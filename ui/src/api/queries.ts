/**
 * TanStack Query access to the M1 read endpoints and mutations. Every read in
 * the app goes through one of these hooks so the SSE feed can invalidate a whole
 * project subtree by key.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch, setCsrfToken } from "./client";
import type {
  Health,
  Member,
  MemberList,
  Me,
  MemberRole,
  Project,
  ProjectCreate,
  ProjectList,
  Readiness,
  Repository,
  RepositoryCreate,
  RepositoryList,
  UserList,
  WorkerList,
} from "./types";

export const queryKeys = {
  me: ["me"] as const,
  users: ["users"] as const,
  projectList: ["project-list"] as const,
  project: (projectId: string) => ["project", projectId] as const,
  repos: (projectId: string) => ["project", projectId, "repos"] as const,
  members: (projectId: string) => ["project", projectId, "members"] as const,
  health: ["system", "health"] as const,
  readiness: ["system", "readiness"] as const,
  workers: ["workers"] as const,
};

export function useMe() {
  return useQuery({
    queryKey: queryKeys.me,
    queryFn: async () => {
      const me = await apiFetch<Me>("/api/v1/me");
      setCsrfToken(me.csrf_token);
      return me;
    },
    staleTime: 30_000,
    retry: false,
  });
}

export function useUsers() {
  return useQuery({
    queryKey: queryKeys.users,
    queryFn: () => apiFetch<UserList>("/api/v1/users"),
  });
}

export function useProjects() {
  return useQuery({
    queryKey: queryKeys.projectList,
    queryFn: () => apiFetch<ProjectList>("/api/v1/projects"),
  });
}

export function useProject(projectId: string) {
  return useQuery({
    queryKey: queryKeys.project(projectId),
    queryFn: () => apiFetch<Project>(`/api/v1/projects/${projectId}`),
    enabled: projectId.length > 0,
  });
}

export function useRepositories(projectId: string) {
  return useQuery({
    queryKey: queryKeys.repos(projectId),
    queryFn: () => apiFetch<RepositoryList>(`/api/v1/projects/${projectId}/repos`),
    enabled: projectId.length > 0,
  });
}

export function useMembers(projectId: string) {
  return useQuery({
    queryKey: queryKeys.members(projectId),
    queryFn: () => apiFetch<MemberList>(`/api/v1/projects/${projectId}/members`),
    enabled: projectId.length > 0,
  });
}

export function useHealth() {
  return useQuery({
    queryKey: queryKeys.health,
    queryFn: () => apiFetch<Health>("/api/v1/system/health"),
    refetchInterval: 15_000,
  });
}

export function useReadiness() {
  return useQuery({
    queryKey: queryKeys.readiness,
    queryFn: () => apiFetch<Readiness>("/api/v1/system/readiness"),
    refetchInterval: 15_000,
    // A not-ready replica answers 503; show the problem rather than retry-loop.
    retry: false,
  });
}

export function useWorkers() {
  return useQuery({
    queryKey: queryKeys.workers,
    queryFn: () => apiFetch<WorkerList>("/api/v1/workers"),
  });
}

export function useCreateProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: ProjectCreate) =>
      apiFetch<Project>("/api/v1/projects", { method: "POST", json: body }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.projectList });
    },
  });
}

export function useAddRepository(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: RepositoryCreate) =>
      apiFetch<Repository>(`/api/v1/projects/${projectId}/repos`, {
        method: "POST",
        json: body,
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.repos(projectId) });
    },
  });
}

export function usePutMember(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: MemberRole }) =>
      apiFetch<Member>(`/api/v1/projects/${projectId}/members/${userId}`, {
        method: "PUT",
        json: { role },
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.members(projectId) });
    },
  });
}

/**
 * Forget cached reads for one project. Called for every SSE frame so a change
 * committed through *another* replica lands in this browser without a reload.
 */
export function invalidateProject(
  queryClient: ReturnType<typeof useQueryClient>,
  projectId: string,
) {
  return queryClient.invalidateQueries({ queryKey: queryKeys.project(projectId) });
}

/** Sign out: delete the session server-side, then forget everything cached. */
export function useLogout() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch<void>("/auth/logout", { method: "POST" }),
    onSuccess: async () => {
      setCsrfToken(null);
      queryClient.clear();
    },
  });
}
