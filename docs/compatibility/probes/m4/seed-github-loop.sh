#!/usr/bin/env bash
# seed-github-loop.sh — LAB-ONLY seed for the REAL issue → draft-PR loop on the
# throwaway repository https://github.com/dbirks/comms-test-repo-1 (private).
# Same structure and idioms as seed.sh / seed-pi.sh (their sign-in, CSRF,
# create-or-resolve-the-409 and SQL-through-psql shapes), scoped to what
# gh-loop.sh drives:
#
#   • project `gh-loop` (created by the bootstrap org admin `admin`, which
#     therefore holds its implicit maintainer membership — the same identity
#     that decides the pipeline's approval gate),
#   • repository `tally` -> https://github.com/dbirks/comms-test-repo-1.git
#     (default branch main),
#   • project secret `github-broker` (delivery_mode integration_broker,
#     ADR-0061) carrying the token, and PATCH /projects/{id}/repos/{id}
#     credential_secret_id -> it: the private-repo clone/fetch + issue-read
#     credential the mirror and the ADR-0056 poller resolve with a
#     secret.resolved audit. Broker secrets are creatable but NEVER mountable,
#   • project secret `github-push-token` (delivery_mode env, mount
#     env_name=GH_TOKEN lifecycle=node_attempt, ADR-0045) allowlisted to the
#     IMPLEMENTER profile ONLY — the planner never sees it; the token rides the
#     exec environment, never argv (ADR-0040),
#   • agent profiles `claude-planner` / `claude-implementer` by SQL upsert —
#     launcher claude, sandbox_enforcement required, permission_mode
#     preapproved_within_sandbox — exactly seed.sh's m4-* upsert
#     (docs/adr/ADR-0036-lab-agent-profiles-preapproved-within-sandbox.md).
#     ADR-0036's lab exception covers claude ONLY and reverts when "the
#     launcher is not claude, the only one evaluated"; launcher pi stays a GAP
#     there (docs/compatibility/ACP.md "Pi": no verified prompting mode, the
#     worker fails such profiles closed) — which is precisely why this probe
#     runs the loop on claude profiles while the shipped template
#     (ui/src/lib/pipeline/templates/issue-to-pr.yaml.txt) names pi ones.
#     The seed rewrites the two profile names in a TEMP COPY via sed; the
#     product template is never touched.
#   • pipeline `issue-to-pr`: that template, draft -> validate -> publish,
#     assigned to gh-loop/tally, plus the issue trigger on `tally`
#     (event labeled, any-of labels [comm:go], inputs templated from the
#     fired issue: goal = {{issue.title}} + {{issue.body}}, issue_number =
#     {{issue.number}}, repository = tally) — ADR-0056 part 2.
#
# THE TOKEN. The value lives ONLY in the file named by
# COMMUNICATION_TEST_REPO_TOKEN_FILE. It is never read, printed, echoed,
# logged or written anywhere except as (a) the HTTP request body that creates
# or rotates a communication secret — piped straight from the file with
# `jq --rawfile` into `curl --data-binary @-`, so it never enters ANY argv —
# and (b) nothing else in this script. GitHub API use of the token
# (issue creation, PR assertion) is gh-loop.sh's job and rides a header
# piped from the same file. When COMMUNICATION_TEST_REPO_TOKEN_FILE is unset
# the secret/mount/credential steps print SKIP-TOKEN and the local parts
# (project, repo, profiles, pipeline, assignment, trigger) still run — the
# dry-run arm; SKIP-TOKEN is not a failure.
#
# Every token-carrying region flips `set +x` and restores exactly whatever
# trace mode the caller had (GH_TRACE_WAS_X), so even `bash -x` cannot make
# the value print.
#
# Why SQL for the profiles, exactly like seed-pi.sh: there is no profile-write
# API (M3 D10) and the profile route journals every create as `ask` regardless
# (the API REFUSES to carry preapproved_within_sandbox at all, ADR-0030), so
# this upsert is the only writer and re-affirms every column idempotently on
# re-seed (ON CONFLICT (organization_id, name) DO UPDATE). Lab scope only: the
# product's own seeds (migration 00003) and every real deployment stay `ask`.
#
# Isolation: everything flows through lib.sh's M4_URL (18091). The running lab
# was composed from ~/.cache/comm-lab with the compose.real.yml overlay and the
# operator's docker needs sudo, so the SQL helper is `sudo docker exec
# communication-m4-postgres-1 psql` (the documented operator path) rather than
# lib.sh's repo-relative `docker compose -f compose.yml ...` exec; nothing here
# starts, stops, or reconfigures the stack. Idempotent end to end: every
# create resolves its 409 through the list routes; a pinned-elsewhere
# assignment is a loud stop, not a silent re-pin; an existing issue trigger on
# the same (assignment, repository, event) is reused, never doubled.
set -uo pipefail
M4_DIR="$(cd "$(dirname "$0")" && pwd)"
export M4_PROBE=seed-github-loop
# shellcheck source=lib.sh
. "$M4_DIR/lib.sh"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/m4-seed-gh-loop.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
PROJECT_SLUG="${M4_GH_PROJECT_SLUG:-gh-loop}"
REPO_NAME="${M4_GH_REPO_NAME:-tally}"
REPO_URL="${M4_GH_REPO_URL:-https://github.com/dbirks/comms-test-repo-1.git}"
DEFAULT_BRANCH="${M4_GH_REPO_BRANCH:-main}"
PIPELINE_SLUG="${M4_GH_PIPELINE_SLUG:-issue-to-pr}"
TRIGGER_LABEL="${M4_GH_TRIGGER_LABEL:-comm:go}"
TEMPLATE="${M4_GH_TEMPLATE:-$M4_REPO_DIR/ui/src/lib/pipeline/templates/issue-to-pr.yaml.txt}"
TOKEN_FILE="${COMMUNICATION_TEST_REPO_TOKEN_FILE:-}"
declare -A JAR CSRF PROFILE_IDS
GH_TRACE_WAS_X=0; case $- in *x*) GH_TRACE_WAS_X=1 ;; esac

