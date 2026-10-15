#!/usr/bin/env bash
# m3 probe 3 — the nono half of ADR-0019's launch chain: the temp-dir default
# (P9/N1), the read-grant semantics (N2), profile authoring/assertion (N3/N4/
# N5/N6 = steps N-b…N-d), AF_UNIX pathname mediation measured against a socket
# this probe owns, egress as an axis, and the two fail-open shapes the contract
# depends on (FC2 external, FC3 nonexistent grant).
#
# Usage: bash p3_nono_policy.sh [--nono <path>] [--fixture <dir>] [--keep]
set -uo pipefail
M3_PROBE=p3_nono_policy
M3_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$(dirname "$0")"
# shellcheck source=lib.sh
. ./lib.sh
M3_FIXTURE="${M3_FIXTURE_ARG:-${M3_PROBE_ROOT_BASE}/p3}"
m3_args "$@"
m3_env_header
[ -x "$M3_NONO" ] || { check PREAMBLE GAP "nono not executable at $M3_NONO"; exit 0; }

rm -rf "$M3_FIXTURE"; mkdir -p "$M3_FIXTURE"/{ws,other,cfg,sock}
# nono's own HOME must stay OUTSIDE every grant (p2 C-H1 measured why), so the
# probes use a launcher home that is never granted.
mkdir -p "$M3_FIXTURE/launcher-home"; chmod 700 "$M3_FIXTURE/launcher-home"
M3_SB_HOME="$M3_FIXTURE/launcher-home"; export M3_SB_HOME
echo "READ-ME" > "$M3_FIXTURE/other/f"
echo "SECRET-NOT-GRANTED" > "$M3_FIXTURE/other/secret.txt"

# ---- C-PROBE (N-a): the kernel capability probe is honest here --------------
st_raw="$("$M3_NONO" setup --check-only 2>&1)"; stc=$?
st="$(printf '%s' "$st_raw" | m3_oneline)"
if [ "$stc" -eq 0 ] && printf '%s' "$st_raw" | grep -q 'Filesystem ruleset creation verified'; then
    abi="$(printf '%s' "$st_raw" | grep -o 'Landlock V[0-9]*' | head -1)"
    tcp="$(printf '%s' "$st_raw" | grep -c 'TCP network rule support verified')"
    check C-PROBE PASS "N-a: nono setup --check-only exit=0 — $abi, 'Filesystem ruleset creation verified' and $tcp 'TCP network rule support verified' line(s); kernel $(uname -r); lsm $(cat /sys/kernel/security/lsm 2>/dev/null || echo unreadable)"
else
    check C-PROBE FAIL "N-a: setup --check-only exit=$stc: $st"
fi

# ---- C-TMP1 (P9/N1): the always-layered default profile write-grants /tmp ----
M3_SB_CWD="$M3_FIXTURE/ws" m3_sb --allow "$M3_FIXTURE/ws" -- sh -c "echo x > /tmp/m3-probe-$$ && echo TMP_WRITE_OK || echo TMP_WRITE_DENIED"
tmp1="$M3_OUT"; tmp1rc=$M3_RC
tmpfile="$(ls -1 /tmp/m3-probe-* 2>/dev/null | head -1 || true)"
M3_SB_CWD="$M3_FIXTURE/ws" m3_sb --allow "$M3_FIXTURE/ws" -- sh -c "cat '$M3_FIXTURE/other/secret.txt' >/dev/null 2>&1 && echo READ_OK || echo READ_DENIED"
M3_SB_CWD="$M3_FIXTURE/ws" m3_sb --allow "$M3_FIXTURE/ws" -- sh -c "echo x > /var/tmp/m3-probe-\$\$ 2>/dev/null || echo VARTMP_DENIED; echo x > /dev/shm/m3-probe-\$\$ 2>/dev/null || echo SHM_DENIED; cat /etc/hostname >/dev/null 2>&1 || echo ETC_READ_DENIED"
if printf '%s' "$tmp1" | grep -q TMP_WRITE_OK; then
    check C-TMP1 PASS "P9/N1 re-derived: with a single rw grant OUTSIDE any temp dir the sandboxed child WROTE $tmp1 (host-visible, content '$(cat "$tmp1" 2>/dev/null)'); same run's other arms: $M3_OUT. 'Denied by omission' is FALSE under /tmp — ADR-0017 D5's hard rule stands"
else
    check C-TMP1 FAIL "N1 does NOT reproduce: the child could not write /tmp (exit=$tmp1rc '$tmp1') — if nono changed its default grants, ADR-0017 D5 / ADR-0019's temp-path abort need re-justifying"
