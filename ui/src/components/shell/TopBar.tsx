/**
 * TopBar — the 60px bar over the content column (redesign R1, README §1
 * "Top bar"; the phone variant is CONTRACT "Phone").
 *
 * Three regions, and each one has exactly one owner:
 *
 * - left: the scope name (All projects / the project's name) — unless a page
 *   claims the region with `<TopBarLeft>` (a breadcrumb, a draft status), in
 *   which case the bar watches its own slot node and stands the name down;
 * - center: `SectionPill`, the app's three places;
 * - right: `SearchField` and the mic. The mic is the assistant's mouth and is
 *   not wired to voice yet — it opens Ask (`openAsk()`) until the voice brief
 *   lands.
 *
 * Below 768px the bar is 52px and the rail is gone, so the left region becomes
 * a 36px tile button that opens the scope sheet, the pill goes icon-only, and
 * a page's claimed left region — which had no room above — gets a 36px strip
 * under the bar.
 */
import { useEffect, useRef, useState } from "react";
import { IconMicrophone } from "@tabler/icons-react";
import { useProjects } from "../../api/queries";
import { useScope } from "../../lib/scope";
import { ASSISTANT_LISTENING_EVENT, startVoiceAsk } from "../assistant/askControl";
import { useSidebarFlags } from "../../lib/sidebarFlags";
import { needsYouBadge, projectInitials } from "./ProjectRail";
import SectionPill from "./SectionPill";
import SearchField from "./SearchField";
import { TOP_BAR_LEFT_SLOT_ID } from "./TopBarSlot";

const FOCUS_RING =
  "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent-ring";

/**
 * Does the slot hold something a person can see? A portal may write elements
 * (`<TopBarLeft><Breadcrumb/></TopBarLeft>`) or a bare string, which React
 * inserts as a text node — and it writes React's own comment markers, which
 * draw nothing. So: an element, or text that is not only whitespace.
 */
function holdsContent(node: Node): boolean {
  return Array.from(node.childNodes).some(
    (child) => child.nodeType === Node.ELEMENT_NODE || (child.textContent ?? "").trim() !== "",
  );
}

/** The rail's tile, shrunk to what the 52px phone bar can hold: 36px, same
 * ink selection, same two letters, so the button is the tile it replaces. */
const PHONE_TILE =
  "grid h-9 w-9 shrink-0 place-items-center rounded-[10px] border border-ink bg-ink font-mono font-semibold text-surface";

export interface TopBarProps {
  /** Below 768px: the phone bar (no rail, so the scope button appears). */
  phone?: boolean;
  /** Is the scope sheet open? Drives the scope button's `aria-expanded`. */
  scopeOpen?: boolean;
  /** Open the scope sheet (phone only — the rail carries the scope above). */
  onScopeOpen?: () => void;
}

/** The mic at rest, and while Quick chat is listening (accent fill, white
 * icon). */
function micTone(listening: boolean): string {
  return listening
    ? "border-accent-edge bg-accent text-white"
    : "border-line bg-surface text-ink-2 hover:bg-disabled-bg";
}

