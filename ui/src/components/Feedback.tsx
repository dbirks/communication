import { type ReactNode } from "react";
import { Link } from "react-router";
import { problemOf } from "../api/client";
import { Alert } from "./ds/Alert";
import { Button } from "./ds/Button";

export interface SpinnerProps {
  label: string;
}

/** Loading state that is announced (statuses are never visual-only). */
export function Spinner({ label }: SpinnerProps) {
  return (
    <p role="status" className="font-mono text-[11px] text-muted" aria-live="polite">
      · {label}…
    </p>
  );
}

export interface FormErrorProps {
  error: unknown;
  testid?: string;
}

/** Inline problem+json detail for a failed mutation (ALERT-K, pale failed). */
export function FormError({ error, testid = "form-error" }: FormErrorProps) {
  if (!error) return null;
  const problem = problemOf(error);
  const text = problem.detail ? `${problem.title}: ${problem.detail}` : problem.title;
  return (
    <Alert state="failed" label="FAILED" role="alert" testid={testid}>
      {text}
    </Alert>
  );
}

export interface ProblemBannerProps {
  error: unknown;
  /** Copy used when the server gave nothing usable. */
  fallback: string;
  testid?: string;
  /**
   * The thing a screen tried to read, in the reader's words — "the workflow
   * library", "this project's runs". With it the banner is the app's ONE load
   * failure treatment: a plain `Couldn't load <thing>` heading, the actions
   * that read actually supports (`retry`, `back`), and the server's own problem
   * document collapsed behind a `Details` disclosure — quoting it is honest,
   * but it is evidence, not a headline, because "Internal Server Error:
   * emulated failure" is a sentence no person reads as an answer (error-details-r6:
   * reviewers graded that raw line as developer-facing text shown to users, so
   * it stays in the DOM for anyone who asks for it and off the screen for
   * everyone else).
   *
   * Without it the banner stays the compact inline callout a dialog or a panel
   * quotes beside its own fields, which is what it has always been.
   */
  subject?: string;
  /** The verb this block owns. `load` (default) is a read that did not come
   * back; `save` is a write the server refused — the same treatment, the verb
   * the reader just pressed (`Couldn't save the trigger.`, `COULDN'T SAVE`). */
  verb?: "load" | "save";
  /** One line on what the reader does next, or what is safe. Defaults to
   * `fallback` — the copy the call site already owns. */
  hint?: string;
  /** What the reader can do from here. `retry` refetches the read (and says
   * `Retrying…` while it runs); `back` is the page's parent, when it has one.
   * A refusal gets neither: re-asking for a thing that is not here answers the
   * same, and a retry button that cannot help is not honesty, it is theatre. */
  retry?: { onClick?: () => void; pending?: boolean; testid?: string };
  /** The page's parent, when it has one. */
  back?: { to: string; label: string; testid?: string };
  /** Passed through to the alert box (a dialog's flex column wants `shrink-0`
   * so the block grows to fit instead of clipping a line in half). */
  className?: string;
}

/**
 * The plain sentence a person reads ABOUT the status, in the app's own words
 * (error-details-r6). A 5xx is the server's problem; `problemOf`'s status 0 is
 * the network's; a refusal (404, 403) is a fact about the thing asked for, so
 * the call site's own words carry it and no generic sentence is bolted on.
 */
function statusSentence(status: number): string | null {
  if (status >= 500) return "The server had a problem — try again in a moment.";
  if (status === 0) return "We couldn't reach the server — check your connection and try again.";
  return null;
}

/**
 * Read-state error: a 404 on a project the caller cannot see, a 500 on the list
 * the page is made of. Two renderings, one component — the page-level load
 * failure (with `subject`) and the compact inline callout (without it) — so a
 * failed read never means two different screens in two different vocabularies.
 */
export function ProblemBanner({
  error,
  fallback,
  testid,
  subject,
  verb = "load",
  hint,
  retry,
  back,
  className = "",
}: ProblemBannerProps) {
  const problem = problemOf(error);
  // `problemOf` stringifies whatever it was handed, and a call site that says
  // “one of these reads broke” without a specific error hands it `undefined` —
  // which came out as “Network error: undefined”, a message that is not honest,
  // it is a leak. An empty answer is dropped rather than quoted.
  const detail =
    problem.detail === undefined ||
    problem.detail === null ||
    problem.detail === "undefined" ||
    problem.detail === "null" ||
    problem.detail === ""
      ? ""
      : problem.detail;
  const quoted = detail ? `${problem.title}: ${detail}` : problem.title;
  const said = statusSentence(problem.status);
  // A refusal (404, or the page's own client-side absence) is not a break: the
  // server's title ("Not Found") is not evidence a person can act on, so the
  // evidence is dropped entirely and the call site's sentence carries the
  // screen.
  const refused = problem.status === 404;

  if (!subject) {
    const text = refused ? fallback : quoted;
    return (
      <Alert state="failed" label="FAILED" role="alert" testid={testid} className={className}>
        {text}
      </Alert>
    );
  }

  // The bar keeps the failed set's glyph + word (handoff rule 06: a state is
  // never color alone) but says what happened to THIS page — `COULDN'T LOAD` —
  // instead of `FAILED`, which is the word a run's status carries.
  const actions: ReactNode[] = [];
  if (retry?.onClick) {
    actions.push(
      <Button
        key="retry"
        variant="secondary"
        compact
        onClick={retry.onClick}
        disabled={retry.pending}
        data-testid={retry.testid}
      >
        {retry.pending ? "Retrying…" : "Retry"}
      </Button>,
    );
  }
  if (back) {
    actions.push(
      <Link
        key="back"
        to={back.to}
        className="ds-btn ds-btn--secondary ds-btn--compact inline-flex items-center rounded-[4px]"
        data-testid={back.testid}
      >
        {back.label}
      </Link>,
    );
  }

  return (
    <Alert
      state="failed"
      label={`COULDN'T ${verb === "save" ? "SAVE" : "LOAD"}`}
      role="alert"
      testid={testid}
      className={className}
    >
      <div className="min-w-0 max-w-[70ch] space-y-[3px]">
        <p
          className="text-[13px] font-semibold text-ink"
          data-testid={testid ? `${testid}-summary` : undefined}
        >
          {`Couldn't ${verb} ${subject}.`}
        </p>
        <p className="text-[12px] text-muted" data-testid={testid ? `${testid}-hint` : undefined}>
          {hint ?? fallback}
        </p>
        {said ? <p className="text-[12px] text-muted">{said}</p> : null}
        {refused ? null : (
          // Collapsed by default (error-details-r6): the raw problem document
          // is evidence, and a `<details>` is how evidence is kept — present
          // in the DOM, keyboard-reachable (the native summary is focusable,
          // Enter/Space opens it), and off the reading line until asked for.
          <details className="pt-[2px]" data-testid={testid ? `${testid}-details` : undefined}>
            <summary className="w-fit cursor-pointer text-[11px] font-semibold text-muted underline decoration-line-strong underline-offset-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent">
              Details
            </summary>
            <p
              className="wrap-anywhere pt-[2px] font-mono text-[10.5px] text-faint"
              data-testid={testid ? `${testid}-server` : undefined}
            >
              server said: {quoted}
            </p>
          </details>
        )}
        {actions.length > 0 ? (
          <div className="flex flex-wrap items-center gap-[6px] pt-[3px]">{actions}</div>
        ) : null}
      </div>
    </Alert>
  );
}
