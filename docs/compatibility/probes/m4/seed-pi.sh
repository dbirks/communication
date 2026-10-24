#!/usr/bin/env bash
# seed-pi.sh — LAB-ONLY seed for the pi launcher proof (ADR-0059 registered the
# `pi` launcher with sandbox/permission cells not_tested; the lab must observe
# real rows before ADR-0036's preapproved-within-sandbox exception could ever
# extend to it). Same structure and idioms as seed.sh, scoped down to what
# pi-proof.sh needs: the project `pi-proof` (created by the bootstrap org admin
# `admin`, which therefore holds its implicit maintainer membership), its
# repository `app` -> file:///srv/m4/fixtures/app.git, and the two agent
# profiles `pi-planner` / `pi-implementer` with launcher_id `pi`,
# sandbox_enforcement `required` and permission_mode
# `preapproved_within_sandbox` — then it prints every id.
#
# Why SQL, exactly the way seed.sh does it: there is no profile-write API
# (M3 D10) and the profile route journals every create as `ask` regardless
# (internal/events AgentProfileCreatedPayload.PermissionMode — the API
# REFUSES to carry preapproved_within_sandbox at all, ADR-0030), so the only
# writer of the mode is this upsert, which re-affirms it idempotently on every
# re-seed (ON CONFLICT (organization_id, name) DO UPDATE).
#
# This file is lab scope only, like ADR-0036's seed.sh block: the product's
# own seeds (migration 00003) and every real deployment stay `ask`. Whether
# these two profiles may RUN preapproved is the open question this probe
# answers with evidence — docs/compatibility/SANDBOX.md, section "pi launcher
# in nono (2026-10-24)". Until that evidence exists (and an ADR extends
# ADR-0036 to `pi`), the worker is EXPECTED to fail these profiles closed: a
# pi profile with any recorded permission mode has no verified prompting mode
# (docs/compatibility/ACP.md "Pi"), and ADR-0019 D6 makes the attempt refuse
# rather than run the adapter's never-asks default.
#
# Isolation: everything flows through lib.sh's M4_URL (18091). The running lab
# was composed from ~/.cache/comm-lab with the compose.real.yml overlay and the
# operator's docker needs sudo, so the SQL helper is `sudo docker exec
# communication-m4-postgres-1 psql` (the documented operator path) rather than
# lib.sh's repo-relative `docker compose -f compose.yml ...` exec; nothing here
# starts, stops, or reconfigures the stack. No secret value is ever read,
# printed or written: only ids and row contents.
set -uo pipefail
M4_DIR="$(cd "$(dirname "$0")" && pwd)"
export M4_PROBE=seed-pi
# shellcheck source=lib.sh
. "$M4_DIR/lib.sh"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/m4-seed-pi.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
PROJECT_SLUG="${M4_PI_PROJECT_SLUG:-pi-proof}"
REPO_URL="${M4_PI_REPO_URL:-file:///srv/m4/fixtures/app.git}"
declare -A JAR CSRF
FAIL=""

say()  { printf 'SEEDPI %s\n' "$*"; }
# loud <label> — the single failure funnel (seed.sh's shape): prints the
# observation verbatim, stops.
loud() {
    printf 'SEEDPI FAIL %s\n' "$1"
    [ -n "${LAST_NOTE:-}" ] && printf '      %s\n' "$LAST_NOTE"
    if [ -n "${LAST_BODY_FILE:-}" ] && [ -s "${LAST_BODY_FILE}" ]; then
        printf '      --- response body (problem detail) ---\n'
        awk 1 "${LAST_BODY_FILE}" | sed 's/^/      /'
        printf '      --- end body ---\n'
    fi
    exit 1
}

# ---- sql helper: operator sudo path against the RUNNING lab (see header) ----
run_sql() {
    sudo docker exec communication-m4-postgres-1 psql -U communication \
        -d communication -tAqc "$1" 2>&1
}

