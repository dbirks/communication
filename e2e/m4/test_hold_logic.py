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
        # c2 holds too: C2a reads the live process environment DURING the attempt
        # (docs/m4-contract.md § 7.1), which a <1s printf step never allows.
        for fn, poster in (("c2", "post_c1_run"), ("c4", "post_c1_run"),
                           ("c5", "post_c1_run"), ("c6", "c7_post_run")):
            self.assertTrue(posts_with_hold(fn, poster),
                            f"{fn} must post {poster} with hold_seconds (live6: its "
                            "fault landed on an attempt that had already succeeded)")

    def test_the_hold_is_the_agreed_45_seconds(self):
        self.assertEqual(m.C_FAULT_HOLD_SECONDS, 45)
        self.assertGreaterEqual(m.C_FAULT_HOLD_SECONDS, 30 + 15,
                                "lease 30s + reconciler tick 15s (§ 7.1 C4a)")

    def test_the_timing_and_concurrency_legs_keep_the_default_zero(self):
        for fn in ("c1", "c7", "c8", "c9", "c10", "c11", "c12", "c13", "c14",
                   "w2", "w10", "w11"):
            for c in calls_in(fn):
                self.assertNotIn(
                    "hold_seconds", [k.arg for k in c.keywords],
                    f"{fn} posts the FAULT hold: C1's key/timing comparison, C7's "
                    "exhaustion and C8's in-flight concurrency are all graded against "
                    "unhurried steps (W2's sampling hold is its own W2_HOLD_SECONDS)")

    def test_w5_and_w6_run_the_same_fault_sequence_so_they_hold_too(self):
        src = open(DRIVER, encoding="utf-8").read()
        for fn in ("w5", "w6_produce_loss"):
            body = ast.get_source_segment(src, next(
                n for n in tree().body if isinstance(n, ast.FunctionDef) and n.name == fn))
            self.assertIn("with_hold(mf(twin,", body,
                          f"{fn} must post its twin run with the hold")
        self.assertNotIn("with_hold", ast.get_source_segment(src, next(
            n for n in tree().body if isinstance(n, ast.FunctionDef) and n.name == "w10")),
            "w10 is not a fault leg")

    def test_w2_holds_short_just_long_enough_to_be_sampled(self):
        """live8/W2.out: `no attempt was sampled MID-LEASE … the twin's process.exec
        attempts finish faster than the poll's 2s interval`. W2 watches a page, it
        kills nothing, so its hold is its OWN (W2_HOLD_SECONDS): long enough for the
        leg's 2s poll and one DOM sample to land inside the lease, short enough that
        none of the leg's timings, ordering or iteration arms move."""
        src = open(DRIVER, encoding="utf-8").read()
        body = ast.get_source_segment(src, next(
            n for n in tree().body if isinstance(n, ast.FunctionDef) and n.name == "w2"))
        self.assertIn('with_hold(mf(twin, "inputs", default={}), W2_HOLD_SECONDS)', body,
                      "W2 must post its twin run through the same hold helper")
        self.assertNotIn("hold_seconds=", body,
                         "W2's is a sampling hold, not a fault hold: it never holds the "
                         "45s a freeze/kill window needs")
        self.assertGreater(m.W2_HOLD_SECONDS, 2, "longer than the leg's own 2s poll")
        self.assertLess(m.W2_HOLD_SECONDS, m.C_FAULT_HOLD_SECONDS,
                        "and shorter than the fault legs' hold")
        self.assertLessEqual(m.W2_HOLD_SECONDS, 600, "within the input's schema maximum")


