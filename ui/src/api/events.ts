/**
 * Project activity feed: the durable journal streamed over SSE
 * (`GET /api/v1/projects/{id}/events`, see `api/openapi.yaml`).
 *
 * Frames carry `event: <type>`, so we listen per type rather than only on
 * `onmessage`. Every frame invalidates the project's cached reads, which is how
 * a change committed through *another* API replica reaches this browser without
 * a reload. `EventSource` reconnects by itself and replays from `Last-Event-ID`;
 * we additionally drop anything at or below the highest `global_seq` we rendered
 * so a replay can never duplicate a row.
 */
import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { invalidateProject } from "./queries";
import type { EventEnvelope } from "./types";

/** Event types that exist in M1; later milestones extend this list. */
export const M1_EVENT_TYPES = [
  "project.created",
  "project.member.updated",
  "repository.added",
] as const;

export type ProjectEventType = (typeof M1_EVENT_TYPES)[number];

export type ConnectionState = "live" | "reconnecting";

const MAX_EVENTS = 100;

function parseEnvelope(data: string): EventEnvelope | null {
  try {
    const value = JSON.parse(data) as EventEnvelope;
    if (typeof value?.global_seq !== "number" || typeof value?.type !== "string") return null;
    return value;
  } catch {
    return null;
  }
}

export interface ProjectEvents {
  /** Newest first. */
  events: EventEnvelope[];
  status: ConnectionState;
}

export function useProjectEvents(projectId: string): ProjectEvents {
  const queryClient = useQueryClient();
  const [events, setEvents] = useState<EventEnvelope[]>([]);
  const [status, setStatus] = useState<ConnectionState>("reconnecting");
  const lastSeq = useRef(0);

  useEffect(() => {
    if (!projectId) return;
    setEvents([]);
    setStatus("reconnecting");
    lastSeq.current = 0;

    const record = (envelope: EventEnvelope) => {
      if (envelope.global_seq <= lastSeq.current) return;
      lastSeq.current = envelope.global_seq;
      setEvents((previous) => [envelope, ...previous].slice(0, MAX_EVENTS));
      setStatus("live");
      void invalidateProject(queryClient, projectId);
    };

    const source = new EventSource(`/api/v1/projects/${projectId}/events`);
    const listeners: Array<[string, (message: MessageEvent<string>) => void]> = [];
    for (const type of M1_EVENT_TYPES) {
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
  }, [projectId, queryClient]);

  return { events, status };
}
