/**
 * `/projects/:projectId/conversations` — the project's conversations as a
 * screen in its own right.
 *
 * Until now the list only existed as a section of the overview
 * (`/projects/:id#conversations`), so the literal URL a breadcrumb, an inbox
 * row, the assistant's route table (`internal/assistant/routes.go` admits
 * `/projects/{id}/conversations`) or a hand-typed address produces rendered the
 * app's "Not found" page. This is the same section the overview mounts, built
 * the way `/runs` and `/pipelines` are: the project read gates the screen, the
 * rail says where you are, and the panel is `components/Conversations.tsx`.
 *
 * The overview keeps its copy of the section, so the `#conversations` fragment
 * still lands on something real; the rail's canonical href is now the route.
 */
import { Link, useParams } from "react-router";
import { useConversations, useProject } from "../api/queries";
import Conversations from "../components/Conversations";
import { ProblemBanner, Spinner } from "../components/Feedback";
import ProjectSectionNav from "../components/ProjectSectionNav";
import { ProjectUnavailable, projectAccessRefused } from "../components/ProjectUnavailable";

export default function ProjectConversations() {
  const { projectId = "" } = useParams<{ projectId: string }>();
  const project = useProject(projectId);
  // The panel below reads the same query key, so this is a second pair of eyes
  // on one round trip — the list route answers the same 404/403 the project
  // read does, and the gate has to see it (`/runs` does the same with its runs
  // read).
  const list = useConversations(projectId);

  if (project.isPending) return <Spinner label="Loading conversations" />;

  // A non-member gets the one refusal every screen under `/projects/:id`
  // gives: the project read answers 404, and a panel saying "no conversations
  // yet" would confirm more than the API chose to say.
  if (projectAccessRefused(project.error) || projectAccessRefused(list.error)) {
    return (
      <ProjectUnavailable
        heading="Conversations"
        headingId="project-conversations-heading"
        testid="project-conversations-not-found"
      />
    );
  }

  if (project.error || !project.data) {
    return (
      <section aria-labelledby="project-conversations-error-heading">
        <h1 id="project-conversations-error-heading" className="text-title-l font-bold">
          Conversations
        </h1>
        <ProblemBanner error={project.error} fallback="The project could not be loaded." />
      </section>
    );
  }

  const data = project.data;

  return (
    <div
      className="grid items-start gap-4 md:grid-cols-[160px_minmax(0,1fr)]"
      data-testid="project-conversations"
    >
      <ProjectSectionNav projectId={data.id} active="conversations" />
      <div className="min-w-0 space-y-4">
        <header className="space-y-1">
          <p className="font-mono text-[11px] text-muted">
            <Link to={`/projects/${data.id}`} className="text-accent-text hover:text-ink">
              {data.name}
            </Link>
            <span aria-hidden="true"> / </span>
            <span>Conversations</span>
          </p>
          <h1
            id="project-conversations-heading"
            className="text-title-l font-bold"
            data-testid="project-conversations-title"
          >
            Conversations — {data.name}
          </h1>
          <p className="text-[12.5px] text-muted">
            Your role: <span className="font-mono">{data.my_role}</span>. Only contributors and
            maintainers can start one; anybody who can read the project can see the list.
          </p>
        </header>
        <Conversations project={data} />
      </div>
    </div>
  );
}
