/**
 * The Ask box is a jump list, not an assistant: the chord opens it, typing
 * filters, arrows and Enter move the router, Esc gets out — and a project's
 * recent runs are reachable by name without opening the project first. The
 * router assertion uses a location probe rather than a screenshot of a page.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import CommandPalette from "./CommandPalette";
import { shortId } from "../api/names";
import {
  claudeProfile,
  codexProfile,
  meFixture,
  mockFetch,
  projectFixture,
  type RouteStub,
} from "../test/fakes";
import {
  WIRE_RUN_ID,
  wirePipelineList,
  wireProjectId,
  wireRunList,
} from "../test/fixtures/m4/wire";

const runsPath = `/api/v1/projects/${wireProjectId}/runs`;

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

function mountPalette(path = "/inbox") {
  mockFetch(routes());
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
      "Jump only — the assistant arrives later.",
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

    // Inbox is first; one step down is Projects at "/".
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input.getAttribute("aria-activedescendant")).toBe("palette-option-1");
    expect(screen.getByRole("option", { selected: true }).textContent).toContain("Projects");

    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByTestId("where").textContent).toBe("/");
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
    expect((await screen.findByTestId("where")).textContent).toBe(
      `/projects/${wireProjectId}/runs/${WIRE_RUN_ID}`,
    );
  });
});
