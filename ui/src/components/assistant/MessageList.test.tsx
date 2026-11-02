import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import MessageList from "./MessageList";
import type { AssistantMessage } from "./types";

afterEach(() => {
  cleanup();
});

const userMessage = (text: string): AssistantMessage => ({
  id: "m-user",
  kind: "user",
  payload: { kind: "user", text },
  created_at: "2026-10-20T10:00:00Z",
});

const assistantMessage = (): AssistantMessage => ({
  id: "m-a",
  kind: "assistant",
  payload: {
    kind: "assistant",
    turn_id: "01K1",
    answer_markdown: "Claude Code · work is used by `3` nodes.\n\nTwo are running.",
    links: [
      { label: "Feature Delivery · run 4f2a", route: "/p/01J/runs/4f2a" },
      { label: "Process Ready Issues · idle", route: "/p/01J/runs" },
    ],
    tool_calls: [
      { name: "run.nodes", summary: "listed 4 nodes on run 4f2a", ok: true },
      { name: "palette.search", summary: "matched 2 runs", ok: true },
    ],
  },
  created_at: "2026-10-20T10:00:05Z",
});

const questionMessage = (): AssistantMessage => ({
  id: "m-q",
  kind: "question",
  payload: {
    kind: "question",
    prompt: "Stricter how? Pick one.",
    options: [
      { label: "Fail review on any auth finding", value: "fail_any" },
      { label: "Add an OWASP checklist", value: "owasp" },
    ],
    allow_free_text: true,
    answered_by: null,
  },
  created_at: "2026-10-20T10:00:10Z",
});

const changeMessage = (): AssistantMessage => ({
  id: "m-c",
  kind: "change",
  payload: {
    kind: "change",
    change_id: "chg-1",
    change_kind: "draft_edit",
    target_ref: "draft:01K1",
    summary: "Inserted node `review` after `tests`",
    undoable: true,
  },
  created_at: "2026-10-20T10:00:12Z",
});

const approvalMessage = (): AssistantMessage => ({
  id: "m-ap",
  kind: "approval_request",
  payload: {
    kind: "approval_request",
    action: "run.retry",
    summary: "Retry node `test` on run 9c1e (attempt 2)",
    state: "pending",
  },
  created_at: "2026-10-20T10:00:15Z",
});

