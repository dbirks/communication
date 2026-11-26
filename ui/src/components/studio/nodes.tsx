/**
 * nodes.tsx — the presentational step and scope-group node bodies for the
 * Studio canvas. React Flow injects `data` (plus `selected`); all behaviour
 * rides on the handlers the canvas puts into `data`, so these components
 * stay dumb enough to render in isolation.
 */
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { IconBolt, IconCheck } from "@tabler/icons-react";
import type { CSSProperties, KeyboardEvent } from "react";
import { useState } from "react";
import { StepKindIcon } from "../../lib/stepIcons";
import { StepPicker } from "./StepPicker";
import { GoalFrame } from "./wrap/GoalFrame";
import type { GoalSpec } from "./wrap/wrapModel";
import { VerdictStack, type VerdictRound } from "./wrap/VerdictStack";

export type StepNodeRender = {
  id: string;
  kind: string;
  label: string;
  kindWord: string;
  deferred: string | null;
  when: string | null;
  terminal: boolean;
  readOnly: boolean;
  stale: boolean;
  highlight: boolean;
  status: { state: string; label: string } | null;
  /** The node's own config (the kind's fields) — the one key fact the second
   * line carries; absent when the kind has none / the doc has none. */
  config?: Record<string, unknown>;
  /** Layout direction for the handle positions; falls back to the canvas's last layout. */
  direction?: "LR" | "TB";
  onSelect: () => void;
  /**
   * Opens this step's Duplicate/Delete menu — the ⋯ button on the SELECTED
   * step (issue #66: a plain left click only selects; the verbs live on
   * right-click, on this ⋯, and on the keyboard, so touch and keyboard users
   * still reach them). Null on a canvas that cannot run them (read-only,
   * stale YAML), and the button never renders without it.
   */
  onMenu: (() => void) | null;
  /** Present only on terminal steps: opens the picker, then adds after this. */
  onAddAfter: ((kind: string) => void) | null;
};

export type ScopeNodeRender = {
  id: string;
  kind: string;
  headerText: string;
  loopNote: string | null;
  goal?: GoalSpec | null;
  verdicts?: VerdictRound[];
  emptyBody: boolean;
  readOnly: boolean;
  stale: boolean;
  /** Run Workbench overlay ("iteration 2 of 4", "14 items: …"). */
  status: { state: string; label: string } | null;
  /** Layout direction for the handle positions; falls back to the canvas's last layout. */
  direction?: "LR" | "TB";
  /** Width/height from flow layout so GoalFrame fills the scope node cleanly. */
  boxWidth?: number;
  boxHeight?: number;
  /** Clicking a GoalFrame header opens its edit card. */
  onEditGoal?: () => void;
  /** Opens this scope's NodeMenu (⋯ button on the selected scope). */
  onMenu?: (() => void) | null;
  /** Present only when the body is empty: opens the picker, then adds inside. */
  onAddInside: ((kind: string) => void) | null;
};

export type TriggerNodeRender = {
  subline: string;
  direction?: "LR" | "TB";
  onClick?: () => void;
};

type StepStateCategory = "done" | "running" | "waiting" | "failed" | "interrupted" | null;

function stepStateCategory(state: string | undefined): StepStateCategory {
  if (!state) return null;
  const s = state.toLowerCase();
  if (
    s.includes("succe") ||
    s.includes("done") ||
    s.includes("complet") ||
    s.includes("verified") ||
    s.includes("approved")
  )
    return "done";
  if (s.includes("run") || s === "active") return "running";
  if (s.includes("wait")) return "waiting";
  // `interrupted` is its OWN state set (ds/states: ⊘ / "stopped") — a stopped
  // step is not a failed one, and a card that paints it plain white says
  // "nothing happened here" about a step the run did stop.
  if (s.includes("interrupt") || s.includes("cancel") || s === "stopped") return "interrupted";
  if (s.includes("fail") || s.includes("error")) return "failed";
  return null;
}

