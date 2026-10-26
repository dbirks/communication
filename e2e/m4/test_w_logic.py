#!/usr/bin/env python3
"""Offline unit tests for the W-leg browser helpers' PURE halves (§ 7.2 W1/W2/W3/W4/W7/W8/W9/W10/W11).

Nothing here touches the stack: the snapshot-YAML ref parser, the spec.inputs
-> form-field expectation builder, the W7 counter verdicts, the W3 approval
verdicts, the W4 pinned-digest/notice verdicts, the W8 Validate-panel verdicts,
the W9 not-found/leakage/SSE/console verdicts, the W2 live-render/order/gap and
iteration verdicts, the W10 resume-cursor/continuity/foreign-event verdicts and
the W11 child-tree/attempt-list/internals-leakage verdicts are pure functions
over canned text. Run: python3 e2e/m4/test_w_logic.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from e2e_m4_exit import (  # noqa: E402  (import the driver under test)
    SEED_PIPELINE_YAML,
    _SNAP_SHAPE,
    _SNAP_SPILL,
    w_approval_verdicts,
    w4_notice_verdict,
    w4_pin_label,
    w4_pinned_verdicts,
    w4_short,
    w8_dom_text,
    w8_error_expectations,
    w8_milestone_verdicts,
    w8_redaction_verdict,
    w8_render_verdicts,
    w9_console_verdict,
    w9_leak_verdicts,
    w9_not_found,
    w9_outsider_verdict,
    w9_sse_verdict,
    w9_state_verdicts,
    w10_continuity_verdicts,
    w10_event_requests,
    w10_foreign_verdict,
    w10_new_type_verdicts,
    w10_resume_verdicts,
    w11_attempt_verdicts,
    w11_child_view,
    w11_extra_frames_verdict,
    w11_internals_verdict,
    w11_pick_attempted_node,
    w11_rendered_children,
    w11_short_id,
    w11_tree_verdicts,
    c11_report_evidence,
    c11_report_honesty_verdicts,
    C11_REPORT_FILES,
    w2_chain_verdicts,
    w2_iteration_verdicts,
    w2_live_verdicts,
    w2_no_gap_verdict,
    w2_timeline_total,
    w2_turn_arm_verdict,
    w2_visible_types,
    w_frame_surfaces,
    w_gate_release_verdict,
    w_type_matches,
    w3_decide_verdict,
    w3_gate_detail_verdict,
    w_counter_verdicts,
    w_form_field_verdicts,
    w_input_expectations,
    W5_COUNTDOWN_COPY,
    W5_FORBIDDEN_WORDS,
    W5_INTERRUPTED_COPY,
    W6_ERROR_CLASS,
    W6_LOSS_COPY,
    W6_REFUSAL_FORBIDDEN,
    w5_attempt2_verdict,
    w5_console_verdict,
    w5_countdown_verdict,
    w5_interrupted_verdict,
    w5_kill_landed_verdicts,
    w5_spinner_verdict,
    w6_chip_verdict,
    w6_auto_retry_class_verdicts,
    w6_loss_attempt_row,
    w6_loss_classification_verdicts,
    w6_loss_copy_verdict,
    w6_loss_facts,
    w6_retry_control_verdict,
    w6_retry_offer_kind,
    w6_retry_scheduled_total,
    w6_who_armed_the_retry,
    C6_LOSS_WORKER,
    C_LIVE_TARGET_KEY,
    w_forbidden_word_hits,
    w_forbidden_word_verdicts,
    w_norm,
    w_pick_container,
    w_quotes,
    w_retry_controls,
    w_spinner_nodes,
    pw_snapshot_nodes,
)

CANNED_SNAPSHOT = """
### Page
- Page URL: http://localhost:18091/projects/01a1/runs
- Page Title: Communication
### Snapshot
```yaml
- generic:
  - heading "New run" [level=2] [ref=e1]
  - textbox "username" [ref=e12]
  - textbox "goal *" [ref=e13]:
    - /placeholder: ""
  - combobox "repository *" [ref=e14]
    - option "app" [ref=e15]
    - option "docs" [ref=e16]
  - textbox "acceptance_criteria" [ref=e17]
  - button "Submit" [ref=e20] [cursor=pointer]
  - button "Approve" [ref=e21]
  - term "approver roles" [ref=e30]
  - definition [ref=e31]: maintainers
  - term "deadline" [ref=e32]
  - definition [ref=e33]: 2026-10-17 05:35:59 UTC · 23h left
  - listitem [ref=e34]: artifact plan.md
  - paragraph: you are not a designated approver for this gate
```
"""


def _assert(label, ok, detail=""):
    print(f"  {'ok  ' if ok else 'FAIL'} {label}{(' — ' + str(detail)[:160]) if detail else ''}")
    if not ok:
        globals()["BAD"] = globals().get("BAD", 0) + 1


def test_snapshot_nodes():
    nodes = pw_snapshot_nodes(CANNED_SNAPSHOT)
    by_name = {n["name"]: n for n in nodes if n["name"]}
    _assert("nodes parsed", len(nodes) >= 9, len(nodes))
    _assert("textbox username -> e12", by_name.get("username", {}).get("ref") == "e12",
            by_name.get("username"))
    _assert("role kept", by_name.get("Submit", {}).get("role") == "button", by_name.get("Submit"))
    _assert("combobox repository", by_name.get("repository *", {}).get("role") == "combobox")
    _assert("option child", by_name.get("app", {}).get("ref") == "e15")
    _assert("unnamed line has no ref crash",
            any(n["role"] == "paragraph" and n["ref"] is None for n in nodes))
    _assert("empty text parses", pw_snapshot_nodes("") == [])


def test_input_expectations():
    doc = {"spec": {"inputs": {
        "required": ["goal", "repository"],
        "properties": {
            "goal": {"type": "string", "minLength": 1},
            "repository": {"type": "string"},
            "acceptance_criteria": {"type": "string", "default": "hello.py works"},
            "fanout": {"type": "boolean"},
            "fanout_count": {"type": "integer"},
        },
    }}}
    exp = w_input_expectations(doc)
    names = [e["name"] for e in exp]
    _assert("every declared input is expected", names == sorted(names, key=names.index)
            and set(names) == {"goal", "repository", "acceptance_criteria", "fanout",
                               "fanout_count"}, names)
    goal = next(e for e in exp if e["name"] == "goal")
    _assert("required from the schema", goal["required"] is True)
    _assert("optional is optional",
            next(e for e in exp if e["name"] == "fanout")["required"] is False)
    _assert("default carried", next(e for e in exp if e["name"] == "acceptance_criteria")
            ["default"] == "hello.py works")
    _assert("no spec -> no expectations", w_input_expectations({}) == [])
    _assert("testid derived from the name", goal["testid"] == "new-run-input-goal")

    nodes = pw_snapshot_nodes(CANNED_SNAPSHOT)
    v = w_form_field_verdicts(exp, nodes)
    got = {label: ok for label, ok, _ in v}
    _assert("goal rendered", got.get("field goal"), v)
    _assert("missing fanout flagged as a FAIL verdict", got.get("field fanout") is False, v)
    _assert("required marker on the label", any("required" in d.lower() or "*" in d
            for _, ok, d in v if ok and "goal" in _), v)


def test_counter_verdicts():
    class Fake:
        pass
    status = {"attempts_by_status": {"queued": 1, "leased": 0, "running": 2},
              "lease_expirations": 0, "max_retry_loop_depth": 1,
              "oldest_queued_age_seconds": None, "waiting_approvals": 1,
              "queued_unbindable_runs": 0,
              "workers": [{"name": "worker-a", "active_attempts": 1, "capacity": 2},
                          {"name": "worker-b", "active_attempts": 0, "capacity": 2}]}
    text = "\n".join([
        '  - term "attempts queued" [ref=e1]',
        '  - term "attempts leased" [ref=e2]',
        '  - term "attempts running" [ref=e3]',
        '  - term "lease expirations" [ref=e4]',
        '  - term "max retry loop depth" [ref=e5]',
        '  - term "oldest queued age" [ref=e6]',
        '  - term "waiting approvals" [ref=e7]',
        '  - term "queued unbindable runs" [ref=e8]',
        '  - row "worker-a 1 / 2" [ref=e9]',
        '  - row "worker-b 0 / 2" [ref=e10]',
    ])
    v = w_counter_verdicts(status, pw_snapshot_nodes(text))
    _assert("all § 6.2 counters render", all(ok for _, ok, _ in v), v)
    missing = w_counter_verdicts(status, pw_snapshot_nodes('  - term "attempts queued" [ref=e1]'))
    _assert("missing counters FAIL loudly", sum(1 for _, ok, _ in missing if not ok) >= 7,
            missing)
    _assert("empty status -> empty verdicts (the caller GAPs)",
            w_counter_verdicts({}, pw_snapshot_nodes(text)) == [])


def test_approval_verdicts():
    nodes = pw_snapshot_nodes(CANNED_SNAPSHOT)
    v = w_approval_verdicts(approver=True, decided=False, nodes=nodes,
                            roles="maintainers", deadline=True, artifacts=True)
    got = {label: ok for label, ok, _ in v}
    _assert("approver sees the Approve button", got.get("alice: Approve button present"), v)
    _assert("approver roles render", got.get("alice: approver roles shown"), v)
    _assert("deadline countdown renders", got.get("alice: deadline countdown shown"), v)
    _assert("evidence links render", got.get("alice: artifact/evidence links shown"), v)
    bob = w_approval_verdicts(approver=False, decided=False, nodes=nodes,
                              roles="maintainers", deadline=True, artifacts=True)
    gotb = {label: ok for label, ok, _ in bob}
    _assert("bob sees the not-a-designated-approver line",
            gotb.get("bob: not-a-designated-approver line"), bob)
    _assert("bob sees NO approve button",
            gotb.get("bob: no Approve button") is False
            or gotb.get("bob: no Approve button") is True, bob)
    _assert("verdict labels are unique", len(set(k for k, _, _ in v)) == len(v), v)


def test_w3_gate_detail_verdict():
    # A control-plane gate has NO attempts (attempt_count=0), and 8d05235 made the
    # run inspector mount the gate card on such a node. Plain asserts, so pytest
    # fails on a regression rather than only printing one (the file's _assert
    # collects counts for the __main__ path only).
    got = w3_gate_detail_verdict(200, 0, True)
    assert got[1] is True, got
    assert "no attempts" in got[2], got
    assert w3_gate_detail_verdict(404, None, True)[1] is False
    assert w3_gate_detail_verdict(None)[1] is None, "no node_execution_id is a GAP"
    assert w3_gate_detail_verdict(200, 0, None)[1] is None, "no browser leg is a GAP"
    assert w3_gate_detail_verdict(200, 0, False)[1] is False, "an unmounted card FAILS"
    assert w3_gate_detail_verdict(200, 2, True)[1] is True, "an attempt-bearing node is fine"


def test_w3_decide_verdict():
    # state is the lifecycle column ('pending','decided','expired','cancelled',
    # 'denied'); the approve/reject fact is `decision` (00005's CHECK). The old arm
    # asked `state` for 'approved', a value the column can never hold.
    ok = w3_decide_verdict("decided|approved|u-alice", "u-alice")
    assert ok[1] is True, ok
    assert w3_decide_verdict("pending||", "u-alice")[1] is False
    assert w3_decide_verdict("decided|rejected|u-alice", "u-alice")[1] is False
    assert w3_decide_verdict("decided|approved|u-bob", "u-alice")[1] is False
    assert w3_decide_verdict("")[1] is None, "an unreadable row is a GAP"
    assert w3_decide_verdict("decided")[1] is None, "a half row is a GAP"
    assert "state='decided'" in ok[2], ok


def _vmap(verdicts):
    return {label: (ok, detail) for label, ok, detail in verdicts}


def one(verdicts, needle, detail=False):
    for label, ok, det in verdicts:
        if needle in label:
            return det if detail else ok
    raise AssertionError(f"no verdict naming {needle!r} in {[v[0] for v in verdicts]}")


def test_w4_pinned_and_notice():
    pinned, newer = "sha256:" + "a" * 64, "sha256:" + "b" * 64
    assert w4_short(pinned) == "a" * 12 and w4_short("deadbeef" * 8) == "deadbeefdead"
    # Today's run page is the graph-first workbench: its header meta line reads
    # `<slug> #<id> · <repo> · revision r<N> <digest> (pinned) · started <age> …` and the
    # pin link's accessible name is `r<N> <12 hex>` — the FULL short digest, the same
    # spelling the runs list and the newer-revision notice use. (The pre-workbench
    # inspector spelled it `pinned r<N> · <digest>`; that spelling still lives on the
    # Diagnostics tab, which is why the canned page below carries both.)
    pin = w4_pin_label(1, pinned)
    assert pin == f"r1 {'a' * 12}", pin
    header = lambda label, marked=True: (f"feature-development #9661b1b8 · app · revision {label}"
                                         f"{' (pinned) · started 2m by alice' if marked else ''}")
    page = (f'{header(pin)} · pinned r1 · {w4_short(pinned)} · 12 frames')
    v = _vmap(w4_pinned_verdicts(pinned, 1, newer, 2, page, page))
    assert all(ok is True for ok, _ in v.values()), v
    moved = page.replace(pin, w4_pin_label(2, newer)).replace(w4_short(pinned), w4_short(newer))
    v = _vmap(w4_pinned_verdicts(pinned, 1, newer, 2, page, moved))
    assert any(ok is False for ok, _ in v.values()), v
    assert one(w4_pinned_verdicts(pinned, 1, newer, 2, page, page), 'shows the pinned digest') is True
    # no loosening: the pin must name N WITH the pinned digest, and the page must say
    # the word "pinned". A 6-char prefix (what the header printed before the W4 fix) is
    # not the pinned digest; a revision link with no "(pinned)" marks nothing; a page
    # that prints the newest number is not naming this run's pin.
    short_only = header(f"r1 {'a' * 6}")
    assert one(w4_pinned_verdicts(pinned, 1, newer, 2, short_only, short_only),
               'shows the pinned digest') is False, "a 6-char prefix is not the digest"
    unmarked = header(pin, marked=False)
    assert one(w4_pinned_verdicts(pinned, 1, newer, 2, unmarked, unmarked),
               'names the run pin') is False, "a bare revision link does not name a pin"
    renumbered = header(f"r2 {'a' * 12}")
    assert one(w4_pinned_verdicts(pinned, 1, newer, 2, renumbered, renumbered),
               'names the run pin') is False, "the page must name N, not the library newest"
    assert one(w4_pinned_verdicts(pinned, None, newer, 2, page, page), 'names the run pin') is None
    # the notice: PASS only when both halves of the row's copy are on the page
    assert w4_notice_verdict("revision 2 published since this run started — this run is "
                             "pinned to 1", 1, 2)[1] is True
    assert w4_notice_verdict("revision 2 published since this run started", 1, 2)[1] is False
    assert w4_notice_verdict(page, 1, 2)[1] is False, "no banner is a FAIL naming the UI"
    assert "RunInspector" in w4_notice_verdict(page, 1, 2)[2], w4_notice_verdict(page, 1, 2)[2]
    assert "NewRevisionNotice" in w4_notice_verdict(page, 1, 2)[2], \
        "the FAIL must name the banner today's page actually draws"
    assert w4_notice_verdict("", 1, 2)[1] is None, "an empty page is a GAP, not a verdict"


def test_w8_panel_verdicts():
    vresp = {"valid": False, "errors": [
        {"code": "kind_not_implemented", "source": "compiler", "instance_location":
         "/spec/nodes/0", "message": "kind parallel is not implemented until M5",
         "hint": "use until/for_each"},
        {"code": "schema_shape", "source": "schema", "instance_location":
         "/spec/nodes/6/config/typo", "message": "unknown field", "hint": "remove it"},
        {"code": "secret_literal_detected", "source": "compiler", "instance_location":
         "/spec/nodes/0/config/env/DATABASE_URL", "message": "secret literal",
         "hint": None}]}
    want = w8_error_expectations(vresp)
    assert len(want) == 3 and want[0][0] == "kind_not_implemented", want
    assert w8_error_expectations(None) == [] and w8_error_expectations({"errors": "x"}) == []
    panel = ("kind_not_implemented compiler lands in M5 kind parallel is not implemented "
             "until M5 instance /spec/nodes/0 hint use until/for_each "
             "schema_shape schema instance /spec/nodes/6/config/typo unknown field")
    v = _vmap(w8_render_verdicts(want, panel))
    assert v["W8 error kind_not_implemented at /spec/nodes/0 renders"][0] is True, v
    assert v["W8 error schema_shape at /spec/nodes/6/config/typo renders"][0] is False, v
    assert "hint" in v["W8 error schema_shape at /spec/nodes/6/config/typo renders"][1], v
    secret = "W8 error secret_literal_detected at /spec/nodes/0/config/env/DATABASE_URL renders"
    assert v[secret][0] is False and "not rendered" in v[secret][1], v[secret]
    # the milestone arm only has an answer when the kind error is there
    assert one(w8_milestone_verdicts(want, panel), "names its milestone") is True
    assert one(w8_milestone_verdicts(want, panel.replace("lands in M5", "")
                                    .replace("until M5", "")),
               "names its milestone") is False
    assert one(w8_milestone_verdicts([("schema_shape", "schema", "/x", "")], panel),
               "names the milestone") is None, "no kind error is a GAP"
    # the secret arm: the FINDING row carries no value; the operator's own pasted
    # text (echoed by the panel's YamlView) legitimately still does
    row = [{"role": "button", "text":
            "compiler secret_literal_detected URL with inline credentials instance "
            "/spec/nodes/0/config/env/DATABASE_URL value never shown", "ref": "e7"}]
    red = w8_redaction_verdict(want, row, panel + " value never shown", "postgres://u:p@h/d")
    assert one(red, "renders redacted") is True, red
    scoped = w8_redaction_verdict(want, row,
                                  panel + " DATABASE_URL: \"postgres://u:p@h/d\" value never "
                                          "shown", "postgres://u:p@h/d")
    assert one(scoped, "renders redacted") is True, "the pasted document is not the finding"
    assert one(w8_redaction_verdict(want, [{"role": "button", "text":
                                           "secret_literal_detected postgres://u:p@h/d",
                                           "ref": "e8"}], panel, "postgres://u:p@h/d"),
               "renders redacted") is False, "a row that echoes the value FAILS"
    assert one(w8_redaction_verdict(want, [], panel, "postgres://u:p@h/d"),
               "renders redacted") is False, "a dropped row FAILS"
    assert one(w8_redaction_verdict(want, row, panel, "postgres://u:p@h/d"),
               "renders redacted") is False, "no redaction copy is not a redacted row"
    assert one(w8_redaction_verdict([("schema_shape", "schema", "/x", "")], row, panel, "s"),
               "renders redacted") is None
    assert w8_dom_text([{"name": "a", "text": "b"}], "raw") == "raw\na b"


def test_w9_outsider_verdicts():
    # row W9: "404/not-found states, no project name, no node names, no digest values,
    # SSE never opens, console clean"
    obs = [{"surface": "run id", "path": "/projects/p/runs/r", "status": 404, "found": True},
           {"surface": "nodes route", "path": "/projects/p/runs/r/nodes", "status": 404,
            "found": False},
           {"surface": "approval", "path": "(no approval)", "status": None, "found": None},
           {"surface": "run SSE URL", "path": "/api/v1/runs/r/events", "status": 200,
            "found": True}]
    v = _vmap(w9_state_verdicts(obs))
    assert v["W9 run id renders a 404/not-found state"][0] is True, v
    assert v["W9 nodes route renders a 404/not-found state"][0] is False, v
    assert v["W9 approval renders a 404/not-found state"][0] is None, v
    assert v["W9 run SSE URL renders a 404/not-found state"][0] is False, \
        "a 200 SSE response can never be a not-found state"
    leaks = [("project name", ["M4 Exit", "m4-exit"]), ("node name", ["/plan"]),
             ("digest value", []), ("worker id", [""])]
    v = _vmap(w9_leak_verdicts("not found. that page does not exist.", leaks))
    assert v["W9 no project name in the DOM of an outsider's session"][0] is True, v
    assert v["W9 no digest value in the DOM of an outsider's session"][0] is None, \
        "nothing to search for is a GAP, never a PASS"
    dirty = w9_leak_verdicts("M4 Exit · /plan · sha256:" + "a" * 64, leaks)
    assert one(dirty, "no project name") is False and one(dirty, "no node name") is False
    assert "leaked" in one(dirty, "no project name", detail=True), dirty
    # SSE: the request must be in the log, and must not have opened a stream
    assert w9_sse_verdict("12. [GET] http://lb/api/v1/runs/r1/events => 404", "r1", "")[1] is True
    assert w9_sse_verdict("12. [GET] http://lb/api/v1/runs/r1/events => 200", "r1", "")[1] is False
    assert w9_sse_verdict("1. [GET] http://lb/api/v1/projects => 200", "r1", "")[1] is None, \
        "no events request in the log is unmeasured"
    assert w9_sse_verdict("12. [GET] http://lb/api/v1/runs/r1/events => 404", "r1",
                          'data: {"type": "run.created"}')[1] is False, "frames opened the stream"
    # console: the browser's own 404 report for a deliberately dead deep link is named
    clean = """Total messages: 0 (Errors: 0, Warnings: 0)"""
    assert w9_console_verdict(clean)[1] is True, w9_console_verdict(clean)
    noisy = ("Total messages: 2 (Errors: 2, Warnings: 0)\n"
             "[ERROR] Failed to load resource: the server responded with a status of 404\n"
             "[ERROR] Uncaught TypeError: cannot read x")
    got = w9_console_verdict(noisy, benign=("Failed to load resource",))
    assert got[1] is False and "Uncaught TypeError" in got[2], got
    onlynoise = ("Total messages: 1 (Errors: 1, Warnings: 0)\n"
                 "[ERROR] Failed to load resource: the server responded with a status of "
                 "404 (Not Found) @ http://localhost:18091/api/v1/runs/01a1/events:0\n"
                 "[ERROR] Failed to load resource: the server responded with a status of "
                 "404 (Not Found) @ http://localhost:18091/favicon.ico:0:")
    assert one([w9_console_verdict(onlynoise, benign=("Failed to load resource",))],
               "console clean") is True, w9_console_verdict(onlynoise)
    assert w9_console_verdict("", rc=1)[1] is None, "an unreadable console read is a GAP"
    assert w9_console_verdict("playwright-cli: no such command")[1] is None
    assert w9_not_found("Run 01a1 is not visible to you, or does not exist.") is True
    assert w9_not_found("Not found — that page does not exist.") is True
    assert w9_not_found("No such run.") is True
    assert w9_not_found("Runs · plan · implement · review") is False
    assert w9_not_found("   ") is None


def test_w9_outsider_observer_arm():
    """§ 7.2 W9 names its observer "carol (project B only)" while § 7.1 C9d makes
    carol an M4 maintainer; seed.sh step 2b provisions the ROLE as a second identity
    (erin, member of manifest.project_b only). The observer arm is a GAP in both
    worlds — it never reports a PASS for a carol who is not project-B-only."""
    label, ok, why = w9_outsider_verdict("maintainer", False, outsider="erin",
                                        outsider_m4_role="",
                                        outsider_project_b_role="maintainer")
    assert ok is None, "the row's literal name (carol) is still not the observer"
    assert "project B only" in label and "C9d" in why, (label, why)
    assert "'erin'" in why and "no row" in why, why
    assert "org admin=False" in why, why
    # no seeded project-B-only membership: the arms fall back to a bare IdP login
    label, ok, why = w9_outsider_verdict("maintainer", False, outsider="erin",
                                        outsider_m4_role=None,
                                        outsider_project_b_role=None)
    assert ok is None and "the seed gap" in why, (label, why)
    # an outsider who DOES hold an M4 row can never stand in for the row's outsider
    label, ok, why = w9_outsider_verdict("maintainer", False, outsider="erin",
                                        outsider_m4_role="contributor",
                                        outsider_project_b_role="maintainer")
    assert ok is None and "the seed gap" in why, (label, why)


def test_snapshot_spill_guard():
    """pw_snapshot's spill path: the file is only trusted on the CLI's own notice.
    W8 pastes YAML whose header names its own source file, the snapshot echoes that
    text, and a bare `.yaml` match once returned the seed pipeline document as the
    page — a page with no textarea in it, and a leg that failed for the wrong reason."""
    pasted = ("### Page\n- Page URL: http://lb/projects/p/pipelines\n### Snapshot\n"
              "```yaml\n- textbox \"Pipeline YAML to validate\" [ref=f2e54]: "
              "'# docs/compatibility/probes/m4/pipeline.yaml — the § 7 exit seed set'\n```")
    assert _SNAP_SPILL.search(pasted) is None, \
        "a .yaml path inside pasted content is not the CLI's spill notice"
    assert _SNAP_SPILL.search("Full snapshot saved to .playwright-cli/page-1.yml") is not None
    spill = _SNAP_SPILL.search("Snapshot written to .playwright-cli/page-1.yml")
    assert spill and spill.group(1) == ".playwright-cli/page-1.yml", spill
    assert _SNAP_SHAPE.search("- generic [ref=f2e3]:\n  - banner [ref=f2e4]")
    with open(SEED_PIPELINE_YAML, encoding="utf-8") as f:
        seed_doc = f.read()
    assert _SNAP_SHAPE.search(seed_doc) is None, \
        "the seed pipeline document must never pass for a page tree"


def test_http_connection_blip_retry():
    """live4/W4: the leg's very first call hit an API replica mid-restart (URLError
    [Errno 111] Connection refused) and the traceback took every later check with
    it. The transport may re-send a request that never reached a server — and must
    never re-send one that came back with a status."""
    import email.message
    import io
    import socket
    import urllib.error
    import urllib.request

    import e2e_m4_exit as m
    from e2e_m4_exit import Client, http_is_connection_blip

    refused = urllib.error.URLError(ConnectionRefusedError(111, "Connection refused"))
    reset = urllib.error.URLError(ConnectionResetError(104, "Connection reset by peer"))
    _assert("connection refused is a blip", http_is_connection_blip(refused))
    _assert("connection reset is a blip", http_is_connection_blip(reset))
    _assert("the textual form is a blip too", bool(
        http_is_connection_blip(urllib.error.URLError("[Errno 111] Connection refused"))))
    http503 = urllib.error.HTTPError("http://x/y", 503, "Service Unavailable",
                                     email.message.Message(), io.BytesIO(b"down"))
    _assert("a 503 is an answer, never a blip", not http_is_connection_blip(http503))
    _assert("DNS is not a blip", not http_is_connection_blip(
        urllib.error.URLError(socket.gaierror(-2, "Name or service not known"))))
    _assert("a timeout is not a blip", not http_is_connection_blip(
        urllib.error.URLError(TimeoutError("timed out"))))

    class Resp:
        def __init__(self, status, headers, payload):
            self.status, self.headers, self._p = status, headers, payload

        def read(self):
            return self._p

    class Opener:
        """Raises each queued error in turn, then answers 200 once."""
        def __init__(self, errors):
            self.errors, self.n = list(errors), 0

        def open(self, req, timeout=None):
            self.n += 1
            if self.errors:
                raise self.errors.pop(0)
            h = email.message.Message()
            h["Set-Cookie"] = "communication_session=abc; Path=/"
            return Resp(200, h, b'{"id":"u1"}')

    keep = m.HTTP_CONNECT_RETRY_WAIT_S
    m.HTTP_CONNECT_RETRY_WAIT_S = 0
    try:
        c = Client("w4")
        c.opener = Opener([refused, reset])
        r = c.call("http://localhost:18091/api/v1/me")
        _assert("two blips then an answer = 3 attempts", c.opener.n == 3, c.opener.n)
        _assert("the retried call answers 200", r.status == 200, r.status)
        _assert("the retried call keeps its session cookie", c.cookies.get("communication_session")
                == "abc", c.cookies)
        c2 = Client("w4")
        c2.opener = Opener([refused, refused, refused])
        raised = None
        try:
            c2.call("http://localhost:18091/api/v1/me")
        except urllib.error.URLError as e:
            raised = e
        _assert("a refusal outlasting the budget still raises", raised is not None)
        _assert("the budget is exactly 3 tries", c2.opener.n == m.HTTP_CONNECT_RETRIES,
                c2.opener.n)
        c3 = Client("w4")
        c3.opener = Opener([http503])
        r3 = c3.call("http://localhost:18091/api/v1/runs/zzz")
        _assert("a 503 is returned after exactly one attempt",
                r3.status == 503 and c3.opener.n == 1, f"{r3.status}/{c3.opener.n}")
        c4 = Client("w4")
        c4.opener = Opener([urllib.error.URLError(TimeoutError("timed out"))])
        try:
            c4.call("http://localhost:18091/api/v1/me")
            slow = "no raise"
        except urllib.error.URLError:
            slow = "raised"
        _assert("a timeout raises immediately, it is not retried",
                slow == "raised" and c4.opener.n == 1, f"{slow}/{c4.opener.n}")
    finally:
        m.HTTP_CONNECT_RETRY_WAIT_S = keep


# --- W2 (row § 7.2 W2) -------------------------------------------------------

# A run page opened on `?tab=timeline`: the stage strip's ONE cell for the loop, the
# panel's own `{visible} of {rows} events` tally, and the journal rows the tab draws.
CANNED_TIMELINE = """
### Page
- Page URL: http://localhost:18091/projects/01a1/runs/r1?tab=timeline
- Page Title: Communication
### Snapshot
```yaml
- generic:
  - tab "Timeline" [selected] [ref=e40]
  - button "build_until_verified, 2 done, 1 running" [ref=e50]
  - paragraph: one cell per definition node; segments inside a cell are its iterations
  - paragraph: 9 of 9 events
  - list:
    - listitem:
      - button "13:01:11 run.created system" [ref=e60]
    - listitem:
      - button "13:01:12 run.started system" [ref=e61]
    - listitem:
      - button "13:01:13 approval.requested system" [ref=e62]
    - listitem:
      - button "13:01:13 run.waiting_human system" [ref=e63]
    - listitem:
      - button "13:01:20 approval.decided alice" [ref=e64]
    - listitem:
      - button "13:01:21 node.attempt.started /plan att 1 worker" [ref=e65]
    - listitem:
      - button "13:01:30 run.checkpoint_saved /build_until_verified[1]/implement att 1 worker" [ref=e66]
    - listitem:
      - button "13:01:31 node.attempt.started /build_until_verified[2]/implement att 2 worker" [ref=e67]
    - listitem:
      - button "13:01:40 node.scope.iteration /build_until_verified[2] system" [ref=e68]
```
"""

JOURNAL_W2 = [(1, "run.created"), (2, "run.started"), (3, "approval.requested"),
              (4, "run.waiting_human"), (5, "approval.decided"),
              (6, "node.attempt.started"), (7, "run.checkpoint_saved"),
              (8, "node.scope.iteration"), (9, "node.attempt.started")]


def test_w2_live_and_order_verdicts():
    """Row W2: "`run.created` → `node.attempt.started` → `conversation.turn.*` (the
    transcript of the agent node, inline, from M2's stream) → `run.checkpoint_saved`
    render live, in order, with no gap". "Live" is measured across DOM samples of ONE
    document (its own timeOrigin is the no-reload witness) whose type set GREW; one
    sample, a flat set or a replaced document are respectively GAP, FAIL, FAIL."""
    vis = w2_visible_types(CANNED_TIMELINE, [t for _s, t in JOURNAL_W2])
    assert w2_timeline_total(CANNED_TIMELINE) == (9, 9), w2_timeline_total(CANNED_TIMELINE)
    assert w2_timeline_total("- text: nothing here") is None, "no tally line = unreadable"
    assert set(vis) <= {t for _s, t in JOURNAL_W2}, vis
    assert vis["node.attempt.started"]["count"] == 2, vis["node.attempt.started"]
    one_row = {"tag": "a", "types": vis, "total": (9, 9), "marker": "1760000000000"}
    grew_row = {"tag": "b", "total": (10, 10), "marker": "1760000000000",
                "types": dict(vis, **{"run.completed": {"first": 4000, "count": 1}})}
    assert one(w2_live_verdicts([one_row]), "renders the journal live") is None
    assert one(w2_live_verdicts([one_row, grew_row]), "renders the journal live") is True
    assert one(w2_live_verdicts([one_row, dict(one_row, tag="b")]),
               "renders the journal live") is False, "nothing ever arrived"
    assert one(w2_live_verdicts([one_row, dict(grew_row, marker="1760000099999")]),
               "renders the journal live") is False, "the document was replaced = a reload"
    assert one(w2_live_verdicts([one_row, dict(grew_row, marker="")]),
               "renders the journal live") is None, "an unreadable witness proves nothing"
    chain = w2_chain_verdicts(vis, JOURNAL_W2)
    assert one(chain, "renders run.created") is True, chain
    assert one(chain, "renders node.attempt.started") is True
    assert one(chain, "renders run.checkpoint_saved") is True
    assert one(chain, "renders conversation.turn.*") is None, "no turn rows on a twin run"
    assert one(chain, "renders in order") is True, chain
    back = [(1, "run.checkpoint_saved"), (2, "node.attempt.started"), (3, "run.created")]
    assert one(w2_chain_verdicts(vis, back), "renders in order") is False, "the page drew them backwards"
    lone = w2_chain_verdicts(w2_visible_types(CANNED_TIMELINE, ["run.created"]),
                             [(1, "run.created")])
    assert one(lone, "renders in order") is None, "one type is not an order"
    assert one(lone, "renders node.attempt.started") is None, "never journalled -> GAP"


def test_w2_turn_gap_and_no_gap():
    """The transcript arm may never be credited to a deterministic run, and "no gap"
    is only measured over the vocabulary the panel has words for (M4_RUN_EVENT_TYPES:
    `toRunEvent` drops the rest, ADR-0014 § 8)."""
    why = w2_turn_arm_verdict(JOURNAL_W2)
    assert why[1] is None, why
    assert "process.exec" in why[2] and "toRunEvent" in why[2], why[2]
    with_turns = w2_turn_arm_verdict(JOURNAL_W2 + [(10, "conversation.turn.started")])
    assert with_turns[1] is None and "outside" in with_turns[2], with_turns
    vis = w2_visible_types(CANNED_TIMELINE, [t for _s, t in JOURNAL_W2])
    ng = w2_no_gap_verdict(vis, JOURNAL_W2, CANNED_TIMELINE)
    assert ng[1] is True, ng
    assert "9 of 9 events" in ng[2], ng[2]
    assert w2_no_gap_verdict(vis, JOURNAL_W2 + [(10, "node.attempt.retry_scheduled")],
                             CANNED_TIMELINE)[1] is False, "a journalled row never drawn"
    assert w2_no_gap_verdict(vis, [(1, "pipeline.revision.published")],
                             CANNED_TIMELINE)[1] is None, "no vocabulary rows = no baseline"
    extra = w11_extra_frames_verdict(vis, JOURNAL_W2, tag="W2")
    assert extra[1] is True, extra
    crowded = dict(vis, **{"node.attempt.started": {"first": 1, "count": 5}})
    assert w11_extra_frames_verdict(crowded, JOURNAL_W2, tag="W2")[1] is False, \
        "more rows drawn than journalled is the foreign-frame signature"


def test_w2_iteration_verdicts():
    """The row's second half: `/build_until_verified[1]` and `[2]` as ITERATIONS, not
    as duplicated definition nodes — both places named, ONE stage-strip cell."""
    nodes = pw_snapshot_nodes(CANNED_TIMELINE)
    keys = {"/build_until_verified", "/build_until_verified[1]/implement",
            "/build_until_verified[2]/implement"}
    v = w2_iteration_verdicts(nodes, CANNED_TIMELINE, keys)
    assert one(v, "really ran /build_until_verified[1]") is True, v
    assert one(v, "really ran /build_until_verified[2]") is True
    assert one(v, "shows /build_until_verified[1]") is True
    assert one(v, "shows /build_until_verified[2]") is True
    assert one(v, "ONE cell for build_until_verified") is True, v
    two = CANNED_TIMELINE + '\n  - button "build_until_verified, 1 running" [ref=e51]\n'
    assert one(w2_iteration_verdicts(pw_snapshot_nodes(two), two, keys),
               "ONE cell for build_until_verified") is False, "two cells is the duplication"
    nokeys = w2_iteration_verdicts(nodes, CANNED_TIMELINE, None)
    assert one(nokeys, "really ran /build_until_verified[1]") is None, "unreadable ledger"
    assert one(nokeys, "shows /build_until_verified[2]") is True, \
        "the page still shows the place — only the ledger half GAPs"
    bare = w2_iteration_verdicts([], "- text: nothing", keys)
    assert one(bare, "ONE cell for build_until_verified") is None, "no strip = unmeasured"
    oneshot = w2_iteration_verdicts(nodes, CANNED_TIMELINE, {"/build_until_verified[1]/test"})
    assert one(oneshot, "really ran /build_until_verified[2]") is False, "the run never iterated twice"
    assert one(oneshot, "shows /build_until_verified[2]") is None


# --- W10 (row § 7.2 W10) -----------------------------------------------------

CANNED_REQUESTS = """
Total 6 requests
  1. [GET] http://localhost:18091/api/v1/me => 200
  2. [GET] http://localhost:18091/api/v1/runs/r1 => 200
  3. [GET] http://localhost:18091/api/v1/runs/r1/nodes => 200
  4. [GET] http://localhost:18091/api/v1/runs/r1/events => 200
  5. [GET] http://localhost:18091/api/v1/runs/other/events => 200
  6. [GET] http://localhost:18091/api/v1/runs/r1/events => 200
