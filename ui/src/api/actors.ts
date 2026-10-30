/**
 * Actor names: the one place that decides how "who did this" is written.
 *
 * The journal and the API identify principals by id (`actor.kind` + `actor.id`
 * in the event envelope, `user_id` on a membership, `decided_by` on a
 * permission), and a uuid is unreadable in a feed. Resolution therefore runs
 * through the read endpoints the app already has — `GET /api/v1/me`,
 * `GET /api/v1/users` and `GET /api/v1/projects/{id}/members`, whose `Member`
 * rows carry a server-resolved `display_name` — and the pure id-to-words rules
 * live in `names.ts` so a fold with no query layer can use them too.
 *
 * Non-human actors get words rather than ids: the system, an agent, a worker
 * and an integration are kinds the journal records (`internal/events/events.go`
 * `ActorKind*`), and the id the control plane stores for `system` is the
 * literal string "system", which says nothing to a reader.
 *
 * The directory is a cache, so it can be wrong in the reader's face: an id it
 * never resolved is a person the transcript calls "someone (abc12345)", and two
 * viewers of one journal then disagree about who acted. `useActorNames` therefore
 * treats an id it cannot name as an outstanding lookup and reads the directory
 * again (bounded), rather than trusting one answer for the life of the page.
 */
import { useEffect, useMemo, useRef } from "react";
import { ApiError } from "./client";
import { useMe, useMembers, useUsers } from "./queries";
import type { EventActor, EventActorKind } from "./types";
import { nameLookup, resolveName, shortId } from "./names";
import type { NameHint, NameLookup } from "./names";

export type { NameHint, NameLookup } from "./names";
export { fallbackName, humanIdsIn, mergeLookups, nameLookup, resolveName, shortId } from "./names";

/** Written-out label for each non-human actor kind. */
const NON_HUMAN_LABELS: Record<EventActorKind, string> = {
  human: "someone",
  system: "the system",
  agent: "an agent",
  worker: "a worker",
  integration: "an integration",
};

/**
 * Who an event came from, in words. Humans are resolved through `lookup`; the
 * other kinds get their label, with the id appended when it adds something
 * (several workers can appear in one feed, "system" cannot).
 */
export function actorName(actor: EventActor, lookup: NameLookup): string {
  if (actor.kind === "human") return resolveName(actor.id, lookup);
  const label = NON_HUMAN_LABELS[actor.kind] ?? actor.kind;
  const id = shortId(actor.id);
  if (!id || id === actor.kind || id === "system") return label;
  return `${label} (${id})`;
}

/**
 * A `conversation.permission.decided` `decided_by` (ADR-0039) names a user
 * or a policy, not always a person: the worker writes
 * `profile_policy:<mode>` / `node_policy:<mode>` when the profile or step
 * policy answered the request instead of a person, and
 * `preapproved_within_sandbox` is the mode for an allow inside the sandbox.
 * This turns that id into the words a feed line can read; anything that is
 * not a policy id falls through to the normal user-name resolution.
 */
export function deciderLabel(decidedBy: string, nameOf: (userId: string) => string): string {
  const match = /^([a-z]+)_policy:([a-z0-9_]+)$/i.exec(decidedBy ?? "");
  if (!match) return nameOf(decidedBy);
  const [, prefix, mode] = match;
  if (prefix === "profile" || prefix === "node") {
    const scope = prefix === "profile" ? "the profile's" : "the step's";
    if (mode === "deny") return `${scope} deny policy`;
    if (mode === "preapproved_within_sandbox") return `${scope} preapproved policy (sandboxed)`;
  }
  return `policy ${mode}`;
}

