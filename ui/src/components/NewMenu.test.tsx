/**
 * The shell's "New" menu (`components/NewMenu.tsx`): the one entry point for
 * starting something — a one-off conversation (shared dialog with a project
 * picker), a new workflow (`/library`) or a run (started from a project).
 *
 * Menu semantics are asserted with the keyboard (arrow keys move, Escape
 * closes and returns focus to the trigger); navigation is asserted on the
 * destination page appearing, and the conversation pick is asserted on the
 * actual POST to the project the picker selected. The API is mocked at the
 * fetch boundary.
 */
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
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
const conversationsPath = `/api/v1/projects/${projectId}/conversations`;

/** Wait budget for one real async boundary (a fake-fetch round trip); the
 *  default 1 s `findBy*` timeout measures the runner, not the page. */
const READ_MS = 5_000;

/** A second project the picker could select, so the POST target proves the pick. */
const gears: Project = {
  id: "01987a80-1111-7000-8000-abcdef012345",
  slug: "gears",
  name: "Gears",
  description: "Gear incubator",
  created_at: "2026-10-14T18:00:00Z",
  version: 1,
  my_role: "contributor",
};
const gearsConversationsPath = `/api/v1/projects/${gears.id}/conversations`;

/** A project the caller may only read: the picker must exclude it. */
const viewerOnly: Project = {
  ...gears,
  id: "01987a80-2222-7000-8000-abcdef012345",
  my_role: "viewer",
};

function routes(extra: RouteStub[] = []): RouteStub[] {
  return [
    ...extra,
    { path: "/api/v1/me", body: meFixture },
    {
      path: "/api/v1/projects",
      method: "GET",
      body: { items: [projectFixture, gears, viewerOnly] },
    },
    { path: "/api/v1/users", method: "GET", body: { items: [] } },
    { path: "/api/v1/agent-profiles", body: { items: [claudeProfile, codexProfile] } },
    { path: "/api/v1/pipelines", method: "GET", body: wirePipelineList },
    { path: `/api/v1/projects/${gears.id}`, method: "GET", body: gears },
    { path: `/api/v1/conversations/${conversationId}`, method: "GET", body: conversationFixture },
  ];
}

async function openMenu() {
  await screen.findByTestId("new-menu");
  fireEvent.click(screen.getByTestId("new-menu"));
  return screen.findByTestId("new-menu-list", undefined, { timeout: READ_MS });
}

