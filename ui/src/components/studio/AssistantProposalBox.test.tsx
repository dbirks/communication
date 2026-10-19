/**
 * AssistantProposalBox tests (ADR-0044 UI half): the mutation is mocked at
 * the hook boundary; the real `applyProposal` and the real problem mapping
 * run in-process. Happy path previews text carrying the new node id and
 * `node_ids`; a 422 shows the server's detail; dirty/readOnly disable
 * Propose with a visible reason; a live preview shows the caption and
 * Apply/Discard wired back to the page.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../api/client";
import type { components } from "../../api/schema";
import { findNode, parseGraph } from "../../lib/pipeline/graphDoc";
import {
  draftProposalErrorOf,
  type DraftProposalInput,
  type DraftProposalResponse,
} from "../../api/draftProposals";
import {
  AssistantProposalBox,
  PROPOSAL_CAPTION,
  type AssistantProposalBoxProps,
} from "./AssistantProposalBox";

/** A tiny two-node draft: build -> tests (root scope, no guards). */
const DRAFT = `apiVersion: communication.dev/v1alpha1
kind: Pipeline
metadata:
  name: t
spec:
  nodes:
  - id: build
    kind: process.exec
    config:
      command: make build
  - id: tests
    kind: process.exec
    dependsOn: [build]
    config:
      command: make test
`;

interface MockState {
  outcome: "ok" | "invalid422";
  mutate: ReturnType<typeof vi.fn>;
}

const state: MockState = {
  outcome: "ok",
  mutate: vi.fn(),
};

vi.mock("../../api/draftProposals", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/draftProposals")>();
  return {
    ...actual,
    useDraftProposal: () => ({
      mutate: state.mutate,
      isPending: false,
    }),
  };
});

function problem(status: number, type: string, detail: string): components["schemas"]["Problem"] {
  return {
    type: `https://communication.dev/problems/${type}`,
    title: detail,
    status,
    detail,
  };
}

function proposalResponse(): DraftProposalResponse {
  return {
    op: {
      op: "insert_after",
      after: "tests",
      kind: "agent.acp",
      id: "review_new",
      config: { profile: "m4-reviewer", prompt: "Review the changes." },
    },
    node_ids: ["review_new"],
    summary: "Inserted a code reviewer (review_new) after the tests.",
    version: 4,
  };
}

beforeEach(() => {
  state.outcome = "ok";
  state.mutate.mockImplementation(
    (
      input: DraftProposalInput,
      callbacks: {
        onSuccess: (data: DraftProposalResponse) => void;
        onError: (error: ApiError) => void;
      },
    ) => {
      expect(input).toEqual({
        draftId: "d1",
        version: 4,
        instruction: "add a reviewer",
      });
      if (state.outcome === "ok") callbacks.onSuccess(proposalResponse());
      else
        callbacks.onError(
          new ApiError(problem(422, "assistant_proposal_invalid", "node id not in draft"), null),
        );
    },
  );
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderBox(overrides: Partial<AssistantProposalBoxProps> = {}) {
  const onPreview = vi.fn();
  const onApply = vi.fn();
  const onDiscard = vi.fn();
  render(
    <AssistantProposalBox
      draftId="d1"
      version={4}
      text={DRAFT}
      readOnly={false}
      dirty={false}
      previewing={false}
      onPreview={onPreview}
      onApply={onApply}
      onDiscard={onDiscard}
      {...overrides}
    />,
  );
  return { onPreview, onApply, onDiscard };
}

function propose(text = "add a reviewer"): void {
  fireEvent.change(screen.getByTestId("assistant-proposal-input"), {
    target: { value: text },
  });
  fireEvent.click(screen.getByTestId("assistant-proposal-submit"));
}

describe("AssistantProposalBox", () => {
  it("applies a 200 proposal locally and previews the text with the new node id", () => {
    const { onPreview } = renderBox();
    propose();
    expect(state.mutate).toHaveBeenCalledTimes(1);
    expect(onPreview).toHaveBeenCalledTimes(1);
    const preview = onPreview.mock.calls[0][0];
    expect(preview.nodeIds).toEqual(["review_new"]);
    expect(preview.summary).toBe(proposalResponse().summary);
    // The local op actually landed in the text (not a string patch-up).
    expect(preview.text).toContain("id: review_new");
    expect(preview.text).toContain("make test");
    const parsed = parseGraph(preview.text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(parsed.error);
    expect(findNode(parsed.model, "review_new")?.dependsOn).toEqual(["tests"]);
  });

  it("shows the 422 detail and does not preview", () => {
    state.outcome = "invalid422";
    const { onPreview } = renderBox();
    propose();
    expect(onPreview).not.toHaveBeenCalled();
    expect(screen.getByTestId("assistant-proposal-error").textContent).toBe("node id not in draft");
  });

  it("maps 503 assistant_not_configured to the not-configured line", () => {
    expect(
      draftProposalErrorOf(
        new ApiError(problem(503, "assistant_not_configured", "no assistant"), null),
      ),
    ).toBe("The assistant is not configured on this server.");
  });

  it("maps 409 to the reload-before-asking line", () => {
    expect(
      draftProposalErrorOf(new ApiError(problem(409, "stale_draft_version", "draft moved"), null)),
    ).toBe("The draft changed — reload before asking.");
  });

  it("disables Propose while the draft has unsaved edits, with the reason", () => {
    renderBox({ dirty: true });
    expect((screen.getByTestId("assistant-proposal-submit") as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(screen.getByTestId("assistant-proposal-reason").textContent).toBe(
      "Save your edits first — proposals are made against the saved version.",
    );
  });

  it("disables Propose on a read-only draft, with the reason", () => {
    renderBox({ readOnly: true });
    expect((screen.getByTestId("assistant-proposal-submit") as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(screen.getByTestId("assistant-proposal-reason").textContent).toMatch(/read-only/);
    propose();
    expect(state.mutate).not.toHaveBeenCalled();
  });

  it("with nothing typed, Propose is inert", () => {
    renderBox();
    fireEvent.click(screen.getByTestId("assistant-proposal-submit"));
    expect(state.mutate).not.toHaveBeenCalled();
  });

  it("while previewing, shows the caption and Apply/Discard wired back to the page", () => {
    const { onApply, onDiscard } = renderBox({ previewing: true });
    expect(screen.getByTestId("assistant-proposal-caption").textContent).toBe(PROPOSAL_CAPTION);
    // The assistant never offers Publish.
    expect(screen.queryByText(/publish/i)).toBeNull();
    fireEvent.click(screen.getByTestId("assistant-proposal-apply"));
    expect(onApply).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId("assistant-proposal-discard"));
    expect(onDiscard).toHaveBeenCalledTimes(1);
  });

  it("collapses and reopens", () => {
    renderBox();
    const toggle = screen.getByTestId("assistant-proposal-box").querySelector("button");
    expect(toggle).not.toBeNull();
    fireEvent.click(toggle!);
    expect(screen.queryByTestId("assistant-proposal-input")).toBeNull();
    fireEvent.click(toggle!);
    expect(screen.getByTestId("assistant-proposal-input")).toBeTruthy();
  });
});
