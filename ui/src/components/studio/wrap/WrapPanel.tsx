/**
 * WrapPanel — popover card (or phone bottom sheet) that turns a box selection
 * into either a `Repeat until` loop (judge / command / contains) or a
 * `Side by side` parallel scope.
 */
import { useId, useRef, useState, type KeyboardEvent } from "react";
import {
  IconColumns,
  IconGavel,
  IconMinus,
  IconPlus,
  IconRepeat,
  IconTerminal2,
  IconTextScan2,
  IconX,
  type TablerIcon,
} from "@tabler/icons-react";
import type { GoalKind, GoalSpec } from "./wrapModel";

export type WrapTab = "repeat" | "side";

export interface WrapPanelProps {
  count: number;
  /** When non-null (`canWrap` is false), the panel renders only this reason sentence. */
  reason?: string | null;
  /** `"wrap"` (default) creates a scope; `"edit"` updates an existing Repeat-until GoalFrame. */
  mode?: "wrap" | "edit";
  initialGoal?: GoalSpec;
  onUnwrap?: () => void;
  onMoreSettings?: () => void;
  unsupported?: Partial<Record<GoalKind, string>>;
  onWrapRepeat: (goal: GoalSpec) => void;
  onWrapSideBySide: () => void;
  onClose: () => void;
  sheet?: boolean;
  className?: string;
}

const MIN_ROUNDS = 1;
const MAX_ROUNDS = 20;
const DEFAULT_ROUNDS = 3;

interface GoalChoice {
  kind: GoalKind;
  label: string;
  Icon: TablerIcon;
  fieldLabel: string;
  placeholder: string;
  mono: boolean;
}

const GOAL_CHOICES: readonly GoalChoice[] = [
  {
    kind: "judge",
    label: "A judge says the goal is met",
    Icon: IconGavel,
    fieldLabel: "The goal",
    placeholder: "Tests pass and the reviewer has no open comments",
    mono: false,
  },
  {
    kind: "command",
    label: "A command passes",
    Icon: IconTerminal2,
    fieldLabel: "Command",
    placeholder: "pnpm test",
    mono: true,
  },
  {
    kind: "contains",
    label: "The output contains…",
    Icon: IconTextScan2,
    fieldLabel: "Look for",
    placeholder: "LGTM",
    mono: true,
  },
];

