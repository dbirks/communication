import { useActorNames } from "../api/actors";
import { useProjectEvents } from "../api/events";
import type { EventEnvelope } from "../api/types";
import { Panel } from "./ds/Panel";
import { StatusChip } from "./ds/Row";
import { STREAM_STATE, stateOf } from "./ds/states";

/** One-line human summary of an event payload (M1 event types). */
export function summarizeEvent(event: EventEnvelope): string {
  const payload = event.payload as Record<string, unknown>;
  const text = (key: string) => (typeof payload[key] === "string" ? (payload[key] as string) : "");
  switch (event.type) {
    case "repository.added":
      return text("name") ? `repository ${text("name")}` : "repository added";
    case "project.created":
      return text("slug") ? `project ${text("slug")}` : "project created";
    case "project.member.updated":
      return text("role") ? `role ${text("role")}` : "membership updated";
    default:
      return text("name") || text("slug") || event.type;
  }
}

function formatTime(occurredAt: string): string {
  const date = new Date(occurredAt);
  if (Number.isNaN(date.valueOf())) return occurredAt;
  return `${date.toISOString().slice(11, 19)} UTC`;
}

export interface ActivityFeedProps {
  projectId: string;
}

/**
 * Live activity: the project's durable event stream (SSE). Frames from any API
 * replica are identical because they are replayed from the shared journal, so
 * this list is also the proof that replicas agree. The actor is written as a
 * person's name — the journal's id is an implementation detail a reader of an
 * activity feed cannot use.
 */
export default function ActivityFeed({ projectId }: ActivityFeedProps) {
  const { events, status } = useProjectEvents(projectId);
  const { actorLabel } = useActorNames(projectId);

  return (
    <Panel
      id="activity"
      title="ACTIVITY"
      headingId="activity-heading"
      headingLevel={2}
      meta={
        <StatusChip
          state={stateOf(STREAM_STATE[status])}
          label={status}
          className="h-[15px]"
          labelProps={{ "data-testid": "activity-status", role: "status" }}
        />
      }
    >
      <div className="p-[10px]">
        {events.length === 0 ? (
          <p className="pb-2 text-[12.5px] text-muted">No events yet.</p>
        ) : null}
        <ol className="divide-y divide-line-soft" data-testid="activity-list" aria-live="polite">
          {events.map((event) => (
            <li
              key={event.global_seq}
              data-testid="activity-item"
              className="flex flex-wrap items-baseline gap-x-2 py-[5px] text-[12.5px]"
            >
              <span className="font-mono text-[11px] font-medium text-ink">{event.type}</span>
              <span aria-hidden="true" className="text-faint">
                ·
              </span>
              <span>{summarizeEvent(event)}</span>
              <span aria-hidden="true" className="text-faint">
                ·
              </span>
              <span>
                by <span data-testid="activity-actor">{actorLabel(event.actor)}</span>
              </span>
              <span aria-hidden="true" className="text-faint">
                ·
              </span>
              <time
                dateTime={event.occurred_at}
                className="ml-auto font-mono text-[10.5px] text-faint"
              >
                {formatTime(event.occurred_at)}
              </time>
            </li>
          ))}
        </ol>
      </div>
    </Panel>
  );
}
