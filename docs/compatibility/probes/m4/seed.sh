#!/usr/bin/env bash
# seed.sh — docs/m4-contract.md § 7.0 seed contract: bring a bare M4 lab stack to
# RUNNING sample-pipeline runs and print every id to a machine-readable manifest.
#
#   bash seed.sh                      # seeds against project communication-m4
#   M4_SEED_MANIFEST=/path/seed-manifest.json bash seed.sh
#
# Route shapes come from api/openapi.yaml ONLY (paths, payloads, CSRF+Origin on
# mutations, problem+json errors) — the handlers are written concurrently, so
# this script's contract is the OpenAPI document. Every call fails LOUDLY:
# non-2xx prints the method, path, status and the problem-detail body verbatim,
# then exits non-zero without writing a manifest.
#
# Lifecycle: the exit driver (e2e/m4/e2e_m4_exit.py) owns stack up/down
# (--up ... --down); seed.sh never starts or stops anything. Run it between
# `--up --ready` and the gates. Isolation: everything flows through lib.sh's
# M4_URL (18091) and M4_COMPOSE (project communication-m4). Never 18080-18090.
#
# What it seeds, in order:
#   1. lab users via the mock IdP form (e2e_m3_exit.py login()'s exact shape:
#      /auth/login?return_to -> IdP form POST (username + claims) -> callback
#      -> /api/v1/me; cookie jar per user under the probe cache dir).
#      "admin" is the lab's bootstrap ORG ADMIN (compose.yml
#      COMMUNICATION_BOOTSTRAP_ADMIN_SUBJECTS) and is the only identity holding
#      the library role, so step 6's library calls run as admin; alice must
#      stay a plain project maintainer for gate C9c.
#   2. project m4-exit (alice creates -> implicit maintainer) + members:
#      bob contributor, carol dan maintainers (C9b/c/d arms)
#   3. repository app -> file:///srv/m4/fixtures/app.git (e2e/m4/make_fixture_repo.sh)
#   4. profiles m4-planner/m4-implementer/m4-reviewer by SQL — M3's D10: there is
#      no profile-write API; § 7.0's launcher claude, sandbox required, implementer
#      commit_granted=true
#   5. secret test-database-url = the § 7.0 contract sentinel (write-only per
#      ADR-0018; never echoed) allowlisted to m4-implementer, mounted env/DATABASE_URL/
#      lifecycle=node_attempt
#   6. pipeline.yaml documents 1-3 (agent variant, deterministic twin, C8 child):
#      draft -> validate (errors abort loudly, verbatim) -> publish (revision_digest
#      and plan_digest captured from the response) -> project assignment.
#      The library calls (create/draft/validate/publish + their lookups) are
#      admin-only (requireLibraryRole); the assignment stays project-scoped as alice.
#   7. POST a run of the agent variant AND of the twin (fanout=false so C1's key
#      set is clean; C8 arms re-POST with fanout=true against the same revision —
#      runs are contributor+ and the Idempotency-Key shape makes re-seeds replay 200)
#
# Manifest: JSON, schema tag m4-seed-manifest/1, format documented in README.md.
# Idempotent against a live stack: 409-on-existing resolves through the list
# routes; a pinned-elsewhere assignment is a loud stop, not a silent re-pin.
# No secrets in the manifest; the sentinel is the contract's public lab string
# and rides request bodies only (which are never printed).
set -uo pipefail
M4_DIR="$(cd "$(dirname "$0")" && pwd)"
export M4_PROBE=seed
# shellcheck source=lib.sh
. "$M4_DIR/lib.sh"
export M4_PROBE_ROOT_BASE="${M4_PROBE_ROOT_BASE:-$HOME/.cache/communication-lab/m4-probes}"
mkdir -p "$M4_PROBE_ROOT_BASE"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/m4-seed.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
MANIFEST="${M4_SEED_MANIFEST:-$M4_PROBE_ROOT_BASE/seed-manifest.json}"
PROJECT_SLUG="${M4_SEED_PROJECT_SLUG:-m4-exit}"
REPO_URL="${M4_SEED_REPO_URL:-file:///srv/m4/fixtures/app.git}"
GOAL="${M4_SEED_GOAL:-Document and fix add() in hello.py}"
SENTINEL="${M4_SEED_SECRET_VALUE:-SENTINEL-m4-7c1e9d42-exit-test-only}"
PIPELINE_YAML="${M4_SEED_PIPELINE:-$M4_DIR/pipeline.yaml}"
declare -A JAR CSRF UID_OF
FAIL=""

