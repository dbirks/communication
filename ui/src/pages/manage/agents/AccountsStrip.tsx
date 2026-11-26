/**
 * The ACCOUNTS strip on Manage → Agents & models: one row per harness
 * (Claude, Codex, Antigravity — the in-app sign-in order), the sign-in state
 * the last probe saw, and the button that queues a worker-side sign-in.
 *
 * The states and the button behaviour are exactly AgentAccounts.tsx's: only
 * an organization admin sees buttons (and only an admin's session ever fires
 * the read — the endpoint answers 403 for everyone else); a row's own start
 * call surfaces its finding in place; the dialog owns the link/code and
 * never renders a token. Claude has no in-app sign-in driver: its row prints
 * "uses the worker's API key" in muted text and no button, unless the read
 * returns a claude item (then it is treated like any other harness).
 */
import { useState } from "react";
import { useMe } from "../../../api/queries";
import {
  isAgentLoginActive,
  useAgentAccounts,
  useStartAgentLogin,
  type AgentAccount,
} from "../../../api/agentAccounts";
import { ApiError, problemOf } from "../../../api/client";
import { Alert } from "../../../components/ds/Alert";
import { SoftButton } from "../../../components/ds/SoftButton";
import AgentLoginDialog, {
  type AgentLoginDialogTarget,
} from "../../../components/settings/AgentLoginDialog";
import { harnessLabel } from "../../../components/shell/AgentPicker";
import { formatAge } from "../../../lib/format";

/** The three harnesses in the strip's order. Other harnesses (a registry that
 * gains one) follow, alphabetically, so no row is ever silently dropped. */
const HARNESS_ORDER = ["claude", "codex", "antigravity"] as const;

