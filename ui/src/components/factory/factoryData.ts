/**
 * factoryData.ts — the one read the Factory index is built from (redesign R4,
 * docs/design/redesign/CONTRACT.md "Routes and scope").
 *
 * Same reads the Workflows index (`pages/Workflows.tsx` `LibraryPage`) makes —
 * the pipeline list, each definition, its latest revision's canonical document,
 * its drafts, and the per-project assignment/schedule fan — plus
 * `useBoardRuns` for the live runs whose step states colour the thumbnail. The
 * old index's filtering UI (search, folders, chips) is deliberately NOT copied:
 * the Factory index is a glance, not a library.
 *
 * Honesty rules, inherited from `components/workflows/WorkflowRow`:
 * - A step chip names a TOP-LEVEL node of the latest published revision's own
 *   document, in document order; a scope node folds to one `loop:` chip.
 *   Nothing is invented for a workflow that has never published — its strip
 *   carries only the trigger chip.
 * - The trigger sentence is built from the facts the row already words (the
 *   enabled cron of an assignment, the enabled issue triggers) and from
 *   `lib/cronText` — never a second cron parser.
 * - A step's state is the newest LIVE run's projection of that step
 *   (`CrossProjectRunStep.state`); with no live run every step is `idle`.
 * - Scope is a project id: only the workflows that project's assignments pin
 *   are listed, and only that project's runs drive their state.
 */
import { useQueries } from "@tanstack/react-query";
import { apiFetch } from "../../api/client";
import { viewRevisionSummary } from "../../api/m4view";
import { queryKeys, useProjects } from "../../api/queries";
import { useBoardRuns } from "../../api/board";
import type { CrossProjectRunSummary } from "../../api/home";
import {
  pipelineDraftsQueryOptions,
  pipelineQueryOptions,
  revisionQueryOptions,
  schedulesQueryOptions,
  usePipelines,
  workflowRowFacts,
} from "../../api/pipelines";
import type { ScheduleList } from "../../api/pipelines";
import { issueTriggersQueryOptions } from "../../api/useIssueTriggers";
import type { IssueTrigger, IssueTriggerList } from "../../api/useIssueTriggers";
import type { AssignmentList, PipelineSummary, Project } from "../../api/types";
import {
  SCOPE_KINDS,
  isDefinitionDocument,
  kindWord,
  scopeBody,
} from "../../lib/pipeline/definition";
import type { DefinitionDocument } from "../../lib/pipeline/definition";
import { cronInWords } from "../../lib/cronText";
import { issueEventText } from "../workflows/IssueTriggerRow";
import type { TriggerGroup } from "../workflows/Triggers";
import type { UsedInRevision } from "../workflows/UsedIn";

/* ------------------------------------------------------------- view model */

/** The six shapes a thumbnail chip draws: the trigger, and five step families. */
export type ThumbStepKind = "trigger" | "agent" | "command" | "approval" | "git" | "other";

/** The five states a chip can be in. `idle` is "no live run says otherwise". */
export type ThumbStepState = "idle" | "running" | "waiting" | "done" | "failed";

export interface ThumbStep {
  id: string;
  /** The chip's text: a node id, the trigger word, or a `+N` overflow. */
  label: string;
  kind: ThumbStepKind;
  state: ThumbStepState;
}

export interface FactoryWorkflowItem {
  pipeline: PipelineSummary;
  /** The thumbnail strip: the trigger chip first, then the document's steps. */
  steps: ThumbStep[];
  /** Lower-case plain English, e.g. "every weekday at 09:00 UTC". */
  triggerText: string;
  /** That workflow's live runs (newest first) in the page's scope. */
  liveRuns: CrossProjectRunSummary[];
  /** Un-published drafts the pipeline carries. */
  draftCount: number;
  /** Display names of the projects whose assignments pin this workflow. */
  usedIn: string[];
  /** The newest run of this workflow in scope (any state), or null. */
  lastRunAt: string | null;
  /** Project assignment groups with schedules and issue triggers for TriggersDialog. */
  triggerGroups?: TriggerGroup[];
  /** Pipeline revision summaries for UseInRepoDialog. */
  revisions?: UsedInRevision[];
  /** Newest published revision summary for UseInRepoDialog, or null if unpublished. */
  newestPublished?: UsedInRevision | null;
  /** True once all project assignment lists have settled without error. */
  assignmentsResolved?: boolean;
}