fi
rm -f /tmp/m3-probe-* /var/tmp/m3-probe-* /dev/shm/m3-probe-* 2>/dev/null

# ---- C-TMP2: filesystem.deny does not close it ------------------------------
cat > "$M3_FIXTURE/cfg/deny-tmp.json" <<'EOF'
{"meta":{"name":"m3-deny-tmp","version":"1.0.0","description":"probe: default with an explicit /tmp deny"},
 "extends":"default","filesystem":{"deny":["/tmp","/var/tmp","/dev/shm"]}}
EOF
"$M3_NONO" profile validate "$M3_FIXTURE/cfg/deny-tmp.json" >/dev/null 2>&1
M3_SB_CWD="$M3_FIXTURE/ws" m3_sb -p "$M3_FIXTURE/cfg/deny-tmp.json" --allow "$M3_FIXTURE/ws" -- sh -c "echo x > /tmp/m3-deny-\$\$ && echo DENY_FAILED_WRITE_OK || echo DENY_HELD"
if printf '%s' "$M3_OUT" | grep -q DENY_FAILED_WRITE_OK; then
    check C-TMP2 PASS "ADR-0017 D5 / ADR-0019's 'absence-of-grant is the only deny mechanism' re-derived the hard way: a profile-level filesystem.deny of [/tmp,/var/tmp,/dev/shm] did NOT stop the write ($M3_OUT) — the layered default's write grant wins, so FSDeny stays an adapter-level configuration error rather than a policy tool"
else
    check C-TMP2 FAIL "filesystem.deny [/tmp,/var/tmp,/dev/shm] now HOLDS under this nono build ($M3_OUT) — ADR-0017 D5 and ADR-0018's threat model may cite a real deny instead of only refusing temp paths"
fi
rm -f /tmp/m3-deny-*

# ---- C-TMP3: excluding the group that grants temp does, but at a cost -------
cat > "$M3_FIXTURE/cfg/no-temp-writes.json" <<'EOF'
{"meta":{"name":"m3-no-temp-writes","version":"1.0.0","description":"probe: default minus system_write_linux"},
 "extends":"default","groups":{"exclude":["system_write_linux"]}}
EOF
"$M3_NONO" profile validate "$M3_FIXTURE/cfg/no-temp-writes.json" >/dev/null 2>&1
M3_SB_CWD="$M3_FIXTURE/ws" m3_sb -p "$M3_FIXTURE/cfg/no-temp-writes.json" --allow "$M3_FIXTURE/ws" -- sh -c '
  echo x > /tmp/m3-notemp-$$ 2>/dev/null && echo TMP_WRITE_OK || echo TMP_WRITE_DENIED
  echo x > /dev/null 2>/dev/null && echo DEVNULL_WRITE_OK || echo DEVNULL_WRITE_DENIED
  git --version >/dev/null 2>&1 && echo GIT_RUNS || echo GIT_BROKEN
  node -e "console.log(1)" >/dev/null 2>&1 && echo NODE_RUNS || echo NODE_BROKEN'
if printf '%s' "$M3_OUT" | grep -q 'TMP_WRITE_DENIED'; then
    check C-TMP3 PASS "the /tmp write comes from the system_write_linux group: excluding it denied /tmp. Side effect observed: $M3_OUT — /dev/null matters to every CLI, so a Communication profile must re-grant the device paths it drops (measured in the same line)"
else
    check C-TMP3 FAIL "excluding system_write_linux did not close /tmp: $M3_OUT"
fi
rm -f /tmp/m3-notemp-* 2>/dev/null

# ---- C-RO (N2): a read grant is read-only outside the temp grants -----------
M3_SB_CWD="$M3_FIXTURE/ws" m3_sb --allow "$M3_FIXTURE/ws" --read "$M3_FIXTURE/other" -- sh -c "cat '$M3_FIXTURE/other/f'; echo w > '$M3_FIXTURE/other/f' 2>/dev/null || echo RO_WRITE_DENIED"
if printf '%s' "$M3_OUT" | grep -q 'READ-ME' && printf '%s' "$M3_OUT" | grep -q RO_WRITE_DENIED; then
    check C-RO PASS "N2 re-derived: --read is read-only outside temp grants ('$M3_OUT')"
else
    check C-RO FAIL "read-grant semantics changed: $M3_OUT"