"""

HDRS_CURSOR = "GET http://localhost:18091/api/v1/runs/r1/events\nlast-event-id: 4711\n"
HDRS_FRESH = "GET http://localhost:18091/api/v1/runs/r1/events\naccept: text/event-stream\n"


def test_w10_resume_cursor_is_read_from_the_browser_log():
    """Row W10: "reload the app mid-run and reconnect the stream with `Last-Event-ID`,
    then roll an API replica (C14a)". The cursor is the BROWSER's request header, so
    the only witness is the page's own request log — and a reloaded page opens a fresh
    EventSource with no cursor at all, which is why the reload is judged on the render
    and the cursor on the roll."""
    lines = w10_event_requests(CANNED_REQUESTS, "r1")
    assert [i for i, _u in lines] == [4, 6], f"another run's stream must not count: {lines}"
    assert all(u.endswith("/runs/r1/events") for _i, u in lines), lines
    assert w10_event_requests("Total 0 requests", "r1") == []
    roll = one(w10_resume_verdicts([{"tag": "roll", "url": "http://x/events",
                                     "headers": HDRS_CURSOR}], roll_done=True),
               "reconnects with Last-Event-ID")
    assert roll is True, roll
    assert one(w10_resume_verdicts([{"tag": "roll", "url": "http://x/events?after=4711",
                                     "headers": HDRS_FRESH}], roll_done=True),
               "reconnects with Last-Event-ID") is True, "?after= is a resume cursor too"
    fresh = w10_resume_verdicts([{"tag": "roll", "url": "http://x/events",
                                  "headers": HDRS_FRESH}], roll_done=True)
    assert one(fresh, "reconnects with Last-Event-ID") is False, \
        "a reconnect that restarts at the head of the journal is not a resume"
    assert "journal head" in one(fresh, "reconnects with Last-Event-ID", detail=True)
    blind = w10_resume_verdicts([{"tag": "roll", "url": "http://x/events", "headers": None}],
                                roll_done=True)
    assert one(blind, "reconnects with Last-Event-ID") is None, "unreadable headers prove nothing"
    no_roll = w10_resume_verdicts([], roll_done=False)
    assert one(no_roll, "reconnects with Last-Event-ID") is None
    assert "never exercised" in one(no_roll, "reconnects with Last-Event-ID", detail=True)
    # A roll with NO new stream request: the leg now reads X-Communication-Replica
    # off the stream response BEFORE rolling and rolls THAT replica, so the drop is
    # forced and a client that never re-opened is the product FAIL again — for
    # either replica's name (the LB coin flip is gone). Only when the serving
    # replica never read back (the leg rolled api-a as a guess) is the drop itself
    # unproven and the verdict a GAP. The bystander shape stays guarded; the
    # pre-roll open is never fed to the verdict as if it were a reconnect.
    dead = w10_resume_verdicts([], roll_done=True, rolled=("api-a",),
                               stream_replica="api-a")
    assert one(dead, "reconnects with Last-Event-ID") is False, \
        "the rolled replica held the socket and the client never re-opened it"
    assert "never" in one(dead, "reconnects with Last-Event-ID", detail=True)
    dead_b = w10_resume_verdicts([], roll_done=True, rolled=("api-b",),
                                 stream_replica="api-b")
    assert one(dead_b, "reconnects with Last-Event-ID") is False, \
        "a socket on api-b is forced the same way now the leg rolls the holder"
    blind_roll = w10_resume_verdicts([], roll_done=True, rolled=("api-a",))
    assert one(blind_roll, "reconnects with Last-Event-ID") is None, \
        "no new request AND no serving replica read back is unmeasured, not a FAIL"
    assert "unmeasured" in one(blind_roll, "reconnects with Last-Event-ID", detail=True)
    bystander = w10_resume_verdicts([], roll_done=True, rolled=("api-a",),
                                    stream_replica="api-b")
    assert one(bystander, "reconnects with Last-Event-ID") is None, \
        "a roll of a bystander replica never dropped this stream — no cursor owed"
    assert "api-b" in one(bystander, "reconnects with Last-Event-ID", detail=True)
    assert one(w10_resume_verdicts([{"tag": "reload", "url": "http://x/events",
                                     "headers": HDRS_FRESH}]),
               "reloads mid-run") is True, "the client re-opened the feed"
    assert one(w10_resume_verdicts([], roll_done=True), "reloads mid-run") is None


def test_w10_continuity_across_the_roll():
    """The rendered timeline may never shorten, and after the roll the frames have to
    keep arriving on the SAME document — a page that got navigated in between says
    nothing about the stream."""
    s = [{"tag": "before reload", "total": (6, 6), "marker": "1760000000000"},
         {"tag": "after reload", "total": (6, 6), "marker": "1760000000000"},
         {"tag": "after the roll", "total": (7, 7), "marker": "1760000000000"},
         {"tag": "delivered", "total": (12, 12), "marker": "1760000000000"}]
    v = w10_continuity_verdicts(s, False)
    assert one(v, "never shortens") is True, v
    assert one(v, "keep arriving on the same document") is True, v
    shrunk = [dict(r) for r in s]
    shrunk[1]["total"] = (2, 2)
    assert one(w10_continuity_verdicts(shrunk, False), "never shortens") is False, \
        "a frame the page had drawn is gone"
    navigated = [dict(r) for r in s]
    navigated[3]["marker"] = "1760000099999"
    assert one(w10_continuity_verdicts(navigated, False),
               "keep arriving on the same document") is False, "that is a reload, not a stream"
    stalled = [dict(r) for r in s]
    stalled[3]["total"] = (7, 7)
    assert one(w10_continuity_verdicts(stalled, False),
               "keep arriving on the same document") is False
    assert one(w10_continuity_verdicts(s, True), "keep arriving on the same document") is None, \
        "a terminal run delivers nothing — that GAPs, it never PASSes"
    assert one(w10_continuity_verdicts(s[:2], False),
               "keep arriving on the same document") is None, "no post-roll sample was taken"
    assert one(w10_continuity_verdicts([dict(r, total=None) for r in s], False),
               "never shortens") is None, "an unreadable tally is not a zero"


def test_w10_new_types_and_foreign_events():
    """"continuity across the new event types with no gap and no cross-project
    event" — the new types are the ones the ADVANCER writes (it is the writer M1-M3
    never had), and a foreign event is searched for in the only words the DOM can
    show it in."""
    vis = w2_visible_types(CANNED_TIMELINE, [t for _s, t in JOURNAL_W2])
    v = w10_new_type_verdicts(vis, JOURNAL_W2)
    assert one(v, "survive the reconnect") is True, v
    no_scope_dom = "\n".join(ln for ln in CANNED_TIMELINE.splitlines()
                             if "node.scope" not in ln)
    journalled = [(s, t) for s, t in JOURNAL_W2 if t != "run.created"]
    assert one(w10_new_type_verdicts(w2_visible_types(no_scope_dom, [t for _s, t in JOURNAL_W2]),
                                     journalled),
               "survive the reconnect") is False, \
        "the journal wrote node.scope.* and the re-rendered page does not name it"
    assert one(w10_new_type_verdicts({}, JOURNAL_W2), "survive the reconnect") is None
    bare = w10_new_type_verdicts({"run.created": {"first": 0, "count": 1}},
                                 [(1, "run.created")])
    assert one(bare, "survive the reconnect") is None, "no advancer-written type at all"
    f = w10_foreign_verdict(CANNED_TIMELINE, [("other project's name or slug",
                                               ["m4-project-b", "M4 Project B"]),
                                              ("another run's attempt id", ["att 9f3a"])])
    assert one(f, "other project's name") is True, f
    assert one(f, "another run's attempt id") is True
    assert one(w10_foreign_verdict(CANNED_TIMELINE,
                                   [("other project's name", ["  "])]),
               "other project's name") is None, "nothing to search is vacuous"
    assert one(w10_foreign_verdict("", [("other project's name", ["m4-project-b"])]),
               "other project's name") is None, "no DOM = unmeasured, not clean"
    assert one(w10_foreign_verdict("… m4-project-b …", [("other project's name",
                                                        ["m4-project-b"])]),
               "other project's name") is False, "leaked"


# --- W11 (row § 7.2 W11) -----------------------------------------------------

CANNED_TREE = """
### Page
- Page URL: http://localhost:18091/projects/01a1/runs/r1?tab=execution
### Snapshot
```yaml
- tree:
  - treeitem "fan_out" [ref=e70]
  - button "expand /fan_out" [ref=e71]
  - treeitem "issue-implementation completed child run 3f5a9c1d · depth 1 · waits for completion" [ref=e80]
  - treeitem "issue-implementation running child run 7b2e1140 · depth 1 · waits for completion" [ref=e81]
  - treeitem "invoke 25 executions" [ref=e82]
  - text: 15 more
- generic:
  - paragraph: ATTEMPT 2
  - paragraph: implement · iter 1 · attempt 2
  - paragraph: what the next attempt inherits (continue_workspace)
"""

TREE_CHILDREN = [{"child_run_id": "01a144d1-0000-7000-8000-00003f5a9c1d", "status": "completed",
                  "depth": 1, "wait_policy": "completion", "node_instance_key": "/fan_out[1]/invoke"},
                 {"child_run_id": "01a144d1-0000-7000-8000-00007b2e1140", "status": "running",
                  "depth": 1, "wait_policy": "completion", "node_instance_key": "/fan_out[2]/invoke"}]


def test_w11_short_id_is_the_uuid_tail_the_tree_prints():
    """`ui/src/lib/format.ts` shortId → `api/names.ts`: the UUIDv7 TAIL. Search the
    DOM for the head and every child row "misses" while sitting on screen."""
    assert w11_short_id("01a144d1-0000-7000-8000-00003f5a9c1d") == "3f5a9c1d"
    assert w11_short_id("/build_until_verified[1]") == "/build_until_verified[1]", "not a uuid"
    assert w11_short_id("") == ""
    rows = w11_rendered_children(CANNED_TREE)
    assert sorted(rows) == ["3f5a9c1d", "7b2e1140"], rows
    assert rows["3f5a9c1d"]["depth"] == 1 and rows["3f5a9c1d"]["wait_policy"] == "completion"


def test_w11_tree_verdicts():
    """"the tree renders depth 1 children with their own statuses" — and the fan-out
    the row names (C8's 25 children) has to be REACHABLE, not stranded behind a pager
    the UI cannot expand."""
    v = w11_tree_verdicts(TREE_CHILDREN, CANNED_TREE)
    assert one(v, "depth-1 children with their own statuses") is True, v
    assert one(v, "reachable in the DOM") is True, v
    twentyfive = TREE_CHILDREN + [{"child_run_id": f"01a144d1-0000-7000-8000-0000000000{i:02d}",
                                   "status": "queued", "depth": 1, "wait_policy": "completion"}
                                  for i in range(3, 26)]
    stranded = w11_tree_verdicts(twentyfive, CANNED_TREE)
    assert one(stranded, "depth-1 children with their own statuses") is True, \
        "what DOES render is still honest"
    assert one(stranded, "reachable in the DOM") is False, "23 children cannot be opened"
    assert "pageSize 10" in one(stranded, "reachable in the DOM", detail=True)
    invented = w11_tree_verdicts(TREE_CHILDREN, CANNED_TREE
                                 + '\n  - treeitem "issue-implementation completed child run '
                                   'deadbeef · depth 1 · waits for completion" [ref=e83]')
    assert one(invented, "depth-1 children with their own statuses") is False, \
        "a row naming no child of this run is not honest"
    statusless = w11_tree_verdicts([dict(TREE_CHILDREN[0], status="failed")], CANNED_TREE)
    assert one(statusless, "depth-1 children with their own statuses") is False, \
        "the route says failed, the chip says completed"
    wrong_depth = w11_tree_verdicts([dict(TREE_CHILDREN[0], depth=2)], CANNED_TREE)
    assert one(wrong_depth, "depth-1 children with their own statuses") is False
    assert one(w11_tree_verdicts([], CANNED_TREE), "depth-1 children") is None, "no children at all"
    assert one(w11_tree_verdicts(TREE_CHILDREN, "- text: the tree never rendered"),
               "depth-1 children") is False, "children in the route, none on screen"


def test_w11_attempt_list_verdicts():
    """"the attempt list shows attempt 1 `interrupted` with `retry_context` and attempt
    2 `succeeded`" — the pair is C5's product (a worker killed mid-node) and this leg
    kills nothing, so no pair is an honest GAP, never a PASS."""
    pair = [{"attempt_number": 1, "status": "interrupted",
             "retry_context": {"mode": "continue_workspace"}},
            {"attempt_number": 2, "status": "succeeded", "retry_context": None}]
    pair_dom = ("- paragraph: ATTEMPT 1\n"
                "  - paragraph: implement \u00b7 iter 1 \u00b7 attempt 1\n"
                "  - text: interrupted \u2014 the worker disappeared mid-node\n"
                "  - paragraph: what the next attempt inherits (continue_workspace)\n"
                "- paragraph: ATTEMPT 2\n"
                "  - paragraph: implement \u00b7 iter 1 \u00b7 attempt 2\n"
                "  - text: succeeded\n")
    v = w11_attempt_verdicts(pair, pair_dom, "/build_until_verified[1]/implement")
    assert one(v, "attempt 1 interrupted with retry_context") is True, v
    assert one(v, "says which attempt it is showing") is True, v
    # what the shipped pane really draws: ONE attempt, the newest (attempts.at(-1)).
    pane = "- paragraph: ATTEMPT 2\n  - paragraph: implement \u00b7 iter 1 \u00b7 attempt 2\n"
    hidden = w11_attempt_verdicts(pair, pane, "/build_until_verified[1]/implement")
    assert one(hidden, "attempt 1 interrupted with retry_context") is False, \
        "the pane opens on attempts.at(-1), so attempt 1 is nowhere on screen"
    assert "attempts.at(-1)" in one(hidden, "attempt 1 interrupted with retry_context",
                                    detail=True)
    assert one(hidden, "says which attempt it is showing") is True, hidden
    failed = [{"attempt_number": 1, "status": "failed", "retry_context": None},
              {"attempt_number": 2, "status": "succeeded", "retry_context": None}]
    gap = w11_attempt_verdicts(failed, CANNED_TREE, "/plan")
    assert one(gap, "attempt 1 interrupted with retry_context") is None
    assert "C5" in one(gap, "attempt 1 interrupted with retry_context", detail=True)
    assert one(w11_attempt_verdicts([], CANNED_TREE, "/plan"),
               "attempt 1 interrupted with retry_context") is None, "unreadable attempts"
    assert one(w11_attempt_verdicts(pair, "", "/x"), "says which attempt it is showing") is False


def test_w11_internals_stay_out_of_the_dom():
    """`fencing_token`/`lease_expires_at`/`worker_id` appear NOWHERE in the DOM
    (ADR-0016 § 8, re-asserted against the new routes) — both spellings, field NAME
    and the ledger's own VALUE."""
    observed = [("fencing token", ["fencing_token", "fencingToken"], ["1266193754800000001"]),
                ("lease expiry", ["lease_expires_at"], ["2026-10-16T13:45:12Z"]),
                ("worker id", ["worker_id"], ["01a144d1-64b9-7f8c-b32e-e4836f7101dc"])]
    assert one(w11_internals_verdict(CANNED_TREE, observed), "no fencing token") is True
    assert one(w11_internals_verdict(CANNED_TREE + "\n  - text: token 1266193754800000001",
                                     observed), "no fencing token") is False, "the value leaked"
    assert one(w11_internals_verdict(CANNED_TREE + "\n  - text: fencingToken",
                                     observed), "no fencing token") is False, "the name leaked"
    assert one(w11_internals_verdict("", observed), "no lease expiry") is None, "no DOM"
    assert one(w11_internals_verdict(CANNED_TREE, [("worker id", [], [])]),
               "no worker id") is None, "nothing to search is vacuous"


# The run page AS `playwright-cli snapshot` writes it (.playwright-cli/
# page-2026-10-16T13-44-41-301Z.yml, verbatim): each timeline row is a button whose
# ACCESSIBLE NAME repeats its child `generic` text nodes, and `w8_dom_text` then appends
# the whole raw tree again. One drawn event therefore appears FOUR times in the text the
# driver joins — which is the whole of live6/W2.out's "every type drawn ~4x" FAIL.
REAL_TIMELINE_ROWS = """
- generic:
  - button "build_until_verified, 2 done, 1 running" [ref=f1e130]
  - button "build_until_verified" [ref=f1e131]
  - paragraph [ref=f1e152]: 2 of 2 events
  - list [ref=f1e153]:
    - listitem [ref=f1e154]:
      - button "13:44:36 run.created alice" [ref=f1e155]:
        - generic [ref=f1e156]: 13:44:36
        - generic [ref=f1e157]: run.created
        - generic [ref=f1e158]: alice
    - listitem [ref=f1e159]:
      - button "13:44:37 node.attempt.started /plan att 1 a worker (fe7f4bfa)" [ref=f1e160]:
        - generic [ref=f1e161]: 13:44:37
        - generic [ref=f1e162]: node.attempt.started
        - code [ref=f1e163]: /plan
        - generic [ref=f1e164]: att 1
        - generic [ref=f1e165]: a worker (fe7f4bfa)
"""


def test_frames_are_rows_not_string_occurrences():
    """The classification live6/W2.out left open ('drawn MORE often than the journal
    holds them', every type ~4x, 8 journalled rows read as 32 frames): the surplus came
    from counting the SAME row's type string in several surfaces — its accessible name,
    its child text nodes, both again in the appended raw tree — not from a panel painting
    extra frames. On the real snapshot shape the row count is 1 per event while the
    joined text holds 4 occurrences, and the extras verdict is clean."""
    journal = [(1, "run.created"), (2, "node.attempt.started")]
    nodes = pw_snapshot_nodes(REAL_TIMELINE_ROWS)
    dom = w8_dom_text(nodes, REAL_TIMELINE_ROWS)
    vis = w2_visible_types(nodes, [t for _s, t in journal])
    assert {t: v["count"] for t, v in vis.items()} == {"run.created": 1,
                                                       "node.attempt.started": 1}, vis
    assert w2_timeline_total(dom) == (2, 2), w2_timeline_total(dom)
    surfaces = w_frame_surfaces(nodes, REAL_TIMELINE_ROWS, sorted(vis), dom_text=dom)
    assert surfaces["run.created"] == {"rows": 1, "row_name": 1, "row_child": 1,
                                       "raw": 2, "dom": 4}, surfaces["run.created"]
    assert w11_extra_frames_verdict(vis, journal, tag="W2")[1] is True, \
        "one row per journalled row is not a foreign frame"
    crowded = dict(vis, **{"run.created": {"first": 1, "count": 2}})
    label, ok, detail = w11_extra_frames_verdict(crowded, journal, tag="W2", tally=(3, 3))
    assert ok is False, detail
    assert "timeline ROWS on the Timeline panel only" in detail, detail
    assert "the panel's own tally reads 3 of 3 events" in detail, detail
    assert "a real extra" in detail, detail
    assert w11_extra_frames_verdict(vis, [], tag="W2")[1] is None, "no baseline = no claim"


def test_c11_report_honesty_tolerates_a_labelled_true_row():
    """ADR-0035/0036 put BOTH labels in the same report: false for the profile the
    contract names, true on the allowlisted path whose denials the audit read. The arm
    exists for the dishonesty — claiming enforcement BLANKETLY while never spelling the
    false label — so a labelled true row must not FAIL it, and the repo's own current
    reports must satisfy it (the failure live W2's offline suite inherited)."""
    honest = ("agent-turn profile: network_enforced=false (reported, ADR-0019 D3)\n"
              'the allowlisted path: "network_enforced": true\n')
    rows = c11_report_honesty_verdicts(honest)
    assert one(rows, "SANDBOX.md") is True, rows
    blanket = c11_report_honesty_verdicts("network_enforced=true for all profiles")
    assert one(blanket, "SANDBOX.md") is False, blanket
    assert one(c11_report_honesty_verdicts(""), "SANDBOX.md") is None
    root = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                        "..", ".."))
    reads = []
    for rel in C11_REPORT_FILES:
        try:
            with open(os.path.join(root, *rel.split("/")), encoding="utf-8") as f:
                reads.append((rel, f.read()))
        except OSError:
            reads.append((rel, ""))
    report, missing = c11_report_evidence(reads)
    assert [] == missing, missing
    rows = c11_report_honesty_verdicts(report, sources=[r for r, t in reads if t],
                                       missing=missing)
    assert one(rows, "SANDBOX.md") is True, rows[0][2]


def test_gate_release_verdict_names_the_twin_speed_instead_of_blaming_the_ui():
    """live6/W2.out FAILed 'an attempt is live on a worker' twice because the
    deterministic twin's process.exec steps finish in <1s — the poll's 2s interval never
    sees a lease. The shared helper that replaced those probes GAPs that reading (and
    never credits a lease it did not see), while a run still parked at the gate, or one
    that left the gate with no attempt rows at all, stays a real FAIL."""
    live = {"id": "452c647c", "key": "/build_until_verified[1]/review", "worker": "worker-a"}
    rows = [w_gate_release_verdict(live, "running", "8", tag="W10")]
    assert one(rows, "the gate released the run into real work") is True, rows
    assert "452c647c" in one(rows, "the gate released the run into real work", detail=True), rows
    _label, ok, detail = w_gate_release_verdict(None, "completed", "8", tag="W11")
    assert ok is None, detail
    assert "finish faster than the poll's 2s interval" in detail, detail
    assert detail.startswith("no attempt was sampled MID-LEASE"), detail
    assert one([w_gate_release_verdict(None, "waiting_human", "1")],
               "the gate released the run into real work") is False, "the gate never released it"
    assert one([w_gate_release_verdict(None, "completed", "0")],
               "the gate released the run into real work") is False, "no attempts = no work to watch"


def test_w11_opens_a_node_whose_attempt_list_has_rows():
    """live6/W11 opened `/fan_out[0]/invoke`, whose attempt list is empty in the ROUTE
    and in the ledger (an invocation node is run by the advancer, no worker ever leases
    it), so the row's attempt arms could only GAP on "did not read back". The choice
    prefers a real interrupted pair, then any execution that owns attempts."""
    nodes = [{"id": "n0", "node_instance_key": "/fan_out[0]/invoke",
              "kind": "pipeline.invoke", "attempt_count": 0},
             {"id": "n1", "node_instance_key": "/plan", "kind": "agent.acp",
              "attempt_count": 1},
             {"id": "n2", "node_instance_key": "/build_until_verified[1]/review",
              "kind": "process.exec", "attempt_count": 3}]
    assert w11_pick_attempted_node(nodes)["id"] == "n2", "the retry loop is the pair's home"
    assert w11_pick_attempted_node(nodes, "n0")["id"] == "n0", "a ledger-named interrupted row wins"
    assert w11_pick_attempted_node(nodes[:2])["id"] == "n1", "a list with one row beats an empty invoke"
    assert w11_pick_attempted_node(nodes[:1])["id"] == "n0", "nothing else exists -> name it and GAP"
    assert w11_pick_attempted_node([]) is None, "no executions at all"
    assert w11_pick_attempted_node(None) is None
    assert w11_pick_attempted_node(["junk", nodes[1]])["id"] == "n1", "a ragged row is not a node"


NESTED_TREE_CHILDREN = [{"run": {"id": "01a144d1-0000-7000-8000-00003f5a9c1d",
                                 "status": "completed", "depth": 1},
                        "node_instance_key": "/fan_out[1]/invoke",
                        "wait_policy": "completion", "depth": 1, "children": []},
                       {"run": {"id": "01a144d1-0000-7000-8000-00007b2e1140",
                               "status": "running", "depth": 1},
                        "node_instance_key": "/fan_out[2]/invoke",
                        "wait_policy": "completion", "children": []}]


def test_w11_reads_the_tree_route_its_own_shape():
    """`GET /runs/{id}/tree` answers RunTreeView: the child's id and status are NESTED
    under `run` (internal/api/runs.go:293-300), which is how C8d reads them. W11's first
    live run read the top level only, so every child looked like `child_run_id=None,
    status='None'` and ten child rows sitting on screen were reported as "naming no child
    of this run" — the driver failing to spell its own answer key, not the page hiding
    children. The normaliser takes both shapes."""
    assert w11_child_view(NESTED_TREE_CHILDREN[0]) == {
        "child_run_id": "01a144d1-0000-7000-8000-00003f5a9c1d", "status": "completed",
        "depth": 1, "node_instance_key": "/fan_out[1]/invoke",
        "wait_policy": "completion"}, w11_child_view(NESTED_TREE_CHILDREN[0])
    assert w11_child_view(TREE_CHILDREN[1])["child_run_id"].endswith("7b2e1140")
    assert w11_child_view(None)["child_run_id"] == "" and w11_child_view(None)["status"] == ""
    v = w11_tree_verdicts(NESTED_TREE_CHILDREN, CANNED_TREE)
    assert one(v, "depth-1 children with their own statuses") is True, v
    assert one(v, "reachable in the DOM") is True, v
    assert "completed" in one(v, "depth-1 children", detail=True), \
        "the route's own child statuses must reach the evidence line"
    # A child the page does not render is STILL the honest FAIL it was:
    assert one(w11_tree_verdicts(NESTED_TREE_CHILDREN[:1] + [dict(
        NESTED_TREE_CHILDREN[1], run=dict(NESTED_TREE_CHILDREN[1]["run"],
                                         id="01a144d1-0000-7000-8000-0000deadbeef"))],
        CANNED_TREE), "depth-1 children") is False, "one child of 2 never drawn"


# --- W11: the answer key and the DOM must be read at the SAME moment ----------
# accept/20261026-035125-77a1219 W11 line 2401:
#   FAIL W11 the tree renders depth-1 children with their own statuses — 17 of 3 child
#   rows rendered; rows naming no child of this run: [14 ids]; rows carrying no status
#   word: ['841761ed','673031a8','983d9781']; child statuses the route reports: ['queued']
# at d3466df the same gate read "25 of 25". The fan-out was still opening while the key
# was read; the page was snapshotted after it. The canned fan-out below is C8's 25
# children in both readings — the key the route reports, and the rows RunTree writes.

W11_FANOUT = [f"01a144d1-0000-7000-8000-0000{i:08x}" for i in range(1, 26)]
W11_TAILS = [r[-8:] for r in W11_FANOUT]


def w11_fanout_key(count, status_at=lambda i: "queued"):
    """`count` of the fan-out's children as `GET /runs/{id}/tree` reports them — W11's
    answer key, the i-th child carrying `status_at(i)`."""
    return [{"child_run_id": W11_FANOUT[i], "status": status_at(i), "depth": 1,
             "wait_policy": "completion",
             "node_instance_key": f"/fan_out[{i + 1}]/invoke"} for i in range(count)]


def w11_fanout_dom(count, status_at=lambda i: "queued", extra=()):
    """The tree page as `RunTree.tsx:478` writes it — `<chip> child run <short id> ·
    depth 1 · waits for completion` — one row per RENDERED child; `extra` appends rows
    naming run ids no read of the route ever reported."""
    lines = ["### Snapshot", "```yaml", "- tree:", '  - treeitem "fan_out" [ref=e70]']
    lines += [f'  - treeitem "invoke {status_at(i)} child run {W11_TAILS[i]} · depth 1 '
              f'· waits for completion" [ref=e{80 + i}]' for i in range(count)]
    lines += [f'  - treeitem "invoke completed child run {s} · depth 1 '
              f'· waits for completion" [ref=e{200 + n}]' for n, s in enumerate(extra)]
    return "\n".join(lines)


