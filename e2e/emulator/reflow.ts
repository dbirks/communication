// reflow.ts — the page-side half of the 390 reflow checks (fixtures.ts
// `screen()`), per the product owner's decision: there are no 390 design
// renders, so the 390 match is the screen's 1280 content and hierarchy
// reflowed into one column, with (a) no sideways scroll, (b) content parity
// with 1280, (c) no clipped text without an ellipsis, and (d) touch targets
// whose HIT AREA is ≥ 44px tall (docs/design/handoff-app-shell/README.md:
// "Heights 26 / 30 / 36; mobile 44–48"; `findSmallTargets` measures the tap
// area — the box plus the control's own invisible absolute `::after`
// extension, proven by hit test — not the painted box), and (e) no leaf text
// or control paints over another
// (see `findOverlaps`; that one runs at both widths). Every violation is a
// RECORDED defect, never a throw.
//
// The collectors run INSIDE the page via page.evaluate, so each function is
// serialized to source and must be fully self-contained (DOM only, no
// references to this module). The Node-side diff (parity + the allowlist)
// lives here too, next to the data shapes it produces.

/** Per-width check outcomes on a screen record (true = pass). */
export interface EmuChecks {
  sidescroll: boolean;
  parity: boolean;
  clip: boolean;
  target: boolean;
  overlap: boolean;
}

/** Two MAIN elements that paint over one another. */
export interface OverlapHit {
  /** The first element's label (testid, else `tag.class "text"`). */
  a: string;
  /** The second element's label. */
  b: string;
  /** The largest fragment-pair intersection on each axis in CSS px (both are
   * > the 4px floor). */
  dx: number;
  dy: number;
}

/** One item of the content-parity inventory (headings, tabs, testids). */
export interface ReflowItem {
  /** Stable identity: `testid:<id>`, `heading:<text>` or `tab:<name>`. */
  key: string;
  /** Human-readable form used in the defect detail. */
  label: string;
  /**
   * testids of the item's ANCESTOR elements, outermost first — lets an
   * allowlist entry cover a whole hidden container's subtree (a phone
   * master-detail pane) instead of naming every id under it.
   */
  containers: string[];
}

/** An element whose text is cut off without an ellipsis. */
export interface ClipHit {
  label: string;
  text: string;
}

/** An interactive control whose hit area is shorter than the 44px phone
 * minimum. `height` is the REAL hit-area height: the painted box when that is
 * all there is, or the (probed, reachable) union with the control's own
 * absolutely positioned `::before` / `::after` extension. */
export interface TargetHit {
  name: string;
  height: number;
}

/** One REFLOW_ALLOWLIST entry. */
export interface ReflowAllowEntry {
  /** One-line reason this content may be absent at 390. */
  reason: string;
  /**
   * A testid that MUST be rendered (visible) at 390 for the entry to apply —
   * the hidden content's one-tap path (a back control, the phone sheet that
   * carries the same content). An entry whose reach is missing never
   * excuses anything: the hidden side would be unreachable.
   */
  reach: string;
  /** When true, items that sit INSIDE the allowlisted container (at 1280)
   * are covered too — the whole hidden subtree. */
  subtree?: boolean;
}

/**
 * Parity allowlist — container/element testid → entry. Only for content that
 * is INTENTIONALLY collapsed on the phone: a genuine master-detail pane (one
 * tap away behind a visible back control) or a desktop-only affordance with
 * no phone meaning, whose CONTENT is reachable the same way. Every entry
 * names its reach control; the check applies the entry only while that
 * control renders at 390.
 */
