/**
 * The composer's next-turn agent chip, ported from
 * `components/conversation/ConversationChatSurface.test.tsx` (the `/threads/:id`
 * page's chip) onto its replacement, `components/chats/ChatComposer.tsx`, seen
 * through the real app at the redesign's `/p/:projectId/chats/:id`.
 *
 * The old chip's own menu is retired with the page: `ComposerAgentChip` and its
 * `composer-agent-menu` / `composer-agent-profile-*` rows / visible
 * `composer-agent-chip-reason` line are replaced everywhere by the shared
 * `components/shell/AgentPicker` (redesign contract, "Agents & models" 2), whose
 * popover says RUNS ON, ticks the current profile with a ✓ and carries a
 * "Manage agents…" door. What a person still does — read which agent runs the
 * next turn, choose another one between turns, see why the choice is locked, and
 * read the route's refusal inline — is asserted here through the ids the new
 * components define.
 */
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderApp } from "../../test/render";
import type { Conversation } from "../../api/types";
import {
  FakeEventSource,
  claudeProfile,
  codexProfile,
  controlledByOther,
  conversationFixture,
  conversationId,
  meFixture,
  projectFixture,
  requestsTo,
  turnFixture,
  type RouteStub,
} from "../../test/fakes";

const path = `/p/${projectFixture.id}/chats/${conversationId}`;
const conversationPath = `/api/v1/conversations/${conversationId}`;
const switchPath = `${conversationPath}/switch-agent`;
const projectPath = `/api/v1/projects/${projectFixture.id}`;

/** The thread after a switch: Codex · gpt-5 runs the next turn. */
const switchedConversation: Conversation = {
  ...conversationFixture,
  agent_profile_id: codexProfile.id,
  agent_profile_name: "Codex",
  agent_profile_model: "gpt-5",
  launcher_id: codexProfile.launcher_id,
};

/** The conversation after the picker moves the next turn back to Claude. */
const backOnClaude: Conversation = {
  ...conversationFixture,
  agent_profile_model: "opus",
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  FakeEventSource.reset();
  window.localStorage.clear();
});

function routes(conversation: Conversation, extra: RouteStub[] = []): RouteStub[] {
  // `extra` first so a stub there can shadow the defaults below.
  return [
    ...extra,
    { path: "/api/v1/me", body: meFixture },
    { path: "/api/v1/users", method: "GET", body: { items: [] } },
    {
      path: "/api/v1/agent-profiles",
      method: "GET",
      body: {
        items: [
          { ...claudeProfile, model: "opus" },
          { ...codexProfile, model: "gpt-5" },
        ],
      },
    },
    { path: projectPath, method: "GET", body: projectFixture },
    { path: `${projectPath}/repos`, method: "GET", body: { items: [] } },
    { path: `${projectPath}/workspaces`, method: "GET", body: { workspaces: [] } },
    { path: `${projectPath}/assignments`, method: "GET", body: { assignments: [] } },
    { path: "/api/v1/pipelines", method: "GET", body: { pipelines: [] } },
    { path: `${projectPath}/issue-triggers`, method: "GET", body: { issue_triggers: [] } },
    { path: `${projectPath}/runs`, method: "GET", body: { runs: [] } },
    { path: `${projectPath}/artifacts`, method: "GET", body: { artifacts: [] } },
    {
      path: `${projectPath}/conversations`,
      method: "GET",
      body: { items: [], next_cursor: null },
    },
    { path: "/api/v1/conversations", method: "GET", body: { items: [], next_cursor: null } },
    { path: conversationPath, method: "GET", body: conversation },
    { path: `${conversationPath}/notes`, method: "GET", body: { notes: [] } },
  ];
}

/** Open the chip's picker and wait for the popover the shared AgentPicker draws. */
async function openPicker(): Promise<HTMLElement> {
  const chip = await screen.findByTestId("composer-agent-chip");
  fireEvent.click(chip);
  return await screen.findByTestId("agent-picker-popover");
}