say()  { printf 'SEEDGH %s\n' "$*"; }
# loud <label> — the single failure funnel (seed.sh's shape): prints the
# observation verbatim, stops. It prints RESPONSE bodies only; a request body
# is never captured, which is what keeps the token out of the failure path.
loud() {
    printf 'SEEDGH FAIL %s\n' "$1"
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

# ---- json helpers (seed.sh's shapes, python3 stdlib) ------------------------
jget() { # jget <file> <dotted.path> -> raw scalar or empty, exit 1 if absent
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
jfind2() { # jfind2 <file> <list.path> <k1> <v1> <k2> <v2> <want.key> — two-key match
    python3 -c '
import json, sys
d = json.load(open(sys.argv[1]))
for part in sys.argv[2].split("."):
    d = d.get(part) if part else d
for row in d or []:
    if str(row.get(sys.argv[3])) == sys.argv[4] and str(row.get(sys.argv[5])) == sys.argv[6]:
        v = row.get(sys.argv[7])
        sys.stdout.write("" if v is None else str(v)); sys.exit(0)
sys.exit(1)
' "$1" "$2" "$3" "$4" "$5" "$6" "$7"
}
json_escape_file() { # -> {"document_yaml": "<verbatim file bytes>"} (seed.sh shape)
    python3 -c '
import json, sys
sys.stdout.write(json.dumps({"document_yaml": open(sys.argv[1], encoding="utf-8").read()}))
' "$1"
}

# ---- HTTP: seed.sh's one call shape, loud on every non-2xx -------------------
# req <user> <METHOD> <path> [json-body] — body in argv, fine for every body
# that carries NO token. Bodies that carry the secret go through req_stdin
# instead, so the token never enters this process's or curl's argv.
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
        LAST_NOTE="curl rc=$rc — cannot reach $M4_URL$path (stack down? compose.real.yml lab must be up)"
        LAST_STATUS=""
        return 2
    fi
    LAST_STATUS="${sttab%%$'\t'*}"
    LAST_NOTE="$method $path -> $sttab"
    return 0
}
# req_stdin <user> <METHOD> <path> — the mutation body arrives on STDIN and is
# handed to curl with --data-binary @- (never argv). The only call shape
# permitted for bodies built from $TOKEN_FILE.
req_stdin() {
    local user="$1" method="$2" path="$3" st sttab rc
    LAST_NOTE=""; LAST_BODY_FILE="$WORK/resp.json"; : > "$LAST_BODY_FILE"
    local -a args=(-sS --max-time 60 -o "$LAST_BODY_FILE" -w '%{http_code}\t%{content_type}')
    sttab=$(curl "${args[@]}" -b "${JAR[$user]}" -X "$method" \
                -H "Origin: $M4_URL" -H "X-CSRF-Token: ${CSRF[$user]}" \
                -H 'Content-Type: application/json' \
                --data-binary @- "$M4_URL$path")
    rc=$?
    if [ $rc -ne 0 ]; then
        LAST_NOTE="curl rc=$rc — cannot reach $M4_URL$path (body piped on stdin)"
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

# ---- login: seed.sh's exact IdP legs (mock IdP form POST -> callback ->
# /api/v1/me; cookie jar per user). `admin` is the lab's bootstrap ORG ADMIN
# (compose BOOTSTRAP_ADMIN_SUBJECTS) — the library role the draft/validate/
# publish calls need — and the project's creator, hence its maintainer, which
# is what gh-loop.sh's approval-gate decision reads.
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
        "{\"name\":\"GH Loop\",\"slug\":\"$PROJECT_SLUG\",\"description\":\"Lab proof of the real issue -> draft PR loop on dbirks/comms-test-repo-1 (docs/compatibility/probes/m4/gh-loop.sh)\"}"
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
        "{\"name\":\"$REPO_NAME\",\"git_url\":\"$REPO_URL\",\"default_branch\":\"$DEFAULT_BRANCH\"}"
    if ok 201; then REPO_ID=$(jget "$LAST_BODY_FILE" id); say "repo: $REPO_NAME -> $REPO_ID ($REPO_URL)"; return; fi
    if ok 409; then
        req admin GET "/api/v1/projects/$PROJECT_ID/repos" || loud "repo reuse: list"
        need "repo reuse: list repos" 200
        REPO_ID=$(jfind "$LAST_BODY_FILE" items name "$REPO_NAME" id) \
            || loud "repo $REPO_NAME: 409 on add but absent from the list"
        say "repo: reused existing $REPO_ID (name $REPO_NAME)"
        return
    fi
    loud "add repository $REPO_NAME (POST /projects/\$id/repos)"
}

# ---- profiles: seed.sh/seed-pi.sh's seed_profile shape, launcher claude ------
# permission_mode is lab-evidence-scoped exactly like ADR-0036's block: the
# claude launcher's preapproved-within-sandbox lab evidence
# (docs/compatibility/SANDBOX.md) is what makes these rows legal here, and
# NOTHING else (docs/compatibility/ACP.md keeps launcher pi a GAP). The upsert
# is the ONLY writer (M3 D10: no profile-write API).
seed_claude_profile() { # seed_claude_profile <name> <commit_granted>
    local name="$1" commit="$2" sql out
    sql="INSERT INTO agent_profiles (organization_id, name, launcher_id, permission_mode, workspace_mode, sandbox_enforcement, commit_granted)
         VALUES ((SELECT id FROM organizations WHERE slug = 'default'), '$name', 'claude', 'preapproved_within_sandbox', 'worktree', 'required', $commit)
         ON CONFLICT (organization_id, name) DO UPDATE SET launcher_id = EXCLUDED.launcher_id,
             permission_mode = EXCLUDED.permission_mode, workspace_mode = EXCLUDED.workspace_mode,
             sandbox_enforcement = EXCLUDED.sandbox_enforcement, commit_granted = EXCLUDED.commit_granted;
         SELECT id FROM agent_profiles WHERE organization_id = (SELECT id FROM organizations WHERE slug = 'default') AND name = '$name';"
    out=$(run_sql "$sql") || { LAST_NOTE="psql: $out"; loud "seed profile $name (sudo docker exec communication-m4-postgres-1 psql)"; }
    PROFILE_ID=$(printf '%s\n' "$out" | tail -1 | tr -d '[:space:]')
    case "$PROFILE_ID" in ""|*[!0-9a-f-]*) LAST_NOTE="psql returned [$out]"; loud "seed profile $name: no uuid back";; esac
    PROFILE_IDS[$name]="$PROFILE_ID"
    # Read the row back — the printed line is the evidence that the LAB row
    # really carries launcher claude / required / preapproved (the API cannot
    # write this mode, so the row is the fact; never take the INSERT's word).
    ROW=$(run_sql "SELECT launcher_id || '/' || sandbox_enforcement || '/' || permission_mode || '/' || workspace_mode || '/commit=' || commit_granted::text FROM agent_profiles WHERE id = '$PROFILE_ID'" | tail -1)
    [ "$ROW" = "claude/required/preapproved_within_sandbox/worktree/commit=$commit" ] \
        || loud "seed profile $name: read-back row is [$ROW], not the seeded claude/required/preapproved shape"
    say "profile: $name -> $PROFILE_ID (launcher claude, sandbox_enforcement=required, permission_mode=preapproved_within_sandbox, workspace_mode=worktree, commit_granted=$commit) readback=[$ROW]"
}

