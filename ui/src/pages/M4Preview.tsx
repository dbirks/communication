/**
 * The M4 building-block preview — **dev only**, mounted at `/__m4-preview`
 * behind `import.meta.env.DEV`, and never reachable from a nav.
 *
 * Every value on this page comes from `src/test/fixtures/m4/`, which is shaped
 * like `docs/m4-contract.md` § 2 (routes) and § 3 (events) — including the
 * § 9.3 sample pipeline document, byte-identical to the corrected sample the Go
 * spike validated. Nothing here talks to a server, so the page says so in its
 * own bar: a screenshot of fixtures must not read as a screenshot of a run.
 *
 * Its job is to be driven by a browser (Playwright) so each block can be
 * screenshotted and its DOM inspected while the M4 backend is still landing.
 */
import { useState } from "react";
import { Alert } from "../components/ds/Alert";
import { Panel } from "../components/ds/Panel";
import { ApprovalCard } from "../components/m4/ApprovalCard";
import { AttemptDetail } from "../components/m4/AttemptDetail";
import { DefinitionGraph } from "../components/m4/DefinitionGraph";
import { PipelineLibrary, type PipelineLibraryRow } from "../components/m4/PipelineLibrary";
import { RunStageStrip } from "../components/m4/RunStageStrip";
import { RunTree } from "../components/m4/RunTree";
import { YamlView } from "../components/m4/YamlView";
import { rollupStatuses } from "../lib/pipeline/runView";
import {
  featureDevelopmentDrafts,
  featureDevelopmentRevisions,
  libraryPipelines,
  projectAssignments,
  releasePromotionDrafts,
} from "../test/fixtures/m4/library";
import {
  fanOutNodes,
  fanOutRun,
  fanOutTree,
  featureCheckpoints,
  featureNodes,
  featureRun,
  implementAttempts,
  runEvents,
  workspaceLostAttempt,
} from "../test/fixtures/m4/runs";
import { samplePipelineDocument, samplePipelineYaml } from "../test/fixtures/m4/samplePipeline";
import { pendingApproval, rejectedApproval, notApproverView } from "../test/fixtures/m4/approvals";
import { shortDigest } from "../lib/pipeline/yamlPointer";
import { w8DraftDocument, w8DraftYaml, w8Validation } from "../test/fixtures/m4/w8Draft";

const libraryRows: PipelineLibraryRow[] = libraryPipelines.map((pipeline) => {
  const assignment = projectAssignments.find((item) => item.pipeline_id === pipeline.id);
  const isFeature = pipeline.slug === "feature-development";
  return {
    pipeline,
    latest: isFeature ? featureDevelopmentRevisions[0] : null,
    revisions: isFeature ? featureDevelopmentRevisions : [],
    drafts: isFeature
      ? featureDevelopmentDrafts
      : pipeline.slug === "release-promotion"
        ? releasePromotionDrafts
        : [],
    channels: assignment?.channels ?? [],
  };
});

