/**
 * The tree's job is to keep three identities apart — a definition node, one of
 * its executions, and a child run — and to say what is hidden. W11's DOM
 * assertion (no `worker_id`, `fencing_token`, `lease_expires_at`) runs here
 * because this is the surface most tempted to show them.
 */
import { afterEach } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RunTree, buildRows, instanceLabel, parentKeyOf } from "./RunTree";
import {
  fanOutNodes,
  fanOutTree,
  featureNodes,
  interruptedNodes,
} from "../../test/fixtures/m4/runs";

// Vitest globals are off, so testing-library cannot register its own cleanup.
afterEach(cleanup);

const LOOP = "/build_until_verified";
const expandedAll = [LOOP, `${LOOP}[1]`, `${LOOP}[2]`];

describe("parentKeyOf", () => {
  it("reads the tree out of the instance key, because the key is the identity", () => {
    expect(parentKeyOf("/plan")).toBe("/");
    expect(parentKeyOf(`${LOOP}[1]/implement`)).toBe(`${LOOP}[1]`);
    expect(parentKeyOf(LOOP)).toBe("/");
    expect(parentKeyOf("/fan[3]/invoke/child/invoke")).toBe("/fan[3]/invoke/child");
  });
});

describe("buildRows", () => {
  it("gives a loop one row and its iterations as children", () => {
    const rows = buildRows({
      nodes: featureNodes,
      tree: null,
      expanded: new Set([LOOP]),
      pageSize: 10,
    });
    const loop = rows.find((row) => row.key === LOOP)!;
    expect(loop.label).toBe("build_until_verified");
    expect(loop.counts).toContain("2 iterations");
    // Iteration 1 is done, iteration 2 is mid-flight: the loop row says so in
    // counts, and its own chip is the server's `running`.
    expect(loop.status?.word).toBe("running");
    expect(rows.filter((row) => row.level === 1).map((row) => row.key)).toEqual([
      `${LOOP}[1]`,
      `${LOOP}[2]`,
    ]);
    expect(rows.filter((row) => row.level === 1).map((row) => row.label)).toEqual([
      "iteration 1",
      "iteration 2",
    ]);
  });

  it("gives an iteration no chip of its own", () => {
    const rows = buildRows({
      nodes: featureNodes,
      tree: null,
      expanded: new Set([LOOP, `${LOOP}[1]`]),
      pageSize: 10,
    });
    const iteration = rows.find((row) => row.key === `${LOOP}[1]`)!;
    // The nodes inside it have states; the iteration is a place.
    expect(iteration.status).toBeNull();
    expect(iteration.counts).toBe("3 done");
    expect(rows.filter((row) => row.level === 2).map((row) => row.key)).toEqual([
      `${LOOP}[1]/implement`,
      `${LOOP}[1]/test`,
      `${LOOP}[1]/review`,
    ]);
  });

  it("collapses an unexpanded row to a single row", () => {
    const rows = buildRows({ nodes: featureNodes, tree: null, expanded: new Set(), pageSize: 10 });
    expect(rows.some((row) => row.key === `${LOOP}[1]`)).toBe(false);
    expect(rows.find((row) => row.key === LOOP)?.expandable).toBe(true);
  });

  it("carries the iteration suffix onto the body node it belongs to", () => {
    expect(instanceLabel(`${LOOP}[2]/review`)).toBe("review[2]");
    expect(instanceLabel("/plan")).toBe("plan");
  });

  it("uses a scope's own numbered rows as its places, states and all", () => {
    const rows = buildRows({
      nodes: fanOutNodes,
      tree: fanOutTree,
      expanded: new Set(["/verify_each", "/verify_each[22]"]),
      pageSize: 30,
    });
    const branch = rows.find((row) => row.key === "/verify_each[22]")!;
    // This fan-out sends a row per branch, so the row's identity and state are
    // the server's — never relabelled as a synthetic place, and never doubled.
    expect(branch.label).toBe("verify_each[22]");
    expect(branch.status?.word).toBe("failed · agent_error");
    // 25 places, plus the one invocation this test expanded.
    expect(rows.filter((row) => row.key.startsWith("/verify_each["))).toHaveLength(26);
    const invocation = rows.find((row) => row.key === "/verify_each[22]/invoke")!;
    expect(invocation.level).toBe(branch.level + 1);
  });

  it("keeps a child run separate from the invocation that made it", () => {
    const rows = buildRows({
      nodes: fanOutNodes,
      tree: fanOutTree,
      expanded: new Set([
        "/verify_each",
        "/verify_each[22]",
        "/verify_each[22]/invoke",
        `run:${fanOutTree.children[21].child_run_id}`,
      ]),
      pageSize: 30,
    });
    const invocation = rows.find((row) => row.key === "/verify_each[22]/invoke")!;
    const childRun = rows.find((row) => row.key === `run:${fanOutTree.children[21].child_run_id}`)!;
    expect(invocation.level).toBeLessThan(childRun.level);
    expect(childRun.detail).toContain("child run");
    expect(childRun.detail).toContain("depth 1");
    expect(childRun.label).toBe("module-check");
    expect(childRun.status?.word).toBe("failed");
    // depth 2 only appears when its own parent is expanded
    expect(rows.some((row) => row.detail.includes("depth 2"))).toBe(true);
  });

  it("pages a long branch and names what is hidden", () => {
    const rows = buildRows({
      nodes: fanOutNodes,
      tree: fanOutTree,
      expanded: new Set(["/verify_each"]),
      pageSize: 10,
    });
    // Ten places and the row that says what the page hid, both at level 1.
    expect(rows.filter((row) => row.level === 1 && !row.key.startsWith("more:"))).toHaveLength(10);
    const more = rows.find((row) => row.key.startsWith("more:"))!;
    expect(more.key).toBe("more:/verify_each");
    expect(more.label).toBe("15 more");
    expect(more.detail).toBe("this branch is longer than one page");
  });
});

