/**
 * The repo page's chat box (design 3a): one line with an ink border and the
 * hard `2px 2px 0` shadow — a placeholder that names the repository, an
 * agent-profile chip (secondary, 26px) that opens the `ds/Menu` picker, and a
 * primary `Start`. Below 640px the placeholder is the verb, not the repo
 * name: review 3a caught `Chat in web…` keeping the prefix while its hint
 * (`ask, plan, or paste an issue`) clipped away — at phone width the hint
 * itself is the shorter sentence, and the repository the chat is born bound
 * to is already the page's own title.
 *
 * Start creates a conversation BORN BOUND to this repository (ADR-0067: the
 * POST carries `repository` — the name — plus the chosen profile and the typed
 * text as the first prompt), then navigates to the thread. The title the wire
 * requires is the text's own first line, never a paraphrase. An empty box
 * cannot Start; a refusal from the API stays inline under the line, in the
 * server's words.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { useNavigate } from "react-router";
import { useAgentProfiles, useCreateConversation } from "../../api/queries";
import { FormError } from "../Feedback";
import { Button } from "../ds/Button";
import { Menu } from "../ds/Menu";
import { routes } from "../../lib/routes";

export interface RepoChatBoxProps {
  projectId: string;
  /** The repository's own name — the wire's `repository` member (ADR-0067). */
  repositoryName: string;
  /**
   * Text to drop into the line, from an assistant note's `start_chat` action
   * (ADR-0071): the note names the prompt, the person still presses `Start`.
   * A new object is a new request — the same words offered twice refill the
   * box rather than being ignored as an unchanged value.
   */
  prefill?: { text: string };
}

/** Below 640px the line's own box shrinks to (almost) nothing beside the
 * profile chip and `Start`, and the long placeholder clips mid-word — the
 * one width question this component asks, asked the same way `Shell` asks
 * its own (`matchMedia`, so CSS and mount logic never disagree). */
const PHONE_WIDTH_QUERY = "(max-width: 639.98px)";

function usePhoneWidth(): boolean {
  const [narrow, setNarrow] = useState(() =>
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia(PHONE_WIDTH_QUERY).matches
      : false,
  );
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const query = window.matchMedia(PHONE_WIDTH_QUERY);
    const onChange = () => setNarrow(query.matches);
    onChange();
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  return narrow;
}

/** The conversation title the wire demands, from the text the person typed:
 * its first non-blank line, trimmed, capped at the server's own 200-rune
 * bound. Nothing is invented — the thread is named by its opening words. */
export function titleFromPrompt(text: string): string {
  const lines = text.split(/\r?\n/).map((part) => part.trim());
  const line = lines.find((part) => part !== "") ?? "";
  return line.slice(0, 200);
}

export function RepoChatBox({ projectId, repositoryName, prefill }: RepoChatBoxProps) {
  const navigate = useNavigate();
  const profiles = useAgentProfiles();
  const create = useCreateConversation(projectId);
  const [text, setText] = useState("");
  const [profileId, setProfileId] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const chipRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const phoneWidth = usePhoneWidth();

  // A note's prefill arrives while the page is already on screen: fill the
  // line and focus it, so the action lands where the person was sent. It never
  // starts anything — the design's rule is that a person confirms what the
  // assistant does (ADR-0052), and `Start` is that confirmation.
  useEffect(() => {
    if (!prefill) return;
    setText(prefill.text);
    inputRef.current?.focus();
  }, [prefill]);

  const items = useMemo(() => profiles.data?.items ?? [], [profiles.data]);
  // First read arms the default pick; a later list change keeps the choice
  // while it is still a real profile.
  useEffect(() => {
    if (items.length === 0) return;
    if (!items.some((item) => item.id === profileId)) setProfileId(items[0].id);
  }, [items, profileId]);

  const selected = items.find((item) => item.id === profileId) ?? null;
  const chipLabel = selected
    ? selected.model
      ? `${selected.name} · ${selected.model}`
      : selected.name
    : profiles.isPending
      ? "loading…"
      : "no profile";
  const trimmed = text.trim();
  const canStart = trimmed !== "" && selected !== null && !create.isPending && !profiles.isPending;

  const start = () => {
    if (!canStart || !selected) return;
    create.mutate(
      {
        title: titleFromPrompt(trimmed),
        agent_profile_id: selected.id,
        prompt: trimmed,
        repository: repositoryName,
      },
      { onSuccess: (conversation) => navigate(routes.thread(conversation.id)) },
    );
  };

  return (
    <div data-testid="repo-chat-box">
      <div className="flex items-stretch gap-2 rounded-[3px] border border-ink bg-surface p-[5px] shadow-(--shadow-raised)">
        <input
          ref={inputRef}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && canStart) {
              event.preventDefault();
              start();
            }
          }}
          aria-label={`Chat in ${repositoryName}`}
          placeholder={
            phoneWidth
              ? "Ask, plan or paste an issue…"
              : `Chat in ${repositoryName}… ask, plan, or paste an issue`
          }
          className="min-w-0 flex-1 bg-transparent px-2 text-[13px] text-ink outline-none placeholder:text-faint focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
          data-testid="repo-chat-input"
        />
        <button
          ref={chipRef}
          type="button"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          disabled={items.length === 0}
          onClick={() => setMenuOpen(true)}
          className="ds-btn ds-btn--secondary ds-btn--compact inline-flex shrink-0 items-center gap-1 rounded-[4px] font-mono text-[10.5px]"
          data-testid="repo-chat-profile"
        >
          {chipLabel}
          <ChevronDown size={12} strokeWidth={2} aria-hidden className="shrink-0" />
        </button>
        <Button
          variant="primary"
          onClick={start}
          disabled={!canStart}
          data-testid="repo-chat-start"
        >
          Start
        </Button>
      </div>
      <Menu
        open={menuOpen && items.length > 0}
        onClose={() => setMenuOpen(false)}
        triggerRef={chipRef}
        side="bottom"
        align="end"
        width={220}
        caption="THE CHAT RUNS ON"
        ariaLabel="Agent profile"
        data-testid="repo-chat-profile-menu"
        items={items.map((profile) => ({
          id: profile.id,
          label: profile.model ? `${profile.name} · ${profile.model}` : profile.name,
          checked: profile.id === profileId,
          testId: `repo-chat-profile-${profile.id.replace(/[^A-Za-z0-9]/g, "").slice(0, 13)}`,
          onSelect: () => {
            setProfileId(profile.id);
            setMenuOpen(false);
          },
        }))}
      />
      {profiles.data && items.length === 0 ? (
        <p className="pt-1 text-[12px] text-muted" data-testid="repo-chat-no-profiles">
          No agent profiles yet — add one under Library › Agent profiles to start a chat.
        </p>
      ) : null}
      {create.isError ? (
        <div className="pt-1">
          <FormError error={create.error} testid="repo-chat-error" />
        </div>
      ) : null}
    </div>
  );
}
