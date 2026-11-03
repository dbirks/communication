import type { AssistantQuestionPayload } from "./types";

/**
 * Follow-up question the model wrote (2a "IT ASKS A FOLLOW-UP", 3d §3,
 * 2c "AWAITING YOUR ANSWER"; ADR-0050 Decision 3) — restyled for the
 * thread → workflow card (design 2f "asks structured questions as
 * cards"): an accent-wash body, the accent mono caps
 * `QUESTION {ordinal}` framing (design 2f: "QUESTION 1 OF 2"), the
 * question, then the option buttons. Whatever the user taps — an option, the free-text
 * affordance, the composer input or the mic — is sent back to the model
 * as plain text: `onAnswer` is called with the option's LABEL verbatim
 * (the `value` never travels; ADR-0050: "the client posts the label
 * verbatim … replies are always plain text").
 *
 * Once answered, the options stay on screen and the CHOSEN label is
 * marked the way 2f draws it — an ink border and bold (2f: "the selected
 * one gets an ink border and bold") — so history reads as the decision
 * it was; the buttons are no longer actionable.
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
  /**
   * 1-based position of this question among the conversation's question rows
   * (2f's `QUESTION N` framing). The ordinal is real transcript data — the
   * row's place among the questions the conversation actually asked.
   */
  ordinal?: number;
  /**
   * The total number of questions, ONLY when the wire carries one. The
   * assistant asks one question per turn, so the transcript can never know
   * the total in advance — a made-up `of M` is a promise the flow cannot
   * keep (rcn-2f round 7: show `QUESTION 1` only when the total is unknown,
   * never invent a count).
   */
  total?: number;
  /**
   * The option label the user answered with, when the transcript's reply
   * row names one verbatim (the ink-border-and-bold member).
   */
  answeredLabel?: string | null;
}

export function QuestionCard({
  question,
  onAnswer,
  onFreeText,
  ordinal,
  total,
  answeredLabel,
}: QuestionCardProps) {
  const answered = question.answered_by != null;
  // The framing (design 2f "QUESTION 1 OF 2"): the index the transcript can
  // prove — this card's place among the conversation's questions. The total
  // prints ONLY when the wire supplies a real one; the one-question-per-turn
  // flow never knows how many questions are coming, so "QUESTION 1" is the
  // honest ceiling (rcn-2f round 7).
  const headerShown = ordinal != null;

  return (
    <div
      data-testid="assistant-question"
      className="rounded-[4px] border border-accent-ring bg-accent-wash px-[10px] py-[8px]"
    >
      {headerShown ? (
        <p
          data-testid="assistant-question-header"
          className="m-0 font-mono text-[10px] font-semibold uppercase tracking-[.04em] text-accent-text"
        >
          {total != null ? `Question ${ordinal} of ${total}` : `Question ${ordinal}`}
        </p>
      ) : null}
      <p className="mt-[4px] whitespace-pre-wrap text-[13px] leading-[1.45] text-ink">
        {question.prompt}
      </p>
      <div
        role="radiogroup"
        aria-label={question.prompt}
        className="mt-[8px] flex flex-col gap-[6px]"
      >
        {question.options.slice(0, 4).map((option) => {
          const selected = answered && answeredLabel != null && answeredLabel === option.label;
          // The radio role is what makes `aria-checked` legal on the button —
          // dropped on an answered card, axe reads the implicit button role
          // and fails `aria-allowed-attr` (critical). The answered card keeps
          // the role and marks itself read-only through `disabled`; selection
          // stays announced.
          return (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={answered ? selected : false}
              disabled={answered}
              data-testid="assistant-question-option"
              data-selected={selected ? "true" : undefined}
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
                // 2f: the selected answer carries an ink border and bold.
                ...(selected
                  ? {
                      borderColor: "var(--color-ink)",
                      fontWeight: 600,
                      background: "var(--color-surface)",
                    }
                  : answered
                    ? { opacity: 0.6 }
                    : null),
              }}
            >
              {option.label}
            </button>
          );
        })}
        {answered ? (
          <span
            data-testid="assistant-question-answered"
            className="font-mono text-[10.5px] text-st-done-pale-fg"
          >
            ✓ answered
          </span>
        ) : null}
        {!answered && question.allow_free_text !== false && onFreeText ? (
          // A HINT, not a quotation (rcn-2f review item 1): the mono face and
          // the curly quotes made a person's own next sentence look like a
          // string the assistant had quoted at them — at 390 it read as the
          // only "code" under the options. Same affordance, prose face, no
          // quotes: the button is the thing to press, and the composer is where
          // the words go.
          <button
            type="button"
            data-testid="assistant-question-freetext"
            onClick={onFreeText}
            className="mt-[2px] cursor-pointer border-none bg-transparent p-0 text-left text-[12px] leading-[1.4] text-muted underline decoration-line-strong underline-offset-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
          >
            Or say it your way…
          </button>
        ) : null}
      </div>
    </div>
  );
}

export default QuestionCard;