class HoldDiagnosisTest(unittest.TestCase):
    """live8/C5.out GAPped "no attempt … was ever held by a worker" on a run the leg
    had posted hold_seconds=45 for. The report could not tell the three explanations
    apart — the input never reached the run, the mounted fixture script ignores it, or
    the hold is honoured but the target was never reached. These reads do (the legs
    attach to a RUNNING stack with `--ready` and only `--up` regenerates
    .harness/m4-fixtures/bin/m4-exit.sh)."""

    def test_no_hold_posted_needs_no_diagnosis(self):
        self.assertEqual(m.hold_diagnosis(0, 0, "honours"), "")
        self.assertEqual(m.hold_diagnosis(None, None, "stale"), "", "not this leg's problem")

    def test_a_pre_hold_fixture_script_is_named_as_a_lab_fault(self):
        why = m.hold_diagnosis(45, 0, "stale")
        self.assertIn("LAB FAULT, not a product gap", why)
        self.assertIn("hold_seconds=45 posted", why)
        self.assertIn(m.FIXTURE_SCRIPT, why)
        self.assertIn(m.FIXTURE_REGEN, why, "the diagnosis has to say how to fix the lab")

    def test_an_unreadable_script_says_so_instead_of_guessing(self):
        self.assertIn("could not be read", m.hold_diagnosis(45, 0, "unreadable"))

    def test_a_honoured_script_that_still_ran_fast_indicts_the_splice(self):
        why = m.hold_diagnosis(45, 0, "honours")
        self.assertIn("LAB FAULT", why)
        self.assertIn("never reached the child process", why)

    def test_an_unreadable_ledger_and_a_short_hold_are_both_said_plainly(self):
        self.assertIn("did not read", m.hold_diagnosis(45, None, "honours"))
        self.assertIn("shorter than the 45s", m.hold_diagnosis(45, 20, "honours", 45))
        self.assertEqual(m.hold_diagnosis(45, 45, "honours", 45), "",
                         "a hold that landed and stayed open is not a diagnosis")


class RunInputReadTest(unittest.TestCase):
    """The evidence half of the same fix: what the API VALIDATED, read per run."""

    def test_parses_name_origin_value_rows(self):
        rows = m.parse_run_inputs(
            "acceptance_criteria=default \"Tests pass\"\n"
            "goal=submitted Document and fix add()\n"
            "hold_seconds=default 45\nragged line without an origin\n")
        self.assertEqual([r["name"] for r in rows],
                         ["acceptance_criteria", "goal", "hold_seconds"])
        self.assertEqual(rows[2], {"name": "hold_seconds", "origin": "default",
                                   "value": "45"})

    def test_the_sql_carries_name_origin_and_value(self):
        sql = m.c1_run_inputs_sql("r-1")
        for needle in ("run_inputs", "name", "origin", "value::text", "'r-1'"):
            self.assertIn(needle, sql)

    def test_the_held_window_read_measures_the_lease_columns(self):
        sql = m.held_attempt_window_sql("r-1")
        for needle in ("started_at", "finished_at", "scheduled_at", "worker_id IS NOT NULL",
                       "'r-1'"):
            self.assertIn(needle, sql)

    def test_the_fixture_regeneration_command_is_the_real_one(self):
        self.assertIn("make_fixture_repo.sh", m.FIXTURE_REGEN)
        self.assertEqual(os.path.basename(m.FIXTURE_REGEN.split()[-1]),
                         os.path.basename(FIXTURE),
                         "the diagnosis must point at the generator that exists")

    def test_fixture_hold_state_reads_the_mounted_script_not_an_assumption(self):
        """The GENERATOR honours the hold (test_the_fixture_script_sleeps_on_the_env_…
        above); this is the copy the workers actually mount, which is lab state and can
        be older than the generator — the exact live8/C5.out case."""
        self.assertIn(m.fixture_hold_state("/nonexistent/m4-exit.sh"), ("unreadable",))
        self.assertIn(m.fixture_hold_state(), ("honours", "stale", "unreadable"))

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


