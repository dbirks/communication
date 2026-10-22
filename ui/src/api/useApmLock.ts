/**
 * The server-side APM lock behind the profile detail's "Lock it" flow
 * (ADR-0054 + amendment 2): the control-plane trigger and the status read.
 *
 * POST /api/v1/agent-profiles/{profileId}/apm/lock answers 202 with the queued
 * request; the resolve itself runs worker-side and reports back through
 * GET .../apm/lock, whose status moves queued → claimed → done | failed. The
 * status query polls every 3 s while a resolve is queued or claimed and stops on
 * done/failed, so the chip is live without a separate event subscription. On
 * done the caller invalidates the agent-profiles list to refetch the pin.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "./client";
import type { APMLockRequest } from "./types";

export const apmLockQueryKey = (profileId: string) => ["apm-lock", profileId] as const;

/** `GET /api/v1/agent-profiles/{profileId}/apm/lock` — the latest lock status. */
export function useApmLockStatus(profileId: string | undefined) {
  return useQuery({
    queryKey: apmLockQueryKey(profileId ?? ""),
    queryFn: () => apiFetch<APMLockRequest>(`/api/v1/agent-profiles/${profileId}/apm/lock`),
    enabled: profileId != null && profileId !== "",
    retry: false,
    // Poll while the resolve is queued or claimed; stop on done/failed and let
    // the unmount/refetch settle the answer.
    refetchInterval: (query) =>
      query.state.data?.status === "queued" || query.state.data?.status === "claimed"
        ? 3000
        : false,
  });
}

/** `POST /api/v1/agent-profiles/{profileId}/apm/lock` — queue a worker-side resolve. */
export function usePostApmLock() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (profileId: string) =>
      apiFetch<APMLockRequest>(`/api/v1/agent-profiles/${profileId}/apm/lock`, { method: "POST" }),
    onSuccess: async (request, profileId) => {
      // The POST answered 202 with the queued request; move the status read to
      // it immediately and let the poll (or the done/failed transition) take
      // over from there.
      queryClient.setQueryData(apmLockQueryKey(profileId), request);
      await queryClient.invalidateQueries({ queryKey: ["agent-profiles"] });
    },
  });
}
