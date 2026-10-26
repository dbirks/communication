# GitHub compatibility — observed evidence

Scope: what the GitHub integration in this repo has actually been *run* against,
per ADR-0031 (read-only anonymous issue listing; no webhook, no token), plus —
from 2026-10-25 — the authenticated issue → draft-PR loop ("Observed" section
below). Rows are appended only with literal observed output — never prefilled
with PASS. The 2026-10-16 rows are anonymous-budget public-repo behaviour only;
the 2026-10-25 rows are the first authenticated evidence in this file. No token
*value* is recorded anywhere here — only the operator's token-file path.

| Capability | Adapter surface | Observed | Result | Evidence date |
|---|---|---|---|---|
| Anonymous issue list, `GET /repos/{owner}/{repo}/issues` with `Accept: application/vnd.github+json`, `X-GitHub-Api-Version: 2022-11-28` | `internal/integrations/github` `Client.ListIssues` (same request shape; httptest-pinned in `client_test.go`) | real curl to `mattpocock/skills`, HTTP 200, 3 issues (numbers 1288, 1287, 1284) | PASS (observed, below) | 2026-10-16 |
| Authenticated access to a private repo (clone/fetch + issue read via the ADR-0061 integration-broker secret; branch push + PR open via the ADR-0045 `GH_TOKEN` env mount) | serve-side broker/poller/push paths — *not* token listing through `Client.ListIssues`, which was not separately exercised | real private repo `dbirks/comms-test-repo-1` cloned, fetched, issue-polled, pushed to, and drafted PRs opened against it on 2026-10-25 | PASS (observed, below) | 2026-10-25 |
| Issue-label → run trigger (ADR-0056 serve-side poller; **not** a webhook) | issue trigger on `labeled` / any-of `[comm:go]` | applying `comm:go` to real issues #28/#30 fired a matching run ~45 s after the label (driver-side observation against `GET /projects/{id}/runs?trigger=issue`) | PASS (observed, below) | 2026-10-25 |
| Webhooks | — | not built — the trigger above is poll-based; `triggers`/`invocations` + dedupe remain M6 work (ADR-0031) | not verified | — |

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

## Observed: real issue → draft-PR loop on a private repo, 2026-10-25

Scope: the `seed-github-loop.sh` + `gh-loop.sh` probes under
`docs/compatibility/probes/m4/` driving the real **private** throwaway repo
`dbirks/comms-test-repo-1` (`private: true`, default branch `main`) against the
running `compose.real.yml` lab — driver at f42615d, lab build at 664de1a. The
token lives only in the operator's file (path documented in "Re-running" below);
neither the scripts nor this file ever carry its value.

What the 2026-10-25 22:25–22:41 UTC run observed:

- **Issue-label trigger (ADR-0056 poller):** applying `comm:go` to a real
  issue fired a run ~45 s after the label was applied. No webhook involved.
- **Private authenticated git + issue read:** the loop cloned/fetched the
  private repo and read its issues through the ADR-0061 `github-broker`
  secret set as the repository's `credential_secret_id`.
