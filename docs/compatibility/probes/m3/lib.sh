# m3 probe library — shared fixture/report helpers. SOURCED, not executed.
#
# Contract of every probe in this directory:
#   * prints an ENV header, then one `CHECK <id> <PASS|FAIL|GAP> <observed>`
#     line per claim (plus `NOTE <id> <observed>` for informational captures);
#   * verdicts are only ever PASS / FAIL / GAP / N/A, and PASS requires an
#     observed literal, never an inference (AGENTS.md, 12-test-strategy.md);
#   * the script exits 0 unless the probe itself could not run;
#   * fixtures live under $HOME/.cache/communication-lab/m3-probes/ only.
#
# Required env from the caller: M3_PROBE (short probe name).
# Recognised flags: --nono <path> --fixture <dir> --keep
#
# M3_DIR is set by the caller (each probe cds to its own directory).

M3_NONO="${M3_NONO:-$HOME/.local/bin/nono}"
M3_NODE="${M3_NODE:-node}"
M3_KEEP=0
M3_PROBE_ROOT_BASE="${M3_PROBE_ROOT_BASE:-$HOME/.cache/communication-lab/m3-probes}"

# Keep m3_oneline's length bound character-based. Under a POSIX locale `cut -c`
# counts BYTES and can split a UTF-8 sequence — observed in communication-worker:dev,
# whose default locale is POSIX while nono's banner carries box-drawing characters;
# the split byte landed in the results file and made it non-text.
case "${LC_ALL:-${LANG:-}}" in
    *utf8*|*UTF-8*|*Utf8*|*utf-8*) ;;
    *)
        _m3_locale="$(locale -a 2>/dev/null | grep -iE '^C\.utf-?8$' | head -1)"
        [ -n "$_m3_locale" ] && export LC_ALL="$_m3_locale"
        ;;
esac
if command -v iconv >/dev/null 2>&1; then M3_SANITIZE=iconv; else M3_SANITIZE=cat; fi
export M3_SANITIZE

m3_args() {
    while [ $# -gt 0 ]; do
        case "$1" in
            --nono)    M3_NONO="$2"; shift 2 ;;
            --fixture) M3_FIXTURE_ARG="$2"; shift 2 ;;
            --node)    M3_NODE="$2"; shift 2 ;;
            --keep)    M3_KEEP=1; shift ;;
            *) echo "m3 lib: unknown argument: $1" >&2; exit 2 ;;
        esac
    done
}

m3_oneline() {
    # `cut -c` is byte-based in practice on this pair (coreutils 9.1 / mawk, observed
    # in communication-worker:dev), which can split a UTF-8 sequence and write an
    # invalid byte into the results file; `iconv -c` drops the split tail. iconv
    # exits 1 when it drops anything, so the status is normalised here.
    local _out=""
    if [ "${M3_SANITIZE:-cat}" = iconv ]; then
        _out="$(tr '\n\r\t' '   ' | sed 's/  */ /g' | cut -c1-400 | iconv -f UTF-8 -t UTF-8 -c 2>/dev/null)"
    else
        _out="$(tr '\n\r\t' '   ' | sed 's/  */ /g' | cut -c1-400)"
    fi
    printf '%s' "$_out"
    return 0
}

# check <id> <PASS|FAIL|GAP|N/A> <observation...>
check() { printf 'CHECK %s %s %s\n' "$1" "$2" "$(printf '%s' "$3" | m3_oneline)"; }
# note <id> <observation...>
note() { printf 'NOTE %s %s\n' "$1" "$(printf '%s' "$2" | m3_oneline)"; }

# Deterministic lab identity only — never touches the user's global git config.
m3_git_identity() {
    export GIT_CONFIG_COUNT=2
    export GIT_CONFIG_KEY_0=user.name  GIT_CONFIG_VALUE_0=communication-lab
    export GIT_CONFIG_KEY_1=user.email GIT_CONFIG_VALUE_1=lab@communication.invalid
    export GIT_TERMINAL_PROMPT=0
    export GIT_ADVICE=0
}

# A sandboxed child must not inherit the probe's git identity env (ADR-0019
# Decision 1: the launch Env is built from scratch); probes that want a clean
# env call m3_sb / m3_run with env -i, which strips these anyway.
m3_clean_env() { printf 'PATH=%s\nHOME=%s\n' "${PATH:-/usr/bin:/bin}" "$1"; }

m3_env_header() {
    local lsm='unreadable'
    [ -r /sys/kernel/security/lsm ] && lsm="$(cat /sys/kernel/security/lsm 2>/dev/null || echo unreadable)"
    echo "== m3 probe: ${M3_PROBE}"
    echo "ENV date=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "ENV user=$(id -un 2>/dev/null || echo '?') uid=$(id -u) gid=$(id -g)"
    echo "ENV kernel=$(uname -r) machine=$(uname -m)"
    echo "ENV locale=${LC_ALL:-${LANG:-unset}} (cut -c in m3_oneline is byte-based under POSIX)"
    echo "ENV lsm=${lsm}"
    echo "ENV git=$(git --version 2>&1 | m3_oneline)"
    echo "ENV nono_bin=${M3_NONO}"
    if [ -x "${M3_NONO}" ]; then
        echo "ENV nono_version=$("${M3_NONO}" --version 2>&1 | m3_oneline)"
        echo "ENV nono_sha256=$(sha256sum "${M3_NONO}" 2>/dev/null | awk '{print $1}')"
    else
        echo "ENV nono_version=MISSING"
    fi
    if command -v "${M3_NODE}" >/dev/null 2>&1; then
        echo "ENV node=$("${M3_NODE}" --version 2>&1 | m3_oneline)"
    else
        echo "ENV node=MISSING"
    fi
    echo "ENV curl=$(command -v curl >/dev/null 2>&1 && curl --version 2>/dev/null | head -1 | m3_oneline || echo no)"
    echo "ENV fixture=${M3_FIXTURE}"
    echo
}

