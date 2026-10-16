#!/usr/bin/env python3
"""test_c9_logic.py — offline unit proof for e2e_m4_exit.py's C9 pure logic.

Runs WITHOUT a stack (stdlib unittest only): the "the gate holds nothing" verdict
algebra, the durability-across-a-restart rule (including the GAP when the lab
restarted nothing), the refusal-is-not-a-decision rule for C9b/C9c, THE central
one — the CAS exactly-once verdict computed from two canned decide responses plus
the gate's ledger row (PASS / FAIL / GAP) — the rejection-is-a-business-outcome
rule and the deadline-arming rule. A green here means the VERDICT ALGEBRA is
right; it never substitutes for C9's live gates against a running control plane
(12-test-strategy.md: authorization at decision time is only proven by really
removing a maintainer and really POSTing /decide).

usage: python3 e2e/m4/test_c9_logic.py [-v]
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import e2e_m4_exit as m  # noqa: E402 — importing the driver is the point

AID = "01987a82-3333-7000-8000-abcdef012345"
RUN = "01987a11-1111-7000-8000-abcdef012345"
BOB = "01987a63-3333-7000-8000-abcdef012345"


def snap(state="pending", version="1", decision="-", decided_by="-", node="waiting",
         outcome="-", error="-", attempts="0", run="waiting_human"):
    return dict(zip(m.C9_SNAP_COLS, [state, version, decision, decided_by, node, outcome,
                                     error, attempts, run]))


def resp(who="bob", status=403, ctype="application/problem+json", body=None):
    return {"who": who, "status": status, "ctype": ctype,
            "body": body if body is not None else {
                "type": "https://communication.dev/errors/approval-denied",
                "detail": "The decision was refused (not_a_designated_approver); the gate "
                          "keeps waiting — a refusal is not a decision."}}


def conflict(who="dan", decision="approved", version=2, by=BOB):
    return {"who": who, "status": 409, "ctype": "application/problem+json",
            "body": {"type": "https://communication.dev/errors/approval-already-decided",
                     "approval_id": AID,
                     "approval": {"state": "decided", "decision": decision,
                                  "decided_by": by, "version": version}}}


def ok_of(verdicts, needle):
    hits = [ok for label, ok, _ in verdicts if needle in label]
    assert hits, f"no verdict matching {needle!r} in {[l for l, _, _ in verdicts]}"
    return hits[0]


def detail_of(verdicts, needle):
    return [d for label, _, d in verdicts if needle in label][0]


class SnapshotTest(unittest.TestCase):
    def test_nine_column_gate_row_parses(self):
        s = m.c9_gate_snapshot("pending|1|-|-|waiting|-|-|0|waiting_human")
        self.assertEqual(s["state"], "pending")
        self.assertEqual(s["node_status"], "waiting")
        self.assertEqual(s["attempts"], "0")
        self.assertEqual(s["run_status"], "waiting_human")

    def test_ragged_and_empty_lines_are_dropped_not_verdicted(self):
        self.assertEqual(m.c9_gate_snapshot("NOTICE: something\n\npending|1|-|-|x|y|z|0|w\n"),
                         m.c9_gate_snapshot("pending|1|-|-|x|y|z|0|w"))
        self.assertEqual(m.c9_gate_snapshot(""), {})
        self.assertEqual(m.c9_gate_snapshot("pending|1"), {})

    def test_manifest_users_keeps_only_real_ids(self):
        self.assertEqual(m.c9_manifest_users({"users": {"alice": " u1 ", "bob": None,
                                                        "carol": "", "dan": "u4"}}),
                         {"alice": "u1", "dan": "u4"})
        self.assertEqual(m.c9_manifest_users({}), {})
        self.assertEqual(m.c9_manifest_users(None), {})
        self.assertEqual(m.c9_manifest_users({"users": []}), {})


class HoldsNothingTest(unittest.TestCase):
    SCHED = {"waiting_approvals": 1, "workers": [{"name": "worker-a", "active_attempts": 0},
                                                 {"name": "worker-b", "active_attempts": 0}]}

    def test_a_gate_holding_nothing_passes(self):
        v = m.c9_holds_nothing_verdicts(snap(), "0", "0", self.SCHED)
        self.assertTrue(all(ok for _, ok, _ in v), v)

    def test_an_attempt_behind_the_gate_fails(self):
        v = m.c9_holds_nothing_verdicts(snap(attempts="1"), "0", "0", self.SCHED)
        self.assertFalse(ok_of(v, "ZERO attempts"))

    def test_a_leased_attempt_of_the_run_fails_the_no_lease_arm(self):
        v = m.c9_holds_nothing_verdicts(snap(), "1", "1", self.SCHED)
        self.assertFalse(ok_of(v, "no leased/running attempt"))
        self.assertFalse(ok_of(v, "active_attempts includes the gated run"))

    def test_scheduler_counters_that_disagree_with_the_ledger_fail(self):
        sched = {"waiting_approvals": 1, "workers": [{"name": "worker-a", "active_attempts": 3}]}
        v = m.c9_holds_nothing_verdicts(snap(), "0", "0", sched)
        self.assertFalse(ok_of(v, "active_attempts includes the gated run"))

    def test_no_scheduler_body_gaps_the_ops_arms(self):
        v = m.c9_holds_nothing_verdicts(snap(), "0", "0", None)
        self.assertIsNone(ok_of(v, "GET /api/v1/system/scheduler answers"))

    def test_no_gate_row_gaps(self):
        v = m.c9_holds_nothing_verdicts({}, "0", "0", self.SCHED)
        self.assertIsNone(ok_of(v, "ledger row is readable"))


class DurableTest(unittest.TestCase):
    def test_the_same_row_across_a_restart_passes(self):
        b, a = snap(), snap()
        self.assertTrue(all(ok for _, ok, _ in m.c9_durable_verdicts(b, a, "worker-a")))

    def test_a_version_that_moved_over_the_restart_fails(self):
        v = m.c9_durable_verdicts(snap(), snap(version="2"), "worker-a")
        self.assertFalse(ok_of(v, "survives the restart"))
        self.assertFalse(ok_of(v, "SAME CAS version"))

    def test_a_restart_that_ended_the_wait_fails(self):
        v = m.c9_durable_verdicts(snap(), snap(state="decided", run="running"), "worker-a")
        self.assertFalse(ok_of(v, "survives the restart"))
        self.assertFalse(ok_of(v, "still waiting_human"))

    def test_no_restart_is_a_gap_never_a_pass(self):
        v = m.c9_durable_verdicts(snap(), snap(), None)
        self.assertIsNone(ok_of(v, "survives the restart"))
        self.assertIn("never inferred", detail_of(v, "survives the restart"))

    def test_a_missing_side_gaps(self):
        self.assertIsNone(ok_of(m.c9_durable_verdicts(snap(), {}, "worker-a"),
                               "survives the restart"))


class DenialTest(unittest.TestCase):
    def test_a_refusal_that_moves_nothing_passes(self):
        v = m.c9_denial_verdicts("C9b bob (contributor)", "not_a_designated_approver",
                                 resp(), ["not_a_designated_approver"], snap(), 1)
        self.assertTrue(all(ok for _, ok, _ in v), v)

    def test_a_404_from_the_visibility_predicate_fails(self):
        v = m.c9_denial_verdicts("C9c alice", "approver_lost_access",
                                 resp(status=404, ctype="application/problem+json"),
                                 ["approver_lost_access"], snap(), 1)
        self.assertFalse(ok_of(v, "403/409 problem+json"))
        self.assertIn("observed 404", detail_of(v, "403/409 problem+json"))

    def test_the_wrong_denial_reason_fails(self):
        v = m.c9_denial_verdicts("C9c alice", "approver_lost_access", resp(),
                                 ["not_a_designated_approver"], snap(), 1)
        self.assertFalse(ok_of(v, "approver_lost_access"))

    def test_a_refusal_that_decided_the_gate_fails(self):
        v = m.c9_denial_verdicts("C9c alice", "approver_lost_access", resp(),
                                 ["approver_lost_access"],
                                 snap(state="decided", decision="approved", decided_by=BOB,
                                      version="2", node="succeeded", run="running"), 1)
        self.assertFalse(ok_of(v, "STILL pending"))
        self.assertFalse(ok_of(v, "CAS version is UNMOVED"))
        self.assertFalse(ok_of(v, "no decision or decider"))
        self.assertFalse(ok_of(v, "still waiting_human"))

    def test_a_200_json_answer_fails_the_problem_json_arm(self):
        v = m.c9_denial_verdicts("C9b bob", "not_a_designated_approver",
                                 resp(status=200, ctype="application/json"), [], snap(), 1)
        self.assertFalse(ok_of(v, "403/409 problem+json"))
        self.assertFalse(ok_of(v, "is journaled"))

    def test_no_response_gaps(self):
        v = m.c9_denial_verdicts("C9b bob", "not_a_designated_approver", None, [], snap(), 1)
        self.assertIsNone(ok_of(v, "the decide call answered"))

    def test_no_ledger_row_gaps_the_state_arms_only(self):
        v = m.c9_denial_verdicts("C9b bob", "not_a_designated_approver", resp(),
                                 ["not_a_designated_approver"], {}, 1)
        self.assertIsNone(ok_of(v, "row is readable after the refusal"))
        self.assertTrue(ok_of(v, "is journaled"))


class CasTest(unittest.TestCase):
    LEDGER = snap(state="decided", version="2", decision="approved", decided_by=BOB,
                  node="succeeded", run="running")

    def test_one_200_one_409_carrying_the_winner_passes(self):
        v = m.c9_cas_verdicts([resp("carol", 200), conflict()], self.LEDGER)
        self.assertTrue(all(ok for _, ok, _ in v), v)

    def test_two_200s_fail_exactly_once(self):
        v = m.c9_cas_verdicts([resp("carol", 200), resp("dan", 200)], self.LEDGER)
        self.assertFalse(ok_of(v, "EXACTLY one POST returns 200"))

    def test_two_409s_fail_exactly_once_too(self):
        v = m.c9_cas_verdicts([conflict("carol"), conflict("dan")], self.LEDGER)
        self.assertFalse(ok_of(v, "EXACTLY one POST returns 200"))

    def test_a_loser_answered_403_is_not_the_cas_arm(self):
        v = m.c9_cas_verdicts([resp("carol", 200), resp("dan", 403)], self.LEDGER)
        self.assertFalse(ok_of(v, "409 approval_already_decided"))

    def test_a_409_that_does_not_carry_the_winner_fails(self):
        loser = conflict()
        loser["body"]["approval"]["decision"] = "rejected"
        loser["body"]["approval"]["version"] = 7
        v = m.c9_cas_verdicts([resp("carol", 200), loser], self.LEDGER)
        self.assertFalse(ok_of(v, "carries the WINNER"))

    def test_a_gate_stuck_at_version_one_fails_the_cas_version_arm(self):
        v = m.c9_cas_verdicts([resp("carol", 200), conflict()],
                              self.LEDGER | {"version": "1"})
        self.assertFalse(ok_of(v, "version=2"))

    def test_a_decided_row_with_no_decider_fails(self):
        v = m.c9_cas_verdicts([resp("carol", 200), conflict()], self.LEDGER | {"decided_by": "-"})
        self.assertFalse(ok_of(v, "version=2"))

    def test_one_decider_answering_gaps_the_race(self):
        v = m.c9_cas_verdicts([resp("carol", 200), None], self.LEDGER)
        self.assertIsNone(ok_of(v, "two decide responses came back"))
        self.assertIsNone(ok_of(v, "409 approval_already_decided"))

    def test_no_ledger_row_gaps_the_persistence_arms(self):
        v = m.c9_cas_verdicts([resp("carol", 200), conflict()], {})
        self.assertIsNone(ok_of(v, "carries the WINNER"))
        self.assertIsNone(ok_of(v, "ONE row, ONE decider, version=2"))


class RejectionTest(unittest.TestCase):
    GATE = snap(state="decided", version="2", decision="rejected", decided_by=BOB,
                node="succeeded", outcome="rejected")
    SKIPPED = [{"key": "/emit_items", "reason": "condition_default"},
               {"key": "/fan_out", "reason": "condition_default"}]

    def test_a_business_rejection_passes(self):
        v = m.c9_rejection_verdicts(self.GATE, "completed", "-", self.SKIPPED,
                                    ["condition_default", "condition_default"])
        self.assertTrue(all(ok for _, ok, _ in v), v)

    def test_a_rejection_written_as_an_execution_failure_fails(self):
        v = m.c9_rejection_verdicts(self.GATE | {"node_status": "failed", "node_outcome": "-",
                                                "node_error_class": "approval_expired"},
                                    "failed", "node_execution_failed:/approve",
                                    self.SKIPPED, ["condition_default"])
        self.assertFalse(ok_of(v, "succeeded with outcome='rejected'"))
        self.assertFalse(ok_of(v, "no execution error_class"))

    def test_a_dependant_skipped_for_another_reason_fails(self):
        v = m.c9_rejection_verdicts(self.GATE, "completed", "-",
                                    [{"key": "/emit_items", "reason": "dependency_skipped"}],
                                    ["dependency_skipped"])
        self.assertFalse(ok_of(v, "condition_default"))

    def test_no_skipped_rows_fails_the_graph_arm(self):
        self.assertFalse(ok_of(m.c9_rejection_verdicts(self.GATE, "completed", "-", [], []),
                              "condition_default"))

    def test_a_run_failed_by_the_approval_clock_fails(self):
        v = m.c9_rejection_verdicts(self.GATE, "failed", "approval_expired", self.SKIPPED,
                                    ["condition_default"])
        self.assertFalse(ok_of(v, "terminates on the graph's terms"))

    def test_a_run_that_never_terminated_fails(self):
        self.assertFalse(ok_of(m.c9_rejection_verdicts(self.GATE, "running", "-",
                                                      self.SKIPPED, ["condition_default"]),
                              "terminates on the graph's terms"))

    def test_no_gate_row_gaps(self):
        self.assertIsNone(ok_of(m.c9_rejection_verdicts({}, "completed", "-", [], []),
                               "node row is readable"))


class DeadlineTest(unittest.TestCase):
    def test_an_armed_future_deadline_passes(self):
        v = m.c9_deadline_verdicts(snap(), "fail", "86399.42", "f")
        self.assertTrue(all(ok for _, ok, _ in v), v)

    def test_a_deadline_already_past_is_not_armed(self):
        self.assertFalse(ok_of(m.c9_deadline_verdicts(snap(), "fail", "-12.0", "f"), "ARMED"))

    def test_an_unparseable_deadline_fails_rather_than_reading_as_zero(self):
        self.assertFalse(ok_of(m.c9_deadline_verdicts(snap(), "fail", "", "f"), "ARMED"))

    def test_an_unknown_on_timeout_fails(self):
        self.assertFalse(ok_of(m.c9_deadline_verdicts(snap(), "ping", "86399", "f"), "ARMED"))

    def test_an_attempt_behind_the_gate_fails_the_holds_nothing_half(self):
        self.assertFalse(ok_of(m.c9_deadline_verdicts(snap(attempts="1"), "fail", "86399", "f"),
                              "ARMED"))

    def test_no_row_gaps(self):
        self.assertIsNone(ok_of(m.c9_deadline_verdicts({}, "fail", "86399", "f"),
                               "deadline is armed"))


if __name__ == "__main__":
    unittest.main(verbosity=2 if "-v" in sys.argv else 1)
