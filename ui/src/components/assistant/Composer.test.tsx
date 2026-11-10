import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import Composer from "./Composer";
import { PAGE_CONTEXT_SESSION_KEY } from "./pageContext";
import {
  flushAssistantSpeechReads,
  resetAssistantSpeechState,
  TRANSCRIPTIONS_PATH,
} from "./useDictation";
import { shortId } from "../../lib/format";
import type { ComposerSendOptions } from "./Composer";

/**
 * The one-box composer (handoff §1/§3/§4/§5; mock L341–455): the box layout,
 * the page-context menu and its payload, the trust menu's exact copy, and the
 * mic — server transcription, its append rule, and the Web Speech fallback.
 */

const sendCalls: [string, ComposerSendOptions | undefined][] = [];

const renderComposer = (draft = "", onDraftChange: (text: string) => void = () => {}) => {
  sendCalls.length = 0;
  const view = render(
    <Composer
      draft={draft}
      onDraftChange={onDraftChange}
      onSend={(text, options) => {
        sendCalls.push([text, options]);
      }}
      trustLevel="ask_risky"
      onTrustLevelChange={() => {}}
    />,
  );
  return view;
};

/** --- the preferences + status + transcription endpoint ------------------- */

interface FetchCall {
  path: string;
  method: string;
  body?: BodyInit | null;
}

let calls: FetchCall[] = [];
let transcriptReply: () => { status: number; body: unknown } = () => ({
  status: 200,
  body: { text: "add a reviewer step" },
});

function stubFetch() {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string, init: RequestInit = {}) => {
      const method = (init.method ?? "GET").toUpperCase();
      calls.push({ path, method, body: init.body });
      if (path === "/api/v1/me/preferences") {
        return reply(200, { assistant: { speech_auto_send: autoSendPref } });
      }
      if (path === "/api/v1/assistant/status") {
        return reply(200, {
          speech_model: { configured: speechConfigured, model: "qwen3-asr-1-7b" },
        });
      }
      if (path === TRANSCRIPTIONS_PATH) {
        const next = transcriptReply();
        return reply(next.status, next.body);
      }
      return reply(404, { title: "not found" });
    }),
  );
}

function reply(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    // `apiFetch` reads the body as text and parses it itself.
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    headers: new Headers(),
  } as unknown as Response;
}

/** --- the recorder and the mic ------------------------------------------- */

class FakeMediaStream {
  readonly tracks: { stop: () => void }[] = [{ stop: () => {} }];
  getTracks() {
    return this.tracks;
  }
  getAudioTracks() {
    return this.tracks;
  }
}

const recorders: FakeMediaRecorder[] = [];

class FakeMediaRecorder {
  state: "inactive" | "recording" = "inactive";
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  readonly stream: FakeMediaStream;

  constructor(stream: FakeMediaStream) {
    this.stream = stream;
    recorders.push(this);
  }

  static isTypeSupported(type: string) {
    return type === "audio/webm";
  }

  start() {
    this.state = "recording";
  }

  stop() {
    this.ondataavailable?.({ data: new Blob(["audio-bytes"], { type: "audio/webm" }) });
    this.state = "inactive";
    this.onstop?.();
  }
}

const getUserMedia = vi.fn(async () => new FakeMediaStream() as unknown as MediaStream);

function stubRecorder() {
  recorders.length = 0;
  getUserMedia.mockClear();
  vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia },
  });
}

/** The browser's own recognizer, to prove the fallback path actually ran. */
const recognizers: FakeRecognition[] = [];

class FakeRecognition {
  continuous = false;
  interimResults = false;
  lang = "";
  onresult: ((event: unknown) => void) | null = null;
  onerror: ((event: { error: string }) => void) | null = null;
  onend: (() => void) | null = null;
  started = false;
  stopped = false;

  constructor() {
    recognizers.push(this);
  }

  start() {
    this.started = true;
  }

  stop() {
    this.stopped = true;
    this.onend?.();
  }

  abort() {
    this.stopped = true;
  }

  /** Test helper: the recognizer's final answer. */
  deliver(text: string) {
    this.onresult?.({
      resultIndex: 0,
      results: [{ isFinal: true, 0: { transcript: text } }],
    });
  }
}

const RUN_ID = "01987a70-1111-7000-8000-abcdef012345";

let autoSendPref = false;
let speechConfigured = true;

