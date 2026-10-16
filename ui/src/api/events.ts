/**
 * Durable journal feeds over SSE (`api/openapi.yaml`, ADR-0014 §5/§9).
 *
 * Both streams are the same `domain_events` journal read through a different
 * scope: `GET /api/v1/projects/{id}/events` and
 * `GET /api/v1/conversations/{id}/events` (ADR-0016 §1: one journal, so one
 * gap-safety argument). Frames carry `event: <type>`, so we listen per type
 * rather than only on `onmessage`.
 *
 * The client does *not* rely on `EventSource`'s private reconnect: a reconnect
 * it owns carries `?after=<last seen global_seq>` (the route's documented
 * cursor for clients that do not send `Last-Event-ID`, `api/openapi.yaml`
 * `components.parameters.After`) and re-arms by hand, so an api replica rolling
 * over (M4 C14a, W10) resumes mid-journal instead of restarting from the head.
 * Frames at or below the highest `global_seq` already rendered are ignored, so a
 * replay can never duplicate a transcript row or a tool update — `id:` on the
 * wire *is* `global_seq`, so that floor is also the id-dedupe.
 *
 * Nothing here ever navigates or reloads: a dropped stream is a network event,
 * and the journal behind it is durable, so the page's own document must survive
 * it with its rendered rows intact (a reload would repaint the timeline from a
 * cold read and is exactly what W10 measures as "document replaced").
 */
import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { M4_PROJECT_EVENT_TYPES } from "../lib/pipeline/runEvents";
import { invalidateConversation, invalidateProject, queryKeys } from "./queries";
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
 * M3 project-stream types, spelled exactly as `internal/events/events.go`
 * emits them (`TypeWorkspacePrepared`…`TypeRepositoryMirrorUpdated`). They are
 * subscribed so a workspace that got quarantined, a secret that failed to
 * materialize, or an artifact that just landed reaches an open project screen
 * without a reload — `docs/design/data-dependencies.md` §4.
 */
export const M3_EVENT_TYPES = [
  "workspace.prepared",
  "workspace.committed",
  "workspace.quarantined",
  "workspace.released",
  "workspace.recovery_lost",
  "sandbox.verified",
  "sandbox.enforcement_failed",
  "secret.created",
  "secret.version.added",
  "secret.policy.updated",
  "secret.revoked",
  "secret.materialized",
  "secret.removed",
  "secret.materialization_failed",
  "artifact.created",
  "artifact.deleted",
  "repository.mirror_updated",
] as const;

export type ProjectM3EventType = (typeof M3_EVENT_TYPES)[number];

/** Everything the project scope carries from M1 through M4. */
const PROJECT_EVENT_TYPES = [...M1_EVENT_TYPES, ...M3_EVENT_TYPES, ...M4_PROJECT_EVENT_TYPES];

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

/**
 * The resume cursor the journal accepts in the URL. `after` is the last
 * `global_seq` rendered, so `0` (nothing seen yet) opens the stream plain and
 * lets the server start wherever its scope says it starts.
 */
export function resumeUrl(url: string, after: number): string {
  if (!(after > 0)) return url;
  return `${url}${url.includes("?") ? "&" : "?"}after=${Math.trunc(after)}`;
}

/** Reconnect ladder, capped: a replica that is down comes back within seconds,
 * and hammering a restarting replica is worse than a one-second gap. */
const RECONNECT_MS = [250, 500, 1000, 2000, 5000];

interface StreamOptions {
  url: string;
  types: readonly string[];
  /** Re-arm (clear) the buffer and refetch when these change, e.g. a new id. */
  keys: readonly (string | number)[];
  onEvent?: (event: EventEnvelope) => void;
}

/** Open one journal scope and return its frames in commit order. */
export function useEventStream({ url, types, keys, onEvent }: StreamOptions): EventStream {
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

    let closed = false;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    // The buffer is deliberately NOT rebuilt with the socket: the rows on screen
    // are the rows this document already drew, and a reconnect only appends.
    const record = (envelope: EventEnvelope) => {
      // The server may replay from the cursor, and a native EventSource retry
      // may redeliver what we already drew: the id (= `global_seq`) decides.
      if (envelope.global_seq <= lastSeq.current) return;
      lastSeq.current = envelope.global_seq;
      setEvents((previous) => [...previous, envelope].slice(-MAX_EVENTS));
      setStatus("live");
      onEventRef.current?.(envelope);
    };

    /** Tear one socket down; a socket we replaced is never allowed to keep a
     * listener that would double-apply a frame. */
    const detach = (source: EventSource) => {
      source.onmessage = null;
      source.onopen = null;
      source.onerror = null;
      for (const [type, listener] of bindings) source.removeEventListener(type, listener);
      source.close();
    };
    const bindings: Array<[string, (message: MessageEvent<string>) => void]> = [];
    for (const type of types) {
      const listener = (message: MessageEvent<string>) => {
        const envelope = parseEnvelope(message.data);
        if (envelope) record(envelope);
      };
      bindings.push([type, listener]);
    }

    let socket: EventSource | null = null;

    const reconnect = () => {
      if (closed || timer) return;
      setStatus("reconnecting");
      const wait = RECONNECT_MS[Math.min(attempt, RECONNECT_MS.length - 1)];
      attempt += 1;
      // A replica restart is a restart, not a mistake of ours: never reload, and
      // never drop the frames already on screen while waiting for the journal.
      timer = setTimeout(() => {
        timer = null;
        open();
      }, wait);
    };

    function open() {
      if (closed) return;
      const source = new EventSource(resumeUrl(url, lastSeq.current));
      for (const [type, listener] of bindings) source.addEventListener(type, listener);
      // Frames sent without an `event:` field (defensive; the server always sets one).
      source.onmessage = (message: MessageEvent<string>) => {
        const envelope = parseEnvelope(message.data);
        if (envelope) record(envelope);
      };
      source.onopen = () => {
        attempt = 0;
        setStatus("live");
      };
      // `onerror` fires both for a dead connection and for one the browser is
      // retrying on its own. Close it and open our own: the browser's retry
      // depends on the server having stamped `id:` on every frame, ours does not.
      source.onerror = () => {
        detach(source);
        if (socket === source) socket = null;
        reconnect();
      };
      socket = source;
    }

    open();

    return () => {
      closed = true;
      if (timer) clearTimeout(timer);
      if (socket) detach(socket);
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
    types: PROJECT_EVENT_TYPES,
    keys: [projectId],
    onEvent: (event) => {
      // M4 rows carry `run_id`: an open Run Inspector is a `["run", id]`
      // subtree, outside the project key, so name it too (docs/m4-contract.md
      // § 3: the project stream remains the superset).
      if (event.run_id) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.run(event.run_id) });
      }
      if (event.type.startsWith("pipeline.") || event.type.startsWith("assignment.")) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.pipelines });
      }
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
