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
});