export interface ActorNames {
  /** Raw resolver, to merge with names a page holds locally. */
  lookup: NameLookup;
  /** Display name for a user id, with the unknown-person fallback applied. */
  nameOf: (userId: string) => string;
  /** Words for an event actor of any kind. */
  actorLabel: (actor: EventActor) => string;
  /**
   * Human ids this hook was told about and the directory still cannot name.
   * A surface shows "someone (abc12345)" for exactly these while it waits; the
   * list is what makes that sentence a lookup in progress rather than a verdict.
   */
  unresolvedIds: readonly string[];
}

/** Repairs per outstanding debt before the page accepts the fallback it has. */
export const DIRECTORY_REPAIR_ATTEMPTS = 3;
/** Safety gap between repairs, for a settled directory read that changes no state. */
export const DIRECTORY_REPAIR_TICK_MS = 2_000;

/** The actor directory as the repair loop can see and poke it. */
export interface DirectoryRepairTarget {
  /** A directory fetch is in flight; asking again now would only duplicate it. */
  busy: boolean;
  /** Changes every time either directory read settles, so a failure is noticed as it lands. */
  settled: string;
  /** Reads the directory again. */
  refetch: () => void;
}

/** The default for `useActorNames`' `actorIds`: a surface that names nobody extra. */
const NO_ACTOR_IDS: readonly string[] = [];

/**
 * An answer that names a decision rather than a failure — `401` (signed out),
 * `403` (not in this project), `404` (no such route). Asking again gets the same
 * answer, so only a transport failure or a 5xx is a debt worth re-reading; the
 * surface that showed it stays the one to explain it.
 */
function answeredInsteadOfFailed(error: unknown): boolean {
  return error instanceof ApiError && error.status > 0 && error.status < 500;
}

/**
 * An unknown actor id is evidence the directory is missing or stale, not proof
 * that the person is a stranger. Two ways that happens, both seen in the lab:
 * the read was lost (`GET /api/v1/users` and `GET …/members` answered nothing at
 * all while both API replicas restarted behind a load balancer with no healthy
 * upstream, one frame after every other request on the page succeeded), or the
 * read predates the person (`members` answered before they were added, and a
 * viewer who only watches receives no invalidation for them). So ask the
 * directory again — as soon as a directory read has settled and the page still
 * cannot name somebody, rather than after a back-off, because every moment spent
 * "someone" is a moment the reader was told something false. Bounded per debt,
 * so a genuinely unnamed person (a stranger on an old run) cannot turn a page
 * into a poller.
 */
export function useDirectoryRepair(
  debt: readonly string[],
  directory: DirectoryRepairTarget,
): void {
  const key = debt.join("\n");
  const current = useRef({ key, directory });
  current.current = { key, directory };
  const spent = useRef(new Map<string, number>());
  useEffect(() => {
    if (key === "") return;
    const attempt = (): boolean => {
      const dir = current.current.directory;
      if (dir.busy) return true; // the read in flight re-runs this effect when it settles
      const owed = current.current.key.split("\n");
      const spendable = owed.filter(
        (name) => (spent.current.get(name) ?? 0) < DIRECTORY_REPAIR_ATTEMPTS,
      );
      if (spendable.length === 0) return false;
      for (const name of spendable) {
        spent.current.set(name, (spent.current.get(name) ?? 0) + 1);
      }
      dir.refetch();
      return true;
    };
    if (!attempt()) return;
    const timer = setInterval(() => {
      if (!attempt()) clearInterval(timer);
    }, DIRECTORY_REPAIR_TICK_MS);
    return () => clearInterval(timer);
  }, [key, directory.busy, directory.settled]);
}

/**
 * The names a page can resolve: the caller, the project's members, and the
 * organization directory. All three are shared cache entries, so a page that
 * already shows members pays no extra request.
 *
 * `actorIds` are the human ids the calling surface is about to put in a sentence
 * (`humanIdsIn` collects them from journal frames and row hints). Passing them
 * is what makes the directory self-healing: whoever is missing from it gets
 * looked up again, so two viewers of one journal read one name for one person
 * rather than one of them reading "someone (abc12345)" for the rest of the page.
 */
