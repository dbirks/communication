/**
 * The "hand to a workflow" pure helpers (ADR-0053): the RunCreate body shape
 * (source member included and omitted exactly when empty), the workflow
 * select projection, the honest branch answers, the `201 base` lines and the
 * last-agent-message prefill.
 */
import { describe, expect, it } from "vitest";
import type { Assignment, Workspace } from "./types";
import { envelopeFixture } from "../test/fakes";
import {
  CARRIES_BRANCH_COPY,
  NO_COMMITS_COPY,
  baseResultLines,
  handoffRunCreateBody,
  handoffRunKey,
  handoffWorkflowOptions,
  lastAgentMessageOf,
  threadBranchCarriesCommits,
  threadWorkspaceOf,
} from "./handoff";

const projectId = "01987a6c-4d5e-7f1a-9b2c-3d4e5f6a7b80";
const conversationId = "01987a70-1111-7000-8000-abcdef012345";
const pipelineId = "01987a7e-3333-7000-8000-abcdef012345";
const digest = "1234567890abcdef1234567890abcdef12345678";

const assignment = (over: Partial<Assignment> = {}): Assignment => ({
  id: "01987a6d-5555-7000-8000-abcdef012345",
  project_id: projectId,
  pipeline_id: pipelineId,
  pinned_revision_id: "01987a7e-4444-7000-8000-abcdef012345",
  pinned_revision_digest: digest,
  pinned_version_label: "stable r4",
  max_concurrent_runs: 2,
  budget_overrides: {},
  effective_budgets: {},
  enabled: true,
  version: 1,
  created_at: "2026-10-14T18:00:00Z",
  updated_at: "2026-10-14T18:00:00Z",
  ...over,
});

const workspace = (over: Partial<Workspace> = {}): Workspace => ({
  id: "01987a75-6666-7000-8000-abcdef012345",
  project_id: projectId,
  scope_kind: "conversation",
  conversation_id: conversationId,
  run_id: null,
  worker_id: "01987a74-5555-7000-8000-abcdef012345",
  volume_id: "sha256:aaaa",
  workspace_mode: "worktree",
  state: "ready",
  repos: [
    {
      repository_id: "01987a79-aaaa-7000-8000-abcdef012345",
      name: "acme-api",
      run_ref: `thread/${conversationId}/acme-api`,
      base_commit: "basebasebase",
      head_commit: null,
      workspace_mode: "worktree",
    },
  ],
  created_at: "2026-10-14T18:00:00Z",
  ...over,
});

describe("handoffRunCreateBody", () => {
  it("carries the assignment pin and the source member with summary and artifacts", () => {
    const body = handoffRunCreateBody("assignment-1", {
      conversationId: conversationId,
      summary: "Cache key misses every run",
      artifactIds: ["a1", "a2"],
    });
    expect(body).toEqual({
      assignment_id: "assignment-1",
      source: {
        conversation_id: conversationId,
        summary: "Cache key misses every run",
        artifact_ids: ["a1", "a2"],
      },
    });
  });

  it("omits an empty (or whitespace) summary and empty artifact lists — never an empty source member", () => {
    const body = handoffRunCreateBody("assignment-1", {
      conversationId: conversationId,
      summary: "   ",
      artifactIds: [],
    });
    expect(body).toEqual({
      assignment_id: "assignment-1",
      source: { conversation_id: conversationId },
    });
    expect("summary" in (body.source ?? {})).toBe(false);
    expect("artifact_ids" in (body.source ?? {})).toBe(false);
  });

  it("trims the summary before it seeds handoff_summary", () => {
    const body = handoffRunCreateBody("assignment-1", {
      conversationId: conversationId,
      summary: "  padded text  ",
    });
    expect(body.source?.summary).toBe("padded text");
  });

  it("carries the declared inputs when there is something to fill, omits an empty map", () => {
    const body = handoffRunCreateBody("assignment-1", {
      conversationId: conversationId,
      inputs: { goal: "Fix the cache key", repository: "acme-api" },
    });
    expect(body.inputs).toEqual({ goal: "Fix the cache key", repository: "acme-api" });
    const empty = handoffRunCreateBody("assignment-1", {
      conversationId: conversationId,
      inputs: {},
    });
    expect("inputs" in empty).toBe(false);
    expect(
      handoffRunCreateBody("assignment-1", { conversationId: conversationId }).inputs,
    ).toBeUndefined();
  });
});

