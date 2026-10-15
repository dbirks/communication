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
