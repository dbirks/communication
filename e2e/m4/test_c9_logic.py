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

    def test_direct_dependant_carries_condition_default_and_transitive_one_the_skip(self):
        # row 14 keeps BOTH reasons: the when-gated node itself is condition_default,
        # everything downstream of a skipped parent is dependency_skipped.
        v = m.c9_rejection_verdicts(
            self.GATE, "completed", "-",
            [{"key": "/emit_items", "reason": "condition_default"},
             {"key": "/fan_out", "reason": "dependency_skipped"}],
            ["condition_default", "dependency_skipped"])
        self.assertTrue(ok_of(v, "condition_default"), v)

    def test_a_failed_dependant_instead_of_a_skipped_one_is_not_credited(self):
        v = m.c9_rejection_verdicts(
            self.GATE, "completed", "-",
            [{"key": "/emit_items", "reason": "condition_default"},
             {"key": "/fan_out", "reason": "case_not_selected"}],
            ["condition_default", "case_not_selected"])
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


class FDocTest(unittest.TestCase):
    """c9f_deadline_doc: the scratch revision must be provably the seed PLUS the
    /approve deadline pair — anything else refuses rather than faking a deadline."""

    def canon(self, dl=86400, ot="fail", gates=1, meta=True, kind="Pipeline"):
        nodes = []
        for i in range(gates):
            nodes.append({"id": f"approve{i}" if gates > 1 else "approve",
                          "kind": "human.approval",
                          "config": {"summary": "go?", "deadlineSeconds": dl,
                                     "onTimeout": ot}})
        doc = {"apiVersion": "communication.dev/v1alpha1", "kind": kind,
               "spec": {"nodes": nodes}}
        if meta:
            doc["metadata"] = {"name": "seed-name"}
        return doc

    def test_a_short_deadline_arm_splices_and_names_both_edits(self):
        r = m.c9f_deadline_doc(self.canon(), "m4x-c9f-fail", "fail")
        self.assertEqual(r["missing"], [])
        self.assertIsInstance(r["doc"], str)
        self.assertIn("deadlineSeconds: 60", r["doc"])
        self.assertIn("onTimeout: fail", r["doc"])
        self.assertNotIn("86400", r["doc"])
        self.assertEqual(len(r["applied"]), 3, r["applied"])
        self.assertIsNotNone(r["edited"])

    def test_the_source_document_is_never_mutated(self):
        src = self.canon()
        m.c9f_deadline_doc(src, "m4x-c9f-x", "expire", 60)
        self.assertEqual(src["metadata"]["name"], "seed-name")
        self.assertEqual(src["spec"]["nodes"][0]["config"]["deadlineSeconds"], 86400)
        self.assertEqual(src["spec"]["nodes"][0]["config"]["onTimeout"], "fail")

    def test_each_schema_arm_is_allowed(self):
        for arm in m.C9F_TIMEOUT_ARMS:
            r = m.c9f_deadline_doc(self.canon(), "n", arm)
            self.assertEqual(r["missing"], [], arm)
            self.assertIn(f"onTimeout: {arm}", r["doc"])

    def test_an_arm_the_schema_does_not_author_is_refused(self):
        r = m.c9f_deadline_doc(self.canon(), "n", "ping")
        self.assertIsNone(r["doc"])
        self.assertTrue(any("not a schema arm" in s for s in r["missing"]), r["missing"])

    def test_a_deadline_under_the_schema_floor_is_refused(self):
        r = m.c9f_deadline_doc(self.canon(), "n", "fail", 20)
        self.assertIsNone(r["doc"])
        self.assertTrue(any("floor" in s for s in r["missing"]), r["missing"])
        self.assertEqual(r["deadline_seconds"], 20)

    def test_a_deadline_that_is_not_a_number_is_refused_not_crashed(self):
        for bad in (None, "soon", {}):
            r = m.c9f_deadline_doc(self.canon(), "n", "fail", bad)
            self.assertIsNone(r["doc"], bad)
            self.assertTrue(any("floor" in s for s in r["missing"]), (bad, r["missing"]))

    def test_a_source_that_already_authors_the_pair_measures_nothing(self):
        r = m.c9f_deadline_doc(self.canon(dl=60, ot="expire"), "n", "expire", 60)
        self.assertIsNone(r["doc"])
        self.assertTrue(any("already authors" in s for s in r["missing"]), r["missing"])

    def test_zero_or_two_gates_refuse_rather_than_guess(self):
        for gates in (0, 2):
            r = m.c9f_deadline_doc(self.canon(gates=gates), "n", "fail")
            self.assertIsNone(r["doc"], gates)
            self.assertTrue(any("human.approval" in s for s in r["missing"]),
                            (gates, r["missing"]))

    def test_a_non_pipeline_source_refuses(self):
        self.assertIsNone(m.c9f_deadline_doc({}, "n", "fail")["doc"])
        self.assertIsNone(m.c9f_deadline_doc(self.canon(kind="Task"), "n", "fail")["doc"])
        self.assertIsNone(m.c9f_deadline_doc(None, "n", "fail")["doc"])

    def test_no_metadata_block_refuses_the_rename(self):
        r = m.c9f_deadline_doc(self.canon(meta=False), "n", "fail")
        self.assertIsNone(r["doc"])
        self.assertTrue(any("metadata.name" in s for s in r["missing"]), r["missing"])


