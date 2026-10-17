#!/usr/bin/env bash
# home_sample_probe.sh — live evidence that docs/samples/home/plan-with-approval.yaml
# runs end to end in the M4 lab: survey (process.exec) -> plan (model.chat,
# qwen3-8-27b through the worker's LLM collective) -> approve (human.approval,
# maintainer) -> publish_plan (artifact.publish). No agent.acp node, so the home
# worker needs no ACP harness credentials (docs/samples/home/README.md).
#   bash docs/compatibility/probes/m4/home_sample_probe.sh   # needs the M4 lab stack up
# The sample's `repository` input is the project's repository BINDING name (07:
# repositories are project bindings), not a URL: the probe reads it with a
# SELECT on repositories for the seeded project m4-exit (seed.sh seeds `app`
# -> file:///srv/m4/fixtures/app.git), never a hardcoded URL.
# Flow: admin (the bootstrap org admin, the only identity holding the pipeline
# library role — seed.sh's rule) creates pipeline slug plan-with-approval,
# drafts the sample YAML VERBATIM (seed.sh's json_escape_file shape), validates
# it (must come back valid=true), publishes revision r1 — a byte-identical
# re-draft reuses the live revision through revision_already_published's
# existing_revision_id — captures BOTH digests (revision_digest + plan_digest
# ride the revision row, not the validate body) and assigns the pinned
# revision to the project as alice; alice starts a run with inputs
# {goal, repository} and the probe polls GET /runs/{id} (bounded 600 s / 5 s
# steps) until the run reaches waiting_human at the sample's approval gate;
# alice — the seeded project's creator, i.e. its maintainer, and the only role
# the gate names (approverRoles: [maintainer]) — decides approved with the
# gate's CAS version (POST /approvals/{id}/decide); the probe polls to
# terminal and reads the journal (SELECT only, through lib.sh run_sql).
# Verdicts, each an observed literal (AGENTS.md): a. the run reached the
# approval gate (an approval.requested journal row names /approve and a
# run.waiting_human row exists); b. the model.chat plan node SUCCEEDED with a
# non-empty outputs.text (its first 200 chars are printed); c. the gate was
# decided by alice (approval_requests: state=decided, decision=approved,
# decided_by=alice's user id) and the journal's approval.decided agrees;
# d. the run completed (runs.status=completed and a run.completed journal
# row); e. every node execution succeeded and every one of the run's attempts
# succeeded (the approval settles on the control plane and creates no
# attempt — ADR-0023 § 3 — so its zero-attempt success is expected);
# f. the run's journal opens with run.created and closes with run.completed
# in global_seq order. § 7.0: all through lib.sh (M4_URL 18091, M4_COMPOSE
# communication-m4). No cookie, header or secret body is ever printed.
# Exit 0 only if every verdict passed.
set -uo pipefail
M4_DIR="$(cd "$(dirname "$0")" && pwd)"
export M4_PROBE=home-sample
# shellcheck source=lib.sh
. "$M4_DIR/lib.sh"
REPO_YAML="${M4_HOME_SAMPLE_YAML:-$M4_DIR/../../../samples/home/plan-with-approval.yaml}"
[ -s "$REPO_YAML" ] || { echo "HOMESAMPLE FAIL sample yaml missing at $REPO_YAML"; exit 1; }
WORK="$(mktemp -d "${TMPDIR:-/tmp}/m4-home-sample.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
TAG="HOMESAMPLE"
SLUG="${M4_HOME_SLUG:-plan-with-approval}"
PROJECT_SLUG="${M4_HOME_PROJECT_SLUG:-m4-exit}"
GOAL="${M4_HOME_GOAL:-Draft a plan to add a documented health-check endpoint to the app repository}"
WAIT_TOTAL="${M4_HOME_WAIT:-600}"; WAIT_STEP="${M4_HOME_STEP:-5}"
declare -A JAR CSRF
FAILS=0
say()  { printf '%s %s\n' "$TAG" "$*"; }
loud() { printf '%s FAIL %s\n' "$TAG" "$1"
    [ -n "${LAST_NOTE:-}" ] && printf '      %s\n' "$LAST_NOTE"
    if [ -n "${LAST_BODY_FILE:-}" ] && [ -s "${LAST_BODY_FILE}" ]; then
        awk 1 "${LAST_BODY_FILE}" | head -c 1200 | sed 's/^/      /'; fi
    exit 1; }
