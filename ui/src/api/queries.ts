/**
 * TanStack Query access to the read endpoints and mutations. Every read in the
 * app goes through one of these hooks so the SSE feeds can invalidate a whole
 * project (or conversation) subtree by key.
 *
 * M2 additions follow one rule from ADR-0016 §9: the browser never carries a
 * fencing token and never invents a `control.version` — it reads the version off
 * `getConversation` and echoes it, and when the server answers `409` the
 * returned `control` replaces the cached one rather than being retried over.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch, conversationConflictOf, setCsrfToken } from "./client";
import type {
  AgentProfileList,
  Conversation,
  ConversationCreate,
  ConversationMessageCreate,
  ConversationSummaryList,
  ConversationTurn,
  Health,
  Member,
  MemberList,
  Me,
  MemberRole,
  PermissionDecision,
  PermissionRequest,
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
  agentProfiles: ["agent-profiles"] as const,
  conversations: (projectId: string) => ["project", projectId, "conversations"] as const,
  conversation: (conversationId: string) => ["conversation", conversationId] as const,
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

export function useAgentProfiles() {
  return useQuery({
    queryKey: queryKeys.agentProfiles,
    queryFn: () => apiFetch<AgentProfileList>("/api/v1/agent-profiles"),
    staleTime: 60_000,
  });
}

export function useConversations(projectId: string) {
  return useQuery({
    queryKey: queryKeys.conversations(projectId),
    queryFn: () => apiFetch<ConversationSummaryList>(`/api/v1/projects/${projectId}/conversations`),
    enabled: projectId.length > 0,
  });
}

export function useConversation(conversationId: string) {
  return useQuery({
    queryKey: queryKeys.conversation(conversationId),
    queryFn: () => apiFetch<Conversation>(`/api/v1/conversations/${conversationId}`),
    enabled: conversationId.length > 0,
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

/**
 * Forget one conversation and the project list that shows its controller.
 * Called for every conversation SSE frame (ADR-0016: the transcript itself is
 * rendered from the stream, so this covers control/turn/permission state).
 */
export function invalidateConversation(
  queryClient: ReturnType<typeof useQueryClient>,
  conversationId: string,
  projectId?: string | null,
) {
  void queryClient.invalidateQueries({ queryKey: queryKeys.conversation(conversationId) });
  if (projectId) {
    void queryClient.invalidateQueries({ queryKey: queryKeys.conversations(projectId) });
  }
}

/** Write a fresh `Conversation` into the cache (control mutations return one). */
export function cacheConversation(
  queryClient: ReturnType<typeof useQueryClient>,
  conversation: Conversation,
) {
  queryClient.setQueryData(queryKeys.conversation(conversation.id), conversation);
}

/**
 * Adopt the `control` a `409` returned instead of retrying the mutation
 * (ADR-0016 §9 obligation 3). Returns true when the error carried a control row.
 */
export function adoptConflict(
  queryClient: ReturnType<typeof useQueryClient>,
  conversationId: string,
  error: unknown,
): boolean {
  const conflict = conversationConflictOf(error);
  if (!conflict) return false;
  queryClient.setQueryData<Conversation>(queryKeys.conversation(conversationId), (current) =>
    current
      ? {
          ...current,
          control: conflict.control,
          ...(conflict.active_turn ? { active_turn: conflict.active_turn } : {}),
        }
      : current,
  );
  return true;
}

/** Adopt the returned `control` instead of retrying (ADR-0016 §9 obligation 3). */
function useControlWrites(conversationId: string) {
  const queryClient = useQueryClient();
  return {
    queryClient,
    cache: (conversation: Conversation) => cacheConversation(queryClient, conversation),
    adopt: (error: unknown) => adoptConflict(queryClient, conversationId, error),
  };
}

export function useCreateConversation(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: ConversationCreate) =>
      apiFetch<Conversation>(`/api/v1/projects/${projectId}/conversations`, {
        method: "POST",
        json: body,
      }),
    onSuccess: async (conversation) => {
      // The caller holds control from this response on (`control.version` 1),
      // so the cached row already carries a usable CAS token.
      cacheConversation(queryClient, conversation);
      await queryClient.invalidateQueries({ queryKey: queryKeys.conversations(projectId) });
    },
  });
}

export function usePostConversationMessage(conversationId: string) {
  const { queryClient, adopt } = useControlWrites(conversationId);
  return useMutation({
    mutationFn: (body: ConversationMessageCreate) =>
      apiFetch<ConversationTurn>(`/api/v1/conversations/${conversationId}/messages`, {
        method: "POST",
        json: body,
      }),
    // The turn is queued, not answered: the reply arrives on the SSE stream.
    onSuccess: () => invalidateConversation(queryClient, conversationId),
    onError: adopt,
  });
}

export function useTakeConversationControl(conversationId: string) {
  const { cache, adopt } = useControlWrites(conversationId);
  return useMutation({
    mutationFn: (body: { version: number }) =>
      apiFetch<Conversation>(`/api/v1/conversations/${conversationId}/take-control`, {
        method: "POST",
        json: body,
      }),
    onSuccess: cache,
    // A 409 already carries the winner's control row: adopt it, do not retry.
    onError: adopt,
  });
}

export function useReturnConversationControl(conversationId: string) {
  const { cache, adopt } = useControlWrites(conversationId);
  return useMutation({
    mutationFn: (body: { version: number }) =>
      apiFetch<Conversation>(`/api/v1/conversations/${conversationId}/return-control`, {
        method: "POST",
        json: body,
      }),
    onSuccess: cache,
    onError: adopt,
  });
}

export function useCancelConversationTurn(conversationId: string) {
  const { queryClient, adopt } = useControlWrites(conversationId);
  return useMutation({
    mutationFn: () =>
      apiFetch<ConversationTurn>(`/api/v1/conversations/${conversationId}/cancel`, {
        method: "POST",
      }),
    onSuccess: () => invalidateConversation(queryClient, conversationId),
    onError: adopt,
  });
}

export function useDecideConversationPermission(conversationId: string) {
  const { queryClient, adopt } = useControlWrites(conversationId);
  return useMutation({
    mutationFn: ({ requestId, body }: { requestId: string; body: PermissionDecision }) =>
      apiFetch<PermissionRequest>(
        `/api/v1/conversations/${conversationId}/permissions/${requestId}`,
        { method: "POST", json: body },
      ),
    onSuccess: () => invalidateConversation(queryClient, conversationId),
    onError: adopt,
  });
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
