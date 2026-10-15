/**
 * The definition-side hooks, driven against the fake fetch (`test/fakes.ts`):
 * what the browser puts on the wire (paths, methods, bodies, CSRF) and how it
 * reads what comes back, including `application/problem+json` failures. Live
 * proof against the real Go server is the § 7 W-leg's; nothing here claims it.
 */
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it } from "vitest";
import type { ReactNode } from "react";
import { problemOf, setCsrfToken } from "./client";
import {
  draftConflictOf,
  useAssignments,
  useCreateDraft,
  usePipelines,
  usePublishDraft,
  usePutDraft,
  useRevision,
  useRevisionDocument,
  useValidateDraft,
} from "./pipelines";
import { queryKeys } from "./queries";
import { mockFetch, requestsTo, type RouteStub } from "../test/fakes";
import {
  WIRE_DRAFT_ID,
  WIRE_PIPELINE_ID,
  WIRE_REVISION_ID,
  wirePipeline,
  wirePipelineList,
  wireProjectId,
  wireRevision,
} from "../test/fixtures/m4/wire";

afterEach(cleanup);

function harness(routes: RouteStub[], gcTime = 0) {
  const { fetchMock, requests } = mockFetch(routes);
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime },
      mutations: { retry: false },
    },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { fetchMock, requests, queryClient, wrapper };
}

const pipelinePath = `/api/v1/pipelines/${WIRE_PIPELINE_ID}`;
const draftPath = `/api/v1/drafts/${WIRE_DRAFT_ID}`;

