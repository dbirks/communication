/**
 * `/artifacts/:artifactId` — one artifact: its metadata, its bytes, and a
 * preview that cannot reach this app.
 *
 * Two rules are load-bearing here and both come from ADR-0020:
 *
 * 1. The download is a plain navigation to `…/content`. The server answers
 *    `text/html` as `text/plain` + `Content-Disposition: attachment` with
 *    `nosniff`, so clicking it cannot execute the artifact in this origin.
 * 2. The preview frame's `src` is the server's absolute `preview_url` on the
 *    *preview hostname*, and only ever that. `resolvePreviewUrl()` returns null
 *    for a relative or same-origin URL, and this screen then says why it
 *    refused rather than embedding anyway — cookies are host-scoped, which is
 *    the entire mechanism that keeps a session cookie away from untrusted HTML.
 */
import { Link, useParams } from "react-router";
import { useActorNames } from "../api/actors";
import { ApiError } from "../api/client";
import { useArtifact } from "../api/queries";
import { ArtifactDetail } from "../components/Artifacts";
import { ProblemBanner, Spinner } from "../components/Feedback";

/**
 * `created_by` is `worker` for anything a worker published, or a user id for an
 * upload (`06` records the actor either way). A worker id is not a person, so it
 * gets a word rather than a name lookup.
 */
function creatorLabel(createdBy: string, nameOf: (userId: string) => string): string {
  if (createdBy === "worker") return "a worker";
  return nameOf(createdBy);
}

export default function ArtifactPage() {
  const { artifactId = "" } = useParams<{ artifactId: string }>();
  const artifact = useArtifact(artifactId);
  const actors = useActorNames();

  if (artifact.isPending) return <Spinner label="Loading artifact" />;

  if (artifact.error instanceof ApiError && artifact.error.status === 404) {
    return (
      <section aria-labelledby="artifact-missing-heading">
        <h1 id="artifact-missing-heading" className="text-title-l font-bold">
          Artifact
        </h1>
        <p className="mt-2 text-st-failed-tag-fg" role="alert">
          <span aria-hidden="true">× </span>
          <span data-testid="artifact-not-found">
            Artifact not found, or your role may not see it — a row hidden by the sensitivity table
            and a row that does not exist answer identically
          </span>
        </p>
      </section>
    );
  }

  if (artifact.error || !artifact.data) {
    return (
      <section aria-labelledby="artifact-error-heading">
        <h1 id="artifact-error-heading" className="text-title-l font-bold">
          Artifact
        </h1>
        <ProblemBanner error={artifact.error} fallback="The artifact could not be loaded." />
      </section>
    );
  }

  const data = artifact.data;

  return (
    <div className="space-y-4">
      <h1 className="sr-only" data-testid="artifact-page-title">
        Artifact {data.name}
      </h1>
      <p className="font-mono text-[11px] text-muted">
        <Link to={`/projects/${data.project_id}`} className="text-accent-text hover:text-ink">
          Project
        </Link>
        <span aria-hidden="true"> / </span>
        <Link
          to={`/projects/${data.project_id}/artifacts`}
          className="text-accent-text hover:text-ink"
        >
          Artifacts
        </Link>
        <span aria-hidden="true"> / </span>
        <span>{data.name}</span>
      </p>
      <ArtifactDetail
        artifact={data}
        createdByName={(createdBy) => creatorLabel(createdBy, actors.nameOf)}
      />
    </div>
  );
}
