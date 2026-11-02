/**
 * A failed turn, in the words a person reads (error-details-r6).
 *
 * `conversation.turn.failed` carries `message`, a bounded diagnostic written
 * for the operator who owns the worker. Quoted whole it is a sentence nobody
 * can act on — the review caught the chat printing
 * `worker: prepare workspace for project 01a19c73-…: workspace: mirror
 * /repos/01a19c73-…/server.git has no branch "main" to base server on
 * (ADR-0017 D2 refuses a branch-name guess)` — a uuid, a path and an ADR
 * number, where the reader needed "the repository has no default branch".
 *
 * So: one plain sentence on the line, mapped from the known classes of
 * failure the worker actually produces (`internal/worker/{unit,turnloop}.go`,
 * `internal/workspace/git/workspace.go`, `internal/agent/acp/*`), and the
 * server's own words kept in the DOM behind a `Details` disclosure — exactly
 * the treatment a7ea79f gave the run gate, because an unquoted failure is a
 * lost fact and a quoted one is a leak-shaped wall of text.
 *
 * An unrecognised message prints the honest generic sentence, never a guess
 * at a cause; the raw line still rides the disclosure, so nothing is hidden
 * from whoever can read it.
 */
import { Fragment, type ReactNode } from "react";
import { sandboxFailureCopy } from "../../api/sandbox";
import { STATES } from "../ds/states";
import type { TranscriptItem } from "../../api/transcript";
import type { EventEnvelope } from "../../api/types";

/** The sentence when no known class matches: true of every failure, and it
 * claims nothing about a cause this build has no words for. */
export const TURN_FAILURE_FALLBACK = "This turn failed.";

/** The sentence when the frame carried no `message` at all. */
export const TURN_FAILURE_SILENT = "This turn failed — the worker reported no detail.";

/**
 * The known classes, in order, each with the sentence a reader gets. The
 * patterns are the worker's own error prefixes — matching them is quoting the
 * producer, not guessing: an unmatched message is genuinely unknown to this
 * build and says so.
 */
const TURN_FAILURE_COPY: {
  readonly test: RegExp;
  readonly words: (match: RegExpMatchArray) => string;
}[] = [
  {
    // `workspace: mirror <path> has no branch "main" to base <repo> on
    // (ADR-0017 D2 refuses a branch-name guess)` and its HEAD-less twin.
    test: /has no branch |neither a default branch nor a HEAD/,
    words: () =>
      "This chat couldn't start its workspace: the repository has no default branch to start from.",
  },
  {
    // `workspace: mirror <path> does not exist and repository <name> has no
    // clone URL` — the repository was never fetched to this worker.
    test: /does not exist and repository .* has no clone URL/,
    words: () =>
      "This chat couldn't start its workspace: the repository has no clone URL to fetch it from.",
  },
  {
    // `workspace: clone <path> from mirror: …` — the fetch itself broke.
    test: /workspace: clone .* from mirror/,
    words: () => "This chat couldn't start its workspace: the repository could not be fetched.",
  },
  {
    // `workspace: create mirror <path> from <git url>: git … clone --mirror
    // … failed: fatal: '…' does not appear to be a git repository` — what
    // this build saw in the lab when a thread was bound to a repository
    // whose address no worker can read. The one thing the reader can act on
    // lives on the project's Settings tab, so name it.
    test: /create mirror .* from |does not appear to be a git repository|Could not read from remote repository|repository not found|authentication required/i,
    words: () =>
      "This chat couldn't start its workspace: the repository's git address could not be read from this worker — check it under the project's repositories.",
  },
  {
    // Anything else on the workspace path: the same honest place to point.
    test: /prepare workspace|workspace: worktree|workspace: mirror/,
    words: () => "This chat couldn't start its workspace on this worker.",
  },
  {
    // `worker: sandbox <stage> refused the launch (<reason>): …` — ADR-0019
    // D6's refusal. The stage/reason words are the app's own vocabulary
    // (`api/sandbox.ts`), the same pair the sandbox verdict panel prints.
    test: /sandbox ([a-z_]+) refused the launch(?: \(([a-z_]+)\))?/,
    words: (m) =>
      `The sandbox refused to start the agent: ${sandboxFailureCopy(m[1] ?? "", m[2] ?? null)}.`,
  },
  {
    // `worker: permission mode <mode> needs a prompting mode for launcher
    // <id>; none is verified` — the fail-closed refusal in turnloop.go.
    test: /needs a prompting mode/,
    words: () =>
      "This agent's launcher has no verified prompting mode on this worker, so the turn was refused.",
  },
  {
    // `errAutonomousWithoutSandbox`: ADR-0069's honesty gate.
    test: /autonomous_within_sandbox is only honest|no unit service|enforcement none/,
    words: () =>
      "This profile runs without asking, which needs an enforced sandbox this worker isn't running — so the turn was refused.",
  },
  {
    // `agent.acp: launcher "x" declares a credential directory at … that is
    // not usable` / `needs one of […] set to a credential directory`.
    test: /credential directory/,
    words: () => "This agent's sign-in is not set up on this worker.",
  },
  {
    // `worker: launcher %q is not a known launcher …` / `acp: unknown launcher`.
    test: /is not a known launcher|unknown launcher/,
    words: () => "This worker doesn't know the launcher this agent runs on.",
  },
  {
    // The ACP runtime's own launch refusals: `acp: initialize: …`,
    // `acp: session/new: …`, `acp: start <exe>: …`, `acp: … pipe: …`.
    test: /\bacp: (initialize|session\/|start |stdin pipe|stdout pipe)/,
    words: () => "The agent process couldn't be started.",
  },
];