export default function AccountsStrip() {
  const me = useMe();
  const isAdmin = me.data?.is_org_admin === true;
  // The read answers 403 for non-admins, so it never fires for one.
  const accounts = useAgentAccounts(isAdmin);
  const start = useStartAgentLogin();
  const [rowNotice, setRowNotice] = useState<RowNotice | null>(null);
  const [dialog, setDialog] = useState<AgentLoginDialogTarget | null>(null);

  const rowKey = (item: AgentAccount) => `${item.launcher}/${item.worker_id}`;

  const openDialog = (target: AgentLoginDialogTarget) => {
    setRowNotice(null);
    setDialog(target);
  };

  if (me.isPending) {
    return <p className="text-[12.5px] text-muted">Loading…</p>;
  }
  if (!isAdmin) {
    return (
      <div data-testid="agent-accounts">
        <p className="text-[12.5px] text-muted" data-testid="agent-accounts-forbidden">
          Only organization admins can manage agent sign-ins.
        </p>
      </div>
    );
  }

  const items = accounts.data?.items ?? [];
  const harnesses = [
    ...HARNESS_ORDER,
    ...Array.from(new Set(items.map((item) => item.launcher)))
      .filter((harness) => !(HARNESS_ORDER as readonly string[]).includes(harness))
      .sort(),
  ];

  return (
    <section data-testid="agent-accounts">
      <p className="mb-[8px] font-mono text-[10.5px] font-semibold uppercase tracking-[.06em] text-faint">
        Accounts
      </p>
      {accounts.isPending && !accounts.data ? (
        <p className="text-[12.5px] text-muted">Loading…</p>
      ) : null}
      {accounts.error ? (
        <Alert state="failed" label="COULDN'T LOAD" testid="agent-accounts-error" role="alert">
          Couldn&apos;t load agent accounts.
        </Alert>
      ) : null}
      <ul>
        {harnesses.map((harness) => (
          <HarnessRow
            key={harness}
            harness={harness}
            items={items.filter((item) => item.launcher === harness)}
            busy={start.isPending}
            onSignIn={(item) => {
              const active = item.login !== null && isAgentLoginActive(item.login.status);
              if (active && item.login) {
                openDialog({
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
                    openDialog({
                      loginId: login.id,
                      launcher: item.launcher,
                      workerId: item.worker_id,
                      workerName: item.worker_name,
                    }),
                  onError: (error) => {
                    // 409 is not a breakdown: a sign-in for this agent and
                    // worker is already running (maybe in another tab).
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
      {rowNotice ? (
        <Alert
          state={rowNotice.state}
          label={rowNotice.label}
          testid={rowNotice.state === "waiting" ? "agent-account-conflict" : "agent-account-failed"}
          role="alert"
          className="mt-2"
        >
          {rowNotice.text}
        </Alert>
      ) : null}
      {dialog ? (
        <AgentLoginDialog
          key={`${dialog.launcher}/${dialog.loginId}`}
          target={dialog}
          onClose={() => setDialog(null)}
        />
      ) : null}
    </section>
  );
}

interface RowNotice {
  key: string;
  state: "waiting" | "failed";
  label: string;
  text: string;
}

/** One harness row, in the order the strip reads it. */
function HarnessRow({
  harness,
  items,
  busy,
  onSignIn,
}: {
  harness: string;
  items: AgentAccount[];
  busy: boolean;
  onSignIn: (item: AgentAccount) => void;
}) {
  // Claude has no in-app sign-in driver: without the read reporting a claude
  // row the strip prints the honest "uses the worker's API key" and no button.
  if (harness === "claude" && items.length === 0) {
    return (
      <li className="grid min-h-[44px] grid-cols-[160px_1fr_auto] items-center gap-3 border-b border-line-soft py-2">
        <span className="text-[13.5px] font-semibold">{harnessLabel(harness)}</span>
        <span className="text-[12.5px] text-muted">uses the worker&apos;s API key</span>
        <span aria-hidden="true" />
      </li>
    );
  }

  const single = items.length === 1;
  return (
    <li
      data-testid={
        single ? `agent-account-${harness}-${items[0].worker_name}` : `agent-account-${harness}`
      }
      className="grid min-h-[44px] grid-cols-[160px_1fr_auto] items-center gap-3 border-b border-line-soft py-2"
    >
      <span className="text-[13.5px] font-semibold">{harnessLabel(harness)}</span>
      <span className="min-w-0">
        {items.length === 0 ? (
          <span className="block text-[12.5px] text-muted" data-testid="agent-account-state">
            not checked yet
          </span>
        ) : single ? (
          <StateLine item={items[0]} />
        ) : (
          <span className="block space-y-[2px]">
            {items.map((item) => (
              <span
                key={`${item.launcher}/${item.worker_id}`}
                data-testid={`agent-account-${item.launcher}-${item.worker_name}`}
                className="block"
              >
                <span className="font-mono text-[11px] text-muted">{item.worker_name}</span>
                {" — "}
                <StateLine item={item} />
              </span>
            ))}
          </span>
        )}
      </span>
      <span className="flex shrink-0 items-center gap-2">
        {items.map((item) => {
          const needsAccent =
            item.state === "signed_out" ||
            (item.login !== null && isAgentLoginActive(item.login.status));
          return (
            <SoftButton
              key={`${item.launcher}/${item.worker_id}`}
              size="sm"
              variant={needsAccent ? "primary" : "secondary"}
              data-testid="agent-account-signin"
              onClick={() => onSignIn(item)}
              disabled={busy}
            >
              {buttonLabel(item)}
            </SoftButton>
          );
        })}
      </span>
    </li>
  );
}

/** The state line: glyph + words, never colour alone. */
function StateLine({ item }: { item: AgentAccount }) {
  const { word, className } = stateOf(item);
  return (
    <span className={`text-[12.5px] ${className}`} data-testid="agent-account-state">
      {word}
      {item.checked_at ? (
        <span className="ml-2 font-mono text-[11px] text-muted">
          checked {formatAge(item.checked_at)} ago
        </span>
      ) : null}
    </span>
  );
}

function buttonLabel(item: AgentAccount): string {
  const active = item.login !== null && isAgentLoginActive(item.login.status);
  if (active) return "Continue sign-in";
  return item.state === "signed_in" ? "Sign in again" : "Sign in";
}

function stateOf(item: AgentAccount): { word: string; className: string } {
  if (item.state === "signed_in") {
    return {
      word: item.account_label ? `✓ signed in as ${item.account_label}` : "✓ signed in",
      className: "text-st-done-tag-fg",
    };
  }
  if (item.state === "signed_out") {
    return { word: "! needs sign-in", className: "text-st-waiting-tag-fg" };
  }
  return { word: "not checked yet", className: "text-muted" };
}
