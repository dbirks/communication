/**
 * The 2e/1h chat surface, proven through the real page: the switch divider
 * rendered from the journal frame, the composer's "NEXT TURN RUNS ON" chip
 * (menu, route call, disabled states, inline errors), the context rail's
 * sections from real reads, and the header's breadcrumb and participants.
 *
 * The API is mocked at the fetch boundary (as everywhere in this suite); the
 * lab predates ADR-0068, so every ADR-0068/0067 member below is the wire's
 * shape hand-built as a stub — never a client-side guess.
 */
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderApp } from "../../test/render";
import {
  claudeProfile,
  codexProfile,
  controlledByOther,
  conversationEvent,
  conversationFixture,
  conversationId,
  conversationSummaryFixture,
  meFixture,
  otherUserId,
  projectFixture,
  repositoryId,
  turnFixture,
  turnId,
  workspaceId,
  workerId,
  FakeEventSource,
  requestsTo,
  type RouteStub,
} from "../../test/fakes";
import type { Conversation } from "../../api/types";

const path = `/p/${projectFixture.id}/conversations/${conversationId}`;
const conversationPath = `/api/v1/conversations/${conversationId}`;
const switchPath = `${conversationPath}/switch-agent`;
const projectConversationsPath = `/api/v1/projects/${projectFixture.id}/conversations`;

/** The thread after a switch: Codex · gpt-5 runs the next turn, and the
 * derived `agents` list says Claude ran turns 1–2 and Codex turns 3–5. */
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

/** The conversation after the picker moves the next turn back to Claude. */
const backOnClaude: Conversation = {
  ...conversationFixture,
  agent_profile_model: "opus",
  agents: switchedConversation.agents,
};

const summaryWithRepo: RouteStub = {
  path: projectConversationsPath,
  body: {
    items: [
      {
        ...conversationSummaryFixture,
        repository_id: repositoryId,
        repository_name: "storefront",
      },
    ],
  },
};

