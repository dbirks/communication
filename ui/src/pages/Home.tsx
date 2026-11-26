/**
 * `/` — the Home for all projects (redesign R2, handoff README §2). Today
 * and Catch up merged into one page: the greeting and the prompt box up
 * top, "Since you left" on the left, and NEEDS YOU / RUNNING / FACTORY
 * HEALTH down the right column.
 *
 * The reads are the ones the app already answers to: the greeting's name
 * from `useMe`, the run rows from the board's own cross-project read
 * (ADR-0047 — Home and Board can never disagree), the pending gates from
 * the Home approvals read (the same rows the decision callouts drew), the
 * stories and the brief headline from the catch-up reads (ADR-0078/0081,
 * rendered by `SinceYouLeft`). Live updates still ride the org journal
 * stream (ADR-0048), never a poll. When the serving image predates the
 * cross-project approvals read, the page keeps the honest server-version
 * note (finding 12) where the waiting cards would have stood.
 *
 * Layout is the prototype's: a centered 760 column for the greeting and
 * the prompt (48px above the greeting, 18px between the greeting and the
 * prompt box; side padding 36 / phone 16, bottom 48 / phone 36), then a
 * max-1100 grid of `1fr 320px` with a 44 gap, one column below 900.
 */
import { HomePrompt } from "../components/home/HomePrompt";
import { SinceYouLeft } from "../components/home/SinceYouLeft";
import { NeedsYouCards } from "../components/home/NeedsYouCards";
import { RunningList } from "../components/home/RunningList";
import { FactoryHealth } from "../components/home/FactoryHealth";
import { useBoardRuns } from "../api/board";
import { useHomeApprovals, useHomeLiveUpdates } from "../api/home";
import { problemOf } from "../api/client";
import { useCatchUpBrief } from "../api/catchup";
import { useMe } from "../api/queries";
import { greeting } from "../lib/greeting";

/** The time word the no-name greeting leads with ("Morning. What are we
 * working on?") — the same wall-clock split `lib/greeting.ts` uses. */
export function greetingLine(now: Date, displayName: string | undefined | null): string {
  const first = displayName?.trim().split(/\s+/)[0];
  if (!first) {
    const hour = now.getHours();
    const part = hour < 12 ? "Morning" : hour < 18 ? "Afternoon" : "Evening";
    return `${part}. What are we working on?`;
  }
  return `${greeting(now, first)}. What are we working on?`;
}

export default function Home() {
  const me = useMe();
  const runs = useBoardRuns({});
  const approvals = useHomeApprovals();
  const brief = useCatchUpBrief("unseen");
  useHomeLiveUpdates();

  const runList = runs.data?.runs ?? [];
  const pending = approvals.data?.approvals ?? [];
  // Finding 12, unchanged copy: the briefing read the serving image cannot
  // answer gets the reader's own sentence, never the API's name for it.
  const approvalsMissing = approvals.isError && problemOf(approvals.error).status === 404;

  return (
    <div
      data-testid="home-all"
      className="h-full overflow-auto bg-surface px-[16px] pt-[48px] pb-[36px] min-[768px]:px-[36px] min-[768px]:pb-[48px]"
    >
      <div className="mx-auto w-full max-w-[760px]">
        <h2
          data-testid="home-greeting"
          className="text-center text-[24px] leading-[1.25] font-bold text-ink"
        >
          {greetingLine(new Date(), me.data?.display_name)}
        </h2>
        <div className="mt-[18px]" data-testid="home-prompt-space">
          <HomePrompt />
        </div>
      </div>

      <div className="mx-auto mt-[40px] grid w-full max-w-[1100px] grid-cols-1 gap-x-[44px] gap-y-[28px] min-[900px]:grid-cols-[minmax(0,1fr)_320px]">
        <SinceYouLeft />
        <div className="flex min-w-0 flex-col gap-[28px]">
          {approvalsMissing ? (
            <p
              className="border border-st-waiting-strong bg-st-waiting-pale-body px-3 py-2 font-mono text-[11px] text-st-waiting-pale-fg"
              data-testid="home-not-available"
              role="note"
            >
              Approvals from other projects can&apos;t load on this server version. The rest of
              Today is up to date. Ask an admin to update
            </p>
          ) : (
            <NeedsYouCards approvals={pending} runs={runList} />
          )}
          <RunningList runs={runList} />
          <FactoryHealth runs={runList} numbers={brief.data?.numbers ?? null} />
        </div>
      </div>
    </div>
  );
}
