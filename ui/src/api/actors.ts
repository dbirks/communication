/**
 * Actor names: the one place that decides how "who did this" is written.
 *
 * The journal and the API identify principals by id (`actor.kind` + `actor.id`
 * in the event envelope, `user_id` on a membership, `decided_by` on a
 * permission), and a uuid is unreadable in a feed. Resolution therefore runs
 * through the read endpoints the app already has — `GET /api/v1/me`,
 * `GET /api/v1/users` and `GET /api/v1/projects/{id}/members`, whose `Member`
 * rows carry a server-resolved `display_name` — and a bare id appears only
 * when the directory genuinely does not know the person, truncated so two of
 * them can still be told apart.
 *
 * Non-human actors get words rather than ids: the system, an agent, a worker
 * and an integration are kinds the journal records (`internal/events/events.go`
 * `ActorKind*`), and the id the control plane stores for `system` is the
 * literal string "system", which says nothing to a reader.
 */
import { useMemo } from "react";
import { useMe, useMembers, useUsers } from "./queries";
import type { EventActor, EventActorKind } from "./types";

/** An `(id, name)` pair a page already holds, e.g. a server-resolved display name. */
export type NameHint = readonly [
  userId: string | null | undefined,
  name: string | null | undefined,
];

/** Resolves a user id to a display name, or null when unknown. */
export type NameLookup = (userId: string) => string | null;

/**
 * Shorten an id for display. A uuid is opaque, so its first eight characters
 * distinguish it from its neighbours; a human-written key (`"worker_a"`,
 * `"github"`, `"system"`) is short already and is shown whole.
 */
export function shortId(id: string): string {
  const value = (id ?? "").trim();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(value) ? value.slice(0, 8) : value;
}

/** A lookup built from names the caller has already read; later hints win. */
export function nameLookup(hints: Iterable<NameHint>): NameLookup {
  const names = new Map<string, string>();
  for (const [userId, name] of hints) {
    if (userId && name) names.set(userId, name);
  }
  return (userId) => names.get(userId) ?? null;
}

/** Try lookups in order and return the first name found. */
export function mergeLookups(...lookups: NameLookup[]): NameLookup {
  return (userId) => {
    for (const lookup of lookups) {
      const name = lookup(userId);
      if (name) return name;
    }
    return null;
  };
}

/** Last resort for a person nobody can name — never a bare uuid. */
export function fallbackName(userId: string): string {
  const id = shortId(userId);
  return id ? `someone (${id})` : "someone";
}

/** Display name for a user id, falling back to {@link fallbackName}. */
export function resolveName(userId: string, lookup: NameLookup): string {
  return lookup(userId) ?? fallbackName(userId);
}

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

export interface ActorNames {
  /** Raw resolver, to merge with names a page holds locally. */
  lookup: NameLookup;
  /** Display name for a user id, with the unknown-person fallback applied. */
  nameOf: (userId: string) => string;
  /** Words for an event actor of any kind. */
  actorLabel: (actor: EventActor) => string;
}

/**
 * The names a page can resolve: the caller, the project's members, and the
 * organization directory. All three are shared cache entries, so a page that
 * already shows members pays no extra request.
 */
export function useActorNames(projectId?: string): ActorNames {
  const me = useMe();
  const users = useUsers();
  const members = useMembers(projectId ?? "");

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

  return useMemo<ActorNames>(
    () => ({
      lookup,
      nameOf: (userId) => resolveName(userId, lookup),
      actorLabel: (actor) => actorName(actor, lookup),
    }),
    [lookup],
  );
}
