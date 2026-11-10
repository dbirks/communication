/**
 * `api/assistant.ts` mutation invalidation (e2e-p789b): the change chip must
 * never wait for a remount. A confirmed turn, a plain post that edited a
 * draft, a single undo and an undo-all each refetch the conversation's
 * change log and every draft the turn touched (an open Studio draft).
 *
 * These tests render the real ChangeChip inside the same QueryClient the
 * mutations run in — "the chip counts up" is asserted on the rendered DOM,
 * not on the mutation's return value.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import ChangeChip from "../components/assistant/ChangeChip";
import { draftIdFromTargetRef, useAssistantChanges } from "./assistant";
import { usePostAssistantMessage, useUndoAssistantChange } from "./assistant";
import { useDraft } from "./pipelines";
import { queryKeys } from "./queries";

afterEach(cleanup);

const CONVERSATION_ID = "conv-1";
const MESSAGES_PATH = `/api/v1/assistant/conversations/${CONVERSATION_ID}/messages`;
const CHANGES_PATH = `/api/v1/assistant/conversations/${CONVERSATION_ID}/changes`;
const DRAFT_ID = "d-1";
const DRAFT_PATH = `/api/v1/drafts/${DRAFT_ID}`;
const UNDO_PATH = "/api/v1/assistant/changes/chg-1/undo";

const WIRE_CHANGE_OPEN = {
  id: "chg-1",
  kind: "draft_edit",
  target_ref: `draft:${DRAFT_ID}`,
  summary: "Edited the acceptance criteria.",
  undoable: true,
  undone_at: null,
  created_at: "2026-07-07T00:00:02Z",
};
const WIRE_CHANGE_UNDONE = { ...WIRE_CHANGE_OPEN, undone_at: "2026-07-07T00:01:00Z" };

const WIRE_CHANGE_ROW = {
  id: "m-chg",
  kind: "change",
  payload: {
    kind: "change",
    change_id: "chg-1",
    change_kind: "draft_edit",
    target_ref: `draft:${DRAFT_ID}`,
    summary: "Edited the acceptance criteria.",
    undoable: true,
  },
  created_at: "2026-07-07T00:00:02Z",
};

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

interface Counts {
  changes: number;
  draft: number;
}

/** A dynamic fetch stub: GETs answer from `changesBody`/`draftBody` closures
 * so the first and the invalidation-triggered calls can differ. */
function stubFetch(opts: {
  postMessages?: unknown;
  changesBody: (counts: Counts) => unknown;
  draftBody: (counts: Counts) => unknown;
  undoBody?: unknown;
}): { fetchMock: ReturnType<typeof vi.fn>; counts: Counts } {
  const counts: Counts = { changes: 0, draft: 0 };
  const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? (init?.body === undefined ? "GET" : "POST")).toUpperCase();
    if (method === "POST" && url === MESSAGES_PATH) {
      return json(opts.postMessages ?? { messages: [], next_cursor: null });
    }
    if (method === "GET" && url === CHANGES_PATH) {
      counts.changes += 1;
      return json(opts.changesBody(counts));
    }
    if (method === "GET" && url === DRAFT_PATH) {
      counts.draft += 1;
      return json(opts.draftBody(counts));
    }
    if (method === "POST" && url === UNDO_PATH) {
      return json(opts.undoBody ?? WIRE_CHANGE_UNDONE);
    }
    return json({ title: "no test stub", status: 404, detail: `${method} ${url}` }, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, counts };
}

function makeWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return wrapper;
}

