#!/usr/bin/env bash
# loop.sh — the "play the user" loop driver.
#
#   e2e/emulator/loop.sh [--max-passes N] [--no-reset]
#
# For each pass:
#   1. (unless --no-reset) rebuild the lab with $LAB_RESET_CMD — required,
#      set by the orchestrator, since only the orchestrator knows how the
#      lab was built;
#   2. run the emulator suite with EMU_PASS_ID=pass-<n>-<timestamp>;
#   3. render the report (out/<pass>/index.html);
#   4. file new defects as GitHub issues (skipped when EMU_DRY_RUN=1);
#   5. count the pass's defects.
#
# The loop stops with exit 0 after TWO CONSECUTIVE clean passes, or with
# exit 1 after --max-passes (default 6) passes without that. One summary
# line is printed per pass.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
cd "$REPO_ROOT"

MAX_PASSES=6
NO_RESET=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --max-passes)
      [[ -n "${2:-}" ]] || { echo "loop: --max-passes needs a number" >&2; exit 2; }
      MAX_PASSES="$2"; shift 2 ;;
    --no-reset) NO_RESET=1; shift ;;
    *) echo "loop: unknown argument: $1" >&2; exit 2 ;;
  esac
done

clean_streak=0
for n in $(seq 1 "$MAX_PASSES"); do
  if [[ "$NO_RESET" -eq 0 ]]; then
    : "${LAB_RESET_CMD:?loop: LAB_RESET_CMD is required unless --no-reset (the orchestrator sets it)}"
    echo "pass $n: rebuilding the lab ($LAB_RESET_CMD)"
    eval "$LAB_RESET_CMD"
  fi

  pass_id="pass-$n-$(date -u +%Y%m%d%H%M%S)"
  out_dir="e2e/emulator/out/$pass_id"
  results="$out_dir/results.json"

  # Which GitHub budget this pass plays on. Only the variable's PRESENCE is
  # reported — the token file's contents are never read here, never echoed and
  # never an argv word (e2e/emulator/github-read-credential.ts reads it into a
  # secret's create body, and nothing else). acceptance.yml's verification job
  # writes it; unset means the anonymous 60/hour read (local runs).
  if [[ -n "${E2E_GITHUB_READ_TOKEN_FILE:-}" ]]; then
    echo "pass $n: server reads GitHub AUTHENTICATED (E2E_GITHUB_READ_TOKEN_FILE is set)"
  else
    echo "pass $n: server reads GitHub anonymously (E2E_GITHUB_READ_TOKEN_FILE is unset)"
  fi

  # The suite records defects even when a journey fails (fixtures.ts: the
  # `emu` recorder files kind=assertion for journeys using it, and the auto
  # `emuOutcome` fixture files one for EVERY test built on it), so the exit
  # code is normally not the pass's verdict — the defect count is. The exit
  # code is the BACKSTOP below: a non-zero exit whose results.json carries no
  # defect at all means the failure escaped the recording fixtures (worker
  # crash, config/load error, a raw @playwright/test import), and such a
  # pass is NEVER clean — a synthetic defect is appended so it counts dirty
  # and gets filed (acceptance 42535038297: a failed test recorded nothing
  # and the loop printed "0 defects, clean streak 1/2" over a red suite).
  # The step environment reaches the spec process through this line unchanged:
  # pnpm exec inherits the shell's exported env and Playwright's workers
  # inherit theirs, so E2E_GITHUB_READ_TOKEN_FILE (and any other knob) is
  # visible to the specs without being named in an argv word.
  rc=0
  EMU_PASS_ID="$pass_id" pnpm --dir e2e exec playwright test -c emulator/playwright.config.ts \
    || rc=$?
  if [[ "$rc" -ne 0 ]]; then
    echo "pass $n: suite exited non-zero with code $rc (journey failure is recorded as an assertion defect)" >&2
  fi

  recorded_defects=$(grep -c '"type":"defect"' "$results" 2>/dev/null) || recorded_defects="${recorded_defects:-0}"
  if [[ "$rc" -ne 0 && "$recorded_defects" -eq 0 ]]; then
    mkdir -p "$out_dir"
    node -e '
      const fs = require("node:fs");
      const crypto = require("node:crypto");
      const [file, passId, code] = process.argv.slice(1);
      const kind = "assertion";
      const journey = "suite";
      const screen = "(no defect recorded)";
      const detail = `assertion: suite exited ${code} with no defect recorded — see the job log`;
      // Same normalisation as fixtures.ts fingerprintOf, so the synthetic
      // defect files ONE issue across passes like any recorded one.
      const normalised = detail
        .toLowerCase()
        .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<uuid>")
        .replace(/0x[0-9a-f]{6,}/g, "<hex>")
        .replace(/localhost:\d+/g, "<host>")
        .replace(/\b\d+(?:\.\d+)?\b/g, "<n>");
      const fingerprint = crypto
        .createHash("sha256")
        .update(`${kind}|${journey}|${screen}|${normalised}`)
        .digest("hex")
        .slice(0, 16);
      const line = JSON.stringify({
        type: "defect", pass: passId, kind, journey, screen,
        viewport: "(suite level)", detail, fingerprint, screenshot: null,
      });
      fs.appendFileSync(file, `${line}\n`);
    ' "$results" "$pass_id" "$rc" || echo "pass $n: WARNING — could not append the synthetic defect" >&2
    echo "pass $n: suite exited $rc with no defect recorded — appended a synthetic defect" >&2
  fi

  node e2e/emulator/report.mjs "$out_dir" > "$out_dir/report.log" 2>&1 \
    || cat "$out_dir/report.log" >&2

  if [[ "${EMU_DRY_RUN:-}" != "1" ]]; then
    node e2e/emulator/file-issues.mjs "$out_dir" || echo "pass $n: WARNING — file-issues failed" >&2
  else
    node e2e/emulator/file-issues.mjs --dry-run "$out_dir" > "$out_dir/file-issues.log" 2>&1
  fi

  defects=$(grep -c '"type":"defect"' "$results" 2>/dev/null) || defects="${defects:-0}"
  screens=$(grep -c '"type":"screen"' "$results" 2>/dev/null) || screens="${screens:-0}"

  if [[ "$defects" -eq 0 ]]; then
    clean_streak=$((clean_streak + 1))
  else
    clean_streak=0
  fi
  echo "PASS $pass_id: $screens screens, $defects defects, clean streak $clean_streak/2"

  if [[ "$clean_streak" -ge 2 ]]; then
    echo "loop: two consecutive clean passes — the product plays clean."
    exit 0
  fi
done

echo "loop: $MAX_PASSES passes without two consecutive clean — stopping with failures open."
exit 1
