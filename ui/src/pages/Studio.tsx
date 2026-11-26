/**
 * Studio.tsx — the Workflow Editor page (`/factory/:pipelineId`,
 * `/p/:projectId/factory/:pipelineId`, and legacy `/workflows/:pipelineId/drafts/:draftId`).
 *
 * Full-bleed LR canvas with floating ToolIsland, top-right Versions / Try it /
 * Make live / "…" controls, debounced 800ms autosave, TopBarLeft breadcrumb &
 * draft status, Box select → WrapPanel → GoalFrame, AgentStepCard, `?run=`
 * live-run canvas overlay with VerdictStack, and synthetic Trigger node.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueries } from "@tanstack/react-query";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { IconDots, IconHistory, IconPlayerPlay, IconX } from "@tabler/icons-react";
import { parse as parseYaml } from "yaml";
import { apiFetch, ApiError, problemOf } from "../api/client";
import { useActorNames } from "../api/actors";
import { useMe, useProject, queryKeys } from "../api/queries";
import {
  useCreateDraft,
  useDeleteDraft,
  useDraft,
  usePipeline,
  usePipelineDrafts,
  usePublishDraft,
  useRevision,
  useValidateDraft,
} from "../api/pipelines";
import { useRun, useRunNodes } from "../api/runs";
import { useRunEvents } from "../api/runEvents";
import {
  viewNodeExecution,
  viewRevisionSummary,
  viewRun,
  viewValidate,
  viewDraftSummary,
} from "../api/m4view";
import type { NodeExecutionDetail, PipelineRevision } from "../api/types";
import type {
  NodeExecutionSummary,
  PipelineDraftSummary,
  PipelineRevisionSummary,
  ValidateBody,
} from "../lib/pipeline/contract";
import { hasLibraryRole, LIBRARY_READ_ONLY_NOTE } from "../lib/pipeline/authoring";
import {
  isScopeKind,
  scopeBody,
  type DefinitionDocument,
  type DefinitionNode,
} from "../lib/pipeline/definition";
import {
  addNode,
  deleteNode,
  findNode,
  parseGraph,
  unwrapScope,
  type GraphEdge,
  type GraphModel,
  type OpResult,
  type ScopePath,
} from "../lib/pipeline/graphDoc";
import { projectRun } from "../lib/pipeline/runEvents";
import { semanticDiff } from "../lib/pipeline/semanticDiff";
import { overlays } from "../lib/pipeline/workbench";
import { duplicateNode } from "../lib/pipeline/duplicateNode";
import { shortId } from "../lib/format";
import { routes } from "../lib/routes";
import { useScope } from "../lib/scope";
import { RUN_STATE, STATES, stateOf } from "../components/ds/states";
import { SoftButton } from "../components/ds/SoftButton";
import { FormError, ProblemBanner, Spinner } from "../components/Feedback";
import { ProjectUnavailable } from "../components/ProjectUnavailable";
import { TopBarLeft, TOP_BAR_LEFT_SLOT_ID } from "../components/shell/TopBarSlot";
import { StartRunDialog } from "../components/home/StartRunDialog";
import { YamlView } from "../components/workflows/YamlView";
import { UsedInPanel } from "../components/workflows/UsedIn";
import { UseInRepoDialog } from "../components/workflows/UseInRepoDialog";
import { InputsTab } from "../components/workflows/inputs/InputsTab";
import { TriggersDialog } from "../components/workflows/TriggersDialog";
import { usePipelineRuns, useUsedIn } from "./workflow/useUsedIn";
import { StudioCanvas, type UiLayout } from "../components/studio/StudioCanvas";
import { StudioInspector } from "../components/studio/StudioInspector";
import { AmbiguityDialog } from "../components/studio/AmbiguityDialog";
import { AgentStepCard } from "../components/studio/AgentStepCard";
import { VersionsPanel } from "../components/studio/VersionsPanel";
import { YamlEditPanel } from "../components/studio/YamlEditPanel";
import type { CanvasTool } from "../components/studio/ToolIsland";
import {
  AssistantProposalBox,
  PROPOSAL_CAPTION,
  type AssistantProposalPreview,
} from "../components/studio/AssistantProposalBox";
import {
  connectOp,
  canConnectOf,
  disconnectEdgeOp,
  insertOnEdgeOp,
  isAmbiguousOp,
  toJsDocument,
  uiLayoutOfText,
  useStudioDraft,
} from "../components/studio/useStudioDraft";
import { useStudioTriggers } from "../components/studio/useStudioTriggers";
import {
  readGoal,
  updateUntilGoal,
  verdictStepId,
  wrapInUntil,
  wrapSideBySide,
  type GoalSpec,
} from "../components/studio/wrap/wrapModel";
import type { VerdictRound } from "../components/studio/wrap/VerdictStack";

function useIsNarrow(query = "(max-width: 767px)"): boolean {
  const [narrow, setNarrow] = useState<boolean>(() =>
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia(query).matches
      : false,
  );
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia(query);
    const onChange = () => setNarrow(mq.matches);
    onChange();
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [query]);
  return narrow;
}

/** Whether `#top-bar-left-slot` exists in the mounted Shell; falls back to an inline bar in isolated tests. */
function useHasTopBarSlot(): boolean {
  const [hasSlot, setHasSlot] = useState<boolean>(() =>
    typeof document !== "undefined"
      ? Boolean(document.getElementById(TOP_BAR_LEFT_SLOT_ID))
      : false,
  );
  useEffect(() => {
    const sync = () =>
      setHasSlot(Boolean(document.getElementById(TOP_BAR_LEFT_SLOT_ID)?.isConnected));
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);
  return hasSlot;
}

const EMPTY_MODEL: GraphModel = { nodes: [], edges: [] };
const AUTOSAVE_DEBOUNCE_MS = 800;

function nodeConfigOf(doc: unknown, model: GraphModel, nodeId: string): Record<string, unknown> {
  const node = findNode(model, nodeId);
  if (!node || !doc || typeof doc !== "object") return {};
  let cur: unknown = doc;
  for (const part of node.pointer.split("/")) {
    if (part === "") continue;
    cur = Array.isArray(cur) ? cur[Number(part)] : (cur as Record<string, unknown> | null)?.[part];
    if (cur === null || cur === undefined) return {};
  }
  if (!cur || typeof cur !== "object" || Array.isArray(cur)) return {};
  const cfg = (cur as Record<string, unknown>).config;
  return cfg && typeof cfg === "object" && !Array.isArray(cfg)
    ? (cfg as Record<string, unknown>)
    : {};
}

function scopeIterationIndex(instanceKey: string, scopeId: string): number | null {
  const re = new RegExp(`/${scopeId}\\[(\\d+)\\]`);
  const m = re.exec(instanceKey);
  return m ? Number(m[1]) : null;
}

function parseJudgeOutput(
  outputs: unknown,
): { verdict: "met" | "not_yet"; reason?: string } | null {
  if (!outputs || typeof outputs !== "object" || Array.isArray(outputs)) return null;
  const text = (outputs as Record<string, unknown>).text;
  if (typeof text !== "string") return null;
  const lines = text.trim().split(/\r?\n/);
  const first = lines[0]?.trim() ?? "";
  const rest = lines.slice(1).join(" ").trim();
  if (first.includes("GOAL_MET")) {
    return { verdict: "met", ...(rest ? { reason: rest } : {}) };
  }
  if (first.includes("NOT_YET")) {
    return { verdict: "not_yet", ...(rest ? { reason: rest } : {}) };
  }
  return null;
}

/** Failed-draft fallback title when the draft cannot be loaded. */
function StudioFailureTitle({
  pipelineName,
  pipelineFolder,
}: {
  pipelineName: string | null;
  pipelineFolder: string | null;
}) {
  const scope = useScope();
  return (
    <header
      className="flex flex-wrap items-center gap-x-[8px] gap-y-[8px] border-b border-line bg-surface px-4 py-2 md:flex-nowrap"
      data-testid="studio-header"
    >
      <nav
        aria-label="Breadcrumb"
        className="flex min-w-0 max-w-full items-center gap-[6px]"
        data-testid="studio-breadcrumb"
      >
        <Link
          to={routes.factory(scope)}
          className="shrink-0 font-mono text-[12px] text-muted underline decoration-line underline-offset-2 hover:text-ink"
          data-testid="studio-breadcrumb-workflows"
        >
          Factory
        </Link>
        <span aria-hidden="true" className="shrink-0 font-mono text-[12px] text-faint">
          /
        </span>
        {pipelineName && pipelineFolder ? (
          <>
            <span
              className="min-w-0 truncate font-mono text-[12px] text-muted"
              data-testid="studio-breadcrumb-folder"
            >
              {pipelineFolder}
            </span>
            <span aria-hidden="true" className="shrink-0 font-mono text-[12px] text-faint">
              /
            </span>
          </>
        ) : null}
      </nav>
      <h1
        className="min-w-0 flex-[1_1_100%] text-[15px] font-semibold [overflow-wrap:anywhere] md:flex-1 md:max-w-max"
        data-testid="studio-title"
        title={pipelineName ?? "Workflow draft"}
      >
        {pipelineName ?? "Workflow draft"}
      </h1>
    </header>
  );
}

/** Lazy UsedIn panel wrapper so the project/assignment fan-out only fires when ?panel=used-in is open. */
function StudioUsedInDrawer({
  pipelineId,
  revisionRows,
  newestPublished,
  newestPublishedId,
}: {
  pipelineId: string;
  revisionRows: PipelineRevisionSummary[];
  newestPublished: PipelineRevisionSummary | null;
  newestPublishedId: string | null;
}) {
  const usedIn = useUsedIn(pipelineId);
  return (
    <UsedInPanel
      groups={usedIn.groups}
      loading={usedIn.loading}
      error={usedIn.error}
      onRetry={usedIn.retry}
      failure={usedIn.failure}
      retrying={usedIn.fetching}
      revisions={revisionRows.map((row) => ({
        id: row.id,
        revision_number: row.revision_number,
        revision_digest: row.revision_digest,
        version_label: row.version_label,
        status: row.status,
      }))}
      newestPublished={newestPublished}
      newestPublishedId={newestPublishedId}
    />
  );
}

/** Lazy InputsTab wrapper so the project/assignment fan-out only fires when ?panel=inputs is open. */
function StudioInputsDrawer({
  pipelineId,
  slug,
  canAuthor,
  revision,
  revisionLoading,
  revisionError,
  onRevisionRetry,
  openDraft,
}: {
  pipelineId: string;
  slug: string;
  canAuthor: boolean;
  revision: PipelineRevision | undefined;
  revisionLoading: boolean;
  revisionError: unknown;
  onRevisionRetry: () => void;
  openDraft: PipelineDraftSummary | null;
}) {
  const usedIn = useUsedIn(pipelineId);
  return (
    <InputsTab
      pipelineId={pipelineId}
      slug={slug}
      canAuthor={canAuthor}
      revision={revision}
      revisionLoading={revisionLoading}
      revisionError={revisionError}
      onRevisionRetry={onRevisionRetry}
      openDraft={openDraft}
      groups={usedIn.groups}
      groupsLoading={usedIn.loading}
      groupsError={usedIn.error}
      embedded
    />
  );
}

export function StudioPage() {
  const { pipelineId = "", draftId: routeDraftId } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const scope = useScope();
  const project = useProject(scope ?? "");
  const explicitDraftId = routeDraftId ?? searchParams.get("draft") ?? "";
  const panelParam = searchParams.get("panel");
  const runParam = searchParams.get("run") ?? "";

  const me = useMe();
  const { actorLabel } = useActorNames(scope ?? undefined);
  const pipeline = usePipeline(pipelineId);
  const drafts = usePipelineDrafts(pipelineId, !explicitDraftId && !runParam);
  const draftId =
    explicitDraftId ||
    drafts.data?.drafts.find(
      (item) => item.edited_by === me.data?.id && item.status !== "published",
    )?.id ||
    "";
  const draft = useDraft(draftId);
  const newestSummary =
    pipeline.data?.revisions?.find((revision) => revision.status === "published") ?? null;
  const newestRevision = useRevision(newestSummary?.revision_digest ?? "");
  const studio = useStudioDraft(draftId, newestRevision.data?.document_text);
  const createDraft = useCreateDraft(pipelineId);
  const deleteDraft = useDeleteDraft(pipelineId);
  const validate = useValidateDraft(draftId, pipelineId);
  const publish = usePublishDraft(draftId);

  // Version-viewing state (clicking a version in Versions panel)
  const [viewingDigest, setViewingDigest] = useState<string | null>(null);
  const viewingRevision = useRevision(viewingDigest ?? "");

  // Run-state mode (?run=<runId>)
  const runQuery = useRun(runParam);
  const runNodesQuery = useRunNodes(runParam);
  const runEvents = useRunEvents(runParam, runQuery.data?.project_id ?? scope ?? "");
  const runRevision = useRevision(runParam ? (runQuery.data?.pipeline_revision_id ?? "") : "");

  // Synthetic Trigger node data
  const triggers = useStudioTriggers(pipelineId, pipeline.isSuccess && !runParam);
  const [triggersDialogOpen, setTriggersDialogOpen] = useState(false);

  // Versions run counts (fetched when Versions panel is open)
  const versionsOpen = panelParam === "versions";
  const pipelineRunsQuery = usePipelineRuns(versionsOpen ? pipelineId : "");
  const runCountsByDigest = useMemo(() => {
    if (!pipelineRunsQuery.isSuccess) return undefined;
    const map = new Map<string, number>();
    for (const run of pipelineRunsQuery.data.runs) {
      map.set(run.revision_digest, (map.get(run.revision_digest) ?? 0) + 1);
    }
    return map;
  }, [pipelineRunsQuery.isSuccess, pipelineRunsQuery.data]);

  // First-edit draft creation
  const creatingDraft = useRef(false);
  const saveFirstEdit = useRef(false);
  const [createFailure, setCreateFailure] = useState<unknown>(null);
  useEffect(() => {
    if (
      runParam ||
      draftId ||
      explicitDraftId ||
      !pipeline.data ||
      !drafts.data ||
      !me.data ||
      creatingDraft.current ||
      createFailure
    )
      return;
    if (newestSummary && (!newestRevision.data || !studio.dirty)) return;
    if (!hasLibraryRole(me.data)) return;
    creatingDraft.current = true;
    saveFirstEdit.current = studio.dirty;
    const body = newestRevision.data
      ? { from_revision_id: newestRevision.data.id }
      : {
          document_yaml: `apiVersion: communication.dev/v1alpha1\nkind: Pipeline\nmetadata:\n  name: ${pipeline.data.slug}\nspec:\n  nodes: []\n`,
        };
    void createDraft
      .mutateAsync(body)
      .then((created) => {
        setSearchParams(
          (current) => {
            const next = new URLSearchParams(current);
            next.set("draft", created.id);
            return next;
          },
          { replace: true },
        );
      })
      .catch((error: unknown) => setCreateFailure(error));
  }, [
    runParam,
    draftId,
    explicitDraftId,
    pipeline.data,
    drafts.data,
    me.data,
    newestSummary,
    newestRevision.data,
    studio.dirty,
    createDraft,
    setSearchParams,
    createFailure,
  ]);

  useEffect(() => {
    if (!saveFirstEdit.current || !draftId || !draft.data || !studio.savedVersion || !studio.dirty)
      return;
    saveFirstEdit.current = false;
    void studio.save();
  }, [draftId, draft.data, studio.savedVersion, studio.dirty, studio.save]);

  // Selection, tools & panels state
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [tool, setTool] = useState<CanvasTool>("select");
  const [fullInspectorForId, setFullInspectorForId] = useState<string | null>(null);
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const moreMenuRef = useRef<HTMLDivElement | null>(null);
  const [tryItOpen, setTryItOpen] = useState(false);
  const [useDialogOpen, setUseDialogOpen] = useState(false);

  const [validateOpen, setValidateOpen] = useState(false);
  const [validateOutcome, setValidateOutcome] = useState<ValidateBody | null>(null);
  const [validateFailure, setValidateFailure] = useState<unknown>(null);
  const [publishNote, setPublishNote] = useState<string | null>(null);
  const [publishFailure, setPublishFailure] = useState<unknown>(null);
  const [opError, setOpError] = useState<string | null>(null);
  const [highlight, setHighlight] = useState<string[]>([]);
  const [proposalSummary, setProposalSummary] = useState<string | null>(null);
  const [ambiguity, setAmbiguity] = useState<{
    title: string;
    reasons: string[];
    rerun: () => void;
  } | null>(null);

  const phone = useIsNarrow("(max-width: 767px)");
  const hasTopBarSlot = useHasTopBarSlot();

  // Close overflow menu on outside click / Esc
  useEffect(() => {
    if (!moreMenuOpen) return;
    const onPointerDown = (event: Event) => {
      const target = event.target as Node | null;
      if (moreMenuRef.current?.contains(target)) return;
      setMoreMenuOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMoreMenuOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [moreMenuOpen]);

  const canAuthor = hasLibraryRole(me.data);
  const status = draft.data?.status ?? "draft";
  const isViewingRun = Boolean(runParam);
  const isViewingHistory = Boolean(viewingDigest);
  const readOnly = !canAuthor || status === "published" || isViewingRun || isViewingHistory;

  // Debounced 800ms autosave
  useEffect(() => {
    if (
      !draftId ||
      readOnly ||
      !studio.dirty ||
      studio.conflict !== null ||
      studio.saveError !== null ||
      studio.savedVersion <= 0 ||
      studio.saving
    ) {
      return;
    }
    const timer = window.setTimeout(() => {
      void studio.save();
    }, AUTOSAVE_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [
    draftId,
    readOnly,
    studio.dirty,
    studio.text,
    studio.layout,
    studio.conflict,
    studio.saveError,
    studio.savedVersion,
    studio.saving,
    studio.save,
  ]);

  // Active canvas document / model (run pinned revision > viewed historical revision > draft)
  const runDocumentText = runRevision.data?.document_text ?? "";
  const runParse = useMemo(
    () => (isViewingRun && runDocumentText ? parseGraph(runDocumentText) : null),
    [isViewingRun, runDocumentText],
  );
  const viewDocumentText = viewingRevision.data?.document_text ?? "";
  const viewParse = useMemo(
    () => (isViewingHistory && viewDocumentText ? parseGraph(viewDocumentText) : null),
    [isViewingHistory, viewDocumentText],
  );

  const parse = studio.parse;
  const parseOk = isViewingRun
    ? (runParse?.ok ?? true)
    : isViewingHistory
      ? (viewParse?.ok ?? true)
      : parse.ok;
  const model: GraphModel = isViewingRun
    ? runParse?.ok
      ? runParse.model
      : EMPTY_MODEL
    : isViewingHistory
      ? viewParse?.ok
        ? viewParse.model
        : EMPTY_MODEL
      : parse.ok
        ? parse.model
        : (studio.lastGood?.model ?? EMPTY_MODEL);

  const documentObj: unknown = useMemo(() => {
    if (isViewingRun) {
      return runRevision.data?.canonical_document ?? toJsDocument(runDocumentText);
    }
    if (isViewingHistory) {
      return viewingRevision.data?.canonical_document ?? toJsDocument(viewDocumentText);
    }
    return parse.ok ? toJsDocument(studio.text) : (studio.lastGood?.document ?? null);
  }, [
    isViewingRun,
    runRevision.data,
    runDocumentText,
    isViewingHistory,
    viewingRevision.data,
    viewDocumentText,
    parse.ok,
    studio.text,
    parse.ok ? null : studio.lastGood,
  ]);

  const activeLayout: UiLayout = useMemo(() => {
    if (isViewingRun) {
      return (
        (runRevision.data?.ui_layout as unknown as UiLayout) ?? uiLayoutOfText(runDocumentText)
      );
    }
    if (isViewingHistory) {
      return (
        (viewingRevision.data?.ui_layout as unknown as UiLayout) ?? uiLayoutOfText(viewDocumentText)
      );
    }
    return studio.layout;
  }, [
    isViewingRun,
    runRevision.data,
    runDocumentText,
    isViewingHistory,
    viewingRevision.data,
    viewDocumentText,
    studio.layout,
  ]);

  // Run projection + VerdictStack per GoalFrame scope
  const baseRun = useMemo(() => (runQuery.data ? viewRun(runQuery.data) : null), [runQuery.data]);
  const baseRunNodes = useMemo(
    () => (runNodesQuery.data?.node_executions ?? []).map(viewNodeExecution),
    [runNodesQuery.data],
  );
  const runProjection = useMemo(
    () =>
      isViewingRun ? projectRun({ run: baseRun, nodes: baseRunNodes }, runEvents.events) : null,
    [isViewingRun, baseRun, baseRunNodes, runEvents.events],
  );
  const statusOverlay = useMemo(
    () => (runProjection ? overlays(runProjection.nodes, {}) : undefined),
    [runProjection],
  );

  // Identify GoalFrame scopes & verdict-step executions to fetch outputs for VerdictStack
  const goalScopes = useMemo(() => {
    if (!isViewingRun || !documentObj || typeof documentObj !== "object") return [];
    const doc = documentObj as DefinitionDocument;
    const found: { id: string; verdictStepId: string | null }[] = [];
    const walk = (nodes: DefinitionNode[]) => {
      for (const n of nodes) {
        if (n.kind === "until" && readGoal(n) !== null) {
          found.push({ id: n.id, verdictStepId: verdictStepId(n) });
        }
        if (isScopeKind(n.kind)) walk(scopeBody(n));
      }
    };
    if (Array.isArray(doc.spec?.nodes)) walk(doc.spec.nodes);
    return found;
  }, [isViewingRun, documentObj]);

  const verdictStepExecutions = useMemo(() => {
    if (!isViewingRun || !runProjection || goalScopes.length === 0) return [];
    const wantedIds = new Set(
      goalScopes.map((g) => g.verdictStepId).filter((id): id is string => Boolean(id)),
    );
    return runProjection.nodes.filter(
      (exec) =>
        wantedIds.has(exec.node_id) && (exec.status === "succeeded" || exec.status === "failed"),
    );
  }, [isViewingRun, runProjection, goalScopes]);

  const verdictDetailQueries = useQueries({
    queries: verdictStepExecutions.map((exec) => ({
      queryKey: queryKeys.runNode(runParam, exec.id),
      queryFn: () => apiFetch<NodeExecutionDetail>(`/api/v1/runs/${runParam}/nodes/${exec.id}`),
      enabled: Boolean(runParam && exec.id),
    })),
  });

  const verdictsByScope = useMemo(() => {
    if (!isViewingRun || !runProjection || goalScopes.length === 0) return undefined;
    const outputsByExecId = new Map<string, Record<string, unknown> | null>();
    verdictStepExecutions.forEach((exec, idx) => {
      const detail = verdictDetailQueries[idx]?.data;
      const latestAttempt = detail?.attempts
        ?.slice()
        .sort((a, b) => a.attempt_number - b.attempt_number)
        .at(-1);
      outputsByExecId.set(
        exec.id,
        (latestAttempt?.outputs as Record<string, unknown> | null) ?? null,
      );
    });
    const out: Record<string, VerdictRound[]> = {};
    for (const scopeItem of goalScopes) {
      const scopeRows = runProjection.nodes.filter(
        (r) => scopeIterationIndex(r.node_instance_key, scopeItem.id) !== null,
      );
      const iterations = [
        ...new Set(
          scopeRows
            .map((r) => scopeIterationIndex(r.node_instance_key, scopeItem.id))
            .filter((n): n is number => n !== null && n >= 1),
        ),
      ].sort((a, b) => a - b);
      if (iterations.length === 0) continue;
      const maxIter = iterations[iterations.length - 1];
      const scopeOverallStatus = statusOverlay?.[scopeItem.id]?.state ?? "queued";
      const rounds: VerdictRound[] = [];
      for (const n of iterations) {
        const exec: NodeExecutionSummary | undefined = scopeItem.verdictStepId
          ? scopeRows.find(
              (r) =>
                r.node_id === scopeItem.verdictStepId &&
                scopeIterationIndex(r.node_instance_key, scopeItem.id) === n,
            )
          : undefined;
        const outputs = exec ? outputsByExecId.get(exec.id) : null;
        const parsedJudge = parseJudgeOutput(outputs);
        let verdict: VerdictRound["verdict"];
        let reason: string | undefined = parsedJudge?.reason;
        if (parsedJudge) {
          verdict = parsedJudge.verdict;
        } else if (
          exec &&
          (exec.status === "running" || exec.status === "leased" || exec.status === "ready")
        ) {
          verdict = "running";
        } else if (n < maxIter) {
          verdict = "not_yet";
        } else if (scopeOverallStatus === "done") {
          verdict = "met";
        } else if (exec?.status === "failed") {
          verdict = "not_yet";
        } else if (scopeOverallStatus === "running" || !exec) {
          verdict = "running";
        } else {
          verdict = "not_yet";
        }
        if (!reason && outputs && typeof outputs.reason === "string" && outputs.reason.trim()) {
          reason = outputs.reason.trim();
        } else if (!reason && exec?.failed_cause) {
          reason = exec.failed_cause;
        }
        rounds.push({ n, verdict, ...(reason ? { reason } : {}) });
      }
      if (rounds.length > 0) out[scopeItem.id] = rounds;
    }
    return out;
  }, [
    isViewingRun,
    runProjection,
    goalScopes,
    verdictStepExecutions,
    verdictDetailQueries,
    statusOverlay,
  ]);

  const activeSelectedIds = useMemo(
    () => selectedIds.filter((id) => model.nodes.some((n) => n.id === id)),
    [selectedIds, model],
  );
  const selectedId = activeSelectedIds.length === 1 ? activeSelectedIds[0] : null;

  useEffect(() => {
    setFullInspectorForId((prev) => (prev === selectedId ? prev : null));
  }, [selectedId]);

  const selectOne = useCallback((id: string | null) => {
    setSelectedIds(id !== null ? [id] : []);
  }, []);

  const modelRef = useRef(model);
  modelRef.current = model;
  const selectMany = useCallback((ids: string[]) => {
    setSelectedIds((current) => {
      const alive = ids.filter((id) => modelRef.current.nodes.some((n) => n.id === id));
      const kept = current.filter((id) => alive.includes(id));
      return kept.length === alive.length && kept.every((id, i) => id === alive[i])
        ? current
        : alive;
    });
  }, []);

  function runOp(op: (text: string) => OpResult) {
    const result = studio.apply(op);
    if (result.ok) {
      setOpError(null);
      setSelectedIds(result.changed[0] !== undefined ? [result.changed[0]] : []);
      return;
    }
    if (isAmbiguousOp(result)) {
      setOpError(result.reasons.join("; "));
      return;
    }
    setOpError(result.error);
  }

  function handleWrapRepeat(nodeIds: string[], goal: GoalSpec) {
    const result = studio.apply((text) => {
      const res = wrapInUntil(text, nodeIds, goal);
      if (!res.ok && "unsupported" in res) {
        return { ok: false, error: res.unsupported };
      }
      return res;
    });
    if (result.ok) {
      setOpError(null);
      setSelectedIds(result.changed[0] !== undefined ? [result.changed[0]] : []);
      setTool("select");
    } else if (isAmbiguousOp(result)) {
      setOpError(result.reasons.join("; "));
    } else {
      setOpError(result.error);
    }
  }

  function handleWrapSideBySide(nodeIds: string[]) {
    runOp((text) => wrapSideBySide(text, nodeIds));
    setTool("select");
  }

  function handleEditGoal(scopeId: string, goal: GoalSpec) {
    const result = studio.apply((text) => {
      const res = updateUntilGoal(text, scopeId, goal);
      if (!res.ok && "unsupported" in res) {
        return { ok: false, error: res.unsupported };
      }
      return res;
    });
    if (result.ok) {
      setOpError(null);
    } else if (isAmbiguousOp(result)) {
      setOpError(result.reasons.join("; "));
    } else {
      setOpError(result.error);
    }
  }

  function handleUnwrap(scopeId: string) {
    runOp((text) => unwrapScope(text, scopeId));
  }

  function insertOnEdge(edge: GraphEdge, kind: string, acceptAmbiguity = false) {
    const title = `Insert a step between ${edge.from} and ${edge.to}`;
    const result = studio.apply((text) => insertOnEdgeOp(text, edge, kind, { acceptAmbiguity }));
    if (result.ok) {
      setOpError(null);
      setSelectedIds(result.changed[0] !== undefined ? [result.changed[0]] : []);
      return;
    }
    if (isAmbiguousOp(result)) {
      setAmbiguity({
        title,
        reasons: result.reasons,
        rerun: () => {
          setAmbiguity(null);
          insertOnEdge(edge, kind, true);
        },
      });
      return;
    }
    setOpError(result.error);
  }

  function handleAddAfter(afterId: string | null, nodeScope: ScopePath, kind: string) {
    runOp((text) => addNode(text, { kind, scope: nodeScope, after: afterId }));
  }

  function handleDelete(ids: string[]) {
    for (const id of ids) {
      const isEdge = id.includes("->");
      const result = studio.apply((text) =>
        isEdge ? disconnectEdgeOp(text, id) : deleteNode(text, id),
      );
      if (!result.ok && !isAmbiguousOp(result)) {
        setOpError(result.error);
        break;
      }
    }
    setSelectedIds([]);
  }

  function onPreview(next: AssistantProposalPreview) {
    const result = studio.apply(() => ({ ok: true, text: next.text, changed: next.nodeIds }));
    if (!result.ok) {
      setOpError(isAmbiguousOp(result) ? result.reasons.join("; ") : result.error);
      return;
    }
    setOpError(null);
    setHighlight(next.nodeIds);
    setProposalSummary(next.summary);
  }

  async function onProposalApply() {
    const saved = await studio.save();
    if (saved) {
      setHighlight([]);
      setProposalSummary(null);
    }
  }

  function onProposalDiscard() {
    studio.undo();
    setHighlight([]);
    setProposalSummary(null);
  }

  function setPanel(nextPanel: string | null) {
    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current);
        if (nextPanel) next.set("panel", nextPanel);
        else next.delete("panel");
        return next;
      },
      { replace: true },
    );
  }

  function exitRunView() {
    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current);
        next.delete("run");
        return next;
      },
      { replace: true },
    );
  }

  async function onMakeLive() {
    if (readOnly || !draftId) return;
    setPublishFailure(null);
    setValidateFailure(null);

    const needsValidation = status !== "valid" || studio.dirty;
    if (studio.dirty) {
      const saved = await studio.save();
      if (!saved) return;
    }
    if (needsValidation) {
      try {
        const body = await validate.mutateAsync();
        const outcome = viewValidate(body);
        setValidateOutcome(outcome);
        if (!outcome || !outcome.valid) {
          setValidateOpen(true);
          return;
        }
        setValidateOpen(false);
      } catch (error) {
        setValidateFailure(error);
        setValidateOpen(true);
        return;
      }
    }
    try {
      const revision = await publish.mutateAsync({ version: studio.getSavedVersion() });
      setPublishNote(`published as r${revision.revision_number} ${revision.version_label}`);
      setValidateOpen(false);
    } catch (error) {
      setPublishFailure(error);
    }
  }

  async function onValidateYaml() {
    if (readOnly || !draftId) return;
    setValidateFailure(null);
    if (studio.dirty) {
      const saved = await studio.save();
      if (!saved) return;
    }
    try {
      const body = await validate.mutateAsync();
      setValidateOutcome(viewValidate(body));
    } catch (error) {
      setValidateFailure(error);
    }
  }

  async function onDiscardDraft() {
    if (readOnly || !draftId) return;
    setMoreMenuOpen(false);
    try {
      await deleteDraft.mutateAsync(draftId);
      setPanel(null);
      navigate(newestSummary ? routes.factoryWorkflow(pipelineId, scope) : routes.factory(scope), {
        replace: true,
      });
    } catch (error) {
      setOpError(problemOf(error).detail || problemOf(error).title);
    }
  }

  async function onRestoreRevision(rev: PipelineRevisionSummary) {
    if (!canAuthor) return;
    try {
      const record = await apiFetch<{ id: string; document_text: string }>(
        `/api/v1/revisions/${rev.revision_digest}`,
      );
      if (draftId && status !== "published") {
        studio.apply(() => ({ ok: true, text: record.document_text, changed: [] }));
        setViewingDigest(null);
        setPanel(null);
      } else {
        const created = await createDraft.mutateAsync({ from_revision_id: record.id });
        setViewingDigest(null);
        setPanel(null);
        setSearchParams(
          (current) => {
            const next = new URLSearchParams(current);
            next.set("draft", created.id);
            next.delete("panel");
            return next;
          },
          { replace: true },
        );
      }
    } catch (error) {
      setOpError(problemOf(error).detail || problemOf(error).title);
    }
  }

  function goToNode(instanceLocation: string | null) {
    if (instanceLocation === null) return;
    const matches = model.nodes.filter(
      (n) => n.pointer === instanceLocation || instanceLocation.startsWith(`${n.pointer}/`),
    );
    if (matches.length === 0) return;
    const node = matches.reduce((deepest, n) =>
      n.pointer.length > deepest.pointer.length ? n : deepest,
    );
    selectOne(node.id);
    setValidateOpen(false);
    if (phone && panelParam === "yaml") setPanel(null);
  }

  // Semantic diff count for the draft status indicator
  const baseDocument = newestRevision.data?.canonical_document ?? null;
  const draftChangeCount = useMemo(() => {
    if (!baseDocument || !parseOk) return null;
    try {
      const diff = semanticDiff(baseDocument, parseYaml(studio.text));
      return diff.nodes.length + diff.edges.length + diff.pipeline.length;
    } catch {
      return null;
    }
  }, [baseDocument, parseOk, studio.text]);

  // Loading & error guards (all hooks ran above)
  if (
    (!runParam &&
      !explicitDraftId &&
      (!pipeline.data || !drafts.data || !me.data || (newestSummary && !newestRevision.data))) ||
    (draftId && !runParam && draft.isPending)
  ) {
    return <Spinner label="Loading the draft" />;
  }
  if (draftId && !runParam && draft.isError) {
    const notFound = draft.error instanceof ApiError && draft.error.status === 404;
    return (
      <div className="min-h-[calc(100dvh-44px)] bg-paper" data-testid="studio-error-page">
        <StudioFailureTitle
          pipelineName={pipeline.data?.display_name || pipeline.data?.slug || null}
          pipelineFolder={pipeline.data?.folder ?? null}
        />
        <section aria-label="Draft unavailable" className="px-[22px] py-[22px] md:px-[28px]">
          <div className="max-w-[70ch]">
            {notFound ? (
              <ProjectUnavailable
                testid="studio-draft-error"
                label="Draft unavailable"
                copy="Draft not found or you do not have access."
                hint="The breadcrumb above opens Factory. There is nothing to retry: this draft is not here."
              />
            ) : (
              <ProblemBanner
                error={draft.error}
                fallback="The draft could not be read."
                subject="the draft"
                hint="Nothing is shown until the draft loads."
                retry={{
                  onClick: () => void draft.refetch(),
                  pending: draft.isFetching,
                  testid: "studio-draft-retry",
                }}
                back={{
                  to: routes.factory(scope),
                  label: "← Back to Factory",
                  testid: "studio-back-to-workflows",
                }}
                testid="studio-draft-error"
              />
            )}
          </div>
        </section>
      </div>
    );
  }

  const pipelineName = pipeline.data?.display_name || pipeline.data?.slug || pipelineId;
  const projectLabel = project.data?.name || scope || "";
  const revisions = (pipeline.data?.revisions ?? []).map(viewRevisionSummary);
  const newestPublishedId = newestRevision.data?.id ?? null;
  const yamlEditable = Boolean(draftId) && !readOnly;
  const parseError = parse.ok ? null : { error: parse.error, line: parse.line };
  const yamlVerdict =
    validateOutcome ?? (studio.dirty ? null : viewValidate(draft.data?.validation ?? null));

  // Draft status line in TopBarLeft
  let draftStatusNode: React.ReactNode = null;
  if (isViewingRun) {
    draftStatusNode = (
      <span
        className="flex items-center gap-[6px] text-[12px] text-muted"
        data-testid="studio-draft-status"
      >
        <span className="h-[7px] w-[7px] rounded-full bg-st-running-strong" aria-hidden />
        Run {shortId(runParam)}
      </span>
    );
  } else if (studio.saving) {
    draftStatusNode = (
      <span
        className="flex items-center gap-[6px] text-[12px] text-muted"
        data-testid="studio-draft-status"
      >
        <span className="h-[7px] w-[7px] rounded-full bg-st-waiting-strong" aria-hidden />
        Saving…
      </span>
    );
  } else if (studio.saveError) {
    const errText = problemOf(studio.saveError).detail || problemOf(studio.saveError).title;
    draftStatusNode = (
      <span
        className="flex items-center gap-[6px] text-[12px] text-st-failed-tag-fg"
        data-testid="studio-draft-status"
      >
        × Couldn&apos;t save: {errText}
      </span>
    );
  } else if (studio.conflict) {
    draftStatusNode = (
      <span
        className="flex items-center gap-[6px] text-[12px] text-st-failed-tag-fg"
        data-testid="studio-draft-status"
      >
        × Conflict (server at v{studio.conflict.currentVersion})
      </span>
    );
  } else if (!draftId && newestSummary) {
    draftStatusNode = (
      <span
        className="flex items-center gap-[6px] text-[12px] text-muted"
        data-testid="studio-draft-status"
      >
        <span className="h-[7px] w-[7px] rounded-full bg-st-done-tag-fg" aria-hidden />
        Live v{newestSummary.revision_number}
      </span>
    );
  } else if (draftId) {
    const changeSummary =
      newestSummary !== null && draftChangeCount !== null
        ? ` · ${draftChangeCount} ${draftChangeCount === 1 ? "change" : "changes"} from live v${newestSummary.revision_number}`
        : newestSummary === null
          ? " · unpublished"
          : "";
    draftStatusNode = (
      <span
        className="flex items-center gap-[6px] text-[12px] text-muted"
        data-testid="studio-draft-status"
      >
        <span className="h-[7px] w-[7px] rounded-full bg-st-waiting-strong" aria-hidden />
        Your draft{changeSummary}
      </span>
    );
  }

  const topBarContent = (
    <div className="flex min-w-0 flex-wrap items-center gap-x-[12px] gap-y-[2px]">
      <nav
        aria-label="Breadcrumb"
        className="flex min-w-0 items-center gap-[6px] text-[14px]"
        data-testid="studio-breadcrumb"
      >
        {scope ? (
          <>
            <Link
              to={routes.scopeHome(scope)}
              data-testid="studio-breadcrumb-project"
              className="shrink-0 text-muted hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
            >
              {projectLabel}
            </Link>
            <span aria-hidden className="text-line-strong">
              /
            </span>
          </>
        ) : null}
        <Link
          to={routes.factory(scope)}
          data-testid="studio-breadcrumb-workflows"
          className="shrink-0 text-muted hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
        >
          Factory
        </Link>
        <span aria-hidden className="text-line-strong">
          /
        </span>
        <span
          className="min-w-0 truncate font-bold text-ink"
          data-testid="studio-title"
          title={pipelineName}
        >
          {pipelineName}
        </span>
      </nav>
      {draftStatusNode}
    </div>
  );

  // Selected node details (for AgentStepCard vs full StudioInspector)
  const selectedGraphNode = selectedId ? findNode(model, selectedId) : undefined;
  const isAgentStep = selectedGraphNode?.kind === "agent.acp";
  const isScopeNode = Boolean(selectedGraphNode?.isScope);
  const showAgentCard = Boolean(
    selectedId &&
    isAgentStep &&
    fullInspectorForId !== selectedId &&
    !isViewingRun &&
    !isViewingHistory &&
    tool !== "box",
  );
  const showStepInspector =
    Boolean(selectedId && ((!isAgentStep && !isScopeNode) || fullInspectorForId === selectedId)) &&
    !showAgentCard &&
    !isViewingRun &&
    !isViewingHistory &&
    tool !== "box";
  const showSettingsInspector = panelParam === "settings" && !selectedId;

  const selectedCfg = selectedId ? nodeConfigOf(documentObj, model, selectedId) : {};
  const agentProfile = typeof selectedCfg.profile === "string" ? selectedCfg.profile : "";
  const agentPrompt = typeof selectedCfg.prompt === "string" ? selectedCfg.prompt : "";

  const inspectorPanel = (
    <div className="flex h-full flex-col">
      <div className="flex items-center border-b border-line-soft px-[16px] py-[10px]">
        <span className="font-mono text-[10.5px] font-semibold uppercase tracking-[.06em] text-muted">
          {selectedId ? "Step settings" : "Workflow settings"}
        </span>
        <button
          type="button"
          aria-label="Close inspector"
          data-testid="editor-inspector-close"
          onClick={() => {
            setFullInspectorForId(null);
            if (selectedId) selectOne(null);
            if (panelParam === "settings") setPanel(null);
          }}
          className="icon-hit ml-auto inline-flex h-[24px] w-[24px] items-center justify-center rounded-[6px] text-muted hover:bg-fill hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
        >
          <IconX size={15} stroke={1.5} aria-hidden />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <StudioInspector
          model={model}
          nodeId={selectedId}
          document={documentObj}
          text={studio.text}
          readOnly={readOnly}
          apply={studio.apply}
          onDelete={(id) => handleDelete([id])}
          onOpenInputs={() => setPanel("inputs")}
        />
      </div>
      {studio.guard.pending === null && studio.conflict === null && !selectedId ? (
        <div className="shrink-0" data-testid="studio-assistant-dock">
          <AssistantProposalBox
            draftId={draftId}
            version={studio.savedVersion}
            text={studio.text}
            readOnly={readOnly}
            dirty={studio.dirty && highlight.length === 0}
            previewing={highlight.length > 0}
            onPreview={onPreview}
            onApply={onProposalApply}
            onDiscard={onProposalDiscard}
            footer
          />
          {highlight.length > 0 ? (
            <p
              className="border-b border-line bg-st-waiting-pale-body px-3 py-1.5 font-mono text-[10px] text-st-waiting-pale-fg"
              data-testid="studio-proposal-caption"
            >
              {PROPOSAL_CAPTION}
              {proposalSummary ? ` — ${proposalSummary}` : ""}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );

  const runBannerState = runProjection?.run
    ? STATES[stateOf(RUN_STATE[runProjection.run.status] ?? "queued")]
    : STATES.queued;

  const viewedRevSummary = viewingDigest
    ? (revisions.find((r) => r.revision_digest === viewingDigest) ?? null)
    : null;

  return (
    <div
      className="flex h-full min-h-0 flex-col overflow-hidden bg-surface"
      data-testid="studio-page"
      data-phone={phone ? "true" : "false"}
    >
      {hasTopBarSlot ? (
        <TopBarLeft>{topBarContent}</TopBarLeft>
      ) : (
        <div
          className="flex shrink-0 items-center border-b border-line bg-surface px-4 py-2"
          data-testid="studio-topbar-fallback"
        >
          {topBarContent}
        </div>
      )}

      {createFailure ? (
        <ProblemBanner error={createFailure} fallback="The draft could not be created." />
      ) : null}
      {studio.guard.pending !== null ? (
        <div
          className="flex flex-wrap items-center gap-[8px] border-b border-line bg-st-waiting-pale-body px-4 py-2"
          data-testid="studio-leave-guard"
        >
          <span className="font-mono text-[11px] text-st-waiting-pale-fg">
            unsaved changes — leaving the studio discards the local edit the server never saw
          </span>
          <SoftButton
            variant="secondary"
            compact
            data-testid="studio-leave-discard"
            onClick={studio.guard.proceed}
          >
            Discard and leave
          </SoftButton>
          <SoftButton
            variant="ghost"
            compact
            data-testid="studio-leave-stay"
            onClick={studio.guard.cancel}
          >
            Stay
          </SoftButton>
        </div>
      ) : null}
      {studio.conflict !== null ? (
        <div
          className="flex flex-wrap items-center gap-[8px] border-b border-line bg-st-failed-pale-body px-4 py-2"
          data-testid="studio-conflict-banner"
        >
          <span className="font-mono text-[11px] text-st-failed-pale-fg">
            stale draft: the server is at v{studio.conflict.currentVersion}, your save targeted v
            {studio.savedVersion}
          </span>
          <SoftButton
            variant="secondary"
            compact
            data-testid="studio-conflict-reload"
            onClick={studio.reloadTheirs}
          >
            Reload theirs
          </SoftButton>
          <SoftButton
            variant="secondary"
            compact
            data-testid="studio-conflict-overwrite"
            onClick={() => void studio.overwrite()}
          >
            Keep mine and overwrite
          </SoftButton>
        </div>
      ) : null}
      {studio.saveError ? (
        <ProblemBanner
          error={studio.saveError}
          fallback="The draft could not be saved."
          testid="studio-save-error"
        />
      ) : null}
      {opError !== null ? (
        <div
          role="alert"
          className="border-b border-line bg-st-failed-pale-body px-4 py-1.5 font-mono text-[11px] text-st-failed-pale-fg"
          data-testid="studio-op-error"
        >
          {opError}
        </div>
      ) : null}
      {publishNote !== null ? (
        <p
          className="border-b border-line px-4 py-1.5 font-mono text-[11px] text-muted"
          data-testid="studio-published"
        >
          {publishNote}
        </p>
      ) : null}
      {publishFailure !== null ? (
        <FormError error={publishFailure} testid="studio-publish-error" />
      ) : null}
      {!canAuthor ? (
        <div
          className="border-b border-line bg-paper px-4 py-1 font-mono text-[11px] text-muted"
          data-testid="studio-read-only-note"
        >
          {LIBRARY_READ_ONLY_NOTE}
        </div>
      ) : null}

      <div className="relative min-h-0 flex-1 overflow-hidden">
        <StudioCanvas
          model={model}
          direction="LR"
          document={documentObj}
          layout={activeLayout}
          selectedId={selectedId}
          selectedIds={activeSelectedIds}
          onSelectionChange={selectMany}
          readOnly={readOnly || !parseOk}
          stale={!parseOk}
          staleMessage="YAML has errors — the canvas shows the last valid version; graph editing is paused"
          highlight={highlight.length > 0 ? highlight : undefined}
          statusOverlay={statusOverlay}
          verdictsByScope={verdictsByScope}
          trigger={
            triggers.subline
              ? {
                  subline: triggers.subline,
                  onClick: () => setTriggersDialogOpen(true),
                }
              : null
          }
          tool={tool}
          onToolChange={setTool}
          phone={phone}
          onSelect={selectOne}
          onMove={readOnly ? undefined : studio.move}
          onInsertOnEdge={readOnly ? undefined : (edge, kind) => insertOnEdge(edge, kind)}
          onAddAfter={readOnly ? undefined : handleAddAfter}
          onConnect={
            readOnly ? undefined : (from, to) => runOp((text) => connectOp(text, from, to))
          }
          onDelete={readOnly ? undefined : handleDelete}
          onDuplicate={readOnly ? undefined : (id) => runOp((text) => duplicateNode(text, id))}
          canConnect={readOnly ? undefined : (from, to) => canConnectOf(model, from, to)}
          onWrapRepeat={readOnly ? undefined : handleWrapRepeat}
          onWrapSideBySide={readOnly ? undefined : handleWrapSideBySide}
          onEditGoal={readOnly ? undefined : handleEditGoal}
          onUnwrap={readOnly ? undefined : handleUnwrap}
          onOpenInspector={(nodeId) => {
            setSelectedIds([nodeId]);
            setFullInspectorForId(nodeId);
          }}
          showToolIsland={!isViewingRun}
          onIslandAdd={(kind, position) => {
            const result = studio.apply((text) =>
              addNode(text, { kind, scope: [], after: selectedId }),
            );
            if (result.ok) {
              setOpError(null);
              const id = result.changed[0];
              if (id) {
                setSelectedIds([id]);
                if (!selectedId) studio.move(id, position);
              }
            } else if (isAmbiguousOp(result)) setOpError(result.reasons.join("; "));
            else setOpError(result.error);
          }}
          hideStepList
          renderNodeOverlay={({ nodeId: overlayNodeId, placement, sheet }) => {
            if (!showAgentCard || overlayNodeId !== selectedId) return null;
            return (
              <div
                data-testid="agent-card-anchor"
                data-side={sheet ? "sheet" : placement.side}
                className={sheet ? "fixed inset-x-0 bottom-0 z-40" : "absolute z-30"}
                style={sheet ? undefined : { left: placement.left, top: placement.top }}
                onPointerDown={(e) => e.stopPropagation()}
              >
                <AgentStepCard
                  nodeId={overlayNodeId}
                  profile={agentProfile}
                  prompt={agentPrompt}
                  text={studio.text}
                  readOnly={readOnly}
                  apply={studio.apply}
                  onRenamed={(nextId) => setSelectedIds([nextId])}
                  onMoreSettings={() => setFullInspectorForId(overlayNodeId)}
                  onClose={() => selectOne(null)}
                  sheet={sheet}
                />
              </div>
            );
          }}
        />

        {/* Top-center Run Banner (?run=<runId>) */}
        {isViewingRun ? (
          <div
            data-testid="studio-run-banner"
            className="absolute left-1/2 top-4 z-20 flex max-w-[calc(100vw-32px)] -translate-x-1/2 items-center gap-[10px] rounded-full border border-line bg-surface px-[14px] py-[6px] text-[13px] shadow-[var(--shadow-pill)] whitespace-nowrap"
          >
            {runQuery.isError ? (
              <span className="text-st-failed-tag-fg">Run could not be loaded</span>
            ) : (
              <span className={`font-medium ${runBannerState.tagFg}`}>
                {runBannerState.glyph} Run {shortId(runParam)} · {runBannerState.word}
              </span>
            )}
            <Link
              to={routes.run(runParam)}
              data-testid="studio-run-open"
              className="font-semibold text-accent-text hover:underline focus-visible:outline-2 focus-visible:outline-accent"
            >
              Open run
            </Link>
            <button
              type="button"
              data-testid="studio-run-back"
              onClick={exitRunView}
              className="font-semibold text-ink-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
            >
              Back to editing
            </button>
          </div>
        ) : null}

        {/* Top-center Historical Version Banner */}
        {!isViewingRun && isViewingHistory ? (
          <div
            data-testid="version-viewing-banner"
            className="absolute left-1/2 top-4 z-20 flex max-w-[calc(100vw-32px)] -translate-x-1/2 items-center gap-[10px] rounded-full border border-line bg-surface px-[14px] py-[6px] text-[13px] shadow-[var(--shadow-pill)] whitespace-nowrap"
          >
            <span className="text-ink-2">
              Viewing v
              {viewedRevSummary?.revision_number ?? viewingRevision.data?.revision_number ?? "?"}.
            </span>
            <button
              type="button"
              data-testid="version-back-to-draft"
              onClick={() => setViewingDigest(null)}
              className="font-semibold text-accent-text hover:underline focus-visible:outline-2 focus-visible:outline-accent"
            >
              {draftId ? "Back to your draft" : "Back to live"}
            </button>
          </div>
        ) : null}

        {/* Top-right action buttons (Versions, Try it, Make live, …) */}
        <div
          className="absolute right-4 top-4 z-40 flex items-center gap-[8px]"
          data-testid="editor-top-actions"
        >
          <button
            type="button"
            data-testid="editor-versions-btn"
            aria-label="Versions"
            aria-pressed={versionsOpen}
            onClick={() => setPanel(versionsOpen ? null : "versions")}
            className={`flex h-[34px] shrink-0 items-center gap-[6px] whitespace-nowrap rounded-[10px] border border-line px-[12px] text-[13px] font-semibold shadow-[var(--shadow-pill)] focus-visible:outline-2 focus-visible:outline-accent ${
              versionsOpen
                ? "bg-accent-tint text-accent-edge"
                : "bg-surface text-ink hover:border-line-strong"
            }`}
          >
            <IconHistory size={16} stroke={1.5} aria-hidden />
            <span className={phone ? "sr-only" : undefined}>Versions</span>
          </button>

          <button
            type="button"
            data-testid="editor-try-it-btn"
            aria-label="Try it"
            onClick={() => setTryItOpen(true)}
            className="flex h-[34px] shrink-0 items-center gap-[6px] whitespace-nowrap rounded-[10px] border border-line bg-surface px-[12px] text-[13px] font-semibold text-ink shadow-[var(--shadow-pill)] hover:border-line-strong focus-visible:outline-2 focus-visible:outline-accent"
          >
            <IconPlayerPlay size={14} stroke={1.5} aria-hidden />
            <span className={phone ? "sr-only" : undefined}>Try it</span>
          </button>

          {canAuthor ? (
            <button
              type="button"
              data-testid="studio-publish"
              disabled={
                !draftId ||
                isViewingRun ||
                isViewingHistory ||
                status === "published" ||
                publish.isPending ||
                validate.isPending ||
                studio.saving
              }
              title={
                !draftId
                  ? "Already live — edit the workflow to start a draft"
                  : status === "published"
                    ? "This draft is already live"
                    : "Validate and make this draft live"
              }
              onClick={() => void onMakeLive()}
              className="flex h-[34px] shrink-0 items-center whitespace-nowrap rounded-[10px] bg-accent px-[14px] text-[13px] font-semibold text-white shadow-[var(--shadow-pill)] hover:brightness-95 disabled:cursor-not-allowed disabled:bg-disabled-bg disabled:text-disabled-fg focus-visible:outline-2 focus-visible:outline-accent"
            >
              {publish.isPending || validate.isPending ? "Making live…" : "Make live"}
            </button>
          ) : null}

          <div ref={moreMenuRef} className="relative">
            <button
              type="button"
              data-testid="editor-more-btn"
              aria-label="More workflow actions"
              aria-haspopup="menu"
              aria-expanded={moreMenuOpen}
              onClick={() => setMoreMenuOpen((open) => !open)}
              className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[10px] border border-line bg-surface text-ink shadow-[var(--shadow-pill)] hover:border-line-strong focus-visible:outline-2 focus-visible:outline-accent"
            >
              <IconDots size={16} stroke={1.5} aria-hidden />
            </button>
            {moreMenuOpen ? (
              <div
                role="menu"
                aria-label="Workflow actions"
                data-testid="editor-more-menu"
                className="absolute right-0 top-[40px] z-40 w-[190px] rounded-[12px] border border-line bg-surface py-[6px] shadow-[var(--shadow-pop)]"
              >
                <button
                  type="button"
                  role="menuitem"
                  data-testid="editor-menu-yaml"
                  onClick={() => {
                    setMoreMenuOpen(false);
                    setPanel("yaml");
                  }}
                  className="flex h-[34px] w-full items-center px-3 text-left text-[13px] text-ink hover:bg-accent-wash focus-visible:bg-accent-wash focus-visible:outline-none"
                >
                  {yamlEditable ? "Edit as YAML" : "View YAML"}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  data-testid="editor-menu-inputs"
                  onClick={() => {
                    setMoreMenuOpen(false);
                    setPanel("inputs");
                  }}
                  className="flex h-[34px] w-full items-center px-3 text-left text-[13px] text-ink hover:bg-accent-wash focus-visible:bg-accent-wash focus-visible:outline-none"
                >
                  Run inputs…
                </button>
                <button
                  type="button"
                  role="menuitem"
                  data-testid="editor-menu-used-in"
                  onClick={() => {
                    setMoreMenuOpen(false);
                    setPanel("used-in");
                  }}
                  className="flex h-[34px] w-full items-center px-3 text-left text-[13px] text-ink hover:bg-accent-wash focus-visible:bg-accent-wash focus-visible:outline-none"
                >
                  Used in
                </button>
                <button
                  type="button"
                  role="menuitem"
                  disabled={!newestSummary}
                  title={
                    newestSummary
                      ? "Pin the newest published revision to a project or repository"
                      : "Make this workflow live before using it in a project"
                  }
                  data-testid="editor-menu-use"
                  onClick={() => {
                    setMoreMenuOpen(false);
                    setUseDialogOpen(true);
                  }}
                  className="flex h-[34px] w-full items-center px-3 text-left text-[13px] text-ink hover:bg-accent-wash disabled:opacity-40 focus-visible:bg-accent-wash focus-visible:outline-none"
                >
                  Use in a project…
                </button>
                <button
                  type="button"
                  role="menuitem"
                  data-testid="editor-menu-settings"
                  onClick={() => {
                    setMoreMenuOpen(false);
                    selectOne(null);
                    setPanel("settings");
                  }}
                  className="flex h-[34px] w-full items-center px-3 text-left text-[13px] text-ink hover:bg-accent-wash focus-visible:bg-accent-wash focus-visible:outline-none"
                >
                  Workflow settings
                </button>
                <button
                  type="button"
                  role="menuitem"
                  disabled={readOnly}
                  data-testid="editor-menu-tidy"
                  onClick={() => {
                    setMoreMenuOpen(false);
                    studio.tidy();
                  }}
                  className="flex h-[34px] w-full items-center px-3 text-left text-[13px] text-ink hover:bg-accent-wash disabled:opacity-40 focus-visible:bg-accent-wash focus-visible:outline-none"
                >
                  Tidy up
                </button>
                <div role="separator" className="my-1 h-px bg-line-soft" />
                <button
                  type="button"
                  role="menuitem"
                  disabled={readOnly || !draftId || deleteDraft.isPending}
                  data-testid="editor-menu-discard"
                  onClick={() => void onDiscardDraft()}
                  className="flex h-[34px] w-full items-center px-3 text-left text-[13px] text-st-failed-tag-fg hover:bg-st-failed-pale-body disabled:opacity-40 focus-visible:bg-st-failed-pale-body focus-visible:outline-none"
                >
                  Discard draft
                </button>
              </div>
            ) : null}
          </div>
        </div>

        {/* Validation findings panel anchored under Make live */}
        {validateOpen ? (
          <div
            data-testid="studio-validate-drawer"
            className={
              phone
                ? "fixed inset-x-0 bottom-0 z-40 max-h-[75dvh] overflow-y-auto rounded-t-[18px] border-t border-line bg-surface p-4 shadow-[var(--shadow-modal)]"
                : "absolute right-4 top-[58px] z-30 max-h-[calc(100%-80px)] w-[360px] overflow-y-auto rounded-[12px] border border-line bg-surface p-3 shadow-[var(--shadow-pop)]"
            }
          >
            <div className="mb-2 flex items-center gap-2">
              <span className="font-mono text-[10.5px] font-semibold uppercase tracking-[.06em] text-muted">
                Validation
              </span>
              <button
                type="button"
                aria-label="Close validation findings"
                data-testid="studio-validate-close"
                onClick={() => setValidateOpen(false)}
                className="icon-hit ml-auto inline-flex h-[24px] w-[24px] items-center justify-center rounded-[6px] text-muted hover:bg-fill hover:text-ink"
              >
                <IconX size={15} stroke={1.5} aria-hidden />
              </button>
            </div>
            {validateFailure !== null ? (
              <ProblemBanner
                error={validateFailure}
                fallback="The draft could not be validated."
                testid="studio-validate-error"
              />
            ) : validateOutcome === null ? (
              <p className="font-mono text-[11px] text-muted" data-testid="studio-validate-pending">
                validating…
              </p>
            ) : (
              <>
                <p className="font-mono text-[11px] text-ink" data-testid="studio-validate-verdict">
                  {validateOutcome.valid
                    ? `valid — ${validateOutcome.errors.length} findings`
                    : `invalid — ${validateOutcome.errors.length} findings`}
                </p>
                {validateOutcome.errors.length > 0 ? (
                  <ul
                    className="mt-2 divide-y divide-line-soft"
                    data-testid="studio-validate-findings"
                  >
                    {validateOutcome.errors.map((issue, index) => (
                      <li
                        key={`${issue.code}-${index}`}
                        className="flex items-start gap-[8px] py-[6px]"
                        data-testid={`studio-validate-finding-${index}`}
                      >
                        <span className="min-w-0 flex-1 font-mono text-[11px] text-muted">
                          <span className="text-ink">{issue.code}</span> · {issue.message}
                        </span>
                        {issue.instance_location !== null ? (
                          <SoftButton
                            variant="ghost"
                            compact
                            data-testid={`studio-goto-node-${index}`}
                            onClick={() => goToNode(issue.instance_location)}
                          >
                            go to node
                          </SoftButton>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </>
            )}
          </div>
        ) : null}

        {/* Versions panel */}
        {versionsOpen ? (
          <div
            className={phone ? "fixed inset-x-0 bottom-0 z-40" : "absolute right-4 top-[58px] z-30"}
          >
            <VersionsPanel
              revisions={revisions}
              baseDocument={baseDocument}
              draftText={studio.text}
              hasDraft={Boolean(draftId && status !== "published")}
              viewingDigest={viewingDigest}
              canAuthor={canAuthor}
              runCountsByDigest={runCountsByDigest}
              actorName={(id) => actorLabel({ kind: "human", id })}
              onSelectDraft={() => setViewingDigest(null)}
              onSelectRevision={(digest) => setViewingDigest(digest)}
              onRestoreRevision={(rev) => void onRestoreRevision(rev)}
              onClose={() => setPanel(null)}
              sheet={phone}
              restoring={createDraft.isPending}
            />
          </div>
        ) : null}

        {/* ?panel=yaml, ?panel=inputs, or ?panel=used-in */}
        {panelParam === "yaml" || panelParam === "used-in" || panelParam === "inputs" ? (
          <div
            data-testid={`editor-panel-${panelParam}`}
            className={
              phone
                ? panelParam === "yaml" || panelParam === "inputs"
                  ? "fixed inset-x-0 top-0 bottom-0 z-40 flex flex-col overflow-y-auto bg-surface p-4"
                  : "fixed inset-x-0 bottom-0 z-40 max-h-[80dvh] overflow-y-auto rounded-t-[18px] border-t border-line bg-surface p-4 shadow-[var(--shadow-modal)]"
                : panelParam === "yaml" || panelParam === "inputs"
                  ? "absolute right-4 top-[58px] bottom-4 z-30 flex w-[520px] max-w-[calc(100%-32px)] flex-col overflow-y-auto rounded-[12px] border border-line bg-surface p-3 shadow-[var(--shadow-pop)]"
                  : "absolute right-4 top-[58px] z-30 max-h-[calc(100%-74px)] w-[420px] overflow-y-auto rounded-[12px] border border-line bg-surface p-3 shadow-[var(--shadow-pop)]"
            }
          >
            <div className="mb-2 flex items-center justify-end">
              <button
                type="button"
                aria-label="Close panel"
                data-testid="editor-panel-close"
                onClick={() => setPanel(null)}
                className="icon-hit inline-flex h-[24px] w-[24px] items-center justify-center rounded-[6px] text-muted hover:bg-fill hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
              >
                <IconX size={16} stroke={1.5} aria-hidden />
              </button>
            </div>
            {panelParam === "yaml" ? (
              yamlEditable ? (
                <YamlEditPanel
                  text={studio.text}
                  status={status}
                  dirty={studio.dirty}
                  saving={studio.saving}
                  validating={validate.isPending}
                  parseError={parseError}
                  verdict={yamlVerdict}
                  validateError={validateFailure}
                  onChange={(next) => {
                    setValidateOutcome(null);
                    setValidateFailure(null);
                    studio.setText(next);
                  }}
                  onValidate={() => void onValidateYaml()}
                  onGoToNode={goToNode}
                />
              ) : (
                <YamlView
                  text={
                    isViewingRun
                      ? runDocumentText
                      : isViewingHistory
                        ? viewDocumentText
                        : studio.text
                  }
                  filename={
                    // A published revision's file carries its number
                    // (`<slug>-r<n>.yaml`); a draft's is the bare slug.
                    isViewingHistory && viewingRevision.data
                      ? `${pipeline.data?.slug ?? pipelineId}-r${viewingRevision.data.revision_number}.yaml`
                      : `${pipeline.data?.slug ?? pipelineId}.yaml`
                  }
                />
              )
            ) : panelParam === "inputs" ? (
              <StudioInputsDrawer
                pipelineId={pipelineId}
                slug={pipeline.data?.slug ?? pipelineId}
                canAuthor={canAuthor}
                revision={newestRevision.data}
                revisionLoading={newestRevision.isPending && newestSummary !== null}
                revisionError={newestRevision.isError ? newestRevision.error : null}
                onRevisionRetry={() => void newestRevision.refetch()}
                openDraft={draft.data ? viewDraftSummary(draft.data) : null}
              />
            ) : (
              <StudioUsedInDrawer
                pipelineId={pipelineId}
                revisionRows={revisions}
                newestPublished={newestSummary ? viewRevisionSummary(newestSummary) : null}
                newestPublishedId={newestPublishedId}
              />
            )}
          </div>
        ) : null}

        {/* Floating full StudioInspector (non-agent steps, "More settings", or Workflow settings) */}
        {showStepInspector || showSettingsInspector ? (
          <aside
            data-testid="editor-inspector-panel"
            className={
              phone
                ? "fixed inset-x-0 bottom-0 z-40 max-h-[75dvh] overflow-y-auto rounded-t-[18px] border-t border-line bg-surface shadow-[var(--shadow-modal)]"
                : "absolute right-4 top-[64px] z-20 max-h-[calc(100%-80px)] w-[360px] overflow-hidden rounded-[12px] border border-line bg-surface shadow-[var(--shadow-pop)]"
            }
          >
            {inspectorPanel}
          </aside>
        ) : null}
      </div>

      {ambiguity !== null ? (
        <AmbiguityDialog
          title={ambiguity.title}
          reasons={ambiguity.reasons}
          onInsertAnyway={ambiguity.rerun}
          onCancel={() => setAmbiguity(null)}
        />
      ) : null}

      {tryItOpen ? <StartRunDialog onClose={() => setTryItOpen(false)} /> : null}

      <TriggersDialog
        open={triggersDialogOpen}
        onClose={() => setTriggersDialogOpen(false)}
        assignments={triggers.groups}
        editing={null}
      />

      <UseInRepoDialog
        open={useDialogOpen}
        onClose={() => setUseDialogOpen(false)}
        pipelineId={pipelineId}
        workflowName={pipelineName}
        newestPublished={newestSummary ? viewRevisionSummary(newestSummary) : null}
        revisions={revisions}
        initialProjectId={scope ?? undefined}
        onAssigned={() => setPanel("used-in")}
      />
    </div>
  );
}

export default StudioPage;