describe("assistant mutation invalidation (e2e-p789b)", () => {
  it("a confirmed turn refetches the change log and the draft, and the chip counts up without remount", async () => {
    const { counts } = stubFetch({
      postMessages: {
        messages: [
          {
            id: "m-user",
            kind: "user",
            payload: { kind: "user", text: "Retry" },
            created_at: "2026-07-07T00:00:01Z",
          },
          {
            id: "m-asst",
            kind: "assistant",
            payload: {
              kind: "assistant",
              turn_id: null,
              answer_markdown: "Done.",
              links: [],
              tool_calls: [],
              degraded: null,
            },
            created_at: "2026-07-07T00:00:02Z",
          },
          WIRE_CHANGE_ROW,
        ],
        next_cursor: null,
      },
      changesBody: (c) => (c.changes === 1 ? { changes: [] } : { changes: [WIRE_CHANGE_OPEN] }),
      draftBody: (c) => ({ id: DRAFT_ID, pipeline_id: "pl-1", version: c.draft }),
    });
    const wrapper = makeWrapper();

    function ConfirmHarness() {
      const changes = useAssistantChanges(CONVERSATION_ID);
      const draft = useDraft(DRAFT_ID);
      const post = usePostAssistantMessage();
      return (
        <div>
          <ChangeChip
            changes={changes.data?.changes ?? []}
            onUndo={() => {}}
            onUndoAll={() => {}}
          />
          <button
            data-testid="confirm-btn"
            onClick={() =>
              void post.mutateAsync({
                conversationId: CONVERSATION_ID,
                body: { confirm: "msg-9" },
              })
            }
          >
            confirm
          </button>
          {/* The draft's cached version — an open Studio draft reads this. */}
          <span data-testid="draft-version">{draft.data ? JSON.stringify(draft.data) : ""}</span>
        </div>
      );
    }

    render(<ConfirmHarness />, { wrapper });
    // 0 changes: the chip renders nothing at all. Wait for the initial load
    // so the click's invalidation is not racing the first fetch.
    await waitFor(() => expect(counts.changes).toBe(1));
    expect(screen.queryByTestId("assistant-change-chip")).toBeNull();

    fireEvent.click(screen.getByTestId("confirm-btn"));
    // The chip appears, without a remount: one change, from the refetch.
    await waitFor(() =>
      expect(screen.getByTestId("assistant-change-chip-toggle").textContent).toContain("1 change"),
    );
    // Exactly one extra round trip per touched query: the initial load, then
    // the invalidation. No polling, no refetch storm.
    expect(counts.changes).toBe(2);
    expect(counts.draft).toBe(2);
  });

  it("a single undo refetches the change log and the touched draft, and the chip shows the row undone", async () => {
    const { counts } = stubFetch({
      changesBody: (c) =>
        c.changes === 1 ? { changes: [WIRE_CHANGE_OPEN] } : { changes: [WIRE_CHANGE_UNDONE] },
      draftBody: (c) => ({ id: DRAFT_ID, pipeline_id: "pl-1", version: c.draft }),
    });
    const wrapper = makeWrapper();

    function UndoHarness() {
      const changes = useAssistantChanges(CONVERSATION_ID);
      const draft = useDraft(DRAFT_ID);
      const undo = useUndoAssistantChange();
      return (
        <div>
          <ChangeChip
            changes={changes.data?.changes ?? []}
            onUndo={(changeId) => undo.mutate(changeId)}
            onUndoAll={() => {}}
            defaultOpen
          />
          <span data-testid="draft-version">{draft.data ? JSON.stringify(draft.data) : ""}</span>
        </div>
      );
    }

    render(<UndoHarness />, { wrapper });
    await waitFor(() => expect(screen.getByTestId("assistant-change-undo")).toBeTruthy());

    fireEvent.click(screen.getByTestId("assistant-change-undo"));
    // The row flips to "✓ undone" from the refetch — not from the POST body
    // being spliced in by hand.
    await waitFor(() => expect(screen.getByTestId("assistant-change-undone")).toBeTruthy());
    expect(counts.changes).toBe(2);
    expect(counts.draft).toBe(2);
  });

  it("draftIdFromTargetRef names the draft a change wrote, and nothing else", () => {
    expect(draftIdFromTargetRef(`draft:${DRAFT_ID}`)).toBe(DRAFT_ID);
    expect(draftIdFromTargetRef("run:r-1")).toBeNull();
    expect(draftIdFromTargetRef("pipeline:p-1")).toBeNull();
    expect(draftIdFromTargetRef("draft:")).toBeNull();
    expect(draftIdFromTargetRef(null)).toBeNull();
    expect(draftIdFromTargetRef(undefined)).toBeNull();
  });
});

