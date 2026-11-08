/**
 * The briefing's decision callouts (artboard 2a): the caller's pending
 * gates in the amber "needs action" panel — the first three are shown,
 * the rest expand IN PLACE on `Show n more` (finding 03: nothing on
 * Today links to the Inbox any more).
 *
 * The gate's own `summary` is the body, labelled "from the workflow" —
 * never "written by the model": the gate text is the author's static
 * config, digested, and nothing on the wire says otherwise. Printed whole
 * it reads as one bold block, so the summary's first line (or first
 * sentence) is the card's title and the plan under it is body text, clamped
 * to three lines with the full text behind the `Read plan` link. Deciding is
 * the shared `DecisionBar` (finding 04): fixed verbs, a 5s undo hold
 * instead of a confirm step, the POST owned by the bar.
 *
 * Finding 04 (the race proof): a live `approval.decided` frame pulls a
 * decided gate out of the pending query while the viewer's hold is still
 * open — the bar notices through the shared cache, cancels the hold without
 * posting, and reports the loss here. The panel then keeps that callout on
 * screen as a "lost" row (rendered from a local list, outside the pending
 * query) until the person dismisses it: the sentence says who decided, and
 * the row never vanishes with the news.
 */
import { useCallback, useMemo, useState } from "react";
import { Link } from "react-router";
import { Panel } from "../ds/Panel";
import { Button } from "../ds/Button";
import DecisionBar from "../ds/DecisionBar";
import type { DecisionConflict } from "../ds/DecisionBar";
import type { Approval } from "../../api/types";
import type { CrossProjectRunSummary } from "../../api/home";
import { formatAge, shortId, testidOf } from "../../lib/format";
import { routes } from "../../lib/routes";

/** How many callouts the briefing renders before offering to show the rest. */
export const CALLOUT_PREVIEW = 3;

/**
 * The cut between a gate summary's title and its body.
 *
 * A planner gate's summary is a prose lead-in followed by the plan itself, and
 * printed whole it reads as one shouty block. The first line — or, when the
 * summary is one line, its first sentence — is the title; everything after it
 * is the body. A summary that is only its first sentence has no body: the
 * whole text is the title, exactly as before.
 */
export function splitGateSummary(summary: string): { title: string; body: string } {
  const text = summary.trim();
  const newline = /^([^\r\n]*)\r?\n([\s\S]*)$/.exec(text);
  if (newline && newline[1].trim() !== "" && newline[2].trim() !== "") {
    return { title: newline[1].trim(), body: newline[2].trim() };
  }
  const sentence = /^[\s\S]{1,}?(?<=[\u2026!?.\uFF0E\uFF01\uFF1F])(?=\s[\s\S])/u.exec(text);
  if (sentence) {
    const title = text.slice(0, sentence.index + sentence[0].length).trim();
    const body = text.slice(sentence.index + sentence[0].length).trim();
    if (title !== "" && body !== "") return { title, body };
  }
  return { title: text, body: "" };
}

export interface DecisionCalloutsProps {
  approvals: Approval[];
  /** The briefing's run rows; supplies each gate's workflow/project names. */
  runs: CrossProjectRunSummary[];
}

/** A callout whose decision lost the race: the row as last seen (for the
 * card's own header and title) plus the facts the bar reported. */
interface LostCallout {
  approval: Approval;
  conflict: DecisionConflict;
}