export const REFLOW_ALLOWLIST: Record<string, ReflowAllowEntry> = {
  "thread-list-pane": {
    reason:
      "phone master-detail: /threads/:id shows the open thread; the list is one tap behind the '← Threads' back link",
    reach: "threads-back",
    subtree: true,
  },
  // The empty-selection column on `/threads` (ui/src/pages/Threads.tsx): it is
  // `hidden … lg:flex`, so at 390 the page keeps ONLY the list — and the phone
  // path to that column's content is opening a thread, which fills the screen.
  // Same master-detail collapse as `thread-list-pane` above, mirrored: the
  // reach is the list the phone does render (its rows are that one tap).
  "threads-detail-column": {
    reason:
      "phone master-detail: /threads keeps the list column at 390; the empty 'No thread selected' " +
      "column is desktop-only and its content is reached by opening a thread (full-screen)",
    reach: "threads-page",
    subtree: true,
  },
  "workbench-dock-pane": {
    reason: "the node detail reflows below the graph at <1024px as the workbench-dock-panel sheet",
    reach: "workbench-dock-panel",
  },
  "workbench-dock-collapse": {
    reason: "desktop-only affordance (side-dock collapse chevron); the phone sheet replaces it",
    reach: "workbench-dock-panel",
  },
  "workbench-dock-resizer": {
    reason: "desktop-only affordance (drag resizer for the side dock); the phone sheet replaces it",
    reach: "workbench-dock-panel",
  },
};

/**
 * The 1280 items that vanished at 390: each must be present (same key) in
 * the 390 inventory or be covered by an allowlist entry whose reach testid
 * renders at 390 (the entry covers its container itself and, with
 * `subtree`, everything inside it).
 */
export function missingParityItems(desktop: ReflowItem[], phone: ReflowItem[]): ReflowItem[] {
  const present = new Set(phone.map((item) => item.key));
  // An entry applies only while its reach control actually renders at 390.
  const liveContainers = new Set<string>();
  for (const [testid, entry] of Object.entries(REFLOW_ALLOWLIST)) {
    if (!present.has("testid:" + entry.reach)) continue;
    liveContainers.add(testid);
    if (entry.subtree) liveContainers.add(testid + ":*");
  }
  return desktop.filter((item) => {
    if (present.has(item.key)) return false;
    if (item.key.startsWith("testid:")) {
      const testid = item.key.slice("testid:".length);
      if (liveContainers.has(testid)) return false;
    }
    for (const container of item.containers) {
      if (liveContainers.has(container + ":*")) return false;
    }
    return true;
  });
}

/**
 * The parity inventory of the page's MAIN content (the app shell — sidebar,
 * phone strip, Ask surfaces — lives outside `<main>` and is excluded).
 * Runs in the page; see the file header for the self-containment rule.
 */
export function collectReflowItems(): ReflowItem[] {
  const main = document.querySelector("main") ?? document.body;
  const norm = (value: string | null | undefined): string =>
    (value ?? "").replace(/\s+/g, " ").trim();
  // "Visible" = rendered: a non-zero box, not display:none / visibility:hidden.
  // Position on/off screen does not matter (a sidebar-scrolled card is shown).
  const rendered = (el: Element): boolean => {
    const cs = window.getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") return false;
    const box = el.getBoundingClientRect();
    return box.width > 0 && box.height > 0;
  };
  // Belt-and-braces shell exclusion (the landmarks from Shell.tsx/Sidebar.tsx).
  const inShell = (el: Element): boolean =>
    el.closest(
      'aside[aria-label="Primary"], [data-testid="sidebar"], [data-testid^="sidebar-"], [data-testid^="project-switcher"], [data-testid="ask-float"], [data-testid="ask-sidebar"]',
    ) !== null;
  const items: ReflowItem[] = [];
  const seen = new Set<string>();
  const add = (key: string, label: string, containers: string[]): void => {
    if (seen.has(key)) return;
    seen.add(key);
    items.push({ key, label, containers });
  };
  // A tab's IDENTITY excludes live counts. A running job can add a count badge
  // to a tab BETWEEN the two captures (dbirks/communication#22: the run
  // workbench's Artifacts tab gains `<span …>1</span>` when the publish_plan
  // step succeeds), so its textContent goes "Artifacts" → "Artifacts1" and the
  // key `tab:Artifacts` looks LOST at 390 — a false positive. Drop descendant
  // elements that carry only a number, then normalise what remains; a tab whose
  // whole label is numeric keeps its text so it never disappears entirely.
  const tabIdentity = (el: Element): string => {
    const clone = el.cloneNode(true) as HTMLElement;
    for (const child of Array.from(clone.querySelectorAll("*"))) {
      if (/^\d+$/.test(norm(child.textContent))) child.remove();
    }
    return norm(clone.textContent);
  };
  const nodes = main.querySelectorAll("h1, h2, h3, [role='heading'], [role='tab'], [data-testid]");
  for (const el of Array.from(nodes)) {
    if (inShell(el) || !rendered(el)) continue;
    // Ancestor testids, outermost first (the parity allowlist's subtree key).
    const containers: string[] = [];
    for (let node = el.parentElement; node !== null; node = node.parentElement) {
      const up = node.getAttribute("data-testid");
      if (up) containers.push(up);
    }
    containers.reverse();
    const role = el.getAttribute("role");
    if (/^H[1-3]$/.test(el.tagName) || role === "heading") {
      const text = norm(el.textContent);
      if (text) add(`heading:${text}`, `heading "${text.slice(0, 60)}"`, containers);
    }
    if (role === "tab") {
      const name = norm(el.getAttribute("aria-label")) || tabIdentity(el) || norm(el.textContent);
      if (name) add(`tab:${name}`, `tab "${name.slice(0, 60)}"`, containers);
    }
    const testid = el.getAttribute("data-testid");
    if (testid) {
      const text = norm(el.textContent);
      add("testid:" + testid, text ? `${testid} "${text.slice(0, 40)}"` : testid, containers);
    }
  }
  return items;
}

