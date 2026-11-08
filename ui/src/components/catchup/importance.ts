/**
 * Shared rendering rules for the catch-up surface: the importance level's
 * token classes, the resolution→state-set mapping, the project-colour
 * fallback and the ref label. Design source: README-catchup Part C ("Importance
 * colors", "Project colors") and mock 8a.
 */
import type { StateName } from "../ds/states";

import type { CatchUpImportance, CatchUpListItem, CatchUpRefs } from "../../api/catchup";

/** A project as the filter row and the item rows both draw it. Both sources —
 * the catch-up item's project chip and the reader's own `Project` — promise a
 * colour, and `color?: string` is the union of the two schemas' spellings of
 * that promise; `projectColor` owns what an absent one looks like. */
export interface ProjectChip {
  id: string;
  name: string;
  color?: string;
}
/** The API promises a colour, but the enum carries `""` for "nobody chose";
 * the design's quiet grey is the fallback the token owns. */
export function projectColor(color: string | undefined | null): string {
  return color && color.length > 0 ? color : "var(--color-project-quiet)";
}

/** The 8px project square (README: 8px, 1px radius). */
export function projectSquareClasses(): string {
  return "inline-block h-[8px] w-[8px] shrink-0 rounded-[1px]";
}

export interface ImportanceStyle {
  /** 3px card top border (the level's FILL) + card ring token. */
  topBorder: string;
  border: string;
  /** Level tag / number square. */
  tagBg: string;
  tagFg: string;
  /** Human label for a tag. */
  label: string;
}

export const IMPORTANCE: Record<CatchUpImportance, ImportanceStyle> = {
  must_know: {
    topBorder: "border-t-imp-must-fill",
    border: "border-imp-must-border",
    tagBg: "bg-imp-must-tag-bg",
    tagFg: "text-imp-must-tag-fg",
    label: "MUST KNOW",
  },
  worth_a_look: {
    topBorder: "border-t-imp-look-fill",
    border: "border-imp-look-border",
    tagBg: "bg-imp-look-tag-bg",
    tagFg: "text-imp-look-tag-fg",
    label: "WORTH A LOOK",
  },
  routine: {
    topBorder: "border-t-imp-routine-fill",
    border: "border-imp-routine-border",
    tagBg: "bg-imp-routine-tag-bg",
    tagFg: "text-imp-routine-tag-fg",
    label: "ROUTINE",
  },
};

/** Resolution → state-set tint (findings: color never alone — the chip always
 * carries the word). `branch_ready` waits on a reviewer, `open` is still
 * moving, `no code` is a quiet record, `run_failed` failed. */
export const RESOLUTION_STATE: Record<CatchUpListItem["resolution"], StateName> = {
  merged: "done",
  branch_ready: "waiting",
  open: "running",
  run_failed: "failed",
  no_code: "queued",
};

/** The word the chip shows — the vocabulary's own, lowercase like the mock. */
export const RESOLUTION_WORD: Record<CatchUpListItem["resolution"], string> = {
  merged: "merged",
  branch_ready: "branch ready",
  open: "open",
  run_failed: "run failed",
  no_code: "no code",
};

/** The ref label a row/card shows: issue number, else PR, else commits. */
export function refLabel(refs: CatchUpRefs): string | null {
  const issue = refs.issues?.[0];
  if (issue) return `#${issue.number}`;
  const pr = refs.pull_requests?.[0];
  if (pr) return `PR #${pr.number}`;
  const commits = refs.commits?.length ?? 0;
  if (commits > 0) return commits === 1 ? "1 commit" : `${commits} commits`;
  return null;
}

/** The first link this ref set can honestly offer — the PR the work landed
 * through, else a commit, else nothing. These are the server's own urls (see
 * `RefChips`); a number with no url is a claim, not a destination. */
export function primaryRefUrl(refs: CatchUpRefs | undefined): string | null {
  if (!refs) return null;
  return (
    refs.pull_requests?.find((pr) => pr.url)?.url ??
    refs.commits?.find((commit) => commit.url)?.url ??
    null
  );
}

/** `14:00` from an RFC 3339 stamp — the "WRITTEN {HH:MM}" clock. */
export function clockOf(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

/** Whole days between an instant and now, rounded up, min 1 — the banner's
 * "41 unseen over 4 days". */
export function daysSince(iso: string, now: Date = new Date()): number {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return 1;
  return Math.max(1, Math.ceil((now.getTime() - then) / 86_400_000));
}
