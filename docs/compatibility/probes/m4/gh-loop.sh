#!/usr/bin/env bash
# gh-loop.sh — driver for the REAL issue → draft-PR loop on the private
# throwaway repo https://github.com/dbirks/comms-test-repo-1, against the
# communication-m4 lab (lib.sh M4_URL 18091, compose.real.yml lab, never
# rebuilt here). Precondition: seed-github-loop.sh has seeded project
# `gh-loop`, repository `tally` (with its ADR-0061 broker credential and the
# ADR-0045 GH_TOKEN secret mounted for claude-implementer), the published
# issue-to-pr pipeline (claude planner/implementer profiles, the lab's
# ADR-0036 preapproved-within-sandbox exception — claude only; pi stays a GAP)
# and the labeled/comm:go issue trigger. If the project is absent the driver
# runs the seed itself (which needs COMMUNICATION_TEST_REPO_TOKEN_FILE).
#
# For i in 1..N (N = $1, default 1):
#   1. CREATE an issue on the real repo through the GitHub REST API — small
#      realistic feature/bug tickets for a tiny Python "tally" CLI, taken from
#      the list below; the FIRST ticket asks to create the project skeleton
#      when the repo is empty, so the loop can start from a bare repository.
#   2. ADD the label comm:go — the trigger's any-of set (the serve-side
#      ADR-0056 poller turns that into a run within ~60 s + the poll tick).
#   3. WAIT (bounded, printing progress) for GET /projects/{id}/runs?
#      trigger=issue to show a run whose trigger.ref is <owner/repo>#<number>.
#   4. APPROVE the gate through the API as admin (project maintainer) when the
#      run goes waiting_human, then wait (bounded) for the terminal status.
#   5. ASSERT: run status completed; the implement node's outputs.pr_url is a
#      https://github.com/…/pull/N URL; GET that PR (GitHub API) shows
#      draft=true and a head ref starting comm/issue-.
# One `PASS`/`FAIL` line per issue with the run id and PR URL; on FAIL the
# failing node's error (attempt detail via GET /runs/{id}/nodes/{ne}) and the
# run's last journal events (SELECT-only psql). Exit non-zero on any FAIL.
#
# THE ADMIN CSRF TOKEN. lib.sh's m4_jar keys the cookie jar on the USER alone
# (jars/<user>.jar under M4_PROBE_ROOT_BASE), not on the probe: so when this
# driver has to seed the lab itself, seed-github-loop.sh's own `login admin`
# deletes and rewrites that same file with a NEW session row, and each session
# carries its own csrf_token (internal/store/postgres/identity.go:180).
# Whatever login() cached then belongs to a session no longer in the jar and
# every later mutation answers 403 "CSRF Token Invalid" — which is exactly the
# pass-2 gate failure. Two defences, both here: refresh_csrf re-reads the token
# for the session the jar currently holds (and runs right after the seed), and
# req retries a mutation ONCE after such a 403 by refreshing first. Any other
# 403 (authz, origin) is a real answer and still FAILs. Never print a token —
# only its length.
#
# THE TOKEN. COMMUNICATION_TEST_REPO_TOKEN_FILE is required (GitHub writes are
# the point of this driver). The value is never read into argv, printed or
# written: every GitHub call builds a curl --config on stdout (piped to
# `curl --config -`) whose Authorization header line is assembled from the
# file, and whose body is a --data-binary @file the token is never in. The
# communication-API calls use seed.sh's cookie/CSRF shape and no token at all.
# set +x guards: even under `bash -x` nothing carrying the value executes.
#
# Isolation § 7.0: all traffic through M4_URL 18091; SQL (evidence reads only)
# through `sudo docker exec communication-m4-postgres-1 psql` — the documented
# operator path for this lab (seed-pi.sh's header). Stack up/down not owned.
set -uo pipefail
# BASH_SOURCE, not $0: this file is also SOURCED (see the sourcing guard ahead of
# main) to exercise the helpers without driving GitHub, and then $0 is the caller's.
M4_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export M4_PROBE=gh-loop
# shellcheck source=lib.sh
. "$M4_DIR/lib.sh"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/m4-gh-loop.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
N="${1:-1}"
case "$N" in ''|*[!0-9]*) echo "gh-loop.sh: N must be a positive integer, got [$1]" >&2; exit 2 ;; esac
[ "$N" -ge 1 ] || { echo "gh-loop.sh: N must be >= 1" >&2; exit 2; }
PROJECT_SLUG="${M4_GH_PROJECT_SLUG:-gh-loop}"
REPO_NAME="${M4_GH_REPO_NAME:-tally}"
GH_REPO="${M4_GH_GITHUB_REPO:-dbirks/comms-test-repo-1}"
TRIGGER_LABEL="${M4_GH_TRIGGER_LABEL:-comm:go}"
GH_API="${M4_GH_API_BASE:-https://api.github.com}"
FIRE_WAIT="${M4_GH_FIRE_WAIT:-900}"    # label → run created (poller ticks 60 s)
RUN_WAIT="${M4_GH_RUN_WAIT:-4200}"     # run → terminal (implement timeout is 3600 s)
STEP="${M4_GH_STEP:-15}"
TOKEN_FILE="${COMMUNICATION_TEST_REPO_TOKEN_FILE:-}"
declare -A JAR CSRF
FAILS=0

