/**
 * The version history behind the app-shell's versioned profile surface
 * (ADR-0058 part 2 = the UI): the reads (`GET …/versions`, `GET …/versions/{n}`)
 * and the write (`POST …/versions/{n}/restore`) the profile detail's HISTORY
 * panel, version glyph and `Save as v<N+1>` token all ride on.
 *
 * The wire shapes are the generated OpenAPI types (`AgentProfileVersion`,
 * `AgentProfileVersionList`); this module adds no vocabulary of its own.
 * The list answers oldest first — the panel renders newest first — and the
 * restore is a NEW write whose snapshot equals the restored version's, so the
 * history is append-only and the restore lands a fresh version.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "./client";
import { queryKeys } from "./queries";
import type { AgentProfile, AgentProfileVersion, AgentProfileVersionList } from "./types";

export const agentProfileVersionsKey = (profileId: string) =>
  ["agent-profile-versions", profileId] as const;

/**
 * `GET /api/v1/agent-profiles/{profileId}/versions` — the profile's version
 * history, oldest first. Read-only; any org member may ask, an invisible
 * subject is `404`, which the caller reads as an error, never as "no versions".
 */
export function useAgentProfileVersions(profileId: string | undefined) {
  return useQuery({
    queryKey: agentProfileVersionsKey(profileId ?? ""),
    queryFn: () =>
      apiFetch<AgentProfileVersionList>(`/api/v1/agent-profiles/${profileId}/versions`),
    enabled: profileId != null && profileId !== "",
    retry: false,
  });
}

/**
 * `GET /api/v1/agent-profiles/{profileId}/versions/{version}` — one frozen
 * version, `404` when the profile carried no such version.
 */
export function useAgentProfileVersion(
  profileId: string | undefined,
  version: number | null | undefined,
) {
  return useQuery({
    queryKey: [...agentProfileVersionsKey(profileId ?? ""), "version", version ?? ""] as const,
    queryFn: () =>
      apiFetch<AgentProfileVersion>(`/api/v1/agent-profiles/${profileId}/versions/${version}`),
    enabled: profileId != null && profileId !== "" && version != null,
    retry: false,
  });
}

export interface RestoreAgentProfileVersionVariables {
  profileId: string;
  version: number;
}

/**
 * `POST /api/v1/agent-profiles/{profileId}/versions/{version}/restore` — the
 * restore write. It answers the profile as the restore landed it (the new
 * version); on success the history and the profile row are invalidated so the
 * detail re-reads both.
 */
export function useRestoreAgentProfileVersion() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ profileId, version }: RestoreAgentProfileVersionVariables) =>
      apiFetch<AgentProfile>(`/api/v1/agent-profiles/${profileId}/versions/${version}/restore`, {
        method: "POST",
      }),
    onSuccess: async (_result, variables) => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.agentProfiles });
      await queryClient.invalidateQueries({
        queryKey: agentProfileVersionsKey(variables.profileId),
      });
    },
  });
}
