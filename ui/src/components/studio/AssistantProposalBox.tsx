/**
 * AssistantProposalBox.tsx — "Ask to change this draft" (ADR-0044 UI half,
 * design `studio-workbench.md` §8).
 *
 * One box, one safe drafting loop:
 *  1. The instruction goes to `POST /api/v1/assistant/draft-proposals`
 *     (draft + version + instruction); the server returns one closed-set op
 *     and writes nothing.
 *  2. The op is applied to the draft text with the same pure `graphDoc`
 *     ops a human gesture would use (`applyProposal`). A clean result hands
 *     the page the new text, the node ids to highlight
 *     (`data-highlight="assistant-proposed"`) and the server's summary; an
 *     ambiguous/failed result is shown, not previewed.
 *  3. While the page previews, the box says so (caption) and offers
 *     **Apply** (the ordinary version-checked `PUT`) or **Discard** (revert).
 *     Publishing is never offered here — the assistant proposes, a human
 *     publishes.
 *
 * The page owns all state that outlives this box (`text`, `previewing`,
 * the pre-proposal text); this box owns only the instruction and errors.
 */
import { useEffect, useState, type FormEvent } from "react";
import {
  draftProposalErrorOf,
  useDraftProposal,
  type DraftProposalResponse,
} from "../../api/draftProposals";
import { applyProposal, type ProposalOp } from "../../lib/pipeline/proposalOps";
import { Button } from "../ds/Button";
import { Textarea } from "../ds/Field";

/** One preview payload: what changed and which nodes to highlight. */
export interface AssistantProposalPreview {
  text: string;
  nodeIds: string[];
  summary: string;
}

export interface AssistantProposalBoxProps {
  draftId: string;
  /** The saved draft version proposals are made against. */
  version: number;
  /** The saved draft YAML text the op is applied to locally. */
  text: string;
  /** No write access — asking would 403. */
  readOnly: boolean;
  /** Unsaved edits: a proposal applied to saved text would lose them. */
  dirty: boolean;
  /** The page is showing a proposal preview (highlight + caption). */
  previewing: boolean;
  /** The page adopts the previewed text and highlights `nodeIds`. */
  onPreview(next: AssistantProposalPreview): void;
  /** The page saves the previewed text with the normal version-checked PUT. */
  onApply(): void;
  /** The page restores the pre-proposal text and clears the highlight. */
  onDiscard(): void;
  /** Design 1g: render as the studio's collapsed footer row ("Ask to change this draft… ⌘K"). */
  footer?: boolean;
}

/** The caption ADR-0044 §4 pins while a proposal is on canvas. */
export const PROPOSAL_CAPTION = "Assistant proposed this change — review, then Apply or Discard";

export function AssistantProposalBox({
  draftId,
  version,
  text,
  readOnly,
  dirty,
  previewing,
  onPreview,
  onApply,
  onDiscard,
  footer = false,
}: AssistantProposalBoxProps) {
  const [open, setOpen] = useState(!footer);
  const [instruction, setInstruction] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [previewSummary, setPreviewSummary] = useState<string | null>(null);
  const proposal = useDraftProposal();

  // Design 1g: in the studio the box collapses to the footer row; ⌘K opens it.
  useEffect(() => {
    if (!footer) return;
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        event.stopImmediatePropagation();
        setOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [footer]);

  const blockedReason = readOnly
    ? "This draft is read-only, so the assistant can't be asked to change it."
    : dirty
      ? "Save your edits first — proposals are made against the saved version."
      : null;
  const submitting = proposal.isPending;
  const canSubmit = !blockedReason && instruction.trim().length > 0 && !submitting;

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!canSubmit) return;
    setError(null);
    proposal.mutate(
      { draftId, version, instruction: instruction.trim() },
      {
        onSuccess: (data) => apply(data),
        onError: (err) => setError(draftProposalErrorOf(err)),
      },
    );
  }

  function apply(data: DraftProposalResponse) {
    const result = applyProposal(text, data.op as ProposalOp);
    if (!result.ok) {
      setError("error" in result ? result.error : result.reasons.join("; "));
      return;
    }
    setInstruction("");
    setPreviewSummary(data.summary);
    onPreview({ text: result.text, nodeIds: data.node_ids, summary: data.summary });
  }

  return (
    <section
      data-testid="assistant-proposal-box"
      className={
        footer
          ? // Design 1g: the studio's assistant row is a pinned bottom strip
            // of the inspector column — a top border, no box.
            "overflow-hidden border-t border-line bg-surface"
          : "overflow-hidden rounded-[3px] border border-line bg-surface"
      }
    >
      {footer && !open ? (
        <button
          type="button"
          data-testid="assistant-proposal-footer"
          onClick={() => setOpen(true)}
          aria-expanded={false}
          className="flex w-full items-center gap-[8px] px-[14px] py-[10px] text-left text-body hover:bg-fill focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent-ring"
        >
          Ask to change this draft…
          <span className="ml-auto font-mono text-[10.5px] tracking-[.04em] text-faint">⌘K</span>
        </button>
      ) : (
        <>
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            className="flex w-full items-center gap-2 px-[10px] py-[6px] text-left text-body"
          >
            <span aria-hidden="true" className="text-faint">
              {open ? "▾" : "▸"}
            </span>
            Ask to change this draft…
            {previewing && (
              <span className="ml-auto font-mono text-[10.5px] tracking-[.04em] text-faint">
                reviewing
              </span>
            )}
          </button>
          {open && (
            <div className="space-y-[8px] border-t border-line-soft px-[10px] py-[8px]">
              {previewing ? (
                <>
                  <p data-testid="assistant-proposal-caption" className="text-body">
                    {PROPOSAL_CAPTION}
                  </p>
                  {previewSummary && <p className="text-faint">{previewSummary}</p>}
                  <div className="flex gap-2">
                    <Button
                      variant="primary"
                      data-testid="assistant-proposal-apply"
                      onClick={onApply}
                    >
                      Apply
                    </Button>
                    <Button
                      variant="secondary"
                      data-testid="assistant-proposal-discard"
                      onClick={onDiscard}
                    >
                      Discard
                    </Button>
                  </div>
                </>
              ) : (
                <>
                  <form onSubmit={submit} className="space-y-[8px]">
                    <Textarea
                      data-testid="assistant-proposal-input"
                      rows={2}
                      placeholder="Describe the change you want"
                      value={instruction}
                      disabled={blockedReason !== null || submitting}
                      onChange={(event) => {
                        setInstruction(event.target.value);
                        setError(null);
                      }}
                    />
                    {blockedReason && (
                      <p data-testid="assistant-proposal-reason" className="text-faint">
                        {blockedReason}
                      </p>
                    )}
                    {error && (
                      <p data-testid="assistant-proposal-error" className="text-ink">
                        {error}
                      </p>
                    )}
                    <div>
                      <Button
                        variant="primary"
                        compact
                        type="submit"
                        data-testid="assistant-proposal-submit"
                        disabled={!canSubmit}
                      >
                        {submitting ? "Thinking…" : "Propose"}
                      </Button>
                    </div>
                  </form>
                </>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}
