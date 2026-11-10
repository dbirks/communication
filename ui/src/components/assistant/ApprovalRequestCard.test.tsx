import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import ApprovalRequestCard from "./ApprovalRequestCard";
import { mapAssistantMessage } from "../../api/assistant";
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
  it("shows the amber header, the sentence and the named action / Not now while pending", () => {
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
    // Finding 5: the primary button NAMES the action — a run.retry is
    // "Retry step", never a bare "Retry" that could be anything.
    expect(screen.getByTestId("assistant-approval-confirm").textContent).toBe("Retry step");
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
    const header = screen.getByTestId("assistant-approval-header");
    // Finding 4: the decided card reads its OWN state — the banner says
    // CONFIRMED and the state line says confirmed, in words.
    expect(header.textContent).toBe("· CONFIRMED");
    expect(header.querySelector("svg")?.getAttribute("class")).toContain("tabler-icon-check");
    expect(screen.getByText(/^confirmed · the action ran once as you$/)).toBeTruthy();
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
    expect(screen.getByTestId("assistant-approval-header").textContent).toBe("· DISMISSED");
    expect(screen.getByText(/dismissed · nothing ran/)).toBeTruthy();
  });

  /**
   * Finding 5: the primary button names the action it runs, for every gated
   * tool — the generic "Confirm" only when the design has no words for it.
   */
  it("names the action in the primary button, per tool", () => {
    const labels: Record<string, string> = {
      "run.start": "Start run",
      "run.retry": "Retry step",
      "run.cancel": "Cancel run",
      "pipeline.publish": "Publish",
      "assignment.set": "Assign",
      "schedule.create": "Create schedule",
      "repo.add": "Connect repository",
      "project.create": "Create project",
      "draft.apply": "Confirm",
    };
    for (const [action, label] of Object.entries(labels)) {
      cleanup();
      render(
        <ApprovalRequestCard
          messageId="msg-7"
          request={request({ action, summary: `Do ${action}` })}
          onConfirm={() => {}}
          onDismiss={() => {}}
        />,
      );
      expect(screen.getByTestId("assistant-approval-confirm").textContent, action).toBe(label);
    }
  });
});

/**
 * Handoff A5 + A7: the same card is the PROPOSAL card for the two creating
 * tools, and every card now answers "why it asks" (CONTRACT §3's reason, or
 * the fixed table's line when the row carries none). The rows below are built
 * through the real mapper, because `reason` and `args` ride the wire payload —
 * a hand-built object would test a shape the server never sends.
 */
const wireApproval = (payload: Record<string, unknown>): AssistantApprovalRequestPayload => {
  const row = mapAssistantMessage({
    id: "msg-7",
    kind: "approval_request",
    payload,
    created_at: "2026-10-20T10:00:00Z",
  });
  if (row === null || row.payload.kind !== "approval_request") {
    throw new Error("the mapper dropped the approval row under test");
  }
  return row.payload;
};

const proposal = (overrides: Record<string, unknown> = {}): AssistantApprovalRequestPayload =>
  wireApproval({
    kind: "approval_request",
    action: "project.create",
    summary: "Create project home-lab with the repo dbirks/home-lab",
    state: "pending",
    reason: "Creates real state.",
    args: {
      name: "home-lab",
      repo_url: "https://github.com/dbirks/home-lab.git",
      credential: "GITHUB_TOKEN",
      default_branch: "main",
    },
    ...overrides,
  });

const renderCard = (
  request: AssistantApprovalRequestPayload,
  onConfirm = () => {},
  onDismiss = () => {},
) =>
  render(
    <ApprovalRequestCard
      messageId="msg-7"
      request={request}
      onConfirm={onConfirm}
      onDismiss={onDismiss}
    />,
  );

