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

  it("offers “Or say it your way…” and reports the free-text intent", () => {
    const onFreeText = vi.fn();
    render(<QuestionCard question={question()} onAnswer={() => {}} onFreeText={onFreeText} />);
    fireEvent.click(screen.getByTestId("assistant-question-freetext"));
    expect(onFreeText).toHaveBeenCalledTimes(1);
  });

  it("marks an answered question and no longer offers answers", () => {
    const onAnswer = vi.fn();
    render(
      <QuestionCard question={question({ answered_by: "01K1user-msg" })} onAnswer={onAnswer} />,
    );
    expect(screen.getByTestId("assistant-question-answered").textContent).toBe("✓ answered");
    expect(screen.queryAllByTestId("assistant-question-option")).toEqual([]);
    expect(onAnswer).not.toHaveBeenCalled();
  });
});