verdict() { if [ "$1" = PASS ]; then printf 'PASS %s — %s\n' "$2" "$3"
    else printf 'FAIL %s — %s\n' "$2" "$3"; FAILS=$((FAILS+1)); fi; }
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
json_escape_file() { # -> a JSON object {"document_yaml": "<verbatim file bytes>"}
    python3 -c '
import json, sys
sys.stdout.write(json.dumps({"document_yaml": open(sys.argv[1], encoding="utf-8").read()}))
' "$1"
}
# req <user> <METHOD> <path> [json] — sets LAST_STATUS/LAST_BODY_FILE; LAST_NOTE is
# method+path+status+content-type only (never a header, cookie or body).
LAST_STATUS="" LAST_BODY_FILE="" LAST_NOTE=""
req() {
    local user="$1" method="$2" path="$3" body="${4:-}" sttab rc
    LAST_NOTE=""; LAST_BODY_FILE="$WORK/resp.json"; : > "$LAST_BODY_FILE"
    local -a args=(-sS --max-time 60 -o "$LAST_BODY_FILE" -w '%{http_code} %{content_type}')
    if [ "$method" = GET ]; then
        sttab=$(curl "${args[@]}" -b "${JAR[$user]}" "$M4_URL$path")
    else
        sttab=$(curl "${args[@]}" -b "${JAR[$user]}" -X "$method" -H "Origin: $M4_URL" \
                    -H "X-CSRF-Token: ${CSRF[$user]}" -H 'Content-Type: application/json' \
                    ${body:+-d "$body"} "$M4_URL$path")
    fi
    rc=$?
    if [ $rc -ne 0 ]; then LAST_NOTE="curl rc=$rc reaching $M4_URL$path"; LAST_STATUS=""; return 2; fi
    LAST_STATUS="${sttab%% *}"; LAST_NOTE="$method $path -> $sttab"; return 0
}
ok()   { [ "$LAST_STATUS" = "$1" ]; }
need() { local label="$1" s; shift
    for s in "$@"; do [ "$LAST_STATUS" = "$s" ] && return 0; done
    loud "$label — allowed=[$*] got=[$LAST_STATUS] ($LAST_NOTE)"; }
login() { # login <user> — lib.sh m4_login's IdP legs, then the CSRF token
    local user="$1" me
    JAR[$user]="$(m4_jar "$user")"; mkdir -p "$(dirname "${JAR[$user]}")"; rm -f "${JAR[$user]}"
    me="$(m4_login "$user")" || true
    [ -n "$me" ] || loud "login($user): the IdP round-trip returned no /api/v1/me body"
    printf '%s' "$me" > "$WORK/me-$user.json"
    CSRF[$user]="$(jget "$WORK/me-$user.json" csrf_token)" || loud "login($user): no csrf_token"
    say "login($user): signed in (jar ${JAR[$user]##*/})"
}

m4_env_header
m4_stack_up || loud "stack not up: both API replicas must answer /api/v1/system/readiness (§ 7.0)"
login admin
login alice
ALICE_ID=$(jget "$WORK/me-alice.json" id) || loud "login(alice): /api/v1/me body has no id"

