#!/usr/bin/env bash
# pi-proof.sh — driver for the pi-launcher-inside-nono lab probe (ADR-0059's
# untested cells: required-sandbox + permission behaviour of launcher `pi`;
# ADR-0036's preapproved lab exception is `claude`-only today and reverts if
# "the launcher is not claude"). Preseeds with seed-pi.sh's pieces (admin
# login, project `pi-proof`, repository `app`, the two pi profiles), then:
#   draft pi-proof.yaml -> validate (verbatim errors abort) -> publish ->
#   assignment to pi-proof pinned to this revision and scoped to repository_id
#   of `app` (ADR-0060) -> POST a run -> poll GET /api/v1/runs/{id} until
#   terminal (bounded ${M4_PI_WAIT:-1200}s / ${M4_PI_STEP:-10}s steps) ->
#   print every node's status and the agent node's outputs through the API
#   (GET /runs/{id}/nodes + /runs/{id}/nodes/{ne}), then the evidence rows by
#   SELECT-only psql: the profile row, the attempt rows (status/error_class/
#   detail), sandbox.verified / sandbox.egress_observed payloads, a best-effort
#   nono-audit host_denied grep per worker, conversation.permission.* counts
#   (preapproved should journal policy verdicts — zero rows on a launcher that
#   never prompts is itself the finding), and the turn's status/stop_reason.
# The API is used for everything it offers (auth, projects, pipelines, runs,
# nodes, attempts); psql only for evidence reads. Lab isolation § 7.0: all
# traffic through lib.sh M4_URL 18091; SQL through `sudo docker exec
# communication-m4-postgres-1` because this lab was composed from
# ~/.cache/comm-lab with compose.real.yml and the operator's docker needs sudo
# (seed-pi.sh's header has the same note). The stack is left exactly as found.
# Exit 0 whenever the probe itself could run (the run reached a terminal
# status and the evidence was read); CHECK lines carry what the evidence
# actually says — PASS only on an observed literal, never an inference.
set -uo pipefail
M4_DIR="$(cd "$(dirname "$0")" && pwd)"
export M4_PROBE=pi-proof
# shellcheck source=lib.sh
. "$M4_DIR/lib.sh"
PIPELINE_YAML="${M4_PI_PIPELINE:-$M4_DIR/pi-proof.yaml}"
[ -s "$PIPELINE_YAML" ] || { echo "PIPROOF FAIL pipeline yaml missing at $PIPELINE_YAML"; exit 1; }
WORK="$(mktemp -d "${TMPDIR:-/tmp}/m4-pi-proof.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
SLUG="${M4_PI_SLUG:-pi-proof}"
PROJECT_SLUG="${M4_PI_PROJECT_SLUG:-pi-proof}"
REPO_NAME="${M4_PI_REPO:-app}"
WAIT_TOTAL="${M4_PI_WAIT:-1200}"; WAIT_STEP="${M4_PI_STEP:-10}"
declare -A JAR CSRF
FAILS=0
say()  { printf 'PIPROOF %s\n' "$*"; }
loud() { printf 'PIPROOF FAIL %s\n' "$1"
    [ -n "${LAST_NOTE:-}" ] && printf '      %s\n' "$LAST_NOTE"
    if [ -n "${LAST_BODY_FILE:-}" ] && [ -s "${LAST_BODY_FILE}" ]; then
        awk 1 "${LAST_BODY_FILE}" | head -c 1200 | sed 's/^/      /'; fi
    exit 1; }
