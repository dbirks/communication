/**
 * useStudioTriggers — reads the workflow's project assignments, schedules,
 * repositories, and issue triggers so the editor can draw the synthetic
 * Trigger node and open `TriggersDialog` directly from it.
 */
import { useQueries } from "@tanstack/react-query";
import { apiFetch } from "../../api/client";
import { schedulesQueryOptions, type Schedule } from "../../api/pipelines";
import { queryKeys, useProjects } from "../../api/queries";
import type { AssignmentList, RepositoryList } from "../../api/types";
import { issueTriggersQueryOptions } from "../../api/useIssueTriggers";
import { triggerSentence } from "../factory/factoryData";
import type { TriggerGroup } from "../workflows/Triggers";

export interface StudioTriggersState {
  groups: TriggerGroup[];
  subline: string | null;
  firstEditing: { group: TriggerGroup; schedule: Schedule } | null;
}

export function useStudioTriggers(pipelineId: string, enabled = true): StudioTriggersState {
  const projects = useProjects();
  const projectItems = enabled && pipelineId ? (projects.data?.items ?? []) : [];

  const assignmentLists = useQueries({
    queries: projectItems.map((project) => ({
      queryKey: queryKeys.assignments(project.id),
      queryFn: () => apiFetch<AssignmentList>(`/api/v1/projects/${project.id}/assignments`),
      enabled: enabled && pipelineId.length > 0,
    })),
  });

  const pinsPipeline = projectItems.map((_project, index) =>
    (assignmentLists[index]?.data?.assignments ?? []).some(
      (candidate) => candidate.pipeline_id === pipelineId,
    ),
  );

  const scheduleLists = useQueries({
    queries: projectItems.map((project, index) =>
      schedulesQueryOptions(project.id, enabled && pinsPipeline[index]),
    ),
  });

  const repoLists = useQueries({
    queries: projectItems.map((project, index) => ({
      queryKey: queryKeys.repos(project.id),
      queryFn: () => apiFetch<RepositoryList>(`/api/v1/projects/${project.id}/repos`),
      enabled: enabled && pinsPipeline[index],
    })),
  });

  const issueTriggerLists = useQueries({
    queries: projectItems.map((project, index) =>
      issueTriggersQueryOptions(project.id, enabled && pinsPipeline[index]),
    ),
  });

  const groups: TriggerGroup[] = [];
  projectItems.forEach((project, index) => {
    const list = assignmentLists[index]?.data;
    const assignment =
      list?.assignments?.find((candidate) => candidate.pipeline_id === pipelineId) ?? null;
    if (!assignment) return;
    groups.push({
      project,
      assignment,
      schedules: (scheduleLists[index]?.data?.schedules ?? []).filter(
        (s) => s.assignment_id === assignment.id,
      ),
      issueTriggers: (issueTriggerLists[index]?.data?.issue_triggers ?? []).filter(
        (t) => t.assignment_id === assignment.id,
      ),
      repositories: repoLists[index]?.data?.items ?? [],
      canManage: project.my_role === "maintainer",
    });
  });

  if (groups.length === 0) {
    return { groups, subline: null, firstEditing: null };
  }

  const crons = groups.flatMap((g) => g.schedules.filter((s) => s.enabled).map((s) => s.cron_expr));
  const issueFacts = groups.flatMap((g) =>
    g.issueTriggers.filter((t) => t.enabled).map((t) => ({ event: t.event, labels: t.labels })),
  );
  const { text } = triggerSentence(crons, issueFacts);
  const firstGroupWithSchedule = groups.find((g) => g.schedules.length > 0) ?? null;
  const firstEditing =
    firstGroupWithSchedule && firstGroupWithSchedule.schedules[0]
      ? { group: firstGroupWithSchedule, schedule: firstGroupWithSchedule.schedules[0] }
      : null;

  return { groups, subline: text, firstEditing };
}
