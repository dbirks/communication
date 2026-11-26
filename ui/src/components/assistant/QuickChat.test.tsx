import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AssistantPopover, { startVoiceAsk } from "./AssistantPopover";
import { dispatchHoldAction, openAsk } from "./askControl";
import {
  flushAssistantSpeechReads,
  resetAssistantSpeechState,
  TRANSCRIPTIONS_PATH,
} from "./useDictation";
import AssistantPage from "../../pages/AssistantPage";

const CONV_ID = "conv-1";

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

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

  deliver(text: string, isFinal = true) {
    this.onresult?.({
      resultIndex: 0,
      results: [{ isFinal, 0: { transcript: text } }],
    });
  }
}

function stubRecorder() {
  recorders.length = 0;
  vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia: vi.fn(async () => new FakeMediaStream() as unknown as MediaStream),
    },
  });
}

interface StubOpts {
  speechConfigured?: boolean;
  autoSend?: boolean;
  browserFallback?: boolean;
  transcriptionText?: string;
  transcript?: unknown[];
}

function stubServer(opts: StubOpts = {}) {
  const {
    speechConfigured = true,
    autoSend = false,
    browserFallback = true,
    transcriptionText = "check the failing build",
    transcript = [],
  } = opts;
  const posted: { body: Record<string, unknown> }[] = [];

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === "/api/v1/me/preferences") {
        return json({
          assistant: {
            speech_auto_send: autoSend,
            speech_browser_fallback: browserFallback,
          },
        });
      }
      if (url === "/api/v1/assistant/status") {
        return json({
          chat_model: { configured: true, model: "test-chat" },
          speech_model: { configured: speechConfigured, model: speechConfigured ? "test-asr" : "" },
          decision_model: { configured: false, model: "" },
          workers: { online: 1, sandbox_mode: "off" },
          execution_mode: "inprocess",
          github_credentials: [],
          projects: { count: 1 },
          workflows: { count: 0, samples: 0, assigned: 0 },
        });
      }
      if (url === TRANSCRIPTIONS_PATH) {
        return json({ text: transcriptionText });
      }
      if (method === "GET" && url.startsWith("/api/v1/assistant/conversations?")) {
        return json({
          conversations: [
            {
              id: CONV_ID,
              title: "Ops check",
              created_at: "2026-07-07T00:00:00Z",
              updated_at: "2026-07-07T00:00:00Z",
              last_message_at: "2026-07-07T00:00:00Z",
            },
          ],
          next_cursor: null,
        });
      }
      if (method === "POST" && url === "/api/v1/assistant/conversations") {
        return json({
          id: CONV_ID,
          title: null,
          created_at: "2026-07-07T00:00:00Z",
          updated_at: "2026-07-07T00:00:00Z",
          last_message_at: null,
        });
      }
      if (method === "GET" && url.includes("/messages")) {
        return json({ messages: transcript, next_cursor: null });
      }
      if (method === "POST" && url.endsWith("/messages")) {
        const parsed = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        posted.push({ body: parsed });
        const text = String(parsed.text ?? "");
        return json({
          messages: [
            {
              id: `u-${posted.length}`,
              kind: "user",
              payload: { kind: "user", text },
              created_at: "2026-07-07T00:00:01Z",
            },
            {
              id: `a-${posted.length}`,
              kind: "assistant",
              payload: {
                kind: "assistant",
                turn_id: `t-${posted.length}`,
                answer_markdown: `Reply to: ${text}`,
                links: [],
                tool_calls: [],
              },
              created_at: "2026-07-07T00:00:02Z",
            },
          ],
          next_cursor: null,
        });
      }
      return json({ title: "Not Found", status: 404 }, 404);
    }),
  );
  return { posted };
}

function NavProbe() {
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <div>
      <span data-testid="route">{location.pathname}</span>
      <button type="button" data-testid="go-chats" onClick={() => navigate("/chats")}>
        Go chats
      </button>
      <button type="button" data-testid="outside-btn">
        Outside
      </button>
    </div>
  );
}

