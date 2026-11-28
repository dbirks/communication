import { useRef } from "react";
import type {
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
} from "react";
import { IconChevronDown, IconChevronUp, IconPlayerStopFilled } from "@tabler/icons-react";

export type TrayTab = "rounds" | "log" | "output";

export interface TrayRound {
  round: number;
  verdict: "not_yet" | "done" | "running" | "failed";
  reason: string;
}

export interface TrayLogLine {
  /** Already formatted for display, e.g. "14:02:11". */
  at: string;
  step: string;
  text: string;
}

export interface RunTrayState {
  glyph: string;
  word: string;
  tone: "running" | "done" | "failed" | "waiting" | "queued";
}

export interface RunTrayProps {
  state: RunTrayState;
  /** e.g. "Try it on #42" or "Run 1a2b3c4d". */
  title: string;
  /** e.g. "round 2 of up to 3 · 1m 42s". */
  meta: string;
  /** Empty when the workflow has no loop. */
  rounds: TrayRound[];
  log: TrayLogLine[];
  /** When set, only lines of this step show and the header names it. */
  logStep?: string | null;
  /** The highlighted round row. */
  activeRound?: number | null;
  /** The Output tab body (the orchestrator provides it). */
  output?: ReactNode;
  tab: TrayTab;
  onTab(tab: TrayTab): void;
  onRound?(round: number): void;
  /** Shows Stop while set. */
  onStop?(): void;
  /** Extra header controls after the meta (e.g. "Open run", "Back to editing"). */
  actions?: ReactNode;
  /** Only the header row shows. */
  collapsed: boolean;
  onToggleCollapsed(): void;
  /** Body height in px when open. */
  height: number;
  /** Drag on the top edge (min 120, max 60% of window.innerHeight). */
  onResize(height: number): void;
}

const MIN_HEIGHT = 120;
const KEY_STEP = 20;

/** Smallest legal tray height, then 60% of the window (README 1c). */
function clampHeight(height: number): number {
  const max = Math.floor(0.6 * window.innerHeight);
  return Math.min(Math.max(height, MIN_HEIGHT), Math.max(max, MIN_HEIGHT));
}

/** Mono state tag; the five state colour sets (README 1c). */
const TAG_CLASS =
  "shrink-0 rounded-[4px] px-[5px] py-[1px] font-mono text-[9.5px] leading-[14px] font-semibold uppercase tracking-[0.03em]";

const TONE_CLASS: Record<RunTrayState["tone"], string> = {
  running: "bg-st-running-tag text-st-running-tag-fg",
  done: "bg-st-done-tag text-st-done-tag-fg",
  failed: "bg-st-failed-tag text-st-failed-tag-fg",
  waiting: "bg-st-waiting-tag text-st-waiting-tag-fg",
  queued: "bg-fill text-ink-2",
};

const VERDICT: Record<TrayRound["verdict"], string> = {
  not_yet: "× NOT YET",
  done: "✓ DONE",
  running: "● RUNNING",
  failed: "× FAILED",
};

const VERDICT_TONE: Record<TrayRound["verdict"], string> = {
  not_yet: "bg-st-failed-tag text-st-failed-tag-fg",
  done: "bg-st-done-tag text-st-done-tag-fg",
  running: "bg-st-running-tag text-st-running-tag-fg",
  failed: "bg-st-failed-tag text-st-failed-tag-fg",
};

const TABS: { id: TrayTab; label: string }[] = [
  { id: "rounds", label: "Rounds" },
  { id: "log", label: "Log" },
  { id: "output", label: "Output" },
];

const ROW_CLASS =
  "grid w-full grid-cols-[26px_auto_1fr] items-start gap-[10px] px-3 py-2 text-left";

function RoundList({
  rounds,
  activeRound,
  onRound,
}: {
  rounds: TrayRound[];
  activeRound?: number | null;
  onRound?: (round: number) => void;
}) {
  return (
    <div data-testid="run-tray-rounds" className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      {rounds.length === 0 ? (
        <p className="px-3 py-2 text-[12.5px] text-muted">This workflow has no loop.</p>
      ) : null}
      {rounds.map((entry) => {
        const row = (
          <>
            <span className="font-mono text-[11px] text-muted">R{entry.round}</span>
            <span className={`${TAG_CLASS} ${VERDICT_TONE[entry.verdict]}`}>
              {VERDICT[entry.verdict]}
            </span>
            <span className="text-[12.5px] leading-[18px] text-ink-2">{entry.reason}</span>
          </>
        );
        const active = activeRound != null && activeRound === entry.round;
        if (!onRound) {
          return (
            <div key={entry.round} className={`${ROW_CLASS} ${active ? "bg-accent-wash" : ""}`}>
              {row}
            </div>
          );
        }
        return (
          <button
            key={entry.round}
            type="button"
            data-testid={`run-tray-round-${entry.round}`}
            onClick={() => onRound(entry.round)}
            className={`${ROW_CLASS} ${active ? "bg-accent-wash" : ""} hover:bg-disabled-bg`}
          >
            {row}
          </button>
        );
      })}
    </div>
  );
}