describe("NewMenu", () => {
  it("opens a menu with the three starters, focused on the first item", async () => {
    renderApp({ path: "/", routes: routes() });
    const menu = await openMenu();

    expect(menu.getAttribute("role")).toBe("menu");
    const items = screen.getAllByRole("menuitem");
    expect(items.map((item) => item.textContent)).toEqual([
      "New conversation",
      "New workflow",
      "Start run",
    ]);
    expect(document.activeElement).toBe(screen.getByTestId("new-menu-conversation"));
  });

  it("moves with the arrow keys and closes on Escape, returning focus to the trigger", async () => {
    renderApp({ path: "/", routes: routes() });
    await openMenu();

    const conversation = screen.getByTestId("new-menu-conversation");
    const workflow = screen.getByTestId("new-menu-workflow");
    const run = screen.getByTestId("new-menu-run");

    fireEvent.keyDown(conversation, { key: "ArrowDown" });
    expect(document.activeElement).toBe(workflow);
    fireEvent.keyDown(workflow, { key: "ArrowDown" });
    expect(document.activeElement).toBe(run);
    // Wraps around.
    fireEvent.keyDown(run, { key: "ArrowDown" });
    expect(document.activeElement).toBe(conversation);
    fireEvent.keyDown(conversation, { key: "ArrowUp" });
    expect(document.activeElement).toBe(run);

    fireEvent.keyDown(run, { key: "Escape" });
    expect(screen.queryByTestId("new-menu-list")).toBeNull();
    expect(document.activeElement).toBe(screen.getByTestId("new-menu"));
  });

  it("New conversation opens the shared dialog with a project picker", async () => {
    renderApp({ path: "/", routes: routes() });
    await openMenu();
    fireEvent.click(screen.getByTestId("new-menu-conversation"));

    const dialog = await screen.findByTestId("new-conversation-dialog", undefined, {
      timeout: READ_MS,
    });
    expect(dialog.getAttribute("role")).toBe("dialog");
    const picker = screen.getByTestId("new-conversation-dialog-project") as HTMLSelectElement;
    expect(picker.tagName).toBe("SELECT");
    // Every writable project is listed…
    expect(picker.value).toBe("");
    const options = screen.getAllByRole("option");
    // "Select a project…" + the two writable projects; the viewer one is out.
    expect(options.map((option) => option.textContent)).toEqual([
      "Select a project…",
      `${projectFixture.name} (${projectFixture.my_role})`,
      `${gears.name} (${gears.my_role})`,
    ]);
    // …and the exclusion is explained, not silent.
    expect(screen.getByText(/1 project hidden \(viewer role only\)/)).not.toBeNull();
  });

  it("posts to the project the picker selected and navigates to the conversation", async () => {
    const { requests } = renderApp({
      path: "/",
      routes: routes([{ path: gearsConversationsPath, method: "POST", body: conversationFixture }]),
    });
    await openMenu();
    fireEvent.click(screen.getByTestId("new-menu-conversation"));
    await screen.findByTestId("new-conversation-dialog", undefined, { timeout: READ_MS });

    const picker = screen.getByTestId("new-conversation-dialog-project") as HTMLSelectElement;
    fireEvent.change(picker, { target: { value: gears.id } });
    // The per-project form remounts on the pick, and its profile directory is
    // fetched for that form: the profile options are one async boundary away.
    await waitFor(() => {
      const profile = screen.getByTestId("conversation-new-profile") as HTMLSelectElement;
      expect(profile.options.length).toBeGreaterThan(1);
    });
    fireEvent.change(screen.getByTestId("conversation-new-title"), {
      target: { value: "Size the gearbox" },
    });
    fireEvent.change(screen.getByTestId("conversation-new-profile"), {
      target: { value: codexProfile.id },
    });
    fireEvent.change(screen.getByTestId("conversation-new-prompt"), {
      target: { value: "Compare the two reducer options." },
    });
    const submitBtn = screen.getByTestId("conversation-new-submit") as HTMLButtonElement;
    fireEvent.click(submitBtn);

    // The POST went to the selected project, not the first one in the list.
    // (awaited: the mutation fetch is one async boundary behind the click)
    await waitFor(() => {
      const post = requestsTo(requests, gearsConversationsPath, "POST");
      expect(post).toHaveLength(1);
      expect(JSON.parse(post[0].body ?? "{}")).toEqual({
        agent_profile_id: codexProfile.id,
        title: "Size the gearbox",
        prompt: "Compare the two reducer options.",
      });
      expect(requestsTo(requests, conversationsPath, "POST")).toHaveLength(0);
    });

    // Success navigates to `/projects/:selectedId/conversations/:id`.
    await screen.findByTestId("conversation-main", undefined, { timeout: READ_MS });
    expect(screen.getByTestId("conversation-title").textContent).toBe(conversationFixture.title);
  });

  it("New workflow navigates to the library", async () => {
    renderApp({ path: "/", routes: routes() });
    await openMenu();
    fireEvent.click(screen.getByTestId("new-menu-workflow"));
    await screen.findByTestId("library-page", undefined, { timeout: READ_MS });
    expect(screen.queryByTestId("new-menu-list")).toBeNull();
  });

  it("Start run navigates to the projects list, where a run is started from a project", async () => {
    renderApp({ path: "/", routes: routes() });
    await openMenu();
    fireEvent.click(screen.getByTestId("new-menu-run"));
    await screen.findByTestId("projects-heading", undefined, { timeout: READ_MS });
    expect(screen.queryByTestId("new-menu-list")).toBeNull();
  });
});

