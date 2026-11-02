/**
 * The repo page's load-failure card (review 3a, item 2).
 *
 * The shared `ProblemBanner` with a `subject` says a failed read three times
 * on one screen — `Couldn't load this repository's runs.`, then the call
 * site's `Runs could not be loaded.`, then `The server had a problem — try
 * again in a moment.` Three sentences, one fact, and the reader has to work
 * out which line is the news. Here the fact is said ONCE, in the page's own
 * words, and the card keeps the two things that are not repetition: the
 * server's problem document, held in the DOM behind a collapsed `Details`
 * disclosure (error-details-r6 — evidence stays reachable, off the reading
 * line), and the `Retry` that re-asks for the read.
 *
 * It lives here, and not in `components/Feedback.tsx`, for one reason: the
 * shared banner is the load-failure treatment of ~30 other screens, and this
 * brief's boundaries are the repository surface. The visual is the same
 * ALERT-K box, the same `COULDN'T LOAD` bar (a state is never colour alone,
 * states.ts), the same compact secondary `Retry` — only the prose is shorter.
 */
import { problemOf } from "../../api/client";
import { Alert } from "../ds/Alert";
import { Button } from "../ds/Button";

export interface RepoLoadErrorProps {
  error: unknown;
  /** The ONE plain sentence: what this page could not read. */
  sentence: string;
  /** What still shows despite the break, when the page has something true to
   * say about it (the lanes view: one read broke, the other still buckets).
   * Not a second restatement of the failure — a different fact. */
  note?: string;
  testid: string;
  /** Re-ask for the read. A refusal (404) gets no button: the same answer
   * comes back, and a Retry that cannot help is theatre, not honesty. */
  retry?: { onClick: () => void; pending?: boolean; testid: string };
}

export function RepoLoadError({ error, sentence, note, testid, retry }: RepoLoadErrorProps) {
  const problem = problemOf(error);
  const detail =
    problem.detail === undefined ||
    problem.detail === null ||
    problem.detail === "undefined" ||
    problem.detail === "null" ||
    problem.detail === ""
      ? ""
      : problem.detail;
  const quoted = detail ? `${problem.title}: ${detail}` : problem.title;
  const refused = problem.status === 404;

  return (
    <Alert state="failed" label="COULDN'T LOAD" role="alert" testid={testid}>
      <div className="min-w-0 max-w-[70ch] space-y-[3px]">
        <p className="text-[13px] font-semibold text-ink" data-testid={`${testid}-summary`}>
          {sentence}
        </p>
        {note ? (
          <p className="text-[12px] text-muted" data-testid={`${testid}-note`}>
            {note}
          </p>
        ) : null}
        {refused ? null : (
          <details data-testid={`${testid}-details`} className="pt-[2px]">
            <summary className="w-fit cursor-pointer text-[11px] font-semibold text-muted underline decoration-line-strong underline-offset-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent">
              Details
            </summary>
            <p
              className="wrap-anywhere pt-[2px] font-mono text-[10.5px] text-faint"
              data-testid={`${testid}-server`}
            >
              server said: {quoted}
            </p>
          </details>
        )}
        {retry && !refused ? (
          <div className="flex flex-wrap items-center gap-[6px] pt-[3px]">
            <Button
              variant="secondary"
              compact
              onClick={retry.onClick}
              disabled={retry.pending}
              data-testid={retry.testid}
            >
              {retry.pending ? "Retrying…" : "Retry"}
            </Button>
          </div>
        ) : null}
      </div>
    </Alert>
  );
}
