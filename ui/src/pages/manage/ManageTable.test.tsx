/**
 * The Manage table's own contract (redesign R7): the header cells, the one
 * honest empty sentence, the row that links from its first cell, and the
 * stacked card a row becomes below 640px. Viewport is the input, so the test
 * answers `matchMedia` the way `Shell.test.tsx` does rather than trusting CSS.
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ManageTable, SectionHeader } from "./ManageTable";
import type { ManageColumn, ManageRow } from "./ManageTable";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** Answer `(max-width: …px)` queries as a `width`px viewport would. */
function stubViewport(width: number): void {
  vi.stubGlobal("matchMedia", (query: string) => {
    const max = /max-width:\s*([\d.]+)px/.exec(query);
    const min = /min-width:\s*([\d.]+)px/.exec(query);
    let matches = true;
    if (max) matches = matches && width <= Number(max[1]);
    if (min) matches = matches && width >= Number(min[1]);
    return {
      matches,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    };
  });
}

const COLUMNS: ManageColumn[] = [
  { key: "name", label: "Name" },
  { key: "branch", label: "Default branch" },
];

const ROWS: ManageRow[] = [
  { id: "one", cells: { name: "First row", branch: "main" }, href: "/p/one/first-row" },
  { id: "two", cells: { name: "Second row", branch: "trunk" } },
];

function renderTable(props: Partial<Parameters<typeof ManageTable>[0]> = {}) {
  return render(
    <MemoryRouter>
      <ManageTable columns={COLUMNS} rows={ROWS} empty="Nothing here yet" testid="t" {...props} />
    </MemoryRouter>,
  );
}

describe("ManageTable", () => {
  it("draws a header cell per column and a row per record", async () => {
    stubViewport(1280);
    renderTable();
    const table = await screen.findByTestId("t");
    expect(table.tagName).toBe("TABLE");
    const headers = table.querySelectorAll("th");
    expect(headers).toHaveLength(2);
    expect(headers[0]!.textContent).toBe("Name");
    expect(headers[1]!.textContent).toBe("Default branch");
    expect(table.querySelectorAll("tbody tr")).toHaveLength(2);
    expect(screen.getByTestId("t-row-one").textContent).toContain("First row");
  });

  it("sits in a card at desktop: 1px line, radius 12, white, 16px side padding, header inside (review 15-1280-2)", async () => {
    stubViewport(1280);
    renderTable();
    const card = await screen.findByTestId("t-card");
    const table = screen.getByTestId("t");
    expect(card.querySelector("table")).toBe(table);
    expect(card.className).toContain("rounded-[12px]");
    expect(card.className).toContain("border-line");
    expect(card.className).toContain("bg-surface");
    // The header row is printed inside the frame, and the table's wrapper
    // carries the 16px inner side padding.
    expect(table.querySelector("thead th")).toBeTruthy();
    expect(card.firstElementChild?.className).toContain("px-[16px]");
  });

  it("prints the empty sentence and no table when there are no rows", async () => {
    stubViewport(1280);
    renderTable({ rows: [] });
    const empty = await screen.findByTestId("t-empty");
    expect(empty.textContent).toBe("Nothing here yet");
    expect(screen.queryByTestId("t")).toBeNull();
    expect(screen.queryByTestId("t-card")).toBeNull();
  });

  it("links a row from its first cell only", async () => {
    stubViewport(1280);
    renderTable();
    const link = await screen.findByTestId("t-row-one-link");
    expect(link.getAttribute("href")).toBe("/p/one/first-row");
    expect(link.textContent).toBe("First row");
    // The second row has no href, so its name is plain text.
    expect(screen.queryByTestId("t-row-two-link")).toBeNull();
    // A cell in another column never becomes the link.
    expect(screen.getAllByRole("link")).toHaveLength(1);
  });

  it("stacks the rows into labelled cards below 640px", async () => {
    stubViewport(390);
    renderTable();
    await waitFor(() =>
      expect(screen.getByTestId("t").getAttribute("data-layout")).toBe("stacked"),
    );
    const row = screen.getByTestId("t-row-one");
    // Label: value lines, in column order — the header row is gone, and the
    // stacked card is its own frame (no table card around it).
    expect(screen.queryByTestId("t-card")).toBeNull();
    expect(row.textContent).toContain("Name");
    expect(row.textContent).toContain("First row");
    expect(row.textContent).toContain("Default branch");
    expect(row.querySelector("th")).toBeNull();
    expect(screen.getAllByTestId("t-row-one-link")).toHaveLength(1);
  });
});

describe("SectionHeader", () => {
  it("renders the title, the one sentence, and the action at the right", async () => {
    render(
      <MemoryRouter>
        <SectionHeader
          title="Projects"
          blurb="Each project holds repositories, people and workflows."
          action={<button type="button">New project</button>}
          testid="h"
        />
      </MemoryRouter>,
    );
    const header = await screen.findByTestId("h");
    expect(header.querySelector("h2")?.textContent).toBe("Projects");
    expect(header.textContent).toContain("Each project holds repositories, people and workflows.");
    expect(screen.getByRole("button", { name: "New project" })).toBeTruthy();
  });
});