/** One plain sentence for a worker's diagnostic — never the diagnostic itself. */
export function turnFailureWords(message: string | null | undefined): string {
  if (!message) return TURN_FAILURE_SILENT;
  for (const entry of TURN_FAILURE_COPY) {
    const match = message.match(entry.test);
    if (match) return entry.words(match);
  }
  return TURN_FAILURE_FALLBACK;
}

export interface TurnFailureData {
  /** The frame's `event_id` — the transcript item's identity. */
  id: string;
  /** The server's bounded diagnostic, verbatim, for the disclosure. */
  message: string | null;
}

/** Read the failure off a `conversation.turn.failed` envelope. */
export function turnFailureFromEvent(event: EventEnvelope): TurnFailureData | null {
  if (event.type !== "conversation.turn.failed") return null;
  const message = event.payload?.message;
  return {
    id: event.event_id,
    message: typeof message === "string" && message !== "" ? message : null,
  };
}

/**
 * A transcript run and the failures inside it, in order.
 *
 * `Transcript` renders one flat list, so a failure that needs its own
 * treatment has to cut the run: the fold's `system` line for a failed turn is
 * replaced by `TurnFailureNotice` at the same position, and the rest of the
 * run keeps its agent header. Exported for tests for the same reason
 * `segmentTranscript` is: it is pure, and it is the whole behaviour.
 */
export type TranscriptBlock =
  | { kind: "items"; items: TranscriptItem[] }
  | { kind: "failure"; failure: TurnFailureData };