export function useActorNames(
  projectId?: string,
  actorIds: readonly string[] = NO_ACTOR_IDS,
): ActorNames {
  const me = useMe();
  // Fail fast rather than sit behind a retry back-off: this hook re-reads the
  // directory the moment a name it needs is missing (below), so the recovery it
  // performs is faster and starts sooner than the app-wide retry would allow.
  const users = useUsers({ failFast: true });
  const membersEnabled = Boolean(projectId);
  const members = useMembers(projectId ?? "", { failFast: true });

  const lookup = useMemo<NameLookup>(() => {
    const hints: NameHint[] = [
      ...(users.data?.items ?? []).map((user) => [user.id, user.display_name] satisfies NameHint),
      ...(members.data?.items ?? []).map(
        (member) => [member.user_id, member.display_name] satisfies NameHint,
      ),
      // Pushed last so the caller's own name wins over a stale directory row.
      ...(me.data ? ([[me.data.id, me.data.display_name]] satisfies NameHint[]) : []),
    ];
    return nameLookup(hints);
  }, [me.data, users.data, members.data]);

  const unresolvedIds = useMemo(
    () => actorIds.filter((id) => lookup(id) === null),
    [actorIds, lookup],
  );

  // A directory read that came back empty-handed is a debt even for the
  // surfaces that name nobody explicitly: their actors would all read "someone"
  // until somebody navigated again.
  const failedReads = useMemo(() => {
    const failed: string[] = [];
    if (users.isError && users.data === undefined && !answeredInsteadOfFailed(users.error)) {
      failed.push("users");
    }
    if (
      membersEnabled &&
      members.isError &&
      members.data === undefined &&
      !answeredInsteadOfFailed(members.error)
    ) {
      failed.push("members");
    }
    return failed;
  }, [
    users.isError,
    users.data,
    users.error,
    membersEnabled,
    members.isError,
    members.data,
    members.error,
  ]);

  // The other kind of empty-handed answer names a decision (`401` signed out,
  // `403` not allowed to read the directory, `404`). Re-reading gets the same
  // answer, so when every directory read this page may make has answered that
  // way, the ids it cannot name are the honest limit of what it may say rather
  // than a lookup to keep asking for.
  const refused = useMemo(() => {
    const answers: unknown[] = [];
    if (users.isError && users.data === undefined) answers.push(users.error);
    if (membersEnabled && members.isError && members.data === undefined) {
      answers.push(members.error);
    }
    const reads = membersEnabled ? 2 : 1;
    return answers.length === reads && answers.every(answeredInsteadOfFailed);
  }, [
    users.isError,
    users.data,
    users.error,
    membersEnabled,
    members.isError,
    members.data,
    members.error,
  ]);

  const debt = useMemo(
    () => (refused ? [] : [...unresolvedIds, ...failedReads]),
    [refused, unresolvedIds, failedReads],
  );

  const directory = useMemo<DirectoryRepairTarget>(
    () => ({
      busy: users.isFetching || (membersEnabled && members.isFetching),
      settled: [
        users.status,
        users.fetchStatus,
        users.dataUpdatedAt,
        users.errorUpdatedAt,
        membersEnabled ? members.status : "disabled",
        membersEnabled ? members.fetchStatus : "disabled",
        membersEnabled ? members.dataUpdatedAt : 0,
        membersEnabled ? members.errorUpdatedAt : 0,
      ].join(":"),
      refetch: () => {
        void users.refetch();
        if (membersEnabled) void members.refetch();
      },
    }),
    [users, members, membersEnabled],
  );
  useDirectoryRepair(debt, directory);

  return useMemo<ActorNames>(
    () => ({
      lookup,
      nameOf: (userId) => resolveName(userId, lookup),
      actorLabel: (actor) => actorName(actor, lookup),
      unresolvedIds,
    }),
    [lookup, unresolvedIds],
  );
}
