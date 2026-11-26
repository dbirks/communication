/**
 * The chat thread's surrounding facts, ported from
 * `components/conversation/ConversationChatSurface.test.tsx` (the
 * `/p/:p/conversations/:id` page's rail, header and protocol lines) onto their
 * replacement, `components/chats/ChatThread.tsx`, seen through the real app at
 * the redesign's `/p/:projectId/chats/:id`.
 *
 * Retired with the old page: its breadcrumb (`conversation-breadcrumb`, whose
 * repository arm the 54px header's `chat-repo-chip` now says), the inline
 * 280px right column and the `thread-side-panel-aside` / `-stack` mounts
 * (design 3 keeps one shelf for these facts — the header's `…` → Details
 * sheet, whose own opens are proven in `ChatThread.ported.test.tsx`), the
 * header's two-line wrap rules (`conversation-meta` is gone), and the old
 * band's phone paddings. What a person still does — read who prompted, read
 * the WORKS IN / BRANCH / AGENTS sections the rail folds out of the real
 * reads, and read a session line that names the agent a turn actually ran on
 * — is asserted here through the ids the new components define.
 */
import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderApp } from "../../test/render";
import type { AgentProfile, Conversation } from "../../api/types";
import {
  FakeEventSource,
  claudeProfile,
  codexProfile,
  conversationEvent,
  conversationFixture,
  conversationId,
  meFixture,
  otherUserId,
  projectFixture,
  repositoryId,
  turnId,
  workerId,
  workspaceId,
  type RouteStub,
} from "../../test/fakes";

const path = `/p/${projectFixture.id}/chats/${conversationId}`;
const conversationPath = `/api/v1/conversations/${conversationId}`;
const projectPath = `/api/v1/projects/${projectFixture.id}`;
const workspacesPath = `${projectPath}/workspaces`;

/** A thread bound to one repository: the header chip and the rail both name it. */
const inStorefront: Conversation = {
  ...conversationFixture,
  repository_id: repositoryId,
  repository_name: "storefront",
};

/** The thread after a switch: Codex · gpt-5 runs the next turn, and the derived
 * `agents` list says Claude ran turns 1–2 and Codex turns 3–5. */
const switchedConversation: Conversation = {
  ...conversationFixture,
  agent_profile_id: codexProfile.id,
  agent_profile_name: "Codex",
  agent_profile_model: "gpt-5",
  launcher_id: codexProfile.launcher_id,
  agents: [
    {
      agent_profile_id: claudeProfile.id,
      agent_profile_name: "Claude Code",
      model: "opus",
      first_turn: 1,
      last_turn: 2,
      turn_count: 2,
    },
    {
      agent_profile_id: codexProfile.id,
      agent_profile_name: "Codex",
      model: "gpt-5",
      first_turn: 3,
      last_turn: 5,
      turn_count: 3,
    },
  ],
};

/** The switched thread, bound to one repository: what the rail's WORKS IN,
 * BRANCH and AGENTS sections read together. */
const switchedInStorefront: Conversation = {
  ...switchedConversation,
  repository_id: repositoryId,
  repository_name: "storefront",
};

/** The conversation after the picker moves the next turn back to Claude. */
const backOnClaude: Conversation = {
  ...conversationFixture,
  agent_profile_model: "opus",
  agents: switchedConversation.agents,
};

const workspaceWithBranch: RouteStub = {
  path: workspacesPath,
  body: {
    workspaces: [
      {
        id: workspaceId,
        project_id: projectFixture.id,
        scope_kind: "conversation",
        conversation_id: conversationId,
        worker_id: workerId,
        volume_id: "vol-1",
        workspace_mode: "worktree",
        state: "ready",
        repos: [
          {
            repository_id: repositoryId,
            name: "storefront",
            run_ref: "chat/search-spike",
            base_commit: "a".repeat(40),
            workspace_mode: "worktree",
            modified_paths: ["a.ts", "b.ts", "c.ts", "d.ts"],
          },
        ],
        created_at: "2026-10-14T18:01:00Z",
      },
    ],
  },
};

/** The prepare failed before any repository was bound: the honest state the
 * header used to read as "no repository attached" (ADR-0067). */