# ---- json helpers (seed.sh's shapes, python3 stdlib) --------------------------
jget() { # jget <file> <dotted.path> -> raw scalar (string/number) or empty, exit 1 if absent
    python3 -c '
import json, sys
try:
    d = json.load(open(sys.argv[1]))
except Exception as exc:
    sys.stderr.write(f"json: {exc}\n"); sys.exit(1)
for part in sys.argv[2].split("."):
    if isinstance(d, list):
        if not part.isdigit() or int(part) >= len(d): sys.exit(1)
        d = d[int(part)]
    elif isinstance(d, dict) and part in d:
        d = d[part]
    else:
        sys.exit(1)
sys.stdout.write("" if d is None else (json.dumps(d) if isinstance(d, (dict, list, bool)) else str(d)))
' "$1" "$2"
}
jfind() { # jfind <file> <list.path> <match.key> <match.value> <want.key>
    python3 -c '
import json, sys
d = json.load(open(sys.argv[1]))
for part in sys.argv[2].split("."):
    d = d.get(part) if part else d
for row in d or []:
    if str(row.get(sys.argv[3])) == sys.argv[4]:
        v = row.get(sys.argv[5])
        sys.stdout.write("" if v is None else str(v)); sys.exit(0)
sys.exit(1)
' "$1" "$2" "$3" "$4" "$5"
}

# ---- HTTP: seed.sh's one call shape, loud on every non-2xx --------------------
LAST_STATUS="" LAST_BODY_FILE="" LAST_NOTE=""
req() {
    local user="$1" method="$2" path="$3" body="${4:-}" st sttab rc
    LAST_NOTE=""; LAST_BODY_FILE="$WORK/resp.json"; : > "$LAST_BODY_FILE"
    local -a args=(-sS --max-time 60 -o "$LAST_BODY_FILE" -w '%{http_code}\t%{content_type}')
    if [ "$method" = GET ]; then
        sttab=$(curl "${args[@]}" -b "${JAR[$user]}" "$M4_URL$path")
    else
        sttab=$(curl "${args[@]}" -b "${JAR[$user]}" -X "$method" \
                    -H "Origin: $M4_URL" -H "X-CSRF-Token: ${CSRF[$user]}" \
                    -H 'Content-Type: application/json' \
                    ${body:+-d "$body"} "$M4_URL$path")
    fi
    rc=$?
    if [ $rc -ne 0 ]; then
        LAST_NOTE="curl rc=$rc — cannot reach $M4_URL$path (stack down? § 7.0 compose up first)"
        LAST_STATUS=""
        return 2
    fi
    LAST_STATUS="${sttab%%$'\t'*}"
    LAST_NOTE="$method $path -> $sttab"
    return 0
}
ok()   { [ "$LAST_STATUS" = "$1" ]; }
need() {
    local label="$1" s
    for s in "$@"; do [ "$LAST_STATUS" = "$s" ] && return 0; done
    loud "$label — allowed=[$*] got=[$LAST_STATUS] ($LAST_NOTE)"
}

