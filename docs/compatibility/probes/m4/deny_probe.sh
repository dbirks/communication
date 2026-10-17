#!/usr/bin/env bash
# deny_probe.sh — live evidence that conversation prompts are ENFORCED on the
# conversation path, generalised to the two launcher prompting modes.
#   bash docs/compatibility/probes/m4/deny_probe.sh                        # needs the M4 lab stack up
#   bash docs/compatibility/probes/m4/deny_probe.sh deny|preapproved_within_sandbox
# a0fd9e7 / 1b93069 put deny and preapproved_within_sandbox into the launcher's
# prompting mode; before that the turn ran in the harness's auto mode, never sent
# session/request_permission, and every tool call was allowed. ADR-0039
# (2881146, migration 00007): a prompt closed by the profile's policy now lands
# `decided` with the policy's option — the permission_requests row carries
# decided_by_kind='policy' / decided_by_policy=<mode> and the
# conversation.permission.decided event carries decided_by
# "profile_policy:<mode>" (internal/store/postgres/turns.go
# DecidePermissionByPolicy) — so a denied prompt is a reject_* decision, and a
# preapproved prompt is an allow_* decision that lands the file.
# Flow (per mode $MODE, default deny): upsert profile m4-<mode>-probe
# (seed_profile's shape: launcher claude, worktree, sandbox required,
# commit_granted false, permission_mode $MODE) → as alice create a conversation
# in the seeded project (slug m4-exit) and POST one message asking for
# <mode-file> (deny-probe.txt / preapproved-probe.txt) → poll
# GET /api/v1/conversations/{id} (bounded 240s / 5s steps) until the turn is
# terminal → read the journal (SELECT only) → PASS/FAIL verdicts; exit 0 only if
# every one passed.
# Verdicts, each an observed literal (AGENTS.md): (a) >=1
# conversation.permission.requested; (b) every requested prompt has exactly one
# conversation.permission.decided; (c) every decided row: status=decided and
# decided_by=profile_policy:<mode> — so for deny, no allow is granted and no row
# is attributed to a preapproval; (d) every decided row's option kind matches
# the policy (reject_* for deny, allow_* for preapproved) via the option-kind
# join — a cancelled-with-no-option close now FAILS (ADR-0039) unless the
# journal shows no such option was offered; (e) every permission_requests row
# (SELECT) is decided / kind=policy / policy=<mode>; (f) journal verdict on the
# write: the conversation workspace is RELEASED at turn end (a
# workspace.released row for the conversation), so a filesystem look is
# vacuous; the real outcome is in the conversation's
# conversation.tool.update rows — for deny, the tool call naming the file ends
# `failed` and no update says "created successfully" for it; for preapproved,
# an update says "File created successfully" naming the file. § 7.0: all
# through lib.sh (M4_URL 18091,
# M4_COMPOSE communication-m4). No cookie, header or secret body is ever printed.
set -uo pipefail
M4_DIR="$(cd "$(dirname "$0")" && pwd)"
MODE="${1:-deny}"
case "$MODE" in deny|preapproved_within_sandbox) ;; *)
    echo "usage: deny_probe.sh [deny|preapproved_within_sandbox] (default deny)"; exit 2;;
esac
export M4_PROBE="$MODE-probe"
# shellcheck source=lib.sh
. "$M4_DIR/lib.sh"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/m4-$MODE-probe.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
case "$MODE" in
    deny)                    TAG="DENY";            PROFILE_NAME="${M4_DENY_PROFILE:-m4-deny-probe}"
                             PROJECT_SLUG="${M4_DENY_PROJECT_SLUG:-m4-exit}"
                             WANTED_FILE="deny-probe.txt";    KINDPREFIX="reject"
                             WAIT_TOTAL="${M4_DENY_WAIT:-240}"; WAIT_STEP="${M4_DENY_STEP:-5}";;
    preapproved_within_sandbox) TAG="PREAPPROVED";   PROFILE_NAME="${M4_PREAPPROVED_PROFILE:-m4-preapproved-probe}"
                             PROJECT_SLUG="${M4_PREAPPROVED_PROJECT_SLUG:-m4-exit}"
                             WANTED_FILE="preapproved-probe.txt"; KINDPREFIX="allow"
                             WAIT_TOTAL="${M4_PREAPPROVED_WAIT:-240}"; WAIT_STEP="${M4_PREAPPROVED_STEP:-5}";;
