/**
 * The Home briefing's cross-project reads (contract C3 / ADR-0047) against
 * the fake fetch: the wire URLs, the envelope shapes, and the frame
 * classifiers that decide which org-stream frames mark the briefing dirty.
 */
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it } from "vitest";
import type { ReactNode } from "react";
import { isHomeRunFrame, isHomeThreadFrame, useHomeApprovals, useHomeConversations } from "./home";
import {
  conversationSummaryFixture,
  meFixture,
  mockFetch,
  projectFixture,
  requestsTo,
  type RouteStub,
} from "../test/fakes";
import type { Approval } from "./types";

const approvalFixture: Approval = {
  id: "01987a90-1111-7000-8000-aaaaaaaaaaaa",
  project_id: projectFixture.id,
  run_id: "01987a90-2222-7000-8000-bbbbbbbbbbbb",
  node_execution_id: "01987a90-3333-7000-8000-cccccccccccc",
  kind: "pipeline_gate",
  summary: "Approve plan: rate limiter for /v2/search.",
  artifact_refs: [],
  approver_roles: ["maintainer"],
  approver_user_ids: [meFixture.id],
  deadline_at: "2026-10-15T18:00:00Z",
  on_timeout: "fail",
  re_requested: false,
  state: "pending",
  version: 3,
  created_at: "2026-10-14T16:00:00Z",
};

function harness(routes: RouteStub[]) {
  const { fetchMock, requests } = mockFetch(routes);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 60_000 } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { requests, fetchMock, wrapper };
}

/** The raw request URL (query string included) of the first call to `path`. */
function rawUrl(fetchMock: ReturnType<typeof mockFetch>["fetchMock"], path: string): string {
  const call = fetchMock.mock.calls.find((args) => String(args[0]).startsWith(path));
  if (!call) throw new Error(`no request recorded for ${path}`);
  return String(call[0]);
}

afterEach(cleanup);

describe("useHomeApprovals", () => {
  it("GETs the cross-project gate list filtered to pending, once", async () => {
    const { requests, fetchMock, wrapper } = harness([
      { path: "/api/v1/approvals", body: { approvals: [approvalFixture] } },
    ]);
    const listed = renderHook(() => useHomeApprovals(), { wrapper });
    await waitFor(() => expect(listed.result.current.isSuccess).toBe(true));
    expect(listed.result.current.data?.approvals[0]?.id).toBe(approvalFixture.id);

    const sent = requestsTo(requests, "/api/v1/approvals");
    expect(sent).toHaveLength(1);
    expect(
      new URL(rawUrl(fetchMock, "/api/v1/approvals"), "http://localhost").searchParams.get(
        "status",
      ),
    ).toBe("pending");
  });
});

describe("useHomeConversations", () => {
  it("GETs the cross-project conversation page with the briefing's limit", async () => {
    const { requests, fetchMock, wrapper } = harness([
      {
        path: "/api/v1/conversations",
        body: { items: [conversationSummaryFixture], next_cursor: null },
      },
    ]);
    const listed = renderHook(() => useHomeConversations(), { wrapper });
    await waitFor(() => expect(listed.result.current.isSuccess).toBe(true));
    expect(listed.result.current.data?.items[0]?.id).toBe(conversationSummaryFixture.id);

    const sent = requestsTo(requests, "/api/v1/conversations");
    expect(sent).toHaveLength(1);
    expect(
      new URL(rawUrl(fetchMock, "/api/v1/conversations"), "http://localhost").searchParams.get(
        "limit",
      ),
    ).toBe("50");
  });
});

describe("org-stream frame classifiers", () => {
  it("run and approval frames mark the run rows and the gate list dirty", () => {
    expect(isHomeRunFrame("run.started")).toBe(true);
    expect(isHomeRunFrame("run.waiting_human")).toBe(true);
    expect(isHomeRunFrame("approval.requested")).toBe(true);
    expect(isHomeRunFrame("approval.decided")).toBe(true);
    expect(isHomeRunFrame("conversation.created")).toBe(false);
    expect(isHomeRunFrame("node.started")).toBe(false);
  });

  it("conversation frames mark the thread list dirty", () => {
    expect(isHomeThreadFrame("conversation.created")).toBe(true);
    expect(isHomeThreadFrame("conversation.message.user")).toBe(true);
    expect(isHomeThreadFrame("run.completed")).toBe(false);
    expect(isHomeThreadFrame("approval.pending")).toBe(false);
  });
});
