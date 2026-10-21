/**
 * `/` — the Home briefing (artboard 2a, contract C3/C4): the greeting and
 * the mono count line across every project the caller belongs to, the
 * decision callouts (at most three, the rest in the Inbox), the
 * "running now" rows and the recent one-off threads.
 *
 * All the data is one cross-project run list (the board's own read,
 * ADR-0047 — Home and Board share the rows, so the count line equals the
 * board's columns at the same moment), one pending-approval list and one
 * conversation list; live updates ride the org journal stream (ADR-0048),
 * never a poll. The lab image predating the C3 reads renders an honest
 * "not available yet" note instead of faking counts.
 */
import { Link } from "react-router";
import { DecisionCallouts } from "../components/home/DecisionCallout";
import { RunningNow } from "../components/home/RunningNow";
import { RecentThreads } from "../components/home/RecentThreads";
import { useBoardRuns } from "../api/board";
import { useHomeApprovals, useHomeConversations, useHomeLiveUpdates } from "../api/home";
import { problemOf } from "../api/client";
import { useAgentProfiles, useMe, useProjects } from "../api/queries";
import { STATES } from "../components/ds/states";
import { ProblemBanner, Spinner } from "../components/Feedback";
import { routes } from "../lib/routes";
import { greeting } from "./Inbox";

/** Run statuses each count-line segment counts (the board's columns). */
const NEED_YOU = ["waiting_human", "paused"];
const FAILED = ["failed", "interrupted", "cancelled"];
const RUNNING = ["running"];
const QUEUED = ["queued", "preparing"];
/** Every status that is not "done" — the "running now" section's rows. */
const ACTIVE = [...NEED_YOU, ...FAILED, ...RUNNING, ...QUEUED];

const isHttpError = (error: unknown, status: number): boolean => problemOf(error).status === status;

export default function Home() {
  const me = useMe();
  const projects = useProjects();
  const profiles = useAgentProfiles();
  const runs = useBoardRuns({});
  const approvals = useHomeApprovals();
  const conversations = useHomeConversations();
  useHomeLiveUpdates();

  const runList = runs.data?.runs ?? [];
  const activeRuns = runList.filter((run) => ACTIVE.includes(run.status));
  const pending = approvals.data?.approvals ?? [];
  const threads = (conversations.data?.items ?? []).filter((thread) => thread.origin === "manual");

  const counts = {
    needYou: countOf(runList, NEED_YOU),
    failed: countOf(runList, FAILED),
    running: countOf(runList, RUNNING),
    queued: countOf(runList, QUEUED),
  };

  if (runs.isPending) {
    return (
      <div data-testid="home-page">
        <Spinner label="Reading your projects" />
      </div>
    );
  }
  if (runs.isError && !isHttpError(runs.error, 404)) {
    return <ProblemBanner error={runs.error} fallback="Your runs could not be read." />;
  }

  const notYet = [runs, approvals, conversations].filter((query) => isHttpError(query.error, 404));
  const broken = [approvals, conversations].filter(
    (query) => query.isError && !isHttpError(query.error, 404),
  );
  const settled =
    (runs.isSuccess || isHttpError(runs.error, 404)) &&
    (approvals.isSuccess || isHttpError(approvals.error, 404)) &&
    (conversations.isSuccess || isHttpError(conversations.error, 404));
  const empty = pending.length === 0 && activeRuns.length === 0 && threads.length === 0;

  const projectNames = new Map((projects.data?.items ?? []).map((p) => [p.id, p.name] as const));
  const profileNames = new Map(
    (profiles.data?.items ?? []).map((profile) => [profile.id, profile.name] as const),
  );

  return (
    <section
      data-testid="home-page"
      className="mx-auto w-full max-w-[960px] px-[22px] py-[28px] sm:px-[28px]"
    >
      <header className="space-y-1">
        <h1 className="text-[22px] leading-[28px] font-semibold" data-testid="home-greeting">
          {greeting(new Date(), me.data?.display_name)}
        </h1>
        <CountLine counts={counts} settled={settled} />
      </header>

      {notYet.length > 0 ? (
        <p
          className="mt-3 border border-st-waiting-strong bg-st-waiting-pale-body px-3 py-2 font-mono text-[11px] text-st-waiting-pale-fg"
          data-testid="home-not-available"
          role="note"
        >
          ! not available yet — this server build predates the cross-project reads the briefing
          uses; the sections it can read still update live.
        </p>
      ) : null}
      {broken.length > 0 ? (
        <ProblemBanner
          error={broken[0].error}
          fallback="Part of your briefing could not be read."
        />
      ) : null}

      {settled && empty ? (
        <div className="mt-8 space-y-3" data-testid="home-empty">
          <p className="text-[13.5px] text-muted">
            Nothing is running and nothing is waiting on you.
          </p>
          <Link
            to={routes.projects()}
            className="ds-btn ds-btn--primary inline-flex h-[30px] items-center rounded-[4px] px-3"
            data-testid="home-start-run"
          >
            Start run
          </Link>
        </div>
      ) : (
        <div className="mt-5 space-y-4">
          {pending.length > 0 ? <DecisionCallouts approvals={pending} runs={runList} /> : null}
          {activeRuns.length > 0 ? <RunningNow runs={activeRuns} /> : null}
          <RecentThreads
            threads={threads}
            projectNames={projectNames}
            profileNames={profileNames}
          />
        </div>
      )}
    </section>
  );
}

function countOf(runs: { status: string }[], statuses: readonly string[]): number {
  return runs.filter((run) => statuses.includes(run.status)).length;
}

/**
 * `! 2 need you · × 1 failed · ● 3 running · · 1 queued` — mono, glyph +
 * word (never color alone), zero segments omitted entirely.
 */
function CountLine({
  counts,
  settled,
}: {
  counts: { needYou: number; failed: number; running: number; queued: number };
  settled: boolean;
}) {
  if (!settled) {
    return <p className="font-mono text-[11px] text-faint">· reading…</p>;
  }
  const segments = [
    { key: "needyou", count: counts.needYou, glyph: STATES.waiting.glyph, word: "need you" },
    { key: "failed", count: counts.failed, glyph: STATES.failed.glyph, word: "failed" },
    { key: "running", count: counts.running, glyph: STATES.running.glyph, word: "running" },
    { key: "queued", count: counts.queued, glyph: STATES.queued.glyph, word: "queued" },
  ].filter((segment) => segment.count > 0);

  return (
    <p className="font-mono text-[11.5px] text-ink-2" data-testid="home-count-line">
      {segments.length === 0
        ? "· nothing active"
        : segments.map((segment, index) => (
            <span key={segment.key}>
              {index > 0 ? " · " : ""}
              <span data-testid={`home-count-${segment.key}`}>
                {segment.glyph} {segment.count} {segment.word}
              </span>
            </span>
          ))}
    </p>
  );
}
