/**
 * useBodyScrollLock — while a modal dialog is open, the page behind it stops
 * scrolling.
 *
 * A dialog owns the screen while it is up. Its dim layer is `position: fixed;
 * inset: 0`, so a document that still scrolls does two damaging things: the
 * wheel moves the page behind a surface that is supposed to have the whole
 * screen, and — round-20's defect — whatever sits below the fold paints BRIGHT
 * and UNDIMMED under the dim's bottom edge (`rcn-1k-run-form-390` showed the
 * ASSISTANT NOTICED card sitting lit outside the backdrop's edge).
 *
 * So the lock clamps the whole page-height chain rather than one element: the
 * two scrolling elements (the app scrolls on the document element; a page that
 * scrolls on the body gets locked the same way) AND the in-flow boxes the body
 * holds, which are what make the document measure as tall as its content.
 * Clamping only the document element and the body leaves the content clipped
 * but the DOCUMENT still taller than the viewport, and a stitched full-page
 * capture still carries a strip of undimmed page below the fold. Fixed-position
 * layers are skipped: the dialog rides in one, it is viewport-sized already,
 * and an ancestor's `overflow: hidden` never clips a fixed box anyway (proved
 * against a real Chromium: clamping the app root leaves the fixed dialog
 * covering the viewport, and the capture with it).
 *
 * The page's scroll offset is saved on the first lock and put back on the last
 * release — a person who cancels a dialog returns to where they were reading,
 * not to the top of the page.
 *
 * The lock is counted, not boolean: dialogs stack (a confirm over the run form)
 * and the inner one closing must not unlock the page under the outer one. The
 * styles handed back on release are the ones read BEFORE the first lock, so a
 * document that arrived with its own inline `overflow`/`height` gets that value
 * back rather than an empty string.
 */
import { useEffect } from "react";

/** The document boxes the lock clamps while a dialog is up. */
function lockTargets(): HTMLElement[] {
  if (typeof document === "undefined") return [];
  const targets: HTMLElement[] = [document.documentElement];
  const { body } = document;
  if (!body) return targets;
  targets.push(body);
  for (const child of Array.from(body.children)) {
    if (!(child instanceof HTMLElement)) continue;
    // A fixed child (the layer a dialog or a portal rides in) is already
    // viewport-sized; clamping it would fight the dialog without shortening
    // the page.
    if (window.getComputedStyle(child).position === "fixed") continue;
    targets.push(child);
  }
  return targets;
}

interface SavedStyle {
  overflow: string;
  height: string;
}

let depth = 0;
/** What each clamped element carried inline before the first lock. */
const saved = new Map<HTMLElement, SavedStyle>();
/** Where the page was scrolled (and on what page) when the first lock was taken. */
let savedScrollY = 0;
let savedHref = "";

/** Take one lock; the returned function is its one and only release. */
function acquire(): () => void {
  if (depth === 0) {
    savedScrollY = window.scrollY;
    savedHref = window.location.href;
    for (const el of lockTargets()) {
      saved.set(el, { overflow: el.style.overflow, height: el.style.height });
      el.style.overflow = "hidden";
      el.style.height = "100%";
    }
  }
  depth += 1;
  let released = false;
  return () => {
    // A double release would unlock a dialog that is still open.
    if (released) return;
    released = true;
    depth -= 1;
    if (depth > 0) return;
    for (const [el, style] of saved) {
      el.style.overflow = style.overflow;
      el.style.height = style.height;
    }
    saved.clear();
    const y = savedScrollY;
    const href = savedHref;
    savedScrollY = 0;
    savedHref = "";
    // The offset goes back only on the page it came from: a dialog that closes
    // by NAVIGATING (Start run → the run page) must not scroll the new page to
    // the old one's reading position, and an unchanged document that never
    // needed scrolling has nothing to put back.
    if (
      y > 0 &&
      href === window.location.href &&
      document.documentElement.scrollHeight > window.innerHeight
    ) {
      window.scrollTo(0, y);
    }
  };
}

/**
 * Lock the page while `open` — default true, for a component that mounts only
 * while its dialog is up. A surface that stays mounted while its panel toggles
 * passes the flag instead.
 */
export function useBodyScrollLock(open = true): void {
  useEffect(() => {
    if (!open) return;
    return acquire();
  }, [open]);
}

/** How many locks are held right now — the nested-dialog contract, observable. */
export function bodyScrollLockDepth(): number {
  return depth;
}
