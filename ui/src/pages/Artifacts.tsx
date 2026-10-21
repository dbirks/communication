/**
 * `/projects/:projectId/artifacts` — the project's artifact index.
 *
 * The list is exactly what `GET /api/v1/projects/{id}/artifacts` serializes:
 * the sensitivity table is enforced in SQL (ADR-0020 §3), so a `restricted` row
 * a viewer cannot see is simply absent rather than greyed out — and the screen
 * says so, because "no rows" and "no rows you may see" are different facts.
 */
import { Link, useParams } from "react-router";
import { ApiError } from "../api/client";
import { useArtifacts, useProject } from "../api/queries";
import { ArtifactsPanel } from "../components/Artifacts";
import ProjectSectionNav from "../components/ProjectSectionNav";
import { ProjectUnavailable, projectAccessRefused } from "../components/ProjectUnavailable";
import { ProblemBanner, Spinner } from "../components/Feedback";
import { Alert } from "../components/ds/Alert";
import { routes } from "../lib/routes";

export default function Artifacts() {
  const { projectId = "" } = useParams<{ projectId: string }>();
  const project = useProject(projectId);
  const artifacts = useArtifacts(projectId);

  if (project.isPending || artifacts.isPending) return <Spinner label="Loading artifacts" />;

  // The project's own refusal — 404 (unknown or invisible) or 403 — is the
  // overview's sentence. A refused *index* while the project reads fine is a
  // different fact ("not readable with your role") and stays a banner.
  const missing =
    projectAccessRefused(project.error) ||
    (artifacts.error instanceof ApiError && artifacts.error.status === 404);
  if (missing) {
    return (
      <ProjectUnavailable
        heading="Artifacts"
        headingId="artifacts-missing-heading"
        testid="artifacts-not-found"
      />
    );
  }
  if (project.error || !project.data) {
    return (
      <section aria-labelledby="artifacts-error-heading">
        <h1 id="artifacts-error-heading" className="text-title-l font-bold">
          Artifacts
        </h1>
        <ProblemBanner error={project.error} fallback="The project could not be loaded." />
      </section>
    );
  }

  const data = project.data;

  return (
    <div className="grid items-start gap-4 md:grid-cols-[160px_minmax(0,1fr)]">
      <ProjectSectionNav projectId={data.id} active="artifacts" />
      <div className="min-w-0 space-y-4">
        <header className="space-y-1">
          <p className="font-mono text-[11px] text-muted">
            <Link to={routes.project(data.id)} className="text-accent-text hover:text-ink">
              {data.name}
            </Link>
            <span aria-hidden="true"> / </span>
            <span>Artifacts</span>
          </p>
          <h1 className="text-title-l font-bold" data-testid="artifacts-title">
            Artifacts — {data.name}
          </h1>
        </header>
        {artifacts.error ? (
          <Alert state="failed" label="FAILED" role="alert" testid="artifacts-error">
            {artifacts.error instanceof ApiError && artifacts.error.status === 403
              ? "Artifacts are not readable with your role here."
              : (artifacts.error as Error).message || "Artifacts could not be loaded."}
          </Alert>
        ) : (
          <ArtifactsPanel
            headingId="artifacts-list-heading"
            artifacts={artifacts.data?.artifacts ?? []}
          />
        )}
      </div>
    </div>
  );
}
