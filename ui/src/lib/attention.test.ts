/**
 * The row-level rules attention lists share: a gate's title drops the plan JSON
 * a template interpolation glued onto it (`live-board.png`), and what is left
 * is clamped rather than allowed to stretch a card down the page.
 *
 * Plus the refresh contract: the fan-out polls only for the caller that asks,
 * so making Inbox live cannot quietly turn the board pages into pollers.
 */
import { act, cleanup, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement, type ReactNode } from "react";
import {
  ATTENTION_TITLE_CLAMP,
  attentionTitle,
  needsYou,
  pendingPermissionCount,
  useAttentionDocumentTitle,
  useProjectAttention,
} from "./attention";
import { mockFetch, projectFixture, requestsTo, type RouteStub } from "../test/fakes";

/** The live board's second card, verbatim: a lead-in and the whole plan. */
const PLAN_GATE = `Plan for Document and fix add() in hello.py
{"acceptance":["pytest passes in app/ with both tests green","add.__doc__ is a non-empty, accurate docstring"],"findings":["app/hello.py:1: add(a, b) returns a + b, which is already the correct sum."],"goal":"Document and fix add() in app/hello.py","risks":["If the checkout is read-only, steps 1-2 need a writable copy of the repo."],"steps":[{"action":"Add a docstring to add() that says it returns the sum of a and b.","file":"app/hello.py","id":1}]}`;

describe("attentionTitle", () => {
  it("keeps the lead-in and drops the plan JSON", () => {
    expect(attentionTitle(PLAN_GATE)).toBe("Plan for Document and fix add() in hello.py");
  });

  it("leaves a prose summary untouched", () => {
    expect(attentionTitle("Approve spec: claims export v2")).toBe("Approve spec: claims export v2");
  });

  it("leaves prose that merely mentions a brace alone", () => {
    expect(attentionTitle("Check the {config} section")).toBe("Check the {config} section");
  });

  it("shows a summary that is only the object rather than going blank", () => {
    const only = '{"goal":"Ship","steps":[]}';
    expect(attentionTitle(only)).toBe(only);
  });

  it("trims the whitespace around the prefix", () => {
    expect(attentionTitle('  Plan ready  \n  {"goal":"Ship"}  ')).toBe("Plan ready");
  });

  it("drops an unparseable object with key-shaped text after the brace", () => {
    expect(attentionTitle('Plan for X\n{"goal":"Ship"\n]')).toBe("Plan for X");
  });

  it("clamps a title to two lines", () => {
    expect(ATTENTION_TITLE_CLAMP).toBe("line-clamp-2");
  });
});

const APPROVALS_PATH = `/api/v1/projects/${projectFixture.id}/approvals`;

function harness(routes: RouteStub[]) {
  const { requests } = mockFetch(routes);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
  return { requests, wrapper };
}

const emptyLists: RouteStub[] = [
  { path: APPROVALS_PATH, body: { approvals: [] } },
  { path: `/api/v1/projects/${projectFixture.id}/runs`, body: { runs: [] } },
  {
    path: `/api/v1/projects/${projectFixture.id}/conversations`,
    body: { items: [] },
  },
];

/** Flush the mount's fetches under fake timers without reaching a poll tick. */
async function settle() {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
  }
}

/**
 * Opt-in polling: the Inbox passes an interval, the board pages pass nothing.
 * A caller that asks is re-read on the tick; one that does not is served exactly
 * once, so `Projects.tsx` and `Project.tsx` keep the behavior they shipped with.
 */
describe("useProjectAttention refresh contract", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("re-reads each project's gates on the interval the caller asked for", async () => {
    vi.useFakeTimers();
    const { requests, wrapper } = harness(emptyLists);
    renderHook(() => useProjectAttention([projectFixture], { refetchInterval: 5_000 }), {
      wrapper,
    });
    await settle();
    expect(requestsTo(requests, APPROVALS_PATH, "GET")).toHaveLength(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(requestsTo(requests, APPROVALS_PATH, "GET")).toHaveLength(2);
  });

  it("never polls a caller that did not ask", async () => {
    vi.useFakeTimers();
    const { requests, wrapper } = harness(emptyLists);
    renderHook(() => useProjectAttention([projectFixture]), { wrapper });
    await settle();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(requestsTo(requests, APPROVALS_PATH, "GET")).toHaveLength(1);
  });
});

/**
 * The two findability rules from the ask-mode diagnosis
 * (docs/testing/claude-ask-mode-2026-11-11 proposal 2): the needs-you count
 * includes the pending ACP prompts the fan-out already reads, and the same
 * count rides the document title so a background tab can say "someone is
 * waiting".
 */
describe("needsYou — prompts waiting on a person count", () => {
  const convo = (pendingPermissions: number) =>
    ({
      project: projectFixture,
      conversation: { id: `c-${pendingPermissions}` },
      pendingPermissions,
    }) as never;

  it("sums gates, stalls and pending permissions", () => {
    expect(
      needsYou({
        decisions: [1, 2] as never,
        stalled: [3] as never,
        conversations: [convo(2), convo(0), convo(1)],
      }),
    ).toBe(6);
  });

  it("adds nothing when no detail reported a prompt", () => {
    expect(
      needsYou({ decisions: [1] as never, stalled: [] as never, conversations: [convo(0)] }),
    ).toBe(1);
  });

  it("counts the fan-out's prompts on their own", () => {
    expect(pendingPermissionCount([convo(3), convo(0), convo(2)] as never)).toBe(5);
    expect(pendingPermissionCount([])).toBe(0);
  });
});

describe("useAttentionDocumentTitle", () => {
  const original = document.title;

  afterEach(() => {
    document.title = original;
  });

  function mountTitle(n: number | null) {
    document.title = "Communication";
    return renderHook(({ count }: { count: number | null }) => useAttentionDocumentTitle(count), {
      initialProps: { count: n },
    });
  }

  it("prefixes with the count while it is positive and restores it at zero", () => {
    const { rerender, unmount } = mountTitle(2);
    expect(document.title).toBe("(2) Communication");
    rerender({ count: 0 });
    expect(document.title).toBe("Communication");
    rerender({ count: 3 });
    expect(document.title).toBe("(3) Communication");
    unmount();
    expect(document.title).toBe("Communication");
  });

  it("treats an in-flight (null) count as nothing waiting", () => {
    const { unmount } = mountTitle(null);
    expect(document.title).toBe("Communication");
    unmount();
  });

  it("never stacks prefixes on a title that already carries one", () => {
    document.title = "(9) Communication";
    const { unmount } = renderHook(() => useAttentionDocumentTitle(1));
    expect(document.title).toBe("(1) Communication");
    unmount();
    expect(document.title).toBe("Communication");
  });
});
