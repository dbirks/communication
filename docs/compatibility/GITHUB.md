# GitHub compatibility — observed evidence

Scope: what the GitHub integration in this repo has actually been *run* against,
per ADR-0031 (read-only anonymous issue listing; no webhook, no token). Rows are
appended only with literal observed output — never prefilled with PASS.
No token is sent anywhere yet, so every row here is inside the anonymous budget
and proves public-repository behaviour only.

| Capability | Adapter surface | Observed | Result | Evidence date |
|---|---|---|---|---|
| Anonymous issue list, `GET /repos/{owner}/{repo}/issues` with `Accept: application/vnd.github+json`, `X-GitHub-Api-Version: 2022-11-28` | `internal/integrations/github` `Client.ListIssues` (same request shape; httptest-pinned in `client_test.go`) | real curl to `mattpocock/skills`, HTTP 200, 3 issues (numbers 1288, 1287, 1284) | PASS (observed, below) | 2026-10-16 |
| Authenticated (token) listing, private repos | — | not attempted; needs the `SecretRef` path (ADR-0018), follow-up to ADR-0031 | not verified | — |
| Webhooks / issue→run triggers | — | not built; `triggers`/`invocations` + dedupe are M6 (ADR-0031) | not verified | — |

## Literal output, 2026-10-16

```console
$ curl -s -o out.json -w '%{http_code}\n' \
    -H 'Accept: application/vnd.github+json' \
    -H 'X-GitHub-Api-Version: 2022-11-28' \
    'https://api.github.com/repos/mattpocock/skills/issues?state=open&per_page=3'
200
$ head -c 600 out.json
[
  {
    "url": "https://api.github.com/repos/mattpocock/skills/issues/1288",
    "repository_url": "https://api.github.com/repos/mattpocock/skills",
    "labels_url": "https://api.github.com/repos/mattpocock/skills/issues/1288/labels{/name}",
    "comments_url": "https://api.github.com/repos/mattpocock/skills/issues/1288/comments",
    "events_url": "https://api.github.com/repos/mattpocock/skills/issues/1288/events",
    "html_url": "https://github.com/mattpocock/skills/issues/1288",
    "id": 5872786510,
    "node_id": "I_kwDORHkdds8AAAABXgucTg",
    "number": 1288,
    "title": "GLOSSARY.m
```

This is the raw GitHub envelope; `ListIssues` decodes `number`, `title`, `body`,
`labels[].name`, `html_url`, `state`, `updated_at` from it and drops items
carrying a `pull_request` key (verified offline in `client_test.go`, not here).
Nothing beyond "GitHub answered 200 with issue JSON for a public repo" is
claimed by this row.
