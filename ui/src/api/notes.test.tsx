/**
 * The assistant-notes client (ADR-0071): the two reads, the one write, and the
 * rules the panels rest on — a note is capped at three, an action the build
 * does not know renders nothing, and a dismissal is this user's row only,
 * applied to the cache on the click rather than on the answer.
 *
 * The notes' honesty (who may see them, what may be written) is the server's,
 * proven in internal/api/assistant_notes_test.go and the real-PostgreSQL store
 * tests; this file is only about what the browser puts on the wire and what it
 * draws from the bytes that come back.
 */
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it } from "vitest";
import type { ReactNode } from "react";
import { setCsrfToken } from "./client";
import {
  ASSISTANT_NOTES_CAP,
  chatPromptFor,
  conversationNotesKey,
  handOffIssueNumbers,
  noteActionKind,
  noteActionLabel,
  notesKeyFor,
  repoNotesKey,
  runIdFor,
  useConversationAssistantNotes,
  useDismissAssistantNote,
  useRepoAssistantNotes,
  visibleAssistantNotes,
  workflowConversationIdFor,
  type AssistantNote,
  type AssistantNoteAction,
} from "./notes";
import { mockFetch, requestsTo, type RouteStub } from "../test/fakes";

afterEach(cleanup);

const PROJECT_ID = "01987a6c-4d5e-7f1a-9b2c-3d4e5f6a7b80";
const REPO_ID = "01987a6c-4d5e-7f1a-9b2c-3d4e5f6a7b81";
const CONVERSATION_ID = "01987a6c-4d5e-7f1a-9b2c-3d4e5f6a7b82";
const NOTES_PATH = `/api/v1/projects/${PROJECT_ID}/repos/${REPO_ID}/notes`;
const CHAT_NOTES_PATH = `/api/v1/conversations/${CONVERSATION_ID}/notes`;
const DISMISS_PATH = "/api/v1/notes/note-1/dismiss";

function note(id: string, over: Partial<AssistantNote> = {}): AssistantNote {
  return {
    id,
    project_id: PROJECT_ID,
    scope_kind: "repository",
    scope_id: REPO_ID,
    text: `Note ${id}`,
    created_at: "2026-11-02T10:00:00Z",
    ...over,
  };
}

function harness(routes: RouteStub[], gcTime = 0) {
  setCsrfToken("csrf-token-for-notes");
  const { fetchMock, requests } = mockFetch(routes);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { fetchMock, requests, queryClient, wrapper };
}

