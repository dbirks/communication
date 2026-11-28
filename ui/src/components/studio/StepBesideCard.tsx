/**
 * StepBesideCard — beside-card body for the non-agent step kinds a canvas
 * selection can hit (editor-interactions "1a"): `process.exec` (COMMAND
 * STEP), `human.approval` (APPROVAL) and `model.chat` (JUDGE). Same field
 * look and autosave-on-blur behavior as AgentStepCard: edits commit through
 * `apply` + `updateConfig` only when the value actually changed, and the
 * step name renames through `renameNode` with an inline error probe.
 */
import { useEffect, useState } from "react";
import { renameNode, updateConfig, type OpResult } from "../../lib/pipeline/graphDoc";
import { BesideCard, type BesideSide } from "./BesideCard";

export type StepBesideKind = "process.exec" | "human.approval" | "model.chat";

export interface StepBesideCardProps {
  nodeId: string;
  kind: StepBesideKind;
  /** The node's current config object. */
  config: Record<string, unknown>;
  /** Draft YAML text (for renameNode probing, like AgentStepCard). */
  text: string;
  readOnly: boolean;
  apply: (op: (text: string) => OpResult) => OpResult;
  onRenamed?: (newId: string) => void;
  onMoreSettings: () => void;
  /** "Wrap in…" link: wrap this one step (opens the wrap card). */
  onWrap?: () => void;
  onClose: () => void;
  sheet?: boolean;
  side?: BesideSide;
  caret?: number;
}

const TITLE: Record<StepBesideKind, string> = {
  "process.exec": "COMMAND STEP",
  "human.approval": "APPROVAL",
  "model.chat": "JUDGE",
};

const INPUT_CLASS =
  "w-full rounded-[8px] border border-line-strong bg-surface px-[10px] py-[7px] text-[13px] text-ink focus-visible:border-accent focus-visible:outline-2 focus-visible:outline-accent disabled:bg-disabled-bg disabled:text-muted";
const MONO_INPUT_CLASS = `${INPUT_CLASS} font-mono`;
const TEXTAREA_CLASS = `${INPUT_CLASS} resize-none leading-[19px]`;
const LABEL_CLASS = "text-[12.5px] font-semibold text-ink-2";

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

interface MessageRecord {
  role: string;
  content: string;
  [key: string]: unknown;
}

function asMessages(value: unknown): MessageRecord[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) =>
    entry !== null && typeof entry === "object" && !Array.isArray(entry)
      ? ({
          ...(entry as Record<string, unknown>),
          role: asString((entry as MessageRecord).role),
          content: asString((entry as MessageRecord).content),
        } as MessageRecord)
      : { role: "system", content: "" },
  );
}

/** Index of the system message, or the first message when none is system; -1 when empty. */
function taskIndex(messages: MessageRecord[]): number {
  if (messages.length === 0) return -1;
  const system = messages.findIndex((m) => m.role === "system");
  return system >= 0 ? system : 0;
}

