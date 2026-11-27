/**
 * WorkflowSuggestion — the single pill above the chat composer suggesting a
 * workflow run for the issue discussed in the chat (redesign R3).
 *
 * Lives outside the composer `<form>`, never auto-focuses, and has no
 * keyboard shortcut: the user must explicitly click "Run it" or Dismiss (×).
 */
import { IconBuildingFactory2, IconX } from "@tabler/icons-react";
import { FormError } from "../Feedback";
import type { WorkflowSuggestionResult } from "./chatSuggestion";

export interface WorkflowSuggestionProps {
  suggestion: Pick<WorkflowSuggestionResult, "pipelineId" | "name" | "subject" | "summary">;
  busy?: boolean;
  error?: unknown;
  onRun: () => void;
  onDismiss: () => void;
}

export function WorkflowSuggestion({
  suggestion,
  busy = false,
  error,
  onRun,
  onDismiss,
}: WorkflowSuggestionProps) {
  return (
    <div className="mb-[8px] flex flex-col gap-[6px]">
      <div
        data-testid="workflow-suggestion"
        className="inline-flex max-w-full flex-wrap items-center gap-[8px] self-start rounded-full border border-accent-mid bg-accent-wash py-[6px] pl-[14px] pr-[8px] text-[13px] text-ink"
      >
        <IconBuildingFactory2
          size={15}
          stroke={1.5}
          className="shrink-0 text-accent-edge"
          aria-hidden="true"
        />
        <span className="min-w-0">
          Run <strong className="font-semibold">{suggestion.name}</strong> on {suggestion.subject}{" "}
          instead?
          {suggestion.summary ? (
            <>
              {" "}
              <em className="italic text-muted">{suggestion.summary}</em>
            </>
          ) : null}
        </span>
        <button
          type="button"
          data-testid="workflow-suggestion-run"
          disabled={busy}
          onClick={onRun}
          className="ds-btn ds-btn--primary ds-btn--compact shrink-0 rounded-full! text-[12px]!"
        >
          {busy ? "Starting…" : "Run it"}
        </button>
        <button
          type="button"
          data-testid="workflow-suggestion-dismiss"
          aria-label="Dismiss"
          disabled={busy}
          onClick={onDismiss}
          className="grid h-[24px] w-[24px] shrink-0 place-items-center rounded-full text-muted hover:bg-accent-tint hover:text-ink focus-visible:outline-2 focus-visible:outline-accent disabled:text-disabled-fg"
        >
          <IconX size={14} stroke={1.5} aria-hidden="true" />
        </button>
      </div>
      {error ? <FormError error={error} testid="workflow-suggestion-error" /> : null}
    </div>
  );
}