# ---- login: seed.sh's exact IdP legs (/auth/login?return_to -> IdP form POST
# -> callback -> /api/v1/me; cookie jar per user). `admin` is the lab's
# bootstrap ORG ADMIN (compose BOOTSTRAP_ADMIN_SUBJECTS) and the only identity
# holding the library role — pi-proof.sh's pipeline calls need it, and as the
# project's creator it is also the project maintainer, so one identity covers
# library + project + runs here.
login() {
    local user="$1" loc form cb
    JAR[$user]="$(m4_jar "$user")"; mkdir -p "$(dirname "${JAR[$user]}")"
    rm -f "${JAR[$user]}"
    LAST_BODY_FILE="$WORK/login-$user.body"
    loc=$(curl -sS --max-time 30 -c "${JAR[$user]}" -o "$LAST_BODY_FILE" -w '%{redirect_url}' \
              "$M4_URL/auth/login?return_to=/projects" 2>"$WORK/curl.err") \
        || { LAST_NOTE="curl: $(m4_oneline < "$WORK/curl.err")"; loud "login($user): GET /auth/login unreachable"; }
    [ -n "$loc" ] || { LAST_NOTE="/auth/login did not answer 3xx+Location"; loud "login($user): GET /auth/login?return_to=/projects"; }
    form=$(curl -sS --max-time 30 -b "${JAR[$user]}" -c "${JAR[$user]}" "$loc" 2>"$WORK/curl.err") \
        || { LAST_NOTE="curl: $(m4_oneline < "$WORK/curl.err")"; loud "login($user): GET IdP form $loc"; }
    case "$form" in *'name="username"'*) ;; *) LAST_NOTE="the page at $loc has no username field"
        loud "login($user): mock IdP form shape" ;; esac
    cb=$(curl -sS --max-time 30 -b "${JAR[$user]}" -c "${JAR[$user]}" -o "$LAST_BODY_FILE" \
            -w '%{redirect_url}' -d "username=$user" \
            --data-urlencode "claims={\"email\":\"$user@example.test\"}" "$loc" 2>"$WORK/curl.err") \
        || { LAST_NOTE="curl: $(m4_oneline < "$WORK/curl.err")"; loud "login($user): POST IdP form"; }
    [ -n "$cb" ] || { LAST_NOTE="IdP form POST did not redirect to the app callback"
        loud "login($user): POST $loc (username/claims form)"; }
    curl -sSL --max-time 30 -b "${JAR[$user]}" -c "${JAR[$user]}" -o /dev/null "$cb" 2>"$WORK/curl.err" \
        || { LAST_NOTE="curl: $(m4_oneline < "$WORK/curl.err")"; loud "login($user): follow callback $cb"; }
    req "$user" GET /api/v1/me || loud "login($user): GET /api/v1/me unreachable"
    need "login($user): GET /api/v1/me (signed-in principal)" 200
    CSRF[$user]="$(jget "$LAST_BODY_FILE" csrf_token)" || loud "login($user): /api/v1/me has no csrf_token"
    [ -n "${CSRF[$user]}" ] || loud "login($user): missing csrf_token in /api/v1/me"
    say "login($user): id=$(jget "$LAST_BODY_FILE" id) (jar ${JAR[$user]##*/})"
}

# ---- upsert helpers (seed.sh shapes: create, or resolve-the-409 via list) ----
create_project() { # -> PROJECT_ID — created by admin, which makes admin its maintainer
    req admin POST /api/v1/projects \
        "{\"name\":\"Pi Proof\",\"slug\":\"$PROJECT_SLUG\",\"description\":\"Lab proof that a pi agent.acp node runs inside nono (docs/compatibility/probes/m4/pi-proof.yaml)\"}"
    if ok 201; then PROJECT_ID=$(jget "$LAST_BODY_FILE" id); say "project: created $PROJECT_ID"; return; fi
    if ok 409; then
        req admin GET /api/v1/projects || loud "project reuse: list"
        need "project reuse: list projects" 200
        PROJECT_ID=$(jfind "$LAST_BODY_FILE" items slug "$PROJECT_SLUG" id) \
            || loud "project $PROJECT_SLUG: 409 on create but absent from the list (unexpected state)"
        say "project: reused existing $PROJECT_ID (slug $PROJECT_SLUG)"
        return
    fi
    loud "create project (POST /api/v1/projects)"
}
create_repo() { # -> REPO_ID
    req admin POST "/api/v1/projects/$PROJECT_ID/repos" \
        "{\"name\":\"app\",\"git_url\":\"$REPO_URL\",\"default_branch\":\"main\"}"
    if ok 201; then REPO_ID=$(jget "$LAST_BODY_FILE" id); say "repo: app -> $REPO_ID ($REPO_URL)"; return; fi
    if ok 409; then
        req admin GET "/api/v1/projects/$PROJECT_ID/repos" || loud "repo reuse: list"
        need "repo reuse: list repos" 200
        REPO_ID=$(jfind "$LAST_BODY_FILE" items name app id) \
            || loud "repo app: 409 on add but absent from the list"
        say "repo: reused existing $REPO_ID (name app)"
        return
    fi
    loud "add repository app (POST /projects/\$id/repos)"
}