/**
 * Clipped text in MAIN: overflow-x hidden/clip, content wider than the box,
 * and NO ellipsis (an ellipsis is the design's intended truncation). Only
 * elements carrying direct text count, so pure layout wrappers that clip a
 * properly-ellipsis'd child are not reported. Runs in the page.
 */
export function findClippedText(): ClipHit[] {
  const main = document.querySelector("main") ?? document.body;
  const norm = (value: string | null | undefined): string =>
    (value ?? "").replace(/\s+/g, " ").trim();
  const rendered = (el: Element): boolean => {
    const cs = window.getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") return false;
    const box = el.getBoundingClientRect();
    return box.width > 0 && box.height > 0;
  };
  const inShell = (el: Element): boolean =>
    el.closest(
      'aside[aria-label="Primary"], [data-testid="sidebar"], [data-testid^="sidebar-"], [data-testid^="project-switcher"], [data-testid="ask-float"], [data-testid="ask-sidebar"]',
    ) !== null;
  // Visually-hidden text (the `.sr-only` convention: a 1×1 overflow-hidden,
  // clip-path'd box) is screen-reader copy, not visible text the reflow can
  // clip — it never renders, so it cannot be "cut off without an ellipsis".
  const visuallyHidden = (el: Element, cs: CSSStyleDeclaration): boolean =>
    el.closest(".sr-only") !== null || cs.clipPath !== "none";
  // A `-webkit-line-clamp` box (the app-shell phone spec's 2-line clamped
  // summary) draws its OWN ellipsis at the cut — that truncation is the
  // design, so it is intended, not a clip defect. (Its computed
  // text-overflow stays `clip`; the clamp itself renders the ….)
  const lineClamped = (cs: CSSStyleDeclaration): boolean => {
    const clamp = cs.getPropertyValue("-webkit-line-clamp");
    return clamp !== "" && clamp !== "none" && clamp !== "0";
  };
  const hits: ClipHit[] = [];
  for (const el of Array.from(main.querySelectorAll("*"))) {
    if (inShell(el) || !rendered(el)) continue;
    const cs = window.getComputedStyle(el);
    if (visuallyHidden(el, cs)) continue;
    if (cs.overflowX !== "hidden" && cs.overflowX !== "clip") continue;
    if (el.scrollWidth <= el.clientWidth + 1) continue;
    if (cs.textOverflow === "ellipsis") continue;
    if (lineClamped(cs)) continue;
    let own = "";
    for (const node of Array.from(el.childNodes)) {
      if (node.nodeType === 3) own += node.textContent ?? "";
    }
    own = norm(own);
    if (!own) continue;
    const cls = el.classList.length > 0 ? `.${String(el.classList[0])}` : "";
    const label = el.getAttribute("data-testid") ?? `${el.tagName.toLowerCase()}${cls}`;
    hits.push({ label, text: own.slice(0, 40) });
  }
  return hits;
}

