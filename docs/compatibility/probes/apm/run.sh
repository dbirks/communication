#!/usr/bin/env bash
# M0 APM staging spike: reproducibility, isolation and HOME-write probe.
# See ../README.md (docs/compatibility/probes/apm/README.md).
#
# Prerequisite: apm v0.33.0 installed at $HOME/.local/bin/apm (see README).
set -euo pipefail

APM_BIN="${APM_BIN:-$HOME/.local/bin/apm}"
LAB="$HOME/.cache/communication-lab/m0-apm"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/fixtures" && pwd)"
WORK="$LAB/work"
FAKEHOME="$LAB/fakehome"
LOGS="$LAB/logs"

check() { printf 'CHECK %s %s %s %s\n' "$1" "$2" "$3" "$4"; }

if [ ! -x "$APM_BIN" ]; then
  check ALL T0 FAIL "apm binary not found at $APM_BIN; install per README before rerunning"
  exit 1
fi

echo "== apm version =="
"$APM_BIN" --version

mkdir -p "$LOGS"

for TARGET in claude codex; do
  # Fresh workspace + fresh fake HOME per target so every observation is isolated.
  rm -rf "$WORK" "$FAKEHOME"
  mkdir -p "$WORK" "$FAKEHOME"
  cp -a "$SRC/." "$WORK/"

  run_apm() { # run_apm <dir> <args...> — apm with isolated HOME
    local dir="$1"; shift
    ( cd "$WORK/$dir" && HOME="$FAKEHOME" "$APM_BIN" "$@" )
  }

  # ---------- T1: install consumer-a, diff the project tree ----------
  before=$(cd "$WORK/consumer-a" && find . | sort)
  if ! run_apm consumer-a install --target "$TARGET" >"$LOGS/$TARGET-t1.log" 2>&1; then
    check "$TARGET" T1 FAIL "apm install failed, see $LOGS/$TARGET-t1.log"
    continue
  fi
  after=$(cd "$WORK/consumer-a" && find . | sort)
  created=$(comm -13 <(echo "$before") <(echo "$after") | grep -v '^\.$' || true)
  if [ -n "$created" ]; then
    check "$TARGET" T1 PASS "install ok; files created under consumer-a:"
    echo "$created" | sed 's|^|    |'
  else
    check "$TARGET" T1 FAIL "install succeeded but created no files in the project"
  fi

  # ---------- T2: delete generated files, reinstall with --frozen ----------
  sums1=$(cd "$WORK/consumer-a" && find . -type f ! -name apm.yml -exec sha256sum {} + | sort -k2)
  ( cd "$WORK/consumer-a" && find . -mindepth 1 -maxdepth 1 ! -name apm.yml ! -name apm.lock.yaml -exec rm -rf {} + )
  if ! run_apm consumer-a install --frozen --target "$TARGET" >"$LOGS/$TARGET-t2.log" 2>&1; then
    check "$TARGET" T2 FAIL "frozen reinstall failed, see $LOGS/$TARGET-t2.log"
  else
    sums2=$(cd "$WORK/consumer-a" && find . -type f ! -name apm.yml -exec sha256sum {} + | sort -k2)
    if [ "$sums1" = "$sums2" ]; then
      check "$TARGET" T2 PASS "frozen reinstall reproduced lockfile + all generated files byte-identically ($(echo "$sums1" | wc -l) files incl. apm.lock.yaml)"
    else
      check "$TARGET" T2 FAIL "digest drift after frozen reinstall:"
      diff <(echo "$sums1") <(echo "$sums2") | sed 's|^|    |' || true
    fi
  fi

  # ---------- T3: isolation — consumer-b gets only pkg-beta content ----------
  run_apm consumer-b install --target "$TARGET" >"$LOGS/$TARGET-t3.log" 2>&1
  leak_a=$(grep -rl 'ALPHA-MARKER' "$WORK/consumer-b" 2>/dev/null || true)
  leak_b=$(grep -rl 'BETA-MARKER' "$WORK/consumer-a" 2>/dev/null || true)
  if [ -z "$leak_a" ] && [ -z "$leak_b" ]; then
    check "$TARGET" T3 PASS "no ALPHA-MARKER under consumer-b and no BETA-MARKER under consumer-a"
  else
    check "$TARGET" T3 FAIL "cross-dependency leakage: ALPHA in [${leak_a:-none}] BETA in [${leak_b:-none}]"
  fi

  # ---------- T4: writes outside the staging dir (into fake HOME) ----------
  home_files=$(cd "$FAKEHOME" && find . -type f | sort || true)
  if [ -z "$home_files" ]; then
    check "$TARGET" T4 PASS "APM wrote no files into isolated HOME"
  else
    check "$TARGET" T4 FAIL "APM wrote into HOME (shared HOME would leak between sessions); paths:"
    echo "$home_files" | sed 's|^|    |'
    ( cd "$FAKEHOME" && sha256sum $home_files ) | sed 's|^|    |'
  fi

  # ---------- T5: lock digest (value Communication stores as apm_lock_digest) ----------
  digest=$(cd "$WORK/consumer-a" && sha256sum apm.lock.yaml | awk '{print $1}')
  check "$TARGET" T5 PASS "apm_lock_digest(sha256 of consumer-a/apm.lock.yaml)=$digest"

  # ---------- T6: does the real harness see the staged skill? ----------
  marker=ALPHA-MARKER; cli=""; args=()
  if [ "$TARGET" = claude ]; then
    cli=claude; args=(-p "List the names of any skills or instructions available to you that mention $marker. Reply NONE if there are none.")
  elif [ "$TARGET" = codex ]; then
    cli=codex; args=(exec --skip-git-repo-check "List the names of any skills or instructions available to you that mention $marker. Reply NONE if there are none.")
  fi
  if command -v "$cli" >/dev/null 2>&1; then
    if ( cd "$WORK/consumer-a" && timeout 240 "$cli" "${args[@]}" ) >"$LOGS/$TARGET-t6.log" 2>&1; then
      if grep -qi 'alpha-skill' "$LOGS/$TARGET-t6.log"; then
        check "$TARGET" T6 PASS "$cli reported alpha-skill; see $LOGS/$TARGET-t6.log"
      else
        check "$TARGET" T6 FAIL "$cli ran but did not report alpha-skill; tail: $(tail -c 200 "$LOGS/$TARGET-t6.log" | tr '\n' ' ')"
      fi
    else
      check "$TARGET" T6 GAP "$cli invocation failed/timed out; see $LOGS/$TARGET-t6.log"
    fi
  else
    check "$TARGET" T6 GAP "$cli CLI not installed on probe host"
  fi
done

echo "== done =="
