// plan-steps.ts — what the gate card's plan says its steps ARE, and whether
// the numbers a reader sees hold up (`run-gate-artifacts.spec.ts`).
//
// The check was one locator: `markdown-list-ordered > li > span[aria-hidden]`
// joined and matched against `1. 2. 3. …`. It asserted a SHAPE, not the
// contract. The contract (pass-1 design review item 1, the original
// `run-gate-waiting-1280.png`: a renderer that printed "1." for every step) is
// "the steps a reader sees are numbered in order, never 1. 1. 1." — and a plan
// is LIVE model output, so its shape is not ours to pick. In
// `out/pass-1-20261101102509` the planner wrote its steps as bold paragraphs
// ("**1. Confirm repository binding…**" with bullet lists under each): there is
// no ordered list in the document, the locator returned nothing, and the check
// red on a plan that reads 1, 2, 3, 4, 5 on screen.
//
// So the rule is read two ways and BOTH must hold:
//
//  1. every ordered list in the plan numbers its own items consecutively from
//     the number its first item asked for (`3.` → 3, 4, 5 …); and
//  2. the numbers a reader actually SEES, in reading order — the leading "N."
//     of a heading, bold step paragraph or list item — run up by one inside a
//     sequence, and a sequence may START AGAIN at 1.
//
// (2) is written as sequences, not as one long rise, because live model plans
// routinely number their steps 1…5 and then number an acceptance list 1…3: a
// fresh 1 is a new section, not a defect. What is a defect is the renderer's
// own signature and its arithmetic:
//
//  • three or more "1"s in a row (1, 1, 1 …) — the pass-1 bug, one list broken
//    into a list per step. Two 1s in a row is allowed, because a one-step
//    section followed by a section that restarts at 1 reads the same and is
//    the model's own doing;
//  • a repeat that is not a restart (1, 2, 2) or a number that drops anywhere
//    but to 1 (1, 2, 3, 2) — the plan lost its place;
//  • a jump that skips a number inside a sequence (1, 3).
//
// Rule 1 catches the same bug from the other side (a renderer that mis-numbers
// WITHIN one list); rule 2 catches it when the lists are split, since each
// single-item list is internally consecutive. And a plan whose blocks LOOK like
// steps (two or more headings, ordered items or bold step titles) but carries
// no number anywhere stays a failure — that is the reader-who-cannot-count
// defect rule 1 was written for. A plan that is prose only numbers nothing and
// is allowed to.
//
// `collectPlanNumbering` runs INSIDE the page via page.evaluate, so (like the
// collectors in reflow.ts) it is serialized to source: DOM only, self
// contained, no reference to this module. `judgePlanNumbering` is pure and is
// unit-tested in `reflow-target.spec.ts` against the live pass's plan text and
// the "1. 1. 1.", "two sequences" and "1, 2, 2" fixtures.

/** What the page reports about one plan, before anyone judges it. */
export interface PlanNumberRead {
  /** False when the gate card holds no plan document at all. */
  found: boolean;
  /** One entry per ordered list: the number strings its own items printed. */
  lists: string[][];
  /** The plan's blocks in reading order — one entry per block, carrying the
   * text that block carries ITSELF (a step's nested bullets are not its own
   * text) and how the block presents itself. */
  blocks: PlanBlock[];
  /** What was read, for the defect line. */
  where: string;
}

/** How a block announces itself: a heading, an item of an ordered list, a
 * paragraph LED by a bold run (a model's "**1. Confirm …**" step title), or
 * ordinary prose. Only the first three read as steps to a reader — which is
 * what decides whether an unnumbered plan is a prose plan (allowed) or a plan
 * whose steps lost their numbers (a defect). */
export type PlanBlockKind = "heading" | "item" | "strong" | "text";

/** One block of the plan. */
export interface PlanBlock {
  text: string;
  kind: PlanBlockKind;
}

