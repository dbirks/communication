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
import { agentProfileVersionsKey } from "./useProfileVersions";
import type { components } from "./schema";
import type {
  AgentProfile,
  AgentProfileList,
  Artifact,
  ArtifactList,
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
  PreviewToken,
  Project,
  ProjectCreate,
  ProjectList,
  Readiness,
  Repository,
  RepositoryCreate,
  RepositoryList,
  Secret,
  SecretCreate,
  SecretList,
  SecretMaterializationList,
  SecretMount,
  SecretMountCreate,
  SecretMountList,
  SecretUpdate,
  SecretVersionCreate,
  SecretVersionInfo,
  SystemSandbox,
  TurnSandbox,
  UserList,
  WorkerList,
  WorkspaceList,
  WorkspaceRepoStatus,
} from "./types";

export const queryKeys = {
  me: ["me"] as const,
  users: ["users"] as const,
  projectList: ["project-list"] as const,
  project: (projectId: string) => ["project", projectId] as const,
  repos: (projectId: string) => ["project", projectId, "repos"] as const,
  members: (projectId: string) => ["project", projectId, "members"] as const,
  agentProfiles: ["agent-profiles"] as const,
  conversations: (projectId: string, origin?: "manual" | "run", q?: string) =>
    ["project", projectId, "conversations", origin ?? null, q ?? null] as const,
  conversation: (conversationId: string) => ["conversation", conversationId] as const,
  health: ["system", "health"] as const,
  readiness: ["system", "readiness"] as const,
  workers: ["workers"] as const,
  /* M3. Everything project-scoped is keyed under `["project", projectId]`
   * so the one `invalidateProject` call the SSE feed already makes covers it
   * (`docs/design/data-dependencies.md` "Cache-key map"). */
  secrets: (projectId: string) => ["project", projectId, "secrets"] as const,
  secretMounts: (projectId: string) => ["project", projectId, "secret-mounts"] as const,
  materializations: (projectId: string, secretId: string) =>
    ["project", projectId, "secrets", secretId, "materializations"] as const,
  workspaces: (projectId: string) => ["project", projectId, "workspaces"] as const,
  workspace: (workspaceId: string) => ["workspace", workspaceId] as const,
  workspaceRepoStatus: (workspaceId: string, repositoryId: string) =>
    ["workspace", workspaceId, "repos", repositoryId] as const,
  artifacts: (projectId: string, conversationId?: string) =>
    conversationId
      ? (["project", projectId, "artifacts", "conversation", conversationId] as const)
      : (["project", projectId, "artifacts"] as const),
  artifact: (artifactId: string) => ["artifact", artifactId] as const,
  systemSandbox: ["system", "sandbox"] as const,
  turnSandbox: (turnId: string) => ["turn", turnId, "sandbox"] as const,
  /* M4. Project-scoped keys stay under `["project", projectId]` so the one
   * `invalidateProject` call the SSE feeds make covers runs/assignments/
   * approvals (`docs/design/data-dependencies.md` "Cache-key map"). The run
   * subtree `["run", runId]` covers nodes, tree and checkpoints by prefix. */
  pipelines: ["pipelines"] as const,
  pipeline: (pipelineId: string) => ["pipeline", pipelineId] as const,
  pipelineRevisions: (pipelineId: string) => ["pipeline", pipelineId, "revisions"] as const,
  pipelineDrafts: (pipelineId: string) => ["pipeline", pipelineId, "drafts"] as const,
  draft: (draftId: string) => ["draft", draftId] as const,
  revision: (digestOrId: string) => ["revision", digestOrId] as const,
  assignments: (projectId: string) => ["project", projectId, "assignments"] as const,
  runs: (projectId: string) => ["project", projectId, "runs"] as const,
  run: (runId: string) => ["run", runId] as const,
  runNodes: (runId: string) => ["run", runId, "nodes"] as const,
  runNode: (runId: string, nodeExecutionId: string) =>
    ["run", runId, "nodes", nodeExecutionId] as const,
  runTree: (runId: string) => ["run", runId, "tree"] as const,
  runCheckpoints: (runId: string) => ["run", runId, "checkpoints"] as const,
  attempt: (attemptId: string) => ["attempt", attemptId] as const,
  approvals: (projectId: string) => ["project", projectId, "approvals"] as const,
  approval: (approvalId: string) => ["approval", approvalId] as const,
  scheduler: ["system", "scheduler"] as const,
};

