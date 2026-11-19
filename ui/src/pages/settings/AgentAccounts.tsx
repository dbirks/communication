/**
 * Settings → Agent accounts (ADR-0085): the one screen that answers "is this
 * agent signed in on this worker, and if not, how do I fix it?".
 *
 * The list is `GET /api/v1/agent-accounts` — one row per live worker ×
 * sign-in-capable launcher, written by the worker's own status probe, so what
 * this page says was observed on that credential volume rather than inferred.
 * Every row's button queues a sign-in the *worker* runs; the token it produces
 * never leaves the worker, and this page never sees one. The dialog owns the
 * link/code and the pasted-back code; the row only carries the button and the
 * state the last read reported.
 *
 * Authorization is the server's (`403` for every non-admin on every route here).
 * The tab is hidden from non-admins and this body refuses them too, because the
 * `/settings/accounts` URL is reachable by typing it.
 */
import { useState } from "react";
import { useMe } from "../../api/queries";
import {
  isAgentLoginActive,
  useAgentAccounts,
  useStartAgentLogin,
  type AgentAccount,
} from "../../api/agentAccounts";
import { ApiError, problemOf } from "../../api/client";
import { Alert } from "../../components/ds/Alert";
import { Button } from "../../components/ds/Button";
import AgentLoginDialog, {
  AGENT_SIGNIN_NAME,
  type AgentLoginDialogTarget,
} from "../../components/settings/AgentLoginDialog";
import { formatAge } from "../../lib/format";

export default function AgentAccountsSettings() {
  const me = useMe();
  const isAdmin = me.data?.is_org_admin === true;
  const accounts = useAgentAccounts(isAdmin);
  const start = useStartAgentLogin();
  // The row's own failed start call, one at a time: a second click replaces the
  // first finding and a successful start clears it.
  const [rowNotice, setRowNotice] = useState<RowNotice | null>(null);
  const [dialog, setDialog] = useState<AgentLoginDialogTarget | null>(null);
  const rowKey = (item: AgentAccount) => `${item.launcher}/${item.worker_id}`;

  if (me.isPending) {
    // The answer to "is this person an admin?" is the whole page's first
    // fact; claiming either one before the read lands would be a lie.
    return <p className="text-[12.5px] text-muted">Loading…</p>;
  }
  if (!isAdmin) {
    return (
      <p data-testid="settings-accounts-forbidden">
        Only organization admins can manage agent sign-ins.
      </p>
    );
  }

  return (
    <div className="space-y-2" data-testid="settings-accounts">
      <p className="text-[12px] leading-[1.45] text-muted">
        Codex and Antigravity run on your own subscription. Sign-in runs on the worker, and the
        token never leaves it.
      </p>

      {accounts.isPending ? <p className="text-[12.5px] text-muted">Loading…</p> : null}
      {accounts.error ? (
        <Alert state="failed" label="COULDN'T LOAD" testid="settings-accounts-error" role="alert">
          Couldn&apos;t load agent accounts.
        </Alert>
      ) : null}
      {accounts.data && accounts.data.items.length === 0 ? (
        <p className="text-[12.5px] text-muted" data-testid="settings-accounts-empty">
          No workers are online, so there is nothing to sign in yet.
        </p>
      ) : null}

      {accounts.data && accounts.data.items.length > 0 ? (
        <ul>
          {accounts.data.items.map((item) => (
            <AgentAccountRow
              key={`${item.launcher}/${item.worker_id}`}
              item={item}
              busy={start.isPending}
              notice={rowNotice && rowNotice.key === rowKey(item) ? rowNotice : null}
              onSignIn={() => {
                if (item.login && isAgentLoginActive(item.login.status)) {
                  setRowNotice(null);
                  setDialog({
                    loginId: item.login.id,
                    launcher: item.launcher,
                    workerId: item.worker_id,
                    workerName: item.worker_name,
                  });
                  return;
                }
                setRowNotice(null);
                start.mutate(
                  { launcher: item.launcher, worker_id: item.worker_id },
                  {
                    onSuccess: (login) =>
                      setDialog({
                        loginId: login.id,
                        launcher: item.launcher,
                        workerId: item.worker_id,
                        workerName: item.worker_name,
                      }),
                    onError: (error) => {
                      // 409 is not a breakdown: a sign-in for this agent and
                      // worker is already running (maybe in another tab). Any
                      // other answer is the server's own sentence.
                      setRowNotice(
                        error instanceof ApiError && error.status === 409
                          ? {
                              key: rowKey(item),
                              state: "waiting",
                              label: "ALREADY RUNNING",
                              text: "A sign-in for this agent is already in progress.",
                            }
                          : {
                              key: rowKey(item),
                              state: "failed",
                              label: "COULDN'T START",
                              text: problemOf(error).detail || "The sign-in couldn't be queued.",
                            },
                      );
                    },
                  },
                );
              }}
            />
          ))}
        </ul>
      ) : null}

      {dialog ? (
        <AgentLoginDialog
          key={`${dialog.launcher}/${dialog.loginId}`}
          target={dialog}
          onClose={() => setDialog(null)}
        />
      ) : null}
    </div>
  );
}

