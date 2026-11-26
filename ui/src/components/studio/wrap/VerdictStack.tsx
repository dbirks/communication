/**
 * VerdictStack — per-round goal status cards stacked beside a GoalFrame
 * while or after a Repeat-until loop runs.
 *
 * The WORDS follow the goal. A loop that asks a judge, a loop that runs a
 * command and a loop that looks for a string in some output answer three
 * different questions, and one set of words ("✓ goal met") lies about the
 * other two. A hand-written `until` condition nobody recognized gets the
 * generic set: its rounds really ran, and the reader is still told what became
 * of each.
 */
import type { StateName } from "../../ds/states";
import type { GoalKind } from "./wrapModel";

export type RoundVerdict = "met" | "not_yet" | "running";

/** The three goals the wrap panel writes, plus `generic`: an `until` scope
 * whose condition nobody recognized still ran rounds. */
export type VerdictKind = GoalKind | "generic";

export interface VerdictRound {
  n: number;
  verdict: RoundVerdict;
  reason?: string;
  /** Which goal this round was judged against. The canvas hands a stack only
   * its rounds, so the kind — the thing that picks the words — rides with
   * them; absent means the stack's own `kind`, and neither means `judge`. */
  kind?: VerdictKind;
}

export interface VerdictStackProps {
  rounds: VerdictRound[];
  /** Which goal the rounds were judged against. Absent = each round's own, and
   * failing that the judge's words. */
  kind?: VerdictKind;
  className?: string;
}

/** The word one goal kind prints for each verdict — glyph-free, because the
 * caller that paints a status line owns the glyph (the frame's canvas line
 * prepends the state's own `●`/`✓`/`×`, `nodes.tsx`). The VerdictStack cards
 * carry the glyph themselves: identity rule 06 wants glyph AND word. */
export const VERDICT_WORDS: Record<VerdictKind, Record<RoundVerdict, string>> = {
  judge: { running: "judging", met: "goal met", not_yet: "not yet" },
  command: { running: "checking", met: "passed", not_yet: "failed" },
  contains: { running: "checking", met: "found", not_yet: "not found" },
  generic: { running: "running", met: "condition met", not_yet: "not yet" },
};

/** The glyph each verdict wears — the same glyphs the state sets use (ds/states:
 * ● running, ✓ done, × failed), so a card and a box never disagree. */
export const VERDICT_GLYPH: Record<RoundVerdict, string> = {
  running: "●",
  met: "✓",
  not_yet: "×",
};

export function verdictWords(kind: VerdictKind): Record<RoundVerdict, string> {
  return VERDICT_WORDS[kind];
}

/** "● judging" — the glyph and the word a card prints. */
export function verdictLabel(kind: VerdictKind, verdict: RoundVerdict): string {
  return `${VERDICT_GLYPH[verdict]} ${VERDICT_WORDS[kind][verdict]}`;
}

/**
 * The loop's own run state read as a verdict: a loop still working is still
 * judging, a loop that ended `done` met its goal, and a loop that ended
 * `failed` did not (the run workbench's scope roll-up says so — `workbench.ts`
 * gives the loop's own row the last word). Every other state (⊘ stopped,
 * ! need you, · not started) is the loop's FATE rather than a verdict on its
 * goal, and keeps the shared state's word.
 */
export function verdictForState(state: StateName | string): RoundVerdict | null {
  switch (state) {
    case "running":
    case "retrying":
      return "running";
    case "done":
      return "met";
    case "failed":
      return "not_yet";
    default:
      return null;
  }
}

const VERDICT_CLASS: Record<RoundVerdict, string> = {
  met: "rounded-[6px] bg-st-done-tag px-[6px] py-[1px] text-st-done-tag-fg",
  not_yet: "text-st-failed-tag-fg",
  running: "rounded-[6px] bg-st-running-tag px-[6px] py-[1px] text-st-running-tag-fg",
};

export function VerdictStack({ rounds, kind, className = "" }: VerdictStackProps) {
  const stackKind: VerdictKind = kind ?? rounds.find((round) => round.kind)?.kind ?? "judge";
  return (
    <div data-testid="verdict-stack" className={`flex w-[220px] flex-col gap-[6px] ${className}`}>
      {rounds.map((round) => {
        // One stack, one loop, one goal — but the page stamps the kind on every
        // round it builds, so a stack assembled from round data alone still
        // prints the right words.
        const label = verdictLabel(round.kind ?? stackKind, round.verdict);
        return (
          <div
            key={round.n}
            data-testid={`verdict-round-${round.n}`}
            className="rounded-[10px] border border-line bg-surface px-[10px] py-[8px]"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="font-mono text-[10.5px] text-muted">Round {round.n}</span>
              <span
                className={`font-mono text-[10.5px] font-medium ${VERDICT_CLASS[round.verdict]}`}
              >
                {label}
              </span>
            </div>
            {round.reason ? (
              <p className="mt-[4px] text-[12.5px] leading-[17px] text-ink-2">{round.reason}</p>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