function LogPanel({ log, logStep }: { log: TrayLogLine[]; logStep?: string | null }) {
  const lines = logStep ? log.filter((line) => line.step === logStep) : log;
  return (
    <section data-testid="run-tray-log" className="flex min-w-0 flex-1 flex-col overflow-hidden">
      <div className="shrink-0 px-3 py-2 font-mono text-[10.5px] font-semibold uppercase tracking-[0.06em] text-muted">
        {logStep ? `LOG · ${logStep.toUpperCase()}` : "LOG"}
      </div>
      {lines.length === 0 ? (
        <p className="px-3 pb-2 text-[12.5px] text-muted">Nothing logged yet.</p>
      ) : (
        <ol className="min-h-0 flex-1 overflow-y-auto px-3 pb-2">
          {lines.map((line, index) => (
            <li
              key={`${line.at}-${index}`}
              className="font-mono text-[11.5px] leading-[19px] text-ink-2"
            >
              <span className="text-faint">{line.at}</span> {line.text}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

/**
 * The run tray docked under the canvas (editor-interactions README 1c): state
 * tag, title, meta, the Rounds / Log / Output segmented control, optional
 * Stop, and a collapsible, resizable body. Presentational — the orchestrator
 * feeds every value and owns the height.
 */
export function RunTray({
  state,
  title,
  meta,
  rounds,
  log,
  logStep = null,
  activeRound = null,
  output,
  tab,
  onTab,
  onRound,
  onStop,
  actions,
  collapsed,
  onToggleCollapsed,
  height,
  onResize,
}: RunTrayProps) {
  const drag = useRef<{ startY: number; startHeight: number } | null>(null);

  const startDrag = (event: ReactPointerEvent<HTMLElement>) => {
    drag.current = { startY: event.clientY, startHeight: height };
    const el = event.currentTarget;
    if (typeof el.setPointerCapture === "function") el.setPointerCapture(event.pointerId);
  };
  const moveDrag = (event: ReactPointerEvent<HTMLElement>) => {
    const current = drag.current;
    if (!current) return;
    // Dragging up makes the tray taller.
    onResize(clampHeight(current.startHeight + (current.startY - event.clientY)));
  };
  const endDrag = () => {
    drag.current = null;
  };
  const onKey = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key === "ArrowUp") {
      event.preventDefault();
      onResize(clampHeight(height + KEY_STEP));
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      onResize(clampHeight(height - KEY_STEP));
    }
  };

  const maxHeight = clampHeight(Number.MAX_SAFE_INTEGER);

  return (
    <div
      data-testid="run-tray"
      className="flex w-full shrink-0 flex-col border-t border-fill-edge bg-surface"
    >
      {!collapsed ? (
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize run tray"
          aria-valuemin={MIN_HEIGHT}
          aria-valuemax={maxHeight}
          aria-valuenow={clampHeight(height)}
          tabIndex={0}
          data-testid="run-tray-resize"
          onPointerDown={startDrag}
          onPointerMove={moveDrag}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onKeyDown={onKey}
          className="h-[6px] shrink-0 cursor-ns-resize hover:bg-disabled-bg focus-visible:outline-2 focus-visible:outline-accent"
        />
      ) : null}

      <div
        data-testid="run-tray-header"
        className={`flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-[10px] ${collapsed ? "" : "border-b border-line-soft"}`}
      >
        <span className={`${TAG_CLASS} ${TONE_CLASS[state.tone]}`}>
          {state.glyph} {state.word}
        </span>
        <span className="min-w-[72px] truncate text-[13.5px] font-semibold text-ink">{title}</span>
        <span className="shrink-0 font-mono text-[11px] text-muted">{meta}</span>
        {actions ? (
          <div
            data-testid="run-tray-actions"
            className="flex shrink-0 items-center gap-[12px] text-[12.5px]"
          >
            {actions}
          </div>
        ) : null}

        <div
          role="tablist"
          aria-label="Run tray view"
          className="ml-auto flex shrink-0 items-center gap-[2px] rounded-[9px] bg-disabled-bg p-[3px] max-md:ml-0"
        >
          {TABS.map((entry) => {
            const selected = tab === entry.id;
            return (
              <button
                key={entry.id}
                type="button"
                role="tab"
                aria-selected={selected}
                data-testid={`run-tray-tab-${entry.id}`}
                onClick={() => onTab(entry.id)}
                className={`h-[26px] rounded-[7px] border px-[10px] text-[12.5px] font-semibold ${
                  selected
                    ? "border-fill-edge bg-surface text-ink"
                    : "border-transparent text-muted hover:text-ink-2"
                }`}
              >
                {entry.label}
              </button>
            );
          })}
        </div>

        {onStop ? (
          <button
            type="button"
            data-testid="run-tray-stop"
            onClick={onStop}
            className="ds-btn ds-btn--secondary h-[28px]! shrink-0"
          >
            <IconPlayerStopFilled size={12} stroke={1.5} aria-hidden />
            Stop
          </button>
        ) : null}

        <button
          type="button"
          aria-label={collapsed ? "Expand run tray" : "Collapse run tray"}
          data-testid="run-tray-collapse"
          onClick={onToggleCollapsed}
          className="flex h-[28px] w-[28px] shrink-0 items-center justify-center rounded-[7px] text-muted hover:bg-disabled-bg hover:text-ink-2 focus-visible:outline-2 focus-visible:outline-accent"
        >
          {collapsed ? (
            <IconChevronUp size={16} stroke={1.5} aria-hidden />
          ) : (
            <IconChevronDown size={16} stroke={1.5} aria-hidden />
          )}
        </button>
      </div>

      {collapsed ? null : (
        <div
          data-testid="run-tray-body"
          className="flex overflow-hidden max-md:flex-col max-md:overflow-y-auto"
          style={{ height }}
        >
          {tab === "rounds" ? (
            <>
              <div className="flex w-[400px] shrink-0 flex-col overflow-hidden max-md:w-full">
                <RoundList rounds={rounds} activeRound={activeRound} onRound={onRound} />
              </div>
              <LogPanel log={log} logStep={logStep} />
            </>
          ) : null}
          {tab === "log" ? <LogPanel log={log} logStep={logStep} /> : null}
          {tab === "output" ? (
            <div data-testid="run-tray-output" className="min-w-0 flex-1 overflow-y-auto px-3 py-2">
              {output ?? <span className="text-[12.5px] text-muted">No output yet.</span>}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
