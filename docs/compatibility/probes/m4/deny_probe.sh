#!/usr/bin/env bash
# deny_probe.sh — live evidence that a `deny` agent profile is ENFORCED on the
# conversation path. a0fd9e7 / 1b93069 put deny (and preapproved_within_sandbox)
# into the launcher's prompting mode; before that the turn ran in the harness's
# auto mode, never sent session/request_permission, and every tool call was allowed.
#   bash docs/compatibility/probes/m4/deny_probe.sh        # needs the M4 lab stack up
# Flow: upsert profile `m4-deny-probe` (seed_profile's shape: launcher claude,
# worktree, sandbox required, commit_granted false, permission_mode deny) → as alice
# create a conversation in the seeded project (slug m4-exit) and POST one message
# asking for deny-probe.txt → poll GET /api/v1/conversations/{id} (bounded
# ${M4_DENY_WAIT:-240}s / ${M4_DENY_STEP:-5}s) until the turn is terminal → read the
# journal (SELECT only) → PASS/FAIL verdicts; exit 0 only if every one passed.
# journal (SELECT only) → PASS/FAIL verdicts; exit 0 only if every one passed.
# Verdicts, each an observed literal (AGENTS.md): (a) >=1
# conversation.permission.requested; (b) no decided row grants an allow —
# PermissionPolicyFor('deny') answers reject_once/reject_always and the empty verdict
# closes the prompt cancelled/expired (internal/store/postgres/agentturn_seams.go);
# (c) no row is attributed to a preapproval; (d) deny-probe.txt exists in no readable
# worker workspace. § 7.0: all through lib.sh (M4_URL 18091, M4_COMPOSE
# communication-m4). No cookie, header or secret body is ever printed.
set -uo pipefail
M4_DIR="$(cd "$(dirname "$0")" && pwd)"
export M4_PROBE=deny-probe
# shellcheck source=lib.sh
. "$M4_DIR/lib.sh"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/m4-deny-probe.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
PROFILE_NAME="${M4_DENY_PROFILE:-m4-deny-probe}"
PROJECT_SLUG="${M4_DENY_PROJECT_SLUG:-m4-exit}"
WANTED_FILE="deny-probe.txt"
PROMPT="Create a file named ${WANTED_FILE} containing the word hello in the repository root, then reply DONE."
WAIT_TOTAL="${M4_DENY_WAIT:-240}"; WAIT_STEP="${M4_DENY_STEP:-5}"
declare -A JAR CSRF
FAILS=0
say()  { printf 'DENY %s\n' "$*"; }
loud() { printf 'DENY FAIL %s\n' "$1"
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
login alice

# 1. the profile — seed_profile's upsert with permission_mode deny. SQL because
#    AgentProfileCreate has no permission_mode field at all (ADR-0030), and
#    ON CONFLICT is the idempotent reuse a 409 would mean over the API.
PROFILE_ID=$(run_sql "INSERT INTO agent_profiles (organization_id, name, launcher_id, permission_mode, workspace_mode, sandbox_enforcement, commit_granted)
  VALUES ((SELECT id FROM organizations WHERE slug = 'default'), '$PROFILE_NAME', 'claude', 'deny', 'worktree', 'required', false)
  ON CONFLICT (organization_id, name) DO UPDATE SET launcher_id = EXCLUDED.launcher_id,
    permission_mode = EXCLUDED.permission_mode, workspace_mode = EXCLUDED.workspace_mode,
    sandbox_enforcement = EXCLUDED.sandbox_enforcement, commit_granted = EXCLUDED.commit_granted;
  SELECT id FROM agent_profiles WHERE organization_id = (SELECT id FROM organizations WHERE slug = 'default') AND name = '$PROFILE_NAME';" | tail -1 | tr -d '[:space:]')
case "$PROFILE_ID" in *[!0-9a-f-]*|"") loud "profile upsert: psql returned no uuid";; esac
MODE=$(run_sql "SELECT permission_mode FROM agent_profiles WHERE id = '$PROFILE_ID'" | tr -d '[:space:]')
verdict "$([ "$MODE" = deny ] && echo PASS || echo FAIL)" "profile $PROFILE_NAME -> $PROFILE_ID is a deny profile (read back from the row)" "psql permission_mode=[$MODE]"

# 2. the conversation and the one user message (api/openapi.yaml ConversationCreate
#    + ConversationMessageCreate bodies, as internal/api/conversations.go decodes them).
PROJECT_ID=$(run_sql "SELECT id FROM projects WHERE slug = '$PROJECT_SLUG'" | tail -1 | tr -d '[:space:]')
case "$PROJECT_ID" in *[!0-9a-f-]*|"") loud "project $PROJECT_SLUG: no id (run seed.sh first)";; esac
req alice POST "/api/v1/projects/$PROJECT_ID/conversations" \
    "{\"agent_profile_id\":\"$PROFILE_ID\",\"title\":\"deny enforcement $(date -u +%H%M%S)\"}"
