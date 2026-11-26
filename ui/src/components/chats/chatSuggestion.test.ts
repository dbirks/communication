import { afterEach, describe, expect, it } from "vitest";
import {
  buildSuggestionWorkflows,
  dismissWorkflowSuggestion,
  isWorkflowSuggestionDismissed,
  suggestWorkflow,
  workflowNoteDismissedKey,
  type SuggestionWorkflow,
} from "./chatSuggestion";
import type { Assignment, PipelineRevision } from "../../api/types";
import type { IssueTrigger } from "../../api/useIssueTriggers";

const baseConversation = {
  id: "conv-1",
  title: "Investigate timeout in importer",
  linked_runs: [],
};

const baseWorkflow: SuggestionWorkflow = {
  assignmentId: "assign-1",
  pipelineId: "pipe-1",
  name: "wf-1",
  hasIssueTrigger: true,
  hasIssueInput: false,
  stepNames: ["plan", "implement", "test", "review"],
};

afterEach(() => {
  window.localStorage.clear();
});

describe("suggestWorkflow", () => {
  it("matches when draft text contains #<number> and workflow has an issue trigger", () => {
    const result = suggestWorkflow({
      conversation: baseConversation,
      draftText: "Can we look at #42 next?",
      lastUserMessage: "",
      workflows: [baseWorkflow],
    });
    expect(result).toEqual({
      assignmentId: "assign-1",
      pipelineId: "pipe-1",
      name: "wf-1",
      subject: "#42",
      issueNumber: 42,
      summary: "plan + implement + test",
      issueInputName: null,
      needsDialog: false,
      repositoryId: null,
    });
  });

  it("matches when lastUserMessage contains #<number> and workflow has an issue input", () => {
    const result = suggestWorkflow({
      conversation: baseConversation,
      draftText: "",
      lastUserMessage: "See #77 for details",
      workflows: [
        {
          ...baseWorkflow,
          hasIssueTrigger: false,
          hasIssueInput: true,
          issueInputName: "issue",
        },
      ],
    });
    expect(result?.subject).toBe("#77");
    expect(result?.issueInputName).toBe("issue");
    expect(result?.summary).toBe("plan + implement + test");
  });

  it("matches when conversation title links an issue (#<number>)", () => {
    const result = suggestWorkflow({
      conversation: { ...baseConversation, title: "Fix #105 parser bug" },
      draftText: "",
      lastUserMessage: "",
      workflows: [baseWorkflow],
    });
    expect(result?.subject).toBe("#105");
  });

  it("returns null when no issue reference is present", () => {
    const result = suggestWorkflow({
      conversation: baseConversation,
      draftText: "Refactor the parser",
      lastUserMessage: "Add unit tests",
      workflows: [baseWorkflow],
    });
    expect(result).toBeNull();
  });

  it("returns null when no workflow has an issue trigger or issue input", () => {
    const result = suggestWorkflow({
      conversation: baseConversation,
      draftText: "Check #42",
      lastUserMessage: "",
      workflows: [
        {
          ...baseWorkflow,
          hasIssueTrigger: false,
          hasIssueInput: false,
        },
      ],
    });
    expect(result).toBeNull();
  });

  it("returns null when a run of that workflow was already started from this chat", () => {
    const result = suggestWorkflow({
      conversation: baseConversation,
      draftText: "Check #42",
      lastUserMessage: "",
      workflows: [baseWorkflow],
      startedPipelineIds: new Set(["pipe-1"]),
    });
    expect(result).toBeNull();
  });

  it("returns null when dismissed in localStorage for that conversation", () => {
    dismissWorkflowSuggestion("conv-1");
    expect(window.localStorage.getItem(workflowNoteDismissedKey("conv-1"))).toBe("1");
    expect(isWorkflowSuggestionDismissed("conv-1")).toBe(true);

    const result = suggestWorkflow({
      conversation: baseConversation,
      draftText: "Check #42",
      lastUserMessage: "",
      workflows: [baseWorkflow],
    });
    expect(result).toBeNull();
    // Different conversation is unaffected.
    expect(
      suggestWorkflow({
        conversation: { ...baseConversation, id: "conv-2" },
        draftText: "Check #42",
        lastUserMessage: "",
        workflows: [baseWorkflow],
      }),
    ).not.toBeNull();
  });

  it("builds workflow metadata from assignments, triggers, and revisions", () => {
    const assignment: Assignment = {
      id: "assign-1",
      project_id: "proj-1",
      pipeline_id: "pipe-1",
      pinned_revision_id: "rev-1",
      pinned_revision_digest: "abcdef123456",
      pinned_version_label: "1.0.0",
      max_concurrent_runs: 1,
      budget_overrides: {},
      effective_budgets: {},
      enabled: true,
      version: 1,
      created_at: "2026-10-14T18:00:00Z",
      updated_at: "2026-10-14T18:00:00Z",
    };
    const trigger: IssueTrigger = {
      id: "trig-1",
      project_id: "proj-1",
      assignment_id: "assign-1",
      repository_id: "repo-1",
      event: "opened",
      labels: [],
      inputs: {},
      enabled: true,
      version: 1,
      created_by: "user-1",
      created_at: "2026-10-14T18:00:00Z",
      updated_at: "2026-10-14T18:00:00Z",
    };
    const revision = {
      id: "rev-1",
      pipeline_id: "pipe-1",
      revision_number: 1,
      version_label: "1.0.0",
      api_version: "communication.dev/v1alpha1",
      canonical_document: {
        apiVersion: "communication.dev/v1alpha1",
        kind: "Pipeline",
        spec: {
          nodes: [
            { id: "run_tests", kind: "process.exec" },
            { id: "goal_check", kind: "agent.acp" },
            { id: "review", kind: "agent.acp" },
            { id: "publish", kind: "git.publish" },
          ],
          inputs: {
            type: "object",
            properties: {
              issue: { type: "integer" },
            },
          },
        },
      },
      document_text: "",
      revision_digest: "abcdef123456",
      digest_scope: "v1",
      compiled_plan: {},
      plan_digest: "p1",
      schema_digest: "s1",
      cel_env_digest: "c1",
      status: "published",
      published_by: "user-1",
      published_at: "2026-10-14T18:00:00Z",
      input_specs: [{ name: "issue", type: "text", required: false }],
    } as unknown as PipelineRevision;

    const workflows = buildSuggestionWorkflows({
      assignments: [assignment],
      pipelines: [{ id: "pipe-1", slug: "wf-1", display_name: "Workflow One" }],
      issueTriggers: [trigger],
      revisionsById: new Map([["rev-1", revision]]),
    });
    expect(workflows).toHaveLength(1);
    expect(workflows[0].hasIssueTrigger).toBe(true);
    expect(workflows[0].hasIssueInput).toBe(true);
    expect(workflows[0].stepNames).toEqual(["run tests", "goal check", "review", "publish"]);
  });
});
