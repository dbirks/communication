#!/usr/bin/env bash
# test_leave_dirty.sh — offline proof that the twin's OPT-IN leave_dirty input does
# not move the default fixture's output by a single byte (docs/m4-contract.md § 7.1
# C6d; docs/compatibility/probes/m4/README.md note 5a).
#
# cefe995's rule for every opt-in twin input: the default MUST keep every existing
# output byte-identical. hold_seconds proved that for the sleep; this proves it for
# leave_dirty. It exercises the REAL generated m4-exit.sh (from
# e2e/m4/make_fixture_repo.sh) — not a re-typed copy — so it fails if the generator
# ever writes an extra byte on the default path.
#
# It is a fixture-shape proof, not the live C6d refusal (12-test-strategy.md: a
# mocked green is not done); the live arm is c6d_dirty_arm in e2e_m4_exit.py.
#
#   usage: bash e2e/m4/test_leave_dirty.sh      (exit 0 = default unchanged + opt-in
#                                                leaves exactly one uncommitted file)
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# Generate the fixture (bare repo + OUT_DIR/bin/m4-exit.sh) into a scratch dir.
bash "$HERE/make_fixture_repo.sh" "$TMP/out" >/dev/null
HELP="$TMP/out/bin/m4-exit.sh"
[ -x "$HELP" ] || { echo "FAIL: make_fixture_repo.sh did not generate an executable m4-exit.sh" >&2; exit 1; }

# A scratch checkout holding exactly the two files m4-exit.sh's in_app() requires.
mkapp() {
    rm -rf "$TMP/app"; mkdir -p "$TMP/app/tests"
    printf 'def add(a, b):\n    return a + b\n' > "$TMP/app/hello.py"
    printf 'import hello\ndef test_add_is_documented():\n    assert hello.add.__doc__\ndef test_add_sums():\n    assert hello.add(1, 2) == 99\n' > "$TMP/app/tests/test_hello.py"
}

fail=0
note() { echo "FAIL: $*" >&2; fail=1; }

# 1. DEFAULT (leave_dirty unset): the two implement iterations emit EXACTLY the
#    shipped stdout, byte for byte, and write NO uncommitted file.
mkapp
( cd "$TMP/app"
  out1="$(bash "$HELP" implement 2>/dev/null)"
  out2="$(bash "$HELP" implement 2>/dev/null)"
  want1='{"summary": "added the add() docstring (iteration 1; the add(1,2) assertion stays red until corrected)", "files_changed": ["hello.py"]}'
  want2='{"summary": "corrected the add(1, 2) assertion to true sum semantics; pytest should be green now", "files_changed": ["tests/test_hello.py"]}'
  [ "$out1" = "$want1" ] || note "default iteration-1 implement stdout changed: got [$out1]"
  [ "$out2" = "$want2" ] || note "default iteration-2 implement stdout changed: got [$out2]"
  [ ! -e m4-leave-dirty.txt ] || note "default path wrote m4-leave-dirty.txt (the tree must stay byte-identical/clean)"
) || fail=1

# 2. leave_dirty=0 / empty / false are ALL the default: still no extra file.
for v in 0 "" false False; do
    mkapp
    ( cd "$TMP/app"; M4_LEAVE_DIRTY="$v" bash "$HELP" implement >/dev/null 2>&1
      [ ! -e m4-leave-dirty.txt ] || note "M4_LEAVE_DIRTY=[$v] wrote m4-leave-dirty.txt: only a truthy value may" )
done

# 3. leave_dirty truthy: the SAME stdout, PLUS exactly one uncommitted file.
mkapp
( cd "$TMP/app"
  dirty_out="$(M4_LEAVE_DIRTY=1 bash "$HELP" implement 2>/dev/null)"
  want1='{"summary": "added the add() docstring (iteration 1; the add(1,2) assertion stays red until corrected)", "files_changed": ["hello.py"]}'
  [ "$dirty_out" = "$want1" ] || note "leave_dirty=1 CHANGED implement stdout (it must add a file, not a byte to stdout): [$dirty_out]"
  [ -e m4-leave-dirty.txt ] || note "leave_dirty=1 wrote NO m4-leave-dirty.txt — C6d's dirty-boundary arm needs the uncommitted file"
) || fail=1

# 4. leave_dirty is implement-ONLY: plan/test/review ignore it (README note 5a).
mkapp
( cd "$TMP/app"
  M4_LEAVE_DIRTY=1 bash "$HELP" plan >/dev/null 2>&1
  M4_LEAVE_DIRTY=1 bash "$HELP" review >/dev/null 2>&1
  [ ! -e m4-leave-dirty.txt ] || note "leave_dirty leaked onto plan/review — it must gate implement only"
) || fail=1

# 5. The twin pipeline declares the input with default false (the opt-in contract).
PIPE="$REPO_ROOT/docs/compatibility/probes/m4/pipeline.yaml"
grep -q "leave_dirty:" "$PIPE" || note "pipeline.yaml does not declare inputs.leave_dirty"
grep -q "M4_LEAVE_DIRTY" "$PIPE" || note "pipeline.yaml does not wire M4_LEAVE_DIRTY to the implement node"

if [ "$fail" -eq 0 ]; then echo "test_leave_dirty.sh: default fixture output byte-identical, leave_dirty opt-in produces exactly one uncommitted file (implement-only)"; exit 0; fi
exit 1