# ---- secrets (ADR-0018 write-only; ADR-0061 broker; ADR-0045 push token) -----
# Every body that carries the token is built by jq --rawfile from $TOKEN_FILE
# on a PROCESS SUBSTITUTION and handed to curl --data-binary @- — the value
# never lands in argv, a variable this script prints, or a file. It is NOT a
# `jq | req_stdin` pipe: a pipeline would run req_stdin in a subshell and its
# LAST_STATUS/LAST_BODY_FILE (the 201 it just read) would never reach the
# caller — the create would report FAIL although the secret landed. The
# guarded trace mode (never -x) is the belt to that brace.
trace_off() { set +x; }
trace_restore() { if [ "$GH_TRACE_WAS_X" = 1 ]; then set -x; fi; }
create_broker_secret() { # -> BROKER_SECRET_ID (never echoed value)
    trace_off
    req_stdin admin POST "/api/v1/projects/$PROJECT_ID/secrets" < <(
        jq -cn --arg purpose 'ADR-0061 GitHub credential for dbirks/comms-test-repo-1 (private clone/fetch + issue reads)' \
           --rawfile value "$TOKEN_FILE" \
           '{slug:"github-broker",purpose:$purpose,delivery_mode:"integration_broker",value:($value|sub("\n+$";""))}')
    trace_restore
    if ok 201; then BROKER_SECRET_ID=$(jget "$LAST_BODY_FILE" id); say "secret: github-broker created $BROKER_SECRET_ID (integration_broker; value piped, never echoed)"; return; fi
    if ok 409; then
        req admin GET "/api/v1/projects/$PROJECT_ID/secrets" || loud "broker secret reuse: list"
        need "broker secret reuse: list" 200
        BROKER_SECRET_ID=$(jfind "$LAST_BODY_FILE" secrets slug github-broker id) || loud "github-broker 409 but not in list"
        rotate_secret "$BROKER_SECRET_ID"
        say "secret: github-broker reused $BROKER_SECRET_ID (current version rotated from the token file)"
        return
    fi
    loud "create secret github-broker (POST /projects/\$id/secrets)"
}
create_push_secret() { # -> PUSH_SECRET_ID, allowlisted to claude-implementer ONLY
    trace_off
    req_stdin admin POST "/api/v1/projects/$PROJECT_ID/secrets" < <(
        jq -cn --arg purpose 'ADR-0045 agent-held GitHub push token (branch push + draft PR); claude-implementer only' \
           --arg profile "${PROFILE_IDS[claude-implementer]}" \
           --rawfile value "$TOKEN_FILE" \
           '{slug:"github-push-token",purpose:$purpose,delivery_mode:"env",allowed_agent_profile_ids:[$profile],value:($value|sub("\n+$";""))}')
    trace_restore
    if ok 201; then PUSH_SECRET_ID=$(jget "$LAST_BODY_FILE" id); say "secret: github-push-token created $PUSH_SECRET_ID (env; allowlist = claude-implementer only)"; return; fi
    if ok 409; then
        req admin GET "/api/v1/projects/$PROJECT_ID/secrets" || loud "push secret reuse: list"
        need "push secret reuse: list" 200
        PUSH_SECRET_ID=$(jfind "$LAST_BODY_FILE" secrets slug github-push-token id) || loud "github-push-token 409 but not in list"
        rotate_secret "$PUSH_SECRET_ID"
        say "secret: github-push-token reused $PUSH_SECRET_ID (current version rotated from the token file)"
        return
    fi
    loud "create secret github-push-token (POST /projects/\$id/secrets)"
}
rotate_secret() { # rotate_secret <id> — re-seed freshness: the resolver reads the CURRENT version
    trace_off
    req_stdin admin POST "/api/v1/projects/$PROJECT_ID/secrets/$1/versions" < <(
        jq -cn --rawfile value "$TOKEN_FILE" '{value:($value|sub("\n+$";""))}')
    trace_restore
    need "rotate secret $1 (POST /projects/\$id/secrets/\$secretId/versions)" 200 201
}
patch_repo_credential() { # body carries the secret ID only — the value is untouchable here
    req admin PATCH "/api/v1/projects/$PROJECT_ID/repos/$REPO_ID" \
        "{\"credential_secret_id\":\"$BROKER_SECRET_ID\"}"
    need "set repository credential (PATCH /projects/\$id/repos/\$id, ADR-0061)" 200
    CRED=$(jget "$LAST_BODY_FILE" credential || echo '?')
    [ "$CRED" = "configured" ] || loud "PATCH repo credential: response credential=[$CRED], not configured"
    say "repo $REPO_NAME: credential_secret_id -> $BROKER_SECRET_ID (credential=$CRED)"
}
create_push_mount() { # mount env GH_TOKEN lifecycle=node_attempt (seed.sh's shape)
    req admin POST "/api/v1/projects/$PROJECT_ID/secret-mounts" \
        "{\"secret_id\":\"$PUSH_SECRET_ID\",\"delivery_mode\":\"env\",\"env_name\":\"GH_TOKEN\",\"lifecycle\":\"node_attempt\"}"
    if ok 201; then MOUNT_ID=$(jget "$LAST_BODY_FILE" id); say "mount: env GH_TOKEN lifecycle=node_attempt -> $MOUNT_ID"; return; fi
    if ok 409; then
        req admin GET "/api/v1/projects/$PROJECT_ID/secret-mounts" || loud "push mount reuse: list"
        need "push mount reuse: list" 200
        MOUNT_ID=$(jfind "$LAST_BODY_FILE" secret_mounts secret_id "$PUSH_SECRET_ID" id) || MOUNT_ID=""
        [ -n "$MOUNT_ID" ] || loud "GH_TOKEN mount 409 but no resolvable mount row (GET secret-mounts)"
        say "mount: reused existing $MOUNT_ID"
        return
    fi
    loud "create GH_TOKEN secret mount (POST /projects/\$id/secret-mounts)"
}

