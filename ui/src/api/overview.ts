/**
 * The Operations page's one read and its one action:
 *
 * - `GET  /api/v1/system/overview` — what this deployment is (build, identity,
 *   storage), what it can ask a model to do (four rows, configuration only),
 *   how many secrets the READER can see, and how many workers are online.
 * - `POST /api/v1/system/models/{kind}/probe` — one real upstream round trip,
 *   answered `{ok, latency_ms, detail}`.
 *
 * These types are written by hand, not generated: `api/openapi.yaml` is another
 * brief's file, and until it names `SystemOverview` there is no
 * `components["schemas"]` member to alias (`src/api/types.ts` restates nothing
 * on purpose, so the shapes live here — the same arrangement `catchup.ts` uses
 * for its local page types). When the document grows the schemas, this module
 * becomes aliases and nothing else changes.
 *
 * No member here can hold a secret value: the server reduces a key to
 * `key_set`, an endpoint to its bare host, and a secret to a count. The probe's
 * `detail` is the upstream's own error message, so it is display text — never
 * put it in a link, an attribute the browser interprets, or a log line the
 * person cannot see.
 */
import { useQuery } from "@tanstack/react-query";
import { ApiError, apiFetch } from "./client";

/** The kinds this app asks a model about. A newer server may name others. */
export type ModelKind = "assistant" | "speech" | "decision" | "worker_chat";

/** One model row. `kind` stays `string`-friendly so a row this build does not
 *  know about renders as an unknown row instead of throwing the page away. */
export interface OverviewModel {
  kind: ModelKind | string;
  label: string;
  model: string;
  endpoint_host: string;
  /** Null when this replica cannot know: a worker-side model's key lives in a
   *  worker's environment, and "not visible here" is not the claim "not set". */
  key_set: boolean | null;
  configured: boolean;
}

/** `GET /api/v1/system/overview`'s 200 body. */
export interface SystemOverview {
  server: {
    version: string;
    /** "" when the binary carries no claim to a revision. */
    commit: string;
    replica: string;
    /** 0 when this replica could not read its own datastore; readiness is the
     *  route that explains that, not this one. */
    schema_version: number;
    started_at: string;
  };
  identity: { provider: string; issuer_host: string; dev_login: boolean };
  storage: { artifact_backend: string; preview_host: string };
  models: OverviewModel[];
  /** The READER's picture: counts across the projects they are a member of. */
  secrets: { projects: number; secrets: number; mounts: number };
  workers: { online: number; offline: number; stale_after_seconds: number };
}

/** One probe's answer. A failed probe is still a 200: `ok:false` is a result,
 *  not an HTTP error, and the 4xx arms are the refusals (403 no library role,
 *  429 two probes of one kind inside ten seconds). */
export interface ModelProbeResult {
  ok: boolean;
  latency_ms: number;
  detail: string;
}

/** The one cache key every overview read shares (tiles, panels, about). */
export const systemOverviewKey = ["system", "overview"] as const;

/**
 * `GET /api/v1/system/overview`. A `404` means the serving image predates the
 * route — "this server does not answer that yet", not a failure — so it
 * resolves to null and the caller says so in words. Anything else throws.
 */
export async function fetchSystemOverview(): Promise<SystemOverview | null> {
  try {
    return await apiFetch<SystemOverview>("/api/v1/system/overview");
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}

/**
 * `POST /api/v1/system/models/{kind}/probe` — one outbound request on the
 * deployment's budget, so the server answers 403 without the organization's
 * library role and 429 when the same kind was probed inside ten seconds.
 * `ApiError.detail` carries the server's sentence in both cases.
 */
export function probeModel(kind: ModelKind | string): Promise<ModelProbeResult> {
  return apiFetch<ModelProbeResult>(`/api/v1/system/models/${encodeURIComponent(kind)}/probe`, {
    method: "POST",
  });
}

/**
 * The overview read. `refetchInterval` is the page's own cadence, not a
 * subscription: every field is a live fact about a fleet that changes while
 * the page is open, and the route is `no-store` for the same reason.
 * `retry: false` because a `404` is an answer this function already folds to
 * null, and a `500` on a self-read means the deployment is having a day.
 */
export function useSystemOverview() {
  return useQuery({
    queryKey: systemOverviewKey,
    queryFn: fetchSystemOverview,
    refetchInterval: 15_000,
    retry: false,
  });
}
