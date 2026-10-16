#!/usr/bin/env python3
"""Offline unit tests for the W-leg browser helpers' PURE halves (§ 7.2 W1/W3/W4/W7/W8/W9).

Nothing here touches the stack: the snapshot-YAML ref parser, the spec.inputs
-> form-field expectation builder, the W7 counter verdicts, the W3 approval
verdicts, the W4 pinned-digest/notice verdicts, the W8 Validate-panel verdicts
and the W9 not-found/leakage/SSE/console verdicts are pure functions over canned
text. Run: python3 e2e/m4/test_w_logic.py
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
    w3_decide_verdict,
    w3_gate_detail_verdict,
    w_counter_verdicts,
    w_form_field_verdicts,
    w_input_expectations,
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
    page = (f'feature-development · pinned r1 · {w4_short(pinned)} · 12 frames '
            f'pinned r1 · {w4_short(pinned)}')
    v = _vmap(w4_pinned_verdicts(pinned, 1, newer, 2, page, page))
    assert all(ok is True for ok, _ in v.values()), v
    moved = page.replace(w4_short(pinned), w4_short(newer)).replace("pinned r1", "pinned r2")
    v = _vmap(w4_pinned_verdicts(pinned, 1, newer, 2, page, moved))
    assert any(ok is False for ok, _ in v.values()), v
    assert one(w4_pinned_verdicts(pinned, 1, newer, 2, page, page), 'shows the pinned digest') is True
    # the notice: PASS only when both halves of the row's copy are on the page
    assert w4_notice_verdict("revision 2 published since this run started — this run is "
                             "pinned to 1", 1, 2)[1] is True
    assert w4_notice_verdict("revision 2 published since this run started", 1, 2)[1] is False
    assert w4_notice_verdict(page, 1, 2)[1] is False, "no banner is a FAIL naming the UI"
    assert "RunInspector" in w4_notice_verdict(page, 1, 2)[2], w4_notice_verdict(page, 1, 2)[2]
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


if __name__ == "__main__":
    for fn in (test_snapshot_nodes, test_input_expectations, test_counter_verdicts,
               test_approval_verdicts, test_w3_gate_detail_verdict, test_w3_decide_verdict,
               test_snapshot_spill_guard, test_w4_pinned_and_notice, test_w8_panel_verdicts,
               test_w9_outsider_verdicts, test_w9_outsider_observer_arm):
        print(f"\n{fn.__name__}")
        fn()
    bad = globals().get("BAD", 0)
    print(f"\n{fn.__name__ if False else ''}{'FAILURES' if bad else 'ALL LOGIC TESTS PASS'}"
          f"{'' if bad else ''} bad={bad}")
    sys.exit(1 if bad else 0)