# the page as the browser drew it seconds after the key: the first children have moved
# past `queued`, and the fan-out has opened 17 of its 25 rows.
W11_LIVE_DOM = w11_fanout_dom(17, lambda i: ("completed" if i == 0 else
                                             "running" if i < 3 else "queued"))
W11_STALE_KEY = w11_fanout_key(3)
W11_FRESH_KEY = w11_fanout_key(17, lambda i: ("completed" if i == 0 else
                                              "running" if i < 3 else "queued"))


def test_w11_a_key_read_mid_fanout_is_the_race_that_false_failed():
    """The OLD reading is kept under test on purpose: a key that stops at 3 children
    against a 17-row DOM is exactly the live FAIL, so the fix is graded against the
    symptom and not just against a happy path."""
    v = w11_tree_verdicts(W11_STALE_KEY, W11_LIVE_DOM)
    assert one(v, "depth-1 children with their own statuses") is False, \
        "the stale key is what produced the live FAIL"
    det = one(v, "depth-1 children", detail=True)
    assert "17 of 3 child rows rendered" in det, det
    assert len(W11_TAILS[:17]) - 3 == 14, "14 honest rows the stale key never saw"
    assert all(t in det for t in W11_TAILS[3:17]), det
    assert "'00000001', '00000002', '00000003'" in det, f"the moved chips: {det}"