# ---- pipeline: the template, pi profiles renamed to claude, on a temp copy ---
make_template_copy() { # -> $WORK/issue-to-pr.yaml (the product file is never edited)
    [ -s "$TEMPLATE" ] || loud "template missing at $TEMPLATE (ui/src/lib/pipeline/templates/issue-to-pr.yaml.txt)"
    sed 's/\bpi-planner\b/claude-planner/g; s/\bpi-implementer\b/claude-implementer/g' \
        "$TEMPLATE" > "$WORK/issue-to-pr.yaml" \
        || loud "sed copy of $TEMPLATE failed"
    grep -q 'profile: claude-planner' "$WORK/issue-to-pr.yaml" \
        || loud "template copy has no claude-planner profile — the sed rewrote nothing"
    grep -q 'profile: claude-implementer' "$WORK/issue-to-pr.yaml" \
        || loud "template copy has no claude-implementer profile — the sed rewrote nothing"
    say "template: $TEMPLATE -> $WORK/issue-to-pr.yaml (pi-planner -> claude-planner, pi-implementer -> claude-implementer; the product template is untouched)"
}

# seed_pipeline: draft -> validate -> publish -> assign (seed.sh's shape, all
# library calls as admin; the assignment carries repository_id=tally, ADR-0060,
# so an issue trigger on this assignment must watch the same repository).
seed_pipeline() {
    local body draft version
    req admin POST /api/v1/pipelines \
        "{\"slug\":\"$PIPELINE_SLUG\",\"display_name\":\"$PIPELINE_SLUG\",\"description\":\"issue -> draft PR loop on claude profiles (ui/src/lib/pipeline/templates/issue-to-pr.yaml.txt with pi-* renamed to the lab claude profiles)\"}"
    if ok 201; then PIPE_ID=$(jget "$LAST_BODY_FILE" id); say "pipeline: $PIPELINE_SLUG created"
    elif ok 409; then
        req admin GET /api/v1/pipelines || loud "$PIPELINE_SLUG reuse: list"
        need "$PIPELINE_SLUG reuse: list pipelines" 200
        PIPE_ID=$(jfind "$LAST_BODY_FILE" pipelines slug "$PIPELINE_SLUG" id) \
            || loud "pipeline $PIPELINE_SLUG: 409 on create but absent from the library"
        say "pipeline: reused existing $PIPELINE_SLUG"
    else
        loud "create pipeline $PIPELINE_SLUG (POST /api/v1/pipelines)"
    fi
    [ -n "${PIPE_ID:-}" ] || loud "pipeline $PIPELINE_SLUG: empty id"

    body=$(json_escape_file "$WORK/issue-to-pr.yaml") || loud "$PIPELINE_SLUG: encode document_yaml"
    req admin POST "/api/v1/pipelines/$PIPE_ID/drafts" "$body"
    need "$PIPELINE_SLUG: create draft (POST /pipelines/\$id/drafts)" 201
    draft=$(jget "$LAST_BODY_FILE" id); version=$(jget "$LAST_BODY_FILE" version)
    [ -n "$draft" ] && [ -n "$version" ] || loud "$PIPELINE_SLUG: draft create lacks id/version"
    say "pipeline $PIPELINE_SLUG: draft $draft version $version"

    req admin POST "/api/v1/drafts/$draft/validate"
    need "$PIPELINE_SLUG: validate draft (POST /drafts/\$id/validate)" 200
    if [ "$(jget "$LAST_BODY_FILE" valid)" != "true" ]; then
        LAST_NOTE="validate says valid=false; the error list is the body below (codes + locations)"
        loud "$PIPELINE_SLUG: draft did not validate"
    fi
    say "pipeline $PIPELINE_SLUG: validate OK"

    req admin POST "/api/v1/drafts/$draft/publish" "{\"version\":$version}"
    if ok 201; then
        REV_ID=$(jget "$LAST_BODY_FILE" id)
        say "pipeline $PIPELINE_SLUG: published revision $REV_ID"
    elif ok 409; then
        # seed.sh's ONE reusable publish 409: revision_already_published names
        # the live row in existing_revision_id; every other conflict is fatal.
        REV_ID=$(jget "$LAST_BODY_FILE" existing_revision_id) || REV_ID=""
        [ -n "$REV_ID" ] || { LAST_NOTE="409 without existing_revision_id is not the digest collision"; loud "$PIPELINE_SLUG: publish draft"; }
        req admin GET "/api/v1/revisions/$REV_ID" || loud "$PIPELINE_SLUG: GET existing revision"
        need "$PIPELINE_SLUG: resolve existing revision" 200
        say "pipeline $PIPELINE_SLUG: identical document already published — reusing revision $REV_ID"
    else
        loud "$PIPELINE_SLUG: publish draft (POST /drafts/\$id/publish)"
    fi
    REV_DIGEST=$(jget "$LAST_BODY_FILE" revision_digest)
    PLAN_DIGEST=$(jget "$LAST_BODY_FILE" plan_digest)
    [ -n "$REV_DIGEST" ] && [ -n "$PLAN_DIGEST" ] \
        || loud "$PIPELINE_SLUG: revision response missing revision_digest/plan_digest"
    say "pipeline $PIPELINE_SLUG: revision_digest=$REV_DIGEST plan_digest=$PLAN_DIGEST"

    req admin POST "/api/v1/projects/$PROJECT_ID/assignments" \
        "{\"pipeline_id\":\"$PIPE_ID\",\"pinned_revision_id\":\"$REV_ID\",\"repository_id\":\"$REPO_ID\",\"max_concurrent_runs\":1}"
    if ok 201; then
        ASSIGN_ID=$(jget "$LAST_BODY_FILE" id)
    elif ok 409; then
        req admin GET "/api/v1/projects/$PROJECT_ID/assignments" || loud "$PIPELINE_SLUG assignment lookup"
        need "$PIPELINE_SLUG: list assignments" 200
        ASSIGN_ID=$(jfind "$LAST_BODY_FILE" assignments pinned_revision_id "$REV_ID" id) \
            || { LAST_NOTE="an assignment for this pipeline exists pinned ELSEWHERE — re-pin deliberately (PATCH /assignments/{id}), not from the seed"
                 loud "$PIPELINE_SLUG: assignment 409 with a different pin"; }
        say "pipeline $PIPELINE_SLUG: reused existing assignment $ASSIGN_ID"
    else
        loud "$PIPELINE_SLUG: create assignment (POST /projects/\$id/assignments)"
    fi
    [ -n "${ASSIGN_ID:-}" ] || loud "$PIPELINE_SLUG: assignment id empty"
    say "assignment: $ASSIGN_ID pins $REV_ID, repository $REPO_ID ($REPO_NAME)"
}