describe("MessageList", () => {
  it("renders the user bubble with its text and the assistant prose with code spans", () => {
    render(
      <MessageList
        messages={[userMessage("hi"), assistantMessage()]}
        onAnswerQuestion={() => {}}
        onConfirmApproval={() => {}}
        onDismissApproval={() => {}}
        onGo={() => {}}
      />,
    );
    const bubble = screen.getByTestId("assistant-msg-user");
    expect(bubble.textContent).toBe("hi");
    const answer = screen.getByTestId("assistant-answer");
    expect(answer.textContent).toContain("Claude Code · work is used by 3 nodes.");
    // `3` is rendered as a mono code span, not HTML
    const code = answer.querySelector("code");
    expect(code?.textContent).toBe("3");
  });

  it("renders one `Go ›` row per link and navigates on click", () => {
    const onGo = vi.fn();
    render(
      <MessageList
        messages={[assistantMessage()]}
        onAnswerQuestion={() => {}}
        onConfirmApproval={() => {}}
        onDismissApproval={() => {}}
        onGo={onGo}
      />,
    );
    const links = screen.getAllByTestId("assistant-link");
    expect(links).toHaveLength(2);
    expect(links[0].textContent).toContain("Feature Delivery · run 4f2a");
    expect(links[0].textContent).toContain("Go ›");
    fireEvent.click(links[0]);
    expect(onGo).toHaveBeenCalledWith("/p/01J/runs/4f2a");
    fireEvent.click(links[1]);
    expect(onGo).toHaveBeenCalledWith("/p/01J/runs");
  });

  it("collapses the tool calls behind `used N tools ▸` with the real count", () => {
    render(
      <MessageList
        messages={[assistantMessage()]}
        onAnswerQuestion={() => {}}
        onConfirmApproval={() => {}}
        onDismissApproval={() => {}}
        onGo={() => {}}
      />,
    );
    const details = screen.getByTestId("assistant-tools") as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(details.textContent).toContain("used 2 tools ▸");
    details.open = true;
    expect(details.textContent).toContain("run.nodes");
    expect(details.textContent).toContain("palette.search");
  });

  it("routes question, approval and change rows to their cards / the chip", () => {
    const onAnswerQuestion = vi.fn();
    const onConfirmApproval = vi.fn();
    const onDismissApproval = vi.fn();
    render(
      <MessageList
        messages={[questionMessage(), approvalMessage(), changeMessage()]}
        onAnswerQuestion={onAnswerQuestion}
        onConfirmApproval={onConfirmApproval}
        onDismissApproval={onDismissApproval}
        onGo={() => {}}
      />,
    );
    // question card
    expect(screen.getByTestId("assistant-question")).toBeTruthy();
    fireEvent.click(screen.getAllByTestId("assistant-question-option")[1]);
    expect(onAnswerQuestion).toHaveBeenCalledWith("Add an OWASP checklist");
    // approval card, with the transcript row's id
    fireEvent.click(screen.getByTestId("assistant-approval-confirm"));
    expect(onConfirmApproval).toHaveBeenCalledWith("m-ap");
    fireEvent.click(screen.getByTestId("assistant-approval-dismiss"));
    expect(onDismissApproval).toHaveBeenCalledWith("m-ap");
    // change rows render in the chip, not the transcript
    const list = screen.getByTestId("assistant-messages");
    expect(list.querySelector('[data-testid="assistant-msg-change"]')).toBeNull();
    expect(screen.queryAllByTestId("assistant-question-option").length).toBeGreaterThan(0);
  });

  it("numbers the question cards from the transcript and inks the tapped answer (2f)", () => {
    const second = (): AssistantMessage => ({
      ...questionMessage(),
      id: "m-q2",
      payload: {
        ...questionMessage().payload,
        prompt: "What starts it?",
      } as AssistantMessage["payload"],
    });
    const reply = (): AssistantMessage => ({
      id: "m-reply",
      kind: "user",
      payload: { kind: "user", text: "Add an OWASP checklist" },
      created_at: "2026-10-20T10:01:00Z",
    });
    const answeredFirst = (): AssistantMessage => ({
      ...questionMessage(),
      payload: {
        ...questionMessage().payload,
        answered_by: "m-reply",
      } as AssistantMessage["payload"],
    });
    render(
      <MessageList
        messages={[answeredFirst(), second(), reply()]}
        onAnswerQuestion={() => {}}
        onConfirmApproval={() => {}}
        onDismissApproval={() => {}}
        onGo={() => {}}
      />,
    );
    const headers = screen.getAllByTestId("assistant-question-header");
    expect(headers.map((h) => h.textContent)).toEqual(["Question 1 of 2", "Question 2 of 2"]);
    const options = screen.getAllByTestId("assistant-question-option");
    // first card: the reply quoted its second option verbatim → inked
    const chosen = options.find((o) => o.getAttribute("data-selected") === "true");
    expect(chosen?.textContent).toBe("Add an OWASP checklist");
    // the unanswered card still offers its options
    expect(options.some((o) => !o.hasAttribute("disabled"))).toBe(true);
  });

  it("renders a draft step list with its progress glyphs (2f)", () => {
    const steps = (): AssistantMessage => ({
      id: "m-steps",
      kind: "assistant",
      payload: {
        kind: "assistant",
        answer_markdown:
          "I read the chat. Drafting Adapter swap → PR in the library:\n\n" +
          "✓ Plan — Claude Code · opus\n✓ Approval — maintainer\n● Review — Codex · skill review\n· Open draft PR",
        links: [{ label: "Open draft", route: "/workflows/pl-9" }],
        tool_calls: [],
      },
      created_at: "2026-10-20T10:00:05Z",
    });
    const onGo = vi.fn();
    render(
      <MessageList
        messages={[steps()]}
        onAnswerQuestion={() => {}}
        onConfirmApproval={() => {}}
        onDismissApproval={() => {}}
        onGo={onGo}
      />,
    );
    const rows = screen.getAllByTestId("assistant-step-row");
    expect(rows).toHaveLength(4);
    expect(rows[0].getAttribute("data-state")).toBe("done");
    expect(rows[2].getAttribute("data-state")).toBe("current");
    expect(rows[3].getAttribute("data-state")).toBe("later");
    expect(rows[0].textContent).toContain("Plan — Claude Code · opus");
    // the saved draft's `Open draft` link navigates through the caller
    fireEvent.click(screen.getByTestId("assistant-link"));
    expect(onGo).toHaveBeenCalledWith("/workflows/pl-9");
  });

  it("keeps a step list whole when its intro rides the same paragraph (2f)", () => {
    const answer = (text: string): AssistantMessage => ({
      ...assistantMessage(),
      payload: {
        ...assistantMessage().payload,
        answer_markdown: text,
        links: [],
      } as AssistantMessage["payload"],
    });
    render(
      <MessageList
        messages={[
          answer(
            "I read the chat. Drafting Adapter swap → PR in the library:\n" +
              "- ✓ Plan — Claude Code\n" +
              "- ● Review — Codex · gpt-5\n" +
              "- · Open draft PR",
          ),
        ]}
        onAnswerQuestion={() => {}}
        onConfirmApproval={() => {}}
        onDismissApproval={() => {}}
        onGo={() => {}}
      />,
    );
    // The bullet-marked lines are still the draft step list…
    const rows = screen.getAllByTestId("assistant-step-row");
    expect(rows).toHaveLength(3);
    expect(rows[1].getAttribute("data-state")).toBe("current");
    expect(rows[0].textContent).toContain("Plan — Claude Code");
    // …and the intro line stays its own prose paragraph.
    expect(screen.getByTestId("assistant-answer").textContent).toContain(
      "I read the chat. Drafting Adapter swap",
    );
  });

  it("leaves a stray ✓ line as prose (a step list needs ≥ 2 marked lines)", () => {
    render(
      <MessageList
        messages={[
          {
            ...assistantMessage(),
            payload: {
              ...assistantMessage().payload,
              answer_markdown: "✓ done.\n\nAll clear.",
            } as AssistantMessage["payload"],
          },
        ]}
        onAnswerQuestion={() => {}}
        onConfirmApproval={() => {}}
        onDismissApproval={() => {}}
        onGo={() => {}}
      />,
    );
    expect(screen.queryByTestId("assistant-step-list")).toBeNull();
  });
});

