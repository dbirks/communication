/**
 * ASSISTANT NOTICED wired to the real store (ADR-0071) on the repository page:
 * the panel draws the served notes, each action performs its own kind, and a
 * dismissal is gone on the click.
 *
 * What this does not test is the notes' content — the generator's rules (the
 * DATA block, the allowlist, the cap) are proven server-side. What it pins is
 * the client half of the same promise: a note is model output, so every action
 * it offers lands on a route this app already owns, and nothing a note says
 * starts a run, sends a chat or writes a workflow by itself.
 */
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderApp } from "../test/render";
import { meFixture, projectFixture, requestsTo, type RouteStub } from "../test/fakes";
import {
  ASSISTANT_OPEN_EVENT,
  type AssistantOpenRequest,
} from "../components/assistant/AssistantPopover";
import type { AssistantNoteList } from "../api/notes";
import type { GitHubIssue } from "../api/issues";
import type { Assignment, PipelineRevision, Repository } from "../api/types";
import {
  WIRE_REVISION_ID,
  wireAssignmentList,
  wirePipelineList,
  wireRevision,
} from "../test/fixtures/m4/wire";

const repositoryId = "01987a6f-7a8b-7c9d-a0e1-f2b3c4d5e6f0";
const conversationId = "01987a6f-7a8b-7c9d-a0e1-f2b3c4d5e6aa";
const runId = "01987a6f-7a8b-7c9d-a0e1-f2b3c4d5e6bb";
const notesPath = `/api/v1/projects/${projectFixture.id}/repos/${repositoryId}/notes`;
const repoPath = `/api/v1/projects/${projectFixture.id}/repos/${repositoryId}`;

const repository: Repository = {
  id: repositoryId,
  project_id: projectFixture.id,
  name: "communication",
  git_url: "https://github.com/example/communication.git",
  default_branch: "main",
  created_at: "2026-10-14T18:00:00Z",
  credential: "none",
};

const issue: GitHubIssue = {
  number: 512,
  title: "The build is red",
  body: "CI fails on main.",
  labels: [],
  html_url: "https://github.com/example/communication/issues/512",
  state: "open",
  updated_at: "2026-10-14T18:00:00Z",
  body_truncated: false,
};

/** This repository's own pin (ADR-0060), on a revision that declares a
 * required `github_issue` input — the only shape that can carry a `hand_off`
 * note's issue in (ADR-0066). */
const repoAssignment: Assignment = {
  ...wireAssignmentList.assignments[0],
  repository_id: repositoryId,
  repository_name: repository.name,
};

const issueAcceptingRevision: PipelineRevision = {
  ...wireRevision,
  input_specs: [
    { name: "issue", type: "github_issue", required: true },
    { name: "branch", type: "branch", required: false, default: "main" },
  ],
};

/** The notes as the store serves them: newest first, three at the most. */
function notesList(body: AssistantNoteList["notes"]): AssistantNoteList {
  return { notes: body };
}

function servedNote(id: string, action?: AssistantNoteList["notes"][number]["action"]) {
  return {
    id,
    project_id: projectFixture.id,
    scope_kind: "repository" as const,
    scope_id: repositoryId,
    text: `Two runs failed at review since lunch (${id}).`,
    created_at: "2026-11-02T10:00:00Z",
    ...(action ? { action } : {}),
  };
}

function feedRoutes(notes: AssistantNoteList | null, overrides: RouteStub[] = []): RouteStub[] {
  const projectPath = `/api/v1/projects/${projectFixture.id}`;
  const base: RouteStub[] = [
    { path: "/api/v1/me", body: meFixture },
    { path: "/api/v1/projects", body: { items: [projectFixture] } },
    { path: "/api/v1/agent-profiles", body: { items: [] } },
    { path: projectPath, body: projectFixture },
    { path: `${projectPath}/repos`, body: { items: [repository] } },
    { path: `${projectPath}/secrets`, body: { secrets: [] } },
    { path: `${projectPath}/runs`, body: { runs: [] } },
    { method: "GET", path: `${projectPath}/conversations`, body: { items: [] } },
    {
      path: `${projectPath}/assignments`,
      body: { assignments: [repoAssignment] },
    },
    {
      path: `/api/v1/revisions/${repoAssignment.pinned_revision_digest}`,
      body: issueAcceptingRevision,
    },
    { path: `/api/v1/revisions/${WIRE_REVISION_ID}`, body: issueAcceptingRevision },
    { path: `${projectPath}/schedules`, body: { schedules: [] } },
    { path: `${projectPath}/issue-triggers`, body: { issue_triggers: [] } },
    { path: `${projectPath}/approvals`, body: { approvals: [] } },
    { path: "/api/v1/pipelines", body: wirePipelineList },
    {
      path: `${repoPath}/issues`,
      body: { repository: "example/communication", state: "open", items: [issue] },
    },
    // The honest default: the notes read answers an empty panel, so a test
    // only sees notes when it stubs them on purpose.
    { path: notesPath, body: notes ?? { notes: [] } },
  ];
  return [...overrides, ...base];
}

