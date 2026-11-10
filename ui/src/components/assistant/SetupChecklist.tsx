import type { ReactNode } from "react";
import { IconAlertCircle, IconCheck, IconChevronRight, IconCircle } from "@tabler/icons-react";
import { useSystemStatus, type AssistantSystemStatus } from "../../api/assistant";
import { KEEP_COMPOSER_SIZE_PX } from "./ContextButton";

/**
 * The setup checklist (handoff A3 §2 / design FIRST RUN 1f): what this server
 * actually has, read from `GET /api/v1/assistant/status` — the same object the
 * `system.status` tool answers with, so the rows the person reads and the
 * answer the model gives come from one read.
 *
 * It is a LOCAL message: no transcript row carries it, it is synthesized while
 * the thread is empty and disappears when it is not. Every row is a question
 * the person can send — the action links and the three starters post real
 * prompts through `onPrompt`, they navigate nothing.
 *
 * Presentational: the caller owns the read (`useSystemStatus`) and the send.
 */

/** A row's own verdict — the checklist never leaves a state to colour alone
 * (states.ts rule 06): the glyph, the `data-state` and the screen-reader word
 * all carry it. */
export type SetupRowState = "ok" | "warn" | "todo";

export interface SetupAction {
  /** The link's word: "Set up" | "Check" | "Add one" | "Show". */
  label: string;
  /** The exact prompt the link sends when clicked. */
  prompt: string;
}

export interface SetupRow {
  state: SetupRowState;
  label: string;
  meta?: string;
  action?: SetupAction;
}

/** The state word a row's icon speaks aloud. */
const STATE_WORD: Record<SetupRowState, string> = {
  ok: "ok",
  warn: "needs attention",
  todo: "not set up",
};

