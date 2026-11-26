/**
 * The chat thread's transcript, ported from `pages/Conversation.test.tsx` and
 * `components/conversation/ConversationChatSurface.test.tsx` onto the
 * replacement surface: `components/chats/ChatThread.tsx`, whose transcript is
 * the same `ConversationTranscript`/`Transcript` the app has always used.
 *
 * Retired with the old page: the header's mono meta line, the `turn-status`
 * chip and the `conversation-main` / `thread-composer-pin` pane geometry (the
 * pane's scroller is now the `chat-thread` column's own scroll region, and the
 * pin's decisions are covered by `useTranscriptScroll.test.tsx` and
 * `ConversationTranscript.test.tsx`). What a person still does — read the tool
 * rows as they update, see whose agent switch cut the thread, read a served
 * plan, read the protocol lines in plain words — is asserted here.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatThread } from "./ChatThread";
import {
  FakeEventSource,
  claudeProfile,
  codexProfile,
  conversationEvent,
  conversationFixture,
  conversationId,
  meFixture,
  mockFetch,
  otherUserId,
  projectFixture,
  turnId,
  workerId,
  type RouteStub,
} from "../../test/fakes";
import type { Conversation } from "../../api/types";

const conversationPath = `/api/v1/conversations/${conversationId}`;
const projectPath = `/api/v1/projects/${projectFixture.id}`;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  FakeEventSource.reset();
  window.localStorage.clear();
});

function routeStubs(conversation: Conversation, extra: RouteStub[] = []): RouteStub[] {
  return [
    ...extra,
    { path: "/api/v1/me", body: meFixture },
    { path: "/api/v1/users", method: "GET", body: { items: [] } },
    { path: "/api/v1/agent-profiles", body: { items: [claudeProfile, codexProfile] } },
    { path: projectPath, method: "GET", body: projectFixture },
    { path: `${projectPath}/repos`, method: "GET", body: { items: [] } },
    { path: `${projectPath}/workspaces`, method: "GET", body: { workspaces: [] } },
    { path: `${projectPath}/assignments`, method: "GET", body: { assignments: [] } },
    { path: "/api/v1/pipelines", method: "GET", body: { pipelines: [] } },
    { path: `${projectPath}/issue-triggers`, method: "GET", body: { issue_triggers: [] } },
    { path: `${projectPath}/runs`, method: "GET", body: { runs: [] } },
    { path: `${projectPath}/artifacts`, method: "GET", body: { artifacts: [] } },
    { path: conversationPath, method: "GET", body: conversation },
    { path: `${conversationPath}/notes`, method: "GET", body: { notes: [] } },
  ];
}

function renderThread(conversation: Conversation, extra: RouteStub[] = []): void {
  mockFetch(routeStubs(conversation, extra));
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <ChatThread conversationId={conversationId} scope={projectFixture.id} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** Every `transcript-item` line currently in the transcript. */
async function transcriptRoot(): Promise<HTMLElement> {
  return await screen.findByTestId("transcript");
}

function items(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>("[data-testid='transcript-item']"));
}