/**
 * Overlapping content in MAIN (design pass 6: the canvas caption printed over
 * the last step card and under the zoom/fit group at 390 while the
 * screenshots were the only thing that caught it). Runs in the page.
 *
 * The rule, and the reason for every clause:
 *
 * • candidates are the things a person actually reads or presses — a leaf
 *   element carrying its OWN text, or a control (button/link/input/…). Layout
 *   wrappers are never candidates: they legitimately stack on each other, and
 *   a wrapper collision is reported by the text/controls inside it;
 * • a pair is a defect when some FRAGMENT of one and some fragment of the other
 *   intersect by MORE THAN 4px on BOTH axes — under that it is antialiasing, a
 *   hairline border or an intentional 1–2px optical overlap, not two things
 *   printed over each other;
 * • unless one candidate's whole box contains the other's, or that fragment
 *   pair contains one another (±1px): a label inside its field, a heading
 *   inside its card and a badge inside its tile are the design;
 * • both must be PAINTED: a zero box, display:none/visibility:hidden/opacity:0,
 *   `.sr-only`/clip-path'd text, and anything an `overflow: hidden|clip|auto|
 *   scroll` ancestor clips away are not visible, so they cannot collide. The
 *   clip walk is what keeps a React Flow node parked outside its pane — which
 *   has a real, large box — from pairing with another off-pane node;
 * • a text candidate is measured by the boxes that get INKED, and compared
 *   FRAGMENT BY FRAGMENT. When it has one box that box is its layout rect
 *   unioned with the Range rects of its direct text nodes: `getBoundingClientRect`
 *   alone is the box LAYOUT gave the element and misses a `whitespace-nowrap`
 *   line that paints past it (how the canvas caption ran under the − + fit
 *   group at 1280 with clean boxes). A `display: inline` run must NEVER be
 *   collapsed to that union: an inline run has no one box, it breaks at every
 *   line it wraps across, so the union paints a rectangle across BOTH lines and
 *   the two neighbouring wrapped runs of one paragraph then "collide" — the
 *   `span × span` / `code × span` hits the run-gate and 2e screens reported at
 *   1280 and 390 through acceptance pass 32 (351×17px) while every screenshot
 *   showed the plan's inline runs wrapped in clean lines. An inline candidate
 *   is therefore its `getClientRects()` line fragments plus its text Range
 *   rects, and a hit needs one fragment of each side to meet the two-axis rule.
 *   Every fragment is cropped by its own and every ancestor's overflow, as
 *   before, which is also what keeps an honest ellipsis label — the design's
 *   own truncation, owned by the clip check — from claiming to collide with its
 *   neighbour;
 * • SVG is ignored outright (React Flow's edges, its labels and every
 *   decorative icon are SVG; the arrow layer legitimately crosses nodes);
 * • an element inside a control is not a second candidate (the `−` glyph
 *   inside the zoom button is not a collision with the button);
 * • while a modal dialog is open the page behind it is inert background, so
 *   only the dialog's own subtree is measured — otherwise every dialog screen
 *   would report the backdrop crossing the rows underneath it;
 * • the app shell is excluded, exactly as the other checks do.
 *
 * Nothing is allowlisted: a reported pair is a real overlap and gets fixed.
 */