class FDocVerdictsTest(unittest.TestCase):
    SP = {"doc": "deadlineSeconds: 60\nonTimeout: expire\n", "applied": ["metadata.name",
          "/approve deadlineSeconds: 86400 -> 60", "/approve onTimeout: fail -> expire"],
          "missing": [], "arm": "expire", "deadline_seconds": 60, "edited": {}}

    def test_a_clean_splice_passes_every_arm(self):
        self.assertTrue(all(ok for _, ok, _ in m.c9f_doc_verdicts(self.SP, "expire")),
                        m.c9f_doc_verdicts(self.SP, "expire"))

    def test_a_refused_splice_fails_rather_than_going_unmeasured(self):
        bad = dict(self.SP, doc=None, applied=[], missing=["the one gate (found 0)"])
        v = m.c9f_doc_verdicts(bad, "fail")
        self.assertFalse(any(ok for _, ok, _ in v), v)
        self.assertTrue(len(v) == 2, v)

    def test_no_report_at_all_gaps(self):
        v = m.c9f_doc_verdicts({}, "fail")
        self.assertEqual([ok for _, ok, _ in v], [None], v)

    def test_bytes_that_do_not_carry_the_pair_fail(self):
        v = m.c9f_doc_verdicts(dict(self.SP, doc="deadlineSeconds: 86400\n"), "fail")
        self.assertFalse(ok_of(v, "carry deadlineSeconds"), v)


class FSubFloorTest(unittest.TestCase):
    """The brief's 20s is UNDER the schema's declared floor (deadlineSeconds.minimum
    60), so the probe must be REFUSED at validate — that refusal is what makes the
    arms' 60 the schema's number rather than the driver's."""

    def resp(self, valid, errors):
        return {"valid": valid, "errors": errors}

    def err(self, loc="/spec/nodes/1/config/deadlineSeconds", code="schema_violation"):
        return {"source": "schema", "code": code, "instance_location": loc,
                "message": "minimum"}

    def test_a_refusal_naming_the_field_passes(self):
        ok = ok_of(m.c9f_sub_floor_verdict(self.resp(False, [self.err()])), "refused")
        self.assertTrue(ok)

    def test_an_accepted_sub_floor_document_fails(self):
        v = m.c9f_sub_floor_verdict(self.resp(True, []))
        self.assertFalse(ok_of(v, "refused"), v)

    def test_a_refusal_somewhere_else_fails(self):
        v = m.c9f_sub_floor_verdict(self.resp(False, [self.err("/spec/nodes/0/kind")]))
        self.assertFalse(ok_of(v, "refused"), v)

    def test_no_validate_body_gaps(self):
        for body in (None, {}, {"errors": "x"}, {"valid": False}):
            v = m.c9f_sub_floor_verdict(body)
            self.assertIsNone(ok_of(v, "refused"), (body, v))


