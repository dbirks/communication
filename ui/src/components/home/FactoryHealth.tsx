/**
 * FactoryHealth — the redesigned Home's "FACTORY HEALTH" block (handoff
 * README §2): one plain sentence about the factory, built from real counts
 * only. "{n} running, {m} waiting on a person, {k} failed in the last day."
 *
 * The numbers prefer the catch-up brief's own arithmetic
 * (`CatchUpBriefNumbers`, already loaded by the page for the headline);
 * where there is no brief the counts fall back to the board's run rows the
 * page already holds — running now, gates/runs waiting on a person, and
 * runs that ended red within the last day. When every count is zero the
 * block says the one true sentence left to it: "All quiet."
 */
import { SectionLabel } from "./SectionLabel";
import type { CatchUpBriefNumbers } from "../../api/catchup";
import type { CrossProjectRunSummary } from "../../api/home";

/** Run statuses that "ended red or stopped" (Home's own FAILED set). */
const FAILED = ["failed", "interrupted", "cancelled"];
/** Run statuses that wait on a person. */
const WAITING = ["waiting_human", "paused"];

export interface FactoryHealthProps {
  /** The board's run rows — the fallback counts. */
  runs: CrossProjectRunSummary[];
  /** The brief's arithmetic when it has one (ADR-0081). */
  numbers?: CatchUpBriefNumbers | null;
  /** Fixed clock for the "last day" fallback; prod passes nothing. */
  now?: Date;
}

/** The three counts the sentence prints, in its own order. */
export function factoryHealthCounts(
  runs: CrossProjectRunSummary[],
  numbers?: CatchUpBriefNumbers | null,
  now = new Date(),
): { running: number; waiting: number; failed: number } {
  if (numbers) {
    return {
      running: numbers.runs.running,
      waiting: numbers.approvals.pending,
      failed: numbers.runs.failed,
    };
  }
  const withinDay = (run: CrossProjectRunSummary) => {
    const at = run.finished_at ?? run.created_at;
    return now.getTime() - new Date(at).getTime() <= 24 * 60 * 60 * 1000;
  };
  return {
    running: runs.filter((run) => run.status === "running").length,
    waiting: runs.filter((run) => WAITING.includes(run.status)).length,
    failed: runs.filter((run) => FAILED.includes(run.status) && withinDay(run)).length,
  };
}

export function FactoryHealth({ runs, numbers, now }: FactoryHealthProps) {
  const counts = factoryHealthCounts(runs, numbers, now);
  const quiet = counts.running === 0 && counts.waiting === 0 && counts.failed === 0;
  return (
    <section data-testid="factory-health">
      <SectionLabel>Factory health</SectionLabel>
      <p data-testid="factory-health-sentence" className="text-[13.5px] leading-[20px] text-ink-2">
        {quiet
          ? "All quiet."
          : `${counts.running} running, ${counts.waiting} waiting on a person, ${counts.failed} failed in the last day.`}
      </p>
    </section>
  );
}

export default FactoryHealth;
