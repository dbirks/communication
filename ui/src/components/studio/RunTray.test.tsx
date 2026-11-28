import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { RunTrayProps, TrayLogLine, TrayRound } from "./RunTray";
import { RunTray } from "./RunTray";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const rounds: TrayRound[] = [
  { round: 1, verdict: "not_yet", reason: "Tests still fail on the parser." },
  { round: 2, verdict: "running", reason: "Agent is writing the fix." },
  { round: 3, verdict: "done", reason: "All green." },
  { round: 4, verdict: "failed", reason: "Sandbox lost the workspace." },
];

const log: TrayLogLine[] = [
  { at: "14:02:11", step: "write the fix", text: "started" },
  { at: "14:02:19", step: "write the fix", text: "edited parser.go" },
  { at: "14:03:02", step: "judge", text: "verdict not_yet" },
];

function renderTray(overrides: Partial<RunTrayProps> = {}) {
  const props: RunTrayProps = {
    state: { glyph: "●", word: "Running", tone: "running" },
    title: "Try it on #42",
    meta: "round 2 of up to 3 · 1m 42s",
    rounds,
    log,
    tab: "rounds",
    onTab: vi.fn(),
    onRound: vi.fn(),
    onStop: vi.fn(),
    collapsed: false,
    onToggleCollapsed: vi.fn(),
    height: 240,
    onResize: vi.fn(),
    ...overrides,
  };
  render(<RunTray {...props} />);
  return props;
}

it("shows the state tag text and its tone class", () => {
  renderTray();
  const header = screen.getByTestId("run-tray-header");
  const tag = header.querySelector("span");
  expect(tag?.textContent).toBe("● Running");
  expect(tag?.className).toContain("bg-st-running-tag");
  expect(tag?.className).toContain("text-st-running-tag-fg");
  expect(tag?.className).toContain("font-mono");
  // Title and meta ride the same row.
  expect(header.textContent).toContain("Try it on #42");
  expect(header.textContent).toContain("round 2 of up to 3 · 1m 42s");
});

it("the queued tone has no colour of its own", () => {
  renderTray({ state: { glyph: "·", word: "Queued", tone: "queued" } });
  const tag = screen.getByTestId("run-tray-header").querySelector("span");
  expect(tag?.textContent).toBe("· Queued");
  expect(tag?.className).toContain("bg-fill");
  expect(tag?.className).toContain("text-ink-2");
});

it("the segmented control is a tablist that reports the active tab", () => {
  const { onTab } = renderTray({ tab: "rounds" });
  const tabs = screen.getAllByRole("tab");
  expect(tabs.map((tab) => tab.textContent)).toEqual(["Rounds", "Log", "Output"]);
  expect(screen.getByTestId("run-tray-tab-rounds").getAttribute("aria-selected")).toBe("true");
  expect(screen.getByTestId("run-tray-tab-log").getAttribute("aria-selected")).toBe("false");
  fireEvent.click(screen.getByTestId("run-tray-tab-log"));
  expect((onTab as ReturnType<typeof vi.fn>).mock.calls).toEqual([["log"]]);
});

it("the log tab keeps the log full width and drops the round list", () => {
  renderTray({ tab: "log" });
  expect(screen.getByTestId("run-tray-tab-log").getAttribute("aria-selected")).toBe("true");
  expect(screen.queryByTestId("run-tray-rounds")).toBeNull();
  expect(screen.getByTestId("run-tray-log")).toBeTruthy();
});

it("the output tab shows what the orchestrator provides, else a placeholder", () => {
  renderTray({ tab: "output", output: <pre>artifact body</pre> });
  expect(screen.getByTestId("run-tray-tab-output").getAttribute("aria-selected")).toBe("true");
  expect(screen.getByTestId("run-tray-output").textContent).toBe("artifact body");
  expect(screen.queryByTestId("run-tray-rounds")).toBeNull();
  cleanup();

  renderTray({ tab: "output" });
  const body = screen.getByTestId("run-tray-output");
  expect(body.textContent).toBe("No output yet.");
  expect(body.querySelector("span")?.className).toContain("text-muted");
});