/**
 * The signed-in session. `options.enabled` lets a surface that must not touch
 * the network (the dev-only M4 fixture page, mounted outside the session gate)
 * opt out — the query key and cache behaviour are otherwise identical.
 */
export function useMe(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: queryKeys.me,
    queryFn: async () => {
      const me = await apiFetch<Me>("/api/v1/me");
      setCsrfToken(me.csrf_token);
      return me;
    },
    staleTime: 30_000,
    retry: false,
    enabled: options?.enabled ?? true,
  });
}

export function useUsers() {
  return useQuery({
    queryKey: queryKeys.users,
    queryFn: () => apiFetch<UserList>("/api/v1/users"),
  });
}

/**
 * Options a read caller may pass to make *its own* copy of a shared query
 * refresh on a timer. Only the caller that passes it is affected — every other
 * page using the same hook keeps the fetch-on-mount-and-invalidate behavior.
 * TanStack's default `refetchIntervalInBackground: false` means the timer only
 * fires while the tab is visible.
 */
export interface RefetchOptions {
  /** Milliseconds between background refreshes; omit to never poll. */
  refetchInterval?: number;
}

export function useProjects(options: RefetchOptions = {}) {
  return useQuery({
    queryKey: queryKeys.projectList,
    queryFn: () => apiFetch<ProjectList>("/api/v1/projects"),
    refetchInterval: options.refetchInterval,
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

/** `PATCH /api/v1/projects/{projectId}/repos/{repositoryId}` body (ADR-0061):
 * the credential member is required — a uuid sets it, `null` clears it — so a
 * body that named nothing could not answer 200 for a request that changed
 * nothing. The secret's VALUE has no representation on this surface. */
export type RepositoryPatch = components["schemas"]["RepositoryPatch"];

/**
 * `PATCH /api/v1/projects/{projectId}/repos/{repositoryId}` — ADR-0061's
 * "GitHub access": point the repository at one `integration_broker` secret of
 * this project (private clone/fetch and issue reads), or clear it to go back
 * to anonymous. Maintainer only; a reference the project may not make is `422`
 * `invalid_credential_secret`, which stays the mutation's error for the caller
 * to render — the server's words, never a dressed-up saved state.
 */
export function usePatchRepository(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ repositoryId, body }: { repositoryId: string; body: RepositoryPatch }) =>
      apiFetch<Repository>(`/api/v1/projects/${projectId}/repos/${repositoryId}`, {
        method: "PATCH",
        json: body,
      }),
    onSuccess: async (repository) => {
      const list = queryClient.getQueryData<RepositoryList>(queryKeys.repos(projectId));
      if (list) {
        queryClient.setQueryData(queryKeys.repos(projectId), {
          ...list,
          items: list.items.map((item) => (item.id === repository.id ? repository : item)),
        });
      }
      await queryClient.invalidateQueries({ queryKey: queryKeys.repos(projectId) });
    },
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

/** `POST /api/v1/agent-profiles` body — two fields, no `permission_mode`, no
 * `apm_*` (ADR-0030 §5: a new profile pins nothing). */
export type AgentProfileCreate = components["schemas"]["AgentProfileCreate"];

/** `PATCH /api/v1/agent-profiles/{profileId}` body — the APM triple, written
 * whole: all three set or all three cleared (`apm_pin_incomplete` otherwise). */
export type AgentProfileAPMPatch = components["schemas"]["AgentProfileAPMPatch"];

/**
 * Create a launch descriptor. Organization library role: a member without it
 * is `403`, a taken name is `409` — both render inline, nothing here guesses
 * `permission_mode` (ADR-0030 §5).
 */
export function useCreateAgentProfile() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: AgentProfileCreate) =>
      apiFetch<AgentProfile>("/api/v1/agent-profiles", { method: "POST", json: body }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.agentProfiles });
    },
  });
}

/**
 * Set or clear one profile's APM pin. The body must carry the triple as a unit
 * (`apm_pin_incomplete` is the server's refusal, never something filtered
 * client-side — the digest is the server's to check).
 */
