/**
 * The phone-first inbox card (design 2f → 3f, 390×844 first): a type chip,
 * the project, the age, the title, a two-line clamped model summary with
 * "More", and two 44px buttons. The model chooses the button labels; the
 * color comes from risk (`refuse`/`destructive` → danger, `proceed` →
 * primary, else secondary) and the labels stay free text.
 *
 * Honesty rule: when the server has no model summary and no suggested
 * actions (the assistant is not configured), the card falls back to the
 * static Approve / Read pair — it never invents a label or a summary.
 *
 * Every decision goes through a confirm step: tapping a button opens an
 * inline confirmation naming the label and the wire decision it records;
 * Escape closes it without deciding. `onDecide` fires only after the human
 * confirms. The card is presentational — the parent owns the decide
 * mutation and the navigation ("Read").
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "../ds/Button";
import { StatusChip } from "../ds/Row";
import { formatAge, testidOf } from "../../lib/format";
import { actionDecision, riskToVariant, type SuggestedAction } from "./riskStyle";

export interface InboxCardAction extends SuggestedAction {
  /**
   * The wire decision the card records for this action. Defaults to
   * `actionDecision(intent)`; a fallback (non-model) button names it
   * explicitly.
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
   * The model's suggested actions, at most two rendered. Omit for the
   * fallback card, which offers Approve / Read.
   */
  actions?: InboxCardAction[];
  /** Called once the human confirms a decision. */
  onDecide: (id: string, decision: "approved" | "rejected") => void;
  /** The detail link the "Read" button opens. */
  onOpen?: (id: string) => void;
}

const KIND_STATE = {
  approval: "waiting",
  permission: "info",
  failed: "failed",
} as const;

const FALLBACK_ACTIONS: InboxCardAction[] = [
  { label: "Approve", intent: "approve", risk: "proceed", decision: "approved" },
];

function decisionFor(action: InboxCardAction): "approved" | "rejected" | null {
  return action.decision ?? actionDecision(action.intent);
}

export default function InboxCard({
  kind,
  id,
  projectName,
  createdAt,
  title,
  summary,
  actions,
  onDecide,
  onOpen,
}: InboxCardProps) {
  const testid = testidOf(id);
  const [expanded, setExpanded] = useState(false);
  const [pending, setPending] = useState<InboxCardAction | null>(null);
  const [choice, setChoice] = useState<"approved" | "rejected" | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  const modelActions = (actions ?? []).slice(0, 2);
  const fallback = modelActions.length === 0;
  // The fallback card is still two 44px buttons: Approve (a decision) and
  // Read (a link, never a decision).
  const buttons: (InboxCardAction | { label: "Read" })[] = fallback
    ? [...FALLBACK_ACTIONS, { label: "Read" }]
    : modelActions;

  const openConfirm = useCallback((action: InboxCardAction) => {
    setChoice(decisionFor(action));
    setPending(action);
  }, []);

  const closeConfirm = useCallback(() => {
    setPending(null);
    setChoice(null);
  }, []);

  // Escape closes the confirm step without deciding; focus lands on the
  // confirming control so the step is reachable by keyboard alone.
  useEffect(() => {
    if (!pending) return;
    panelRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        closeConfirm();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pending, choice, closeConfirm]);

  const confirm = () => {
    if (pending && choice !== null) {
      onDecide(id, choice);
      closeConfirm();
    }
  };

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

      <div className="grid grid-cols-2 gap-2 p-3">
        {buttons.map((button, index) =>
          fallback && index === 1 ? (
            <Button
              key="read"
              variant="secondary"
              className="h-[44px]"
              data-testid={`inbox-card-read-${testid}`}
              onClick={() => onOpen?.(id)}
            >
              Read
            </Button>
          ) : (
            <Button
              key={button.label}
              variant={riskToVariant((button as InboxCardAction).risk)}
              className="h-[44px] text-[12.5px]"
              data-testid={`inbox-card-action-${testid}-${index}`}
              onClick={() => openConfirm(button as InboxCardAction)}
            >
              {button.label}
            </Button>
          ),
        )}
      </div>

      {pending ? (
        <div
          ref={panelRef}
          tabIndex={-1}
          role="group"
          aria-label={`Confirm: ${pending.label}`}
          className="mx-3 mb-3 rounded-[3px] border border-line bg-fill p-2.5"
          data-testid={`inbox-card-confirm-${testid}`}
        >
          <p className="text-[12.5px] leading-[1.45] text-ink">
            {choice === null ? (
              <>“{pending.label}” is not a decision word — choose the decision to record:</>
            ) : (
              <>
                Confirm <strong className="font-semibold">“{pending.label}”</strong>? This records{" "}
                <code className="font-mono text-[11.5px] text-ink">{choice}</code> on the gate.
              </>
            )}
          </p>
          {choice === null ? (
            <div className="mt-2 grid grid-cols-2 gap-2">
              <Button
                variant="primary"
                className="h-[40px] text-[12.5px]"
                data-testid={`inbox-card-confirm-approved-${testid}`}
                onClick={() => {
                  onDecide(id, "approved");
                  closeConfirm();
                }}
              >
                Approve
              </Button>
              <Button
                variant="danger"
                className="h-[40px] text-[12.5px]"
                data-testid={`inbox-card-confirm-rejected-${testid}`}
                onClick={() => {
                  onDecide(id, "rejected");
                  closeConfirm();
                }}
              >
                Reject
              </Button>
            </div>
          ) : (
            <div className="mt-2 flex gap-2">
              <Button
                variant={choice === "approved" ? "primary" : "danger"}
                className="h-[40px] flex-1 text-[12.5px]"
                data-testid={`inbox-card-confirm-go-${testid}`}
                onClick={confirm}
              >
                Confirm {choice === "approved" ? "approve" : "reject"}
              </Button>
              <Button
                variant="secondary"
                className="h-[40px] text-[12.5px]"
                data-testid={`inbox-card-confirm-cancel-${testid}`}
                onClick={closeConfirm}
              >
                Cancel
              </Button>
            </div>
          )}
        </div>
      ) : null}
    </article>
  );
}