# sql helper: the operator's documented read path against the RUNNING lab.
run_sql() {
    sudo docker exec communication-m4-postgres-1 psql -U communication \
        -d communication -tAqc "$1" 2>&1
}
jget() { # jget <file> <dotted.path> — raw scalar; exit 1 if absent/null
    python3 -c '
import json, sys
d = json.load(open(sys.argv[1]))
for k in sys.argv[2].split("."):
    d = d[int(k)] if isinstance(d, list) else d[k]
    if d is None: sys.exit(1)
sys.stdout.write(d if isinstance(d, str) else json.dumps(d) if isinstance(d, (dict, list, bool)) else str(d))
' "$1" "$2" 2>/dev/null
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
json_escape_file() { # -> {"document_yaml": "<verbatim file bytes>"} (seed.sh shape)
    python3 -c '
import json, sys
sys.stdout.write(json.dumps({"document_yaml": open(sys.argv[1], encoding="utf-8").read()}))
' "$1"
}
LAST_STATUS="" LAST_BODY_FILE="" LAST_NOTE=""
req() { # req <user> <METHOD> <path> [json] — seed.sh's shape; never prints bodies/cookies
    local user="$1" method="$2" path="$3" body="${4:-}" sttab rc
    LAST_NOTE=""; LAST_BODY_FILE="$WORK/resp.json"; : > "$LAST_BODY_FILE"
    local -a args=(-sS --max-time 60 -o "$LAST_BODY_FILE" -w '%{http_code}\t%{content_type}')
    if [ "$method" = GET ]; then
        sttab=$(curl "${args[@]}" -b "${JAR[$user]}" "$M4_URL$path")
    else
        sttab=$(curl "${args[@]}" -b "${JAR[$user]}" -X "$method" -H "Origin: $M4_URL" \
                    -H "X-CSRF-Token: ${CSRF[$user]}" -H 'Content-Type: application/json' \
                    ${body:+-d "$body"} "$M4_URL$path")
    fi
    rc=$?
    if [ $rc -ne 0 ]; then LAST_NOTE="curl rc=$rc reaching $M4_URL$path"; LAST_STATUS=""; return 2; fi
    LAST_STATUS="${sttab%%$'\t'*}"; LAST_NOTE="$method $path -> $sttab"; return 0
}
ok()   { [ "$LAST_STATUS" = "$1" ]; }
need() { local label="$1" s; shift
    for s in "$@"; do [ "$LAST_STATUS" = "$s" ] && return 0; done
    loud "$label — allowed=[$*] got=[$LAST_STATUS] ($LAST_NOTE)"; }
login() { # login <user> — seed.sh's IdP legs (m4_login alone has no loud legs)
    local user="$1" loc form cb me
    JAR[$user]="$(m4_jar "$user")"; mkdir -p "$(dirname "${JAR[$user]}")"; rm -f "${JAR[$user]}"
    LAST_BODY_FILE="$WORK/login-$user.body"
    loc=$(curl -sS --max-time 30 -c "${JAR[$user]}" -o "$LAST_BODY_FILE" -w '%{redirect_url}' \
              "$M4_URL/auth/login?return_to=/projects" 2>"$WORK/curl.err") \
        || { LAST_NOTE="curl: $(m4_oneline < "$WORK/curl.err")"; loud "login($user): GET /auth/login unreachable"; }
    [ -n "$loc" ] || loud "login($user): /auth/login did not redirect"
    form=$(curl -sS --max-time 30 -b "${JAR[$user]}" -c "${JAR[$user]}" "$loc" 2>"$WORK/curl.err") \
        || { LAST_NOTE="curl: $(m4_oneline < "$WORK/curl.err")"; loud "login($user): GET IdP form $loc"; }
    case "$form" in *'name="username"'*) ;; *) loud "login($user): no username field at $loc" ;; esac
    cb=$(curl -sS --max-time 30 -b "${JAR[$user]}" -c "${JAR[$user]}" -o "$LAST_BODY_FILE" \
            -w '%{redirect_url}' -d "username=$user" \
            --data-urlencode "claims={\"email\":\"$user@example.test\"}" "$loc" 2>"$WORK/curl.err") \
        || { LAST_NOTE="curl: $(m4_oneline < "$WORK/curl.err")"; loud "login($user): POST IdP form"; }
    [ -n "$cb" ] || loud "login($user): IdP POST did not redirect to the callback"
    curl -sSL --max-time 30 -b "${JAR[$user]}" -c "${JAR[$user]}" -o /dev/null "$cb" 2>"$WORK/curl.err" \
        || { LAST_NOTE="curl: $(m4_oneline < "$WORK/curl.err")"; loud "login($user): follow callback $cb"; }
    req "$user" GET /api/v1/me || loud "login($user): GET /api/v1/me unreachable"
    need "login($user): signed-in principal" 200
    me="$LAST_BODY_FILE"
    CSRF[$user]="$(jget "$me" csrf_token)" || loud "login($user): no csrf_token"
    say "login($user): signed in (jar ${JAR[$user]##*/})"
}

m4_env_header
m4_stack_up || loud "stack not up: both API replicas must answer /api/v1/system/readiness (§ 7.0; never rebuild/down the lab)"

