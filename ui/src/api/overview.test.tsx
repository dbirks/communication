/**
 * The ops overview wire contract, pinned from the browser side: the URL each
 * call uses, the null-fold that turns "this serving image predates the route"
 * into a stated absence instead of an error card, the probe's POST (CSRF token
 * and all — it is a mutation that spends the organization's model budget), and
 * the fact that a 429 arrives as a typed error whose detail the panel shows.
 *
 * The bodies are the shapes the Go side answers (internal/api/system_overview.go);
 * if a field name changes there, the assertion here is the failure that says so.
 */
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import type { ReactNode } from "react";
import { fetchSystemOverview, probeModel, systemOverviewKey, useSystemOverview } from "./queries";
import { ApiError, setCsrfToken } from "./client";
import { mockFetch, requestsTo, type RouteStub } from "../test/fakes";

const overview = {
  server: {
    version: "0.0.0-SNAPSHOT-f918881",
    commit: "f918881",
    replica: "communication-7d9f4c2d8b-xk2lp",
    schema_version: 30,
    started_at: "2026-11-11T08:41:07Z",
  },
  identity: { provider: "oidc", issuer_host: "idp.beluga-wyvern.ts.net", dev_login: false },
  storage: {
    artifact_backend: "local",
    preview_host: "communication-preview.beluga-wyvern.ts.net",
  },
  models: [
    {
      kind: "assistant",
      label: "Assistant chat",
      model: "david-birks/qwen3-8-flash-next",
      endpoint_host: "llm-collective.e-gineering.com",
      key_set: true,
      configured: true,
    },
    {
      kind: "worker_chat",
      label: "Workflow model steps",
      model: "",
      endpoint_host: "",
      key_set: null,
      configured: false,
    },
  ],
  secrets: { projects: 3, secrets: 7, mounts: 4 },
  workers: { online: 1, offline: 35, stale_after_seconds: 3600 },
};

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe("useSystemOverview", () => {
  it("reads the one overview route", async () => {
    const { fetchMock, requests } = mockFetch([
      { path: "/api/v1/system/overview", body: overview },
    ]);
    const { result } = renderHook(() => useSystemOverview(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.server.schema_version).toBe(30);
    expect(result.current.data?.workers).toEqual(overview.workers);
    // A key this replica cannot see stays null: the UI must be able to tell
    // "the worker owns it" from "there is no key".
    const workerChat = result.current.data?.models.find((model) => model.kind === "worker_chat");
    expect(workerChat?.key_set).toBeNull();
    expect(requestsTo(requests, "/api/v1/system/overview")).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("folds the route's absence to null rather than an error card", async () => {
    // No stub: mockFetch answers 404, which is what an older serving image
    // says about a route it has never heard of.
    mockFetch([]);
    const { result } = renderHook(() => useSystemOverview(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toBeNull();
  });

  it("caches under one key the tiles and the panels share", async () => {
    mockFetch([{ path: "/api/v1/system/overview", body: overview }]);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    const { result } = renderHook(() => useSystemOverview(), {
      wrapper: ({ children }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    // One key for every consumer, so the one invalidation the SSE feed already
    // makes can reach the tile and the panel together (the cache-key map's rule).
    expect(systemOverviewKey).toEqual(["system", "overview"]);
    expect(client.getQueryData(systemOverviewKey)).toMatchObject({
      server: { schema_version: 30 },
    });
  });

  it("surfaces a real failure as an error, not as an empty deployment", async () => {
    mockFetch([
      {
        path: "/api/v1/system/overview",
        method: "GET",
        status: 500,
        body: {
          type: "about:blank",
          title: "Internal Server Error",
          status: 500,
          detail: "The server could not read its own state. Use the request id when reporting it.",
        },
      },
    ]);
    const { result } = renderHook(() => useSystemOverview(), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.data).toBeUndefined();
  });
});

describe("fetchSystemOverview + probeModel", () => {
  it("resolves the overview body", async () => {
    mockFetch([{ path: "/api/v1/system/overview", body: overview }]);
    await expect(fetchSystemOverview()).resolves.toEqual(overview);
  });

  it("posts the probe to the kind's own route with the CSRF header", async () => {
    setCsrfToken("csrf-token-value");
    const { requests } = mockFetch([
      {
        method: "POST",
        path: "/api/v1/system/models/assistant/probe",
        body: { ok: true, latency_ms: 812, detail: "" },
      },
    ]);
    await expect(probeModel("assistant")).resolves.toEqual({
      ok: true,
      latency_ms: 812,
      detail: "",
    });
    const call = requestsTo(requests, "/api/v1/system/models/assistant/probe", "POST")[0];
    expect(call.method).toBe("POST");
    expect(call.headers.get("x-csrf-token")).toBe("csrf-token-value");
    setCsrfToken(null);
  });

  it("escapes the kind it is told to probe", async () => {
    const { requests } = mockFetch([]);
    const error = await probeModel("nope/../keys").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect(requests).toHaveLength(1);
    // A kind from a hand-typed URL cannot walk out of the model-probe route.
    expect(requests[0].url).toBe("/api/v1/system/models/nope%2F..%2Fkeys/probe");
  });

  it("keeps a 429's own sentence on the error the panel reads", async () => {
    const routes: RouteStub[] = [
      {
        method: "POST",
        path: "/api/v1/system/models/speech/probe",
        status: 429,
        body: {
          type: "about:blank",
          title: "Too Many Requests",
          status: 429,
          detail: "One model probe per kind every 10 seconds; try again shortly.",
        },
      },
    ];
    mockFetch(routes);
    const error = await probeModel("speech").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(429);
    expect((error as ApiError).detail).toContain("One model probe per kind");
  });
});