describe("the transcript (ported from the thread page)", () => {
  it("updates a tool call in place as its status changes", async () => {
    renderThread(conversationFixture);
    await screen.findByTestId("chat-title");

    act(() => {
      FakeEventSource.last().emit(
        conversationEvent("conversation.tool.call", {
          tool_call_id: "toolu_01",
          title: "Edit internal/api/projects.go",
          kind: "edit",
          status: "in_progress",
          input_preview: "func list()",
        }),
      );
    });

    const transcript = await transcriptRoot();
    expect(items(transcript)).toHaveLength(1);
    expect(screen.getByTestId("tool-status-toolu_01").textContent).toBe("status: in_progress");
    // 6d: a tool call is one row; its output is behind a click, not on screen.
    expect(transcript.querySelector("[data-testid='tool-preview-input']")).toBeNull();
    fireEvent.click(screen.getByTestId("tool-row-toolu_01"));
    expect(screen.getByTestId("tool-preview-input").textContent).toContain("func list()");

    act(() => {
      FakeEventSource.last().emit(
        conversationEvent("conversation.tool.update", {
          tool_call_id: "toolu_01",
          status: "completed",
          output_preview: "written",
          update_seq: 1,
        }),
      );
    });

    // Same single row, now completed, and the output is on screen because the
    // row was expanded.
    expect(items(transcript)).toHaveLength(1);
    expect(screen.getByTestId("tool-status-toolu_01").textContent).toBe("status: completed");
    expect(transcript.textContent).toContain("written");
    expect(screen.getByTestId("tool-row-toolu_01").getAttribute("aria-expanded")).toBe("true");
  });

  it("renders no input block for the `{}` an ACP harness sends", async () => {
    renderThread(conversationFixture);
    await screen.findByTestId("chat-title");

    act(() => {
      const source = FakeEventSource.last();
      source.emit(
        conversationEvent("conversation.tool.call", {
          tool_call_id: "toolu_empty",
          title: "List files",
          kind: "execute",
          status: "in_progress",
          input_preview: "{}",
        }),
      );
      source.emit(
        conversationEvent("conversation.tool.update", {
          tool_call_id: "toolu_empty",
          status: "completed",
          output_preview: '{"a":1}',
        }),
      );
      source.emit(
        conversationEvent("conversation.tool.call", {
          tool_call_id: "toolu_real",
          title: "Edit secrets.go",
          kind: "edit",
          status: "in_progress",
          input_preview: '{"path":"internal/api/secrets.go"}',
        }),
      );
    });

    const root = await transcriptRoot();
    const rowFor = (title: string) => items(root).find((item) => item.textContent?.includes(title));
    const empty = rowFor("List files");
    expect(empty).toBeDefined();
    // Rows start collapsed (6d); expand them to see what the call carried.
    fireEvent.click(empty!.querySelector("[data-testid='tool-row-toolu_empty']") as HTMLElement);
    expect(empty!.querySelector("[data-testid='tool-preview-input']")).toBeNull();
    expect(empty!.querySelector("[data-testid='tool-preview-output']")?.textContent).toContain(
      '"a":1',
    );
    const real = rowFor("Edit secrets.go");
    fireEvent.click(real!.querySelector("[data-testid='tool-row-toolu_real']") as HTMLElement);
    expect(real!.querySelector("[data-testid='tool-preview-input']")?.textContent).toContain(
      "secrets.go",
    );
    // Nowhere in the transcript is a bare pair of braces standing in for content.
    expect(root.textContent).not.toContain("{}");
  });

  it("renders an agent message as a speaker block and cycles the tool output open", async () => {
    renderThread(conversationFixture);
    await screen.findByTestId("chat-title");

    act(() => {
      const source = FakeEventSource.last();
      source.emit(
        conversationEvent(
          "conversation.message.agent",
          { text: "Reading the tests.", final: true },
          { occurred_at: "2026-10-14T18:03:07Z" },
        ),
      );
      source.emit(
        conversationEvent("conversation.tool.call", {
          tool_call_id: "toolu_big",
          title: "go test ./...",
          kind: "execute",
          status: "in_progress",
        }),
      );
      source.emit(
        conversationEvent("conversation.tool.update", {
          tool_call_id: "toolu_big",
          status: "in_progress",
          output_preview: "line one\nline two\nline three\nline four\nline five",
        }),
      );
    });

    const speaker = await screen.findByTestId("agent-speaker");
    // The restyled transcript names the agent and the wall time in the
    // reader's zone (the full stamp rides the line's `title`).
    expect(speaker.textContent).toMatch(/^Claude Code · \d{2}:\d{2}$/);
    expect(speaker.getAttribute("title")).toContain("18:03:07");

    const row = screen.getByTestId("tool-row-toolu_big");
    expect(row.textContent).toContain("go test ./...");
    // Row one: collapsed. Row two: the head of the output. Row three: all of it.
    fireEvent.click(row);
    expect(screen.getByTestId("tool-preview-output").textContent).toBe(
      "line one\nline two\nline three",
    );
    fireEvent.click(screen.getByTestId("tool-show-all-toolu_big"));
    expect(screen.getByTestId("tool-preview-output").textContent).toContain("line five");
    expect(row.textContent).toContain("status: in_progress");
  });

  it("ellipsizes a long tool title and keeps the full text in the title", async () => {
    renderThread(conversationFixture);
    await screen.findByTestId("chat-title");

    const longTitle = "bash: npm run build -- --minify --source-map --target es2022";
    act(() => {
      FakeEventSource.last().emit(
        conversationEvent("conversation.tool.call", {
          tool_call_id: "toolu_long",
          title: longTitle,
          kind: "execute",
          status: "in_progress",
        }),
      );
    });

    const row = screen.getByTestId("tool-row-toolu_long");
    const title = Array.from(row.querySelectorAll("[title]")).find(
      (el) => el.getAttribute("title") === longTitle,
    ) as HTMLElement;
    // Long tool text is one line: ellipsized in the row, full text in the title.
    expect(title.className).toContain("truncate");
    expect(title.className).toContain("min-w-0");
    // The chevron + timing row keeps its own slot instead of pushing content out.
    const timing = screen.getByTestId("tool-timing-toolu_long");
    expect(timing.className).toContain("w-[72px]");
    expect(timing.className).toContain("shrink");
  });

  it("puts the agent's sentence under its speaker line, not 40px below it", async () => {
    renderThread(conversationFixture);
    await screen.findByTestId("chat-title");
    act(() => {
      FakeEventSource.last().emit(
        conversationEvent("conversation.message.agent", {
          turn_id: turnId,
          text: "\n\n\n\nOK",
          final: true,
        }),
      );
    });
    const item = await screen.findByTestId("transcript-item");
    expect(item.querySelector("p")?.textContent).toBe("OK");
    expect(item.querySelector("[data-testid='agent-speaker']")?.textContent).toContain(
      "Claude Code",
    );
  });

  it("says who it connected to by PROFILE name, and keeps the launcher in the tooltip", async () => {
    renderThread(conversationFixture);
    await screen.findByTestId("chat-title");
    act(() => {
      FakeEventSource.last().emit(
        conversationEvent("agent.session.connected", {
          binding_id: "b-1",
          worker_id: workerId,
          acp_session_id: "s-1",
          protocol_version: "0.4",
          launcher_id: claudeProfile.launcher_id,
        }),
      );
    });
    const line = (await screen.findByText(/^Connected to /)).closest("li[title]") as HTMLElement;
    expect(line.textContent).toContain("Connected to Claude Code");
    expect(line.getAttribute("title")).toBe(`launcher_id ${claudeProfile.launcher_id}`);
  });

  it("wears the launcher id itself when no read names it, never a guessed product", async () => {
    renderThread(conversationFixture);
    await screen.findByTestId("chat-title");
    act(() => {
      FakeEventSource.last().emit(
        conversationEvent("agent.session.connected", {
          binding_id: "b-9",
          worker_id: workerId,
          acp_session_id: "s-9",
          protocol_version: "0.4",
          launcher_id: "mystery",
        }),
      );
    });
    const line = (await screen.findByText(/^Connected to /)).closest("li[title]") as HTMLElement;
    expect(line.textContent).toContain("Connected to mystery");
  });

  it("writes a completed turn as one plain word, with the stop reason as the tooltip", async () => {
    renderThread(conversationFixture);
    await screen.findByTestId("chat-title");
    act(() => {
      FakeEventSource.last().emit(
        conversationEvent("conversation.turn.completed", {
          turn_id: turnId,
          worker_id: workerId,
          fencing_token: 7,
          stop_reason: "end_turn",
        }),
      );
    });
    const line = (await screen.findByText(/^Turn (completed|the agent)/)).closest(
      "li[title]",
    ) as HTMLElement;
    expect(line.textContent).toBe("Turn completed");
    expect(line.getAttribute("title")).toBe("stop_reason end_turn");
  });

  it("says what a token-limit stop means instead of printing the enum", async () => {
    renderThread(conversationFixture);
    await screen.findByTestId("chat-title");
    act(() => {
      FakeEventSource.last().emit(
        conversationEvent("conversation.turn.completed", {
          turn_id: turnId,
          stop_reason: "max_tokens",
        }),
      );
    });
    const line = (await screen.findByText(/^Turn (completed|the agent)/)).closest(
      "li[title]",
    ) as HTMLElement;
    expect(line.textContent).toContain("completed — the agent hit its token limit");
    expect(line.textContent).not.toContain("max_tokens");
    expect(line.getAttribute("title")).toBe("stop_reason max_tokens");
  });

  it("reports a disconnect in words and keeps the machine reason in the tooltip", async () => {
    renderThread(conversationFixture);
    await screen.findByTestId("chat-title");
    act(() => {
      FakeEventSource.last().emit(
        conversationEvent("agent.session.disconnected", {
          binding_id: "b-1",
          worker_id: workerId,
          acp_session_id: "s-1",
          reason: "agent_switched",
        }),
      );
    });
    const line = (await screen.findByText(/^The agent session closed/)).closest(
      "li[title]",
    ) as HTMLElement;
    expect(line.textContent).toContain(
      "The agent session closed — the thread's agent was switched",
    );
    expect(line.getAttribute("title")).toBe("reason agent_switched");
  });
});

