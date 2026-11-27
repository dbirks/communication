/**
 * SearchField — the "Search or ask" field in the top bar (redesign R1).
 *
 * It is a button, not an input: it owns no text and no caret. Clicking it
 * opens the command palette through the same `openPalette()` the sidebar's
 * `Search ⌘K` field used (finding 08: one search surface, one chord), and the
 * ⌘K chip is the hint that says so — spelled the way the machine really
 * labels the key.
 *
 * On the phone it is a 36px round icon button; the words and the chip would
 * not fit beside the compact pill.
 */
import { IconSearch } from "@tabler/icons-react";
import { openPalette } from "../CommandPalette";

const FOCUS_RING =
  "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent-ring";

/**
 * `⌘K` on an Apple machine, `Ctrl K` everywhere else — the palette's own rule
 * (`commandKeyHint` there is private, and the hint must read the same in both
 * places or the chip in the bar lies about the chord it opens).
 */
export function commandKeyHint(): string {
  const platform = `${navigator.platform} ${navigator.userAgent}`;
  return /mac|iphone|ipad|ipod/i.test(platform) ? "⌘K" : "Ctrl K";
}

export interface SearchFieldProps {
  /** Phone: a 36px round icon-only button. */
  compact?: boolean;
}

export default function SearchField({ compact = false }: SearchFieldProps) {
  if (compact) {
    return (
      <button
        type="button"
        data-testid="search-or-ask"
        aria-label="Search or ask"
        title="Search or ask"
        onClick={openPalette}
        className={`grid h-9 w-9 shrink-0 place-items-center rounded-full border border-line bg-surface text-muted hover:bg-disabled-bg ${FOCUS_RING}`}
      >
        <IconSearch size={16} aria-hidden />
      </button>
    );
  }
  return (
    <button
      type="button"
      data-testid="search-or-ask"
      aria-label="Search or ask"
      onClick={openPalette}
      className={`flex h-8 w-[250px] min-w-0 shrink items-center gap-2 rounded-full border border-line bg-surface py-0 pl-[10px] pr-1.5 text-left hover:border-fill-edge ${FOCUS_RING}`}
    >
      <IconSearch size={15} className="shrink-0 text-muted" aria-hidden />
      <span className="min-w-0 flex-1 truncate text-[12.5px] text-muted">Search or ask</span>
      <span className="shrink-0 px-[6px] font-mono text-[10.5px] text-faint">
        {commandKeyHint()}
      </span>
    </button>
  );
}
