#!/usr/bin/env python3
"""test_hold_logic.py — offline proof of the fault legs' hold_seconds wiring.

live6's evidence: `C4 FAIL=14`, `C5 GAP`, `C6 FAIL=9` — every fault landed on an
attempt that had ALREADY succeeded, because the twin's process.exec steps are
printfs that close in <1s (docs/compatibility/probes/m4/README.md § 7.1 note 5).
Document 2 therefore takes an opt-in run input `hold_seconds` (0-600, default 0)
that m4-exit.sh sleeps BEFORE any work. This file pins the driver half: the hold
is posted by EXACTLY the fault legs (C4/C5/C6 and the W5/W6 rows that rerun those
sequences) and by nobody else — C1 compares key sets and timings across the two
manifest runs, C7 exhausts the until loop and C8 measures real in-flight
concurrency, so all of them must keep the default 0.

A green here means the run bodies and the wait windows are right; it never
substitutes for the live kill/freeze (12-test-strategy.md: a mocked green is not
done).

usage: python3 e2e/m4/test_hold_logic.py [-v]
"""
import ast
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import e2e_m4_exit as m  # noqa: E402 — importing the driver is the point

HERE = os.path.dirname(os.path.abspath(__file__))
DRIVER = os.path.join(HERE, "e2e_m4_exit.py")
PROBE = os.path.abspath(os.path.join(HERE, "..", "..", "docs", "compatibility", "probes",
                                     "m4", "pipeline.yaml"))
FIXTURE = os.path.abspath(os.path.join(HERE, "..", "..", "e2e", "m4",
                                       "make_fixture_repo.sh"))


def tree():
    with open(DRIVER, encoding="utf-8") as fh:
        return ast.parse(fh.read())


def calls_in(fn_name):
    """Every ast.Call inside a module-level def, keyed by function name."""
    for node in tree().body:
        if isinstance(node, ast.FunctionDef) and node.name == fn_name:
            return [c for c in ast.walk(node) if isinstance(c, ast.Call)
                    and isinstance(c.func, ast.Name)]
    raise AssertionError(f"{fn_name} is not a module-level def in {DRIVER}")


def posts_with_hold(fn_name, poster):
    """True when `fn_name` calls `poster(...)` with a hold_seconds keyword argument."""
    return any(c.func.id == poster and any(k.arg == "hold_seconds" for k in c.keywords)
               for c in calls_in(fn_name))


class FakeResp:
    status, text = 201, '{"run_id":"run-1","status":"queued"}'

    def json(self):
        return {"run_id": "run-1", "status": "queued"}


class FakeClient:
    def __init__(self):
        self.body = None

    def post(self, _lb, _path, body):
        self.body = body
        return FakeResp()


FACTS = {"revision_id": "rev-1", "project_id": "p-1",
         "inputs": {"goal": "ship it", "repository": "app"}}


class WithHoldTest(unittest.TestCase):
    def test_hold_is_added_without_touching_the_manifest_inputs(self):
        got = m.with_hold(FACTS["inputs"])
        self.assertEqual(got["hold_seconds"], m.C_FAULT_HOLD_SECONDS)
        self.assertEqual(got["goal"], "ship it")
        self.assertNotIn("hold_seconds", FACTS["inputs"], "the manifest's dict is C1's")

    def test_missing_or_bogus_inputs_degrade_to_the_hold_alone(self):
        self.assertEqual(m.with_hold(None), {"hold_seconds": 45})
        self.assertEqual(m.with_hold("nope", 30), {"hold_seconds": 30})

    def test_hold_seconds_is_an_int_within_the_schema_bounds(self):
        n = m.with_hold({})["hold_seconds"]
        self.assertIsInstance(n, int)
        self.assertLessEqual(0, n)
        self.assertLessEqual(n, 600)                          # pipeline.yaml's maximum