class FWaitedTest(unittest.TestCase):
    def test_a_gate_holding_nothing_and_not_yet_expired_passes(self):
        self.assertTrue(all(ok for _, ok, _ in m.c9f_waited_verdicts(snap(), [])),
                        m.c9f_waited_verdicts(snap(), []))

    def test_an_early_expiry_fails_the_wait(self):
        self.assertFalse(ok_of(m.c9f_waited_verdicts(snap(), [{"re_requested": "f"}]),
                              "NOT expired"))

    def test_an_attempt_behind_the_gate_fails(self):
        self.assertFalse(ok_of(m.c9f_waited_verdicts(snap(attempts="1"), []),
                              "nothing is claimed"))

    def test_no_expired_read_gaps_that_arm_only(self):
        v = m.c9f_waited_verdicts(snap(), None)
        self.assertIsNone(ok_of(v, "NOT expired"), v)
        self.assertTrue(ok_of(v, "nothing is claimed"), v)

    def test_no_gate_row_gaps_the_only_arm(self):
        self.assertEqual([ok for _, ok, _ in m.c9f_waited_verdicts({}, [])], [None])


class FBranchTest(unittest.TestCase):
    PLAN = {"status": "succeeded", "outputs_present": "t"}

    def test_plan_outputs_and_a_readable_artifact_pass(self):
        v = m.c9f_branch_verdicts(self.PLAN, [{"id": "a1"}], {"a1": 200})
        self.assertTrue(all(ok for _, ok, _ in v), v)

    def test_plan_outputs_alone_still_carries_the_run_when_there_are_no_bytes(self):
        v = m.c9f_branch_verdicts(self.PLAN, [], {})
        self.assertTrue(ok_of(v, "/plan is succeeded"), v)
        self.assertIsNone(ok_of(v, "artifact is still readable"), v)
        self.assertIn("deterministic twin", detail_of(v, "artifact is still readable"))

    def test_an_unreadable_artifact_fails(self):
        v = m.c9f_branch_verdicts(self.PLAN, [{"id": "a1"}, {"id": "a2"}],
                                  {"a1": 200, "a2": 404})
        self.assertFalse(ok_of(v, "artifact is still readable"), v)

    def test_a_missing_artifact_read_gaps(self):
        v = m.c9f_branch_verdicts(self.PLAN, None, {})
        self.assertIsNone(ok_of(v, "artifact is still readable"), v)

    def test_no_plan_row_gaps_its_own_arm(self):
        for row in (None, {}, "x"):
            v = m.c9f_branch_verdicts(row, [{"id": "a1"}], {"a1": 200})
            self.assertIsNone(ok_of(v, "/plan is succeeded"), (row, v))

    def test_a_plan_row_that_is_not_succeeded_fails(self):
        self.assertFalse(ok_of(m.c9f_branch_verdicts(
            {"status": "running", "outputs_present": "f"}, [], []), "/plan is succeeded"))


class FSiblingTest(unittest.TestCase):
    def test_a_sibling_that_ran_while_our_gate_held_passes(self):
        self.assertTrue(all(ok for _, ok, _ in m.c9f_sibling_verdicts(3, True,
                                                                     "waiting_human")))

    def test_no_progressed_sibling_is_a_gap_never_a_pass(self):
        for ran in (None, 0, ""):
            v = m.c9f_sibling_verdicts(ran, True, "waiting_human")
            self.assertIsNone(ok_of(v, "sibling node"), (ran, v))

    def test_a_sibling_that_ran_after_our_gate_closed_proves_nothing(self):
        self.assertFalse(ok_of(m.c9f_sibling_verdicts(3, False, "completed"),
                              "sibling node"))