# 1. the seeded project and its repository binding name. The sample's
#    `repository` input is a binding NAME (07), read here from repositories
#    — seed.sh seeds exactly one binding for m4-exit (`app`).
PROJECT_ID=$(run_sql "SELECT id FROM projects WHERE slug = '$PROJECT_SLUG'" | tail -1 | tr -d '[:space:]')
case "$PROJECT_ID" in *[!0-9a-f-]*|"") loud "project $PROJECT_SLUG: no id (run seed.sh first)";; esac
REPO_BINDING=$(run_sql "SELECT r.name FROM repositories r WHERE r.project_id = '$PROJECT_ID' ORDER BY r.created_at LIMIT 1" | tail -1 | tr -d '[:space:]')
[ -n "$REPO_BINDING" ] || loud "project $PROJECT_SLUG: no repository binding (SELECT on repositories)"
ALICE_ROLE=$(run_sql "SELECT m.role FROM memberships m WHERE m.project_id = '$PROJECT_ID' AND m.user_id = '$ALICE_ID'" | tail -1 | tr -d '[:space:]')
say "project $PROJECT_SLUG: repo binding $REPO_BINDING, alice's role $ALICE_ROLE (the gate names approverRoles [maintainer])"

# 2. the pipeline: draft -> validate -> publish -> assign. Library calls run as
#    admin (the only library-role identity, seed.sh's rule); the assignment is
#    project-scoped and runs as alice. Same call shapes as seed.sh.
req admin POST /api/v1/pipelines \
    "{\"slug\":\"$SLUG\",\"display_name\":\"$SLUG\",\"description\":\"Home-cluster sample (docs/samples/home/plan-with-approval.yaml)\"}"
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

body=$(json_escape_file "$REPO_YAML") || loud "$SLUG: encode document_yaml"
req admin POST "/api/v1/pipelines/$PIPE_ID/drafts" "$body"
need "$SLUG: create draft (POST /pipelines/\$id/drafts)" 201
draft=$(jget "$LAST_BODY_FILE" id); version=$(jget "$LAST_BODY_FILE" version)
[ -n "$draft" ] && [ -n "$version" ] || loud "$SLUG: draft create lacks id/version"
say "pipeline $SLUG: draft $draft version $version"

req admin POST "/api/v1/drafts/$draft/validate"
need "$SLUG: validate draft (POST /drafts/\$id/validate)" 200
[ "$(jget "$LAST_BODY_FILE" valid)" = "true" ] \
    || { LAST_NOTE="validate says valid=false; the error list is the body above (codes + locations)"; loud "$SLUG: draft did not validate"; }
say "pipeline $SLUG: validate OK valid=$(jget "$LAST_BODY_FILE" valid) digest_scope=$(jget "$LAST_BODY_FILE" digest_scope) errors=$(jget "$LAST_BODY_FILE" errors)"

req admin POST "/api/v1/drafts/$draft/publish" "{\"version\":$version}"
if ok 201; then
    REV_ID=$(jget "$LAST_BODY_FILE" id)
    say "pipeline $SLUG: published revision $REV_ID"
elif ok 409; then
    # seed.sh's one reusable publish 409: revision_already_published names the
    # live row in existing_revision_id; every other 409 is fatal.
    REV_ID=$(jget "$LAST_BODY_FILE" existing_revision_id) || REV_ID=""
    [ -n "$REV_ID" ] || { LAST_NOTE="409 without existing_revision_id is not the digest collision"; loud "$SLUG: publish draft"; }
    req admin GET "/api/v1/revisions/$REV_ID" || loud "$SLUG: GET existing revision"
    need "$SLUG: resolve existing revision" 200
    say "pipeline $SLUG: identical document already published — reusing revision $REV_ID"
else
    loud "$SLUG: publish draft (POST /drafts/\$id/publish)"
fi
REV_NUM=$(jget "$LAST_BODY_FILE" revision_number)
REV_DIGEST=$(jget "$LAST_BODY_FILE" revision_digest)
PLAN_DIGEST=$(jget "$LAST_BODY_FILE" plan_digest)
[ -n "$REV_DIGEST" ] && [ -n "$PLAN_DIGEST" ] \
    || loud "$SLUG: revision response missing revision_digest/plan_digest (both digests required)"
say "pipeline $SLUG: revision ${REV_NUM} revision_digest=${REV_DIGEST}"
say "pipeline $SLUG: plan_digest=${PLAN_DIGEST}"