describe("definition hooks (frozen M4 routes)", () => {
  it("GETs the frozen library path and returns the wire list", async () => {
    const { requests, wrapper } = harness([{ path: "/api/v1/pipelines", body: wirePipelineList }]);
    const { result } = renderHook(() => usePipelines(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.pipelines.map((p) => p.slug)).toEqual([
      "feature-development",
      "module-check",
    ]);
    const [request] = requestsTo(requests, "/api/v1/pipelines");
    expect(request.method).toBe("GET");
    expect(request.headers.get("accept")).toBe("application/json");
  });

  it("stays silent until an id exists (no `/revisions/` request with an empty id)", async () => {
    const { requests, wrapper } = harness([]);
    const { result } = renderHook(() => useRevision(""), { wrapper });
    await waitFor(() => expect(result.current.fetchStatus).toBe("idle"));
    expect(requests).toHaveLength(0);
  });

  it("resolves a revision by digest through the same route as by id (route 13)", async () => {
    const digest = `sha256:${"ab".repeat(32)}`;
    const { requests, wrapper } = harness([
      { path: `/api/v1/revisions/${digest}`, body: wireRevision },
    ]);
    const { result } = renderHook(() => useRevision(digest), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(requestsTo(requests, `/api/v1/revisions/${digest}`)).toHaveLength(1);
    expect(result.current.data?.id).toBe(WIRE_REVISION_ID);
  });

  it("asks for the regenerated document with ?format=yaml (text/yaml body)", async () => {
    const { fetchMock, wrapper } = harness([
      { path: `/api/v1/revisions/${WIRE_REVISION_ID}/document`, body: "kind: Pipeline\n" },
    ]);
    const { result } = renderHook(() => useRevisionDocument(WIRE_REVISION_ID), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    // The recorded url drops the query (the stub matcher does too), so the
    // raw call is where `?format=yaml` — the only supported value — is proven.
    expect(fetchMock.mock.calls[0][0]).toBe(
      `/api/v1/revisions/${WIRE_REVISION_ID}/document?format=yaml`,
    );
    expect(result.current.data).toContain("kind: Pipeline");
  });

  it("POSTs a draft with the CSRF token, and PUTs the CAS version back verbatim", async () => {
    setCsrfToken("csrf-m4");
    const { requests, wrapper } = harness([
      { path: `${pipelinePath}/drafts`, method: "POST", body: wirePipeline },
      { path: draftPath, method: "PUT", body: { ...wirePipeline, version: 13 } },
    ]);
    const create = renderHook(() => useCreateDraft(WIRE_PIPELINE_ID), { wrapper });
    create.result.current.mutate({ document_yaml: "kind: Pipeline\n" });
    await waitFor(() => expect(create.result.current.isSuccess).toBe(true));

    const put = renderHook(() => usePutDraft(WIRE_DRAFT_ID), { wrapper });
    put.result.current.mutate({ document_yaml: "kind: Pipeline\nv: 2\n", version: 12 });
    await waitFor(() => expect(put.result.current.isSuccess).toBe(true));

    const post = requestsTo(requests, `${pipelinePath}/drafts`, "POST")[0];
    expect(JSON.parse(String(post.body))).toEqual({ document_yaml: "kind: Pipeline\n" });
    expect(post.headers.get("x-csrf-token")).toBe("csrf-m4");
    const replaced = requestsTo(requests, draftPath, "PUT")[0];
    expect(JSON.parse(String(replaced.body))).toEqual({
      document_yaml: "kind: Pipeline\nv: 2\n",
      version: 12,
    });
    setCsrfToken(null);
  });

  it("validates without a body and publishes with the CAS body, caching the revision", async () => {
    const { requests, queryClient, wrapper } = harness(
      [
        {
          path: `${draftPath}/validate`,
          method: "POST",
          body: {
            valid: true,
            errors: [],
            notes: [],
            digest_scope: "v1alpha1-canonical-1",
          },
        },
        { path: `${draftPath}/publish`, method: "POST", body: wireRevision },
      ],
      60_000, // the cached-write assertion needs the entry to survive collection
    );
    const validate = renderHook(() => useValidateDraft(WIRE_DRAFT_ID), { wrapper });
    validate.result.current.mutate();
    await waitFor(() => expect(validate.result.current.isSuccess).toBe(true));
    const validateRequest = requestsTo(requests, `${draftPath}/validate`, "POST")[0];
    expect(validateRequest.body).toBeUndefined();

    const publish = renderHook(() => usePublishDraft(WIRE_DRAFT_ID), { wrapper });
    publish.result.current.mutate({ version: 12, version_label: "8.0.0" });
    await waitFor(() => expect(publish.result.current.isSuccess).toBe(true));
    expect(
      JSON.parse(String(requestsTo(requests, `${draftPath}/publish`, "POST")[0].body)),
    ).toEqual({ version: 12, version_label: "8.0.0" });
    // The published revision lands in the cache under its own key (route 13's id).
    expect(queryClient.getQueryData(queryKeys.revision(WIRE_REVISION_ID))).toMatchObject({
      revision_number: 7,
    });
  });

  it("surfaces an application/problem+json refusal as a typed problem", async () => {
    const { requests, wrapper } = harness([
      {
        path: "/api/v1/pipelines",
        status: 403,
        body: {
          type: "https://communication.dev/errors/forbidden",
          title: "Forbidden",
          status: 403,
          detail: "the library role publishes; you do not hold it",
        },
      },
    ]);
    const { result } = renderHook(() => usePipelines(), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(problemOf(result.current.error)).toMatchObject({ status: 403, title: "Forbidden" });
    // 403 must not retry-loop (the app-level retry policy is bypassed in tests;
    // one request is one request).
    expect(requests).toHaveLength(1);
  });

  it("reads a draft CAS 409 as `current_version` — re-read, never retry-over", async () => {
    const { wrapper } = harness([
      {
        path: draftPath,
        method: "PUT",
        status: 409,
        body: {
          type: "https://communication.dev/errors/stale-draft-version",
          title: "Draft version stale",
          status: 409,
          detail: "draft.version is 14, not 12.",
          draft_id: WIRE_DRAFT_ID,
          current_version: 14,
        },
      },
    ]);
    const put = renderHook(() => usePutDraft(WIRE_DRAFT_ID), { wrapper });
    put.result.current.mutate({ document_yaml: "kind: Pipeline\n", version: 12 });
    await waitFor(() => expect(put.result.current.isError).toBe(true));
    expect(draftConflictOf(put.result.current.error)).toMatchObject({
      draft_id: WIRE_DRAFT_ID,
      current_version: 14,
    });
  });

  it("lists project assignments from the project-scoped route", async () => {
    const path = `/api/v1/projects/${wireProjectId}/assignments`;
    const { requests, wrapper } = harness([{ path, body: { assignments: [] } }]);
    const { result } = renderHook(() => useAssignments(wireProjectId), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(requestsTo(requests, path)).toHaveLength(1);
    expect(result.current.data?.assignments).toEqual([]);
  });
});