export default function M4Preview() {
  const [selectedNode, setSelectedNode] = useState<string | null>(
    "/build_until_verified/implement",
  );
  const [selectedTreeKey, setSelectedTreeKey] = useState<string | null>(
    "/build_until_verified[2]/implement",
  );
  const [expanded, setExpanded] = useState<string[]>([
    "/build_until_verified",
    "/build_until_verified[2]",
    "/verify_each",
    "/verify_each[22]",
    "/verify_each[22]/invoke",
    `run:${fanOutTree.children[21].child_run_id}`,
  ]);
  const [stageNode, setStageNode] = useState<string | null>(null);

  const toggle = (key: string) =>
    setExpanded((current) =>
      current.includes(key) ? current.filter((item) => item !== key) : [...current, key],
    );

  return (
    <div className="mx-auto max-w-[80rem] space-y-4 px-4 py-6" data-testid="m4-preview">
      <header className="space-y-2">
        <h1 className="text-[19px] font-bold">M4 building blocks — fixture preview</h1>
        <Alert state="info" label="FIXTURES, NOT A RUN" barTone="pale" testid="m4-preview-notice">
          Every value below is a fixture shaped like{" "}
          <code className="font-mono">docs/m4-contract.md</code> § 2 and § 3 — the § 9.3 sample
          pipeline, W8’s validation findings, W5’s interrupted attempt and C8’s 25 child runs. No
          server was contacted to render this page, and no route under{" "}
          <code className="font-mono">/api/v1</code> is called by it.
        </Alert>
      </header>

      <PipelineLibrary rows={libraryRows} onOpen={(pipeline) => setSelectedNode(pipeline.slug)} />

      <YamlView
        text={samplePipelineYaml}
        label={`feature-development · revision 7 · ${shortDigest(featureDevelopmentRevisions[0].revision_digest)} · canonical`}
        highlightPointer={pointerForSelectedNode(selectedNode)}
      />

      <YamlView
        text={w8DraftYaml}
        label="w8-draft · an authored document with fourteen findings"
        validation={w8Validation}
      />

      <DefinitionGraph
        document={w8DraftDocument}
        label="w8-draft · eleven nodes, seven kinds M4 refuses"
        selectedKey={selectedNode}
        onSelectKey={setSelectedNode}
      />

      {/* The same document, seen from inside a run: the graph is definition and
          the marker is run state, so the two halves of M4 meet on one surface. */}
      <DefinitionGraph
        document={samplePipelineDocument}
        label="pinned revision 7 · run states from node_executions"
        statuses={rollupStatuses(featureNodes)}
        selectedKey={selectedNode}
        onSelectKey={setSelectedNode}
      />

      <Panel title="RUN INSPECTOR — LOOPING RUN" headingId="run-inspector-a" headingLevel={2}>
        <div className="space-y-[10px] p-[10px]">
          <p className="font-mono text-[11px] text-muted" data-testid="m4-preview-run-a-identity">
            run {shortDigest(featureRun.id)} · pinned {shortDigest(featureRun.revision_digest)} ·
            plan {shortDigest(featureRun.plan_digest)} · status {featureRun.status}
          </p>
          <RunStageStrip
            nodes={featureNodes}
            selectedNodeId={stageNode}
            onSelectNode={setStageNode}
          />
          <div className="grid gap-[10px] xl:grid-cols-[26rem_minmax(0,1fr)]">
            <RunTree
              nodes={featureNodes}
              expandedKeys={expanded}
              onToggle={toggle}
              selectedKey={selectedTreeKey}
              onSelect={setSelectedTreeKey}
            />
            <div className="space-y-[10px]">
              <AttemptDetail
                attempt={implementAttempts[0]}
                node={featureNodes.find(
                  (node) => node.node_instance_key === "/build_until_verified[2]/implement",
                )}
                events={runEvents.filter((event) => event.attempt_id === implementAttempts[0].id)}
              />
              <AttemptDetail
                attempt={implementAttempts[1]}
                checkpoint={featureCheckpoints[0]}
                node={featureNodes.find(
                  (node) => node.node_instance_key === "/build_until_verified[2]/implement",
                )}
              />
              <AttemptDetail attempt={workspaceLostAttempt} />
            </div>
          </div>
        </div>
      </Panel>

      <Panel
        title="RUN INSPECTOR — FAN-OUT CHILD RUNS"
        headingId="run-inspector-b"
        headingLevel={2}
      >
        <div className="space-y-[10px] p-[10px]">
          <p className="font-mono text-[11px] text-muted" data-testid="m4-preview-run-b-identity">
            run {shortDigest(fanOutRun.id)} · 25 child runs under{" "}
            <code className="font-mono">/verify_each</code> · page size 10, so the branch paginates
          </p>
          <RunStageStrip nodes={fanOutNodes} />
          <RunTree
            nodes={fanOutNodes}
            tree={fanOutTree}
            pageSize={10}
            expandedKeys={expanded}
            onToggle={toggle}
            selectedKey={selectedTreeKey}
            onSelect={setSelectedTreeKey}
            runPath={(runId) => `/__m4-preview#run=${runId}`}
          />
        </div>
      </Panel>

      <Panel title="GATES" headingId="run-inspector-gates" headingLevel={2}>
        <div className="grid gap-[10px] p-[10px] xl:grid-cols-2">
          <ApprovalCard approval={pendingApproval} canDecide />
          <ApprovalCard
            approval={{ ...pendingApproval, id: "01J8APPROVALBOB" }}
            canDecide={false}
          />
          <ApprovalCard approval={rejectedApproval} canDecide={false} />
          <ApprovalCard
            approval={rejectedApproval}
            canDecide={false}
            conflictError={notApproverView.conflictError}
          />
        </div>
      </Panel>
    </div>
  );
}

/** The graph's selection highlights the node's own block in the YAML view. */
function pointerForSelectedNode(key: string | null): string | null {
  if (!key) return null;
  // Node keys are wire-shaped (`/scope/body`), so the leading `/` is not a scope.
  const parts = key.split("/").filter(Boolean);
  if (parts.length === 1) {
    const index = samplePipelineDocument.spec.nodes.findIndex((node) => node.id === parts[0]);
    return index >= 0 ? `/spec/nodes/${index}` : null;
  }
  const [scopeId, bodyId] = parts;
  const scopeIndex = samplePipelineDocument.spec.nodes.findIndex((node) => node.id === scopeId);
  if (scopeIndex < 0) return null;
  const body =
    (samplePipelineDocument.spec.nodes[scopeIndex].config?.body as { nodes?: { id: string }[] })
      ?.nodes ?? [];
  const bodyIndex = body.findIndex((node) => node.id === bodyId);
  return bodyIndex >= 0 ? `/spec/nodes/${scopeIndex}/config/body/nodes/${bodyIndex}` : null;
}
