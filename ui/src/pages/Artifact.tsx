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
 *
 * The header line is a breadcrumb and a byline, and both name real things: the
 * project by the name its owner gave it, the publisher by the words the actor
 * directory resolves (`api/actors.ts` — the same lookup the transcript uses),
 * and the moment in the relative units every other list in the app uses.
 */
import { Link, useParams } from "react-router";
import { useActorNames } from "../api/actors";
import type { ActorNames } from "../api/actors";
import { ApiError } from "../api/client";
import { useArtifact, useProject } from "../api/queries";
import { shortId } from "../api/names";
import { ArtifactDetail } from "../components/Artifacts";
import { ProblemBanner, Spinner } from "../components/Feedback";
import { formatAge } from "../lib/format";
import { routes } from "../lib/routes";
import type { Artifact } from "../api/types";

/**
 * Who published an artifact, in words a reader can act on.
 *
 * `created_by` is `worker` for anything a worker published, or a user id for an
 * upload (`06` records the actor either way) — and in practice the two publish
 * paths (`attempt_artifacts.go`, `unit_artifacts.go`) both record the *worker's*
 * id, which is a uuid the pass-2 review correctly read as "someone (4e7f968c)".
 * A machine publisher is therefore named by what it published *for*: the run, or
 * the conversation. Only a row the directory actually recognizes as a person
 * gets a person's name, so a human upload is never rewritten as a run.
 */
export function artifactCreator(artifact: Artifact, actors: ActorNames): string {
  if (artifact.created_by === "worker") return "a worker";
  const person = actors.lookup(artifact.created_by);
  if (person) return person;
  if (artifact.run_id) return `the run ${shortId(artifact.run_id)}`;
  if (artifact.conversation_id) return `the thread ${shortId(artifact.conversation_id)}`;
  if (artifact.worker_id) return "a worker";
  // A person the directory cannot (yet) name: `someone (abc12345)`, and the id
  // was handed to `useActorNames` below, so that is a lookup in progress.
  return actors.nameOf(artifact.created_by);
}

export default function ArtifactPage() {
  const { artifactId = "" } = useParams<{ artifactId: string }>();
  const artifact = useArtifact(artifactId);

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

  return <ArtifactHeader artifact={artifact.data} />;
}

/**
 * The page's own chrome above the detail panel. A separate component so the
 * project and directory reads it needs run with the row in hand (hooks may not
 * hide behind a loading branch).
 */
function ArtifactHeader({ artifact: data }: { artifact: Artifact }) {
  const project = useProject(data.project_id);
  // The publisher id goes to the directory as an outstanding lookup: a person it
  // cannot name is looked up again rather than left as "someone" for the life of
  // the page (`api/actors.ts`).
  const actorIds = [data.created_by];
  const actors = useActorNames(data.project_id, actorIds);
  const created = `${formatAge(data.created_at)} ago`;

  return (
    <div className="space-y-4">
      <h1 className="sr-only" data-testid="artifact-page-title">
        Artifact {data.name}
      </h1>
      <p className="font-mono text-[11px] text-muted">
        <Link
          to={routes.project(data.project_id)}
          className="text-accent-text hover:text-ink"
          data-testid="artifact-breadcrumb-project"
        >
          {/* The breadcrumb names the project, not the word "Project" — the
           * reader is standing inside one, and the pass-2 review asked what it
           * is called. The generic word is only the loading/unknown arm. */}
          {project.data?.name ?? "Project"}
        </Link>
        <span aria-hidden="true"> / </span>
        <Link
          to={routes.projectTab(data.project_id, "artifacts")}
          className="text-accent-text hover:text-ink"
        >
          Artifacts
        </Link>
        <span aria-hidden="true"> / </span>
        <span>{data.name}</span>
      </p>
      <ArtifactDetail
        artifact={data}
        createdByName={() => artifactCreator(data, actors)}
        createdLabel={() => created}
      />
    </div>
  );
}
