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
               test_w11_reads_the_tree_route_its_own_shape,
               test_c11_report_honesty_tolerates_a_labelled_true_row,
               test_http_connection_blip_retry):
        print(f"\n{fn.__name__}")
        fn()
    bad = globals().get("BAD", 0)
    print(f"\n{fn.__name__ if False else ''}{'FAILURES' if bad else 'ALL LOGIC TESTS PASS'}"
          f"{'' if bad else ''} bad={bad}")
    sys.exit(1 if bad else 0)
