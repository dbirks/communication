/**
 * The Ask box splits (ADR-0050): the jump half is this palette — the chord
 * opens it (via the popover while the assistant is on screen, via
 * `openPalette()` here), typing filters, arrows and Enter move the router.
 * The ask half is the assistant popover (`assistant/AssistantPopover.tsx`):
 * the chord opens it first, the Ask row hands the question over (posted with
 * the route context), a 503 leaves the jump list alone, and the honest line
 * says the assistant is not configured. The router assertion uses a location
 * probe rather than a screenshot of a page.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import CommandPalette, { openPalette } from "./CommandPalette";
import AssistantPopover from "./assistant/AssistantPopover";
import { shortId } from "../api/names";
import {
  claudeProfile,
  codexProfile,
  meFixture,
  mockFetch,
  projectFixture,
  requestsTo,
  type RouteStub,
} from "../test/fakes";
import {
  WIRE_RUN_ID,
  wirePipelineList,
  wireProjectId,
  wireRunList,
} from "../test/fixtures/m4/wire";

const runsPath = `/api/v1/projects/${wireProjectId}/runs`;

const assistantConversationsPath = "/api/v1/assistant/conversations";
const assistantMessagesPath = `${assistantConversationsPath}/conv-1/messages`;

/** The one conversation the create stub returns (id `conv-1`). */
const assistantConversation = {
  id: "conv-1",
  title: null,
  created_at: "2026-07-07T00:00:00Z",
  updated_at: "2026-07-07T00:00:00Z",
  last_message_at: null,
};

/** One scripted turn: prose, a jump it justifies, and the tools behind both. */
const turnAnswerFixture = {
  answer_markdown: "Two runs wait on you.\n\nBoth stop at `build_until_verified`.",
  links: [
    { label: "Open the board", route: "/board" },
    { label: "The stalled run", route: `/runs/${WIRE_RUN_ID}` },
  ],
  tool_calls: [
    { name: "approval.pending", summary: "Saw 2 pending approvals.", ok: true },
    { name: "run.list", summary: "Could not list the runs.", ok: false, reason: "not_found" },
  ],
  turn_id: "01TURN",
  degraded: null,
};

/** The wire rows the messages POST appends for a turn (the `user` row first). */
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

function routes(extra: RouteStub[] = []): RouteStub[] {
  return [
    ...extra,
    { path: "/api/v1/me", body: meFixture },
    { path: "/api/v1/projects", body: { items: [projectFixture] } },
    { path: "/api/v1/pipelines", body: wirePipelineList },
    { path: runsPath, body: wireRunList },
    { path: "/api/v1/agent-profiles", body: { items: [claudeProfile, codexProfile] } },
    // The popover reads the caller's conversations while open; an empty page
    // keeps the tests' conversations fresh.
    {
      path: assistantConversationsPath,
      method: "GET",
      body: { conversations: [], next_cursor: null },
    },
  ];
}

/** The palette drives the router; this is how a test sees where it landed. */
function Where() {
  return <div data-testid="where">{useLocation().pathname}</div>;
}