/** One `change` transcript row of the given kind, as the server writes it. */
function changeRow(kind: string, targetRef: string) {
  return {
    id: `m-${kind}`,
    kind: "change",
    payload: {
      kind: "change",
      change_id: `chg-${kind}`,
      change_kind: kind,
      target_ref: targetRef,
      summary: "Created the project Beluga.",
      undoable: false,
    },
    created_at: "2026-07-07T00:00:02Z",
  };
}

/**
 * Render a post against the real mutation and answer the POST with
 * `messages`, then hand back the query keys the success path invalidated.
 * Handoff §6 step 4 is about what OTHER caches forget after a turn, so the
 * assertion belongs on `invalidateQueries`, not on the rendered DOM.
 */
async function invalidatedKeys(messages: unknown[], body: Record<string, unknown> = {}) {
  stubFetch({
    postMessages: { messages, next_cursor: null },
    changesBody: () => ({ changes: [] }),
    draftBody: () => ({ id: DRAFT_ID, pipeline_id: "pl-1", version: 1 }),
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const spy = vi.spyOn(queryClient, "invalidateQueries");
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );

  // `mutateAsync` settles AFTER the mutation's onSuccess handlers run, so
  // awaiting it means every key the success path invalidated is recorded.
  let settled: Promise<unknown> = Promise.resolve();
  function PostHarness() {
    const post = usePostAssistantMessage();
    return (
      <button
        data-testid="post-btn"
        onClick={() => {
          settled = post
            .mutateAsync({ conversationId: CONVERSATION_ID, body })
            .catch(() => undefined);
        }}
      >
        post
      </button>
    );
  }

  render(<PostHarness />, { wrapper });
  fireEvent.click(screen.getByTestId("post-btn"));
  await settled;
  return spy.mock.calls
    .map((args) => (args[0] as { queryKey?: readonly unknown[] })?.queryKey)
    .filter((key): key is readonly unknown[] => Array.isArray(key));
}

describe("assistant mutation refreshes the sidebar (handoff §6 step 4)", () => {
  it("a turn carrying a project_create change invalidates the projects list", async () => {
    const keys = await invalidatedKeys([changeRow("project_create", "project:p-new")]);
    expect(keys).toContainEqual(queryKeys.projectList);
    // The new project's own subtree (repos, assignments, runs) too — its
    // `target_ref` names the project directly.
    expect(keys).toContainEqual(queryKeys.project("p-new"));
  });

  it("a repo_add change refreshes the project the turn was asked on", async () => {
    const keys = await invalidatedKeys([changeRow("repo_add", "repo:r-9")], {
      text: "connect the repo",
      context: { route: "/p/p-7", project_id: "p-7" },
    });
    expect(keys).toContainEqual(queryKeys.projectList);
    expect(keys).toContainEqual(queryKeys.project("p-7"));
  });

  it("a run_cancel change refreshes the run the change names", async () => {
    const keys = await invalidatedKeys([changeRow("run_cancel", "run:r-3")]);
    expect(keys).toContainEqual(queryKeys.projectList);
    expect(keys).toContainEqual(queryKeys.run("r-3"));
  });

  it("a draft-only turn touches the draft and leaves the project list alone", async () => {
    const keys = await invalidatedKeys([changeRow("draft_edit", `draft:${DRAFT_ID}`)]);
    expect(keys).toContainEqual(queryKeys.draft(DRAFT_ID));
    expect(keys).not.toContainEqual(queryKeys.projectList);
  });
});