req alice POST "/api/v1/projects/$PROJECT_ID/assignments" \
    "{\"pipeline_id\":\"$PIPE_ID\",\"pinned_revision_id\":\"$REV_ID\",\"max_concurrent_runs\":3}"
if ok 201; then
    ASSIGN_ID=$(jget "$LAST_BODY_FILE" id)
elif ok 409; then
    req alice GET "/api/v1/projects/$PROJECT_ID/assignments" || loud "$SLUG assignment lookup"
    need "$SLUG: list assignments" 200
    ASSIGN_ID=$(jfind "$LAST_BODY_FILE" assignments pinned_revision_id "$REV_ID" id) \
        || { LAST_NOTE="an assignment for this pipeline exists pinned ELSEWHERE — re-pin deliberately (PATCH /assignments/{id}), not from this probe"
             loud "$SLUG: assignment 409 with a different pin"; }
    say "pipeline $SLUG: reused existing assignment $ASSIGN_ID"
else
    loud "$SLUG: create assignment (POST /projects/\$id/assignments)"
fi
[ -n "${ASSIGN_ID:-}" ] || loud "$SLUG: assignment id empty"
say "assignment: $ASSIGN_ID pins revision $REV_ID"

# 3. the run: alice starts it with the sample's two declared inputs and a
#    fresh idempotency key (ADR-0023 § 12), then the probe polls to the gate.
IDEM="home-sample-$(date -u +%Y%m%d%H%M%S)"
req alice POST "/api/v1/projects/$PROJECT_ID/runs" \
    "{\"assignment_id\":\"$ASSIGN_ID\",\"inputs\":{\"goal\":\"$GOAL\",\"repository\":\"$REPO_BINDING\"},\"idempotency\":\"$IDEM\"}"
need "POST /projects/\$id/runs" 201 200
RUN_ID=$(jget "$LAST_BODY_FILE" run_id)
[ -n "$RUN_ID" ] || loud "run create response has no run_id"
say "run: $RUN_ID status=$(jget "$LAST_BODY_FILE" status) (idempotency $IDEM)"

# Bounded wait for the approval gate: waiting_human is the run's gate state;
# a terminal status before that is evidence the gate was never reached.
REACHED_GATE=0
END=$(( $(date +%s) + WAIT_TOTAL ))
while :; do
    req alice GET "/api/v1/runs/$RUN_ID" || loud "poll GET /runs/\$id"
    need "poll GET /runs/\$id" 200
    ST=$(jget "$LAST_BODY_FILE" status || true); ST="${ST:-?}"
    say "run: $ST (bound ${WAIT_TOTAL}s, step ${WAIT_STEP}s)"
    case "$ST" in
        waiting_human) REACHED_GATE=1; break ;;
        completed|failed|cancelled|interrupted) break ;;
    esac
    [ "$(date +%s)" -lt "$END" ] || loud "run still $ST after ${WAIT_TOTAL}s — the gate was never observed"
    sleep "$WAIT_STEP"
done

# The pending gate (SELECT only) and the decision: alice, the project
# maintainer, is the only role the gate names, and the CAS version is echoed.
APPR_ID="" APPR_VER=""
if [ "$REACHED_GATE" = 1 ]; then
    END=$(( $(date +%s) + 60 ))
    while :; do
        ROW=$(run_sql "SELECT id || '|' || version FROM approval_requests WHERE run_id = '$RUN_ID' AND state = 'pending' ORDER BY created_at LIMIT 1" | tail -1)
        [ -n "$ROW" ] && break
        [ "$(date +%s)" -lt "$END" ] || loud "run is waiting_human but no pending approval_requests row after 60s"
        sleep 5
    done
    APPR_ID="${ROW%%|*}"; APPR_VER="${ROW##*|}"
    say "gate: $APPR_ID (v$APPR_VER) — deciding approved as alice"
    req alice POST "/api/v1/approvals/$APPR_ID/decide" "{\"decision\":\"approved\",\"version\":$APPR_VER}"
    need "decide gate (POST /approvals/\$id/decide)" 200
    say "gate: decided $(jget "$LAST_BODY_FILE" state) v$(jget "$LAST_BODY_FILE" version)"
