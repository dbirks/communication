/**
 * The gate card's three arms (W3): decide, read-but-cannot-decide, and closed.
 * The CAS `version` is the interesting part — a stale decision must come back
 * as a conflict in place, never as a silent overwrite.
 */
import { afterEach } from "vitest";
import { cleanup, fireEvent, render as renderBase, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { ApprovalCard } from "./ApprovalCard";
import { ApiError } from "../../api/client";
import { baseRoutes, mockFetch } from "../../test/fakes";
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

/** The decide arm hosts the shared DecisionBar, which reaches for the query
 * client on mount (its default POST path) — so every card mounts inside a
 * provider, exactly as it renders in the app. */
function mount(element: ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return renderBase(<QueryClientProvider client={client}>{element}</QueryClientProvider>);
}

/** A real-looking decider id: the pass-2 emulator wrote this shape verbatim. */
const DECIDER_ID = "01a18c3e-5347-787b-86d3-6b8ae2d22c36";

/** A host's decide that the server refused: the bar sees exactly this error,
 * because the host rethrows it (`T10b`) rather than swallowing it. */
function refused(status: number, body: Record<string, unknown>): ApiError {
  const problem = {
    type: "https://communication.dev/errors/problem",
    title: "Refused",
    status,
    detail: "the gate kept waiting",
    ...body,
  };
  return new ApiError(problem, problem);
}

/** The `409 approval_already_decided` winner, as route 36 serves it: the
 * decider is a user ID — a name is the app's directory's job, not the body's. */
function alreadyDecided(decidedBy: string | null = DECIDER_ID): ApiError {
  const body = {
    type: "https://communication.dev/errors/approval-already-decided",
    title: "Approval Already Decided",
    status: 409,
    detail: "The gate is already decided; the body carries the winner.",
    approval_id: pendingApproval.id,
    approval: { state: "decided", decision: "approved", decided_by: decidedBy, version: 2 },
  };
  return new ApiError(body, body);
}

describe("a pending gate you can decide", () => {
  it("posts through the DecisionBar once the undo hold expires, with the CAS version", async () => {
    const onDecide = vi.fn();
    mount(<ApprovalCard approval={pendingApproval} canDecide onDecide={onDecide} now={now} />);
    // Finding 04: fixed verbs, never model-written labels.
    expect(screen.getByTestId("decision-approve").textContent).toBe("Approve");
    expect(screen.getByTestId("decision-request-changes").textContent).toBe("Request changes");
    expect(screen.getByTestId("decision-reject").textContent).toBe("Reject");

    vi.useFakeTimers();
    try {
      fireEvent.click(screen.getByTestId("decision-approve"));
      expect(onDecide).not.toHaveBeenCalled(); // the hold is not a post
      await vi.advanceTimersByTimeAsync(5000);
      expect(onDecide).toHaveBeenCalledTimes(1);
      expect(onDecide).toHaveBeenCalledWith({
        approvalId: pendingApproval.id,
        decision: "approved",
        comments: "",
        version: 1,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("Request changes carries the person's note as rejected + comments", async () => {
    const onDecide = vi.fn();
    mount(<ApprovalCard approval={pendingApproval} canDecide onDecide={onDecide} now={now} />);
    vi.useFakeTimers();
    try {
      fireEvent.click(screen.getByTestId("decision-request-changes"));
      fireEvent.change(screen.getByTestId("decision-changes-text"), {
        target: { value: "Ship it." },
      });
      fireEvent.click(screen.getByTestId("decision-changes-send"));
      expect(onDecide).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(5000);
      expect(onDecide).toHaveBeenCalledWith({
        approvalId: pendingApproval.id,
        decision: "rejected",
        comments: "Ship it.",
        version: 1,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("says what rejecting does, in the same breath as the button", () => {
    mount(<ApprovalCard approval={pendingApproval} canDecide now={now} />);
    // A rejection is a business outcome, not an execution failure
    // (`docs/m4-contract.md` § 5.3, C9e): the card must say so and must NEVER
    // promise that rejecting fails the run — the old "rejecting fails this
    // run" sentence contradicted the engine and is a regression guard now.
    // The version line is gone with the old form (the bar carries the CAS
    // token itself); the consequence copy stays and stays honest.
    const consequence = screen.getByTestId("approval-consequence").textContent ?? "";
    expect(consequence).toContain("does not merge");
    expect(consequence).toContain("Rejecting records the decision as a business outcome");
    expect(consequence).toContain("steps that need approval won't run");
    expect(consequence).not.toMatch(/reject\w*\s+(will )?fail/);
  });

  it("names the roles, the deadline and the consequence of the deadline", () => {
    mount(<ApprovalCard approval={pendingApproval} canDecide now={now} />);
    // Round-2 review item 3: the card read `node /approve` — the run's internal
    // path identity — where the reader wants the step. The leaf of the key *is*
    // the step's name (`/approve` → `approve`, `/scope[2]/gate` → `gate`), and
    // the whole key stays one hover away in the value's `title`.
    const step = screen.getByTestId("approval-node");
    expect(step.textContent).toBe("approve");
    expect(step.getAttribute("title")).toBe("/approve");
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

  // Pass-1 design review item 2: the plan the decision rests on ran ~1800px
  // tall, so Approve/Reject were off the bottom of `run-gate-waiting-1280.png`
  // with nothing pinned. The plan is NOT clamped (round-2 review item 3 forbids
  // a clamp on a decidable body) — instead the card says the decision is further
  // down and puts one verb at the top that lands the reader on the form.
  it("offers a Decide jump at the top of the card, above the plan", () => {
    mount(<ApprovalCard approval={pendingApproval} canDecide now={now} />);
    const jump = screen.getByTestId("approval-decide-jump");
    expect(jump.textContent).toContain("Decide");
    // It sits ABOVE the plan, which is the whole point: a reader who can see the
    // top of the card can see the way to the decision.
    const card = screen.getByTestId("approval-summary").parentElement as HTMLElement;
    expect(card.contains(jump)).toBe(true);
    expect(
      jump.compareDocumentPosition(screen.getByTestId("approval-summary")) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // …and it names the form it controls.
    const form = screen.getByTestId("approval-decision-form");
    expect(jump.getAttribute("aria-controls")).toBe(form.id);
    expect(form.id).not.toBe("");
  });

  it("moves the reader to the decision when they take the jump", () => {
    const scrolled: string[] = [];
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function scrollIntoView(this: Element) {
      scrolled.push(this.getAttribute("data-testid") ?? "?");
    };
    try {
      mount(<ApprovalCard approval={pendingApproval} canDecide now={now} />);
      fireEvent.click(screen.getByTestId("approval-decide-jump"));
    } finally {
      Element.prototype.scrollIntoView = original;
    }
    expect(scrolled).toEqual(["approval-decision-form"]);
    // A keyboard user gets the caret where their next keystroke belongs.
    expect(document.activeElement).toBe(screen.getByTestId("decision-approve"));
  });

  it("offers no jump verb where there is no decision to make", () => {
    // W3's arm: the card is readable, and there is no form to jump to.
    const { unmount } = mount(
      <ApprovalCard approval={pendingApproval} canDecide={false} now={now} />,
    );
    expect(screen.queryByTestId("approval-decide-jump")).toBeNull();
    expect(screen.queryByTestId("approval-decide-bar")).toBeNull();
    unmount();
    // A closed gate has no decision either — the record is what it shows.
    mount(<ApprovalCard approval={rejectedApproval} canDecide now={now} />);
    expect(screen.queryByTestId("approval-decide-jump")).toBeNull();
  });

  it("lists the evidence, including what is restricted and why that matters", () => {
    mount(<ApprovalCard approval={pendingApproval} canDecide now={now} />);
    const evidence = screen.getByTestId("approval-evidence");
    expect(evidence.textContent).toContain("plan.md");
    expect(evidence.textContent).toContain("restricted — metadata only");
  });
});

describe("a pending gate you cannot decide (W3)", () => {
  const show = () =>
    mount(
      <ApprovalCard
        approval={{ ...pendingApproval, id: "01J8APPROVALBOB" }}
        canDecide={false}
        now={now}
      />,
    );

  it("has no decision controls at all", () => {
    const { container } = show();
    expect(screen.queryByTestId("approval-decision-form")).toBeNull();
    expect(screen.queryByTestId("decision-approve")).toBeNull();
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
    mount(<ApprovalCard approval={rejectedApproval} canDecide={false} now={now} />);
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
    mount(
      <ApprovalCard
        approval={{ ...rejectedApproval, decided_by: DECIDER_ID }}
        canDecide={false}
        now={now}
        nameOf={(id) => (id === DECIDER_ID ? "Ada Lovelace" : id)}
      />,
    );
    expect(screen.getByTestId("approval-decided-by").textContent).toBe("Ada Lovelace");
    expect(screen.getByTestId("approval-decided").textContent).not.toContain("01a18c3e");
    // Round-2 review item 3 (the handoff's own copy rule: “Times are relative
    // (`8m`, `2h`); never show ISO strings”): WHEN is the distance from now, and
    // the exact instant the audit trail speaks rides the value's `title`.
    expect(screen.getByTestId("approval-decided-at").textContent).toBe("42m ago");
    expect(screen.getByTestId("approval-decided-at").getAttribute("title")).toBe(
      "2026-07-31 14:02:19 UTC",
    );
  });

  it("says someone (id) rather than a bare uuid when no directory was handed over", () => {
    mount(
      <ApprovalCard approval={{ ...rejectedApproval, decided_by: DECIDER_ID }} canDecide={false} />,
    );
    // `names.ts`'s last resort: short enough to read, distinct between two
    // strangers, and never the 36 characters the review saw.
    expect(screen.getByTestId("approval-decided-by").textContent).toBe("someone (e2d22c36)");
  });

  it("reads a policy pseudo-id as the policy it is, not as a missing person", () => {
    // ADR-0039: a decider can be `profile_policy:deny` — a mode, not a human.
    mount(
      <ApprovalCard
        approval={{ ...rejectedApproval, decided_by: "profile_policy:deny" }}
        canDecide={false}
        nameOf={() => "nobody"}
      />,
    );
    expect(screen.getByTestId("approval-decided-by").textContent).toBe("the profile's deny policy");
  });

  it("shows an expired gate as a failure of the deadline, not a decision", () => {
    mount(
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
    mount(
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
    mount(
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
    mount(
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
    expect(screen.getByTestId("decision-approve").hasAttribute("disabled")).toBe(false);
  });

  it("replaces the verbs with the undo hold while the decision waits", () => {
    vi.useFakeTimers();
    try {
      mount(<ApprovalCard approval={pendingApproval} canDecide now={now} />);
      fireEvent.click(screen.getByTestId("decision-approve"));
      expect(screen.queryByTestId("decision-approve")).toBeNull();
      expect(screen.getByTestId("decision-status").textContent).toContain(
        "Approved. The run continues in 5s.",
      );
      // Undo so the hold never posts (there is no decide stub under this test).
      fireEvent.click(screen.getByTestId("decision-undo"));
      expect(screen.getByTestId("decision-approve")).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("a host whose decide the server refused", () => {
  // T10b: the hosts that own the POST (the workbench dock, the run inspector,
  // the M4 previews) used to catch the error themselves. The bar then resolved
  // and printed "Your decision is recorded" while the host printed a refusal —
  // a refused decision reading as a recorded one. The hosts rethrow now, so the
  // card's own decide is the thing under test here.
  //
  // The directory is stubbed because the bar now reads it (an id in a conflict
  // is a person to look up, not a verdict to print).
  it("reads the conflict, never 'recorded', when the host's decide gets a 409", async () => {
    mockFetch(baseRoutes());
    const host = vi.fn().mockRejectedValue(alreadyDecided());
    mount(<ApprovalCard approval={pendingApproval} canDecide onDecide={host} now={now} />);
    vi.useFakeTimers();
    try {
      fireEvent.click(screen.getByTestId("decision-approve"));
      await vi.advanceTimersByTimeAsync(5000);
    } finally {
      vi.useRealTimers();
    }

    expect(host).toHaveBeenCalledTimes(1);
    // The truth, in the bar's own words: the loser sees who beat the click.
    expect(screen.getByTestId("decision-conflict").textContent).toContain(
      "approved this a moment ago. Your decision wasn't recorded.",
    );
    // And not the lie: no "recorded" line, and no half-decided status either.
    expect(screen.queryByText(/Your decision is recorded/)).toBeNull();
    expect(screen.queryByTestId("decision-status")).toBeNull();
  });

  it("keeps the bar and its Try again line when the host's decide gets a 500", async () => {
    mockFetch(baseRoutes());
    const host = vi.fn().mockRejectedValue(refused(500, { title: "Internal Server Error" }));
    mount(<ApprovalCard approval={pendingApproval} canDecide onDecide={host} now={now} />);
    vi.useFakeTimers();
    try {
      fireEvent.click(screen.getByTestId("decision-approve"));
      await vi.advanceTimersByTimeAsync(5000);
    } finally {
      vi.useRealTimers();
    }

    expect(host).toHaveBeenCalledTimes(1);
    const line = screen.getByTestId("decision-error");
    expect(line.getAttribute("role")).toBe("alert");
    expect(line.textContent).toContain("Try again.");
    expect(screen.queryByText(/Your decision is recorded/)).toBeNull();
    // The verbs come back: a failed POST leaves the decision unmade, so the
    // reader must be able to make it again.
    expect(screen.getByTestId("decision-approve")).toBeTruthy();
    expect(screen.getByTestId("decision-reject")).toBeTruthy();
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
    mount(<ApprovalCard approval={planGate(`Plan for hello.py\n${plan}\n`)} canDecide now={now} />);
    expect(screen.getByTestId("approval-summary-title").textContent).toBe("Plan for hello.py");
    expect(screen.getByTestId("plan-goal").textContent).toBe("Document and fix add() in hello.py");
    expect(screen.getByTestId("plan-steps").textContent).toContain("Find the file and its tests");
    expect(screen.getByTestId("plan-risks").textContent).toContain("repo was never read");
    expect(screen.getByTestId("approval-summary").textContent).not.toContain('"done_when"');
  });

  it("leaves a prose summary as prose", () => {
    mount(<ApprovalCard approval={pendingApproval} canDecide now={now} />);
    expect(screen.queryByTestId("approval-summary-title")).toBeNull();
    expect(screen.getByTestId("approval-summary").textContent).toContain(
      "four files, one migration",
    );
  });
});