say()  { printf 'SEED %s\n' "$*"; }
# loud <label> — the single failure funnel: prints the observation verbatim, stops.
loud() {
    printf 'SEED FAIL %s\n' "$1"
    [ -n "${LAST_NOTE:-}" ] && printf '      %s\n' "$LAST_NOTE"
    if [ -n "${LAST_BODY_FILE:-}" ] && [ -s "${LAST_BODY_FILE}" ]; then
        printf '      --- response body (problem detail) ---\n'
        awk 1 "${LAST_BODY_FILE}" | sed 's/^/      /'
        printf '      --- end body ---\n'
    fi
    exit 1
}

# ---- json helpers (python3 stdlib; the harness already requires CPython 3) ----
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
json_escape_file() { # -> a JSON object {"document_yaml": "<verbatim file bytes>"}
    python3 -c '
import json, sys
sys.stdout.write(json.dumps({"document_yaml": open(sys.argv[1], encoding="utf-8").read()}))
' "$1"
}

# ---- HTTP: one call shape, loud on every non-2xx -----------------------------
# req <user> <METHOD> <path> [json-body] — sets LAST_STATUS, LAST_BODY_FILE.
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
# ok <expected-status> — used by callers that branch on a 409 themselves
ok() { [ "$LAST_STATUS" = "$1" ]; }
# need <label> <allowed statuses...> — loud unless current status is allowed
need() {
    local label="$1"; shift
    local s
    for s in "$@"; do [ "$LAST_STATUS" = "$s" ] && return 0; done
    loud "$label — allowed=[$*] got=[$LAST_STATUS] ($LAST_NOTE)"
}

# ---- login (e2e_m3_exit.py login(), curl shape, as in lib.sh m4_login) -------
# /auth/login?return_to -> IdP form POST (username + claims) -> callback -> /api/v1/me.
# Every leg that stops being a redirect prints the response body (problem detail).
login() { # login <user> — populates UID_OF/CSRF_OF; loud on every leg
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
    UID_OF[$user]="$(jget "$LAST_BODY_FILE" id)" || loud "login($user): /api/v1/me has no id"
    CSRF[$user]="$(jget "$LAST_BODY_FILE" csrf_token)" || loud "login($user): /api/v1/me has no csrf_token"
    [ -n "${UID_OF[$user]}" ] && [ -n "${CSRF[$user]}" ] \
        || loud "login($user): missing id or csrf_token in /api/v1/me"
    say "login($user): id=${UID_OF[$user]} (jar ${JAR[$user]##*/})"
}

# ---- upsert helpers: create, or resolve-the-existing on the documented 409 ----
create_project() { # -> PROJECT_ID
    req alice POST /api/v1/projects \
        "{\"name\":\"M4 Exit\",\"slug\":\"$PROJECT_SLUG\",\"description\":\"M4 exit lab project (docs/m4-contract.md section 7.0)\"}"
    if ok 201; then PROJECT_ID=$(jget "$LAST_BODY_FILE" id); say "project: created $PROJECT_ID"; return; fi
    if ok 409; then
        req alice GET /api/v1/projects || loud "project reuse: list"
        need "project reuse: list projects" 200
        PROJECT_ID=$(jfind "$LAST_BODY_FILE" items slug "$PROJECT_SLUG" id) \
            || loud "project $PROJECT_SLUG: 409 on create but absent from the list (unexpected state)"
        say "project: reused existing $PROJECT_ID (slug $PROJECT_SLUG)"
        return
    fi
    loud "create project (POST /api/v1/projects)"
}
create_repo() { # -> REPO_ID
    req alice POST "/api/v1/projects/$PROJECT_ID/repos" \
        "{\"name\":\"app\",\"git_url\":\"$REPO_URL\",\"default_branch\":\"main\"}"
    if ok 201; then REPO_ID=$(jget "$LAST_BODY_FILE" id); say "repo: app -> $REPO_ID ($REPO_URL)"; return; fi
    if ok 409; then
        req alice GET "/api/v1/projects/$PROJECT_ID/repos" || loud "repo reuse: list"
        need "repo reuse: list repos" 200
        REPO_ID=$(jfind "$LAST_BODY_FILE" items name app id) \
            || loud "repo app: 409 on add but absent from the list"
        say "repo: reused existing $REPO_ID (name app)"
        return
    fi
    loud "add repository app (POST /projects/\$id/repos)"
}
put_member() { # put_member <user> <role>
    req alice PUT "/api/v1/projects/$PROJECT_ID/members/${UID_OF[$1]}" "{\"role\":\"$2\"}"
    need "add member $1 as $2 (PUT /projects/\$id/members/\$uid)" 200 201
    say "member: $1 (${UID_OF[$1]}) -> $2"
}

