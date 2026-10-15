# m4 probe library — shared helpers for the M4 exit probes. SOURCED, not executed.
#
# Contract of every probe in this directory (inherited from probes/m3/lib.sh):
#   * prints an ENV header, then one `CHECK <id> <PASS|FAIL|GAP|SKIP|N/A> <observed>`
#     line per claim (plus `NOTE <id> <observed>` for informational captures);
#   * verdicts are only ever PASS / FAIL / GAP / SKIP / N/A, and PASS requires
#     an observed literal, never an inference (AGENTS.md, 12-test-strategy.md);
#   * SKIP = the precondition (built stack, real Go code) is absent TODAY and
#     is printed honestly, never dressed up as green;
#   * the script exits 0 unless the probe itself could not run.
#
# Isolation (§ 7.0): every docker command goes through M4_COMPOSE — project
# `communication-m4`, its own port block. Never the `communication` project,
# never host ports 18080–18090 or 8080/8081/8090.
#
# Required env from the caller: M4_PROBE (short probe name).

M4_URL="${M4_URL:-http://localhost:18091}"
M4_API_A="${M4_API_A:-http://localhost:18092}"
M4_API_B="${M4_API_B:-http://localhost:18093}"
M4_COLLECTOR="${M4_COLLECTOR:-http://localhost:18099}"
M4_PROBE_ROOT_BASE="${M4_PROBE_ROOT_BASE:-$HOME/.cache/communication-lab/m4-probes}"
M4_COMPOSE=(docker compose -p communication-m4 -f compose.yml -f compose.harness.yml -f compose.m4.yml)
# The compose files are relative to the repository root:
M4_REPO_DIR="${M4_REPO_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)}"

m4_oneline() {
    local _out=""
    _out="$(tr '\n\r\t' '   ' | sed 's/  */ /g' | cut -c1-400)"
    printf '%s' "$_out"
    return 0
}

# check <id> <PASS|FAIL|GAP|SKIP|N/A> <observation...>
check() { printf 'CHECK %s %s %s\n' "$1" "$2" "$(printf '%s' "$3" | m4_oneline)"; }
# note <id> <observation...>
note() { printf 'NOTE %s %s\n' "$1" "$(printf '%s' "$2" | m4_oneline)"; }

# assert <id> <expected> <observed...> — PASS only on an exact observed literal.
m4_assert() {
    local id="$1" want="$2"; shift 2
    local got="$*"
    if [ "$got" = "$want" ]; then check "$id" PASS "observed: $got"; else check "$id" FAIL "want=[$want] got=[$got]"; fi
}

# ---- stack accessors (§ 7.0: lib.sh defines run_sql, api, events_of_run) ----

# run_sql <sql> — READ-ONLY evidence queries via the stack's own postgres.
run_sql() {
    (cd "$M4_REPO_DIR" && "${M4_COMPOSE[@]}" exec -T postgres psql -U communication \
        -d communication -tAqc "$1" 2>&1)
}

# events_of_run <run_id> <type> [type...] — the journal slice for one run.
events_of_run() {
    local run="$1"; shift
    local types; types="$(printf "'%s'," "$@" | sed 's/,$//')"
    run_sql "SELECT global_seq || ' ' || type || ' ' || payload::text FROM domain_events \
             WHERE run_id='$run' AND type IN ($types) ORDER BY global_seq"
}

# Compose passthroughs (scoped by project — never a bare `docker kill`).
m4_compose() { (cd "$M4_REPO_DIR" && "${M4_COMPOSE[@]}" "$@" 2>&1); }
m4_logs()    { m4_compose logs --no-color "$@"; }

# ---- api <user> <METHOD> <path> [json-body] — cookie jar per user -----------
# Logs the user in once through the mock IdP's interactive form (e2e_m3_exit.py
# login()'s curl shape), caches the session + CSRF token under
# $M4_PROBE_ROOT_BASE/jars/, and replays mutations with Origin + X-CSRF-Token.
# Best-effort scaffold: it will be debugged the day a gate runs against a live
# stack; until then nothing calls it (run.sh SKIPs before reaching it).
m4_jar() { printf '%s/jars/%s.jar' "$M4_PROBE_ROOT_BASE" "$1"; }

m4_login() { # m4_login <user> ; echoes the /api/v1/me body
    local user="$1" jar loc authz cb me
    jar="$(m4_jar "$user")"; mkdir -p "$(dirname "$jar")"
    loc=$(curl -s -c "$jar" -o /dev/null -w '%{redirect_url}' \
          "$M4_URL/auth/login?return_to=/projects")
    authz=$(curl -s -b "$jar" -c "$jar" "$loc" >/dev/null; echo "$loc")
    cb=$(curl -s -b "$jar" -c "$jar" -o /dev/null -w '%{redirect_url}' \
          -d "username=$user" \
          --data-urlencode "claims={\"email\":\"$user@example.test\"}" \
          "$authz")
    curl -sL -b "$jar" -c "$jar" -o /dev/null "$cb"
    me=$(curl -s -b "$jar" -c "$jar" "$M4_URL/api/v1/me")
    printf '%s' "$me"
}

api() { # api <user> <METHOD> <path> [json-body]
    local user="$1" method="$2" path="$3" body="${4:-}" jar csrf
    jar="$(m4_jar "$user")"
    [ -s "$jar" ] || m4_login "$user" >/dev/null
    csrf=$(sed -n 's/.*"csrf_token":"\([^"]*\)".*/\1/p' <(curl -s -b "$jar" "$M4_URL/api/v1/me"))
    if [ "$method" = GET ]; then
        curl -s -b "$jar" "$M4_URL$path"
    else
        curl -s -b "$jar" -X "$method" \
             -H "Origin: $M4_URL" -H "X-CSRF-Token: $csrf" \
             -H 'Content-Type: application/json' \
             ${body:+-d "$body"} "$M4_URL$path"
    fi
}

# ---- preconditions -----------------------------------------------------------

m4_stack_up() {
    curl -fsS --max-time 5 "$M4_API_A/api/v1/system/readiness" >/dev/null 2>&1 \
      && curl -fsS --max-time 5 "$M4_API_B/api/v1/system/readiness" >/dev/null 2>&1
}

m4_env_header() {
    echo "== m4 probe: ${M4_PROBE}"
    echo "ENV date=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "ENV user=$(id -un 2>/dev/null || echo '?') uid=$(id -u) gid=$(id -g)"
    echo "ENV compose_project=communication-m4 url=$M4_URL collector=$M4_COLLECTOR"
    echo "ENV docker=$(command -v docker >/dev/null 2>&1 && docker --version 2>&1 | m4_oneline || echo MISSING)"
    if m4_stack_up; then echo "ENV stack=UP (both replicas ready)"; else echo "ENV stack=DOWN"; fi
    echo
}
