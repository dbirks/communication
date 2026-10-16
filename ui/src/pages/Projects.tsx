/**
 * `/` — the projects index as a board (design 6b: "inbox as a board of
 * projects"). One card per project, each showing what that project still asks
 * of you, so a person can see *which client needs attention before what*.
 *
 * The counts are not this page's arithmetic: they come from
 * `../lib/attention.ts`, the single reduction Inbox reads, split per project.
 * A stalled run is therefore never attention on one screen and "fine" on
 * another. Honesty rules are Inbox's — the wire carries no run name and no
 * approval title, so an item shows its `summary`/status/short id and nothing
 * invented.
 */
import { useMemo, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router";
import { ApiError } from "../api/client";
import { useCreateProject, useProjects } from "../api/queries";
import type { Project } from "../api/types";
import { FormError, ProblemBanner, Spinner } from "../components/Feedback";
import { InitialsBox } from "../components/ds/AppBar";
import { Button } from "../components/ds/Button";
import { Field, Textarea, Input } from "../components/ds/Field";
import { Panel } from "../components/ds/Panel";
import { StatusChip } from "../components/ds/Row";
import {
  CONVERSATION_STATE,
  RUN_STATE,
  stateOf,
  STATES,
  type StateName,
} from "../components/ds/states";
import {
  attentionByProject,
  attentionTitle,
  ATTENTION_TITLE_CLAMP,
  needsYou,
  useProjectAttention,
  EMPTY_PROJECT_VIEW,
  type Attention,
  type ProjectAttentionView,
} from "../lib/attention";
import { formatAge, shortId } from "../lib/format";

/** Board order. \"needs me first\" is the default: the design's whole point is
 * that the client asking something of you sits at the front. */
type SortKey = "needs-me" | "az";

export default function Projects() {
  const projects = useProjects();
  const [sort, setSort] = useState<SortKey>("needs-me");
  const [formOpen, setFormOpen] = useState(false);

  const list = useMemo(() => projects.data?.items ?? [], [projects.data]);
  // One fan-out for every card, then a per-project cut — the same read Inbox
  // makes, so the two screens cannot disagree.
  const attention = useProjectAttention(list);
  const views = useMemo(() => attentionByProject(attention, list), [attention, list]);
  const ordered = useMemo(() => sortProjects(list, views, sort), [list, views, sort]);
  /** A project whose wires could not be read must not claim that nothing needs
   * you — the failure is stated on its card instead. */
  const readErrors = useMemo(() => {
    const byProject = new Map<string, string>();
    for (const { project, title } of attention.unread) {
      if (!byProject.has(project.id)) byProject.set(project.id, title);
    }
    return byProject;
  }, [attention.unread]);

  /** On an empty account the form is the only possible action, so it starts
   * open (the same rule `pages/Project.tsx` gives its add-forms). */
  const adding = formOpen || list.length === 0;

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-start justify-between gap-x-[14px] gap-y-2">
        <div className="min-w-0 space-y-1">
          <h1 className="text-[22px] leading-[28px] font-semibold" data-testid="projects-heading">
            Your projects
          </h1>
          {list.length > 0 ? <Tally attention={attention} /> : null}
        </div>
        <div className="flex shrink-0 items-center gap-[10px]">
          <SortToggle sort={sort} onChange={setSort} />
          <Button
            variant="primary"
            aria-expanded={adding}
            aria-controls="create-project-form"
            data-testid="new-project-toggle"
            onClick={() => setFormOpen((current) => !current)}
          >
            {adding ? "Close" : "New project"}
          </Button>
        </div>
      </header>

      {adding ? <NewProjectForm /> : null}

      {projects.isPending ? <Spinner label="Loading projects" /> : null}
      {projects.error ? (
        <ProblemBanner error={projects.error} fallback="Projects could not be loaded." />
      ) : null}
      {projects.data ? (
        list.length === 0 ? (
          <p className="text-[12.5px] text-muted" data-testid="project-list-empty">
            No projects yet
          </p>
        ) : (
          <ul
            className="grid grid-cols-1 items-start gap-3 sm:grid-cols-2 xl:grid-cols-3"
            data-testid="project-list"
          >
            {ordered.map((project) => (
              <ProjectCard
                key={project.id}
                project={project}
                view={views.get(project.id) ?? EMPTY_PROJECT_VIEW}
                readError={readErrors.get(project.id)}
              />
            ))}
          </ul>
        )
      ) : null}
    </div>
  );
}

/** Decisions and stalls first (most-needed first), then name. */
function sortProjects(
  projects: readonly Project[],
  views: ReadonlyMap<string, ProjectAttentionView>,
  sort: SortKey,
): Project[] {
  const items = [...projects];
  const viewOf = (project: Project) => views.get(project.id) ?? EMPTY_PROJECT_VIEW;
  return sort === "az"
    ? items.sort((a, b) => a.name.localeCompare(b.name))
    : items.sort(
        (a, b) => needsYou(viewOf(b)) - needsYou(viewOf(a)) || a.name.localeCompare(b.name),
      );
}