# ---- profiles: § 7.0 seeds them; there is no profile-write API (M3 D10) ------
seed_profile() { # seed_profile <name> <commit_granted> <workspace_mode>
    local name="$1" commit="$2" ws="$3" sql
    sql="INSERT INTO agent_profiles (organization_id, name, launcher_id, permission_mode, workspace_mode, sandbox_enforcement, commit_granted)
         VALUES ((SELECT id FROM organizations WHERE slug = 'default'), '$name', 'claude', 'ask', '$ws', 'required', $commit)
         ON CONFLICT (organization_id, name) DO UPDATE SET launcher_id = EXCLUDED.launcher_id,
             permission_mode = EXCLUDED.permission_mode, workspace_mode = EXCLUDED.workspace_mode,
             sandbox_enforcement = EXCLUDED.sandbox_enforcement, commit_granted = EXCLUDED.commit_granted;
         SELECT id FROM agent_profiles WHERE organization_id = (SELECT id FROM organizations WHERE slug = 'default') AND name = '$name';"
    local out
    out=$(run_sql "$sql") || { LAST_NOTE="psql: $out"; loud "seed profile $name (docker compose exec postgres psql)"; }
    PROFILE_ID=$(printf '%s\n' "$out" | tail -1)
    case "$PROFILE_ID" in *[!0-9a-f-]*|"") LAST_NOTE="psql returned [$out]"; loud "seed profile $name: no uuid back";; esac
    PROFILE_ID=$(printf '%s' "$PROFILE_ID" | tr -d '[:space:]')
    PROFILE_IDS[$name]="$PROFILE_ID"
    say "profile: $name -> $PROFILE_ID (launcher claude, commit_granted=$commit, workspace_mode=$ws)"
}
declare -A PROFILE_IDS

# ---- pipelines: draft -> validate -> publish (capture both digests) -----------
declare -A PIPE_ID REV_ID REV_NUM REV_LABEL REV_DIGEST PLAN_DIGEST ASSIGN_ID

split_docs() {
    awk -v dir="$WORK" 'BEGIN { d = 1 }
        /^---$/ { d++; next }
        { print > (dir "/doc" d ".yaml") }' "$PIPELINE_YAML"
    local n
    for n in 1 2 3; do
        [ -s "$WORK/doc$n.yaml" ] || loud "pipeline.yaml: document $n missing (file split yielded $(ls "$WORK" | tr '\n' ' '))"
    done
}

