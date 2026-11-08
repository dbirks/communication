/**
 * The phone-first inbox card (finding 04 rewrite): a type chip, the project,
 * the age, the title, a two-line clamped model summary with "More", a Read
 * link, and the shared `DecisionBar` — Approve / Request changes / Reject,
 * fixed verbs, no confirm step, a 5s undo hold on the decision.
 *
 * The model no longer chooses button labels: model-written text belongs in
 * the summary above the bar, never on a verb. The `actions` prop is kept for
 * wire compatibility with hosts that still pass the model's suggestions —
 * the card ignores it; there is no "is not a decision word" path any more,
 * because no label can be anything but a fixed verb.
 *
 * The card stays presentational: the decide mutation belongs to the parent,
 * so the bar's POST is injected (`submit`) and reaches the parent through
 * `onDecide(id, decision, comments?)` — "Request changes" arrives as
 * `rejected` with the person's note (see DecisionBar's mapping).
 */
import { useState } from "react";
import { Button } from "../ds/Button";
import DecisionBar from "../ds/DecisionBar";
import { StatusChip } from "../ds/Row";
import { formatAge, testidOf } from "../../lib/format";
import type { SuggestedAction } from "./riskStyle";

export interface InboxCardAction extends SuggestedAction {
  /**
   * Legacy field: the wire decision a model label used to record. The bar's
   * verbs are fixed now, so the card never reads it; it is kept so hosts
   * built against the old shape still compile while they are updated.
   */
  decision?: "approved" | "rejected";
}

export interface InboxCardProps {
  /** The attention kind the chip prints. */
  kind: "approval" | "permission" | "failed";
  /** The resource id (the approval id for `approval` cards). */
  id: string;
  projectName: string;
  /** The row's `created_at`, rendered as an age. */
  createdAt: string;
  /** The row title (the gate's `summary`, clamped by the caller if needed). */
  title: string;
  /** The model's two-line summary; omit for the fallback card. */
  summary?: string;
  /**
   * Legacy: the model's suggested actions. Kept on the interface so hosts
   * that still pass them compile; the card no longer renders them — the
   * DecisionBar's fixed verbs replaced every model-written label.
   */
  actions?: InboxCardAction[];
  /** Called when the bar's undo hold expires and the decision is posted.
   * `comments` carries the "Request changes" note (decision `rejected`). */
  onDecide: (id: string, decision: "approved" | "rejected", comments?: string) => void;
  /** The detail link the "Read" button opens. */
  onOpen?: (id: string) => void;
}

const KIND_STATE = {
  approval: "waiting",
  permission: "info",
  failed: "failed",
} as const;

export default function InboxCard({
  kind,
  id,
  projectName,
  createdAt,
  title,
  summary,
  onDecide,
  onOpen,
}: InboxCardProps) {
  const testid = testidOf(id);
  const [expanded, setExpanded] = useState(false);

  return (
    <article
      data-testid={`inbox-card-${testid}`}
      className="rounded-[3px] border border-line-strong bg-surface"
    >
      <div className="flex items-center gap-2 px-3 pt-2.5">
        <StatusChip state={KIND_STATE[kind]} label={kind} />
        <span className="text-[12px] font-medium text-ink-2">{projectName}</span>
        <span className="ml-auto font-mono text-[10.5px] text-faint">{formatAge(createdAt)}</span>
      </div>
      <h3
        className="px-3 pt-2 text-[14px] leading-[1.35] font-semibold text-ink"
        title={title}
        data-testid={`inbox-card-title-${testid}`}
      >
        {title}
      </h3>
      {summary ? (
        <p className="px-3 pt-1 text-[12.5px] leading-[1.45] text-muted">
          <span className={expanded ? "" : "line-clamp-2"}>{summary}</span>{" "}
          <button
            type="button"
            className="text-[11px] font-medium text-accent-text underline decoration-accent-mid"
            aria-expanded={expanded}
            data-testid={`inbox-card-more-${testid}`}
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? "Less" : "More"}
          </button>
        </p>
      ) : null}

      <div className="p-3">
        <DecisionBar
          approval={{ id }}
          compact
          submit={(body) => onDecide(id, body.decision, body.comments)}
        />
        {onOpen ? (
          <div className="mt-2">
            <Button
              variant="secondary"
              className="h-[36px]"
              data-testid={`inbox-card-read-${testid}`}
              onClick={() => onOpen(id)}
            >
              Read
            </Button>
          </div>
        ) : null}
      </div>
    </article>
  );
}