describe("ApprovalRequestCard proposal (A7 §6)", () => {
  it("renders project.create as the proposal: the banner, the five rows, Create project / Not now", () => {
    const onConfirm = vi.fn();
    const onDismiss = vi.fn();
    renderCard(proposal(), onConfirm, onDismiss);
    expect(screen.getByTestId("assistant-approval-header").textContent).toBe(
      "NEEDS YOUR OK · CREATES REAL STATE",
    );
    expect(screen.getByTestId("assistant-proposal-project").textContent).toBe("home-lab (new)");
    expect(screen.getByTestId("assistant-proposal-repository").textContent).toBe(
      "dbirks/home-lab @ main",
    );
    expect(screen.getByTestId("assistant-proposal-credential").textContent).toBe("GITHUB_TOKEN");
    expect(screen.getByTestId("assistant-proposal-workflow").textContent).toBe("none yet");
    expect(screen.getByTestId("assistant-approval-reason").textContent).toBe("Creates real state.");
    expect(screen.getByTestId("assistant-approval-confirm").textContent).toBe("Create project");
    expect(screen.getByTestId("assistant-approval-dismiss").textContent).toBe("Not now");
    fireEvent.click(screen.getByTestId("assistant-approval-confirm"));
    expect(onConfirm).toHaveBeenCalledWith("msg-7");
    fireEvent.click(screen.getByTestId("assistant-approval-dismiss"));
    expect(onDismiss).toHaveBeenCalledWith("msg-7");
  });

  it("repo.add rides the same layout, and a bare repo url reads owner/repo", () => {
    renderCard(
      proposal({
        action: "repo.add",
        args: { project_id: "proj-1", repo_url: "github.com/dbirks/home-lab", credential: "GH" },
      }),
    );
    expect(screen.getByTestId("assistant-proposal-project").textContent).toBe("proj-1 (new)");
    expect(screen.getByTestId("assistant-proposal-repository").textContent).toBe("dbirks/home-lab");
    expect(screen.getByTestId("assistant-proposal-credential").textContent).toBe("GH");
    // Finding 5: a repo.add proposal is confirmed with its OWN verb.
    expect(screen.getByTestId("assistant-approval-confirm").textContent).toBe("Connect repository");
  });

  it("a confirmed proposal says what it did and offers nothing else", () => {
    renderCard(proposal({ state: "confirmed" }));
    expect(screen.getByTestId("assistant-approval-header").textContent).toBe("CONFIRMED");
    expect(screen.getByTestId("assistant-approval").textContent).toContain(
      "created · can't be undone from here",
    );
    expect(screen.queryByTestId("assistant-approval-confirm")).toBeNull();
    expect(screen.queryByTestId("assistant-approval-dismiss")).toBeNull();
  });

  it("a dismissed proposal says it created nothing", () => {
    renderCard(proposal({ state: "dismissed" }));
    expect(screen.getByTestId("assistant-approval-header").textContent).toBe("DISMISSED");
    expect(screen.getByTestId("assistant-approval").textContent).toContain("not created");
    expect(screen.queryByTestId("assistant-approval-confirm")).toBeNull();
  });

  it("falls back to the fixed table's reason when the row carries none", () => {
    renderCard(proposal({ reason: undefined, args: undefined }));
    // In the proposal grid the label is the row's own cell.
    expect(screen.getByTestId("assistant-approval-reason").textContent).toBe("Creates real state.");
    expect(screen.getByTestId("assistant-approval").textContent).toContain("Why it asks");
    // no args, no invented rows: the summary the server wrote stays honest
    expect(screen.getByTestId("assistant-proposal-credential").textContent).toBe("none");
  });

  it("prints the judge's own reason when that is what stopped the call", () => {
    renderCard(proposal({ reason: "The decision model flagged a create outside your projects." }));
    expect(screen.getByTestId("assistant-approval-reason").textContent).toBe(
      "The decision model flagged a create outside your projects.",
    );
  });

  it("every other gated tool keeps its own card and gains the Why it asks row", () => {
    renderCard(
      wireApproval({
        kind: "approval_request",
        action: "run.retry",
        summary: "Retry node `test` on run 9c1e (attempt 2)",
        state: "pending",
        reason: "Your level asks before every change.",
      }),
    );
    expect(screen.getByTestId("assistant-approval-header").textContent).toBe("! NEEDS APPROVAL");
    expect(screen.getByTestId("assistant-approval-confirm").textContent).toBe("Retry step");
    expect(screen.queryByTestId("assistant-proposal-project")).toBeNull();
    expect(screen.getByTestId("assistant-approval-reason").textContent).toBe(
      "Why it asks · Your level asks before every change.",
    );
  });
});