class HoldWindowTest(unittest.TestCase):
    def test_cover_is_steps_times_the_hold_plus_the_lease_window(self):
        self.assertEqual(m.hold_cover(4), 4 * m.C_FAULT_HOLD_SECONDS + m.C_FAULT_LEASE_S)
        self.assertGreaterEqual(m.hold_cover(), 4 * m.C_FAULT_HOLD_SECONDS)

    def test_windows_are_never_shortened_and_always_cover_the_hold(self):
        self.assertEqual(m.hold_window(900), 900)
        self.assertEqual(m.hold_window(600), 600)
        self.assertEqual(m.hold_window(150), m.hold_cover())
        self.assertEqual(m.hold_window(180), m.hold_cover())
        self.assertEqual(m.hold_window(None), m.hold_cover())   # unreadable cap -> cover


class FaultLegRunBodyTest(unittest.TestCase):
    """Which legs post the hold — read off the driver's own call sites."""

    def test_the_fault_legs_post_the_hold(self):
        for fn, poster in (("c4", "post_c1_run"), ("c5", "post_c1_run"),
                           ("c6", "c7_post_run")):
            self.assertTrue(posts_with_hold(fn, poster),
                            f"{fn} must post {poster} with hold_seconds (live6: its "
                            "fault landed on an attempt that had already succeeded)")

    def test_the_hold_is_the_agreed_45_seconds(self):
        self.assertEqual(m.C_FAULT_HOLD_SECONDS, 45)
        self.assertGreaterEqual(m.C_FAULT_HOLD_SECONDS, 30 + 15,
                                "lease 30s + reconciler tick 15s (§ 7.1 C4a)")

    def test_the_timing_and_concurrency_legs_keep_the_default_zero(self):
        for fn in ("c1", "c2", "c7", "c8", "c9", "c10", "c11", "c12", "c13", "c14",
                   "w2", "w10", "w11"):
            for c in calls_in(fn):
                self.assertNotIn(
                    "hold_seconds", [k.arg for k in c.keywords],
                    f"{fn} posts a hold: C1's key/timing comparison, C7's exhaustion and "
                    "C8's in-flight concurrency are all graded against unhurried steps")

    def test_w5_and_w6_run_the_same_fault_sequence_so_they_hold_too(self):
        src = open(DRIVER, encoding="utf-8").read()
        for fn in ("w5", "w6_produce_loss"):
            body = ast.get_source_segment(src, next(
                n for n in tree().body if isinstance(n, ast.FunctionDef) and n.name == fn))
            self.assertIn("with_hold(mf(twin,", body,
                          f"{fn} must post its twin run with the hold")
        for fn in ("w2", "w10"):
            body = ast.get_source_segment(src, next(
                n for n in tree().body if isinstance(n, ast.FunctionDef) and n.name == fn))
            self.assertNotIn("with_hold", body, f"{fn} is not a fault leg")

    def test_post_c1_run_only_holds_when_asked(self):
        for hold, want in ((None, None), (45, 45)):
            client = FakeClient()
            orig, m.check = m.check, lambda *_a, **_k: True
            try:
                m.post_c1_run(client, FACTS, "idem-1", "t", hold_seconds=hold)
            finally:
                m.check = orig
            self.assertEqual(client.body["inputs"].get("hold_seconds"), want)
        self.assertNotIn("hold_seconds", FACTS["inputs"], "the facts stay C1's")


class FixtureAndDocTest(unittest.TestCase):
    """The input the legs post must exist and must be honoured (read, not assumed)."""

    def test_the_twin_declares_hold_seconds_with_default_zero(self):
        doc = open(PROBE, encoding="utf-8").read().split("\n---\n")[1]
        self.assertIn("feature-development-deterministic", doc)
        self.assertIn("hold_seconds:", doc)
        self.assertIn("default: 0", doc.split("hold_seconds:")[1].split("outputs:")[0])
        self.assertEqual(doc.count("M4_HOLD_SECONDS: ${{ string(inputs.hold_seconds) }}"),
                         4, "plan, implement, test and review all hold")

    def test_the_fixture_script_sleeps_on_the_env_before_any_work(self):
        sh = open(FIXTURE, encoding="utf-8").read()
        self.assertIn("M4_HOLD_SECONDS", sh)
        self.assertLess(sh.index("M4_HOLD_SECONDS"), sh.index("sleep") + len(sh),
                        "m4-exit.sh reads the hold it is given")


if __name__ == "__main__":
    unittest.main(verbosity=2 if "-v" in sys.argv else 1)
