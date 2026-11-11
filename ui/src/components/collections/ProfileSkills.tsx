/**
 * The attached-collections block of a profile's SKILLS panel (ADR-0084).
 *
 * The pin list is ORDERED and the order is semantics: when two collections
 * ship one skill name, apm settles it by install order — the LATER claimant
 * wins. This block shows the order, lets the writer change it (up/down; the
 * wire contract is a PATCH of the whole list with the version CAS token,
 * ADR-0058), and surfaces what the lock decided rather than reinterpreting
 * it: the lock summary's per-skill `from_ref` attribution (ADR-0084) is what
 * lets a losing entry say `overridden by <ref>` beside a skill it declared
 * but does not own.
 *
 * Honesty rules:
 * - A count is only shown where it is computable from reads: skills are
 *   attributed to this collection's refs, packages are the pinned revision's
 *   own entry count. No attribution yet (the profile is unlocked) → no claim.
 * - The attach picker lists PUBLISHED collections only and pins the newest
 *   PUBLISHED revision — `latest` is not attachable (ADR-0084), so the read
 *   of the collection detail decides the exact number, not a guess.
 * - Pi: the worker stages the shared `.agents/skills/` tree for the `pi`
 *   launcher, but Pi reading it is an OPEN SPIKE (A-1) — the warning line
 *   says exactly that.
 */
import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { IconArrowDown, IconArrowUp, IconX } from "@tabler/icons-react";
import { Button } from "../ds/Button";
import { Field, Input } from "../ds/Field";
import { Alert } from "../ds/Alert";
import { Spinner } from "../Feedback";
import { problemOf } from "../../api/client";
import { usePatchAgentProfile } from "../../api/queries";
import {
  collectionsRoute,
  getCollectionDetail,
  invalidateCollections,
  newestPublishedRevision,
  useApmCollections,
  type APMCollection,
} from "../../api/apmCollections";
import type { APMCollectionPin } from "../../api/apmCollections";
import type { AgentProfile } from "../../api/types";

export interface ProfileSkillsProps {
  profile: AgentProfile;
  canWrite: boolean;
}

/** The circled ordinals the design uses, ①…⑳; deeper lists fall back to `21.`. */
function ordinal(index: number): string {
  return index < 20 ? String.fromCodePoint(0x2460 + index) : `${index + 1}.`;
}

export function ProfileSkills({ profile, canWrite }: ProfileSkillsProps) {
  const queryClient = useQueryClient();
  const patch = usePatchAgentProfile(profile.id);
  const collections = useApmCollections();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [attachProblem, setAttachProblem] = useState<unknown>(null);

  const pins: APMCollectionPin[] = profile.apm_collections ?? [];
  const byId = useMemo(() => {
    const map = new Map<string, APMCollection>();
    for (const collection of collections.data?.collections ?? [])
      map.set(collection.id, collection);
    return map;
  }, [collections.data]);

  // The lock summary's per-skill attribution: skill name → the ref that OWNS
  // it after apm's install-order settle. Empty (or absent) until a lock
  // resolve has reported — nothing is invented from it.
  const winners = useMemo(() => {
    const map = new Map<string, string>();
    for (const row of profile.apm_contents?.skill_refs ?? []) {
      if (row.from_ref) map.set(row.skill, row.from_ref);
    }
    return map;
  }, [profile.apm_contents]);

  async function writePins(next: APMCollectionPin[]) {
    invalidateCollections(queryClient);
    await patch.mutateAsync({ apm_collections: next, version: profile.version }).catch(() => {
      /* the problem renders below; the version CAS is the server's call */
    });
  }

  function move(index: number, delta: -1 | 1) {
    const target = index + delta;
    if (target < 0 || target >= pins.length) return;
    const next = [...pins];
    const [moved] = next.splice(index, 1);
    next.splice(target, 0, moved);
    void writePins(next);
  }

  function remove(index: number) {
    const next = pins.filter((_, i) => i !== index);
    void writePins(next);
  }

  const errorText = patch.isError
    ? problemOf(patch.error).detail || problemOf(patch.error).title
    : attachProblem
      ? problemOf(attachProblem).detail || problemOf(attachProblem).title
      : null;

  return (
    <div className="space-y-1 p-[10px]" data-testid={`agent-skills-${profile.id}`}>
      {pins.length === 0 ? (
        <p className="text-[12px] text-muted" data-testid={`agent-skills-none-${profile.id}`}>
          No skills attached.
        </p>
      ) : (
        <ol className="space-y-[3px]" data-testid={`agent-skills-list-${profile.id}`}>
          {pins.map((pin, index) => (
            <ProfileSkillRow
              key={`${pin.collection_id}:${pin.revision}`}
              pin={pin}
              index={index}
              count={pins.length}
              collection={byId.get(pin.collection_id)}
              winners={winners}
              busy={patch.isPending}
              canWrite={canWrite}
              onMove={(delta) => move(index, delta)}
              onRemove={() => remove(index)}
            />
          ))}
        </ol>
      )}
      {pins.length > 0 ? (
        <p
          className="pt-[4px] text-[11.5px] text-muted"
          data-testid={`agent-skills-order-note-${profile.id}`}
        >
          Later collections win when two ship the same skill.
        </p>
      ) : null}
      {profile.launcher_id === "pi" ? (
        <p
          className="pt-[2px] text-[11.5px] text-st-waiting-tag-fg"
          data-testid={`agent-skills-pi-warning-${profile.id}`}
        >
          Pi reads .agents/skills — staged, not yet verified for Pi.
        </p>
      ) : null}
      {canWrite ? (
        <div className="flex items-center gap-[8px] pt-[6px]">
          <Button
            variant="secondary"
            compact
            disabled={collections.data === null}
            onClick={() => setPickerOpen(true)}
            data-testid={`agent-skills-attach-${profile.id}`}
          >
            Attach collection
          </Button>
          <a
            href={collectionsRoute}
            className="text-[11.5px] text-muted underline underline-offset-2 hover:text-ink"
          >
            Browse the library
          </a>
        </div>
      ) : null}
      {errorText ? (
        <Alert
          state="failed"
          label="REFUSED"
          role="alert"
          testid={`agent-skills-problem-${profile.id}`}
        >
          {errorText}
        </Alert>
      ) : null}
      <AttachCollectionDialog
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onAttach={(collectionId) => void attach(collectionId)}
        collections={collections}
      />
    </div>
  );

  /** The one read the picker cannot skip: the pin must name the NEWEST
   * PUBLISHED revision, and the list row's summary does not prove published
   * status — the detail's history does. */
  async function attach(collectionId: string) {
    try {
      const detail = await getCollectionDetail(collectionId);
      const published = newestPublishedRevision(detail);
      if (!published) {
        setPickerOpen(false);
        setAttachProblem(
          new Error(`“${detail.collection.name}” has no published revision to attach.`),
        );
        return;
      }
      setPickerOpen(false);
      setAttachProblem(null);
      await writePins([...pins, { collection_id: collectionId, revision: published.revision }]);
    } catch (error) {
      // A failed read or write is surfaced, never hidden: an attach that did
      // not land must not look like one that did.
      setAttachProblem(error);
    }
  }
}

