/**
 * Thread rail — the ARTIFACTS section (docs/design/handoff-app-shell/gaps/
 * threads.md, work unit W3): the artifacts this thread produced, up to a page of
 * five, each linking to the artifact's own page.
 *
 * The rows come from the project artifact list filtered by conversation
 * (`GET /api/v1/projects/{projectId}/artifacts?conversation_id=…`) through
 * `useConversationArtifacts`; the server resolves the thread before filtering,
 * so the empty answer is "this thread has none yet" and the invisible answer is
 * a not-found the page renders as an error rather than as an empty list.
 */
import { Link } from "react-router";
import { Alert } from "../ds/Alert";
import { problemOf } from "../../api/client";
import { useConversationArtifacts } from "../../api/useConversationArtifacts";
import type { Artifact } from "../../api/types";
import { formatAge } from "../../lib/format";

/** How many rows the rail lists before the reader is expected to open the page. */
const RAIL_ARTIFACT_LIMIT = 5;

export function ThreadArtifacts({
  projectId,
  conversationId,
}: {
  projectId: string;
  conversationId: string;
}) {
  const query = useConversationArtifacts(projectId, conversationId);
  const artifacts = query.data?.artifacts ?? [];

  // The rail itself is ONE element in every state (docs/design/handoff-app-
  // shell/gaps/threads.md W3): a reader (or the e2e proof) can always see the
  // ARTIFACTS section — loading, refused, empty, or its rows — and the rows
  // keep their own `thread-artifacts` list identity inside it.
  return (
    <div data-testid="artifacts-rail">
      {query.isPending ? (
        <p className="text-[12.5px] text-muted">Loading this thread's artifacts…</p>
      ) : query.isError ? (
        <Alert state="failed" label="FAILED" role="alert" testid="artifacts-rail-error">
          {problemOf(query.error).detail || "Artifacts could not be loaded."}
        </Alert>
      ) : artifacts.length === 0 ? (
        <p className="text-[12.5px] text-muted">No artifacts from this thread yet</p>
      ) : (
        <ul className="space-y-[4px]" data-testid="thread-artifacts">
          {artifacts.slice(0, RAIL_ARTIFACT_LIMIT).map((artifact) => (
            <li key={artifact.id}>
              <ThreadArtifactRow artifact={artifact} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * One thread-artifact row: name, kind, relative time, and a link to the
 * artifact's own page. Metadata only — bytes stay behind the preview/content
 * paths.
 */
export function ThreadArtifactRow({ artifact }: { artifact: Artifact }) {
  return (
    <Link
      to={`/artifacts/${artifact.id}`}
      className="flex h-[34px] w-full items-center gap-[9px] rounded-[3px] border border-line bg-surface px-[10px] hover:border-line-strong focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
      data-testid="thread-artifact-row"
    >
      <span className="truncate text-[12.5px] font-semibold">{artifact.name}</span>
      <span className="font-mono text-[10.5px] text-muted">{artifact.kind}</span>
      <span className="ml-auto font-mono text-[10.5px] text-faint">
        {formatAge(artifact.created_at)} ago
      </span>
    </Link>
  );
}
