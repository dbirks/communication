/**
 * The chat rail's ASSISTANT slot wired to the notes store (ADR-0071, design
 * 2e): the thread's own notes render in the rail, `Make a workflow…` opens the
 * assistant on the chat the note named, and a dismissal is this reader's only.
 *
 * The 2f standing note (the rail's own "Turn this chat into a workflow…")
 * shares the slot: the panel keeps one note surface per rail, so a real note
 * takes it — and the generator's `make_workflow` note is what replaces the
 * standing one, which is why the affordance is still exactly one click deep.
 */
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderApp } from "../test/render";
import {
  conversationFixture,
  conversationId,
  meFixture,
  projectFixture,
  requestsTo,
  type RouteStub,
} from "../test/fakes";
import { ASSISTANT_OPEN_EVENT } from "../components/assistant/AssistantPopover";
import type { AssistantNoteList } from "../api/notes";

const notesPath = `/api/v1/conversations/${conversationId}/notes`;
const path = `/p/${projectFixture.id}/conversations/${conversationId}`;

function chatNote(id: string, action?: AssistantNoteList["notes"][number]["action"]) {
  return {
    id,
    project_id: projectFixture.id,
    scope_kind: "conversation" as const,
    scope_id: conversationId,
    text: `Plan → implement → review. This reads like a workflow (${id}).`,
    created_at: "2026-11-02T10:00:00Z",
    ...(action ? { action } : {}),
  };
}

function renderThread(
  notes: unknown,
  extra: RouteStub[] = [],
): { requests: ReturnType<typeof renderApp>["requests"] } {
  const result = renderApp({
    path,
    routes: [
      ...extra,
      { path: notesPath, body: notes ?? { notes: [] } },
      { path: "/api/v1/me", body: meFixture },
      { path: "/api/v1/agent-profiles", body: { items: [] } },
      { path: `/api/v1/projects/${projectFixture.id}`, body: projectFixture },
      { path: "/api/v1/users", body: { items: [] } },
      { path: `/api/v1/conversations/${conversationId}`, body: conversationFixture },
      { path: `/api/v1/projects/${projectFixture.id}/artifacts`, body: { artifacts: [] } },
      { path: `/api/v1/projects/${projectFixture.id}/conversations`, body: { items: [] } },
    ],
  });
  return { requests: result.requests };
}

describe("assistant notes in the chat rail", () => {
  it("renders nothing in the rail while the store holds nothing", async () => {
    renderThread(null);
    await screen.findByTestId("conversation-side-panel");
    // Only the 2f standing note is in the slot: no store row, no sentence of
    // the reader's own, and no dismiss that would pretend otherwise.
    expect(screen.queryByText(/reads like a workflow \(/)).toBeNull();
    expect(screen.queryByTestId("assistant-note-c-1-dismiss")).toBeNull();
  });

  it("draws the thread's note with its own dismiss", async () => {
    const served = {
      notes: [chatNote("c-1", { kind: "make_workflow", conversation_id: conversationId })],
    };
    const h = renderThread(null, [
      { method: "POST", path: "/api/v1/notes/c-1/dismiss", status: 204 },
      // The re-read after the 204 answers without the row, so the instant hide
      // is an honest preview and not a flicker the next fetch undoes.
      { path: notesPath, body: (call: number) => (call === 1 ? served : { notes: [] }) },
    ]);
    const note = await screen.findByTestId("assistant-note-c-1");
    expect(note.textContent).toContain("This reads like a workflow (c-1).");
    expect(note.textContent).toContain("Make a workflow…");

    fireEvent.click(screen.getByTestId("assistant-note-c-1-dismiss"));
    await waitFor(() => expect(screen.queryByTestId("assistant-note-c-1")).toBeNull());
    await waitFor(() =>
      expect(requestsTo(h.requests, "/api/v1/notes/c-1/dismiss", "POST")).toHaveLength(1),
    );
  });

  it("Make a workflow… opens the assistant on the chat the note named", async () => {
    const seen: Event[] = [];
    const listener = (event: Event) => seen.push(event);
    window.addEventListener(ASSISTANT_OPEN_EVENT, listener);
    try {
      renderThread({
        notes: [chatNote("c-2", { kind: "make_workflow", conversation_id: conversationId })],
      });
      fireEvent.click(await screen.findByTestId("assistant-note-c-2-action-make_workflow"));
    } finally {
      window.removeEventListener(ASSISTANT_OPEN_EVENT, listener);
    }
    expect(seen).toHaveLength(1);
    const ask = (seen[0] as CustomEvent<string>).detail;
    expect(ask).toContain(conversationId);
    expect(ask).toContain(conversationFixture.title);
  });

  it("a note with no action is a sentence with no button", async () => {
    renderThread({ notes: [chatNote("c-3")] });
    const note = await screen.findByTestId("assistant-note-c-3");
    expect(note.textContent).toContain("Assistant");
    expect(note.querySelector("button[data-testid$='-action']")).toBeNull();
    // Dismissal is still real: the row exists and this user owns it.
    expect(screen.getByTestId("assistant-note-c-3-dismiss")).toBeTruthy();
  });

  it("with no notes the rail keeps the 2f standing note it always showed", async () => {
    renderThread(null);
    const standing = await screen.findByTestId("assistant-note-workflow");
    expect(standing.textContent).toContain(conversationFixture.title);
  });
});
