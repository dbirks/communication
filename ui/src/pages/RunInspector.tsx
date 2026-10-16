/**
 * `/projects/:projectId/runs/:runId` — the run inspector as a real route, laid
 * out like the design's run view (references 3b/3d/4a): runs column on the
 * left, header + Definition | Execution | Timeline panes in the middle, the
 * selected node's detail on the right.
 *
 * Everything here is live: the same hooks the `/__m4-preview?source=live`
 * seam proved (`api/runs.ts`, `api/pipelines.ts`, `api/approvals.ts`,
 * `api/runEvents.ts`) mapped through `api/m4view.ts` onto the components in
 * `components/m4/`. Node selection lives in `?node=<nodeExecutionId>` so a
 * pane is linkable from anywhere — including the § 7 W-legs.
 *
 * Honesty: an unreadable run answers 404 and renders a 404, never an empty
 * inspector; frames from the event stream paint but the reads confirm them;
 * Pause/Resume/Cancel are requests with receipts, so the button reflects the
 * run the server last reported, not the one just asked for.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useSearchParams } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { Alert } from "../components/ds/Alert";
import { Button } from "../components/ds/Button";
import { ApprovalCard } from "../components/m4/ApprovalCard";
import { ProblemBanner, Spinner } from "../components/Feedback";
import { AttemptDetail } from "../components/m4/AttemptDetail";
import { DefinitionGraph } from "../components/m4/DefinitionGraph";
import { RunStageStrip } from "../components/m4/RunStageStrip";
import { RunTree } from "../components/m4/RunTree";
import { usePipelines, useRevision } from "../api/pipelines";
import {
  adoptApprovalConflict,
  approvalConflictOf,
  useDecideApproval,
  useProjectApprovals,
} from "../api/approvals";
import {
  runConflictOf,
  useCancelRun,
  usePauseRun,
  useResumeRun,
  useRun,
  useRunNode,
  useRunNodes,
  useRunTree,
} from "../api/runs";
import { useRunEvents } from "../api/runEvents";
import { problemOf } from "../api/client";
import { useMe, useProject } from "../api/queries";
import {
  viewApproval,
  viewAttempt,
  viewNodeExecution,
  viewRun,
  viewRunCheckpoint,
  viewRunTree,
} from "../api/m4view";
import { projectRun, toRunEvent } from "../lib/pipeline/runEvents";
import {
  isScopeKind,
  scopeBody,
  type DefinitionDocument,
  type DefinitionNode,
} from "../lib/pipeline/definition";
import type {
  NodeExecutionStatus,
  NodeExecutionSummary,
  RunTreeRoot,
} from "../lib/pipeline/contract";
import type { EventEnvelope } from "../api/types";
import {
  ProjectSectionNav,
  RunStatusChip,
  RunsListColumn,
  shortDigest,
  shortId,
} from "./ProjectRuns";

type Tab = "definition" | "execution" | "timeline";
const TABS: readonly { id: Tab; label: string }[] = [
  { id: "definition", label: "Definition" },
  { id: "execution", label: "Execution" },
  { id: "timeline", label: "Timeline" },
];

export default function RunInspector() {
  const { projectId = "", runId = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const tab = readTab(params.get("tab"));
  const selectedNodeId = params.get("node");
  // The run view owns the whole viewport: the shell's centred reading column is
  // about 64rem wide, and a graph squeezed into what is left of it shows one
  // node. So this page measures the column it was handed and bleeds out of it.
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [bleed, setBleed] = useState<{ left: number; width: number } | null>(null);
  const [navOpen, setNavOpen] = useState(true);
  /** Measure from the parent, never from the element itself: the parent's
   * content-box left is the child's static position and does not move when the
   * child's own negative margin does. */
  const measureBleed = useCallback(() => {
    const el = rootRef.current;
    const parent = el?.parentElement;
    if (!el || !parent) return;
    const style = window.getComputedStyle(parent);
    const left = parent.getBoundingClientRect().left + parseFloat(style.paddingLeft || "0");
    const width = document.documentElement.clientWidth || window.innerWidth || el.offsetWidth;
    // Equal values do not re-render: this runs from a ref callback, and a new
    // object every time would be a render loop with a measurement in it.
    setBleed((current) =>
      current && current.left === left && current.width === width ? current : { left, width },
    );
  }, []);
  // A ref callback rather than an effect: the page is a loading skeleton for its
  // first paint, and an effect that ran once would have measured nothing and
  // never come back. It stays stable across renders for the same reason — a new
  // callback identity every render would re-attach the ref on every commit.
  const attachRoot = useCallback(
    (node: HTMLDivElement | null) => {
      rootRef.current = node;
      if (node) measureBleed();
    },
    [measureBleed],
  );
  useEffect(() => {
    window.addEventListener("resize", measureBleed);
    return () => window.removeEventListener("resize", measureBleed);
  }, [measureBleed]);

  const runQuery = useRun(runId);
  const nodesQuery = useRunNodes(runId);
  const treeQuery = useRunTree(runId);
  const pipelines = usePipelines();
  const stream = useRunEvents(runId, projectId);

  const baseRun = useMemo(() => (runQuery.data ? viewRun(runQuery.data) : null), [runQuery.data]);
  const baseNodes = useMemo(
    () => (nodesQuery.data?.node_executions ?? []).map(viewNodeExecution),
    [nodesQuery.data],
  );
  // Frames paint first; the invalidated reads confirm (ADR-0014).
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

  const selectedNode =
    projection.nodes.find((node) => node.id === selectedNodeId) ??
    projection.nodes.find((node) => node.id === attentionNodeId(projection.nodes)) ??
    null;
  /** The graph keys a node by its instance key without iteration suffixes, the
   * tree keys a row by the full instance key; the URL carries the execution id
   * and both handles are derived from it. */
  const graphKey = selectedNode ? graphKeyOf(selectedNode.node_instance_key) : null;
  const instanceKey = selectedNode?.node_instance_key ?? null;

  const selectNodeById = (id: string | null) =>
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        if (id) next.set("node", id);
        else next.delete("node");
        return next;
      },
      { replace: true },
    );
  /** The three panes select by different handles — the graph and the tree by
   * instance key, the strip by definition node id — and the URL carries one
   * thing: the node execution id. */
  const selectNode = (handle: string | null) => {
    if (!handle) return selectNodeById(null);
    const exact = projection.nodes.find(
      (node) => node.id === handle || node.node_instance_key === handle,
    );
    const byGraph = projection.nodes.find(
      (node) => graphKeyOf(node.node_instance_key) === graphKeyOf(handle),
    );
    const byNodeId = projection.nodes.find(
      (node) => node.node_id === handle || node.node_instance_key === `/${handle}`,
    );
    selectNodeById((exact ?? byGraph ?? byNodeId)?.id ?? null);
  };
  const setTab = (next: Tab) =>
    setParams(
      (current) => {
        const withTab = new URLSearchParams(current);
        withTab.set("tab", next);
        return withTab;
      },
      { replace: true },
    );

  /* ---------------------------------------------------------- error states */

  if (runQuery.isError) {
    const problem = problemOf(runQuery.error);
    if (problem.status === 404) {
      return (
        <div className="px-4 py-6" data-testid="run-not-found">
          <Alert state="info" label="NOT FOUND" barTone="neutral" role="status">
            Run <code className="font-mono">{runId}</code> is not visible to you, or does not exist.
            The control plane answered 404 — this page shows no scaffold for a run it cannot see.
          </Alert>
        </div>
      );
    }
    return (
      <div className="px-4 py-6">
        <ProblemBanner error={runQuery.error} fallback="This run could not be loaded." />
      </div>
    );
  }
  if (nodesQuery.isError) {
    return (
      <div className="px-4 py-6">
        <ProblemBanner error={nodesQuery.error} fallback="Node executions could not be loaded." />
      </div>
    );
  }
  if (runQuery.isPending || !projection.run) {
    return (
      <div className="px-4 py-6">
        <Spinner label="Loading run" />
      </div>
    );
  }

  const run = projection.run;
  const slug = slugsById.get(run.pipeline_id) ?? run.pipeline_id;
  // Runs column on the left (collapsible), the panes flexible in the middle —
  // never less than about 60% of what is left — and the node's detail on the
  // right at the 360–420px the run view is drawn at.
  const columns = navOpen
    ? "xl:grid-cols-[minmax(13rem,15rem)_minmax(0,1fr)_minmax(22.5rem,26rem)]"
    : "xl:grid-cols-[2.25rem_minmax(0,1fr)_minmax(22.5rem,26rem)]";

  return (
    <div
      ref={attachRoot}
      data-testid="run-inspector"
      data-full-width={bleed ? bleed.width : "unmeasured"}
      className={`grid min-h-full grid-cols-1 ${columns} border-y border-line bg-paper`}
      style={
        bleed
          ? { width: bleed.width || undefined, marginLeft: -bleed.left, maxWidth: "none" }
          : { maxWidth: "none" }
      }
    >
      <aside
        className="min-w-0 border-b border-line xl:border-b-0 xl:border-r"
        data-testid="run-inspector-nav"
      >
        {navOpen ? (
          <>
            <div className="border-b border-line px-3 py-2">
              <ProjectSectionNav projectId={projectId} active="runs" />
            </div>
            <RunsListColumn projectId={projectId} selectedRunId={runId} />
          </>
        ) : (
          <div className="flex justify-center border-b border-line py-2">
            <button
              type="button"
              data-testid="run-nav-expand"
              aria-label="Show the runs list"
              onClick={() => setNavOpen(true)}
              className="grid h-[22px] w-[22px] place-items-center rounded-[2px] border border-line bg-surface font-mono text-[11px] text-muted hover:border-line-strong hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
            >
              {"\u203a"}
            </button>
          </div>
        )}
      </aside>

      <main className="min-w-0 px-4 py-3">
        <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line pb-3">
          <div className="min-w-0 flex-1">
            <p className="truncate font-mono text-[11px] text-muted">
              {slug} · pinned {shortDigest(run.revision_digest)} · {stream.events.length} frames
              folded
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-[19px] font-bold" data-testid="run-title">
                Run #{shortId(run.id)}
              </h1>
              <RunStatusChip status={run.status} testid="run-header-status" />
              {!run.placement.scheduled &&
              run.placement.reason === "volume_affinity_unsatisfied" ? (
                <span className="text-[11.5px] text-muted" data-testid="run-waiting-for-worker">
                  waiting for its worker
                </span>
              ) : null}
              <span className="font-mono text-[11px] text-faint" data-testid="run-stream-status">
                {stream.status}
              </span>
            </div>
          </div>
          <RunActions runId={runId} status={run.status} />
        </header>

        <div className="flex gap-1 py-3" role="tablist" aria-label="Run views">
          {TABS.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={tab === item.id}
              data-testid={`run-tab-${item.id}`}
              onClick={() => setTab(item.id)}
              className={`rounded-[3px] border px-3 py-[5px] text-[12.5px] font-semibold ${
                tab === item.id
                  ? "border-ink bg-ink text-paper"
                  : "border-line text-muted hover:border-line-strong hover:text-ink"
              }`}
            >
              {item.label}
            </button>
          ))}
          {navOpen ? (
            <button
              type="button"
              data-testid="run-nav-collapse"
              aria-label="Hide the runs list"
              onClick={() => setNavOpen(false)}
              className="ml-auto self-center rounded-[3px] border border-line px-2 py-[3px] font-mono text-[10.5px] text-muted hover:border-line-strong hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
            >
              runs {"\u2039"}
            </button>
          ) : null}
        </div>

        {tab === "definition" ? (
          <RunDefinitionTab
            digest={run.revision_digest}
            nodes={projection.nodes}
            selectedKey={graphKey}
            onSelectKey={selectNode}
          />
        ) : null}
        {tab === "execution" ? (
          <RunExecutionTab
            projectId={projectId}
            digest={run.revision_digest}
            nodes={projection.nodes}
            tree={tree}
            selectedNodeId={selectedNode?.node_id ?? null}
            selectedKey={instanceKey}
            onSelect={selectNode}
          />
        ) : null}
        {tab === "timeline" ? <RunTimelineTab runId={runId} events={stream.events} /> : null}
      </main>

      <aside
        className="min-w-0 border-t border-line bg-surface px-3 py-3 xl:border-l xl:border-t-0"
        data-testid="run-inspector-detail"
      >
        <RunNodeDetail
          runId={runId}
          projectId={projectId}
          node={selectedNode}
          frames={stream.events}
        />
      </aside>
    </div>
  );
}

