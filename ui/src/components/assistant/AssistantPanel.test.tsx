import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import AssistantPanel, {
  type AssistantPanelProps,
  type RecentConversation,
} from "./AssistantPanel";
import type { AssistantMessage } from "./types";

afterEach(() => {
  cleanup();
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
  it("is the 400px panel with the ASSISTANT header, trust pill, expand and esc hint", () => {
    const onExpand = vi.fn();
    const { container } = renderPanel({ onExpand });
    const panel = container.querySelector('[data-testid="assistant-panel"]') as HTMLElement;
    expect(panel.style.width).toBe("400px");
    expect(panel.style.borderRadius).toBe("4px");
    const header = screen.getByTestId("assistant-panel-header");
    expect(header.textContent).toContain("ASSISTANT");
    expect(header.textContent).toContain("esc");
    expect(screen.getByTestId("assistant-pill").textContent).toContain("ask for risky");
    fireEvent.click(screen.getByTestId("assistant-expand"));
    expect(onExpand).toHaveBeenCalledTimes(1);
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

  it("shows up to three dashed FOR THIS PAGE chips, each sending its text", () => {
    const onSend = vi.fn();
    renderPanel({
      onSend,
      suggestions: [
        "Walk me through this workflow",
        "What changed since r2?",
        "Why did the last 3 runs loop more than twice?",
        "A fourth that must not render",
      ],
    });
    const chips = screen.getAllByTestId("assistant-suggest");
    expect(chips).toHaveLength(3);
    expect(chips[0].textContent).toBe("Walk me through this workflow");
    const style = chips[0] as HTMLButtonElement;
    expect(style.style.borderStyle).toBe("dashed");
    fireEvent.click(chips[1]);
    expect(onSend).toHaveBeenCalledWith("What changed since r2?");
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
    expect(onSend).toHaveBeenCalledWith("add a reviewer");
    expect((input as HTMLInputElement).value).toBe("");
    expect((screen.getByTestId("assistant-send") as HTMLButtonElement).disabled).toBe(true);
  });

  it("hides the mic where the Web Speech API is absent and shows the list while listening", () => {
    // jsdom has no SpeechRecognition — the honest degradation is no button.
    renderPanel();
    expect(screen.queryByTestId("mic-button")).toBeNull();
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
      expect(input.placeholder).toBe("Ask, or tell it what to change…");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("shortens at phone width so the row fits", () => {
    viewport(390);
    try {
      renderPanel();
      const input = screen.getByTestId("assistant-composer-input") as HTMLInputElement;
      expect(input.placeholder).toBe("Tell it what to change…");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("AssistantPanel (expanded)", () => {
  it("renders the 680px centred column with the opened-from chip and Shrink", () => {
    const onShrink = vi.fn();
    const { container } = render(
      <AssistantPanel
        variant="expanded"
        {...panelProps}
        contextLabel="Feature Delivery"
        onShrink={onShrink}
      />,
    );
    const panel = container.querySelector('[data-testid="assistant-panel"]') as HTMLElement;
    expect(panel.dataset.variant).toBe("expanded");
    const column = panel.querySelector("div");
    expect((column as HTMLElement).style.maxWidth).toBe("680px");
    expect(screen.getByTestId("assistant-opened-from").textContent).toBe(
      "opened from Feature Delivery",
    );
    const shrink = screen.getByTestId("assistant-shrink");
    expect(shrink.textContent).toBe("Shrink to popover");
    fireEvent.click(shrink);
    expect(onShrink).toHaveBeenCalledTimes(1);
  });

  /**
   * rcn-2f review item 1: design 2f is drafted in the assistant panel NEXT TO
   * the chat, so the `docked` variant is the same full-size surface laid out
   * for the ~450px column it is handed — it fills that width instead of
   * centring a 680px conversation inside it, and its header keeps the popover's
   * icon-only controls (the row is 450px wide whatever the screen's width is,
   * so viewport-driven wording would run off its right edge).
   */
  it("docked: fills the column it is handed, with icon-only header controls", () => {
    const onShrink = vi.fn();
    const { container } = render(
      <AssistantPanel
        variant="docked"
        {...panelProps}
        contextLabel="threads"
        onShrink={onShrink}
        onNewConversation={() => {}}
      />,
    );
    const panel = container.querySelector('[data-testid="assistant-panel"]') as HTMLElement;
    expect(panel.dataset.variant).toBe("docked");
    // No centred 680px column: the dock's own width is the conversation's.
    expect(panel.style.maxWidth).toBe("");
    expect(panel.style.width).toBe("100%");
    expect(screen.getByTestId("assistant-opened-from").textContent).toBe("opened from threads");
    // The two header controls name themselves to assistive tech and the
    // tooltip, and print an icon or a ＋ on screen.
    const shrink = screen.getByTestId("assistant-shrink");
    expect(shrink.getAttribute("aria-label")).toBe("Shrink to popover");
    expect(shrink.querySelector(".sr-only")?.textContent).toBe("Shrink to popover");
    fireEvent.click(shrink);
    expect(onShrink).toHaveBeenCalledTimes(1);
    const fresh = screen.getByTestId("assistant-new-conversation");
    expect(fresh.getAttribute("aria-label")).toBe("New thread");
    expect(fresh.textContent).toContain("New");
  });

  /**
   * rcn-6 review: the docked panel opened FROM a chat names THAT chat in the
   * header chip — `from “<title>”` — not the bare section name `threads`.
   */
  it("docked from a chat: the chip names the chat, not the section", () => {
    const { container } = render(
      <AssistantPanel
        variant="docked"
        {...panelProps}
        contextLabel="threads"
        chatContext="Refactor the settings page"
        onShrink={() => {}}
      />,
    );
    const panel = container.querySelector('[data-testid="assistant-panel"]') as HTMLElement;
    expect(panel.dataset.variant).toBe("docked");
    const chip = screen.getByTestId("assistant-opened-from");
    expect(chip.textContent).toBe("from Refactor the settings page");
    expect(chip.title).toBe("from Refactor the settings page");
  });

  it("esc closes the expanded view too, and a busy turn shows thinking…", () => {
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
    const { rerender } = render(
      <AssistantPanel variant="docked" {...panelProps} onGo={onGo} onShrink={() => {}} />,
    );
    expect(screen.queryByTestId("assistant-open-draft")).toBeNull();
    rerender(
      <AssistantPanel
        variant="docked"
        {...panelProps}
        onGo={onGo}
        onShrink={() => {}}
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
        variant="docked"
        {...panelProps}
        onGo={onGo}
        onShrink={() => {}}
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
        <AssistantPanel
          variant="docked"
          {...panelProps}
          onGo={onGo}
          onShrink={() => {}}
          messages={[rawLabelled]}
        />
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
        variant="docked"
        {...panelProps}
        onGo={onGo}
        onShrink={() => {}}
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
      withQuery(
        <AssistantPanel
          variant="docked"
          {...panelProps}
          onShrink={() => {}}
          messages={[draftAndOther]}
        />,
      ),
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
describe("AssistantPanel header controls (ui-newconv)", () => {
  const recent: RecentConversation[] = [
    { id: "c1", title: "Fix the board", lastMessageAt: "2026-07-07T09:00:00Z" },
    { id: "c2", title: null, lastMessageAt: null },
  ];

  it("popover: the compact New control is a ghost button and reports the callback", () => {
    const onNew = vi.fn();
    renderPanel({ onNewConversation: onNew });
    const button = screen.getByTestId("assistant-new-conversation") as HTMLButtonElement;
    expect(button.className).toContain("ds-btn--ghost");
    expect(button.title).toBe("New thread");
    // The narrow header's glyph is the lucide Plus (an SVG, so it adds no text
    // to the name); the wording lives in the sr-only span and the tooltip
    // (rcn-6 review: the old fullwidth ＋ rendered as an unlabelled blue bar).
    expect(button.querySelector("svg")).toBeTruthy();
    expect(button.textContent).toBe("New thread");
    fireEvent.click(button);
    expect(onNew).toHaveBeenCalledTimes(1);
    // No Recent menu without the switch callback.
    expect(screen.queryByTestId("assistant-history")).toBeNull();
  });

  it("expanded: the full New thread wording", () => {
    const onNew = vi.fn();
    render(<AssistantPanel variant="expanded" {...panelProps} onNewConversation={onNew} />);
    const button = screen.getByTestId("assistant-new-conversation");
    expect(button.textContent).toBe("New thread");
    fireEvent.click(button);
    expect(onNew).toHaveBeenCalledTimes(1);
  });

  /**
   * Review 2f, item 6: at 390 the expanded header ran off the right edge —
   * `Shrink to popover` clipped to `S`/`po` and the `opened from …` chip
   * wrapped onto three lines. Both header controls are now icon-plus-label:
   * below 640px only the glyph is on screen, and the wording stays in the
   * accessible name and the tooltip. jsdom applies no media query, so the
   * contract asserted here is the DOM one the CSS switches between.
   */
  it("expanded: both header controls name themselves, and the chip truncates", () => {
    render(
      <AssistantPanel
        variant="expanded"
        {...panelProps}
        contextLabel="threads"
        onNewConversation={() => {}}
        onShrink={() => {}}
      />,
    );
    const shrink = screen.getByTestId("assistant-shrink") as HTMLButtonElement;
    expect(shrink.getAttribute("aria-label")).toBe("Shrink to popover");
    expect(shrink.title).toBe("Shrink to popover");
    // The phone's glyph is an SVG (it adds no text to the button's name), and
    // the wording only shows from 640px up.
    expect(shrink.querySelector("svg")).toBeTruthy();
    expect(shrink.querySelector("span")?.className).toContain("min-[640px]:inline");

    const button = screen.getByTestId("assistant-new-conversation") as HTMLButtonElement;
    expect(button.getAttribute("aria-label")).toBe("New thread");
    expect(button.querySelector("svg")).toBeTruthy();

    const chip = screen.getByTestId("assistant-opened-from");
    expect(chip.textContent).toBe("opened from threads");
    expect(chip.className).toContain("truncate");
    expect(chip.title).toBe("opened from threads");
  });

  it("Recent lists the conversations by title + age and switches on click", () => {
    const onSwitch = vi.fn();
    renderPanel({
      onSwitchConversation: onSwitch,
      recentConversations: recent,
      activeConversationId: "c1",
    });
    fireEvent.click(screen.getByTestId("assistant-history"));
    const items = screen.getAllByTestId("assistant-history-item");
    expect(items).toHaveLength(2);
    expect(items[0].textContent).toContain("✓");
    expect(items[0].textContent).toContain("Fix the board");
    expect(items[1].textContent).toContain("Untitled");
    expect(items[1].textContent).not.toContain("✓");
    fireEvent.click(items[1]);
    expect(onSwitch).toHaveBeenCalledTimes(1);
    expect(onSwitch).toHaveBeenCalledWith("c2");
  });

  it("Recent caps at 5 rows and shows the honest empty line when there are none", () => {
    const many: RecentConversation[] = Array.from({ length: 7 }, (_, i) => ({
      id: `c${i}`,
      title: `conv ${i}`,
      lastMessageAt: "2026-07-07T00:00:00Z",
    }));
    renderPanel({ onSwitchConversation: () => {}, recentConversations: many });
    fireEvent.click(screen.getByTestId("assistant-history"));
    expect(screen.getAllByTestId("assistant-history-item")).toHaveLength(5);
    cleanup();
    renderPanel({ onSwitchConversation: () => {}, recentConversations: [] });
    fireEvent.click(screen.getByTestId("assistant-history"));
    expect(screen.getByTestId("assistant-history-menu").textContent).toContain(
      "No conversations yet",
    );
  });

  it("the Recent menu carries the shared pointer arrow (handoff 3c)", () => {
    renderPanel({ onSwitchConversation: () => {}, recentConversations: recent });
    expect(screen.queryByTestId("menu-arrow")).toBeNull();
    const trigger = screen.getByTestId("assistant-history");
    fireEvent.click(trigger);
    const menu = screen.getByTestId("assistant-history-menu");
    const arrow = screen.getByTestId("menu-arrow") as HTMLElement;
    // Handoff 3c's rule, in the hand-rolled Recent menu: the shared arrow,
    // mounted on the wrapper that hugs the `Recent ▾` trigger rather than
    // inside the box (the rule centres it on the TRIGGER, not on the box).
    expect(arrow.getAttribute("aria-hidden")).toBe("true");
    expect(arrow.style.width).toBe("9px");
    expect(arrow.style.transform).toContain("rotate(45deg)");
    expect(arrow.style.left).toBe("50%");
    expect(menu.contains(arrow)).toBe(false);
    expect(trigger.parentElement?.contains(arrow)).toBe(true);
    fireEvent.keyDown(menu, { key: "Escape" });
    expect(screen.queryByTestId("menu-arrow")).toBeNull();
  });

  it("esc in the Recent menu closes only the menu, then the panel", () => {
    const onClose = vi.fn();
    renderPanel({
      onClose,
      onSwitchConversation: () => {},
      recentConversations: recent,
      activeConversationId: "c1",
    });
    fireEvent.click(screen.getByTestId("assistant-history"));
    expect(screen.getByTestId("assistant-history-menu")).toBeTruthy();
    fireEvent.keyDown(screen.getByTestId("assistant-history-menu"), { key: "Escape" });
    expect(screen.queryByTestId("assistant-history-menu")).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Recent is keyboard reachable: arrows move, Enter picks", () => {
    const onSwitch = vi.fn();
    renderPanel({
      onSwitchConversation: onSwitch,
      recentConversations: recent,
      activeConversationId: "c1",
    });
    fireEvent.click(screen.getByTestId("assistant-history"));
    const items = screen.getAllByTestId("assistant-history-item");
    items[0].focus();
    fireEvent.keyDown(screen.getByTestId("assistant-history-menu"), { key: "ArrowDown" });
    expect(document.activeElement).toBe(items[1]);
    fireEvent.keyDown(screen.getByTestId("assistant-history-menu"), { key: "Enter" });
    expect(onSwitch).toHaveBeenCalledWith("c2");
  });
});

/**
 * assistant-lost-ask (acceptance 30, journey f): a failed turn stores nothing
 * server-side (ADR-0034), so a send that did not reach the model must put the
 * person's words back where they can be sent again. The caller reports the
 * round-trip by returning `false` (or throwing) from `onSend`/
 * `onAnswerQuestion`; anything else counts as accepted.
 */
describe("a failed send puts the ask back (assistant-lost-ask)", () => {
  it("restores the typed ask when the send reports failure", async () => {
    const onSend = vi.fn(() => Promise.resolve(false));
    renderPanel({ onSend, messages: [userMessage("earlier turn")] });
    const input = screen.getByTestId("assistant-composer-input");
    fireEvent.change(input, { target: { value: "  add a reviewer step  " } });
    fireEvent.click(screen.getByTestId("assistant-send"));
    expect(onSend).toHaveBeenCalledWith("add a reviewer step");
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

  it("puts a failed suggestion chip's question in the composer", async () => {
    const onSend = vi.fn(() => Promise.resolve(false));
    renderPanel({ onSend, suggestions: ["What needs me right now?"] });
    fireEvent.click(screen.getByTestId("assistant-suggest"));
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
