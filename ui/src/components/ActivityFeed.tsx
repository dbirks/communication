import { useProjectEvents } from "../api/events";
import type { EventEnvelope } from "../api/types";

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
 * this list is also the proof that replicas agree.
 */
export default function ActivityFeed({ projectId }: ActivityFeedProps) {
  const { events, status } = useProjectEvents(projectId);

  return (
    <section aria-labelledby="activity-heading" className="space-y-2">
      <div className="flex items-baseline gap-3">
        <h2 id="activity-heading" className="text-lg font-semibold">
          Activity
        </h2>
        <p className="text-sm text-gray-700" role="status" aria-live="polite">
          feed: <span data-testid="activity-status">{status}</span>
        </p>
      </div>
      {events.length === 0 ? <p className="text-sm text-gray-600">No events yet.</p> : null}
      <ol className="space-y-1" data-testid="activity-list" aria-live="polite">
        {events.map((event) => (
          <li
            key={event.global_seq}
            data-testid="activity-item"
            className="flex flex-wrap gap-x-2 text-sm"
          >
            <span className="font-medium">{event.type}</span>
            <span aria-hidden="true">·</span>
            <span>{summarizeEvent(event)}</span>
            <span aria-hidden="true">·</span>
            <span>
              {event.actor.kind}: {event.actor.id.slice(0, 8)}
            </span>
            <span aria-hidden="true">·</span>
            <time dateTime={event.occurred_at}>{formatTime(event.occurred_at)}</time>
          </li>
        ))}
      </ol>
    </section>
  );
}