describe("RunTree", () => {
  it("is a real tree to assistive technology", () => {
    render(<RunTree nodes={featureNodes} expandedKeys={expandedAll} />);
    const tree = screen.getByTestId("run-tree");
    expect(tree.getAttribute("role")).toBe("tree");
    expect(within(tree).getAllByRole("treeitem").length).toBeGreaterThan(4);
    // loop (level 1) → iteration (2) → body node (3): the key's depth is the
    // tree's depth, which is what makes an iteration findable by ear.
    const nested = screen.getByTestId(`run-tree-row-${LOOP}[2]/implement`);
    expect(nested.getAttribute("aria-level")).toBe("3");
    expect(nested.getAttribute("aria-setsize")).toBe("3");
    expect(nested.getAttribute("aria-posinset")).toBe("1");
    expect(nested.textContent).toContain("implement[2]");
    const loop = screen.getByTestId(`run-tree-row-${LOOP}`);
    expect(
      within(loop)
        .getByRole("button", { name: /collapse/i })
        .getAttribute("aria-expanded"),
    ).toBe("true");
  });

  it("tells the truth about a node that ran fine and failed its check", () => {
    render(<RunTree nodes={featureNodes} expandedKeys={expandedAll} />);
    const testRow = screen.getByTestId(`run-tree-row-${LOOP}[1]/test`);
    expect(testRow.textContent).toContain("ran fine · failed");
    expect(testRow.textContent).not.toMatch(/× failed$/);
  });

  it("names a node whose worker is gone as an unknown outcome, never as a resumption", () => {
    render(<RunTree nodes={interruptedNodes} expandedKeys={expandedAll} />);
    const row = screen.getByTestId(`run-tree-row-${LOOP}[2]/implement`);
    expect(row.textContent).toContain("interrupted — outcome unknown");
    expect(row.textContent).not.toMatch(/resumed|restored|no data lost/i);
  });

  it("does not call a node interrupted because one of its attempts was", () => {
    // `featureNodes`' iteration 2 lost a worker and then succeeded on the retry;
    // the node's own state is done, and only the attempt panel tells the history.
    render(<RunTree nodes={featureNodes} expandedKeys={expandedAll} />);
    const row = screen.getByTestId(`run-tree-row-${LOOP}[2]/implement`);
    expect(row.textContent).toContain("2 attempts");
    expect(row.textContent).not.toContain("outcome unknown");
  });

  it("links a child run to its own inspector without hiding what it is", () => {
    const onSelect = vi.fn();
    render(
      <RunTree
        nodes={fanOutNodes}
        tree={fanOutTree}
        expandedKeys={["/verify_each", "/verify_each[22]", "/verify_each[22]/invoke"]}
        onSelect={onSelect}
        runPath={(runId) => `/runs/${runId}`}
        pageSize={30}
      />,
    );
    const link = screen.getByTestId(`run-tree-link-run:${fanOutTree.children[21].child_run_id}`);
    expect(link.getAttribute("href")).toBe(`/runs/${fanOutTree.children[21].child_run_id}`);
    fireEvent.click(link);
    expect(onSelect).toHaveBeenCalled();
  });

  it("expands and collapses on request, and counts what it hides", () => {
    const onToggle = vi.fn();
    render(
      <RunTree
        nodes={fanOutNodes}
        tree={fanOutTree}
        expandedKeys={[]}
        onToggle={onToggle}
        pageSize={10}
      />,
    );
    fireEvent.click(screen.getByTestId("run-tree-toggle-/verify_each"));
    expect(onToggle).toHaveBeenCalledWith("/verify_each");
    expect(screen.getByTestId("run-tree-count").textContent).toContain("node executions");
    expect(screen.getByTestId("run-tree-count").textContent).toContain("rows shown");
  });

  it("shows an honest empty state for a run with nothing executed", () => {
    render(<RunTree nodes={[]} />);
    expect(screen.getByTestId("run-tree-empty").textContent).toContain("queued");
  });

  it("never renders a worker id, a fencing token or a lease deadline (W11)", () => {
    const { container } = render(
      <RunTree
        nodes={fanOutNodes}
        tree={fanOutTree}
        expandedKeys={["/verify_each", "/verify_each[22]", "/verify_each[22]/invoke"]}
        pageSize={30}
      />,
    );
    const text = container.textContent ?? "";
    expect(text).not.toMatch(/worker_id|worker-a|fencing|lease_expires|lease expires/i);
  });
});