export function findOverlaps(): OverlapHit[] {
  const main = document.querySelector("main") ?? document.body;
  /** Both axes must intersect by more than this many CSS px. */
  const MIN_OVERLAP_PX = 4;
  /** Slack when asking whether one box holds the other. */
  const CONTAIN_SLACK_PX = 1;
  const CONTROL =
    'a[href], button, input, select, textarea, summary, [role="button"], [role="link"], [role="checkbox"], [role="radio"], [role="switch"], [role="tab"], [role="menuitem"], [role="option"], [role="slider"], [contenteditable="true"]';
  const norm = (value: string | null | undefined): string =>
    (value ?? "").replace(/\s+/g, " ").trim();
  const inShell = (el: Element): boolean =>
    el.closest(
      'aside[aria-label="Primary"], [data-testid="sidebar"], [data-testid^="sidebar-"], [data-testid^="project-switcher"], [data-testid="ask-float"], [data-testid="ask-sidebar"]',
    ) !== null;
  const isSvg = (el: Element): boolean =>
    el.tagName.toLowerCase() === "svg" || el.closest("svg") !== null;
  // Layered overlays (an open menu, picker, listbox, tooltip or dialog): the
  // ARIA contract says these FLOAT above the page, so a menu crossing the
  // cards under it is the design, not a collision — its own contents are still
  // measured against each other. Two candidates are comparable only when they
  // sit in the same overlay (or both outside every overlay).
  const OVERLAY =
    '[role="dialog"], [role="alertdialog"], [role="menu"], [role="menuitem"], [role="listbox"], [role="tooltip"], [role="grid"], dialog[open]';
  const overlayRoot = (el: Element): Element | null => {
    let root: Element | null = null;
    for (let node: Element | null = el.parentElement; node !== null; node = node.parentElement) {
      if (node === main) break;
      if (node.matches(OVERLAY)) root = node;
    }
    return root;
  };
  // The open modal (if any): everything outside it is background right now.
  const modal = document.querySelector('[role="dialog"], [role="alertdialog"], dialog[open]');
  const painted = (el: Element): DOMRect | null => {
    const cs = window.getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") return null;
    if (parseFloat(cs.opacity || "1") === 0) return null;
    if (el.closest('[aria-hidden="true"]') !== null) return null;
    // The `.sr-only` convention and any clip-path box: screen-reader copy.
    if (el.closest(".sr-only") !== null || cs.clipPath !== "none") return null;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    return rect;
  };
  type Box = { l: number; t: number; r: number; b: number };
  type Candidate = {
    el: Element;
    label: string;
    layer: Element | null;
    /** The union of `fragments` — the candidate's whole box (containment rule). */
    full: Box;
    /** The painted fragments, one per line an inline run breaks across. */
    fragments: Box[];
  };
  const union = (a: Box, b: Box): Box => ({
    l: Math.min(a.l, b.l),
    t: Math.min(a.t, b.t),
    r: Math.max(a.r, b.r),
    b: Math.max(a.b, b.b),
  });
  // Every line box an element's OWN text is INKED on — one per line for a
  // wrapped inline run, and for nowrap / absolutely-positioned text the rect
  // where the ink actually goes (that is how the canvas caption's single line
  // ran under the − + fit group at 1280 while its own box stopped short of it).
  // A Range reports the glyphs' real line boxes; `getBoundingClientRect` only
  // ever reports the box LAYOUT gave the element.
  const boxOf = (r: DOMRect): Box => ({ l: r.left, t: r.top, r: r.right, b: r.bottom });
  const textInkRects = (el: Element): Box[] => {
    const range = document.createRange();
    const rects: Box[] = [];
    for (const node of Array.from(el.childNodes)) {
      if (node.nodeType !== 3 || !(node.textContent ?? "").trim()) continue;
      range.selectNode(node);
      for (const r of Array.from(range.getClientRects())) {
        if (r.width <= 0 || r.height <= 0) continue;
        rects.push(boxOf(r));
      }
    }
    return rects;
  };
  // Which elements LAYOUT breaks across lines. `inline` (and `inline-table`) is
  // inline-level AND breakable, so it generates one box per line fragment;
  // `inline-block` / `inline-flex` are inline-level but ATOMIC — they get one
  // box and keep the single-box rule (their whole rect is what paints).
  const breaksAcrossLines = (el: Element): boolean => {
    const display = window.getComputedStyle(el).display;
    return display === "inline" || display === "inline-table";
  };
  // The part of `box` the browser actually paints: the element's own overflow
  // and every clipping/clipping-or-scrolling ancestor crops it, React Flow's
  // pane included. Cropping the element itself is what keeps an honest
  // `text-overflow: ellipsis` label (the design's own truncation, reported by
  // the clip check) from claiming to collide with its neighbour.
  const clipped = (el: Element, box: Box): Box => {
    let { l, t, r, b } = box;
    for (let node: Element | null = el; node !== null; node = node.parentElement) {
      const cs = window.getComputedStyle(node);
      // Only `visible` lets content paint past the box; `hidden`, `clip` and
      // the scrollable axes all crop what they cover.
      const crops = (axis: string): boolean => axis !== "visible";
      if (crops(cs.overflowX) || crops(cs.overflowY)) {
        const edge = node.getBoundingClientRect();
        if (crops(cs.overflowX)) {
          l = Math.max(l, edge.left);
          r = Math.min(r, edge.right);
        }
        if (crops(cs.overflowY)) {
          t = Math.max(t, edge.top);
          b = Math.min(b, edge.bottom);
        }
        if (l >= r || t >= b) return { l: 0, t: 0, r: 0, b: 0 };
      }
      if (node === main) break;
    }
    return { l, t, r, b };
  };
  const ownText = (el: Element): string => {
    let text = "";
    for (const node of Array.from(el.childNodes))
      if (node.nodeType === 3) text += node.textContent ?? "";
    return norm(text);
  };
  const label = (el: Element, text: string): string => {
    const testid = el.getAttribute("data-testid");
    if (testid) return testid;
    const cls = el.classList.length > 0 ? `.${String(el.classList[0])}` : "";
    return `${el.tagName.toLowerCase()}${cls}${text ? ` "${text.slice(0, 28)}"` : ""}`;
  };
  const boxes: Candidate[] = [];
  for (const el of Array.from(main.querySelectorAll("*"))) {
    if (isSvg(el) || inShell(el)) continue;
    if (modal !== null && el.closest('[role="dialog"], [role="alertdialog"], dialog') === null) {
      continue;
    }
    const rect = painted(el);
    if (rect === null) continue;
    const control = el.matches(CONTROL);
    // A LEAF that carries its own text: an element with element children is a
    // wrapper (the meta line of the run header holds its own revision link, so
    // its box legitimately spills around it), and the text inside it is the
    // candidate instead. A control is always a candidate, wrapper or not.
    const text = ownText(el);
    if (!control && (text === "" || el.children.length > 0)) continue;
    // A control's descendants are the control: the `fit` text inside its
    // button is not a second element colliding with the button.
    const owner = el.closest(CONTROL);
    if (owner !== null && owner !== el) continue;
    const layout = boxOf(rect);
    const inkRects = text === "" ? [] : textInkRects(el);
    const raw = breaksAcrossLines(el)
      ? [...Array.from(el.getClientRects()).map(boxOf), ...inkRects]
      : [inkRects.length === 0 ? layout : inkRects.reduce(union, layout)];
    const fragments = raw
      .map((box) => clipped(el, box))
      .filter((box) => box.r - box.l > 0 && box.b - box.t > 0);
    if (fragments.length === 0) continue;
    boxes.push({
      el,
      label: label(el, text),
      layer: overlayRoot(el),
      full: fragments.reduce(union),
      fragments,
    });
  }
  const hits: OverlapHit[] = [];
  const contains = (a: Box, b: Box): boolean =>
    a.l <= b.l + CONTAIN_SLACK_PX &&
    a.t <= b.t + CONTAIN_SLACK_PX &&
    a.r >= b.r - CONTAIN_SLACK_PX &&
    a.b >= b.b - CONTAIN_SLACK_PX;
  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      const a = boxes[i]!;
      const b = boxes[j]!;
      if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
      // A floating overlay only collides with itself.
      if (a.layer !== b.layer) continue;
      // One candidate's whole box holding the other's is the design (a heading
      // inside its card), fragments included: a wrapped run's line fragment that
      // sits wholly inside its neighbour's fragment is the same case at line
      // scale — a badge's own line parked inside a longer line's box.
      if (contains(a.full, b.full) || contains(b.full, a.full)) continue;
      let dx = 0;
      let dy = 0;
      for (const fa of a.fragments) {
        for (const fb of b.fragments) {
          const x = Math.min(fa.r, fb.r) - Math.max(fa.l, fb.l);
          const y = Math.min(fa.b, fb.b) - Math.max(fa.t, fb.t);
          if (x <= MIN_OVERLAP_PX || y <= MIN_OVERLAP_PX) continue;
          if (contains(fa, fb) || contains(fb, fa)) continue;
          if (x * y > dx * dy) {
            dx = x;
            dy = y;
          }
        }
      }
      if (dx <= 0 || dy <= 0) continue;
      hits.push({ a: a.label, b: b.label, dx: Math.round(dx), dy: Math.round(dy) });
    }
  }
  return hits;
}

