/**
 * The repo page, Lanes view (design 3b): a WORKFLOWS chip row (name ·
 * trigger — the same trigger words the 3a panel speaks) over FOUR lanes,
 * `ISSUES · n`, `! NEEDS YOU · n`, `● RUNNING · n` and `FINISHED · 7 DAYS`,
 * in `repeat(4, minmax(0,1fr))` stacking below 1024px so the page itself
 * never scrolls sideways. Each lane: fill `#efede7` (`bg-fill`), radius 3,
 * padding 10, mono 10/600 caps header.
 *
 * Bucketing is the served statuses and nothing else — the SAME status field
 * the List view and the thread pane read (`Conversation.status`, `Run.status`),
 * so one row never wears two states on two screens (rcn-3b review item 1):
 * - NEEDS YOU — `waiting_human`/`paused` runs (attention.ts' gate arms) and
 *   `disconnected` chats (a turn open with its session lost);
 * - RUNNING — `queued`/`preparing`/`running` runs and every chat that is
 *   still a chat a person can talk in: `active` (a session is attached) and
 *   `idle` (history, nothing attached, the next prompt opens a session).
 *   `idle` is NOT finished: ADR `09` spells it "history, nothing attached",
 *   and the thread pane lists the same row under LIVE whenever its turn is
 *   open — filing it under FINISHED said the work was over while three other
 *   surfaces said it was pending, live or running;
 * - FINISHED · 7 DAYS — terminal runs and `archived` chats (the one status
 *   the wire spells read-only) whose last activity is inside the seven days
 *   the header promises; older rows are out of the window, and the project's
 *   run list stays the record.
 * A waiting card whose pending gate the approvals read observed carries
 * `Approve` — a link onto the existing gate route — and every run/chat card
 * carries its `Open`. A failed card wears the failed pale edge; state is
 * glyph + word (states.ts), never color alone.
 *
 * Issue → Running is native HTML5 drag-and-drop, no dependency: the lane
 * answers a dragged issue with a dashed accent border over an accent-tint
 * fill, and the drop opens a `START #<n> WITH` menu anchored with an arrow.
 * Its workflow entries are the repo's enabled pins whose pinned revision
 * really declares a `github_issue` input (ADR-0066 `input_specs`) — read on
 * demand, never guessed. Choosing one posts the run with the ADR-0066 issue
 * object `{number, title, body, url, repo}` in that input plus the ADR-0064
 * `issue: {number}` trigger fact; when OTHER required inputs have no
 * default, the run-by-hand form opens instead of a doomed POST.
 * `Chat about it instead` creates a repo-bound chat (ADR-0067) seeded with
 * the issue. The keyboard path is each card's `Start…` button — the same
 * menu, the same actions.
 */
import { useRef, useState, type DragEvent } from "react";
import { Link, useNavigate } from "react-router";
import { useQueries } from "@tanstack/react-query";
import { apiFetch, problemOf } from "../../api/client";
import { queryKeys } from "../../api/queries";
import { useSchedules } from "../../api/pipelines";
import { useIssueTriggers } from "../../api/useIssueTriggers";
import { useCreateRun } from "../../api/runs";
import { useCreateConversation } from "../../api/queries";
import type { GitHubIssue, useRepoIssues } from "../../api/issues";
import type {
  Approval,
  Assignment,
  ConversationSummary,
  PipelineRevision,
  RunSummary,
} from "../../api/types";
import { VARIANT_CLASS } from "../ds/Button";
import { Menu, type MenuEntry } from "../ds/Menu";
import { ProgressStrip } from "../ds/ProgressStrip";
import { runStepSegments } from "./RepoActivity";
import { triggerLine } from "./RepoWorkflowPanel";
import { CONVERSATION_STATE, RUN_STATE, SHORT_WORD, STATES } from "../ds/states";
import { Spinner } from "../Feedback";
import { RepoLoadError } from "./RepoLoadError";
import { formatAge, shortId, testidOf } from "../../lib/format";
import { routes } from "../../lib/routes";

/* ------------------------------------------------------------------ bucketing */

/** A lane row: a run or a chat, plus the moment that put it where it is. */
export type LaneEntry =
  | { kind: "run"; at: string; run: RunSummary }
  | { kind: "chat"; at: string; conversation: ConversationSummary };