need "POST /projects/\$id/conversations on $PROFILE_NAME (ConversationCreate)" 201
CONV_ID=$(jget "$LAST_BODY_FILE" id) || loud "create conversation: 201 with no id"
req alice POST "/api/v1/conversations/$CONV_ID/messages" "{\"prompt\":\"$PROMPT\"}"
need "POST /conversations/\$id/messages (one user message)" 202
say "conversation: $CONV_ID turn $(jget "$LAST_BODY_FILE" id) (profile $PROFILE_ID)"

# 3. bounded wait: active_turn is the conversation's non-terminal turn, so its
#    absence means the turn reached completed|cancelled|failed|interrupted.
END=$(( $(date +%s) + WAIT_TOTAL ))
while :; do
    req alice GET "/api/v1/conversations/$CONV_ID" || loud "poll GET /conversations/\$id"
    need "poll GET /conversations/\$id" 200
    TURN=$(jget "$LAST_BODY_FILE" active_turn.status || true); TURN="${TURN:-terminal}"
    say "turn: $TURN (bound ${WAIT_TOTAL}s, step ${WAIT_STEP}s)"
    [ "$TURN" = terminal ] && break
    [ "$(date +%s)" -lt "$END" ] || loud "turn still $TURN after ${WAIT_TOTAL}s — nothing below would be evidence yet"
    sleep "$WAIT_STEP"
done

# 4. the journal, SELECT only, through lib.sh run_sql (compose project communication-m4).
#    Every payload->> is parenthesised: || binds tighter than ->> (live pass 28).
JOURNAL=$(run_sql "SELECT d.global_seq || '|' || d.type || '|' || COALESCE((d.payload->>'status'),'-') || '|' || COALESCE((d.payload->>'decided_by'),'-') || '|' || COALESCE((d.payload->>'decision_option_id'),'-') || '|' || COALESCE((SELECT o->>'kind' FROM domain_events r, jsonb_array_elements(r.payload->'options') o WHERE r.conversation_id = d.conversation_id AND r.type = 'conversation.permission.requested' AND (r.payload->>'permission_request_id') = (d.payload->>'permission_request_id') AND (o->>'option_id') = (d.payload->>'decision_option_id')),'-') FROM domain_events d WHERE d.conversation_id = '$CONV_ID'::uuid AND d.type IN ('conversation.permission.requested','conversation.permission.decided') ORDER BY d.global_seq")
printf '%s\n' "$JOURNAL" | sed 's/^/      J /'
read -r NREQ NDEC NALL NPRE <<<"$(printf '%s\n' "$JOURNAL" | awk -F'|' '/\.permission\.requested/{q++;next} /\.permission\.decided/{d++; if ($3=="decided" && $6 !~ /^reject/) a++; if ($4 ~ /preapproved/) p++} END{printf "%d %d %d %d", q+0,d+0,a+0,p+0}')"
say "journal: $NREQ requested / $NDEC decided / $NALL allow / $NPRE preapproved"
# 5. verdicts. d: the API never serves a workspace path (api/openapi.yaml: the
#    client "never learns a path"), so the refused file is looked for where it would
#    live — and an unreadable root is a FAIL, never a vacuous PASS.
verdict "$([ "$NREQ" -ge 1 ] && echo PASS || echo FAIL)" "a. >=1 conversation.permission.requested: the deny turn really prompted" "requested rows=$NREQ"
verdict "$([ "$NDEC" -ge 1 ] && [ "$NALL" -eq 0 ] && echo PASS || echo FAIL)" "b. no decided row grants an allow (a reject_* option kind, or cancelled/expired with no option)" "decided rows=$NDEC allow rows=$NALL"
verdict "$([ "$NPRE" -eq 0 ] && echo PASS || echo FAIL)" "c. no decided row is attributed to a preapproval" "preapproved rows=$NPRE"
FOUND=""; READABLE=0
for svc in worker-a worker-b; do
    OUT=$(m4_compose exec -T "$svc" find /workspaces -name "$WANTED_FILE" 2>/dev/null) || continue
    READABLE=1; FOUND="$FOUND $(printf '%s\n' "$OUT" | grep -F "$WANTED_FILE" | tr '\n' ' ')"
done
if [ -d "$M4_REPO_DIR/.harness/workspaces" ]; then
    READABLE=1; FOUND="$FOUND $(find "$M4_REPO_DIR/.harness/workspaces" -name "$WANTED_FILE" 2>/dev/null | tr '\n' ' ')"
fi
verdict "$([ "$READABLE" = 1 ] && [ -z "${FOUND// /}" ] && echo PASS || echo FAIL)" "d. the refused write never landed: $WANTED_FILE in no workspace" "roots readable=$READABLE matches=[$FOUND]"
[ "$FAILS" -eq 0 ] && { say "done — deny enforced, every verdict PASS"; exit 0; }
say "done — $FAILS verdict(s) FAIL"; exit 1