const workspaceWithBranch: RouteStub = {
  path: `/api/v1/projects/${projectFixture.id}/workspaces`,
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

const usersDirectory: RouteStub = {
  path: "/api/v1/users",
  body: { items: [{ id: otherUserId, display_name: "Dana Reyes", email: null }] },
};

function routes(conversation: Conversation, extra: RouteStub[] = []): RouteStub[] {
  return [
    ...extra,
    { path: "/api/v1/me", body: meFixture },
    {
      path: "/api/v1/agent-profiles",
      body: {
        items: [
          { ...claudeProfile, model: "opus" },
          { ...codexProfile, model: "gpt-5" },
        ],
      },
    },
    { path: `/api/v1/projects/${projectFixture.id}`, body: projectFixture },
    usersDirectory,
    { path: conversationPath, body: conversation },
    { path: `/api/v1/projects/${projectFixture.id}/artifacts`, body: { artifacts: [] } },
  ];
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

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

describe("the switch divider renders from the journal frame", () => {
  it("cuts the transcript at the switch and words the divider exactly as ADR-0068 fixes it", async () => {
    renderApp({ path, routes: routes(switchedConversation) });
    await screen.findByTestId("conversation-title");
    emitSwitchedTranscript();

    const divider = await screen.findByTestId("agent-switch-divider");
    expect(divider.textContent).toBe(
      "Ada Lovelace switched to Codex · gpt-5 · transcript and branch carried over",
    );

    // Two transcript runs: the divider splits the list, each run keeps its
    // own agent header — never one label painted over the other's turns.
    const lists = screen.getAllByTestId("transcript");
    expect(lists).toHaveLength(2);
    expect(within(lists[0]).getByTestId("agent-speaker").textContent).toContain(
      "Claude Code · opus",
    );
    expect(within(lists[1]).getByTestId("agent-speaker").textContent).toContain("Codex · gpt-5");
    // The divider sits between them.
    const main = screen.getByTestId("conversation-main");
    expect(
      main.compareDocumentPosition(divider) & Node.DOCUMENT_POSITION_CONTAINED_BY,
    ).toBeTruthy();
  });

  it("renders no divider when no switch frame exists, and one run as before", async () => {
    renderApp({ path, routes: routes(conversationFixture) });
    await screen.findByTestId("conversation-title");
    const source = FakeEventSource.last();
    act(() => {
      source.emit(
        conversationEvent("conversation.message.agent", { text: "Reading.", final: true }),
      );
    });
    expect(screen.getAllByTestId("transcript")).toHaveLength(1);
    expect(screen.queryByTestId("agent-switch-divider")).toBeNull();
    // No switch ever happened: the run carries the conversation's own profile.
    expect(screen.getByTestId("agent-speaker").textContent).toContain("Claude Code");
  });
});

describe("the composer's agent chip", () => {
  it("prints the next-turn profile and lists the profiles under NEXT TURN RUNS ON", async () => {
    renderApp({ path, routes: routes(switchedConversation) });
    const chip = await screen.findByTestId("composer-agent-chip");
    expect(chip.textContent).toContain("Codex · gpt-5");

    fireEvent.click(chip);
    const menu = await screen.findByTestId("composer-agent-menu");
    expect(menu.textContent).toContain("NEXT TURN RUNS ON");
    expect(
      within(menu).getByTestId(`composer-agent-profile-${claudeProfile.id}`).textContent,
    ).toContain("Claude Code · opus");
    // ✓ on the current profile only.
    expect(
      within(menu).getByTestId(`composer-agent-profile-${codexProfile.id}`).textContent,
    ).toContain("✓");
    expect(
      within(menu).getByTestId(`composer-agent-profile-${claudeProfile.id}`).textContent,
    ).not.toContain("✓");
  });

  it("choosing a profile calls the switch route and moves the chip when the fresh conversation lands", async () => {
    const { requests } = renderApp({
      path,
      routes: routes(switchedConversation, [
        { path: switchPath, method: "POST", body: backOnClaude },
      ]),
    });
    const chip = await screen.findByTestId("composer-agent-chip");
    fireEvent.click(chip);
    const menu = await screen.findByTestId("composer-agent-menu");
    fireEvent.click(within(menu).getByTestId(`composer-agent-profile-${claudeProfile.id}`));

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
    expect(chip.getAttribute("title")).toBe(
      "Only the controller can choose which agent runs the next turn.",
    );
    expect(screen.getByTestId("composer-agent-chip-reason").textContent).toContain(
      "Only the controller can choose",
    );
  });

  it("is disabled while a turn runs, even for the controller", async () => {
    renderApp({
      path,
      routes: routes({ ...switchedConversation, active_turn: turnFixture({ status: "running" }) }),
    });
    const chip = await screen.findByTestId("composer-agent-chip");
    expect(chip.hasAttribute("disabled")).toBe(true);
    expect(screen.getByTestId("composer-agent-chip-reason").textContent).toContain(
      "A turn is running",
    );
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
    const chip = await screen.findByTestId("composer-agent-chip");
    fireEvent.click(chip);
    const menu = await screen.findByTestId("composer-agent-menu");
    fireEvent.click(within(menu).getByTestId(`composer-agent-profile-${claudeProfile.id}`));
    const box = await screen.findByTestId("composer-agent-switch-error");
    expect(box.textContent).toContain("only the conversation's controller switches agents");
  });
});

describe("the context rail (2e side panel) from the reads", () => {
  it("shows WORKS IN, BRANCH with its file count and the agents with their ranges", async () => {
    renderApp({
      path,
      routes: routes(switchedConversation, [summaryWithRepo, workspaceWithBranch]),
    });
    const panel = await screen.findByTestId("conversation-side-panel");
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
    renderApp({ path, routes: routes(conversationFixture) });
    await screen.findByTestId("conversation-title");
    const panel = await screen.findByTestId("conversation-side-panel");
    // No read names a repository, a branch, files or agent ranges: every
    // data section is absent.
    expect(within(panel).queryByTestId("side-panel-works-in")).toBeNull();
    expect(within(panel).queryByTestId("side-panel-branch")).toBeNull();
    expect(within(panel).queryByTestId("side-panel-files-changed")).toBeNull();
    expect(within(panel).queryByTestId("side-panel-agent-range-0")).toBeNull();
    // Thread → workflow (design 2f): the host names this thread's chat, so
    // the ASSISTANT slot always carries — the rail is never wholly dark here.
    expect(within(panel).getByTestId("assistant-note-workflow")).toBeTruthy();
  });
});

describe("the header's breadcrumb and participants", () => {
  it("links project / repository once a read names the repository", async () => {
    renderApp({ path, routes: routes(conversationFixture, [summaryWithRepo]) });
    const crumb = await screen.findByTestId("conversation-breadcrumb");
    expect(crumb.textContent).toContain("Widgets");
    const repo = within(crumb).getByTestId("conversation-breadcrumb-repo");
    expect(repo.textContent).toBe("storefront");
    expect(repo.getAttribute("href")).toBe(`/p/${projectFixture.id}/storefront`);
  });

  it("says chats when no read names a repository", async () => {
    renderApp({ path, routes: routes(conversationFixture) });
    const crumb = await screen.findByTestId("conversation-breadcrumb");
    expect(within(crumb).getByTestId("conversation-breadcrumb-unbound").textContent).toBe("chats");
  });

  it("names every person whose prompt the journal carries", async () => {
    renderApp({ path, routes: routes(switchedConversation) });
    await screen.findByTestId("conversation-title");
    emitSwitchedTranscript();
    const line = await screen.findByTestId("conversation-participants");
    expect(line.textContent).toBe("Ada Lovelace, Dana Reyes");
  });

  it("prints no participant line for a thread nobody has prompted", async () => {
    renderApp({ path, routes: routes(conversationFixture) });
    await screen.findByTestId("conversation-title");
    expect(screen.queryByTestId("conversation-participants")).toBeNull();
  });
});

describe("the failed turn (error-details-r6)", () => {
  /** The exact diagnostic the rcn-2e review caught on screen: a project uuid, a
   * mirror path and an ADR number, quoted at a person who can act on none of
   * them. */
  const RAW =
    "worker: prepare workspace for project 01a19c73-99be-72da-b92b-4a74716530b2: " +
    "workspace: mirror /repos/01a19c73-99be-72da-b92b-4a74716530b2/server.git has no " +
    'branch "main" to base server on (ADR-0017 D2 refuses a branch-name guess)';

  it("prints one plain sentence and keeps the server's words behind Details", async () => {
    renderApp({ path, routes: routes(conversationFixture) });
    await screen.findByTestId("conversation-title");
    const source = FakeEventSource.last();
    act(() => {
      source.emit(
        conversationEvent("conversation.message.user", {
          turn_id: turnId,
          submitted_by: meFixture.id,
          text: "Start the workspace.",
        }),
      );
      source.emit(conversationEvent("conversation.turn.failed", { turn_id: turnId, message: RAW }));
    });

    const notice = await screen.findByTestId("turn-failed");
    expect(within(notice).getByTestId("turn-failed-plain").textContent).toBe(
      "This chat couldn't start its workspace: the repository has no default branch to start from.",
    );
    // The reading line names no uuid, no path and no ADR number.
    expect(within(notice).getByTestId("turn-failed-plain").textContent).not.toMatch(
      /01a19c73|\/repos\/|ADR-0017/,
    );
    // The fold's raw `Turn failed: worker: prepare workspace …` line is GONE
    // from the transcript — the notice replaces it, it does not sit beside it.
    for (const item of screen.queryAllByTestId("transcript-item")) {
      expect(item.textContent).not.toContain("worker: prepare workspace");
    }

    // The evidence survives, collapsed: in the DOM, reachable, not on the line.
    const details = notice.querySelector("details") as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(within(notice).getByTestId("turn-failed-server").textContent).toBe(
      `server said: ${RAW}`,
    );
    fireEvent.click(details.querySelector("summary") as HTMLElement);
    expect((notice.querySelector("details") as HTMLDetailsElement).open).toBe(true);
  });
});

describe("one repository fact for the header and the rail (ADR-0067)", () => {
  /** The contradiction the review caught: the rail read the summary row's
   * `repository_name` and said `web`, while the header read the thread's own
   * workspace and said “no repository attached”. The workspace is a second
   * fact, never a denial of the first. */
  const workspaceWithoutRepo: RouteStub = {
    path: `/api/v1/projects/${projectFixture.id}/workspaces`,
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
          // The prepare failed before any repository was bound: `preparing`,
          // no repos — the honest state the header used to read as “no
          // repository attached”.
          state: "preparing",
          repos: [],
          created_at: "2026-10-14T18:01:00Z",
        },
      ],
    },
  };

  it("names the repository in BOTH and says the workspace did not prepare", async () => {
    renderApp({
      path: `/threads/${conversationId}`,
      routes: routes(conversationFixture, [
        summaryWithRepo,
        workspaceWithoutRepo,
        { path: "/api/v1/conversations", body: { items: [], next_cursor: null } },
      ]),
    });
    const meta = await screen.findByTestId("conversation-meta");
    await waitFor(() => expect(meta.textContent).toContain("storefront"));
    expect(meta.textContent).toContain("workspace not prepared");
    expect(meta.textContent).not.toContain("no repository attached");

    const panel = await screen.findByTestId("conversation-side-panel");
    const works = within(panel).getByTestId("side-panel-works-in");
    expect(works.textContent).toContain("storefront");
    expect(within(works).getByTestId("side-panel-works-in-state").textContent).toContain(
      "workspace not prepared",
    );
  });

  it("says nothing extra once the workspace really is attached", async () => {
    renderApp({
      path: `/threads/${conversationId}`,
      routes: routes(conversationFixture, [
        summaryWithRepo,
        workspaceWithBranch,
        { path: "/api/v1/conversations", body: { items: [], next_cursor: null } },
      ]),
    });
    const meta = await screen.findByTestId("conversation-meta");
    await waitFor(() => expect(meta.textContent).toContain("storefront"));
    expect(meta.textContent).not.toContain("workspace not prepared");
    const panel = await screen.findByTestId("conversation-side-panel");
    expect(
      within(within(panel).getByTestId("side-panel-works-in")).queryByTestId(
        "side-panel-works-in-state",
      ),
    ).toBeNull();
  });
});