class FExpiryTest(unittest.TestCase):
    """c9f_expiry_verdicts: the terminal algebra, one shape per on_timeout arm."""

    def snap(self, state="expired", err="approval_expired"):
        return snap(state=state, node="failed", error=err)

    EX = [{"on_timeout": "fail", "re_requested": "f"}]
    RUN = {"status": "failed", "failed_cause": "approval_expired"}
    FAIL_EV = {"error_class": "approval_expired"}

    def test_the_fail_arm_passes_on_its_own_ledger_shape(self):
        v = m.c9f_expiry_verdicts("fail", self.snap(), self.EX, self.RUN, self.FAIL_EV, None)
        self.assertTrue(all(ok for _, ok, _ in v), v)

    def test_the_expire_arm_fails_the_same_way_once(self):
        v = m.c9f_expiry_verdicts("expire", self.snap(),
                                  [{"on_timeout": "expire", "re_requested": "t"}],
                                  self.RUN, self.FAIL_EV, None)
        self.assertTrue(all(ok for _, ok, _ in v), v)

    def test_no_expired_row_fails_the_journal_arm(self):
        v = m.c9f_expiry_verdicts("fail", self.snap(), [], self.RUN, self.FAIL_EV, None)
        self.assertFalse(ok_of(v, "approval.expired is journalled"), v)
        self.assertFalse(ok_of(v, "names on_timeout"), v)

    def test_an_expired_row_naming_another_arm_fails(self):
        v = m.c9f_expiry_verdicts("fail", self.snap(),
                                  [{"on_timeout": "cancel_run", "re_requested": "f"}],
                                  self.RUN, self.FAIL_EV, None)
        self.assertFalse(ok_of(v, "names on_timeout"), v)

    def test_a_gate_stuck_pending_fails_the_terminal_arm(self):
        self.assertFalse(ok_of(m.c9f_expiry_verdicts(
            "fail", self.snap(state="pending"), self.EX, self.RUN, self.FAIL_EV, None),
            "terminal"))

    def test_a_run_failed_for_another_class_fails_the_error_class_arm(self):
        v = m.c9f_expiry_verdicts("fail", self.snap(err="worker_shutdown"), self.EX,
                                  {"status": "failed", "failed_cause": "worker_shutdown"},
                                  {"error_class": "worker_shutdown"}, None)
        self.assertFalse(ok_of(v, "error_class='approval_expired'"), v)

    def test_a_run_that_never_failed_fails_the_run_arm(self):
        v = m.c9f_expiry_verdicts("fail", self.snap(), self.EX,
                                  {"status": "waiting_human", "failed_cause": "-"},
                                  {}, {})
        self.assertFalse(ok_of(v, "error_class='approval_expired'"), v)

    def test_an_unreadable_run_failed_journal_gaps_the_fail_arm(self):
        v = m.c9f_expiry_verdicts("fail", self.snap(), self.EX, self.RUN, None, None)
        self.assertIsNone(ok_of(v, "error_class='approval_expired'"), v)

    def test_the_cancel_run_arm_cancels_and_never_fails(self):
        cr = [{"on_timeout": "cancel_run", "re_requested": "f"}]
        good = m.c9f_expiry_verdicts("cancel_run", self.snap(state="cancelled", err="-"),
                                     cr, {"status": "cancelled", "failed_cause": "-"},
                                     {}, {"cascade": True})
        self.assertTrue(all(ok for _, ok, _ in good), good)
        bad = m.c9f_expiry_verdicts("cancel_run", self.snap(state="cancelled", err="-"),
                                    cr, {"status": "failed", "failed_cause": "x"},
                                    {"error_class": "approval_expired"}, None)
        self.assertFalse(ok_of(bad, "ends cancelled"), bad)
        self.assertIsNone(ok_of(bad, "run.cancel_requested was journalled"), bad)
        self.assertFalse(ok_of(bad, "never masquerades"), bad)

    def test_an_unreadable_run_failed_row_gaps_the_masquerade_arm(self):
        cr = [{"on_timeout": "cancel_run", "re_requested": "f"}]
        v = m.c9f_expiry_verdicts("cancel_run", self.snap(state="cancelled", err="-"), cr,
                                  {"status": "cancelled", "failed_cause": "-"}, None,
                                  {"cascade": True})
        self.assertIsNone(ok_of(v, "never masquerades"), v)

    def test_a_cancel_that_also_re_requested_fails_the_exactly_once_arm(self):
        cr = [{"on_timeout": "cancel_run", "re_requested": "t"}]
        v = m.c9f_expiry_verdicts("cancel_run", self.snap(state="cancelled", err="-"), cr,
                                  {"status": "cancelled", "failed_cause": "-"}, None,
                                  {"cascade": True})
        self.assertFalse(ok_of(v, "re_requested stays false"), v)

    def test_an_unreadable_gate_or_journal_gaps_rather_than_failing(self):
        self.assertIsNone(ok_of(m.c9f_expiry_verdicts("fail", {}, self.EX, self.RUN,
                                                      self.FAIL_EV, None),
                               "row is readable after the window"))
        v = m.c9f_expiry_verdicts("fail", self.snap(), None, None, None, None)
        self.assertIsNone(ok_of(v, "approval.expired is journalled"), v)

    def test_an_unreadable_runs_row_gaps_the_terminal_arms(self):
        v = m.c9f_expiry_verdicts("fail", self.snap(), self.EX, None, None, None)
        self.assertIsNone(ok_of(v, "error_class='approval_expired'"), v)
        self.assertTrue(ok_of(v, "approval.expired is journalled"), v)


