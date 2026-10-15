/**
 * The M4 preview in LIVE mode — the same building blocks, fed by the frozen
 * M4 routes instead of fixtures.
 *
 * The seam: every value below travels `route → generated wire type →
 * api/m4view.ts → the component's view-model props`. Fixture mode never
 * imports this file's data flow; live mode never imports a fixture. The page
 * says which mode it is in its own bar, for the same reason the fixture page
 * does: a screenshot must not be able to claim the other mode's truth.
 *
 * Honesty: live mode is proven here against test fakes (fetch + EventSource),
 * not against a running control plane — the Go server does not serve these
 * routes yet. When it does, the W-legs drive `/__m4-preview?source=live` in a
 * browser with no UI change.
 */
import { useMemo, useState } from "react";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import { Alert } from "../components/ds/Alert";
import { Panel } from "../components/ds/Panel";
import { M4SourceProvider } from "../components/m4/source";
import { ApprovalCard } from "../components/m4/ApprovalCard";
import { AttemptDetail } from "../components/m4/AttemptDetail";
import { DefinitionGraph } from "../components/m4/DefinitionGraph";
import { PipelineLibrary, type PipelineLibraryRow } from "../components/m4/PipelineLibrary";
import { RunStageStrip } from "../components/m4/RunStageStrip";
import { RunTree } from "../components/m4/RunTree";
import { YamlView } from "../components/m4/YamlView";
import { problemOf } from "../api/client";
import {
  pipelineDraftsQueryOptions,
  pipelineQueryOptions,
  useAssignments,
  usePipelines,
  useRevision,
} from "../api/pipelines";
import {
  adoptApprovalConflict,
  approvalConflictOf,
  useDecideApproval,
  useProjectApprovals,
} from "../api/approvals";
import { useRun, useRunNode, useRunNodes, useRunTree } from "../api/runs";
import { useRunEvents } from "../api/runEvents";
import { useMe, useProject } from "../api/queries";
import {
  viewApproval,
  viewDraftSummary,
  viewNodeExecution,
  viewAttempt,
  viewPipeline,
  viewPipelineSummary,
  viewRun,
  viewRunCheckpoint,
  viewRunTree,
} from "../api/m4view";
import { projectRun, toRunEvent } from "../lib/pipeline/runEvents";
import type { DefinitionDocument } from "../lib/pipeline/definition";
import { shortDigest } from "../lib/pipeline/yamlPointer";

export interface M4LivePreviewProps {
  projectId: string;
  runId: string | null;
}

export function M4LivePreview({ projectId, runId }: M4LivePreviewProps) {
  return (
    <M4SourceProvider mode="live">
      <div className="mx-auto max-w-[80rem] space-y-4 px-4 py-6" data-testid="m4-preview-live">
        <header className="space-y-2">
          <h1 className="text-[19px] font-bold">M4 building blocks — live routes</h1>
          <Alert state="info" label="LIVE, FROM /api/v1" barTone="pale" testid="m4-live-notice">
            Every value below is a response from the frozen M4 routes (OpenAPI 0.4.0-m4) and, when a
            run is open, frames from <code className="font-mono">/runs/{"{runId}"}/events</code>. No
            fixture shapes this page; if the control plane is not serving a route, the block that
            needs it says so instead of pretending.
          </Alert>
        </header>
        <LivePipelineLibrary />
        <LiveRevision projectId={projectId} />
        {runId ? <LiveRunInspector projectId={projectId} runId={runId} /> : null}
        {projectId ? <LiveGates projectId={projectId} runId={runId} /> : null}
      </div>
    </M4SourceProvider>
  );
}

/* ------------------------------------------------------------- library */

