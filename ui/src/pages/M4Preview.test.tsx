/**
 * The dev-only preview must be provably *fixture*-driven: a block that silently
 * fell back to a live endpoint would screenshot like a real run.
 */
import { afterEach } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import M4Preview from "./M4Preview";
import { mockFetch } from "../test/fakes";
import { renderApp } from "../test/render";

// Vitest globals are off, so testing-library cannot register its own cleanup.
afterEach(cleanup);

describe("M4Preview", () => {
  it("renders every building block without contacting the API", () => {
    const { fetchMock, requests } = mockFetch([]);
    render(<M4Preview />);

    expect(screen.getByTestId("m4-preview-notice").textContent).toMatch(/fixtures, not a run/i);
    // Several blocks appear twice on purpose: the looping run and the fan-out
    // run are different shapes, and the preview must show both without hiding
    // either behind a tab.
    expect(screen.getAllByTestId("pipeline-library")).toHaveLength(1);
    expect(screen.getAllByTestId("yaml-view")).toHaveLength(2);
    expect(screen.getAllByTestId("definition-graph")).toHaveLength(2);
    expect(screen.getAllByTestId("run-stage-strip")).toHaveLength(2);
    expect(screen.getAllByTestId("run-tree")).toHaveLength(2);
    expect(screen.getByTestId("attempt-outputs")).toBeTruthy();
    expect(screen.getByTestId("attempt-checkpoint")).toBeTruthy();
    expect(screen.getByTestId("approval-approve")).toBeTruthy();

    expect(requests).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("wires the graph's selection to the YAML highlight and the tree's toggle", () => {
    mockFetch([]);
    render(<M4Preview />);
    fireEvent.click(screen.getByTestId("definition-graph-list-verdict"));
    expect(screen.getByTestId("definition-graph-inspector-id").textContent).toBe("verdict");

    // The fan-out scope starts expanded on the preview, so one click collapses it
    // and the next one brings its places back — 25 places, ten to a page.
    fireEvent.click(screen.getByTestId("run-tree-toggle-/verify_each"));
    expect(screen.queryAllByTestId("run-tree-row-/verify_each[1]")).toHaveLength(0);
    fireEvent.click(screen.getByTestId("run-tree-toggle-/verify_each"));
    expect(screen.getAllByTestId(/^run-tree-row-\/verify_each\[\d+\]$/)).toHaveLength(10);
    // The page says what it is hiding rather than leaving a short list unexplained.
    expect(screen.getByTestId("run-tree-row-more:/verify_each").textContent).toContain("15 more");
  });

  it("is reachable through the app at its dev path, with no session check", async () => {
    // Shell asks the API who the user is; the preview renders outside it, so
    // mounting the whole app at this path must still touch the network zero
    // times. That is the guard against a fixture page quietly gaining a
    // `/session` call and screenshotting like a live screen.
    const { requests } = renderApp({ path: "/__m4-preview" });
    // Lazy, so it arrives a tick late; the assertion is that it arrives at all.
    await screen.findByTestId("m4-preview");
    expect(requests).toHaveLength(0);
  });
});