class FRerequestTest(unittest.TestCase):
    ROWS = [{"on_timeout": "expire", "re_requested": "t"}]

    def test_exactly_one_re_request_that_keeps_waiting_passes(self):
        v = m.c9f_rerequest_verdicts(snap(), "t", self.ROWS, True)
        self.assertTrue(all(ok for _, ok, _ in v), v)

    def test_a_second_re_request_fails_exactly_once(self):
        two = self.ROWS + [{"on_timeout": "expire", "re_requested": "t"}]
        self.assertFalse(ok_of(m.c9f_rerequest_verdicts(snap(), "t", two, True),
                              "EXACTLY ONE"))

    def test_a_re_request_that_left_the_gate_pending_fails(self):
        v = m.c9f_rerequest_verdicts(snap(state="expired", attempts="1"), "t", self.ROWS,
                                     True)
        self.assertFalse(ok_of(v, "still pending"), v)

    def test_a_missing_re_requested_flag_fails(self):
        self.assertFalse(ok_of(m.c9f_rerequest_verdicts(snap(), "f", self.ROWS, True),
                              "re_requested = t"))

    def test_a_deadline_that_never_moved_fails(self):
        self.assertFalse(ok_of(m.c9f_rerequest_verdicts(snap(), "t", self.ROWS, False),
                              "moved the deadline"))

    def test_no_mid_window_row_gaps_every_arm(self):
        self.assertEqual([ok for _, ok, _ in m.c9f_rerequest_verdicts({}, "t", [], True)],
                         [None])

    def test_an_unreadable_expired_journal_gaps_its_own_arm(self):
        v = m.c9f_rerequest_verdicts(snap(), "t", None, None)
        self.assertIsNone(ok_of(v, "EXACTLY ONE"), v)
        self.assertIsNone(ok_of(v, "moved the deadline"), v)
        self.assertTrue(ok_of(v, "still pending"), v)