describe("handoffRunKey", () => {
  it("is a per-instance key and differs per call", () => {
    expect(handoffRunKey()).not.toBe(handoffRunKey());
    expect(handoffRunKey().startsWith("handoff-")).toBe(true);
  });
});

describe("handoffWorkflowOptions", () => {
  it("lists enabled assignments labelled by pipeline slug and version, digest-prefix fallback", () => {
    const options = handoffWorkflowOptions(
      [
        assignment(),
        assignment({
          id: "01987a6d-6666-7000-8000-abcdef012345",
          pinned_version_label: null,
          enabled: false,
        }),
      ],
      [{ id: pipelineId, slug: "bugfix" }],
    );
    expect(options).toEqual([
      {
        id: "01987a6d-5555-7000-8000-abcdef012345",
        pinnedRevisionId: "01987a7e-4444-7000-8000-abcdef012345",
        label: "bugfix · stable r4",
      },
    ]);
  });
});

describe("thread workspace answers", () => {
  it("finds the conversation's own workspace row only", () => {
    const rows = [
      workspace({ scope_kind: "run", conversation_id: null, run_id: "run-1" }),
      workspace({ conversation_id: "another-conversation" }),
    ];
    expect(threadWorkspaceOf(rows, conversationId)).toBeNull();
    const rows2 = [...rows, workspace()];
    expect(threadWorkspaceOf(rows2, conversationId)?.id).toBe(rows2.at(-1)?.id);
  });

  it("answers the branch question from recorded head vs base only", () => {
    expect(threadBranchCarriesCommits(null)).toBe(false);
    expect(threadBranchCarriesCommits(workspace())).toBe(false); // head null
    const clean = workspace({
      repos: [{ ...workspace().repos[0], head_commit: "basebasebase" }],
    });
    expect(threadBranchCarriesCommits(clean)).toBe(false); // head == base
    const dirty = workspace({
      repos: [{ ...workspace().repos[0], head_commit: "newhead" }],
    });
    expect(threadBranchCarriesCommits(dirty)).toBe(true);
    expect(CARRIES_BRANCH_COPY).toContain("the run's base");
    expect(NO_COMMITS_COPY).toContain("default branch");
  });
});

describe("baseResultLines", () => {
  it("one line per repository, in the order the create response sent", () => {
    const lines = baseResultLines({
      repositories: [
        {
          repository_id: "r1",
          mode: "thread_branch",
          base_commit: "abcdef1234567890",
          reason: "head commit abcdef12 beyond base basebase",
        },
        {
          repository_id: "r2",
          mode: "default_branch",
          base_commit: null,
          reason: "no recorded commits beyond the base",
        },
      ],
    });
    expect(lines).toEqual([
      "base: the thread branch, pinned at abcdef123456",
      "base: the repository's default branch (no recorded commits beyond the base)",
    ]);
    expect(baseResultLines(undefined)).toEqual([]);
    expect(baseResultLines(null)).toEqual([]);
  });
});

describe("lastAgentMessageOf", () => {
  const userOnly = envelopeFixture({
    global_seq: 1,
    event_id: "evt-user-only",
    type: "conversation.message.user",
    conversation_id: conversationId,
    payload: {
      conversation_id: conversationId,
      turn_id: "turn-1",
      submitted_by: "user-1",
      text: "hi",
    },
  });

  const agentMessage = (seq: number, text: string, final = false) =>
    envelopeFixture({
      global_seq: seq,
      event_id: `evt-${seq}`,
      type: "conversation.message.agent",
      conversation_id: conversationId,
      payload: {
        conversation_id: conversationId,
        turn_id: "turn-1",
        chunk_seq: seq,
        text,
        truncated: false,
        final,
      },
    });

  it("is the last agent message; chunks of one turn merge as the transcript does", () => {
    const events = [
      envelopeFixture({
        global_seq: 1,
        event_id: "evt-user",
        type: "conversation.message.user",
        conversation_id: conversationId,
        payload: {
          conversation_id: conversationId,
          turn_id: "turn-1",
          submitted_by: "user-1",
          text: "Why is CI slow?",
        },
      }),
      agentMessage(2, "The cache key includes the lockfile path, "),
      agentMessage(3, "so every run misses.", true),
    ];
    expect(lastAgentMessageOf(events)).toBe(
      "The cache key includes the lockfile path, so every run misses.",
    );
  });

  it("is empty when the thread has no agent message yet", () => {
    expect(lastAgentMessageOf([])).toBe("");
    expect(lastAgentMessageOf([userOnly])).toBe("");
  });
});