/** The status glyph always travels with the word — colour is never the signal. */
function statusGlyph(state: string): string {
  const s = state.toLowerCase();
  if (s.includes("run") || s === "active") return "●";
  if (
    s.includes("succe") ||
    s.includes("done") ||
    s.includes("complet") ||
    s.includes("verified") ||
    s.includes("approved")
  )
    return "✓";
  // ⊘ is the interrupted set's glyph (ds/states): stopped, outcome unknown.
  // It is NOT the failed set's ×, and the old `cancel` → × mapping printed a
  // failure mark on every box a cancelled run had stopped.
  if (s.includes("interrupt") || s.includes("cancel") || s === "stopped") return "⊘";
  if (s.includes("fail") || s.includes("error")) return "×";
  // "!" is the waiting set's glyph — a person must answer it. Not-started
  // work (queued/pending) carries the queued set's neutral dot instead
  // (ds/states: queued is "·"), so an unstarted box never reads as urgent.
  if (s.includes("wait")) return "!";
  if (s.includes("pend") || s.includes("queue") || s.includes("skip")) return "·";
  if (s.includes("retry")) return "↻";
  return "·";
}

/** The state's own text colour, for a status line that rides a coloured frame. */
function stateToneClass(state: string | undefined): string {
  switch (stepStateCategory(state)) {
    case "done":
      return "text-st-done-pale-fg";
    case "running":
      return "text-st-running-pale-fg";
    case "waiting":
      return "text-st-waiting-pale-fg";
    case "failed":
      return "text-st-failed-pale-fg";
    case "interrupted":
      return "text-st-interrupted-pale-fg";
    default:
      return "text-muted";
  }
}

/** The ONE key fact a canvas node carries beyond icon + kind word: the
 * kind's own config value — the model name, the command, the approver, the
 * artifact — or nothing. Absent → the second line is kind word only;
 * nothing is ever invented (design 1g).
 */
function keyFactFor(kind: string, config: Record<string, unknown> | undefined): string | null {
  const c = config ?? {};
  const text = (v: unknown): string | null =>
    typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
  switch (kind) {
    case "agent.acp":
      return text(c.profile);
    case "model.chat":
      return text(c.model);
    case "process.exec": {
      const cmd = text(c.executable);
      if (cmd) return cmd;
      const args = Array.isArray(c.args)
        ? c.args.filter((a): a is string => typeof a === "string")
        : [];
      return text(args[0]) ?? null;
    }
    case "human.approval":
      return text(c.approver) ?? (Array.isArray(c.approverRoles) ? text(c.approverRoles[0]) : null);
    case "artifact.publish":
      return text(c.name);
    default:
      return null;
  }
}

/**
 * Handles stay in the DOM in every mode — a read-only canvas still needs
 * them for edge geometry (an edge with no resolvable handle is dropped).
 * Design 1g draws no handle dots: the interactive ones stay invisible at
 * rest and only appear when the pointer reaches them (hover = "connecting");
 * they keep full pointer events so a connection drag still starts there.
 */
const handleClass = (interactive: boolean): string =>
  interactive
    ? "!h-[10px] !w-[10px] !border-[1.5px] !border-accent !bg-surface opacity-0 group-hover:opacity-100 focus:opacity-100"
    : "!h-2 !w-2 !border-transparent !bg-transparent opacity-0 !pointer-events-none";