def test_w11_grades_the_dom_against_a_key_read_at_the_same_moment():
    """Fix (1)+(2): the key is waited out to the whole fan-out and re-read right after
    the snapshot, so ids and statuses were observed when the page was drawn — the rows
    the stale key called invented and statusless are honest under the fresh key."""
    v = w11_tree_verdicts(W11_FRESH_KEY, W11_LIVE_DOM, prior_children=W11_STALE_KEY)
    assert one(v, "depth-1 children with their own statuses") is True, \
        one(v, "depth-1 children", detail=True)
    assert "re-read after the snapshot" in one(v, "depth-1 children", detail=True)
    # the whole fan-out rendered (what d3466df measured as 25 of 25) is a clean PASS on
    # both arms, with the mid-fan-out read along as the second opinion.
    dom25 = w11_fanout_dom(25)
    both = w11_tree_verdicts(w11_fanout_key(25), dom25, prior_children=W11_STALE_KEY)
    assert one(both, "depth-1 children with their own statuses") is True, both
    assert one(both, "reachable in the DOM") is True, both


def test_w11_accepts_the_status_either_tree_read_saw():
    """A child moves `queued → running → completed` between the pre-snapshot read, the
    snapshot and the re-read. The chip is honest against EITHER read; a chip matching
    neither is still a wrong status, and with no `prior_children` supplied the verdict
    is exactly the old one."""
    dom_running = w11_fanout_dom(1, lambda i: "running")
    queued_before, running_now = (w11_fanout_key(1, lambda i: "queued"),
                                  w11_fanout_key(1, lambda i: "running"))
    # queued -> running between the two reads (the live case): PASS either way.
    assert one(w11_tree_verdicts(running_now, dom_running, prior_children=queued_before),
               "depth-1 children") is True, "the status moved after the key was read"
    assert one(w11_tree_verdicts(running_now, dom_running), "depth-1 children") is True
    # running -> succeeded between the reads: the chip holds the PRE-snapshot truth.
    succeeded_now = w11_fanout_key(1, lambda i: "succeeded")
    with_prior = w11_tree_verdicts(succeeded_now, dom_running, prior_children=running_now)
    assert one(with_prior, "depth-1 children") is True, one(with_prior, "depth-1",
                                                            detail=True)
    det = one(with_prior, "depth-1 children", detail=True)
    assert "status moved between the two reads" in det and "running" in det, det
    assert one(w11_tree_verdicts(succeeded_now, dom_running), "depth-1 children") is False, \
        "prior_children defaults to the current single-read behaviour"
    failed_now = w11_fanout_key(1, lambda i: "failed")
    assert one(w11_tree_verdicts(failed_now, dom_running, prior_children=queued_before),
               "depth-1 children") is False, "a chip no read ever saw is a wrong status"