it("Stop only renders with onStop and calls it", () => {
  const withStop = renderTray();
  const stop = screen.getByTestId("run-tray-stop");
  fireEvent.click(stop);
  expect((withStop.onStop as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  cleanup();

  renderTray({ onStop: undefined });
  expect(screen.queryByTestId("run-tray-stop")).toBeNull();
});

it("collapsing hides the body and flips the chevron label", () => {
  const open = renderTray({ collapsed: false });
  expect(screen.getByTestId("run-tray-body")).toBeTruthy();
  expect(screen.getByTestId("run-tray-collapse").getAttribute("aria-label")).toBe(
    "Collapse run tray",
  );
  expect(screen.getByTestId("run-tray-header").className).toContain("border-b");
  expect(screen.getByTestId("run-tray-resize")).toBeTruthy();
  fireEvent.click(screen.getByTestId("run-tray-collapse"));
  expect((open.onToggleCollapsed as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  cleanup();

  renderTray({ collapsed: true });
  expect(screen.queryByTestId("run-tray-body")).toBeNull();
  expect(screen.queryByTestId("run-tray-rounds")).toBeNull();
  expect(screen.queryByTestId("run-tray-log")).toBeNull();
  expect(screen.getByTestId("run-tray-collapse").getAttribute("aria-label")).toBe(
    "Expand run tray",
  );
  expect(screen.getByTestId("run-tray-header").className).not.toContain("border-b");
});

it("round rows render the verdict words and mark the active round", () => {
  renderTray({ activeRound: 2 });
  const list = screen.getByTestId("run-tray-rounds");
  expect(
    Array.from(list.querySelectorAll("[data-testid^='run-tray-round-'] span:first-child")).map(
      (el) => el.textContent,
    ),
  ).toEqual(["R1", "R2", "R3", "R4"]);
  expect(list.textContent).toContain("× NOT YET");
  expect(list.textContent).toContain("● RUNNING");
  expect(list.textContent).toContain("✓ DONE");
  expect(list.textContent).toContain("× FAILED");
  expect(screen.getByTestId("run-tray-round-2").className).toContain("bg-accent-wash");
  expect(screen.getByTestId("run-tray-round-1").className).not.toContain("bg-accent-wash");
  // The reason is the judge's one-liner.
  expect(screen.getByTestId("run-tray-round-1").textContent).toContain(
    "Tests still fail on the parser.",
  );
});

it("onRound fires with the round number; without it the rows are not buttons", () => {
  const { onRound } = renderTray();
  fireEvent.click(screen.getByTestId("run-tray-round-3"));
  expect((onRound as ReturnType<typeof vi.fn>).mock.calls).toEqual([[3]]);
  cleanup();

  renderTray({ onRound: undefined });
  expect(screen.queryByTestId("run-tray-round-3")).toBeNull();
  expect(screen.getByTestId("run-tray-rounds").querySelectorAll("button")).toHaveLength(0);
});

it("a workflow without a loop says so", () => {
  renderTray({ rounds: [] });
  expect(screen.getByTestId("run-tray-rounds").textContent).toBe("This workflow has no loop.");
});

it("the log lists every line, or only the named step", () => {
  renderTray({ tab: "log" });
  const panel = screen.getByTestId("run-tray-log");
  expect(panel.textContent).toContain("LOG");
  expect(panel.textContent).not.toContain("LOG ·");
  expect(panel.querySelectorAll("li")).toHaveLength(3);

  cleanup();
  renderTray({ tab: "log", logStep: "write the fix" });
  const filtered = screen.getByTestId("run-tray-log");
  expect(filtered.textContent).toContain("LOG · WRITE THE FIX");
  const lines = Array.from(filtered.querySelectorAll("li")).map((li) => li.textContent);
  expect(lines).toEqual(["14:02:11 started", "14:02:19 edited parser.go"]);
  // Timestamps are the faint column.
  expect(filtered.querySelector("li > span")?.className).toContain("text-faint");

  cleanup();
  renderTray({ tab: "log", logStep: "judge" });
  expect(screen.getByTestId("run-tray-log").textContent).toContain("LOG · JUDGE");
  expect(screen.getByTestId("run-tray-log").querySelectorAll("li")).toHaveLength(1);
});

it("an empty log has its own placeholder", () => {
  renderTray({ tab: "log", log: [] });
  expect(screen.getByTestId("run-tray-log").textContent).toContain("Nothing logged yet.");
});

it("the body honours the height it is given", () => {
  renderTray({ height: 320 });
  expect(screen.getByTestId("run-tray-body").getAttribute("style")).toContain("height: 320px");
});

it("dragging the top edge resizes: up is taller, clamped to 60% of the window", () => {
  vi.stubGlobal("innerHeight", 1000);
  const { onResize } = renderTray({ height: 240 });
  const handle = screen.getByTestId("run-tray-resize");
  expect(handle.getAttribute("role")).toBe("separator");
  expect(handle.getAttribute("aria-orientation")).toBe("horizontal");
  expect(handle.getAttribute("aria-label")).toBe("Resize run tray");
  expect(handle.className).toContain("cursor-ns-resize");
  expect(handle.className).toContain("h-[6px]");

  fireEvent.pointerDown(handle, { pointerId: 1, clientY: 500 });
  fireEvent.pointerMove(handle, { pointerId: 1, clientY: 460 });
  fireEvent.pointerMove(handle, { pointerId: 1, clientY: 430 });
  fireEvent.pointerUp(handle, { pointerId: 1 });
  expect((onResize as ReturnType<typeof vi.fn>).mock.calls).toEqual([[280], [310]]);

  // Pushing far down clamps at the 120px floor, far up at 60% of the window.
  (onResize as ReturnType<typeof vi.fn>).mockClear();
  fireEvent.pointerDown(handle, { pointerId: 2, clientY: 100 });
  fireEvent.pointerMove(handle, { pointerId: 2, clientY: 5000 });
  fireEvent.pointerDown(handle, { pointerId: 3, clientY: 5000 });
  fireEvent.pointerMove(handle, { pointerId: 3, clientY: 0 });
  expect((onResize as ReturnType<typeof vi.fn>).mock.calls).toEqual([[120], [600]]);
});

it("the focused handle steps 20px per key and clamps at the maximum", () => {
  vi.stubGlobal("innerHeight", 1000);
  const { onResize } = renderTray({ height: 240 });
  const handle = screen.getByTestId("run-tray-resize");
  fireEvent.keyDown(handle, { key: "ArrowUp" });
  fireEvent.keyDown(handle, { key: "ArrowDown" });
  const calls = (onResize as ReturnType<typeof vi.fn>).mock.calls;
  expect(calls[0]).toEqual([260]);
  expect(calls[1]).toEqual([220]);

  cleanup();
  (onResize as ReturnType<typeof vi.fn>).mockClear();
  renderTray({ height: 595, onResize });
  fireEvent.keyDown(screen.getByTestId("run-tray-resize"), { key: "ArrowUp" });
  expect((onResize as ReturnType<typeof vi.fn>).mock.calls).toEqual([[600]]);

  cleanup();
  (onResize as ReturnType<typeof vi.fn>).mockClear();
  renderTray({ height: 125, onResize });
  fireEvent.keyDown(screen.getByTestId("run-tray-resize"), { key: "ArrowDown" });
  expect((onResize as ReturnType<typeof vi.fn>).mock.calls).toEqual([[120]]);
});
