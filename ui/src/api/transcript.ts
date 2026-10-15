/**
 * Transcript projection (ADR-0016 §7): the conversation's `domain_events` rows
 * folded into something a person can read.
 *
 * The journal is the transcript, so this is a pure fold over the frames the SSE
 * stream delivered — replayed frames are deduplicated by `global_seq`, streamed
 * agent chunks merge into one message per turn, and a `conversation.tool.update`
 * mutates the tool call already on screen instead of adding a row. Nothing here
 * decides state: the turn's status comes from the events and from
 * `getConversation.active_turn`, never from a client-side guess, and
 * `interrupted` is rendered as "stopped, outcome unknown" (`10-ui-design-handoff
 * .md` J7) rather than as a resume.
 */
import type {
  ConversationTurn,
  ConversationTurnStatus,
  EventEnvelope,
  PermissionOption,
  PermissionRequestStatus,
} from "./types";

export type TranscriptItem =
  | {
      kind: "user";
      id: string;
      turnId: string;
      authorUserId: string;
      text: string;
      at: string;
    }
  | {
      kind: "agent";
      id: string;
      turnId: string;
      text: string;
      truncated: boolean;
      final: boolean;
    }
  | { kind: "thought"; id: string; turnId: string; text: string; truncated: boolean }
  | {
      kind: "tool";
      id: string;
      turnId: string;
      toolCallId: string;
      title: string;
      toolKind: string;
      status: string;
      inputPreview: string;
      outputPreview: string;
      truncated: boolean;
    }
  | {
      kind: "permission";
      id: string;
      turnId: string;
      requestId: string;
      title: string;
      toolKind: string;
      options: PermissionOption[];
      status: PermissionRequestStatus;
      decisionOptionId: string | null;
      decidedBy: string | null;
      deadlineAt: string | null;
    }
  | { kind: "system"; id: string; text: string; at: string };

/** What the journal says about one turn (merged with `active_turn` for display). */
export interface TurnRecord {
  turnId: string;
  status: ConversationTurnStatus;
  stopReason: string | null;
  /** `lease_expired` | `worker_gone` | `shutdown` for an interrupted turn. */
  interruptReason: string | null;
  requestedBy: string | null;
  sessionOrigin: string | null;
  startedAt: string | null;
}

export interface Transcript {
  items: TranscriptItem[];
  turns: TurnRecord[];
  /** Highest `global_seq` folded in, i.e. what a reconnect would resume from. */
  throughSeq: number;
}

function str(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  return typeof value === "string" ? value : "";
}

function bool(payload: Record<string, unknown>, key: string): boolean {
  return payload[key] === true;
}

function options(payload: Record<string, unknown>): PermissionOption[] {
  const raw = payload["options"];
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const option = entry as Record<string, unknown>;
    const optionId = str(option, "option_id");
    if (!optionId) return [];
    return [{ option_id: optionId, label: str(option, "label"), kind: str(option, "kind") }];
  });
}

const INTERRUPT_COPY: Record<string, string> = {
  lease_expired: "the worker's lease expired",
  worker_gone: "the worker disappeared",
  shutdown: "the worker shut down",
};

/**
 * The honest sentence for an interrupted turn (`10-ui-design-handoff.md` J7:
 * never "resumed without loss"). Exported so the turn-status line and the
 * transcript say the same thing.
 */
export function interruptedCopy(reason: string | null): string {
  const cause = reason ? INTERRUPT_COPY[reason] : undefined;
  return cause
    ? `Turn stopped — outcome unknown (${cause}); you can send a new prompt`
    : "Turn stopped — outcome unknown; you can send a new prompt";
}

/** Plain-language line for the journal rows that are not message content. */
function systemLine(event: EventEnvelope, payload: Record<string, unknown>): string | null {
  switch (event.type) {
    case "conversation.created":
      return `Conversation started with ${str(payload, "agent_profile_name") || "an agent"}`;
    case "conversation.control.transferred": {
      const to = str(payload, "to_kind") === "human" ? str(payload, "to_user_id") : "nobody";
      const reason = str(payload, "reason");
      if (reason === "returned") return `Control returned (to ${to})`;
      if (reason === "taken") return `Control taken (by ${to})`;
      return `Control transferred to ${to} (${reason})`;
    }
    case "conversation.turn.started":
      return str(payload, "session_origin") === "resumed"
        ? "Turn started on a resumed agent session"
        : "Turn started on a new agent session";
    case "conversation.turn.completed":
      return `Turn completed${str(payload, "stop_reason") ? ` (${str(payload, "stop_reason")})` : ""}`;
    case "conversation.turn.cancelled":
      return "Turn cancelled";
    case "conversation.turn.failed":
      return `Turn failed${str(payload, "message") ? `: ${str(payload, "message")}` : ""}`;
    case "conversation.turn.interrupted":
      return interruptedCopy(str(payload, "reason") || null);
    case "agent.session.connected":
      return `Agent session connected (${str(payload, "launcher_id")})`;
    case "agent.session.disconnected":
      return `Agent session disconnected (${str(payload, "reason")})`;
    default:
      return null;
  }
}