const workspaceWithoutRepo: RouteStub = {
  path: workspacesPath,
  body: {
    workspaces: [
      {
        id: workspaceId,
        project_id: projectFixture.id,
        scope_kind: "conversation",
        conversation_id: conversationId,
        worker_id: workerId,
        volume_id: "vol-1",
        workspace_mode: "worktree",
        state: "preparing",
        repos: [],
        created_at: "2026-10-14T18:01:00Z",
      },
    ],
  },
};

/** A repository row of the project, so the WORKS IN switcher has a name to read. */
const repoStub = {
  id: repositoryId,
  project_id: projectFixture.id,
  name: "storefront",
  git_url: "https://git.example/storefront.git",
  default_branch: "main",
  created_at: "2026-10-14T18:00:00Z",
  credential: "none" as const,
};

const usersDirectory: RouteStub = {
  path: "/api/v1/users",
  body: { items: [{ id: otherUserId, display_name: "Dana Reyes", email: null }] },
};

function routes(conversation: Conversation, extra: RouteStub[] = []): RouteStub[] {
  // `extra` first so a stub there can shadow the defaults below.
  return [
    ...extra,
    { path: "/api/v1/me", body: meFixture },
    usersDirectory,
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
    { path: workspacesPath, method: "GET", body: { workspaces: [] } },
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

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  FakeEventSource.reset();
  window.localStorage.clear();
});

/** Open the chat, then its header's `…` → Details, where the rail now lives. */
async function openDetails(conversation: Conversation, extra: RouteStub[] = []) {
  renderApp({ path, routes: routes(conversation, extra) });
  await screen.findByTestId("chat-header");
  fireEvent.click(screen.getByTestId("chat-menu"));
  fireEvent.click(await screen.findByTestId("chat-menu-details"));
  return await screen.findByTestId("conversation-side-panel");
}

/** Emit the two-turn switched transcript: Claude turn, the switch frame, a
 * Codex turn — in journal order. */
function emitSwitchedTranscript(): void {
  const source = FakeEventSource.last();
  act(() => {
    source.emit(
      conversationEvent("conversation.message.user", {
        turn_id: turnId,
        submitted_by: meFixture.id,
        text: "How is search wired today?",
      }),
    );
    source.emit(
      conversationEvent("conversation.message.agent", {
        turn_id: turnId,
        text: "One client, six call sites.",
        final: true,
      }),
    );
    source.emit(
      conversationEvent("conversation.agent.switched", {
        turn_id: undefined,
        actor_user_id: meFixture.id,
        from_agent_profile_id: claudeProfile.id,
        from_profile_name: "Claude Code",
        to_agent_profile_id: codexProfile.id,
        to_profile_name: "Codex",
        to_launcher_id: codexProfile.launcher_id,
        model: "gpt-5",
        transcript_carried_over: true,
      }),
    );
    source.emit(
      conversationEvent("conversation.message.user", {
        turn_id: "01987a73-9999-7000-8000-abcdef012345",
        submitted_by: otherUserId,
        text: "/review the diff.",
      }),
    );
    source.emit(
      conversationEvent("conversation.message.agent", {
        turn_id: "01987a73-9999-7000-8000-abcdef012345",
        text: "Two findings, both fixed.",
        final: true,
      }),
    );
  });
}

describe("the context rail from the reads (ported, behind Details)", () => {
  it("shows WORKS IN, BRANCH with its file count and the agents with their ranges", async () => {
    const panel = await openDetails(switchedInStorefront, [
      workspaceWithBranch,
      { path: `${projectPath}/repos`, body: { items: [repoStub] } },
    ]);
    expect(within(panel).getByTestId("side-panel-works-in").textContent).toContain("storefront");
    expect(within(panel).getByTestId("side-panel-branch").textContent).toContain(
      "chat/search-spike",
    );
    expect(within(panel).getByTestId("side-panel-files-changed").textContent).toBe(
      "4 files changed",
    );
    expect(within(panel).getByTestId("side-panel-agent-range-0").textContent).toBe(
      "turns 1\u20132",
    );
    expect(within(panel).getByTestId("side-panel-agent-range-1").textContent).toBe(
      "turns 3\u20135",
    );
    // No read names a skill or a PR, and agent mail (3d) is off: absent.
    expect(within(panel).queryByTestId("side-panel-skills")).toBeNull();
    expect(within(panel).queryByTestId("side-panel-pr-link")).toBeNull();
    expect(within(panel).queryByText(/LINKED CHATS/i)).toBeNull();
  });

  it("hides every data section when no read names anything, leaving only the assistant's note", async () => {
    const panel = await openDetails(conversationFixture);
    // No read names a branch, files or agent ranges: those data sections are
    // absent. WORKS IN alone stays — a named thread's scope switcher is its
    // own fact, and no read naming a repository hides it (round-8 design
    // review item 3 made the section the switcher's, not the repository
    // name's).
    expect(within(panel).getByTestId("side-panel-works-in-switch")).toBeTruthy();
    expect(within(panel).queryByTestId("side-panel-branch")).toBeNull();
    expect(within(panel).queryByTestId("side-panel-files-changed")).toBeNull();
    expect(within(panel).queryByTestId("side-panel-agent-range-0")).toBeNull();
    // Thread → workflow (design 2f): the host names this thread's chat, so
    // the ASSISTANT slot always carries — the rail is never wholly dark here.
    expect(within(panel).getByTestId("assistant-note-workflow")).toBeTruthy();
  });
});