# ---- profiles: seed.sh's seed_profile shape, launcher `pi` -------------------
# permission_mode is lab-evidence-scoped exactly like ADR-0036's block; the
# upsert is the ONLY writer (M3 D10: no profile-write API) and re-affirms every
# column idempotently on re-seed.
declare -A PROFILE_IDS
seed_pi_profile() { # seed_pi_profile <name> — pi launcher, required, preapproved (lab evidence pending), worktree, no commit grant
    local name="$1" sql out
    sql="INSERT INTO agent_profiles (organization_id, name, launcher_id, permission_mode, workspace_mode, sandbox_enforcement, commit_granted)
         VALUES ((SELECT id FROM organizations WHERE slug = 'default'), '$name', 'pi', 'preapproved_within_sandbox', 'worktree', 'required', false)
         ON CONFLICT (organization_id, name) DO UPDATE SET launcher_id = EXCLUDED.launcher_id,
             permission_mode = EXCLUDED.permission_mode, workspace_mode = EXCLUDED.workspace_mode,
             sandbox_enforcement = EXCLUDED.sandbox_enforcement, commit_granted = EXCLUDED.commit_granted;
         SELECT id FROM agent_profiles WHERE organization_id = (SELECT id FROM organizations WHERE slug = 'default') AND name = '$name';"
    out=$(run_sql "$sql") || { LAST_NOTE="psql: $out"; loud "seed profile $name (sudo docker exec communication-m4-postgres-1 psql)"; }
    PROFILE_ID=$(printf '%s\n' "$out" | tail -1 | tr -d '[:space:]')
    case "$PROFILE_ID" in ""|*[!0-9a-f-]*) LAST_NOTE="psql returned [$out]"; loud "seed profile $name: no uuid back";; esac
    PROFILE_IDS[$name]="$PROFILE_ID"
    # Read the row back — the printed line is the evidence that the LAB row
    # really carries launcher pi / required / preapproved (the API cannot write
    # this mode, so the row is the fact; never take the INSERT's word for it).
    ROW=$(run_sql "SELECT launcher_id || '/' || sandbox_enforcement || '/' || permission_mode || '/' || workspace_mode || '/commit=' || commit_granted::text FROM agent_profiles WHERE id = '$PROFILE_ID'" | tail -1)
    [ "$ROW" = "pi/required/preapproved_within_sandbox/worktree/commit=false" ] \
        || loud "seed profile $name: read-back row is [$ROW], not the seeded pi/required/preapproved shape"
    say "profile: $name -> $PROFILE_ID (launcher pi, sandbox_enforcement=required, permission_mode=preapproved_within_sandbox, workspace_mode=worktree, commit_granted=false) readback=[$ROW]"
}

# ================================= main =========================================
say "seed target $M4_URL (compose project communication-m4, pi overlay; nothing else — the stack is left exactly as found)"
if ! m4_stack_up; then
    LAST_NOTE="both API replicas (${M4_API_A} ${M4_API_B}) failed /api/v1/system/readiness — the lab must be up (never rebuilt by this probe)"
    loud "stack not ready"
fi
say "readiness: both replicas 200"

login admin
create_project
create_repo
seed_pi_profile pi-planner
seed_pi_profile pi-implementer

say "ids: project=$PROJECT_ID repo(app)=$REPO_ID pi-planner=${PROFILE_IDS[pi-planner]} pi-implementer=${PROFILE_IDS[pi-implementer]}"
say "done — run: bash docs/compatibility/probes/m4/pi-proof.sh"