/** Fold journal frames into transcript items in the order they were committed. */
export function projectTranscript(events: readonly EventEnvelope[]): Transcript {
  const items: TranscriptItem[] = [];
  const turns = new Map<string, TurnRecord>();
  const agentByTurn = new Map<string, Extract<TranscriptItem, { kind: "agent" }>>();
  const thoughtByTurn = new Map<string, Extract<TranscriptItem, { kind: "thought" }>>();
  const tools = new Map<string, Extract<TranscriptItem, { kind: "tool" }>>();
  const permissions = new Map<string, Extract<TranscriptItem, { kind: "permission" }>>();
  const seen = new Set<number>();
  let throughSeq = 0;

  const push = (item: TranscriptItem) => {
    items.push(item);
    return item;
  };

  const turnRecord = (turnId: string, event: EventEnvelope): TurnRecord => {
    const existing = turns.get(turnId);
    if (existing) return existing;
    const record: TurnRecord = {
      turnId,
      status: "queued",
      stopReason: null,
      interruptReason: null,
      requestedBy: null,
      sessionOrigin: null,
      startedAt: event.occurred_at,
    };
    turns.set(turnId, record);
    return record;
  };

  for (const event of events) {
    // Replay-safe: the same `global_seq` must never be folded twice.
    if (seen.has(event.global_seq)) continue;
    seen.add(event.global_seq);
    if (event.global_seq > throughSeq) throughSeq = event.global_seq;

    const payload = (event.payload ?? {}) as Record<string, unknown>;
    const turnId = str(payload, "turn_id");
    const at = event.occurred_at;

    switch (event.type) {
      case "conversation.message.user": {
        push({
          kind: "user",
          id: event.event_id,
          turnId,
          authorUserId: str(payload, "submitted_by"),
          text: str(payload, "text"),
          at,
        });
        if (turnId) turnRecord(turnId, event).status = "queued";
        break;
      }
      case "conversation.message.agent": {
        const text = str(payload, "text");
        const existing = turnId ? agentByTurn.get(turnId) : undefined;
        if (existing) {
          existing.text += text;
          existing.truncated = existing.truncated || bool(payload, "truncated");
          existing.final = existing.final || bool(payload, "final");
          break;
        }
        const item: Extract<TranscriptItem, { kind: "agent" }> = {
          kind: "agent",
          id: event.event_id,
          turnId,
          text,
          truncated: bool(payload, "truncated"),
          final: bool(payload, "final"),
        };
        push(item);
        if (turnId) agentByTurn.set(turnId, item);
        break;
      }
      case "conversation.thought": {
        const text = str(payload, "text");
        const existing = turnId ? thoughtByTurn.get(turnId) : undefined;
        if (existing) {
          existing.text += text;
          existing.truncated = existing.truncated || bool(payload, "truncated");
          break;
        }
        const item: Extract<TranscriptItem, { kind: "thought" }> = {
          kind: "thought",
          id: event.event_id,
          turnId,
          text,
          truncated: bool(payload, "truncated"),
        };
        push(item);
        if (turnId) thoughtByTurn.set(turnId, item);
        break;
      }
      case "conversation.tool.call": {
        const callId = str(payload, "tool_call_id");
        const item: Extract<TranscriptItem, { kind: "tool" }> = {
          kind: "tool",
          id: event.event_id,
          turnId,
          toolCallId: callId,
          title: str(payload, "title"),
          toolKind: str(payload, "kind"),
          status: str(payload, "status") || "pending",
          inputPreview: str(payload, "input_preview"),
          outputPreview: "",
          truncated: bool(payload, "truncated"),
        };
        push(item);
        if (callId) tools.set(callId, item);
        break;
      }
      case "conversation.tool.update": {
        const callId = str(payload, "tool_call_id");
        const target = callId ? tools.get(callId) : undefined;
        if (target) {
          // Update in place: the row already on screen changes status, never a
          // second row for the same tool call.
          target.status = str(payload, "status") || target.status;
          const title = str(payload, "title");
          if (title) target.title = title;
          target.outputPreview += str(payload, "output_preview");
          target.truncated = target.truncated || bool(payload, "truncated");
          break;
        }
        const item: Extract<TranscriptItem, { kind: "tool" }> = {
          kind: "tool",
          id: event.event_id,
          turnId,
          toolCallId: callId,
          title: str(payload, "title") || "(tool call not in transcript)",
          toolKind: "",
          status: str(payload, "status") || "pending",
          inputPreview: "",
          outputPreview: str(payload, "output_preview"),
          truncated: bool(payload, "truncated"),
        };
        push(item);
        if (callId) tools.set(callId, item);
        break;
      }
      case "conversation.permission.requested": {
        const requestId = str(payload, "permission_request_id");
        if (requestId && permissions.has(requestId)) break;
        const item: Extract<TranscriptItem, { kind: "permission" }> = {
          kind: "permission",
          id: event.event_id,
          turnId,
          requestId,
          title: str(payload, "title"),
          toolKind: str(payload, "kind"),
          options: options(payload),
          status: "pending",
          decisionOptionId: null,
          decidedBy: null,
          deadlineAt: str(payload, "deadline_at") || null,
        };
        push(item);
        if (requestId) permissions.set(requestId, item);
        break;
      }
      case "conversation.permission.decided": {
        const requestId = str(payload, "permission_request_id");
        const status = str(payload, "status") as PermissionRequestStatus;
        const decision = str(payload, "decision_option_id") || null;
        const decider = str(payload, "decided_by") || null;
        const target = requestId ? permissions.get(requestId) : undefined;
        if (target) {
          target.status = status;
          target.decisionOptionId = decision;
          target.decidedBy = decider;
          break;
        }
        // The request itself scrolled out of the retained window (or was
        // appended before this client connected): still show how it closed.
        push({
          kind: "system",
          id: event.event_id,
          text: `Permission ${status}${decision ? ` (${decision})` : ""}`,
          at,
        });
        break;
      }
      default: {
        const turnEvent = event.type.startsWith("conversation.turn.")
          ? event.type.slice("conversation.turn.".length)
          : "";
        if (turnEvent) {
          if (turnId) {
            const record = turnRecord(turnId, event);
            switch (turnEvent) {
              case "started":
                record.status = "running";
                record.sessionOrigin = str(payload, "session_origin") || null;
                record.startedAt = at;
                break;
              case "completed":
                record.status = "completed";
                record.stopReason = str(payload, "stop_reason") || null;
                break;
              case "cancelled":
                record.status = "cancelled";
                record.stopReason = str(payload, "stop_reason") || null;
                record.requestedBy = str(payload, "requested_by") || null;
                break;
              case "failed":
                record.status = "failed";
                record.stopReason = str(payload, "stop_reason") || null;
                break;
              case "interrupted":
                // No stop reason: nothing reported one (migration 00003 says so).
                record.status = "interrupted";
                record.interruptReason = str(payload, "reason") || null;
                break;
              default:
                break;
            }
          }
        }
        const line = systemLine(event, payload);
        if (line) push({ kind: "system", id: event.event_id, text: line, at });
        break;
      }
    }
  }

  return { items, turns: [...turns.values()], throughSeq };
}