/** The judge's answer: pass/fail, the numbers seen, and — when it fails — the
 * reason in the words a report needs. */
export interface PlanNumberVerdict {
  ok: boolean;
  /** The step numbers harvested from the blocks, in reading order. */
  steps: number[];
  reason: string;
}

/** An ordered list's printed marker ("3." — the renderer's own words). */
const MARKER = /^(\d{1,3})\.$/;
/** A step: a line that opens with its number ("2. Execute the gate — …"). */
const STEP_LINE = /^(\d{1,3})[.)](?=\s|$)/;

/** The number a line opens with, or null when it is not a step line. */
export function stepNumberOn(line: string): number | null {
  const match = STEP_LINE.exec(line.replace(/\s+/g, " ").trim());
  return match === null ? null : Number(match[1]);
}

/** The step numbers in `blocks`, in reading order — one per block at most. */
export function stepNumbersIn(blocks: PlanBlock[]): number[] {
  const out: number[] = [];
  for (const block of blocks) {
    // A block's number is the first line it carries its OWN text on: in the
    // app's list markup the "1." marker is its own box, so the item's text
    // follows it on the next line (and a bullet marker is not a number at all).
    for (const line of block.text.split("\n").slice(0, 2)) {
      const num = stepNumberOn(line);
      if (num !== null) {
        out.push(num);
        break;
      }
    }
  }
  return out;
}

/**
 * Walk the reading-order numbers as SEQUENCES and say what is wrong, or null.
 * A sequence rises by one; a `1` opens a new one. `1, 1` is the ambiguous case
 * — two single-item sections read exactly like the split-list renderer's first
 * two steps — so the renderer's real signature, `1, 1, 1`, is the floor.
 */
export function sequenceFault(steps: number[]): string | null {
  /** How many identical numbers in a row the walk has seen up to `at - 1`. */
  let run = 1;
  for (let at = 1; at < steps.length; at += 1) {
    const previous = steps[at - 1]!;
    const current = steps[at]!;
    if (current === previous) {
      run += 1;
      if (current === 1) {
        if (run >= 3) {
          const seen = steps.slice(at - run + 1, at + 1);
          return `${run} steps in a row are numbered "1." (${seen.join(", ")}) — the plan is not numbered, every step reads "1."`;
        }
        continue;
      }
      return `step ${current} is numbered twice in a row (${around(steps, at)}) — a sequence repeats a number`;
    }
    run = 1;
    if (current === 1) continue; // a new sequence starts at 1
    if (current !== previous + 1) {
      return previous < current
        ? `the plan's step numbering skips (${around(steps, at)}) — a sequence rises by one`
        : `the plan's step numbering falls without starting a new sequence (${around(steps, at)})`;
    }
  }
  return null;
}

/** The `…three before → this one…` window a numbering complaint quotes. */
function around(steps: number[], at: number): string {
  const from = Math.max(0, at - 3);
  return `${steps.slice(from, at).join(", ")} → ${steps[at]}${at + 1 < steps.length ? " …" : ""}`;
}

/**
 * Judge a plan read from the screen. `reason` is "" on a pass, so a test can
 * assert it directly and the failure message says what was actually seen.
 */
