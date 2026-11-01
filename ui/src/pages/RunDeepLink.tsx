/**
 * RunDeepLink.tsx — the project-less workbench deep link, `/runs/:runId`.
 *
 * The workbench was built for `/projects/:projectId/runs/:runId` and reads the
 * project from the URL; this wrapper resolves it from the unscoped
 * `GET /api/v1/runs/{runId}` and mounts the workbench with the prop, showing
 * the workbench's own loading state until the project is known.
 *
 * It is its own module — and its own route chunk — because it is the only
 * thing that mounts `RunHeaderLoading` (and through it `RunActions` and the
 * run's definition graph, which is `@dagrejs/dagre`) before the workbench
 * arrives: kept out of `App.tsx`, none of that is in the first paint. The
 * fallback `App.tsx` shows for this chunk is the exact markup
 * `RunHeaderLoading` prints while a read is pending, so the chunk arriving
 * replaces one line with the same line.
 */
import { Suspense, lazy } from "react";
import { useParams } from "react-router";
import { RunHeaderLoading } from "../components/workbench/RunHeader";
import { useRun } from "../api/runs";

const loadRunWorkbench = () => import("./RunWorkbench");
const RunWorkbench = lazy(loadRunWorkbench);
// gh-69: fetch the workbench chunk the moment this chunk arrives, in parallel
// with the run read. The old code issued the import only after the read
// resolved (the pending gate above the Suspense boundary stacked a chunk
// waterfall on a data waterfall: three loading lines before the workbench).
void loadRunWorkbench();

export default function RunDeepLink() {
  const { runId = "" } = useParams();
  const run = useRun(runId);
  if (run.isPending || !run.data) {
    return (
      <RunHeaderLoading
        runError={run.error}
        nodesError={null}
        pending={run.isPending}
        runId={runId}
      />
    );
  }
  return (
    <Suspense
      fallback={<RunHeaderLoading runError={null} nodesError={null} pending runId={runId} />}
    >
      <RunWorkbench projectId={run.data.project_id} />
    </Suspense>
  );
}