- **Agent in nono pushed + opened the draft PR:** the implement agent (claude
  launcher under ADR-0036's lab exception, sandboxed in nono) pushed a
  `comm/issue-<n>-<slug>` branch with the ADR-0045 `GH_TOKEN` env secret and
  opened a **draft** PR. GitHub reports `isDraft: true` for every PR below.
  PR `author.login` is `dbirks` because that is the token owner; the commit
  authors are `Communication Worker <worker@communication.invalid>`.
- **Unassisted full loop:** issue **#28 → draft PR #29** and issue
  **#30 → draft PR #31** ran end to end with no human in the loop — the
  driver decided the pipeline's approval gate through the API as admin.
- **#26 → PR #27 needed a manual gate approval, plainly because of a driver
  bug at the time:** `lib.sh` keys its admin cookie jar by user alone, so the
  seed's own `login admin` rewrote the jar and the gate-approval call carried
  a stale CSRF token and 403'd; the gate was approved by hand and the run then
  completed. Fixed in f42615d (`refresh_csrf` re-read + one retry after a
  CSRF 403) — the two unassisted pairs above ran on that fixed driver.

GitHub-side timestamps (read-only `gh`; label event from
`gh api repos/…/issues/<n>/events`):

| issue created | `comm:go` applied | draft PR | PR created | head ref | diff (gh pr view) |
|---|---|---|---|---|---|
| #28 22:34:14Z | 22:34:15Z | #29 | 22:37:39Z | `comm/issue-28-add-report-command` | +28/−1, 3 files, commit `ed3136a` |
| #30 22:38:03Z | 22:38:04Z | #31 | 22:40:20Z | `comm/issue-30-reject-empty-names` | +16/−0, 1 file, commit `46db416` |
| #26 22:25:34Z | 22:25:35Z | #27 | 22:33:37Z | `comm/issue-26-add-report-command` | +24/−1, 3 files, commit `d8c85420` |

Literal output (the JSON this section is based on):

```console
$ gh pr view 29 -R dbirks/comms-test-repo-1 --json number,title,isDraft,headRefName,createdAt,url
{"createdAt":"2026-10-25T22:37:39Z","headRefName":"comm/issue-28-add-report-command","isDraft":true,"number":29,"title":"Add the missing tally report subcommand to the existing Node.js CLI","url":"https://github.com/dbirks/comms-test-repo-1/pull/29"}
$ gh pr view 31 -R dbirks/comms-test-repo-1 --json number,title,isDraft,headRefName,createdAt,url
{"createdAt":"2026-10-25T22:40:20Z","headRefName":"comm/issue-30-reject-empty-names","isDraft":true,"number":31,"title":"Reject empty and whitespace-only names in tally add","url":"https://github.com/dbirks/comms-test-repo-1/pull/31"}
$ gh pr view 27 -R dbirks/comms-test-repo-1 --json number,title,isDraft,headRefName,createdAt,url
{"createdAt":"2026-10-25T22:33:37Z","headRefName":"comm/issue-26-add-report-command","isDraft":true,"number":27,"title":"Add a tally report command that prints each counter and its count","url":"https://github.com/dbirks/comms-test-repo-1/pull/27"}
$ gh issue view 28 -R dbirks/comms-test-repo-1 --json number,title,labels,createdAt,closed
{"closed":false,"createdAt":"2026-10-25T22:34:14Z","labels":[{"id":"LA_kwDOVV-IEs8AAAAC_J9Wcg","name":"comm:go","description":"communication: run the issue-to-PR loop","color":"0e8a16"}],"number":28,"title":"Bootstrap the tally CLI project"}
$ gh issue view 30 -R dbirks/comms-test-repo-1 --json number,title,labels,createdAt,closed
{"closed":false,"createdAt":"2026-10-25T22:38:03Z","labels":[{"id":"LA_kwDOVV-IEs8AAAAC_J9Wcg","name":"comm:go","description":"communication: run the issue-to-PR loop","color":"0e8a16"}],"number":30,"title":"tally add should reject empty item names"}
$ gh issue view 26 -R dbirks/comms-test-repo-1 --json number,title,labels,createdAt,closed
{"closed":false,"createdAt":"2026-10-25T22:25:34Z","labels":[{"id":"LA_kwDOVV-IEs8AAAAC_J9Wcg","name":"comm:go","description":"communication: run the issue-to-PR loop","color":"0e8a16"}],"number":26,"title":"Bootstrap the tally CLI project"}
```

Earlier PRs, described as GitHub shows them: **#21, #23, #25** are open draft
PRs from earlier runs of the same loop on the same evening (created
17:54:25Z / 17:57:05Z / 18:00:42Z; heads `comm/issue-20-add-report-command`,
`comm/issue-22-reject-empty-names`, `comm/issue-24-sort-report-by-count`; one
commit each by `Communication Worker`: `d22767f6`, `0c7961e3`, `9513abd0`),
and issues #1–#19 with draft PRs #4/#6/#8/#10/#14/#18 are repeated attempts
of the same three tickets earlier on 2026-10-25. This record claims for those
only what GitHub shows — open drafts from `comm/issue-*` heads — and makes no
claim about how their approval gates were decided.

Context: **nothing has been merged.** `main` is still the hand-written
Node.js `tally` skeleton (commit `015e9d89`, 2026-10-24, authored before the
loop ran), which is why the "Bootstrap the tally CLI project" issues produced
PRs titled "add the missing report subcommand to the existing Node.js CLI" —
the issue body instructs the agent to do the most obviously missing piece when
the project already exists.

Not verified by this run, unchanged: webhooks (poller only), `pi`-launcher
profiles in this loop (claude-only per ADR-0036; launcher pi stays a GAP in
`docs/compatibility/ACP.md`), merge/review flows, private-repo token listing
through `Client.ListIssues` itself, and any dedupe/webhook delivery (M6,
ADR-0031).

## Re-running the loop

```bash
COMMUNICATION_TEST_REPO_TOKEN_FILE=$HOME/.config/communication/test-repo-token \
  bash docs/compatibility/probes/m4/gh-loop.sh N
```

Needs the `compose.real.yml` lab up with the `gh-loop` project seeded
(`seed-github-loop.sh` is idempotent and the driver runs it if the project is
absent). The path above is the operator's token *file* only — the value is
never read into argv, printed, or written by the scripts or by anything in
this file.