/* ------------------------------------------------------------- actions */

function RunActions({ runId, status }: { runId: string; status: string }) {
  const pause = usePauseRun(runId);
  const resume = useResumeRun(runId);
  const cancel = useCancelRun(runId);
  const [conflict, setConflict] = useState<string | null>(null);
  const terminal = ["completed", "failed", "cancelled"].includes(status);
  const report = (error: unknown) => {
    const clash = runConflictOf(error);
    setConflict(clash ? `refused — the run is ${clash.run_status}` : problemOf(error).title);
  };
  const pauseRun = () =>
    pause.mutate(undefined, { onSuccess: () => setConflict(""), onError: report });
  const resumeRun = () =>
    resume.mutate(undefined, { onSuccess: () => setConflict(""), onError: report });
  const cancelRun = () =>
    cancel.mutate(undefined, { onSuccess: () => setConflict(""), onError: report });

  return (
    <div className="flex items-center gap-2">
      {status === "paused" ? (
        <Button
          variant="primary"
          disabled={resume.isPending}
          data-testid="run-resume"
          onClick={resumeRun}
        >
          Resume
        </Button>
      ) : (
        <Button
          variant="secondary"
          disabled={terminal || pause.isPending}
          title="In-flight attempts finish honestly — this is a request, not a stop"
          data-testid="run-pause"
          onClick={pauseRun}
        >
          Pause
        </Button>
      )}
      <Button
        variant="danger"
        disabled={terminal || cancel.isPending}
        data-testid="run-cancel"
        onClick={cancelRun}
      >
        Cancel
      </Button>
      {conflict ? (
        <p className="w-full font-mono text-[11px] text-failed" data-testid="run-action-error">
          {conflict}
        </p>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------- definition tab */

function RunDefinitionTab({
  digest,
  nodes,
  selectedKey,
  onSelectKey,
}: {
  digest: string;
  nodes: NodeExecutionSummary[];
  selectedKey: string | null;
  onSelectKey: (key: string | null) => void;
}) {
  const revision = useRevision(digest);
  if (revision.isError) {
    return (
      <ProblemBanner
        error={revision.error}
        fallback={`The pinned revision ${shortDigest(digest)} could not be read.`}
      />
    );
  }
  const record = revision.data;
  if (!record) {
    return (
      <p className="font-mono text-[11px] text-muted" data-testid="run-definition-pending">
        Reading the pinned revision {shortDigest(digest)} — the run stays on this digest whatever
        the library publishes next.
      </p>
    );
  }
  const document = record.canonical_document as unknown as DefinitionDocument;
  const statuses: Record<string, NodeExecutionStatus> = {};
  for (const node of nodes) statuses[graphKeyOf(node.node_instance_key)] = node.status;
  return (
    <DefinitionGraph
      document={document}
      label={`pinned r${record.revision_number} · ${shortDigest(record.revision_digest)} · states from this run`}
      statuses={statuses}
      selectedKey={selectedKey}
      onSelectKey={onSelectKey}
      headingId="run-definition-heading"
    />
  );
}

/* -------------------------------------------------------- execution tab */

function RunExecutionTab({
  projectId,
  digest,
  nodes,
  tree,
  selectedNodeId,
  selectedKey,
  onSelect,
}: {
  projectId: string;
  digest: string;
  nodes: NodeExecutionSummary[];
  tree: RunTreeRoot | null;
  /** The selected node execution's definition id — the strip and the tree
   * select by it, and the URL still carries the execution id. */
  selectedNodeId: string | null;
  selectedKey: string | null;
  onSelect: (handle: string | null) => void;
}) {
  const [expanded, setExpanded] = useState<string[]>([]);
  // The strip and the tree read against the pinned graph, not against the order
  // the API sorted the rows into. Same cached read as the Definition tab; the
  // strip degrades to the caller's order until it lands.
  const revision = useRevision(digest);
  const definitionOrder = useMemo(
    () =>
      revision.data
        ? definitionOrderOf(revision.data.canonical_document as unknown as DefinitionDocument)
        : undefined,
    [revision.data],
  );
  return (
    <div className="space-y-[10px]">
      <RunStageStrip
        nodes={nodes}
        definitionOrder={definitionOrder}
        selectedNodeId={selectedNodeId}
        onSelectNode={onSelect}
        headingId="run-stage-strip-heading"
      />
      <RunTree
        nodes={nodes}
        definitionOrder={definitionOrder}
        tree={tree}
        expandedKeys={expanded}
        onToggle={(key) =>
          setExpanded((current) =>
            current.includes(key) ? current.filter((item) => item !== key) : [...current, key],
          )
        }
        selectedKey={selectedKey}
        onSelect={onSelect}
        runPath={(child) => `/projects/${projectId}/runs/${child}`}
        headingId="run-tree-heading"
      />
    </div>
  );
}

/* ---------------------------------------------------------- timeline tab */

function RunTimelineTab({ runId, events }: { runId: string; events: readonly EventEnvelope[] }) {
  const frames = useMemo(
    () =>
      events
        .map(toRunEvent)
        .filter((event): event is NonNullable<typeof event> => event !== null)
        .sort((a, b) => a.global_seq - b.global_seq),
    [events],
  );
  if (frames.length === 0) {
    return (
      <p className="font-mono text-[11px] text-muted" data-testid="run-timeline-empty">
        No run events yet on the stream for {runId} — this list is the journal, not a guess.
      </p>
    );
  }
  return (
    <ol className="space-y-[2px]" data-testid="run-timeline">
      {frames.map((event) => (
        <li
          key={`${event.global_seq}`}
          className="flex flex-wrap items-baseline gap-2 border-b border-line px-1 py-[5px] font-mono text-[11.5px]"
          data-testid={`run-timeline-row-${event.global_seq}`}
        >
          <span className="text-faint">{event.occurred_at.slice(11, 19)}</span>
          <span className="font-semibold">{event.type}</span>
          {event.payload?.node_instance_key ? (
            <code className="text-muted">{event.payload.node_instance_key}</code>
          ) : null}
          {(event.payload?.detail ?? event.payload?.reason) ? (
            <span className="text-muted">{event.payload.detail ?? event.payload.reason}</span>
          ) : null}
        </li>
      ))}
    </ol>
  );
}

/* --------------------------------------------------- right pane: the node */

function RunNodeDetail({
  runId,
  projectId,
  node,
  frames,
}: {
  runId: string;
  projectId: string;
  node: NodeExecutionSummary | null;
  frames: readonly EventEnvelope[];
}) {
  const nodeId = node?.id ?? null;
  const detail = useRunNode(runId, nodeId ?? "");
  const approvalsQuery = useProjectApprovals(projectId);
  const decide = useDecideApproval(projectId);
  const queryClient = useQueryClient();
  const me = useMe();
  const project = useProject(projectId);
  const [conflict, setConflict] = useState<string | null>(null);

  const attemptViews = useMemo(() => (detail.data?.attempts ?? []).map(viewAttempt), [detail.data]);
  const lastAttempt = attemptViews.at(-1) ?? null;
  const attemptEvents = useMemo(
    () =>
      lastAttempt
        ? frames
            .map(toRunEvent)
            .filter(
              (event): event is NonNullable<typeof event> =>
                event !== null && event.attempt_id === lastAttempt.id,
            )
        : [],
    [frames, lastAttempt],
  );
  const gate = (approvalsQuery.data?.approvals ?? [])
    .map(viewApproval)
    .find((approval) => approval.node_execution_id === nodeId);

  if (!node || !nodeId) {
    return (
      <p className="font-mono text-[11px] text-muted" data-testid="run-detail-none">
        Select a node — in the definition graph, a stage cell or the execution tree — to read its
        attempts, artifacts and gates here.
      </p>
    );
  }
  if (detail.isError) {
    return <ProblemBanner error={detail.error} fallback="This node execution could not be read." />;
  }
  if (detail.isPending || !lastAttempt) {
    return (
      <p className="font-mono text-[11px] text-muted" data-testid="run-detail-pending">
        Reading attempts for <code className="font-mono">{node.node_instance_key}</code>…
      </p>
    );
  }
  return (
    <div className="space-y-[10px]">
      <AttemptDetail
        attempt={lastAttempt}
        node={node}
        checkpoint={detail.data?.checkpoint ? viewRunCheckpoint(detail.data.checkpoint) : null}
        events={attemptEvents}
        headingId="run-attempt-heading"
      />
      {gate ? (
        <ApprovalCard
          approval={gate}
          canDecide={canDecide(
            gate.approver_roles,
            gate.approver_user_ids,
            me.data,
            project.data?.my_role,
          )}
          pending={decide.isPending}
          conflictError={conflict}
          onDecide={({ approvalId, decision, comments, version }) =>
            decide.mutate(
              { approvalId, body: { decision, version, ...(comments ? { comments } : {}) } },
              {
                onSuccess: () => setConflict(null),
                onError: (error) => {
                  if (approvalConflictOf(error)) {
                    adoptApprovalConflict(queryClient, error);
                    setConflict(
                      "someone decided this gate first — what you see now is the winner's",
                    );
                  } else {
                    setConflict(problemOf(error).title);
                  }
                },
              },
            )
          }
          headingId={`run-approval-heading-${gate.id}`}
        />
      ) : null}
    </div>
  );
}

/** The server-told answer: the gate's approver arrays plus the caller's own
 * identity, never a role guessed from a display. */
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

/** `/build_until_verified[2]/review` → `/build_until_verified/review`: the
 * graph's key is the instance key without its iteration suffixes. */
function graphKeyOf(key: string): string {
  return key.replaceAll(/\[\d+\]/g, "");
}

/**
 * What the run is stopped on, in the order a reader cares about: the gate a
 * human owes an answer at, then a failure, then the work in flight. A run that
 * is waiting on somebody must not open on an empty pane, so the inspector
 * pre-selects it before anyone clicks. A scope row (`until`, `for each`) is
 * skipped — it owns no attempt of its own, so its children are what the reader
 * can act on. Declaration order breaks ties, so the pick is stable.
 */
export function attentionNodeId(
  nodes: readonly Pick<NodeExecutionSummary, "id" | "kind" | "status" | "waiting_reason">[],
): string | null {
  const work = nodes.filter((node) => !isScopeKind(node.kind));
  const gate = work.find(
    (node) =>
      node.status === "waiting" &&
      (node.kind === "human.approval" || node.waiting_reason === "approval"),
  );
  if (gate) return gate.id;
  return (
    (
      work.find((node) => node.status === "failed") ??
      work.find((node) => node.status === "running")
    )?.id ?? null
  );
}

/** Definition is the tab a run opens on: the reader orients on the graph the run
 * is pinned to before they read what happened in it. */
function readTab(value: string | null): Tab {
  return value === "execution" || value === "timeline" ? value : "definition";
}

/** The revision's node ids in the order the document declares them, scopes
 * listed before the body nodes inside them — the order the graph draws. */
function definitionOrderOf(document: DefinitionDocument | null | undefined): string[] {
  if (!document?.spec?.nodes) return [];
  const walk = (nodes: DefinitionNode[]): string[] =>
    nodes.flatMap((node) => [node.id, ...walk(scopeBody(node))]);
  return walk(document.spec.nodes);
}