class GTakeoverTest(unittest.TestCase):
    """§ 7.1 C9g's take-control half over canned rows/responses."""
    BOB = "01987a63-3333-7000-8000-abcdef012345"

    def take(self, status=200, kind="human", who=None, version=2):
        return {"status": status, "ctype": "application/json",
                "body": {"control": {"kind": kind, "user_id": who or self.BOB,
                                     "version": version}}}

    TURN = {"status": "running", "cancel_requested": "2026-05-01 12:00:00+00"}
    ATT = {"status": "interrupted", "error_class": "interrupted"}
    RUN = {"status": "paused", "paused_reason": "human_takeover"}
    EV = {"reason": "human_takeover"}

    def test_a_clean_takeover_passes_every_arm(self):
        v = m.c9g_takeover_verdicts(self.take(), self.TURN, self.ATT, self.RUN, self.EV,
                                    self.BOB)
        self.assertTrue(all(ok for _, ok, _ in v), v)

    def test_a_refused_take_control_fails_only_its_own_arms(self):
        v = m.c9g_takeover_verdicts({"status": 409, "ctype": "application/problem+json",
                                     "body": {"control": {"kind": "run_attempt",
                                                          "version": 3}}},
                                    self.TURN, self.ATT, self.RUN, self.EV, self.BOB)
        self.assertFalse(ok_of(v, "take-control with the version"), v)
        self.assertFalse(ok_of(v, "controller badge"), v)
        self.assertTrue(ok_of(v, "cancel-requested"), v)

    def test_a_controller_that_is_not_the_taker_fails_the_badge(self):
        v = m.c9g_takeover_verdicts(self.take(who="someone-else"), self.TURN, self.ATT,
                                    self.RUN, self.EV, self.BOB)
        self.assertFalse(ok_of(v, "controller badge"), v)

    def test_a_control_row_still_held_by_the_run_attempt_fails_the_badge(self):
        v = m.c9g_takeover_verdicts(self.take(kind="run_attempt", who=None), self.TURN,
                                    self.ATT, self.RUN, self.EV, self.BOB)
        self.assertFalse(ok_of(v, "controller badge"), v)

    def test_a_control_row_the_answer_never_carried_gaps_the_badge(self):
        v = m.c9g_takeover_verdicts({"status": 200, "ctype": "application/json",
                                     "body": {}}, self.TURN, self.ATT, self.RUN, self.EV,
                                    self.BOB)
        self.assertIsNone(ok_of(v, "controller badge"), v)

    def test_a_turn_never_cancel_requested_fails(self):
        self.assertFalse(ok_of(m.c9g_takeover_verdicts(
            self.take(), {"status": "running", "cancel_requested": None},
            self.ATT, self.RUN, self.EV, self.BOB), "cancel-requested"))

    def test_an_attempt_closed_as_a_business_failure_fails(self):
        self.assertFalse(ok_of(m.c9g_takeover_verdicts(
            self.take(), self.TURN, {"status": "failed", "error_class": "invalid_output"},
            self.RUN, self.EV, self.BOB), "attempts.status='interrupted'"))

    def test_an_interrupted_attempt_for_another_reason_fails(self):
        v = m.c9g_takeover_verdicts(self.take(), self.TURN, self.ATT, self.RUN,
                                    {"reason": "worker_shutdown"}, self.BOB)
        self.assertFalse(ok_of(v, "is journalled"), v)

    def test_a_run_left_running_fails_the_pause_arm(self):
        v = m.c9g_takeover_verdicts(self.take(), self.TURN, self.ATT,
                                    {"status": "running", "paused_reason": None}, self.EV,
                                    self.BOB)
        self.assertFalse(ok_of(v, "paused_reason='human_takeover'"), v)

    def test_missing_reads_gap_rather_than_fail(self):
        v = m.c9g_takeover_verdicts(None, None, None, None, None, self.BOB)
        self.assertEqual([ok for _, ok, _ in v], [None] * 6, v)