/** The thread after a switch: Codex · gpt-5 runs the next turn. */
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

describe("the agent-switch divider (ported from the chat surface)", () => {
  it("cuts the transcript at the switch and words the divider exactly as ADR-0068 fixes it", async () => {
    renderThread(switchedConversation);
    await screen.findByTestId("chat-title");
    emitSwitchedTranscript();

    const divider = await screen.findByTestId("agent-switch-divider");
    expect(divider.textContent).toBe(
      "Ada Lovelace switched to Codex · gpt-5 · transcript and branch carried over",
    );

    // Two transcript runs: the divider splits the list, each run keeps its
    // own agent header — never one label painted over the other's turns.
    const lists = screen.getAllByTestId("transcript");
    expect(lists).toHaveLength(2);
    expect(lists[0].querySelector("[data-testid='agent-speaker']")?.textContent).toContain(
      "Claude Code · opus",
    );
    expect(lists[1].querySelector("[data-testid='agent-speaker']")?.textContent).toContain(
      "Codex · gpt-5",
    );
    // The divider sits inside the thread column, between the two runs.
    const thread = screen.getByTestId("chat-thread");
    expect(
      thread.compareDocumentPosition(divider) & Node.DOCUMENT_POSITION_CONTAINED_BY,
    ).toBeTruthy();
    expect(
      lists[0].compareDocumentPosition(divider) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      lists[1].compareDocumentPosition(divider) & Node.DOCUMENT_POSITION_PRECEDING,
    ).toBeTruthy();
  });

  it("renders no divider when no switch frame exists, and one run as before", async () => {
    renderThread(conversationFixture);
    await screen.findByTestId("chat-title");
    act(() => {
      FakeEventSource.last().emit(
        conversationEvent("conversation.message.agent", { text: "Reading.", final: true }),
      );
    });
    expect(screen.getAllByTestId("transcript")).toHaveLength(1);
    expect(screen.queryByTestId("agent-switch-divider")).toBeNull();
    expect(screen.getByTestId("agent-speaker").textContent).toContain("Claude Code");
  });
});

