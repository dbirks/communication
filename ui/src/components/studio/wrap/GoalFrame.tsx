/**
 * GoalFrame — presentational frame drawn around a Repeat-until loop on the
 * canvas: an ink "REPEAT UNTIL" tab on the top border, the quoted goal text,
 * the checker sentence, the round bound, and an optional animated MarchingAnts
 * outline while a run is executing (design 1g: the frame stopped being blue).
 */
import type { ReactNode } from "react";
import type { TablerIcon } from "@tabler/icons-react";
import { IconColumns, IconRepeat } from "@tabler/icons-react";
import { MarchingAnts, type MarchingAntsRect } from "./MarchingAnts";
import type { GoalKind, GoalSpec } from "./wrapModel";

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
 * The checker sentence names what the loop is judged BY in 12px muted text
 * under the goal (design 1g). A goal whose kind this build does not know
 * prints no checker line — inventing one would say a fact the frame does not
 * have.
 */
const GOAL_CHECKER: Partial<Record<GoalKind, string>> = {
  judge: "a judge decides",
  command: "a command passes",
  contains: "the output contains …",
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
  /** Ink border + ink shadow on the frame box (the frame is draggable; 1g).
   * Only applies while not running. */
  selected?: boolean;
  /** Tab label: every Repeat-until kind reads "REPEAT UNTIL"; side-by-side
   * wraps pass "side" to read "SIDE BY SIDE". */
  variant?: "repeat" | "side";
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
  selected = false,
  variant = "repeat",
  children,
  className = "",
}: GoalFrameProps) {
  const isMono = goal.kind === "command" || goal.kind === "contains";
  const TabIcon: TablerIcon = variant === "side" ? IconColumns : IconRepeat;
  const tabText = variant === "side" ? "SIDE BY SIDE" : "REPEAT UNTIL";
  const checker = GOAL_CHECKER[goal.kind];
  const roundWord = goal.maxRounds === 1 ? "round" : "rounds";
  const tail = giveUpText ?? "then stop";
  const run = status ? splitRunLabel(status.text) : null;
  const boundLine = run?.bound ?? `up to ${goal.maxRounds} ${roundWord} · ${tail}`;

  const tab = (
    <span
      data-testid="goal-frame-tab"
      className="flex items-center gap-[5px] rounded-[6px] bg-ink px-[8px] py-[3px] font-mono text-[10.5px] font-semibold uppercase tracking-[.06em] text-white"
    >
      <TabIcon
        size={12}
        stroke={1.5}
        aria-hidden
        data-testid="goal-frame-icon"
        className="shrink-0"
      />
      <span>{tabText}</span>
    </span>
  );

  const headerContent = (
    <>
      <span
        data-testid="goal-frame-text"
        className={`text-pretty text-[13px] leading-[18px] text-ink ${
          isMono ? "font-mono" : "font-ui"
        }`}
      >
        “{goal.text}”
      </span>
      {checker ? (
        <span data-testid="goal-frame-checker" className="text-[12px] text-muted">
          {checker}
        </span>
      ) : null}
    </>
  );

  return (
    <div
      data-testid="goal-frame"
      className={`absolute flex flex-col justify-between rounded-[16px] border bg-rail ${
        running || !selected ? "border-fill-edge" : "border-ink shadow-(--shadow-node-selected)"
      } ${className}`}
      style={{
        left: rect.x,
        top: rect.y,
        width: rect.width,
        height: rect.height,
        ...(running ? { border: "1.5px solid transparent", backgroundColor: "transparent" } : null),
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
          aria-label="Edit goal"
          data-testid="goal-frame-header"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onHeaderClick();
          }}
          className="absolute left-[18px] top-[-11px] z-[2] focus-visible:outline-2 focus-visible:outline-accent"
        >
          {tab}
        </button>
      ) : (
        <div className="pointer-events-none absolute left-[18px] top-[-11px] z-[2]">{tab}</div>
      )}

      <div className="relative z-1 flex flex-col gap-[4px] pt-[16px] pr-[30px] pl-[14px] max-md:pr-[60px]">
        {headerContent}
      </div>

      {children ? <div className="relative z-1 flex-1">{children}</div> : null}

      {/* The bound and the state share the frame's one mono footer line: the
          header is NOT in the flow the step cards are laid out against (React
          Flow positions those by canvas coordinate), so anything added there
          grows over the first card instead of pushing it down. */}
      <div
        data-testid="goal-frame-footer"
        className="pointer-events-none relative z-1 flex flex-col gap-[4px] px-[14px] pt-[8px] pb-[10px] font-mono text-[10.5px] leading-[14px] text-muted"
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
