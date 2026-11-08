/**
 * RunNotFound — the one answer both run surfaces (the workbench header and the
 * run inspector) give for a run read that came back 404 (finding 12).
 *
 * The old line was a note to the reviewer: it named the control plane, quoted
 * the status code and explained why the page shows no scaffold — an internal
 * design decision the reader cannot act on. The sentence here follows the
 * rulebook in `docs/design/design-system.md`: what happened, then the way out.
 *
 * The two actions depend on what the page knows:
 *   - With a project id (the project-scoped run routes) `Back to Runs` lands on
 *     that project's runs tab and `Ask for access` on its members page.
 *   - On the project-less deep link (`/runs/:runId`) the 404 means there is no
 *     project to name, so `Back to Runs` goes to the briefing and access is a
 *     sentence naming who to ask rather than a link to a page that may not
 *     exist for this reader.
 * A 404 is a refusal, not a break, so there is no retry button and no `Details`
 * disclosure: re-asking for a run that is not there answers the same.
 */
import { Link } from "react-router";
import { Alert } from "../ds/Alert";
import { routes } from "../../lib/routes";

export function RunNotFound({ runId, projectId = "" }: { runId: string; projectId?: string }) {
  const named = projectId !== "";
  return (
    <div className="px-4 py-6" data-testid="run-not-found">
      <Alert state="info" label="NOT FOUND" barTone="neutral" role="status">
        <div className="min-w-0 max-w-[70ch] space-y-[3px]">
          <p className="text-[13px] font-semibold text-ink" data-testid="run-not-found-summary">
            This run doesn&apos;t exist or you don&apos;t have access to it.
          </p>
          {/* The id the reader followed is data they can quote to an admin, so it
              keeps its own muted line rather than sitting inside the sentence. */}
          <p className="font-mono text-[11px] text-muted" data-testid="run-not-found-id">
            run {runId}
          </p>
          <div className="flex flex-wrap items-center gap-[6px] pt-[3px]">
            <Link
              to={named ? routes.projectTab(projectId, "runs") : routes.home()}
              className="ds-btn ds-btn--secondary ds-btn--compact inline-flex items-center rounded-[4px]"
              data-testid="run-not-found-runs"
            >
              Back to Runs
            </Link>
            {named ? (
              <Link
                to={routes.projectMembers(projectId)}
                className="ds-btn ds-btn--secondary ds-btn--compact inline-flex items-center rounded-[4px]"
                data-testid="run-not-found-access"
              >
                Ask for access
              </Link>
            ) : (
              <span className="text-[12px] text-muted" data-testid="run-not-found-access">
                Ask an admin of the project this run belongs to for access.
              </span>
            )}
          </div>
        </div>
      </Alert>
    </div>
  );
}
