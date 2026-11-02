/**
 * The transcript divider for `conversation.agent.switched` (ADR-0068).
 *
 * The journal row *is* the divider: the controller moved the conversation's
 * next-turn agent profile between turns, and the transcript renders exactly
 * what that row says — "`<person>` switched to `<agent>` · `<model>` ·
 * transcript and branch carried over". Nothing else is inferred: the actor's
 * name resolves through the page's actor directory, the model segment appears
 * only when the row carries one (a profile that names none shows its bare
 * name — the honest answer), and the carried-over tail prints only when the
 * payload's `transcript_carried_over` is true.
 *
 * The wording follows ADR-0068 § 3 verbatim. The design round (2e) prints a
 * shortened "Dana switched to Codex · gpt-5"; where the two differ the ADR
 * wins, and 1h carries the same full sentence, so the divider never claims
 * less (or more) than "transcript and branch carried over". Per ADR-0068 § 5
 * that sentence is exactly true: the durable journal and the workspace/branch
 * carry over; the *harness's private context* is not re-seeded across a
 * profile change, and the divider does not claim it is.
 */
import type { EventEnvelope } from "../../api/types";

/** The tail ADR-0068 fixes for the divider, printed only when the row says
 * `transcript_carried_over: true`. */
export const CARRIED_OVER_TAIL = "transcript and branch carried over";

export interface AgentSwitchDividerProps {
  /** Who switched — a display name, never a bare uuid. */
  person: string;
  /** `to_profile_name` from the journal row. */
  agent: string;
  /** The pinned display model, or null when the profile names none. */
  model: string | null;
  /** `transcript_carried_over` as the row reported it. */
  carriedOver: boolean;
  testId?: string;
}

/** The divider's sentence. `model` and the carried-over tail are segments,
 * not guesses: an absent model prints no ` · ` before it. */
export function agentSwitchCopy(
  person: string,
  agent: string,
  model: string | null,
  carriedOver: boolean,
): string {
  return (
    `${person} switched to ${agent}` +
    (model ? ` · ${model}` : "") +
    (carriedOver ? ` · ${CARRIED_OVER_TAIL}` : "")
  );
}

function str(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  return typeof value === "string" ? value : "";
}

/** Read the divider's props off a `conversation.agent.switched` envelope.
 * The payload names the actor; the envelope's actor carries the same human —
 * when neither names one, the divider says "Someone" rather than inventing a
 * person or printing a uuid. */
export function agentSwitchFromEvent(
  event: EventEnvelope,
  nameOf: (userId: string) => string,
): AgentSwitchDividerProps {
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  const actorId =
    str(payload, "actor_user_id") || (event.actor?.kind === "human" ? event.actor.id : "");
  return {
    person: actorId ? nameOf(actorId) : "Someone",
    agent: str(payload, "to_profile_name") || "an agent",
    model: str(payload, "model") || null,
    carriedOver: payload.transcript_carried_over === true,
  };
}

/** The centred mono divider row. */
export function AgentSwitchDivider(props: AgentSwitchDividerProps) {
  const { person, agent, model, carriedOver, testId = "agent-switch-divider" } = props;
  return (
    <div
      data-testid={testId}
      className="flex items-center gap-3 px-1 py-2"
      role="separator"
      aria-label={agentSwitchCopy(person, agent, model, carriedOver)}
    >
      <span aria-hidden="true" className="h-px min-w-0 flex-1 bg-line" />
      <span className="min-w-0 break-words text-center font-mono text-[10.5px] text-faint">
        {agentSwitchCopy(person, agent, model, carriedOver)}
      </span>
      <span aria-hidden="true" className="h-px min-w-0 flex-1 bg-line" />
    </div>
  );
}