export function usePatchAgentProfile(profileId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: AgentProfileAPMPatch) =>
      apiFetch<AgentProfile>(`/api/v1/agent-profiles/${profileId}`, {
        method: "PATCH",
        json: body,
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.agentProfiles });
      // ADR-0058: a versioned save LANDS A NEW VERSION — the HISTORY panel
      // reads `agent-profile-versions` (not a prefix of `agent-profiles`), so
      // without this the panel would keep showing the pre-save history.
      await queryClient.invalidateQueries({ queryKey: agentProfileVersionsKey(profileId) });
    },
  });
}

/** List filters (ADR-0043): where the conversation was opened and a case-
 * insensitive title substring. Both travel as `origin`/`q` query params. */
export interface ConversationListFilters {
  origin?: "manual" | "run";
  q?: string;
}

export function useConversations(projectId: string, filters: ConversationListFilters = {}) {
  const origin = filters.origin;
  const q = filters.q?.trim() ? filters.q.trim() : undefined;
  const search = new URLSearchParams();
  if (origin) search.set("origin", origin);
  if (q) search.set("q", q);
  const query = search.toString();
  return useQuery({
    queryKey: queryKeys.conversations(projectId, origin, q),
    queryFn: () =>
      apiFetch<ConversationSummaryList>(
        `/api/v1/projects/${projectId}/conversations${query ? `?${query}` : ""}`,
      ),
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

/* ------------------------------------------------------------------ M3 */

/**
 * Secret *references*: metadata only. There is deliberately no hook that could
 * return a value — the contract has no such route (`docs/m3-contract.md` §2:
 * "any route returning a secret value (including 'masked', 'last-4' or an admin
 * override" is on the deliberately-absent list), so no component state can hold
 * one and nothing can accidentally render it.
 */
export function useSecrets(projectId: string) {
  return useQuery({
    queryKey: queryKeys.secrets(projectId),
    queryFn: () => apiFetch<SecretList>(`/api/v1/projects/${projectId}/secrets`),
    enabled: projectId.length > 0,
  });
}

export function useCreateSecret(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: SecretCreate) =>
      apiFetch<Secret>(`/api/v1/projects/${projectId}/secrets`, { method: "POST", json: body }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.secrets(projectId) });
    },
  });
}

/** Metadata/policy only. A body carrying `value` is a `400` by contract. */
export function useUpdateSecret(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ secretId, body }: { secretId: string; body: SecretUpdate }) =>
      apiFetch<Secret>(`/api/v1/projects/${projectId}/secrets/${secretId}`, {
        method: "PUT",
        json: body,
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.secrets(projectId) });
    },
  });
}

/**
 * Rotation: append an immutable version. The response is version *metadata*
 * (`secret_id`, `version`, `key_id`, `created_at`) — never the value written.
 */
export function useAddSecretVersion(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ secretId, body }: { secretId: string; body: SecretVersionCreate }) =>
      apiFetch<SecretVersionInfo>(`/api/v1/projects/${projectId}/secrets/${secretId}/versions`, {
        method: "POST",
        json: body,
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.secrets(projectId) });
    },
  });
}

export function useRevokeSecret(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (secretId: string) =>
      apiFetch<Secret>(`/api/v1/projects/${projectId}/secrets/${secretId}:revoke`, {
        method: "POST",
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.secrets(projectId) });
    },
  });
}

/** The audit view: which unit had this secret, at which target, when cleaned. */
export function useSecretMaterializations(projectId: string, secretId: string) {
  return useQuery({
    queryKey: queryKeys.materializations(projectId, secretId),
    queryFn: () =>
      apiFetch<SecretMaterializationList>(
        `/api/v1/projects/${projectId}/secrets/${secretId}/materializations`,
      ),
    enabled: projectId.length > 0 && secretId.length > 0,
  });
}

export function useSecretMounts(projectId: string) {
  return useQuery({
    queryKey: queryKeys.secretMounts(projectId),
    queryFn: () => apiFetch<SecretMountList>(`/api/v1/projects/${projectId}/secret-mounts`),
    enabled: projectId.length > 0,
  });
}