export interface FactoryWorkflows {
  items: FactoryWorkflowItem[];
  /** Every live run the scope can see (the header's counts). */
  liveRuns: CrossProjectRunSummary[];
  /** True while the list — or, in a project scope, its assignment read — is in flight. */
  isPending: boolean;
  /** The read that leaves this page with nothing to show, or null. */
  error: unknown;
  /** True when a per-row read (a definition, its latest revision, a draft list,
   * an assignment fan entry) broke: those rows carry less, so the page says so
   * in one line rather than presenting a thinner list as the whole truth. */
  rowsIncomplete: boolean;
}

/* ---------------------------------------------------------- pure mapping */

/** A catalogue kind onto the one thumbnail shape that draws it. A kind outside
 * the catalogue is `other` — the rule `lib/stepIcons` follows with its neutral
 * box: never invent a shape for something the document only names. */
export function thumbStepKind(nodeKind: string): ThumbStepKind {
  if (nodeKind === "agent.acp" || nodeKind === "model.chat") return "agent";
  if (nodeKind === "process.exec") return "command";
  if (nodeKind === "human.approval" || nodeKind === "gate") return "approval";
  if (nodeKind === "git.commit" || nodeKind === "git.publish") return "git";
  return "other";
}

/** The chip ceiling of one thumbnail card, trigger chip included. */
export const THUMB_STEP_LIMIT = 6;

/**
 * The document's TOP-LEVEL nodes in document order, as chips without a state.
 * A scope node (`until` / `for_each` / `parallel`) collapses to one shaded
 * `loop: <child> · <child>…` chip naming the document's own child ids — the
 * index row's rule, so the thumbnail and the row never disagree about a loop.
 */
export function documentStepChips(doc: DefinitionDocument | null): Omit<ThumbStep, "state">[] {
  if (!doc) return [];
  const chips: Omit<ThumbStep, "state">[] = [];
  for (const node of doc.spec.nodes) {
    if ((SCOPE_KINDS as readonly string[]).includes(node.kind)) {
      const children = scopeBody(node)
        .map((child) => child.id)
        .join(" · ");
      chips.push({
        id: node.id,
        label: children.length > 0 ? `loop: ${children}` : kindWord(node.kind),
        kind: thumbStepKind(node.kind),
      });
    } else {
      chips.push({ id: node.id, label: node.id, kind: thumbStepKind(node.kind) });
    }
  }
  return chips;
}

/** Cap the strip at {@link THUMB_STEP_LIMIT} chips: when the document has more
 * top-level nodes, the last chip is the overflow `+N`. */
export function capStepChips(chips: Omit<ThumbStep, "state">[]): Omit<ThumbStep, "state">[] {
  if (chips.length <= THUMB_STEP_LIMIT) return chips;
  const shown = chips.slice(0, THUMB_STEP_LIMIT - 1);
  return [
    ...shown,
    {
      id: `+${chips.length - shown.length}`,
      label: `+${chips.length - shown.length}`,
      kind: "other" as const,
    },
  ];
}

/** The trigger chip's word — the one fact that decides how a run starts. */
export type TriggerWord = "manual" | "issue" | "schedule";

/** An issue trigger reduced to what the sentence needs. */
export interface TriggerFact {
  event: IssueTrigger["event"];
  labels: string[];
}

/**
 * The trigger sentence and the chip's word, from the facts the Workflows row
 * words today. An enabled issue trigger wins (it is the more specific promise),
 * then an enabled cron — read by `lib/cronText`, not by a second parser — then
 * the honest `when you start it`.
 */
export function triggerSentence(
  crons: (string | null)[],
  triggers: TriggerFact[] = [],
): { text: string; word: TriggerWord } {
  const [first] = triggers;
  if (first) {
    if (first.labels.length > 0) {
      const labels = first.labels.map((label) => `'${label}'`).join(", ");
      return { text: `when an issue gets ${labels}`, word: "issue" };
    }
    return { text: issueEventText(first.event), word: "issue" };
  }
  const cron = crons.find((expr): expr is string => typeof expr === "string" && expr.trim() !== "");
  if (cron) return { text: cronInWords(cron), word: "schedule" };
  return { text: "when you start it", word: "manual" };
}

/** The wire's seven step states onto the thumbnail's five. `pending` has not
 * started and is not settled, so it is `idle`; a cancelled step did not
 * complete, so it reads as `failed` (the board's own reading). */
export function thumbStateOfRunStep(
  state: CrossProjectRunSummary["steps"][number]["state"],
): ThumbStepState {
  switch (state) {
    case "running":
      return "running";
    case "waiting":
      return "waiting";
    case "succeeded":
    case "skipped":
      return "done";
    case "failed":
    case "cancelled":
      return "failed";
    default:
      return "idle";
  }
}

