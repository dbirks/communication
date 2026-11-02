/**
 * The conversation transcript with ADR-0068's agent-switch dividers.
 *
 * `Transcript` renders one flat list and cannot be touched from this task's
 * boundaries, so this wrapper composes it: the items are cut at every
 * `conversation.agent.switched` journal frame (ordered by `global_seq`, the
 * same cursor the fold itself dedupes on) and each run of items renders as
 * its own `Transcript`, with the divider between them. A conversation that
 * never switched agents renders exactly one `Transcript`, as before.
 *
 * The agent label per run answers the design's `Agent · model` header:
 *
 * - No switch ever happened, so every turn ran on the conversation's current
 *   profile: the label is `agent_profile_name · agent_profile_model` (the
 *   model segment only when the profile pins one — ADR-0068: null is the
 *   honest "names no model").
 * - After a switch, each following run takes its label from the switch row's
 *   `to_profile_name`/`model`; the first run takes the profile from the
 *   derived `agents` list (the entry whose range starts at turn 1) or from
 *   the `conversation.created` frame. When neither is in the retained stream
 *   the label falls back to a plain "agent" — never the *current* profile,
 *   which after a switch would misname every earlier turn.
 * - `· skill: name` (design 2e) is not rendered because no wire data carries
 *   a per-message skill today; the day the journal names one, this is the
 *   place it lands.
 */
import Transcript from "../Transcript";
import type { TranscriptItem } from "../../api/transcript";
import type { EventEnvelope } from "../../api/types";
import { AgentSwitchDivider, agentSwitchFromEvent } from "./AgentSwitchDivider";
import type { ConversationSession } from "./useConversationSession";

/** `Codex · gpt-5`, or just `Codex` when the profile names no model. */
export function agentLabel(name: string, model?: string | null): string {
  return model ? `${name} · ${model}` : name;
}

/**
 * Cut the folded items at every `conversation.agent.switched` frame.
 * Exported for tests: it is the whole behaviour of this surface, and it runs
 * on plain data.
 */
export function splitAtAgentSwitches(
  items: readonly TranscriptItem[],
  events: readonly EventEnvelope[],
): { divider: EventEnvelope | null; items: TranscriptItem[] }[] {
  const seqById = new Map<string, number>();
  const switches: EventEnvelope[] = [];
  const seen = new Set<number>();
  for (const event of events) {
    // The same replay guard the fold applies: one `global_seq` folds once.
    if (seen.has(event.global_seq)) continue;
    seen.add(event.global_seq);
    seqById.set(event.event_id, event.global_seq);
    if (event.type === "conversation.agent.switched") switches.push(event);
  }
  const parts: { divider: EventEnvelope | null; items: TranscriptItem[] }[] = [
    { divider: null, items: [] },
  ];
  let next = 0;
  for (const item of items) {
    const itemSeq = seqById.get(item.id);
    if (itemSeq !== undefined) {
      // A switch belongs before the first frame that committed after it. An
      // item whose originating frame is not in the window (impossible from
      // this page's own stream, defensive for reuse elsewhere) keeps its
      // position and does not flush pending dividers.
      while (
        next < switches.length &&
        (seqById.get(switches[next].event_id) ?? Number.POSITIVE_INFINITY) < itemSeq
      ) {
        parts.push({ divider: switches[next], items: [] });
        next += 1;
      }
    }
    parts[parts.length - 1].items.push(item);
  }
  while (next < switches.length) {
    parts.push({ divider: switches[next], items: [] });
    next += 1;
  }
  return parts;
}

export interface ConversationTranscriptProps {
  session: ConversationSession;
}

/** The session's transcript, with a divider where the agent was switched. */
export function ConversationTranscript({ session }: ConversationTranscriptProps) {
  const { data, transcript, events, isController, nameOf } = session;
  const parts = splitAtAgentSwitches(transcript.items, events);
  const switched = parts.length > 1;

  // The label for the run before any switch.
  let initial = "agent";
  if (!switched) {
    initial = agentLabel(data?.agent_profile_name ?? "agent", data?.agent_profile_model);
  } else {
    const first = (data?.agents ?? []).find((entry) => entry.first_turn === 1);
    const created = events.find((event) => event.type === "conversation.created");
    const createdName =
      typeof created?.payload?.agent_profile_name === "string"
        ? created.payload.agent_profile_name
        : "";
    initial = first ? agentLabel(first.agent_profile_name, first.model) : createdName || "agent";
  }

  const controllerName = data
    ? (data.control.display_name ??
      (data.control.user_id ? session.nameOf(data.control.user_id) : null))
    : null;

  const transcriptFor = (items: TranscriptItem[], agentName: string) => (
    <Transcript
      items={items}
      agentName={agentName}
      canDecide={isController}
      controllerName={controllerName}
      nameOf={nameOf}
      onDecide={session.onDecide}
      decidingRequestId={session.decidingRequestId}
      decisionError={session.decide.error}
      decisionErrorRequestId={
        session.decide.isError ? (session.decide.variables?.requestId ?? null) : null
      }
    />
  );

  return (
    <>
      {parts.map((part, index) => {
        const label = part.divider
          ? agentLabel(
              String(part.divider.payload?.to_profile_name ?? "agent"),
              typeof part.divider.payload?.model === "string" ? part.divider.payload.model : null,
            )
          : initial;
        return (
          <div
            key={part.divider ? part.divider.event_id : `segment-${index}`}
            className="space-y-[4px]"
          >
            {part.divider ? (
              <AgentSwitchDivider {...agentSwitchFromEvent(part.divider, nameOf)} />
            ) : null}
            {part.items.length > 0 || !switched ? transcriptFor(part.items, label) : null}
          </div>
        );
      })}
    </>
  );
}