export function splitAtTurnFailures(
  items: readonly TranscriptItem[],
  events: readonly EventEnvelope[],
): TranscriptBlock[] {
  const failures = new Map<string, TurnFailureData>();
  for (const event of events) {
    const failure = turnFailureFromEvent(event);
    if (failure) failures.set(failure.id, failure);
  }
  const blocks: TranscriptBlock[] = [];
  let run: TranscriptItem[] = [];
  const flush = () => {
    if (run.length > 0) {
      blocks.push({ kind: "items", items: run });
      run = [];
    }
  };
  for (const item of items) {
    // The fold keys a system item by its frame's `event_id`, so the failed
    // turn's raw line is exactly the item this run names. A failure whose
    // system item is NOT in this run (a turn-filtered pane, where the journal
    // frames of other turns are simply not on screen) prints nothing here —
    // inventing a row for a turn this surface does not show would say more
    // than the items do.
    const failure = item.kind === "system" ? failures.get(item.id) : undefined;
    if (failure) {
      flush();
      blocks.push({ kind: "failure", failure });
    } else {
      run.push(item);
    }
  }
  flush();
  // Nothing failed: one run (empty or not), so the caller's `Transcript` — and
  // its "no transcript yet" copy — behaves exactly as before.
  if (blocks.length === 0) blocks.push({ kind: "items", items: [] });
  return blocks;
}

export interface TurnFailureNoticeProps {
  failure: TurnFailureData;
  testId?: string;
}
/**
 * Render one run's items with every failed turn cut out and printed as a
 * `TurnFailureNotice` in its place. Shared by the two surfaces that own the
 * chat transcript (`ConversationTranscript`, `AgentConversationPanel`) so a
 * failure never reads as raw worker text on one screen and plain prose on the
 * other. `renderItems` owns the list rendering (each surface styles its own
 * `Transcript`); a run with no failure returns exactly one call to it, so an
 * unaffected conversation renders the identical tree — including the empty
 * "no transcript yet" copy, which stays the fold's sentence.
 */
export function renderSplitAtTurnFailures(
  items: TranscriptItem[],
  events: readonly EventEnvelope[],
  keyBase: string,
  renderItems: (items: TranscriptItem[]) => ReactNode,
): ReactNode {
  const blocks = splitAtTurnFailures(items, events);
  if (blocks.every((block) => block.kind === "items")) return renderItems(items);
  return blocks.map((block, index) =>
    block.kind === "failure" ? (
      <TurnFailureNotice key={`${keyBase}-failed-${block.failure.id}`} failure={block.failure} />
    ) : (
      <Fragment key={`${keyBase}-run-${index}`}>{renderItems(block.items)}</Fragment>
    ),
  );
}

/**
 * The failure row: the failed state's glyph and word (never colour alone, per
 * handoff rule 06), the one plain sentence, and the server's own line behind
 * `Details`. It wears the transcript's system-row shape (same size, same left
 * rule as the `i` rows) because it IS a journal fact, not a banner the reader
 * must dismiss.
 */
export function TurnFailureNotice({ failure, testId = "turn-failed" }: TurnFailureNoticeProps) {
  const failed = STATES.failed;
  return (
    <div
      data-testid={testId}
      className="flex items-baseline gap-2 px-1 py-1 text-[12px] text-ink-2"
      role="status"
    >
      <span className={`shrink-0 font-mono text-[10.5px] not-italic ${failed.tagFg}`}>
        <span aria-hidden="true">{failed.glyph} </span>
        <span className="sr-only">Turn failed. </span>
      </span>
      <div className="min-w-0 flex-1">
        <p className="min-w-0 wrap-anywhere" data-testid={`${testId}-plain`}>
          {turnFailureWords(failure.message)}
        </p>
        {failure.message ? (
          // Collapsed by default (error-details-r6, as in `ProblemBanner`):
          // the raw diagnostic is evidence — in the DOM, keyboard-reachable,
          // and off the reading line until someone asks for it.
          <details className="pt-[2px]" data-testid={`${testId}-details`}>
            <summary className="w-fit cursor-pointer text-[11px] font-semibold text-muted underline decoration-line-strong underline-offset-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent">
              Details
            </summary>
            <p
              className="wrap-anywhere pt-[2px] font-mono text-[10.5px] font-normal text-faint"
              data-testid={`${testId}-server`}
            >
              server said: {failure.message}
            </p>
          </details>
        ) : null}
      </div>
    </div>
  );
}