export interface Lanes {
  needsYou: LaneEntry[];
  running: LaneEntry[];
  finished: LaneEntry[];
}

/** Seven days, in ms — the window the FINISHED header names. */
export const FINISHED_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

const NEEDS_YOU_RUN_STATUSES = new Set<string>(["waiting_human", "paused"]);
const RUNNING_RUN_STATUSES = new Set<string>(["queued", "preparing", "running"]);
const FINISHED_RUN_STATUSES = new Set<string>(["completed", "failed", "cancelled", "interrupted"]);
/** `disconnected` lost its session with a turn still open (attention.ts). */
const NEEDS_YOU_CHAT_STATUSES = new Set<string>(["disconnected"]);
/** `active` has a live session; `idle` is the same open chat with no session
 * attached (09's own words) — both are live chat cards, not finished work. */
const RUNNING_CHAT_STATUSES = new Set<string>(["active", "idle"]);
/** `archived` is the wire's only read-only, ended chat. */
const FINISHED_CHAT_STATUSES = new Set<string>(["archived"]);

function runActivityAt(run: RunSummary): string {
  return run.finished_at ?? run.started_at ?? run.created_at;
}

function byNewest(a: LaneEntry, b: LaneEntry): number {
  return b.at.localeCompare(a.at);
}

/**
 * One pass, served statuses only. `now` is injectable because the 7-day
 * window is the lane's own promise and must be testable against a fixed
 * day; callers pass nothing and get the real clock.
 */
export function buildLanes(
  runs: readonly RunSummary[],
  conversations: readonly ConversationSummary[],
  now: number = Date.now(),
): Lanes {
  const needsYou: LaneEntry[] = [];
  const running: LaneEntry[] = [];
  const finished: LaneEntry[] = [];
  const windowStart = now - FINISHED_WINDOW_MS;

  for (const run of runs) {
    const entry: LaneEntry = { kind: "run", at: runActivityAt(run), run };
    if (NEEDS_YOU_RUN_STATUSES.has(run.status)) needsYou.push(entry);
    else if (RUNNING_RUN_STATUSES.has(run.status)) running.push(entry);
    else if (FINISHED_RUN_STATUSES.has(run.status) && Date.parse(entry.at) >= windowStart)
      finished.push(entry);
  }
  for (const conversation of conversations) {
    const entry: LaneEntry = { kind: "chat", at: conversation.updated_at, conversation };
    if (NEEDS_YOU_CHAT_STATUSES.has(conversation.status)) needsYou.push(entry);
    else if (RUNNING_CHAT_STATUSES.has(conversation.status)) running.push(entry);
    else if (FINISHED_CHAT_STATUSES.has(conversation.status) && Date.parse(entry.at) >= windowStart)
      finished.push(entry);
  }
  return {
    needsYou: needsYou.sort(byNewest),
    running: running.sort(byNewest),
    finished: finished.sort(byNewest),
  };
}

/* ------------------------------------------------------------ workflow chips */

export interface RepoWorkflowChipsProps {
  projectId: string;
  /** The repo's ENABLED pins — the chip row is what can start work here. */
  assignments: readonly Assignment[];
  /** Pipeline id → workflow name (display name, else slug). */
  names: ReadonlyMap<string, string>;
}

/**
 * The WORKFLOWS chip row: one `name · trigger` chip per enabled pin. The
 * trigger honesty is `RepoWorkflowPanel`'s rule — reads not landed say `…`,
 * a failed read says `triggers unavailable`, never `By hand` for a trigger
 * the wire never refused.
 */