# ---- 0. the seed (seed-pi.sh's objects, created here if absent so the driver
# is self-sufficient; identical SQL upsert and identical API fallbacks) ----
login admin
req admin GET /api/v1/projects || loud "list projects"
need "list projects" 200
PROJECT_ID=$(jfind "$LAST_BODY_FILE" items slug "$PROJECT_SLUG" id) || PROJECT_ID=""
if [ -z "$PROJECT_ID" ]; then
    say "project $PROJECT_SLUG absent — running seed-pi.sh first"
    bash "$M4_DIR/seed-pi.sh" || loud "seed-pi.sh failed"
    req admin GET /api/v1/projects || loud "list projects (after seed)"
    need "list projects (after seed)" 200
    PROJECT_ID=$(jfind "$LAST_BODY_FILE" items slug "$PROJECT_SLUG" id) \
        || loud "project $PROJECT_SLUG: still absent after seed-pi.sh"
fi
say "project: $PROJECT_ID (slug $PROJECT_SLUG)"
req admin GET "/api/v1/projects/$PROJECT_ID/repos" || loud "list repos"
need "list repos" 200
REPO_ID=$(jfind "$LAST_BODY_FILE" items name "$REPO_NAME" id) \
    || loud "repository $REPO_NAME missing on $PROJECT_SLUG (seed-pi.sh should have created it)"
say "repo: $REPO_NAME -> $REPO_ID"
# The two pi profiles must exist; if the seed was never run the assignment /
# node would die anonymously at the worker, so fail here with the fix named.
NPI=$(run_sql "SELECT count(*) FROM agent_profiles p JOIN organizations o ON o.id = p.organization_id WHERE o.slug = 'default' AND p.name IN ('pi-planner','pi-implementer') AND p.launcher_id = 'pi';" | tail -1 | tr -d '[:space:]')
[ "$NPI" = "2" ] || loud "pi profiles: found $NPI/2 (run: bash docs/compatibility/probes/m4/seed-pi.sh)"
PROFILE_ROW=$(run_sql "SELECT launcher_id || '/' || sandbox_enforcement || '/' || permission_mode FROM agent_profiles WHERE name = 'pi-implementer' AND organization_id = (SELECT id FROM organizations WHERE slug = 'default')" | tail -1)
say "profile pi-implementer row: $PROFILE_ROW"

# ---- 1. pipeline: create -> draft -> validate -> publish (library role = admin) ----
req admin POST /api/v1/pipelines \
    "{\"slug\":\"$SLUG\",\"display_name\":\"$SLUG\",\"description\":\"pi launcher inside nono (docs/compatibility/probes/m4/pi-proof.yaml)\"}"
if ok 201 || ok 409; then
    if ok 201; then PIPE_ID=$(jget "$LAST_BODY_FILE" id); say "pipeline: $SLUG created"
    else
        req admin GET /api/v1/pipelines || loud "$SLUG reuse: list"
        need "$SLUG reuse: list pipelines" 200
        PIPE_ID=$(jfind "$LAST_BODY_FILE" pipelines slug "$SLUG" id) \
            || loud "pipeline $SLUG: 409 on create but absent from the library"
        say "pipeline: reused existing $SLUG"
    fi
else
    loud "create pipeline $SLUG (POST /api/v1/pipelines)"
fi
[ -n "${PIPE_ID:-}" ] || loud "pipeline $SLUG: empty id"

body=$(json_escape_file "$PIPELINE_YAML") || loud "$SLUG: encode document_yaml"
req admin POST "/api/v1/pipelines/$PIPE_ID/drafts" "$body"
need "$SLUG: create draft (POST /pipelines/\$id/drafts)" 201
draft=$(jget "$LAST_BODY_FILE" id); version=$(jget "$LAST_BODY_FILE" version)
[ -n "$draft" ] && [ -n "$version" ] || loud "$SLUG: draft create lacks id/version"
say "pipeline $SLUG: draft $draft version $version"

req admin POST "/api/v1/drafts/$draft/validate"
need "$SLUG: validate draft (POST /drafts/\$id/validate)" 200
if [ "$(jget "$LAST_BODY_FILE" valid)" != "true" ]; then
    LAST_NOTE="validate says valid=false; the findings are the body below (codes + locations)"
    loud "$SLUG: draft did not validate"
fi
say "pipeline $SLUG: validate OK"

req admin POST "/api/v1/drafts/$draft/publish" "{\"version\":$version}"
if ok 201; then
    REV_ID=$(jget "$LAST_BODY_FILE" id)
    say "pipeline $SLUG: published revision $REV_ID"