say()  { printf 'GHLOOP %s\n' "$*"; }
# loud <label> — stop the driver itself (a harness fact, not a per-issue
# verdict). Per-issue failures print FAIL lines and continue; loud is only
# for "the driver cannot run".
loud() { printf 'GHLOOP FAIL %s\n' "$1"
    [ -n "${LAST_NOTE:-}" ] && printf '      %s\n' "$LAST_NOTE"
    if [ -n "${LAST_BODY_FILE:-}" ] && [ -s "${LAST_BODY_FILE}" ]; then
        awk 1 "${LAST_BODY_FILE}" | head -c 1200 | sed 's/^/      /'; fi
    exit 1; }

# The ticket list — small, realistic feature/bug tickets for a tiny Python
# "tally" CLI (count things, add/report). Ticket 1 bootstraps the skeleton so
# the first loop works on an empty repo. N cycles the list with a numbered
# suffix past its end.
TITLES=(
    "Bootstrap the tally CLI project"
    "tally add should reject empty item names"
    "tally report should sort items by count, descending"
    "Add a --json flag to tally report"
    "tally add should be case-insensitive for item names"
    "Persist the tally between runs with a state file"
)
BODIES=(
    "The repository is currently empty (or nearly so).\n\nCreate the project skeleton for \`tally\`, a tiny Python CLI that counts things:\n- a \`tally.py\` (or \`tally/__main__.py\`) entry point with subcommands \`add <item>\` and \`report\` (prints each item and its count), using argparse\n- a \`pyproject.toml\` declaring the \`tally\` console script\n- a \`tests/\` directory with pytest covering add + report (in-memory store for now)\n- a short README with the two commands and how to run the tests\n\nIf the project already exists, do the most obviously missing piece of the skeleton instead."
    "\`tally add \"\"\` and \`tally add \"   \"\` currently create empty-name counters that show up blank in the report. Reject empty and whitespace-only names with a clear error message (exit code 2), and add a test for each arm."
    "\`tally report\` prints items in insertion order, which makes the top of a long report almost random. Sort by count descending, ties alphabetically. Keep the plain-text layout otherwise identical, and update the tests."
    "\`tally report --json\` should print the counts as a JSON object (item -> count) instead of the table, so the tally can be piped into other tools. Sort keys for stable output. Add a test that parses the output back with json.loads."
    "\`tally add Cat\` then \`tally add cat\` currently yields two separate counters. Items should be matched case-insensitively (the first spelling seen is the one displayed). Add a test for the mixed-case sequence."
    "The tally only lives inside one process right now. Keep the counts in a state file (default \`.tally.json\` in the current directory, overridable with \`--state PATH\`), written atomically after each add, so \`tally add x && tally report\` shows x: 1 across processes. Include a test using a temp directory, and add \`.tally.json\` to \`.gitignore\`."
)
ticket() { # ticket <n> -> sets TICKET_TITLE / TICKET_BODY (1-based, cycling)
    local i=$(( ($1 - 1) % ${#TITLES[@]} ))
    local cycle=$(( ($1 - 1) / ${#TITLES[@]} ))
    TICKET_TITLE="${TITLES[$i]}"
    TICKET_BODY="${BODIES[$i]}"
    if [ "$cycle" -gt 0 ]; then TICKET_TITLE="$TICKET_TITLE (pass $((cycle + 1)))"; fi
}

run_sql() {
    sudo docker exec communication-m4-postgres-1 psql -U communication \
        -d communication -tAqc "$1" 2>&1
}

# ---- json helpers (python3 stdlib; seed.sh shapes) ----------------------------
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
run_for_ref() { # run_for_ref <runs-file> <trigger-ref> — the run id whose nested trigger.ref matches
    python3 -c '
import json, sys
d = json.load(open(sys.argv[1]))
for row in d.get("runs") or []:
    if (row.get("trigger") or {}).get("ref") == sys.argv[2]:
        print(row["id"]); sys.exit(0)
sys.exit(1)
' "$1" "$2" 2>/dev/null
}
pending_approval_for() { # pending_approval_for <approvals-file> <run_id> — pending gate id, else exit 1
    python3 -c '
import json, sys
d = json.load(open(sys.argv[1]))
for row in d.get("approvals") or []:
    if row.get("run_id") == sys.argv[2] and row.get("state") == "pending":
        print(row["id"]); sys.exit(0)
sys.exit(1)
' "$1" "$2" 2>/dev/null
}

# ---- communication API: seed.sh's shape (cookies + CSRF; NO token) -----------
LAST_STATUS="" LAST_BODY_FILE="" LAST_NOTE=""
_req() { # _req <user> <METHOD> <path> [json] — one call, no retry; use req()
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
# refresh_csrf <user> — re-read csrf_token for the session ${JAR[$user]} NOW
# holds from GET /api/v1/me (lib.sh:90-98's shape) into CSRF[$user]. Prints the
# token LENGTH only. On failure it appends why to LAST_NOTE (keeping the
# caller's note) and returns 1 WITHOUT touching LAST_STATUS, so the 403 the
# caller is reacting to is still what `need`/`loud` report.
refresh_csrf() { # refresh_csrf <user>
    local user="$1" jar sttok rc tok note=""
    local me="$WORK/me-$user.json"
    jar="${JAR[$user]:-}"
    if [ -z "$jar" ]; then
        LAST_NOTE="${LAST_NOTE:+$LAST_NOTE; }refresh_csrf($user): no jar (login first)"
        return 1
    fi
    sttok=$(curl -sS --max-time 30 -b "$jar" -o "$me" -w '%{http_code}' \
                "$M4_URL/api/v1/me" 2>"$WORK/me-curl.err")
    rc=$?
    if [ $rc -ne 0 ]; then
        note="GET /api/v1/me unreachable: curl rc=$rc ($(m4_oneline < "$WORK/me-curl.err"))"
    elif [ "$sttok" != 200 ]; then
        note="GET /api/v1/me -> $sttok ($(m4_oneline < "$me"))"
    else
        tok=$(jget "$me" csrf_token) || tok=""
        [ -n "$tok" ] || note="GET /api/v1/me 200 but the body has no csrf_token"
    fi
    if [ -n "$note" ]; then
        LAST_NOTE="${LAST_NOTE:+$LAST_NOTE; }refresh_csrf($user): $note"
        return 1
    fi
    CSRF[$user]="$tok"
    say "csrf($user): token re-read from GET /api/v1/me (length ${#tok})"
    return 0
}
req() { # req <user> <METHOD> <path> [json] — _req plus ONE stale-CSRF repair
    local user="$1" method="$2" path="$3" body="${4:-}" st
    _req "$user" "$method" "$path" "$body" || return $?
    # Only a 403 naming the CSRF token is retryable here: that is a stale
    # credential the driver can re-read (the shared per-user jar rotated under
    # it — e.g. by the seed it just ran). A 403 from authorization or the
    # strict-origin check is the server's real answer: pass it through so the
    # caller's `need` FAILs on it unchanged.
    [ "$LAST_STATUS" = 403 ] || return 0
    grep -qi 'CSRF Token Invalid' "$LAST_BODY_FILE" 2>/dev/null || return 0
    st="$LAST_STATUS"
    if ! refresh_csrf "$user"; then
        LAST_STATUS="$st"; return 0
    fi
    say "csrf($user): retrying $method $path once after a stale-token 403"
    _req "$user" "$method" "$path" "$body"
    return 0
}
# (No ok() helper here on purpose: every branch in this driver is an explicit
# `need` allow-list or a case on LAST_STATUS — an unused status helper is
# exactly how the pass-2 un-called gh_label_issue hid behind SC2329.)
# need <label> <allowed statuses...> — driver-fatal unless one matched
need() { local label="$1" s; shift
    for s in "$@"; do [ "$LAST_STATUS" = "$s" ] && return 0; done
    loud "$label — allowed=[$*] got=[$LAST_STATUS] ($LAST_NOTE)"; }

login() { # login <user> — seed.sh's IdP legs
    local user="$1" loc form cb
    JAR[$user]="$(m4_jar "$user")"; mkdir -p "$(dirname "${JAR[$user]}")"; rm -f "${JAR[$user]}"
    LAST_BODY_FILE="$WORK/login-$user.body"
    loc=$(curl -sS --max-time 30 -c "${JAR[$user]}" -o "$WORK/login-$user.out" -w '%{redirect_url}' \
              "$M4_URL/auth/login?return_to=/projects" 2>"$WORK/curl.err") \
        || { LAST_NOTE="curl: $(m4_oneline < "$WORK/curl.err")"; loud "login($user): GET /auth/login unreachable"; }
    [ -n "$loc" ] || loud "login($user): /auth/login did not redirect"
    form=$(curl -sS --max-time 30 -b "${JAR[$user]}" -c "${JAR[$user]}" "$loc" 2>"$WORK/curl.err") \
        || { LAST_NOTE="curl: $(m4_oneline < "$WORK/curl.err")"; loud "login($user): GET IdP form $loc"; }
    case "$form" in *'name="username"'*) ;; *) loud "login($user): no username field at $loc" ;; esac
    cb=$(curl -sS --max-time 30 -b "${JAR[$user]}" -c "${JAR[$user]}" -o "$WORK/login-$user.out" \
            -w '%{redirect_url}' -d "username=$user" \
            --data-urlencode "claims={\"email\":\"$user@example.test\"}" "$loc" 2>"$WORK/curl.err") \
        || { LAST_NOTE="curl: $(m4_oneline < "$WORK/curl.err")"; loud "login($user): POST IdP form"; }
    [ -n "$cb" ] || loud "login($user): IdP POST did not redirect to the callback"
    curl -sSL --max-time 30 -b "${JAR[$user]}" -c "${JAR[$user]}" -o /dev/null "$cb" 2>"$WORK/curl.err" \
        || { LAST_NOTE="curl: $(m4_oneline < "$WORK/curl.err")"; loud "login($user): follow callback $cb"; }
    refresh_csrf "$user" || loud "login($user): GET /api/v1/me returned no live session/csrf_token"
    say "login($user): signed in (jar ${JAR[$user]##*/}, csrf length ${#CSRF[$user]})"
}

# ---- GitHub REST: the token rides ONLY a header piped into curl's stdin ------
# gh_api <METHOD> <api-path> [json-body-file-or-empty]
# The Authorization value streams file -> head -> tr -> awk -> `curl -H @-`:
# it never becomes a shell word (no command substitution), never enters any
# process's argv (head/tr/awk receive it on stdin; only the PATH is in argv),
# is never printed, and is never written anywhere. Bodies are secret-free JSON
# files handed over as --data-binary @file. set +x guards the region even
# under `bash -x`, restored to exactly whatever the caller had.
GH_TRACE_WAS_X=0; case $- in *x*) GH_TRACE_WAS_X=1 ;; esac
gh_api() {
    local method="$1" path="$2" bodyfile="${3:-}" sttab rc
    LAST_NOTE=""; LAST_BODY_FILE="$WORK/gh-resp.json"; : > "$LAST_BODY_FILE"
    local -a args=(-sS --max-time 60 -o "$LAST_BODY_FILE" -w '%{http_code}\t%{content_type}'
                   -H 'Accept: application/vnd.github+json'
                   -H 'X-GitHub-Api-Version: 2022-11-28'
                   -H @-)
    [ -n "$bodyfile" ] && args+=( -H 'Content-Type: application/json' --data-binary "@$bodyfile" )
    set +x
    sttab=$( head -c 65537 "$TOKEN_FILE" | tr -d '\r\n' \
                 | awk 'BEGIN{ORS=""; first=1} {if(first){printf "Authorization: Bearer %s", $0; first=0} else {printf "%s", $0}}' \
                 | curl "${args[@]}" -X "$method" "$GH_API$path" 2>"$WORK/gh-curl.err" )
    rc=$?
    if [ "$GH_TRACE_WAS_X" = 1 ]; then set -x; fi
    LAST_STATUS="${sttab%%$'\t'*}"
    [ $rc -ne 0 ] && LAST_STATUS=""
    LAST_NOTE="GitHub $method $path -> ${sttab:-curl rc=$rc} ($(m4_oneline < "$WORK/gh-curl.err"))"
    [ $rc -eq 0 ] || return 2
    return 0
}

# ---- upsert: the lab objects the driver needs, resolved by list --------------
resolve_ids() {
    req admin GET /api/v1/projects || loud "list projects"
    need "list projects" 200
    PROJECT_ID=$(jfind "$LAST_BODY_FILE" items slug "$PROJECT_SLUG" id) || PROJECT_ID=""
    if [ -z "$PROJECT_ID" ]; then
        say "project $PROJECT_SLUG absent — running seed-github-loop.sh first"
        bash "$M4_DIR/seed-github-loop.sh" || loud "seed-github-loop.sh failed"
        # That seed ran its own `login admin`, which rewrote THIS admin jar
        # with a new session, so the token login() cached is dead: re-read it
        # before anything mutates (belt and braces: req() also retries once).
        refresh_csrf admin || loud "refresh CSRF for admin after the seed"
        req admin GET /api/v1/projects || loud "list projects (after seed)"
        need "list projects (after seed)" 200
        PROJECT_ID=$(jfind "$LAST_BODY_FILE" items slug "$PROJECT_SLUG" id) \
            || loud "project $PROJECT_SLUG: still absent after the seed"
    fi
    say "project: $PROJECT_ID (slug $PROJECT_SLUG)"
    req admin GET "/api/v1/projects/$PROJECT_ID/repos" || loud "list repos"
    need "list repos" 200
    REPO_ID=$(jfind "$LAST_BODY_FILE" items name "$REPO_NAME" id) \
        || loud "repository $REPO_NAME missing on $PROJECT_SLUG (run: bash docs/compatibility/probes/m4/seed-github-loop.sh)"
    CRED=$(jfind "$LAST_BODY_FILE" items name "$REPO_NAME" credential) || CRED='?'
    [ -n "$CRED" ] || CRED=none
    [ "$CRED" = "configured" ] \
        || say "WARNING: repo $REPO_NAME credential=$CRED (not configured) — clone/issue-read of a PRIVATE repo will fail closed unless the repo is public; check seed-github-loop.sh ran with the token"
    say "repo: $REPO_NAME -> $REPO_ID (credential=$CRED)"
}

# ---- GitHub legs --------------------------------------------------------------
gh_ensure_label() { # comm:go must exist on the repo (422 name_exists is fine)
    jq -cn --arg name "$TRIGGER_LABEL" '{name:$name, color:"0e8a16", description:"communication: run the issue-to-PR loop"}' \
        > "$WORK/label.json" || loud "encode label body (jq)"
    gh_api POST "/repos/$GH_REPO/labels" "$WORK/label.json"
    case "$LAST_STATUS" in
        201) say "label: created $TRIGGER_LABEL on $GH_REPO" ;;
        422) say "label: $TRIGGER_LABEL already exists on $GH_REPO" ;;
        *)   loud "ensure label $TRIGGER_LABEL (POST /repos/$GH_REPO/labels) — $LAST_NOTE" ;;
    esac
}
gh_create_issue() { # -> ISSUE_NUMBER (ticket body in a secret-free file)
    jq -cn --arg title "$TICKET_TITLE" --arg body "$TICKET_BODY" '{title:$title, body:$body}' \
        > "$WORK/issue.json" || loud "encode issue body (jq)"
    gh_api POST "/repos/$GH_REPO/issues" "$WORK/issue.json"
    need "create issue via GitHub (POST /repos/$GH_REPO/issues)" 201
    ISSUE_NUMBER=$(jget "$LAST_BODY_FILE" number) || loud "GitHub issue create has no number"
    ISSUE_URL=$(jget "$LAST_BODY_FILE" html_url || true)
    say "issue #${ISSUE_NUMBER}: created on $GH_REPO (${ISSUE_URL:-no html_url})"
}
gh_label_issue() {
    jq -cn --arg l "$TRIGGER_LABEL" '{labels:[$l]}' > "$WORK/labels.json" \
        || loud "encode issue-label body (jq)"
    gh_api POST "/repos/$GH_REPO/issues/$ISSUE_NUMBER/labels" "$WORK/labels.json"
    need "add label to issue (POST /repos/$GH_REPO/issues/N/labels)" 200 201
    say "issue #${ISSUE_NUMBER}: labeled $TRIGGER_LABEL — waiting up to ${FIRE_WAIT}s for the trigger to fire"
}
gh_read_pr() { # gh_read_pr <pr-url> — fetches the pull; leaves body + prints n
    local url="$1" o r n
    o=$(printf '%s' "$url" | sed -nE 's#^https://github\.com/([^/]+)/([^/]+)/pull/[0-9]+/?$#\1#p')
    r=$(printf '%s' "$url" | sed -nE 's#^https://github\.com/([^/]+)/([^/]+)/pull/[0-9]+/?$#\2#p')
    n=$(printf '%s' "$url" | sed -nE 's#^https://github\.com/[^/]+/[^/]+/pull/([0-9]+).*$#\1#p')
    { [ -n "$o" ] && [ -n "$r" ] && [ -n "$n" ]; } || { LAST_NOTE="pr_url [$url] is not https://github.com/<owner>/<repo>/pull/<n>"; return 1; }
    gh_api GET "/repos/$o/$r/pulls/$n"
    # A non-200 here is a per-issue fact (the agent reported a URL that does
    # not exist), never a driver fault: return 1 and let the caller record the
    # FAIL with the observed body.
    [ "$LAST_STATUS" = 200 ] || return 1
    return 0
}

# ---- the loop for one issue ----------------------------------------------------
run_one() { # run_one <n> — creates the ticket, drives the run, prints the verdict
    local n="$1" t0 now ST RUN_ID APPR APPR_VER DRAFT HEAD REF PR_URL
    ticket "$n"
    gh_ensure_label
    gh_create_issue
    gh_label_issue
    REF="${GH_REPO}#${ISSUE_NUMBER}"

    # 1. wait for the trigger to create the run (GET the project's issue runs)
    RUN_ID=""
    t0=$(date +%s)
    while :; do
        req admin GET "/api/v1/projects/$PROJECT_ID/runs?trigger=issue" || loud "list issue runs"
        need "list issue runs" 200
        cp "$LAST_BODY_FILE" "$WORK/runs.json"
        RUN_ID=$(run_for_ref "$WORK/runs.json" "$REF") || RUN_ID=""
        now=$(date +%s)
        if [ -n "$RUN_ID" ]; then say "issue #${ISSUE_NUMBER}: run $RUN_ID started by the trigger ($((now - t0))s after the label)"; break; fi
        if [ $((now - t0)) -ge "$FIRE_WAIT" ]; then
            say "FAIL run=- issue=#${ISSUE_NUMBER} pr=- — no run appeared for trigger ref $REF within ${FIRE_WAIT}s; trigger state below"
            run_sql "SELECT '      T ' || id || ' enabled=' || enabled::text || ' last_error=' || COALESCE(last_error,'-') || ' last_polled=' || COALESCE(last_polled_at::text,'never') FROM issue_triggers WHERE project_id = '$PROJECT_ID'" | head -5
            FAILS=$((FAILS + 1)); return
        fi
        [ $(((now - t0) % 60)) -lt "$STEP" ] && say "issue #${ISSUE_NUMBER}: waiting for the trigger fire ($((now - t0))s / ${FIRE_WAIT}s)"
        sleep "$STEP"
    done

    # 2. drive the run: approve the gate when it waits, poll to terminal
    t0=$(date +%s)
    ST=""
    while :; do
        req admin GET "/api/v1/runs/$RUN_ID" || loud "poll GET /runs/\$id"
        need "poll GET /runs/\$id" 200
        ST=$(jget "$LAST_BODY_FILE" status || echo '?')
        if [ "$ST" = "waiting_human" ]; then
            req admin GET "/api/v1/approvals?status=pending" || loud "list pending approvals"
            need "list pending approvals" 200
            cp "$LAST_BODY_FILE" "$WORK/appr.json"
            APPR=$(pending_approval_for "$WORK/appr.json" "$RUN_ID") || APPR=""
            if [ -n "$APPR" ]; then
                req admin GET "/api/v1/approvals/$APPR" || loud "GET approval $APPR"
                need "GET approval" 200
                APPR_VER=$(jget "$LAST_BODY_FILE" version) || loud "approval $APPR has no version"
                req admin POST "/api/v1/approvals/$APPR/decide" "{\"decision\":\"approved\",\"version\":$APPR_VER}"
                need "decide approval $APPR (POST /approvals/\$id/decide as admin/maintainer)" 200 409
                say "issue #${ISSUE_NUMBER}: gate $APPR decided approved (HTTP $LAST_STATUS) — run resumes through the advancer"
            fi
        fi
        now=$(date +%s)
        case "$ST" in completed|failed|cancelled|interrupted) break ;; esac
        if [ $((now - t0)) -ge "$RUN_WAIT" ]; then
            say "FAIL run=$RUN_ID issue=#${ISSUE_NUMBER} pr=- — still $ST after ${RUN_WAIT}s (not terminal inside the window)"
            dump_failure "$RUN_ID"
            FAILS=$((FAILS + 1)); return
        fi
        [ $(((now - t0) % 120)) -lt "$STEP" ] && say "issue #${ISSUE_NUMBER}: run $ST ($((now - t0))s / ${RUN_WAIT}s)"
        sleep "$STEP"
    done

    # 3. assertions: completed → outputs.pr_url → the PR itself is draft
    if [ "$ST" != "completed" ]; then
        say "FAIL run=$RUN_ID issue=#${ISSUE_NUMBER} pr=- — run status $ST, not completed"
        dump_failure "$RUN_ID"
        FAILS=$((FAILS + 1)); return
    fi
    req admin GET "/api/v1/runs/$RUN_ID/nodes" || loud "GET run nodes"
    need "list run nodes" 200
    cp "$LAST_BODY_FILE" "$WORK/nodes.json"
    PR_URL=$(python3 -c '
import json, sys
d = json.load(open(sys.argv[1]))
for row in d.get("node_executions") or []:
    if row.get("node_id") == "implement":
        print(((row.get("outputs") or {}).get("pr_url")) or ""); sys.exit(0)
print(""); ' "$WORK/nodes.json" 2>/dev/null || echo '')
    if ! printf '%s' "$PR_URL" | grep -qE '^https://github\.com/[^/]+/[^/]+/pull/[0-9]+$'; then
        say "FAIL run=$RUN_ID issue=#${ISSUE_NUMBER} pr=${PR_URL:--} — implement outputs.pr_url is not a github.com/.../pull/N URL"
        dump_failure "$RUN_ID"
        FAILS=$((FAILS + 1)); return
    fi
    if ! gh_read_pr "$PR_URL"; then
        say "FAIL run=$RUN_ID issue=#${ISSUE_NUMBER} pr=$PR_URL — GitHub GET failed ($LAST_NOTE); response: $(m4_oneline < "$WORK/gh-resp.json")"
        FAILS=$((FAILS + 1)); return
    fi
    DRAFT=$(jget "$LAST_BODY_FILE" draft || echo '?')
    HEAD=$(jget "$LAST_BODY_FILE" head.ref || echo '')
    case "$HEAD" in comm/issue-*) HEAD_OK=yes ;; *) HEAD_OK=no ;; esac
    if [ "$DRAFT" = "true" ] && [ "$HEAD_OK" = "yes" ]; then
        say "PASS run=$RUN_ID issue=#${ISSUE_NUMBER} pr=$PR_URL (draft=true head=$HEAD)"
        return
    fi
    say "FAIL run=$RUN_ID issue=#${ISSUE_NUMBER} pr=$PR_URL — observed draft=$DRAFT head=$HEAD (want draft=true, head starting comm/issue-)"
    FAILS=$((FAILS + 1))
}

