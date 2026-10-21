/**
 * The briefing's decision callouts (artboard 2a): the caller's pending
 * gates, at most three, in the amber "needs action" panel.
 *
 * The gate's own `summary` is the body, labelled "from the workflow" —
 * never "written by the model": the gate text is the author's static
 * config, digested, and nothing on the wire says otherwise.
 * `Approve` always asks for a small confirmation first (an approval is
 * a business outcome, not a click), then posts to the existing decide
 * endpoint with the row's `version` as the CAS token; a `409` adopts the
 * winner, the Inbox row's rule (`api/approvals.ts`).
 */
import { useMemo, useState } from "react";
import { Link } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "../ds/Button";
import { Panel } from "../ds/Panel";
import { adoptApprovalConflict, approvalConflictOf, useDecideApproval } from "../../api/approvals";
import { problemOf } from "../../api/client";
import type { Approval } from "../../api/types";
import type { CrossProjectRunSummary } from "../../api/home";
import { formatAge, shortId, testidOf } from "../../lib/format";
import { routes } from "../../lib/routes";

/** How many callouts the briefing renders before pointing at the Inbox. */
export const CALLOUT_MAX = 3;

export interface DecisionCalloutsProps {
  approvals: Approval[];
  /** The briefing's run rows; supplies each gate's workflow/project names. */
  runs: CrossProjectRunSummary[];
}

export function DecisionCallouts({ approvals, runs }: DecisionCalloutsProps) {
  const shown = approvals.slice(0, CALLOUT_MAX);
  const rest = approvals.length - shown.length;
  return (
    <Panel
      title="NEEDS YOUR DECISION"
      state="waiting"
      headingId="home-callouts-heading"
      headingLevel={2}
      meta={approvals.length > 1 ? String(approvals.length) : undefined}
    >
      <div data-testid="home-callouts">
        {shown.map((approval) => (
          <CalloutRow key={approval.id} approval={approval} runs={runs} />
        ))}
      </div>
      {rest > 0 ? (
        <p className="border-t border-line px-[10px] py-[6px] text-right">
          <Link
            to={routes.inbox()}
            className="font-mono text-[11px] underline"
            data-testid="home-more-inbox"
          >
            {rest} more in Inbox ›
          </Link>
        </p>
      ) : null}
    </Panel>
  );
}

function CalloutRow({ approval, runs }: { approval: Approval; runs: CrossProjectRunSummary[] }) {
  const decide = useDecideApproval(approval.project_id);
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The briefing's own run rows carry the workflow and project human names;
  // a run that left the list (finished while this tab was open) still shows
  // its short id — the names are never invented.
  const run = useMemo(
    () => runs.find((candidate) => candidate.id === approval.run_id),
    [runs, approval.run_id],
  );
  const workflow = run ? run.pipeline_display_name : undefined;
  const project = run?.project_name;

  const submit = () => {
    setConfirming(false);
    setError(null);
    decide.mutate(
      { approvalId: approval.id, body: { decision: "approved", version: approval.version } },
      {
        onSuccess: () => setError(null),
        onError: (err) => {
          if (approvalConflictOf(err)) {
            adoptApprovalConflict(queryClient, err);
            setError("someone decided this gate first — what you see now is the winner's");
          } else {
            setError(problemOf(err).detail || problemOf(err).title);
          }
        },
      },
    );
  };

  return (
    <div
      className="border-b border-line px-[10px] py-[8px] last:border-b-0"
      data-testid={`home-callout-${testidOf(approval.id)}`}
    >
      <p className="font-mono text-[10.5px] text-faint">
        {workflow ? `${workflow} · ` : ""}run #{shortId(approval.run_id)}
        {project ? ` · ${project}` : ""} · {formatAge(approval.created_at)}
      </p>
      <p className="mt-1 font-mono text-[10px] tracking-[.03em] text-st-waiting-strong-fg uppercase">
        from the workflow
      </p>
      <p
        className="mt-[2px] text-[13.5px] font-semibold leading-[1.35]"
        data-testid={`home-callout-summary-${testidOf(approval.id)}`}
        title={approval.summary}
      >
        {approval.summary}
      </p>
      <div className="mt-[8px] flex flex-wrap items-center gap-2">
        <Link
          to={routes.run(approval.run_id)}
          className="ds-btn ds-btn--secondary ds-btn--compact inline-flex h-[26px] items-center rounded-[4px] px-3"
          data-testid={`home-read-plan-${testidOf(approval.id)}`}
        >
          Read plan
        </Link>
        {confirming ? (
          <>
            <span className="font-mono text-[10.5px] text-muted" role="status">
              approve this gate?
            </span>
            <Button
              variant="primary"
              compact
              disabled={decide.isPending}
              data-testid={`home-approve-confirm-${testidOf(approval.id)}`}
              onClick={submit}
            >
              Confirm
            </Button>
            <Button
              variant="ghost"
              compact
              data-testid={`home-approve-cancel-${testidOf(approval.id)}`}
              onClick={() => setConfirming(false)}
            >
              Cancel
            </Button>
          </>
        ) : (
          <Button
            variant="primary"
            compact
            disabled={decide.isPending}
            data-testid={`home-approve-${testidOf(approval.id)}`}
            onClick={() => setConfirming(true)}
          >
            {decide.isPending ? "Posting…" : "Approve"}
          </Button>
        )}
      </div>
      {error ? (
        <p
          className="mt-[6px] font-mono text-[10.5px] text-st-failed-tag-fg"
          role="alert"
          data-testid={`home-callout-error-${testidOf(approval.id)}`}
        >
          × {error}
        </p>
      ) : null}
    </div>
  );
}