export function WrapPanel({
  count,
  reason = null,
  mode = "wrap",
  initialGoal,
  onUnwrap,
  onMoreSettings,
  unsupported,
  onWrapRepeat,
  onWrapSideBySide,
  onClose,
  sheet = false,
  className = "",
}: WrapPanelProps) {
  const baseId = useId();
  const isEdit = mode === "edit";
  const [tab, setTab] = useState<WrapTab>("repeat");
  const initialKind =
    initialGoal?.kind ??
    GOAL_CHOICES.find((choice) => !unsupported?.[choice.kind])?.kind ??
    "judge";
  const [goalKind, setGoalKind] = useState<GoalKind>(initialKind);
  const [drafts, setDrafts] = useState<Record<GoalKind, string>>({
    judge: initialGoal?.kind === "judge" ? initialGoal.text : "",
    command: initialGoal?.kind === "command" ? initialGoal.text : "",
    contains: initialGoal?.kind === "contains" ? initialGoal.text : "",
  });
  const [rounds, setRounds] = useState<number>(initialGoal?.maxRounds ?? DEFAULT_ROUNDS);

  const repeatTabRef = useRef<HTMLButtonElement | null>(null);
  const sideTabRef = useRef<HTMLButtonElement | null>(null);
  const radioRefs = useRef<Record<GoalKind, HTMLButtonElement | null>>({
    judge: null,
    command: null,
    contains: null,
  });

  const activeChoice = GOAL_CHOICES.find((c) => c.kind === goalKind) ?? GOAL_CHOICES[0];
  const currentDraft = drafts[goalKind] ?? "";
  const activeUnsupported = unsupported?.[goalKind];
  const canSubmitRepeat = currentDraft.trim().length > 0 && !activeUnsupported;

  function switchTab(next: WrapTab, focusTarget = false) {
    setTab(next);
    if (focusTarget) {
      const target = next === "repeat" ? repeatTabRef.current : sideTabRef.current;
      target?.focus();
    }
  }

  function handleTabKeyDown(e: KeyboardEvent<HTMLButtonElement>) {
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      switchTab(tab === "repeat" ? "side" : "repeat", true);
    } else if (e.key === "Home") {
      e.preventDefault();
      switchTab("repeat", true);
    } else if (e.key === "End") {
      e.preventDefault();
      switchTab("side", true);
    }
  }

  function handleRadioKeyDown(e: KeyboardEvent<HTMLButtonElement>, currentIndex: number) {
    const enabledChoices = GOAL_CHOICES.filter((c) => !unsupported?.[c.kind]);
    if (enabledChoices.length === 0) return;
    let delta = 0;
    if (e.key === "ArrowDown" || e.key === "ArrowRight") delta = 1;
    else if (e.key === "ArrowUp" || e.key === "ArrowLeft") delta = -1;
    if (delta === 0) return;
    e.preventDefault();
    const curKind = GOAL_CHOICES[currentIndex].kind;
    const pos = enabledChoices.findIndex((c) => c.kind === curKind);
    const nextIdx = pos < 0 ? 0 : (pos + delta + enabledChoices.length) % enabledChoices.length;
    const nextKind = enabledChoices[nextIdx].kind;
    setGoalKind(nextKind);
    radioRefs.current[nextKind]?.focus();
  }

  function handleRepeatSubmit() {
    if (!canSubmitRepeat) return;
    onWrapRepeat({
      kind: goalKind,
      text: currentDraft.trim(),
      maxRounds: rounds,
    });
  }

  const containerLayout = sheet
    ? "w-full rounded-t-[14px] rounded-b-none"
    : "w-[340px] rounded-[14px]";

  const repeatTabId = `${baseId}-tab-repeat`;
  const sideTabId = `${baseId}-tab-side`;
  const panelId = `${baseId}-tabpanel`;
  const groupLabelId = `${baseId}-done-label`;
  const fieldId = `${baseId}-field-${goalKind}`;

  return (
    <div
      role={sheet ? "dialog" : undefined}
      aria-modal={sheet ? true : undefined}
      aria-label={sheet ? "Wrap selected steps" : undefined}
      data-testid="wrap-panel"
      className={`flex flex-col gap-[12px] border border-line bg-surface p-[14px] shadow-[var(--shadow-pop)] ${containerLayout} ${className}`}
    >
      <div className="flex items-center gap-2">
        <span className="font-mono text-[10.5px] font-semibold uppercase tracking-[.06em] text-muted">
          {isEdit ? "REPEAT UNTIL" : `WRAP ${count} ${count === 1 ? "STEP" : "STEPS"} IN`}
        </span>
        <button
          type="button"
          aria-label="Close"
          data-testid="wrap-panel-close"
          onClick={onClose}
          className="icon-hit ml-auto inline-flex h-[24px] w-[24px] items-center justify-center rounded-[6px] text-muted hover:bg-fill hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
        >
          <IconX size={15} stroke={1.5} aria-hidden />
        </button>
      </div>

      {reason ? (
        <p data-testid="wrap-panel-reason" className="text-[13px] leading-[19px] text-ink-2">
          {reason}
        </p>
      ) : (
        <>
          {!isEdit ? (
            <div
              role="tablist"
              aria-label="Wrap mode"
              className="grid grid-cols-2 gap-[2px] rounded-[9px] bg-disabled-bg p-[3px]"
            >
              <button
                ref={repeatTabRef}
                id={repeatTabId}
                type="button"
                role="tab"
                aria-selected={tab === "repeat"}
                aria-controls={panelId}
                tabIndex={tab === "repeat" ? 0 : -1}
                data-testid="wrap-tab-repeat"
                onClick={() => switchTab("repeat")}
                onKeyDown={handleTabKeyDown}
                className={`flex h-[30px] items-center justify-center gap-[6px] whitespace-nowrap rounded-[7px] border text-[13px] font-semibold focus-visible:outline-2 focus-visible:outline-accent ${
                  tab === "repeat"
                    ? "border-fill-edge bg-surface text-ink"
                    : "border-transparent bg-transparent text-muted hover:text-ink"
                }`}
              >
                <IconRepeat size={15} stroke={1.5} aria-hidden />
                Repeat until
              </button>
              <button
                ref={sideTabRef}
                id={sideTabId}
                type="button"
                role="tab"
                aria-selected={tab === "side"}
                aria-controls={panelId}
                tabIndex={tab === "side" ? 0 : -1}
                data-testid="wrap-tab-side"
                onClick={() => switchTab("side")}
                onKeyDown={handleTabKeyDown}
                className={`flex h-[30px] items-center justify-center gap-[6px] whitespace-nowrap rounded-[7px] border text-[13px] font-semibold focus-visible:outline-2 focus-visible:outline-accent ${
                  tab === "side"
                    ? "border-fill-edge bg-surface text-ink"
                    : "border-transparent bg-transparent text-muted hover:text-ink"
                }`}
              >
                <IconColumns size={15} stroke={1.5} aria-hidden />
                Side by side
              </button>
            </div>
          ) : null}

          {isEdit || tab === "repeat" ? (
            <div
              id={panelId}
              role={isEdit ? undefined : "tabpanel"}
              aria-labelledby={isEdit ? undefined : repeatTabId}
              className="flex flex-col gap-[12px]"
            >
              <div className="flex flex-col gap-[6px]">
                <span id={groupLabelId} className="text-[12.5px] font-semibold text-ink-2">
                  How do we know it&apos;s done?
                </span>
                <div
                  role="radiogroup"
                  aria-labelledby={groupLabelId}
                  className="flex flex-col gap-[6px]"
                >
                  {GOAL_CHOICES.map((choice, idx) => {
                    const choiceReason = unsupported?.[choice.kind];
                    const isDisabled = Boolean(choiceReason);
                    const selected = goalKind === choice.kind && !isDisabled;
                    const Icon = choice.Icon;
                    return (
                      <button
                        key={choice.kind}
                        ref={(el) => {
                          radioRefs.current[choice.kind] = el;
                        }}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        aria-disabled={isDisabled || undefined}
                        disabled={isDisabled}
                        data-testid={`wrap-goal-${choice.kind}`}
                        onClick={() => {
                          if (!isDisabled) setGoalKind(choice.kind);
                        }}
                        onKeyDown={(e) => handleRadioKeyDown(e, idx)}
                        className={`flex min-h-[40px] w-full items-center gap-[9px] rounded-[9px] border px-[10px] py-[6px] text-left focus-visible:outline-2 focus-visible:outline-accent ${
                          isDisabled
                            ? "cursor-not-allowed border-line bg-disabled-bg text-muted"
                            : selected
                              ? "border-accent bg-accent-wash font-semibold text-ink"
                              : "border-line bg-surface text-ink hover:bg-paper"
                        }`}
                      >
                        <Icon
                          size={16}
                          stroke={1.5}
                          aria-hidden
                          className={`shrink-0 ${
                            isDisabled ? "text-muted" : selected ? "text-accent-edge" : "text-muted"
                          }`}
                        />
                        <span className="flex min-w-0 flex-1 flex-col">
                          <span className="text-[13.5px] leading-[18px]">{choice.label}</span>
                          {choiceReason ? (
                            <span className="text-[11.5px] font-normal leading-[15px] text-muted">
                              {choiceReason}
                            </span>
                          ) : null}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="flex flex-col gap-[5px]">
                <label htmlFor={fieldId} className="text-[12.5px] font-semibold text-ink-2">
                  {activeChoice.fieldLabel}
                </label>
                {activeChoice.kind === "judge" ? (
                  <textarea
                    id={fieldId}
                    rows={2}
                    value={currentDraft}
                    placeholder={activeChoice.placeholder}
                    data-testid="wrap-goal-input"
                    onChange={(e) => setDrafts((prev) => ({ ...prev, [goalKind]: e.target.value }))}
                    className="w-full resize-none rounded-[8px] border border-line-strong bg-surface px-[10px] py-[8px] font-ui text-[13px] leading-[18px] text-ink placeholder:text-faint focus-visible:border-accent focus-visible:outline-2 focus-visible:outline-accent"
                  />
                ) : (
                  <input
                    id={fieldId}
                    type="text"
                    value={currentDraft}
                    placeholder={activeChoice.placeholder}
                    data-testid="wrap-goal-input"
                    onChange={(e) => setDrafts((prev) => ({ ...prev, [goalKind]: e.target.value }))}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && canSubmitRepeat) {
                        e.preventDefault();
                        handleRepeatSubmit();
                      }
                    }}
                    className="w-full rounded-[8px] border border-line-strong bg-surface px-[10px] py-[8px] font-mono text-[13px] leading-[18px] text-ink placeholder:text-faint focus-visible:border-accent focus-visible:outline-2 focus-visible:outline-accent"
                  />
                )}
              </div>

              <div className="flex items-center gap-[8px] text-[12.5px] text-ink-2">
                <span>Give up after</span>
                <div className="inline-flex items-center gap-[4px] rounded-[8px] border border-line-strong bg-surface p-[2px]">
                  <button
                    type="button"
                    aria-label="Decrease rounds"
                    data-testid="wrap-rounds-dec"
                    disabled={rounds <= MIN_ROUNDS}
                    onClick={() => setRounds((r) => Math.max(MIN_ROUNDS, r - 1))}
                    className="inline-flex h-[28px] w-[28px] items-center justify-center rounded-[6px] text-muted hover:bg-fill hover:text-ink disabled:cursor-not-allowed disabled:text-disabled-fg focus-visible:outline-2 focus-visible:outline-accent"
                  >
                    <IconMinus size={14} stroke={1.5} aria-hidden />
                  </button>
                  <span
                    aria-live="polite"
                    data-testid="wrap-rounds-value"
                    className="min-w-[22px] text-center font-mono text-[13px] tabular-nums text-ink"
                  >
                    {rounds}
                  </span>
                  <button
                    type="button"
                    aria-label="Increase rounds"
                    data-testid="wrap-rounds-inc"
                    disabled={rounds >= MAX_ROUNDS}
                    onClick={() => setRounds((r) => Math.min(MAX_ROUNDS, r + 1))}
                    className="inline-flex h-[28px] w-[28px] items-center justify-center rounded-[6px] text-muted hover:bg-fill hover:text-ink disabled:cursor-not-allowed disabled:text-disabled-fg focus-visible:outline-2 focus-visible:outline-accent"
                  >
                    <IconPlus size={14} stroke={1.5} aria-hidden />
                  </button>
                </div>
                <span>{rounds === 1 ? "round" : "rounds"}</span>
              </div>

              <div className="flex items-center gap-3">
                {isEdit && onUnwrap ? (
                  <button
                    type="button"
                    data-testid="goal-unwrap"
                    onClick={onUnwrap}
                    className="text-[12.5px] font-semibold text-accent-text hover:underline focus-visible:outline-2 focus-visible:outline-accent"
                  >
                    Unwrap
                  </button>
                ) : null}
                {isEdit && onMoreSettings ? (
                  <button
                    type="button"
                    data-testid="goal-card-more-settings"
                    onClick={onMoreSettings}
                    className="text-[12.5px] font-semibold text-accent-text hover:underline focus-visible:outline-2 focus-visible:outline-accent"
                  >
                    More settings
                  </button>
                ) : null}
                <button
                  type="button"
                  disabled={!canSubmitRepeat}
                  data-testid="wrap-submit"
                  onClick={handleRepeatSubmit}
                  className="h-[34px] flex-1 rounded-[8px] bg-accent px-[14px] text-[13px] font-semibold text-white hover:brightness-95 disabled:cursor-not-allowed disabled:bg-disabled-bg disabled:text-disabled-fg focus-visible:outline-2 focus-visible:outline-accent"
                >
                  {isEdit ? "Update" : "Wrap"}
                </button>
              </div>
            </div>
          ) : (
            <div
              id={panelId}
              role="tabpanel"
              aria-labelledby={sideTabId}
              className="flex flex-col gap-[12px]"
            >
              <p className="text-[13px] leading-[19px] text-ink-2">
                These steps run at the same time. The workflow continues when all of them finish.
              </p>
              <button
                type="button"
                data-testid="wrap-submit"
                onClick={onWrapSideBySide}
                className="h-[34px] w-full rounded-[8px] bg-accent px-[14px] text-[13px] font-semibold text-white hover:brightness-95 focus-visible:outline-2 focus-visible:outline-accent"
              >
                Wrap
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