/**
 * Touch targets in MAIN under 44px: rendered, ENABLED button / [role=button]
 * / [role=tab] / select / input / textarea. Bare <a> links without a role
 * are inline text links, not touch targets. Hidden/checkbox/radio inputs
 * are measured through their <label> box. Runs in the page.
 *
 * What is MEASURED is the hit area, not the painted box (acceptance-36 false
 * positive: the phone workflow rows keep the desktop's 26px `Edit` / `⋯` DRAWN
 * and extend the tappable area to 44px with an invisible absolutely positioned
 * `::after` — `PHONE_HIT` in `ui/src/components/workflows/WorkflowRow.tsx`. A
 * bare `getBoundingClientRect()` called that a 26px target on every screen).
 * So for a short element the effective box is the union of its own rect and the
 * boxes of its own `::before` / `::after`, but only for a pseudo the ELEMENT
 * hosts as its containing block (`position` other than `static`) with
 * `position:absolute` and `content` other than `none`/`normal` — an `absolute`
 * pseudo on a `static` element belongs to some ANCESTOR's padding box, not to
 * this target, and does not lengthen it.
 *
 * The CSS is never taken on faith: the extra band must actually answer to a
 * touch. `document.elementFromPoint` is probed — at the effective box's
 * horizontal centre — `top+2` and `bottom-2`; the element counts as ≥44 only if
 * both probes resolve to the element itself or a descendant of it. A sibling or
 * overlay parked over the extension means the extension is unreachable, so the
 * target keeps its measured (small) height. A probe point outside the viewport
 * is skipped when the element is outside it too (nothing is provable about a
 * row that is not on screen); when the element IS on screen and its extension
 * is not, the extension does not count either.
 */
