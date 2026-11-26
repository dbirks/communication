/**
 * GoalFrame — presentational frame drawn around a Repeat-until loop on the
 * canvas, showing the human goal sentence, quoted goal text, round bound, and
 * optional animated MarchingAnts outline while a run is executing.
 */
import type { ReactNode } from "react";
import { IconRepeat } from "@tabler/icons-react";
import { MarchingAnts, type MarchingAntsRect } from "./MarchingAnts";
import { goalSentence, type GoalSpec } from "./wrapModel";

export interface GoalFrameProps {
  rect: MarchingAntsRect;
  goal: GoalSpec;
  giveUpText?: string;
  running?: boolean;
  /** The frame's OWN run state, glyph + word composed by the caller ("✓ done",
   * "⊘ stopped", "· not started"). A goal frame is a step like any other: while
   * or after its loop runs the frame has to SAY its state — the animated outline
   * is motion, never a word (identity rule 06). Absent while editing. */
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
  const roundWord = goal.maxRounds === 1 ? "round" : "rounds";
  const tail = giveUpText ?? "then stop";

  const headerContent = (
    <>
      <span className="flex items-center gap-[6px] text-[12px] font-semibold text-accent-edge">
        <IconRepeat size={15} stroke={1.5} aria-hidden className="shrink-0" />
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
        <span>
          up to {goal.maxRounds} {roundWord} · {tail}
        </span>
        {status ? (
          <span
            data-testid="goal-frame-status"
            title={status.text}
            className={`self-end whitespace-nowrap font-semibold ${status.className}`}
          >
            {status.text}
          </span>
        ) : null}
      </div>
    </div>
  );
}