function renderQuickChat(initialPath = "/") {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialPath]}>
        <Routes>
          <Route path="/assistant" element={<AssistantPage />} />
          <Route path="*" element={<NavProbe />} />
        </Routes>
        <AssistantPopover />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  window.sessionStorage.clear();
  resetAssistantSpeechState();
  recognizers.length = 0;
  recorders.length = 0;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  window.sessionStorage.clear();
});

describe("QuickChat chrome and lifecycle", () => {
  it("stays open on outside click and on route changes; closes via × and Esc-inside", async () => {
    stubServer();
    renderQuickChat("/");

    act(() => openAsk());
    const panel = await screen.findByTestId("quick-chat");
    expect(panel.getAttribute("role")).toBe("complementary");
    expect(panel.getAttribute("aria-label")).toBe("Quick chat");

    // Outside click does NOT close Quick chat.
    fireEvent.mouseDown(screen.getByTestId("outside-btn"));
    fireEvent.click(screen.getByTestId("outside-btn"));
    expect(screen.getByTestId("quick-chat")).toBeTruthy();

    // Esc while focus is OUTSIDE Quick chat does NOT close it.
    screen.getByTestId("outside-btn").focus();
    fireEvent.keyDown(screen.getByTestId("outside-btn"), { key: "Escape" });
    expect(screen.getByTestId("quick-chat")).toBeTruthy();

    // Navigation does NOT close Quick chat.
    fireEvent.click(screen.getByTestId("go-chats"));
    expect(screen.getByTestId("route").textContent).toBe("/chats");
    expect(screen.getByTestId("quick-chat")).toBeTruthy();

    // Esc while focus is INSIDE Quick chat closes it.
    const input = screen.getByTestId("assistant-composer-input");
    input.focus();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByTestId("quick-chat")).toBeNull();

    // Re-open and close via × (`quick-chat-close`).
    act(() => openAsk());
    await screen.findByTestId("quick-chat");
    fireEvent.click(screen.getByTestId("quick-chat-close"));
    expect(screen.queryByTestId("quick-chat")).toBeNull();
  });

  it("⌘J toggles Quick chat and focuses the reply field", async () => {
    stubServer();
    renderQuickChat("/");

    expect(screen.queryByTestId("quick-chat")).toBeNull();
    fireEvent.keyDown(window, { key: "j", metaKey: true });
    await screen.findByTestId("quick-chat");
    expect(document.activeElement).toBe(screen.getByTestId("assistant-composer-input"));

    fireEvent.keyDown(window, { key: "j", metaKey: true });
    expect(screen.queryByTestId("quick-chat")).toBeNull();
  });

  it("renders user bubbles right-aligned, assistant answers left-aligned, and mic icon on dictated messages", async () => {
    stubRecorder();
    const { posted } = stubServer({ transcriptionText: "status of relay" });
    renderQuickChat("/");

    act(() => openAsk());
    await screen.findByTestId("quick-chat");

    // Typed message: no voice icon.
    const input = screen.getByTestId("assistant-composer-input");
    fireEvent.change(input, { target: { value: "typed ask" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(posted).toHaveLength(1));

    const bubbles = screen.getAllByTestId("assistant-msg-user");
    expect(bubbles[0].className).toContain("self-end");
    expect(within(bubbles[0]).queryByTestId("assistant-spoken")).toBeNull();
    expect(screen.getByTestId("assistant-msg-assistant").className).toContain("text-left");

    // Dictated message via Hold-to-Talk: shows mic icon before the text even when server echo omits spoken.
    await act(async () => {
      dispatchHoldAction("start");
    });
    expect(await screen.findByTestId("listening-capsule")).toBeTruthy();
    await act(async () => {
      dispatchHoldAction("stop");
    });
    await waitFor(() => expect(posted).toHaveLength(2));
    const userRows = screen.getAllByTestId("assistant-msg-user");
    expect(userRows[1].getAttribute("data-via")).toBe("voice");
    expect(within(userRows[1]).getByTestId("assistant-spoken")).toBeTruthy();
  });

  it("shows the dark listening capsule while recording and stops on Stop click", async () => {
    vi.stubGlobal("SpeechRecognition", FakeRecognition);
    stubServer({ speechConfigured: false, browserFallback: true });
    renderQuickChat("/");
    await act(async () => {
      await flushAssistantSpeechReads();
    });

    act(() => openAsk());
    await screen.findByTestId("quick-chat");

    fireEvent.click(screen.getByTestId("mic-button"));
    const capsule = await screen.findByTestId("listening-capsule");
    expect(capsule.textContent).toContain("Listening…");
    expect(screen.getByTestId("mic-button").className).toContain("bg-[#2f4bd6]");

    const rec = recognizers[recognizers.length - 1];
    act(() => {
      rec.deliver("check logs", false);
    });
    expect(capsule.textContent).toContain("check logs");

    fireEvent.click(screen.getByTestId("listening-capsule-stop"));
    expect(screen.queryByTestId("listening-capsule")).toBeNull();
    expect((screen.getByTestId("assistant-composer-input") as HTMLTextAreaElement).value).toBe(
      "check logs",
    );
  });

  it("shows 'Didn't catch that.' in the capsule for 2s when hold-to-talk ends empty", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("SpeechRecognition", FakeRecognition);
    const { posted } = stubServer({ speechConfigured: false, browserFallback: true });
    renderQuickChat("/");
    await act(async () => {
      await flushAssistantSpeechReads();
    });

    act(() => dispatchHoldAction("start"));
    expect(screen.getByTestId("listening-capsule").textContent).toContain("Listening…");

    act(() => dispatchHoldAction("stop"));
    expect(posted).toHaveLength(0);
    expect(screen.getByTestId("listening-capsule").textContent).toContain("Didn't catch that.");

    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(screen.queryByTestId("listening-capsule")).toBeNull();
  });

  it("startVoiceAsk() and openAsk({ voice: true }) open Quick chat and toggle click-to-send dictation", async () => {
    vi.stubGlobal("SpeechRecognition", FakeRecognition);
    const { posted } = stubServer({ speechConfigured: false, browserFallback: true });
    renderQuickChat("/");
    await act(async () => {
      await flushAssistantSpeechReads();
    });

    act(() => startVoiceAsk());
    await screen.findByTestId("quick-chat");
    expect(screen.getByTestId("listening-capsule")).toBeTruthy();

    const rec = recognizers[recognizers.length - 1];
    act(() => {
      rec.deliver("deploy status");
    });

    // Second startVoiceAsk() stops and sends immediately.
    await act(async () => {
      startVoiceAsk();
    });
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0].body.text).toBe("deploy status");
    expect(posted[0].body.spoken).toBe(true);

    // openAsk({ voice: true }) behaves the same way.
    act(() => openAsk({ voice: true }));
    expect(screen.getByTestId("listening-capsule")).toBeTruthy();
    const rec2 = recognizers[recognizers.length - 1];
    act(() => {
      rec2.deliver("second voice ask");
    });
    await act(async () => {
      openAsk({ voice: true });
    });
    await waitFor(() => expect(posted).toHaveLength(2));
    expect(posted[1].body.text).toBe("second voice ask");
  });

  it("disables mic with reason when speech is unavailable", async () => {
    stubServer({ speechConfigured: false, browserFallback: false });
    renderQuickChat("/");
    await act(async () => {
      await flushAssistantSpeechReads();
    });

    act(() => openAsk());
    const mic = (await screen.findByTestId("mic-button")) as HTMLButtonElement;
    expect(mic.disabled).toBe(true);
    expect(mic.title).toContain("unavailable");
  });

  it("Open as chat links to /assistant and opens the full page for the thread", async () => {
    stubServer();
    renderQuickChat("/");

    act(() => openAsk());
    const link = (await screen.findByTestId("quick-chat-open-as-chat")) as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("/assistant");

    fireEvent.click(link);
    await screen.findByTestId("assistant-page");
    expect(screen.queryByTestId("quick-chat")).toBeNull();
    expect(screen.getByTestId("assistant-panel").dataset.variant).toBe("page");
  });
});
