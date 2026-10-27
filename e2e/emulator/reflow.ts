// reflow.ts — the page-side half of the 390 reflow checks (fixtures.ts
// `screen()`), per the product owner's decision: there are no 390 design
// renders, so the 390 match is the screen's 1280 content and hierarchy
// reflowed into one column, with (a) no sideways scroll, (b) content parity
// with 1280, (c) no clipped text without an ellipsis, and (d) touch targets
// ≥ 44px tall (docs/design/handoff-app-shell/README.md: "Heights 26 / 30 /
// 36; mobile 44–48"). Every violation is a RECORDED defect, never a throw.
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
      add(
        "testid:" + testid,
        text ? `${testid} "${text.slice(0, 40)}"` : testid,
        containers,
      );
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