function renderFeed(notes: AssistantNoteList | null, overrides: RouteStub[] = []) {
  return renderApp({
    path: `/p/${projectFixture.id}/communication`,
    routes: feedRoutes(notes, overrides),
  });
}

describe("ASSISTANT NOTICED on the repository page", () => {
  it("keeps the ASSISTANT NOTICED heading with its honest empty line while the store holds nothing", async () => {
    renderFeed(null);
    await waitFor(() => expect(screen.getByTestId("repo-chat-box")).toBeTruthy());
    // rcn-review13 item 3: the section is the reader's contract, not the
    // notes' — an empty store shows the heading and one muted line, never
    // a placeholder note and never a missing section.
    const panel = screen.getByTestId("repo-assistant-notes");
    expect(panel.textContent).toContain("ASSISTANT NOTICED");
    expect(screen.getByTestId("repo-assistant-notes-empty").textContent).toContain(
      "Nothing noticed yet",
    );
    expect(panel.querySelector("[data-testid^='repo-assistant-note-'")).toBeNull();
  });

  it("sits at the BOTTOM of the side panel — under WORKFLOWS and OPEN ISSUES (design 3a)", async () => {
    renderFeed(null);
    const notes = await screen.findByTestId("repo-assistant-notes");
    // The panel's order is the design's: WORKFLOWS, then OPEN ISSUES, then
    // the ASSISTANT NOTICED block (rcn-review14, item 3 — it led the panel
    // for three rounds).
    const workflows = screen.getByTestId("repo-workflows");
    const issues = screen.getByTestId("repo-issues");
    expect(
      workflows.compareDocumentPosition(notes) & Node.DOCUMENT_POSITION_FOLLOWING,
      "ASSISTANT NOTICED follows the WORKFLOWS panel",
    ).toBeTruthy();
    expect(
      issues.compareDocumentPosition(notes) & Node.DOCUMENT_POSITION_FOLLOWING,
      "ASSISTANT NOTICED follows the OPEN ISSUES panel",
    ).toBeTruthy();
  });

  it("draws the notes the store served, newest first, with the store's own labels", async () => {
    renderFeed(
      notesList([
        servedNote("n-1", { kind: "open_run", run_id: runId }),
        servedNote("n-2"),
        servedNote("n-3", { kind: "start_chat", prompt: "why is review red?" }),
        servedNote("n-4"),
      ]),
    );
    const panel = await screen.findByTestId("repo-assistant-notes");
    expect(panel.textContent).toContain("Two runs failed at review since lunch (n-1).");
    expect(screen.getByTestId("repo-assistant-notes-count").textContent).toBe("3");
    expect(screen.queryByTestId("repo-assistant-note-n-4")).toBeNull();
    expect(screen.getByTestId("repo-assistant-note-n-1-action").textContent).toBe("Open the run");
    // A note with no action says its sentence and offers nothing.
    expect(screen.queryByTestId("repo-assistant-note-n-2-action")).toBeNull();
  });

  it("open_run navigates to the run the note names", async () => {
    const h = renderFeed(notesList([servedNote("n-1", { kind: "open_run", run_id: runId })]));
    fireEvent.click(await screen.findByTestId("repo-assistant-note-n-1-action"));
    await waitFor(() =>
      expect(requestsTo(h.requests, `/api/v1/runs/${runId}`).length).toBeGreaterThan(0),
    );
    expect(screen.queryByTestId("repo-assistant-notes")).toBeNull();
  });

  it("start_chat fills the repository's chat box and sends nothing itself", async () => {
    const h = renderFeed(
      notesList([servedNote("n-1", { kind: "start_chat", prompt: "why is review red?" })]),
    );
    await screen.findByTestId("repo-assistant-notes");
    fireEvent.click(screen.getByTestId("repo-assistant-note-n-1-action"));
    const input = screen.getByTestId("repo-chat-input") as HTMLInputElement;
    expect(input.value).toBe("why is review red?");
    // A model writing a prompt has not been allowed to send one: the thread
    // POST is the person's click on `Start`, and there has been none.
    expect(
      requestsTo(h.requests, `/api/v1/projects/${projectFixture.id}/conversations`, "POST"),
    ).toHaveLength(0);
  });

  it("hand_off opens the run form with the issue the note named", async () => {
    renderFeed(notesList([servedNote("n-9", { kind: "hand_off", issue_numbers: [512] })]));
    fireEvent.click(await screen.findByTestId("repo-assistant-note-n-9-action"));
    const form = await screen.findByTestId("repo-run-form");
    expect(form.textContent).toContain("Start a run");
    // The note named issue 512 and nothing else — no title, no url. What the
    // form carries is its own `github_issue` input picked from the issue list
    // this page read, which is the design's 1k prefill (ADR-0066).
    await waitFor(() =>
      expect((screen.getByTestId("new-run-input-issue") as HTMLInputElement).value).toBe("#512"),
    );
    // The note's own words never reach the form: model text is a sentence in
    // the panel, not an input value.
    expect(form.textContent).not.toContain("Two runs failed at review");
  });

  it("make_workflow opens the assistant on the chat the note named", async () => {
    const seen: Event[] = [];
    const listener = (event: Event) => seen.push(event);
    window.addEventListener(ASSISTANT_OPEN_EVENT, listener);
    try {
      renderFeed(
        notesList([servedNote("n-7", { kind: "make_workflow", conversation_id: conversationId })]),
      );
      fireEvent.click(await screen.findByTestId("repo-assistant-note-n-7-action"));
    } finally {
      window.removeEventListener(ASSISTANT_OPEN_EVENT, listener);
    }
    expect(seen).toHaveLength(1);
    // 2f review: the chat id rides the open request as structured context
    // (an `AssistantOpenRequest`), never as visible prose in the ask.
    const ask = (seen[0] as CustomEvent<AssistantOpenRequest>).detail;
    expect(ask.entity).toEqual({ kind: "conversation", id: conversationId });
  });

  it("an action this build cannot perform renders no button", async () => {
    // The server's allowlist is the writer's guarantee; the client's own rule
    // is that a kind it does not know becomes nothing.
    renderFeed(
      notesList([
        servedNote("n-5", {
          kind: "delete_repository",
        } as unknown as AssistantNoteList["notes"][number]["action"]),
      ]),
    );
    await screen.findByTestId("repo-assistant-note-n-5");
    expect(screen.queryByTestId("repo-assistant-note-n-5-action")).toBeNull();
    expect(screen.getByTestId("repo-assistant-note-n-5").textContent).toContain(
      "Two runs failed at review since lunch (n-5).",
    );
  });

  it("dismiss hides the note on the click and asks the server once", async () => {
    const h = renderFeed(notesList([servedNote("n-1"), servedNote("n-2")]), [
      { method: "POST", path: `/api/v1/notes/n-1/dismiss`, status: 204 },
      // The server has dismissed it now: the re-read after the 204 answers
      // without the row, which is what keeps the optimistic hide honest.
      {
        path: notesPath,
        body: (call: number) =>
          call === 1
            ? notesList([servedNote("n-1"), servedNote("n-2")])
            : notesList([servedNote("n-2")]),
      },
    ]);
    await screen.findByTestId("repo-assistant-notes");
    fireEvent.click(screen.getByTestId("repo-assistant-note-n-1-dismiss"));
    // The row leaves the cache in the dismissal's own `onMutate`, before the
    // request is answered (proven in api/notes.test.tsx); the panel follows on
    // the render that does, never on a later poll.
    await waitFor(() => expect(screen.queryByTestId("repo-assistant-note-n-1")).toBeNull());
    expect(screen.getByTestId("repo-assistant-note-n-2")).toBeTruthy();
    await waitFor(() =>
      expect(requestsTo(h.requests, "/api/v1/notes/n-1/dismiss", "POST")).toHaveLength(1),
    );
    // And it stays gone after the re-read the 204 triggers: the hide was an
    // honest preview, not a flicker the next fetch undoes.
    await waitFor(() => expect(screen.queryByTestId("repo-assistant-note-n-1")).toBeNull());
  });

  it("a page whose notes read failed is the page without notes", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      renderFeed(null, [{ path: notesPath, status: 500, body: { title: "boom" } }]);
      await waitFor(() => expect(screen.getByTestId("repo-chat-box")).toBeTruthy());
    } finally {
      spy.mockRestore();
    }
    expect(screen.getByTestId("repo-assistant-notes-empty").textContent).toContain(
      "Nothing noticed yet",
    );
  });
});
