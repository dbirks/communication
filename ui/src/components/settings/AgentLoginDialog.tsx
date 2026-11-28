/**
 * The ADR-0085 sign-in dialog: the one place a person carries a subscription
 * sign-in through to the worker that needs it.
 *
 * It renders a single fact — `GET /api/v1/agent-logins/{id}` — polled every 2 s
 * while the attempt is alive, because every status transition (and the code or
 * link the worker writes into `awaiting_user`) arrives through that read, not
 * through an event subscription. Two provider shapes, exactly as ADR-0085
 * observed them:
 *
 *   - Codex: a device code. The worker holds the verification, the person
 *     carries the short code to auth.openai.com, and nothing comes back here.
 *   - Antigravity: a paste-back. The person signs in at Google and returns the
 *     authorization code (or the callback URL) in this box; the API carries it
 *     once, the worker reads-and-clears it, and it never appears in a log, a
 *     cache or a render after the submit — hence no `console.*` of `code`
 *     anywhere in this file.
 *
 * Closing the dialog does NOT cancel the sign-in: the worker keeps waiting, the
 * row goes back to "Continue sign-in", and reopening returns to the same
 * attempt. Only the explicit Cancel button posts the cancellation.
 */
import { useEffect, useRef, useState } from "react";
import {
  isAgentLoginActive,
  useAgentLogin,
  useCancelAgentLogin,
  useStartAgentLogin,
  useSubmitAgentLoginCode,
  type AgentLauncher,
  type AgentLogin,
} from "../../api/agentAccounts";
import { ApiError } from "../../api/client";
import { Alert } from "../ds/Alert";
import { Input } from "../ds/Field";
import { Sheet } from "../ds/Sheet";

/** Which attempt the dialog shows, and the row it came from (the retry posts
 * to the same launcher and worker — the credential volume is theirs). */
export interface AgentLoginDialogTarget {
  loginId: string;
  launcher: AgentLauncher;
  workerId: string;
  workerName: string;
}

export interface AgentLoginDialogProps {
  target: AgentLoginDialogTarget;
  onClose: () => void;
}

/**
 * The agent's own name, as the profile library and the agent cards spell it —
 * one table, shared with the row that opens this dialog (`AgentAccounts.tsx`)
 * so a tab, a row and a dialog can never name the same agent differently.
 */
export const AGENT_SIGNIN_NAME: Record<AgentLauncher, string> = {
  codex: "Codex",
  antigravity: "Antigravity",
};

const TITLE_ID = "agent-login-dialog-title";

/** The URL as a person reads it: the host and path, without the scheme. */
function urlWithoutScheme(url: string): string {
  return url.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/+/, "").replace(/\/+$/, "");
}

export default function AgentLoginDialog({ target, onClose }: AgentLoginDialogProps) {
  // A retry replaces the attempt this dialog follows (failed/expired ⇒ the old
  // row is finished and a new one is queued for the same worker), so the id is
  // state, not a prop read once.
  const [loginId, setLoginId] = useState(target.loginId);
  const login = useAgentLogin(loginId);
  const cancel = useCancelAgentLogin();
  const start = useStartAgentLogin();

  const retry = () => {
    start.mutate(
      { launcher: target.launcher, worker_id: target.workerId },
      { onSuccess: (next) => setLoginId(next.id) },
    );
  };

  return (
    <Sheet
      onClose={onClose}
      labelledBy={TITLE_ID}
      testid="agent-login-dialog"
      widthClassName="w-[440px]"
      panelClassName="mt-[8vh] p-[24px] max-md:mt-0 max-md:p-[16px]"
    >
      <h2 id={TITLE_ID} className="text-[16px] font-bold">
        Sign in to {AGENT_SIGNIN_NAME[target.launcher] ?? target.launcher}
      </h2>
      <p className="mt-1 font-mono text-[11px] text-muted">on {target.workerName}</p>

      {login.isPending ? (
        <p
          className="mt-3 text-[12.5px] text-muted"
          data-testid="agent-login-loading"
          role="status"
        >
          Loading…
        </p>
      ) : login.error ? (
        <Alert
          className="mt-3"
          state="failed"
          label="COULDN'T LOAD"
          testid="agent-login-error"
          role="alert"
        >
          Couldn&apos;t load this sign-in.
        </Alert>
      ) : (
        <LoginBody
          login={login.data}
          workerName={target.workerName}
          onCancel={() => cancel.mutate(loginId)}
          cancelBusy={cancel.isPending}
          onRetry={retry}
          retryBusy={start.isPending}
          onClose={onClose}
        />
      )}
    </Sheet>
  );
}

