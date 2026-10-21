import { Button } from "../ds/Button";
import type { AssistantApprovalRequestPayload } from "./types";

/**
 * The amber approval gate (2a "Approval card", 4d §2; ADR-0050 Decision 4).
 *
 * Under a gated trust level the server stops the turn without executing
 * the risky tool and appends an `approval_request` row; this card is the
 * only actable surface for it. `Retry` posts `{"confirm": <id>}`,
 * `Not now` posts `{"dismiss": <id>}` — the caller maps those to the
 * messages POST. Buttons exist only while `state === "pending"`; once
 * decided the card keeps its place in the history with the outcome,
 * status as glyph + text, never colour alone.
 */
export interface ApprovalRequestCardProps {
  /** The transcript row's id — what confirm/dismiss name. */
  messageId: string;
  request: AssistantApprovalRequestPayload;
  onConfirm: (messageId: string) => void;
  onDismiss: (messageId: string) => void;
}

export function ApprovalRequestCard({
  messageId,
  request,
  onConfirm,
  onDismiss,
}: ApprovalRequestCardProps) {
  const pending = request.state === "pending";

  const headerText = pending
    ? "! NEEDS APPROVAL"
    : request.state === "confirmed"
      ? "✓ APPROVED"
      : "· NOT NOW — DISMISSED";

  return (
    <div
      data-testid="assistant-approval"
      role="group"
      aria-label={`Needs approval: ${request.summary}`}
      className="overflow-hidden px-[10px] py-[8px]"
      style={{
        border: "1px solid var(--color-st-waiting-pale-edge)",
        borderRadius: 4,
        background: "var(--color-st-waiting-pale-body)",
        display: "inline-block",
        maxWidth: "100%",
      }}
    >
      <p
        data-testid="assistant-approval-header"
        className="m-0 font-mono text-[10px] font-semibold tracking-wide"
        style={{
          background: "var(--color-st-waiting-pale-bar)",
          color: "var(--color-st-waiting-pale-fg)",
          padding: "4px 8px",
          margin: "-8px -10px 8px",
        }}
      >
        {headerText}
      </p>
      <p className="m-0 whitespace-pre-wrap text-[13px] leading-[1.45] text-ink">
        {request.summary}
      </p>
      {request.risk ? (
        <p className="m-0 mt-[4px] whitespace-pre-wrap text-[11px] leading-[1.4] text-muted">
          {request.risk}
        </p>
      ) : null}
      {pending ? (
        <div className="mt-[8px] flex gap-[8px]">
          <Button
            variant="primary"
            compact
            data-testid="assistant-approval-confirm"
            onClick={() => onConfirm(messageId)}
          >
            Retry
          </Button>
          <Button
            variant="secondary"
            compact
            data-testid="assistant-approval-dismiss"
            onClick={() => onDismiss(messageId)}
          >
            Not now
          </Button>
        </div>
      ) : request.state === "confirmed" ? (
        <p className="m-0 mt-[6px] font-mono text-[10.5px] text-st-done-pale-fg">
          approved · the action ran once as you
        </p>
      ) : (
        <p className="m-0 mt-[6px] font-mono text-[10.5px] text-faint">dismissed · nothing ran</p>
      )}
    </div>
  );
}

export default ApprovalRequestCard;
