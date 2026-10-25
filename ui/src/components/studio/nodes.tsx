/**
 * nodes.tsx — the presentational step and scope-group node bodies for the
 * Studio canvas. React Flow injects `data` (plus `selected`); all behaviour
 * rides on the handlers the canvas puts into `data`, so these components
 * stay dumb enough to render in isolation.
 */
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import type { CSSProperties, KeyboardEvent } from "react";
import { useState } from "react";
import { kindGlyph } from "../../lib/pipeline/definition";
import { StepPicker } from "./StepPicker";

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
  /** Present only on terminal steps: opens the picker, then adds after this. */
  onAddAfter: ((kind: string) => void) | null;
};

export type ScopeNodeRender = {
  id: string;
  kind: string;
  headerText: string;
  loopNote: string | null;
  emptyBody: boolean;
  readOnly: boolean;
  stale: boolean;
  /** Run Workbench overlay ("iteration 2 of 4", "14 items: …"). */
  status: { state: string; label: string } | null;
  /** Layout direction for the handle positions; falls back to the canvas's last layout. */
  direction?: "LR" | "TB";
  /** Present only when the body is empty: opens the picker, then adds inside. */
  onAddInside: ((kind: string) => void) | null;
};

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
  if (s.includes("fail") || s.includes("cancel") || s.includes("error")) return "×";
  // "!" is the waiting set's glyph — a person must answer it. Not-started
  // work (queued/pending) carries the queued set's neutral dot instead
  // (ds/states: queued is "·"), so an unstarted box never reads as urgent.
  if (s.includes("wait")) return "!";
  if (s.includes("pend") || s.includes("queue")) return "·";
  return "•";
}

const chip =
  "rounded-full border border-line bg-fill px-1.5 py-0.5 text-[10px] leading-4 text-muted";

/** The ONE key fact a canvas node carries beyond glyph + kind word: the
 * kind's own config value — the model name, the command, the approver, the
 * artifact — or nothing. Absent → the second line is glyph + kind word only;
 * nothing is ever invented (design 1g).
 */