/** One attached collection: the ordinal, name, pinned revision and — where the
 * reads support it — what that attachment ships. */
function ProfileSkillRow({
  pin,
  index,
  count,
  collection,
  winners,
  busy,
  canWrite,
  onMove,
  onRemove,
}: {
  pin: APMCollectionPin;
  index: number;
  count: number;
  collection: APMCollection | undefined;
  winners: Map<string, string>;
  busy: boolean;
  canWrite: boolean;
  onMove: (delta: -1 | 1) => void;
  onRemove: () => void;
}) {
  const testid = `agent-skills-row-${pin.collection_id}-r${pin.revision}`;
  // The pinned revision's entries are only readable when the pin names the
  // newest revision (the list carries that one summary); a pin onto an older
  // revision renders its exact number without an invented count.
  const entries =
    collection?.latest_revision?.revision === pin.revision
      ? (collection.latest_revision.entries ?? [])
      : null;
  const refs = new Set((entries ?? []).map((entry) => entry.ref));
  const attributed: string[] = [];
  const overridden: { skill: string; by: string }[] = [];
  for (const [skill, ref] of winners) {
    if (refs.has(ref)) attributed.push(skill);
  }
  for (const entry of entries ?? []) {
    for (const skill of entry.skills ?? []) {
      const winner = winners.get(skill);
      if (winner !== undefined && winner !== entry.ref) overridden.push({ skill, by: winner });
    }
  }
  attributed.sort();
  const name = collection?.name ?? `collection ${pin.collection_id.slice(0, 8)}`;
  const meta: string[] = [`r${pin.revision}`];
  if (attributed.length > 0)
    meta.push(`${attributed.length} ${attributed.length === 1 ? "skill" : "skills"}`);
  else if (entries !== null)
    meta.push(`${entries.length} ${entries.length === 1 ? "package" : "packages"}`);

  return (
    <li className="flex flex-wrap items-center gap-x-[6px] gap-y-[2px]" data-testid={testid}>
      {canWrite ? (
        <span className="flex items-center">
          <button
            type="button"
            aria-label={`Move ${name} up`}
            disabled={busy || index === 0}
            onClick={() => onMove(-1)}
            data-testid={`agent-skills-up-${pin.collection_id}`}
            className="rounded-[3px] p-[2px] text-muted hover:text-ink disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
          >
            <IconArrowUp size={14} stroke={1.7} aria-hidden="true" />
          </button>
          <button
            type="button"
            aria-label={`Move ${name} down`}
            disabled={busy || index === count - 1}
            onClick={() => onMove(1)}
            data-testid={`agent-skills-down-${pin.collection_id}`}
            className="rounded-[3px] p-[2px] text-muted hover:text-ink disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
          >
            <IconArrowDown size={14} stroke={1.7} aria-hidden="true" />
          </button>
        </span>
      ) : null}
      <span className="font-mono text-[12px] text-faint" aria-hidden="true">
        {ordinal(index)}
      </span>
      <span className="text-[12.5px] font-medium text-ink">{name}</span>
      {meta.length > 0 ? (
        <span className="font-mono text-[10.5px] text-muted">· {meta.join(" · ")}</span>
      ) : null}
      {canWrite ? (
        <button
          type="button"
          aria-label={`Remove ${name}`}
          disabled={busy}
          onClick={onRemove}
          data-testid={`agent-skills-remove-${pin.collection_id}`}
          className="rounded-[3px] p-[2px] text-muted hover:text-ink disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
        >
          <IconX size={13} stroke={1.9} aria-hidden="true" />
        </button>
      ) : null}
      {attributed.length + overridden.length > 0 ? (
        <details
          className="w-full pl-[2px]"
          data-testid={`agent-skills-skills-${pin.collection_id}`}
        >
          <summary className="cursor-pointer font-mono text-[10.5px] text-muted">
            Skills ({attributed.length + overridden.length})
          </summary>
          <ul className="mt-[2px] space-y-[1px] pl-4">
            {attributed.map((skill) => (
              <li key={skill} className="font-mono text-[11px] text-ink-2">
                {skill}
              </li>
            ))}
            {overridden.map(({ skill, by }) => (
              <li
                key={`${skill}:${by}`}
                className="font-mono text-[11px] text-muted"
                data-testid={`agent-skills-overridden-${pin.collection_id}-${skill}`}
              >
                {skill} — overridden by <span className="text-ink-2">{by}</span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </li>
  );
}

/** The picker: published collections, searched by name/slug. Attaching reads
 * the detail so the pin names the newest PUBLISHED revision exactly. */
function AttachCollectionDialog({
  open,
  onClose,
  onAttach,
  collections,
}: {
  open: boolean;
  onClose: () => void;
  onAttach: (collectionId: string) => void;
  collections: ReturnType<typeof useApmCollections>;
}) {
  const [search, setSearch] = useState("");
  if (!open) return null;
  const query = search.trim().toLowerCase();
  const items = (collections.data?.collections ?? [])
    .filter((collection) => collection.published_revisions > 0)
    .filter(
      (collection) =>
        query === "" ||
        collection.name.toLowerCase().includes(query) ||
        collection.slug.toLowerCase().includes(query),
    );
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-ink/25 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="agent-skills-picker-title"
        className="mt-[10vh] w-full max-w-[480px] rounded-[4px] border border-line-strong bg-surface p-[14px]"
        data-testid="agent-skills-picker"
      >
        <h2
          id="agent-skills-picker-title"
          className="font-mono text-[10.5px] uppercase tracking-[.06em] text-faint"
        >
          Attach collection
        </h2>
        <Field id="agent-skills-picker-search" label="search" className="pt-[8px]">
          <Input
            id="agent-skills-picker-search"
            value={search}
            placeholder="name or slug"
            onChange={(event) => setSearch(event.target.value)}
            data-testid="agent-skills-picker-search"
          />
        </Field>
        {collections.isPending ? (
          <Spinner label="Loading the library" />
        ) : items.length === 0 ? (
          <p className="py-[8px] text-[12px] text-muted" data-testid="agent-skills-picker-empty">
            No published collections {query === "" ? "yet" : `match “${search.trim()}”`}.
          </p>
        ) : (
          <ul
            className="max-h-[320px] divide-y divide-line overflow-y-auto"
            data-testid="agent-skills-picker-list"
          >
            {items.map((collection) => (
              <li
                key={collection.id}
                className="flex items-center gap-[8px] py-[6px]"
                data-testid={`agent-skills-picker-row-${collection.id}`}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12.5px] font-medium">
                    {collection.name}
                  </span>
                  <span className="block font-mono text-[10.5px] text-muted">
                    r{collection.latest_revision?.revision ?? collection.published_revisions} ·{" "}
                    {collection.published_revisions}{" "}
                    {collection.published_revisions === 1 ? "published" : "published revisions"}
                  </span>
                </span>
                <Button
                  variant="secondary"
                  compact
                  onClick={() => onAttach(collection.id)}
                  data-testid={`agent-skills-picker-attach-${collection.id}`}
                >
                  Attach
                </Button>
              </li>
            ))}
          </ul>
        )}
        <div className="flex justify-end pt-[8px]">
          <Button variant="ghost" onClick={onClose} data-testid="agent-skills-picker-close">
            Close
          </Button>
        </div>
      </div>
    </div>
  );
}

export default ProfileSkills;
