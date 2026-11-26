/**
 * Search or ask (⌘K) + Quick chat + Hold-to-Talk tests (redesign R6).
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import CommandPalette, { openPalette } from "./CommandPalette";
import AssistantPopover from "./assistant/AssistantPopover";
import { openAsk } from "./assistant/askControl";
import { HOLD_TO_TALK_MS } from "./assistant/HoldToTalk";
import {
  flushAssistantSpeechReads,
  resetAssistantSpeechState,
  TRANSCRIPTIONS_PATH,
} from "./assistant/useDictation";
import { shortId } from "../api/names";
import {
  claudeProfile,
  codexProfile,
  conversationSummaryFixture,
  meFixture,
  mockFetch,
  projectFixture,
  requestsTo,
  type RouteStub,
} from "../test/fakes";
import {
  WIRE_CHILD_PIPELINE_ID,
  WIRE_RUN_ID,
  wirePipelineList,
  wireProjectId,
  wireRunList,
} from "../test/fixtures/m4/wire";

const wirePipelineId = WIRE_CHILD_PIPELINE_ID;

const runsPath = `/api/v1/projects/${wireProjectId}/runs`;
const assistantConversationsPath = "/api/v1/assistant/conversations";
const assistantMessagesPath = `${assistantConversationsPath}/conv-1/messages`;

const assistantConversation = {
  id: "conv-1",
  title: null,
  created_at: "2026-07-07T00:00:00Z",
  updated_at: "2026-07-07T00:00:00Z",
  last_message_at: null,
};

const turnAnswerFixture = {
  answer_markdown: "Two runs wait on you.\n\nBoth stop at `build_until_verified`.",
  links: [
    { label: "The workflow library", route: "/factory" },
    { label: "The stalled run", route: `/runs/${WIRE_RUN_ID}` },
  ],
  tool_calls: [
    { name: "approval.pending", summary: "Saw 2 pending approvals.", ok: true },
    { name: "run.list", summary: "Could not list the runs.", ok: false, reason: "not_found" },
  ],
  turn_id: "01TURN",
  degraded: null,
};

function turnMessagesBody(text: string) {
  return {
    messages: [
      {
        id: "m-1",
        kind: "user",
        payload: { kind: "user", text },
        created_at: "2026-07-07T00:00:01Z",
      },
      {
        id: "m-2",
        kind: "assistant",
        payload: { kind: "assistant", ...turnAnswerFixture },
        created_at: "2026-07-07T00:00:02Z",
      },
    ],
    next_cursor: null,
  };
}

const notConfiguredStub: RouteStub = {
  path: assistantMessagesPath,
  method: "POST",
  status: 503,
  body: {
    type: "https://communication.dev/errors/assistant-not-configured",
    title: "Assistant unavailable",
    status: 503,
    detail: "No model base URL is configured for this deployment.",
    degraded: "assistant_not_configured",
  },
};

const sampleChat = {
  ...conversationSummaryFixture,
  project_id: wireProjectId,
  origin: "manual" as const,
  title: "Investigate date parser failure on Feb 29",
};

function stubRoutes(extra: RouteStub[] = []): RouteStub[] {
  return [
    ...extra,
    { path: "/api/v1/me", body: meFixture },
    { path: "/api/v1/me/preferences", body: { assistant: { speech_auto_send: false } } },
    {
      path: "/api/v1/assistant/status",
      body: {
        chat_model: { configured: true, model: "test-chat" },
        speech_model: { configured: true, model: "test-asr" },
        decision_model: { configured: false, model: "" },
        workers: { online: 1, sandbox_mode: "off" },
        execution_mode: "inprocess",
        github_credentials: [],
        projects: { count: 1 },
        workflows: { count: 1, samples: 0, assigned: 1 },
      },
    },
    { path: "/api/v1/projects", body: { items: [projectFixture] } },
    { path: "/api/v1/conversations", body: { items: [sampleChat], next_cursor: null } },
    { path: "/api/v1/pipelines", body: wirePipelineList },
    { path: runsPath, body: wireRunList },
    { path: "/api/v1/agent-profiles", body: { items: [claudeProfile, codexProfile] } },
    {
      path: assistantConversationsPath,
      method: "GET",
      body: { conversations: [], next_cursor: null },
    },
  ];
}

function Where() {
  return <div data-testid="where">{useLocation().pathname}</div>;
}

function mountPalette(path = "/", extra: RouteStub[] = []) {
  const harness = mockFetch(stubRoutes(extra));
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <CommandPalette context="home" />
        <AssistantPopover />
        <Routes>
          <Route path="*" element={<Where />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return harness;
}

/** Tap Ctrl+K / Cmd+K (keydown + keyup). */
function tapChord(meta = false) {
  fireEvent.keyDown(window, { key: "k", ctrlKey: !meta, metaKey: meta });
  fireEvent.keyUp(window, { key: "k", ctrlKey: !meta, metaKey: meta });
}

