import { Fragment } from "react";
import { Button } from "../ds/Button";
import ApprovalRequestCard from "./ApprovalRequestCard";
import QuestionCard from "./QuestionCard";
import type { AssistantAnswerPayload, AssistantMessage } from "./types";

/**
 * The assistant transcript (2a/2c/3d). Presentational: messages flow in as
 * props; navigation, answering and confirm/dismiss come back through
 * callbacks. `change`-kind rows are NOT rendered here — the 2c decision
 * drops the side column and the change chip owns them (ChangeChip).
 */
export interface MessageListProps {
  messages: AssistantMessage[];
  /** Plain text the user answers a follow-up question with. */
  onAnswerQuestion: (label: string) => void;
  /** Focus the composer for "Or say it your way…" free text. */
  onFreeText?: () => void;
  onConfirmApproval: (messageId: string) => void;
  onDismissApproval: (messageId: string) => void;
  /** Perform the same-origin navigation a `Go ›` row points at. */
  onGo: (route: string) => void;
  /**
   * Issue #63: `Retry` under a failed send's own bubble — re-sends that
   * message's text. Only optimistic local rows can fail, so only they
   * render the line and the button.
   */
  onRetrySend?: (messageId: string) => void;
}

export function MessageList({
  messages,
  onAnswerQuestion,
  onFreeText,
  onConfirmApproval,
  onDismissApproval,
  onGo,
  onRetrySend,
}: MessageListProps) {
  // Design 2f numbers the question cards the transcript really holds:
  // the ordinal is the row's position among the conversation's question
  // rows and the total is how many it has asked so far ("QUESTION 1 OF
  // 2" as honest transcript data, not a model-invented count). An
  // answered card also learns WHICH label the reply quoted, so the
  // chosen option can carry its ink border and bold.
  const questionIds = messages
    .map((message) => (message.payload.kind === "question" ? message.id : null))
    .filter((id): id is string => id !== null);
  const answeredLabelFor = (
    payload: Extract<AssistantMessage["payload"], { kind: "question" }>,
  ) => {
    if (payload.answered_by == null) return null;
    const reply = messages.find((message) => message.id === payload.answered_by);
    if (!reply || reply.payload.kind !== "user") return null;
    const text = reply.payload.text.trim();
    return (
      payload.options.slice(0, 4).find((option) => option.label.trim() === text)?.label ?? null
    );
  };
  return (
    <div data-testid="assistant-messages" className="flex flex-col gap-[8px]">
      {messages.map((message) => {
        switch (message.payload.kind) {
          case "user":
            return (
              <div
                key={message.id}
                data-testid="assistant-msg-user"
                className="px-[10px] py-[8px]"
                style={{ alignSelf: "flex-end", maxWidth: "85%" }}
              >
                <div
                  className="whitespace-pre-wrap rounded-[4px] px-[10px] py-[6px] text-[13px] leading-[1.45] text-ink"
                  style={{ background: "var(--color-accent-tint)" }}
                >
                  {message.payload.text}
                </div>
                {/* Issue #63: a failed send keeps its bubble and answers it
                    in place — the honest line sits under the person's own
                    words, with the Retry that sends them again. */}
                {message.local?.state === "failed" ? (
                  <div className="flex flex-col items-end gap-[6px] pt-[6px]">
                    <p
                      data-testid="assistant-error"
                      className="m-0 max-w-full rounded-[4px] border border-st-failed-pale-edge bg-st-failed-pale-body px-[8px] py-[5px] text-[11.5px] leading-[1.4] text-st-failed-pale-fg"
                    >
                      × {message.local.error ?? "The assistant could not answer."}
                    </p>
                    <Button
                      variant="primary"
                      compact
                      data-testid="assistant-send-retry"
                      onClick={() => onRetrySend?.(message.id)}
                    >
                      Retry
                    </Button>
                  </div>
                ) : null}
              </div>
            );
          case "assistant":
            return (
              <div
                key={message.id}
                data-testid="assistant-msg-assistant"
                className="px-[10px] py-[8px]"
              >
                <AnswerProse text={message.payload.answer_markdown} />
                {message.payload.links.length > 0 ? (
                  <div data-testid="assistant-links" className="flex flex-col gap-[4px] pt-[2px]">
                    {message.payload.links.map((link, index) => (
                      <button
                        key={`${link.route}-${index}`}
                        type="button"
                        data-testid="assistant-link"
                        onClick={() => onGo(link.route)}
                        className="flex cursor-pointer items-center justify-between gap-[8px] border-none bg-transparent p-0 text-left text-[12.5px] text-accent-text"
                      >
                        <span
                          style={{
                            flex: "1 1 auto",
                            minWidth: 0,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          ● {link.label}
                        </span>
                        <span aria-hidden="true" className="flex-shrink-0 font-mono text-[11px]">
                          Go ›
                        </span>
                      </button>
                    ))}
                  </div>
                ) : null}
                <ToolDisclosure calls={message.payload.tool_calls} />
              </div>
            );
          case "question":
            return (
              <QuestionCard
                key={message.id}
                question={message.payload}
                onAnswer={onAnswerQuestion}
                onFreeText={onFreeText}
                ordinal={questionIds.indexOf(message.id) + 1}
                total={questionIds.length}
                answeredLabel={answeredLabelFor(message.payload)}
              />
            );
          case "approval_request":
            return (
              <ApprovalRequestCard
                key={message.id}
                messageId={message.id}
                request={message.payload}
                onConfirm={onConfirmApproval}
                onDismiss={onDismissApproval}
              />
            );
          case "change":
            // The change chip renders these (2c decision); the transcript
            // row exists for the audit trail only.
            return null;
          default:
            return null;
        }
      })}
    </div>
  );
}

/**
 * `answer_markdown` as prose without a markdown dependency: paragraphs
 * split on blank lines, `` `code` `` spans set in mono — the same
 * renderer shape the command palette's answer uses. The text is never
 * turned into HTML, so nothing the model wrote can render as the app's
 * origin (ADR-0020).
 */
function CodeSpans({ text }: { text: string }) {
  return (
    <>
      {text.split(/`([^`]+)`/g).map((part, index) =>
        index % 2 === 1 ? (
          <code
            key={index}
            className="rounded-[3px] bg-fill px-[3px] py-[1px] font-mono text-[11.5px] text-ink"
          >
            {part}
          </code>
        ) : (
          <Fragment key={index}>{part}</Fragment>
        ),
      )}
    </>
  );
}

/**
 * step glyphs the assistant's draft step list is built from (design 2f:
 * ✓ done in the chat, ● the step drafted to run next, · a later step).
 */
const STEP_GLYPHS = ["✓", "●", "·"] as const;

/**
 * One step line: an (optional) markdown list marker and emphasis around the
 * glyph, then the step text. The server's drafting rules ask for
 * `✓ Plan — Claude Code · opus`, but a model that wraps the lines in `- `
 * bullets or bolds the glyph is still posting a step list (2f review: the
 * list must render as it is posted, not fall back to a prose block).
 */
interface StepLine {
  glyph: (typeof STEP_GLYPHS)[number];
  rest: string;
}

function stepLineOf(raw: string): StepLine | null {
  let line = raw.trim();
  const bullet = /^(?:[-*+]|\d+[.)])\s+/.exec(line);
  if (bullet) line = line.slice(bullet[0].length).trimStart();
  // `**✓**` / `*✓*` / `__·__`: the glyph may ride inside markdown emphasis.
  const emphasized = /^([*_]{1,2})([✓●·])\1/.exec(line);
  if (emphasized) line = line.slice(emphasized[0].length).trimStart();
  const glyph = (STEP_GLYPHS as readonly string[]).includes(line.charAt(0))
    ? (line.charAt(0) as (typeof STEP_GLYPHS)[number])
    : null;
  if (glyph === null) return null;
  return { glyph, rest: line.slice(1).trim() };
}

/**
 * Split one answer paragraph into prose runs and step-list runs: a run of
 * two or more consecutive step lines is the draft step list (a stray ✓ line
 * stays prose, as before); everything else renders as the prose it is.
 */
type AnswerChunk = { type: "prose"; text: string } | { type: "steps"; lines: StepLine[] };

function chunkParagraph(paragraph: string): AnswerChunk[] {
  const chunks: AnswerChunk[] = [];
  let prose: string[] = [];
  let steps: StepLine[] = [];
  const flushProse = () => {
    if (prose.length === 0) return;
    chunks.push({ type: "prose", text: prose.join("\n") });
    prose = [];
  };
  const flushSteps = () => {
    if (steps.length === 0) return;
    if (steps.length < 2) prose.push(...steps.map((line) => `${line.glyph} ${line.rest}`));
    else chunks.push({ type: "steps", lines: steps });
    steps = [];
  };
  for (const raw of paragraph.split("\n")) {
    const step = stepLineOf(raw);
    if (step) {
      flushProse();
      steps.push(step);
    } else {
      flushSteps();
      if (raw.trim().length > 0 || prose.length > 0 || steps.length > 0) prose.push(raw);
    }
  }
  flushSteps();
  flushProse();
  return chunks;
}

/**
 * The draft step list (design 2f "posts a DRAFT STEP LIST … marked with
 * progress ✓ / ● / ·"): one line per step, the glyph paired with its
 * word (never colour alone, per states.ts) — done, next, later.
 */
function StepList({ lines }: { lines: StepLine[] }) {
  return (
    <div data-testid="assistant-step-list" className="flex flex-col gap-[2px] py-[2px]">
      {lines.map((line, index) => (
        <p
          key={index}
          data-testid="assistant-step-row"
          data-state={line.glyph === "✓" ? "done" : line.glyph === "●" ? "current" : "later"}
          className="m-0 flex items-baseline gap-[6px] text-[12.5px] leading-[1.5] text-ink"
        >
          <span
            aria-hidden="true"
            className={`w-[12px] flex-shrink-0 text-center ${
              line.glyph === "✓"
                ? "text-st-done-pale-fg"
                : line.glyph === "●"
                  ? "text-accent"
                  : "text-faint"
            }`}
          >
            {line.glyph}
          </span>
          <span className="min-w-0">{line.rest}</span>
          <span className="sr-only">
            {line.glyph === "✓" ? " (done)" : line.glyph === "●" ? " (next)" : " (later)"}
          </span>
        </p>
      ))}
    </div>
  );
}

function AnswerProse({ text }: { text: string }) {
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0);
  return (
    <div data-testid="assistant-answer" className="space-y-[6px]">
      {paragraphs.flatMap((paragraph, index) =>
        chunkParagraph(paragraph).map((chunk, chunkIndex) =>
          chunk.type === "steps" ? (
            <StepList key={`${index}:${chunkIndex}`} lines={chunk.lines} />
          ) : (
            <p
              key={`${index}:${chunkIndex}`}
              className="m-0 whitespace-pre-wrap text-[13px] leading-[1.45] text-ink"
            >
              <CodeSpans text={chunk.text} />
            </p>
          ),
        ),
      )}
    </div>
  );
}

/**
 * Transparency, not a replay log: what the turn looked at, collapsed by
 * default (2a "used 2 tools ▸"). Glyphs: ✓ ok / × failed, with the
 * server-supplied summary sentence.
 */
function ToolDisclosure({ calls }: { calls: AssistantAnswerPayload["tool_calls"] }) {
  if (calls.length === 0) return null;
  return (
    <details
      data-testid="assistant-tools"
      style={{ borderTop: "1px solid var(--color-line)", marginTop: 6 }}
    >
      <summary className="cursor-pointer font-mono text-[10.5px] text-faint">
        {`used ${calls.length} tool${calls.length === 1 ? "" : "s"} ▸`}
      </summary>
      <ul className="m-0 mt-[4px] list-none space-y-[2px] p-0">
        {calls.map((call, index) => (
          <li
            key={`${call.name}-${index}`}
            className="flex items-baseline gap-[6px] font-mono text-[10.5px] text-muted"
          >
            <span aria-hidden="true">{call.ok ? "✓" : "×"}</span>
            <span className="flex-shrink-0 truncate">{call.name}</span>
            <span style={{ flex: "1 1 auto", minWidth: 0 }}>{call.summary}</span>
            {!call.ok && call.reason ? (
              <span className="flex-shrink-0 text-st-failed-tag-fg">{call.reason}</span>
            ) : null}
          </li>
        ))}
      </ul>
    </details>
  );
}

export default MessageList;
