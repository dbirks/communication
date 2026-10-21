import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import ApprovalRequestCard from "./ApprovalRequestCard";
import type { AssistantApprovalRequestPayload } from "./types";

afterEach(() => {
  cleanup();
});

const request = (
  overrides: Partial<AssistantApprovalRequestPayload> = {},
): AssistantApprovalRequestPayload => ({
  kind: "approval_request",
  turn_id: "01K1turn",
  action: "run.retry",
  summary: "Retry node `test` on run 9c1e (attempt 2)",
  risk: "Re-runs the failed node with its recorded retry context.",
  state: "pending",
  ...overrides,
});

describe("ApprovalRequestCard", () => {
  it("shows the amber header, the sentence and Retry / Not now while pending", () => {
    render(
      <ApprovalRequestCard
        messageId="msg-7"
        request={request()}
        onConfirm={() => {}}
        onDismiss={() => {}}
      />,
    );
    expect(screen.getByTestId("assistant-approval")).toBeTruthy();
    expect(screen.getByTestId("assistant-approval-header").textContent).toBe("! NEEDS APPROVAL");
    expect(screen.getByText("Retry node `test` on run 9c1e (attempt 2)")).toBeTruthy();
    expect(
      screen.getByText("Re-runs the failed node with its recorded retry context."),
    ).toBeTruthy();
    expect(screen.getByTestId("assistant-approval-confirm").textContent).toBe("Retry");
    expect(screen.getByTestId("assistant-approval-dismiss").textContent).toBe("Not now");
  });

  it("Retry posts confirm with the message id; Not now posts dismiss", () => {
    const onConfirm = vi.fn();
    const onDismiss = vi.fn();
    render(
      <ApprovalRequestCard
        messageId="msg-7"
        request={request()}
        onConfirm={onConfirm}
        onDismiss={onDismiss}
      />,
    );
    fireEvent.click(screen.getByTestId("assistant-approval-confirm"));
    expect(onConfirm).toHaveBeenCalledWith("msg-7");
    expect(onDismiss).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("assistant-approval-dismiss"));
    expect(onDismiss).toHaveBeenCalledWith("msg-7");
  });

  it("a confirmed request keeps its place with the outcome, no buttons", () => {
    render(
      <ApprovalRequestCard
        messageId="msg-7"
        request={request({ state: "confirmed" })}
        onConfirm={() => {}}
        onDismiss={() => {}}
      />,
    );
    expect(screen.getByTestId("assistant-approval-header").textContent).toBe("✓ APPROVED");
    expect(screen.queryByTestId("assistant-approval-confirm")).toBeNull();
    expect(screen.queryByTestId("assistant-approval-dismiss")).toBeNull();
  });

  it("a dismissed request says it did nothing", () => {
    render(
      <ApprovalRequestCard
        messageId="msg-7"
        request={request({ state: "dismissed" })}
        onConfirm={() => {}}
        onDismiss={() => {}}
      />,
    );
    expect(screen.getByTestId("assistant-approval-header").textContent).toContain("DISMISSED");
    expect(screen.getByText(/dismissed · nothing ran/)).toBeTruthy();
  });
});