fi

# Bounded wait for the run to leave waiting_human and go terminal.
END=$(( $(date +%s) + WAIT_TOTAL ))
while :; do
    req alice GET "/api/v1/runs/$RUN_ID" || loud "poll GET /runs/\$id (post-decision)"
    need "poll GET /runs/\$id" 200
    ST=$(jget "$LAST_BODY_FILE" status || true); ST="${ST:-?}"
    say "run: $ST (bound ${WAIT_TOTAL}s, step ${WAIT_STEP}s)"
    case "$ST" in
        completed|failed|cancelled|interrupted) break ;;
    esac
    [ "$(date +%s)" -lt "$END" ] || loud "run still $ST ${WAIT_TOTAL}s after the decision"
    sleep "$WAIT_STEP"
done
say "run: terminal status $ST"

# 4. verdicts — journal and tables, SELECT only through lib.sh run_sql.
# a. the run reached the gate: an approval.requested row names /approve and a
#    run.waiting_human row exists (the run's own gate state).
N_GATE_REQ=$(run_sql "SELECT count(*) FROM domain_events WHERE run_id = '$RUN_ID' AND type = 'approval.requested' AND (payload->>'node_instance_key') = '/approve'" | tail -1 | tr -d '[:space:]')
N_WAIT=$(run_sql "SELECT count(*) FROM domain_events WHERE run_id = '$RUN_ID' AND type = 'run.waiting_human'" | tail -1 | tr -d '[:space:]')
verdict "$([ "$REACHED_GATE" = 1 ] && [ "${N_GATE_REQ:-0}" -ge 1 ] && [ "${N_WAIT:-0}" -ge 1 ] && echo PASS || echo FAIL)" \
    "a. the run reached its approval gate (/approve)" \
    "approval.requested rows naming /approve=$N_GATE_REQ run.waiting_human rows=$N_WAIT reached=$REACHED_GATE"

# b. the model.chat plan node SUCCEEDED with a non-empty outputs.text.
#    Three separate scalar reads: the text itself may contain pipes and newlines,
#    so a |-joined psql line would misparse.
PLAN_STATUS=$(run_sql "SELECT COALESCE(status,'-') FROM node_executions WHERE run_id = '$RUN_ID' AND node_id = 'plan' LIMIT 1" | tail -1 | tr -d '[:space:]')
PLAN_LEN=$(run_sql "SELECT COALESCE(length(outputs->>'text'),0) FROM node_executions WHERE run_id = '$RUN_ID' AND node_id = 'plan' LIMIT 1" | tail -1 | tr -d '[:space:]')
PLAN_HEAD=$(run_sql "SELECT COALESCE(LEFT(outputs->>'text',200),'') FROM node_executions WHERE run_id = '$RUN_ID' AND node_id = 'plan' LIMIT 1")
[ -n "$PLAN_STATUS" ] || verdict FAIL "b. the model.chat plan node SUCCEEDED with a non-empty outputs.text" "no node_executions row for node_id=plan"
verdict "$([ "$PLAN_STATUS" = succeeded ] && [ "${PLAN_LEN:-0}" -ge 1 ] && echo PASS || echo FAIL)" \
    "b. the model.chat plan node SUCCEEDED with a non-empty outputs.text" \
    "status=$PLAN_STATUS text_len=$PLAN_LEN"
say "plan node outputs.text (first 200 chars, newlines as spaces): $(printf '%s' "$PLAN_HEAD" | tr '\n' ' ')"