export function StepBesideCard({
  nodeId,
  kind,
  config,
  text,
  readOnly,
  apply,
  onRenamed,
  onMoreSettings,
  onWrap,
  onClose,
  sheet = false,
  side,
  caret,
}: StepBesideCardProps) {
  // Derived current values from the node's config object.
  const commandValue = (() => {
    const executable = asString(config.executable);
    const args = asStringArray(config.args);
    return (executable ? [executable, ...args] : args).join(" ");
  })();
  const summaryValue = asString(config.summary);
  const approversValue = asStringArray(config.approverRoles);
  const approversJoined = approversValue.join(", ");
  const modelValue = asString(config.model);
  const messages = asMessages(config.messages);
  const taskIdx = taskIndex(messages);
  const taskValue = taskIdx >= 0 ? messages[taskIdx].content : "";

  const [nameDraft, setNameDraft] = useState(nodeId);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [commandDraft, setCommandDraft] = useState(commandValue);
  const [summaryDraft, setSummaryDraft] = useState(summaryValue);
  const [approversDraft, setApproversDraft] = useState(approversValue.join(", "));
  const [modelDraft, setModelDraft] = useState(modelValue);
  const [taskDraft, setTaskDraft] = useState(taskValue);

  useEffect(() => {
    setNameDraft(nodeId);
    setRenameError(null);
  }, [nodeId]);
  useEffect(() => {
    setCommandDraft(commandValue);
  }, [commandValue]);
  useEffect(() => {
    setSummaryDraft(summaryValue);
  }, [summaryValue]);
  useEffect(() => {
    setApproversDraft(approversJoined);
  }, [approversJoined]);
  useEffect(() => {
    setModelDraft(modelValue);
  }, [modelValue]);
  useEffect(() => {
    setTaskDraft(taskValue);
  }, [taskValue]);

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

  function commitCommand() {
    if (readOnly || commandDraft.trim() === commandValue.trim()) return;
    const words = commandDraft.trim().split(/\s+/).filter(Boolean);
    apply((t) =>
      updateConfig(t, nodeId, {
        executable: words.length > 0 ? words[0] : undefined,
        args: words.length > 1 ? words.slice(1) : undefined,
      }),
    );
  }

  function commitSummary() {
    if (readOnly || summaryDraft === summaryValue) return;
    apply((t) => updateConfig(t, nodeId, { summary: summaryDraft || undefined }));
  }

  function commitApprovers() {
    if (readOnly) return;
    const roles = approversDraft
      .split(",")
      .map((role) => role.trim())
      .filter(Boolean);
    if (roles.join(", ") === approversJoined) return;
    apply((t) => updateConfig(t, nodeId, { approverRoles: roles }));
  }

  function commitModel() {
    if (readOnly || modelDraft === modelValue) return;
    apply((t) => updateConfig(t, nodeId, { model: modelDraft.trim() || undefined }));
  }

  function commitTask() {
    if (readOnly || taskDraft === taskValue) return;
    const nextMessages =
      taskIdx < 0
        ? [{ role: "system", content: taskDraft }]
        : messages.map((message, i) =>
            i === taskIdx ? { ...message, content: taskDraft } : message,
          );
    apply((t) => updateConfig(t, nodeId, { messages: nextMessages }));
  }

  return (
    <BesideCard
      title={TITLE[kind]}
      onClose={onClose}
      side={side}
      caret={caret}
      sheet={sheet}
      testid="step-beside-card"
      closeTestid="step-card-close"
    >
      <div className="flex flex-col gap-[4px]">
        <label htmlFor="step-card-name" className={LABEL_CLASS}>
          Step name
        </label>
        <input
          id="step-card-name"
          type="text"
          disabled={readOnly}
          value={nameDraft}
          data-testid="step-card-name"
          onChange={(e) => setNameDraft(e.target.value)}
          onBlur={commitName}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commitName();
            }
          }}
          className={MONO_INPUT_CLASS}
        />
        {renameError ? (
          <p
            className="font-mono text-[11px] text-st-failed-tag-fg"
            data-testid="step-card-rename-error"
          >
            {renameError}
          </p>
        ) : null}
      </div>

      {kind === "process.exec" ? (
        <div className="flex flex-col gap-[4px]">
          <label htmlFor="step-card-command" className={LABEL_CLASS}>
            Command
          </label>
          <input
            id="step-card-command"
            type="text"
            disabled={readOnly}
            value={commandDraft}
            placeholder="executable [args…]"
            data-testid="step-card-command"
            onChange={(e) => setCommandDraft(e.target.value)}
            onBlur={commitCommand}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commitCommand();
              }
            }}
            className={MONO_INPUT_CLASS}
          />
        </div>
      ) : null}

      {kind === "human.approval" ? (
        <>
          <div className="flex flex-col gap-[4px]">
            <label htmlFor="step-card-summary" className={LABEL_CLASS}>
              What to approve
            </label>
            <textarea
              id="step-card-summary"
              rows={4}
              disabled={readOnly}
              value={summaryDraft}
              placeholder="What is the approver being asked to accept?"
              data-testid="step-card-summary"
              onChange={(e) => setSummaryDraft(e.target.value)}
              onBlur={commitSummary}
              className={`${TEXTAREA_CLASS} font-ui`}
            />
          </div>
          <div className="flex flex-col gap-[4px]">
            <label htmlFor="step-card-approvers" className={LABEL_CLASS}>
              Who can approve
            </label>
            <input
              id="step-card-approvers"
              type="text"
              disabled={readOnly}
              value={approversDraft}
              placeholder="lead, oncall"
              data-testid="step-card-approvers"
              onChange={(e) => setApproversDraft(e.target.value)}
              onBlur={commitApprovers}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  commitApprovers();
                }
              }}
              className={INPUT_CLASS}
            />
          </div>
        </>
      ) : null}

      {kind === "model.chat" ? (
        <>
          <div className="flex flex-col gap-[4px]">
            <label htmlFor="step-card-model" className={LABEL_CLASS}>
              Model
            </label>
            <input
              id="step-card-model"
              type="text"
              disabled={readOnly}
              value={modelDraft}
              placeholder="model id"
              data-testid="step-card-model"
              onChange={(e) => setModelDraft(e.target.value)}
              onBlur={commitModel}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  commitModel();
                }
              }}
              className={INPUT_CLASS}
            />
          </div>
          <div className="flex flex-col gap-[4px]">
            <label htmlFor="step-card-task" className={LABEL_CLASS}>
              What should it decide?
            </label>
            <textarea
              id="step-card-task"
              rows={4}
              disabled={readOnly}
              value={taskDraft}
              placeholder="The question this step answers"
              data-testid="step-card-task"
              onChange={(e) => setTaskDraft(e.target.value)}
              onBlur={commitTask}
              className={`${TEXTAREA_CLASS} font-ui`}
            />
          </div>
        </>
      ) : null}

      <div className="flex items-center gap-3 pt-[2px]">
        <button
          type="button"
          data-testid="step-card-more"
          onClick={onMoreSettings}
          className="text-[13px] font-semibold text-accent-text hover:underline focus-visible:outline-2 focus-visible:outline-accent"
        >
          More settings
        </button>
        {onWrap ? (
          <button
            type="button"
            data-testid="step-card-wrap"
            onClick={onWrap}
            className="text-[13px] font-semibold text-accent-text hover:underline focus-visible:outline-2 focus-visible:outline-accent"
          >
            Wrap in…
          </button>
        ) : null}
        <span className="ml-auto font-mono text-[10.5px] text-faint">autosaved</span>
      </div>
    </BesideCard>
  );
}