export function DecisionCallouts({ approvals, runs }: DecisionCalloutsProps) {
  const [expanded, setExpanded] = useState(false);
  // Finding 04: gates whose bar reported "someone else decided" stay here —
  // outside the pending query, which has already dropped them — until the
  // person dismisses the callout. A newer report for the same gate replaces
  // the older one (the bar re-reports when the decider's name arrives).
  const [lost, setLost] = useState<LostCallout[]>([]);
  const rememberLost = useCallback((row: Approval, conflict: DecisionConflict) => {
    setLost((current) => {
      const rest = current.filter((entry) => entry.conflict.approvalId !== conflict.approvalId);
      return [...rest, { approval: row, conflict }];
    });
  }, []);
  const dismissLost = useCallback((approvalId: string) => {
    setLost((current) => current.filter((entry) => entry.conflict.approvalId !== approvalId));
  }, []);

  const lostIds = new Set(lost.map((entry) => entry.conflict.approvalId));
  const pending = approvals.filter((approval) => !lostIds.has(approval.id));
  const shown = expanded ? pending : pending.slice(0, CALLOUT_PREVIEW);
  const rest = pending.length - shown.length;
  return (
    <Panel
      title="NEEDS YOUR DECISION"
      state="waiting"
      headingId="home-callouts-heading"
      headingLevel={2}
      meta={approvals.length > 1 ? String(approvals.length) : undefined}
    >
      <div data-testid="home-callouts">
        {/* Lost rows ride above the live list: they are the news the person
            has not dismissed, and the pending query no longer carries them. */}
        {lost.map((entry) => (
          <CalloutRow
            key={`lost-${entry.approval.id}`}
            approval={entry.approval}
            runs={runs}
            conflict={entry.conflict}
            onDismiss={() => dismissLost(entry.conflict.approvalId)}
          />
        ))}
        {shown.map((approval) => (
          <CalloutRow key={approval.id} approval={approval} runs={runs} onLost={rememberLost} />
        ))}
      </div>
      {rest > 0 ? (
        <p className="border-t border-line px-[10px] py-[6px] text-right">
          <Button
            variant="secondary"
            compact
            data-testid="home-show-more"
            onClick={() => setExpanded(true)}
          >
            Show {rest} more
          </Button>
        </p>
      ) : null}
    </Panel>
  );
}

function CalloutRow({
  approval,
  runs,
  conflict = null,
  onLost,
  onDismiss,
}: {
  approval: Approval;
  runs: CrossProjectRunSummary[];
  /** Set when this row is a just-decided-elsewhere callout: the bar renders
   * straight into the sticky conflict sentence, plus a Dismiss control. */
  conflict?: DecisionConflict | null;
  onLost?: (approval: Approval, conflict: DecisionConflict) => void;
  onDismiss?: () => void;
}) {
  // The briefing's own run rows carry the workflow and project human names;
  // a run that left the list (finished while this tab was open) still shows
  // its short id — the names are never invented.
  const run = useMemo(
    () => runs.find((candidate) => candidate.id === approval.run_id),
    [runs, approval.run_id],
  );
  const workflow = run ? run.pipeline_display_name : undefined;
  const project = run?.project_name;
  const { title, body } = splitGateSummary(approval.summary);

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
      {/* The summary's own first line (or sentence) is the card's title; the
          rest of it is body text under it, clamped to three lines. The whole
          text is never lost: the `title` carries it and `Read plan` opens the
          gate's own page. */}
      <p
        className="mt-[2px] text-[13.5px] font-semibold leading-[1.35]"
        data-testid={`home-callout-summary-${testidOf(approval.id)}`}
        title={approval.summary}
      >
        {title}
      </p>
      {body !== "" ? (
        <p
          className="mt-[2px] text-[12.5px] leading-[1.45] text-muted line-clamp-3"
          data-testid={`home-callout-body-${testidOf(approval.id)}`}
        >
          {body}
        </p>
      ) : null}
      <div className="mt-[8px] flex flex-wrap items-center gap-2">
        <Link
          to={routes.approval(approval.id)}
          className="ds-btn ds-btn--secondary ds-btn--compact inline-flex h-[26px] items-center rounded-[4px] px-3"
          data-testid={`home-read-plan-${testidOf(approval.id)}`}
        >
          Read plan
        </Link>
        <DecisionBar
          approval={approval}
          compact
          initialConflict={conflict}
          onConflict={
            onLost && conflict === null
              ? (info: DecisionConflict) => onLost(approval, info)
              : undefined
          }
        />
        {conflict !== null && onDismiss ? (
          <Button
            variant="secondary"
            compact
            data-testid={`home-callout-dismiss-${testidOf(approval.id)}`}
            onClick={onDismiss}
          >
            Dismiss
          </Button>
        ) : null}
      </div>
    </div>
  );
}