seed_pipeline() { # seed_pipeline <slug> <docfile> — library calls run as admin (org admin holds the library role; see compose.yml BOOTSTRAP_ADMIN_SUBJECTS), the project assignment as alice
    local slug="$1" docfile="$2" body draft version vd
    req admin POST /api/v1/pipelines \
        "{\"slug\":\"$slug\",\"display_name\":\"$slug\",\"description\":\"M4 exit seed pipeline (docs/compatibility/probes/m4/pipeline.yaml)\"}"
    if ok 201 || ok 409; then
        if ok 201; then PIPE_ID[$slug]=$(jget "$LAST_BODY_FILE" id); say "pipeline: $slug created"
        else
            req admin GET /api/v1/pipelines || loud "$slug reuse: list"
            need "$slug reuse: list pipelines" 200
            PIPE_ID[$slug]=$(jfind "$LAST_BODY_FILE" pipelines slug "$slug" id) \
                || loud "pipeline $slug: 409 on create but absent from the library"
            say "pipeline: reused existing $slug"
        fi
    else
        loud "create pipeline $slug (POST /api/v1/pipelines)"
    fi

    body=$(json_escape_file "$docfile") || loud "$slug: encode document_yaml"
    req admin POST "/api/v1/pipelines/${PIPE_ID[$slug]}/drafts" "$body"
    need "$slug: create draft (POST /pipelines/\$id/drafts)" 201
    draft=$(jget "$LAST_BODY_FILE" id); version=$(jget "$LAST_BODY_FILE" version)
    [ -n "$draft" ] && [ -n "$version" ] || loud "$slug: draft create lacks id/version"
    say "pipeline $slug: draft $draft version $version"

    req admin POST "/api/v1/drafts/$draft/validate"
    need "$slug: validate draft (POST /drafts/\$id/validate)" 200
    if [ "$(jget "$LAST_BODY_FILE" valid)" != "true" ]; then
        LAST_NOTE="validate says valid=false; the error list is the body below (codes + locations, docs/m4-contract.md § 2.2)"
        loud "$slug: draft did not validate"
    fi
    vd=$(jget "$LAST_BODY_FILE" revision_digest)
    say "pipeline $slug: validate OK revision_digest=$vd plan_digest=$(jget "$LAST_BODY_FILE" plan_digest)"

    req admin POST "/api/v1/drafts/$draft/publish" "{\"version\":$version}"
    if ok 201; then
        REV_ID[$slug]=$(jget "$LAST_BODY_FILE" id)
        say "pipeline $slug: published revision ${REV_ID[$slug]}"
    elif ok 409 && grep -q 'revision_already_published' "$LAST_BODY_FILE"; then
        REV_ID[$slug]=$(jget "$LAST_BODY_FILE" existing_revision_id) || REV_ID[$slug]=""
        if [ -z "${REV_ID[$slug]}" ]; then
            req admin GET "/api/v1/pipelines/${PIPE_ID[$slug]}/revisions" || loud "$slug revision lookup"
            need "$slug: list revisions" 200
            REV_ID[$slug]=$(jfind "$LAST_BODY_FILE" revisions revision_digest "$vd" id) \
                || loud "$slug: revision_already_published but no resolvable revision"
        fi
        req admin GET "/api/v1/revisions/${REV_ID[$slug]}" || loud "$slug: GET existing revision"
        need "$slug: resolve existing revision" 200
        say "pipeline $slug: digest collision — using existing revision ${REV_ID[$slug]}"
    else
        loud "$slug: publish draft (POST /drafts/\$id/publish)"
    fi
    REV_NUM[$slug]=$(jget "$LAST_BODY_FILE" revision_number)
    REV_LABEL[$slug]=$(jget "$LAST_BODY_FILE" version_label)
    REV_DIGEST[$slug]=$(jget "$LAST_BODY_FILE" revision_digest)
    PLAN_DIGEST[$slug]=$(jget "$LAST_BODY_FILE" plan_digest)
    [ -n "${REV_DIGEST[$slug]}" ] && [ -n "${PLAN_DIGEST[$slug]}" ] \
        || loud "$slug: revision response missing revision_digest/plan_digest"

    req alice POST "/api/v1/projects/$PROJECT_ID/assignments" \
        "{\"pipeline_id\":\"${PIPE_ID[$slug]}\",\"pinned_revision_id\":\"${REV_ID[$slug]}\",\"max_concurrent_runs\":3}"
    if ok 201; then
        ASSIGN_ID[$slug]=$(jget "$LAST_BODY_FILE" id)
    elif ok 409; then
        req alice GET "/api/v1/projects/$PROJECT_ID/assignments" || loud "$slug assignment lookup"
        need "$slug: list assignments" 200
        ASSIGN_ID[$slug]=$(jfind "$LAST_BODY_FILE" assignments pinned_revision_id "${REV_ID[$slug]}" id) \
            || { LAST_NOTE="an assignment for this pipeline exists pinned ELSEWHERE — re-pin deliberately (PATCH /assignments/{id}), not from the seed"
                 loud "$slug: assignment 409 with a different pin"; }
        say "pipeline $slug: reused existing assignment ${ASSIGN_ID[$slug]}"
    else
        loud "$slug: create assignment (POST /projects/\$id/assignments)"
    fi
    [ -n "${ASSIGN_ID[$slug]}" ] || loud "$slug: assignment id empty"
    say "pipeline $slug: revision ${REV_NUM[$slug]} (${REV_LABEL[$slug]}) assignment ${ASSIGN_ID[$slug]}"
    say "pipeline $slug: revision_digest=${REV_DIGEST[$slug]}"
    say "pipeline $slug: plan_digest=${PLAN_DIGEST[$slug]}"
}

