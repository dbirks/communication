/**
 * The shared "New conversation" dialog (`components/NewConversationDialog.tsx`).
 *
 * It is driven here through the project page's header button, which opens it
 * with the project fixed — the other opener (the shell's New menu, with the
 * project picker) is covered by `NewMenu.test.tsx`. The API is mocked at the
 * fetch boundary, so the submit assertion is on the actual POST body and the
 * navigation is on the conversation page appearing.
 */
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderApp } from "../test/render";
import {
  claudeProfile,
  codexProfile,
  conversationFixture,
  conversationId,
  meFixture,
  projectFixture,
  requestsTo,
  type RouteStub,
} from "../test/fakes";
import { wirePipelineList } from "../test/fixtures/m4/wire";
import type { Project } from "../api/types";

const projectId = projectFixture.id;
const projectPath = `/api/v1/projects/${projectId}`;
const conversationsPath = `${projectPath}/conversations`;
const conversationPath = `/api/v1/conversations/${conversationId}`;

/** Wait budget for one real async boundary (a fake-fetch round trip); the
 *  default 1 s `findBy*` timeout measures the runner, not the page. */
const READ_MS = 5_000;

function routes(extra: RouteStub[] = []): RouteStub[] {
  // `extra` first so the POST stub shadows the list GET.
  return [
    ...extra,
    { path: "/api/v1/me", body: meFixture },
    { path: projectPath, method: "GET", body: projectFixture },
    { path: `${projectPath}/repos`, method: "GET", body: { items: [] } },
    { path: `${projectPath}/members`, method: "GET", body: { items: [] } },
    { path: "/api/v1/users", method: "GET", body: { items: [] } },
    { path: `${projectPath}/approvals`, method: "GET", body: { approvals: [] } },
    { path: `${projectPath}/runs`, method: "GET", body: { runs: [] } },
    { path: conversationsPath, method: "GET", body: { items: [] } },
    { path: "/api/v1/agent-profiles", body: { items: [claudeProfile, codexProfile] } },
    { path: "/api/v1/pipelines", method: "GET", body: wirePipelineList },
    { path: conversationPath, method: "GET", body: conversationFixture },
  ];
}

/** The dialog as the project header opens it: project fixed to `projectFixture`. */
async function openDialog() {
  await screen.findByTestId("project-new-conversation", undefined, { timeout: READ_MS });
  fireEvent.click(screen.getByTestId("project-new-conversation"));
  return screen.findByTestId("new-conversation-dialog", undefined, { timeout: READ_MS });
}