export function RepoWorkflowChips({ projectId, assignments, names }: RepoWorkflowChipsProps) {
  const schedules = useSchedules(projectId);
  const issueTriggers = useIssueTriggers(projectId);
  const ready = !schedules.isPending && !issueTriggers.isPending;
  const failed = schedules.isError || issueTriggers.isError;
  return (
    <div
      className="flex min-w-0 flex-wrap items-center gap-2"
      data-testid="repo-lane-workflows"
      aria-label="Workflows assigned to this repository"
    >
      <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.05em] text-muted">
        Workflows
      </span>
      {assignments.length === 0 ? (
        <span
          className="font-mono text-[10.5px] text-faint"
          data-testid="repo-lane-workflows-empty"
        >
          none — assign one from the List view
        </span>
      ) : null}
      {assignments.map((assignment) => {
        const key = testidOf(assignment.id);
        const name = names.get(assignment.pipeline_id) ?? shortId(assignment.pipeline_id);
        const words = failed
          ? "triggers unavailable"
          : !ready
            ? "…"
            : triggerLine(
                (issueTriggers.data?.issue_triggers ?? []).filter(
                  (trigger) => trigger.assignment_id === assignment.id,
                ),
                (schedules.data?.schedules ?? []).filter(
                  (schedule) => schedule.assignment_id === assignment.id,
                ),
              );
        return (
          <span
            key={assignment.id}
            className="rounded-[3px] border border-line-strong bg-surface px-[8px] py-[3px] text-[12px] text-ink"
            data-testid={`repo-lane-workflow-${key}`}
          >
            {name}
            <span className="text-muted"> · </span>
            <span data-testid={`repo-lane-workflow-trigger-${key}`}>{words}</span>
          </span>
        );
      })}
    </div>
  );
}

/* ----------------------------------------------------------------- start menu */

interface StartState {
  issue: GitHubIssue;
  /** `drop` anchors on the card the lane caught; `keyboard` on the card's
   * `Start…` button — the required accessible route to the same menu. */
  anchor: "drop" | "keyboard";
  /** One idempotency key per menu opening (ADR-0023 § 12). */
  key: string;
}

function startMenuKey(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return `lanedrop-${c.randomUUID()}`;
  return `lanedrop-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/** The ADR-0066 runtime value a `github_issue` input receives. */
function issueInputValue(issue: GitHubIssue, repo: string): Record<string, unknown> {
  return {
    number: issue.number,
    title: issue.title,
    body: issue.body,
    url: issue.html_url,
    repo,
  };
}

/** The issue's own words as a chat seed: the heading line the run form uses
 * plus the body, never a paraphrase. */
export function issueChatSeed(issue: GitHubIssue): string {
  const heading = `#${issue.number} ${issue.title}`;
  return issue.body.trim() === "" ? heading : `${heading}\n\n${issue.body}`;
}

export interface StartIssueMenuProps {
  projectId: string;
  repositoryName: string;
  start: StartState;
  /** The `owner/repo` the issue list echoed — the ADR-0066 value's `repo`. */
  issueRepo: string;
  /** The repo's enabled pins; their pinned revisions decide the entries. */
  assignments: readonly Assignment[];
  names: ReadonlyMap<string, string>;
  profileDefaultId: string | null;
  profilesPending: boolean;
  /** The drop card (anchor `drop`)… */
  dropCardRef: React.RefObject<HTMLElement | null>;
  /** …or the `Start…` button (anchor `keyboard`). */
  triggerRef: React.RefObject<HTMLElement | null>;
  /** A workflow whose OTHER required inputs have no default: the run-by-hand
   * form takes over instead of posting a doomed run — carrying the issue and
   * the chosen assignment, so the form starts on that pin (1k). */
  onOpenRunForm: (issue: GitHubIssue, assignment: Assignment) => void;
  onClose: () => void;
}

function menuKey(id: string): string {
  return testidOf(id);
}

/**
 * The `START #<n> WITH` menu. Workflow entries appear only for pins whose
 * pinned revision (ADR-0066 `input_specs`, read on this menu's demand)
 * really declares a `github_issue` input; unreadable revisions are named as
 * unreadable, never passed off as not accepting the issue. `Chat about it
 * instead` is always the last entry.
 */