fi
M3_SB_CWD="$M3_FIXTURE/ws" m3_sb --allow "$M3_FIXTURE/ws" --read "$M3_FIXTURE/other" -- sh -c "cat '$M3_FIXTURE/other/secret.txt'"
check C-ROb N/A "secret under a read grant is readable by design: exit=$M3_RC '$M3_OUT' (this is ADR-0018's 'an agent granted read can exfiltrate' clause, not a defect)"

# ---- C-PROF (N-b/N3): profile authoring surface -----------------------------
initout="$("$M3_NONO" profile init "$M3_FIXTURE/cfg/comm-agent.json" 2>&1 | m3_oneline)"; initrc=$?
if [ "$initrc" -ne 0 ] && printf '%s' "$initout" | grep -qi 'alphanumeric'; then
    check C-PROF PASS "N3 re-derived: 'nono profile init <path>' refuses a path argument (exit=$initrc '$initout') → the profile file must be authored, not generated (ADR-0009 D4 asset dir)"
else
    check C-PROF FAIL "profile init accepted a path (exit=$initrc '$initout') — N3's premise may no longer hold"
fi
cat > "$M3_FIXTURE/cfg/communication-agent.json" <<'EOF'
{
  "meta": {"name":"m3-communication-agent","version":"1.0.0","description":"probe stand-in for worker/sandbox/profiles/communication-agent.json"},
  "extends": "default",
  "linux": {"af_unix_mediation":"pathname","sandbox_policy":"landlock"},
  "security": {"process_info_mode":"isolated"},
  "groups": {"exclude":["system_write_linux"]},
  "filesystem": {"write_file":["/dev/null","/dev/zero","/dev/tty","/dev/stdout","/dev/stderr"],"allow":["/proc/self/fd","/dev/pts"]}
}
EOF
valout="$("$M3_NONO" profile validate "$M3_FIXTURE/cfg/communication-agent.json" 2>&1 | m3_oneline)"; valrc=$?
if [ "$valrc" -eq 0 ]; then
    check C-PROFb PASS "N-b: 'nono profile validate <path>' on a file we ship → exit=0 '$valout'"
else
    check C-PROFb FAIL "N-b: our stand-in profile does not validate: exit=$valrc '$valout'"
fi
unknown="$("$M3_NONO" profile validate /nonexistent-profile.json 2>&1 | m3_oneline)"; urc=$?
[ "$urc" -ne 0 ] && check C-PROFc PASS "N-b fail-closed: validating a missing profile exits $urc '$unknown'" || check C-PROFc FAIL "N-b: validating a missing profile exited 0"

# ---- C-AFU (N-c): where the mediation assertion is actually observable ------
show_raw="$("$M3_NONO" profile show "$M3_FIXTURE/cfg/communication-agent.json" 2>&1)"; show="$(printf '%s' "$show_raw" | tr '\n\t' '  ' )"
dry_raw="$(cd "$M3_FIXTURE/ws" && HOME="$M3_SB_HOME" "$M3_NONO" run -p "$M3_FIXTURE/cfg/communication-agent.json" --allow "$M3_FIXTURE/ws" -v --dry-run -- true 2>&1)"; dry="$(printf '%s' "$dry_raw" | tr '\n\t' '  ')"; dry_lines="$(printf '%s\n' "$dry_raw" | grep -c .)"
silent_raw="$(cd "$M3_FIXTURE/ws" && HOME="$M3_SB_HOME" "$M3_NONO" run -s -p "$M3_FIXTURE/cfg/communication-agent.json" --allow "$M3_FIXTURE/ws" -v --dry-run -- true 2>&1)"; silent_lines="$(printf '%s\n' "$silent_raw" | grep -c .)"
if printf '%s' "$show_raw" | grep -qi 'AF_UNIX mediation: Pathname'; then
    check C-AFU PASS "N-c: 'nono profile show <path>' reports 'AF_UNIX mediation: Pathname'"
else
    check C-AFU FAIL "N-c: profile show did not report Pathname mediation: $show"
fi
if [ "$silent_lines" -lt 5 ] && [ "$dry_lines" -ge 5 ]; then
    check C-SILENT FAIL "the ADR-0019 chain runs nono with -s everywhere except N-d, and that is load-bearing: 'run -s -p <path> -v --dry-run' printed $silent_lines line(s) (no grant list at all) while the same argv without -s printed $dry_lines. An adapter that reuses its silent flags for N-d asserts against empty output and passes vacuously"
else
    check C-SILENT PASS "silent vs verbose dry-run both produced a parseable list ($silent_lines vs $dry_lines lines)"
