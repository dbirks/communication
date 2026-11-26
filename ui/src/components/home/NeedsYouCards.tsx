/**
 * NeedsYouCards — the redesigned Home's "NEEDS YOU" block (handoff README
 * §2): one pale-waiting card per gate waiting on the reader, built from the
 * same read Home's decision callouts use today (`useHomeApprovals`, rows
 * supplied by the page).
 *
 * Card (prototype §"NEEDS YOU"): bg `#fdf6e4`, 1px `#e8cf94`, radius 10,
 * padding 10 12 — "! " + the gate's own title (the summary's first line or
 * sentence, `splitGateSummary`'s cut), and under it the project · the age,
 * 12px muted. The whole card links where the callout's "Read plan" links:
 * the gate's own approval page. Status is glyph + word ("!"), never colour
 * alone (CONTRACT.md).
 */
import { Link } from "react-router";
import { SectionLabel } from "./SectionLabel";
import { splitGateSummary } from "./DecisionCallout";
import type { Approval } from "../../api/types";
import type { CrossProjectRunSummary } from "../../api/home";
import { formatAge, shortId } from "../../lib/format";
import { routes } from "../../lib/routes";

export interface NeedsYouCardsProps {
  /** The caller's pending gates (the `useHomeApprovals` rows). */
  approvals: Approval[];
  /** The board's run rows; supply each gate's project name, as the callouts do. */
  runs: CrossProjectRunSummary[];
}

export function NeedsYouCards({ approvals, runs }: NeedsYouCardsProps) {
  return (
    <section data-testid="needs-you">
      <SectionLabel testid="needs-you-label" glyph="!" tone="waiting">
        Needs you
      </SectionLabel>
      {approvals.length === 0 ? (
        <p data-testid="needs-you-empty" className="text-[13.5px] text-muted">
          Nothing is waiting on you.
        </p>
      ) : (
        <div className="flex flex-col gap-[8px]" data-testid="needs-you-cards">
          {approvals.map((approval) => {
            const run = runs.find((candidate) => candidate.id === approval.run_id);
            const meta = [
              run?.project_name ?? `run #${shortId(approval.run_id)}`,
              formatAge(approval.created_at),
            ]
              .filter(Boolean)
              .join(" · ");
            return (
              <Link
                key={approval.id}
                to={routes.approval(approval.id)}
                data-testid={`needs-you-card-${approval.id}`}
                className="block rounded-[10px] border border-st-waiting-pale-edge bg-st-waiting-pale-body px-[12px] py-[10px] focus-visible:outline-2 focus-visible:outline-accent"
              >
                <span className="block text-[13.5px] font-semibold text-st-waiting-pale-fg">
                  ! {splitGateSummary(approval.summary).title}
                </span>
                <span className="block text-[12px] text-muted">{meta}</span>
              </Link>
            );
          })}
        </div>
      )}
    </section>
  );
}

export default NeedsYouCards;