function LivePipelineLibrary() {
  const pipelines = usePipelines();
  const ids = useMemo(
    () => (pipelines.data?.pipelines ?? []).map((pipeline) => pipeline.id),
    [pipelines.data],
  );
  // Each library row wants its definition (revision summaries) and its drafts;
  // the list route carries neither, so one `useQueries` fan per pipeline —
  // keyed exactly like the single-read hooks, so SSE invalidation covers both.
  const definitions = useQueries({ queries: ids.map(pipelineQueryOptions) });
  const draftsList = useQueries({ queries: ids.map(pipelineDraftsQueryOptions) });
  const rows: PipelineLibraryRow[] = [];
  definitions.forEach((entry, index) => {
    const definition = entry.data;
    const drafts = draftsList[index]?.data;
    if (!definition) return;
    const view = viewPipeline(definition);
    rows.push({
      pipeline: { ...viewPipelineSummary(definition), description: definition.description },
      latest: view.revisions[0] ?? null,
      revisions: view.revisions,
      drafts: (drafts?.drafts ?? []).map(viewDraftSummary),
      // `channels` is M6 rollout vocabulary; the M4 wire serves none, so the
      // row renders the honest absence.
      channels: [],
    });
  });

  const emptyCopy = pipelines.isError
    ? problemCopy(pipelines.error)
    : ids.length === 0
      ? "reading the organization's pipeline library from the control plane…"
      : `reading definitions and drafts for ${ids.length} pipeline${ids.length === 1 ? "" : "s"}…`;

  return (
    <PipelineLibrary
      rows={rows}
      canCreate={false}
      emptyCopy={emptyCopy}
      headingId="live-pipeline-library-heading"
    />
  );
}

/* ------------------------------------------------------ pinned revision */

function LiveRevision({ projectId }: { projectId: string }) {
  const assignments = useAssignments(projectId);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const pin =
    assignments.data?.assignments.find((assignment) => assignment.enabled)?.pinned_revision_id ??
    "";
  const revision = useRevision(pin);

  if (!projectId) return null;
  if (assignments.isError)
    return <ProblemAlert error={assignments.error} testid="m4-live-assignments-error" />;
  if (!assignments.isPending && !pin)
    return (
      <p className="font-mono text-[11.5px] text-muted" data-testid="m4-live-revision-none">
        no pipeline is assigned to this project — there is no pinned revision to draw, and this
        block invents none.
      </p>
    );
  if (revision.isError)
    return <ProblemAlert error={revision.error} testid="m4-live-revision-error" />;
  const record = revision.data;
  if (!record) return null;
  const document = record.canonical_document as unknown as DefinitionDocument;
  return (
    <>
      <YamlView
        text={record.document_text}
        label={`${record.revision_number} · ${record.version_label} · ${shortDigest(record.revision_digest)} · regenerated canonical`}
        highlightPointer={pointerForSelectedNode(document, selectedKey)}
        headingId="live-yaml-view-heading"
      />
      <DefinitionGraph
        document={document}
        label={`pinned r${record.revision_number} · revision states from this record`}
        selectedKey={selectedKey}
        onSelectKey={setSelectedKey}
        headingId="live-definition-graph-heading"
      />
    </>
  );
}

/* ---------------------------------------------------------- run screen */