elif ok 409; then
    # seed.sh's ONE reusable publish 409: revision_already_published names the
    # live row in existing_revision_id; every other publish conflict is fatal.
    REV_ID=$(jget "$LAST_BODY_FILE" existing_revision_id) || REV_ID=""
    [ -n "$REV_ID" ] || { LAST_NOTE="409 without existing_revision_id is not the digest collision"; loud "$SLUG: publish draft"; }
    req admin GET "/api/v1/revisions/$REV_ID" || loud "$SLUG: GET existing revision"
    need "$SLUG: resolve existing revision" 200
    say "pipeline $SLUG: identical document already published — reusing revision $REV_ID"
else
    loud "$SLUG: publish draft (POST /drafts/\$id/publish)"
fi
REV_DIGEST=$(jget "$LAST_BODY_FILE" revision_digest)
PLAN_DIGEST=$(jget "$LAST_BODY_FILE" plan_digest)
[ -n "$REV_DIGEST" ] && [ -n "$PLAN_DIGEST" ] \
    || loud "$SLUG: revision response missing revision_digest/plan_digest"
say "pipeline $SLUG: revision_digest=${REV_DIGEST} plan_digest=${PLAN_DIGEST}"

# ---- 2. assignment (project-scoped; admin created the project so admin is
# its maintainer). repository_id scopes it to `app` (ADR-0060). ----
req admin POST "/api/v1/projects/$PROJECT_ID/assignments" \
    "{\"pipeline_id\":\"$PIPE_ID\",\"pinned_revision_id\":\"$REV_ID\",\"repository_id\":\"$REPO_ID\",\"max_concurrent_runs\":1}"
if ok 201; then
    ASSIGN_ID=$(jget "$LAST_BODY_FILE" id)
elif ok 409; then
    req admin GET "/api/v1/projects/$PROJECT_ID/assignments" || loud "$SLUG assignment lookup"
    need "$SLUG: list assignments" 200
    ASSIGN_ID=$(jfind "$LAST_BODY_FILE" assignments pinned_revision_id "$REV_ID" id) \
        || { LAST_NOTE="an assignment for this pipeline exists pinned ELSEWHERE — re-pin deliberately, not from this probe"
             loud "$SLUG: assignment 409 with a different pin"; }
    say "pipeline $SLUG: reused existing assignment $ASSIGN_ID"
else
    loud "$SLUG: create assignment (POST /projects/\$id/assignments)"
fi
[ -n "${ASSIGN_ID:-}" ] || loud "$SLUG: assignment id empty"
say "assignment: $ASSIGN_ID pins $REV_ID, repository $REPO_ID"

# ---- 3. the run + bounded poll to terminal (20 min default) ----
IDEM="pi-proof-$(date -u +%Y%m%d%H%M%S)"
req admin POST "/api/v1/projects/$PROJECT_ID/runs" \
    "{\"assignment_id\":\"$ASSIGN_ID\",\"inputs\":{\"repository\":\"$REPO_NAME\"},\"idempotency\":\"$IDEM\"}"
need "POST /projects/\$id/runs" 201 200
RUN_ID=$(jget "$LAST_BODY_FILE" run_id)
[ -n "$RUN_ID" ] || loud "run create response has no run_id"
say "run: $RUN_ID status=$(jget "$LAST_BODY_FILE" status) (idempotency $IDEM)"

ST=""
END=$(( $(date +%s) + WAIT_TOTAL ))
while :; do
    req admin GET "/api/v1/runs/$RUN_ID" || loud "poll GET /runs/\$id"
    need "poll GET /runs/\$id" 200
    ST=$(jget "$LAST_BODY_FILE" status || true); ST="${ST:-?}"
    say "run: $ST (bound ${WAIT_TOTAL}s, step ${WAIT_STEP}s)"
    case "$ST" in completed|failed|cancelled|interrupted) break ;; esac
    [ "$(date +%s)" -lt "$END" ] || loud "run still $ST after ${WAIT_TOTAL}s — not terminal inside the probe window; nothing below would be final evidence"
    sleep "$WAIT_STEP"
done
check RUN-TERMINAL PASS "run $RUN_ID reached terminal status $ST"

