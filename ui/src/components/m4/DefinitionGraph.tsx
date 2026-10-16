/**
 * The compact definition graph — a read-only projection of a **pinned
 * revision** (`03` "Definition versus runtime graph"), not an editor: there is
 * no palette, no dragging, no creating (M5 owns those, and `10` J9 forbids
 * this screen from implying otherwise).
 *
 * Layout comes from dagre (`../../lib/pipeline/layout`); every mark is drawn
 * by hand in the identity's vocabulary. Scope nodes (`until`, `for_each`,
 * `parallel`) render as boxed groups with a labelled bar, per
 * `docs/design/wireframes.md` C — and a box is always accompanied by the words
 * `UNTIL build_until_verified`, never by shape alone (identity rule 06).
 *
 * The canvas is never the only way in: an equivalent node list sits under it,
 * so a keyboard or screen-reader user reads the same graph, and selecting a
 * node opens the binding inspector — the hover affordance is never load-bearing.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  layoutDefinition,
  type DefinitionGraphLayout,
  type GraphNodeView,
} from "../../lib/pipeline/layout";
import {
  bindingText,
  kindGlyph,
  rootWords,
  type DefinitionDocument,
} from "../../lib/pipeline/definition";
import type { NodeExecutionStatus } from "../../lib/pipeline/contract";
import { Panel } from "../ds/Panel";
import { StatusChip } from "../ds/Row";
import { NODE_EXECUTION_STATE, SEGMENT_COLOR, SHORT_WORD, STATES, stateOf } from "../ds/states";
import { KindChip } from "./KindChip";

/** A node key as a selector-safe suffix: `/build_until_verified/implement` →
 * `build_until_verified-implement`. Test ids stay one-to-one with nodes even
 * when two scopes hold nodes with the same id. */