/** The shell mounts the palette and the popover together — so do the tests. */
function mountPalette(path = "/inbox", extra: RouteStub[] = []) {
  const harness = mockFetch(routes(extra));
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <CommandPalette context="inbox" />
        <AssistantPopover />
        <Routes>
          <Route path="*" element={<Where />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return harness;
}

/** Ctrl+K / Cmd+K, whichever the host platform would send. */
function pressChord(meta = false) {
  fireEvent.keyDown(window, { key: "k", ctrlKey: !meta, metaKey: meta });
}

afterEach(cleanup);

describe("CommandPalette", () => {
  it("opens the assistant popover on Ctrl+K, and the jump palette on the chord over it", async () => {
    mountPalette();
    expect(screen.queryByTestId("assistant-popover")).toBeNull();

    pressChord();
    expect(screen.getByTestId("assistant-popover")).toBeTruthy();

    // The assistant is already on screen, so the chord lands on the jumps.
    pressChord();
    const dialog = await screen.findByRole("dialog");
    expect(screen.getByTestId("palette-footer").textContent).toContain(
      "The Ask row opens the assistant popover",
    );
    // The sections are jumpable before anything has even loaded.
    expect(within(dialog).getByText("Inbox")).toBeTruthy();
    expect(within(dialog).getByText("Operations")).toBeTruthy();
    // The input drives the list it filters (combobox pattern).
    const input = screen.getByTestId("palette-input");
    expect(input.getAttribute("aria-controls")).toBe("palette-listbox");
    expect(input.getAttribute("aria-expanded")).toBe("true");
  });

  it("filters case-insensitively on the label and on the secondary line", async () => {
    mountPalette();
    openPalette();
    const input = await screen.findByTestId("palette-input");

    fireEvent.change(input, { target: { value: "MODU" } });
    const list = screen.getByRole("listbox");
    expect(await within(list).findByText("Module check")).toBeTruthy();
    expect(within(list).queryByText("Operations")).toBeNull();

    // "running" appears in no label — only in a run row's secondary text.
    fireEvent.change(input, { target: { value: "running" } });
    expect(
      await within(list).findByText(`feature-development #${shortId(WIRE_RUN_ID)}`),
    ).toBeTruthy();
    expect(within(list).queryByText("Inbox")).toBeNull();
  });

  it("moves the router with ArrowDown and Enter, and closes when it goes", async () => {
    mountPalette();
    expect((await screen.findByTestId("where")).textContent).toBe("/inbox");

    openPalette();
    const input = await screen.findByTestId("palette-input");
    await waitFor(() =>
      expect(input.getAttribute("aria-activedescendant")).toBe("palette-option-0"),
    );

    // Inbox is first; one step down is Projects at "/projects".
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input.getAttribute("aria-activedescendant")).toBe("palette-option-1");
    expect(screen.getByRole("option", { selected: true }).textContent).toContain("Projects");

    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByTestId("where").textContent).toBe("/projects");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("closes on Esc and on a press outside the panel", async () => {
    mountPalette();
    openPalette();
    const input = await screen.findByTestId("palette-input");
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();

    openPalette();
    await screen.findByRole("dialog");
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens from the app bar box, whose chip carries the current section", async () => {
    mountPalette();
    const box = screen.getByTestId("ask-box");
    expect(box.textContent).toContain("inbox");
    expect(box.textContent).toContain("Ctrl K");

    fireEvent.click(box);
    expect(await screen.findByRole("dialog")).toBeTruthy();
  });

  it("jumps straight to a project's recent run, and offers its sub-pages", async () => {
    mountPalette();
    openPalette();
    const list = await screen.findByRole("listbox");

    // The row is named the way the runs list names it: pipeline slug + short id.
    const label = await within(list).findByText(`feature-development #${shortId(WIRE_RUN_ID)}`);
    expect(within(list).getByText(`recent run · ${projectFixture.name} · running`)).toBeTruthy();
    expect(within(list).getByText(`${projectFixture.name} · Settings`)).toBeTruthy();

    fireEvent.click(label.closest('[role="option"]') as HTMLElement);
    expect((await screen.findByTestId("where")).textContent).toBe(`/runs/${WIRE_RUN_ID}`);
  });

  it("offers the question as the first row once there is text to ask", async () => {
    mountPalette();
    openPalette();
    const input = await screen.findByTestId("palette-input");

    // No text means no question: an empty box is a jump list and nothing else.
    expect(screen.queryByTestId("palette-ask")).toBeNull();

    fireEvent.change(input, { target: { value: "which runs" } });
    expect((await screen.findByTestId("palette-ask")).textContent).toContain("Ask: which runs");

    // The Ask row leads both the caret and the list it lives in.
    expect(input.getAttribute("aria-activedescendant")).toBe("palette-option-0");
    expect(screen.getAllByRole("option")[0].getAttribute("data-testid")).toBe("palette-ask");
  });

  it("posts the question with the route context to the popover on Enter", async () => {
    const { requests } = mountPalette(`/p/${wireProjectId}/runs`, [
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

    // The Ask row hands the question to the popover and gets out of the way.
    const popover = await screen.findByTestId("assistant-popover");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(within(popover).getByTestId("assistant-msg-user").textContent).toContain(
      "what is failing here?",
    );
    // The turn posts as a plain user message; `context.route` is the
    // on-screen route, so "here" means this project.
    const posted = requestsTo(requests, assistantMessagesPath, "POST");
    expect(posted).toHaveLength(1);
    expect(JSON.parse(posted[0].body ?? "{}")).toEqual({
      text: "what is failing here?",
      context: { route: `/p/${wireProjectId}/runs`, project_id: wireProjectId },
    });
  });

  it("says thinking… while the turn is in flight, then answers and jumps", async () => {
    const { requests } = mountPalette("/inbox", [
      { path: assistantConversationsPath, method: "POST", body: assistantConversation },
      {
        path: assistantMessagesPath,
        method: "POST",
        body: turnMessagesBody("which runs wait on me?"),
      },
    ]);

    // Hold the answer back so "pending" is observed rather than assumed: the
    // stub's own resolution is only a microtask away.
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

    // Pending: a muted line in the popover, whose composer stays the surface.
    await screen.findByTestId("assistant-popover");
    expect((await screen.findByTestId("assistant-thinking")).textContent).toContain("thinking…");
    expect(screen.getByTestId("assistant-composer-input")).toBeTruthy();
    expect(requestsTo(requests, assistantMessagesPath, "POST")).toHaveLength(1);

    release();
    const answer = await screen.findByTestId("assistant-answer");
    expect(within(answer).getByText("Two runs wait on you.")).toBeTruthy();
    expect(within(answer).getByText("build_until_verified").tagName).toBe("CODE");

    // The tools it used are transparency, folded away until asked for.
    const tools = screen.getByTestId("assistant-tools");
    expect(tools.textContent).toContain("used 2 tools");
    expect(tools.tagName).toBe("DETAILS");
    expect(tools.hasAttribute("open")).toBe(false);
    expect(tools.textContent).toContain("approval.pending");
    expect(tools.textContent).toContain("run.list");
    expect(tools.textContent).toContain("not_found");

    // A link is a jump: it navigates and gets out of the way.
    const link = screen.getAllByTestId("assistant-link")[0];
    expect(link.tagName).toBe("BUTTON");
    fireEvent.click(link);
    expect((await screen.findByTestId("where")).textContent).toBe("/board");
  });

  it("keeps the jump list when the server has no assistant", async () => {
    mountPalette("/inbox", [
      { path: assistantConversationsPath, method: "POST", body: assistantConversation },
      notConfiguredStub,
    ]);
    openPalette();
    const input = await screen.findByTestId("palette-input");

    // A query that also names a jump target — the jump must survive the failure.
    fireEvent.change(input, { target: { value: "Oper" } });
    await screen.findByTestId("palette-ask");
    fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });

    // The popover carries the failure honestly: one line, nothing faked.
    const line = await screen.findByTestId("assistant-error");
    expect(line.textContent).toContain("isn't configured on this server");
    expect(line.textContent).not.toContain("model base URL");
    // The jump half is untouched by the assistant's 503: the palette's list
    // still lands on the same target.
    openPalette();
    expect(within(await screen.findByRole("listbox")).getByText("Operations")).toBeTruthy();
  });
});
