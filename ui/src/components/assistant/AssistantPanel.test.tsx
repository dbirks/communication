import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render as baseRender,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement, ReactNode } from "react";
import AssistantPanel, {
  AssistantPageFrame,
  AssistantPageSideColumn,
  AssistantThreadColumn,
  type AssistantPanelProps,
  type RecentConversation,
} from "./AssistantPanel";
import type { AssistantMessage } from "./types";

/**
 * The empty thread is the setup checklist now (handoff A3 §2), and the
 * checklist owns its own `GET /assistant/status` read — so every panel render
 * needs a query client, and a test that has not said anything about the status
 * route answers 404 (the checklist renders nothing, exactly as it does on a
 * server without the route).
 */
const panelQuery = () =>
  new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });

const withQuery = (element: ReactElement, client = panelQuery()) => (
  <QueryClientProvider client={client}>{element}</QueryClientProvider>
);

/**
 * Every render goes through one provider (and the same wrapper survives a
 * `rerender`), because the panel's empty thread now mounts the checklist with
 * its own status read.
 */
function render(element: ReactElement) {
  const client = panelQuery();
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return baseRender(element, { wrapper: Wrapper });
}

/** A `GET` answer for any path; the panel tests' default: nothing is set up. */
function stubStatusNotFound(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify({ title: "Not Found", status: 404, detail: "no stub" }), {
          status: 404,
          headers: { "content-type": "application/problem+json" },
        }),
    ),
  );
}

beforeEach(() => {
  stubStatusNotFound();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.sessionStorage.clear();
});

const panelProps: Omit<AssistantPanelProps, "variant"> = {
  contextLabel: "home",
  messages: [],
  trustLevel: "ask_risky",
  onTrustLevelChange: () => {},
  onSend: () => {},
  onAnswerQuestion: () => {},
  onConfirmApproval: () => {},
  onDismissApproval: () => {},
  onGo: () => {},
  onClose: () => {},
};

const renderPanel = (props: Partial<typeof panelProps> = {}) =>
  render(<AssistantPanel variant="popover" {...panelProps} {...props} />);

const userMessage = (text: string): AssistantMessage => ({
  id: "m-user",
  kind: "user",
  payload: { kind: "user", text },
  created_at: "2026-10-20T10:00:00Z",
});

const questionMessage = (): AssistantMessage => ({
  id: "m-q",
  kind: "question",
  payload: {
    kind: "question",
    prompt: "Stricter how? Pick one.",
    options: [
      { label: "Fail review on any auth finding", value: "fail_any" },
      { label: "Add an OWASP checklist", value: "owasp" },
    ],
    allow_free_text: true,
    answered_by: null,
  },
  created_at: "2026-10-20T10:00:10Z",
});

const composerValue = () =>
  (screen.getByTestId("assistant-composer-input") as HTMLInputElement).value;

/** Let pending send promises (and the draft restore they trigger) settle. */
const flush = async () => {
  await act(async () => {
    await Promise.resolve();
  });
};