function keyFactFor(kind: string, config: Record<string, unknown> | undefined): string | null {
  const c = config ?? {};
  const text = (v: unknown): string | null =>
    typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
  switch (kind) {
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
    ? "!h-2 !w-2 !border-transparent !bg-transparent opacity-0 hover:opacity-100 hover:!border-line-strong hover:!bg-surface"
    : "!h-2 !w-2 !border-transparent !bg-transparent opacity-0 !pointer-events-none";

export function StepNode(props: NodeProps<Node<StepNodeRender>>) {
  const { data, selected } = props;
  const [pickerOpen, setPickerOpen] = useState(false);
  const interactive = !data.readOnly && !data.stale;
  // The Studio canvas is ALWAYS top-to-bottom (design 1g): the handles ride
  // the node's top and bottom in every canvas view that renders a definition
  // graph, so a dragged step keeps its bottom→top connections.
  const inPosition = Position.Top;
  const outPosition = Position.Bottom;

  // Design 1g keeps exactly two lines in the node: the id, and glyph + kind
  // word + one key fact. The `when` guard is not drawn on the node — it
  // stays visible in the inspector and the edge labels.
  const pick = (event: KeyboardEvent) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      data.onSelect();
    }
  };

  const keyFact = keyFactFor(data.kind, data.config);
  const secondLine = keyFact
    ? `${kindGlyph(data.kind)} ${data.kindWord} · ${keyFact}`
    : `${kindGlyph(data.kind)} ${data.kindWord}`;

  return (
    <div
      className="relative"
      data-highlight={data.highlight ? "assistant-proposed" : undefined}
      data-testid={`canvas-step-${data.id}`}
    >
      <Handle id="in" type="target" position={inPosition} className={handleClass(interactive)} />
      <Handle id="out" type="source" position={outPosition} className={handleClass(interactive)} />
      <div
        role="button"
        tabIndex={interactive ? 0 : -1}
        aria-label={`${data.label} step ${data.id}`}
        onClick={() => data.onSelect()}
        onKeyDown={pick}
        className={[
          "flex h-full flex-col rounded-md border bg-surface px-2.5 text-left outline-none",
          data.status ? "gap-[2px] py-1" : "gap-0.5 py-2",
          selected ? "border-accent shadow-[0_0_0_2px_var(--color-accent-ring)]" : "border-line",
          data.stale ? "opacity-70" : "",
        ].join(" ")}
        style={{ width: 200, height: 52 }}
      >
        <div
          className="truncate text-[13.5px] font-semibold leading-none text-ink"
          title={`${data.id} (${data.label})`}
        >
          {data.id}
        </div>
        {data.status && (
          <div
            className="flex min-w-0 items-start gap-1 text-[11px] leading-tight text-ink-2"
            aria-label={`status: ${data.status.label}`}
            data-testid={`step-status-${data.id}`}
            title={data.status.label}
          >
            <span aria-hidden="true" className="shrink-0">
              {statusGlyph(data.status.state)}
            </span>
            {/* Single line: the layout box reserves no room for a wrapped
                second line — wrapping pushed the rendered node below its
                dagre box and the neighbour edge labels grazed it. */}
            <span className="min-w-0 truncate">{data.status.label}</span>
          </div>
        )}
        <div className="flex items-center gap-1.5">
          <span
            className="truncate font-mono text-[11px] leading-none text-ink-2"
            title={data.label}
          >
            {secondLine}
          </span>
          {data.deferred && <span className={chip}>{data.deferred}</span>}
        </div>
      </div>

      {data.terminal && interactive && data.onAddAfter && (
        <div
          className="absolute left-1/2 flex -translate-x-1/2 flex-col items-center"
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
            className="-mt-px flex h-[22px] w-[22px] items-center justify-center rounded-full border-[2px] border-dashed border-line-strong bg-surface text-sm leading-none text-ink-2 hover:border-accent hover:text-accent hover:shadow-[0_0_0_2px_var(--color-accent-ring)]"
            // The "+" opens the picker and NOTHING else: without the
            // pointerdown guard the gesture reaches the node and the step
            // gets selected on the same click that opens the picker.
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              setPickerOpen(true);
            }}
          >
            +
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

/** The recurrence arrow: drawn inside the box, aria-hidden, never serialized. */
function RecurrenceArrow() {
  return (
    <svg
      className="pointer-events-none absolute right-1 top-7 h-[calc(100%-2.5rem)] w-10 text-faint"
      viewBox="0 0 40 80"
      fill="none"
      aria-hidden="true"
      preserveAspectRatio="none"
    >
      <title>repeats until the pass condition holds — illustration only</title>
      <path
        d="M 20 74 C 38 62, 38 18, 20 6"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeDasharray="3 3"
      />
      <path d="M 14 10 L 20 5 L 25 11" stroke="currentColor" strokeWidth="1.5" fill="none" />
    </svg>
  );
}

export function ScopeNode(props: NodeProps<Node<ScopeNodeRender>>) {
  const { data } = props;
  const [pickerOpen, setPickerOpen] = useState(false);
  const interactive = !data.readOnly && !data.stale;
  // The Studio canvas is ALWAYS top-to-bottom (design 1g): the handles ride
  // the scope group's top and bottom (a scope is a node like any other).
  const inPosition = Position.Top;
  const outPosition = Position.Bottom;

  const style: CSSProperties = {
    // The dagre group box already reserves the header bar; the border just
    // traces it.
    borderRadius: 8,
    border: `1px solid var(--color-line-strong)`,
    background: "color-mix(in srgb, var(--color-fill) 55%, transparent)",
  };

  return (
    <div className="relative h-full w-full" data-testid={`canvas-scope-${data.id}`} style={style}>
      {/* Scope boxes are edge endpoints (a scope is a node in the graph), so
       * they need the handles the edges resolve against — never draggable. */}
      <Handle id="in" type="target" position={inPosition} className={handleClass(false)} />
      <Handle id="out" type="source" position={outPosition} className={handleClass(false)} />
      <div className="flex items-center gap-1.5 rounded-t-lg border-b border-line-strong bg-fill px-2.5 py-1">
        <span className="truncate text-[11px] font-semibold uppercase tracking-wide text-ink-2">
          {data.headerText}
        </span>
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
      <RecurrenceArrow />
      {data.emptyBody && (
        <div className="flex h-[calc(100%-1.75rem)] w-full items-center justify-center">
          {interactive && data.onAddInside ? (
            <button
              type="button"
              data-testid={`add-inside-${data.id}`}
              className="rounded-md border border-dashed border-line-strong bg-surface px-2.5 py-1 text-[12px] text-ink-2 hover:border-accent hover:text-accent"
              // Same "+" contract as the edge/terminal affordances: the
              // pointerdown must not reach the scope node, or the click that
              // opens the picker also selects the scope.
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
      )}
    </div>
  );
}