describe("the header's two facts at a narrow pane width", () => {
  it("wraps the title and the meta line instead of ellipsising either", async () => {
    // rcn-2e review defect 1: inside the `/threads` pane (320px list + 280px
    // rail) the title cut to “EMU-R…” and the meta line to “C…”. The run title
    // settled this rule in a68240c — a name is never the thing that gives way.
    renderApp({
      path: `/threads/${conversationId}`,
      routes: routes(switchedConversation, [
        { path: "/api/v1/conversations", body: { items: [], next_cursor: null } },
      ]),
    });
    const title = await screen.findByTestId("conversation-title");
    const titleTokens = title.className.split(/\s+/);
    expect(titleTokens).toContain("wrap-anywhere"); // overflow-wrap:anywhere
    expect(titleTokens).not.toContain("truncate");
    expect(titleTokens).not.toContain("lg:truncate");
    expect(titleTokens).not.toContain("line-clamp-2");

    const meta = screen.getByTestId("conversation-meta");
    const metaTokens = meta.className.split(/\s+/);
    expect(metaTokens).toContain("wrap-anywhere");
    expect(metaTokens).not.toContain("truncate");
    expect(metaTokens).not.toContain("lg:truncate");
  });
});

describe("the side panel follows the width", () => {
  it("mounts as the 280px right column at desktop widths", async () => {
    renderApp({
      path: `/threads/${conversationId}`,
      routes: routes(switchedConversation, [
        summaryWithRepo,
        { path: "/api/v1/conversations", body: { items: [], next_cursor: null } },
      ]),
    });
    const aside = await screen.findByTestId("thread-side-panel-aside");
    expect(within(aside).getByTestId("conversation-side-panel")).toBeTruthy();
    expect(screen.queryByTestId("thread-side-panel-stack")).toBeNull();
  });

  it("collapses under the transcript below 1024px", async () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query.includes("max-width"),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      onchange: null,
      dispatchEvent: () => false,
    }));
    renderApp({
      path: `/threads/${conversationId}`,
      routes: routes(switchedConversation, [
        summaryWithRepo,
        { path: "/api/v1/conversations", body: { items: [], next_cursor: null } },
      ]),
    });
    const stack = await screen.findByTestId("thread-side-panel-stack");
    expect(within(stack).getByTestId("conversation-side-panel")).toBeTruthy();
    expect(screen.queryByTestId("thread-side-panel-aside")).toBeNull();
  });
});
