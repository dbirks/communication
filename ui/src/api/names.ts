/**
 * The pure half of actor naming: turning an id into words, with no directory
 * and no React. The directory-backed resolver lives in `actors.ts`; this module
 * exists so the transcript fold (`transcript.ts`) can name people without
 * importing the query layer.
 *
 * The rule both halves obey: a bare uuid is never a label. The journal and the
 * API identify principals by id; a human-facing sentence names them, and the
 * last resort when nobody knows the person is `someone (abc12345)` — short
 * enough to read, distinct enough to tell two strangers apart.
 */

/** An `(id, name)` pair a page already holds, e.g. a server-resolved display name. */
export type NameHint = readonly [
  userId: string | null | undefined,
  name: string | null | undefined,
];

/** Resolves a user id to a display name, or null when unknown. */
export type NameLookup = (userId: string) => string | null;

/**
 * Shorten an id for display, keeping it distinct from its neighbours. Every id
 * this system issues is a UUIDv7, whose first 12 hex characters are a
 * millisecond timestamp — everything created inside the same ~65 seconds shares
 * a prefix, so the *leading* eight characters collide (three runs all rendered
 * as `01a14350` in the Inbox). The tail is the random part, so that is what we
 * show. A human-written key (`"worker_a"`, `"github"`, `"system"`) has no uuid
 * shape and is short already, so it is shown whole.
 */
export function shortId(id: string): string {
  const value = (id ?? "").trim();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(value) ? value.slice(-8) : value;
}

/**
 * Payload members whose value is a user id that some feed renders as a name.
 * The journal carries ids only (`09-api-events-data.md`), so these are the
 * places a page can meet a person it was never told about by the row it is
 * rendering. Keys are enumerated rather than pattern-matched: `decided_by` also
 * carries policy pseudo-ids (`profile_policy:deny`, ADR-0039), which are not
 * people and must never send the page looking for one.
 */
const USER_ID_FIELDS: readonly string[] = [
  "submitted_by",
  "requested_by",
  "decided_by",
  "edited_by",
  "cleaned_by",
  "controller_user_id",
  "to_user_id",
  "from_user_id",
];

/** A journal frame, taken structurally so this module stays import-free. */
type JournalFrame = {
  actor?: { kind?: string; id?: string | null } | undefined;
  payload?: Record<string, unknown> | undefined;
};

/**
 * Every human id a surface is about to put in a sentence — the journal actors
 * of kind `human`, the ids the payloads carry, plus any id a row hands over
 * directly (a controller, a turn's submitter). A page passes the result to
 * `useActorNames`, which asks the directory about these ids whether or not the
 * fetch that would have carried them landed; a person the fold is about to call
 * "someone" is a lookup the UI owes the reader.
 *
 * Ids that are not people are filtered out: an actor of kind `agent`, `worker`,
 * `system` or `integration` never enters the list, and neither does a policy
 * pseudo-id (`profile_policy:deny`), `null` or the empty string — none of them
 * is somebody the directory could name.
 */
export function humanIdsIn(
  events: readonly JournalFrame[],
  extraIds: readonly (string | null | undefined)[] = [],
): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  const add = (value: unknown): void => {
    if (typeof value !== "string") return;
    const id = value.trim();
    // A pseudo-id (`profile_policy:deny`, `system`) is not a person.
    if (!id || id.includes(":") || seen.has(id)) return;
    seen.add(id);
    ids.push(id);
  };
  for (const event of events) {
    if (event.actor?.kind === "human") add(event.actor.id);
    const payload = event.payload;
    if (!payload) continue;
    for (const field of USER_ID_FIELDS) add(payload[field]);
  }
  for (const id of extraIds) add(id);
  return ids;
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