def test_w11_still_fails_a_row_that_names_no_child_of_this_run():
    """The tolerance is for the driver's own two reads of THIS run's tree, never for the
    page: a row naming an id neither read reported stays a FAIL."""
    dom = w11_fanout_dom(25, extra=["deadbeef"])
    v = w11_tree_verdicts(w11_fanout_key(25), dom, prior_children=W11_STALE_KEY)
    assert one(v, "depth-1 children with their own statuses") is False, \
        "an invented row is not made honest by a second read"
    assert "deadbeef" in one(v, "depth-1 children", detail=True)
    assert one(v, "reachable in the DOM") is True, "the 25 real children are all on screen"
    # a child the fresh read LOST but the pre-snapshot read saw is still a child of this
    # run, so its row is not 'invented'; the stranded arm is graded on the fresh key.
    dropped = w11_tree_verdicts(w11_fanout_key(1), w11_fanout_dom(3),
                                prior_children=w11_fanout_key(3))
    assert one(dropped, "depth-1 children") is True, one(dropped, "depth-1", detail=True)
    assert one(dropped, "reachable in the DOM") is True


def test_w11_waits_for_the_whole_fanout_before_reading_its_key():
    """Fix (1) over canned `/tree` reads (fake clock, no stack): the leg may stop polling
    only when the fan-out is FULL, and must keep today's behaviour — report what it read
    — when it never gets there."""
    import e2e_m4_exit as m

    class Clock:
        """Monotonic fake clock so a 300 s cap costs no wall time."""

        def __init__(self):
            self.now = 1000.0

        def time(self):
            return self.now

        def sleep(self, secs):
            self.now += secs

    def drive(reads, want=25, seconds=300, delay=5):
        polls, pos = [0], [0]

        def fake_tree(client, run_id):
            polls[0] += 1
            n = reads[min(pos[0], len(reads) - 1)]
            pos[0] += 1
            return {"children": w11_fanout_key(n)}

        orig = (m.time, m.c8_tree_doc)
        m.time, m.c8_tree_doc = Clock(), fake_tree
        try:
            out = m.w11_wait_fanout_children(object(), "r1", want, seconds, delay)
        finally:
            m.time, m.c8_tree_doc = orig
        return out, polls[0]

    out, n = drive([3, 9, 24, 25])
    assert len(out) == 25 and n == 4, (len(out), n)
    full = w11_tree_verdicts(out, w11_fanout_dom(25))
    assert one(full, "depth-1 children") is True, full
    assert one(full, "reachable in the DOM") is True, full
    # already-full route: one read, no sleeping at all
    out, n = drive([25])
    assert len(out) == 25 and n == 1, (len(out), n)
    # a fan-out stuck at 3 children costs its window and is then reported honestly
    out, n = drive([3], seconds=60, delay=5)
    assert len(out) == 3 and n == 12, (len(out), n)
    partial = w11_tree_verdicts(out, w11_fanout_dom(3))
    assert one(partial, "depth-1 children") is True, partial
    assert one(w11_tree_verdicts(out, W11_LIVE_DOM), "depth-1 children") is False, \
        "and the honest 3-of-17 verdict is still the FAIL it always was"