describe("one repository fact for the header and the rail (ADR-0067)", () => {
  it("names the repository in BOTH and says the workspace did not prepare", async () => {
    // One render: the header chip is on screen while the sheet stands open, so
    // the two readings of the same ADR-0067 fact are compared on one surface.
    const panel = await openDetails(inStorefront, [workspaceWithoutRepo]);
    expect(screen.getByTestId("chat-repo-chip").textContent).toBe("storefront");

    const works = within(panel).getByTestId("side-panel-works-in");
    expect(works.textContent).toContain("storefront");
    expect(within(works).getByTestId("side-panel-works-in-state").textContent).toContain(
      "workspace not prepared",
    );
    expect(panel.textContent).not.toContain("no repository attached");
  });

  it("says nothing extra once the workspace really is attached", async () => {
    const panel = await openDetails(inStorefront, [workspaceWithBranch]);
    const works = within(panel).getByTestId("side-panel-works-in");
    expect(works.textContent).toContain("storefront");
    expect(within(works).queryByTestId("side-panel-works-in-state")).toBeNull();
  });
});

describe("the people the journal names (ported)", () => {
  it("names every person whose prompt the journal carries", async () => {
    renderApp({ path, routes: routes(switchedConversation) });
    await screen.findByTestId("chat-title");
    emitSwitchedTranscript();
    // The header's one people line: every person whose prompt the journal
    // carries, then the agent they are all talking to.
    const line = await screen.findByTestId("chat-people");
    expect(line.textContent).toBe("Ada Lovelace, Dana Reyes · Codex");
  });

  it("names only the agent on a thread nobody has prompted", async () => {
    // The old page printed no participant line at all; the 54px header's one
    // people line always says whose agent it is, and names no person the
    // journal never saw prompt.
    renderApp({ path, routes: routes(conversationFixture) });
    const line = await screen.findByTestId("chat-people");
    expect(line.textContent).toBe("Claude Code");
  });
});

