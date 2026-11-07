# ADR-0077 — Per-replica in-memory request rate limits and stream caps

- **Date:** 2026-11-06
- **Status:** Accepted (implemented and verified — see Verification)
- **Owners:** control-plane maintainers
- **Related decisions / contracts:** audit findings F1/F2 (internet-exposure review, 2026-11-06), ADR-0012 (the login handshake writes one `oidc_login_states` row per hit — F1's amplifier), ADR-0014 § 5 (SSE stream semantics — F2's per-principal concurrency target), ADR-0034/ADR-0050 (assistant turns are billed model work — F2's cost target), ADR-0061 (GitHub issue reads share one upstream request budget per egress IP), communication-spec/09-api-events-data.md (problem+json error envelope).

## Context

The read-only internet-exposure audit found that nothing in the API throttles anything:

- **F1:** every unauthenticated `GET /auth/login` inserts an `oidc_login_states` row (audit/session writes ride the same path), so a scripted attacker turns a cheap GET into unbounded Postgres writes.
- **F2:** with one cheap auto-provisioned account an attacker can (a) fire unlimited assistant turns, each of which makes several *billed* model calls against the operator's gateway; (b) exhaust the shared 60 req/h upstream GitHub budget for every other user from one script; (c) open unlimited concurrent SSE streams, each a goroutine, two tickers and repeated authz queries.

Any throttle must decide where the counter lives. That is the decision this ADR records; the exact profile numbers are tunable knobs, not protocol.

## Options considered
| Option | Advantages | Disadvantages | Evidence |
|---|---|---|---|
| A. Per-replica in-memory buckets (chosen) | Zero new dependencies (stdlib only, matching the repo rule); no hot DB row per request; eviction keeps memory capped; trivially testable with an injectable clock | Effective fleet limit is replicas x configured limit; a restart hands every key a fresh burst; per-IP keys need a trusted-proxy rule | `internal/api/ratelimit.go` + unit tests |
| B. Postgres-backed shared buckets | Exact fleet-wide limits; survives restarts | One serialised write per throttled request — the throttle itself becomes the DB amplifier F1 is about; needs tables/migrations | rejected on ADR-0013 cost grounds |
| C. Edge/LB rate limiting (nginx/nginx-ingress config) | No application code; standard practice | Unportable across the deployment models this repo ships (compose LB, Tailscale Ingress, home-cluster manifests); limits silently vanish wherever the edge is replaced; invisible to tests | rejected — the app must hold the floor |
| D. Redis/token-bucket service | Exact shared limits, cheap | New mandatory infrastructure dependency for M-stage deployments | rejected as Later-tier scope |

## Decision

**Option A.** `internal/api/ratelimit.go` adds a keyed token bucket (`sync.Mutex` + map + injectable clock, stdlib only) and a per-key concurrency limiter (counting-semaphore map). The bucket map cannot grow without bound: it is capped at 100k keys and, on overflow, evicts sampled idle keys (TTL 10 min) first, else the oldest-touched sampled key; an evicted key simply returns as a fresh bucket, so eviction degrades fairness, never availability. The semaphore map holds an entry only while a principal holds a live stream, so it is bounded by concurrent connections.

Profiles and defaults (all applied by `serve`'s env parsing — the `api.Config` zero value disables everything so tests and the lab are never throttled by accident):

| Route group | Key | Default | Env (per-minute / burst) |
|---|---|---|---|
| `GET /auth/login`, `GET /auth/callback` | client IP | 10/min, burst 20 | `COMMUNICATION_RATE_AUTH_PER_MIN` / `COMMUNICATION_RATE_AUTH_BURST` |
| `POST /api/v1/assistant/ask`, `POST /api/v1/assistant/draft-proposals`, `POST /api/v1/assistant/conversations/{id}/messages` | principal (user id) | 30/min, burst 10 | `COMMUNICATION_RATE_ASSISTANT_PER_MIN` / `COMMUNICATION_RATE_ASSISTANT_BURST` |
| `GET /api/v1/projects/{id}/repos/{rid}/issues` | principal | 60/min, burst 30 | `COMMUNICATION_RATE_ISSUES_PER_MIN` / `COMMUNICATION_RATE_ISSUES_BURST` |
| SSE: project, org, conversation and run event streams | principal | 16 concurrent | `COMMUNICATION_RATE_MAX_STREAMS` |

**A value of 0 disables that limit.** The principal routes wrap the handler *inside* `HandleAuthed`, so the throttle only ever sees requests whose session already resolved (anonymous floods are answered 401 before a token is spent).

**Trusted-proxy rule:** `COMMUNICATION_TRUSTED_PROXY_HOPS` defaults to 0, which means the client IP is always `r.RemoteAddr`'s host and `X-Forwarded-For` is never honoured — a client could otherwise spray header values into free bucket keys. With hops = N ≥ 1 the *first* (leftmost) XFF hop becomes the key when present. That is the client address only when exactly N trusted proxies front the replica and own the header (one LB that rewrites/normalises XFF); operators behind a different topology must leave it at 0 or size the keying themselves.

**429 shape:** every denial is `application/problem+json` with `status: 429`, `title: "Too Many Requests"`, a non-echoing fixed `detail`, and a `Retry-After` header in whole seconds (ceil of the token refill wait, minimum 1; stream-cap denials advise 1). No body or identity detail is echoed.

**Effective limits scale with replicas:** with R replicas an attacker sees up to R x the configured sustained rate (requests may land on any replica; ADR-0012's statelessness is preserved). This is accepted for now: the throttle's job is to raise the cost of scripted abuse from O(1) to O(replicas x burst + rate x time) without adding shared state to the hot path; exactness is Option B/D territory and can replace the backend behind the same config surface.

## Consequences
- Positive: the F1 write amplifier and the F2 cost/quota/goroutine vectors now have bounded per-key budgets; limits are uniform across deployment shapes; every knob is env-tunable and rollbackable to "off".
- Negative / accepted: distributed attackers and IP rotation shrink the effective limit; a replica restart refreshes bursts; the auth bucket is per-IP only (no per-account throttle — account-keyed login throttling belongs with the IdP); limits are absent wherever `api.Config.Limits` is left zero (dev mode inherits serve's env parsing, so only non-production hand-built stacks opt out).
- Backwards compatibility: none of the success-path contracts change; only over-limit clients see a new 429. The lab compose (`compose.yml`, both `api-a`/`api-b` replicas) sets all four `COMMUNICATION_RATE_*_PER_MIN`/`MAX_STREAMS` knobs to 0 because the e2e/verification suites drive these routes from one browser (one IP behind the lb, one bootstrap principal) — production defaults would fail the suites, not the product.

## Security/privacy
- Fail-open within a request (a missing/evicted bucket admits a full burst); fail-closed is not possible without shared state and was rejected as Option B's cost.
- Keys are IPs and user ids held in an in-process capped map; nothing is logged from the limiter and no key material or client body is echoed in the 429 detail.
- Misconfiguring `COMMUNICATION_TRUSTED_PROXY_HOPS` larger than the real proxy count makes the auth throttle forgeable (attacker-chosen XFF keys); 0 (the default) is never forgeable, only coarse behind a shared NAT/LB.

## Verification
- `go test -count=1 ./internal/api/... ./cmd/communication` (2026-11-06): unit tests for burst/refill arithmetic (`TestKeyedBucket*`, injectable clock), cap + idle eviction (`TestKeyedBucketIdleEviction`, `TestKeyedBucketCapEvictsOldestTouched`), the semaphore (`TestKeyedSemaphore*`), XFF trust (`TestClientKey`), the 429 problem+json + `Retry-After` shape through the real middleware chain (`TestThrottleAuth*`, `TestThrottleAssistant*`, `TestThrottleIssues*`, `TestLimitStreamsCapsConcurrentStreamsPerPrincipal`), the disabled-by-zero pass-through, and the env parsing (`TestServeRateLimits*`). All PASS.
- Full-suite evidence (e2e lab with the overrides above) lands with the CI run for this commit.

## Migration/rollback
No schema, no new dependency, no deployment-shape change: roll forward is redeploy. Rollback is either the old binary or setting every `COMMUNICATION_RATE_*` knob (and `COMMUNICATION_TRUSTED_PROXY_HOPS`) to 0 — with 0 the binary behaves exactly as the pre-ADR code. Lab compose already ships the 0 configuration.