/** The starter prompts under the rows (handoff A3: three questions, verbatim). */
export const SETUP_STARTERS: readonly string[] = [
  "What workflows do I have?",
  "Any GitHub tokens?",
  "Is anything stuck here?",
];

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? "" : "s"}`;

/**
 * The seven rows of CONTRACT §1, in the order the design draws them. A model
 * that is configured shows its id; one that is not says so in the row's own
 * words and (where the person can act on it) offers the question to ask.
 */
export function setupRowsOf(status: AssistantSystemStatus): SetupRow[] {
  const rows: SetupRow[] = [];

  rows.push(
    status.chat_model.configured
      ? { state: "ok", label: "Chat model", meta: status.chat_model.model }
      : { state: "warn", label: "No chat model" },
  );

  rows.push(
    status.speech_model.configured
      ? { state: "ok", label: "Speech model", meta: status.speech_model.model }
      : {
          state: "todo",
          label: "No speech model",
          action: { label: "Set up", prompt: "how do I set up the speech model?" },
        },
  );

  rows.push(
    status.decision_model.configured
      ? { state: "ok", label: "Decision model", meta: status.decision_model.model }
      : {
          state: "warn",
          label: "No decision model",
          meta: "fixed table decides",
          action: { label: "Set up", prompt: "how do I set up the decision model?" },
        },
  );

  rows.push(
    status.workers.online >= 1
      ? {
          state: "ok",
          label: plural(status.workers.online, "worker") + " online",
          meta: `nono ${status.workers.sandbox_mode}`,
        }
      : { state: "warn", label: "No workers online" },
  );

  for (const credential of status.github_credentials) {
    rows.push({
      state: "ok",
      label: "GitHub credential",
      meta: `${credential.name} · ${credential.used_by === 0 ? "unused" : `${credential.used_by} ${credential.used_by === 1 ? "repo" : "repos"}`}`,
      action: { label: "Check", prompt: "do you have access to any github tokens?" },
    });
  }
  if (status.github_credentials.length === 0) {
    rows.push({
      state: "warn",
      label: "No GitHub credential",
      action: { label: "Set up", prompt: "how do I set up the github credential?" },
    });
  }

  rows.push(
    status.projects.count > 0
      ? { state: "ok", label: plural(status.projects.count, "project") }
      : {
          state: "todo",
          label: "No projects yet",
          action: { label: "Add one", prompt: "help me add my first project" },
        },
  );

  rows.push(
    status.workflows.assigned > 0
      ? {
          state: "ok",
          label: `${plural(status.workflows.count, "workflow")} · ${status.workflows.assigned} assigned`,
        }
      : {
          state: "todo",
          label: `${plural(status.workflows.count, "workflow")}, none assigned`,
          action: { label: "Show", prompt: "what workflows do I have?" },
        },
  );

  return rows;
}

export interface SetupChecklistProps {
  /** The caller's view of this server (`GET /api/v1/assistant/status`). */
  status: AssistantSystemStatus;
  /** Send this prompt as the person's next message. */
  onPrompt: (text: string) => void;
}

/**
 * The checklist as the transcript row it is: the local message A3 §2 puts in
 * an empty thread, holding its own read. It is a separate component so the
 * transcript that shows no checklist makes no status request and needs no
 * query client at all; nothing renders until the read answers, because half a
 * checklist of rows guessed from nothing would be worse than none.
 */
export function SetupMessage({ onPrompt }: { onPrompt: (text: string) => void }) {
  const { data } = useSystemStatus(true);
  if (!data) return null;
  return <SetupChecklist status={data} onPrompt={onPrompt} />;
}

/**
 * The `› used system.status` line (design L209–212 / L241–292): a TOP RULE
 * across the column, then the chevron FIRST and the mono line after it. One
 * component for both places that says what a turn looked at — this checklist and
 * an answer's folded tool disclosure (`MessageList`), so the two never drift
 * apart again.
 */
export function ToolRuleLine({
  as: Tag = "div",
  children,
  className = "",
}: {
  as?: "div" | "summary";
  children: ReactNode;
  className?: string;
}) {
  return (
    <Tag
      className={`flex items-center gap-[4px] border-t border-line pt-[4px] font-mono text-[10.5px] text-faint ${className}`}
    >
      <IconChevronRight size={11} stroke={2} aria-hidden className="shrink-0" />
      <span className="min-w-0 truncate">{children}</span>
    </Tag>
  );
}

export function SetupChecklist({ status, onPrompt }: SetupChecklistProps) {
  const rows = setupRowsOf(status);
  return (
    <div data-testid="assistant-setup" className="flex flex-col gap-[6px] px-[10px] py-[6px]">
      <p className="m-0 text-[13px] leading-[1.5] text-ink">Checked this server.</p>
      <div data-testid="assistant-setup-card" className="rounded-[3px] border border-line p-[4px]">
        {rows.map((row) => (
          <div
            key={`${row.label}-${row.meta ?? ""}`}
            data-testid="assistant-setup-row"
            data-state={row.state}
            // Inside <main> (the full page) at phone width a row's action is a
            // 44px touch target (the APP-SHELL-PHONE floor), so EVERY row takes
            // that height there and the card stays even; the popover and side
            // panel (outside <main>) keep the design's ~28px rows.
            className="flex items-center gap-[8px] rounded-[3px] px-[6px] py-[5px] max-[559px]:[main_&]:min-h-[44px] max-[559px]:[main_&]:py-0"
          >
            {/* Design L176–195: a 16px ROUNDED-SQUARE tile with a tinted
                fill (done / waiting / quiet), never a round circle. */}
            <span
              role="img"
              aria-label={STATE_WORD[row.state]}
              className={`grid h-[16px] w-[16px] shrink-0 place-items-center rounded-[3px] ${
                row.state === "ok"
                  ? "bg-st-done-tag text-st-done-tag-fg"
                  : row.state === "warn"
                    ? "bg-st-waiting-tag text-st-waiting-tag-fg"
                    : "bg-fill text-faint"
              }`}
            >
              {row.state === "ok" ? (
                <IconCheck size={11} stroke={2} aria-hidden className="shrink-0" />
              ) : row.state === "warn" ? (
                <IconAlertCircle size={11} stroke={2} aria-hidden className="shrink-0" />
              ) : (
                <IconCircle size={10} stroke={2} aria-hidden className="shrink-0" />
              )}
            </span>
            {/* The label is WHOLE and stays ONE LINE (§3): it never wraps — a
                two-line row leaves a blank second line and breaks the 28px row
                rhythm — and never pushes the action out of the card. The mono
                meta column (min-w-0 + truncate) is what shrinks; the label only
                gives way when it alone exceeds the row (min-width: auto floors
                it at its longest word). */}
            <span
              data-testid="assistant-setup-label"
              className="text-[13px] leading-[1.4] whitespace-nowrap text-ink"
            >
              {row.label}
            </span>
            {row.meta ? (
              <span
                data-testid="assistant-setup-meta"
                className="min-w-0 flex-1 truncate text-right font-mono text-[11px] text-faint"
              >
                {row.meta}
              </span>
            ) : (
              <span className="min-w-0 flex-1" aria-hidden="true" />
            )}
            {row.action ? (
              <button
                type="button"
                data-testid="assistant-setup-action"
                onClick={() => onPrompt(row.action?.prompt ?? "")}
                className="inline-flex flex-shrink-0 cursor-pointer items-center gap-[2px] border-none bg-transparent p-0 text-[12px] font-semibold whitespace-nowrap text-accent-text hover:underline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
              >
                {row.action.label}
                <IconChevronRight size={11} stroke={2} aria-hidden className="shrink-0" />
              </button>
            ) : null}
          </div>
        ))}
      </div>
      <div className="flex flex-wrap gap-[6px]">
        {SETUP_STARTERS.map((text) => (
          <button
            key={text}
            type="button"
            data-testid="assistant-starter"
            onClick={() => onPrompt(text)}
            className={`cursor-pointer rounded-[4px] border border-line bg-surface px-[9px] py-[5px] text-left text-[12px] text-ink hover:bg-accent-wash focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent ${KEEP_COMPOSER_SIZE_PX}`}
          >
            {text}
          </button>
        ))}
      </div>
      <ToolRuleLine>used system.status</ToolRuleLine>
    </div>
  );
}

export default SetupChecklist;