describe("the transcript names the agent a turn ran on (ported)", () => {
  it("names the agent a switch divider proved, not the launcher it carried", async () => {
    // After a switch the conversation's OWN profile row describes the next
    // turn, so a session event on the profile the chat moved OFF has to be
    // named from the divider frame — the journal's own launcher → profile pair.
    renderApp({ path, routes: routes(backOnClaude) });
    await screen.findByTestId("chat-title");
    act(() => {
      const source = FakeEventSource.last();
      source.emit(
        conversationEvent("conversation.agent.switched", {
          actor_user_id: meFixture.id,
          from_agent_profile_id: claudeProfile.id,
          from_profile_name: "Claude Code",
          to_agent_profile_id: codexProfile.id,
          to_profile_name: "Codex",
          to_launcher_id: codexProfile.launcher_id,
          model: "gpt-5",
          transcript_carried_over: true,
        }),
      );
      source.emit(
        conversationEvent("agent.session.connected", {
          binding_id: "b-2",
          worker_id: workerId,
          acp_session_id: "s-2",
          protocol_version: "0.4",
          launcher_id: codexProfile.launcher_id,
        }),
      );
    });
    const line = (await screen.findByText(/^Connected to /)).closest("li[title]") as HTMLElement;
    expect(line.textContent).toContain("Connected to Codex");
  });

  it("names the agent the TURN ran on, not the profile the thread is on now", async () => {
    // rcn-2e review item 2, end to end, on the lab's exact shape: TWO agent
    // profiles of one organization launch the SAME executable (`pi`), and the
    // thread switched between them. `agent.session.connected` carries no
    // profile — only the launcher — so the fold alone can only name the
    // thread's CURRENT profile, which misnamed the earlier session. The frame's
    // binding names the turn it launched, and ADR-0068's turn range names the
    // agent that turn ran on.
    const piProfile = (id: string, name: string): AgentProfile => ({
      id,
      name,
      launcher_id: "pi",
      permission_mode: "ask",
      created_at: "2026-10-14T18:00:00Z",
      version: 1,
    });
    const implementer = piProfile("01987a71-2222-7000-8000-abcdef0000a1", "m4-implementer");
    const planner = piProfile("01987a71-2222-7000-8000-abcdef0000a2", "m4-planner");
    const piThread: Conversation = {
      ...conversationFixture,
      agent_profile_id: planner.id,
      agent_profile_name: "m4-planner",
      agent_profile_model: null,
      launcher_id: "pi",
      agents: [
        {
          agent_profile_id: implementer.id,
          agent_profile_name: "m4-implementer",
          model: null,
          first_turn: 1,
          last_turn: 1,
          turn_count: 1,
        },
        {
          agent_profile_id: planner.id,
          agent_profile_name: "m4-planner",
          model: null,
          first_turn: 2,
          last_turn: 2,
          turn_count: 1,
        },
      ],
    };
    renderApp({
      path,
      routes: routes(piThread, [
        { path: "/api/v1/agent-profiles", body: { items: [implementer, planner] } },
      ]),
    });
    await screen.findByTestId("chat-title");
    act(() => {
      const source = FakeEventSource.last();
      source.emit(
        conversationEvent("agent.session.connected", {
          turn_id: "",
          binding_id: "bind-1",
          worker_id: workerId,
          acp_session_id: "s-1",
          protocol_version: "0.4",
          launcher_id: "pi",
          session_origin: "new",
        }),
      );
      source.emit(
        conversationEvent("conversation.turn.started", {
          turn_id: turnId,
          worker_id: workerId,
          fencing_token: 1,
          binding_id: "bind-1",
          acp_session_id: "s-1",
          session_origin: "new",
        }),
      );
    });
    const line = (await screen.findByText(/^Connected to /)).closest("li[title]") as HTMLElement;
    // The thread runs on m4-planner NOW; this session was the m4-implementer's.
    expect(line.textContent).toContain("Connected to m4-implementer");
    // The wire's own word for the executable stays on the tooltip.
    expect(line.getAttribute("title")).toBe("launcher_id pi");
  });
});

/**
 * round-19's structural contract, ported: the header is the thread's OWN band
 * — a `shrink-0` flex sibling ABOVE the transcript scroller, never
 * `sticky`/`fixed`/`absolute` over it, so transcript content never slides under
 * it. jsdom applies no CSS, so the classes and the DOM shape ARE the contract.
 * (The old band's own phone paddings are retired with it: the 54px header
 * compacts with its own `max-md:py-[6px]`.)
 */
describe("the chat header sits above the transcript (ported)", () => {
  it("the header is a plain sibling band: shrink-0, never sticky/fixed/absolute", async () => {
    renderApp({ path, routes: routes(conversationFixture) });
    const header = await screen.findByTestId("chat-header");
    const classes = header.className.split(/\s+/);
    // No class positions it over scrolling content at ANY breakpoint.
    for (const offender of ["sticky", "fixed", "absolute"]) {
      expect(classes.some((cls) => cls === offender || cls.endsWith(`:${offender}`))).toBe(false);
    }
    expect(classes.some((cls) => /(^|:)(top|z|inset)-/.test(cls))).toBe(false);
    // It owns a fixed band: `shrink-0` in a column that clips.
    expect(classes).toContain("shrink-0");
    expect(header.parentElement?.className).toContain("flex-col");
    // The transcript scroller is the header's SIBLING below it — the header
    // contains no scroller and no scroller contains the header.
    const scroller = document.querySelector<HTMLElement>("[data-capture-keep-scroll]");
    expect(scroller?.className).toContain("overflow-y-auto");
    expect(scroller?.contains(header)).toBe(false);
    expect(scroller?.parentElement).toBe(header.parentElement);
    // And the band sits above it in document order.
    expect(
      header.compareDocumentPosition(scroller as HTMLElement) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});
