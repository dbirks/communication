/**
 * The APM collection library (ADR-0084): named, versioned bundles of pinned
 * APM refs that an agent profile attaches in an order of its choosing.
 *
 * Wire contract: `docs/adr/ADR-0084-apm-collections.md` + `api/openapi.yaml`
 * (`GET|POST /api/v1/apm-collections`, `GET /apm-collections/{id}`,
 * `POST .../revisions`, `POST .../revisions/{rev}/publish`).
 *
 * The list read's `404` means the serving image predates the endpoint — the
 * honest "not available yet" (same convention as `nodeTemplates.ts` and
 * `launchers.ts`), not an error. A `404` on ONE collection stays an error.
 *
 * Revisions are immutable once published (ADR-0002's rule for pipelines,
 * restated here): every edit lands a NEW draft revision, and publishing is a
 * separate act — "a human read the entries".
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, apiFetch } from "./client";
import type { components } from "./schema";

export type APMCollection = components["schemas"]["APMCollection"];
export type APMCollectionList = components["schemas"]["APMCollectionList"];
export type APMCollectionDetail = components["schemas"]["APMCollectionDetail"];
export type APMCollectionRevision = components["schemas"]["APMCollectionRevision"];
export type APMCollectionEntry = components["schemas"]["APMCollectionEntry"];
export type APMCollectionPin = components["schemas"]["APMCollectionPin"];
export type APMCollectionCreate = components["schemas"]["APMCollectionCreate"];

export const apmCollectionKeys = {
  list: ["apm-collections"] as const,
  detail: (id: string) => ["apm-collections", id] as const,
};

/** The Collections tab route and one collection's editor route. These live
 * here (rather than `lib/routes.ts`) only while the feature is one worker's:
 * they are the addresses `App.tsx` mounts `pages/Collections.tsx` at. */
export const collectionsRoute = "/workflows/collections";
export const collectionRoute = (id: string): string =>
  `/workflows/collections/${encodeURIComponent(id)}`;

/**
 * The library (`GET /api/v1/apm-collections`), ordered by slug; the whole
 * organization in one page. `data` is `null` — not an error — when the server
 * lacks the endpoint.
 */
export function useApmCollections() {
  return useQuery({
    queryKey: apmCollectionKeys.list,
    queryFn: async (): Promise<APMCollectionList | null> => {
      try {
        return await apiFetch<APMCollectionList>("/api/v1/apm-collections");
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return null;
        throw error;
      }
    },
    retry: false,
  });
}

/** One collection with its FULL revision history, newest first. */
export function useApmCollection(collectionId: string | undefined) {
  return useQuery({
    queryKey: apmCollectionKeys.detail(collectionId ?? ""),
    queryFn: () => apiFetch<APMCollectionDetail>(`/api/v1/apm-collections/${collectionId}`),
    enabled: collectionId !== undefined && collectionId !== "",
    retry: false,
  });
}

/** `POST /api/v1/apm-collections` — identity plus the revision-1 entries; the
 * new collection lands as a DRAFT (publishing is its own act). */
export function createCollection(body: APMCollectionCreate): Promise<APMCollection> {
  return apiFetch<APMCollection>("/api/v1/apm-collections", { method: "POST", json: body });
}

/** `POST .../revisions` — "save as a new revision". The revision number is the
 * store's (one past the highest), never the caller's. */
export function createRevision(
  collectionId: string,
  entries: APMCollectionEntry[],
): Promise<APMCollectionRevision> {
  return apiFetch<APMCollectionRevision>(`/api/v1/apm-collections/${collectionId}/revisions`, {
    method: "POST",
    json: { entries },
  });
}

/** `POST .../revisions/{rev}/publish` — flip one draft to published. A
 * published revision is immutable; publishing an already-published one is
 * `409`, never a silent no-op. */
export function publishRevision(
  collectionId: string,
  revision: number,
): Promise<APMCollectionRevision> {
  return apiFetch<APMCollectionRevision>(
    `/api/v1/apm-collections/${collectionId}/revisions/${revision}/publish`,
    { method: "POST" },
  );
}