export default function TopBar({ phone = false, scopeOpen = false, onScopeOpen }: TopBarProps) {
  const scope = useScope();
  // Quick chat announces when dictation records; the mic mirrors it.
  const [listening, setListening] = useState(false);
  useEffect(() => {
    const onListening = (event: Event) =>
      setListening(Boolean((event as CustomEvent<boolean>).detail));
    window.addEventListener(ASSISTANT_LISTENING_EVENT, onListening);
    return () => window.removeEventListener(ASSISTANT_LISTENING_EVENT, onListening);
  }, []);
  const projects = useProjects();
  const flags = useSidebarFlags();
  const slotRef = useRef<HTMLDivElement>(null);
  /** Does a page hold the left region right now? Read from the slot node's own
   * children — the portal writes them, so no context has to reach the pages. */
  const [claimed, setClaimed] = useState(false);

  useEffect(() => {
    const node = slotRef.current;
    if (!node) return;
    const sync = () => setClaimed(holdsContent(node));
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(node, { childList: true, characterData: true, subtree: true });
    return () => observer.disconnect();
    // The wide and phone bars print different nodes.
  }, [phone]);

  const items = projects.data?.items ?? [];
  const current = scope === null ? null : items.find((project) => project.id === scope);
  // Scoped but the list has not arrived: no name yet — a guess would be a
  // different project's name for one frame.
  const scopeName = scope === null ? "All projects" : (current?.name ?? "");
  const tileLabel = scope === null ? "All" : projectInitials(current?.name ?? "") || "··";
  const waiting = scope === null ? false : needsYouBadge(flags.projects[scope]);

  const slot = (
    <div
      ref={slotRef}
      id={TOP_BAR_LEFT_SLOT_ID}
      className={`min-w-0 items-center gap-2 overflow-hidden ${claimed ? "flex" : "hidden"}`}
    />
  );

  if (phone) {
    return (
      <>
        <header
          data-testid="top-bar"
          className="grid h-[52px] shrink-0 grid-cols-[auto_1fr_auto] items-center gap-2 border-b border-line bg-surface px-3"
        >
          <button
            type="button"
            data-testid="scope-open"
            aria-label="Projects"
            aria-expanded={scopeOpen}
            onClick={onScopeOpen}
            className={`relative text-[11px] ${PHONE_TILE} ${FOCUS_RING}`}
          >
            {tileLabel}
            {waiting ? (
              <span
                aria-hidden="true"
                className="absolute -top-[4px] -right-[5px] grid h-[13px] min-w-[13px] place-items-center rounded-full border-2 border-surface bg-st-waiting-strong text-[8px] font-bold text-st-waiting-strong-fg"
              />
            ) : null}
          </button>
          <div className="justify-self-center">
            <SectionPill compact />
          </div>
          <div className="flex items-center justify-self-end gap-2">
            <SearchField compact />
            <button
              type="button"
              data-testid="top-bar-mic"
              aria-label="Talk to the assistant"
              aria-pressed={listening}
              data-listening={listening ? "true" : undefined}
              onClick={() => startVoiceAsk()}
              className={`grid h-9 w-9 shrink-0 place-items-center rounded-full border ${micTone(listening)} ${FOCUS_RING}`}
            >
              <IconMicrophone size={16} aria-hidden />
            </button>
          </div>
        </header>
        {/* A page's claimed left region on the phone: a 36px strip under the
            bar, mounted always (it is the portal target) and shown only while
            it holds something. */}
        <div
          data-testid="top-bar-phone-slot"
          aria-hidden={!claimed}
          className={`h-9 shrink-0 items-center border-b border-line bg-surface px-3 ${
            claimed ? "flex" : "hidden"
          }`}
        >
          {slot}
        </div>
      </>
    );
  }

  return (
    <header
      data-testid="top-bar"
      className="grid h-[60px] shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-4 border-b border-line bg-surface pr-4 pl-6"
    >
      <div data-testid="top-bar-context" className="flex min-w-0 items-center overflow-hidden">
        {slot}
        {claimed ? null : (
          <span
            data-testid="top-bar-scope-name"
            className="min-w-0 truncate text-[16px] font-bold text-ink"
          >
            {scopeName}
          </span>
        )}
      </div>
      <div className="justify-self-center">
        <SectionPill />
      </div>
      <div className="flex items-center justify-self-end gap-2">
        <SearchField />
        <button
          type="button"
          data-testid="top-bar-mic"
          aria-label="Talk to the assistant"
          aria-pressed={listening}
          data-listening={listening ? "true" : undefined}
          onClick={() => startVoiceAsk()}
          className={`grid h-8 w-8 shrink-0 place-items-center rounded-full border ${micTone(listening)} ${FOCUS_RING}`}
        >
          <IconMicrophone size={16} aria-hidden />
        </button>
      </div>
    </header>
  );
}
