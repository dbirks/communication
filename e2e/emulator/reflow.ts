// reflow.ts — the page-side half of the 390 reflow checks (fixtures.ts
// `screen()`), per the product owner's decision: there are no 390 design
// renders, so the 390 match is the screen's 1280 content and hierarchy
// reflowed into one column, with (a) no sideways scroll, (b) content parity
// with 1280, (c) no clipped text without an ellipsis, and (d) touch targets
// ≥ 44px tall (docs/design/handoff-app-shell/README.md: "Heights 26 / 30 /
// 36; mobile 44–48"), and (e) no leaf text or control paints over another
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
  /** The intersection on each axis in CSS px (both are > the 4px floor). */
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

/** An interactive control shorter than the 44px phone minimum. */
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
      const name = norm(el.getAttribute("aria-label")) || norm(el.textContent);
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
 * • a pair is a defect when the two rendered boxes intersect by MORE THAN 4px
 *   on BOTH axes — under that it is antialiasing, a hairline border or an
 *   intentional 1–2px optical overlap, not two things printed over each other;
 * • unless one box contains the other (±1px): a label inside its field, a
 *   heading inside its card and a badge inside its tile are the design;
 * • both must be PAINTED: a zero box, display:none/visibility:hidden/opacity:0,
 *   `.sr-only`/clip-path'd text, and anything an `overflow: hidden|clip|auto|
 *   scroll` ancestor clips away are not visible, so they cannot collide. The
 *   clip walk is what keeps a React Flow node parked outside its pane — which
 *   has a real, large box — from pairing with another off-pane node;
 * • a text candidate's box is the box that gets INKED: its layout rect unioned
 *   with the Range rects of its direct text nodes, then cropped by its own
 *   overflow. `getBoundingClientRect` alone is the box LAYOUT gave the element
 *   and misses a `whitespace-nowrap` line that paints past it (how the canvas
 *   caption ran under the − + fit group at 1280 with clean boxes), while
 *   cropping by the element's own overflow keeps an honest ellipsis label —
 *   the design's own truncation, owned by the clip check — from claiming to
 *   collide with its neighbour;
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
  type Candidate = Box & { el: Element; label: string; layer: Element | null };
  const union = (a: Box, b: Box): Box => ({
    l: Math.min(a.l, b.l),
    t: Math.min(a.t, b.t),
    r: Math.max(a.r, b.r),
    b: Math.max(a.b, b.b),
  });
  // The painted box of an element's OWN text. `getBoundingClientRect` is the
  // box LAYOUT gave the element; nowrap / absolutely-positioned text PAINTS
  // past it — that is how the canvas caption's single line ran under the
  // − + fit group at 1280 while its own box stopped short of it. A Range
  // reports the glyphs' real line boxes.
  const textInk = (el: Element): Box | null => {
    const range = document.createRange();
    let ink: Box | null = null;
    for (const node of Array.from(el.childNodes)) {
      if (node.nodeType !== 3 || !(node.textContent ?? "").trim()) continue;
      range.selectNode(node);
      for (const r of Array.from(range.getClientRects())) {
        if (r.width <= 0 || r.height <= 0) continue;
        ink =
          ink === null
            ? { l: r.left, t: r.top, r: r.right, b: r.bottom }
            : {
                l: Math.min(ink.l, r.left),
                t: Math.min(ink.t, r.top),
                r: Math.max(ink.r, r.right),
                b: Math.max(ink.b, r.bottom),
              };
      }
    }
    return ink;
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
    const layout = { l: rect.left, t: rect.top, r: rect.right, b: rect.bottom };
    const ink = text === "" ? null : textInk(el);
    const paintedBox = clipped(el, ink === null ? layout : union(layout, ink));
    if (paintedBox.r - paintedBox.l <= 0 || paintedBox.b - paintedBox.t <= 0) continue;
    boxes.push({ el, label: label(el, text), layer: overlayRoot(el), ...paintedBox });
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
      const dx = Math.min(a.r, b.r) - Math.max(a.l, b.l);
      const dy = Math.min(a.b, b.b) - Math.max(a.t, b.t);
      if (dx <= MIN_OVERLAP_PX || dy <= MIN_OVERLAP_PX) continue;
      if (contains(a, b) || contains(b, a)) continue;
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
 */
export function findSmallTargets(): TargetHit[] {
  const main = document.querySelector("main") ?? document.body;
  const MIN = 44;
  const norm = (value: string | null | undefined): string =>
    (value ?? "").replace(/\s+/g, " ").trim();
  const inShell = (el: Element): boolean =>
    el.closest(
      'aside[aria-label="Primary"], [data-testid="sidebar"], [data-testid^="sidebar-"], [data-testid^="project-switcher"], [data-testid="ask-float"], [data-testid="ask-sidebar"]',
    ) !== null;
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
    const rect = box.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    if (rect.height >= MIN) continue;
    const name =
      norm(el.getAttribute("aria-label")) ||
      norm(el.getAttribute("title")) ||
      norm(el.getAttribute("placeholder")) ||
      norm(el.textContent) ||
      norm(el.getAttribute("data-testid")) ||
      el.tagName.toLowerCase();
    hits.push({ name: name.slice(0, 40), height: Math.round(rect.height) });
  }
  return hits;
}
