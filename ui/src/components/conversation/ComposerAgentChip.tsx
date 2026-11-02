/**
 * The composer's agent chip — the "NEXT TURN RUNS ON" picker (ADR-0068,
 * design 1h).
 *
 * The chip prints the conversation's NEXT-turn profile
 * (`agent_profile_name · agent_profile_model`; the model segment only when
 * the profile pins one). It opens the ds `Menu` with the design's caption and
 * the caller's organization's agent profiles, ✓ on the current one. Choosing
 * a profile calls `POST /api/v1/conversations/{id}/switch-agent` — the whole
 * route, with its rules shown as state, not re-implemented here:
 *
 * - only the human controller may switch → disabled with a visible reason;
 * - only between turns → disabled while a turn is open;
 * - an archived thread answers `409` → disabled with its reason;
 * - every API answer (403 identity, 409 `turn_in_progress`, 400
 *   `invalid_agent_profile`) renders inline, never swallowed.
 *
 * Switching to the profile already set is the API's idempotent no-op — the
 * item is still clickable (the double-click rule), and no fake optimistic
 * flip happens: the chip moves when the conversation read says it moved.
 */
import { useRef, useState } from "react";
import { useAgentProfiles } from "../../api/queries";
import { FormError } from "../Feedback";
import { Menu, type MenuEntry } from "../ds/Menu";
import { agentLabel } from "./ConversationTranscript";
import type { ConversationSession } from "./useConversationSession";

export interface ComposerAgentChipProps {
  session: ConversationSession;
}

/** Why the chip is disabled, in the words a member reads; null = allowed.
 * The order mirrors the route's own refusal order (controller first, then
 * timing, then the thread's state). */
export function agentSwitchBlockedReason(
  session: Pick<ConversationSession, "isController" | "turnInProgress" | "data">,
): string | null {
  if (!session.isController)
    return "Only the controller can choose which agent runs the next turn.";
  if (session.turnInProgress)
    return "A turn is running — the next-turn agent can be chosen between turns.";
  if (session.data?.status === "archived")
    return "This thread is archived — nothing more runs on it.";
  return null;
}

export function ComposerAgentChip({ session }: ComposerAgentChipProps) {
  const profiles = useAgentProfiles();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const data = session.data;
  const blocked = agentSwitchBlockedReason(session);
  // One sentence per fact, once on the screen (rcn-3d review item 5). A
  // controller whose turn is open is told so by the composer's own explainer
  // under the box — "A turn is already open (…). Wait for it to finish, or
  // press Stop" — which is the longer, more actionable of the two lines, and
  // the one wired to the input through `aria-describedby`. This chip's reason
  // said the same thing a second time, inside the form, so it is not printed
  // in that state; the disabled chip keeps it as its `title` tooltip and its
  // accessible description, and every OTHER refusal (a non-controller, an
  // archived thread) still prints, because there the explainer below says
  // something different (who holds the wheel, or that the thread is closed).
  const reasonIsOnTheScreenElsewhere = session.isController && session.turnInProgress;
  const current = agentLabel(data?.agent_profile_name ?? "agent", data?.agent_profile_model);

  const list = profiles.data?.items ?? [];
  const items: MenuEntry[] = [];
  if (profiles.isPending) {
    items.push({ id: "loading", label: "Loading profiles…", onSelect: () => {}, disabled: true });
  } else if (profiles.isError || list.length === 0) {
    items.push({
      id: "none",
      label: profiles.isError
        ? "The agent profiles could not be read."
        : "This organization has no agent profiles yet.",
      onSelect: () => {},
      disabled: true,
    });
  } else {
    for (const profile of list) {
      items.push({
        id: profile.id,
        label: agentLabel(profile.name, profile.model),
        // `false` (not undefined) on the siblings keeps the labels aligned.
        checked: profile.id === data?.agent_profile_id,
        disabled: blocked !== null || session.switchAgent.isPending,
        testId: `composer-agent-profile-${profile.id}`,
        onSelect: () => {
          setOpen(false);
          session.switchAgent.mutate({ agent_profile_id: profile.id });
        },
      });
    }
    items.push({ separator: true });
    items.push({
      id: "source",
      label: (
        <span className="text-[11.5px] text-faint">
          Profiles come from the project's agent profiles.
        </span>
      ),
      onSelect: () => {},
      disabled: true,
    });
  }

  return (
    <>
      <span className="relative inline-flex max-w-full">
        <button
          ref={triggerRef}
          type="button"
          data-testid="composer-agent-chip"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-disabled={blocked !== null || undefined}
          disabled={blocked !== null}
          title={blocked ?? "Choose the agent the next turn runs on"}
          onClick={() => setOpen((value) => !value)}
          className="inline-flex h-[28px] min-w-0 max-w-full items-center gap-[6px] rounded-[3px] border border-line-strong bg-surface px-2 font-mono text-[11.5px] text-ink hover:border-ink disabled:cursor-not-allowed disabled:text-muted"
        >
          <span className="min-w-0 truncate">{current}</span>
          <span aria-hidden="true" className="shrink-0 text-[10px] text-muted">
            {open ? "▴" : "▾"}
          </span>
        </button>
        <Menu
          open={open && blocked === null}
          onClose={() => setOpen(false)}
          triggerRef={triggerRef}
          side="top"
          width={260}
          caption="NEXT TURN RUNS ON"
          ariaLabel="The agent the next turn runs on"
          data-testid="composer-agent-menu"
          items={items}
        />
      </span>
      {blocked !== null && !reasonIsOnTheScreenElsewhere ? (
        <p
          className="w-full font-mono text-[10.5px] text-faint"
          data-testid="composer-agent-chip-reason"
        >
          {blocked}
        </p>
      ) : null}
      {session.switchAgent.isPending ? (
        <p
          className="w-full font-mono text-[10.5px] text-faint"
          role="status"
          data-testid="composer-agent-switch-pending"
        >
          Switching the next-turn agent…
        </p>
      ) : null}
      {session.switchAgent.error ? (
        <div className="w-full" data-testid="composer-agent-switch-error">
          <FormError error={session.switchAgent.error} testid="composer-agent-switch-error-copy" />
        </div>
      ) : null}
    </>
  );
}
