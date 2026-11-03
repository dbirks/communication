import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import QuestionCard from "./QuestionCard";
import type { AssistantQuestionPayload } from "./types";

afterEach(() => {
  cleanup();
});

const question = (overrides: Partial<AssistantQuestionPayload> = {}): AssistantQuestionPayload => ({
  kind: "question",
  turn_id: "01K1turn",
  prompt: "Stricter how? Pick one, combine them, or say it your way.",
  options: [
    { label: "Fail review on any auth finding", value: "fail_any" },
    { label: "Add an OWASP checklist to its instructions", value: "owasp" },
    { label: "Add a second reviewer on Codex", value: "second" },
  ],
  allow_free_text: true,
  answered_by: null,
  ...overrides,
});

describe("QuestionCard", () => {
  it("renders the prompt and one 32px option button per option (max 4)", () => {
    const { rerender } = render(<QuestionCard question={question()} onAnswer={() => {}} />);
    expect(screen.getByText(/Stricter how\?/)).toBeTruthy();
    const options = screen.getAllByTestId("assistant-question-option");
    expect(options).toHaveLength(3);
    expect(options[0].textContent).toBe("Fail review on any auth finding");

    rerender(
      <QuestionCard
        question={question({
          options: [
            { label: "a", value: "a" },
            { label: "b", value: "b" },
            { label: "c", value: "c" },
            { label: "d", value: "d" },
            { label: "e", value: "e" },
          ],
        })}
        onAnswer={() => {}}
      />,
    );
    expect(screen.getAllByTestId("assistant-question-option")).toHaveLength(4);
  });

  it("sends the option LABEL verbatim as plain text (never the value)", () => {
    const onAnswer = vi.fn();
    render(<QuestionCard question={question()} onAnswer={onAnswer} />);
    const [first, second, third] = screen.getAllByTestId("assistant-question-option");
    fireEvent.click(second);
    expect(onAnswer).toHaveBeenCalledTimes(1);
    expect(onAnswer).toHaveBeenCalledWith("Add an OWASP checklist to its instructions");
    // nothing else travels: the values stay on the server
    expect(onAnswer).not.toHaveBeenCalledWith("owasp");
    fireEvent.click(first);
    fireEvent.click(third);
    expect(onAnswer.mock.calls.length).toBe(3);
    expect(onAnswer.mock.calls[2][0]).toBe("Add a second reviewer on Codex");
  });

  it("offers the free-text path as a plain hint, not a quoted mono string", () => {
    const onFreeText = vi.fn();
    render(<QuestionCard question={question()} onAnswer={() => {}} onFreeText={onFreeText} />);
    // rcn-2f review item 1: the affordance wore `font-mono` and curly quotes,
    // so at 390 a person's own next sentence read like a string the assistant
    // had quoted at them. Same affordance, prose face, no quotes.
    fireEvent.click(screen.getByTestId("assistant-question-freetext"));
    expect(onFreeText).toHaveBeenCalledTimes(1);
    const hint = screen.getByTestId("assistant-question-freetext");
    expect(hint.textContent).toBe("Or say it your way…");
    expect(hint.className).not.toContain("font-mono");
  });

  it("keeps an answered question's options on screen, inert, the chosen one inked (2f)", () => {
    const onAnswer = vi.fn();
    render(
      <QuestionCard
        question={question({ answered_by: "01K1user-msg" })}
        onAnswer={onAnswer}
        answeredLabel="Add an OWASP checklist to its instructions"
      />,
    );
    expect(screen.getByTestId("assistant-question-answered").textContent).toBe("✓ answered");
    // 2f: the selected option keeps its place with an ink border and
    // bold — the history reads as the decision it was. Nothing is
    // clickable any more: the answer already travelled as plain text.
    const options = screen.getAllByTestId("assistant-question-option");
    expect(options).toHaveLength(3);
    const chosen = options[1];
    expect(chosen.getAttribute("data-selected")).toBe("true");
    expect(chosen.hasAttribute("disabled")).toBe(true);
    expect(chosen.style.fontWeight).toBe("600");
    expect(chosen.style.borderColor).toBe("var(--color-ink)");
    fireEvent.click(chosen);
    expect(onAnswer).not.toHaveBeenCalled();
    // an answered card with an unknown reply (typed, not tapped) marks nothing
    // selected but stays inert the same way.
    cleanup();
    render(
      <QuestionCard question={question({ answered_by: "01K1user-msg" })} onAnswer={onAnswer} />,
    );
    expect(
      screen.queryAllByTestId("assistant-question-option")[0]?.getAttribute("data-selected"),
    ).toBeNull();
    expect(
      screen.getAllByTestId("assistant-question-option").every((o) => o.hasAttribute("disabled")),
    ).toBe(true);
  });

  it("carries the 2f card header when the transcript numbers the questions", () => {
    const { rerender } = render(
      <QuestionCard question={question()} onAnswer={() => {}} ordinal={1} total={2} />,
    );
    expect(screen.getByTestId("assistant-question-header").textContent).toBe("Question 1 of 2");
    rerender(<QuestionCard question={question()} onAnswer={() => {}} />);
    expect(screen.queryByTestId("assistant-question-header")).toBeNull();
  });

  /**
   * rcn-2f review item 2: the lab's reply announced TWO things the chat left
   * open and then held ONE question, and the card's own header — `Question 1
   * of 1` — was the last piece of that lie on screen. Design 2f asks ONE
   * question per turn, so a single OPEN question is not the first of a list:
   * it prints no count. Once it is answered the list is closed and the count
   * is a fact, so the card says so.
   */
  it("prints no count on the one question the conversation is asking", () => {
    const { rerender } = render(
      <QuestionCard question={question()} onAnswer={() => {}} ordinal={1} total={1} />,
    );
    expect(screen.queryByTestId("assistant-question-header")).toBeNull();
    // Answered, the same card is honestly the one question it asked.
    rerender(
      <QuestionCard
        question={question({ answered_by: "01K1user-msg" })}
        onAnswer={() => {}}
        ordinal={1}
        total={1}
      />,
    );
    expect(screen.getByTestId("assistant-question-header").textContent).toBe("Question 1 of 1");
  });
});