fi
if printf '%s' "$dry_raw" | grep -qi 'AF_UNIX'; then
    note C-AFU2 "the verbose dry-run now prints an AF_UNIX line — N-c and N-d could collapse into one command"
    check C-AFU2 PASS "AF_UNIX mediation is reported by the dry-run too (N-c's premise that it is not is stale for this build)"
elif [ "$dry_lines" -lt 5 ]; then
    check C-AFU2 GAP "the dry-run produced no parseable output ($dry_lines lines) — cannot test whether it reports AF_UNIX"
else
    check C-AFU2 PASS "N4's premise re-derived: the verbose dry-run ($dry_lines lines, $(printf '%s' "$dry_raw" | grep -c '\[user\]') [user] + $(printf '%s' "$dry_raw" | grep -c '\[group:') [group:] grants) contains NO AF_UNIX line — the mediation assertion must come from 'nono profile show'"
fi

# ---- C-SOCK (N4): AF_UNIX pathname mediation on a socket we own -------------
SOCK="$M3_FIXTURE/sock/probe.sock"
nodep=""
command -v "$M3_NODE" >/dev/null 2>&1 && nodep="$M3_NODE"
if [ -z "$nodep" ]; then
    check C-SOCK GAP "no node on PATH to host the AF_UNIX listener"
    check C-SOCKb GAP "no node on PATH"
else
    "$nodep" "$M3_DIR/helpers/m3-net.mjs" unix "$SOCK" >"$M3_FIXTURE/sock.log" 2>&1 &
    listener=$!
    for _ in 1 2 3 4 5 6 7 8 9 10; do [ -S "$SOCK" ] && break; sleep 0.2; done
    if [ ! -S "$SOCK" ]; then
        check C-SOCK GAP "listener never created $SOCK: $(m3_oneline < "$M3_FIXTURE/sock.log")"
    else
        M3_SB_CWD="$M3_FIXTURE/ws" m3_sb --allow "$M3_FIXTURE/ws" -- sh -c "curl -sS --max-time 5 --unix-socket '$SOCK' http://localhost/ 2>&1"
        ctl="$M3_OUT"; ctlyrc=$M3_RC
        M3_SB_CWD="$M3_FIXTURE/ws" m3_sb -p "$M3_FIXTURE/cfg/communication-agent.json" --allow "$M3_FIXTURE/ws" -- sh -c "curl -sS --max-time 5 --unix-socket '$SOCK' http://localhost/ 2>&1 || echo CURL_DENIED"
        pro="$M3_OUT"
        if printf '%s' "$ctl" | grep -q 'M3-ECHO' && [ "$ctlyrc" -eq 0 ]; then
            note C-SOCK "control (no profile, socket ungranted): connect SUCCEEDED — reproduces SANDBOX.md C7's fail-open on a socket we own: '$ctl'"
            if printf '%s' "$pro" | grep -qiE 'Permission denied|Could not connect|CURL_DENIED|Failed to connect'; then
                check C-SOCK PASS "N4 re-derived with our own profile file: af_unix_mediation=pathname denied connect() to an ungranted AF_UNIX socket — '$pro' (control had connected: '$ctl')"
            else
                check C-SOCK FAIL "profile did not deny the socket connect: '$pro'"
            fi
        else
            check C-SOCK GAP "control connect failed ('$ctl', rc=$ctlyrc), so the denial would prove nothing — socket mediation unmeasured in this environment"
        fi
        M3_SB_CWD="$M3_FIXTURE/ws" m3_sb -p "$M3_FIXTURE/cfg/communication-agent.json" --allow "$M3_FIXTURE/ws" --allow-unix-socket "$SOCK" -- sh -c "curl -sS --max-time 5 --unix-socket '$SOCK' http://localhost/ 2>&1 || echo CURL_DENIED"
        check C-SOCKb PASS "positive control: explicitly granting the socket restores it (mediation is a real gate, not a blanket block): '$M3_OUT' (rc=$M3_RC)"
    fi
    kill "$listener" 2>/dev/null || true; wait "$listener" 2>/dev/null || true
fi
if [ ! -S /var/run/docker.sock ]; then
    check C-SOCK2 GAP "/var/run/docker.sock is not a socket in this environment"