def test_w11_fanout_wait_decides_the_approval_gate_it_waits_behind():
    """Two `--only W11` passes both said `PASS W11 the gate released the run into real
    work` (the PRE-gate `/plan` lease) and then `GAP W11 the child-run tree arms — the
    /tree route holds no children`, with the run STILL `waiting_human` in postgres: no
    approval was ever decided, and /fan_out sits behind that gate. Over canned ledger
    reads the wait must decide the gate (C1b's route) and still return the full fan-out."""
    import e2e_m4_exit as m

    class Clock:
        def __init__(self):
            self.now = 1000.0

        def time(self):
            return self.now

        def sleep(self, secs):
            self.now += secs

    def drive(statuses, approve, reads, want=25, seconds=60, delay=5, project_id="p-1"):
        """Drive the wait over canned reads: `statuses` is the run's status per poll (the
        last repeats), `approve` what decide returns, `reads` the /tree child count per
        poll. Returns (children, decide_calls, check_lines)."""
        polls, pos, calls, checks = [0], [0], [], []

        def fake_status(run_id):
            return statuses[min(polls[0], len(statuses) - 1)]

        def fake_tree(client, run_id):
            n = reads[min(pos[0], len(reads) - 1)]
            pos[0] += 1
            polls[0] += 1
            return {"children": w11_fanout_key(n)}

        orig = (m.time, m.c8_tree_doc, m.run_status, m.approve_gate, m.check)
        m.time, m.c8_tree_doc, m.run_status = Clock(), fake_tree, fake_status
        m.approve_gate = lambda client, pid, rid: calls.append(pid) or approve
        m.check = lambda label, ok, detail="": checks.append((label, ok, detail)) or ok
        try:
            out = m.w11_wait_fanout_children(object(), "r1", want, seconds, delay,
                                             project_id=project_id)
        finally:
            m.time, m.c8_tree_doc, m.run_status, m.approve_gate, m.check = orig
        return out, calls, checks

    def gate_lines(rows):
        return [c for c in rows if "the approval gate was decided" in c[0]]

    # the live shape: held in waiting_human, decided once, then the 25 children open.
    out, calls, checks = drive(["waiting_human", "running"], True, [0, 25])
    assert len(out) == 25, (len(out), calls)
    assert len(calls) == 1 and len(gate_lines(checks)) == 1, checks
    label, ok, detail = gate_lines(checks)[0]
    assert ok is True and "C1b's route" in label, (label, ok)
    assert "released from waiting_human" in detail, detail
    assert one(w11_tree_verdicts(out, w11_fanout_dom(25)), "depth-1 children") is True, \
        "with the gate decided the tree arms have a fan-out to grade"

    # a gate this leg cannot decide is an honest FAIL naming the route, not a GAP that
    # blames the /tree route for a run nobody ever released.
    out, calls, checks = drive(["waiting_human"], False, [0])
    assert out == [] and len(calls) == 12, (out, calls)
    assert len(gate_lines(checks)) == 1 and gate_lines(checks)[0][1] is False, checks
    assert "never returning 200" in gate_lines(checks)[0][2], gate_lines(checks)

    # a run that was never held (what the full acceptance order usually handed W11)
    # is not touched at all.
    out, calls, checks = drive(["running"], True, [25])
    assert len(out) == 25 and calls == [] and gate_lines(checks) == [], (out, calls, checks)

    # a SECOND waiting_human (a later ask) gets its own decide and its own line.
    out, calls, checks = drive(["waiting_human", "running", "running", "waiting_human",
                                "running"], True, [0, 0, 0, 0, 25])
    assert len(out) == 25 and len(calls) == 2 and len(gate_lines(checks)) == 2, \
        (len(out), calls, checks)

    # with no project named the wait reads the tree and NOTHING else: the behaviour
    # every other caller of a tree poll keeps.
    def boom(run_id):
        raise AssertionError("read the ledger with no project to decide a gate for")

    orig = (m.time, m.c8_tree_doc, m.run_status)
    m.time, m.run_status = Clock(), boom
    m.c8_tree_doc = lambda client, run_id: {"children": w11_fanout_key(25)}
    try:
        out = m.w11_wait_fanout_children(object(), "r1", 25, 60, 5)
    finally:
        m.time, m.c8_tree_doc, m.run_status = orig
    assert len(out) == 25, "no project -> the wait stays a pure /tree poll"


def test_w11_leg_rereads_the_tree_after_its_snapshot():
    """The fix is the LEG's ordering, not only the verdict algebra: wait the fan-out
    open, snapshot the page, re-read the key, and hand both reads to the verdict."""
    import ast

    here = os.path.dirname(os.path.abspath(__file__))
    src = open(os.path.join(here, "e2e_m4_exit.py"), encoding="utf-8").read()
    fns = {n.name: n for n in ast.parse(src).body if isinstance(n, ast.FunctionDef)}
    leg = ast.get_source_segment(src, fns["w11"])
    assert "w11_wait_fanout_children(client, run_id, C8_ITEMS" in leg, \
        "W11 still reads its key mid-fan-out"
    assert "project_id=project_id" in leg[leg.index("w11_wait_fanout_children("):], \
        "the fan-out wait cannot decide the gate W11's own run is held in"
    assert "len(children) >= 3" not in leg, "the >= 3 break is the race itself"
    snap = leg.index('pw_snapshot(session="m4w11")')
    reread = leg.index("w11_tree_children(client, run_id)")
    verdict = leg.index("w11_tree_verdicts(")
    assert snap < reread < verdict, (snap, reread, verdict)
    call = leg[verdict:leg.index(")", verdict)]
    assert "prior_children=" in call, call
    assert "children_after or children" in call, \
        "an unreadable re-read falls back to the key the leg has"


# --- W5/W6: the interrupted page, the forbidden words, the lost workspace -----
# Row § 7.2 W5 quotes three pieces of copy and forbids three words; W6 quotes one
# sentence, one chip and one withheld control. All of it is text work over a snapshot,
# so it is pinned here WITHOUT a browser: the canned trees below are the shapes
# playwright-cli prints for ui/src/components/m4/AttemptDetail.tsx and RunInspector.

W5_PANE = """
### Page
- Page URL: http://localhost:18091/projects/01a1/runs/01a2
### Snapshot
```yaml
- heading "/build_until_verified[1]/implement · attempt 1" [level=3] [ref=e50]
- status "OUTCOME UNKNOWN" [ref=e51]: interrupted — the worker disappeared mid-node. Nothing
  was finished on its side, and anything after the last completed boundary may be repeated
- term "scheduled" [ref=e52]
- definition [ref=e53]: 2026-10-16 11:02:15 UTC
- paragraph: ↻ next attempt scheduled 2026-10-16 11:02:15 UTC · backoff 5s
- status: · Loading artifacts…
```
"""

W5_ATTEMPT2 = """
- heading "/build_until_verified[1]/implement · attempt 2" [level=3] [ref=e60]
- text: running
- paragraph: ↻ next attempt scheduled 2026-10-16 11:02:15 UTC
"""

W5_DISHONEST = W5_ATTEMPT2 + """
- status "RESUMED" [ref=e61]: the run was resumed after the crash — no data lost
"""

W6_PANE = """
### Page
- Page URL: http://localhost:18091/projects/01a1/runs/01a3
### Snapshot
```yaml
- heading "/build_until_verified[1]/implement · attempt 2" [level=3] [ref=e70]
- text: error class
- generic: × workspace_lost — the workspace is gone
- alert "EDITS LOST" [ref=e71]: prior edits lost, rerun required. No automatic retry is
  offered: there is no workspace to continue in
- button "Pause" [ref=e72]
- button "Cancel" [ref=e73]
- button "Retry" [ref=e74]
```
"""

W6_CHIP_ONLY = """
- text: error class
- generic: × workspace_lost — the workspace is gone
- button "Retry" [ref=e74]
"""

# The graph-first dock (ADR-0043 decision 5): attempt tabs for retries, ONE attempt's
# facts drawn at a time, newest first — the shape the W5 arm navigates.
W5_DOCK_ATTEMPT2 = """
- tablist "Attempts":
  - tab "attempt 1 · interrupted" [ref=e50]
  - tab "attempt 2 · succeeded" [selected, ref=e51]
- heading "ATTEMPT 2" [level=3] [ref=e52]
- text: attempt 2 of 2
"""

W5_DOCK_ATTEMPT1 = """
- tablist "Attempts":
  - tab "attempt 1 · interrupted" [selected, ref=e50]
  - tab "attempt 2 · succeeded" [ref=e51]
- heading "ATTEMPT 1" [level=3] [ref=e52]
- alert "OUTCOME UNKNOWN" [ref=e53]: interrupted — the worker disappeared mid-node. Nothing
  was finished on its side, and anything after the last completed boundary may be repeated
- paragraph: ↻ next attempt scheduled 2026-10-16 11:02:15 UTC · backoff 60s
"""


def test_w5_wording_and_forbidden_scan():
    """W5's three wording arms plus 10 J7's honesty rule. The forbidden scan is the
    verdict that matters most: ONE missing piece of honest copy is a FAIL, and a single
    'resumed' anywhere on the page is a FAIL that quotes the line."""
    assert w_norm("Interrupted  —\nthe WORKER") == "interrupted - the worker"
    assert w_quotes("nothing here", "interrupt") == ["(no line mentions 'interrupt')"], \
        "a FAIL detail still has to be a quote-shaped list"
    nodes = pw_snapshot_nodes(W5_PANE)
    dom = w8_dom_text(nodes, W5_PANE)
    hit = w5_interrupted_verdict(dom)
    assert hit[1] is True, hit
    # the copy is matched case- and dash-insensitively but NOT loosely: a page that says
    # 'interrupted' alone has not said the row's sentence.
    assert w5_interrupted_verdict("- text: interrupted")[1] is False
    assert "the page says" in w5_interrupted_verdict("- text: interrupted")[2]
    # ADR-0043 moved attempts into the workbench dock, which draws ONE attempt at a time
    # and leads with the newest: the row's sentence lives in the DEAD attempt's pane, so
    # the arm opens it with `?attempt=<n>` and a FAIL names the attempt it actually read.
    dock_on_retry = w8_dom_text(pw_snapshot_nodes(W5_DOCK_ATTEMPT2), W5_DOCK_ATTEMPT2)
    miss = w5_interrupted_verdict(dock_on_retry, " (the pane of attempt 2, the retry)")
    assert miss[1] is False, "the retry's pane does not get to speak for the dead try"
    assert "(the pane of attempt 2, the retry)" in miss[2], miss[2]
    assert "attempt 1 · interrupted" in dock_on_retry, \
        "the strip still names the dead try while the retry is on screen"
    dock_on_dead = w8_dom_text(pw_snapshot_nodes(W5_DOCK_ATTEMPT1), W5_DOCK_ATTEMPT1)
    hit = w5_interrupted_verdict(dock_on_dead, " (attempt 1)")
    assert hit[1] is True, hit
    assert "(attempt 1)" in hit[2], hit[2]
    # countdown: the row names the CONTENT (the promised scheduled_at), so the time the
    # ledger promised must be on screen — as the countdown line or as the retried
    # attempt's own `scheduled` fact, which carries the identical value
    led = ["2026-10-16 11:02:15"]
    assert w5_countdown_verdict(dom, led)[1] is True, w5_countdown_verdict(dom, led)
    fact_only = '- term "scheduled"\n- definition: 2026-10-16 11:02:15 UTC\n'
    assert w5_countdown_verdict(fact_only, led)[1] is True, \
        "the scheduled fact IS the retry's promise"
    assert "scheduled" in w5_countdown_verdict(fact_only, led)[2]
    assert w5_countdown_verdict(dom, ["2026-10-16 11:99:99"])[1] is False, \
        "a countdown copy that shows a time the ledger never promised is the FAIL"
    assert w5_countdown_verdict(dom, [])[1] is None, \
        "an unreadable promise cannot be checked — GAP, never PASS"
    assert w5_countdown_verdict("- text: nothing", led)[1] is False
    # attempt 2 across the leg's samples
    assert w5_attempt2_verdict(dom + W5_ATTEMPT2, "/build_until_verified[1]/implement")[1] is True
    assert w5_attempt2_verdict(dom, "/plan")[1] is False
    # the honesty rule: none of the three words on the honest page…
    assert w_forbidden_word_hits(dom, W5_FORBIDDEN_WORDS) == []
    assert one(w_forbidden_word_verdicts(dom), "appear nowhere") is True
    # …and every one of them drawn is a FAIL naming the words AND the line
    hits = w_forbidden_word_hits(W5_DISHONEST, W5_FORBIDDEN_WORDS)
    assert sorted(w for w, _ in hits) == ["no data lost", "resumed"], hits
    v = one(w_forbidden_word_verdicts(W5_DISHONEST), "appear nowhere", detail=True)
    assert "resumed" in v and "no data lost" in v, v
    assert one(w_forbidden_word_verdicts(W5_DISHONEST), "appear nowhere") is False
    # an empty scan is never a silent PASS over a page that was never read
    assert one(w_forbidden_word_verdicts(""), "appear nowhere") is True, \
        "no text has no forbidden words — the caller's 'page rendered' check carries that"