/**
 * The turn whose state the page should describe.
 *
 * `activeTurn` (from `getConversation`) outranks the journal while the journal
 * has nothing newer: it is the authoritative lease answer, including
 * `cancel_requested_at`, which no event carries. But a *terminal* journal record
 * for that same turn outranks it outright — the turn row and its terminal event
 * commit in one transaction (ADR-0014), so the event is proof the row already
 * moved and the cached read is merely stale.
 */
export function describeTurn(
  turns: readonly TurnRecord[],
  activeTurn?: ConversationTurn | null,
): { status: ConversationTurnStatus; record?: TurnRecord; active?: ConversationTurn } {
  const TERMINAL = new Set<ConversationTurnStatus>([
    "completed",
    "cancelled",
    "failed",
    "interrupted",
  ]);
  if (activeTurn) {
    const record = turns.find((candidate) => candidate.turnId === activeTurn.id);
    if (record && TERMINAL.has(record.status)) {
      return { status: record.status, record };
    }
    return { status: activeTurn.status, record, active: activeTurn };
  }
  const last = turns.at(-1);
  if (last) return { status: last.status, record: last };
  return { status: "queued" };
}

/** Text for the `turn-status` hook — status is never conveyed by colour alone. */
export function turnStatusText(
  turns: readonly TurnRecord[],
  activeTurn?: ConversationTurn | null,
): string {
  const described = describeTurn(turns, activeTurn);
  const { status, record, active } = described;
  switch (status) {
    case "queued":
      return record || active ? "queued — waiting for a worker" : "idle — no turn yet";
    case "leased":
      return "starting — a worker has the turn";
    case "running":
      return active?.cancel_requested_at
        ? "running — stop requested, waiting for the agent"
        : "running";
    case "completed":
      return `completed${record?.stopReason ? ` (${record.stopReason})` : ""}`;
    case "cancelled":
      return `cancelled${record?.requestedBy ? " (requested by a controller)" : ""}`;
    case "failed":
      return `failed${record?.stopReason ? ` (${record.stopReason})` : ""}`;
    case "interrupted":
      return "stopped — outcome unknown";
    default:
      return status;
  }
}
