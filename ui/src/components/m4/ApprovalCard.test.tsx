/**
 * The gate card's three arms (W3): decide, read-but-cannot-decide, and closed.
 * The CAS `version` is the interesting part — a stale decision must come back
 * as a conflict in place, never as a silent overwrite.
 */
import { afterEach } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ApprovalCard } from "./ApprovalCard";
import {
  notApproverView,
  pendingApproval,
  rejectedApproval,
} from "../../test/fixtures/m4/approvals";

// Vitest globals are off, so testing-library cannot register its own cleanup.
afterEach(cleanup);

/** Fixed clock: the countdown is a rendering of `deadline_at - now`, so a test
 * that lets "now" move cannot assert on it. */
const now = () => Date.parse("2026-07-31T14:44:02Z");

describe("a pending gate you can decide", () => {
  it("posts the decision with the row's CAS version and the comments", () => {
    const onDecide = vi.fn();
    render(<ApprovalCard approval={pendingApproval} canDecide onDecide={onDecide} now={now} />);
    fireEvent.change(screen.getByTestId("approval-comment"), { target: { value: "Ship it." } });
    fireEvent.click(screen.getByTestId("approval-approve"));
    expect(onDecide).toHaveBeenCalledWith({
      approvalId: pendingApproval.id,
      decision: "approved",
      comments: "Ship it.",
      version: 1,
    });
  });

  it("says what rejecting does, in the same breath as the button", () => {
    render(<ApprovalCard approval={pendingApproval} canDecide now={now} />);
    expect(screen.getByTestId("approval-cas-version").textContent).toContain(
      "rejecting fails this run",
    );
    expect(screen.getByTestId("approval-consequence").textContent).toContain("does not merge");
  });

  it("names the roles, the deadline and the consequence of the deadline", () => {
    render(<ApprovalCard approval={pendingApproval} canDecide now={now} />);
    expect(screen.getByTestId("approval-roles").textContent).toBe("maintainer");
    expect(screen.getByTestId("approval-deadline").textContent).toContain(
      "2026-08-01 10:44:02 UTC",
    );
    expect(screen.getByTestId("approval-countdown").textContent).toContain("20h left");
    expect(screen.getByTestId("approval-on-timeout").textContent).toContain("fail the node");
  });

  it("lists the evidence, including what is restricted and why that matters", () => {
    render(<ApprovalCard approval={pendingApproval} canDecide now={now} />);
    const evidence = screen.getByTestId("approval-evidence");
    expect(evidence.textContent).toContain("plan.md");
    expect(evidence.textContent).toContain("restricted — metadata only");
  });
});

describe("a pending gate you cannot decide (W3)", () => {
  const show = () =>
    render(
      <ApprovalCard
        approval={{ ...pendingApproval, id: "01J8APPROVALBOB" }}
        canDecide={false}
        now={now}
      />,
    );

  it("has no decision controls at all", () => {
    const { container } = show();
    expect(screen.queryByTestId("approval-decision-form")).toBeNull();
    expect(screen.queryByTestId("approval-approve")).toBeNull();
    expect(container.querySelector("button[data-testid^='approval-']")).toBeNull();
  });

  it("says why, and names who holds it", () => {
    show();
    expect(screen.getByTestId("approval-not-approver").textContent).toContain(notApproverView.copy);
    expect(screen.getByTestId("approval-not-approver").textContent).toContain("maintainer");
  });
});

describe("a closed gate", () => {
  it("shows the decision, the decider and the comments", () => {
    render(<ApprovalCard approval={rejectedApproval} canDecide={false} now={now} />);
    expect(screen.getByTestId("approval-decided").textContent).toContain("rejected");
    expect(screen.getByTestId("approval-decided").textContent).toContain("usr_alice");
    expect(screen.getByTestId("approval-decision-comments").textContent).toContain(
      "needs an ADR first",
    );
    expect(screen.getByTestId("approval-state").textContent).toBe("decided");
  });

  it("shows an expired gate as a failure of the deadline, not a decision", () => {
    render(
      <ApprovalCard
        approval={{ ...pendingApproval, state: "expired", decision: null, decided_by: null }}
        canDecide={false}
        now={now}
      />,
    );
    // A closed gate shows no countdown: pretending to count to a passed
    // deadline would be the optimistic render the copy rules refuse.
    expect(screen.queryByTestId("approval-countdown")).toBeNull();
    expect(screen.getByTestId("approval-expired-reason").textContent).toContain("deadline passed");
    expect(screen.queryByTestId("approval-decision-form")).toBeNull();
  });

  it("shows a denied gate as the approver set stopping applying", () => {
    render(
      <ApprovalCard
        approval={{ ...pendingApproval, state: "denied" }}
        canDecide={false}
        now={now}
      />,
    );
    expect(screen.getByTestId("approval-denied-reason").textContent).toContain(
      "approver set no longer admits anyone",
    );
  });

  it("says when the gate carries no evidence at all", () => {
    render(
      <ApprovalCard
        approval={{ ...pendingApproval, artifact_refs: [] }}
        canDecide={false}
        now={now}
      />,
    );
    expect(screen.getByTestId("approval-no-evidence").textContent).toContain("no artifacts");
  });
});

describe("a decision refused by the server", () => {
  it("keeps the card open and names the conflict in place", () => {
    render(
      <ApprovalCard
        approval={pendingApproval}
        canDecide
        pending={false}
        conflictError={notApproverView.conflictError}
        now={now}
      />,
    );
    expect(screen.getByTestId("approval-error").getAttribute("role")).toBe("alert");
    expect(screen.getByTestId("approval-error").textContent).toContain(
      "someone decided this gate first",
    );
    // Still decidable: the version it carries is stale, but the gate is open.
    expect(screen.getByTestId("approval-approve").hasAttribute("disabled")).toBe(false);
  });

  it("disables the buttons while a decision is in flight", () => {
    render(<ApprovalCard approval={pendingApproval} canDecide pending now={now} />);
    expect(screen.getByTestId("approval-approve").hasAttribute("disabled")).toBe(true);
    expect(screen.getByTestId("approval-approve").textContent).toBe("Posting…");
  });
});
