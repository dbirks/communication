# api/ — API and event contracts

Contract assets only, per `docs/adr/ADR-0007-repository-layout.md`: **no Go code lives
here.** Go request handlers are in `internal/api`, worker code in `internal/worker`.
`api/` is the reviewable freeze point that both tracks (and the React UI in `ui/`)
write against.

| Path | What it is |
| --- | --- |
| `openapi.yaml` | OpenAPI 3.1 document for the REST surface under `/api/v1` plus the `/auth/*` login flow. |
| `schemas/event-envelope.schema.json` | JSON Schema (draft 2020-12) for the durable event envelope — every `domain_events` row and every SSE `data:` frame. Referenced from `openapi.yaml` as `components.schemas.EventEnvelope`. |
| `serve.compose.yaml` | *(not here yet)* `serve`-mode container/compose fragment, added with the compose task. |

## Status: M1 contract

This is the **M1** contract (`0.1.0-m1`): log in, create a project, add two
repositories, see consistent state across two API replicas
(`communication-spec/11-build-roadmap.md`). It covers a deliberate slice of
`communication-spec/09-api-events-data.md` — pipelines, runs, conversations,
artifacts, secrets and the assistant are later milestones and are **not** reserved or
stubbed here.

09 says of itself: "This document specifies **proposed** public API conventions, not an
already deployed server… Freeze details after the first vertical slice and ADR."
M1 is written to be buildable now, and is the freeze candidate. Until that freeze,
changes here need review by both tracks (API + UI) and, where they touch the public
API, persistence
schema or security boundary, an ADR in `docs/adr/` (see `AGENTS.md` → Decisions). After
the freeze, breaking changes need an ADR full stop — a PR that edits a request/response
shape without one is a bug.

M1 event types carried by the envelope: `project.created`, `project.member.updated`,
`repository.added`.

## Lint

```bash
# OpenAPI (warnings are reviewed, errors are not merged)
pnpm --package=@redocly/cli@2.63.0 dlx redocly lint api/openapi.yaml

# event envelope schema: must parse and keep its required set
python3 -I -c "import json;s=json.load(open('api/schemas/event-envelope.schema.json'));print(s['$schema'], sorted(s['required']))"
```

`pnpm dlx @redocly/cli …` fails on pnpm 10+ ("Could not determine executable to run":
the package ships both `redocly` and `openapi` binaries), hence the `--package=` form.

Deliberate redocly warnings — do not "fix" them by changing the contract:

* `no-server-example.com` on `servers[0].url`: the M1 local stack is served same-origin
  at `http://localhost:8080` behind the compose load balancer, and the brief pins that
  single server entry.
* `operation-2xx-response` on `GET /auth/login` and `GET /auth/callback`: the OIDC hop
  is a `302`; `302` is the success code, and 3xx is not a 2xx.
* `operation-4xx-response` on `GET /api/v1/system/health` and `GET /auth/login`: health
  never fails (it does not touch the database) and `login` only redirects; readiness
  fails with `503`, which is 5xx.

Redocly resolves the external `$ref` into `schemas/event-envelope.schema.json`, so a
broken envelope schema fails the OpenAPI lint too.
