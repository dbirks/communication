# Assistant handoff: wire contract

These are the shared shapes the backend and UI tasks build against. Field names are final; add to them only through a contract change. Every route is behind the usual session auth and the assistant rate limiter. Every read authorizes as the caller.

## 1. System status (§2): `GET /api/v1/assistant/status` and the `system.status` tool

The route and the tool return the same JSON. The tool's payload is exactly this object.

```json
{
  "chat_model":     {"configured": true,  "model": "qwen3-8-flash-next"},
  "speech_model":   {"configured": true,  "model": "qwen3-asr-1-7b", "endpoint_host": "llm-collective.e-gineering.com", "key_set": true},
  "decision_model": {"configured": false, "model": ""},
  "workers":        {"online": 1, "sandbox_mode": "required"},
  "execution_mode": "inprocess",
  "github_credentials": [{"name": "GITHUB_TOKEN", "scope": "org", "used_by": 0}],
  "projects":       {"count": 0},
  "workflows":      {"count": 3, "samples": 2, "assigned": 0}
}
```

- `model` is the configured model id, or "" when not configured. Keys and URLs with credentials never appear; `endpoint_host` is the host only.
- `sandbox_mode` is the online workers' reported mode (`required` | `optional` | `off` | `unknown`). If workers disagree, the weakest one wins.
- `github_credentials` lists the secrets the caller can see (org scope plus the caller's projects) whose purpose is a git/GitHub credential. Each row has the name (slug), scope, and how many repositories use it. Values are never included.
- `workflows.samples` counts pipelines installed as samples. `assigned` counts pipelines with at least one project assignment.

## 2. Page context (§3)

`AssistantMessagePost.context` gains an optional `page` object:

```json
"context": {
  "route": "/runs/9c1e…",
  "project_id": "…",
  "entity": {"kind": "run", "id": "…"},
  "page": {"label": "Run 9c1e", "status": "waiting", "project": "feature-delivery"}
}
```

- The client omits `context` entirely when "Send with my messages" is unchecked.
- The server bounds `label`, `status` and `project` to 80 characters and strips control characters and `<` `>`. They are data, never instructions.
- The server appends this block to the user turn's content (never to the system prompt), followed by the handoff's guidance text verbatim:

```
<page_context observational="true">
page: Run 9c1e · status waiting
project: feature-delivery
route: /runs/9c1e…
</page_context>
```

  Lines whose value is empty are left out. `route` is the allowlist-cleaned route.
- **Assumed line.** The guidance also tells the model that if it used the page, its reply must end with one line `Assumed: <item>` (for example `Assumed: run 9c1e` or `Assumed: the Today page`). The server strips that line from the answer markdown and stores it as `payload.assumed` on the `assistant` row (bounded to 80 characters). The UI renders "assumed you meant {assumed} (on screen)".

## 3. Decision model (§4)

- Config: `COMMUNICATION_DECISION_BASE_URL`, `COMMUNICATION_DECISION_API_KEY` or `COMMUNICATION_DECISION_API_KEY_FILE`, `COMMUNICATION_DECISION_MODEL`, and `COMMUNICATION_DECISION_TIMEOUT` (default 4s). The judge counts as configured when the base URL and model are set.
- Endpoint (provisional, recorded in the ADR because §4 leaves the shape open): an OpenAI-compatible `POST {base}/chat/completions` with `temperature: 0`. A fixed system prompt is followed by one user message holding this JSON:
  `{"tool": "...", "class": "read|navigate|draft_edit|risky", "args": {...bounded...}, "role": "owner|maintainer|member|viewer", "page": "<page line or empty>"}`.
  The reply's first JSON object must be `{"decision": "allow"|"ask", "reason": "<one line>"}`. Anything else counts as down.
- Gate per trust level:
  - `ask_all`: unchanged. Draft edits and risky calls ask, and the judge is not consulted.
  - `ask_risky` with no judge: the fixed table decides (unchanged).
  - `ask_risky` with a judge: every call is judged.
    - `allow` runs the call.
    - `ask` gates it with the judge's reason.
    - `approval.decide` and `permission.allow` always gate, whatever the judge says.
    - If the judge is down, slow, or replies malformed, risky and draft-edit calls gate with the reason "The decision model didn't answer, so this waits for you." Reads and navigation fall back to the fixed table and run, so a dead judge never blocks the assistant from looking things up.
  - `no_ask`: everything runs, and the judge is not consulted.
- The approval row's payload gains `reason` (shown as "Why it asks"):
  - the judge's reason;
  - "Creates real state." under the fixed table;
  - "Your level asks before every change." under `ask_all`;
  - "Approving a gate always asks." / "Granting a permission always asks." for the always-ask set.
- Each `tool_calls[]` entry gains `judge`: `"allowed"` | `"asked"` | `"unavailable"` | absent (not consulted).

## 4. Speech (§5): `POST /api/v1/assistant/transcriptions`

- multipart/form-data with field `file` (audio/webm, audio/ogg, audio/wav or audio/mp4), at most 10 MiB. It returns `{"text": "..."}`.
- The server forwards the file to `{COMMUNICATION_SPEECH_BASE_URL}/audio/transcriptions` with `model=COMMUNICATION_SPEECH_MODEL` and the key as a Bearer token. Audio is never written to disk or the database, and the request body is dropped after forwarding.
- When speech is not configured, it returns 503 `{"code": "speech_not_configured"}`. If upstream fails or times out (30s), it returns 502 `{"code": "speech_unavailable"}`. The client falls back to Web Speech when the `speech.browser_fallback` pref is true.
- `AssistantMessagePost` gains `spoken: boolean`, and the `user` row payload carries `spoken: true`.
- Prefs (user_preferences.assistant): `speech_auto_send` (default false) and `speech_browser_fallback` (default true).

## 5. Tools (§6)

| Tool | Class | Args | Payload / effect |
|---|---|---|---|
| `credential.list` | read | — | `[{name, kind, scope, used_by:[project slugs]}]`, never values |
| `docs.search` | read | `query` | `[{title, path, excerpt}]` from the embedded curated how-to set (`internal/assistant/howto/*.md`) |
| `workflow.list` | read | — | `[{id, slug, name, latest_revision, sample, assigned_to:[project slugs]}]` |
| `workflow.inspect` | read | `pipeline_id` | the pipeline, its revisions and assignments |
| `repo.check` | read | `url`, optional `credential` | `{repo, reachable, default_branch, can_push, credential}`. The server calls only the GitHub API, with the credential resolved server-side. |
| `issue.list` | read | `project_id`, `repository_id` | the existing ADR-0031 listing |
| `profile.list` | read | — | agent profiles the caller can see |
| `schedule.list` | read | `project_id` | the project's schedules |
| `project.create` | risky | `name`, optional `repo_url`, `credential`, `default_branch` | creates the project; with `repo_url`, also adds the repo bound to the credential, in one confirm. Change kind `project_create`. |
| `repo.add` | risky | `project_id`, `repo_url`, `credential`, optional `default_branch` | change kind `repo_add` |
| `assignment.set` | risky | `project_id`, `pipeline_id` | pins the latest published revision. The approval summary names the revision (the promotion preview). Change kind `assignment_set`. |
| `run.cancel` | risky | `run_id` | change kind `run_cancel` |
| `schedule.create` | risky | `project_id`, `pipeline_id`, `cron` | change kind `schedule_create` |

- **The proposal card** is the approval card for `project.create` / `repo.add`. It renders rows from the approval args: Project (`name` + "(new)"), Repository (`repo_url` @ `default_branch`), Credential, Workflow ("none yet"), and Why it asks (`reason`).
- `credential.create` is never registered. A "how do I add a token" answer links to `/settings/secrets` (or the project's secrets page).