function LiveRunInspector({ projectId, runId }: { projectId: string; runId: string }) {
  const runQuery = useRun(runId);
  const nodesQuery = useRunNodes(runId);
  const treeQuery = useRunTree(runId);
  const pipelines = usePipelines();
  const stream = useRunEvents(runId, projectId);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [stageNode, setStageNode] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string[]>([]);

  const baseNodes = useMemo(
    () => (nodesQuery.data?.node_executions ?? []).map(viewNodeExecution),
    [nodesQuery.data],
  );
  const baseRun = useMemo(() => (runQuery.data ? viewRun(runQuery.data) : null), [runQuery.data]);
  // The frames paint first; the invalidated reads confirm after (ADR-0014).
  const projection = useMemo(
    () => projectRun({ run: baseRun, nodes: baseNodes }, stream.events),
    [baseRun, baseNodes, stream.events],
  );
  const slugsById = useMemo(
    () => new Map((pipelines.data?.pipelines ?? []).map((p) => [p.id, p.slug])),
    [pipelines.data],
  );
  const tree = useMemo(
    () => (treeQuery.data ? viewRunTree(treeQuery.data, (id) => slugsById.get(id) ?? id) : null),
    [treeQuery.data, slugsById],
  );

  const selectedNode = projection.nodes.find((node) => node.node_instance_key === selectedKey);
  const detail = useRunNode(runId, selectedNode?.id ?? "");
  const attemptViews = useMemo(() => (detail.data?.attempts ?? []).map(viewAttempt), [detail.data]);
  const lastAttempt = attemptViews.at(-1) ?? null;
  const attemptEvents = useMemo(
    () =>
      lastAttempt
        ? stream.events
            .map(toRunEvent)
            .filter(
              (event): event is NonNullable<typeof event> => event?.attempt_id === lastAttempt.id,
            )
        : [],
    [stream.events, lastAttempt],
  );

  const toggle = (key: string) =>
    setExpanded((current) =>
      current.includes(key) ? current.filter((item) => item !== key) : [...current, key],
    );

  if (runQuery.isError) return <ProblemAlert error={runQuery.error} testid="m4-live-run-error" />;
  if (nodesQuery.isError)
    return <ProblemAlert error={nodesQuery.error} testid="m4-live-nodes-error" />;

  return (
    <Panel
      title="RUN INSPECTOR — LIVE"
      headingId="live-run-inspector-heading"
      headingLevel={2}
      meta={
        <span className="font-mono text-[10.5px]" data-testid="m4-live-stream-status">
          {stream.status}
        </span>
      }
    >
      <div className="space-y-[10px] p-[10px]">
        <p className="font-mono text-[11px] text-muted" data-testid="m4-live-run-identity">
          run {projection.run?.id ?? runId} · pinned{" "}
          {projection.run ? shortDigest(projection.run.revision_digest) : "—"} · status{" "}
          {projection.run?.status ?? "unknown"} · {stream.events.length} event frames folded
        </p>
        <RunStageStrip
          nodes={projection.nodes}
          selectedNodeId={stageNode}
          onSelectNode={setStageNode}
          headingId="live-stage-strip-heading"
        />
        <div className="grid gap-[10px] xl:grid-cols-[26rem_minmax(0,1fr)]">
          <RunTree
            nodes={projection.nodes}
            tree={tree}
            expandedKeys={expanded}
            onToggle={toggle}
            selectedKey={selectedKey}
            onSelect={setSelectedKey}
            runPath={(child) => `/__m4-preview?source=live&project=${projectId}&run=${child}`}
            headingId="live-run-tree-heading"
          />
          <div className="space-y-[10px]">
            {selectedNode && !lastAttempt ? (
              <p className="font-mono text-[11px] text-muted" data-testid="m4-live-attempt-pending">
                reading attempts for{" "}
                <code className="font-mono">{selectedNode.node_instance_key}</code>…
              </p>
            ) : null}
            {lastAttempt ? (
              <AttemptDetail
                attempt={lastAttempt}
                node={selectedNode ?? null}
                checkpoint={
                  detail.data?.checkpoint ? viewRunCheckpoint(detail.data.checkpoint) : null
                }
                events={attemptEvents}
                headingId="live-attempt-heading"
              />
            ) : null}
          </div>
        </div>
      </div>
    </Panel>
  );
}

/* ----------------------------------------------------------- the gates */

