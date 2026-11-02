import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

  it("esc closes the expanded view too, and a busy turn shows thinking…", () => {
    const onClose = vi.fn();
    renderPanel({ onClose, busy: true, messages: [userMessage("hi")] });
    expect(screen.getByTestId("assistant-thinking").textContent).toBe("thinking…");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

/**
 * ui-newconv: the header's `New conversation` control and the Recent menu
 * (the caller's last 5 conversations by title + age, newest first).
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
    expect(button.title).toBe("New conversation");
    expect(button.textContent).toBe("＋ New");
    fireEvent.click(button);
    expect(onNew).toHaveBeenCalledTimes(1);
    // No Recent menu without the switch callback.
    expect(screen.queryByTestId("assistant-history")).toBeNull();
  });

  it("expanded: the full New conversation wording", () => {
    const onNew = vi.fn();
    render(<AssistantPanel variant="expanded" {...panelProps} onNewConversation={onNew} />);
    const button = screen.getByTestId("assistant-new-conversation");
    expect(button.textContent).toBe("New conversation");
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
    expect(button.getAttribute("aria-label")).toBe("New conversation");
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
