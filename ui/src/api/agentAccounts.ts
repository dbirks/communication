/**
 * ADR-0085 in-app agent sign-in: what the Settings → Agent accounts page reads
 * and the four calls it makes.
 *
 * The shapes are the generated OpenAPI types (`AgentAccount`, `AgentLogin`) —
 * nothing here restates a wire field. `agent_account_status` rows say whether an
 * agent is signed in on a given worker; an `AgentLogin` is one sign-in attempt,
 * which the worker drives and this page only watches. The same
 * control-plane-queues, worker-answers pattern `useApmLock` uses: this client
 * never learns a token, and the API never returns a pasted code.
 */
import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "./client";
import type { components } from "./schema";

export type AgentLogin = components["schemas"]["AgentLogin"];
export type AgentLoginStatus = AgentLogin["status"];
export type AgentLauncher = components["schemas"]["AgentAccount"]["launcher"];
export type AgentAccount = components["schemas"]["AgentAccount"];
export type AgentAccountState = AgentAccount["state"];
export type AgentAccountList = components["schemas"]["AgentAccountList"];

/** The list read (one row per live worker × sign-in-capable launcher). */
export const agentAccountsKey = ["agent-accounts"] as const;
/** One sign-in attempt, polled while it is still moving. */
export const agentLoginKey = (loginId: string) => ["agent-login", loginId] as const;

/** The statuses in which a sign-in is still in flight (ADR-0085's `active` set). */
export const ACTIVE_LOGIN_STATUSES: readonly AgentLoginStatus[] = [
  "queued",
  "starting",
  "awaiting_user",
  "verifying",
];

/** True while the worker still owns the attempt (it may still move on its own). */
export function isAgentLoginActive(status: AgentLoginStatus | undefined | null): boolean {
  return status !== undefined && status !== null && ACTIVE_LOGIN_STATUSES.includes(status);
}

/**
 * `GET /api/v1/agent-accounts` — organization admins only; every other caller
 * gets a `403`, so the caller passes `enabled` from `me.is_org_admin` and the
 * read never fires for someone who cannot use the answer.
 */
export function useAgentAccounts(enabled = true) {
  return useQuery({
    queryKey: agentAccountsKey,
    queryFn: () => apiFetch<AgentAccountList>("/api/v1/agent-accounts"),
    enabled,
    retry: false,
  });
}

/**
 * `GET /api/v1/agent-logins/{id}` — the attempt behind the open dialog. Polls
 * every 2 s while it is queued/starting/awaiting_user/verifying and stops the
 * moment the worker writes a terminal status; that terminal transition is also
 * what changes the account row (signed in, or signed out with an error), so the
 * list is invalidated then rather than on an arbitrary timer.
 */
export function useAgentLogin(loginId: string | null | undefined) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: agentLoginKey(loginId ?? ""),
    queryFn: () => apiFetch<AgentLogin>(`/api/v1/agent-logins/${loginId}`),
    enabled: loginId != null && loginId !== "",
    retry: false,
    refetchInterval: (state) => (isAgentLoginActive(state.state.data?.status) ? 2000 : false),
  });
  const status = query.data?.status;
  useEffect(() => {
    if (status !== undefined && !isAgentLoginActive(status)) {
      void queryClient.invalidateQueries({ queryKey: agentAccountsKey });
    }
  }, [status, queryClient]);
  return query;
}

/**
 * `POST /api/v1/agent-accounts/{launcher}/logins` — queue a sign-in on the
 * worker that owns the credential volume. A `409` means one is already active
 * for that launcher and worker: the caller shows it and the row's own
 * `login` field is the attempt to reopen.
 */
export function useStartAgentLogin() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { launcher: AgentLauncher; worker_id?: string | null }) =>
      apiFetch<AgentLogin>(`/api/v1/agent-accounts/${input.launcher}/logins`, {
        method: "POST",
        json: { worker_id: input.worker_id ?? undefined },
      }),
    onSuccess: (login) => {
      // Seed the poll's first answer so the dialog renders the queued attempt
      // without waiting a round trip, and refresh the rows it came from.
      queryClient.setQueryData(agentLoginKey(login.id), login);
      void queryClient.invalidateQueries({ queryKey: agentAccountsKey });
    },
  });
}

/**
 * `POST /api/v1/agent-logins/{id}/code` — hand the worker a code the person
 * pasted back (Antigravity). The value goes out once and is never rendered
 * after submit, logged or cached. A `409` means the attempt is no longer
 * waiting for a code.
 */
export function useSubmitAgentLoginCode() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { loginId: string; code: string }) =>
      apiFetch<void>(`/api/v1/agent-logins/${input.loginId}/code`, {
        method: "POST",
        json: { code: input.code },
      }),
    onSuccess: (_void, input) => {
      // The attempt moves to `verifying` worker-side; ask again now rather than
      // waiting out the poll's 2 s.
      void queryClient.invalidateQueries({ queryKey: agentLoginKey(input.loginId) });
    },
  });
}

/** `POST /api/v1/agent-logins/{id}/cancel` — give the worker up. */
export function useCancelAgentLogin() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (loginId: string) =>
      apiFetch<void>(`/api/v1/agent-logins/${loginId}/cancel`, { method: "POST" }),
    onSuccess: (_void, loginId) => {
      void queryClient.invalidateQueries({ queryKey: agentLoginKey(loginId) });
      void queryClient.invalidateQueries({ queryKey: agentAccountsKey });
    },
  });
}