esac
PROMPT="Create a file named ${WANTED_FILE} containing the word hello in the repository root, then reply DONE."
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

# 1. the profile — seed_profile's upsert with permission_mode $MODE. SQL because
#    AgentProfileCreate has no permission_mode field at all (ADR-0030), and
#    ON CONFLICT is the idempotent reuse a 409 would mean over the API.
PROFILE_ID=$(run_sql "INSERT INTO agent_profiles (organization_id, name, launcher_id, permission_mode, workspace_mode, sandbox_enforcement, commit_granted)
  VALUES ((SELECT id FROM organizations WHERE slug = 'default'), '$PROFILE_NAME', 'claude', '$MODE', 'worktree', 'required', false)
  ON CONFLICT (organization_id, name) DO UPDATE SET launcher_id = EXCLUDED.launcher_id,
    permission_mode = EXCLUDED.permission_mode, workspace_mode = EXCLUDED.workspace_mode,
    sandbox_enforcement = EXCLUDED.sandbox_enforcement, commit_granted = EXCLUDED.commit_granted;
  SELECT id FROM agent_profiles WHERE organization_id = (SELECT id FROM organizations WHERE slug = 'default') AND name = '$PROFILE_NAME';" | tail -1 | tr -d '[:space:]')
case "$PROFILE_ID" in *[!0-9a-f-]*|"") loud "profile upsert: psql returned no uuid";; esac
MODE_READBACK=$(run_sql "SELECT permission_mode FROM agent_profiles WHERE id = '$PROFILE_ID'" | tr -d '[:space:]')
verdict "$([ "$MODE_READBACK" = "$MODE" ] && echo PASS || echo FAIL)" "profile $PROFILE_NAME -> $PROFILE_ID is a $MODE profile (read back from the row)" "psql permission_mode=[$MODE_READBACK]"

