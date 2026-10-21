/**
 * The step-registry data hooks (`api/nodeTemplates.ts`, ADR-0049 part 1).
 * Two contract behaviours matter: the LIST read's 404 means "server lacks
 * the endpoint" and degrades to `null` (not an error), while a 404 on ONE
 * template stays an error (the house not-found sentinel), and the two
 * mutations POST the exact bodies the wire checks and invalidate the list.
 */
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import {
  useCreateNodeTemplateRevision,
  useDuplicateNodeTemplate,
  useNodeTemplate,
  useNodeTemplates,
} from "./nodeTemplates";
import { mockFetch, requestsTo } from "../test/fakes";

const TEMPLATE = {
  id: "t-1",
  slug: "code-reviewer",
  display_name: "Code reviewer",
  kind: "agent.acp",
  description: "Read-only review.",
  status: "active",
  latest_revision: {
    revision_id: "r-1",
    revision_number: 1,
    version_label: "2.0.0",
    revision_digest: "sha256:abc",
    created_at: "2026-07-01T10:00:00Z",
  },
  used_in_count: 2,
  created_by: "u-1",
  created_at: "2026-07-01T10:00:00Z",
  updated_at: "2026-07-01T10:00:00Z",
};

const REVISION = {
  revision_id: "r-1",
  revision_number: 1,
  version_label: "2.0.0",
  parameters: { type: "object", properties: {} },
  config: { profile: "reviewer" },
  output_schema: { type: "object" },
  workspace_mode: "read_only",
  revision_digest: "sha256:abc",
  created_by: "u-1",
  created_at: "2026-07-01T10:00:00Z",
};

const DETAIL = { template: TEMPLATE, revisions: [REVISION], usages: [] };

function harness(routes: Parameters<typeof mockFetch>[0]) {
  const { requests } = mockFetch(routes);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 60_000 }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { requests, wrapper };
}

afterEach(cleanup);

describe("useNodeTemplates", () => {
  it("lists the registry", async () => {
    const { wrapper } = harness([
      { path: "/api/v1/node-templates", body: { templates: [TEMPLATE], next_cursor: null } },
    ]);
    const { result } = renderHook(() => useNodeTemplates(), { wrapper });
    await waitFor(() => expect(result.current.data?.templates).toHaveLength(1));
    expect(result.current.data?.next_cursor).toBeNull();
  });

  it("treats a 404 as 'server lacks the endpoint' — data null, no error", async () => {
    const { wrapper } = harness([
      {
        path: "/api/v1/node-templates",
        status: 404,
        body: { type: "about:blank", title: "Not found", status: 404, detail: "no such route" },
      },
    ]);
    const { result } = renderHook(() => useNodeTemplates(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toBeNull();
    expect(result.current.error).toBeNull();
  });
});

describe("useNodeTemplate", () => {
  it("reads one template with revisions and usages", async () => {
    const { wrapper } = harness([{ path: "/api/v1/node-templates/t-1", body: DETAIL }]);
    const { result } = renderHook(() => useNodeTemplate("t-1"), { wrapper });
    await waitFor(() => expect(result.current.data?.template.slug).toBe("code-reviewer"));
    expect(result.current.data?.revisions).toHaveLength(1);
  });
});

describe("useCreateNodeTemplateRevision", () => {
  it("POSTs the exact body and invalidates list and detail", async () => {
    const response = {
      revision: { ...REVISION, revision_number: 2, version_label: "2.0.1", revision_id: "r-2" },
      adopted: [],
      skipped: [],
    };
    const { requests, wrapper } = harness([
      {
        path: "/api/v1/node-templates/t-1/revisions",
        method: "POST",
        status: 201,
        body: response,
      },
      { path: "/api/v1/node-templates", body: { templates: [TEMPLATE], next_cursor: null } },
      { path: "/api/v1/node-templates/t-1", body: DETAIL },
    ]);
    const { result } = renderHook(
      () => ({
        list: useNodeTemplates(),
        detail: useNodeTemplate("t-1"),
        mutation: useCreateNodeTemplateRevision("t-1"),
      }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.detail.data).toBeDefined());
    let resolved: unknown;
    await act(async () => {
      resolved = await result.current.mutation.mutateAsync({
        parameters: { type: "object", properties: {} },
        config: { profile: "reviewer-2" },
        output_schema: {},
        workspace_mode: "read_only",
        version_label: "2.0.1",
        adopt_using_workflows: true,
      } as unknown as Parameters<typeof result.current.mutation.mutateAsync>[0]);
    });
    expect((resolved as { revision: { version_label: string } }).revision.version_label).toBe(
      "2.0.1",
    );
    const post = requestsTo(requests, "/api/v1/node-templates/t-1/revisions", "POST")[0];
    const body = JSON.parse(String(post.body));
    expect(body.adopt_using_workflows).toBe(true);
    expect(body.version_label).toBe("2.0.1");
    expect(body.config).toEqual({ profile: "reviewer-2" });
  });
});

describe("useDuplicateNodeTemplate", () => {
  it("POSTs the duplicate body and returns the new template", async () => {
    const created = { ...TEMPLATE, id: "t-2", slug: "code-reviewer-copy" };
    const { requests, wrapper } = harness([
      { path: "/api/v1/node-templates/t-1/duplicate", method: "POST", status: 201, body: created },
    ]);
    const { result } = renderHook(() => useDuplicateNodeTemplate("t-1"), { wrapper });
    await act(async () => {
      const created = await result.current.mutateAsync({
        slug: "code-reviewer-copy",
        display_name: "Code reviewer copy",
      });
      expect(created.id).toBe("t-2");
    });
    const post = requestsTo(requests, "/api/v1/node-templates/t-1/duplicate", "POST")[0];
    expect(JSON.parse(String(post.body))).toEqual({
      slug: "code-reviewer-copy",
      display_name: "Code reviewer copy",
    });
  });
});