# c. the gate was decided by alice: the approval_requests row is
#    decided/approved with decided_by = alice's user id, and the journal's
#    approval.decided row carries the same decider.
GATEROW=$(run_sql "SELECT state || '|' || COALESCE(decision,'-') || '|' || COALESCE(decided_by::text,'-') FROM approval_requests WHERE run_id = '$RUN_ID' ORDER BY created_at LIMIT 1" | tail -1)
GATE_STATE="${GATEROW%%|*}"; REST="${GATEROW#*|}"; GATE_DECISION="${REST%%|*}"; GATE_DECIDER="${REST#*|}"
J_DECIDER=$(run_sql "SELECT COALESCE((payload->>'decided_by'),'') FROM domain_events WHERE run_id = '$RUN_ID' AND type = 'approval.decided' ORDER BY global_seq LIMIT 1" | tail -1 | tr -d '[:space:]')
verdict "$([ "$GATE_STATE" = decided ] && [ "$GATE_DECISION" = approved ] && [ "$GATE_DECIDER" = "$ALICE_ID" ] && [ "$J_DECIDER" = "$ALICE_ID" ] && echo PASS || echo FAIL)" \
    "c. the gate was decided by alice (the gate's maintainer role)" \
    "state=$GATE_STATE decision=$GATE_DECISION decided_by=$GATE_DECIDER journal decided_by=$J_DECIDER alice=$ALICE_ID alice_role=$ALICE_ROLE"

# d. the run completed: the runs row says completed and the journal holds a
#    run.completed row.
RSTAT=$(run_sql "SELECT status FROM runs WHERE id = '$RUN_ID'" | tail -1 | tr -d '[:space:]')
N_COMPLETED=$(run_sql "SELECT count(*) FROM domain_events WHERE run_id = '$RUN_ID' AND type = 'run.completed'" | tail -1 | tr -d '[:space:]')
verdict "$([ "$RSTAT" = completed ] && [ "${N_COMPLETED:-0}" -ge 1 ] && echo PASS || echo FAIL)" \
    "d. the run completed" \
    "runs.status=$RSTAT run.completed rows=$N_COMPLETED"

# e. every node execution succeeded and every attempt succeeded. The approval
#    node settles on the control plane and creates no attempt (ADR-0023 § 3),
#    so its zero-attempt success is expected, not an exception.
NNODES=$(run_sql "SELECT count(*) FROM node_executions WHERE run_id = '$RUN_ID'" | tail -1 | tr -d '[:space:]')
BADNODES=$(run_sql "SELECT count(*) FROM node_executions WHERE run_id = '$RUN_ID' AND status <> 'succeeded'" | tail -1 | tr -d '[:space:]')
NATT=$(run_sql "SELECT count(*) FROM attempts WHERE run_id = '$RUN_ID'" | tail -1 | tr -d '[:space:]')
BADATT=$(run_sql "SELECT count(*) FROM attempts WHERE run_id = '$RUN_ID' AND status <> 'succeeded'" | tail -1 | tr -d '[:space:]')
verdict "$([ "${NNODES:-0}" -ge 4 ] && [ "${BADNODES:-1}" -eq 0 ] && [ "${BADATT:-1}" -eq 0 ] && echo PASS || echo FAIL)" \
    "e. every node execution succeeded and every attempt of the run succeeded" \
    "node_executions=$NNODES not_succeeded=$BADNODES attempts=$NATT not_succeeded=$BADATT"

# f. the run's journal opens with run.created and closes with run.completed in
#    global_seq order.
FIRST_EVT=$(run_sql "SELECT type FROM domain_events WHERE run_id = '$RUN_ID' ORDER BY global_seq LIMIT 1" | tail -1 | tr -d '[:space:]')
LAST_EVT=$(run_sql "SELECT type FROM domain_events WHERE run_id = '$RUN_ID' ORDER BY global_seq DESC LIMIT 1" | tail -1 | tr -d '[:space:]')
verdict "$([ "$FIRST_EVT" = run.created ] && [ "$LAST_EVT" = run.completed ] && echo PASS || echo FAIL)" \
    "f. the run's journal runs run.created ... run.completed" \
    "first=$FIRST_EVT last=$LAST_EVT"

[ "$FAILS" -eq 0 ] && { say "done — the home sample ran end to end, every verdict PASS"; exit 0; }
say "done — $FAILS verdict(s) FAIL"; exit 1
