/**
 * The project home's starter pills (redesign R2, README §2 "Project home").
 *
 * Three kinds, all built from data the API actually serves — never from the
 * prototype's mock rows:
 *
 * - up to two RESUME pills: the two conversations of this project the reader
 *   was most recently in (`useConversations`, newest `updated_at` first), each
 *   labelled with the thread's own title and linking back to it;
 * - up to two RUN pills: the workflows this project has assigned
 *   (`useAssignments`), labelled `Run {name}`;
 * - one NEW CHAT pill, always there, pointing at the New chat pane.
 *
 * The run pill is a LINK, not a dialog opener: `StartRunDialog` has no way to
 * be opened on one named workflow, and a pill that opened the form on a random
 * workflow would start something other than what it just named. It goes to that
 * workflow's page in the Factory, where starting it is the button's own job.
 *
 * A name the library read has not answered yet is not guessed at: the run pill
 * prints the workflow's short id (the run rows' own fallback), never an
 * invented display name.
 */
import { Link } from "react-router";
import { IconArrowBackUp, IconBuildingFactory2, IconMessagePlus } from "@tabler/icons-react";
import { useAssignments, usePipelines } from "../../api/pipelines";
import { useConversations } from "../../api/queries";
import { shortId } from "../../lib/format";
import { routes } from "../../lib/routes";
import { byUpdatedDesc } from "../project/RecentThreads";

/** How many pills of each dynamic kind the row may carry. */
export const STARTER_PILL_LIMIT = 2;

/** The classes one pill wears: 1px line, full radius, 5px 11px, 12.5px. */
const PILL_CLASS =
  "inline-flex min-h-[44px] max-w-full items-center gap-[6px] rounded-full border border-line px-[11px] text-[12.5px] text-ink hover:border-line-strong hover:bg-accent-wash focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent min-[560px]:min-h-[28px]";

/** The icon a pill wears, always 14px in the accent's own edge colour. */
const PILL_ICON_CLASS = "shrink-0 text-accent-edge";

export interface StarterPillsProps {
  /** The project whose conversations and workflows the row is built from. */
  projectId: string;
}

export function StarterPills({ projectId }: StarterPillsProps) {
  const conversations = useConversations(projectId);
  const assignments = useAssignments(projectId);
  const pipelines = usePipelines();

  const recent = byUpdatedDesc(conversations.data?.items ?? [])
    .filter((thread) => thread.status !== "archived")
    .slice(0, STARTER_PILL_LIMIT);
  const pinned = (assignments.data?.assignments ?? [])
    .filter((assignment) => assignment.enabled)
    .slice(0, STARTER_PILL_LIMIT);
  const library = new Map(
    (pipelines.data?.pipelines ?? []).map((pipeline) => [pipeline.id, pipeline] as const),
  );

  return (
    <div className="flex flex-wrap gap-2" data-testid="starter-pills">
      {recent.map((thread) => (
        <Link
          key={thread.id}
          to={routes.chat(thread.id, projectId)}
          className={PILL_CLASS}
          data-testid={`starter-pill-resume-${shortId(thread.id)}`}
          title={`Resume ${thread.title}`}
        >
          <IconArrowBackUp size={14} stroke={1.5} className={PILL_ICON_CLASS} aria-hidden />
          <span className="min-w-0 truncate">{thread.title}</span>
        </Link>
      ))}
      {pinned.map((assignment) => {
        const pipeline = library.get(assignment.pipeline_id);
        // The library read names the workflow; until it answers (or when the
        // pipeline is gone from it) the short id is the only honest label.
        const name =
          pipeline?.display_name ?? pipeline?.slug ?? `workflow ${shortId(assignment.pipeline_id)}`;
        return (
          <Link
            key={assignment.id}
            to={routes.factoryWorkflow(assignment.pipeline_id, projectId)}
            className={PILL_CLASS}
            data-testid={`starter-pill-run-${shortId(assignment.pipeline_id)}`}
          >
            <IconBuildingFactory2 size={14} stroke={1.5} className={PILL_ICON_CLASS} aria-hidden />
            <span className="min-w-0 truncate">Run {name}</span>
          </Link>
        );
      })}
      <Link
        to={routes.chat("new", projectId)}
        className={PILL_CLASS}
        data-testid="starter-pill-chat"
      >
        <IconMessagePlus size={14} stroke={1.5} className={PILL_ICON_CLASS} aria-hidden />
        New chat
      </Link>
    </div>
  );
}

export default StarterPills;