export function StartIssueMenu({
  projectId,
  repositoryName,
  start,
  issueRepo,
  assignments,
  names,
  profileDefaultId,
  profilesPending,
  dropCardRef,
  triggerRef,
  onOpenRunForm,
  onClose,
}: StartIssueMenuProps) {
  const navigate = useNavigate();
  const createRun = useCreateRun(projectId);
  const createChat = useCreateConversation(projectId);
  const inFlight = useRef(false);
  // The pinned revision of every enabled pin, read because the menu opened.
  const revisions = useQueries({
    queries: assignments.map((assignment) => ({
      queryKey: queryKeys.revision(assignment.pinned_revision_id),
      queryFn: () =>
        apiFetch<PipelineRevision>(`/api/v1/revisions/${assignment.pinned_revision_id}`),
    })),
  });

  const busy = createRun.isPending || createChat.isPending || inFlight.current;
  const anyPending = revisions.some((result) => result.isPending);

  const accepting = assignments
    .map((assignment, index) => {
      const revision = revisions[index];
      const specs = revision.data?.input_specs ?? [];
      const issueInput = specs.find((spec) => spec.type === "github_issue");
      if (!issueInput) return null;
      const unfilled = specs.filter(
        (spec) => spec.required && spec.name !== issueInput.name && spec.default === undefined,
      );
      return { assignment, issueInput: issueInput.name, unfilled };
    })
    .filter((row): row is NonNullable<typeof row> => row !== null);

  const items: MenuEntry[] = [];
  for (let index = 0; index < assignments.length; index += 1) {
    const result = revisions[index];
    if (!result.isError) continue;
    const assignment = assignments[index];
    items.push({
      id: `unreadable-${assignment.id}`,
      label: `${names.get(assignment.pipeline_id) ?? shortId(assignment.pipeline_id)} — revision unreadable`,
      disabled: true,
      onSelect: () => undefined,
    });
  }
  for (const row of accepting) {
    items.push({
      id: row.assignment.id,
      label: names.get(row.assignment.pipeline_id) ?? shortId(row.assignment.pipeline_id),
      testId: `repo-start-issue-workflow-${menuKey(row.assignment.id)}`,
      disabled: busy,
      onSelect: () => {
        if (busy) return;
        if (row.unfilled.length > 0) {
          // Other required inputs have no default: the run-by-hand form is
          // the only honest start — opened with the issue prefilled.
          onClose();
          onOpenRunForm(start.issue, row.assignment);
          return;
        }
        if (inFlight.current) return;
        inFlight.current = true;
        const issue = start.issue;
        createRun.mutate(
          {
            body: {
              assignment_id: row.assignment.id,
              inputs: { [row.issueInput]: issueInputValue(issue, issueRepo) },
              title: issue.title.slice(0, 200),
              // ADR-0064: the run records the issue trigger fact a fire would.
              issue: { number: issue.number },
              idempotency: start.key,
            },
            idempotencyKey: start.key,
          },
          {
            onSuccess: (created) => navigate(routes.run(created.run_id)),
            onError: () => {
              inFlight.current = false;
            },
          },
        );
      },
    });
  }
  if (accepting.length === 0 && anyPending) {
    items.push({
      id: "reading",
      label: "reading the pinned revisions…",
      disabled: true,
      onSelect: () => undefined,
    });
  }
  if (items.length > 0) items.push({ separator: true });
  items.push({
    id: "chat",
    label: "Chat about it instead",
    testId: "repo-start-issue-chat",
    disabled: busy || profileDefaultId === null,
    title:
      profileDefaultId === null
        ? profilesPending
          ? "the agent profiles are still loading"
          : "this project has no agent profile"
        : undefined,
    onSelect: () => {
      if (busy || profileDefaultId === null) return;
      if (inFlight.current) return;
      inFlight.current = true;
      const issue = start.issue;
      const prompt = issueChatSeed(issue);
      createChat.mutate(
        {
          // Born bound to this repository (ADR-0067), titled by the issue.
          title: `#${issue.number} ${issue.title}`.slice(0, 200),
          agent_profile_id: profileDefaultId,
          prompt,
          repository: repositoryName,
        },
        {
          onSuccess: (conversation) => navigate(routes.thread(conversation.id)),
          onError: () => {
            inFlight.current = false;
          },
        },
      );
    },
  });
  const refusal =
    createRun.isError || createChat.isError
      ? problemOf(createRun.error ?? createChat.error).detail ||
        "The server refused the start — nothing was created."
      : null;
  if (refusal) {
    items.push({ separator: true });
    items.push({
      id: "refused",
      label: <span className="text-st-failed-pale-fg">{refusal}</span>,
      disabled: true,
      onSelect: () => undefined,
      testId: "repo-start-issue-error",
    });
  }

  return (
    <Menu
      open
      onClose={onClose}
      triggerRef={start.anchor === "drop" ? dropCardRef : triggerRef}
      side="bottom"
      width={230}
      height={190}
      caption={`Start #${start.issue.number} with`}
      ariaLabel={`Start #${start.issue.number} with`}
      data-testid="repo-start-issue-menu"
      items={items}
    />
  );
}