beforeEach(() => {
  window.sessionStorage.clear();
  resetAssistantSpeechState();
  recognizers.length = 0;
  sendCalls.length = 0;
  autoSendPref = false;
  speechConfigured = true;
  transcriptReply = () => ({ status: 200, body: { text: "add a reviewer step" } });
  stubFetch();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("the composer box (handoff §1)", () => {
  it("is one box: textarea on top, ctx · trust · spacer · mic · send below, all 26–30px", () => {
    const { container } = renderComposer();
    expect(screen.getByTestId("assistant-composer")).toBeTruthy();
    expect(container.querySelector('[data-testid="composer-box"]')?.className).toContain(
      "border-line-strong",
    );
    const input = screen.getByTestId("assistant-composer-input") as HTMLTextAreaElement;
    expect(input.tagName).toBe("TEXTAREA");
    expect(input.rows).toBe(2);
    expect(input.placeholder).toBe("Ask anything, or use the mic…");
    expect(screen.getByTestId("assistant-context-button").className).toContain("h-[26px]");
    expect(screen.getByTestId("assistant-pill").className).toContain("h-[26px]");
    expect(screen.getByTestId("mic-button").className).toContain("h-[30px]");
    const send = screen.getByTestId("assistant-send") as HTMLButtonElement;
    expect(send.className).toContain("h-[30px]");
    // Review §4: the phone touch-target floor (`main button` ≥ 44px below
    // 560px) may not stretch these four. On the full page at 390px it turned
    // the 26px context square into a 26×44 sliver; each one widens with it, so
    // at phone width inside <main> (the full page) they are SQUARE 44px targets
    // and the popover/side panel (outside <main>) keep the design's 26/30px.
    for (const testid of [
      "assistant-context-button",
      "assistant-pill",
      "mic-button",
      "assistant-send",
    ]) {
      expect(screen.getByTestId(testid).className, testid).toContain(
        "max-[559px]:[main_&]:min-w-[44px]",
      );
    }
    // Empty draft: Send is disabled, and it carries the disabled pair.
    expect(send.disabled).toBe(true);
    expect(send.className).toContain("bg-disabled-bg");
  });

  it("sends the trimmed draft on Send and on Enter, and Shift+Enter is a newline", () => {
    renderComposer("  add a reviewer  ");
    const input = screen.getByTestId("assistant-composer-input");
    fireEvent.click(screen.getByTestId("assistant-send"));
    expect(sendCalls).toHaveLength(1);
    expect(sendCalls[0][0]).toBe("add a reviewer");

    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(sendCalls).toHaveLength(1);

    fireEvent.keyDown(input, { key: "Enter" });
    expect(sendCalls).toHaveLength(2);
  });

  it("locks while a turn is in flight and while the mic holds the box", () => {
    stubRecorder();
    const { rerender } = renderComposer("hello");
    const send = screen.getByTestId("assistant-send") as HTMLButtonElement;
    expect(send.disabled).toBe(false);
    rerender(
      <Composer
        draft="hello"
        onDraftChange={() => {}}
        onSend={() => {}}
        busy
        trustLevel="ask_risky"
        onTrustLevelChange={() => {}}
      />,
    );
    expect((screen.getByTestId("assistant-send") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("mic-button") as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("the page-context button and menu (handoff §3)", () => {
  it("toggles the menu and carries the page label, route and checkbox", () => {
    renderComposer();
    const button = screen.getByTestId("assistant-context-button");
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(button.getAttribute("title")).toBe("Page context: Today");
    // Closed: the design's quiet line border.
    expect(button.className).toContain("border-line");
    fireEvent.click(button);
    const menu = screen.getByTestId("assistant-context-menu");
    expect(button.getAttribute("aria-expanded")).toBe("true");
    // Review fix 4 (prototype ctxBtnStyle): while the menu is open the button
    // carries the INK border, whatever the on/off fill underneath it.
    expect(button.className).toContain("border-ink");
    expect(menu.textContent).toContain("PAGE CONTEXT");
    expect(menu.textContent).toContain("Today");
    expect(menu.textContent).toContain("/");
    const checkbox = screen.getByTestId("assistant-context-send") as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
    // The 9px rotated-square arrow points at the button from the box.
    const arrow = screen.getByTestId("menu-arrow") as HTMLElement;
    expect(arrow.style.width).toBe("9px");
    expect(arrow.style.transform).toContain("rotate(45deg)");
    // The ink border belongs to the open menu alone: esc drops it back.
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.getByTestId("assistant-context-button").className).not.toContain("border-ink");
    expect(screen.getByTestId("assistant-context-button").className).toContain("border-line");
  });

  it("sends the page context with the ask, and omits it once unchecked", () => {
    renderComposer("what is stuck?");
    fireEvent.click(screen.getByTestId("assistant-send"));
    expect(sendCalls[0][1]).toEqual({
      spoken: false,
      context: { route: "/", page: { label: "Today" } },
    });

    // Uncheck "Send with my messages": the context member is gone ENTIRELY.
    fireEvent.click(screen.getByTestId("assistant-context-button"));
    fireEvent.click(screen.getByTestId("assistant-context-send"));
    expect(window.sessionStorage.getItem(PAGE_CONTEXT_SESSION_KEY)).toContain("false");
    fireEvent.keyDown(window, { key: "Escape" });

    fireEvent.click(screen.getByTestId("assistant-send"));
    expect(sendCalls[1][1]).toEqual({ spoken: false, context: undefined });
  });

  it("keeps the switch off for the rest of the tab", () => {
    renderComposer();
    fireEvent.click(screen.getByTestId("assistant-context-button"));
    fireEvent.click(screen.getByTestId("assistant-context-send"));
    cleanup();
    renderComposer();
    fireEvent.click(screen.getByTestId("assistant-context-button"));
    expect((screen.getByTestId("assistant-context-send") as HTMLInputElement).checked).toBe(false);
    expect(screen.getByTestId("assistant-context-button").getAttribute("title")).toBe(
      "Page context off",
    );
  });

  it("names a run page by its short id", () => {
    // The route is the page context's only source: a run page reads "Run <id>".
    window.history.pushState({}, "", `/runs/${RUN_ID}`);
    renderComposer();
    fireEvent.click(screen.getByTestId("assistant-context-button"));
    expect(screen.getByTestId("assistant-context-menu").textContent).toContain(
      `Run ${shortId(RUN_ID)}`,
    );
    window.history.pushState({}, "", "/");
  });
});

describe("the trust menu (handoff §4)", () => {
  it("lists the three levels with the handoff's exact copy and no undo promise", () => {
    renderComposer();
    expect(screen.getByTestId("assistant-pill").textContent).toContain("ask when risky");
    fireEvent.click(screen.getByTestId("assistant-pill"));
    const menu = screen.getByTestId("assistant-pill-menu");
    expect(menu.textContent).toContain("Ask before every changeYou confirm every change.");
    expect(screen.getByTestId("assistant-pill-option-ask_all").textContent).toContain(
      "You confirm every change.",
    );
    expect(screen.getByTestId("assistant-pill-option-ask_risky").textContent).toContain(
      "A decision model checks each call. Flagged ones wait for you.",
    );
    expect(screen.getByTestId("assistant-pill-option-no_ask").textContent).toContain(
      "Everything runs. Each action is listed in the thread.",
    );
    expect(screen.getByTestId("assistant-pill-option-ask_risky").textContent).toContain("default");
    // No level promises that a change can be undone.
    expect(menu.textContent?.toLowerCase()).not.toContain("undo");
    // The chosen level carries the check, not a ✓ glyph.
    expect(screen.getByTestId("assistant-pill-option-ask_risky").querySelector("svg")).toBeTruthy();
    expect(menu.textContent).not.toContain("✓");
  });

  it("picking a level calls onChange and closes the menu", () => {
    const onTrust = vi.fn();
    render(
      <Composer
        draft=""
        onDraftChange={() => {}}
        onSend={() => {}}
        trustLevel="ask_risky"
        onTrustLevelChange={onTrust}
      />,
    );
    fireEvent.click(screen.getByTestId("assistant-pill"));
    fireEvent.click(screen.getByTestId("assistant-pill-option-no_ask"));
    expect(onTrust).toHaveBeenCalledWith("no_ask");
    expect(screen.queryByTestId("assistant-pill-menu")).toBeNull();
  });
});

describe("the mic (handoff §5)", () => {
  it("records, posts the clip as multipart, and APPENDS the transcript to the draft", async () => {
    stubRecorder();
    render(<Harness initial="ship the" />);

    await act(async () => {
      fireEvent.click(screen.getByTestId("mic-button"));
    });
    expect(await screen.findByTestId("listening-bar")).toBeTruthy();
    // 28 accent bars, and the mono clock.
    expect(
      screen.getByTestId("listening-bar").querySelectorAll(".composer-wave > span"),
    ).toHaveLength(28);
    expect(screen.getByTestId("listening-bar").textContent).toContain("0:00");
    // The box itself changes while the mic is open.
    expect(screen.getByTestId("composer-box").className).toContain("border-dashed");

    await act(async () => {
      fireEvent.click(screen.getByTestId("mic-button"));
    });
    const post = calls.find((call) => call.path === TRANSCRIPTIONS_PATH)!;
    expect(post.method).toBe("POST");
    expect(post.body).toBeInstanceOf(FormData);
    const file = (post.body as FormData).get("file");
    expect(file).toBeInstanceOf(Blob);
    expect((file as Blob).type).toBe("audio/webm");
    // Appended to what was already typed — never a replacement.
    await waitFor(() => expect(draftValue()).toBe("ship the add a reviewer step"));
    expect(screen.queryByTestId("listening-bar")).toBeNull();
    // and it was not sent: the box keeps the words for an edit.
    expect(sendCalls).toHaveLength(0);
  });

  it("falls back to the browser's speech when the endpoint answers 503", async () => {
    stubRecorder();
    vi.stubGlobal("SpeechRecognition", FakeRecognition);
    transcriptReply = () => ({ status: 503, body: { code: "speech_not_configured" } });
    render(<Harness initial="" />);

    await act(async () => {
      fireEvent.click(screen.getByTestId("mic-button"));
    });
    expect(await screen.findByTestId("listening-bar")).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByTestId("mic-button"));
    });
    await waitFor(() => expect(calls.some((call) => call.path === TRANSCRIPTIONS_PATH)).toBe(true));
    // Web Speech took over: a recognizer is live and still capturing.
    await waitFor(() => expect(recognizers.length).toBeGreaterThan(0));
    expect(recognizers[recognizers.length - 1].started).toBe(true);
    expect(screen.getByTestId("listening-bar")).toBeTruthy();
  });

  it("sends straight away when speech_auto_send is on, marked spoken", async () => {
    stubRecorder();
    autoSendPref = true;
    render(<Harness initial="typed first" />);
    // The preference is read once per page life; wait for it before dictating.
    await act(async () => {
      await flushAssistantSpeechReads();
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("mic-button"));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("mic-button"));
    });
    await waitFor(() => expect(sendCalls).toHaveLength(1));
    expect(sendCalls[0][0]).toBe("typed first add a reviewer step");
    expect(sendCalls[0][1]?.spoken).toBe(true);
    expect(draftValue()).toBe("");
  });

  it("asks the browser straight away when the server has no speech model", async () => {
    stubRecorder();
    vi.stubGlobal("SpeechRecognition", FakeRecognition);
    speechConfigured = false;
    render(<Harness initial="" />);
    await act(async () => {
      await flushAssistantSpeechReads();
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("mic-button"));
    });
    // No clip is recorded for an endpoint that does not exist.
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(calls.some((call) => call.path === TRANSCRIPTIONS_PATH)).toBe(false);
    expect(recognizers.length).toBeGreaterThan(0);
    expect(screen.getByTestId("listening-bar")).toBeTruthy();
  });

  it("hands the browser fallback's transcript to the box, appended to what was typed", async () => {
    stubRecorder();
    vi.stubGlobal("SpeechRecognition", FakeRecognition);
    speechConfigured = false;
    render(<Harness initial="ship it," />);
    await act(async () => {
      await flushAssistantSpeechReads();
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("mic-button"));
    });
    const rec = recognizers[recognizers.length - 1];
    await act(async () => {
      rec.deliver("then tell the reviewer");
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("mic-button"));
    });
    await waitFor(() => expect(draftValue()).toBe("ship it, then tell the reviewer"));
    expect(sendCalls).toHaveLength(0);
  });

  it("is present with text in the box, and says so in its title", async () => {
    stubRecorder();
    render(<Harness initial="some typed text" />);
    const mic = screen.getByTestId("mic-button") as HTMLButtonElement;
    expect(mic).toBeTruthy();
    expect(mic.title).toBe("Dictate (adds to the end)");
    await act(async () => {
      fireEvent.click(mic);
    });
    expect((screen.getByTestId("mic-button") as HTMLButtonElement).title).toBe(
      "Stop and transcribe",
    );
  });
});

/** A controlled draft, so the append rule is visible in the DOM. */
function Harness({ initial }: { initial: string }) {
  const [draft, setDraft] = useState(initial);
  draftRef.current = () => draft;
  return (
    <>
      <Composer
        draft={draft}
        onDraftChange={setDraft}
        onSend={(text, options) => {
          setDraft("");
          sendCalls.push([text, options]);
        }}
        trustLevel="ask_risky"
        onTrustLevelChange={() => {}}
      />
      <span data-testid="draft-seen">{draft}</span>
    </>
  );
}

const draftRef: { current: () => string } = { current: () => "" };
const draftValue = () => draftRef.current();