/** The status-dependent body. */
function LoginBody({
  login,
  workerName,
  onCancel,
  cancelBusy,
  onRetry,
  retryBusy,
  onClose,
}: {
  login: AgentLogin | undefined;
  workerName: string;
  onCancel: () => void;
  cancelBusy: boolean;
  onRetry: () => void;
  retryBusy: boolean;
  onClose: () => void;
}) {
  if (!login) return null;
  const active = isAgentLoginActive(login.status);
  return (
    <div className="mt-3 space-y-3">
      {active ? (
        <StatusLine login={login} workerName={workerName} />
      ) : (
        <TerminalBody login={login} onRetry={onRetry} retryBusy={retryBusy} onClose={onClose} />
      )}
      {active ? (
        <div className="border-t border-line pt-3">
          <button
            type="button"
            className="ds-btn ds-btn--secondary"
            data-testid="agent-login-cancel"
            onClick={onCancel}
            disabled={cancelBusy}
          >
            {cancelBusy ? "Cancelling…" : "Cancel sign-in"}
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** An attempt that is still waiting on someone: the worker, or the person. */
function StatusLine({ login, workerName }: { login: AgentLogin; workerName: string }) {
  switch (login.status) {
    case "queued":
    case "starting":
      return (
        <p className="text-[12.5px] text-muted" data-testid="agent-login-status">
          Starting the sign-in on {workerName}…
        </p>
      );
    case "verifying":
      return (
        <p className="text-[12.5px] text-muted" data-testid="agent-login-status">
          Checking the code…
        </p>
      );
    case "awaiting_user":
      return login.needs_code ? (
        <PasteBackLogin login={login} />
      ) : (
        <DeviceCodeLogin login={login} />
      );
    default:
      return (
        <p className="text-[12.5px] text-muted" data-testid="agent-login-status">
          Waiting…
        </p>
      );
  }
}

/** Codex (and any device-code sign-in): a link to open and a code to carry. */
function DeviceCodeLogin({ login }: { login: AgentLogin }) {
  const url = login.verification_url;
  const code = login.user_code;
  return (
    <div className="space-y-3">
      <section>
        <h3 className="font-mono text-[10.5px] font-semibold uppercase tracking-[.04em] text-muted">
          1. Open the sign-in page
        </h3>
        {url ? (
          <a
            data-testid="agent-login-link"
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-1 block font-mono text-[12.5px] text-accent-text underline underline-offset-2"
          >
            {urlWithoutScheme(url)}
          </a>
        ) : (
          <p className="mt-1 text-[12.5px] text-muted">
            The sign-in page address hasn&apos;t arrived yet.
          </p>
        )}
      </section>
      {code ? <CodeCard code={code} /> : null}
      <p className="text-[12.5px] text-muted" data-testid="agent-login-status">
        Waiting for you to approve…
      </p>
      <p className="text-[11px] leading-[1.45] text-muted">
        If OpenAI says device code sign-in is off, turn on “Enable device code sign-in for Codex” in
        ChatGPT → Settings → Security.
      </p>
    </div>
  );
}

/** The code itself, large and mono, with a copy button that says Copied. */
function CodeCard({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const copy = () => {
    // jsdom has no clipboard and non-secure contexts lack it: the button no-ops.
    if (!navigator.clipboard) return;
    void navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 2000);
    });
  };
  return (
    <section>
      <h3 className="font-mono text-[10.5px] font-semibold uppercase tracking-[.04em] text-muted">
        2. Enter this code
      </h3>
      <div className="mt-1 flex items-center gap-2">
        <span
          className="font-mono text-[22px] tracking-widest text-ink"
          data-testid="agent-login-code"
        >
          {code}
        </span>
        <button
          type="button"
          className="ds-btn ds-btn--secondary"
          data-testid="agent-login-copy"
          onClick={copy}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </section>
  );
}

/**
 * Antigravity: the person signs in at Google, then pastes the code the callback
 * page shows (or the page's whole address). The value is handed to the worker
 * once; the input empties on success and nothing about it is kept or printed.
 */
function PasteBackLogin({ login }: { login: AgentLogin }) {
  const submit = useSubmitAgentLoginCode();
  const [value, setValue] = useState("");
  const [rejected, setRejected] = useState(false);
  const trimmed = value.trim();
  const onError = (error: unknown) => {
    // 409 says the attempt already moved on (verified, expired, cancelled).
    if (error instanceof ApiError && error.status === 409) setRejected(true);
  };
  const onSubmit = () => {
    if (trimmed === "") return;
    const code = trimmed;
    setRejected(false);
    submit.mutate(
      { loginId: login.id, code },
      {
        onSuccess: () => setValue(""),
        onError,
      },
    );
  };
  return (
    <div className="space-y-3">
      <section>
        <h3 className="font-mono text-[10.5px] font-semibold uppercase tracking-[.04em] text-muted">
          1. Open Google sign-in
        </h3>
        {login.verification_url ? (
          <a
            data-testid="agent-login-link"
            href={login.verification_url}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-1 block font-mono text-[12.5px] text-accent-text underline underline-offset-2"
          >
            Open Google sign-in
          </a>
        ) : (
          <p className="mt-1 text-[12.5px] text-muted">
            The sign-in page address hasn&apos;t arrived yet.
          </p>
        )}
      </section>
      <section>
        <label
          htmlFor="agent-login-code-field"
          className="block font-mono text-[10.5px] font-semibold uppercase tracking-[.04em] text-muted"
        >
          2. After you sign in, the page shows a code. Paste it here (or paste the page&apos;s whole
          address):
        </label>
        <div className="mt-1 flex items-start gap-2">
          <Input
            id="agent-login-code-field"
            data-testid="agent-login-code-input"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            autoComplete="off"
            spellCheck={false}
            aria-invalid={rejected || undefined}
          />
          <button
            type="button"
            className="ds-btn ds-btn--primary"
            data-testid="agent-login-submit"
            onClick={onSubmit}
            disabled={trimmed === "" || submit.isPending}
          >
            {submit.isPending ? "Submitting…" : "Submit"}
          </button>
        </div>
        {rejected ? (
          <p
            className="pt-1 font-mono text-[11px] text-st-failed-tag-fg"
            role="alert"
            data-testid="agent-login-code-rejected"
          >
            This sign-in isn&apos;t waiting for a code any more.
          </p>
        ) : null}
        {submit.error && !rejected ? (
          <p
            className="pt-1 font-mono text-[11px] text-st-failed-tag-fg"
            role="alert"
            data-testid="agent-login-code-failed"
          >
            The code couldn&apos;t be handed to the worker. Try again.
          </p>
        ) : null}
      </section>
      <p className="text-[12.5px] text-muted" data-testid="agent-login-status">
        Waiting for you to approve…
      </p>
    </div>
  );
}

/** An attempt the worker finished: the answer, and the one action it leaves. */
function TerminalBody({
  login,
  onRetry,
  retryBusy,
  onClose,
}: {
  login: AgentLogin;
  onRetry: () => void;
  retryBusy: boolean;
  onClose: () => void;
}) {
  switch (login.status) {
    case "succeeded":
      return (
        <>
          <p className="text-[12.5px] text-st-done-tag-fg" data-testid="agent-login-status">
            {login.account_label ? `Signed in as ${login.account_label}.` : "Signed in."}
          </p>
          <button
            type="button"
            className="ds-btn ds-btn--primary"
            data-testid="agent-login-done"
            onClick={onClose}
          >
            Done
          </button>
        </>
      );
    case "failed":
      return (
        <>
          <Alert state="failed" label="SIGN-IN FAILED" testid="agent-login-error" role="alert">
            <span data-testid="agent-login-status">
              {login.error ?? "The worker didn't say why."}
            </span>
          </Alert>
          <button
            type="button"
            className="ds-btn ds-btn--primary"
            data-testid="agent-login-retry"
            onClick={onRetry}
            disabled={retryBusy}
          >
            {retryBusy ? "Starting…" : "Try again"}
          </button>
        </>
      );
    case "expired":
      return (
        <>
          <p className="text-[12.5px] text-muted" data-testid="agent-login-status">
            The sign-in timed out after 15 minutes.
          </p>
          <button
            type="button"
            className="ds-btn ds-btn--primary"
            data-testid="agent-login-retry"
            onClick={onRetry}
            disabled={retryBusy}
          >
            {retryBusy ? "Starting…" : "Try again"}
          </button>
        </>
      );
    default:
      return (
        <>
          <p className="text-[12.5px] text-muted" data-testid="agent-login-status">
            Sign-in cancelled.
          </p>
          <button
            type="button"
            className="ds-btn ds-btn--secondary"
            data-testid="agent-login-close"
            onClick={onClose}
          >
            Close
          </button>
        </>
      );
  }
}
