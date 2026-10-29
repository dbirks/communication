/**
 * GraphCanvas — the Overview's read-only canvas (design 1e). This is NOT the
 * run-screen `m4/DefinitionGraph` card: the design draws no panel chrome, no
 * zoom row and no visible node list. The canvas is a full-bleed dotted field
 * with solid white step cards (200×52, radius 6, hairline border) laid out
 * TOP-TO-BOTTOM and joined by solid ink lines; the only text on the canvas is
 * the caption, bottom-left: `read-only · r1 · Edit workflow opens the canvas
 * on your draft`.
 *
 * Positions and edge routing are the STUDIO's, reused verbatim where the
 * read-only canvas can (`components/studio/flowModel`: `canvasLayout` for the
 * dagre TB layout, `stepCardBox` to re-centre every card on its rank's axis,
 * `edgeAxis` + `routeEdge` for the orthogonal bottom-centre → top-centre
 * lines). That is what makes 1e and 1g agree: one 200×52 axis per chain, and
 * strictly vertical connectors between centred steps — no diagonal bends,
 * because the router draws from the RENDERED card boxes, not dagre's own
 * per-label box (the middle points dagre emitted for its own boxes are what
 * drew the "<" zig-zags). The node list the m4 graph keeps visible here exists as a
 * visually-hidden sibling — the canvas is never the only way in.
 *
 * The second line mirrors the Studio's rule (1g): kind glyph + kind word +
 * the ONE key fact the kind's own config carries — model name, executable,
 * approver, artifact — never an invention.
 *
 * The canvas FITS its width to the pane (`graphFit`): measured on mount and
 * on resize, scaled down to the pane (never up — the 1280 look is untouched)
 * and never under the readable floor. At the floor a still-wider graph
 * left-aligns at its LEFT edge — centring the overflow would strand the
 * left column in the browser's unscrollable dead zone, the 390px bug — and
 * the pane says it pans. See `./graphFit.ts`.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { DefinitionGraphLayout } from "../../lib/pipeline/layout";
import {
  canvasLayout,
  edgeAxis,
  routeEdge,
  stepCardBox,
  type EdgeBox,
} from "../../components/studio/flowModel";
import {
  kindGlyph,
  scopeBody,
  type DefinitionDocument,
  type DefinitionNode,
} from "../../lib/pipeline/definition";
import { fitScale, pansHorizontally } from "./graphFit";

/** A node key as a selector-safe suffix (same rule as the m4 graph). */
function keySlug(key: string): string {
  return key.replace(/^\//, "").replace(/\W+/g, "-");
}

/** The ONE key fact a card carries beyond glyph + kind word — the same
 * reading the Studio canvas uses, mirrored here because the run-screen graph
 * and the editor must not disagree about what a kind shows. */
export function keyFactFor(
  kind: string,
  config: Record<string, unknown> | undefined,
): string | null {
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

/** Key (scope-qualified id) → the raw node, so a card can read its config.
 * Layout keys carry a leading slash (`/approve`, `/until_step/implement`);
 * the map keys here are the same paths without it, and the lookup strips it
 * — one rule, no duplicated key shapes. */
function nodesByKey(document: DefinitionDocument): Map<string, DefinitionNode> {
  const map = new Map<string, DefinitionNode>();
  for (const node of document.spec.nodes ?? []) {
    map.set(node.id, node);
    const body = scopeBody(node);
    for (const child of body) {
      map.set(`${node.id}/${child.id}`, child);
    }
  }
  return map;
}

/** The Studio's own canvas layout (dense TB); a document with a cycle would
 * make dagre throw — nothing is drawn rather than a guess, and the caller
 * says so. */
function safeLayout(
  document: DefinitionDocument | null,
): { laid: DefinitionGraphLayout; direction: "TB" } | null {
  if (!document) return null;
  try {
    return canvasLayout(document);
  } catch {
    return null;
  }
}

/** A group's box grown (left/right/bottom — its top edge stays where the
 * header bar lives) until it contains `box` plus the same 8px pad the Studio
 * gives re-centred children: a 200-wide card can outgrow the dagre cluster
 * its id was measured into, and a scope border slicing through a step is
 * the bug this rule exists to prevent in both canvases. */
const GROUP_PAD = 8;
function growTo(box: EdgeBox, group: { x: number; y: number; width: number; height: number }) {
  const overLeft = group.x - (box.x - GROUP_PAD);
  if (overLeft > 0) {
    group.x -= overLeft;
    group.width += overLeft;
  }
  group.width = Math.max(group.width, box.x + box.width + GROUP_PAD - group.x);
  group.height = Math.max(group.height, box.y + box.height + GROUP_PAD - group.y);
}

export interface GraphCanvasProps {
  document: DefinitionDocument | null;
  /** The caption, bottom-left, in the design's words. */
  label: string;
}

export function GraphCanvas({ document, label }: GraphCanvasProps) {
  const canvas = useMemo(() => safeLayout(document), [document]);
  const rawNodes = useMemo(
    () => (document ? nodesByKey(document) : new Map<string, DefinitionNode>()),
    [document],
  );
  /** The pane width the graph fits to: the root is block-level inside the
   * Overview's scrollable canvas, so its own width IS the pane width, however
   * wide the drawing inside it gets. Measured on mount and on every resize. */
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [pane, setPane] = useState(0);
  useEffect(() => {
    const node = rootRef.current;
    if (!node) return;
    setPane(node.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const watcher = new ResizeObserver((entries) => {
      for (const entry of entries) setPane(entry.contentRect.width);
    });
    watcher.observe(node);
    return () => watcher.disconnect();
  }, []);
  if (!canvas) return null;
  const { laid: shown, direction } = canvas;

  // The rendered card for every node: dagre's box re-centred on its own
  // centre and grown to the 200×52 floor (the Studio's `stepCardBox` rule).
  // The SAME box feeds the edge router below — one geometry for card and
  // line, so the line can never leave a card's bottom centre off-centre.
  const cards = new Map<string, EdgeBox>();
  for (const node of shown.nodes) cards.set(node.key, stepCardBox(node));
  const groupBoxes = shown.groups.map((group) => ({ ...group }));
  // Deepest scopes first, so an inner group is final before its parent
  // measures against it (the Studio's `toFlow` rule for re-centred bodies).
  for (const group of [...groupBoxes].sort((a, b) => b.depth - a.depth)) {
    const path = group.key.replace(/^#/, "");
    for (const [key, box] of cards) if (key.startsWith(`${path}/`)) growTo(box, group);
    for (const inner of groupBoxes) {
      if (inner === group) continue;
      if (inner.key.replace(/^#/, "").startsWith(`${path}/`)) growTo(inner, group);
    }
  }
  // A card centred on a narrow dagre box reaches past where the layout put
  // it; slide the whole drawing back inside the canvas margins rather than
  // clip it (the layout does the same for its own group padding).
  const allBoxes: EdgeBox[] = [...cards.values(), ...groupBoxes];
  const offsetX = Math.max(0, 8 - Math.min(0, ...allBoxes.map((box) => box.x)));
  const offsetY = Math.max(0, 8 - Math.min(0, ...allBoxes.map((box) => box.y)));
  for (const box of allBoxes) {
    box.x += offsetX;
    box.y += offsetY;
  }
  const width = Math.max(shown.width + offsetX, ...allBoxes.map((box) => box.x + box.width)) + 8;
  const height = Math.max(shown.height + offsetY, ...allBoxes.map((box) => box.y + box.height)) + 8;
  // Fit the pane's width (never zoom past 1 — at 1280 the seed graph fits and
  // draws exactly as the design drew it), floored at the readable minimum; at
  // the floor the graph still pans, from its left edge, and says so.
  const scale = fitScale({ paneWidth: pane, graphWidth: width });
  const pans = pansHorizontally({ paneWidth: pane, graphWidth: width, scale });
  const scaledWidth = Math.round(width * scale);
  const scaledHeight = Math.round(height * scale);

  return (
    <div
      ref={rootRef}
      className="relative flex min-h-full flex-col"
      data-testid="workflow-graph"
      data-fit-scale={scale.toFixed(3)}
      data-pans={pans ? "true" : "false"}
    >
      {/* Left-aligned while the graph overflows: `justify-center` would push
          half the overflow into the pane's unscrollable inline-start dead
          zone, stranding the graph's left column — the 390px cut-off. When it
          fits, it centres exactly as the 1280 design draws it. */}
      <div className={`flex flex-1 ${pans ? "justify-start" : "justify-center"}`}>
        {/* The sized box is what the pane's scrollbars measure; the canvas
            inside keeps its natural geometry (so cards, lines and the overlap
            tests all read graph coordinates) and is scaled in place. */}
        <div className="relative shrink-0" style={{ width: scaledWidth, height: scaledHeight }}>
          <div
            className="absolute left-0 top-0 origin-top-left"
            style={{ width, height, transform: `scale(${scale})` }}
            data-testid="workflow-graph-canvas"
            data-scale={scale.toFixed(3)}
          >
            {/* No arrowheads: the design's lines are plain (pass-4). */}
            <svg
              className="absolute inset-0 pointer-events-none"
              width={width}
              height={height}
              aria-hidden
              data-testid="workflow-graph-edges"
            >
              {groupBoxes.map((group) => (
                <rect
                  key={group.key}
                  data-testid={`workflow-graph-scope-${group.ownerId}`}
                  x={group.x}
                  y={group.y}
                  width={group.width}
                  height={group.height}
                  rx={8}
                  fill="var(--color-node-scope-fill)"
                  stroke="var(--color-node-border)"
                  strokeWidth={1}
                  strokeDasharray="4 3"
                />
              ))}
              {shown.edges.map((edge) => {
                const source = cards.get(edge.from);
                const target = cards.get(edge.to);
                if (!source || !target) return null;
                // The Studio's router on the rendered card boxes: orthogonal,
                // bottom-centre → top-centre for a vertical hop (straight down
                // when the cards share the axis a centred chain does), the short
                // single-bend connector for side-by-side siblings.
                const { path } = routeEdge(
                  source,
                  target,
                  edgeAxis(source, target, false, direction),
                );
                return (
                  <path
                    key={`${edge.from} ${edge.to}`}
                    data-testid={`workflow-graph-edge-${edge.from.split("/").pop()}-to-${edge.to.split("/").pop()}`}
                    data-from={edge.from}
                    data-to={edge.to}
                    d={path}
                    fill="none"
                    stroke={
                      edge.kind === "error" ? "var(--color-node-error-route)" : "var(--color-ink-2)"
                    }
                    strokeWidth={1.5}
                    strokeDasharray={edge.kind === "error" ? "3 3" : undefined}
                  />
                );
              })}
            </svg>
            {groupBoxes.map((group) => (
              <span
                key={group.key}
                data-testid={`workflow-graph-scope-label-${group.ownerId}`}
                className="absolute font-mono text-[11px] font-semibold tracking-[0.04em] text-ink-2"
                style={{
                  left: group.x + 10,
                  top: group.y + 5,
                  width: group.headerWidth,
                  lineHeight: "18px",
                }}
              >
                {group.headerText}
              </span>
            ))}
            {shown.nodes.map((node) => {
              const raw = rawNodes.get(node.key.replace(/^\//, ""));
              const fact = keyFactFor(
                node.kind,
                raw?.config as Record<string, unknown> | undefined,
              );
              const card = cards.get(node.key) as EdgeBox;
              return (
                <div
                  key={node.key}
                  data-testid={`workflow-graph-node-${keySlug(node.key)}`}
                  data-node-key={node.key}
                  data-gate={node.gate ? "true" : undefined}
                  className="absolute flex flex-col justify-center gap-[4px] overflow-hidden rounded-[6px] border border-line bg-surface px-[10px] py-[8px]"
                  style={{
                    left: card.x,
                    top: card.y,
                    width: card.width,
                    height: card.height,
                  }}
                >
                  <span
                    className="min-w-0 break-words text-[13.5px] leading-[17px] font-semibold text-ink"
                    data-testid={`workflow-graph-node-id-${keySlug(node.key)}`}
                  >
                    {node.id}
                  </span>
                  {/* glyph + kind word + the ONE key fact the config carries — the
                  Studio's rule (1g); nothing is invented when it holds none. */}
                  <span className="min-w-0 truncate font-mono text-[11px] leading-[14px] text-muted">
                    <span aria-hidden>{kindGlyph(node.kind)}</span>
                    {` ${node.word}${fact ? ` · ${fact}` : ""}`}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
      {/* The caption is part of the canvas (design 1e, bottom-left): one line
          from `lg` up, and free to wrap below `lg` rather than run off a
          390px canvas (pass-4). It sits in the FLOW under the graph, not
          pinned over it: the 390px canvas is barely taller than a four-step
          chain, and a bottom-pinned caption printed over `publish_plan`
          (pass-5). `flex-1` on the canvas area keeps it on the canvas
          field's bottom while the graph is shorter than the pane. */}
      <span
        className="block px-[16px] pb-[14px] pt-[8px] font-mono text-[10.5px] text-faint lg:whitespace-nowrap"
        data-testid="workflow-graph-caption"
      >
        {label}
      </span>
      {/* Only here when the floor could not fit the pane: plain words telling
          the reader what to do, in the caption line's voice — no pixel counts,
          no geometry. */}
      {pans ? (
        <span
          className="block px-[16px] pb-[10px] font-mono text-[10.5px] text-faint"
          data-testid="workflow-graph-pan-hint"
        >
          Scroll sideways to see the rest of the graph.
        </span>
      ) : null}
      {/* The same graph in words, for assistive tech and keyboard users —
          visually hidden here (the m4 card draws it; the design's canvas
          shows only the caption). */}
      <ol className="sr-only" data-testid="workflow-graph-list">
        {shown.nodes.map((node) => (
          <li key={node.key}>{`${node.id} — ${node.kind}${
            node.dependsOn.length > 0 ? `, after ${node.dependsOn.join(", ")}` : ", no dependencies"
          }`}</li>
        ))}
      </ol>
    </div>
  );
}