describe("NewConversationDialog (project page opener)", () => {
  it("shows as an accessible modal with the project fixed", async () => {
    renderApp({ path: `/projects/${projectId}`, routes: routes() });
    const dialog = await openDialog();

    expect(dialog.getAttribute("role")).toBe("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(screen.getByRole("heading", { name: "New thread" })).not.toBeNull();
    // The one-line explainer under the title.
    expect(
      screen.getByText(
        "A one-off thread with an agent in a project workspace — no workflow needed.",
      ),
    ).not.toBeNull();

    // Project fixed: the name renders, and there is no project select.
    expect(screen.getByTestId("new-conversation-dialog-project").textContent).toBe(
      projectFixture.name,
    );
    expect(screen.queryByRole("combobox", { name: /project/i })).toBeNull();

    // Focus is trapped on the first field.
    expect(document.activeElement).toBe(screen.getByTestId("conversation-new-title"));
  });

  it("posts the chosen fields to the fixed project and navigates to the conversation", async () => {
    const { requests } = renderApp({
      path: `/projects/${projectId}`,
      routes: routes([{ path: conversationsPath, method: "POST", body: conversationFixture }]),
    });
    await openDialog();

    fireEvent.change(screen.getByTestId("conversation-new-title"), {
      target: { value: "Investigate the flake" },
    });
    fireEvent.change(screen.getByTestId("conversation-new-profile"), {
      target: { value: claudeProfile.id },
    });
    fireEvent.change(screen.getByTestId("conversation-new-prompt"), {
      target: { value: "Read the repo and propose a plan." },
    });

    const submit = screen.getByTestId("conversation-new-submit") as HTMLButtonElement;
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);

    // (awaited: the mutation fetch is one async boundary behind the click)
    await waitFor(
      () => {
        const post = requestsTo(requests, conversationsPath, "POST");
        expect(post).toHaveLength(1);
        expect(JSON.parse(post[0].body ?? "{}")).toEqual({
          agent_profile_id: claudeProfile.id,
          title: "Investigate the flake",
          prompt: "Read the repo and propose a plan.",
        });
      },
      { timeout: READ_MS },
    );

    // Success navigates to `/projects/:pid/conversations/:id` and closes the dialog.
    await screen.findByTestId("conversation-main", undefined, { timeout: READ_MS });
    await waitFor(() => expect(screen.queryByTestId("new-conversation-dialog")).toBeNull());
    expect(screen.getByTestId("conversation-title").textContent).toBe(conversationFixture.title);
  });

  it("leaves the prompt out of the POST body when it is empty", async () => {
    const { requests } = renderApp({
      path: `/projects/${projectId}`,
      routes: routes([{ path: conversationsPath, method: "POST", body: conversationFixture }]),
    });
    await openDialog();

    fireEvent.change(screen.getByTestId("conversation-new-title"), {
      target: { value: "Quick question" },
    });
    fireEvent.change(screen.getByTestId("conversation-new-profile"), {
      target: { value: codexProfile.id },
    });
    fireEvent.click(screen.getByTestId("conversation-new-submit"));

    // (awaited: the mutation fetch is one async boundary behind the click)
    await waitFor(() => {
      const post = requestsTo(requests, conversationsPath, "POST");
      expect(post).toHaveLength(1);
      expect(JSON.parse(post[0].body ?? "{}")).toEqual({
        agent_profile_id: codexProfile.id,
        title: "Quick question",
      });
    });
  });

  it("closes on Escape and returns focus to the opener", async () => {
    renderApp({ path: `/projects/${projectId}`, routes: routes() });
    const opener = await screen.findByTestId("project-new-conversation", undefined, {
      timeout: READ_MS,
    });
    // A real click focuses the button (jsdom's synthetic one does not), so the
    // opener's focus is set explicitly before the dialog can take it.
    opener.focus();
    fireEvent.click(opener);
    await screen.findByTestId("new-conversation-dialog", undefined, { timeout: READ_MS });

    fireEvent.keyDown(screen.getByTestId("conversation-new-title"), { key: "Escape" });

    expect(screen.queryByTestId("new-conversation-dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("hides the opener entirely for viewer projects", async () => {
    const viewer: Project = { ...projectFixture, my_role: "viewer" };
    const { requests } = renderApp({
      path: `/projects/${projectId}`,
      routes: routes([{ path: projectPath, method: "GET", body: viewer }]),
    });
    // Design 1b took the thread list off the overview — its "only contributors
    // and maintainers can start conversations" line is asserted on the Threads
    // page (`pages/ProjectConversations.test.tsx`). The overview's own header
    // actions agree with it: neither verb is offered to a viewer.
    expect(await screen.findByTestId("project-name")).toBeTruthy();
    expect(screen.getByTestId("project-role-hint").textContent).toContain("read-only");
    expect(screen.queryByTestId("project-new-conversation")).toBeNull();
    expect(screen.queryByTestId("project-start-run")).toBeNull();
    // No dialog mount, and no extra reads: the project once, and the single
    // conversations read the tab count and the RECENT THREADS panel share.
    expect(requestsTo(requests, projectPath, "GET")).toHaveLength(1);
    expect(requestsTo(requests, conversationsPath, "GET")).toHaveLength(1);
  });
});
