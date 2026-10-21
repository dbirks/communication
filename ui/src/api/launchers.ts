/**
 * `GET /api/v1/launchers` (contract C5, ADR-0051): the launcher registry with
 * evidence-backed capability cells.
 *
 * A `404` here means the serving image predates the endpoint — which is a
 * "status not available yet" for the callers (profile chips, the launcher
 * block), not an error state: the page itself stays usable on the other
 * reads. Any other failure stays an error.
 */
import { useQuery } from "@tanstack/react-query";
import { apiFetch, ApiError } from "./client";
import type { Launcher, LauncherList } from "../lib/profiles";

export const launcherKey = ["system", "launchers"] as const;

/**
 * The launcher cards. `data` is `null` (not an error) when the server lacks
 * the endpoint, so callers can render the honest "not available yet" copy
 * instead of a red banner for a read-only status.
 */
export function useLaunchers() {
  return useQuery({
    queryKey: launcherKey,
    queryFn: async (): Promise<LauncherList | null> => {
      try {
        return await apiFetch<LauncherList>("/api/v1/launchers");
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return null;
        throw error;
      }
    },
    retry: false,
  });
}

export type { Launcher, LauncherList };