export function judgePlanNumbering(read: PlanNumberRead): PlanNumberVerdict {
  const fail = (reason: string, steps: number[] = []): PlanNumberVerdict => ({
    ok: false,
    steps,
    reason,
  });
  if (!read.found) return fail(`${read.where}: no plan document was rendered to read`);

  // (1) every ordered list numbers its own items in step. A marker this rule
  // cannot read (a renderer that prints no marker span) is not a failure: the
  // reader sees no number there, so rule (2) is the one that judges it.
  for (let index = 0; index < read.lists.length; index += 1) {
    const nums: number[] = [];
    for (const marker of read.lists[index] ?? []) {
      const match = MARKER.exec(marker.trim());
      if (match === null) continue;
      nums.push(Number(match[1]));
    }
    for (let at = 1; at < nums.length; at += 1) {
      if (nums[at] !== undefined && nums[at] !== nums[at - 1]! + 1) {
        return fail(
          `${read.where}: ordered list ${index + 1} prints ${nums.join(", ")} — not consecutive from ${nums[0] ?? "its first item"}`,
          nums,
        );
      }
    }
  }

  const steps = stepNumbersIn(read.blocks);
  if (steps.length === 0) {
    const stepish = read.blocks.filter((block) => block.kind !== "text").length;
    if (stepish < 2) {
      // A plan written as prose (paragraphs and bullets, no step-shaped block
      // to number) numbers nothing and is not a defect.
      return { ok: true, steps, reason: "" };
    }
    return fail(
      `${read.where}: ${stepish} blocks read as steps (headings, ordered items, bold step titles) but none of them carries a number — a reader cannot count the plan's steps`,
    );
  }
  const fault = sequenceFault(steps);
  if (fault !== null) return fail(`${read.where}: ${fault} (read: ${steps.join(", ")})`, steps);
  return { ok: true, steps, reason: "" };
}

/**
 * Read the gate card's plan (or any plan / markdown document on screen) from
 * INSIDE the page. Runs via page.evaluate — see the file header for the
 * self-containment rule.
 */
