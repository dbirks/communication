/**
 * The Ask open control (redesign finding 08).
 *
 * `Ask` — the assistant surface — opens from three places: the floating
 * bottom-right button `Shell` draws on every page, the `⌘J` chord, and a caller
 * that already holds the question (the palette's Ask row). Until finding 08 the
 * first two pressed ⌘K by dispatching a SYNTHETIC keydown at the window
 * (`Sidebar`'s old `openAsk()`), which made the chord order-dependent — the
 * Studio draft footer needed a `stopImmediatePropagation` hijack so its own ⌘K
 * did not also raise the popover — and left a bare `⌘K` button that said
 * nothing about what it opened. This module is the explicit handle instead:
 *
 * - `openAsk(question?)` opens the mounted Ask surface, asking `question` when
 *   the caller has one;
 * - `useAskOpen(handler)` registers that surface (the Shell mounts exactly one);
 * - `⌘K` is NOT handled here at all: it belongs to the jump/search palette
 *   (`components/CommandPalette.tsx`) and nothing else. ADR-0050's
 *   first-⌘K-opens-the-assistant toggle is superseded by finding 08.
 *
 * A page may own the Ask surface for as long as it is on screen (the Studio
 * draft footer does: its ⌘J opens the draft's own ask row, not the floating
 * popover). Claims are a stack: the newest holder answers `openAsk()`, and
 * leaving the page hands Ask back to whoever held it before.
 *
 * The registry is module-scope on purpose: the surface mounts from `Shell` and
 * from page chunks, and a caller in a chunk that loaded later reaches it
 * without a provider wrapped around the tree. Registering is an
 * effect (not a render-time write), so a mount/unmount cycle — a remount of the
 * Shell, a hot reload — cannot leave a stale handle behind.
 */
import { useEffect, useRef } from "react";

/** What `openAsk` hands the Ask surface. `text`, when given, is asked as soon
 * as the surface is up. */
export interface AskOpenRequest {
  text?: string;
}

type AskOpenListener = (request: AskOpenRequest) => void;

/** The mounted Ask surfaces, oldest claim first; the top answers `openAsk`. */
const claims: AskOpenListener[] = [];

/** Open the Ask surface; `question`, when given, is asked straight away. */
export function openAsk(question?: string): void {
  claims[claims.length - 1]?.({ text: question });
}

/**
 * Claim the Ask chord for the mounted component. The newest claim answers
 * `openAsk()`; dropping it (unmount, or leaving the page) hands it back.
 * `enabled: false` claims nothing at all — a component that only owns Ask in
 * one of its shapes (the Studio box, footer mode only) must leave the chord
 * with the floating popover in every other shape.
 */
export function useAskOpen(next: AskOpenListener, options: { enabled?: boolean } = {}): void {
  const { enabled = true } = options;
  const ref = useRef(next);
  ref.current = next;
  useEffect(() => {
    if (!enabled) return;
    const claim: AskOpenListener = (request) => ref.current(request);
    claims.push(claim);
    return () => {
      const index = claims.lastIndexOf(claim);
      if (index >= 0) claims.splice(index, 1);
    };
  }, [enabled]);
}
