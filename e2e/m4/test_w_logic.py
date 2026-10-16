#!/usr/bin/env python3
"""Offline unit tests for the W-leg browser helpers' PURE halves (§ 7.2 W1/W3/W7).

Nothing here touches the stack: the snapshot-YAML ref parser, the spec.inputs
-> form-field expectation builder, the W7 counter verdicts and the W3 approval
verdicts are pure functions over canned text. Run: python3 e2e/m4/test_w_logic.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from e2e_m4_exit import (  # noqa: E402  (import the driver under test)
    w_approval_verdicts,
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


if __name__ == "__main__":
    for fn in (test_snapshot_nodes, test_input_expectations, test_counter_verdicts,
               test_approval_verdicts, test_w3_gate_detail_verdict, test_w3_decide_verdict):
        print(f"\n{fn.__name__}")
        fn()
    bad = globals().get("BAD", 0)
    print(f"\n{fn.__name__ if False else ''}{'FAILURES' if bad else 'ALL LOGIC TESTS PASS'}"
          f"{'' if bad else ''} bad={bad}")
    sys.exit(1 if bad else 0)