function SortToggle({ sort, onChange }: { sort: SortKey; onChange: (next: SortKey) => void }) {
  const option = (key: SortKey, label: string) => (
    <button
      type="button"
      aria-pressed={sort === key}
      data-testid={`projects-sort-${key}`}
      className={`font-mono text-[10.5px] underline decoration-line-strong underline-offset-4 ${
        sort === key ? "text-ink" : "text-faint hover:text-ink-2"
      }`}
      onClick={() => onChange(key)}
    >
      {label}
    </button>
  );
  return (
    <span className="flex items-center gap-[8px]" role="group" aria-label="Sort projects">
      {option("needs-me", "needs me first")}
      {option("az", "a–z")}
    </span>
  );
}

/**
 * One project: initials, what it asks of you, and the two items that ask
 * hardest. The card is a link at the top and an explicit `Open project` at the
 * bottom because the design's scan path starts on the name.
 */
function ProjectCard({
  project,
  view,
  readError,
}: {
  project: Project;
  view: ProjectAttentionView;
  readError: string | undefined;
}) {
  const items = topItems(view);
  const quiet =
    readError === undefined &&
    needsYou(view) === 0 &&
    view.conversations.length === 0 &&
    view.running.length === 0;
  return (
    <li data-testid={`project-card-${project.slug}`} className="h-full min-w-0">
      <article className="flex h-full flex-col overflow-hidden rounded-[3px] border border-line-strong bg-surface">
        <Link
          to={`/projects/${project.id}`}
          data-testid={`project-link-${project.slug}`}
          className="flex items-start gap-[10px] border-b border-line px-[12px] py-[10px]"
        >
          <InitialsBox name={project.name} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13.5px] font-semibold">{project.name}</span>
            <span className="block truncate font-mono text-[10.5px] text-muted">
              role: {project.my_role}
            </span>
            {project.description ? (
              <span
                className="mt-[2px] block truncate text-[12.5px] text-muted"
                title={project.description}
              >
                {project.description}
              </span>
            ) : null}
          </span>
        </Link>

        <div
          className="flex items-center gap-[10px] border-b border-line px-[12px] py-[7px]"
          data-testid={`project-counts-${project.slug}`}
        >
          <Count
            state="waiting"
            glyph="!"
            value={view.decisions.length}
            label="decisions"
            testid={`project-count-${project.slug}-decisions`}
          />
          <Count
            state="failed"
            glyph="×"
            value={view.stalled.length}
            label="stalled runs"
            testid={`project-count-${project.slug}-stalled`}
          />
          <Count
            state="running"
            glyph="●"
            value={view.conversations.length}
            label="conversations"
            testid={`project-count-${project.slug}-conversations`}
          />
          <Count
            state="queued"
            glyph="▸"
            value={view.running.length}
            label="running fine"
            testid={`project-count-${project.slug}-running`}
          />
        </div>

        <div className="flex-1 space-y-[8px] px-[12px] py-[10px]">
          {items.length > 0 ? (
            items.map((item) => <AttentionItem key={item.key} item={item} />)
          ) : (
            <p
              className={`text-[12.5px] ${readError ? "text-st-failed-tag-fg" : "text-muted"}`}
              data-testid={`project-quiet-${project.slug}`}
            >
              {readError
                ? `× could not be read — ${readError}`
                : quiet
                  ? "Nothing needs you."
                  : `${view.running.length} running fine`}
            </p>
          )}
        </div>

        <div className="border-t border-line px-[12px] py-[8px]">
          <Link
            to={`/projects/${project.id}`}
            className="ds-btn ds-btn--secondary inline-flex h-[26px] items-center rounded-[4px] px-[10px]"
            data-testid={`project-open-${project.slug}`}
          >
            Open project
          </Link>
        </div>
      </article>
    </li>
  );
}

/**
 * A count with its state glyph. The number is the visible part, so the word
 * rides in the accessible name — a glyph alone is color-by-another-name.
 */
function Count({
  state,
  glyph,
  value,
  label,
  testid,
}: {
  state: StateName;
  glyph: string;
  value: number;
  label: string;
  testid: string;
}) {
  return (
    <span
      data-testid={testid}
      className={`inline-flex items-center gap-[4px] font-mono text-[10.5px] ${
        value > 0 ? STATES[state].tagFg : "text-faint"
      }`}
    >
      <span aria-hidden="true">{glyph}</span>
      <span>{value}</span>
      <span className="sr-only">{label}</span>
    </span>
  );
}

interface CardItem {
  key: string;
  state: StateName;
  tag: string;
  /** What the row prints — a gate's summary with its plan JSON left out. */
  title: string;
  /** The wire's full text, kept for the row's tooltip. */
  full: string;
  meta: string;
  to: string;
}

/** The two rows that ask most: an open gate before a stopped run before a
 * live conversation, each already in its own list's order. */