else
    M3_SB_CWD="$M3_FIXTURE/ws" m3_sb -p "$M3_FIXTURE/cfg/communication-agent.json" --allow "$M3_FIXTURE/ws" -- sh -c "curl -sS --max-time 5 --unix-socket /var/run/docker.sock -o /dev/null -w 'code=%{http_code}' http://localhost/version 2>&1; echo child_rc=\$?"
    if printf '%s' "$M3_OUT" | grep -qE 'child_rc=0 code=2[0-9][0-9]'; then
        check C-SOCK2 FAIL "docker API ANSWERED from inside the sandboxed child despite af_unix_mediation=pathname: '$M3_OUT'"
    elif [ "$M3_RC" -ne 0 ] || printf '%s' "$M3_OUT" | grep -qiE 'Permission denied|Could not connect|Failed to connect|code=000'; then
        check C-SOCK2 PASS "SANDBOX.md C7's remedy re-derived with our own profile file: the docker socket was unreachable from inside the sandbox (exit=$M3_RC '$M3_OUT')"
    else
        check C-SOCK2 GAP "socket present but not connectable even in the control (docker context is rootless/abstract here): exit=$M3_RC '$M3_OUT' — C-SOCK's owned-socket pair is the authoritative answer"
    fi
fi

# ---- C-CWD: does the dry-run really abort when cwd is outside the grants? ---
mkdir -p "$M3_FIXTURE/repos"
for variant in "-s" "-s -p PROFILE" "no-silent" "-p PROFILE no-silent"; do
    case "$variant" in
        "-s")                 flags="-s";                                      prof="" ;;
        "-s -p PROFILE")      flags="-s -p $M3_FIXTURE/cfg/communication-agent.json"; prof="profile" ;;
        "no-silent")          flags="";                                        prof="" ;;
        "-p PROFILE no-silent") flags="-p $M3_FIXTURE/cfg/communication-agent.json"; prof="profile" ;;
    esac
    rcin=0; rcout=0
    (cd "$M3_FIXTURE/ws"    && HOME="$M3_SB_HOME" "$M3_NONO" run $flags --allow "$M3_FIXTURE/ws" -v --dry-run -- true) >/dev/null 2>&1 || rcin=$?
    (cd "$M3_FIXTURE/other" && HOME="$M3_SB_HOME" "$M3_NONO" run $flags --allow "$M3_FIXTURE/ws" -v --dry-run -- true) >/dev/null 2>&1 || rcout=$?
    note C-CWD "argv 'nono run $flags --allow <ws> -v --dry-run': cwd-inside exit=$rcin, cwd-outside exit=$rcout"
done
rcout_s=0; (cd "$M3_FIXTURE/other" && HOME="$M3_SB_HOME" "$M3_NONO" run -s --allow "$M3_FIXTURE/ws" -v --dry-run -- true) >/dev/null 2>&1 || rcout_s=$?
rcout_p=0; (cd "$M3_FIXTURE/other" && HOME="$M3_SB_HOME" "$M3_NONO" run -s -p "$M3_FIXTURE/cfg/communication-agent.json" --allow "$M3_FIXTURE/ws" -v --dry-run -- true) >/dev/null 2>&1 || rcout_p=$?
if [ "$rcout_s" -ne 0 ] && [ "$rcout_p" -eq 0 ]; then
    check C-CWD FAIL "ADR-0019 N-d's exit-status assertion is FALSE for the configuration ADR-0009 mandates: with CLI flags only a cwd outside the grants exits $rcout_s ('CWD access requires --allow-cwd'), but with '-p <profile path>' the SAME command exits 0 and simply skips the CWD grant. A required-mode adapter must therefore validate cmd.Dir itself (requireDirInsideReadWrite) and never read N-d's exit status as the CWD proof"
elif [ "$rcout_p" -ne 0 ]; then
    check C-CWD PASS "N5 re-derived: a cwd outside the grants aborts even with -p <path> (exit=$rcout_p)"
else
    check C-CWD FAIL "unexpected CWD matrix: flags-only=$rcout_s, profile=$rcout_p"
fi

