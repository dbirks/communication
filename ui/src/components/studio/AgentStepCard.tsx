/**
 * AgentStepCard — compact floating card shown beside a selected `agent.acp`
 * step (CONTRACT "Agents & models" 4): "AGENT STEP" label, step name field,
 * `AgentPicker` profile selector, 6-row autosizing prompt textarea, and a
 * "More settings" link that opens the full inspector panel.
 */
import { useEffect, useState } from "react";
import { IconX } from "@tabler/icons-react";
import { renameNode, updateConfig, type OpResult } from "../../lib/pipeline/graphDoc";
import { AgentPicker } from "../shell/AgentPicker";

export interface AgentStepCardProps {
  nodeId: string;
  profile: string;
  prompt: string;
  text: string;
  readOnly: boolean;
  apply: (op: (text: string) => OpResult) => OpResult;
  onRenamed?: (newId: string) => void;
  onMoreSettings: () => void;
  onClose: () => void;
  sheet?: boolean;
  className?: string;
}

export function AgentStepCard({
  nodeId,
  profile,
  prompt,
  text,
  readOnly,
  apply,
  onRenamed,
  onMoreSettings,
  onClose,
  sheet = false,
  className = "",
}: AgentStepCardProps) {
  const [nameDraft, setNameDraft] = useState(nodeId);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [promptDraft, setPromptDraft] = useState(prompt);

  useEffect(() => {
    setNameDraft(nodeId);
    setRenameError(null);
  }, [nodeId]);

  useEffect(() => {
    setPromptDraft(prompt);
  }, [prompt]);

  function commitName() {
    if (readOnly) return;
    const next = nameDraft.trim();
    if (!next || next === nodeId) {
      setNameDraft(nodeId);
      setRenameError(null);
      return;
    }
    const probe = renameNode(text, nodeId, next);
    if (!probe.ok) {
      setRenameError("error" in probe ? probe.error : probe.reasons.join("; "));
      return;
    }
    setRenameError(null);
    const applied = apply((t) => renameNode(t, nodeId, next));
    if (applied.ok) onRenamed?.(next);
  }

  function commitPrompt() {
    if (readOnly || promptDraft === prompt) return;
    apply((t) => updateConfig(t, nodeId, { prompt: promptDraft || undefined }));
  }

  const promptRows = Math.max(
    6,
    Math.min(14, promptDraft.split("\n").length, Math.ceil(promptDraft.length / 42)),
  );

  const containerLayout = sheet
    ? "w-full rounded-t-[14px] rounded-b-none border-t border-line p-[16px] shadow-[var(--shadow-modal)]"
    : "w-[340px] rounded-[14px] border border-fill-edge p-[14px] shadow-[var(--shadow-pop)]";

  return (
    <div
      data-testid="agent-step-card"
      className={`flex flex-col gap-[12px] bg-surface ${containerLayout} ${className}`}
    >
      <div className="flex items-center gap-2">
        <span className="font-mono text-[10.5px] font-semibold uppercase tracking-[.06em] text-muted">
          AGENT STEP
        </span>
        <button
          type="button"
          aria-label="Close"
          data-testid="agent-card-close"
          onClick={onClose}
          className="icon-hit ml-auto inline-flex h-[24px] w-[24px] items-center justify-center rounded-[6px] text-muted hover:bg-fill hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
        >
          <IconX size={15} stroke={1.5} aria-hidden />
        </button>
      </div>

      <div className="flex flex-col gap-[4px]">
        <label htmlFor="agent-card-name" className="text-[12.5px] font-semibold text-ink-2">
          Step name
        </label>
        <input
          id="agent-card-name"
          type="text"
          disabled={readOnly}
          value={nameDraft}
          data-testid="agent-card-name"
          onChange={(e) => setNameDraft(e.target.value)}
          onBlur={commitName}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commitName();
            }
          }}
          className="w-full rounded-[8px] border border-line-strong bg-surface px-[10px] py-[6px] font-mono text-[13px] text-ink focus-visible:border-accent focus-visible:outline-2 focus-visible:outline-accent disabled:bg-disabled-bg disabled:text-muted"
        />
        {renameError ? (
          <p
            className="font-mono text-[11px] text-st-failed-tag-fg"
            data-testid="agent-card-rename-error"
          >
            {renameError}
          </p>
        ) : null}
      </div>

      <div className="flex flex-col gap-[4px]">
        <span className="text-[12.5px] font-semibold text-ink-2">Agent</span>
        <AgentPicker
          value={profile || null}
          side="bottom"
          disabled={readOnly}
          disabledReason="This workflow is read-only"
          testid="agent-card-picker"
          onChange={(profileId) => {
            if (readOnly) return;
            apply((t) => updateConfig(t, nodeId, { profile: profileId }));
          }}
        />
      </div>

      <div className="flex flex-col gap-[4px]">
        <label htmlFor="agent-card-prompt" className="text-[12.5px] font-semibold text-ink-2">
          Prompt
        </label>
        <textarea
          id="agent-card-prompt"
          rows={promptRows}
          disabled={readOnly}
          value={promptDraft}
          placeholder="What should this agent do?"
          data-testid="agent-card-prompt"
          onChange={(e) => setPromptDraft(e.target.value)}
          onBlur={commitPrompt}
          className="w-full resize-none rounded-[8px] border border-line-strong bg-surface px-[10px] py-[8px] font-ui text-[13px] leading-[19px] text-ink placeholder:text-faint focus-visible:border-accent focus-visible:outline-2 focus-visible:outline-accent disabled:bg-disabled-bg disabled:text-muted"
        />
      </div>

      <div className="flex items-center justify-between pt-[2px]">
        <button
          type="button"
          data-testid="agent-card-more-settings"
          onClick={onMoreSettings}
          className="text-[12.5px] font-semibold text-accent-text hover:underline focus-visible:outline-2 focus-visible:outline-accent"
        >
          More settings
        </button>
      </div>
    </div>
  );
}