/* ----------------------------------------------------------------- lane view */

export interface RepoLanesProps {
  projectId: string;
  repositoryName: string;
  issues: ReturnType<typeof useRepoIssues>;
  githubHosted: boolean;
  /** This repository's runs (depth-0, as the page attributes them). */
  runs: readonly RunSummary[];
  /** This repository's chats (ADR-0067 `?repository=`). */
  conversations: readonly ConversationSummary[];
  runsPending: boolean;
  runsError: unknown;
  onRetryRuns: () => void;
  retryingRuns: boolean;
  chatsPending: boolean;
  chatsError: unknown;
  onRetryChats: () => void;
  retryingChats: boolean;
  /** The pending gate of a run, when the approvals read observed one. */
  gateFor: (runId: string) => Approval | null;
  /** The repo's enabled pins — the menu's workflow candidates. */
  assignments: readonly Assignment[];
  names: ReadonlyMap<string, string>;
  profileDefaultId: string | null;
  profilesPending: boolean;
  /** Opens the run-by-hand form (1k) with the issue prefilled, when a
   * picked workflow has other required inputs with no default. */
  onOpenRunForm: (issue: GitHubIssue, assignment: Assignment) => void;
  now?: number;
}

const LANE_CLASS = "min-w-0 space-y-2 rounded-[3px] bg-fill p-[10px]";
const LANE_HEADER_CLASS =
  "flex items-center gap-1 font-mono text-[10px] font-semibold uppercase tracking-[0.05em] text-ink-2";
const CARD_CLASS = "min-w-0 rounded-[3px] border border-line-strong bg-surface p-[8px]";

function laneHeader(glyph: string, glyphClass: string, label: string) {
  return (
    <header className={LANE_HEADER_CLASS}>
      <span aria-hidden="true" className={glyphClass}>
        {glyph}
      </span>
      <span>{label}</span>
    </header>
  );
}