function LiveGates({ projectId, runId }: { projectId: string; runId: string | null }) {
  const approvalsQuery = useProjectApprovals(projectId);
  const decide = useDecideApproval(projectId);
  const queryClient = useQueryClient();
  const me = useMe();
  const project = useProject(projectId);
  const [conflict, setConflict] = useState<string | null>(null);

  const approvals = useMemo(() => {
    const rows = (approvalsQuery.data?.approvals ?? []).map(viewApproval);
    return runId ? rows.filter((row) => row.run_id === runId) : rows;
  }, [approvalsQuery.data, runId]);

  if (approvalsQuery.isError)
    return <ProblemAlert error={approvalsQuery.error} testid="m4-live-approvals-error" />;

  return (
    <Panel title="GATES — LIVE" headingId="live-gates-heading" headingLevel={2}>
      <div className="space-y-[10px] p-[10px]">
        {approvals.length === 0 ? (
          <p className="font-mono text-[11.5px] text-muted" data-testid="m4-live-gates-none">
            {approvalsQuery.isPending
              ? "reading the project's gates…"
              : "no open gate on this run — the list is the server's, not a guess."}
          </p>
        ) : (
          approvals.map((approval) => (
            <ApprovalCard
              key={approval.id}
              approval={approval}
              canDecide={canDecide(
                approval.approver_roles,
                approval.approver_user_ids,
                me.data,
                project.data?.my_role,
              )}
              pending={decide.isPending}
              conflictError={conflict}
              onDecide={({ approvalId, decision, comments, version }) =>
                decide.mutate(
                  {
                    approvalId,
                    body: {
                      decision,
                      version,
                      ...(comments ? { comments } : {}),
                    },
                  },
                  {
                    onSuccess: () => setConflict(null),
                    onError: (error) => {
                      if (approvalConflictOf(error)) {
                        // `12` case 9d: the loser adopts the winner by re-reading.
                        adoptApprovalConflict(queryClient, error);
                        setConflict(
                          "someone decided this gate first — the decision you see now is the winner's",
                        );
                      } else {
                        setConflict(problemCopy(error));
                      }
                    },
                  },
                )
              }
              headingId={`live-approval-heading-${approval.id}`}
            />
          ))
        )}
      </div>
    </Panel>
  );
}

/**
 * The server-told answer the card documents: the gate's approver arrays plus
 * the caller's own identity (`useMe` + the project's `my_role`), never a role
 * name guessed from a display.
 */
function canDecide(
  approverRoles: string[],
  approverUserIds: string[],
  me: { id: string } | undefined,
  myRole: string | null | undefined,
): boolean {
  if (!me) return false;
  if (approverUserIds.includes(me.id)) return true;
  return myRole !== null && myRole !== undefined && approverRoles.includes(myRole);
}

function ProblemAlert({ error, testid }: { error: unknown; testid: string }) {
  const problem = problemOf(error);
  return (
    <Alert state="failed" label={`HTTP ${problem.status}`} barTone="pale" testid={testid}>
      {problem.title}
      {problem.detail ? ` — ${problem.detail}` : ""}
    </Alert>
  );
}

function problemCopy(error: unknown): string {
  const problem = problemOf(error);
  return `${problem.title}${problem.detail ? `: ${problem.detail}` : ""}`;
}

/** The graph's selection highlights the node's own block in the YAML view. */
function pointerForSelectedNode(document: DefinitionDocument, key: string | null): string | null {
  if (!key) return null;
  const parts = key.split("/").filter(Boolean);
  const nodes = document.spec?.nodes ?? [];
  if (parts.length === 1) {
    const index = nodes.findIndex((node) => node.id === parts[0]);
    return index >= 0 ? `/spec/nodes/${index}` : null;
  }
  const [scopeId, bodyId] = parts;
  const scopeIndex = nodes.findIndex((node) => node.id === scopeId);
  if (scopeIndex < 0) return null;
  const body = (nodes[scopeIndex].config?.body as { nodes?: { id: string }[] } | undefined)?.nodes;
  if (!Array.isArray(body)) return null;
  const bodyIndex = body.findIndex((node) => node.id === bodyId);
  return bodyIndex >= 0 ? `/spec/nodes/${scopeIndex}/config/body/nodes/${bodyIndex}` : null;
}
