/**
 * The collection-library data hooks and the add-row grammar mirror
 * (`api/apmCollections.ts`, ADR-0084). Two contract behaviours matter: the
 * LIST read's 404 means "server lacks the endpoint" and degrades to `null`
 * (the nodeTemplates convention), while a 404 on ONE collection stays an
 * error; and the writes POST the exact bodies the wire checks. The ref
 * validator carries ADR-0084's pin rule — a branch is refused, a tag or a
 * full SHA is not.
 */
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import {
  COLLECTION_REF_ERROR,
  collectionPackageCount,
  createCollection,
  createRevision,
  newestPublishedRevision,
  publishRevision,
  useApmCollection,
  useApmCollections,
  validateCollectionRef,
  type APMCollection,
  type APMCollectionDetail,
  type APMCollectionRevision,
} from "./apmCollections";
import { mockFetch, requestsTo } from "../test/fakes";

const COLLECTION: APMCollection = {
  id: "01987a71-3333-7000-8000-abcdef012345",
  slug: "matt-pocock-skills",
  name: "Matt Pocock skills",
  description: "The whole plugin set of 27 skills.",
  created_by: "migration:00033",
  created_at: "2026-11-11T10:00:00Z",
  updated_at: "2026-11-11T10:00:00Z",
  published_revisions: 1,
  latest_revision: {
    revision_id: "01987a71-4444-7000-8000-abcdef012345",
    revision: 1,
    status: "published",
    entries: [{ ref: "mattpocock/skills#v1.3.2" }],
    created_at: "2026-11-11T10:00:00Z",
  },
};

const REVISION_DRAFT: APMCollectionRevision = {
  revision_id: "01987a71-5555-7000-8000-abcdef012345",
  revision: 2,
  status: "draft",
  entries: [{ ref: "mattpocock/skills#v1.3.2", skills: ["tdd"], note: "narrowed" }],
  created_by: "u-1",
  created_at: "2026-11-11T11:00:00Z",
};

const REVISION_PUBLISHED: APMCollectionRevision = {
  revision_id: "01987a71-4444-7000-8000-abcdef012345",
  revision: 1,
  status: "published",
  entries: [{ ref: "mattpocock/skills#v1.3.2" }],
  created_by: "migration:00033",
  created_at: "2026-11-11T10:00:00Z",
};

const DETAIL: APMCollectionDetail = {
  collection: COLLECTION,
  revisions: [REVISION_DRAFT, REVISION_PUBLISHED],
};

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

describe("useApmCollections", () => {
  it("lists the library", async () => {
    const { wrapper } = harness([
      { path: "/api/v1/apm-collections", body: { collections: [COLLECTION], next_cursor: null } },
    ]);
    const { result } = renderHook(() => useApmCollections(), { wrapper });
    await waitFor(() => expect(result.current.data?.collections).toHaveLength(1));
    expect(result.current.data?.next_cursor).toBeNull();
  });

  it("treats a 404 as 'server lacks the endpoint' — data null, no error", async () => {
    const { wrapper } = harness([]);
    const { result } = renderHook(() => useApmCollections(), { wrapper });
    await waitFor(() => expect(result.current.isPending).toBe(false));
    expect(result.current.data).toBeNull();
    expect(result.current.error).toBeNull();
  });
});

describe("useApmCollection", () => {
  it("reads one collection with its full revision history", async () => {
    const { wrapper } = harness([
      { path: `/api/v1/apm-collections/${COLLECTION.id}`, body: DETAIL },
    ]);
    const { result } = renderHook(() => useApmCollection(COLLECTION.id), { wrapper });
    await waitFor(() => expect(result.current.data?.revisions).toHaveLength(2));
    expect(result.current.data?.collection.name).toBe("Matt Pocock skills");
  });
});

describe("collection writes", () => {
  it("createCollection POSTs the identity body", async () => {
    const { requests } = harness([
      { path: "/api/v1/apm-collections", method: "POST", status: 201, body: COLLECTION },
    ]);
    await createCollection({ slug: "matt-pocock-skills", name: "Matt Pocock skills" });
    const [request] = requestsTo(requests, "/api/v1/apm-collections", "POST");
    expect(JSON.parse(request.body ?? "{}")).toEqual({
      slug: "matt-pocock-skills",
      name: "Matt Pocock skills",
    });
  });

  it("createRevision POSTs the ordered entries", async () => {
    const { requests } = harness([
      {
        path: `/api/v1/apm-collections/${COLLECTION.id}/revisions`,
        method: "POST",
        status: 201,
        body: REVISION_DRAFT,
      },
    ]);
    const created = await createRevision(COLLECTION.id, REVISION_DRAFT.entries);
    expect(created.revision).toBe(2);
    const [request] = requestsTo(
      requests,
      `/api/v1/apm-collections/${COLLECTION.id}/revisions`,
      "POST",
    );
    expect(JSON.parse(request.body ?? "{}")).toEqual({ entries: REVISION_DRAFT.entries });
  });

  it("publishRevision POSTs the exact revision's publish route", async () => {
    const { requests } = harness([
      {
        path: `/api/v1/apm-collections/${COLLECTION.id}/revisions/2/publish`,
        method: "POST",
        body: { ...REVISION_DRAFT, status: "published" },
      },
    ]);
    const published = await publishRevision(COLLECTION.id, 2);
    expect(published.status).toBe("published");
    expect(
      requestsTo(requests, `/api/v1/apm-collections/${COLLECTION.id}/revisions/2/publish`, "POST"),
    ).toHaveLength(1);
  });
});

describe("newestPublishedRevision + counts", () => {
  it("skips the open draft and names the newest published revision", () => {
    const published = newestPublishedRevision(DETAIL);
    expect(published?.revision).toBe(1);
    expect(
      newestPublishedRevision({ collection: COLLECTION, revisions: [REVISION_DRAFT] }),
    ).toBeNull();
  });

  it("counts the packages of the latest revision", () => {
    expect(collectionPackageCount(COLLECTION)).toBe(1);
    expect(collectionPackageCount({ ...COLLECTION, latest_revision: null })).toBe(0);
  });
});

describe("validateCollectionRef — ADR-0084's pin grammar", () => {
  it("refuses a branch", () => {
    expect(validateCollectionRef("mattpocock/skills#main")).toBe(COLLECTION_REF_ERROR);
    expect(validateCollectionRef("mattpocock/skills#master")).toBe(COLLECTION_REF_ERROR);
    expect(validateCollectionRef("owner/repo")).toBe(COLLECTION_REF_ERROR);
    expect(validateCollectionRef("owner/repo#")).toBe(COLLECTION_REF_ERROR);
    expect(validateCollectionRef("")).toBe(COLLECTION_REF_ERROR);
    expect(validateCollectionRef("owner/repo#v1.3.2 main")).toBe(COLLECTION_REF_ERROR);
    expect(validateCollectionRef("owner/../repo#v1.0.0")).toBe(COLLECTION_REF_ERROR);
  });

  it("accepts a tag", () => {
    expect(validateCollectionRef("mattpocock/skills#v1.3.2")).toBeNull();
    expect(validateCollectionRef("cursor/plugins/harness/pstack/claude-code#v1.0.0")).toBeNull();
  });

  it("accepts a full 40-character commit SHA", () => {
    expect(
      validateCollectionRef(
        "cursor/plugins/harness/pstack/claude-code/skills/poteto-mode#63912a91d52c43946f974f2aaf661334a6116a82",
      ),
    ).toBeNull();
  });
});
