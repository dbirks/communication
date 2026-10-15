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
import { ProblemBanner, Spinner } from "../components/Feedback";
import { Alert } from "../components/ds/Alert";

export default function Artifacts() {
  const { projectId = "" } = useParams<{ projectId: string }>();
  const project = useProject(projectId);
  const artifacts = useArtifacts(projectId);

  if (project.isPending || artifacts.isPending) return <Spinner label="Loading artifacts" />;

  const missing =
    (project.error instanceof ApiError && project.error.status === 404) ||
    (artifacts.error instanceof ApiError && artifacts.error.status === 404);
  if (missing) {
    return (
      <section aria-labelledby="artifacts-missing-heading">
        <h1 id="artifacts-missing-heading" className="text-title-l font-bold">
          Artifacts
        </h1>
        <p className="mt-2 text-st-failed-tag-fg" role="alert">
          <span aria-hidden="true">× </span>
          <span data-testid="artifacts-not-found">Project not found or you do not have access</span>
        </p>
      </section>
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
    <div className="space-y-4">
      <header className="space-y-1">
        <p className="font-mono text-[11px] text-muted">
          <Link to={`/projects/${data.id}`} className="text-accent-text hover:text-ink">
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
  );
}