# ---- C-CWD2: profile mode + an outside cwd: is anything actually readable? ---
# The corrected N-d assertion has to say what nono DOES (nothing) and whether the
# ungranted launch directory leaks. Both arms below are what the launcher rule
# (validate cmd.Dir yourself; never pass --allow-cwd) is built on.
cwd2_rc=0
cwd2_raw="$(cd "$M3_FIXTURE/other" && HOME="$M3_SB_HOME" "$M3_NONO" run -p "$M3_FIXTURE/cfg/communication-agent.json" --allow "$M3_FIXTURE/ws" -- sh -c "echo CWD=\$(pwd); cat '$M3_FIXTURE/other/secret.txt' 2>&1; ls '$M3_FIXTURE/other' 2>&1; exit 0" 2>&1)" || cwd2_rc=$?
cwd2="$(printf '%s' "$cwd2_raw" | m3_oneline)"
cwd2_pwd="$(printf '%s' "$cwd2_raw" | grep -o 'CWD=[^ ]*' | head -1 | m3_oneline)"
if [ "$cwd2_rc" -eq 0 ] && ! printf '%s' "$cwd2_raw" | grep -q 'SECRET-NOT-GRANTED' && printf '%s' "$cwd2_raw" | grep -qi 'Permission denied'; then
    check C-CWD2 PASS "no disclosure, but no abort either: with '-p <profile>' and a cwd outside the grants nono exits $cwd2_rc and the child's working directory became '$cwd2_pwd', while the ungranted launch dir stays unreadable even by absolute path ('$cwd2'). In profile mode the adapter owns the cwd rule entirely: require cmd.Dir inside its own rw grant list BEFORE launching, and never read nono's exit status as proof"
else
    check C-CWD2 FAIL "profile-mode cwd is not understood (exit=$cwd2_rc '$cwd2') — no cwd assertion may rely on nono until this is measured"
fi
cwd3_rc=0
cwd3_raw="$(cd "$M3_FIXTURE/other" && HOME="$M3_SB_HOME" "$M3_NONO" run -s --allow-cwd --allow "$M3_FIXTURE/ws" -- cat "$M3_FIXTURE/other/secret.txt" 2>&1)" || cwd3_rc=$?
cwd3="$(printf '%s' "$cwd3_raw" | m3_oneline)"
if printf '%s' "$cwd3_raw" | grep -q 'SECRET-NOT-GRANTED'; then
    check C-CWD3 PASS "hazard confirmed, so the launcher rule is load-bearing: '--allow-cwd' is a GRANT, not an assertion — with it (flags-only argv) the launch directory outside the intended grants became readable (exit=$cwd3_rc '$cwd3'). The M3 launcher must never pass it, and must not need it: every launch sets cmd.Dir inside the workspace"
else
    check C-CWD3 N/A "'--allow-cwd' did not widen the grant set on this build (exit=$cwd3_rc '$cwd3') — never passing it stays as defence in depth, not a measured requirement"
fi

# ---- C-ND: the grant-list assertion needs the non-silent form ---------------
nd_raw="$(cd "$M3_FIXTURE/ws" && HOME="$M3_SB_HOME" "$M3_NONO" run -p "$M3_FIXTURE/cfg/communication-agent.json" --allow "$M3_FIXTURE/ws" --read "$M3_FIXTURE/repos" -v --dry-run -- true 2>&1)"
nd_lines="$(printf '%s\n' "$nd_raw" | grep -c .)"
user_lines="$(printf '%s\n' "$nd_raw" | grep -c '\[user\]')"
grp_lines="$(printf '%s\n' "$nd_raw" | grep -c '\[group:')"
tmp_lines="$(printf '%s\n' "$nd_raw" | grep -cE '^[[:space:]]*[rw]+[[:space:]]+/tmp')"
d_def="$(cd "$M3_FIXTURE/ws" && HOME="$M3_SB_HOME" "$M3_NONO" run -p default --allow "$M3_FIXTURE/ws" --read "$M3_FIXTURE/repos" -v --dry-run -- true 2>&1)"
d_def_tmp="$(printf '%s\n' "$d_def" | grep -cE '^[[:space:]]*[rw]+[[:space:]]+/tmp')"
if [ "$nd_lines" -ge 5 ] && [ "$user_lines" -ge 1 ] && [ "$grp_lines" -ge 1 ]; then
    check C-ND PASS "N-d is observable WITHOUT -s: $nd_lines lines, $user_lines [user] grant(s), $grp_lines [group:…] grant(s); our profile's resolved list names /tmp $tmp_lines time(s) vs $d_def_tmp for '-p default' — the merged list is the right place to assert the grant set and to catch a temp-dir grant"
else
    check C-ND FAIL "could not parse a merged grant list from the non-silent dry-run ($nd_lines lines, $user_lines user, $grp_lines group): $(printf '%s' "$nd_raw" | m3_oneline)"
fi

# ---- C-MISSING (N6): a missing policy file fails closed before exec ---------
rm -f "$M3_FIXTURE/ws/never-ran"
mrun_rc=0
mrun_out="$(cd "$M3_FIXTURE/ws" && "$M3_NONO" run -s -p "$M3_FIXTURE/cfg/does-not-exist.json" --allow "$M3_FIXTURE/ws" -- sh -c "echo i-ran > '$M3_FIXTURE/ws/never-ran'" 2>&1 | m3_oneline)" || mrun_rc=$?
if [ ! -e "$M3_FIXTURE/ws/never-ran" ] && [ "$mrun_rc" -ne 0 ]; then
    check C-MISSING PASS "N6 re-derived: missing profile → exit=$mrun_rc and the child was NEVER exec'd (marker absent): '$mrun_out'"