def test_w5_kill_proof_console_and_spinner():
    """The kill's own proof, the console, and the stuck spinner — all three read as
    GAPs when there was nothing to measure, never as schedule-PASSes."""
    assert one(w5_kill_landed_verdicts("interrupted", 2, True), "died holding a live lease") is True
    assert one(w5_kill_landed_verdicts("closed", 1, True), "died holding") is False
    assert one(w5_kill_landed_verdicts("closed", 1, None), "died holding") is None
    assert one(w5_kill_landed_verdicts("unattainable", 4, None), "died holding") is None
    assert one(w5_kill_landed_verdicts("live", 1, True), "died holding") is False
    assert one(w5_kill_landed_verdicts("", 0, None), "died holding") is None
    # console: the same reading as W9, relabelled, never re-invented
    clean = "Total messages: 4 (Errors: 0, Warnings: 1)\n[log] hi\n"
    label, ok, det = w5_console_verdict(clean, 0)
    assert label.startswith("W5 ") and ok is True, (label, det)
    assert w5_console_verdict("[error] boom\n", 0)[1] is False
    assert w5_console_verdict("", 1)[1] is None, "an unreadable console proves nothing clean"
    # spinner: the app's announced loading state is `· {label}…`
    nodes = pw_snapshot_nodes(W5_PANE)
    assert w_spinner_nodes(nodes) == ["· Loading artifacts…"], w_spinner_nodes(nodes)
    assert w_spinner_nodes(pw_snapshot_nodes(W5_ATTEMPT2)) == []
    assert w5_spinner_verdict(nodes, "")[1] is None, "no terminal state → unmeasurable"
    assert w5_spinner_verdict(nodes, "completed")[1] is False, "terminal + spinner = stuck"
    assert w5_spinner_verdict(pw_snapshot_nodes(W5_ATTEMPT2), "completed")[1] is True
    # a state ALERT shares role=status but is not a spinner: it must never be counted
    assert w_spinner_nodes(pw_snapshot_nodes('- status "INTERRUPTED" [ref=e1]: interrupted')) \
        == [], "the honest interrupted banner is not a loading state"


def test_w6_loss_copy_chip_and_retry_control():
    """W6: the sentence (case-insensitive, both halves), the chip, and the control the
    row says must not be offered."""
    nodes = pw_snapshot_nodes(W6_PANE)
    dom = w8_dom_text(nodes, W6_PANE)
    assert w6_loss_copy_verdict(dom)[1] is True, w6_loss_copy_verdict(dom)
    assert w6_loss_copy_verdict(dom.upper())[1] is True, "the row's check is case-insensitive"
    label, ok, det = w6_loss_copy_verdict(W6_CHIP_ONLY)
    assert ok is False and "missing" in det, (label, det)
    assert W6_LOSS_COPY[0] in det and W6_LOSS_COPY[1] in det, det
    assert w6_chip_verdict(nodes, dom)[1] is True
    assert w6_chip_verdict([], "") [1] is False, "no chip is the honest FAIL the row asks for"
    assert one([w6_chip_verdict(nodes, dom)], "chip", detail=True).startswith("1 element")
    # the retry control: § 7.2 W6's words are "no AUTO-retry is offered"; the rule it
    # cites (M3 W8) is a WORDING rule about the UI, and route 31 keeps the operator's
    # manual rerun of failed node executions (no workspace_lost exclusion). The engine's
    # half is the journal's (w6_auto_retry_class_verdicts), so this arm fails an offered
    # AUTOMATIC retry, not the manual rerun the row's own copy asks for.
    ctrls = w_retry_controls(nodes)
    assert [c["text"] for c in ctrls] == ["Retry"], ctrls
    live17 = ('### Result\n"Re-runs 7 nodes: /build_until_verified, '
              '/build_until_verified[1]/implement"')  # live17/W6.out's real route-31 title
    assert w6_retry_control_verdict([], dom, 0)[1] is True
    assert w6_retry_control_verdict([dict(c, disabled=True) for c in ctrls], dom, 0)[1] is True
    assert w6_retry_control_verdict([dict(c, disabled=None, title="not retriable")
                                     for c in ctrls], dom, 0)[1] is True
    gap = w6_retry_control_verdict([dict(c, disabled=None) for c in ctrls], dom, 0)
    assert gap[1] is None and "did not read back" in gap[2], gap
    manual = w6_retry_control_verdict([dict(c, disabled=False, title=live17)
                                       for c in ctrls], dom, 0)
    assert manual[1] is True and "manual rerun" in manual[2], manual
    assert "run=0" in manual[2], "the engine's half is quoted so a reader can tell them apart"
    unnamed = w6_retry_control_verdict([dict(c, disabled=False) for c in ctrls], dom, 0)
    assert unnamed[1] is True and "NONE of them offers an automatic retry" in unnamed[2], unnamed
    for promise in ("Retry — this failure will be retried automatically",
                    "Retry · auto retry scheduled",
                    "Retry — next attempt scheduled on backoff"):
        bad = w6_retry_control_verdict([dict(c, disabled=False, title=promise)
                                        for c in ctrls], dom, 0)
        assert bad[1] is False and "AUTOMATIC" in bad[2], (promise, bad)
    # an honest refusal that SAYS no auto-retry is offered is not an offer of one
    assert w6_retry_control_verdict(
        [dict(c, disabled=False, title="Retry — no automatic retry is offered; "
                                        "start a new run") for c in ctrls], dom, 0)[1] is True
    # the engine's half still rules: a scheduled loss retry is an auto-retry whoever
    # drew the control, and an unreadable journal leaves the claim half-measured
    assert w6_retry_control_verdict([dict(c, disabled=False, title=live17)
                                     for c in ctrls], dom, 1)[1] is False
    assert w6_retry_control_verdict([dict(c, disabled=False, title=live17)
                                     for c in ctrls], dom, None)[1] is None


def test_w_pick_container_only_this_projects_worker():
    """C5's kill has always been aimed at `communication-m4-worker-a`, which is a NAME
    PREFIX: the container compose runs is communication-m4-worker-a-1, and docker
    answers the prefix with 'no such object'. W5 kills the worker it can PROVE belongs
    to this project and nothing else."""
    seen = ["communication-m4-worker-a-1", "communication-m4-worker-b-1",
            "llm-collective-worker-a-1", "communication-m4-api-a-1"]
    assert w_pick_container(seen, "worker-a") == "communication-m4-worker-a-1"
    assert w_pick_container(seen, "worker-b") == "communication-m4-worker-b-1"
    assert w_pick_container(seen, "api-a") == "communication-m4-api-a-1", \
        "the resolver is not worker-specific, it is project-specific"
    assert w_pick_container(["communication-m4-worker-a"], "worker-a") == "", \
        "the prefix alone is NOT a container — that is the bug this helper exists for"
    assert w_pick_container(["communication-m4-worker-a-1"], "worker-b") == ""
    assert w_pick_container(["communication-m4-worker-a-1x"], "worker-a") == ""
    assert w_pick_container(["communication-m4-worker-a-1"], "worker-a", project="other") == ""
    assert w_pick_container([], "worker-a") == "" and w_pick_container(None, "") == ""


def test_w5_w6_aim_their_kill_at_the_held_post_gate_attempt():
    """live8/W5.out and live8/W6.out both GAPped `no attempt row readable after 0 kill
    pick(s)`: the shared kill sequence waited for ANY held attempt, the twin parks at
    /approve with nothing leased (and holds /plan BEFORE the gate), and the run reached
    its terminal state before a signal could be aimed anywhere. W5/W6 now inherit
    C5's target-node picker — the held POST-GATE /build_until_verified[1]/implement —
    and dump WHY (validated inputs, longest held attempt, the mounted fixture script)
    before they GAP."""
    here = os.path.dirname(os.path.abspath(__file__))
    src = open(os.path.join(here, "e2e_m4_exit.py"), encoding="utf-8").read()
    import ast
    tree = ast.parse(src)
    fn = next(n for n in tree.body if isinstance(n, ast.FunctionDef)
              and n.name == "w_kill_worker_mid_node")
    calls = {c.func.id: c for c in ast.walk(fn) if isinstance(c, ast.Call)
             and isinstance(c.func, ast.Name)}
    assert "wait_live_past_gate" in calls, sorted(calls)
    kw = {k.arg: ast.unparse(k.value) for k in calls["wait_live_past_gate"].keywords}
    assert kw.get("target") == "target", f"the target must reach the wait: {kw}"
    assert "fault_hold_evidence" in calls, "nothing-was-held needs its WHY dumped first"
    assert "dump_run_evidence" in calls, "…and the run's own evidence with it"
    # the verdict line carries the diagnosis instead of leaving the row to blame the UI
    why = "LAB FAULT, not a product gap: hold_seconds=45 posted…"
    det = one(w5_kill_landed_verdicts("", 0, None, why), "died holding", detail=True)
    assert why in det, det
    assert "target node" in det, det
    det2 = one(w5_kill_landed_verdicts("unattainable", 3, None, why), "died holding",
               detail=True)
    assert why in det2 and "hold_seconds is not taking effect" in det2, det2
    assert one(w5_kill_landed_verdicts("", 0, None), "died holding") is None, \
        "no diagnosis is still an honest GAP"
    assert C_LIVE_TARGET_KEY == "/build_until_verified[1]/implement"


ROWS_1 = [{"attempt_number": "1", "status": "interrupted", "error_class": "interrupted",
           "detail": "-", "worker": "worker-a"}]
ROWS_LOST = ROWS_1 + [{"attempt_number": "2", "status": "failed",
                       "error_class": W6_ERROR_CLASS, "detail":
                       "prior edits lost, rerun required", "worker": C6_LOSS_WORKER}]
ROW_LOST = ROWS_LOST[1]


def test_w6_who_armed_the_retry_reads_the_ledger_not_a_post():
    """live13/W6.out raced the engine: it drained worker-a, pointed the run at
    worker-c and POSTED /runs/{id}/retry, which answered 409 "a running run is not
    retriable" while the ledger already read attempt 2 failed/infra — with the twin's
    attempt_limit 2 the ENGINE armed that attempt the moment the reconciler wrote
    interrupted (§ 7.1 C5b's "running (retry armed)"). The leg now arms NOTHING and
    grades whose attempt it measured."""
    ok = w6_who_armed_the_retry("1", ROWS_LOST, C6_LOSS_WORKER)[0]
    assert ok[1] is True and "W6 graded the engine's own attempt 2" in ok[2], ok
    # scheduled but never claimed: the affinity flip lost the race, and a leg that
    # posted no retry has nobody else to blame
    never = w6_who_armed_the_retry("1", ROWS_1, C6_LOSS_WORKER)[0]
    assert never[1] is False and "claimed" in never[2].lower(), never
    # no scheduling AND no attempt: nothing to measure is a GAP, never a FAIL
    assert w6_who_armed_the_retry("0", ROWS_1, "") [0][1] is None
    assert w6_who_armed_the_retry(None, ROWS_1, "")[0][1] is None, \
        "an unreadable retry_scheduled count proves nothing"
    # claimed, but by the worker that ALREADY had the tree: no cross-volume subject
    same = w6_who_armed_the_retry("1", ROWS_1 + [dict(ROW_LOST, worker="worker-a")],
                                  C6_LOSS_WORKER)[0]
    assert same[1] is False and "worker-a" in same[2], same
    # a reused ledger case names no throwaway: any claiming worker satisfies the arm
    assert w6_who_armed_the_retry("1", ROWS_LOST, "")[0][1] is True


def test_w6_auto_retry_class_verdicts_sees_the_engine_pre_loss_but_not_post_loss():
    """§ 7.2 W6's "no auto-retry is offered" over the ledger: the attempt-1→2
    scheduling the engine did BEFORE the loss is § 7.1 C5b's expected auto-retry (the
    caller passes the loss-class-only count in `sched` and the loss's own number as
    `base`); what must never exist is a retry armed FOR the loss."""
    assert w6_auto_retry_class_verdicts("0", ROWS_LOST, 2)[0][1] is True
    assert w6_auto_retry_class_verdicts("1", ROWS_LOST, 2)[0][1] is False, \
        "a workspace_lost retry_scheduled row IS an offered auto-retry"
    assert w6_auto_retry_class_verdicts("0", ROWS_LOST, 1)[0][1] is False, \
        "base=1 reads attempt 2 as a retry above the loss"
    above = ROWS_LOST + [{"attempt_number": "3", "status": "queued",
                          "error_class": "-", "detail": "-", "worker": "-"}]
    bad = w6_auto_retry_class_verdicts("0", above, 2)[0]
    assert bad[1] is False and "3" in bad[2], bad
    assert w6_auto_retry_class_verdicts(None, ROWS_LOST, 2)[0][1] is None, \
        "the journal did not answer: GAP"
    assert w6_auto_retry_class_verdicts(None, above, 2)[0][1] is False, \
        "…but a queued attempt above the loss is an auto-retry whoever armed it"