class FaultHoldEvidenceTest(unittest.TestCase):
    """The dump a fault leg owes before it GAPs 'nothing was ever held': the reads
    are canned here, the psql and the mounted file are not touched."""

    ROWS = ("acceptance_criteria=default \"Tests pass\"\ngoal=submitted Document and fix "
            "add()\nhold_seconds=default 0\nrepository=submitted app")

    def run_evidence(self, hold_rows, held_s, fixture_state, expected=45):
        shown, orig = [], (m.psql, m.show, m.fixture_hold_state,
                           m.held_attempt_window_s)
        m.psql = lambda sql: hold_rows if "run_inputs" in sql else str(held_s)
        m.show = lambda label, out="": shown.append((label, out))
        m.fixture_hold_state = lambda *a, **k: fixture_state
        m.held_attempt_window_s = lambda run_id: held_s
        try:
            why = m.fault_hold_evidence(None, "run-1", "C5a", expected=expected)
        finally:
            (m.psql, m.show, m.fixture_hold_state,
             m.held_attempt_window_s) = orig
        return why, shown

    def test_an_input_that_never_reached_the_run_is_named_as_such(self):
        why, shown = self.run_evidence(self.ROWS, 0, "stale")
        self.assertIn("posts hold_seconds=45", why)
        self.assertIn("default=0", why, "the ledger's own origin/value is the evidence")
        self.assertIn("never", why)
        self.assertTrue(any("run_inputs" in label for label, _o in shown), shown)

    def test_a_posted_hold_the_steps_ignored_blames_the_mounted_fixture(self):
        why, _shown = self.run_evidence(self.ROWS.replace("default 0", "submitted 45"),
                                        0, "stale")
        self.assertIn("LAB FAULT", why)
        self.assertIn(m.FIXTURE_SCRIPT, why)

    def test_a_leg_that_never_posted_a_hold_says_nothing(self):
        why, _shown = self.run_evidence(self.ROWS.replace("default 0", "default 45"),
                                        45, "honours", expected=0)
        self.assertEqual(why, "", "no expectation, no diagnosis")


class RequireFaultHoldTest(unittest.TestCase):
    """The precondition paid for UP FRONT: a leg that posts hold_seconds against a
    fixture that cannot honour it burns its whole 300s window to report the obvious
    (live8/C5.out, live8/W5.out, live8/W6.out) — so it says so and stops. An
    unreadable fixture is NOT evidence of a lab fault, so the leg runs anyway."""

    def guard(self, state):
        gaps, orig = [], (m.gap, m.fixture_hold_state)
        m.gap = lambda label, why: gaps.append((label, why))
        m.fixture_hold_state = lambda *a, **k: state
        try:
            return m.require_fault_hold("C5a"), gaps
        finally:
            m.gap, m.fixture_hold_state = orig

    def test_a_pre_hold_fixture_stops_the_leg_with_the_command_that_fixes_it(self):
        ok, gaps = self.guard("stale")
        self.assertFalse(ok)
        self.assertEqual(len(gaps), 1, gaps)
        label, why = gaps[0]
        self.assertTrue(label.startswith("C5a "), label)
        self.assertIn(m.FIXTURE_REGEN, why)
        self.assertIn(f"hold_seconds={m.C_FAULT_HOLD_SECONDS}", why)

    def test_a_honouring_or_unreadable_fixture_never_blocks_the_leg(self):
        for state in ("honours", "unreadable"):
            ok, gaps = self.guard(state)
            self.assertTrue(ok, state)
            self.assertEqual(gaps, [], state)

    def test_every_leg_that_posts_a_hold_checks_it_first(self):
        src = open(DRIVER, encoding="utf-8").read()
        for fn in ("c5", "c6", "w5", "w6_produce_loss"):
            body = ast.get_source_segment(src, next(
                n for n in tree().body
                if isinstance(n, ast.FunctionDef) and n.name == fn))
            self.assertIn("require_fault_hold(", body,
                          f"{fn} posts hold_seconds against a fixture it never checked")
        for fn in ("c4", "c1", "c7", "c8", "w2", "w10", "w11"):
            body = ast.get_source_segment(src, next(
                n for n in tree().body
                if isinstance(n, ast.FunctionDef) and n.name == fn))
            self.assertNotIn("require_fault_hold(", body,
                             f"{fn} blocks on a fixture it does not depend on")


if __name__ == "__main__":
    unittest.main(verbosity=2 if "-v" in sys.argv else 1)