# ---- issue trigger (ADR-0056 part 2): labeled + any-of [comm:go] -------------
# A re-seed reuses an existing trigger on (assignment, repository, labeled)
# instead of stacking duplicates; the fired runs dedupe on the
# `issue-<trigger id>-<number>` idempotency key anyway.
seed_issue_trigger() { # -> TRIGGER_ID
    local inputs
    inputs=$(jq -cn --arg repo "$REPO_NAME" \
        '{goal:"{{issue.title}}\n\n{{issue.body}}", issue_number:"{{issue.number}}", repository:$repo}') \
        || loud "issue trigger: encode template inputs (jq)"
    req admin GET "/api/v1/projects/$PROJECT_ID/issue-triggers" || loud "issue trigger reuse: list"
    need "issue trigger reuse: list" 200
    TRIGGER_ID=$(jfind2 "$LAST_BODY_FILE" issue_triggers assignment_id "$ASSIGN_ID" repository_id "$REPO_ID" id) || TRIGGER_ID=""
    if [ -n "$TRIGGER_ID" ]; then
        say "issue trigger: reused existing $TRIGGER_ID (assignment $ASSIGN_ID, repo $REPO_ID)"
        return
    fi
    req admin POST "/api/v1/projects/$PROJECT_ID/issue-triggers" \
        "{\"assignment_id\":\"$ASSIGN_ID\",\"repository_id\":\"$REPO_ID\",\"event\":\"labeled\",\"labels\":[\"$TRIGGER_LABEL\"],\"inputs\":$inputs,\"enabled\":true}"
    if ok 201; then
        TRIGGER_ID=$(jget "$LAST_BODY_FILE" id)
        say "issue trigger: created $TRIGGER_ID on $REPO_NAME (event=labeled labels=[$TRIGGER_LABEL] goal/issue_number templated, repository=$REPO_NAME)"
        return
    fi
    if ok 422 && grep -q 'expected an integer' "$LAST_BODY_FILE" 2>/dev/null; then
        LAST_NOTE="$LAST_NOTE — a typed-input refusal here would mean the lab predates de42a9f (whole-placeholder inputs render typed against a sample issue at create AND fire); rebuild the lab from ≥ de42a9f."
    fi
    loud "create issue trigger (POST /projects/\$id/issue-triggers)"
}