/**
 * Paint the newest live run's states onto the chips, matched by node id — the
 * run's projection is the only source: a step it passed is `done`, the step it
 * sits on is `running`, the gate it waits on is `waiting`. The trigger chip
 * carries the run's own state (a live run did start; a `waiting_human` one is
 * held). With no run, every chip keeps the `idle` it arrived with.
 */
export function applyRunStates(
  steps: ThumbStep[],
  run: CrossProjectRunSummary | null | undefined,
): ThumbStep[] {
  if (!run) return steps;
  const byId = new Map(run.steps.map((step) => [step.node_id, step.state]));
  const waitingRun = run.status === "waiting_human" || run.status === "paused";
  return steps.map((step) => {
    if (step.kind === "trigger") {
      return {
        ...step,
        state: waitingRun ? ("waiting" as ThumbStepState) : ("running" as ThumbStepState),
      };
    }
    const observed = byId.get(step.id);
    if (observed === undefined) return step;
    return { ...step, state: thumbStateOfRunStep(observed) };
  });
}

/** The strip's `aria-label`: how many steps, and the one that needs the eye. */
export function thumbAriaLabel(steps: ThumbStep[]): string {
  const stepChips = steps.filter((step) => step.kind !== "trigger");
  const base = `${stepChips.length} ${stepChips.length === 1 ? "step" : "steps"}`;
  const waiting = stepChips.find((step) => step.state === "waiting");
  if (waiting) return `${base}; step '${waiting.label}' is waiting on an approval`;
  const running = stepChips.find((step) => step.state === "running");
  if (running) return `${base}; step '${running.label}' is running`;
  return base;
}

/* ------------------------------------------------------------------ hook */

/** Statuses that mean the run is still going. */
export const LIVE_RUN_STATUSES: ReadonlySet<string> = new Set([
  "queued",
  "preparing",
  "running",
  "waiting_human",
  "paused",
]);

export function isLiveRun(run: CrossProjectRunSummary): boolean {
  return LIVE_RUN_STATUSES.has(run.status);
}

/** The enabled issue triggers of the assignments this workflow pins. */
export function triggersForAssignments(
  assignmentIds: ReadonlySet<string>,
  lists: (IssueTriggerList | undefined)[],
): IssueTrigger[] {
  const out: IssueTrigger[] = [];
  for (const list of lists) {
    for (const trigger of list?.issue_triggers ?? []) {
      if (trigger.enabled && assignmentIds.has(trigger.assignment_id)) out.push(trigger);
    }
  }
  return out;
}

/** A document only as far as the step strip can read it. */
function asDocument(value: unknown): DefinitionDocument | null {
  return isDefinitionDocument(value) ? value : null;
}

/**
 * The Factory index's data for one scope: a project id, or null for All
 * projects.
 */
