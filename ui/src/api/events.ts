/**
 * Durable journal feeds over SSE (`api/openapi.yaml`, ADR-0014 §5/§9).
 *
 * Both streams are the same `domain_events` journal read through a different
 * scope: `GET /api/v1/projects/{id}/events` and
 * `GET /api/v1/conversations/{id}/events` (ADR-0016 §1: one journal, so one
 * gap-safety argument). Frames carry `event: <type>`, so we listen per type
 * rather than only on `onmessage`.
 *
 * `EventSource` reconnects by itself and replays from `Last-Event-ID`; we
 * additionally ignore anything at or below the highest `global_seq` already
 * rendered, so a replay can never duplicate a transcript row or a tool update.
 */
import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { invalidateConversation, invalidateProject } from "./queries";
import type { EventEnvelope } from "./types";

/** Event types that existed in M1. */
export const M1_EVENT_TYPES = [
  "project.created",
  "project.member.updated",
  "repository.added",
] as const;

/**
 * M2 conversation event types (ADR-0016 §7), spelled exactly as the Go
 * constants in `internal/events/events.go` emit them.
 */
export const M2_EVENT_TYPES = [
  "conversation.created",
  "conversation.message.user",
  "conversation.message.agent",
  "conversation.thought",
  "conversation.tool.call",
  "conversation.tool.update",
  "conversation.permission.requested",
  "conversation.permission.decided",
  "conversation.turn.started",
  "conversation.turn.completed",
  "conversation.turn.cancelled",
  "conversation.turn.failed",
  "conversation.turn.interrupted",
  "conversation.control.transferred",
  "agent.session.connected",
  "agent.session.disconnected",
] as const;

export type ProjectEventType = (typeof M1_EVENT_TYPES)[number];
export type ConversationEventType = (typeof M2_EVENT_TYPES)[number];

/**
 * Types that change the `Conversation` resource itself (control, active turn,
 * pending prompts, attached session). Transcript chunks deliberately do not
 * appear here: they are rendered from the stream, and refetching the
 * conversation for every coalesced chunk would be a request storm.
 */
const RESOURCE_TYPES = new Set<string>([
  "conversation.created",
  "conversation.control.transferred",
  "conversation.permission.requested",
  "conversation.permission.decided",
  "conversation.turn.started",
  "conversation.turn.completed",
  "conversation.turn.cancelled",
  "conversation.turn.failed",
  "conversation.turn.interrupted",
  "agent.session.connected",
  "agent.session.disconnected",
]);

export type ConnectionState = "live" | "reconnecting";

const MAX_EVENTS = 500;

function parseEnvelope(data: string): EventEnvelope | null {
  try {
    const value = JSON.parse(data) as EventEnvelope;
    if (typeof value?.global_seq !== "number" || typeof value?.type !== "string") return null;
    return value;
  } catch {
    return null;
  }
}

export interface EventStream {
  /** Event envelopes in journal order (oldest first). */
  events: EventEnvelope[];
  status: ConnectionState;
}

interface StreamOptions {
  url: string;
  types: readonly string[];
  /** Re-arm (clear) the buffer and refetch when these change, e.g. a new id. */
  keys: readonly (string | number)[];
  onEvent?: (event: EventEnvelope) => void;
}

/** Open one journal scope and return its frames in commit order. */
function useEventStream({ url, types, keys, onEvent }: StreamOptions): EventStream {
  const [events, setEvents] = useState<EventEnvelope[]>([]);
  const [status, setStatus] = useState<ConnectionState>("reconnecting");
  const lastSeq = useRef(0);
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  useEffect(() => {
    if (!url) return;
    setEvents([]);
    setStatus("reconnecting");
    lastSeq.current = 0;

    const record = (envelope: EventEnvelope) => {
      // A replay from Last-Event-ID can redeliver what we already drew.
      if (envelope.global_seq <= lastSeq.current) return;
      lastSeq.current = envelope.global_seq;
      setEvents((previous) => [...previous, envelope].slice(-MAX_EVENTS));
      setStatus("live");
      onEventRef.current?.(envelope);
    };

    const source = new EventSource(url);
    const listeners: Array<[string, (message: MessageEvent<string>) => void]> = [];
    for (const type of types) {
      const listener = (message: MessageEvent<string>) => {
        const envelope = parseEnvelope(message.data);
        if (envelope) record(envelope);
      };
      source.addEventListener(type, listener);
      listeners.push([type, listener]);
    }

    // Frames sent without an `event:` field (defensive; the server always sets one).
    source.onmessage = (message: MessageEvent<string>) => {
      const envelope = parseEnvelope(message.data);
      if (envelope) record(envelope);
    };
    source.onopen = () => setStatus("live");
    source.onerror = () => setStatus("reconnecting");

    return () => {
      source.onmessage = null;
      source.onopen = null;
      source.onerror = null;
      for (const [type, listener] of listeners) source.removeEventListener(type, listener);
      source.close();
    };
    // `types` is a module constant per call site; `keys` are the ids inside `url`,
    // so the dependency array length is fixed for a given call site.
  }, [url, ...keys]);

  return { events, status };
}

export interface ProjectEvents extends EventStream {
  /** Newest first, as the activity list renders it. */
  events: EventEnvelope[];
}

export function useProjectEvents(projectId: string): ProjectEvents {
  const queryClient = useQueryClient();
  const { events, status } = useEventStream({
    url: projectId ? `/api/v1/projects/${projectId}/events` : "",
    types: M1_EVENT_TYPES,
    keys: [projectId],
    onEvent: (event) => {
      void invalidateProject(queryClient, event.project_id ?? projectId);
    },
  });
  // The activity feed shows the newest frame at the top.
  return { events: [...events].reverse(), status };
}

/**
 * One conversation's transcript stream. Every frame also refreshes the
 * `Conversation` resource when it is a state-bearing type, which is how a
 * control transfer committed through *another* API replica reaches this browser
 * (`communication-spec/11-build-roadmap.md` M2 exit: pod restarts lose nothing).
 */
export function useConversationEvents(conversationId: string): EventStream {
  const queryClient = useQueryClient();
  return useEventStream({
    url: conversationId ? `/api/v1/conversations/${conversationId}/events` : "",
    types: M2_EVENT_TYPES,
    keys: [conversationId],
    onEvent: (event) => {
      if (RESOURCE_TYPES.has(event.type)) {
        invalidateConversation(
          queryClient,
          event.conversation_id ?? conversationId,
          event.project_id,
        );
      }
    },
  });
}