/** Issue #62 + the pointer-arrow handoff: the menu anchors to the trigger's
 * LEFT edge, clamps inside the viewport with an 8px margin (its pointer
 * arrow stays centered on the trigger even when the box shifts — asserted
 * in ds/Menu.test), and never stands beside another open surface (opening
 * Ask left New open before the fix — measured live: new-menu-list and
 * assistant-popover both on screen). */
describe("NewMenu placement and one-menu-at-a-time (issue #62)", () => {
  /** Place the trigger (and its `relative` wrapper, which is the menu's
   * positioning parent) at `left` in a `width`-wide viewport for the clamp
   * math (jsdom lays nothing out, so the rects are the only input). */
  function placeTrigger(left: number, width: number) {
    const trigger = screen.getByTestId("new-menu");
    const rect = (l: number) =>
      ({
        left: l,
        right: l + 48,
        width: 48,
        height: 26,
        top: 0,
        bottom: 26,
        x: l,
        y: 0,
      }) as DOMRect;
    trigger.getBoundingClientRect = () => rect(left);
    (trigger.parentElement as HTMLElement).getBoundingClientRect = () => rect(left);
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      writable: true,
      value: width,
    });
  }

  it("anchors the menu to the trigger's left edge when nothing overflows", async () => {
    renderApp({ path: "/", routes: routes() });
    await screen.findByTestId("new-menu");
    placeTrigger(10, 1280);
    fireEvent.click(screen.getByTestId("new-menu"));
    const menu = await screen.findByTestId("new-menu-list", undefined, { timeout: READ_MS });
    expect(menu.className).toContain("left-0");
    expect(menu.style.left).toBe("0px");
  });

  it("clamps the menu inside the viewport only as far as the right edge needs", async () => {
    renderApp({ path: "/", routes: routes() });
    await screen.findByTestId("new-menu");
    // 250 + the 180px menu would end at 430 in a 300px viewport. With the
    // 8px margin the menu's viewport-left may reach at most 300 - 8 - 180 =
    // 112; against the wrapper at 250 that is the -138px shift whose right
    // edge sits exactly on the margin.
    placeTrigger(250, 300);
    fireEvent.click(screen.getByTestId("new-menu"));
    const menu = await screen.findByTestId("new-menu-list", undefined, { timeout: READ_MS });
    expect(menu.style.left).toBe("-138px");
  });

  it("closes on a pointerdown outside the menu (clicking Ask or another menu's trigger)", async () => {
    renderApp({ path: "/", routes: routes() });
    await openMenu();
    // Inside the menu: stays open.
    fireEvent.pointerDown(screen.getByTestId("new-menu-conversation"));
    expect(screen.queryByTestId("new-menu-list")).not.toBeNull();
    // Outside: closes.
    fireEvent.pointerDown(document.body);
    await waitFor(() => expect(screen.queryByTestId("new-menu-list")).toBeNull());
  });

  it("closes the moment the assistant popover or the jump palette opens", async () => {
    renderApp({ path: "/", routes: routes() });
    await openMenu();
    act(() => window.dispatchEvent(new CustomEvent("communication:close-other-menus")));
    await waitFor(() => expect(screen.queryByTestId("new-menu-list")).toBeNull());

    fireEvent.click(screen.getByTestId("new-menu"));
    await screen.findByTestId("new-menu-list", undefined, { timeout: READ_MS });
    act(() => window.dispatchEvent(new CustomEvent("communication:palette-open")));
    await waitFor(() => expect(screen.queryByTestId("new-menu-list")).toBeNull());
  });

  it("clicking Ask closes New and opens the assistant popover (one menu at a time)", async () => {
    renderApp({ path: "/", routes: routes() });
    await openMenu();
    const ask = await screen.findByTestId("ask-sidebar", undefined, { timeout: READ_MS });
    fireEvent.pointerDown(ask);
    fireEvent.click(ask);
    await waitFor(() => expect(screen.queryByTestId("new-menu-list")).toBeNull());
    await screen.findByTestId("assistant-popover", undefined, { timeout: READ_MS });
  });
});