# 2. the conversation and the one user message (api/openapi.yaml ConversationCreate
#    + ConversationMessageCreate bodies, as internal/api/conversations.go decodes them).
PROJECT_ID=$(run_sql "SELECT id FROM projects WHERE slug = '$PROJECT_SLUG'" | tail -1 | tr -d '[:space:]')
case "$PROJECT_ID" in *[!0-9a-f-]*|"") loud "project $PROJECT_SLUG: no id (run seed.sh first)";; esac
req alice POST "/api/v1/projects/$PROJECT_ID/conversations" \
    "{\"agent_profile_id\":\"$PROFILE_ID\",\"title\":\"policy $MODE $(date -u +%H%M%S)\"}"
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
# 4. the journal, SELECT only, through lib.sh run_sql (compose project
#    communication-m4). Every payload->> is parenthesised: || binds tighter than
#    ->> (live pass 28). Fields: seq|type|status|decided_by|decision_option_id|
#    decided_option_kind (the existing option-kind join)|request_id|offered_kinds
#    (the requested event's option kinds, comma-joined).
JOURNAL=$(run_sql "SELECT d.global_seq || '|' || d.type || '|' || COALESCE((d.payload->>'status'),'-') || '|' || COALESCE((d.payload->>'decided_by'),'-') || '|' || COALESCE((d.payload->>'decision_option_id'),'-') || '|' || COALESCE((SELECT o->>'kind' FROM domain_events r, jsonb_array_elements(r.payload->'options') o WHERE r.conversation_id = d.conversation_id AND r.type = 'conversation.permission.requested' AND (r.payload->>'permission_request_id') = (d.payload->>'permission_request_id') AND (o->>'option_id') = (d.payload->>'decision_option_id')),'-') || '|' || COALESCE((d.payload->>'permission_request_id'),'-') || '|' || COALESCE((SELECT string_agg(DISTINCT o->>'kind', ',' ORDER BY o->>'kind') FROM domain_events r, jsonb_array_elements(r.payload->'options') o WHERE r.conversation_id = d.conversation_id AND r.type = 'conversation.permission.requested' AND (r.payload->>'permission_request_id') = (d.payload->>'permission_request_id')),'-') FROM domain_events d WHERE d.conversation_id = '$CONV_ID'::uuid AND d.type IN ('conversation.permission.requested','conversation.permission.decided') ORDER BY d.global_seq")
printf '%s\n' "$JOURNAL" | sed 's/^/      J /'
# awk emits: requested decided bad_status bad_decided_by bad_kind no_option
# bad_pairing no_<KINDPREFIX>_offered.
read -r NREQ NDEC BADST BADDB BADKIND NOOPT BADPAIR NOFFERED <<<"$(printf '%s\n' "$JOURNAL" | awk -F'|' -v mode="$MODE" -v pre="$KINDPREFIX" '
/\.permission\.requested/{id=$7; q++; off[id]=$8; next}
/\.permission\.decided/{id=$7; d++; dec[id]++
  if ($3 != "decided") stb++
  if ($4 != "profile_policy:" mode) dbb++
  if ($6 == "-") { noopt++; nooptid[id]=1 }
  else if (substr($6, 1, length(pre)) != pre) kb++
}
END{
  bad = 0
  # pairing uses the requested set collected via q counting below
  for (id in off) if (dec[id] != 1) bad++
  for (id in dec) if (!(id in off)) bad++
  offered = 0
  for (id in off) if (index(off[id], pre) > 0) offered = 1
  printf "%d %d %d %d %d %d %d %d", q+0, d+0, stb+0, dbb+0, kb+0, noopt+0, bad+0, offered+0
}')"
say "journal: $NREQ requested / $NDEC decided / bad_status=$BADST bad_decided_by=$BADDB bad_kind=$BADKIND no_option=$NOOPT bad_pairing=$BADPAIR"
# 5. verdicts.
verdict "$([ "$NREQ" -ge 1 ] && echo PASS || echo FAIL)" "a. >=1 conversation.permission.requested: the $MODE turn really prompted" "requested rows=$NREQ"
verdict "$([ "$NREQ" -eq "$NDEC" ] && [ "$BADPAIR" -eq 0 ] && echo PASS || echo FAIL)" "b. every requested prompt closed with exactly one conversation.permission.decided" "requested=$NREQ decided=$NDEC bad pairing=$BADPAIR"
verdict "$([ "$BADST" -eq 0 ] && [ "$BADDB" -eq 0 ] && echo PASS || echo FAIL)" "c. every decided row: status=decided, decided_by=profile_policy:$MODE" "bad status=$BADST bad decided_by=$BADDB"
if [ "$BADKIND" -eq 0 ] && [ "$NOOPT" -eq 0 ]; then
    verdict PASS "d. every decided row's option kind matches the policy (${KINDPREFIX}_*)" "bad kind=$BADKIND no option=$NOOPT"
elif [ "$NOOFFERED" -eq 0 ]; then
    # ADR-0039: a deny with a reject option offered must be DECIDED, never
    # cancelled — the old cancelled-with-no-option acceptance is now a FAIL,
    # unless the journal shows no ${KINDPREFIX}_* option was ever offered.
    verdict PASS "d. no ${KINDPREFIX}_* option was offered in the journal, so the option-less close predates ADR-0039" "bad kind=$BADKIND no option=$NOOPT"
else
    verdict FAIL "d. the decided prompt did not close with a ${KINDPREFIX}_* option (ADR-0039: it must be decided, not cancelled)" "bad kind=$BADKIND no option=$NOOPT"
fi
# e. the permission_requests rows (SELECT only): every row of this conversation
#    is decided with decided_by_kind='policy' and decided_by_policy=$MODE (00007).
ROWS=$(run_sql "SELECT status || '|' || COALESCE(decided_by_kind, '-') || '|' || COALESCE(decided_by_policy, '-') FROM permission_requests WHERE conversation_id = '$CONV_ID'")
NCOUNT=0 NOK=0
while IFS='|' read -r st kd pl; do
    [ -n "$st" ] || continue
    NCOUNT=$((NCOUNT+1)); [ "$st" = "decided" ] && [ "$kd" = "policy" ] && [ "$pl" = "$MODE" ] && NOK=$((NOK+1))