def test_w6_classification_failure_is_a_fail_that_names_the_ledger():
    """AttemptDetail.tsx draws the copy, the chip AND the withheld retry control from
    one field (attempts.error_class). A refusal the product classed 'infra' is the
    product not classifying the loss: FAIL, with the ledger quoted — never a GAP and
    never a wording line that blames the UI for a classification it was never given."""
    none = w6_loss_classification_verdicts(None, None, "")
    assert len(none) == 1 and none[0][1] is None, none
    infra = w6_loss_classification_verdicts(dict(ROW_LOST, error_class="infra"),
                                            None, "failed|infra")
    assert infra[0][1] is False and "'infra'" in infra[0][2], infra[0]
    assert "AttemptDetail.tsx" in infra[0][2], "the FAIL has to say WHY the UI is innocent"
    assert infra[1][1] is False, "no workspace.recovery_lost row is its own FAIL"
    assert infra[2][1] is True, "the infra detail still carries the words — graded apart"
    good = w6_loss_classification_verdicts(ROW_LOST, {"reason": "different_worker"},
                                           "interrupted|workspace_lost")
    assert [v[1] for v in good] == [True, True, True], good
    quiet = w6_loss_classification_verdicts(dict(ROW_LOST, detail="workspace gone"),
                                            {"reason": "different_worker"}, "")
    assert [v[1] for v in quiet] == [True, True, False], quiet
    assert W6_LOSS_COPY[0] in quiet[2][0], "the FAIL's label names the copy it looked for"


# live17/W6.out's REAL refusal — the worker's journal prose, which inflects the
# contract's sentence ("its prior edits ARE lost, rerun required") because it is
# machine prose. The exact words § 7.2 W6 quotes are the OPERATOR's sentence, drawn
# by AttemptDetail.tsx from error_class and graded on the page by w6_loss_copy_verdict;
# this arm's job is that the refusal tells the same story and never a resume.
LIVE17_DETAIL = ("workspace.recovery_lost/volume_changed: this run's workspace is not on a "
                 "volume this worker can serve; its prior edits are lost, rerun required "
                 "(ADR-0023 § 7 — never retried automatically): postgres: run workspace volume")


def test_w6_refusal_wording_arms_separate_the_journal_from_the_operators_sentence():
    """The ledger arm grades the STORY, the page arm grades the WORDS — and neither one
    is allowed to quietly stand in for the other."""
    v = w6_loss_classification_verdicts(dict(ROW_LOST, detail=LIVE17_DETAIL),
                                       {"reason": "volume_changed"},
                                       "failed|node_execution_failed:/build_until_verified")
    assert [x[1] for x in v] == [True, True, True], v
    assert "w6_loss_copy_verdict" in v[2][2], "the FAIL/GAP text says where the exact words live"
    # a refusal that hides the loss or promises the work carried on is still a FAIL
    hidden = w6_loss_classification_verdicts(dict(ROW_LOST, detail="attempt failed"),
                                            {"reason": "volume_changed"}, "")[2]
    assert hidden[1] is False and "machine sentence" in hidden[2], hidden
    lied = w6_loss_classification_verdicts(
        dict(ROW_LOST, detail="workspace resumed from the mirror, no data lost, rerun "
                              "required"), {"reason": "volume_changed"}, "")[2]
    assert lied[1] is False and any(w in lied[2] for w in W6_REFUSAL_FORBIDDEN), lied
    # and the page arm still demands the contract's exact sentence: the paraphrase above
    # is NOT enough to pass it.
    page = w6_loss_copy_verdict(LIVE17_DETAIL)
    assert page[1] is False and "missing" in page[2], page


def test_w6_retry_offer_kind_reads_a_promise_not_the_word_retry():
    assert w6_retry_offer_kind('Retry ### Result "Re-runs 7 nodes: /plan"') == "manual"
    assert w6_retry_offer_kind("Retry — no automatic retry is offered") == "manual" or \
        w6_retry_offer_kind("Retry — no automatic retry is offered") == "", \
        "the honest refusal is never an offer"
    assert w6_retry_offer_kind("Retry · this will retry itself") == "auto"
    assert w6_retry_offer_kind("Retry · next attempt scheduled 2026-10-16 11:02:15") == "auto"
    assert w6_retry_offer_kind("Pause") == ""


def test_w6_loss_attempt_row_only_reads_a_refusal_as_a_refusal():
    assert w6_loss_attempt_row(ROWS_LOST)["attempt_number"] == "2"
    assert w6_loss_attempt_row(ROWS_LOST, "2")["attempt_number"] == "2"
    assert w6_loss_attempt_row(ROWS_LOST, "1")["attempt_number"] == "2", \
        "the named row must be a REFUSAL: attempt 1 is the interruption, not the loss"
    assert w6_loss_attempt_row(ROWS_1) is None and w6_loss_attempt_row([]) is None
    two = ROWS_1 + [{"attempt_number": "2", "status": "failed", "error_class": "timeout",
                     "detail": "-", "worker": "worker-a"}, ROW_LOST]
    assert w6_loss_attempt_row(two, "2")["error_class"] == W6_ERROR_CLASS, \
        "C5h's exhausted budget leaves earlier failures on the same node"


def test_w6_retry_reads_answer_or_none_never_a_fake_zero():
    """w6_retry_scheduled_total counts EVERY retry_scheduled row of the run (§ 7.1
    C5b's expected attempt-1→2 arm), apart from the loss-class count in
    w6_auto_retried; a ledger that will not answer gives None so the verdict GAPs."""
    import contextlib
    import io

    import e2e_m4_exit as m
    seen, orig = [], {}

    def drive(sql_answer):
        def fake_psql(sql):
            seen.append(sql)
            if isinstance(sql_answer, Exception):
                raise sql_answer
            return sql_answer
        for name, fn in (("psql", fake_psql),):
            orig.setdefault(name, getattr(m, name))
            setattr(m, name, fn)
        try:
            with contextlib.redirect_stdout(io.StringIO()):
                return w6_retry_scheduled_total("r-1")
        finally:
            for name, fn in orig.items():
                setattr(m, name, fn)

    assert drive("2") == 2
    assert drive("") is None, "an empty answer is NOT a zero the leg can PASS on"
    assert drive("x") is None
    assert drive(RuntimeError("psql failed")) is None
    joined = " AND ".join(seen[-1].split())
    assert "node.attempt.retry_scheduled" in joined and "error_class" not in joined, \
        "the TOTAL read must not filter on the class — w6_auto_retried is the classed one"


def test_w6_loss_facts_reads_every_fact_the_verdicts_consume():
    """One shape whatever produced the subject (C6e's ledger row or this pass's kill):
    the attempt rows, BOTH retry counts, the recovery event and the run row. It reads;
    it decides nothing — and an unreadable ledger stays None, never a zero."""
    import contextlib
    import io

    import e2e_m4_exit as m
    orig = {}

    def fake_psql(sql):
        s = " ".join(sql.split())
        if "retry_scheduled" in s:
            return "0" if "error_class" in s else "2"   # pre-loss scheduling only
        if "FROM runs" in s:
            return "interrupted|workspace_lost"
        raise AssertionError("unexpected psql: " + s[:120])

    def patch(name, fn):
        orig.setdefault(name, getattr(m, name))
        setattr(m, name, fn)

    patch("psql", fake_psql)
    patch("c6_attempts_of_key", lambda run_id, key: ROWS_LOST)
    patch("c6_recovery_event", lambda project_id, run_id: {"reason": "different_worker"})
    try:
        with contextlib.redirect_stdout(io.StringIO()):
            out = w6_loss_facts("p-1", {"run_id": "r-1", "key": m.C_LIVE_TARGET_KEY})
    finally:
        for name, fn in orig.items():
            setattr(m, name, fn)
    assert out["rows"] == ROWS_LOST and out["sched_total"] == 2 \
        and out["sched_loss"] == 0 and out["run_row"] == "interrupted|workspace_lost", out
    assert out["event"] == {"reason": "different_worker"}
    verdicts = (w6_who_armed_the_retry(out["sched_total"], out["rows"], C6_LOSS_WORKER)
                + w6_loss_classification_verdicts(w6_loss_attempt_row(out["rows"], "2"),
                                                  out["event"], out["run_row"])
                + w6_auto_retry_class_verdicts(out["sched_loss"], out["rows"], 2))
    assert all(ok is True for _l, ok, _d in verdicts), \
        [(l, ok, d) for l, ok, d in verdicts if ok is not True]
    # an unreadable ledger is carried as None and GAPs, it never reads as a clean zero
    orig2 = dict(orig)

    def dead_psql(sql):
        raise RuntimeError("psql failed")

    patch("psql", dead_psql)
    patch("c6_row", lambda sql, what: "")
    try:
        with contextlib.redirect_stdout(io.StringIO()):
            gap_out = w6_loss_facts("p-1", {"run_id": "r-1", "key": "k"})
    finally:
        for name, fn in orig2.items():
            setattr(m, name, fn)
    assert gap_out["sched_total"] is None and gap_out["sched_loss"] is None
    assert w6_auto_retry_class_verdicts(gap_out["sched_loss"], [], 2)[0][1] is None


def test_w6_wires_the_engine_retry_and_never_posts_its_own():
    """The sequencing fix a06bd6a made to C5e/C6, pinned for W6: the leg must NOT
    POST /runs/{id}/retry (that 409 is the engine mid-retry, not a product refusal),
    it must flip the affinity and READ attempt 2, and w6() must grade the ledger
    verdicts BEFORE the page wording that depends on them."""
    import ast

    import e2e_m4_exit as m
    here = os.path.dirname(os.path.abspath(__file__))
    src = open(os.path.join(here, "e2e_m4_exit.py"), encoding="utf-8").read()
    tr = ast.parse(src)
    fns = {n.name: n for n in tr.body if isinstance(n, ast.FunctionDef)}
    prod = ast.get_source_segment(src, fns["w6_produce_loss"])
    posted = [ast.unparse(c) for c in ast.walk(fns["w6_produce_loss"])
              if isinstance(c, ast.Call) and isinstance(c.func, ast.Attribute)
              and c.func.attr == "post"
              and "/retry" in " ".join(ast.unparse(a) for a in c.args)]
    assert not posted, f"the loss leg POSTS a retry it does not own: {posted}"
    for needle in ("W6_RETRY_WAIT_S", "c6_attempts_of_key", "w6_retry_scheduled_total",
                   "C6_LOSS_WORKER", "w_kill_worker_mid_node"):
        assert needle in prod, f"w6_produce_loss lost {needle!r}"
    assert "restart=False" in prod, "the owning worker stays drained or it reclaims its " \
                                    "own volume and nothing is lost"
    leg = ast.get_source_segment(src, fns["w6"])
    for needle in ("w6_loss_facts", "w6_who_armed_the_retry",
                   "w6_loss_classification_verdicts", "w6_auto_retry_class_verdicts",
                   "w6_loss_attempt_row"):
        assert needle in leg, f"w6() no longer calls {needle} — the helper is dead code"
    assert leg.index("w6_loss_classification_verdicts") < leg.index("w6_loss_copy_verdict"), \
        "the classification is graded before the copy that cannot render without it"
    assert m.W6_RETRY_WAIT_S <= 240, "the leg has to end well inside the 25-minute budget"


if __name__ == "__main__":
    for fn in (test_snapshot_nodes, test_input_expectations, test_counter_verdicts,
               test_approval_verdicts, test_w3_gate_detail_verdict, test_w3_decide_verdict,
               test_snapshot_spill_guard, test_w4_pinned_and_notice, test_w8_panel_verdicts,
               test_w9_outsider_verdicts, test_w9_outsider_observer_arm,
               test_w2_live_and_order_verdicts, test_w2_turn_gap_and_no_gap,
               test_w2_iteration_verdicts, test_w10_resume_cursor_is_read_from_the_browser_log,
               test_w10_continuity_across_the_roll, test_w10_new_types_and_foreign_events,
               test_w11_short_id_is_the_uuid_tail_the_tree_prints, test_w11_tree_verdicts,
               test_w11_attempt_list_verdicts, test_w11_internals_stay_out_of_the_dom,
               test_frames_are_rows_not_string_occurrences,
               test_gate_release_verdict_names_the_twin_speed_instead_of_blaming_the_ui,
               test_w11_opens_a_node_whose_attempt_list_has_rows,
               test_w5_wording_and_forbidden_scan,
               test_w5_kill_proof_console_and_spinner,
               test_w6_loss_copy_chip_and_retry_control,
               test_w_pick_container_only_this_projects_worker,
               test_w6_who_armed_the_retry_reads_the_ledger_not_a_post,
               test_w6_auto_retry_class_verdicts_sees_the_engine_pre_loss_but_not_post_loss,
               test_w6_classification_failure_is_a_fail_that_names_the_ledger,
               test_w6_loss_attempt_row_only_reads_a_refusal_as_a_refusal,
               test_w6_retry_reads_answer_or_none_never_a_fake_zero,
               test_w6_loss_facts_reads_every_fact_the_verdicts_consume,
               test_w6_wires_the_engine_retry_and_never_posts_its_own,
               test_w5_w6_aim_their_kill_at_the_held_post_gate_attempt,
               test_w11_reads_the_tree_route_its_own_shape,
               test_w11_a_key_read_mid_fanout_is_the_race_that_false_failed,
               test_w11_grades_the_dom_against_a_key_read_at_the_same_moment,
               test_w11_accepts_the_status_either_tree_read_saw,
               test_w11_still_fails_a_row_that_names_no_child_of_this_run,
               test_w11_waits_for_the_whole_fanout_before_reading_its_key,
               test_w11_fanout_wait_decides_the_approval_gate_it_waits_behind,
               test_w11_leg_rereads_the_tree_after_its_snapshot,
               test_c11_report_honesty_tolerates_a_labelled_true_row,
               test_http_connection_blip_retry):
        print(f"\n{fn.__name__}")
        fn()
    bad = globals().get("BAD", 0)
    print(f"\n{fn.__name__ if False else ''}{'FAILURES' if bad else 'ALL LOGIC TESTS PASS'}"
          f"{'' if bad else ''} bad={bad}")
    sys.exit(1 if bad else 0)
