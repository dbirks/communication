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
      // Nothing under `/verify_each` is expanded: the only reason to open a
      // branch is its own subtree, and a child run no longer lives there.
      expanded: new Set([`run:${fanOutTree.children[21].child_run_id}`]),
      pageSize: 30,
    });
    expect(rows.find((row) => row.key === "/verify_each[22]/invoke")).toBeUndefined();
    const childRun = rows.find((row) => row.key === `run:${fanOutTree.children[21].child_run_id}`)!;
    // W11: "the tree renders depth 1 children with their own statuses".
    expect(childRun.level).toBe(1);
    expect(childRun.detail).toContain("child run");
    expect(childRun.detail).toContain("depth 1");
    // The relationship the route names is still said out loud.
    expect(childRun.detail).toContain("invoked by /verify_each[22]/invoke");
    expect(childRun.label).toBe("module-check");
    expect(childRun.status?.word).toBe("failed");
    // depth 2 only appears when its own parent is expanded
    expect(rows.filter((row) => row.detail.includes("depth 2"))).toHaveLength(1);
  });

  it("shows every child the /tree route reports without a single expansion (W11)", () => {
    const rows = buildRows({
      nodes: fanOutNodes,
      tree: fanOutTree,
      expanded: new Set(),
      pageSize: 10,
    });
    const heading = rows.find((row) => row.key === "runs:child-runs")!;
    expect(heading.expanded).toBe(true);
    expect(heading.detail).toBe("25 child runs of this run");
    const shown = rows.filter((row) => row.key.startsWith("run:"));
    // Not ten, not "the ones that happened to be reachable": all of them.
    expect(shown).toHaveLength(fanOutTree.children.length);
    for (const child of fanOutTree.children) {
      const row = rows.find((item) => item.key === `run:${child.child_run_id}`)!;
      expect(row.detail.startsWith("child run ")).toBe(true);
      expect(row.detail).toContain(` · depth ${child.depth} · waits for ${child.wait_policy}`);
      expect(row.status?.word).toBe(child.status);
    }
  });

  it("collapses its child runs only on request, and says what it holds", () => {
    const rows = buildRows({
      nodes: fanOutNodes,
      tree: fanOutTree,
      expanded: new Set(["runs:child-runs"]),
      pageSize: 10,
    });
    expect(rows.find((row) => row.key === "runs:child-runs")?.expanded).toBe(false);
    expect(rows.filter((row) => row.key.startsWith("run:"))).toHaveLength(0);
  });

  it("counts a node execution's child runs on the row that invoked them", () => {
    const rows = buildRows({
      nodes: fanOutNodes,
      tree: fanOutTree,
      expanded: new Set(["/verify_each", "/verify_each[22]"]),
      pageSize: 30,
    });
    const invocation = rows.find((row) => row.key === "/verify_each[22]/invoke")!;
    expect(invocation.counts).toContain("1 child run");
  });

  it("pages a long branch and names what is hidden", () => {
    const rows = buildRows({
      nodes: fanOutNodes,
      tree: fanOutTree,
      expanded: new Set(["/verify_each"]),
      pageSize: 10,
    });
    // Ten places and the row that says what the page hid, both at level 1.
    expect(
      rows.filter((row) => row.level === 1 && row.key.startsWith("/verify_each[")),
    ).toHaveLength(10);
    const more = rows.find((row) => row.key.startsWith("more:"))!;
    expect(more.key).toBe("more:/verify_each");
    expect(more.label).toBe("15 more");
    expect(more.detail).toBe("this branch is longer than one page");
    // A page that cannot be turned strands whatever it hides, so this row opens.
    expect(more.expandable).toBe(true);
  });

  it("hands back the whole branch when its page is turned", () => {
    const rows = buildRows({
      nodes: fanOutNodes,
      tree: fanOutTree,
      expanded: new Set(["/verify_each", "more:/verify_each"]),
      pageSize: 10,
    });
    expect(rows.filter((row) => row.key.startsWith("/verify_each["))).toHaveLength(25);
    expect(rows.find((row) => row.key === "more:/verify_each")).toBeUndefined();
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

  it("names every row, and stops counting in-flight work once the node is terminal", () => {
    // The route answers in instance-key order, so `/plan` is last alphabetically
    // — and a row whose identity is squeezed out of a narrow pane reads as a
    // nameless failure. The label keeps its own width; the detail gives way.
    const failed = featureNodes.map((node) =>
      node.node_instance_key === "/plan"
        ? { ...node, status: "failed" as const, error_class: "infra" as const, in_flight: 2 }
        : node,
    );
    render(<RunTree nodes={failed} expandedKeys={expandedAll} />);
    const planRow = screen.getByTestId("run-tree-row-/plan");
    expect(within(planRow).getByTestId("run-tree-label-/plan").textContent).toBe("plan");
    // `in_flight` is a live count: attempts a worker still holds. A failed row
    // cannot hold work, so it must not claim two in flight beside the ×.
    expect(planRow.textContent).toContain("failed");
    expect(planRow.textContent).not.toContain("in flight");
    // A running node still says it: the count is the point there.
    const running = featureNodes.map((node) =>
      node.node_instance_key === "/plan"
        ? { ...node, status: "running" as const, outcome: null, error_class: null, in_flight: 2 }
        : node,
    );
    cleanup();
    render(<RunTree nodes={running} expandedKeys={expandedAll} />);
    expect(screen.getByTestId("run-tree-row-/plan").textContent).toContain("2 in flight");
  });

  it("lists the run's nodes in the definition's order when the caller knows it", () => {
    const order = [
      "plan",
      "approve",
      "build_until_verified",
      "implement",
      "test",
      "review",
      "verdict",
      "publish_verified",
      "publish_needs_attention",
    ];
    const rows = buildRows({
      nodes: [...featureNodes].sort((a, b) =>
        a.node_instance_key.localeCompare(b.node_instance_key),
      ),
      tree: null,
      expanded: new Set<string>([...expandedAll, `${LOOP}[1]/test`, `${LOOP}[2]/test`]),
      pageSize: 20,
      definitionOrder: order,
    });
    expect(rows.slice(0, 3).map((row) => row.label)).toEqual([
      "plan",
      "approve",
      "build_until_verified",
    ]);
    // Without the revision's order the same rows come back as the API sent them:
    // the loop first, and the node that leads into it last.
    const plain = buildRows({
      nodes: [...featureNodes].sort((a, b) =>
        a.node_instance_key.localeCompare(b.node_instance_key),
      ),
      tree: null,
      expanded: new Set<string>(),
      pageSize: 20,
    });
    const plainLabels = plain.map((row) => row.label);
    expect(plainLabels.indexOf("approve")).toBeLessThan(plainLabels.indexOf("plan"));
    expect(plainLabels.indexOf("build_until_verified")).toBeLessThan(plainLabels.indexOf("plan"));
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
        expandedKeys={[]}
        onSelect={onSelect}
        runPath={(runId) => `/runs/${runId}`}
        pageSize={30}
      />,
    );
    const link = screen.getByTestId(`run-tree-link-run:${fanOutTree.children[21].child_run_id}`);
    expect(link.getAttribute("href")).toBe(`/runs/${fanOutTree.children[21].child_run_id}`);
    expect(link.textContent).toContain("failed");
    fireEvent.click(link);
    expect(onSelect).toHaveBeenCalled();
  });

  it("turns its own page when a branch is longer than the window", () => {
    const onToggle = vi.fn();
    render(
      <RunTree
        nodes={fanOutNodes}
        tree={fanOutTree}
        expandedKeys={["/verify_each"]}
        onToggle={onToggle}
        pageSize={10}
      />,
    );
    fireEvent.click(screen.getByTestId("run-tree-toggle-more:/verify_each"));
    expect(onToggle).toHaveBeenCalledWith("more:/verify_each");
  });

  it("says in words how many child runs the route reported", () => {
    render(<RunTree nodes={fanOutNodes} tree={fanOutTree} expandedKeys={[]} />);
    const heading = screen.getByTestId("run-tree-row-runs:child-runs");
    expect(heading.textContent).toContain("25 child runs of this run");
    expect(heading.getAttribute("aria-expanded")).toBe("true");
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
