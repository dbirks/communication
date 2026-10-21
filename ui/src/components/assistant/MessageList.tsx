import { Fragment } from "react";
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
}

export function MessageList({
  messages,
  onAnswerQuestion,
  onFreeText,
  onConfirmApproval,
  onDismissApproval,
  onGo,
}: MessageListProps) {
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

function AnswerProse({ text }: { text: string }) {
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0);
  return (
    <div data-testid="assistant-answer" className="space-y-[6px]">
      {paragraphs.map((paragraph, index) => (
        <p key={index} className="m-0 whitespace-pre-wrap text-[13px] leading-[1.45] text-ink">
          <CodeSpans text={paragraph} />
        </p>
      ))}
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