export function RepoLanes({
  projectId,
  repositoryName,
  issues,
  githubHosted,
  runs,
  conversations,
  runsPending,
  runsError,
  onRetryRuns,
  retryingRuns,
  chatsPending,
  chatsError,
  onRetryChats,
  retryingChats,
  gateFor,
  assignments,
  names,
  profileDefaultId,
  profilesPending,
  onOpenRunForm,
  now = Date.now(),
}: RepoLanesProps) {
  const [dragIssue, setDragIssue] = useState<GitHubIssue | null>(null);
  const [dropActive, setDropActive] = useState(false);
  const [start, setStart] = useState<StartState | null>(null);
  const dropCardRef = useRef<HTMLLIElement | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);

  const lanes = buildLanes(runs, conversations, now);
  const issueItems: GitHubIssue[] = issues.data?.items ?? [];
  const issueRepo = issues.data?.repository ?? "";

  const beginDrag = (event: DragEvent<HTMLLIElement>, issue: GitHubIssue) => {
    // Native HTML5 transfer; the state is what the lane reads (jsdom hands no
    // DataTransfer, and a browser hands the same object either way).
    event.dataTransfer?.setData("application/x-communication-issue", String(issue.number));
    if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
    setDragIssue(issue);
  };
  const endDrag = () => {
    setDragIssue(null);
    setDropActive(false);
  };
  const dropIssue = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    const issue = dragIssue;
    setDropActive(false);
    setDragIssue(null);
    if (!issue) return;
    setStart({ issue, anchor: "drop", key: startMenuKey() });
  };
  const openFromKeyboard = (issue: GitHubIssue, button: HTMLElement) => {
    triggerRef.current = button;
    setStart({ issue, anchor: "keyboard", key: startMenuKey() });
  };

  const laneErrors = (
    <>
      {runsError ? (
        <RepoLoadError
          error={runsError}
          sentence="Couldn't load this repository's runs."
          note="The lanes below show the chats only — the runs lanes have no data to bucket."
          testid="repo-lanes-runs-problem"
          retry={{ onClick: onRetryRuns, pending: retryingRuns, testid: "repo-lanes-runs-retry" }}
        />
      ) : null}
      {chatsError ? (
        <RepoLoadError
          error={chatsError}
          sentence="Couldn't load this repository's chats."
          note="The lanes below show the runs only — the chat rows have no data to bucket."
          testid="repo-lanes-chats-problem"
          retry={{
            onClick: onRetryChats,
            pending: retryingChats,
            testid: "repo-lanes-chats-retry",
          }}
        />
      ) : null}
    </>
  );

  return (
    <div className="min-w-0 space-y-4" data-testid="repo-lanes">
      {laneErrors}
      {/* Four lanes; below 1024px they stack — the page itself never
          scrolls sideways. */}
      <div className="grid grid-cols-1 items-start gap-4 min-[1024px]:grid-cols-[repeat(4,minmax(0,1fr))]">
        {/* ISSUES — the draggable source. */}
        <section className={LANE_CLASS} aria-label="Issues" data-testid="repo-lane-issues">
          {laneHeader(
            "",
            "",
            `Issues · ${!githubHosted ? "0" : issues.isPending ? "…" : issueItems.length}`,
          )}
          {issues.isPending && githubHosted ? <Spinner label="Loading issues" /> : null}
          {!githubHosted ? (
            <p className="text-[12px] text-muted" data-testid="repo-lane-issues-not-github">
              Issue hand-offs need a GitHub repository.
            </p>
          ) : null}
          {githubHosted && issues.isError ? (
            <p className="text-[12px] text-muted" data-testid="repo-lane-issues-error">
              {problemOf(issues.error).detail || "GitHub refused the read."}{" "}
              <button
                type="button"
                onClick={() => void issues.refetch()}
                className="font-mono text-[10.5px] text-accent-text underline"
                data-testid="repo-lane-issues-retry"
              >
                retry
              </button>
            </p>
          ) : null}
          {!issues.isPending && !issues.isError && githubHosted && issueItems.length === 0 ? (
            <p className="text-[12px] text-muted" data-testid="repo-lane-issues-empty">
              No open issues.
            </p>
          ) : null}
          <ul className="space-y-2">
            {issueItems.slice(0, 12).map((issue) => (
              <li
                key={issue.number}
                draggable
                onDragStart={(event) => beginDrag(event, issue)}
                onDragEnd={endDrag}
                data-testid={`repo-lane-issue-${issue.number}`}
                className={`${CARD_CLASS} cursor-grab ${
                  dragIssue?.number === issue.number ? "opacity-50" : ""
                }`}
              >
                <div className="flex items-start gap-2">
                  <span className="font-mono text-[10px] text-faint">#{issue.number}</span>
                  <span className="min-w-0 flex-1 text-[12.5px] font-semibold text-ink">
                    {issue.title}
                  </span>
                  {/* The keyboard route to the drop menu (required). */}
                  <button
                    type="button"
                    aria-haspopup="menu"
                    aria-label={`Start #${issue.number} with a workflow`}
                    onClick={(event) => openFromKeyboard(issue, event.currentTarget)}
                    className="shrink-0 rounded-[2px] border border-line-strong bg-surface px-[6px] py-[1px] font-mono text-[10px] text-accent-text hover:bg-fill focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
                    data-testid={`repo-lane-issue-start-${issue.number}`}
                  >
                    Start…
                  </button>
                </div>
              </li>
            ))}
          </ul>
          {issueItems.length > 12 ? (
            <p className="font-mono text-[10.5px] text-faint" data-testid="repo-lane-issues-more">
              + {issueItems.length - 12} more
            </p>
          ) : null}
        </section>

        {/* NEEDS YOU — waiting runs (with their gate) and stalled chats. */}
        <section className={LANE_CLASS} aria-label="Needs you" data-testid="repo-lane-needs-you">
          {laneHeader("!", STATES.waiting.tagFg, `Needs you · ${lanes.needsYou.length}`)}
          {runsPending || chatsPending ? <Spinner label="Loading lanes" /> : null}
          {!runsPending && !chatsPending && lanes.needsYou.length === 0 ? (
            <p className="text-[12px] text-muted" data-testid="repo-lane-needs-you-empty">
              Nothing waits on anyone.
            </p>
          ) : null}
          <ul className="space-y-2">
            {lanes.needsYou.map((entry) =>
              entry.kind === "run" ? (
                <RunLaneCard
                  key={`run-${entry.run.id}`}
                  run={entry.run}
                  name={names.get(entry.run.pipeline_id) ?? null}
                  gate={gateFor(entry.run.id)}
                  showStrip={false}
                />
              ) : (
                <ChatLaneCard
                  key={`chat-${entry.conversation.id}`}
                  conversation={entry.conversation}
                />
              ),
            )}
          </ul>
        </section>

        {/* RUNNING — the drop target; live runs (with the ADR-0070 strip)
            and live chats. */}
        <section
          className={`${LANE_CLASS} relative ${
            dropActive && dragIssue
              ? "bg-accent-tint outline-2 outline-dashed -outline-offset-2 outline-accent"
              : ""
          }`}
          aria-label="Running"
          data-testid="repo-lane-running"
          onDragOver={(event) => {
            if (!dragIssue) return;
            event.preventDefault();
            if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
            setDropActive(true);
          }}
          onDragLeave={(event) => {
            if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
            setDropActive(false);
          }}
          onDrop={dropIssue}
        >
          {laneHeader("●", STATES.running.tagFg, `Running · ${lanes.running.length}`)}
          {runsPending || chatsPending ? <Spinner label="Loading lanes" /> : null}
          {!runsPending && !chatsPending && lanes.running.length === 0 && !dragIssue ? (
            <p className="text-[12px] text-muted" data-testid="repo-lane-running-empty">
              Nothing is running.
            </p>
          ) : null}
          <ul className="space-y-2">
            {lanes.running.map((entry) =>
              entry.kind === "run" ? (
                <RunLaneCard
                  key={`run-${entry.run.id}`}
                  run={entry.run}
                  name={names.get(entry.run.pipeline_id) ?? null}
                  gate={null}
                  showStrip
                />
              ) : (
                <ChatLaneCard
                  key={`chat-${entry.conversation.id}`}
                  conversation={entry.conversation}
                />
              ),
            )}
            {dragIssue && dropActive ? (
              /* The in-flight preview the drop catches (3b's card). */
              <li
                aria-hidden="true"
                className="min-w-0 rounded-[3px] border border-dashed border-accent bg-surface p-[8px] font-mono text-[10px] text-muted"
                data-testid="repo-lane-drop-preview"
              >
                #{dragIssue.number} · dragging
                <span className="block font-sans text-[12.5px] font-semibold text-ink">
                  {dragIssue.title}
                </span>
              </li>
            ) : null}
            {start && start.anchor === "drop" ? (
              /* The caught card: the menu's anchor, kept while it is open. */
              <li
                ref={dropCardRef}
                className={`${CARD_CLASS} border-ink shadow-(--shadow-raised)`}
                data-testid="repo-lane-drop-card"
              >
                <span className="font-mono text-[10px] text-faint">#{start.issue.number}</span>
                <span className="block text-[12.5px] font-semibold text-ink">
                  {start.issue.title}
                </span>
              </li>
            ) : null}
          </ul>
          {start ? (
            <StartIssueMenu
              projectId={projectId}
              repositoryName={repositoryName}
              start={start}
              issueRepo={issueRepo}
              assignments={assignments}
              names={names}
              profileDefaultId={profileDefaultId}
              profilesPending={profilesPending}
              dropCardRef={dropCardRef}
              triggerRef={triggerRef}
              onOpenRunForm={onOpenRunForm}
              onClose={() => setStart(null)}
            />
          ) : null}
        </section>

        {/* FINISHED · 7 DAYS — the closed-out week. */}
        <section
          className={LANE_CLASS}
          aria-label="Finished, last 7 days"
          data-testid="repo-lane-finished"
        >
          {laneHeader("", "", "Finished · 7 days")}
          {runsPending || chatsPending ? <Spinner label="Loading lanes" /> : null}
          {!runsPending && !chatsPending && lanes.finished.length === 0 ? (
            <p className="text-[12px] text-muted" data-testid="repo-lane-finished-empty">
              Nothing finished in the last 7 days.
            </p>
          ) : null}
          <ul className="space-y-2">
            {lanes.finished.map((entry) =>
              entry.kind === "run" ? (
                <RunLaneCard
                  key={`run-${entry.run.id}`}
                  run={entry.run}
                  name={names.get(entry.run.pipeline_id) ?? null}
                  gate={null}
                  showStrip={false}
                />
              ) : (
                <ChatLaneCard
                  key={`chat-${entry.conversation.id}`}
                  conversation={entry.conversation}
                />
              ),
            )}
          </ul>
        </section>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- lane cards */

function RunLaneCard({
  run,
  name,
  gate,
  showStrip,
}: {
  run: RunSummary;
  name: string | null;
  gate: Approval | null;
  /** Only the RUNNING lane draws the strip (3b); every other lane is the
   * closed or waiting story. */
  showStrip: boolean;
}) {
  const state = RUN_STATE[run.status] ?? "queued";
  const spec = STATES[state];
  const segments = showStrip ? runStepSegments(run) : null;
  const waiting = state === "waiting";
  const failedState = state === "failed";
  return (
    <li
      className={`${CARD_CLASS} ${
        waiting ? "border-st-waiting-pale-edge" : failedState ? "border-st-failed-pale-edge" : ""
      }`}
      data-testid={`repo-lane-run-${testidOf(run.id)}`}
      title={run.id}
    >
      {/* Glyph AND word, on one line (states.ts, handoff rule 06) — the
          List row beside this lane says `running`/`need you` in words, and a
          lane card that showed only the dot made two cards read the same.
          rcn-3b review item 1. */}
      <div
        className={`font-mono text-[10px] ${waiting || failedState ? spec.tagFg : "text-muted"}`}
      >
        <span aria-hidden="true" className="mr-1">
          {spec.glyph}
        </span>
        RUN · {name ?? shortId(run.id)}
        <span className="ml-1">· {SHORT_WORD[state]}</span>
      </div>
      <Link
        to={routes.run(run.id)}
        data-testid={`repo-lane-run-open-${testidOf(run.id)}`}
        className="mt-1 block text-[12.5px] font-semibold text-ink hover:underline"
      >
        {run.title ?? `Run #${shortId(run.id)}`}
      </Link>
      {segments ? (
        <ProgressStrip
          variant="J"
          stages={[{ label: "steps", active: true, segments }]}
          className="mt-[3px] max-w-[200px]"
        />
      ) : null}
      {gate ? (
        <p
          className="mt-1 text-[12px] text-muted"
          data-testid={`repo-lane-gate-${testidOf(run.id)}`}
        >
          {gate.summary}
        </p>
      ) : null}
      {gate || waiting ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {gate ? (
            <Link
              to={routes.approval(gate.id)}
              className={`ds-btn ${VARIANT_CLASS.primary} ds-btn--compact`}
              data-testid={`repo-lane-approve-${testidOf(run.id)}`}
            >
              Approve
            </Link>
          ) : null}
          <Link
            to={routes.run(run.id)}
            className={`ds-btn ${VARIANT_CLASS.secondary} ds-btn--compact`}
            data-testid={`repo-lane-runbutton-${testidOf(run.id)}`}
          >
            Open
          </Link>
        </div>
      ) : null}
    </li>
  );
}

