/**
 * The brief's NUMBERS strip (ADR-0081 § numbers): the arithmetic the old recap
 * had no access to, on one line.
 *
 * Zero terms are OMITTED rather than printed as `0 succeeded`: a strip of
 * zeroes says nothing and pushes the terms that did happen off the line. All
 * zero is no strip at all — the page's quiet state owns that sentence. The
 * example line (`12 succeeded · 3 failed · 1 cancelled · 2 running · 4 PRs ·
 * 1 commit · 2 approvals decided`) is the shape; a pending-approval or
 * active-thread count joins it at the end, because the strip is the ONE place
 * those two numbers are said, and "any number > 0" means any of them.
 *
 * `interrupted` runs are counted with `cancelled` server-side (the schema has
 * no key for them), and `prs`/`commits` are counted from the harvest rather
 * than from the rows the cap left standing, so "3 shown, 9 more" still adds up
 * to the real fourteen.
 */
import type { CatchUpBriefNumbers } from "../../api/catchup";

/** The strip's terms, in the order the line reads them. */
export function numberTerms(numbers: CatchUpBriefNumbers): string[] {
  /** A countable noun gets its plural; a state word (`succeeded`, `running`)
   * never does — `3 faileds` is not a word. */
  const count = (n: number, word: string, many = word) => `${n} ${n === 1 ? word : many}`;
  return [
    numbers.runs.succeeded > 0 ? count(numbers.runs.succeeded, "succeeded") : null,
    numbers.runs.failed > 0 ? count(numbers.runs.failed, "failed") : null,
    numbers.runs.cancelled > 0 ? count(numbers.runs.cancelled, "cancelled") : null,
    numbers.runs.running > 0 ? count(numbers.runs.running, "running") : null,
    numbers.prs > 0 ? count(numbers.prs, "PR", "PRs") : null,
    numbers.commits > 0 ? count(numbers.commits, "commit", "commits") : null,
    numbers.approvals.decided > 0
      ? `${count(numbers.approvals.decided, "approval", "approvals")} decided`
      : null,
    numbers.approvals.pending > 0
      ? `${count(numbers.approvals.pending, "approval", "approvals")} waiting`
      : null,
    numbers.threads_active > 0 ? count(numbers.threads_active, "thread", "threads") : null,
  ].filter((term): term is string => term !== null);
}

export function BriefNumbers({ numbers }: { numbers: CatchUpBriefNumbers }) {
  const terms = numberTerms(numbers);
  if (terms.length === 0) return null;
  return (
    <p
      data-testid="catchup-brief-numbers"
      className="font-mono text-[11.5px] leading-[1.4] whitespace-normal text-muted"
    >
      {terms.join(" · ")}
    </p>
  );
}

export default BriefNumbers;