/** The failed-turn surface: one plain sentence, the server's words behind a
 * disclosure (error-details-r6). The old page drew it above the composer; the
 * transcript draws it in the same place it cut the raw line out of. */
const RAW =
  "worker: prepare workspace for project 01a19c73-99be-72da-b92b-4a74716530b2: " +
  "workspace: mirror /repos/01a19c73-99be-72da-b92b-4a74716530b2/server.git has no " +
  'branch "main" to base server on (ADR-0017 D2 refuses a branch-name guess)';

const NOT_SIGNED_IN =
  'worker: launcher "claude" is not signed in on this worker: the agent refused ' +
  "session/new because it requires a sign-in, JSON-RPC code -32000 \u2014 check this " +
  "launcher's credential directory on the worker that owns the turn";

describe("the failed turn (ported from the chat surface)", () => {
  it("prints one plain sentence and keeps the server's words behind Details", async () => {
    renderThread(conversationFixture);
    await screen.findByTestId("chat-title");
    act(() => {
      const source = FakeEventSource.last();
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
    expect(notice.querySelector("[data-testid='turn-failed-plain']")?.textContent).toBe(
      "This thread couldn't start its workspace: the repository has no default branch to start from.",
    );
    expect(notice.querySelector("[data-testid='turn-failed-plain']")?.textContent).not.toMatch(
      /01a19c73|\/repos\/|ADR-0017/,
    );
    // The fold's raw line is GONE from the transcript — the notice replaces it.
    for (const item of screen.queryAllByTestId("transcript-item")) {
      expect(item.textContent).not.toContain("worker: prepare workspace");
    }
    const details = notice.querySelector("details") as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(notice.querySelector("[data-testid='turn-failed-server']")?.textContent).toBe(
      `server said: ${RAW}`,
    );
    fireEvent.click(details.querySelector("summary") as HTMLElement);
    expect((notice.querySelector("details") as HTMLDetailsElement).open).toBe(true);
  });

  it("names the AGENT a sign-in refusal came from, in the words the member chose", async () => {
    renderThread(conversationFixture);
    await screen.findByTestId("chat-title");
    act(() => {
      const source = FakeEventSource.last();
      source.emit(
        conversationEvent("conversation.message.user", {
          turn_id: turnId,
          submitted_by: meFixture.id,
          text: "Run the specs.",
        }),
      );
      source.emit(
        conversationEvent("conversation.turn.failed", { turn_id: turnId, message: NOT_SIGNED_IN }),
      );
    });

    const notice = await screen.findByTestId("turn-failed");
    expect(notice.querySelector("[data-testid='turn-failed-plain']")?.textContent).toBe(
      "Claude Code isn't signed in on this worker, so this turn couldn't start.",
    );
    expect(notice.querySelector("[data-testid='turn-failed-server']")?.textContent).toContain(
      'launcher "claude" is not signed in',
    );
  });

  it("marks the agent run that failed in the Details sheet's AGENTS rows", async () => {
    // The AGENTS rows are ADR-0068's turn RANGES; the journal's turn rows are
    // the only thing that says how a turn in a range ended. ChatThread hands
    // `transcript.turns` to the panel — the rows live behind the header's
    // `…` → Details now.
    const oneTurnPerRun: Conversation = {
      ...conversationFixture,
      agents: [
        {
          agent_profile_id: claudeProfile.id,
          agent_profile_name: claudeProfile.name,
          model: "opus",
          first_turn: 1,
          last_turn: 1,
          turn_count: 1,
        },
        {
          agent_profile_id: codexProfile.id,
          agent_profile_name: codexProfile.name,
          model: "gpt-5",
          first_turn: 2,
          last_turn: 2,
          turn_count: 1,
        },
      ],
    };
    renderThread(oneTurnPerRun);
    await screen.findByTestId("chat-title");
    act(() => {
      const source = FakeEventSource.last();
      source.emit(
        conversationEvent("conversation.message.user", {
          turn_id: turnId,
          submitted_by: meFixture.id,
          text: "Start the workspace.",
        }),
      );
      source.emit(
        conversationEvent("conversation.turn.failed", { turn_id: turnId, message: NOT_SIGNED_IN }),
      );
    });
    await screen.findByTestId("turn-failed");

    fireEvent.click(screen.getByTestId("chat-menu"));
    fireEvent.click(await screen.findByTestId("chat-menu-details"));
    const panel = await screen.findByTestId("conversation-side-panel");
    await waitFor(() =>
      expect(
        panel.querySelector("[data-testid='side-panel-agent-state-0']")?.textContent,
      ).toContain("failed"),
    );
    expect(panel.querySelector("[data-testid='side-panel-agent-row-0']")?.textContent).toContain(
      "Claude Code",
    );
    expect(panel.querySelector("[data-testid='side-panel-agent-state-1']")).toBeNull();
  });
});

/** An agent message that served a plan (the m4-planner's real final text). */
const planText = JSON.stringify({
  plan: {
    goal: "Document and fix add() in app/hello.py",
    steps: [
      { id: 1, file: "app/hello.py", action: "Add a docstring to add()" },
      { id: 2, file: "app/tests/test_hello.py", action: "Correct the failing assertion" },
    ],
    risks: ["If the contract requires the test file unchanged, steps 1-2 conflict."],
  },
});

async function agentSays(text: string): Promise<HTMLElement> {
  renderThread(conversationFixture);
  await screen.findByTestId("chat-title");
  act(() => {
    FakeEventSource.last().emit(
      conversationEvent("conversation.message.agent", { text, final: true }),
    );
  });
  return screen.findByTestId("transcript");
}

describe("an agent message that served a plan (ported from the thread page)", () => {
  it("renders it as a plan, with the raw text one click away", async () => {
    const transcript = await agentSays(planText);
    expect(transcript.querySelector("[data-testid='plan-view']")).toBeTruthy();
    expect(transcript.querySelector("[data-testid='plan-goal']")?.textContent).toContain(
      "Document and fix add()",
    );
    expect(transcript.querySelectorAll("[data-testid^='plan-step-']").length).toBeGreaterThan(0);
    expect(transcript.textContent).not.toContain('{"plan":{"goal"');

    fireEvent.click(screen.getByTestId("agent-plan-toggle"));
    expect(screen.getByTestId("agent-plan-raw").textContent).toBe(planText);
    fireEvent.click(screen.getByTestId("agent-plan-toggle"));
    expect(transcript.querySelector("[data-testid='plan-view']")).toBeTruthy();
  });

  it("leaves every other message as the text it is", async () => {
    const transcript = await agentSays("Reading the failing spec now.");
    expect(transcript.querySelector("[data-testid='plan-view']")).toBeNull();
    expect(transcript.querySelector("[data-testid='agent-plan-toggle']")).toBeNull();
    expect(transcript.textContent).toContain("Reading the failing spec now.");
  });

  it("waits for a plan that has not fully arrived", async () => {
    const transcript = await agentSays(planText.slice(0, 40));
    expect(transcript.querySelector("[data-testid='plan-view']")).toBeNull();
    expect(transcript.textContent).toContain('{"plan":{"goal":');
  });

  it("reads a plan served without the envelope too", async () => {
    const bare = JSON.stringify({
      goal: "Split the billing job",
      steps: [{ id: 1, title: "Cut the cron entry", actions: ["remove the schedule"] }],
    });
    const transcript = await agentSays(bare);
    expect(transcript.querySelector("[data-testid='plan-goal']")?.textContent).toBe(
      "Split the billing job",
    );
    expect(transcript.querySelector("[data-testid='agent-plan-toggle']")).toBeTruthy();
  });
});