export function StepNode(props: NodeProps<Node<StepNodeRender>>) {
  const { data, selected } = props;
  const [pickerOpen, setPickerOpen] = useState(false);
  const interactive = !data.readOnly && !data.stale;
  // The Studio canvas is ALWAYS top-to-bottom (design 1g): the handles ride
  // the node's top and bottom in every canvas view that renders a definition
  // graph, so a dragged step keeps its bottom→top connections.
  const inPosition = data.direction === "LR" ? Position.Left : Position.Top;
  const outPosition = data.direction === "LR" ? Position.Right : Position.Bottom;

  // Design 1g keeps exactly two lines in the node: the id, and kind icon +
  // kind word + one key fact. The `when` guard is not drawn on the node — it
  // stays visible in the inspector and the edge labels.
  const pick = (event: KeyboardEvent) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      data.onSelect();
    }
  };

  const keyFact = keyFactFor(data.kind, data.config);
  // Issue #66 place fix: the ⋯ rides the SELECTED step's top-right corner, and
  // the truncated text lines stop short of it (pr) so nothing hides under the
  // button's opaque box at any width (at 390 the phone floor grows the button
  // to 44px tall, spanning both lines' right ends).
  const showMenu = Boolean(selected && interactive && data.onMenu);
  const menuPad = showMenu ? " pr-[24px]" : "";
  // Issue #65: the kind's icon rides in front of the line (aria-hidden); the
  // line's text is the accessible content, so `title` and `textContent` stay
  // the same string.
  const secondLine = keyFact ? `${data.kindWord} · ${keyFact}` : data.kindWord;
  const stateCat = stepStateCategory(data.status?.state);
  const cardSurfaceClass = selected
    ? stateCat === "running"
      ? "border-accent bg-st-running-pale-body"
      : stateCat === "waiting"
        ? "border-accent bg-st-waiting-pale-body"
        : stateCat === "failed"
          ? "border-accent bg-st-failed-pale-body"
          : stateCat === "interrupted"
            ? "border-accent bg-st-interrupted-pale-body"
            : "border-accent bg-surface"
    : stateCat === "running"
      ? "border-st-running-strong bg-st-running-pale-body"
      : stateCat === "waiting"
        ? "border-st-waiting-pale-edge bg-st-waiting-pale-body"
        : stateCat === "failed"
          ? "border-st-failed-pale-edge bg-st-failed-pale-body"
          : stateCat === "interrupted"
            ? "border-st-interrupted-pale-edge bg-st-interrupted-pale-body"
            : "border-line bg-surface";
  const tileClass =
    stateCat === "done"
      ? "bg-st-done-tag text-st-done-tag-fg"
      : stateCat === "interrupted"
        ? "bg-st-interrupted-tag text-st-interrupted-tag-fg"
        : data.kind === "model.chat" || data.kind === "agent.acp"
          ? "bg-accent-tint text-accent-edge"
          : data.kind === "human.approval"
            ? "bg-st-waiting-tag text-st-waiting-tag-fg"
            : "bg-fill text-ink-2";

  return (
    <div
      className="group relative"
      data-highlight={data.highlight ? "assistant-proposed" : undefined}
      data-step-node-id={data.id}
      data-state-kind={stateCat ?? undefined}
      data-testid={`canvas-step-${data.id}`}
    >
      <Handle id="in" type="target" position={inPosition} className={handleClass(interactive)} />
      <Handle id="out" type="source" position={outPosition} className={handleClass(interactive)} />
      <div
        role="button"
        tabIndex={interactive ? 0 : -1}
        aria-label={
          data.status
            ? `${data.label} step ${data.id} · ${data.status.label}`
            : `${data.label} step ${data.id}`
        }
        onClick={() => data.onSelect()}
        onKeyDown={pick}
        className={`flex ${data.status ? "min-h-[56px] py-1" : "h-[56px]"} w-[168px] items-center gap-[10px] rounded-[10px] border px-3 text-left outline-none focus-visible:outline-2 focus-visible:outline-accent ${cardSurfaceClass} ${data.stale ? "opacity-70" : ""}`}
      >
        <span
          data-testid={`canvas-step-tile-${data.id}`}
          className={`grid h-[30px] w-[30px] shrink-0 place-items-center rounded-[8px] ${tileClass}`}
        >
          {stateCat === "done" ? (
            <IconCheck size={17} stroke={1.75} aria-hidden />
          ) : (
            <StepKindIcon kind={data.kind} size={16} />
          )}
        </span>
        <span className={`min-w-0 flex-1 ${menuPad}`}>
          <span
            className="block truncate text-[13.5px] font-semibold leading-[17px]"
            title={data.id}
          >
            {data.id}
          </span>
          <span
            className="block truncate font-mono text-[11px] leading-[15px] text-muted"
            data-testid={`canvas-step-fact-${data.id}`}
            title={secondLine}
          >
            {secondLine}
          </span>
          {data.status && (
            <span
              className="block truncate text-[10px] leading-3"
              aria-label={`status: ${data.status.label}`}
              // The card's role=button aria-label OVERRIDES its text content for
              // an assistive tech, so the state word has to ride that name (and a
              // hover title) — a sighted-only "✓ done" is colour-alone for anyone
              // who cannot see the tile (identity rule 06).
              title={data.status.label}
              data-testid={`step-status-${data.id}`}
            >
              {statusGlyph(data.status.state)} {data.status.label}
            </span>
          )}
        </span>
      </div>

      {/* Issue #66: Duplicate/Delete left the plain-click toolbar and live on
          right-click, the keyboard and THIS ⋯ — drawn only while the step is
          selected, so the touch user who has no right-click reaches the verbs
          from the step they just selected. The shared `.icon-hit` utility
          (#68) grows the desktop hit area to 30×30 without growing the painted
          dot; the phone band's `main button` floor gives it 44px there.

          Issue #66 place: the ⋯ sits in the step's TOP-RIGHT corner, INSIDE
          the card — clear of the outgoing edge (which leaves the bottom-centre
          handle) and of every edge “+”. The pass-1 review caught it drawn at
          the card's BOTTOM-LEFT, ON the edge line, even though the class read
          `absolute right-[2px] top-[2px]`: `.icon-hit` lives OUTSIDE Tailwind
          v4's `@layer utilities` (by design — it must outrank component-layer
          pseudo rules) and its `position: relative` therefore beat the plain
          `absolute` utility, dropping the button into FLOW under the 200×52
          card. `absolute!` compiles to `position:absolute !important`, which
          the unlayered rule cannot outrank (the same trick as `items-stretch!`
          below against the phone band's `main [role="button"]` rule). */}
      {showMenu && (
        <button
          type="button"
          data-testid={`node-menu-button-${data.id}`}
          aria-label={`Actions for step ${data.id}`}
          aria-haspopup="menu"
          className="icon-hit absolute! right-[2px] top-[2px] z-20 grid h-[20px] w-[20px] place-items-center rounded-[6px] border border-line bg-surface text-[12px] leading-none text-ink-2 hover:border-accent hover:text-accent"
          // Same guard as every canvas affordance: the pointerdown must not
          // reach React Flow (node drag / selection churn) or the menu's own
          // click-away, and the click must not re-trigger the step's select.
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            data.onMenu?.();
          }}
        >
          <span aria-hidden="true">⋯</span>
        </button>
      )}

      {data.terminal && interactive && data.onAddAfter && (
        <div
          className="group absolute left-1/2 flex -translate-x-1/2 flex-col items-center"
          style={{ top: "100%" }}
        >
          {/* Short dashed stub below the sink, on the node's vertical axis
              (design 1g); the "+" sits at the end of the stub, never on the
              node's edge. */}
          <span
            aria-hidden="true"
            className="h-[10px] w-px border-l border-dashed border-line-strong"
          />
          <button
            type="button"
            data-testid={`add-after-${data.id}`}
            aria-label={`Add a step after ${data.id}`}
            // A 44px target that DRAWS a 22px circle (the phone band's
            // `min-height: 44px` stretched the circle itself into a tall pill,
            // and the emulator's touch-target check measures the real box): the
            // circle sits at the top of the button, on the stub's end exactly
            // where it always sat, and the extra 22px of hit area falls into
            // the empty band below it.
            className="-mt-px grid h-[44px] w-[44px] place-items-start justify-center bg-transparent outline-none focus-visible:ring-2 focus-visible:ring-accent"
            // The "+" opens the picker and NOTHING else: without the
            // pointerdown guard the gesture reaches the node and the step
            // gets selected on the same click that opens the picker.
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              setPickerOpen(true);
            }}
          >
            <span
              aria-hidden
              className="grid h-[22px] w-[22px] place-items-center rounded-full border-[2px] border-dashed border-line-strong bg-surface text-sm leading-none text-ink-2 group-hover:border-accent group-hover:text-accent"
            >
              +
            </span>
          </button>
          {pickerOpen && (
            <div className="absolute left-1/2 top-full z-50 -translate-x-1/2">
              <StepPicker
                title={`Add a step after ${data.label} (${data.id})`}
                onPick={(kind) => {
                  setPickerOpen(false);
                  data.onAddAfter?.(kind);
                }}
                onClose={() => setPickerOpen(false)}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function ScopeNode(props: NodeProps<Node<ScopeNodeRender>>) {
  const { data, selected } = props;
  const [pickerOpen, setPickerOpen] = useState(false);
  const interactive = !data.readOnly && !data.stale;
  const inPosition = data.direction === "LR" ? Position.Left : Position.Top;
  const outPosition = data.direction === "LR" ? Position.Right : Position.Bottom;
  const width = props.width ?? data.boxWidth ?? 224;
  const height = props.height ?? data.boxHeight ?? 160;
  const running = stepStateCategory(data.status?.state) === "running";
  // A goal frame carries its run state the same way a step card does: the
  // glyph+word pair, in the state's own colour.
  const frameStatus = data.status
    ? {
        text: `${statusGlyph(data.status.state)} ${data.status.label}`,
        className: stateToneClass(data.status.state),
      }
    : null;
  const showMenu = Boolean(selected && interactive && data.onMenu);
  const scopeMenuBtn = showMenu ? (
    <button
      type="button"
      data-testid={`node-menu-button-${data.id}`}
      aria-label={`Actions for scope ${data.id}`}
      aria-haspopup="menu"
      className="icon-hit absolute! right-[6px] top-[6px] z-20 grid h-[20px] w-[20px] place-items-center rounded-[6px] border border-line bg-surface text-[12px] leading-none text-ink-2 hover:border-accent hover:text-accent"
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        data.onMenu?.();
      }}
    >
      <span aria-hidden="true">⋯</span>
    </button>
  ) : null;

  const emptyBodyNode = data.emptyBody ? (
    <div className="flex h-[calc(100%-2.25rem)] w-full items-center justify-center">
      {interactive && data.onAddInside ? (
        <button
          type="button"
          data-testid={`add-inside-${data.id}`}
          className="rounded-md border border-dashed border-line-strong bg-surface px-2.5 py-1 text-[12px] text-ink-2 hover:border-accent hover:text-accent"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            setPickerOpen(true);
          }}
        >
          + Add step inside
        </button>
      ) : (
        <span className="text-[12px] text-muted">empty body</span>
      )}
      {pickerOpen && (
        <div className="absolute left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2">
          <StepPicker
            title={`Add a step inside ${data.id}`}
            onPick={(kind) => {
              setPickerOpen(false);
              data.onAddInside?.(kind);
            }}
            onClose={() => setPickerOpen(false)}
          />
        </div>
      )}
    </div>
  ) : null;

  if (data.goal) {
    return (
      <div className="relative h-full w-full" data-testid={`canvas-scope-${data.id}`}>
        <Handle id="in" type="target" position={inPosition} className={handleClass(false)} />
        <Handle id="out" type="source" position={outPosition} className={handleClass(false)} />
        <GoalFrame
          rect={{ x: 0, y: 0, width, height }}
          goal={data.goal}
          running={running}
          status={frameStatus}
          onHeaderClick={interactive ? data.onEditGoal : undefined}
        >
          {emptyBodyNode}
        </GoalFrame>
        {scopeMenuBtn}
        {data.verdicts && data.verdicts.length > 0 ? (
          <div
            className="pointer-events-auto absolute left-full top-0 z-10 ml-[14px]"
            onPointerDown={(e) => e.stopPropagation()}
          >
            <VerdictStack rounds={data.verdicts} />
          </div>
        ) : null}
      </div>
    );
  }

  const style: CSSProperties = {
    borderRadius: 16,
    border: "1.5px solid var(--color-line-strong)",
    background: "transparent",
  };

  return (
    <div className="relative h-full w-full" data-testid={`canvas-scope-${data.id}`} style={style}>
      {/* Scope boxes are edge endpoints (a scope is a node in the graph), so
       * they need the handles the edges resolve against — never draggable. */}
      <Handle id="in" type="target" position={inPosition} className={handleClass(false)} />
      <Handle id="out" type="source" position={outPosition} className={handleClass(false)} />
      <div className="flex items-center gap-1.5 px-[14px] pt-[10px]">
        <span className="truncate font-mono text-[10.5px] text-muted">{data.headerText}</span>
        {data.status && (
          <span
            className="ml-auto shrink-0 text-[11px] font-semibold leading-none text-ink"
            aria-label={`status: ${data.status.label}`}
            data-testid={`scope-status-${data.id}`}
            title={data.status.label}
          >
            <span aria-hidden="true">{statusGlyph(data.status.state)}</span> {data.status.label}
          </span>
        )}
      </div>
      {scopeMenuBtn}
      {emptyBodyNode}
    </div>
  );
}

export function TriggerNode(props: NodeProps<Node<TriggerNodeRender>>) {
  const { data } = props;
  const outPosition = data.direction === "LR" ? Position.Right : Position.Bottom;
  return (
    <div className="relative" data-testid="canvas-trigger-node">
      <Handle id="out" type="source" position={outPosition} className={handleClass(false)} />
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          data.onClick?.();
        }}
        disabled={!data.onClick}
        aria-label={`Trigger: ${data.subline}`}
        className="flex h-[56px] w-[168px] items-center gap-[10px] rounded-[10px] border border-line bg-surface px-3 text-left outline-none hover:border-line-strong focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-default"
      >
        <span className="grid h-[30px] w-[30px] shrink-0 place-items-center rounded-[8px] bg-ink text-surface">
          <IconBolt size={17} stroke={1.5} aria-hidden />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13.5px] font-semibold leading-[17px] text-ink">
            Trigger
          </span>
          <span
            className="block truncate font-mono text-[11px] leading-[15px] text-muted"
            title={data.subline}
          >
            {data.subline}
          </span>
        </span>
      </button>
    </div>
  );
}
