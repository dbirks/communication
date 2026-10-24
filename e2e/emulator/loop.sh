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

  # The suite records defects even when a journey fails; its exit code is
  # not the pass's verdict — the defect count is.
  EMU_PASS_ID="$pass_id" pnpm --dir e2e exec playwright test -c emulator/playwright.config.ts \
    || echo "pass $n: suite exited non-zero (journey failure is recorded as an assertion defect)" >&2

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