/** The detail read outside the cache — the profile's picker uses it to answer
 * "which revision is the newest PUBLISHED one" before it pins a pin. */
export function getCollectionDetail(collectionId: string): Promise<APMCollectionDetail> {
  return apiFetch<APMCollectionDetail>(`/api/v1/apm-collections/${collectionId}`);
}

/** The newest PUBLISHED revision of a detail read, or null when nothing has
 * ever been published. `latest` is never a thing a profile may attach — the
 * pin names an exact revision (ADR-0084). */
export function newestPublishedRevision(detail: APMCollectionDetail): APMCollectionRevision | null {
  // The wire orders revisions newest first; take the first published one.
  for (const revision of detail.revisions) {
    if (revision.status === "published") return revision;
  }
  return null;
}

/** Drop the library + one collection from the cache after a write. */
export function invalidateCollections(queryClient: ReturnType<typeof useQueryClient>, id?: string) {
  void queryClient.invalidateQueries({ queryKey: apmCollectionKeys.list });
  if (id !== undefined) {
    void queryClient.invalidateQueries({ queryKey: apmCollectionKeys.detail(id) });
  }
}

/** The inline refusal the add-row shows for any ref that is not a pin. */
export const COLLECTION_REF_ERROR = "Pin a tag or a full commit SHA — branches move.";

/** Names a default branch could carry — the client refuses these outright;
 * any other revision reads as a tag (the server's grammar owns the rest). */
const DEFAULT_BRANCH_NAMES = new Set(["main", "master", "develop", "dev", "trunk"]);

/** The characters a git coordinate can hold — the worker's `checkRefChars`
 * whitelist restated so the add-row refuses what the server will refuse. */
const REF_CHARS = /^[A-Za-z0-9\-_./]+$/;

const FULL_SHA = /^[0-9a-f]{40}$/i;

/**
 * Client-side mirror of the collection entry grammar: the worker's
 * `apm.ValidatePackageRef` (`internal/agent/apm/manifest.go`) PLUS the
 * ADR-0084 pin requirement — the `#<revision>` must be a tag or a full
 * 40-character SHA, never a branch a force-push can move. Returns the inline
 * error text, or `null` when the ref is a pin the flatten will accept.
 */
export function validateCollectionRef(raw: string): string | null {
  const ref = raw.trim();
  if (ref === "") return COLLECTION_REF_ERROR;
  const hash = ref.indexOf("#");
  // Exactly one `#`, a path before it, a revision after it.
  if (hash < 0 || hash !== ref.lastIndexOf("#")) return COLLECTION_REF_ERROR;
  const source = ref.slice(0, hash);
  const revision = ref.slice(hash + 1);
  if (revision === "") return COLLECTION_REF_ERROR;
  const segments = source.split("/");
  if (segments.length < 2 || segments[0] === "" || segments[1] === "") {
    return COLLECTION_REF_ERROR;
  }
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") return COLLECTION_REF_ERROR;
  }
  if (!REF_CHARS.test(source) || !REF_CHARS.test(revision)) return COLLECTION_REF_ERROR;
  // Git's own refusals (the backend's `ValidAPMPackageRef`).
  if (revision.startsWith("-") || revision.endsWith("/") || revision.includes("..")) {
    return COLLECTION_REF_ERROR;
  }
  // A full commit SHA is the strongest pin; anything that reads like a default
  // branch is refused; the rest is taken at its word as a tag — the server and
  // the eventual `apm resolve` are still the authorities.
  if (FULL_SHA.test(revision)) return null;
  if (DEFAULT_BRANCH_NAMES.has(revision.toLowerCase())) return COLLECTION_REF_ERROR;
  return null;
}

/** How many packages (entries) a collection row currently IS. */
export function collectionPackageCount(collection: APMCollection): number {
  return collection.latest_revision?.entries.length ?? 0;
}
