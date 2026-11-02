/**
 * The repo page's new pieces, unit-tested where the page test cannot reach:
 * the merged feed order, the honest step-segment rule (segments only from
 * real step data — the project run list has none, so the strip is omitted),
 * and `AssistantNotes`, which renders nothing without notes and the notes
 * panel when a source finally hands them over.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { buildActivityRows, runStepSegments } from "./RepoActivity";
import { AssistantNotes } from "./AssistantNotes";
import type { ConversationSummary, RunSummary } from "../../api/types";
import { conversationFixture, meFixture, projectFixture } from "../../test/fakes";
import { WIRE_PIPELINE_ID, WIRE_REVISION_ID } from "../../test/fixtures/m4/wire";

function run(overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    id: "01987c11-0000-7000-8000-abcdef012345",
    project_id: projectFixture.id,
    pipeline_id: WIRE_PIPELINE_ID,
    pipeline_revision_id: WIRE_REVISION_ID,
    revision_digest: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
    plan_digest: "sha256:2222222222222222222222222222222222222222222222222222222222222222",
    status: "running",
    depth: 0,
    triggered_by: meFixture.id,
    priority: 0,
    created_at: "2026-11-01T09:00:00Z",
    started_at: "2026-11-01T09:01:00Z",
    ...overrides,
  };
}

function chat(overrides: Partial<ConversationSummary> = {}): ConversationSummary {
  return {
    ...conversationFixture,
    project_id: projectFixture.id,
    control: conversationFixture.control,
    origin: "manual",
    run_link: null,
    ...overrides,
  };
}

describe("buildActivityRows", () => {
  it("merges runs and chats by last activity, newest first", () => {
    const rows = buildActivityRows(
      [
        run({ id: "01987c11-000a-7000-8000-abcdef012345", finished_at: "2026-11-01T10:00:00Z" }),
        run({
          id: "01987c11-000b-7000-8000-abcdef012345",
          status: "completed",
          finished_at: "2026-10-30T10:00:00Z",
        }),
      ],
      [chat({ id: "01987c11-000c-7000-8000-abcdef012345", updated_at: "2026-11-01T09:30:00Z" })],
    );
    expect(rows.map((row) => row.kind)).toEqual(["run", "chat", "run"]);
    expect(rows[0]?.run?.finished_at).toBe("2026-11-01T10:00:00Z");
  });
});

describe("runStepSegments", () => {
  it("returns null without real step data — the project run list has none", () => {
    expect(runStepSegments(run())).toBeNull();
    expect(runStepSegments(run({ steps: [] } as never))).toBeNull();
  });

  it("counts the served steps into segments, never inventing one", () => {
    const segments = runStepSegments(
      run({
        steps: [
          { state: "succeeded" },
          { state: "succeeded" },
          { state: "running" },
          { state: "pending" },
          { state: "pending" },
        ],
      } as never),
    );
    expect(segments).toEqual([
      { kind: "done", count: 2 },
      { kind: "running", count: 1 },
      { kind: "open", count: 2 },
    ]);
  });
});

describe("AssistantNotes", () => {
  it("renders nothing at all without notes — no placeholder, no rule", () => {
    const { container } = render(<AssistantNotes notes={[]} />);
    expect(container.innerHTML).toBe("");
    expect(screen.queryByTestId("repo-assistant-notes")).toBeNull();
  });

  it("renders up to three notes, each with its action and dismiss", () => {
    const onDismiss = vi.fn();
    const onAction = vi.fn();
    const notes = [1, 2, 3, 4].map((n) => ({
      id: `note-${n}`,
      text: `Note number ${n}.`,
      action: { label: "Start a fix chat", onSelect: onAction },
    }));
    render(<AssistantNotes notes={notes} onDismiss={onDismiss} />);
    expect(screen.getByTestId("repo-assistant-notes")).toBeTruthy();
    expect(screen.queryByTestId("repo-assistant-note-note-4")).toBeNull();
    expect(screen.getByTestId("repo-assistant-note-note-1").textContent).toContain(
      "Note number 1.",
    );
    fireEvent.click(screen.getByTestId("repo-assistant-note-note-1-action"));
    expect(onAction).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId("repo-assistant-note-note-2-dismiss"));
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onDismiss.mock.calls[0]?.[0]?.id).toBe("note-2");
  });
});
