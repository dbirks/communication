/**
 * The honesty tests. `docs/m4-contract.md` § 7.2 W5/W6 name the exact words
 * this component must and must not produce, and ADR-0023 § 6 decides what a
 * retry inherits — which is the one question a person asks an interrupted
 * attempt and the one a UI is most tempted to answer falsely.
 */
import { afterEach } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  AttemptDetail,
  AttemptAgentWork,
  CheckpointBlock,
  ErrorClassChip,
  attemptWord,
} from "./AttemptDetail";
import type { AttemptDetail as Attempt, NodeExecutionSummary } from "../../lib/pipeline/contract";
import {
  featureCheckpoints,
  featureNodes,
  implementAttempts,
  runEvents,
  workspaceLostAttempt,
} from "../../test/fixtures/m4/runs";

// Vitest globals are off, so testing-library cannot register its own cleanup.
afterEach(cleanup);

const node = featureNodes.find(
  (item) => item.node_instance_key === "/build_until_verified[2]/implement",
)!;

describe("an interrupted attempt (W5)", () => {
  // Every case renders inside the test: `cleanup` runs after each one, so a
  // render hoisted to describe scope would be gone before the assertions.
  const show = () =>
    render(
      <AttemptDetail
        attempt={implementAttempts[0]}
        node={node}
        events={runEvents.filter((event) => event.attempt_id === implementAttempts[0].id)}
      />,
    );

  it("says the worker disappeared and the outcome is unknown", () => {
    show();
    expect(screen.getByTestId("attempt-interrupted-note").textContent).toContain(
      "interrupted — the worker disappeared mid-node",
    );
    expect(screen.getByTestId("attempt-interrupted-note").textContent).toContain(
      "may be repeated by the next attempt",
    );
    expect(screen.getByTestId("attempt-status").textContent).toBe("interrupted");
  });

  it("never claims a resumption", () => {
    const { container } = show();
    expect(container.textContent).not.toMatch(/resumed|restored|no data lost|picked up/i);
  });

  it("shows the retry countdown from node.attempt.retry_scheduled, not from a guess", () => {
    show();
    expect(screen.getByTestId("attempt-retry-countdown").textContent).toContain(
      "2026-07-31 10:34:47 UTC",
    );
    expect(screen.getByTestId("attempt-retry-countdown").textContent).toContain("backoff 10s");
  });

  it("names what the next attempt inherits, in the mode the server recorded", () => {
    show();
    const block = screen.getByTestId("attempt-retry-context");
    expect(block.textContent).toContain("continue_workspace");
    expect(screen.getByTestId("attempt-continuity").textContent).toContain("uncommitted edits");
    expect(screen.getByTestId("attempt-continuity").textContent).toContain("new agent turn");
    // ADR-0023 § 4's degraded arm: resume was asked for, `new` is what happened.
    expect(screen.getByTestId("attempt-session-degraded").textContent).toContain(
      "asked for resume_if_supported, got new",
    );
  });

  it("lists the events correlated on this attempt, with the reason", () => {
    show();
    expect(screen.getByTestId("attempt-event-node.attempt.interrupted")).toBeTruthy();
    expect(screen.getByTestId("attempt-events").textContent).toContain("worker_lease_expired");
  });

  it("says there is no checkpoint rather than implying one exists", () => {
    show();
    expect(screen.getByTestId("attempt-checkpoint-none").textContent).toContain(
      "no checkpoint saved",
    );
    expect(screen.getByTestId("attempt-checkpoint-none").textContent).toContain(
      "/build_until_verified[2]/implement",
    );
  });
});

describe("a workspace_lost attempt (W6)", () => {
  const show = () => render(<AttemptDetail attempt={workspaceLostAttempt} />);

  it("says the edits are lost and no auto-retry is offered", () => {
    show();
    expect(screen.getByTestId("attempt-workspace-lost-note").textContent).toContain(
      "prior edits lost, rerun required",
    );
    expect(screen.getByTestId("attempt-workspace-lost-note").textContent).toContain(
      "No automatic retry is offered",
    );
    expect(screen.getByTestId("error-class-workspace_lost").textContent).toContain(
      "workspace_lost",
    );
  });

  it("has no retry countdown and no inheritance claim", () => {
    const { container } = show();
    expect(screen.queryByTestId("attempt-retry-countdown")).toBeNull();
    // `mode: none` is still an answer about inheritance, and says so.
    expect(screen.getByTestId("attempt-continuity").textContent).toContain("nothing is inherited");
    expect(container.textContent).not.toMatch(/kept the previous attempt/i);
  });
});

describe("a succeeded attempt with its boundary", () => {
  it("shows the outputs, the evidence and the checkpoint it saved", () => {
    render(
      <AttemptDetail
        attempt={implementAttempts[1]}
        node={node}
        checkpoint={featureCheckpoints[0]}
      />,
    );
    expect(screen.getByTestId("attempt-status").textContent).toBe("succeeded");
    expect(screen.getByTestId("attempt-outputs").textContent).toContain(
      "Implemented the approved plan",
    );
    expect(screen.getByTestId("attempt-evidence")).toBeTruthy();
    // A digest is shown shortened, in mono — the full value is on the artifact page.
    expect(screen.getByTestId("attempt-evidence-implement-summary.json").textContent).toBe(
      "9c1f7a2e4d6b",
    );
    // A sha is shortened the way git shortens one, and the commit relationship
    // is stated without a verb the API did not earn.
    expect(screen.getByTestId("attempt-checkpoint-repo-repo_01J8APP").textContent).toContain(
      "4f2a1c8 → 9b3d7e1 (head differs from base)",
    );
    expect(screen.getByTestId("attempt-checkpoint-volume").textContent).toBe("vol_01J8A");
  });

  it("labels an attempt by its error class when it has one", () => {
    expect(attemptWord(implementAttempts[0])).toBe("interrupted");
    expect(attemptWord({ ...implementAttempts[1], status: "failed", error_class: "timeout" })).toBe(
      "failed · timeout",
    );
  });
});

