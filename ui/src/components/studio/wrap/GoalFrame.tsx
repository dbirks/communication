/**
 * GoalFrame — presentational frame drawn around a Repeat-until loop on the
 * canvas, showing the human goal sentence, quoted goal text, round bound, and
 * optional animated MarchingAnts outline while a run is executing.
 */
import type { ReactNode } from "react";
import type { TablerIcon } from "@tabler/icons-react";
import { IconGavel, IconRepeat, IconTerminal2, IconTextScan2 } from "@tabler/icons-react";
import { MarchingAnts, type MarchingAntsRect } from "./MarchingAnts";
import { goalSentence, type GoalKind, type GoalSpec } from "./wrapModel";

/**
 * The frame says its round bound ONCE. While editing that is the bound alone
 * ("up to 3 rounds · then stop"); during a run it is the round the loop is on
 * against the declared bound ("round 2 of up to 3"), and the state word rides
 * beside it. The Run Workbench's own label for a scope counts the same thing in
 * the workbench's words (`iteration 2 of 3`, `workbench.ts`) — a frame that
 * printed that beside its "up to 3 rounds" line would show two counters that
 * disagree (the workbench's total is the rounds it has SEEN, the frame's is the
 * bound the step declares).
 *
 * So the caller writes the count into the status line with `runStatusLabel`
 * ("judging · round 2 of up to 3") and the frame lifts it back onto the bound
 * line with `splitRunLabel`. Both halves live here so the frame and its callers
 * cannot drift apart.
 */
export function runStatusLabel(word: string, round: number, maxRounds: number): string {
  return `${word} · round ${round} of up to ${Math.max(round, maxRounds)}`;
}

const RUN_BOUND_PHRASE = /·\s*round (\d+) of up to (\d+)\s*$/;

/**
 * The header glyph names what the loop is judged BY, the same three icons the
 * wrap panel offers (review-1 finding 39): a gavel, a command prompt, a text
 * scan. A goal whose kind this build does not know keeps the repeat glyph — the
 * frame is still a loop, and inventing a glyph for an unknown kind would say a
 * fact the frame does not have.
 */
const GOAL_ICON: Partial<Record<GoalKind, TablerIcon>> = {
  judge: IconGavel,
  command: IconTerminal2,
  contains: IconTextScan2,
};

/** `runStatusLabel`'s inverse: the trailing round count, and what is left of the
 * status line without it. A status with no count ("· not started", "⊘ stopped",
 * and every label a run-less canvas hands the frame) comes back whole. */
export function splitRunLabel(text: string): { status: string; bound: string | null } {
  const match = RUN_BOUND_PHRASE.exec(text);
  if (!match) return { status: text, bound: null };
  const status = text.slice(0, match.index).trimEnd();
  return {
    status,
    bound: `round ${match[1]} of up to ${match[2]}`,
  };
}

export interface GoalFrameProps {
  rect: MarchingAntsRect;
  goal: GoalSpec;
  giveUpText?: string;
  running?: boolean;
  /** The frame's OWN run state, glyph + word composed by the caller ("✓ done",
   * "⊘ stopped", "· not started"). A goal frame is a step like any other: while
   * or after its loop runs the frame has to SAY its state — the animated outline
   * is motion, never a word (identity rule 06). Absent while editing. A count
   * written by `runStatusLabel` moves onto the bound line (`splitRunLabel`). */
  status?: { text: string; className: string } | null;
  onHeaderClick?: () => void;
  children?: ReactNode;
  className?: string;
}

export function GoalFrame({
  rect,
  goal,
  giveUpText,
  running = false,
  status = null,
  onHeaderClick,
  children,
  className = "",
}: GoalFrameProps) {
  const isMono = goal.kind === "command" || goal.kind === "contains";
  const KindIcon = GOAL_ICON[goal.kind] ?? IconRepeat;
  const roundWord = goal.maxRounds === 1 ? "round" : "rounds";
  const tail = giveUpText ?? "then stop";
  const run = status ? splitRunLabel(status.text) : null;
  const boundLine = run?.bound ?? `up to ${goal.maxRounds} ${roundWord} · ${tail}`;

  const headerContent = (
    <>
      <span className="flex items-center gap-[6px] text-[12px] font-semibold text-accent-edge">
        <KindIcon
          size={15}
          stroke={1.5}
          aria-hidden
          data-testid="goal-frame-icon"
          className="shrink-0"
        />
        <span>{goalSentence(goal)}</span>
      </span>
      <span
        data-testid="goal-frame-text"
        className={`text-pretty text-[13px] leading-[18px] text-ink ${
          isMono ? "font-mono" : "font-ui"
        }`}
      >
        “{goal.text}”
      </span>
    </>
  );

  return (
    <div
      data-testid="goal-frame"
      className={`absolute flex flex-col justify-between rounded-[16px] ${className}`}
      style={{
        left: rect.x,
        top: rect.y,
        width: rect.width,
        height: rect.height,
        border: running ? "1.5px solid transparent" : "1.5px solid #2f4bd6",
        backgroundColor: running ? "transparent" : "rgba(47, 75, 214, 0.03)",
      }}
    >
      {running ? (
        <MarchingAnts
          data-testid="goal-frame-ants"
          rect={{ x: -1.5, y: -1.5, width: rect.width, height: rect.height }}
          rx={16}
          animated
        />
      ) : null}

      {onHeaderClick ? (
        <button
          type="button"
          data-testid="goal-frame-header"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onHeaderClick();
          }}
          className="relative z-1 flex w-full flex-col gap-[4px] rounded-t-[15px] py-[10px] pl-[14px] pr-[30px] text-left hover:bg-accent/[0.04] focus-visible:outline-2 focus-visible:outline-accent"
        >
          {headerContent}
        </button>
      ) : (
        <div className="relative z-1 flex flex-col gap-[4px] px-[14px] py-[10px]">
          {headerContent}
        </div>
      )}

      {children ? <div className="relative z-1 flex-1">{children}</div> : null}

      {/* The bound and the state share the frame's one mono footer line: the
          header is NOT in the flow the step cards are laid out against (React
          Flow positions those by canvas coordinate), so anything added there
          grows over the first card instead of pushing it down. */}
      <div
        data-testid="goal-frame-footer"
        className="pointer-events-none relative z-1 flex flex-col gap-[4px] px-[14px] pt-[8px] pb-[10px] font-mono text-[10.5px] leading-[14px] text-accent-text"
      >
        <span data-testid="goal-frame-bound">{boundLine}</span>
        {status && run ? (
          <span
            data-testid="goal-frame-status"
            title={run.status}
            className={`self-end whitespace-nowrap font-semibold ${status.className}`}
          >
            {run.status}
          </span>
        ) : null}
      </div>
    </div>
  );
}