post_run() { # post_run <manifest-key> <slug> <idempotency> -> RUNS[key]=run_id
    local key="$1" slug="$2" idem="$3"
    req alice POST "/api/v1/projects/$PROJECT_ID/runs" \
        "{\"assignment_id\":\"${ASSIGN_ID[$slug]}\",\"inputs\":{\"goal\":\"$GOAL\",\"repository\":\"app\",\"fanout\":false,\"fanout_count\":0},\"idempotency\":\"$idem\"}"
    need "$key: POST /projects/\$id/runs" 201 200
    RUNS[$key]=$(jget "$LAST_BODY_FILE" run_id)
    [ -n "${RUNS[$key]}" ] || loud "$key: run create response has no run_id"
    say "$key run: ${RUNS[$key]} status=$(jget "$LAST_BODY_FILE" status) (pipeline $slug, idempotency $idem)"
}
declare -A RUNS

# ---- manifest ------------------------------------------------------------------
write_manifest() {
    mkdir -p "$(dirname "$MANIFEST")"
    M4_SEED_USERS_ALICE="${UID_OF[alice]}" M4_SEED_USERS_BOB="${UID_OF[bob]}" \
    M4_SEED_USERS_CAROL="${UID_OF[carol]}" M4_SEED_USERS_DAN="${UID_OF[dan]}" \
    M4_SEED_USERS_ADMIN="${UID_OF[admin]}" \
    M4_SEED_PROJECT_ID="$PROJECT_ID" M4_SEED_PROJECT_SLUG="$PROJECT_SLUG" \
    M4_SEED_REPO_ID="$REPO_ID" M4_SEED_REPO_URL="$REPO_URL" \
    M4_SEED_PLANNER_ID="${PROFILE_IDS[m4-planner]}" M4_SEED_IMPLEMENTER_ID="${PROFILE_IDS[m4-implementer]}" \
    M4_SEED_REVIEWER_ID="${PROFILE_IDS[m4-reviewer]}" M4_SEED_SECRET_ID="$SECRET_ID" \
    M4_SEED_MOUNT_ID="$MOUNT_ID" M4_SEED_GOAL="$GOAL" M4_SEED_REPO_INPUT=app \
    M4_SEED_FD_PIPELINE="${PIPE_ID[feature-development]}" M4_SEED_FD_REVISION="${REV_ID[feature-development]}" \
    M4_SEED_FD_REVNUM="${REV_NUM[feature-development]}" M4_SEED_FD_LABEL="${REV_LABEL[feature-development]}" \
    M4_SEED_FD_RDIGEST="${REV_DIGEST[feature-development]}" M4_SEED_FD_PDIGEST="${PLAN_DIGEST[feature-development]}" \
    M4_SEED_FD_ASSIGN="${ASSIGN_ID[feature-development]}" M4_SEED_FD_RUN="${RUNS[agent]}" \
    M4_SEED_TW_PIPELINE="${PIPE_ID[feature-development-deterministic]}" M4_SEED_TW_REVISION="${REV_ID[feature-development-deterministic]}" \
    M4_SEED_TW_REVNUM="${REV_NUM[feature-development-deterministic]}" M4_SEED_TW_LABEL="${REV_LABEL[feature-development-deterministic]}" \
    M4_SEED_TW_RDIGEST="${REV_DIGEST[feature-development-deterministic]}" M4_SEED_TW_PDIGEST="${PLAN_DIGEST[feature-development-deterministic]}" \
    M4_SEED_TW_ASSIGN="${ASSIGN_ID[feature-development-deterministic]}" M4_SEED_TW_RUN="${RUNS[twin]}" \
    M4_SEED_II_PIPELINE="${PIPE_ID[issue-implementation]}" M4_SEED_II_REVISION="${REV_ID[issue-implementation]}" \
    M4_SEED_II_REVNUM="${REV_NUM[issue-implementation]}" M4_SEED_II_LABEL="${REV_LABEL[issue-implementation]}" \
    M4_SEED_II_RDIGEST="${REV_DIGEST[issue-implementation]}" M4_SEED_II_PDIGEST="${PLAN_DIGEST[issue-implementation]}" \
    M4_SEED_II_ASSIGN="${ASSIGN_ID[issue-implementation]}" \
    python3 - "$MANIFEST.$$" <<'PYEOF'
import datetime, json, os, sys
e = os.environ
def pipelines():
    out = {}
    for tag, slug in (("M4_SEED_FD", "feature-development"),
                      ("M4_SEED_TW", "feature-development-deterministic"),
                      ("M4_SEED_II", "issue-implementation")):
        p = {"pipeline_id": e[f"{tag}_PIPELINE"], "slug": slug,
             "revision_id": e[f"{tag}_REVISION"], "revision_number": int(e[f"{tag}_REVNUM"]),
             "version_label": e[f"{tag}_LABEL"], "revision_digest": e[f"{tag}_RDIGEST"],
             "plan_digest": e[f"{tag}_PDIGEST"], "assignment_id": e[f"{tag}_ASSIGN"]}
        out[slug] = p
    out["feature-development"]["run_id"] = e["M4_SEED_FD_RUN"]
    out["feature-development-deterministic"]["run_id"] = e["M4_SEED_TW_RUN"]
    return out
manifest = {
    "schema": "m4-seed-manifest/1",
    "seeded_at": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
    "stack": {"compose_project": "communication-m4", "url": e["M4_URL"]},
    "users": {"alice": e["M4_SEED_USERS_ALICE"], "bob": e["M4_SEED_USERS_BOB"],
              "carol": e["M4_SEED_USERS_CAROL"], "dan": e["M4_SEED_USERS_DAN"],
              "admin": e["M4_SEED_USERS_ADMIN"]},
    "project": {"id": e["M4_SEED_PROJECT_ID"], "slug": e["M4_SEED_PROJECT_SLUG"]},
    "repositories": {"app": {"id": e["M4_SEED_REPO_ID"], "git_url": e["M4_SEED_REPO_URL"]}},
    "profiles": {"m4-planner": e["M4_SEED_PLANNER_ID"],
                 "m4-implementer": e["M4_SEED_IMPLEMENTER_ID"],
                 "m4-reviewer": e["M4_SEED_REVIEWER_ID"]},
    "secret": {"id": e["M4_SEED_SECRET_ID"], "slug": "test-database-url",
               "mount_id": e["M4_SEED_MOUNT_ID"], "env_name": "DATABASE_URL",
               "lifecycle": "node_attempt", "allowed_profile": "m4-implementer"},
    "pipelines": pipelines(),
    "runs": [
        {"run_id": e["M4_SEED_FD_RUN"], "variant": "agent",
         "pipeline_slug": "feature-development",
         "revision_digest": e["M4_SEED_FD_RDIGEST"], "plan_digest": e["M4_SEED_FD_PDIGEST"],
         "inputs": {"goal": e["M4_SEED_GOAL"], "repository": e["M4_SEED_REPO_INPUT"],
                    "fanout": False, "fanout_count": 0}},
        {"run_id": e["M4_SEED_TW_RUN"], "variant": "twin",
         "pipeline_slug": "feature-development-deterministic",
         "revision_digest": e["M4_SEED_TW_RDIGEST"], "plan_digest": e["M4_SEED_TW_PDIGEST"],
         "inputs": {"goal": e["M4_SEED_GOAL"], "repository": e["M4_SEED_REPO_INPUT"],
                    "fanout": False, "fanout_count": 0}},
    ],
    "fixture": {"git_url": e["M4_SEED_REPO_URL"],
                "generator": "e2e/m4/make_fixture_repo.sh"},
}
with open(sys.argv[1], "w", encoding="utf-8") as f:
    json.dump(manifest, f, indent=2, sort_keys=True)
    f.write("\n")
PYEOF
    mv "$MANIFEST.$$" "$MANIFEST"
    say "manifest: $MANIFEST"
    sed 's/^/  /' "$MANIFEST"
}