export function collectPlanNumbering(): PlanNumberRead {
  // The plan's own container, by the arms PlanView renders: a decoded JSON
  // plan (`plan-view`), markdown text (`plan-view-plain` → `markdown-body`),
  // or the gate card itself if this build wraps them differently.
  const ROOTS = [
    '[data-testid="approval-summary"] [data-testid="plan-view"]',
    '[data-testid="approval-summary"] [data-testid="plan-view-plain"]',
    '[data-testid="approval-summary"] [data-testid="markdown-body"]',
    '[data-testid="approval-summary"]',
    '[data-testid="plan-view"]',
    '[data-testid="plan-view-plain"]',
    '[data-testid="markdown-body"]',
  ];
  let root: Element | null = null;
  let where = "";
  for (const selector of ROOTS) {
    const el = document.querySelector(selector);
    if (el !== null) {
      root = el;
      where = selector;
      break;
    }
  }
  if (root === null) return { found: false, lists: [], blocks: [], where: "the gate card" };

  // (1) the lists, each judged on its own items' printed markers. A marker is
  // the renderer's `aria-hidden` span; where a list has none (a future renderer
  // that leaves the numbering to CSS), the `<ol start>` the author asked for is
  // what the browser paints, so that is what is read.
  const lists: string[][] = [];
  for (const list of Array.from(
    root.querySelectorAll('[data-testid="markdown-list-ordered"], [data-testid="plan-steps"], ol'),
  )) {
    const declared = Number(list.getAttribute("start") ?? "1");
    const markers: string[] = [];
    let at = 0;
    for (const item of Array.from(list.children)) {
      if (item.tagName !== "LI") continue;
      const span = item.querySelector(":scope > span[aria-hidden]");
      const text = span !== null ? (span.textContent ?? "").trim() : "";
      markers.push(text !== "" ? text : `${(Number.isFinite(declared) ? declared : 1) + at}.`);
      at += 1;
    }
    if (markers.length > 0) lists.push(markers);
  }

  // (2) the blocks, in reading order. A block is a thing that carries text
  // (paragraph, heading, list item, quote); its OWN text is what counts, so a
  // step's nested sub-list — which restarts its own numbering at 1 by design —
  // is never mistaken for a step of the plan. Fenced code and collapsed JSON
  // blocks are payloads, not the plan's prose, and are not walked at all.
  const BLOCK = "p, li, h1, h2, h3, h4, h5, h6, blockquote, dt, dd";
  const stopsWalk = (el: Element): boolean => {
    const tag = el.tagName.toLowerCase();
    if (tag === "ol" || tag === "ul" || tag === "pre" || tag === "p" || tag === "li") return true;
    if (/^h[1-6]$/.test(tag) || tag === "blockquote" || tag === "table") return true;
    return /^(markdown|plan)-/.test(el.getAttribute("data-testid") ?? "");
  };
  const painted = (el: Element): boolean => {
    const cs = window.getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") return false;
    const box = el.getBoundingClientRect();
    return box.width > 0 && box.height > 0;
  };
  const ownText = (el: Element): string => {
    let text = "";
    for (const child of Array.from(el.childNodes)) {
      if (child.nodeType === 3) {
        text += child.textContent ?? "";
        continue;
      }
      if (child.nodeType !== 1) continue;
      const node = child as Element;
      if (stopsWalk(node)) continue;
      const inner = ownText(node);
      if (inner === "") continue;
      // Where the browser starts a new line, the text this collects starts a
      // new line too. The app's list items are `display:flex` with the "1."
      // marker in its own span, and flex items are blockified — so the marker
      // reads as line 1 and the step's words as line 2, exactly as they are
      // painted. Inline runs (`<strong>`, `<code>`) stay on the line they paint
      // on, which is what makes a bold “**1. Confirm …**” paragraph read as the
      // step it is instead of losing its number in a concatenation.
      const display = window.getComputedStyle(node).display;
      const breaksLine =
        display !== "inline" && display !== "inline-block" && display !== "inline-flex";
      text += (text !== "" && breaksLine ? "\n" : "") + inner;
    }
    return text;
  };
  const insideItem = (el: Element): boolean => {
    for (let node = el.parentElement; node !== null && node !== root; node = node.parentElement) {
      if (node.tagName === "LI") return true;
    }
    return false;
  };
  // How the block ANNOUNCES itself, which is what tells an unnumbered prose
  // plan from a plan whose steps lost their numbers: a heading, an item of an
  // ORDERED list, or a paragraph that LEADS with a bold run (a model writing
  // “**1. Confirm …**”) all read to a person as “a step”.
  const leadsBold = (el: Element): boolean => {
    for (const child of Array.from(el.childNodes)) {
      if (child.nodeType === 3) {
        if ((child.textContent ?? "").trim() !== "") return false;
        continue;
      }
      if (child.nodeType !== 1) continue;
      const node = child as Element;
      if (stopsWalk(node)) return false;
      const tag = node.tagName.toLowerCase();
      if (tag === "strong" || tag === "b") return true;
      return window.getComputedStyle(node).fontWeight === "bold";
    }
    return false;
  };
  const kindOf = (el: Element): PlanBlockKind => {
    const tag = el.tagName.toLowerCase();
    if (/^h[1-6]$/.test(tag) || el.matches('[role="heading"]')) return "heading";
    if (el.getAttribute("data-testid") === "markdown-heading") return "heading";
    if (tag === "li") {
      const list = el.parentElement;
      return list !== null && list.tagName === "OL" ? "item" : "text";
    }
    return tag === "p" && leadsBold(el) ? "strong" : "text";
  };
  const blocks: { text: string; kind: PlanBlockKind }[] = [];
  for (const el of Array.from(root.querySelectorAll(BLOCK))) {
    if (el.closest("pre") !== null) continue;
    if (el.closest('[data-testid$="-json"]') !== null) continue;
    if (!painted(el)) continue;
    if (insideItem(el)) continue;
    const own = ownText(el).trim();
    if (own === "") continue;
    // A step's number leads the step: for a paragraph or heading that is its
    // FIRST line (a later line of prose is prose, not a step). A list item is
    // different — its “1.” marker is its own box, so the item's text sits on
    // the line after the number — and the judge reads an item's whole own text.
    blocks.push({
      text: el.tagName === "LI" ? own : (own.split("\n")[0] ?? "").trim(),
      kind: kindOf(el),
    });
  }
  return { found: true, lists, blocks, where };
}
