/**
 * The two things the journal fold cannot say on its own, fixed on the way out
 * of a conversation session (rcn-2e review item 2).
 *
 * Both live here rather than in `api/transcript.ts` because both need facts
 * the fold does not hold: the fold turns frames into lines and knows only what
 * a frame carries; these need the conversation's derived turn ranges and the
 * surface's own turn rows.
 *
 * 1. `nameAgentSessionLines` — the `Connected to …` line.
 *    `agent.session.connected` carries a LAUNCHER (`pi`), never a profile. Two
 *    profiles of one organization can run the same executable (the lab's
 *    `m4-implementer` and `m4-planner` both launch `pi`), so naming the
 *    launcher can only ever name the thread's CURRENT profile — which misnamed
 *    every earlier turn the moment the controller switched agents: the reviewed
 *    chat's first session printed "Connected to m4-planner" over a turn the
 *    `m4-implementer` ran. ADR-0068 put the fact on the turn row
 *    (`agent_profile_id`, stamped at enqueue and never moved) and derives the
 *    `Conversation.agents` turn ranges from it; this joins the session frame to
 *    the turn it launched and asks THAT what profile ran.
 *
 *    An unattributed frame keeps whatever the fold wrote: the honest launcher
 *    words, never a guessed product name.
 *
 * 2. `trimAgentMessageLead` — the gap under a speaker line.
 *    The first chunk of a turn arrives as blank lines (the worker flushes its
 *    workspace note, then the harness opens its answer with newlines), and
 *    `Transcript` renders agent text with `whitespace-pre-wrap`, so those
 *    newlines became ~40px of empty column between the `agent · time` header
 *    and the sentence under it. A blank leading line carries no information;
 *    it is stripped, and only at the start — an indented first line, or a gap
 *    inside the message, is the agent's own formatting and stays.
 */
import type { TranscriptItem, TurnRecord } from "../../api/transcript";
import type { EventEnvelope } from "../../api/types";

/** What `Conversation.agents` says about one run of turns (ADR-0068). */
export interface AgentTurnRange {
  agent_profile_name: string;
  model?: string | null;
  first_turn: number;
  last_turn: number;
}

/** The turn-row facts this line reads (`ConversationTurn`, ADR-0068). */
export interface AgentTurnRow {
  id: string;
  agent_profile_name?: string | null;
}

export interface SessionNameSource {
  /** The stream this surface folded, in the order the frames arrived. */
  events: readonly EventEnvelope[];
  /** The fold's turn records in journal order — ordinal `n` is `turns[n-1]`,
   * the same join `ConversationSidePanel` applies to the agent ranges. */
  turns: readonly TurnRecord[];
  /** `Conversation.agents`: which profile ran which range of turns. */
  agents?: readonly AgentTurnRange[] | undefined;
  /** The turn rows this surface holds (today: the active turn). The row is
   * the record of what its turn ran on, so it outranks the derived range. */
  turnRows?: readonly AgentTurnRow[] | undefined;
}

/** The leading-edge copy of the fold's session line (`api/transcript.ts`). */
const CONNECTED_PREFIX = "Connected to ";

function str(payload: unknown, key: string): string {
  if (!payload || typeof payload !== "object") return "";
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === "string" ? value : "";
}

/** One entry per committed frame (the fold's own `global_seq` replay guard),
 * in stream order. */
function committedFrames(events: readonly EventEnvelope[]): EventEnvelope[] {
  const seen = new Set<number>();
  const frames: EventEnvelope[] = [];
  for (const event of events) {
    if (seen.has(event.global_seq)) continue;
    seen.add(event.global_seq);
    frames.push(event);
  }
  return frames;
}

/**
 * The turn a session frame launched, or null when the stream cannot say.
 *
 * `agent.session.connected` is emitted when the worker launches the harness,
 * immediately before that turn's `conversation.turn.started` (04 § Sessions:
 * the connected row names the binding, and `turn.started` carries the same
 * `binding_id`). So the binding identifies the turn outright where both rows
 * carry it; otherwise the turn that started after the launch, earliest first,
 * is the only turn the session can have served.
 */
