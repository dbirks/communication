/**
 * Shared display formatting for machine-produced values. Mono is a rule for
 * these (`docs/design/handoff/README.md` rule 07), but the *shape* of the string
 * is decided here once, so two screens never disagree about what the same
 * timestamp or byte count looks like.
 */

import { shortId as shortenId } from "../api/names";

/** `2026-10-14T18:03:07Z` → `2026-10-14 18:03:07 UTC`; anything odd is shown raw. */
export function formatTime(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? value
    : `${date.toISOString().replace("T", " ").slice(0, 19)} UTC`;
}

/** Clock time only: `18:03:07 UTC`. */
export function formatClock(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : `${date.toISOString().slice(11, 19)} UTC`;
}

/**
 * Age in words, for the "last seen / recorded" columns. Staleness is the point
 * of an age line, so a future or unreadable value says `unknown` rather than a
 * confident `0s`.
 */
export function formatAge(value: string | null | undefined, now = Date.now()): string {
  if (!value) return "unknown";
  const at = new Date(value).valueOf();
  if (Number.isNaN(at)) return "unknown";
  const seconds = Math.round((now - at) / 1000);
  if (seconds < 0) return "unknown";
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

/** Byte counts a person can compare; artifacts are compared by size. */
export function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "unknown";
  if (value < 1024) return `${value} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let size = value / 1024;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size >= 10 ? Math.round(size) : size.toFixed(1)} ${units[unit]}`;
}

/** A commit sha, shortened the way `git` shortens one. */
export function shortCommit(sha: string | null | undefined): string {
  if (!sha) return "—";
  return sha.slice(0, 7);
}

/**
 * A uuid, shortened enough to tell two apart and to fit a row.
 *
 * The tail, not the head: ids here are UUIDv7, whose leading hex characters are
 * a millisecond timestamp, so a prefix is the *least* distinguishing part of
 * one. `../api/names.ts`'s `shortId` owns that rule (and the non-uuid key
 * behavior) so no two screens can drift apart on it again.
 */
export function shortId(id: string | null | undefined): string {
  if (!id) return "—";
  return shortenId(id) || "—";
}

/** A uuid as a git-ref segment takes it: 8-4-4-4-12 hex. */
const UUID_SEGMENT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A long hex object id with no dashes (a bare sha, a sha-ish workspace key). */
const LONG_HEX_SEGMENT = /^[0-9a-f]{16,}$/i;

/**
 * A git ref, shortened for the one quiet line it lives on (design 1e/2e).
 *
 * A run's branch is `<run uuid>/<repo>` — 36 characters of uuid wrap the row
 * over two lines and read as raw machinery. Each `/`-separated segment that is
 * a uuid is cut by {@link shortId}'s rule — the *tail*, because a UUIDv7 head is
 * a millisecond timestamp and every run seeded in the same minute shares it,
 * which is what made two sibling rows read as the same `01a18abe/app`. Using
 * the same rule the row's own `Run #…` already uses makes the two lines agree:
 * `Run #a1d71e29` above `a1d71e29/app` is one run, visibly. A dashless sha (a
 * commit-shaped segment) keeps `git`'s own reading — the head — because for a
 * sha there is no timestamp head to distrust (see {@link shortCommit}). The
 * real ref stays in the row's `title`, so nothing is lost. A segment a person
 * named (`app`, `main`, `feature/login`) is left exactly as written — this
 * shortens machine output, never a name.
 */
export function shortBranch(ref: string | null | undefined): string {
  if (!ref) return "";
  return ref
    .split("/")
    .map((segment) =>
      UUID_SEGMENT.test(segment)
        ? shortenId(segment)
        : LONG_HEX_SEGMENT.test(segment)
          ? segment.slice(0, 8)
          : segment,
    )
    .join("/");
}

/**
 * A stable `data-testid` fragment for an id.
 *
 * `shortId` is what a person reads, and eight characters is far too few to tell
 * two ids apart — UUIDs that differ only in their fourth group (which is how
 * seeded batches are made) collide. Test ids must not collide, or a test asserts
 * against whichever row happened to render first.
 */
export function testidOf(id: string | null | undefined): string {
  if (!id) return "none";
  return id.replace(/[^A-Za-z0-9]/g, "").slice(0, 13);
}

/**
 * A countdown: how much time is left until a deadline (`approvals.deadline_at`).
 * `formatAge` deliberately refuses the future, so the future gets its own
 * formatter rather than a reused one — a deadline shown as `unknown` is a
 * deadline nobody can act on, and one shown as `-20h` is a lie about direction.
 */
export function formatRemaining(value: string | null | undefined, now = Date.now()): string {
  if (!value) return "unknown";
  const at = new Date(value).valueOf();
  if (Number.isNaN(at)) return "unknown";
  const seconds = Math.round((at - now) / 1000);
  if (seconds <= 0) return "passed";
  if (seconds < 60) return `${seconds}s left`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m left`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h left`;
  return `${Math.round(hours / 24)}d left`;
}