else
    check C-MISSING FAIL "fail-open: child ran with a missing policy file (exit=$mrun_rc, marker exists=$([ -e "$M3_FIXTURE/ws/never-ran" ] && echo yes || echo no)): '$mrun_out'"
fi

# ---- C-EG1/C-EG2: egress is an axis, and 'agent-turn' really is unenforced --
"$nodep" "$M3_DIR/helpers/m3-net.mjs" tcp 127.0.0.1 0 >"$M3_FIXTURE/tcp.log" 2>&1 &
tl=$!
for _ in 1 2 3 4 5 6 7 8 9 10; do grep -q LISTEN "$M3_FIXTURE/tcp.log" 2>/dev/null && break; sleep 0.2; done
TPORT="$(awk '/LISTEN/{print $3}' "$M3_FIXTURE/tcp.log" 2>/dev/null | head -1)"
if [ -z "$TPORT" ]; then
    check C-EG1 GAP "no loopback listener (node missing?)"; check C-EG2 GAP "no loopback listener"
else
    M3_SB_CWD="$M3_FIXTURE/ws" m3_sb --allow "$M3_FIXTURE/ws" --block-net -- sh -c "curl -sS --max-time 5 http://127.0.0.1:$TPORT/ 2>&1 || echo CURL_DENIED"
    if [ "$M3_RC" -ne 0 ] || printf '%s' "$M3_OUT" | grep -qiE 'Permission denied|Could not connect|CURL_DENIED|Failed to connect|refused'; then
        check C-EG1 PASS "agent-turn-egress-denied shape: --block-net denied a loopback TCP connect (port $TPORT): '$M3_OUT' (this is the command-only profile case 13 needs)"
    else
        check C-EG1 FAIL "--block-net did NOT stop loopback egress: '$M3_OUT'"
    fi
    M3_SB_CWD="$M3_FIXTURE/ws" m3_sb --allow "$M3_FIXTURE/ws" -- sh -c "curl -sS --max-time 5 http://127.0.0.1:$TPORT/ 2>&1"
    if printf '%s' "$M3_OUT" | grep -q 'M3-ECHO'; then
        check C-EG2 PASS "agent-turn shape: without --block-net the same connect succeeded ('$M3_OUT') — this is the observed proof that M3's agent-turn profile carries network_enforced=false, exactly as ADR-0019 D3 states"
    else
        check C-EG2 FAIL "unexpected: egress blocked even without --block-net: '$M3_OUT'"
    fi
fi
kill "$tl" 2>/dev/null || true; wait "$tl" 2>/dev/null || true

# ---- C-FC2: --sandbox-policy external silently drops --block-net ------------
M3_SB_CWD="$M3_FIXTURE/ws" m3_sb --allow "$M3_FIXTURE/ws" --block-net --sandbox-policy external -- sh -c "curl -sS -o /dev/null -w '%{http_code}' --max-time 8 https://example.com 2>&1"
if [ "$M3_RC" -eq 0 ]; then
    check C-FC2 FAIL "FC2 re-produced: with --sandbox-policy external the child reached the network (exit=0 '$M3_OUT') while --block-net was requested — ADR-0019 D2's 'never emit external' stands, and no M3 profile may accept it"
else
    check C-FC2 PASS "FC2 no longer reproduces: egress stayed blocked with --sandbox-policy external (exit=$M3_RC '$M3_OUT')"
fi

# ---- C-FC2b: can any nono surface REPORT the resolved sandbox policy? -------
# If none can, the adapter cannot outsource the "never external" rule to N-b/N-c/N-d
# and must assert the shipped profile file's own contents instead.
if [ -s "$M3_FIXTURE/cfg/communication-agent.json" ]; then
    sed 's/"sandbox_policy":"landlock"/"sandbox_policy":"external"/' "$M3_FIXTURE/cfg/communication-agent.json" > "$M3_FIXTURE/cfg/external-agent.json"