function turnLaunchedBy(frame: EventEnvelope, frames: readonly EventEnvelope[]): string | null {
  const binding = str(frame.payload, "binding_id");
  for (const candidate of frames) {
    if (candidate.type !== "conversation.turn.started") continue;
    if (candidate.global_seq <= frame.global_seq) continue;
    const turnId = str(candidate.payload, "turn_id");
    if (!turnId) continue;
    // The same binding, on the frame the launch opened: the exact join.
    if (binding && str(candidate.payload, "binding_id") === binding) return turnId;
    // No binding to join on — the first turn this session can have served.
    if (!binding) return turnId;
  }
  return null;
}

/** Every turn this stream named a `turn.started` for, in commit order — the
 * 1-based ordinal `Conversation.agents` ranges are spelled in. */
function turnOrdinals(frames: readonly EventEnvelope[]): Map<string, number> {
  const ordinals = new Map<string, number>();
  for (const frame of frames) {
    if (frame.type !== "conversation.turn.started") continue;
    const turnId = str(frame.payload, "turn_id");
    if (!turnId || ordinals.has(turnId)) continue;
    ordinals.set(turnId, ordinals.size + 1);
  }
  return ordinals;
}

/** The profile one session frame connected to, or null when neither the turn
 * row nor the derived range reaches that turn. */
function sessionProfileFor(
  frame: EventEnvelope,
  frames: readonly EventEnvelope[],
  ordinals: ReadonlyMap<string, number>,
  source: SessionNameSource,
): string | null {
  const turnId = turnLaunchedBy(frame, frames);
  if (!turnId) return null;
  const row = (source.turnRows ?? []).find((candidate) => candidate.id === turnId);
  const rowName = row?.agent_profile_name;
  if (typeof rowName === "string" && rowName) return rowName;
  // The ordinal is the order turns started in — the same order the fold's
  // `turns` list and the server's 1-based `agents` ranges use, so it is the
  // join `ConversationSidePanel` already applies to those ranges.
  let ordinal = ordinals.get(turnId) ?? 0;
  if (ordinal === 0) {
    const folded = source.turns.findIndex((record) => record.turnId === turnId);
    if (folded >= 0) ordinal = folded + 1;
  }
  if (ordinal <= 0) return null;
  const range = (source.agents ?? []).find(
    (entry) => ordinal >= entry.first_turn && ordinal <= entry.last_turn,
  );
  return range?.agent_profile_name ?? null;
}

/**
 * Re-name every `Connected to …` line the fold built from an
 * `agent.session.connected` frame with the profile that turn actually ran on.
 * Exported for tests: it runs on plain data (frames, turn records, ranges).
 */
export function nameAgentSessionLines(
  items: TranscriptItem[],
  source: SessionNameSource,
): TranscriptItem[] {
  const frames = committedFrames(source.events);
  const ordinals = turnOrdinals(frames);
  const byId = new Map(frames.map((frame) => [frame.event_id, frame] as const));
  let touched = false;
  const out = items.map((item) => {
    if (item.kind !== "system" || !item.text.startsWith(CONNECTED_PREFIX)) return item;
    const frame = byId.get(item.id);
    if (!frame || frame.type !== "agent.session.connected") return item;
    const name = sessionProfileFor(frame, frames, ordinals, source);
    if (!name) return item;
    const text = `${CONNECTED_PREFIX}${name}`;
    if (text === item.text) return item;
    touched = true;
    return { ...item, text };
  });
  return touched ? out : items;
}

/** One or more leading blank lines (spaces and tabs allowed on them). */
const LEADING_BLANK_LINES = /^(?:[ \t]*\r?\n)+/;

/** Drop the blank lines a turn's first chunk arrives behind, so the agent's
 * sentence sits under its own speaker line instead of 40px below it. */
export function trimAgentMessageLead(items: TranscriptItem[]): TranscriptItem[] {
  let touched = false;
  const out = items.map((item) => {
    if (item.kind !== "agent") return item;
    const text = item.text.replace(LEADING_BLANK_LINES, "");
    if (text === item.text) return item;
    touched = true;
    return { ...item, text };
  });
  return touched ? out : items;
}