function topItems(view: ProjectAttentionView): CardItem[] {
  const items: CardItem[] = [
    ...view.decisions.map(({ project, approval }) => ({
      key: `decision-${approval.id}`,
      state: "waiting" as StateName,
      tag: "approval",
      title: attentionTitle(approval.summary),
      full: approval.summary,
      meta: `${formatAge(approval.created_at)} · run ${shortId(approval.run_id)}`,
      to: `/projects/${project.id}/runs/${approval.run_id}`,
    })),
    ...view.stalled.map(({ project, run }) => ({
      key: `stalled-${run.id}`,
      state: stateOf(RUN_STATE[run.status]),
      tag: run.status,
      title: `Run ${shortId(run.id)}${run.failed_cause ? ` — ${run.failed_cause}` : ""}`,
      full: `Run ${shortId(run.id)}${run.failed_cause ? ` — ${run.failed_cause}` : ""}`,
      meta: `${formatAge(run.created_at)} · run ${shortId(run.id)}`,
      to: `/projects/${project.id}/runs/${run.id}`,
    })),
    ...view.conversations.map(({ project, conversation, pendingPermissions }) => ({
      key: `conversation-${conversation.id}`,
      state:
        pendingPermissions > 0
          ? ("waiting" as StateName)
          : stateOf(CONVERSATION_STATE[conversation.status]),
      tag: pendingPermissions > 0 ? "permission" : conversation.status,
      title: conversation.title.trim() || `conversation ${shortId(conversation.id)}`,
      full: conversation.title.trim() || `conversation ${shortId(conversation.id)}`,
      meta: `${formatAge(conversation.updated_at)} · conversation`,
      to: `/projects/${project.id}/conversations/${conversation.id}`,
    })),
  ];
  return items.slice(0, 2);
}

function AttentionItem({ item }: { item: CardItem }) {
  return (
    <Link
      to={item.to}
      className="block rounded-[3px] border border-line bg-paper px-[9px] py-[7px] hover:border-line-strong"
      data-testid={`project-item-${item.key}`}
    >
      <StatusChip state={item.state} label={item.tag} />
      <span
        className={`mt-[3px] block break-words text-[12.5px] font-semibold leading-[17px] ${ATTENTION_TITLE_CLAMP}`}
        data-testid={`item-title-${item.key}`}
        title={item.full}
      >
        {item.title}
      </span>
      <span className="mt-[2px] block font-mono text-[10.5px] text-faint">{item.meta}</span>
    </Link>
  );
}

/** The board-wide line the design puts under the heading: the same totals the
 * cards add to. */
function Tally({ attention }: { attention: Attention }) {
  const count = (state: StateName, glyph: string, value: number, label: string) => (
    <span
      className={`inline-flex items-center gap-[4px] font-mono text-[10.5px] ${STATES[state].tagFg}`}
    >
      <span aria-hidden="true">{glyph}</span>
      {value} {label}
    </span>
  );
  return (
    <p
      className="flex flex-wrap items-center gap-x-[12px] gap-y-[2px]"
      data-testid="projects-tally"
    >
      {count("waiting", "!", attention.decisions.length, "decisions")}
      {count("failed", "×", attention.stalled.length, "stalled")}
      {count("running", "●", attention.conversations.length, "conversations")}
      <span className="inline-flex items-center gap-[4px] font-mono text-[10.5px] text-faint">
        <span aria-hidden="true">▸</span>
        {attention.running.length} running fine
      </span>
    </p>
  );
}

/**
 * The create form the index has always carried, now collapsed behind the
 * header's `New project` button. Same fields, same testids, same 409 note:
 * `e2e/tests` fill it to make the first project of an account, which is exactly
 * the state where it starts open.
 */
function NewProjectForm() {
  const create = useCreateProject();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    create.mutate(
      { name: trimmed, description: description.trim() || undefined },
      {
        onSuccess: (project) => {
          setName("");
          setDescription("");
          navigate(`/projects/${project.id}`);
        },
      },
    );
  };

  return (
    <form id="create-project-form" onSubmit={onSubmit} aria-labelledby="create-heading">
      <Panel title="NEW PROJECT" headingId="create-heading">
        <div className="space-y-3 p-[10px]">
          <Field id="create-project-name" label="Name">
            <Input
              id="create-project-name"
              data-testid="create-project-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
            />
          </Field>
          <Field id="create-project-description" label="Description (optional)">
            <Textarea
              id="create-project-description"
              data-testid="create-project-description"
              rows={3}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
          </Field>
          <Button
            type="submit"
            variant="primary"
            data-testid="create-project-submit"
            disabled={create.isPending || !name.trim()}
          >
            {create.isPending ? "Creating…" : "Create project"}
          </Button>
          {create.error instanceof ApiError && create.error.status === 409 ? (
            <p className="text-[12.5px] text-muted">Pick a different name — the slug is taken.</p>
          ) : null}
          <FormError error={create.error} />
        </div>
      </Panel>
    </form>
  );
}
