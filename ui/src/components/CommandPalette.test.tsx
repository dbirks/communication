/**
 * The Ask box is a jump list *and* — since ADR-0034 — the one read-only
 * question the server will answer: the chord opens it, typing filters, arrows
 * and Enter move the router, Enter on the Ask row posts the question with the
 * route context, a link answers with a jump, and a 503 leaves the list alone.
 * The router assertion uses a location probe rather than a screenshot of a page.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import CommandPalette from "./CommandPalette";
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

const askPath = "/api/v1/assistant/ask";

/** One scripted turn: prose, a jump it justifies, and the tools behind both. */
const answerFixture = {
  answer_markdown: "Two runs wait on you.\n\nBoth stop at `build_until_verified`.",
  links: [
    { label: "Open approvals", href: `/projects/${wireProjectId}/approvals` },
    { label: "The stalled run", href: `/projects/${wireProjectId}/runs/${WIRE_RUN_ID}` },
  ],
  tool_calls: [
    { name: "approval.pending", args: { project_id: wireProjectId }, ok: true },
    { name: "run.list", ok: false, reason: "not_found" },
  ],
  assistant_turn_id: "01TURN",
  degraded: null,
};

const notConfiguredStub: RouteStub = {
  path: askPath,
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
  ];
}

/** The palette drives the router; this is how a test sees where it landed. */
function Where() {
  return <div data-testid="where">{useLocation().pathname}</div>;
}

function mountPalette(path = "/inbox", extra: RouteStub[] = []) {
  const harness = mockFetch(routes(extra));
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <CommandPalette context="inbox" />
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
  it("opens on Ctrl+K and names itself as a jump, not an answer", async () => {
    mountPalette();
    expect(screen.queryByRole("dialog")).toBeNull();

    pressChord();
    const dialog = await screen.findByRole("dialog");
    expect(screen.getByTestId("palette-footer").textContent).toContain(
      "Read-only assistant — it can look things up and link you there; it cannot act.",
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
    pressChord(true);
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

    pressChord();
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
    pressChord();
    const input = await screen.findByTestId("palette-input");
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();

    pressChord();
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
    pressChord();
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
    pressChord();
    const input = await screen.findByTestId("palette-input");

    // No text means no question: an empty box is a jump list and nothing else.
    expect(screen.queryByTestId("palette-ask")).toBeNull();

    fireEvent.change(input, { target: { value: "which runs" } });
    expect((await screen.findByTestId("palette-ask")).textContent).toContain("Ask: which runs");

    // The Ask row leads both the caret and the list it lives in.
    expect(input.getAttribute("aria-activedescendant")).toBe("palette-option-0");
    expect(screen.getAllByRole("option")[0].getAttribute("data-testid")).toBe("palette-ask");
  });

  it("posts the question with the route context on Enter", async () => {
    const { requests } = mountPalette(`/projects/${wireProjectId}/runs`, [
      { path: askPath, method: "POST", body: answerFixture },
    ]);
    pressChord();
    const input = await screen.findByTestId("palette-input");
    fireEvent.change(input, { target: { value: "what is failing here?" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(requestsTo(requests, askPath, "POST")).toHaveLength(1));
    // `context.route` is the on-screen route, so “here” means this project.
    expect(JSON.parse(requestsTo(requests, askPath, "POST")[0].body ?? "{}")).toEqual({
      question: "what is failing here?",
      context: { route: `/projects/${wireProjectId}/runs`, project_id: wireProjectId },
    });
  });

  it("says thinking… while the turn is in flight, then answers and jumps", async () => {
    const { requests } = mountPalette("/inbox", [
      { path: askPath, method: "POST", body: answerFixture },
    ]);

    // Hold the answer back so “pending” is observed rather than assumed: the
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
      if (input === askPath) await gate;
      return response;
    });

    pressChord();
    const input = await screen.findByTestId("palette-input");
    fireEvent.change(input, { target: { value: "which runs wait on me?" } });
    fireEvent.keyDown(input, { key: "Enter" });

    // Pending: a muted line, the list still there, and the box stays editable.
    expect((await screen.findByTestId("assistant-thinking")).textContent).toContain("thinking…");
    expect(screen.getByRole("listbox")).toBeTruthy();
    expect((input as HTMLInputElement).disabled).toBe(false);
    expect(requestsTo(requests, askPath, "POST")).toHaveLength(1);

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
    expect(tools.textContent).toContain("failed");

    // A link is a jump: it navigates and gets out of the way.
    const link = screen.getAllByTestId("assistant-link")[0];
    expect(link.tagName).toBe("BUTTON");
    fireEvent.click(link);
    expect((await screen.findByTestId("where")).textContent).toBe(
      `/projects/${wireProjectId}/approvals`,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("keeps the jump list when the server has no assistant", async () => {
    mountPalette("/inbox", [notConfiguredStub]);
    pressChord();
    const input = await screen.findByTestId("palette-input");

    // A query that also names a jump target — the jump must survive the failure.
    fireEvent.change(input, { target: { value: "Oper" } });
    await screen.findByTestId("palette-ask");
    fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });

    const line = await screen.findByTestId("assistant-error");
    expect(line.textContent).toContain("The assistant isn't configured on this server.");
    expect(screen.getByTestId("assistant-error").textContent).not.toContain("model base URL");
    expect(within(screen.getByRole("listbox")).getByText("Operations")).toBeTruthy();
  });
});