# ---- 4. node statuses + the agent node's outputs, through the API ----
req admin GET "/api/v1/runs/$RUN_ID/nodes" || loud "GET /runs/\$id/nodes"
need "list run nodes" 200
cp "$LAST_BODY_FILE" "$WORK/nodes.json"
python3 - "$WORK/nodes.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
for n in d["node_executions"]:
    print(f"NODE {n['node_id']} kind={n['kind']} status={n['status']} error_class={n.get('error_class') or '-'} outcome={n.get('outcome') or '-'}")
edit = next((n for n in d["node_executions"] if n["node_id"] == "edit"), None)
diff = next((n for n in d["node_executions"] if n["node_id"] == "diffstat"), None)
if edit is not None:
    print("AGENT-NODE-OUTPUTS", json.dumps(edit.get("outputs") or {}, sort_keys=True))
if diff is not None:
    o = diff.get("outputs") or {}
    print("DIFFSTAT", f"exit_code={o.get('exit_code')}", "stdout_preview=" + repr(o.get("stdout_preview", ""))[:400])
    print("EDIT_NODE_ID", edit["id"] if edit else "")
PY
EDIT_NEID=$(python3 -c '
import json,sys
d=json.load(open(sys.argv[1]))
print(next((n["id"] for n in d["node_executions"] if n["node_id"]=="edit"),""))
' "$WORK/nodes.json")
EDIT_STATUS=$(python3 -c '
import json,sys
d=json.load(open(sys.argv[1]))
print(next((n["status"] for n in d["node_executions"] if n["node_id"]=="edit"),"?"))
' "$WORK/nodes.json")
case "$EDIT_STATUS" in
    succeeded) check EDIT-NODE PASS "agent.acp node edit succeeded" ;;
    failed)    check EDIT-NODE FAIL "agent.acp node edit FAILED — attempt detail below carries the observed refusal/failure" ;;
    *)         check EDIT-NODE GAP "agent.acp node edit ended status=$EDIT_STATUS" ;;
esac
# Full attempt history of the agent node through the API (append-only —
# GET /runs/{id}/nodes/{nodeExecutionId}).
if [ -n "$EDIT_NEID" ]; then
    req admin GET "/api/v1/runs/$RUN_ID/nodes/$EDIT_NEID" || loud "GET run node detail"
    need "get run node (edit)" 200
    cp "$LAST_BODY_FILE" "$WORK/node-edit.json"
    python3 - "$WORK/node-edit.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
for a in d.get("attempts", []):
    det = (a.get("detail") or "").replace("\n", " ")
    print(f"ATTEMPT {a.get('id')} n={a.get('attempt_number')} status={a.get('status')} error_class={a.get('error_class') or '-'} detail={det[:400]}")
    oerrs = a.get("output_errors")
    if oerrs: print(f"  output_errors={json.dumps(oerrs)[:400]}")
PY
fi

# ---- 5. evidence rows (SELECT only). ------------------------------------------
# e1. the attempt rows the scheduler recorded (status / class / verbatim detail
#     is where a fail-closed refusal or an adapter fault lands).
ATTEMPTS=$(run_sql "SELECT a.id || '|' || a.node_execution_id || '|' || a.attempt_number || '|' || a.status || '|' || COALESCE(a.error_class,'-') || '|' || COALESCE(LEFT(a.detail,300),'') FROM attempts a WHERE a.run_id = '$RUN_ID' ORDER BY a.created_at")
say "attempt rows:"
printf '%s\n' "$ATTEMPTS" | sed 's/^/      A /'
# e2. the attempt's sandbox profile/enforcement rows: the profile row it ran
# under, plus the run's own sandbox.verified / sandbox.egress_observed journal
# payloads (grants, backend+version, network label, policy digest).
say "profile row (agent_profiles):"
run_sql "SELECT name || ' launcher=' || launcher_id || ' sandbox=' || sandbox_enforcement || ' permission=' || permission_mode || ' workspace=' || workspace_mode || ' commit=' || commit_granted::text FROM agent_profiles WHERE name IN ('pi-planner','pi-implementer') ORDER BY name" | sed 's/^/      P /'
SANDBOX_EVENTS=$(run_sql "SELECT global_seq || ' ' || type || ' ' || payload::text FROM domain_events WHERE run_id = '$RUN_ID' AND type IN ('sandbox.verified','sandbox.egress_observed') ORDER BY global_seq")
if [ -n "$SANDBOX_EVENTS" ]; then
    say "sandbox journal rows for the run:"
    printf '%s\n' "$SANDBOX_EVENTS" | sed 's/^/      S /'
    check SANDBOX-VERIFIED PASS "sandbox.verified rows=$(printf '%s\n' "$SANDBOX_EVENTS" | grep -c 'sandbox.verified')"
