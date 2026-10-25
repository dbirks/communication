/**
 * The "used in" fan-out for the workflow page (design 2a): every project the
 * caller belongs to that pins this pipeline, with the triggers that
 * assignment carries and the runs it started.
 *
 * This is the read-only sibling of the fan-out `components/workflows/Triggers.tsx`
 * does for editing — same routes, same query keys (so the caches are shared),
 * but grouped per ASSIGNMENT ROW rather than per project: since ADR-0060 a
 * project can use one pipeline in several repositories, and each repo pin is
 * its own row with its own schedules and issue triggers. Runs ride the one
 * cross-project list the board already serves
 * (`GET /api/v1/runs?pipeline_id=`, ADR-0047/0060) — newest first, so the
 * first run that names an assignment is that row's last run.
 *
 * Nothing is invented: a project whose lists have not arrived contributes no
 * row (`loading` covers it), and a project whose lists failed is surfaced as
 * `error` rather than as "not used".
 */
import { useQueries, useQuery } from "@tanstack/react-query";
import { apiFetch } from "../../api/client";
import { queryKeys, useProjects } from "../../api/queries";
import { schedulesQueryOptions, type Schedule } from "../../api/pipelines";
import { issueTriggersQueryOptions, type IssueTrigger } from "../../api/useIssueTriggers";
import type { CrossProjectRunList } from "../../api/board";
import type {
  Assignment,
  AssignmentList,
  Project,
  Repository,
  RepositoryList,
} from "../../api/types";

/** The page's one runs read; every block (rail LAST RUNS, the Used-in rows'
 * last run) projects this same page of newest-first rows. */
export function usePipelineRuns(pipelineId: string) {
  return useQuery({
    queryKey: ["pipeline", pipelineId, "runs"] as const,
    queryFn: () =>
      apiFetch<CrossProjectRunList>(
        `/api/v1/runs?pipeline_id=${encodeURIComponent(pipelineId)}&limit=200`,
      ),
    enabled: pipelineId.length > 0,
  });
}

/** One repo pin (ADR-0060): an assignment + its project, its watched
 * repository list, the triggers that pin carries, and its runs. */
export interface UsedInGroup {
  project: Project;
  assignment: Assignment;
  /** The project's repositories — a trigger row names the watched repo by id. */
  repositories: Repository[];
  schedules: Schedule[];
  issueTriggers: IssueTrigger[];
  /** This assignment's runs, newest first (the server's own order). */
  runs: CrossProjectRunList["runs"];
  /** Both trigger reads for this project settled with data. */
  triggersArrived: boolean;
  /** A trigger read for this project failed — "started by hand" is then not
   * a fact the page may state. */
  triggersError: boolean;
}

export interface UsedInFacts {
  groups: UsedInGroup[];
  /** A read the rows need is still in flight. */
  loading: boolean;
  /** A read the rows need failed — say so rather than under-counting. */
  error: boolean;
}

export function useUsedIn(pipelineId: string): UsedInFacts {
  const projects = useProjects();
  const projectItems = projects.data?.items ?? [];
  const assignmentLists = useQueries({
    queries: projectItems.map((project) => ({
      queryKey: queryKeys.assignments(project.id),
      queryFn: () => apiFetch<AssignmentList>(`/api/v1/projects/${project.id}/assignments`),
    })),
  });
  // A project pins the pipeline exactly when its arrived list says so; the
  // per-project trigger/repo reads arm on that answer.
  const pinsPipeline = projectItems.map((_project, index) =>
    (assignmentLists[index]?.data?.assignments ?? []).some(
      (candidate) => candidate.pipeline_id === pipelineId,
    ),
  );
  const scheduleLists = useQueries({
    queries: projectItems.map((project, index) =>
      schedulesQueryOptions(project.id, pinsPipeline[index]),
    ),
  });
  const repoLists = useQueries({
    queries: projectItems.map((project, index) => ({
      queryKey: queryKeys.repos(project.id),
      queryFn: () => apiFetch<RepositoryList>(`/api/v1/projects/${project.id}/repos`),
      enabled: pinsPipeline[index],
    })),
  });
  const issueTriggerLists = useQueries({
    queries: projectItems.map((project, index) =>
      issueTriggersQueryOptions(project.id, pinsPipeline[index]),
    ),
  });
  const runs = usePipelineRuns(pipelineId);

  // Rows: one per assignment that pins this pipeline, in the caller's own
  // project order. A list that has not arrived yet contributes nothing —
  // loading is not "not used".
  const groups: UsedInGroup[] = [];
  projectItems.forEach((project, index) => {
    const list = assignmentLists[index]?.data;
    if (!list) return;
    for (const assignment of list.assignments) {
      if (assignment.pipeline_id !== pipelineId) continue;
      groups.push({
        project,
        assignment,
        repositories: repoLists[index]?.data?.items ?? [],
        schedules: (scheduleLists[index]?.data?.schedules ?? []).filter(
          (schedule) => schedule.assignment_id === assignment.id,
        ),
        issueTriggers: (issueTriggerLists[index]?.data?.issue_triggers ?? []).filter(
          (trigger) => trigger.assignment_id === assignment.id,
        ),
        runs: (runs.data?.runs ?? []).filter((run) => run.assignment_id === assignment.id),
        triggersArrived:
          scheduleLists[index]?.data !== undefined && issueTriggerLists[index]?.data !== undefined,
        triggersError:
          scheduleLists[index]?.isError === true || issueTriggerLists[index]?.isError === true,
      });
    }
  });

  const loading =
    projects.isPending ||
    projectItems.some((_project, index) => assignmentLists[index]?.isPending) ||
    runs.isPending;
  const error =
    projects.isError ||
    projectItems.some((_project, index) => assignmentLists[index]?.isError) ||
    runs.isError;
  return { groups, loading, error };
}
