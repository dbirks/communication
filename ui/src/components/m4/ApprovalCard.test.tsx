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

/** A real-looking decider id: the pass-2 emulator wrote this shape verbatim. */
const DECIDER_ID = "01a18c3e-5347-787b-86d3-6b8ae2d22c36";

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
    // A rejection is a business outcome, not an execution failure
    // (`docs/m4-contract.md` § 5.3, C9e): the card must say so and must NEVER
    // promise that rejecting fails the run — the old "rejecting fails this
    // run" sentence contradicted the engine and is a regression guard now.
    const version = screen.getByTestId("approval-cas-version").textContent ?? "";
    expect(version).toContain("rejecting records the decision");
    expect(version).toContain("version 1");
    expect(version).not.toContain("fails");
    const consequence = screen.getByTestId("approval-consequence").textContent ?? "";
    expect(consequence).toContain("does not merge");
    expect(consequence).toContain("Rejecting records the decision as a business outcome");
    expect(consequence).toContain("steps that need approval won't run");
    expect(consequence).not.toMatch(/reject\w*\s+(will )?fail/);
  });

  it("names the roles, the deadline and the consequence of the deadline", () => {
    render(<ApprovalCard approval={pendingApproval} canDecide now={now} />);
    expect(screen.getByTestId("approval-roles").textContent).toBe("maintainer");
    // A waiting gate's deadline is ONE relative number — the time left — with
    // the exact instant it counts down to in the title (pass-7 review, the gate
    // showed `2026-08-01 10:44:02 UTC · 20h left`: an absolute stamp and a
    // countdown for one fact, and the handoff's copy rule says times read
    // relative). `docs/design/handoff-projects/README.md` § 1.
    const deadline = screen.getByTestId("approval-deadline");
    expect(deadline.textContent).toBe("20h left");
    expect(deadline.getAttribute("title")).toBe("2026-08-01 10:44:02 UTC");
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
    // A closed gate's chip is the state in the app's short word, not the wire's
    // `decided` token; WHO decided and WHAT they said is the record below.
    expect(screen.getByTestId("approval-state").textContent).toBe("done");
    // The deadline of a gate that closed INSIDE its deadline says so in the
    // same relative words, measured from the decision — not a countdown, not a
    // stamp.
    expect(screen.getByTestId("approval-deadline").textContent).toBe("closed with 21h left");
  });

  // Design review pass 2 (`run-gate-completed-1280.png`): the record read
  // `01a18c3e-5347-787b-86d3-6b8ae2d22c36 · 2026-10-30 09:59:32 UTC`. The gate
  // card is where a team learns who said yes, so it says a name.
  it("writes the decider's name from the caller's directory into the record", () => {
    render(
      <ApprovalCard
        approval={{ ...rejectedApproval, decided_by: DECIDER_ID }}
        canDecide={false}
        now={now}
        nameOf={(id) => (id === DECIDER_ID ? "Ada Lovelace" : id)}
      />,
    );
    expect(screen.getByTestId("approval-decided-by").textContent).toBe("Ada Lovelace");
    expect(screen.getByTestId("approval-decided").textContent).not.toContain("01a18c3e");
    expect(screen.getByTestId("approval-decided").textContent).toContain("2026-07-31 14:02:19");
  });

  it("says someone (id) rather than a bare uuid when no directory was handed over", () => {
    render(
      <ApprovalCard approval={{ ...rejectedApproval, decided_by: DECIDER_ID }} canDecide={false} />,
    );
    // `names.ts`'s last resort: short enough to read, distinct between two
    // strangers, and never the 36 characters the review saw.
    expect(screen.getByTestId("approval-decided-by").textContent).toBe("someone (e2d22c36)");
  });

  it("reads a policy pseudo-id as the policy it is, not as a missing person", () => {
    // ADR-0039: a decider can be `profile_policy:deny` — a mode, not a human.
    render(
      <ApprovalCard
        approval={{ ...rejectedApproval, decided_by: "profile_policy:deny" }}
        canDecide={false}
        nameOf={() => "nobody"}
      />,
    );
    expect(screen.getByTestId("approval-decided-by").textContent).toBe("the profile's deny policy");
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
    // deadline would be the optimistic render the copy rules refuse. It still
    // says the deadline in relative words with the exact instant in the title.
    expect(screen.queryByTestId("approval-countdown")).toBeNull();
    expect(screen.getByTestId("approval-deadline").textContent).toBe("the deadline passed");
    expect(screen.getByTestId("approval-deadline").getAttribute("title")).toBe(
      "2026-08-01 10:44:02 UTC",
    );
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

describe("a gate whose summary carries the plan document", () => {
  /** What the fixture pipeline actually serves: a title line and the planner's
   * JSON glued into one string (`samplePipeline`'s gate summary). */
  const planGate = (body: string) => ({ ...pendingApproval, summary: body });
  const plan = JSON.stringify({
    goal: "Document and fix add() in hello.py",
    steps: [{ id: 1, title: "Find the file and its tests", actions: ["Call hello.py"] }],
    risks: ["The repo was never read"],
  });

  it("keeps the title line and renders the plan as a plan, not as JSON", () => {
    render(
      <ApprovalCard approval={planGate(`Plan for hello.py\n${plan}\n`)} canDecide now={now} />,
    );
    expect(screen.getByTestId("approval-summary-title").textContent).toBe("Plan for hello.py");
    expect(screen.getByTestId("plan-goal").textContent).toBe("Document and fix add() in hello.py");
    expect(screen.getByTestId("plan-steps").textContent).toContain("Find the file and its tests");
    expect(screen.getByTestId("plan-risks").textContent).toContain("repo was never read");
    expect(screen.getByTestId("approval-summary").textContent).not.toContain('"done_when"');
  });

  it("leaves a prose summary as prose", () => {
    render(<ApprovalCard approval={pendingApproval} canDecide now={now} />);
    expect(screen.queryByTestId("approval-summary-title")).toBeNull();
    expect(screen.getByTestId("approval-summary").textContent).toContain(
      "four files, one migration",
    );
  });
});