else
    check SANDBOX-VERIFIED GAP "no sandbox.verified / sandbox.egress_observed rows for this run — the attempt never reached sandbox verification (see attempt detail above)"
fi
# host_denied audit rows: sandbox.egress_observed.denied_hosts carries the
# earned label (ADR-0035 design A); nono's own journal is the verbatim source
# — best-effort grep of both worker containers for this run's denied lines.
DENIED=$(run_sql "SELECT count(*) FROM domain_events WHERE run_id = '$RUN_ID' AND type = 'sandbox.egress_observed' AND payload::text LIKE '%host_denied%'" | tail -1 | tr -d '[:space:]')
EGRESS_ROWS=$(run_sql "SELECT count(*) FROM domain_events WHERE run_id = '$RUN_ID' AND type = 'sandbox.egress_observed'" | tail -1 | tr -d '[:space:]')
note EGRESS-EVENTS "sandbox.egress_observed rows=$EGRESS_ROWS host_denied-carrying rows=$DENIED"
for w in worker-a worker-b; do
    AUDIT=$(sudo docker exec "communication-m4-$w-1" bash -lc '
        HOME=/sandbox-home nono audit list --json 2>/dev/null | tr -d "\n" | grep -o "[0-9a-f]\{16\}" | while read -r s; do
            HOME=/sandbox-home nono audit show "$s" --json 2>/dev/null | grep -o "\"target\":\"example.com\"[^}]*\|\"decision\":\"deny\",\"denial_category\":\"host_denied\",\"target\":\"[^\"]*\"" | head -3 | sed "s/^/SESSION $s /"
        done' 2>/dev/null | head -10)
    [ -n "$AUDIT" ] && { say "nono audit deny lines ($w, lab-wide — attribute by session before quoting):"; printf '%s\n' "$AUDIT" | sed "s/^/      N /"; }
done
# e3. permission journal: conversation.permission.* rows for the run and the
# permission_requests durable rows for the attempt's conversation. Under
# preapproved the pipeline-attempt path journals requested+decided pairs *for
# launchers that prompt* (ADR-0036 addendum, claude only so far); zero rows is
# either "launcher never prompted" or "no prompt mode → failed closed" — the
# attempt detail above says which.
NPERM=$(run_sql "SELECT count(*) FROM domain_events WHERE run_id = '$RUN_ID' AND type LIKE '%permission%'" | tail -1 | tr -d '[:space:]')
NPREQ=$(run_sql "SELECT count(*) FROM permission_requests pr WHERE pr.conversation_id IN (SELECT DISTINCT conversation_id FROM attempts WHERE run_id = '$RUN_ID' AND conversation_id IS NOT NULL)" | tail -1 | tr -d '[:space:]')
check PERMISSION-ROWS GAP "conversation.permission.* domain_events for the run=$NPERM permission_requests rows=$NPREQ — expected 0 if the launcher never reached a prompting mode; read with the attempt detail above"
if [ "${NPERM:-0}" -gt 0 ]; then
    run_sql "SELECT global_seq || ' ' || type || ' ' || LEFT(payload::text, 240) FROM domain_events WHERE run_id = '$RUN_ID' AND type LIKE '%permission%' ORDER BY global_seq" | sed 's/^/      X /'
fi
# e4. the turn's status + stop reason (end_turn is the completing shape; none
#     at all means no turn ever ran).
TURN=$(run_sql "SELECT a.id || '|' || COALESCE(t.status,'no-turn') || '|' || COALESCE(t.stop_reason,'-') FROM attempts a LEFT JOIN conversation_turns t ON t.id = a.turn_id WHERE a.run_id = '$RUN_ID' ORDER BY a.created_at" | tail -1)
say "turn row: $TURN"
STOP=$(printf '%s' "$TURN" | awk -F'|' '{print $3}')
if [ "$STOP" = "end_turn" ]; then check TURN-STOP PASS "stop_reason=end_turn"; else check TURN-STOP FAIL "stop_reason=$STOP"; fi

say "done — run $RUN_ID terminal status $ST; the CHECK lines above are the whole verdict set (PASS only on observed literals)"
exit 0
