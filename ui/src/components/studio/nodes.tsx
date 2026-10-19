/**
 * nodes.tsx — the presentational step and scope-group node bodies for the
 * Studio canvas. React Flow injects `data` (plus `selected`); all behaviour
 * rides on the handlers the canvas puts into `data`, so these components
 * stay dumb enough to render in isolation.
 */
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import type { CSSProperties, KeyboardEvent } from "react";
import { useState } from "react";
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
  if (s.includes("wait") || s.includes("pend") || s.includes("queue")) return "!";
  return "•";
}

const chip =
  "rounded-full border border-line bg-fill px-1.5 py-0.5 text-[10px] leading-4 text-muted";

export function StepNode(props: NodeProps<Node<StepNodeRender>>) {
  const { data, selected } = props;
  const [pickerOpen, setPickerOpen] = useState(false);
  const interactive = !data.readOnly && !data.stale;

  const pick = (event: KeyboardEvent) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      data.onSelect();
    }
  };

  return (
    <div
      className="relative"
      data-highlight={data.highlight ? "assistant-proposed" : undefined}
      data-testid={`canvas-step-${data.id}`}
    >
      {interactive && (
        <>
          <Handle
            id="in"
            type="target"
            position={Position.Top}
            className="!h-2 !w-2 !border-line-strong !bg-surface"
          />
          <Handle
            id="out"
            type="source"
            position={Position.Bottom}
            className="!h-2 !w-2 !border-line-strong !bg-surface"
          />
        </>
      )}
      <div
        role="button"
        tabIndex={interactive ? 0 : -1}
        aria-label={`${data.label} step ${data.id}`}
        onClick={() => data.onSelect()}
        onKeyDown={pick}
        className={[
          "flex h-full flex-col gap-0.5 rounded-md border bg-surface px-2.5 py-2 text-left outline-none",
          selected ? "border-accent shadow-[0_0_0_2px_var(--color-accent-ring)]" : "border-line",
          data.stale ? "opacity-70" : "",
        ].join(" ")}
      >
        <div className="flex items-center gap-1.5">
          <span className="truncate text-[13px] font-semibold text-ink">{data.label}</span>
          {data.status && (
            <span
              className="shrink-0 text-[10px] leading-none text-ink-2"
              aria-label={`status: ${data.status.label}`}
              data-testid={`step-status-${data.id}`}
            >
              <span aria-hidden="true">{statusGlyph(data.status.state)}</span> {data.status.label}
            </span>
          )}
        </div>
        <div className="truncate font-mono text-[11px] text-ink-2">{data.id}</div>
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] text-muted">{data.kind}</span>
          {data.deferred && <span className={chip}>{data.deferred}</span>}
        </div>
        {data.when && (
          <div className="truncate text-[10px] italic text-faint" title={data.when}>
            when {data.when}
          </div>
        )}
      </div>

      {data.terminal && interactive && data.onAddAfter && (
        <div className="absolute -bottom-2.5 left-1/2 -translate-x-1/2">
          <button
            type="button"
            data-testid={`add-after-${data.id}`}
            aria-label={`Add a step after ${data.id}`}
            className="flex h-5 w-5 items-center justify-center rounded-full border border-line-strong bg-surface text-xs leading-none text-ink-2 hover:border-accent hover:text-accent"
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

  const style: CSSProperties = {
    // The dagre group box already reserves the header bar; the border just
    // traces it.
    borderRadius: 8,
    border: `1px solid var(--color-line-strong)`,
    background: "color-mix(in srgb, var(--color-fill) 55%, transparent)",
  };

  return (
    <div className="relative h-full w-full" data-testid={`canvas-scope-${data.id}`} style={style}>
      <div className="flex items-center gap-1.5 rounded-t-lg border-b border-line-strong bg-fill px-2.5 py-1">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-2">
          {data.headerText}
        </span>
      </div>
      <RecurrenceArrow />
      {data.emptyBody && (
        <div className="flex h-[calc(100%-1.75rem)] w-full items-center justify-center">
          {interactive && data.onAddInside ? (
            <button
              type="button"
              data-testid={`add-inside-${data.id}`}
              className="rounded-md border border-dashed border-line-strong bg-surface px-2.5 py-1 text-[12px] text-ink-2 hover:border-accent hover:text-accent"
              onClick={() => setPickerOpen(true)}
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