# ================================= main =========================================
say "seed target $M4_URL (compose project communication-m4; nothing else)"
if ! m4_stack_up; then
    LAST_NOTE="both API replicas (${M4_API_A} ${M4_API_B}) failed /api/v1/system/readiness — bring the exit stack up first:
      HOST_UID=\$(id -u) HOST_GID=\$(id -g) docker compose -p communication-m4 -f compose.yml -f compose.harness.yml -f compose.m4.yml up -d --build
      (and regenerate the fixture: bash e2e/m4/make_fixture_repo.sh)"
    loud "stack not ready"
fi
say "readiness: both replicas 200"

login alice; login bob; login carol; login dan; login admin
create_project
put_member bob contributor
put_member carol maintainer
put_member dan maintainer
create_repo

seed_profile m4-planner false worktree
seed_profile m4-implementer true worktree
seed_profile m4-reviewer false worktree

req alice POST "/api/v1/projects/$PROJECT_ID/secrets" \
    "{\"slug\":\"test-database-url\",\"purpose\":\"M4 exit C2 sentinel (docs/m4-contract.md § 7.0)\",\"delivery_mode\":\"env\",\"allowed_agent_profile_ids\":[\"${PROFILE_IDS[m4-implementer]}\"],\"value\":\"$SENTINEL\"}" \
    || loud "create secret test-database-url"