class GReturnTest(unittest.TestCase):
    """§ 7.1 C9g's second half: return-control resumes the run and the next attempt's "
    "retry_context names the intervention."""
    RCX = {"attempt": 1, "error_class": "interrupted",
           "human_takeover": {"summary": "bob drove the turn for 40s"}}

    def ret(self, status=200):
        return {"status": status, "body": {"control": {"kind": "none", "version": 3}}}

    def test_a_return_that_resumes_with_the_intervention_in_context_passes(self):
        v = m.c9g_return_verdicts(self.ret(), {"status": "queued", "paused_reason": None},
                                  {"paused_reason": "human_takeover"},
                                  {"attempt_number": 2, "retry_context": dict(self.RCX)},
                                  "drove the turn for 40s")
        self.assertTrue(all(ok for _, ok, _ in v), v)

    def test_a_run_still_paused_fails(self):
        self.assertFalse(ok_of(m.c9g_return_verdicts(
            self.ret(), {"status": "paused", "paused_reason": "human_takeover"},
            {"paused_reason": "human_takeover"},
            {"attempt_number": 2, "retry_context": dict(self.RCX)}, "x"), "resumes"))

    def test_a_resume_naming_another_reason_fails(self):
        self.assertFalse(ok_of(m.c9g_return_verdicts(
            self.ret(), {"status": "queued"}, {"paused_reason": "manual"},
            {"attempt_number": 2, "retry_context": dict(self.RCX)}, "drove"), "run.resumed"))

    def test_a_retry_with_no_context_fails_the_intervention_arm(self):
        self.assertFalse(ok_of(m.c9g_return_verdicts(
            self.ret(), {"status": "queued"}, {"paused_reason": "human_takeover"},
            {"attempt_number": 2, "retry_context": None}, "drove the turn"),
            "retry_context"))

    def test_a_context_that_never_mentions_the_human_fails(self):
        v = m.c9g_return_verdicts(self.ret(), {"status": "queued"},
                                  {"paused_reason": "human_takeover"},
                                  {"attempt_number": 2,
                                   "retry_context": {"attempt": 1,
                                                     "error_class": "interrupted"}},
                                  "drove the turn for 40s")
        self.assertFalse(ok_of(v, "retry_context"), v)

    def test_a_refused_return_fails_only_its_own_arm(self):
        v = m.c9g_return_verdicts({"status": 409, "body": {}}, {"status": "paused"}, None,
                                  None, "drove")
        self.assertFalse(ok_of(v, "return-control"), v)
        self.assertIsNone(ok_of(v, "run.resumed"), v)
        self.assertIsNone(ok_of(v, "retry_context"), v)

    def test_nothing_readable_gaps_all_four(self):
        self.assertEqual([ok for _, ok, _ in m.c9g_return_verdicts(None, None, None, None,
                                                                   "")], [None] * 4)


class GTranscriptTest(unittest.TestCase):
    """§ 7.1 C9g's last sentence: one journal, rows only added, never a second cursor."""
    TYPES = ["conversation.message.agent", "conversation.control.transferred",
             "conversation.turn.cancelled"]

    def test_a_journal_that_grows_on_one_cursor_passes(self):
        v = m.c9g_transcript_verdicts("4100", "4137", self.TYPES, [])
        self.assertTrue(all(ok for _, ok, _ in v), v)

    def test_a_shrinking_transcript_fails(self):
        self.assertFalse(ok_of(m.c9g_transcript_verdicts("4137", "4100", self.TYPES, []),
                              "domain_events journal"))

    def test_a_missing_takeover_row_fails_the_control_arm(self):
        v = m.c9g_transcript_verdicts("4100", "4137", ["conversation.message.agent"], [])
        self.assertFalse(ok_of(v, "control transferred"), v)

    def test_a_new_cursor_table_fails_the_last_arm(self):
        v = m.c9g_transcript_verdicts("4100", "4137", self.TYPES, ["run_transcript_cursor"])
        self.assertFalse(ok_of(v, "SECOND transcript cursor"), v)

    def test_unreadable_reads_gap(self):
        v = m.c9g_transcript_verdicts("", "", None, None)
        self.assertEqual([ok for _, ok, _ in v], [None, None, None], v)