export function useCreateSecretMount(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: SecretMountCreate) =>
      apiFetch<SecretMount>(`/api/v1/projects/${projectId}/secret-mounts`, {
        method: "POST",
        json: body,
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.secretMounts(projectId) });
    },
  });
}

/** Removes a *declaration*; it does not revoke the secret (contract §2). */
export function useDeleteSecretMount(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (mountId: string) =>
      apiFetch<void>(`/api/v1/projects/${projectId}/secret-mounts/${mountId}`, {
        method: "DELETE",
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.secretMounts(projectId) });
    },
  });
}

/** Live + recent workspaces of a project — refs and ids, never host paths. */
export function useWorkspaces(projectId: string) {
  return useQuery({
    queryKey: queryKeys.workspaces(projectId),
    queryFn: () => apiFetch<WorkspaceList>(`/api/v1/projects/${projectId}/workspaces`),
    enabled: projectId.length > 0,
  });
}

/**
 * One checkout's dirty manifest, read from the row the worker wrote at a unit
 * boundary. `staleTime` matters: this is *not* a live `git status`, and polling
 * it would imply one (`docs/m3-contract.md` §2).
 */
export function useWorkspaceRepoStatus(workspaceId: string, repositoryId: string) {
  return useQuery({
    queryKey: queryKeys.workspaceRepoStatus(workspaceId, repositoryId),
    queryFn: () =>
      apiFetch<WorkspaceRepoStatus>(
        `/api/v1/workspaces/${workspaceId}/repos/${repositoryId}/status`,
      ),
    enabled: workspaceId.length > 0 && repositoryId.length > 0,
    staleTime: 30_000,
  });
}

/**
 * What enforcement one launched unit actually ran under. `retry: false`: a
 * turn that never launched has no record, and a `404` is the honest answer
 * (ADR-0019: no process, no verdict) rather than something to hammer.
 */
export function useTurnSandbox(turnId: string) {
  return useQuery({
    queryKey: queryKeys.turnSandbox(turnId),
    queryFn: () => apiFetch<TurnSandbox>(`/api/v1/turns/${turnId}/sandbox`),
    enabled: turnId.length > 0,
    retry: false,
  });
}

/** Fleet sandbox health: backend, enforcement mode, verified, volumes per root. */
export function useSystemSandbox() {
  return useQuery({
    queryKey: queryKeys.systemSandbox,
    queryFn: () => apiFetch<SystemSandbox>("/api/v1/system/sandbox"),
  });
}

/** Artifacts the caller's role may see (the sensitivity filter runs in SQL). */
export function useArtifacts(projectId: string) {
  return useQuery({
    queryKey: queryKeys.artifacts(projectId),
    queryFn: () => apiFetch<ArtifactList>(`/api/v1/projects/${projectId}/artifacts`),
    enabled: projectId.length > 0,
  });
}

export function useArtifact(artifactId: string) {
  return useQuery({
    queryKey: queryKeys.artifact(artifactId),
    queryFn: () => apiFetch<Artifact>(`/api/v1/artifacts/${artifactId}`),
    enabled: artifactId.length > 0,
  });
}

/**
 * Mint a single-artifact preview token. The returned `token`/`preview_url` are
 * a credential: they live in this component's state only, are never written to
 * the cache, and are dropped as soon as the frame is closed (ADR-0020 D5).
 */
export function useCreatePreviewToken() {
  return useMutation({
    mutationFn: (artifactId: string) =>
      apiFetch<PreviewToken>(`/api/v1/artifacts/${artifactId}/preview-token`, {
        method: "POST",
      }),
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
 * Forget cached reads for one project. Driven by the project SSE feed — co-
 * alesced there into at most one call per `FRAME_BATCH_MS` window, because a
 * journal replay delivers frames faster than any read can round-trip — so a
 * change committed through *another* replica lands in this browser without a
 * reload.
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
    // The prefix key invalidates every filtered list of this project too.
    void queryClient.invalidateQueries({ queryKey: ["project", projectId, "conversations"] });
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
      // The prefix key invalidates every filtered list of this project too.
      await queryClient.invalidateQueries({ queryKey: ["project", projectId, "conversations"] });
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