function ChatLaneCard({ conversation }: { conversation: ConversationSummary }) {
  const state = CONVERSATION_STATE[conversation.status] ?? "info";
  const spec = STATES[state];
  return (
    <li
      className={CARD_CLASS}
      data-testid={`repo-lane-chat-${testidOf(conversation.id)}`}
      title={conversation.id}
    >
      <div className="font-mono text-[10px] font-semibold text-accent-text">
        <span aria-hidden="true" className={spec.tagFg}>
          {spec.glyph}
        </span>{" "}
        CHAT
        {/* The word beside the glyph, not behind `sr-only`: a chat card under
            RUNNING has to say whether the session is attached (`running`) or
            the chat is merely open (`pending`) — rcn-3b review item 1. */}
        <span className="ml-1 font-normal">· {SHORT_WORD[state]}</span>
      </div>
      <div className="mt-1 flex items-start gap-2">
        <Link
          to={routes.thread(conversation.id)}
          className="min-w-0 flex-1 text-[12.5px] font-semibold text-ink hover:underline"
        >
          {conversation.title}
        </Link>
        <span className="shrink-0 font-mono text-[10.5px] text-faint">
          {formatAge(conversation.updated_at)}
        </span>
      </div>
      {state === "interrupted" ? (
        <Link
          to={routes.thread(conversation.id)}
          className={`ds-btn ${VARIANT_CLASS.secondary} ds-btn--compact mt-2`}
          data-testid={`repo-lane-chat-open-${testidOf(conversation.id)}`}
        >
          Open
        </Link>
      ) : null}
    </li>
  );
}
