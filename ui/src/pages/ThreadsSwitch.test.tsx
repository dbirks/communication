/**
 * gh-69's two route-independent halves. The screen-stability half of the same
 * defect (the two-pane frame, `placeholderData` between threads, the row
 * prefetch) now lives with the redesign's replacement — see
 * `components/chats/ChatThread.ported.test.tsx` and
 * `components/chats/ChatList.ported.test.tsx`; the routes it was pinned on
 * (`/threads`, `/threads/:id`) are replace-redirects now.
 *
 * What stays here does not depend on a route at all:
 *
 * 1. `useRun` answers with the PREVIOUS run while the next one is in flight
 *    (`placeholderData: keepPreviousData`), so the workbench never collapses
 *    to its loading line;
 * 2. `RouteErrorBoundary` clears a caught crash through `resetKey` without
 *    remounting a healthy route.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { useRun } from "../api/runs";
import { RouteErrorBoundary } from "../components/RouteErrorBoundary";

describe("gh-69: useRun keeps the previous run while the next one loads", () => {
  it("answers with the previous run id while the new run's read is pending", async () => {
    const held: { release?: () => void } = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) => {
        const url = String(input);
        if (url.includes("/api/v1/runs/r-A")) return Response.json({ id: "r-A" });
        if (url.includes("/api/v1/runs/r-B")) {
          await new Promise<void>((release) => {
            held.release = () => release();
          });
          return Response.json({ id: "r-B" });
        }
        return new Response(null, { status: 404 });
      }),
    );
    function Probe() {
      const [id, setId] = useState("r-A");
      const run = useRun(id);
      return (
        <div>
          <button onClick={() => setId("r-B")}>switch</button>
          <span data-testid="state">{run.isPending ? "PENDING" : (run.data?.id ?? "none")}</span>
        </div>
      );
    }
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <Probe />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("state").textContent).toBe("r-A"));
    fireEvent.click(screen.getByText("switch"));
    // B is held in flight by the stub; the read still answers with A, so the
    // already-painted workbench stays on screen instead of the loading line.
    expect(screen.getByTestId("state").textContent).toBe("r-A");
    held.release?.();
    await waitFor(() => expect(screen.getByTestId("state").textContent).toBe("r-B"));
  });
});

/**
 * The other half of the gh-69 remount: `Shell` used to key the content
 * subtree by pathname, so EVERY path change — even `/threads/a` to
 * `/threads/b` — threw away the mounted page. The boundary now clears a
 * caught crash through `resetKey` and must never remount a healthy route.
 */
describe("gh-69: the route error boundary resets without remounting", () => {
  it("keeps the mounted page across a resetKey change and clears a crash on the next one", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const mounts: string[] = [];
    function Page({ tag, fail }: { tag: string; fail?: boolean }) {
      useEffect(() => {
        mounts.push(tag);
      }, [tag]);
      if (fail) throw new Error("boom on purpose");
      return <span data-testid="page">{tag}</span>;
    }
    const view = (
      <RouteErrorBoundary resetKey="/x/1">
        <Page tag="one" />
      </RouteErrorBoundary>
    );
    const { rerender } = render(view);
    expect(screen.getByTestId("page").textContent).toBe("one");

    // Navigation (the boundary's resetKey changes; children stay identical):
    // the page component instance must survive — no remount flash.
    rerender(
      <RouteErrorBoundary resetKey="/x/2">
        <Page tag="one" />
      </RouteErrorBoundary>,
    );
    expect(mounts).toEqual(["one"]);
    expect(screen.queryByTestId("route-error-boundary")).toBeNull();

    // A crash still surfaces as the banner…
    rerender(
      <RouteErrorBoundary resetKey="/x/3">
        <Page tag="one" fail />
      </RouteErrorBoundary>,
    );
    expect(screen.getByTestId("route-error-boundary").textContent).toContain("boom");

    // …and the NEXT navigation clears it (the property the pathname `key`
    // used to buy by remounting everything).
    rerender(
      <RouteErrorBoundary resetKey="/x/4">
        <Page tag="two" />
      </RouteErrorBoundary>,
    );
    expect(screen.queryByTestId("route-error-boundary")).toBeNull();
    expect(screen.getByTestId("page").textContent).toBe("two");
    expect(mounts).toEqual(["one", "two"]);
    spy.mockRestore();
  });
});