# ---- fixture builders -------------------------------------------------------
# Seed origin + per-project mirror + one linked worktree per scope, exactly the
# ADR-0017 Decision 1/4 layout.
m3_seed_origin() { # m3_seed_origin <name> [extra-file...]
    local name="$1" d="${M3_FIXTURE}/.seed/$1"
    mkdir -p "$d"
    git init -q -b main "$d"
    printf '# %s\nM3 probe seed.\n' "$name" > "$d/README.md"
    printf '%s line one\n' "$name" > "$d/app.txt"
    [ -f "$d/tests.txt" ] || printf 'tests for %s\n' "$name" > "$d/tests.txt"
    git -C "$d" add -A
    git -C "$d" commit -qm "seed $name"
    git clone --bare -q "$d" "${M3_FIXTURE}/origins/$name.git"
}

m3_mirror() { printf '%s/repos/%s/%s.git' "$M3_FIXTURE" "$1" "$2"; }   # <project> <repo>
m3_ws()    { printf '%s/workspaces/%s/%s' "$M3_FIXTURE" "$1" "$2"; }   # <scope> <id>

m3_make_mirror() { # m3_make_mirror <project> <repo...>
    local proj="$1"; shift
    local name
    for name in "$@"; do
        mkdir -p "$(dirname "$(m3_mirror "$proj" "$name")")"
        git clone --mirror -q "${M3_FIXTURE}/origins/$name.git" "$(m3_mirror "$proj" "$name")"
    done
}

# m3_add_worktree <scope> <scope-id> <project> <repo> — creates the 05 layout
# dirs (repos/ scratch/ meta/ home/) and a worktree on branch <scope-id>/<repo>.
m3_add_worktree() {
    local kind="$1" id="$2" proj="$3" name="$4" dir
    dir="$(m3_ws "$kind" "$id")"
    mkdir -p "$dir/repos" "$dir/scratch" "$dir/meta" "$dir/home"
    chmod 700 "$dir/home"
    m3_seed_homegitconfig "$dir/home"
    git --git-dir="$(m3_mirror "$proj" "$name")" worktree add -q -b "$id/$name" "$dir/repos/$name" main
}

m3_seed_homegitconfig() {
    printf '[user]\n\tname = communication-lab\n\temail = lab@communication.invalid\n' > "$1/.gitconfig"
    chmod 600 "$1/.gitconfig"
}

# The administrative directory git actually used for a worktree — the ONLY
# correct way to know it (P1: git auto-suffixes on basename collision).
m3_admin_dir() { git -C "$1" rev-parse --absolute-git-dir; }

m3_cleanup() {
    if [ "${M3_KEEP}" = 0 ]; then
        rm -rf "${M3_FIXTURE}"
    fi
    return 0
}

# ---- sandbox runners --------------------------------------------------------
# m3_sb <nono args…> — execs nono with cwd=$M3_SB_CWD and a from-scratch child
# env (PATH + HOME=$M3_SB_HOME), mirroring ADR-0019 Decision 1's built Env.
# Result in globals M3_RC / M3_OUT (single line).
m3_sb() {
    local _h="${M3_SB_HOME:-$M3_FIXTURE}" _c="${M3_SB_CWD:-$M3_FIXTURE}"
    local _r=0 _o=""
    _o="$(cd "$_c" && env -i PATH="${_M3_PATH:-$PATH}" HOME="$_h" "$M3_NONO" run -s "$@" 2>&1)" || _r=$?
    M3_RC=$_r
    M3_OUT="$(printf '%s' "$_o" | m3_oneline)"
}

# m3_unsandboxed <cmd…> — same clean env, same cwd, no nono (control arm).
m3_unsandboxed() {
    local _h="${M3_SB_HOME:-$M3_FIXTURE}" _c="${M3_SB_CWD:-$M3_FIXTURE}"
    local _r=0 _o=""
    _o="$(cd "$_c" && env -i PATH="${_M3_PATH:-$PATH}" HOME="$_h" "$@" 2>&1)" || _r=$?
    M3_RC=$_r
    M3_OUT="$(printf '%s' "$_o" | m3_oneline)"
}

# Denied/read verdict helper: used by read-denial style checks.
m3_denied() { # m3_denied <id> <rc> <out> — expect a non-zero denial
    if printf '%s' "$2" | grep -qi 'Sandbox initialization failed\|Landlock\|not supported'; then
        check "$1" GAP "nono refused to start: $3"
    elif [ "$2" -ne 0 ] && printf '%s' "$3" | grep -qi 'permission denied\|operation not permitted\|read-only file system'; then
        check "$1" PASS "exit=$2 $3"
    elif [ "$2" -ne 0 ]; then
        check "$1" PASS "exit=$2 (non-zero, content not returned) $3"
    else
        check "$1" FAIL "exit=0 content readable: $3"
    fi
}
