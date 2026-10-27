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

/**
 * Parity allowlist — testid → one-line reason. Only for content that is
 * INTENTIONALLY collapsed behind a disclosure on the phone. Every entry must
 * be reported; keep this empty unless a real case forces one.
 */
export const REFLOW_ALLOWLIST: Record<string, string> = {};

/**
 * The 1280 items that vanished at 390: each must be present (same key) in
 * the 390 inventory or be explicitly allowlisted by testid.
 */
export function missingParityItems(desktop: ReflowItem[], phone: ReflowItem[]): ReflowItem[] {
  const present = new Set(phone.map((item) => item.key));
  return desktop.filter((item) => {
    if (present.has(item.key)) return false;
    if (item.key.startsWith("testid:")) {
      const testid = item.key.slice("testid:".length);
      if (Object.prototype.hasOwnProperty.call(REFLOW_ALLOWLIST, testid)) return false;
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
  const add = (key: string, label: string): void => {
    if (seen.has(key)) return;
    seen.add(key);
    items.push({ key, label });
  };
  const nodes = main.querySelectorAll("h1, h2, h3, [role='heading'], [role='tab'], [data-testid]");
  for (const el of Array.from(nodes)) {
    if (inShell(el) || !rendered(el)) continue;
    const role = el.getAttribute("role");
    if (/^H[1-3]$/.test(el.tagName) || role === "heading") {
      const text = norm(el.textContent);
      if (text) add(`heading:${text}`, `heading "${text.slice(0, 60)}"`);
    }
    if (role === "tab") {
      const name = norm(el.getAttribute("aria-label")) || norm(el.textContent);
      if (name) add(`tab:${name}`, `tab "${name.slice(0, 60)}"`);
    }
    const testid = el.getAttribute("data-testid");
    if (testid) {
      const text = norm(el.textContent);
      add("testid:" + testid, text ? `${testid} "${text.slice(0, 40)}"` : testid);
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
  const hits: ClipHit[] = [];
  for (const el of Array.from(main.querySelectorAll("*"))) {
    if (inShell(el) || !rendered(el)) continue;
    const cs = window.getComputedStyle(el);
    if (visuallyHidden(el, cs)) continue;
    if (cs.overflowX !== "hidden" && cs.overflowX !== "clip") continue;
    if (el.scrollWidth <= el.clientWidth + 1) continue;
    if (cs.textOverflow === "ellipsis") continue;
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