export function findSmallTargets(): TargetHit[] {
  const main = document.querySelector("main") ?? document.body;
  const MIN = 44;
  /** How far inside the effective box the probes sit (px). */
  const PROBE_INSET = 2;
  const norm = (value: string | null | undefined): string =>
    (value ?? "").replace(/\s+/g, " ").trim();
  const inShell = (el: Element): boolean =>
    el.closest(
      'aside[aria-label="Primary"], [data-testid="sidebar"], [data-testid^="sidebar-"], [data-testid^="project-switcher"], [data-testid="ask-float"], [data-testid="ask-sidebar"]',
    ) !== null;
  interface Box {
    left: number;
    top: number;
    right: number;
    bottom: number;
  }
  const toBox = (rect: DOMRect): Box => ({
    left: rect.left,
    top: rect.top,
    right: rect.right,
    bottom: rect.bottom,
  });
  const widthOf = (box: Box): number => box.right - box.left;
  const heightOf = (box: Box): number => box.bottom - box.top;
  const union = (a: Box, b: Box): Box => ({
    left: Math.min(a.left, b.left),
    top: Math.min(a.top, b.top),
    right: Math.max(a.right, b.right),
    bottom: Math.max(a.bottom, b.bottom),
  });
  /** A used px value, or null for `auto` / a percentage / anything unresolvable. */
  const px = (value: string | null | undefined): number | null => {
    const text = norm(value);
    if (!/^-?\d+(\.\d+)?px$/.test(text)) return null;
    const num = Number.parseFloat(text);
    return Number.isFinite(num) ? num : null;
  };
  const side = (value: string | null | undefined): number => px(value) ?? 0;
  /**
   * The element's own generated pseudo boxes in viewport coordinates, for the
   * hit-area extension pattern. Empty when the element hosts no such box.
   */
  const pseudoBoxes = (el: Element, rect: Box): Box[] => {
    const host = window.getComputedStyle(el);
    // `static`: the element is not the containing block, so an `absolute`
    // pseudo is positioned against an ancestor and is not this target's area.
    if (host.position === "static") return [];
    const boxes: Box[] = [];
    // The abspos containing block is the element's PADDING box.
    const padLeft = rect.left + side(host.borderLeftWidth);
    const padTop = rect.top + side(host.borderTopWidth);
    const padW = widthOf(rect) - side(host.borderLeftWidth) - side(host.borderRightWidth);
    const padH = heightOf(rect) - side(host.borderTopWidth) - side(host.borderBottomWidth);
    for (const pseudo of ["::before", "::after"]) {
      const cs = window.getComputedStyle(el, pseudo);
      const content = norm(cs.content);
      if (content === "" || content === "none" || content === "normal") continue;
      if (cs.position !== "absolute") continue;
      // A `display:none` / `visibility:hidden` pseudo generates no hit box;
      // `opacity:0` DOES still answer to a touch, so it is not excluded here.
      if (cs.display === "none" || cs.visibility === "hidden") continue;
      const w = px(cs.width);
      const h = px(cs.height);
      const left = px(cs.left);
      const right = px(cs.right);
      const top = px(cs.top);
      const bottom = px(cs.bottom);
      let l: number;
      let r: number;
      if (left !== null) {
        l = padLeft + left;
        r = w !== null ? l + w : padLeft + padW - (right ?? 0);
      } else if (right !== null) {
        r = padLeft + padW - right;
        l = w !== null ? r - w : padLeft;
      } else {
        l = padLeft;
        r = padLeft + (w ?? padW);
      }
      let t: number;
      let b: number;
      if (top !== null) {
        t = padTop + top;
        b = h !== null ? t + h : padTop + padH - (bottom ?? 0);
      } else if (bottom !== null) {
        b = padTop + padH - bottom;
        t = h !== null ? b - h : padTop;
      } else {
        t = padTop;
        b = padTop + (h ?? padH);
      }
      if (r - l <= 0 || b - t <= 0) continue;
      boxes.push({ left: l, top: t, right: r, bottom: b });
    }
    return boxes;
  };
  /**
   * Does a touch at (x,y) land on `box` (or something inside it)? A point
   * outside the viewport is unprovable: it passes only when `box` is off screen
   * too, because then nothing about the row can be checked anyway.
   */
  const probe = (el: Element, rect: Box, x: number, y: number): boolean => {
    const onScreen = x >= 0 && y >= 0 && x <= window.innerWidth && y <= window.innerHeight;
    if (!onScreen) {
      const elementVisible =
        rect.top < window.innerHeight &&
        rect.bottom > 0 &&
        rect.left < window.innerWidth &&
        rect.right > 0;
      return !elementVisible;
    }
    const hit = document.elementFromPoint(x, y);
    return hit !== null && (hit === el || el.contains(hit));
  };
  const hits: TargetHit[] = [];
  const nodes = main.querySelectorAll(
    'button, [role="button"], [role="tab"], select, input, textarea',
  );
  for (const el of Array.from(nodes)) {
    if (inShell(el)) continue;
    const cs = window.getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") continue;
    const html = el as HTMLElement & { disabled?: boolean; type?: string };
    if (html.disabled === true || el.getAttribute("aria-disabled") === "true") continue;
    let box: Element = el;
    if (el.tagName === "INPUT") {
      const type = (html.type ?? "text").toLowerCase();
      if (type === "hidden" || type === "checkbox" || type === "radio") {
        box = el.closest("label") ?? el;
      }
    }
    const rect = toBox(box.getBoundingClientRect());
    if (widthOf(rect) <= 0 || heightOf(rect) <= 0) continue;
    let measured = heightOf(rect);
    if (measured < MIN) {
      // The hit area the CSS CLAIMS: own rect ∪ own hosting pseudos.
      const effective = pseudoBoxes(box, rect).reduce(union, rect);
      if (heightOf(effective) > measured) {
        // …and the hit area a finger actually GETS, probed through the top and
        // bottom of that extension at the box's horizontal centre.
        const cx = (effective.left + effective.right) / 2;
        const reachable =
          probe(box, rect, cx, effective.top + PROBE_INSET) &&
          probe(box, rect, cx, effective.bottom - PROBE_INSET);
        if (reachable) measured = heightOf(effective);
      }
    }
    if (measured >= MIN) continue;
    const name =
      norm(el.getAttribute("aria-label")) ||
      norm(el.getAttribute("title")) ||
      norm(el.getAttribute("placeholder")) ||
      norm(el.textContent) ||
      norm(el.getAttribute("data-testid")) ||
      el.tagName.toLowerCase();
    hits.push({ name: name.slice(0, 40), height: Math.round(measured) });
  }
  return hits;
}