/** What a row's failed start call said, and where it said it. */
interface RowNotice {
  key: string;
  state: "waiting" | "failed";
  label: string;
  text: string;
}

/** One worker × launcher: who it is, what the last probe saw, and the button. */
function AgentAccountRow({
  item,
  busy,
  notice,
  onSignIn,
}: {
  item: AgentAccount;
  busy: boolean;
  notice: RowNotice | null;
  onSignIn: () => void;
}) {
  const active = item.login !== null && isAgentLoginActive(item.login.status);
  const label = active
    ? "Continue sign-in"
    : item.state === "signed_in"
      ? "Sign in again"
      : "Sign in";
  return (
    <li
      data-testid={`agent-account-${item.launcher}-${item.worker_name}`}
      className="border-b border-line-soft py-3 last:border-b-0"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="min-w-[140px] flex-1">
          <span className="block text-[13px] font-semibold text-ink">
            {AGENT_SIGNIN_NAME[item.launcher] ?? item.launcher}
          </span>
          <span className="block font-mono text-[11px] text-muted">{item.worker_name}</span>
        </span>
        <AgentAccountState item={item} />
        <Button
          variant={active ? "primary" : "secondary"}
          data-testid="agent-account-signin"
          onClick={onSignIn}
          disabled={busy}
        >
          {label}
        </Button>
      </div>
      {notice ? (
        <Alert
          state={notice.state}
          label={notice.label}
          testid={notice.state === "waiting" ? "agent-account-conflict" : "agent-account-failed"}
          role="alert"
          className="mt-2"
        >
          {notice.text}
        </Alert>
      ) : null}
    </li>
  );
}

/**
 * The chip: the probe's answer in the words of rule 06 (the state is always a
 * word, the colour only emphasises it), plus how old that answer is — a
 * six-hour-old "Signed in as …" is a hint, not a fact.
 */
function AgentAccountState({ item }: { item: AgentAccount }) {
  const copy =
    item.state === "signed_in"
      ? {
          word: item.account_label ? `Signed in as ${item.account_label}` : "Signed in",
          className: "text-st-done-tag-fg",
        }
      : item.state === "signed_out"
        ? { word: "Needs sign-in", className: "text-st-waiting-tag-fg" }
        : { word: "Not checked yet", className: "text-muted" };
  return (
    <span className="text-right">
      <span className={`block text-[12.5px] ${copy.className}`} data-testid="agent-account-state">
        {copy.word}
      </span>
      {item.checked_at ? (
        <span
          className="block font-mono text-[11px] text-muted"
          data-testid="agent-account-checked"
        >
          Checked {formatAge(item.checked_at)} ago
        </span>
      ) : null}
    </span>
  );
}