describe("the composer's agent chip (ported from the thread page)", () => {
  it("prints the next-turn profile and lists the profiles under RUNS ON", async () => {
    renderApp({ path, routes: routes(switchedConversation) });
    const chip = await screen.findByTestId("composer-agent-chip");
    expect(chip.textContent).toContain("Codex · gpt-5");

    const menu = await openPicker();
    // The design's caption, in the picker's own words.
    expect(menu.textContent).toContain("RUNS ON");
    const other = await within(menu).findByTestId(`agent-option-${claudeProfile.id}`);
    expect(other.textContent).toContain("Claude Code");
    expect(other.textContent).toContain("opus");
    // ✓ on the current profile only.
    expect(within(menu).getByTestId(`agent-option-${codexProfile.id}`).textContent).toContain("✓");
    expect(other.textContent).not.toContain("✓");
    // Every profile, including the ones further down: the old menu's one flat
    // list is now grouped by harness with a door to the library.
    expect(menu.querySelector("[data-testid='agent-picker-manage']")?.getAttribute("href")).toBe(
      "/manage/agents",
    );
  });

  it("choosing a profile calls the switch route and moves the chip when the fresh conversation lands", async () => {
    const { requests } = renderApp({
      path,
      routes: routes(switchedConversation, [
        { path: switchPath, method: "POST", body: backOnClaude },
      ]),
    });
    const menu = await openPicker();
    fireEvent.click(within(menu).getByTestId(`agent-option-${claudeProfile.id}`));

    await waitFor(() => {
      const [request] = requestsTo(requests, switchPath, "POST");
      expect(request).toBeTruthy();
      expect(JSON.parse(request.body ?? "{}")).toEqual({ agent_profile_id: claudeProfile.id });
    });
    await waitFor(() => {
      expect(screen.getByTestId("composer-agent-chip").textContent).toContain("Claude Code · opus");
    });
  });

  it("is disabled with a reason for a member who is not the controller", async () => {
    renderApp({ path, routes: routes({ ...controlledByOther, agent_profile_model: "gpt-5" }) });
    const chip = await screen.findByTestId("composer-agent-chip");
    expect(chip.hasAttribute("disabled")).toBe(true);
    // The visible reason line is retired with the old chip: the shared picker
    // carries the same sentence as the locked chip's own tooltip.
    expect(chip.getAttribute("title")).toBe(
      "Only the controller can choose which agent runs the next turn.",
    );
    // It stays locked: no popover, and no second copy of the sentence in the
    // composer (the explainer under the box already names the controller).
    const explainer = await screen.findByTestId("composer-explainer");
    expect(explainer.textContent).toContain("Only the controller (Dana Observer)");
    fireEvent.click(chip);
    expect(screen.queryByTestId("agent-picker-popover")).toBeNull();
  });

  it("is disabled while a turn runs, and says it ONCE", async () => {
    // rcn-3d review item 5 survives the redesign: a controller with an open
    // turn is told so by the composer's own explainer — the longer, actionable
    // line wired to the input — and never twice in the same breath. The locked
    // chip keeps the reason as the tooltip a hover or a screen reader reaches.
    renderApp({
      path,
      routes: routes({ ...switchedConversation, active_turn: turnFixture({ status: "running" }) }),
    });
    const chip = await screen.findByTestId("composer-agent-chip");
    expect(chip.hasAttribute("disabled")).toBe(true);
    expect(chip.getAttribute("title")).toContain("A turn is running");
    const explainer = screen.getByTestId("composer-explainer");
    expect(explainer.textContent).toContain("A turn is already open");
    // …and the phrase appears exactly once on the surface.
    const composer = screen.getByTestId("chat-composer");
    expect((composer.textContent?.match(/A turn is/g) ?? []).length).toBe(1);
  });

  it("shows a refused switch inline", async () => {
    renderApp({
      path,
      routes: routes(switchedConversation, [
        {
          path: switchPath,
          method: "POST",
          status: 403,
          body: {
            type: "https://communication.dev/errors/forbidden",
            title: "Forbidden",
            status: 403,
            detail: "only the conversation's controller switches agents",
          },
        },
      ]),
    });
    const menu = await openPicker();
    fireEvent.click(within(menu).getByTestId(`agent-option-${claudeProfile.id}`));
    const box = await screen.findByTestId("composer-agent-switch-error");
    expect(box.textContent).toContain("only the conversation's controller switches agents");
  });
});