if ok 201; then SECRET_ID=$(jget "$LAST_BODY_FILE" id); say "secret: created $SECRET_ID (value never echoed)"
elif ok 409; then
    req alice GET "/api/v1/projects/$PROJECT_ID/secrets" || loud "secret reuse"
    need "secret reuse: list" 200
    SECRET_ID=$(jfind "$LAST_BODY_FILE" secrets slug test-database-url id) || loud "secret 409 but not in list"
    say "secret: reused existing $SECRET_ID"
else
    loud "create secret test-database-url (POST /projects/\$id/secrets)"
fi
req alice POST "/api/v1/projects/$PROJECT_ID/secret-mounts" \
    "{\"secret_id\":\"$SECRET_ID\",\"delivery_mode\":\"env\",\"env_name\":\"DATABASE_URL\",\"lifecycle\":\"node_attempt\"}"
if ok 201; then MOUNT_ID=$(jget "$LAST_BODY_FILE" id); say "mount: env DATABASE_URL lifecycle=node_attempt -> $MOUNT_ID"
elif ok 409; then
    req alice GET "/api/v1/projects/$PROJECT_ID/secret-mounts" || loud "mount reuse: list"
    need "mount reuse: list" 200
    MOUNT_ID=$(jfind "$LAST_BODY_FILE" secret_mounts secret_id "$SECRET_ID" id) || MOUNT_ID=""
    [ -n "$MOUNT_ID" ] || loud "secret mount 409 but no resolvable mount row (GET secret-mounts)"
    say "mount: reused existing $MOUNT_ID"
else loud "create secret mount (POST /projects/\$id/secret-mounts)"; fi

split_docs
seed_pipeline feature-development "$WORK/doc1.yaml"
seed_pipeline feature-development-deterministic "$WORK/doc2.yaml"
seed_pipeline issue-implementation "$WORK/doc3.yaml"

post_run agent feature-development m4-seed-agent
post_run twin feature-development-deterministic m4-seed-twin

write_manifest
say "done — the exit driver can now gate on the manifest (README.md, manifest format)"
