/**
 * AgentStepCard — compact floating card shown beside a selected `agent.acp`
 * step (CONTRACT "Agents & models" 4): "AGENT STEP" label, step name field,
 * `AgentPicker` profile selector, 4–8-row autosizing prompt textarea, and a
 * "More settings" link that opens the full inspector panel.
 */
import { useEffect, useState } from "react";
import { renameNode, updateConfig, type OpResult } from "../../lib/pipeline/graphDoc";
import { AgentPicker } from "../shell/AgentPicker";
import { BesideCard, type BesideSide } from "./BesideCard";

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
  /** 1a: "Wrap in…" — wrap this one step (opens the wrap card). */
  onWrap?: () => void;
  /** Caret side and offset from the beside-card placement (1a). */
  side?: BesideSide;
  caret?: number;
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
  side,
  caret,
  onWrap,
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

  // Editor interactions 1a: the prompt box starts at 4 rows and grows to 8,
  // then scrolls, so the card stays beside the step on an 800px screen.
  const promptRows = Math.max(
    4,
    Math.min(8, Math.max(promptDraft.split("\n").length, Math.ceil(promptDraft.length / 42))),
  );

  return (
    <BesideCard
      title="AGENT STEP"
      onClose={onClose}
      side={side}
      caret={caret}
      sheet={sheet}
      testid="agent-step-card"
      closeTestid="agent-card-close"
      className={className}
    >
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

      <div className="flex items-center gap-[14px] pt-[2px]">
        <button
          type="button"
          data-testid="agent-card-more-settings"
          onClick={onMoreSettings}
          className="text-[12.5px] font-semibold text-accent-text hover:underline focus-visible:outline-2 focus-visible:outline-accent"
        >
          More settings
        </button>
        {onWrap ? (
          <button
            type="button"
            data-testid="agent-card-wrap"
            onClick={onWrap}
            className="text-[12.5px] font-semibold text-accent-text hover:underline focus-visible:outline-2 focus-visible:outline-accent"
          >
            Wrap in…
          </button>
        ) : null}
        <span className="ml-auto font-mono text-[10.5px] text-faint">autosaved</span>
      </div>
    </BesideCard>
  );
}