class FakeRecognition {
  continuous = false;
  interimResults = false;
  lang = "";
  onresult: ((event: unknown) => void) | null = null;
  onerror: ((event: { error: string }) => void) | null = null;
  onend: (() => void) | null = null;

  start() {}
  stop() {
    this.onend?.();
  }
  abort() {}

  deliver(text: string) {
    this.onresult?.({
      resultIndex: 0,
      results: [{ isFinal: true, 0: { transcript: text } }],
    });
  }
}

const recognizers: FakeRecognition[] = [];

function stubBrowserSpeech() {
  recognizers.length = 0;
  class TrackedRecognition extends FakeRecognition {
    constructor() {
      super();
      recognizers.push(this);
    }
  }
  vi.stubGlobal("SpeechRecognition", TrackedRecognition);
}

beforeEach(() => {
  resetAssistantSpeechState();
  window.sessionStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  window.sessionStorage.clear();
});

describe("CommandPalette", () => {
  it("opens the jump palette on Ctrl+K tap with redesign pages, never Quick chat", async () => {
    mountPalette();
    expect(screen.queryByTestId("quick-chat")).toBeNull();
    expect(screen.queryByTestId("palette-root")).toBeNull();

    tapChord();
    const dialog = await screen.findByRole("dialog");
    expect(screen.queryByTestId("quick-chat")).toBeNull();

    // Quick chat can also open; ⌘K keeps belonging to the palette.
    openAsk();
    await screen.findByTestId("quick-chat");
    tapChord();
    expect(within(dialog).getByRole("option", { name: /^Home/ })).toBeTruthy();
    expect(within(dialog).getByRole("option", { name: /^Chats/ })).toBeTruthy();
    expect(within(dialog).getByRole("option", { name: /^Factory/ })).toBeTruthy();
    expect(within(dialog).getByText("Manage · Projects")).toBeTruthy();
    expect(within(dialog).getByText("Manage · Repositories")).toBeTruthy();
    expect(within(dialog).getByText("Manage · People & access")).toBeTruthy();
    expect(within(dialog).getByText("Manage · Runners")).toBeTruthy();
    expect(within(dialog).getByText("Manage · Agents & models")).toBeTruthy();
    expect(within(dialog).getByText("Manage · Secrets")).toBeTruthy();

    expect(within(dialog).queryByText("Today")).toBeNull();
    expect(within(dialog).queryByText("Catch up")).toBeNull();
    expect(within(dialog).queryByText("Threads")).toBeNull();
    expect(within(dialog).queryByText("Operations")).toBeNull();
    expect(within(dialog).queryByText("Inbox")).toBeNull();
    expect(within(dialog).queryByText("Board")).toBeNull();
    expect(within(dialog).queryByText("Library")).toBeNull();

    const input = screen.getByTestId("palette-input");
    expect(input.getAttribute("placeholder")).toBe("Search or ask…");
    expect(input.getAttribute("aria-controls")).toBe("palette-listbox");
    expect(input.getAttribute("aria-expanded")).toBe("true");
  });

  it("opens the palette on Ctrl+K on non-mac and on ⌘K on mac", async () => {
    mountPalette();
    tapChord(false);
    await screen.findByTestId("palette-root");
    cleanup();

    mountPalette();
    tapChord(true);
    await screen.findByTestId("palette-root");
    expect(screen.queryByTestId("quick-chat")).toBeNull();
  });

  it("uses the redesign routes for projects, chats, workflows, runs, and Manage", async () => {
    mountPalette();
    await act(async () => {
      openPalette();
    });
    const list = await screen.findByRole("listbox");

    // Project -> routes.scopeHome(id)
    const projOpt = (await within(list).findByText(projectFixture.name)).closest(
      '[role="option"]',
    ) as HTMLElement;
    fireEvent.click(projOpt);
    await waitFor(() =>
      expect(screen.getByTestId("where").textContent).toBe(`/p/${wireProjectId}`),
    );

    // Chat -> routes.chat(id, projectId)
    await act(async () => {
      openPalette();
    });
    const list2 = await screen.findByRole("listbox");
    const chatOpt = (await within(list2).findByText(sampleChat.title)).closest(
      '[role="option"]',
    ) as HTMLElement;
    fireEvent.click(chatOpt);
    await waitFor(() =>
      expect(screen.getByTestId("where").textContent).toBe(
        `/p/${wireProjectId}/chats/${sampleChat.id}`,
      ),
    );

    // Workflow -> routes.factoryWorkflow(id)
    await act(async () => {
      openPalette();
    });
    const list3 = await screen.findByRole("listbox");
    const wfOpt = (await within(list3).findByText("Module check")).closest(
      '[role="option"]',
    ) as HTMLElement;
    fireEvent.click(wfOpt);
    await waitFor(() =>
      expect(screen.getByTestId("where").textContent).toBe(`/factory/${wirePipelineId}`),
    );

    // Run -> routes.run(id)
    await act(async () => {
      openPalette();
    });
    const list4 = await screen.findByRole("listbox");
    const runOpt = (
      await within(list4).findByText(`feature-development #${shortId(WIRE_RUN_ID)}`)
    ).closest('[role="option"]') as HTMLElement;
    fireEvent.click(runOpt);
    await waitFor(() =>
      expect(screen.getByTestId("where").textContent).toBe(`/runs/${WIRE_RUN_ID}`),
    );
  });

  it("filters case-insensitively on the label and on the secondary line", async () => {
    mountPalette();
    openPalette();
    const input = await screen.findByTestId("palette-input");

    fireEvent.change(input, { target: { value: "MODU" } });
    const list = screen.getByRole("listbox");
    expect(await within(list).findByText("Module check")).toBeTruthy();
    expect(within(list).queryByText("Manage · Runners")).toBeNull();

    // "running" appears in no label — only in a run row's secondary text.
    fireEvent.change(input, { target: { value: "running" } });
    expect(
      await within(list).findByText(`feature-development #${shortId(WIRE_RUN_ID)}`),
    ).toBeTruthy();
    expect(within(list).queryByText("Chats")).toBeNull();
  });

  it("moves the router with ArrowDown and Enter, and closes when it goes", async () => {
    mountPalette();
    expect((await screen.findByTestId("where")).textContent).toBe("/");

    openPalette();
    const input = await screen.findByTestId("palette-input");
    await waitFor(() =>
      expect(input.getAttribute("aria-activedescendant")).toBe("palette-option-0"),
    );

    // Home (0), Chats (1), Factory (2), Manage · Projects (3)
    for (let i = 0; i < 3; i++) fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input.getAttribute("aria-activedescendant")).toBe("palette-option-3");
    expect(screen.getByRole("option", { selected: true }).textContent).toContain(
      "Manage · Projects",
    );

    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByTestId("where").textContent).toBe("/manage/projects");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("closes on Esc and on a press outside the panel", async () => {
    mountPalette();
    openPalette();
    const input = await screen.findByTestId("palette-input");
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();

    await act(async () => {
      openPalette();
    });
    await screen.findByRole("dialog");
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("closes on a press on the dimmed backdrop, and on Esc after focus left the input", async () => {
    mountPalette();
    await act(async () => {
      openPalette();
    });
    await screen.findByRole("dialog");
    fireEvent.mouseDown(screen.getByTestId("palette-backdrop"));
    expect(screen.queryByRole("dialog")).toBeNull();

    await act(async () => {
      openPalette();
    });
    const input = await screen.findByTestId("palette-input");
    input.blur();
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("prints the chord the host platform labels its modifier with", () => {
    const descriptor = Object.getOwnPropertyDescriptor(window.navigator, "platform");
    Object.defineProperty(window.navigator, "platform", { configurable: true, value: "MacIntel" });
    try {
      mountPalette();
      expect(screen.getByTestId("ask-box").textContent).toContain("⌘K");
    } finally {
      if (descriptor) Object.defineProperty(window.navigator, "platform", descriptor);
      else delete (window.navigator as unknown as { platform?: string }).platform;
      cleanup();
    }
    mountPalette();
    expect(screen.getByTestId("ask-box").textContent).toContain("Ctrl K");
  });

  describe("Ask row and default highlight rule", () => {
    it("renders Ask as the last row when query is non-empty, and highlights first result for short queries", async () => {
      mountPalette();
      openPalette();
      const input = await screen.findByTestId("palette-input");

      expect(screen.queryByTestId("palette-ask")).toBeNull();

      // Short prefix query matching "Factory" -> first result wins, Ask row is last.
      fireEvent.change(input, { target: { value: "Fac" } });
      const options = screen.getAllByRole("option");
      expect(options[0].textContent).toContain("Factory");
      expect(options[0].getAttribute("aria-selected")).toBe("true");
      const ask = options[options.length - 1];
      expect(ask.getAttribute("data-testid")).toBe("palette-ask");
      expect(ask.textContent).toContain("Ask: \u201CFac\u201D");
      expect(ask.textContent).toContain("↵");
      expect(ask.getAttribute("aria-selected")).toBe("false");

      // ArrowDown reaches the Ask row.
      fireEvent.keyDown(input, { key: "ArrowDown" });
      expect(screen.getByTestId("palette-ask").getAttribute("aria-selected")).toBe("true");
    });

    it("highlights Ask by default when query ends with '?' or has 4+ words without a prefix match", async () => {
      mountPalette();
      openPalette();
      const input = await screen.findByTestId("palette-input");

      // Question mark -> Ask wins even if a result matches in label/secondary.
      fireEvent.change(input, { target: { value: "Factory?" } });
      expect(screen.getByTestId("palette-ask").getAttribute("aria-selected")).toBe("true");

      // 4+ words with no result label starting with query -> Ask wins.
      fireEvent.change(input, { target: { value: "why did the runners stop" } });
      expect(screen.getByTestId("palette-ask").getAttribute("aria-selected")).toBe("true");
    });

    it("lets a matching 4+ word result label win over Ask by default", async () => {
      mountPalette();
      openPalette();
      const input = await screen.findByTestId("palette-input");
      await waitFor(() => expect(screen.getByText(sampleChat.title)).toBeTruthy());

      // Matches "Investigate date parser failure on Feb 29" (4+ words, label starts with query)
      fireEvent.change(input, { target: { value: "Investigate date parser failure" } });
      const options = screen.getAllByRole("option");
      expect(options[0].textContent).toContain(sampleChat.title);
      expect(options[0].getAttribute("aria-selected")).toBe("true");
      expect(screen.getByTestId("palette-ask").getAttribute("aria-selected")).toBe("false");
    });
  });

  it("posts the question with route context to Quick chat on Enter", async () => {
    const { requests } = mountPalette(`/p/${wireProjectId}/chats`, [
      { path: assistantConversationsPath, method: "POST", body: assistantConversation },
      {
        path: assistantMessagesPath,
        method: "POST",
        body: turnMessagesBody("what is failing here?"),
      },
    ]);
    openPalette();
    const input = await screen.findByTestId("palette-input");
    fireEvent.change(input, { target: { value: "what is failing here?" } });
    fireEvent.keyDown(input, { key: "Enter" });

    const quickChat = await screen.findByTestId("quick-chat");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(within(quickChat).getByTestId("assistant-msg-user").textContent).toContain(
      "what is failing here?",
    );
    const posted = requestsTo(requests, assistantMessagesPath, "POST");
    expect(posted).toHaveLength(1);
    expect(JSON.parse(posted[0].body ?? "{}")).toEqual({
      text: "what is failing here?",
      context: { route: `/p/${wireProjectId}/chats`, project_id: wireProjectId },
    });
  });

  it("says thinking… while the turn is in flight, then answers and jumps", async () => {
    const { requests } = mountPalette("/", [
      { path: assistantConversationsPath, method: "POST", body: assistantConversation },
      {
        path: assistantMessagesPath,
        method: "POST",
        body: turnMessagesBody("which runs wait on me?"),
      },
    ]);

    const responder = globalThis.fetch as unknown as (
      input: unknown,
      init?: RequestInit,
    ) => Promise<Response>;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.stubGlobal("fetch", async (input: unknown, init?: RequestInit) => {
      const response = await responder(input, init);
      if (String(input).includes("/messages")) await gate;
      return response;
    });

    openPalette();
    const input = await screen.findByTestId("palette-input");
    fireEvent.change(input, { target: { value: "which runs wait on me?" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await screen.findByTestId("quick-chat");
    expect((await screen.findByTestId("assistant-thinking")).textContent).toContain("thinking…");
    expect(screen.getByTestId("assistant-composer-input")).toBeTruthy();
    expect(requestsTo(requests, assistantMessagesPath, "POST")).toHaveLength(1);

    release();
    const answer = await screen.findByTestId("assistant-answer");
    expect(within(answer).getByText("Two runs wait on you.")).toBeTruthy();
    expect(within(answer).getByText("build_until_verified").tagName).toBe("CODE");

    const tools = screen.getByTestId("assistant-tools");
    expect(tools.textContent).toContain("used approval.pending, run.list");
    expect(tools.tagName).toBe("DETAILS");
    expect(tools.hasAttribute("open")).toBe(false);

    const link = screen.getAllByTestId("assistant-link")[0];
    expect(link.tagName).toBe("BUTTON");
    fireEvent.click(link);
    expect((await screen.findByTestId("where")).textContent).toBe("/factory");
  });

  it("keeps the jump list when the server has no assistant", async () => {
    mountPalette("/", [
      { path: assistantConversationsPath, method: "POST", body: assistantConversation },
      notConfiguredStub,
    ]);
    openPalette();
    const input = await screen.findByTestId("palette-input");

    fireEvent.change(input, { target: { value: "Runn" } });
    await screen.findByTestId("palette-ask");
    fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });

    const line = await screen.findByTestId("assistant-error");
    expect(line.textContent).toContain("isn't configured on this server");
    expect(line.textContent).not.toContain("model base URL");

    openPalette();
    expect(within(await screen.findByRole("listbox")).getByText("Manage · Runners")).toBeTruthy();
  });
});

describe("Hold ⌘K to talk integration", () => {
  it("hold >= 500ms opens Quick chat with capsule (no palette) and sends on release", async () => {
    vi.useFakeTimers();
    stubBrowserSpeech();
    const { requests } = mountPalette("/", [
      {
        path: "/api/v1/assistant/status",
        body: {
          chat_model: { configured: true, model: "test-chat" },
          speech_model: { configured: false, model: "" },
          decision_model: { configured: false, model: "" },
          workers: { online: 1, sandbox_mode: "off" },
          execution_mode: "inprocess",
          github_credentials: [],
          projects: { count: 1 },
          workflows: { count: 0, samples: 0, assigned: 0 },
        },
      },
      { path: assistantConversationsPath, method: "POST", body: assistantConversation },
      {
        path: assistantMessagesPath,
        method: "POST",
        body: turnMessagesBody("check relay status"),
      },
      { path: TRANSCRIPTIONS_PATH, method: "POST", body: { text: "" } },
    ]);
    await act(async () => {
      await flushAssistantSpeechReads();
    });

    fireEvent.keyDown(window, { key: "k", metaKey: true });
    act(() => {
      vi.advanceTimersByTime(HOLD_TO_TALK_MS);
    });

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByTestId("quick-chat")).toBeTruthy();
    expect(screen.getByTestId("listening-capsule")).toBeTruthy();

    const rec = recognizers[recognizers.length - 1];
    act(() => {
      rec.deliver("check relay status");
    });

    await act(async () => {
      fireEvent.keyUp(window, { key: "k", metaKey: true });
    });

    const posted = requestsTo(requests, assistantMessagesPath, "POST");
    expect(posted).toHaveLength(1);
    expect(JSON.parse(posted[0].body ?? "{}")).toMatchObject({
      text: "check relay status",
      spoken: true,
    });
  });

  it("falls back immediately to a tap when speech is unavailable", async () => {
    vi.useFakeTimers();
    mountPalette("/", [
      {
        path: "/api/v1/me/preferences",
        body: { assistant: { speech_browser_fallback: false } },
      },
      {
        path: "/api/v1/assistant/status",
        body: {
          chat_model: { configured: true, model: "test-chat" },
          speech_model: { configured: false, model: "" },
          decision_model: { configured: false, model: "" },
          workers: { online: 1, sandbox_mode: "off" },
          execution_mode: "inprocess",
          github_credentials: [],
          projects: { count: 1 },
          workflows: { count: 0, samples: 0, assigned: 0 },
        },
      },
    ]);
    await act(async () => {
      await flushAssistantSpeechReads();
    });

    fireEvent.keyDown(window, { key: "k", metaKey: true });
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.queryByTestId("quick-chat")).toBeNull();
  });
});

describe("where the trigger and the panel live (design review pass 2)", () => {
  it("mounts the trigger in flow, so it can only ever sit in the header it is placed in", async () => {
    mountPalette();
    const box = screen.getByTestId("ask-box");
    expect(box.closest('[class*="fixed"]')).toBeNull();
    expect(box.closest('[class*="absolute"]')).toBeNull();
    expect(box.className).toContain("sm:flex");
    expect(box.className).not.toMatch(/\b(fixed|absolute)\b/);
  });

  it("anchors the panel to the viewport and keeps it open for a press inside it", async () => {
    mountPalette();
    await act(async () => {
      openPalette();
    });
    const dialog = await screen.findByRole("dialog");
    expect(dialog.parentElement?.parentElement).toBe(document.body);
    expect(dialog.className).toContain("fixed");
    fireEvent.mouseDown(screen.getByTestId("palette-input"));
    expect(screen.getByRole("dialog")).toBeTruthy();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