export function useFactoryWorkflows(scope: string | null): FactoryWorkflows {
  const pipelines = usePipelines();
  const projects = useProjects();

  const rows = pipelines.data?.pipelines ?? [];
  const ids = rows.map((pipeline) => pipeline.id);
  // One fan keyed exactly like the single-read hooks (as the project page
  // does), so every screen that reads a workflow shares one cache entry.
  const definitions = useQueries({ queries: ids.map(pipelineQueryOptions) });
  const draftsList = useQueries({ queries: ids.map(pipelineDraftsQueryOptions) });
  // The step strip needs the latest revision's canonical document: route 13
  // resolves a digest, so the fan keys on each row's newest summary digest —
  // DEDUPLICATED first. Two workflows can pin the same revision, and a fan
  // that asks for one digest twice registers the query key twice (the
  // "Duplicate Queries found" warning), which is noise the shared cache makes
  // for free. A row with nothing published asks for nothing.
  const latestDigests = rows.map(
    (_pipeline, index) => definitions[index]?.data?.revisions[0]?.revision_digest ?? "",
  );
  const uniqueDigests = [...new Set(latestDigests.filter((digest) => digest !== ""))];
  const revisionFan = useQueries({ queries: uniqueDigests.map(revisionQueryOptions) });
  const revisionByDigest = new Map(
    uniqueDigests.map((digest, index) => [digest, revisionFan[index]]),
  );

  const projectItems = (projects.data?.items ?? []) as Project[];
  const indexIds = new Set(ids);
  const assignmentsFan = useQueries({
    queries: projectItems.map((project) => ({
      queryKey: queryKeys.assignments(project.id),
      queryFn: () => apiFetch<AssignmentList>(`/api/v1/projects/${project.id}/assignments`),
    })),
  });
  // A `manual`-only project costs one assignments read, not three.
  const pinnedHere = (index: number) =>
    (assignmentsFan[index]?.data?.assignments ?? []).some((assignment) =>
      indexIds.has(assignment.pipeline_id),
    );
  const schedulesFan = useQueries({
    queries: projectItems.map((project, index) =>
      schedulesQueryOptions(project.id, pinnedHere(index)),
    ),
  });
  const issueTriggersFan = useQueries({
    queries: projectItems.map((project, index) =>
      issueTriggersQueryOptions(project.id, pinnedHere(index)),
    ),
  });

  const runs = useBoardRuns(scope ? { projectId: scope } : {});
  const allRuns = runs.data?.runs ?? [];
  const liveRunsAll = allRuns.filter(isLiveRun);

  const assignmentLists = assignmentsFan.map((entry) => entry?.data) as (
    | AssignmentList
    | undefined
  )[];
  const scheduleLists = schedulesFan.map((entry) => entry?.data) as (ScheduleList | undefined)[];
  const triggerLists = issueTriggersFan.map((entry) => entry?.data) as (
    | IssueTriggerList
    | undefined
  )[];

  const items: FactoryWorkflowItem[] = [];
  rows.forEach((pipeline, index) => {
    const facts = workflowRowFacts(projectItems, assignmentLists, scheduleLists, pipeline.id);
    // In a project scope the index lists what that project pins and nothing
    // else: a workflow the project never assigned is not this project's.
    if (scope !== null && !facts.assigned.some((entry) => entry.project.id === scope)) return;

    const document = asDocument(
      revisionByDigest.get(latestDigests[index] ?? "")?.data?.canonical_document,
    );
    const chips = capStepChips(documentStepChips(document));
    const assignmentIds = new Set(facts.assigned.map((entry) => entry.assignment.id));
    const trigger = triggerSentence(
      facts.assigned.map((entry) => entry.cron),
      triggersForAssignments(assignmentIds, triggerLists),
    );
    const runsForPipeline = allRuns.filter((run) => run.pipeline_id === pipeline.id);
    const live = runsForPipeline.filter(isLiveRun);
    const steps: ThumbStep[] = [
      { id: "trigger", label: trigger.word, kind: "trigger", state: "idle" },
      ...chips.map((chip) => ({ ...chip, state: "idle" as ThumbStepState })),
    ];
    const triggerGroups: TriggerGroup[] = [];
    projectItems.forEach((project, pIndex) => {
      if (scope !== null && project.id !== scope) return;
      const assignment = assignmentLists[pIndex]?.assignments.find(
        (candidate) => candidate.pipeline_id === pipeline.id,
      );
      if (!assignment) return;
      triggerGroups.push({
        project,
        assignment,
        schedules: (scheduleLists[pIndex]?.schedules ?? []).filter(
          (s) => s.assignment_id === assignment.id,
        ),
        issueTriggers: (triggerLists[pIndex]?.issue_triggers ?? []).filter(
          (t) => t.assignment_id === assignment.id,
        ),
        repositories: [],
        canManage: project.my_role === "maintainer",
      });
    });
    const revisions = (definitions[index]?.data?.revisions ?? []).map(viewRevisionSummary);
    const newestPublished = revisions.find((row) => row.status === "published") ?? null;
    items.push({
      pipeline,
      steps: applyRunStates(steps, live[0]),
      triggerText: trigger.text,
      liveRuns: live,
      draftCount: (draftsList[index]?.data?.drafts ?? []).filter(
        (draft) => draft.status !== "published",
      ).length,
      usedIn: facts.assigned.map((entry) => entry.project.name),
      lastRunAt: runsForPipeline[0]?.created_at ?? null,
      triggerGroups,
      revisions,
      newestPublished,
      assignmentsResolved:
        !projects.isPending &&
        !projects.isError &&
        assignmentsFan.every((entry) => entry.isSuccess),
    });
  });

  const listed = new Set(items.map((item) => item.pipeline.id));
  const scopedLiveRuns = liveRunsAll.filter((run) => listed.has(run.pipeline_id));
  // A per-row read that failed costs that row its detail, not the page: the
  // strip then carries the trigger alone, which is true as far as it goes. The
  // page's error is the one read that leaves it with nothing to show at all.
  const rowsIncomplete =
    [...definitions, ...revisionFan, ...draftsList, ...assignmentsFan].some(
      (entry) => entry.isError,
    ) ||
    projects.isError ||
    runs.isError;
  return {
    items,
    liveRuns: scopedLiveRuns,
    isPending:
      pipelines.isPending ||
      projects.isPending ||
      (scope !== null && assignmentsFan.some((entry) => entry.isPending)),
    error: pipelines.error ?? null,
    rowsIncomplete,
  };
}