describe("the notes reads", () => {
  it("asks the repository route and keys the answer under the project", async () => {
    const h = harness([{ path: NOTES_PATH, body: { notes: [note("n-1"), note("n-2")] } }]);
    const { result } = renderHook(() => useRepoAssistantNotes(PROJECT_ID, REPO_ID), {
      wrapper: h.wrapper,
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.notes.map((row) => row.id)).toEqual(["n-1", "n-2"]);
    expect(requestsTo(h.requests, NOTES_PATH)).toHaveLength(1);
    expect(h.queryClient.getQueryData(repoNotesKey(PROJECT_ID, REPO_ID))).toBeTruthy();
  });

  it("asks the thread route, which names no project", async () => {
    const h = harness([
      {
        path: CHAT_NOTES_PATH,
        body: { notes: [note("c-1", { scope_kind: "conversation", scope_id: CONVERSATION_ID })] },
      },
    ]);
    const { result } = renderHook(() => useConversationAssistantNotes(CONVERSATION_ID), {
      wrapper: h.wrapper,
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(requestsTo(h.requests, CHAT_NOTES_PATH)).toHaveLength(1);
    expect(h.queryClient.getQueryData(conversationNotesKey(CONVERSATION_ID))).toBeTruthy();
  });

  it("never asks before there is a scope to ask about", () => {
    const h = harness([{ path: NOTES_PATH, body: { notes: [] } }]);
    const { result } = renderHook(() => useRepoAssistantNotes(PROJECT_ID, ""), {
      wrapper: h.wrapper,
    });
    expect(result.current.isPending).toBe(true);
    expect(requestsTo(h.requests, NOTES_PATH)).toHaveLength(0);
  });

  it("a refused read is the panel's silence, not a retry storm", async () => {
    const h = harness([
      { path: NOTES_PATH, status: 404, body: { type: "x", title: "No such scope" } },
    ]);
    const { result } = renderHook(() => useRepoAssistantNotes(PROJECT_ID, REPO_ID), {
      wrapper: h.wrapper,
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(requestsTo(h.requests, NOTES_PATH)).toHaveLength(1);
  });
});

describe("useDismissAssistantNote", () => {
  it("posts to the dismiss route with the CSRF header and no body", async () => {
    const h = harness([{ method: "POST", path: DISMISS_PATH, status: 204 }]);
    const { result } = renderHook(() => useDismissAssistantNote(), { wrapper: h.wrapper });
    h.queryClient.setQueryData(repoNotesKey(PROJECT_ID, REPO_ID), { notes: [note("note-1")] });
    result.current.mutate(note("note-1"));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const [call] = requestsTo(h.requests, DISMISS_PATH, "POST");
    expect(call).toBeTruthy();
    expect(call.headers.get("x-csrf-token")).toBe("csrf-token-for-notes");
    expect(call.body).toBeUndefined();
  });

  it("hides the note on the click, before the answer", async () => {
    const h = harness([{ method: "POST", path: DISMISS_PATH, status: 204 }]);
    const { result } = renderHook(() => useDismissAssistantNote(), { wrapper: h.wrapper });
    const key = repoNotesKey(PROJECT_ID, REPO_ID);
    h.queryClient.setQueryData(key, { notes: [note("note-1"), note("note-2")] });
    result.current.mutate(note("note-1"));
    // The cache is already down to the one note the person did not dismiss.
    expect(
      (h.queryClient.getQueryData<{ notes: AssistantNote[] }>(key)?.notes ?? []).map((n) => n.id),
    ).toEqual(["note-2"]);
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
  });

  it("a failed dismissal puts the row back rather than losing it quietly", async () => {
    // gcTime is the cache's own default here: a rolled-back row must still be
    // in the cache when the panel reads it again, not an artefact of a
    // zero-timeout cache having dropped it.
    const h = harness(
      [{ method: "POST", path: DISMISS_PATH, status: 500, body: { title: "boom" } }],
      30_000,
    );
    const { result } = renderHook(() => useDismissAssistantNote(), { wrapper: h.wrapper });
    const key = repoNotesKey(PROJECT_ID, REPO_ID);
    h.queryClient.setQueryData(key, { notes: [note("note-1")] });
    result.current.mutate(note("note-1"));
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(
      (h.queryClient.getQueryData<{ notes: AssistantNote[] }>(key)?.notes ?? []).map((n) => n.id),
    ).toEqual(["note-1"]);
  });

  it("a dismissal that 404s reconciles with the server rather than resurrecting the row", async () => {
    // A 404 says the row is no longer this reader's to dismiss — already
    // dismissed, expired, or replaced by the generator's cap (acceptance
    // 42339622074 pass-2). The store serves it no more, so putting it back
    // on the panel would draw a row the next read contradicts; the row
    // stays off and the list is re-read instead. (v565 pass-2's product
    // fix makes this path rare; the UI behavior is still the honest one.)
    const h = harness(
      [
        {
          method: "POST",
          path: DISMISS_PATH,
          status: 404,
          body: { type: "x", title: "Not Found", status: 404 },
        },
      ],
      30_000,
    );
    const { result } = renderHook(() => useDismissAssistantNote(), { wrapper: h.wrapper });
    const key = repoNotesKey(PROJECT_ID, REPO_ID);
    h.queryClient.setQueryData(key, { notes: [note("note-1"), note("note-2")] });
    result.current.mutate(note("note-1"));
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(
      (h.queryClient.getQueryData<{ notes: AssistantNote[] }>(key)?.notes ?? []).map((n) => n.id),
    ).toEqual(["note-2"]);
  });

  it("a conversation note is removed from the conversation's own cache", async () => {
    const h = harness([{ method: "POST", path: DISMISS_PATH, status: 204 }]);
    const { result } = renderHook(() => useDismissAssistantNote(), { wrapper: h.wrapper });
    const chatNote = note("note-1", {
      scope_kind: "conversation",
      scope_id: CONVERSATION_ID,
      project_id: PROJECT_ID,
    });
    h.queryClient.setQueryData(conversationNotesKey(CONVERSATION_ID), { notes: [chatNote] });
    result.current.mutate(chatNote);
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(
      (
        h.queryClient.getQueryData<{ notes: AssistantNote[] }>(
          conversationNotesKey(CONVERSATION_ID),
        )?.notes ?? []
      ).map((n) => n.id),
    ).toEqual([]);
  });
});

describe("the notes' client-side rules", () => {
  it("draws three notes, never a fourth", () => {
    const rows = [1, 2, 3, 4, 5].map((i) => note(`n-${i}`));
    expect(visibleAssistantNotes(rows)).toHaveLength(ASSISTANT_NOTES_CAP);
    expect(visibleAssistantNotes(rows)[0].id).toBe("n-1");
    expect(visibleAssistantNotes(undefined)).toEqual([]);
  });

  it("names a known kind and refuses an unknown one", () => {
    // Unknown kinds are built through `unknown` on purpose: the point is a
    // wire value this build's types cannot name, which is exactly what a
    // server that grows the union later sends.
    const action = (over: Record<string, unknown>): AssistantNoteAction =>
      ({ kind: "start_chat", ...over }) as unknown as AssistantNoteAction;
    expect(noteActionKind(action({ kind: "hand_off", issue_numbers: [4] }))).toBe("hand_off");
    expect(noteActionKind(action({ kind: "open_any_url" }))).toBeNull();
    expect(noteActionKind(undefined)).toBeNull();
    expect(noteActionLabel(action({ kind: "open_run", run_id: "r-1" }))).toBe("Open the run");
    expect(noteActionLabel(action({ kind: "open_any_url" }))).toBeNull();
  });

  it("reads only the payload its kind owns", () => {
    const action = (over: Record<string, unknown>): AssistantNoteAction =>
      ({ kind: "start_chat", ...over }) as unknown as AssistantNoteAction;
    const handOff = action({ kind: "hand_off", issue_numbers: [7, 0, -3, 12] });
    expect(handOffIssueNumbers(handOff)).toEqual([7, 12]);
    // A prompt on a hand_off is another kind's member: the client ignores it.
    expect(chatPromptFor(handOff)).toBe("");
    expect(chatPromptFor(action({ kind: "start_chat", prompt: "why is it red?" }))).toBe(
      "why is it red?",
    );
    expect(runIdFor(action({ kind: "open_run", run_id: "run-9" }))).toBe("run-9");
    expect(runIdFor(action({ kind: "make_workflow", conversation_id: CONVERSATION_ID }))).toBe("");
    expect(workflowConversationIdFor(action({ kind: "start_chat", prompt: "x" }))).toBe("");
    expect(
      workflowConversationIdFor(
        action({ kind: "make_workflow", conversation_id: CONVERSATION_ID }),
      ),
    ).toBe(CONVERSATION_ID);
  });

  it("keys a note by the scope it carries, not by where it was read", () => {
    expect(notesKeyFor(note("n-1"))).toEqual(repoNotesKey(PROJECT_ID, REPO_ID));
    expect(
      notesKeyFor(note("c-1", { scope_kind: "conversation", scope_id: CONVERSATION_ID })),
    ).toEqual(conversationNotesKey(CONVERSATION_ID));
  });
});
