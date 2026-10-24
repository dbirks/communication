# e2e/emulator — the "play the user" loop

The product must be proven by a scripted loop that plays a real user in a
real browser against a freshly built lab, screen by screen, until **two
consecutive passes come back clean**. This directory is the harness;
journeys are added as screens land.

## What a pass does

1. `setup.spec.ts` (setup project) signs the lab's identities in through
   the mock IdP once and saves the browser storage states
   (`admin.json`, `alice.json`) into the pass output directory.
2. The journeys (`journeys.spec.ts`) play the screens against the lab
   (`http://localhost:18091` — `localhost`, not `127.0.0.1`: the session
   cookie is set for `localhost`). Every screen goes through
   `emu.screen(badge, name)`, which captures the page at **1280×900 and
   390×844** and records it against the design render
   `docs/design/handoff-workflows/png/<badge>.png` (Projects Review
   badges will come under `docs/design/handoff-projects/png/`).
3. The `emu` fixture (fixtures.ts) records, per page:
   - `pageerror` events and `console.error` messages (URL + text);
   - every `/api/` response with status ≥ 400 (method, path, status) and
     every `requestfailed` — **except** ones a journey declared expected
     via `emu.expectFailure(/regex/, status)` (e.g. a deliberate 409/422
     shown inline);
   - a **sideways scroll** at either viewport — `document.documentElement.scrollWidth <= innerWidth`
     is asserted, but a violation is *recorded* (the screenshot still
     proves the screen), not thrown;
   - a failing journey's own error, as `kind: assertion` — a journey that
     hits a missing design element is a real defect, recorded, and the
     journey FAILS with a clear message. Journeys are written against the
     design, never around the old UI.
4. At each test's end, one JSON object per screen and per defect is
   **appended** to `out/<passId>/results.json` (append-safe JSON lines).
   Defects carry `{kind, journey, screen, viewport, detail, fingerprint,
   screenshot}`; the fingerprint is a stable hash of kind + journey +
   screen + normalised detail (uuids and numbers stripped), so the same
   defect files one issue across passes.
5. `report.mjs` renders `out/<passId>/index.html` — defects on top, then
   one row per screen with the app screenshot beside its design render
   (both at 50%) — and prints `PASS <id>: <n> screens, <m> defects`
   (exit 0 when clean, 1 otherwise).
6. `file-issues.mjs` files each not-yet-filed fingerprint as a GitHub
   issue in `dbirks/communication` (label `emulator`, body carries
   journey, screen, viewport, detail, `fingerprint: <fp>` and the
   screenshot path; open AND closed issues are searched). It never puts
   cookies, tokens or env values in an issue.

## Run one pass

```bash
docker compose -p communication-m4 -f compose.yml up -d --build   # or the orchestrator's reset
EMU_PASS_ID=pass-1-$(date +%s) \
  pnpm --dir e2e exec playwright test -c emulator/playwright.config.ts
node e2e/emulator/report.mjs e2e/emulator/out/pass-1-<ts>
node e2e/emulator/file-issues.mjs --dry-run e2e/emulator/out/pass-1-<ts>   # prints instead of filing
node e2e/emulator/file-issues.mjs e2e/emulator/out/pass-1-<ts>            # files the issues
```

`EMU_PASS_ID` defaults to `emu-p<runner-pid>` (stable across the suite's
worker processes); `EMU_BASE_URL` defaults to `http://localhost:18091`.

## Run the loop

```bash
LAB_RESET_CMD='docker compose -p communication-m4 -f compose.yml up -d --build && ...' \
  e2e/emulator/loop.sh [--max-passes 6] [--no-reset]
```

Each pass rebuilds the lab (`$LAB_RESET_CMD`, required unless
`--no-reset` — the orchestrator sets it), runs the suite, renders the
report and files new issues (skip filing with `EMU_DRY_RUN=1`). The loop
prints one summary line per pass and exits 0 after **two consecutive
clean passes**, or 1 after `--max-passes` (default 6) without that.

## out/ layout

```
e2e/emulator/out/<passId>/
  admin.json            signed-in browser state (admin)
  alice.json            signed-in browser state (alice)
  results.json          one JSON line per screen and per defect
  <badge>-<name>-1280.png   desktop capture
  <badge>-<name>-390.png    phone capture
  index.html            the report (report.mjs)
  report.log, file-issues.log   loop outputs
```

## Defect rules

- A defect is anything the fixture records: `pageerror`, `console`,
  `api`, `sidescroll`, `assertion`. A pass is clean when results.json
  holds zero defect lines.
- Deliberate failures a journey exercises inline are *declared*:
  `emu.expectFailure(/\/api\/v1\/pipelines$/, 409)`. Anything undeclared
  with status ≥ 400 is a defect.
- Filing is fingerprint-deduplicated across open and closed issues; a
  fixed-then-returned defect files a new issue, a recurring one does not.
- Do not run the loop yourself and do not skip/modify journeys to make a
  pass clean — a red journey is the signal.

## Current journeys

- `workflows-index` (admin): `/workflows` → 1b; New workflow dialog → 1c;
  create from the "Plan with approval" template ("Emu plan <passId>") →
  Studio → 1g.
- `thread` (alice — the seeded M4 lab gives the org admin no project
  membership, and a thread starts in a project workspace): `/threads` →
  New thread → send one message → threads-1g.