function keySlug(key: string): string {
  return key.replace(/^\//, "").replace(/\W+/g, "-");
}

/** `#/build_until_verified` → the scope a node sits in, for prose and labels. */
function scopeOf(node: GraphNodeView): string | null {
  return node.groupKey ? node.groupKey.replace(/^#\/?/, "") : null;
}

export interface DefinitionGraphProps {
  /** The document the graph projects — a revision's `canonical_document`. */
  document: DefinitionDocument | null;
  /** Where this graph came from: `revision 7 · sha256:3f2f…`, shown in the bar. */
  label?: string;
  /**
   * Optional per-node rollup, for the graph inside a run. Keyed by the graph's
   * node key — the scope-qualified path, which is `node_instance_key` minus the
   * `[n]` iteration suffix (`/build_until_verified/implement`). Not by `node_id`:
   * the § 9.3 sample legitimately has an `implement` inside two different scopes,
   * and a name shared by two nodes cannot carry one node's state.
   */
  statuses?: Record<string, NodeExecutionStatus>;
  selectedKey?: string | null;
  onSelectKey?: (key: string | null) => void;
  /** Two-way link: highlight the YAML line range of the selected node. */
  onHoverKey?: (key: string | null) => void;
  headingId?: string;
  className?: string;
}

export function DefinitionGraph({
  document,
  label,
  statuses,
  selectedKey = null,
  onSelectKey,
  onHoverKey,
  headingId = "definition-graph-heading",
  className = "",
}: DefinitionGraphProps) {
  // A new document means a new layout; nothing is cached across documents.
  const shown = useMemo(() => safeLayout(document), [document]);
  const canvasRef = useRef<HTMLDivElement>(null);
  /** Measured pane width — the graph scales to it (see `useFitScale`). */
  const [pane, setPane] = useState(0);
  const observe = useCallback((node: HTMLDivElement | null) => {
    canvasRef.current = node;
    if (node) setPane(node.clientWidth);
  }, []);
  useEffect(() => {
    const node = canvasRef.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const watcher = new ResizeObserver((entries) => {
      for (const entry of entries) setPane(entry.contentRect.width);
    });
    watcher.observe(node);
    return () => watcher.disconnect();
  }, []);
  // 1 = "fit the pane": the whole graph is visible by default, and a wide
  // definition never looks like a three-node one. Anything above 1 zooms in
  // and the frame keeps its scrollbars, so panning stays available.
  const [zoom, setZoom] = useState(1);

  if (!shown) {
    return (
      <Panel title="DEFINITION GRAPH" headingId={headingId} headingLevel={2} className={className}>
        <p className="p-[10px] text-[12.5px] text-muted" data-testid="definition-graph-unavailable">
          No graph: this document does not read as a pipeline definition, so nothing is drawn rather
          than a guess. {label ? <span className="font-mono text-[11px]">{label}</span> : null}
        </p>
      </Panel>
    );
  }

  const selected = shown.nodes.find((node) => node.key === selectedKey) ?? null;
  // Fit by default: the pane's width over the graph's width, clamped at the
  // bottom — below ~40% a node's kind line is smaller than the hairline around
  // it, and an unreadable whole is worse than a readable pane with a scrollbar.
  // The graph never upscales past 100%.
  const fitScale = pane > 0 && shown.width > 0 ? Math.min(1, pane / shown.width) : 1;
  const scale = Math.min(2, Math.max(0.4, fitScale) * zoom);
  const frameHeight = Math.round(Math.min(560, Math.max(200, shown.height * scale + 14)));

  return (
    <Panel
      title="DEFINITION GRAPH"
      headingId={headingId}
      headingLevel={2}
      meta={label ? <span className="font-mono text-[10.5px] text-muted">{label}</span> : undefined}
      className={className}
    >
      <div className="grid items-start gap-[10px] p-[10px] 2xl:grid-cols-[minmax(0,1fr)_21rem]">
        <div className="min-w-0 space-y-[8px]">
          {/* A wide graph looks like a short one: the size is stated in the bar,
              the scale is stated next to the zoom controls, and the list under
              the canvas is the same graph in dependency order — the accessible
              route, and the honest total. */}
          <p
            className="flex flex-wrap items-center gap-x-[8px] font-mono text-[10.5px] text-faint"
            data-testid="definition-graph-hint"
          >
            {`${shown.nodes.length} nodes · ${shown.edges.length} edges · ${shown.width}×${shown.height}px · arrow keys move, the list is all of it`}
            <span className="ml-auto flex items-center gap-[3px]">
              <ZoomButton
                label="Zoom out"
                testid="definition-graph-zoom-out"
                onClick={() => setZoom((z) => Math.max(0.4, z / 1.25))}
              >
                {"\u2212"}
              </ZoomButton>
              <span
                className="w-[3.2rem] text-center tabular-nums"
                data-testid="definition-graph-scale"
              >
                {`${Math.round(scale * 100)}%`}
              </span>
              <ZoomButton
                label="Zoom in"
                testid="definition-graph-zoom-in"
                onClick={() => setZoom((z) => Math.min(2.5, z * 1.25))}
              >
                {"+"}
              </ZoomButton>
              <ZoomButton
                label="Fit the graph to the pane"
                testid="definition-graph-zoom-fit"
                onClick={() => setZoom(1)}
              >
                fit
              </ZoomButton>
            </span>
          </p>
          <div
            ref={observe}
            data-testid="definition-graph"
            role="group"
            aria-label={`Definition graph: ${shown.nodes.length} nodes${shown.groups.length === 1 ? " in 1 scope group" : shown.groups.length > 1 ? ` in ${shown.groups.length} scope groups` : ""}. Arrow keys move between nodes.`}
            className="w-full overflow-auto rounded-[3px] border border-line bg-canvas-bg"
            style={{ height: frameHeight }}
            onKeyDown={(event) => moveFocus(event, shown, canvasRef, onSelectKey)}
          >
            {/* The sized box is what the scrollbars measure; the box inside it is
                the graph at its natural size, scaled in place. */}
            <div
              className="relative"
              style={{ width: shown.width * scale, height: shown.height * scale }}
            >
              <div
                data-testid="definition-graph-canvas"
                data-scale={scale.toFixed(3)}
                className="absolute origin-top-left"
                style={{
                  width: shown.width,
                  height: shown.height,
                  transform: `scale(${scale})`,
                }}
              >
                <EdgeLayer layout={shown} selectedKey={selectedKey} />
                {shown.groups.map((group) => (
                  <div
                    key={group.key}
                    data-testid={`definition-graph-scope-${group.ownerId}`}
                    data-scope-kind={group.kind}
                    className="absolute rounded-[4px] border border-dashed border-node-border bg-node-scope-fill"
                    style={{
                      left: group.x,
                      top: group.y,
                      width: group.width,
                      height: group.height,
                    }}
                  >
                    <span
                      className="absolute font-mono text-[10px] font-semibold tracking-[0.04em] text-ink-2"
                      style={{ left: 8, top: 5 }}
                    >
                      {group.word} · {group.ownerId}
                      {group.boundLabel ? ` · ${group.boundLabel}` : ""}
                    </span>
                    {group.loopNote ? (
                      <span
                        className="absolute font-mono text-[10px] text-muted"
                        data-testid={`definition-graph-scope-note-${group.ownerId}`}
                        style={{ left: 8, bottom: 4 }}
                      >
                        {group.loopNote}
                      </span>
                    ) : null}
                  </div>
                ))}
                {shown.nodes.map((node) => (
                  <GraphNode
                    key={node.key}
                    node={node}
                    selected={node.key === selectedKey}
                    status={statuses?.[node.key]}
                    onSelect={onSelectKey}
                    onHover={onHoverKey}
                  />
                ))}
              </div>
            </div>
          </div>
          <NodeList
            layout={shown}
            statuses={statuses}
            selectedKey={selectedKey}
            onSelect={onSelectKey}
          />
        </div>
        <BindingInspector node={selected} />
      </div>
    </Panel>
  );
}

/* ------------------------------------------------------------- fragments */

/** The canvas's own zoom control: `−`, the scale in words, `+`, `fit`. */
function ZoomButton({
  label,
  testid,
  onClick,
  children,
}: {
  label: string;
  testid: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      data-testid={testid}
      onClick={onClick}
      className="grid h-[18px] min-w-[22px] place-items-center rounded-[2px] border border-line bg-surface px-[4px] font-mono text-[10.5px] leading-none text-muted hover:border-line-strong hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
    >
      {children}
    </button>
  );
}

function GraphNode({
  node,
  selected,
  status,
  onSelect,
  onHover,
}: {
  node: GraphNodeView;
  selected: boolean;
  status?: NodeExecutionStatus;
  onSelect?: (key: string) => void;
  onHover?: (key: string | null) => void;
}) {
  // No rollup at all, or one that was never scheduled: the run view draws the
  // node dashed and muted ("Draft PR · pending"), which is also the honest
  // answer — a node nobody has run must not look like a node that ran.
  const state = status ? stateOf(NODE_EXECUTION_STATE[status]) : null;
  const idle = state === null || state === "queued";
  const slug = keySlug(node.key);
  return (
    <button
      type="button"
      data-testid={`definition-graph-node-${slug}`}
      data-node-key={node.key}
      data-gate={node.gate ? "true" : undefined}
      data-state={state ?? "unscheduled"}
      aria-pressed={selected}
      aria-label={`Definition node ${node.id}${scopeOf(node) ? ` in scope ${scopeOf(node)}` : ""}, kind ${node.kind}${node.deferredTo ? `, not implemented until ${node.deferredTo}` : ""}${node.bindings.length === 1 ? ", 1 binding" : `, ${node.bindings.length} bindings`}`}
      onClick={() => onSelect?.(node.key)}
      onMouseEnter={() => onHover?.(node.key)}
      onMouseLeave={() => onHover?.(null)}
      onFocus={() => onHover?.(node.key)}
      onKeyDown={(event) => {
        // Enter/Space select as always (a button does this); a focused node is
        // the canvas's selection, so the pane shows it without a second click.
        if (event.key === "Enter" || event.key === " ") onSelect?.(node.key);
      }}
      className={`absolute flex flex-col justify-center gap-[2px] overflow-hidden rounded-[3px] border pl-[11px] pr-[7px] text-left transition-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
        node.gate
          ? "border-st-waiting-strong bg-st-waiting-pale-body"
          : "border-node-border bg-surface"
      } ${selected ? "border-node-border-selected shadow-raised ring-[1.5px] ring-ink" : ""} ${
        idle && !node.gate ? "border-dashed" : ""
      }`}
      style={{ left: node.x, top: node.y, width: node.width, height: node.height }}
    >
      {/* The state's colour as a 3px rule down the left edge — and the state's
          glyph and word on the line below, never the colour alone (rule 06). */}
      {state ? (
        <span
          aria-hidden
          data-testid={`definition-graph-node-bar-${slug}`}
          className={`absolute inset-y-0 left-0 w-[3px] ${SEGMENT_COLOR[state] ?? "bg-seg-open"}`}
        />
      ) : null}
      {/* Row 1 is the node's name — the one string an expression may use — so it
          never shares its line with a chip. */}
      <span className="flex min-w-0 items-center gap-[4px] text-[12.5px] font-semibold text-ink">
        <span className="truncate">{node.id}</span>
        {/* <n> is the design's binding marker, and n is the real count. A node
            with no bindings shows nothing rather than an empty box. */}
        {node.bindings.length > 0 ? (
          <span aria-hidden className="shrink-0 font-mono text-[10px] text-ink-2">
            {`<${node.bindings.length}>`}
          </span>
        ) : null}
      </span>
      {/* Row 2: the kind in the few words a box can carry, then the state in
          glyph + word. The catalogue name — what the API and an expression use —
          travels in the `title`, the `aria-label` and the node list below. */}
      <span className="flex min-w-0 items-center gap-[4px] font-mono text-[10.5px] text-muted">
        <span aria-hidden className="shrink-0 text-[10px] text-ink-2">
          {kindGlyph(node.kind)}
        </span>
        <span
          className="shrink-0"
          title={node.kind}
          data-testid={`definition-graph-node-kind-${slug}`}
        >
          {node.word}
        </span>
        {state ? (
          <span className="truncate" data-testid={`definition-graph-node-state-${slug}`}>
            {`${STATES[state].glyph} ${SHORT_WORD[state]}`}
          </span>
        ) : node.deferredTo ? (
          <span className="shrink-0 text-faint">{`not until ${node.deferredTo}`}</span>
        ) : (
          <span className="shrink-0 text-faint">pending</span>
        )}
      </span>
    </button>
  );
}

/**
 * Edges as one SVG layer: hairlines, a solid arrowhead, and a dashed route for a
 * condition's error case. The layer is decorative to assistive tech on purpose —
 * a polyline cannot say "verdict routes to publish_needs_attention when the
 * result is not successful", and duplicating that as hidden text would be a
 * second source of truth. The node list below says it in words instead.
 */
function EdgeLayer({
  layout,
  selectedKey,
}: {
  layout: DefinitionGraphLayout;
  selectedKey: string | null;
}) {
  const byKey = new Map(layout.nodes.map((node) => [node.key, node]));
  return (
    <svg
      className="absolute inset-0 pointer-events-none"
      width={layout.width}
      height={layout.height}
      aria-hidden
      data-testid="definition-graph-edges"
    >
      <defs>
        <marker
          id="m4-arrow"
          viewBox="0 0 8 8"
          refX="7"
          refY="4"
          markerWidth="7"
          markerHeight="7"
          orient="auto"
        >
          <path d="M0 0 L8 4 L0 8 z" fill="var(--color-node-border)" />
        </marker>
        <marker
          id="m4-arrow-error"
          viewBox="0 0 8 8"
          refX="7"
          refY="4"
          markerWidth="7"
          markerHeight="7"
          orient="auto"
        >
          <path d="M0 0 L8 4 L0 8 z" fill="var(--color-node-error-route)" />
        </marker>
      </defs>
      {layout.edges.map((edge) => {
        const from = byKey.get(edge.from);
        const to = byKey.get(edge.to);
        if (!from || !to) return null;
        const points =
          edge.points.length > 0
            ? edge.points
            : [
                { x: from.x + from.width, y: from.y + from.height / 2 },
                { x: to.x, y: to.y + to.height / 2 },
              ];
        const touched = edge.from === selectedKey || edge.to === selectedKey;
        return (
          <polyline
            key={`${edge.from}\u0000${edge.to}`}
            data-testid={`definition-graph-edge-${edge.from.split("/").pop()}-to-${edge.to.split("/").pop()}`}
            points={points.map((point) => `${point.x},${point.y}`).join(" ")}
            fill="none"
            stroke={
              edge.kind === "error" ? "var(--color-node-error-route)" : "var(--color-node-border)"
            }
            strokeWidth={1}
            strokeDasharray={edge.kind === "error" ? "3 3" : undefined}
            markerEnd={edge.kind === "error" ? "url(#m4-arrow-error)" : "url(#m4-arrow)"}
            opacity={selectedKey === null || touched ? 1 : 0.45}
          />
        );
      })}
    </svg>
  );
}

/** The non-canvas path to the same facts, and the scroll target for a keyboard
 * user. It is not a caption: it is the list the canvas summarizes. */
function NodeList({
  layout,
  statuses,
  selectedKey,
  onSelect,
}: {
  layout: DefinitionGraphLayout;
  statuses?: Record<string, NodeExecutionStatus>;
  selectedKey: string | null;
  onSelect?: (key: string) => void;
}) {
  return (
    <div data-testid="definition-graph-list">
      <p className="mb-[6px] font-mono text-[10px] font-semibold tracking-[0.04em] text-muted uppercase">
        Nodes in dependency order
      </p>
      <ol className="space-y-[4px]">
        {layout.nodes.map((node) => {
          const wire = statuses?.[node.key];
          const state = wire ? stateOf(NODE_EXECUTION_STATE[wire]) : null;
          const scope = scopeOf(node);
          const idle = state === null || state === "queued";
          return (
            <li key={node.id + node.key}>
              <button
                type="button"
                data-testid={`definition-graph-list-${keySlug(node.key)}`}
                data-gate={node.gate ? "true" : undefined}
                onClick={() => onSelect?.(node.key)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") onSelect?.(node.key);
                }}
                aria-current={node.key === selectedKey ? "true" : undefined}
                className={`flex h-[28px] w-full items-center gap-[8px] rounded-[3px] border px-[10px] text-left focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent ${
                  node.key === selectedKey
                    ? "border-node-border-selected bg-tree-active"
                    : node.gate
                      ? "border-st-waiting-strong bg-st-waiting-pale-body hover:border-st-waiting-strong"
                      : "border-line bg-surface hover:border-line-strong"
                } ${idle && !node.gate ? "border-dashed" : ""}`}
              >
                {state ? (
                  <StatusChip state={state} label={wire ?? ""} />
                ) : (
                  <span
                    aria-hidden
                    className="shrink-0 font-mono text-[10px] text-faint"
                    data-testid={`definition-graph-list-unscheduled-${keySlug(node.key)}`}
                  >
                    pending
                  </span>
                )}
                <span className="shrink-0 truncate text-[12.5px] font-semibold">{node.id}</span>
                <KindChip
                  kind={node.kind}
                  deferredTo={node.deferredTo}
                  className="min-w-0 shrink-0"
                />
                <span className="truncate font-mono text-[10.5px] text-muted">
                  {/* A body node's `dependsOn` names its siblings, so "no
                      dependencies" alone would hide the thing that makes a box a
                      box: which scope the node sits in. */}
                  {node.dependsOn.length > 0
                    ? `after ${node.dependsOn.join(", ")}`
                    : scope
                      ? `starts ${scope}`
                      : "no dependencies"}
                  {scope ? ` \u00b7 in ${scope}` : ""}
                </span>
                <span className="ml-auto shrink-0 truncate font-mono text-[10.5px] text-faint">
                  {node.bindings.length === 1 ? "1 binding" : `${node.bindings.length} bindings`}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/** The right-hand inspector: bindings, route, and the node's own words. */
function BindingInspector({ node }: { node: GraphNodeView | null }) {
  if (!node) {
    return (
      <div
        data-testid="definition-graph-inspector"
        className="rounded-[3px] border border-line bg-surface p-[10px]"
      >
        <p className="text-[12.5px] text-muted">
          Select a node to read its bindings — the expressions it consumes, with the position each
          one was written in.
        </p>
      </div>
    );
  }
  return (
    <div
      data-testid="definition-graph-inspector"
      className="space-y-[8px] rounded-[3px] border border-line bg-surface p-[10px]"
    >
      <div className="flex flex-wrap items-center gap-[6px]">
        <span className="text-[13.5px] font-semibold" data-testid="definition-graph-inspector-id">
          {node.id}
        </span>
        <KindChip kind={node.kind} deferredTo={node.deferredTo} />
      </div>
      <dl className="space-y-[4px] font-mono text-[11px]">
        <div className="flex gap-2">
          <dt className="text-muted">path</dt>
          <dd data-testid="definition-graph-inspector-key">{node.key}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="text-muted">document</dt>
          <dd data-testid="definition-graph-inspector-pointer" className="break-all">
            {node.pointer}
          </dd>
        </div>
        {node.when ? (
          <div className="flex gap-2">
            <dt className="text-muted">when</dt>
            <dd data-testid="definition-graph-inspector-when" className="break-all">
              {node.when}
            </dd>
          </div>
        ) : null}
        {node.errorRoute ? (
          <div className="flex gap-2">
            <dt className="text-muted">on error</dt>
            <dd data-testid="definition-graph-inspector-error-route" className="break-all">
              → {node.errorRoute}
            </dd>
          </div>
        ) : null}
        {node.boundLabel ? (
          <div className="flex gap-2">
            <dt className="text-muted">bound</dt>
            <dd data-testid="definition-graph-inspector-bound" className="break-all">
              {node.boundLabel}
            </dd>
          </div>
        ) : null}
      </dl>
      <p className="font-mono text-[10px] font-semibold tracking-[0.04em] text-muted uppercase">
        Bindings ({node.bindings.length})
      </p>
      {node.bindings.length === 0 ? (
        <p className="text-[12.5px] text-muted" data-testid="definition-graph-inspector-empty">
          This node consumes nothing — no <span className="font-mono">{"${{ … }}"}</span> and no
          bare expression.
        </p>
      ) : (
        <ul className="space-y-[6px]">
          {node.bindings.map((binding, index) => (
            <li
              key={`${binding.slot}\u0000${binding.expression}`}
              data-testid={`definition-graph-binding-${binding.slot}`}
              className="rounded-[3px] border border-line bg-paper p-[8px]"
            >
              <div className="flex flex-wrap items-baseline gap-[6px]">
                <span className="font-mono text-[10.5px] text-muted">{binding.slot}</span>
                <span className="font-mono text-[10px] text-faint uppercase">
                  {binding.position === "expression" ? "bare expression" : "in text"}
                </span>
              </div>
              <code className="mt-[2px] block break-all font-mono text-[11px] leading-[16px]">
                {bindingText(binding)}
              </code>
              <p className="mt-[2px] font-mono text-[10.5px] text-faint">
                {rootWords(binding.expression).join(" · ")}
              </p>
              <span className="sr-only">
                binding {index + 1} of {node.bindings.length}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Spatial arrow-key movement: left/right/up/down to the nearest node centre.
 * `aria-label`s already told the user the graph is a graph; this makes it
 * traversable without a pointer, which is the accessibility contract. */
function moveFocus(
  event: React.KeyboardEvent<HTMLDivElement>,
  layout: DefinitionGraphLayout,
  canvasRef: React.RefObject<HTMLDivElement | null>,
  onSelect?: (key: string) => void,
): void {
  const keys = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"];
  if (!keys.includes(event.key)) return;
  const active = document.activeElement as HTMLElement | null;
  const currentKey = active?.getAttribute("data-node-key") ?? null;
  const current = layout.nodes.find((node) => node.key === currentKey);
  if (!current) {
    if (!currentKey) {
      // Entering the canvas from outside: focus the first node.
      const first = canvasRef.current?.querySelector<HTMLElement>("[data-node-key]");
      first?.focus();
      event.preventDefault();
    }
    return;
  }
  const vector = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[
    event.key as "ArrowLeft"
  ];
  const cx = current.x + current.width / 2;
  const cy = current.y + current.height / 2;
  let best: { key: string; distance: number } | null = null;
  for (const node of layout.nodes) {
    if (node.key === current.key) continue;
    const dx = node.x + node.width / 2 - cx;
    const dy = node.y + node.height / 2 - cy;
    const along = dx * vector[0] + dy * vector[1];
    const across = Math.abs(dx * vector[1]) + Math.abs(dy * vector[0]);
    if (along <= 0) continue;
    const distance = along + across * 2;
    if (!best || distance < best.distance) best = { key: node.key, distance };
  }
  if (!best) return;
  event.preventDefault();
  onSelect?.(best.key);
  canvasRef.current
    ?.querySelector<HTMLElement>(`[data-node-key="${CSS.escape(best.key)}"]`)
    ?.focus();
}

/** A document with a cycle would make dagre throw; a draft is allowed to have
 * one, and the graph must degrade to the YAML view instead of crashing. */
function safeLayout(document: DefinitionDocument | null): DefinitionGraphLayout | null {
  if (!document) return null;
  try {
    return layoutDefinition(document);
  } catch {
    return null;
  }
}