/**
 * Issue #63: the ask lands in the transcript the moment it is sent, as an
 * optimistic local row. While in flight it is a plain user bubble (the
 * caller shows `thinking…`); a failed send KEEPS the bubble and answers it
 * in place — the honest line under the person's own words, with the Retry
 * that re-sends them (named by the row's id).
 */
describe("MessageList optimistic rows (issue #63)", () => {
  const pendingAsk = (): AssistantMessage => ({
    ...userMessage("What needs me right now?"),
    local: { state: "pending" },
  });
  const failedAsk = (): AssistantMessage => ({
    ...userMessage("What needs me right now?"),
    local: {
      state: "failed",
      error: "The assistant could not answer. Your question was not sent — send it again.",
    },
  });

  it("draws an in-flight ask as a plain user bubble — no line, no Retry", () => {
    render(
      <MessageList
        messages={[pendingAsk()]}
        onAnswerQuestion={() => {}}
        onConfirmApproval={() => {}}
        onDismissApproval={() => {}}
        onGo={() => {}}
      />,
    );
    const bubble = screen.getByTestId("assistant-msg-user");
    expect(bubble.textContent).toBe("What needs me right now?");
    expect(screen.queryByTestId("assistant-error")).toBeNull();
    expect(screen.queryByTestId("assistant-send-retry")).toBeNull();
  });

  it("keeps a failed ask's bubble and puts the error line under it with a Retry", () => {
    const onRetrySend = vi.fn();
    render(
      <MessageList
        messages={[failedAsk()]}
        onAnswerQuestion={() => {}}
        onConfirmApproval={() => {}}
        onDismissApproval={() => {}}
        onGo={() => {}}
        onRetrySend={onRetrySend}
      />,
    );
    const bubble = screen.getByTestId("assistant-msg-user");
    // The person's words stay, and the line lives UNDER them — inside the
    // bubble's own row, not floating at the top of the panel.
    expect(bubble.textContent).toContain("What needs me right now?");
    const error = screen.getByTestId("assistant-error");
    expect(bubble.contains(error)).toBe(true);
    expect(bubble.compareDocumentPosition(error) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(error.textContent).toContain("Your question was not sent — send it again.");
    // The bubble's text comes first, the error after it.
    expect(onRetrySend).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("assistant-send-retry"));
    expect(onRetrySend).toHaveBeenCalledWith("m-user");
  });

  it("a server row with no local marker renders exactly as before", () => {
    render(
      <MessageList
        messages={[userMessage("echoed")]}
        onAnswerQuestion={() => {}}
        onConfirmApproval={() => {}}
        onDismissApproval={() => {}}
        onGo={() => {}}
      />,
    );
    expect(screen.getByTestId("assistant-msg-user").textContent).toBe("echoed");
    expect(screen.queryByTestId("assistant-error")).toBeNull();
  });
});