# dump_failure <run_id> — the failing node's error (API) + the last events
# (SELECT-only psql), so a FAIL line is never bare.
dump_failure() {
    local rid="$1" neid
    req admin GET "/api/v1/runs/$rid/nodes" && [ "$LAST_STATUS" = 200 ] || return 0
    cp "$LAST_BODY_FILE" "$WORK/fail-nodes.json"
    python3 - "$WORK/fail-nodes.json" <<'PY' | sed 's/^/      /'
import json, sys
d = json.load(open(sys.argv[1]))
for n in d.get("node_executions") or []:
    if n.get("status") in ("failed", "interrupted"):
        print(f"NODE {n['node_id']} status={n['status']} error_class={n.get('error_class') or '-'} outcome={n.get('outcome') or '-'}")
PY
    neid=$(python3 -c '
import json,sys
d=json.load(open(sys.argv[1]))
print(next((n["id"] for n in d.get("node_executions") or [] if n.get("status")=="failed"),""))
' "$WORK/fail-nodes.json" 2>/dev/null || echo '')
    if [ -n "$neid" ]; then
        req admin GET "/api/v1/runs/$rid/nodes/$neid" && [ "$LAST_STATUS" = 200 ] || return 0
        cp "$LAST_BODY_FILE" "$WORK/fail-node.json"
        python3 - "$WORK/fail-node.json" <<'PY' | sed 's/^/      /'
import json, sys
d = json.load(open(sys.argv[1]))
for a in d.get("attempts") or []:
    det = (a.get("detail") or "").replace("\n", " ")
    print(f"ATTEMPT n={a.get('attempt_number')} status={a.get('status')} error_class={a.get('error_class') or '-'} detail={det[:300]}")
    if a.get("output_errors"): print(f"  output_errors={json.dumps(a['output_errors'])[:300]}")
PY
    fi
    say "last events (journal tail):"
    run_sql "SELECT '      E ' || global_seq || ' ' || type || ' ' || LEFT(payload::text, 240) FROM domain_events WHERE run_id = '$rid' ORDER BY global_seq DESC LIMIT 15" | tac
}

# Sourced (`. gh-loop.sh`, so BASH_SOURCE[0] != $0) this file defines the
# helpers and runs nothing else — that is how the CSRF-refresh path is
# demonstrated against a live lab without driving real GitHub issues. Executed,
# it runs main below.
if [ "${BASH_SOURCE[0]}" != "${0}" ]; then return 0; fi

# ================================= main =========================================
say "driver target $M4_URL (repo $GH_REPO via $GH_API; the stack is never rebuilt, restarted or configured here)"
[ -n "$TOKEN_FILE" ] && [ -r "$TOKEN_FILE" ] \
    || { LAST_NOTE="GitHub writes need the token: export COMMUNICATION_TEST_REPO_TOKEN_FILE=/path/to/token-file"; loud "COMMUNICATION_TEST_REPO_TOKEN_FILE unset or unreadable"; }
if ! m4_stack_up; then
    LAST_NOTE="both API replicas (${M4_API_A} ${M4_API_B}) failed /api/v1/system/readiness — bring the lab up first (compose.real.yml); this driver never touches the stack"
    loud "stack not ready"
fi
say "readiness: both replicas 200"

login admin
resolve_ids
for i in $(seq 1 "$N"); do
    run_one "$i"
done

if [ "$FAILS" -gt 0 ]; then
    say "done — $FAILS of $N issue(s) FAILED (verdict lines above; failing-node errors and journal tails printed for each)"
    exit 1
fi
say "done — all $N issue(s) closed with a draft PR"
exit 0