describe("CheckpointBlock", () => {
  it("shows commits and paths-free locators, and never a filesystem path", () => {
    const { container } = render(
      <CheckpointBlock
        checkpoint={featureCheckpoints[0]}
        nodeKey="/build_until_verified[2]/implement"
      />,
    );
    expect(screen.getByTestId("attempt-checkpoint-inputs-digest").textContent).toBe("1111a2e4d6b8");
    expect(screen.getByTestId("attempt-checkpoint").textContent).toContain(
      "modified paths: modified-paths.json",
    );
    expect(container.innerHTML).not.toMatch(/\/home\/|\/var\/|\/workspace|C:\\\\|repos\/app/i);
  });

  it("explains what a boundary is for", () => {
    render(<CheckpointBlock checkpoint={featureCheckpoints[0]} />);
    expect(screen.getByTestId("attempt-checkpoint").textContent).toContain(
      "a retry inherits this boundary, not the interrupted process",
    );
  });
});

describe("ErrorClassChip", () => {
  it("renders every error class the server can name, each with its words", () => {
    for (const errorClass of [
      "infra",
      "interrupted",
      "timeout",
      "agent_error",
      "invalid_output",
      "predicate_error",
      "sandbox_enforcement_failed",
      "workspace_lost",
      "binding_error",
      "approval_expired",
      "cancelled",
    ]) {
      render(<ErrorClassChip errorClass={errorClass} />);
    }
    // `agent_error` is not a verdict on model quality, and says so (contract § 5).
    expect(screen.getByTestId("error-class-agent_error").textContent).toContain(
      "not a model quality judgement",
    );
    expect(screen.getByTestId("error-class-sandbox_enforcement_failed").textContent).toContain(
      "the sandbox refused the stage",
    );
  });

  it("shows an unrecognised class as named, rather than dropping it", () => {
    render(<ErrorClassChip errorClass="brand_new_class" />);
    expect(screen.getByTestId("error-class-brand_new_class").textContent).toContain(
      "brand_new_class",
    );
  });
});

/* ------------------------------------------- what the pane shows, and how */

describe("the pane's own behaviour (run-view-3b/4a)", () => {
  const execNode: NodeExecutionSummary = {
    ...node,
    kind: "process.exec",
    node_instance_key: "/checks[1]/test",
  };
  const execAttempt: Attempt = {
    ...implementAttempts[1],
    detail: "go test ./... exited 1",
    outputs: {
      exit_code: 1,
      stdout_bytes: 4096,
      stderr_bytes: 128,
      stdout_preview: "ok  \tinternal/api\t0.411s\nFAIL\tinternal/store\t0.902s",
      stderr_preview: "panic: runtime error",
    },
  };

  it("keeps the outputs document collapsed until it is asked for", () => {
    render(<AttemptDetail attempt={implementAttempts[1]} node={node} />);
    const pre = screen.getByTestId("attempt-outputs");
    // Collapsed by default: the payload is in the DOM (it is the node's own
    // answer) but hidden, and the toggle says so.
    expect(pre.hasAttribute("hidden")).toBe(true);
    expect(screen.getByTestId("attempt-outputs-toggle").getAttribute("aria-expanded")).toBe(
      "false",
    );

    fireEvent.click(screen.getByTestId("attempt-outputs-toggle"));
    expect(pre.hasAttribute("hidden")).toBe(false);
    expect(screen.getByTestId("attempt-outputs-toggle").getAttribute("aria-expanded")).toBe("true");
    expect(pre.textContent).toContain("Implemented the approved plan");
  });

  it("reports a process.exec attempt by exit code and captured previews", () => {
    render(<AttemptDetail attempt={execAttempt} node={execNode} />);
    expect(screen.getByTestId("attempt-exit-code").textContent).toBe("1");
    expect(screen.getByTestId("attempt-capture-bytes").textContent).toContain("4096");
    expect(screen.getByTestId("attempt-stdout").textContent).toContain("FAIL\tinternal/store");
    expect(screen.getByTestId("attempt-stderr").textContent).toContain("panic: runtime error");
    // The preview is labelled a preview: the full bytes are the artifact's story.
    expect(screen.getByTestId("attempt-process-facts").textContent).toContain("(preview)");
  });

  it("says no exit code was served rather than inventing one", () => {
    render(
      <AttemptDetail attempt={{ ...execAttempt, outputs: { stdout_bytes: 12 } }} node={execNode} />,
    );
    expect(screen.getByTestId("attempt-exit-code").textContent).toBe("not served");
    expect(screen.queryByTestId("attempt-stdout")).toBeNull();
  });

  it("says plainly when an attempt owns no conversation", () => {
    render(
      <AttemptDetail
        attempt={{ ...implementAttempts[1], conversation_id: null, turn_id: null }}
        node={node}
        work={
          <AttemptAgentWork
            attempt={{ ...implementAttempts[1], conversation_id: null }}
            projectId="prj"
            node={node}
          />
        }
      />,
    );
    expect(screen.getByTestId("attempt-no-conversation").textContent).toContain(
      "reports no conversation",
    );
  });
});