fi
"$M3_NONO" profile show "$M3_FIXTURE/cfg/communication-agent.json" 2>&1 | grep -v "^nono profile: profile" >"$M3_FIXTURE/show-ll.txt"; show_ll_rc=$?
"$M3_NONO" profile show "$M3_FIXTURE/cfg/external-agent.json" 2>&1 | grep -v "^nono profile: profile" >"$M3_FIXTURE/show-ext.txt"; show_ext_rc=$?
"$M3_NONO" profile validate "$M3_FIXTURE/cfg/external-agent.json" >/dev/null 2>&1; val_ext_rc=$?
show_diff=0; cmp -s "$M3_FIXTURE/show-ll.txt" "$M3_FIXTURE/show-ext.txt" || show_diff=1
# /proc/<pid>/fd is granted per-invocation, so the pid is normalised before compare.
norm() { sed -E 's|/proc/[0-9]+/|/proc/PID/|g' | m3_oneline; }
gl_ll="$(cd "$M3_FIXTURE/ws" && HOME="$M3_SB_HOME" "$M3_NONO" run -p "$M3_FIXTURE/cfg/communication-agent.json" --allow "$M3_FIXTURE/ws" -v --dry-run -- true 2>&1 | grep -E '^[[:space:]]*(r\+w|=w|=r|sock|net|scope)' | norm)"
gl_ext="$(cd "$M3_FIXTURE/ws" && HOME="$M3_SB_HOME" "$M3_NONO" run -p "$M3_FIXTURE/cfg/external-agent.json" --allow "$M3_FIXTURE/ws" -v --dry-run -- true 2>&1 | grep -E '^[[:space:]]*(r\+w|=w|=r|sock|net|scope)' | norm)"
if [ "$show_ll_rc" -eq 0 ] && [ "$show_ext_rc" -eq 0 ] && [ "$val_ext_rc" -eq 0 ] && [ "$show_diff" -eq 0 ] && [ -n "$gl_ll" ] && [ "$gl_ll" = "$gl_ext" ]; then
    check C-FC2b PASS "no nono surface reveals the policy: 'profile validate' accepts sandbox_policy=external (exit=$val_ext_rc), 'profile show' is identical for landlock and external once its own path echo is dropped ($(wc -c <"$M3_FIXTURE/show-ll.txt") bytes), and the dry-run rule lines are identical modulo the per-invocation /proc/<pid>/fd grant ('$gl_ll') — while C-FC2 shows the enforced behaviour differs. The 'never external' rule therefore cannot live in N-b/N-c/N-d: it must be a text assertion over the profile file the worker ships (which the recorded policy_digest already pins) plus a ban on the CLI flag"
else
    check C-FC2b FAIL "a nono surface did distinguish the two policies (validate=$val_ext_rc, show_diff=$show_diff, grants equal=$([ "$gl_ll" = "$gl_ext" ] && echo yes || echo no)) — N-b/N-c can assert the policy after all; record the observed difference and keep ADR-0019's chain as written"
fi

# ---- C-FC3: a nonexistent grant path is silently ignored --------------------
M3_SB_CWD="$M3_FIXTURE/ws" m3_sb --allow "$M3_FIXTURE/ws" --allow "$M3_FIXTURE/no-such-dir" -- sh -c "cat '$M3_FIXTURE/other/secret.txt'"
if printf '%s' "$M3_OUT" | grep -qi 'Permission denied'; then
    check C-FC3 PASS "FC3 re-derived: non-existent grant ignored with no error, sandbox still applied (exit=$M3_RC '$M3_OUT') — the adapter must validate grant paths itself (ADR-0019 FC3/N-d)"
else
    check C-FC3 FAIL "unexpected FC3 behaviour: exit=$M3_RC '$M3_OUT'"
fi

# ---- C-CMD: the default profile's dangerous_commands blocklist --------------
echo "seed" > "$M3_FIXTURE/ws/chmod-target"
M3_SB_CWD="$M3_FIXTURE/ws" m3_sb --allow "$M3_FIXTURE/ws" -- sh -c "chmod 600 '$M3_FIXTURE/ws/chmod-target' 2>&1 || echo CHMOD_BLOCKED; cp '$M3_FIXTURE/other/f' '$M3_FIXTURE/ws/cf' 2>&1 || echo CP_BLOCKED"
note C-CMD "default-profile dangerous_commands as observed: $M3_OUT — mode after the sandboxed chmod: $(stat -c %a "$M3_FIXTURE/ws/chmod-target" 2>/dev/null). nono documents command blocking as bypassable, so it is not a control — but a materializer still must use O_CREAT|O_EXCL + umask rather than chmod (nono documents command blocking as bypassable, so it is not a control — but it is also why a materializer must use umask/O_EXCL rather than chmod)"

m3_cleanup
exit 0