done <<<"$ROWS"
verdict "$([ "$NCOUNT" -eq "$NREQ" ] && [ "$NOK" -eq "$NCOUNT" ] && echo PASS || echo FAIL)" "e. every permission_requests row: status=decided, decided_by_kind=policy, decided_by_policy=$MODE" "rows=$NCOUNT expected=$NREQ matching=$NOK"
# f. the write's outcome, in the journal. The conversation workspace is
#    released when the turn ends — a workspace.released row for this
#    conversation — so /workspaces/conversation/<id>/ no longer exists and a
#    filesystem look is vacuous (live pass 30: deny "in no workspace" was
#    unmeasurable; preapproved "in exactly one workspace" read 0 matches
#    although the agent wrote the file). The real outcome is the
#    conversation's conversation.tool.update rows: each row is
#    <tool_call_id>|<title>|<status>|<output_preview>, ordered by update_seq,
#    and a tool call's last row is its outcome. deny: the tool call naming
#    $WANTED_FILE ended `failed` ("User refused permission to run tool") and
#    no update says "File created successfully" naming it; preapproved: an
#    update says "File created successfully" naming the file.
RELEASED=$(run_sql "SELECT count(*) FROM domain_events WHERE conversation_id = '$CONV_ID'::uuid AND type = 'workspace.released'")
say "f. informational: workspace.released rows for this conversation = ${RELEASED:-?} — the conversation workspace was released at turn end, so a filesystem look is vacuous; the journal holds the write's outcome"
TOOLS=$(run_sql "SELECT (d.payload->>'tool_call_id') || '|' || COALESCE((d.payload->>'title'),'-') || '|' || COALESCE((d.payload->>'status'),'-') || '|' || COALESCE((d.payload->>'output_preview'),'') FROM domain_events d WHERE d.conversation_id = '$CONV_ID'::uuid AND d.type = 'conversation.tool.update' ORDER BY COALESCE((d.payload->>'update_seq')::int, 0)")
# awk emits: filetools denied_final created — the tool calls that named the
# file, how many of those ended `failed`, and how many updates say "File
# created successfully" naming the file.
read -r FILETOOLS DENIEDFINAL CREATED <<<"$(printf '%s\n' "$TOOLS" | awk -F'|' -v file="$WANTED_FILE" '
NF >= 3 && $1 != "" { final[$1] = $3
  if (index($0, file) > 0) filetools[$1] = 1
  if (index($0, "File created successfully") > 0 && index($0, file) > 0) created++ }
END {
  denied = 0; ft = 0
  for (id in filetools) { ft++; if (final[id] == "failed") denied++ }
  printf "%d %d %d", ft, denied, created + 0
}')"
if ! printf '%s %s %s\n' "$FILETOOLS" "$DENIEDFINAL" "$CREATED" | grep -q '^[0-9]\+ [0-9]\+ [0-9]\+$'; then
    verdict FAIL "f. the journal read of the conversation's conversation.tool.update rows failed" "psql output=[$(printf '%s' "$TOOLS" | head -1)]"
fi
if [ "$MODE" = deny ]; then
    verdict "$([ "$DENIEDFINAL" -ge 1 ] && [ "$CREATED" -eq 0 ] && echo PASS || echo FAIL)" "f. the journal says the write was refused: the tool call naming $WANTED_FILE ended failed and no update says it was created" "tool calls naming the file=$FILETOOLS of them ended failed=$DENIEDFINAL 'created successfully' naming it=$CREATED"
else
    verdict "$([ "$CREATED" -ge 1 ] && echo PASS || echo FAIL)" "f. the journal says the write landed: a tool update says 'File created successfully' naming $WANTED_FILE" "tool calls naming the file=$FILETOOLS 'created successfully' naming it=$CREATED"
fi
[ "$FAILS" -eq 0 ] && { say "done — $MODE enforced, every verdict PASS"; exit 0; }
say "done — $FAILS verdict(s) FAIL"; exit 1
