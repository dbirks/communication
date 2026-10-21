import type { AssistantQuestionPayload } from "./types";

/**
 * Follow-up question the model wrote (2a "IT ASKS A FOLLOW-UP", 3d §3,
 * 2c "AWAITING YOUR ANSWER"; ADR-0050 Decision 3).
 *
 * The model offers 2–4 answer buttons it wrote. Whatever the user taps —
 * an option, the free-text affordance, the composer input or the mic — is
 * sent back to the model as plain text: `onAnswer` is called with the
 * option's LABEL verbatim (the `value` never travels; ADR-0050: "the
 * client posts the label verbatim … replies are always plain text").
 */
export interface QuestionCardProps {
  question: AssistantQuestionPayload;
  /** Called with the option's label text, verbatim. */
  onAnswer: (label: string) => void;
  /**
   * "Or say it your way…" — the parent typically focuses the composer so
   * the user can type or dictate. Optional; the affordance is rendered
   * only when the question allows free text (it always does in this
   * version) or when the callback is given.
   */
  onFreeText?: () => void;
}

export function QuestionCard({ question, onAnswer, onFreeText }: QuestionCardProps) {
  const answered = question.answered_by != null;

  return (
    <div data-testid="assistant-question" className="px-[10px] py-[8px]">
      <p className="whitespace-pre-wrap text-[13px] leading-[1.45] text-ink">{question.prompt}</p>
      {answered ? (
        <p
          data-testid="assistant-question-answered"
          className="mt-[6px] font-mono text-[10.5px] text-st-done-pale-fg"
        >
          ✓ answered
        </p>
      ) : (
        <div
          role="radiogroup"
          aria-label={question.prompt}
          className="mt-[8px] flex flex-col gap-[6px]"
        >
          {question.options.slice(0, 4).map((option) => (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={false}
              data-testid="assistant-question-option"
              onClick={() => onAnswer(option.label)}
              className="ds-btn ds-btn--secondary"
              style={{
                height: 32,
                padding: "0 10px",
                textAlign: "left",
                justifyContent: "flex-start",
                whiteSpace: "normal",
                overflowWrap: "anywhere",
                fontSize: 12.5,
              }}
            >
              {option.label}
            </button>
          ))}
          {question.allow_free_text !== false && onFreeText ? (
            <button
              type="button"
              data-testid="assistant-question-freetext"
              onClick={onFreeText}
              className="mt-[2px] cursor-pointer border-none bg-transparent p-0 text-left font-mono text-[11px] text-faint"
            >
              “Or say it your way…”
            </button>
          ) : null}
        </div>
      )}
    </div>
  );
}

export default QuestionCard;