describe("AssistantPanel (popover)", () => {
  it("is the 400px popover whose header is five icon buttons (handoff §1)", () => {
    const onDock = vi.fn();
    const onExpandPage = vi.fn();
    const onClose = vi.fn();
    const { container } = renderPanel({
      onDock,
      onExpandPage,
      onClose,
      onNewConversation: () => {},
      onSwitchConversation: () => {},
    });
    const panel = container.querySelector('[data-testid="assistant-panel"]') as HTMLElement;
    expect(panel.dataset.variant).toBe("popover");
    // Corners: the box clips its own children, and the 400px width, radius 4
    // and 2px offset ink shadow are the design's frame.
    expect(panel.className).toContain("overflow-hidden");
    expect(panel.className).toContain("rounded-[4px]");
    expect(panel.className).toContain("border-ink");
    expect(panel.className).toContain("shadow-raised");
    expect(panel.className).toContain("max-h-[min(72vh,600px)]");

    const header = screen.getByTestId("assistant-panel-header");
    expect(header.textContent).toContain("ASSISTANT");
    // Design L131–137 (review fix 3): the popover header is ONLY the mono
    // ASSISTANT label — no thread title. The title lives in the side panel
    // and the full page, which show ONLY the title.
    expect(screen.queryByTestId("assistant-thread-title")).toBeNull();
    // The old text controls are gone: no ▾ Recent menu, no ⤢, no `esc` hint.
    expect(header.textContent).not.toContain("esc");
    expect(header.textContent).not.toContain("▾");
    expect(header.textContent).not.toContain("Recent");
    // Handoff §1: the trust pill lives in the composer box, not the header.
    expect(screen.getByTestId("assistant-pill").textContent).toContain("Ask when risky");
    expect(
      screen.getByTestId("assistant-panel-header").contains(screen.getByTestId("assistant-pill")),
    ).toBe(false);
    expect(
      screen.getByTestId("assistant-composer").contains(screen.getByTestId("assistant-pill")),
    ).toBe(true);

    // Five 26px buttons, each naming itself in `title` + the accessible name,
    // every glyph an SVG (no Unicode glyph icons).
    const buttons: Array<[string, string]> = [
      ["assistant-new-conversation", "New thread"],
      ["assistant-history", "Threads"],
      ["assistant-dock", "Open as side panel"],
      ["assistant-expand", "Open full page"],
      ["assistant-close", "Close"],
    ];
    for (const [testid, title] of buttons) {
      const button = screen.getByTestId(testid) as HTMLButtonElement;
      expect(button.title, testid).toBe(title);
      expect(button.getAttribute("aria-label"), testid).toBe(title);
      expect(button.querySelector("svg"), testid).toBeTruthy();
      expect(button.textContent ?? "", testid).toBe("");
    }
    expect(header.querySelectorAll("button")).toHaveLength(5);
    // No New-thread callback (a mount that cannot start a thread) drops its
    // button and the Threads button with it (nothing to switch to).
    fireEvent.click(screen.getByTestId("assistant-dock"));
    expect(onDock).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId("assistant-expand"));
    expect(onExpandPage).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId("assistant-close"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("esc closes the panel through the window listener", () => {
    const onClose = vi.fn();
    renderPanel({ onClose });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    // other keys do nothing
    fireEvent.keyDown(window, { key: "a" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("an empty thread is the setup checklist, not a chip table (handoff §1/§2)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              chat_model: { configured: true, model: "qwen3-8-flash-next" },
              speech_model: { configured: false, model: "" },
              decision_model: { configured: false, model: "" },
              workers: { online: 1, sandbox_mode: "required" },
              execution_mode: "inprocess",
              github_credentials: [],
              projects: { count: 0 },
              workflows: { count: 0, samples: 0, assigned: 0 },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      ),
    );
    try {
      const onSend = vi.fn();
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false, gcTime: 0 } },
      });
      render(
        <QueryClientProvider client={queryClient}>
          <AssistantPanel variant="popover" {...panelProps} onSend={onSend} />
        </QueryClientProvider>,
      );
      expect(await screen.findByTestId("assistant-setup")).toBeTruthy();
      // The retired table's chips are gone (see ui/scripts/retired-testids.json).
      expect(screen.queryAllByTestId("assistant-suggest")).toHaveLength(0);
      expect(screen.queryByTestId("assistant-empty")).toBeNull();
      // The checklist's starters send through the normal send path.
      fireEvent.click(screen.getAllByTestId("assistant-starter")[0]);
      expect(onSend).toHaveBeenCalledWith("What workflows do I have?");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("shows the page context chip in the composer", () => {
    renderPanel({ contextLabel: "run 9c1e" });
    expect(screen.getByTestId("assistant-context-chip").textContent).toBe("run 9c1e");
  });

  it("sends the typed draft on Send and on Enter, and clears it", () => {
    const onSend = vi.fn();
    const onGo = vi.fn();
    renderPanel({ onSend, onGo, messages: [userMessage("hi")] });
    const input = screen.getByTestId("assistant-composer-input");
    expect(screen.getByText("hi").closest('[data-testid="assistant-msg-user"]')).toBeTruthy();
    fireEvent.change(input, { target: { value: "  add a reviewer  " } });
    fireEvent.keyDown(input, { key: "Enter" });
    // The composer's send names what came with the ask (CONTRACT §2/§4).
    expect(onSend).toHaveBeenCalledWith("add a reviewer", {
      spoken: false,
      context: { route: "/", page: { label: "Today" } },
    });
    expect((input as HTMLInputElement).value).toBe("");
    expect((screen.getByTestId("assistant-send") as HTMLButtonElement).disabled).toBe(true);
  });

  it("always offers the mic — the server reads the audio, not the browser", () => {
    // jsdom has neither SpeechRecognition nor MediaRecorder. Handoff §5 still
    // draws the mic (it is how dictation is attempted at all); the honest
    // failure is the line under the box, not a missing control.
    renderPanel();
    expect(screen.getByTestId("mic-button")).toBeTruthy();
    expect(screen.getByTestId("mic-button").className).toContain("h-[30px]");
  });

  it("shows the change chip above the composer when the conversation has changes", () => {
    renderPanel({
      messages: [userMessage("add a reviewer")],
      changes: [
        {
          id: "chg-1",
          kind: "draft_edit",
          target_ref: "draft:01K1",
          summary: "+ step security-reviewer 1.0.0",
          undoable: true,
          undone_at: null,
          created_at: "2026-10-20T10:00:00Z",
        },
      ],
    });
    expect(screen.getByTestId("assistant-change-chip-toggle").textContent).toContain("1 change");
  });
});

describe("the composer placeholder fits the width (rcn-2f review item 2)", () => {
  // Answer the shell's narrow query as a `width` px viewport would — the
  // composer row at phone width (390) also holds the mic and Send, so the
  // long wording clipped mid-word; below the app's phone cut the row
  // answers with the shorter one.
  const viewport = (width: number) =>
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: width < 1024 && query.includes("max-width"),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      onchange: null,
      dispatchEvent: () => false,
    }));

  it("keeps the full wording at a wide panel", () => {
    viewport(1280);
    try {
      renderPanel();
      const input = screen.getByTestId("assistant-composer-input") as HTMLInputElement;
      // The one-box composer gives the textarea the whole width, so the row
      // cannot clip the wording any more: one placeholder at every width.
      expect(input.placeholder).toBe("Ask anything, or use the mic…");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("shortens at phone width so the row fits", () => {
    viewport(390);
    try {
      renderPanel();
      const input = screen.getByTestId("assistant-composer-input") as HTMLInputElement;
      expect(input.placeholder).toBe("Ask anything, or use the mic…");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("AssistantPanel (page and dock)", () => {
  /**
   * Handoff §1: the full page's centre column is the conversation at ≤720px,
   * the composer's box at ≤752px, and the header carries the thread title (no
   * `ASSISTANT` word, no `opened from` chip — the thread list is right there).
   */
  it("page: the centred 720px column, the thread title, the Exit-full-page verb", () => {
    const { container } = render(
      withQuery(
        <AssistantPanel
          variant="page"
          {...panelProps}
          contextLabel="Feature Delivery"
          recentConversations={[{ id: "c1", title: "Fix the board", lastMessageAt: null }]}
          activeConversationId="c1"
          onExpandPage={() => {}}
          onDock={() => {}}
          onNewConversation={() => {}}
          onSwitchConversation={() => {}}
          showThreadControls={false}
        />,
      ),
    );
    const panel = container.querySelector('[data-testid="assistant-panel"]') as HTMLElement;
    expect(panel.dataset.variant).toBe("page");
    // The conversation column, centred at the design's 720px.
    const column = panel.querySelector('[data-testid="assistant-body"] > div') as HTMLElement;
    expect(column.className).toContain("max-w-[720px]");
    expect(column.className).toContain("mx-auto");
    // The composer's own box is the 752px column with the page's padding.
    const composerFrame = screen.getByTestId("assistant-composer-frame");
    expect(composerFrame.className).toContain("max-w-[752px]");
    expect(composerFrame.className).toContain("pb-[18px]");
    // The header names the thread; the popover's word does not appear.
    const header = screen.getByTestId("assistant-panel-header");
    expect(header.textContent).not.toContain("ASSISTANT");
    const title = screen.getByTestId("assistant-thread-title");
    // Design L134: the wide headers' title is 13.5px/600, ellipsized.
    expect(title.className).toContain("text-[13.5px]");
    expect(title.className).toContain("font-semibold");
    expect(title.className).toContain("truncate");
    expect(title.textContent).toBe("Fix the board");
    // Below ~1000px the caller hides the thread list and returns the thread
    // buttons to the header (`showThreadControls`); here they are the page's
    // left column, so the header draws the other three.
    expect(screen.queryByTestId("assistant-new-conversation")).toBeNull();
    expect(screen.queryByTestId("assistant-history")).toBeNull();
    const expand = screen.getByTestId("assistant-expand") as HTMLButtonElement;
    expect(expand.title).toBe("Exit full page");
    expect(expand.getAttribute("aria-label")).toBe("Exit full page");
    expect(screen.getByTestId("assistant-dock").title).toBe("Open as side panel");
    expect(screen.getByTestId("assistant-close").title).toBe("Close");
  });

  it("page on a narrow viewport: New thread and Threads come back to the header", () => {
    render(
      <AssistantPanel
        variant="page"
        {...panelProps}
        onNewConversation={() => {}}
        onSwitchConversation={() => {}}
        showThreadControls
      />,
    );
    expect(screen.getByTestId("assistant-new-conversation")).toBeTruthy();
    expect(screen.getByTestId("assistant-history")).toBeTruthy();
  });

  /**
   * rcn-2f review item 1 / handoff §1: the side panel is the same conversation
   * laid out for the 450px column it is handed — it fills that width instead of
   * centring a column inside it, and its header is the popover's five icon
   * buttons with the side-panel control reading `Back to popover` (pressed).
   */
  it("dock: fills the column it is handed, with the five icon header buttons", () => {
    const onDock = vi.fn();
    const { container } = render(
      <AssistantPanel
        variant="dock"
        {...panelProps}
        contextLabel="threads"
        onDock={onDock}
        onExpandPage={() => {}}
        onNewConversation={() => {}}
        onSwitchConversation={() => {}}
      />,
    );
    const panel = container.querySelector('[data-testid="assistant-panel"]') as HTMLElement;
    expect(panel.dataset.variant).toBe("dock");
    // No centred column: the dock's own width is the conversation's. And it
    // FILLS the column it is handed (finding 1) — its own scroll is the body,
    // the composer sits at the bottom of the 450px sheet.
    expect(panel.className).toContain("w-full");
    expect(panel.className).toContain("h-full");
    expect(panel.className).toContain("min-h-0");
    const header = screen.getByTestId("assistant-panel-header");
    // Review fix 3 (design L131–137): the side panel shows ONLY the thread
    // title — the popover's `ASSISTANT` label does NOT ride along (reverts
    // the earlier "dock shows ASSISTANT" change). An untitled thread is
    // "New thread" — the page section (`threads`, `today`) belongs to the
    // page-context button, not the header.
    expect(header.textContent).not.toContain("ASSISTANT");
    expect(screen.getByTestId("assistant-thread-title").textContent).toBe("New thread");
    // Review fix 3: the dock header is ~38px — the popover's 6/8/6/10 padding
    // around the 26px buttons (the page header's is 10/16).
    expect(header.className).toContain("pt-[6px]");
    expect(header.className).toContain("pl-[10px]");
    expect(header.className).toContain("pr-[8px]");
    const dock = screen.getByTestId("assistant-dock") as HTMLButtonElement;
    expect(dock.title).toBe("Back to popover");
    expect(dock.getAttribute("aria-label")).toBe("Back to popover");
    expect(dock.getAttribute("aria-pressed")).toBe("true");
    // Review fix 4 (prototype ibOn): the pressed header button is the pale
    // LINE fill (#e6e2d9), not the darker fill-edge.
    expect(dock.className).toContain("bg-line");
    expect(dock.className).not.toContain("bg-fill-edge");
    expect(screen.getByTestId("assistant-new-conversation").title).toBe("New thread");
    expect(screen.getByTestId("assistant-history").title).toBe("Threads");
    expect(screen.getByTestId("assistant-expand").title).toBe("Open full page");
    expect(screen.getByTestId("assistant-close").title).toBe("Close");
    fireEvent.click(dock);
    expect(onDock).toHaveBeenCalledTimes(1);
  });

  /**
   * Review fix 4 (prototype threadsBtnStyle = ibOn while the menu is open):
   * the Threads button takes the same pale line fill while its menu stands.
   */
  it("threads button takes the pale pressed fill while its menu is open", () => {
    render(
      <AssistantPanel
        variant="dock"
        {...panelProps}
        onSwitchConversation={() => {}}
        onThreadsMenuOpenChange={() => {}}
        threadsMenuOpen
        recentConversations={[{ id: "c1", title: "Fix the board", lastMessageAt: null }]}
        activeConversationId="c1"
      />,
    );
    const history = screen.getByTestId("assistant-history") as HTMLButtonElement;
    expect(history.getAttribute("aria-pressed")).toBe("true");
    expect(history.className).toContain("bg-line");
    expect(history.className).not.toContain("bg-fill-edge");
  });

  /**
   * rcn-6 review: a surface opened FROM a chat names THAT chat in the header,
   * not the bare section name — until the thread has a title of its own.
   */
  it("dock from a chat: the header names the chat, not the section", () => {
    render(
      <AssistantPanel
        variant="dock"
        {...panelProps}
        contextLabel="threads"
        chatContext="Refactor the settings page"
      />,
    );
    expect(screen.getByTestId("assistant-thread-title").textContent).toBe(
      "Refactor the settings page",
    );
  });

  it("esc closes the wide surface too, and a busy turn shows thinking…", () => {
    const onClose = vi.fn();
    renderPanel({ onClose, busy: true, messages: [userMessage("hi")] });
    expect(screen.getByTestId("assistant-thinking").textContent).toBe("thinking…");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  /**
   * rcn-2f round 7: the `Open draft` action beside the composer — the design's
   * `Or tell me what to change… Open draft` row. It links the REAL library
   * draft the assistant saved: the server tags the creating answer's link
   * `Open draft` (workflow.create_draft → links[]), so the button is hidden
   * until such a turn exists, never a door to an unsaved draft.
   */
  const savedDraftMessage = (route: string): AssistantMessage => ({
    id: "m-saved",
    kind: "assistant",
    payload: {
      kind: "assistant",
      answer_markdown: "Draft saved in the library.",
      links: [{ label: "Open draft", route }],
      tool_calls: [],
    },
    created_at: "2026-10-20T10:02:00Z",
  });

  it("Open draft: hidden until a turn links the saved draft, then opens it (2f)", () => {
    const onGo = vi.fn();
    const { rerender } = render(<AssistantPanel variant="dock" {...panelProps} onGo={onGo} />);
    expect(screen.queryByTestId("assistant-open-draft")).toBeNull();
    rerender(
      <AssistantPanel
        variant="dock"
        {...panelProps}
        onGo={onGo}
        messages={[savedDraftMessage("/workflows/01PIPE")]}
      />,
    );
    const button = screen.getByTestId("assistant-open-draft");
    expect(button.textContent).toBe("Open draft");
    fireEvent.click(button);
    expect(onGo).toHaveBeenCalledWith("/workflows/01PIPE");
  });

  it("Open draft: the newest saved draft supersedes the earlier door", () => {
    const onGo = vi.fn();
    render(
      <AssistantPanel
        variant="dock"
        {...panelProps}
        onGo={onGo}
        messages={[savedDraftMessage("/workflows/01OLD"), savedDraftMessage("/workflows/01NEW")]}
      />,
    );
    fireEvent.click(screen.getByTestId("assistant-open-draft"));
    expect(onGo).toHaveBeenCalledWith("/workflows/01NEW");
  });

  it("Open draft: a draft link with a non-`Open draft` label is still the draft door — the target decides (rcn-review13-2f)", () => {
    const onGo = vi.fn();
    const rawLabelled: AssistantMessage = {
      id: "m-raw",
      kind: "assistant",
      payload: {
        kind: "assistant",
        answer_markdown: "Saved it to the library.",
        // the round-13 shape: the server's own target, a label that is the
        // raw path itself
        links: [{ label: "/workflows/pl-9/drafts/d-13", route: "/workflows/pl-9/drafts/d-13" }],
        tool_calls: [],
      },
      created_at: "2026-10-20T10:02:00Z",
    };
    render(
      <QueryClientProvider client={new QueryClient()}>
        <AssistantPanel variant="dock" {...panelProps} onGo={onGo} messages={[rawLabelled]} />
      </QueryClientProvider>,
    );
    const button = screen.getByTestId("assistant-open-draft");
    expect(button.textContent).toBe("Open draft");
    fireEvent.click(button);
    expect(onGo).toHaveBeenCalledWith("/workflows/pl-9/drafts/d-13");
  });

  it("Open draft: a non-draft link with an `Open draft`-ish label is not the door", () => {
    const onGo = vi.fn();
    render(
      <AssistantPanel
        variant="dock"
        {...panelProps}
        onGo={onGo}
        messages={[
          {
            id: "m-run",
            kind: "assistant",
            payload: {
              kind: "assistant",
              answer_markdown: "Started the run.",
              links: [{ label: "Open draft PR", route: "/runs/r-1" }],
              tool_calls: [],
            },
            created_at: "2026-10-20T10:02:00Z",
          },
        ]}
      />,
    );
    expect(screen.queryByTestId("assistant-open-draft")).toBeNull();
    expect(onGo).not.toHaveBeenCalled();
  });

  it("Open draft: the 400px popover's row stays dense — the draft door rides the transcript link there", () => {
    renderPanel({ messages: [savedDraftMessage("/workflows/01PIPE")] });
    expect(screen.queryByTestId("assistant-open-draft")).toBeNull();
  });

  /**
   * rcn-review17-2f: the wide panel showed the saved draft TWICE — the
   * footer's `Open draft` button and, straight under the step list, a link row
   * in the same style as the steps. One door, one control; the popover, which
   * has no room for the button, keeps the row as the draft's only way in.
   */
  it("Open draft: the wide panel's button is the draft's only door; the popover keeps the transcript row", () => {
    const draftAndOther: AssistantMessage = {
      id: "m-r17",
      kind: "assistant",
      payload: {
        kind: "assistant",
        answer_markdown: "Drafted it in the library.",
        links: [
          { label: "Open draft", route: "/workflows/pl-9/drafts/d-9" },
          { label: "Agent profiles", route: "/profiles" },
        ],
        tool_calls: [],
      },
      created_at: "2026-10-20T10:02:00Z",
    };
    const withQuery = (panel: ReactElement) => (
      <QueryClientProvider client={new QueryClient()}>{panel}</QueryClientProvider>
    );
    const { unmount } = render(
      withQuery(<AssistantPanel variant="dock" {...panelProps} messages={[draftAndOther]} />),
    );
    expect(screen.getByTestId("assistant-open-draft").textContent).toBe("Open draft");
    const rows = screen.getAllByTestId("assistant-link");
    expect(rows.map((row) => row.textContent)).toEqual([expect.stringContaining("Agent profiles")]);
    unmount();

    render(
      withQuery(<AssistantPanel variant="popover" {...panelProps} messages={[draftAndOther]} />),
    );
    expect(screen.queryByTestId("assistant-open-draft")).toBeNull();
    expect(screen.getAllByTestId("assistant-link")).toHaveLength(2);
  });
});

/**
 * ui-newconv: the header's `New thread` control and the Recent menu
 * (the caller's last 5 threads by title + age, newest first).
 */
describe("AssistantPanel header controls (handoff §1)", () => {
  const recent: RecentConversation[] = [
    { id: "c1", title: "Fix the board", lastMessageAt: "2026-07-07T09:00:00Z" },
    { id: "c2", title: null, lastMessageAt: null },
  ];

  const renderWithThreads = (props: Partial<typeof panelProps> = {}) =>
    render(
      <AssistantPanel
        variant="popover"
        {...panelProps}
        onNewConversation={() => {}}
        onSwitchConversation={() => {}}
        recentConversations={recent}
        activeConversationId="c1"
        {...props}
      />,
    );

  it("the Threads button toggles the menu through the caller's state", () => {
    const onOpenChange = vi.fn();
    renderWithThreads({ onThreadsMenuOpenChange: onOpenChange, threadsMenuOpen: false });
    expect(screen.queryByTestId("assistant-history-menu")).toBeNull();
    const trigger = screen.getByTestId("assistant-history") as HTMLButtonElement;
    expect(trigger.getAttribute("aria-pressed")).toBeNull();
    fireEvent.click(trigger);
    expect(onOpenChange).toHaveBeenCalledWith(true);
  });

  /**
   * Handoff §1's corners rule, the part that used to be a bug: the popover
   * clips (`overflow: hidden`), so a menu inside it is a menu with its rows
   * cut off. The threads box is rendered as a SIBLING of the panel element.
   */
  it("the threads menu is a sibling of the overflow-hidden panel, not inside it", () => {
    renderWithThreads({ threadsMenuOpen: true });
    const menu = screen.getByTestId("assistant-history-menu");
    const panel = screen.getByTestId("assistant-panel");
    expect(panel.className).toContain("overflow-hidden");
    expect(panel.contains(menu)).toBe(false);
    // 300px wide, the ds box: white, ink border, radius 4, the 2px shadow.
    expect(menu.className).toContain("w-[300px]");
    expect(menu.className).toContain("border-ink");
    expect(menu.className).toContain("shadow-raised");
    // The 9px rotated-square arrow rides with the box, centred on the button.
    const arrow = screen.getByTestId("menu-arrow") as HTMLElement;
    expect(arrow.style.width).toBe("9px");
    expect(arrow.style.transform).toContain("rotate(45deg)");
  });

  it("lists the threads by title + age, checks the current one, and switches", () => {
    const onSwitch = vi.fn();
    renderWithThreads({ threadsMenuOpen: true, onSwitchConversation: onSwitch });
    const items = screen.getAllByTestId("assistant-history-item");
    expect(items).toHaveLength(2);
    expect(items[0].textContent).toContain("Fix the board");
    expect(items[1].textContent).toContain("New thread");
    expect(items[1].textContent).not.toContain("unknown age");
    // The current row is the accent wash, a semibold title and the Tabler check.
    expect(items[0].className).toContain("bg-accent-wash");
    expect(items[0].firstElementChild?.className).toContain("font-semibold");
    expect(items[0].querySelector("svg")).toBeTruthy();
    expect(items[1].querySelector("svg")).toBeNull();
    fireEvent.click(items[1]);
    expect(onSwitch).toHaveBeenCalledWith("c2");
  });

  it("the search field filters the rows by title", () => {
    renderWithThreads({ threadsMenuOpen: true });
    fireEvent.change(screen.getByTestId("assistant-history-search"), {
      target: { value: "board" },
    });
    const items = screen.getAllByTestId("assistant-history-item");
    expect(items).toHaveLength(1);
    expect(items[0].textContent).toContain("Fix the board");
    fireEvent.change(screen.getByTestId("assistant-history-search"), {
      target: { value: "nothing matches" },
    });
    expect(screen.queryAllByTestId("assistant-history-item")).toHaveLength(0);
    expect(screen.getByTestId("assistant-history-menu").textContent).toContain(
      "No thread matches that search",
    );
  });

  it("the menu's New thread row starts a fresh thread and closes the menu", () => {
    const onNew = vi.fn();
    const onClose = vi.fn();
    renderWithThreads({
      threadsMenuOpen: true,
      onNewConversation: onNew,
      onThreadsMenuOpenChange: onClose,
    });
    fireEvent.click(screen.getByTestId("assistant-menu-new-thread"));
    expect(onNew).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledWith(false);
  });

  it("says so honestly when the caller has no threads at all", () => {
    renderWithThreads({ threadsMenuOpen: true, recentConversations: [] });
    expect(screen.getByTestId("assistant-history-menu").textContent).toContain(
      "No threads yet — the next answer starts one.",
    );
  });

  it("esc in the threads menu closes only the menu, then the panel", () => {
    const onClose = vi.fn();
    const onMenuChange = vi.fn();
    renderWithThreads({ onClose, onThreadsMenuOpenChange: onMenuChange, threadsMenuOpen: true });
    fireEvent.keyDown(screen.getByTestId("assistant-history-menu"), { key: "Escape" });
    expect(onMenuChange).toHaveBeenCalledWith(false);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("the threads menu is keyboard reachable: arrows move, Enter picks", () => {
    const onSwitch = vi.fn();
    renderWithThreads({ threadsMenuOpen: true, onSwitchConversation: onSwitch });
    const items = screen.getAllByTestId("assistant-history-item");
    items[0].focus();
    fireEvent.keyDown(screen.getByTestId("assistant-history-menu"), { key: "ArrowDown" });
    expect(document.activeElement).toBe(items[1]);
    fireEvent.keyDown(screen.getByTestId("assistant-history-menu"), { key: "Enter" });
    expect(onSwitch).toHaveBeenCalledWith("c2");
  });
});

describe("a failed send puts the ask back (assistant-lost-ask)", () => {
  it("restores the typed ask when the send reports failure", async () => {
    const onSend = vi.fn(() => Promise.resolve(false));
    renderPanel({ onSend, messages: [userMessage("earlier turn")] });
    const input = screen.getByTestId("assistant-composer-input");
    fireEvent.change(input, { target: { value: "  add a reviewer step  " } });
    fireEvent.click(screen.getByTestId("assistant-send"));
    expect(onSend).toHaveBeenCalledWith(
      "add a reviewer step",
      expect.objectContaining({ spoken: false }),
    );
    // Back in the composer, trimmed, and ready to send again.
    await waitFor(() => expect(composerValue()).toBe("add a reviewer step"));
    expect((screen.getByTestId("assistant-send") as HTMLButtonElement).disabled).toBe(false);
  });

  it("restores the ask when the send throws (a network error mid-turn)", async () => {
    const onSend = vi.fn(() => Promise.reject(new Error("network down")));
    renderPanel({ onSend });
    fireEvent.change(screen.getByTestId("assistant-composer-input"), {
      target: { value: "why is the run stuck?" },
    });
    fireEvent.click(screen.getByTestId("assistant-send"));
    await waitFor(() => expect(composerValue()).toBe("why is the run stuck?"));
  });

  it("restores the ask for a caller that reports failure synchronously", async () => {
    const onSend = vi.fn(() => false);
    renderPanel({ onSend });
    fireEvent.change(screen.getByTestId("assistant-composer-input"), {
      target: { value: "ask A" },
    });
    fireEvent.keyDown(screen.getByTestId("assistant-composer-input"), { key: "Enter" });
    await flush();
    expect(composerValue()).toBe("ask A");
  });

  it("keeps the composer clear when the send is accepted", async () => {
    const onSend = vi.fn(() => Promise.resolve(true));
    renderPanel({ onSend });
    fireEvent.change(screen.getByTestId("assistant-composer-input"), {
      target: { value: "ask A" },
    });
    fireEvent.click(screen.getByTestId("assistant-send"));
    await flush();
    await flush();
    expect(composerValue()).toBe("");
    expect((screen.getByTestId("assistant-send") as HTMLButtonElement).disabled).toBe(true);
  });

  it("never clobbers text typed after the failed send", async () => {
    let reject: (ok: boolean) => void = () => undefined;
    const onSend = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          reject = resolve;
        }),
    );
    renderPanel({ onSend });
    fireEvent.change(screen.getByTestId("assistant-composer-input"), {
      target: { value: "the ask that failed" },
    });
    fireEvent.click(screen.getByTestId("assistant-send"));
    // The person starts a new question before the failure surfaces.
    await act(async () => {
      fireEvent.change(screen.getByTestId("assistant-composer-input"), {
        target: { value: "a different question" },
      });
    });
    await act(async () => {
      reject(false);
    });
    expect(composerValue()).toBe("a different question");
  });

  it("puts a failed starter's question in the composer (the checklist's send path)", async () => {
    const onSend = vi.fn(() => Promise.resolve(false));
    // The checklist is the empty thread's own message: send its starter and
    // the failed ask comes back into the composer exactly like a typed one.
    renderPanel({ onSend, messages: [userMessage("earlier")] });
    fireEvent.change(screen.getByTestId("assistant-composer-input"), {
      target: { value: "What needs me right now?" },
    });
    fireEvent.click(screen.getByTestId("assistant-send"));
    await waitFor(() => expect(composerValue()).toBe("What needs me right now?"));
  });

  it("returns a failed question option's label to the composer", async () => {
    const onAnswerQuestion = vi.fn(() => Promise.resolve(false));
    renderPanel({ onAnswerQuestion, messages: [questionMessage()] });
    fireEvent.click(screen.getAllByTestId("assistant-question-option")[0]);
    await waitFor(() => expect(composerValue()).toBe("Fail review on any auth finding"));
  });

  it("applies an external restore request once per token, never over a draft", async () => {
    const onSend = vi.fn(() => Promise.resolve(true));
    const view = renderPanel({ onSend });
    fireEvent.change(screen.getByTestId("assistant-composer-input"), {
      target: { value: "typed over it" },
    });
    // Same token re-delivered: the panel has already consumed it.
    view.rerender(
      <AssistantPanel
        variant="popover"
        {...panelProps}
        onSend={onSend}
        composerRestore={{ token: 1, text: "carried ask" }}
      />,
    );
    expect(composerValue()).toBe("typed over it");
    // A fresh token hands the text back into an empty composer only.
    fireEvent.change(screen.getByTestId("assistant-composer-input"), { target: { value: "" } });
    view.rerender(
      <AssistantPanel
        variant="popover"
        {...panelProps}
        onSend={onSend}
        composerRestore={{ token: 2, text: "carried ask" }}
      />,
    );
    expect(composerValue()).toBe("carried ask");
  });
});

/**
 * Issue #63: a failed send keeps its bubble in the transcript with the
 * error line and a `Retry` under it (rendered by MessageList); the panel
 * owns what Retry does with the composer — the restored duplicate copy
 * leaves with the ask, a draft typed since never gets clobbered, and the
 * in-flight turn locks the button like it locks the composer.
 */
describe("Retry under a failed ask (issue #63)", () => {
  const failedAsk = (text: string): AssistantMessage => ({
    ...userMessage(text),
    local: {
      state: "failed",
      error: "The assistant could not answer. Your question was not sent — send it again.",
    },
  });

  it("Retry re-sends the failed row's words verbatim and clears the composer's copy", async () => {
    const onSend = vi.fn(() => Promise.resolve(true));
    renderPanel({ onSend, messages: [failedAsk("What needs me right now?")] });
    fireEvent.change(screen.getByTestId("assistant-composer-input"), {
      target: { value: "What needs me right now?" },
    });
    fireEvent.click(screen.getByTestId("assistant-send-retry"));
    expect(onSend).toHaveBeenCalledWith("What needs me right now?");
    await waitFor(() => expect(composerValue()).toBe(""));
  });

  it("Retry sends even from an empty composer, and a failing retry never eats a newer draft", async () => {
    const onSend = vi.fn(() => Promise.resolve(false));
    renderPanel({ onSend, messages: [failedAsk("What needs me right now?")] });
    // The failure restored the words into the composer; the person rephrases.
    fireEvent.change(screen.getByTestId("assistant-composer-input"), {
      target: { value: "a different question" },
    });
    fireEvent.click(screen.getByTestId("assistant-send-retry"));
    expect(onSend).toHaveBeenCalledWith("What needs me right now?");
    await flush();
    // The retry failed again: the failed bubble still holds the words, and
    // the person's own draft is untouched.
    expect(composerValue()).toBe("a different question");
  });

  it("Retry is locked while a turn is in flight", () => {
    const onSend = vi.fn();
    renderPanel({ onSend, busy: true, messages: [failedAsk("again")] });
    fireEvent.click(screen.getByTestId("assistant-send-retry"));
    expect(onSend).not.toHaveBeenCalled();
  });
});

/**
 * Handoff §1 / the lab walk-through finding 1: the full page's three columns
 * FILL the host the route hands the engine — the thread list scrolls inside
 * its own 240px rail, the conversation scrolls with the composer pinned at the
 * bottom of the centre column, and the context rail scrolls inside its 260px.
 * `h-full` + `min-h-0` is the chain; a `min-h-full` frame is what stopped all
 * three at the height of their content (~470px) on the 1280/1440 shots.
 */
describe("the full page's height chain (walk-through finding 1)", () => {
  it("the frame fills its host, the centre column scrolls, the composer stays pinned", () => {
    const { container } = render(
      withQuery(
        <AssistantPageFrame
          threadColumn={
            <AssistantThreadColumn
              conversations={[{ id: "c1", title: "Fix the board", lastMessageAt: null }]}
              activeId="c1"
              onSwitch={() => {}}
              onNewConversation={() => {}}
            />
          }
          sideColumn={
            <AssistantPageSideColumn
              pageContextOn
              pageLabel="Today"
              pageRoute="/"
              changes={[]}
              trustLevel="ask_risky"
            />
          }
        >
          <AssistantPanel variant="page" {...panelProps} messages={[userMessage("hi")]} />
        </AssistantPageFrame>,
      ),
    );
    const frame = container.querySelector('[data-testid="assistant-page"]') as HTMLElement;
    // The frame takes the host's full height and clips: no page-level scroll.
    expect(frame.className).toContain("h-full");
    expect(frame.className).toContain("min-h-0");
    expect(frame.className).toContain("flex-1");
    expect(frame.className).toContain("overflow-hidden");

    // The left and right rails keep a 1px line to the centre and own scroll.
    const threads = screen.getByTestId("assistant-page-threads");
    expect(threads.className).toContain("border-r");
    expect(threads.className).toContain("border-line");
    expect(threads.className).toContain("h-full");
    const side = screen.getByTestId("assistant-page-side");
    expect(side.className).toContain("border-l");
    expect(side.className).toContain("border-line");
    expect(side.className).toContain("h-full");
    expect(side.className).toContain("overflow-y-auto");

    // The conversation panel fills its column; the body is the scroll box and
    // the composer frame is pinned below it (never inside the scroll).
    const panel = screen.getByTestId("assistant-panel");
    expect(panel.className).toContain("h-full");
    expect(panel.className).toContain("flex-1");
    const body = screen.getByTestId("assistant-body");
    expect(body.className).toContain("flex-1");
    expect(body.className).toContain("min-h-0");
    expect(body.className).toContain("overflow-y-auto");
    const composer = screen.getByTestId("assistant-composer-frame");
    expect(composer.className).toContain("shrink-0");
    expect(body.contains(composer)).toBe(false);
    // The rail's own thread list — not the whole rail — is what scrolls.
    const list = threads.querySelector(".overflow-y-auto") as HTMLElement;
    expect(list).toBeTruthy();
    expect(list.className).toContain("min-h-0");
  });
});

/**
 * Review §2 (handoff §1, mock L112–125 / L381–410): the prototype's
 * `threadRows` ALWAYS contain the thread on screen. A new thread with nothing
 * persisted yet was showing the empty-state sentence instead of itself.
 */
describe("the full page's THREADS column always lists the open thread", () => {
  const column = (props: Omit<Parameters<typeof AssistantThreadColumn>[0], "onNewConversation">) =>
    render(withQuery(<AssistantThreadColumn {...props} onNewConversation={() => {}} />));

  const classes = (node: HTMLElement) => new Set(node.className.split(/\s+/));

  it("leads with the unsaved thread as a selected “New thread · now” row, no empty state", () => {
    const onSwitch = vi.fn();
    column({
      conversations: [],
      activeId: null,
      currentThread: { id: "", title: null, lastMessageAt: null },
      onSwitch,
    });
    const items = screen.getAllByTestId("assistant-history-item");
    expect(items).toHaveLength(1);
    expect(items[0].textContent).toContain("New thread");
    expect(items[0].textContent).toContain("now");
    // Selected: the accent wash marks the current row; the page's THREADS
    // column carries NO check (prototype threadRows: title + age only — the
    // check belongs to the header's threads menu).
    expect(classes(items[0]).has("bg-accent-wash")).toBe(true);
    expect(items[0].querySelector(".tabler-icon-check")).toBeNull();
    // “No threads yet” never appears while a thread is on screen.
    expect(screen.queryByText("No threads yet — the next answer starts one.")).toBeNull();
    // It IS the open thread: tapping it switches to nothing.
    fireEvent.click(items[0]);
    expect(onSwitch).not.toHaveBeenCalled();
  });

  it("lists a saved thread once, selected, with the others after it", () => {
    const onSwitch = vi.fn();
    column({
      conversations: [
        { id: "c1", title: "Fix the board", lastMessageAt: "2026-10-20T10:00:00Z" },
        { id: "c2", title: "Add a reviewer", lastMessageAt: "2026-10-19T10:00:00Z" },
      ],
      activeId: "c1",
      currentThread: { id: "c1", title: "Fix the board", lastMessageAt: "2026-10-20T10:00:00Z" },
      onSwitch,
    });
    const items = screen.getAllByTestId("assistant-history-item");
    expect(items.map((item) => item.getAttribute("data-conversation-id"))).toEqual(["c1", "c2"]);
    expect(classes(items[0]).has("bg-accent-wash")).toBe(true);
    // The other row only washes on hover — it is not the open thread.
    expect(classes(items[1]).has("bg-accent-wash")).toBe(false);
    expect(classes(items[1]).has("bg-transparent")).toBe(true);
    fireEvent.click(items[1]);
    expect(onSwitch).toHaveBeenCalledWith("c2");
  });

  it("keeps the empty state for a thread list with nothing open, and the search miss", () => {
    const { rerender } = column({
      conversations: [],
      activeId: null,
      onSwitch: () => {},
    });
    // Truly nothing: no rows and no open thread.
    expect(screen.getByText("No threads yet — the next answer starts one.")).toBeTruthy();
    rerender(
      withQuery(
        <AssistantThreadColumn
          conversations={[{ id: "c1", title: "Fix the board", lastMessageAt: null }]}
          activeId="c1"
          currentThread={{ id: "c1", title: "Fix the board", lastMessageAt: null }}
          onSwitch={() => {}}
          onNewConversation={() => {}}
        />,
      ),
    );
    fireEvent.change(screen.getByTestId("assistant-history-search"), {
      target: { value: "nothing matches this" },
    });
    expect(screen.getByText("No thread matches that search.")).toBeTruthy();
    expect(screen.queryAllByTestId("assistant-history-item")).toHaveLength(0);
  });
});

/**
 * Handoff §1 / the prototype's `componentDidUpdate`: the body follows the
 * transcript while the reader is AT the newest row, and holds their place when
 * they have climbed away to read (> ~80px off the bottom, the chat transcript's
 * own pin band).
 */
describe("the transcript's auto-scroll (walk-through finding 3)", () => {
  /** A body with a real scroll geometry (jsdom measures nothing at all). */
  function scrollableBody(scrollTop = 0): { body: HTMLElement; model: { scrollTop: number } } {
    const body = screen.getByTestId("assistant-body") as HTMLElement;
    const model = { scrollTop };
    Object.defineProperty(body, "scrollHeight", { configurable: true, value: 1000 });
    Object.defineProperty(body, "clientHeight", { configurable: true, value: 400 });
    Object.defineProperty(body, "scrollTop", {
      configurable: true,
      get: () => model.scrollTop,
      set: (value: number) => {
        model.scrollTop = Math.min(Math.max(0, value), body.scrollHeight - body.clientHeight);
      },
    });
    return { body, model };
  }

  it("appending a row scrolls the body to its bottom", () => {
    const first = [userMessage("one")];
    const { rerender } = renderPanel({ messages: first });
    // The reader sits 600px above the newest row's bottom edge — 200px away.
    const { model } = scrollableBody(400);
    const next = [...first, userMessage("two")];
    rerender(<AssistantPanel variant="popover" {...panelProps} messages={next} />);
    // 1000 - 400: the newest row sits at the visible bottom.
    expect(model.scrollTop).toBe(600);
  });

  it("the thinking row alone still pulls the pinned reader to the bottom", () => {
    const messages = [userMessage("one")];
    const { rerender } = renderPanel({ messages });
    const { model } = scrollableBody(0);
    rerender(<AssistantPanel variant="popover" {...panelProps} messages={messages} busy />);
    expect(model.scrollTop).toBe(600);
  });

  it("a reader who climbed away from the newest row is not yanked", () => {
    const first = [userMessage("one")];
    const { rerender } = renderPanel({ messages: first });
    const { body, model } = scrollableBody(0);
    // Reading history: 200px up from the bottom of a 1000/400 scroll box.
    model.scrollTop = 400;
    fireEvent.scroll(body);
    rerender(
      <AssistantPanel
        variant="popover"
        {...panelProps}
        messages={[...first, userMessage("two")]}
      />,
    );
    expect(model.scrollTop).toBe(400);
  });

  it("a re-render with nothing new leaves the reader's place alone", () => {
    const messages = [userMessage("one")];
    const { rerender } = renderPanel({ messages });
    const { body, model } = scrollableBody(0);
    model.scrollTop = 300;
    fireEvent.scroll(body);
    rerender(<AssistantPanel variant="popover" {...panelProps} messages={messages} />);
    expect(model.scrollTop).toBe(300);
  });

  it("an approval card deciding in place pulls a reader who is at the bottom", () => {
    const pending: AssistantMessage = {
      id: "m-ap",
      kind: "approval_request",
      payload: {
        kind: "approval_request",
        action: "run.retry",
        summary: "Retry node `test` on run 9c1e",
        state: "pending",
      },
      created_at: "2026-10-20T10:00:00Z",
    };
    const { rerender } = renderPanel({ messages: [pending] });
    const { model } = scrollableBody(520);
    const decided: AssistantMessage = {
      ...pending,
      payload: {
        kind: "approval_request",
        action: "run.retry",
        summary: "Retry node `test` on run 9c1e",
        state: "confirmed",
      },
    };
    rerender(<AssistantPanel variant="popover" {...panelProps} messages={[decided]} />);
    expect(model.scrollTop).toBe(600);
  });
});