# ================================= main =========================================
say "seed target $M4_URL (compose project communication-m4, compose.real.yml lab; nothing else — the stack is left exactly as found)"
if ! m4_stack_up; then
    LAST_NOTE="both API replicas (${M4_API_A} ${M4_API_B}) failed /api/v1/system/readiness — the lab must be up (never rebuilt by this probe)"
    loud "stack not ready"
fi
say "readiness: both replicas 200"
[ -n "$TOKEN_FILE" ] || say "SKIP-TOKEN: COMMUNICATION_TEST_REPO_TOKEN_FILE unset — github-broker/github-push-token, the repository credential PATCH and the GH_TOKEN mount are skipped; everything local (project, repo, profiles, pipeline, assignment, issue trigger) still seeds"
[ -n "$TOKEN_FILE" ] && { [ -r "$TOKEN_FILE" ] || loud "COMMUNICATION_TEST_REPO_TOKEN_FILE names an unreadable file ($TOKEN_FILE)"; }

login admin
create_project
create_repo
seed_claude_profile claude-planner false
seed_claude_profile claude-implementer true
if [ -n "$TOKEN_FILE" ]; then
    create_broker_secret
    create_push_secret
    create_push_mount
    patch_repo_credential
fi
make_template_copy
seed_pipeline
seed_issue_trigger

say "ids: project=$PROJECT_ID repo($REPO_NAME)=$REPO_ID claude-planner=${PROFILE_IDS[claude-planner]} claude-implementer=${PROFILE_IDS[claude-implementer]} pipeline=${PIPE_ID:-} revision=${REV_ID:-} assignment=$ASSIGN_ID trigger=$TRIGGER_ID"
say "done — run: bash docs/compatibility/probes/m4/gh-loop.sh [N] (needs COMMUNICATION_TEST_REPO_TOKEN_FILE)"