class SchemaTruthTest(unittest.TestCase):
    """The arms and the floor are the SCHEMA's, not this file's. If
    configHumanApproval ever gains an arm or moves its minimum, this FAILS and the
    driver's constants go with it — that is the point."""

    @classmethod
    def setUpClass(cls):
        path = os.path.join(m.REPO_DIR, "internal", "pipelines", "schema", "assets",
                            "pipeline-v1alpha1.schema.json")
        with open(path, encoding="utf-8") as f:
            import json as _json
            defs = _json.load(f)["$defs"]["configHumanApproval"]["properties"]
        cls.arms = tuple(defs["onTimeout"]["enum"])
        cls.floor = defs["deadlineSeconds"]["minimum"]

    def test_the_arms_are_the_schemas(self):
        self.assertEqual(sorted(m.C9F_TIMEOUT_ARMS), sorted(self.arms),
                         f"schema={self.arms} driver={m.C9F_TIMEOUT_ARMS}")

    def test_the_floor_is_the_schemas(self):
        self.assertEqual(m.C9F_SCHEMA_FLOOR_S, self.floor)
        self.assertEqual(m.C9F_DEADLINE_S, self.floor)

    def test_the_briefs_20s_is_under_the_floor_so_it_is_the_probe_not_the_arm(self):
        self.assertLess(m.C9F_SUB_FLOOR_S, self.floor)

    def test_the_wait_windows_cover_the_deadline_plus_the_reconciler_tick(self):
        self.assertGreaterEqual(m.C9F_ARM_WAIT_S, m.C9F_DEADLINE_S + m.C9F_TICK_S)
        self.assertGreaterEqual(m.C9F_EXPIRE_WAIT_S, 2 * m.C9F_DEADLINE_S + m.C9F_TICK_S)


class FSubFloorDocTest(unittest.TestCase):
    DOC = "deadlineSeconds: 60\nonTimeout: fail\n"

    def test_the_probe_lowers_only_the_deadline(self):
        got = m.c9f_sub_floor_doc(self.DOC)
        self.assertIn("deadlineSeconds: 20", got)
        self.assertIn("onTimeout: fail", got)
        self.assertNotIn("60", got)

    def test_no_deadline_line_means_no_probe(self):
        self.assertEqual(m.c9f_sub_floor_doc("onTimeout: fail\n"), "")
        self.assertEqual(m.c9f_sub_floor_doc(None), "")

    def test_the_refused_value_alone_is_the_sub_floor(self):
        self.assertEqual(m.c9f_sub_floor_doc(self.DOC, sub_floor=10),
                         "deadlineSeconds: 10\nonTimeout: fail\n")


class GControlBadgeTest(unittest.TestCase):
    BOB = "u-bob"

    def test_a_human_badge_naming_the_taker_passes(self):
        self.assertTrue(m._c9g_control_moved({"kind": "human", "user_id": self.BOB,
                                              "version": 2}, self.BOB))

    def test_the_run_attempt_holding_it_fails(self):
        self.assertFalse(m._c9g_control_moved({"kind": "run_attempt", "user_id": None,
                                               "version": 3}, self.BOB))

    def test_a_different_human_fails(self):
        self.assertFalse(m._c9g_control_moved({"kind": "human", "user_id": "carol",
                                               "version": 2}, self.BOB))

    def test_a_version_never_bumped_fails(self):
        self.assertFalse(m._c9g_control_moved({"kind": "human", "user_id": self.BOB,
                                               "version": 1}, self.BOB))

    def test_no_control_row_gaps(self):
        for row in (None, "x", 7):
            self.assertIsNone(m._c9g_control_moved(row, self.BOB), row)


if __name__ == "__main__":
    unittest.main(verbosity=2 if "-v" in sys.argv else 1)
