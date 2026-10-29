#!/usr/bin/env python3
"""test_c9_logic.py — offline unit proof for e2e_m4_exit.py's C9 pure logic.

Runs WITHOUT a stack (stdlib unittest only): the "the gate holds nothing" verdict
algebra, the durability-across-a-restart rule (including the GAP when the lab
restarted nothing), the refusal-is-not-a-decision rule for C9b/C9c, THE central
one — the CAS exactly-once verdict computed from two canned decide responses plus
the gate's ledger row (PASS / FAIL / GAP) — the rejection-is-a-business-outcome
rule and the deadline-arming rule. Since gap-c9e-reject it also owns C9e's
authored revision: c9e_rejection_doc (the twin's /plan + /approve plus ONE
dependant guarded on nodes.approve.outputs.decision — § 7.1 C9e's "skipped
dependants" is not producible on the seeded graph), c9e_doc_verdicts, the
per-node skip algebra of c9e_graph_verdicts (skipped + condition_default + zero
attempts + a dependency_skipped witness, never cancelled and never run) and the
control flow of c9e_own_gate. A green here means the VERDICT ALGEBRA is
right; it never substitutes for C9's live gates against a running control plane
(12-test-strategy.md: authorization at decision time is only proven by really
removing a maintainer and really POSTing /decide, and C9e's guard is only proven
by really rejecting a gate on a published revision).

usage: python3 e2e/m4/test_c9_logic.py [-v]
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import e2e_m4_exit as m  # noqa: E402 — importing the driver is the point
import yamlmini as yaml  # noqa: E402 — stdlib YAML subset (CI's python3 has no PyYAML)

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
    """c9_rejection_verdicts — the GATE half of § 7.1 C9e. The dependant half is
    graded only against a graph that guards a node on the decision (guard_key), which
    is what c9e_rejection_doc authors; on the § 7.0 twin the arm GAPs instead of
    crediting /emit_items' fan-out skip with the approver's decision."""
    GATE = snap(state="decided", version="2", decision="rejected", decided_by=BOB,
                node="succeeded", outcome="rejected")
    SKIPPED = [{"key": "/emit_items", "reason": "condition_default"},
               {"key": "/fan_out", "reason": "condition_default"}]
    GUARDED = [{"key": "/ship", "reason": "condition_default"},
               {"key": "/ship_evidence", "reason": "dependency_skipped"}]

    def test_a_business_rejection_passes(self):
        v = m.c9_rejection_verdicts(self.GATE, "completed", "-", self.GUARDED,
                                    ["condition_default", "dependency_skipped"],
                                    guard_key="/ship")
        self.assertTrue(all(ok for _, ok, _ in v), v)

    def test_a_rejection_written_as_an_execution_failure_fails(self):
        v = m.c9_rejection_verdicts(self.GATE | {"node_status": "failed",
                                                 "node_outcome": "-",
                                                 "node_error_class": "approval_expired"},
                                    "failed", "node_execution_failed:/approve",
                                    self.GUARDED, ["condition_default"], guard_key="/ship")
        self.assertFalse(ok_of(v, "succeeded with outcome='rejected'"))
        self.assertFalse(ok_of(v, "no execution error_class"))

    def test_a_dependant_skipped_for_another_reason_fails(self):
        v = m.c9_rejection_verdicts(self.GATE, "completed", "-",
                                    [{"key": "/ship", "reason": "dependency_skipped"}],
                                    ["dependency_skipped"], guard_key="/ship")
        self.assertFalse(ok_of(v, "condition_default"))

    def test_direct_dependant_carries_condition_default_and_transitive_one_the_skip(self):
        # row 14 keeps BOTH reasons: the when-gated node itself is condition_default,
        # everything downstream of a skipped parent is dependency_skipped.
        v = m.c9_rejection_verdicts(
            self.GATE, "completed", "-",
            [{"key": "/ship", "reason": "condition_default"},
             {"key": "/ship_evidence", "reason": "dependency_skipped"}],
            ["condition_default", "dependency_skipped"], guard_key="/ship")
        self.assertTrue(ok_of(v, "condition_default"), v)

    def test_a_guarded_node_skipped_for_something_else_than_its_when_fails(self):
        v = m.c9_rejection_verdicts(
            self.GATE, "completed", "-",
            [{"key": "/ship", "reason": "condition_default"},
             {"key": "/ship_evidence", "reason": "case_not_selected"}],
            ["condition_default", "case_not_selected"], guard_key="/ship")
        self.assertFalse(ok_of(v, "condition_default"))

    def test_the_fanout_pair_alone_is_never_credited_with_the_rejection(self):
        # THE vacuity this revision closes: on the seeded twin these rows are true and
        # say nothing about the decision, so the arm is a GAP, never a PASS.
        v = m.c9_rejection_verdicts(self.GATE, "completed", "-", self.SKIPPED,
                                    ["condition_default", "condition_default"])
        gap_line = [d for label, ok, d in v if "BECAUSE of the rejection" in label]
        self.assertEqual([None], [ok for label, ok, _ in v
                                  if "BECAUSE of the rejection" in label], v)
        self.assertIn("inputs.fanout", gap_line[0])

    def test_a_guard_key_the_run_never_had_fails_instead_of_gapping(self):
        # A revision this gate authored and published MUST show its guard in the ledger;
        # a missing row is a product failure, while the twin fallback is the GAP above.
        v = m.c9_rejection_verdicts(self.GATE, "completed", "-", self.SKIPPED,
                                    ["condition_default"], guard_key="/ship")
        self.assertFalse(ok_of(v, "condition_default"))

    def test_no_skipped_rows_fails_the_graph_arm(self):
        self.assertFalse(ok_of(m.c9_rejection_verdicts(self.GATE, "completed", "-", [], [],
                                                      guard_key="/ship"),
                              "condition_default"))

    def test_a_run_failed_by_the_approval_clock_fails(self):
        v = m.c9_rejection_verdicts(self.GATE, "failed", "approval_expired", self.GUARDED,
                                    ["condition_default"], guard_key="/ship")
        self.assertFalse(ok_of(v, "terminates on the graph's terms"))

    def test_a_run_that_never_terminated_fails(self):
        self.assertFalse(ok_of(m.c9_rejection_verdicts(self.GATE, "running", "-",
                                                      self.GUARDED, ["condition_default"],
                                                      guard_key="/ship"),
                              "terminates on the graph's terms"))

    def test_no_gate_row_gaps(self):
        self.assertIsNone(ok_of(m.c9_rejection_verdicts({}, "completed", "-", [], []),
                               "node row is readable"))


class GuardedGraphTest(unittest.TestCase):
    """c9e_graph_verdicts — the per-NODE half of § 7.1 C9e on the revision C9e
    publishes: 'skipped, because my own when read the rejection' is a claim about
    condition_default, about zero attempts and about the row NOT being cancelled, and
    only the node ledger can say all three."""
    ROWS = {"/plan": {"status": "succeeded", "reason": "-", "attempts": "1",
                      "outcome": "-", "error_class": "-", "outputs_present": "t"},
            "/approve": {"status": "succeeded", "reason": "-", "attempts": "0",
                         "outcome": "rejected", "error_class": "-", "outputs_present": "t"},
            "/ship": {"status": "skipped", "reason": "condition_default", "attempts": "0",
                      "outcome": "-", "error_class": "-", "outputs_present": "f"},
            "/ship_evidence": {"status": "skipped", "reason": "dependency_skipped",
                               "attempts": "0", "outcome": "-", "error_class": "-",
                               "outputs_present": "f"}}
    RUN = {"status": "completed", "failed_cause": "-"}

    def test_a_rejected_gate_skips_its_guarded_dependant(self):
        v = m.c9e_graph_verdicts(self.ROWS, self.RUN)
        self.assertTrue(all(ok for _, ok, _ in v), v)

    def test_a_cancelled_dependant_is_not_a_business_outcome(self):
        rows = {k: dict(v) for k, v in self.ROWS.items()}
        rows["/ship"].update(status="cancelled", reason="-")
        v = m.c9e_graph_verdicts(rows, self.RUN)
        self.assertFalse(ok_of(v, "is SKIPPED"))
        self.assertFalse(ok_of(v, "was CANCELLED or FAILED"))

    def test_a_dependant_that_ran_is_not_a_skip(self):
        rows = {k: dict(v) for k, v in self.ROWS.items()}
        rows["/ship"].update(status="succeeded", reason="-", attempts="1")
        v = m.c9e_graph_verdicts(rows, self.RUN)
        self.assertFalse(ok_of(v, "is SKIPPED"))
        self.assertFalse(ok_of(v, "NEVER RAN"))

    def test_an_attempt_on_a_skipped_row_says_it_ran_anyway(self):
        rows = {k: dict(v) for k, v in self.ROWS.items()}
        rows["/ship"]["attempts"] = "2"
        self.assertFalse(ok_of(m.c9e_graph_verdicts(rows, self.RUN), "NEVER RAN"))

    def test_a_skipped_row_carrying_outputs_says_it_ran(self):
        # status=skipped AND outputs written is not a skip the graph decided; the claim
        # reads the row's own jsonb column rather than trusting the status word.
        rows = {k: dict(v) for k, v in self.ROWS.items()}
        rows["/ship"]["outputs_present"] = "t"
        self.assertFalse(ok_of(m.c9e_graph_verdicts(rows, self.RUN), "NEVER RAN"))

    def test_a_reason_that_is_not_the_nodes_own_condition_fails(self):
        rows = {k: dict(v) for k, v in self.ROWS.items()}
        rows["/ship"]["reason"] = "dependency_skipped"
        self.assertFalse(ok_of(m.c9e_graph_verdicts(rows, self.RUN), "is SKIPPED"))

    def test_the_downstream_witness_must_carry_the_other_reason(self):
        rows = {k: dict(v) for k, v in self.ROWS.items()}
        rows["/ship_evidence"]["reason"] = "condition_default"
        self.assertFalse(ok_of(m.c9e_graph_verdicts(rows, self.RUN), "PROPAGATES"))

    def test_a_missing_guard_row_fails_rather_than_gapping(self):
        rows = {k: v for k, v in self.ROWS.items() if k != "/ship"}
        v = m.c9e_graph_verdicts(rows, self.RUN)
        self.assertFalse(ok_of(v, "is SKIPPED"))
        self.assertFalse(ok_of(v, "NEVER RAN"))

    def test_an_unreadable_ledger_gaps_and_never_passes(self):
        v = m.c9e_graph_verdicts(None, self.RUN)
        self.assertEqual([None], [ok for _l, ok, _d in v], v)

    def test_a_run_the_rejection_failed_is_not_the_graphs_terms(self):
        for run in ({"status": "failed", "failed_cause": "node_execution_failed:/ship"},
                    {"status": "cancelled", "failed_cause": "run_cancelled"},
                    {"status": "completed", "failed_cause": "approval_expired"}):
            self.assertFalse(ok_of(m.c9e_graph_verdicts(self.ROWS, run),
                                   "terminates on the graph's terms"), run)

    def test_an_unreadable_runs_row_gaps_the_terminal_arm(self):
        self.assertIsNone(ok_of(m.c9e_graph_verdicts(self.ROWS, None),
                                "terminates on the graph's terms"))

    def test_without_a_guarded_graph_the_arm_says_so_once_and_never_passes(self):
        # The twin fallback: no guard node exists, so nothing may be verdicted on it.
        # The CLAIM is GAPped by c9_rejection_verdicts; this line is the NOTE saying why,
        # and C5_NOTE is never a PASS (c5_emit prints it as NOTE).
        v = m.c9e_graph_verdicts(self.ROWS, self.RUN, guard_key=None)
        self.assertEqual(1, len(v), v)
        self.assertIs(m.C5_NOTE, v[0][1], v)
        self.assertIn("inputs.fanout", v[0][2], v)


class C9eGuardDocTest(unittest.TestCase):
    """c9e_rejection_doc / c9e_doc_verdicts: the revision C9e rejects a gate on must be
    provably the twin's pre-gate pair PLUS the decision guard, because a graph this file
    invented would measure this file's opinion of § 5.3 instead of the engine's. The
    splice runs on the same regenerated-4-space shape the live gate reads off
    GET /revisions/{id} (test_c7_logic's RC3 rule)."""

    @classmethod
    def setUpClass(cls):
        path = os.path.join(m.REPO_DIR, "docs", "compatibility", "probes", "m4",
                            "pipeline.yaml")
        with open(path, encoding="utf-8") as f:
            seed = f.read().split("\n---\n")[1]
        cls.twin = yaml.safe_load(yaml.safe_dump(yaml.safe_load(seed), indent=4,
                                                sort_keys=True, allow_unicode=True))
        cls.sp = m.c9e_rejection_doc(cls.twin, "m4x-c9e-unit")

    def _nodes(self):
        return {n["id"]: n for n in yaml.safe_load(self.sp["doc"])["spec"]["nodes"]}

    def test_the_document_is_the_pre_gate_pair_plus_the_guard(self):
        self.assertEqual([], self.sp["missing"], str(self.sp["missing"]))
        self.assertEqual(["/plan", "/approve", "/ship", "/ship_evidence"],
                         self.sp["node_keys"])
        self.assertEqual(["plan", "approve"], self.sp["kept"])
        self.assertNotIn("fanout", self.sp["inputs_declared"],
                         "the seed's when-guard source is NOT in this graph's inputs")
        self.assertTrue(all(ok for _l, ok, _d in m.c9e_doc_verdicts(self.sp)),
                        m.c9e_doc_verdicts(self.sp))

    def test_the_twin_nodes_are_copied_verbatim(self):
        got, want = self._nodes(), {n["id"]: n for n in self.twin["spec"]["nodes"]}
        self.assertEqual(want["plan"], got["plan"], "/plan moved: the guard would be "
                         "measured on a run that is not the twin's")
        self.assertEqual(want["approve"]["config"], got["approve"]["config"],
                         "the gate's summary/roles/deadline are the twin's verbatim")
        self.assertEqual(["plan"], got["approve"]["dependsOn"],
                         "dependsOn may only lose the nodes this revision dropped")
        self.assertEqual(want["approve"]["retry"], got["approve"]["retry"])

    def test_the_guard_is_the_bare_cel_the_engine_itself_writes(self):
        # `$when` is a restricted-CEL string (schema $defs/celExpression: 'no ${{ }}
        # delimiters'), the gate's outputs are `decision` (§ 5.3 / advancer closeGate),
        # and 'approved' is the value a passed gate carries — all three read off the
        # runtime's own fixture rather than paraphrased from this driver's prose.
        fixture = os.path.join(m.REPO_DIR, "internal", "pipelines", "runtime", "testdata",
                               "gate_sibling.yaml")
        with open(fixture, encoding="utf-8") as f:
            doc = yaml.safe_load("\n".join(l for l in f.read().splitlines()
                                           if not l.lstrip().startswith("#")))
        want = [n["when"] for n in doc["spec"]["nodes"] if n.get("when")][0]
        self.assertEqual(want.replace("gate", "approve"), self.sp["guard_when"])
        line = [l for l in self.sp["doc"].splitlines() if l.strip().startswith("when:")]
        self.assertEqual(1, len(line), line)
        self.assertEqual(f"when: {m.C9E_GUARD_WHEN}", line[0].strip(),
                         "exactly ONE when in the graph, and it reads the decision")
        self.assertNotIn("${{", line[0], "a `when` with delimiters is not a CEL guard")

    def test_the_witness_behind_the_guard_has_no_condition_of_its_own(self):
        got = self._nodes()
        self.assertNotIn("when", got["ship_evidence"],
                         "a guarded witness proves its own condition, not the cascade")
        self.assertEqual(["ship"], got["ship_evidence"]["dependsOn"])
        self.assertEqual(["approve"], got["ship"]["dependsOn"])

    def test_nothing_else_from_the_seed_survives(self):
        for node in m.C9E_FORBIDDEN_NODES:
            self.assertNotIn(f"id: {node}", self.sp["doc"], node)
        spec = yaml.safe_load(self.sp["doc"])["spec"]
        self.assertNotIn("outputs", spec, "the twin's outputs bind /build_until_verified")
        self.assertNotIn("resultBindings", spec)
        self.assertEqual(self.twin["spec"]["policies"], spec["policies"],
                         "policies ride along unchanged — the arm changes a graph, not a budget")

    def test_the_declared_inputs_are_the_twin_s_own_schemas(self):
        spec = yaml.safe_load(self.sp["doc"])["spec"]
        seed_props = self.twin["spec"]["inputs"]["properties"]
        self.assertEqual(sorted(set(self.sp["input_refs"]) | {"goal", "repository"}),
                         sorted(spec["inputs"]["properties"]))
        for name, schema in spec["inputs"]["properties"].items():
            self.assertEqual(seed_props[name], schema, f"inputs.{name} was invented")
        self.assertEqual(["goal", "repository"], spec["inputs"]["required"])

    def test_the_splice_never_mutates_the_caller_s_document(self):
        frozen = yaml.safe_load(yaml.safe_dump(self.twin))
        m.c9e_rejection_doc(self.twin, "m4x-c9e-unit-2")
        self.assertEqual(frozen, self.twin)

    def test_a_document_that_is_not_the_twin_refuses_rather_than_inventing(self):
        cases = {
            "no pipeline": {"notes": "just notes"},
            "no gate": {"apiVersion": "v", "kind": "Pipeline", "metadata": {"name": "x"},
                        "spec": {"inputs": {}, "nodes": [{"id": "plan",
                                                          "kind": "process.exec"}]}},
            "two gates": {"apiVersion": "v", "kind": "Pipeline", "metadata": {"name": "x"},
                          "spec": {"inputs": {}, "nodes": [
                              {"id": "plan", "kind": "process.exec"},
                              {"id": "approve", "kind": "human.approval"},
                              {"id": "approve2", "kind": "human.approval"}]}},
        }
        for name, doc in cases.items():
            sp = m.c9e_rejection_doc(doc, "m4x-c9e-junk")
            self.assertIsNone(sp["doc"], name)
            self.assertTrue(sp["missing"], name)
            self.assertTrue(any(ok is False for _l, ok, _d in m.c9e_doc_verdicts(sp)),
                            f"{name}: a refused splice must FAIL, not gap silently")

    def test_a_gate_named_otherwise_refuses_because_the_guard_names_approve(self):
        twin = yaml.safe_load(yaml.safe_dump(self.twin))
        for n in twin["spec"]["nodes"]:
            if n.get("kind") == "human.approval":
                n["id"] = "sign_off"
        sp = m.c9e_rejection_doc(twin, "m4x-c9e-renamed")
        self.assertIsNone(sp["doc"])
        self.assertTrue([x for x in sp["missing"] if "approve" in x], sp["missing"])

    def test_an_input_the_twin_does_not_declare_refuses(self):
        # C5h's 1c190fe shape, seen from the other side: a node that reads an input no
        # schema declares is a compiler refusal, so the builder says so before posting.
        twin = yaml.safe_load(yaml.safe_dump(self.twin))
        for n in twin["spec"]["nodes"]:
            if n.get("kind") == "human.approval":
                n["config"]["summary"] = "${{ inputs.plan_of_the_week }}"
        sp = m.c9e_rejection_doc(twin, "m4x-c9e-undeclared")
        self.assertIsNone(sp["doc"])
        self.assertTrue([x for x in sp["missing"] if "inputs.plan_of_the_week" in x],
                        sp["missing"])

    def test_no_report_at_all_is_a_gap_not_a_pass(self):
        v = m.c9e_doc_verdicts({})
        self.assertEqual([None], [ok for _l, ok, _d in v], v)


class OwnGateArmTest(unittest.TestCase):
    """c9e_own_gate is the call that replaces C9e's GAP: author -> publish -> run -> wait
    at the gate, on a revision this gate published. Its API half is faked (unit layer —
    the live lab proves the measurement, 12-test-strategy.md); what is proven here is the
    CONTROL FLOW: the guard key is handed back only for a gate the gate's own revision
    opened, every bail-out returns None (so the caller measures the business outcome on
    the twin) AND prints its reason, and the scratch run never posts an input the
    revision does not declare."""

    FACTS = {"project_id": "p-1", "pipeline_id": "pl-1", "revision_id": "rev-1",
             "inputs": {"goal": "ship", "repository": "app", "fanout": False,
                        "hold_seconds": 5}}

    @classmethod
    def setUpClass(cls):
        path = os.path.join(m.REPO_DIR, "docs", "compatibility", "probes", "m4",
                            "pipeline.yaml")
        with open(path, encoding="utf-8") as f:
            seed = f.read().split("\n---\n")[1]
        cls.twin = yaml.safe_load(yaml.safe_dump(yaml.safe_load(seed), indent=4,
                                                sort_keys=True, allow_unicode=True))

    class Client:
        who = "alice"

    def drive(self, revision="rev-xyz", run_id="r-9", aid="01987a55-5555-7000-8000-"
              "abcdef012345", canonical="twin"):
        import contextlib
        import io
        posted, waited, dumped = [], [], []
        src = {"twin": self.twin, "junk": {"notes": "not a pipeline"}}[canonical]
        def fake_publish(admin, plid, tag, doc):
            return ({"revision_id": revision, "vresp": {"valid": True}}
                    if revision else None)

        patches = {
            "doc_revision_canonical": lambda client, rid: src,
            "c7_publish": fake_publish,
            "c9_f_post": lambda alice, pid, rev, inputs, idem, label: (
                posted.append((rev, inputs)) or run_id),
            "c9_wait_for_gate": lambda client, pid, rid, cap=900, exclude=(): (
                waited.append((rid, cap, exclude)) or aid),
            "dump_run_evidence": lambda client, rid: dumped.append(rid),
            "run_status": lambda rid: "running",
        }
        orig, buf = {}, io.StringIO()
        for name, fn in patches.items():
            orig[name] = getattr(m, name)
            setattr(m, name, fn)
        try:
            with contextlib.redirect_stdout(buf):
                got = m.c9e_own_gate(self.Client(), object(), self.FACTS, {"aid-1"})
        finally:
            for name, fn in orig.items():
                setattr(m, name, fn)
        return got, buf.getvalue(), posted, waited, dumped

    def test_the_authored_gate_comes_back_with_its_guard_key(self):
        got, out, posted, waited, _dumped = self.drive()
        self.assertEqual(("r-9", "/ship", "/ship_evidence"),
                         (got[0], got[3], got[4]), out)
        self.assertIn("C9e's own revision", got[2])
        self.assertEqual(posted[0][0], "rev-xyz", "the run is C9e's revision, not the twin's")
        self.assertEqual({"goal": "ship", "repository": "app", "hold_seconds": 5},
                         posted[0][1], "fanout is dropped: this revision does not declare it")
        self.assertEqual(waited[0][0], "r-9")
        self.assertLess(waited[0][1], 900, "the scratch graph's waits are its own")
        self.assertIn("PASS  C9e its own revision published", out)

    def test_a_document_that_refuses_publishes_nothing(self):
        got, out, posted, _waited, _d = self.drive(canonical="junk")
        self.assertIsNone(got)
        self.assertEqual([], posted)
        self.assertIn("FAIL  C9e the scratch revision is the twin's pre-gate pair",
                      out, "a refused splice FAILS loudly, it is not a silent skip")

    def test_a_publish_refusal_gaps_with_the_compilers_words(self):
        got, out, posted, _waited, _d = self.drive(revision="")
        self.assertIsNone(got)
        self.assertEqual([], posted, "no revision, no run")
        self.assertIn("GAP   C9e its own revision published", out)

    def test_a_gate_that_never_opened_dumps_evidence_and_owns_the_run(self):
        # The run IS C9e's own revision's, so the arm hands it back (with no gate) rather
        # than returning None and letting the caller post a SECOND run on top of it.
        got, out, posted, _waited, dumped = self.drive(aid=None)
        self.assertEqual("r-9", got[0])
        self.assertIsNone(got[1], "no gate: the caller GAPs the rejection leg")
        self.assertEqual("rev-xyz", posted[0][0], "the run WAS posted; the gate is what failed")
        self.assertEqual(["r-9"], dumped, "the run that never waited is dumped, not dropped")
        self.assertIn("C9e its own revision never opened a gate", out)


class C9eRunInputsTest(unittest.TestCase):
    """c9e_run_inputs: the scratch run posts the DECLARED slice of the twin's inputs.
    The revision drops the nodes that read fanout/fanout_count, and the compiler
    refuses an input its pipeline does not declare (C5h's 1c190fe refusal)."""

    def test_only_declared_members_are_sent(self):
        r = m.c9e_run_inputs({"goal": "g", "repository": "app", "fanout": False,
                             "fanout_count": 25, "hold_seconds": 0},
                            ["goal", "repository", "hold_seconds"], ["goal", "repository"])
        self.assertEqual({"goal": "g", "repository": "app", "hold_seconds": 0}, r["inputs"])
        self.assertEqual(["fanout", "fanout_count"], r["dropped"])
        self.assertEqual([], r["missing"])

    def test_a_missing_required_input_is_a_reason_not_a_default(self):
        r = m.c9e_run_inputs({"repository": "app"}, ["goal", "repository"],
                             ["goal", "repository"])
        self.assertIsNone(r["inputs"])
        self.assertEqual(["goal"], r["missing"])

    def test_an_absent_manifest_block_reads_as_missing_not_as_empty(self):
        for junk in (None, "goal", []):
            r = m.c9e_run_inputs(junk, ["goal"], ["goal"])
            self.assertIsNone(r["inputs"], junk)
            self.assertEqual(["goal"], r["missing"], junk)



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
    """§ 7.1 C9f's 'the run's other branches keep running: the sample's /plan artifact
    is still readable … while an unrelated gate waits'. The seed's `publish_plan` node
    (docs/compatibility/probes/m4/pipeline.yaml, both documents — /plan → publish_plan →
    /approve) is what puts a readable row in the ledger BEFORE the gate opens, so these
    tests carry that node's ledger row and the name it publishes."""
    PLAN = {"status": "succeeded", "outputs_present": "t"}
    PUB = {"status": "succeeded", "outputs_present": "t"}
    PLAN_ART = {"id": "a1", "name": m.C9F_PLAN_ARTIFACT}

    def test_plan_outputs_and_a_readable_plan_artifact_pass(self):
        v = m.c9f_branch_verdicts(self.PLAN, [self.PLAN_ART], {"a1": 200},
                                  run_status_during="waiting_human", publisher=self.PUB)
        self.assertTrue(all(ok for _, ok, _ in v), v)
        self.assertEqual(3, len(v), v)
        self.assertIn(m.C9F_PLAN_ARTIFACT, " ".join(l for l, _, _ in v))

    def test_a_succeeded_publisher_with_no_artifact_row_is_a_fail(self):
        """The node ran and the ledger holds nothing: that is the product losing the
        publication, not a case the seed failed to author."""
        v = m.c9f_branch_verdicts(self.PLAN, [], {}, publisher=self.PUB)
        self.assertTrue(ok_of(v, "/plan is succeeded"), v)
        self.assertIs(False, ok_of(v, "artifact is still readable"), v)
        self.assertIn("succeeded", detail_of(v, "artifact is still readable"))

    def test_zero_rows_gap_only_while_nothing_upstream_of_the_gate_published(self):
        for pub in ({}, {"status": "running"}, {"status": "pending"}, None):
            v = m.c9f_branch_verdicts(self.PLAN, [], {}, publisher=pub)
            self.assertIsNone(ok_of(v, "artifact is still readable"), (pub, v))

    def test_a_publisher_that_ended_any_other_way_did_not_land_the_artifact(self):
        for status in ("failed", "skipped", "cancelled", "interrupted"):
            v = m.c9f_branch_verdicts(self.PLAN, [], {},
                                      publisher={"status": status})
            self.assertIs(False, ok_of(v, "artifact is still readable"), (status, v))

    def test_an_unreadable_artifact_fails(self):
        v = m.c9f_branch_verdicts(self.PLAN,
                                  [self.PLAN_ART, {"id": "a2", "name": "other.json"}],
                                  {"a1": 200, "a2": 404}, publisher=self.PUB)
        self.assertFalse(ok_of(v, "artifact is still readable"), v)

    def test_rows_that_are_not_the_plan_evidence_do_not_satisfy_the_name_arm(self):
        """A non-empty ledger is not the arm: § 7.1 names the /plan artifact, so a run
        whose only pre-gate row came from somewhere else still fails this verdict."""
        v = m.c9f_branch_verdicts(self.PLAN, [{"id": "a1", "name": "something-else.json"}],
                                  {"a1": 200}, publisher=self.PUB)
        self.assertTrue(ok_of(v, "artifact is still readable"), v)
        self.assertIs(False, ok_of(v, "IS the plan evidence"), v)

    def test_the_name_arm_gaps_when_the_publisher_row_was_never_read(self):
        v = m.c9f_branch_verdicts(self.PLAN, [self.PLAN_ART], {"a1": 200})
        self.assertIsNone(ok_of(v, "IS the plan evidence"), v)

    def test_a_missing_artifact_read_gaps(self):
        v = m.c9f_branch_verdicts(self.PLAN, None, {}, publisher=self.PUB)
        self.assertIsNone(ok_of(v, "artifact is still readable"), v)

    def test_no_plan_row_gaps_its_own_arm(self):
        for row in (None, {}, "x"):
            v = m.c9f_branch_verdicts(row, [self.PLAN_ART], {"a1": 200}, publisher=self.PUB)
            self.assertIsNone(ok_of(v, "/plan is succeeded"), (row, v))

    def test_a_plan_row_that_is_not_succeeded_fails(self):
        self.assertFalse(ok_of(m.c9f_branch_verdicts(
            {"status": "running", "outputs_present": "f"}, [], [], publisher=self.PUB),
            "/plan is succeeded"))


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


class FDeadlinePairTest(unittest.TestCase):
    """The expire arm's deadline pair, measured as the row's OWN deadline_at
    instants (before at gate-open, after once the re-request's journal row is
    visible). The algebra is pure here; the live reads stay with the driver —
    a green here never substitutes for the measured verdict (12-strategy)."""

    ROWS = [{"on_timeout": "expire", "re_requested": "t"}]

    def test_a_second_window_later_than_the_first_moved(self):
        self.assertIs(m.c9_f_deadline_pair_moved(1000.0, 1060.5, True, "pending"), True)

    def test_a_deadline_that_never_moved_is_measured_as_not_moved(self):
        # Same instant on the row after the re-request as before it — the
        # verdict FAILS; a re-request that moved nothing is the product bug
        # this pair exists to catch, never a GAP.
        self.assertIs(m.c9_f_deadline_pair_moved(1000.0, 1000.0, True, "pending"), False)

    def test_a_deadline_moved_backwards_is_not_a_second_window(self):
        self.assertIs(m.c9_f_deadline_pair_moved(1000.0, 999.5, True, "pending"), False)

    def test_no_before_capture_gaps_rather_than_reading_zero(self):
        self.assertIsNone(m.c9_f_deadline_pair_moved(None, 1060.0, True, "pending"))

    def test_an_unreadable_after_instant_gaps(self):
        self.assertIsNone(m.c9_f_deadline_pair_moved(1000.0, None, True, "pending"))

    def test_an_after_read_before_the_re_request_landed_gaps(self):
        # re_requested still false on the row: the move has not happened yet —
        # there is nothing to compare, which is a GAP, not a FAIL.
        self.assertIsNone(m.c9_f_deadline_pair_moved(1000.0, 1060.0, False, "pending"))

    def test_an_after_read_after_the_final_expiry_gaps(self):
        # Expire rewrites deadline_at to the expiry instant when the gate goes
        # final 'expired'; such a read cannot be attributed to the re-request.
        self.assertIsNone(m.c9_f_deadline_pair_moved(1000.0, 1120.0, True, "expired"))

    def test_instants_read_as_psql_text_still_compare_as_instants(self):
        self.assertIs(m.c9_f_deadline_pair_moved("1000.1", "1060.2", True, "pending"), True)

    def test_the_measured_pair_flows_through_the_rerequest_verdict(self):
        v = m.c9f_rerequest_verdicts(snap(), "t", self.ROWS, True,
                                     deadline_detail="before=1.0 after=61.0")
        self.assertTrue(ok_of(v, "moved the deadline"), v)
        self.assertIn("before=1.0 after=61.0", detail_of(v, "moved the deadline"))

    def test_an_unmeasured_pair_gaps_the_verdict(self):
        v = m.c9f_rerequest_verdicts(snap(), "t", self.ROWS, None)
        self.assertIsNone(ok_of(v, "moved the deadline"), v)

    def test_a_pair_measured_as_unmoved_fails_the_verdict(self):
        v = m.c9f_rerequest_verdicts(snap(), "t", self.ROWS, False,
                                     deadline_detail="before=1.0 after=1.0")
        self.assertFalse(ok_of(v, "moved the deadline"), v)


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
    """§ 7.1 C9g's last sentence: one journal, rows only added, never a second
    cursor — plus the promise the takeover itself keeps: it JOURNALS the transfer and
    only REQUESTS the turn's cancel (ADR-0016 § 5: 'a takeover cancels without
    pretending the turn finished'), so the turn's terminal is the worker's ack
    (conversation.turn.cancelled) or the reconciler's lease arm
    (conversation.turn.interrupted), never the takeover's own row."""
    TYPES = ["conversation.message.agent", "conversation.control.transferred",
             "conversation.turn.cancelled"]
    CLOSED = {"status": "cancelled", "cancel_requested": "2026-10-16 23:10:11"}

    def test_a_journal_that_grows_on_one_cursor_passes(self):
        v = m.c9g_transcript_verdicts("4100", "4137", self.TYPES, [], self.CLOSED, 120)
        self.assertTrue(all(ok for _, ok, _ in v), v)

    def test_the_reconciler_word_for_the_turn_counts_too(self):
        # The takeover already interrupted the attempt, so the worker's next renew
        # is ErrLeaseLost and it writes NOTHING: in practice the reconciler's lease
        # arm closes the turn ~50 s later. The arm must read that as the answered
        # request it is, not as a missing conversation.turn.cancelled.
        types = ["conversation.control.transferred", "conversation.turn.interrupted"]
        v = m.c9g_transcript_verdicts("4100", "4137", types, [],
                                      {"status": "interrupted"}, 120)
        self.assertTrue(ok_of(v, "honest terminal"), v)
        self.assertTrue(ok_of(v, "control.transferred"), v)

    def test_a_shrinking_transcript_fails(self):
        self.assertFalse(ok_of(m.c9g_transcript_verdicts(
            "4137", "4100", self.TYPES, [], self.CLOSED, 120), "domain_events journal"))

    def test_a_missing_takeover_row_fails_the_control_arm(self):
        v = m.c9g_transcript_verdicts("4100", "4137", ["conversation.message.agent"], [],
                                      self.CLOSED, 120)
        self.assertFalse(ok_of(v, "control.transferred"), v)

    def test_a_turn_still_live_after_the_full_wait_fails(self):
        # 90 s of waiting covers 30 s lease + 10 s renew + 5 s pass + 5 s safety:
        # a turn still leased past that is a request nobody ever answered, and it is
        # the row conversation_turns_one_active_idx then refuses the retry against.
        v = m.c9g_transcript_verdicts("4100", "4137", ["conversation.control.transferred"],
                                      [], {"status": "leased"}, 120)
        self.assertFalse(ok_of(v, "honest terminal"), v)

    def test_a_terminal_turn_row_with_no_journal_row_fails(self):
        v = m.c9g_transcript_verdicts("4100", "4137", ["conversation.control.transferred"],
                                      [], {"status": "cancelled"}, 120)
        self.assertFalse(ok_of(v, "honest terminal"), v)

    def test_a_truncated_wait_gaps_rather_than_fails_the_terminal_arm(self):
        # An unearned FAIL is the gate's own bug: with less than the lease arithmetic
        # the leg has not measured the arm, it has measured its own clock.
        for waited in (None, 0, 20, m.C9G_TURN_CLOSE_MIN_S - 1):
            v = m.c9g_transcript_verdicts("4100", "4137", ["conversation.control.transferred"],
                                         [], {"status": "leased"}, waited)
            self.assertIsNone(ok_of(v, "honest terminal"), f"waited={waited}: {v}")
        # The same read at the full floor is an earned FAIL, not a GAP.
        self.assertFalse(ok_of(m.c9g_transcript_verdicts(
            "4100", "4137", ["conversation.control.transferred"], [],
            {"status": "leased"}, m.C9G_TURN_CLOSE_MIN_S), "honest terminal"))

    def test_a_new_cursor_table_fails_the_last_arm(self):
        v = m.c9g_transcript_verdicts("4100", "4137", self.TYPES, ["run_transcript_cursor"],
                                      self.CLOSED, 120)
        self.assertFalse(ok_of(v, "SECOND transcript cursor"), v)

    def test_unreadable_reads_gap(self):
        v = m.c9g_transcript_verdicts("", "", None, None, None, None)
        self.assertEqual([ok for _, ok, _ in v], [None, None, None, None], v)


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


class ArmWindowTest(unittest.TestCase):
    """The C9f/C9g arms are only wired in if they fit the gate's wall clock: the
    harness cuts ONE gate at 1500 s and D7's finding is that over-budget caps are
    TRUNCATED mid-poll without even a GAP. So the call site bounds the windows and
    falls back to the old GAP when they cannot fit — never a half-measurement."""

    def test_an_unstamped_budget_bounds_nothing(self):
        self.assertIsNone(m.CTX.get("c9_started"), "the envelope must be per-gate")
        self.assertIsNone(m.c9_budget_left(""))
        self.assertEqual(m.c9f_arm_windows(None), (m.C9F_ARM_WAIT_S, m.C9F_EXPIRE_WAIT_S))
        self.assertEqual(m.c9g_windows(None),
                         (m.C9G_WINDOW_S, m.C9G_CLOSE_POLL_S, m.C9G_RESUME_POLL_S))

    def test_a_fresh_budget_runs_the_arms_on_their_authored_windows(self):
        self.assertEqual(m.c9f_arm_windows(m.C9_BUDGET_S),
                         (m.C9F_ARM_WAIT_S, m.C9F_EXPIRE_WAIT_S))
        live, close, resume = m.c9g_windows(m.C9_BUDGET_S)
        self.assertEqual((close, resume), (m.C9G_CLOSE_POLL_S, 276))
        self.assertLessEqual(live, m.C9G_WINDOW_S)
        self.assertGreaterEqual(live, m.C9G_WINDOW_FLOOR_S)

    def test_a_tight_budget_trims_toward_the_floors_and_never_below(self):
        # 3 arms x (62 + 122) is the floor of the C9f leg; just above it the windows
        # must BE the floors, and below it the leg must refuse rather than truncate.
        fit = 3 * (m.C9F_ARM_FLOOR_S + m.C9F_EXPIRE_FLOOR_S)
        self.assertEqual(m.c9f_arm_windows(fit), (m.C9F_ARM_FLOOR_S, m.C9F_EXPIRE_FLOOR_S))
        self.assertIsNone(m.c9f_arm_windows(fit - 1))
        self.assertLess(m.c9f_arm_windows(m.C9_BUDGET_S // 2),
                        (m.C9F_ARM_WAIT_S, m.C9F_EXPIRE_WAIT_S))
        self.assertIsNone(m.c9g_windows(600))
        self.assertLess(m.c9g_windows(900)[0], m.C9G_WINDOW_S)
        self.assertGreaterEqual(m.c9g_windows(900)[0], m.C9G_WINDOW_FLOOR_S)

    def test_the_clamp_is_given_back(self):
        before = (m.C9F_ARM_WAIT_S, m.C9F_EXPIRE_WAIT_S)
        prev = m.c9_clamp_windows({"C9F_ARM_WAIT_S": 70, "C9F_EXPIRE_WAIT_S": None})
        try:
            self.assertEqual(m.C9F_ARM_WAIT_S, 70, "the arm reads it at CALL time")
            self.assertEqual(m.C9F_EXPIRE_WAIT_S, before[1], "None bounds nothing")
        finally:
            m.c9_restore_windows(prev)
        self.assertEqual((m.C9F_ARM_WAIT_S, m.C9F_EXPIRE_WAIT_S), before)


class RunArmProbeTest(unittest.TestCase):
    """c9_run_arm counts the verdict lines an arm printed — the call-site answer to
    "did the arm measure anything, or bail before its first row?" That count is what
    decides whether the OLD GAP is still owed, so it must count every printer the arms
    use and must hand the printers back even when the arm raises."""

    def test_every_printer_counts_and_the_return_is_the_arms(self):
        def arm():
            m.c5_emit([("a", True, ""), ("b", None, "")])
            m.check("c", True, "")
            m.gap("d", "no row")
            return "the arm's value"
        res, lines = m.c9_run_arm(arm)
        self.assertEqual(res, "the arm's value")
        self.assertGreaterEqual(lines, 4)

    def test_a_silent_arm_counts_zero(self):
        _res, lines = m.c9_run_arm(lambda: None)
        self.assertEqual(lines, 0)

    def test_the_printers_survive_a_crashing_arm(self):
        before = {name: getattr(m, name) for name in m.C9_ARM_PRINTERS}
        with self.assertRaises(RuntimeError):
            m.c9_run_arm(self._boom)
        self.assertEqual({name: getattr(m, name) for name in m.C9_ARM_PRINTERS}, before)

    @staticmethod
    def _boom():
        raise RuntimeError("the arm died")


class WiredArmsTest(unittest.TestCase):
    """c9() must CALL both late arms. Until this wiring the live report still printed
    the old "the deadline is ARMED only" and "the twin carries no conversation_id"
    GAPs while c9f_deadline_arms() / c9g_takeover() sat uncalled. Everything the stack
    would answer is mocked (unit layer: it proves the WIRING and the fallback, never
    the measurement — 12-test-strategy.md), and the two arms are recorders."""

    FACTS = {"project_id": "p-1", "pipeline_id": "pl-1", "revision_id": "rev-1",
             "users": {"alice": "u-alice", "bob": "u-bob"}}

    class Resp:
        def __init__(self, status, payload=None, text=""):
            self.status, self._payload = status, payload or {}
            self.text = text or str(payload or "")
            self.headers = {"Content-Type": "application/json"}

        def json(self):
            return self._payload

    class Client:
        """Enough of Client for c9()'s GETs — no sockets, no login flow."""

        def __init__(self, who, routes):
            self.who, self.routes = who, routes

        def get(self, base, path, **kw):
            for needle, resp in self.routes.items():
                if needle in path:
                    return resp
            return WiredArmsTest.Resp(404, {"type": "no-route"}, "no-route")

    def drive(self, spent=0.0, arm_verdicts=None, own_gate=None, graph_rows=None):
        """`spent` is the wall clock C9a-C9e burn before the arms are reached: the
        fake clock jumps inside C9e's run-to-terminal wait, which is what the
        envelope is measured against in the real pass."""
        import contextlib
        import io
        import time as time_mod
        calls, orig = [], {}
        clock = {"now": time_mod.time()}
        gate = {"state": "pending", "version": "1", "on_timeout": "fail",
                "re_requested": False}
        sched = {"waiting_approvals": 1, "workers": [{"name": "worker-a",
                                                      "active_attempts": 0}]}
        routes = {"/system/scheduler": self.Resp(200, sched),
                  "/api/v1/approvals/": self.Resp(200, gate)}
        clients = {who: self.Client(who, routes)
                   for who in ("alice", "bob", "admin", "carol", "dan")}
        gates = iter([("r-1", AID, "a mocked pending gate"),
                      ("r-2", AID + "e", "a mocked second gate")])

        def rec(name, tag):
            def fn(*a, **kw):
                calls.append((name, a, kw))
                # An arm that GRADED something emits verdicts; one that bailed at its
                # first precondition prints nothing — the call site tells them apart.
                if arm_verdicts:
                    m.c5_emit(arm_verdicts(tag))
            return fn

        def fake_psql(sql):
            if "extract(epoch FROM (deadline_at - now()))" in sql:
                return "86340"
            if "max(global_seq)" in sql:
                return "10"
            if "count(a.turn_id)" in sql:
                return "0|0"
            if "node.execution_skipped" in sql and "ne.status = 'skipped'" in sql:
                # C9e's skipped-row read, answered so the wiring test can tell the
                # guard's PASS apart from a ledger that never spoke.
                return ("/ship|condition_default\n/ship_evidence|dependency_skipped")
            if "FROM runs WHERE id" in sql:
                return "completed|-"
            return ""

        def fake_acquire(alice, facts, used, label):
            calls.append(("c9_acquire_gate", (alice, facts, used, label), {}))
            return next(gates)

        def fake_own_gate(alice, admin, facts, used):
            """C9e's authored-revision arm: the recorder answers with `own_gate` (None =
            'no revision could be published', which is the twin fallback)."""
            calls.append(("c9e_own_gate", (alice, admin, facts, used), {}))
            return own_gate

        patches = {
            "login": lambda c: {"id": f"u-{c.who}"},
            "psql": fake_psql,
            "run": lambda cmd, **kw: (0, "Container m4-worker-a-1  Started"),
            "wait_worker_row": lambda name, timeout=120: ("c-1", name),
            "c9_manifest_json": lambda: {},
            "c9_manifest_users": lambda obj: {},
            "c9_acquire_gate": fake_acquire,
            "c9e_own_gate": fake_own_gate,
            "c9e_graph_rows": lambda run_id: dict(graph_rows or {}),
            "c9_gate_row": lambda aid: dict(zip(m.C9_SNAP_COLS, [
                "pending", "1", "-", "-", "waiting", "-", "-", "0", "waiting_human"])),
            "c9_live_attempts": lambda run_id=None: "0",
            "c9_journal_seq": lambda: "10",
            "c9_role_of": lambda pid, uid: "contributor" if uid == "u-bob" else "maintainer",
            "c9_decide": lambda client, aid, decision, version, comments: {
                "who": client.who, "status": 200 if decision == "rejected" else 403,
                "ctype": "application/problem+json", "body": {"type": "x"}},
            "c9_decide_race": lambda clients_, aid, decision, version: (
                [{"who": c.who, "status": 200 if i == 0 else 409,
                  "ctype": "application/json", "body": {}} for i, c in enumerate(clients_)],
                []),
            "c9_denied_reasons": lambda *a, **kw: ["not_a_designated_approver"],
            "c9_lab_write": lambda sql, why: (0, ""),
            "c9_restore_member": lambda *a, **kw: None,
            "c9_run_to_terminal": lambda run_id, cap, client, label: (
                clock.update(now=clock["now"] + spent) or "completed"),
            "dump_run_evidence": lambda client, run_id: None,
            "c9f_deadline_arms": rec("c9f_deadline_arms", "C9f armed"),
            "c9g_takeover": rec("c9g_takeover", "C9g paused"),
        }
        saved = dict(m.CTX)
        for name, fn in patches.items():
            orig[name] = getattr(m, name)
            setattr(m, name, fn)
        m.CTX.update({"stack_up": True, "manifest": self.FACTS,
                      "alice": clients["alice"], "bob": clients["bob"],
                      "admin": clients["admin"], "carol": clients["carol"],
                      "dan": clients["dan"]})
        buf, fails, gaps = io.StringIO(), list(m.FAILURES), list(m.GAPS)
        sleep, real_time = time_mod.sleep, time_mod.time
        time_mod.sleep = lambda s: None
        time_mod.time = lambda: clock["now"]
        try:
            with contextlib.redirect_stdout(buf):
                m.c9()
        finally:
            time_mod.sleep, time_mod.time = sleep, real_time
            m.FAILURES[:], m.GAPS[:] = fails, gaps
            m.CTX.clear()
            m.CTX.update(saved)
            for name, fn in orig.items():
                setattr(m, name, fn)
        return calls, buf.getvalue()

    @staticmethod
    def _arms(calls):
        """Only the two LATE arms the envelope bounds — the gate acquirers run earlier
        and are recorded for the C9e wiring tests, not for the budget assertion."""
        return [c[0] for c in calls if c[0] in ("c9f_deadline_arms", "c9g_takeover")]

    def test_c9_invokes_both_arms_with_the_clients_and_facts_it_has(self):
        calls, out = self.drive()
        names = [c[0] for c in calls]
        self.assertEqual(names.count("c9f_deadline_arms"), 1, out[-400:])
        self.assertEqual(names.count("c9g_takeover"), 1, out[-400:])
        f = [c for c in calls if c[0] == "c9f_deadline_arms"][0][1]
        self.assertEqual([c.who for c in f[:2]], ["alice", "admin"])
        self.assertIs(f[2], self.FACTS)
        g = [c for c in calls if c[0] == "c9g_takeover"][0][1]
        self.assertEqual(g[0].who, "alice")
        self.assertIs(g[1], self.FACTS)
        self.assertLess(names.index("c9f_deadline_arms"), names.index("c9g_takeover"),
                        "C9f's arms run after C9e and before the takeover leg")

    def test_the_old_gap_is_the_fallback_when_an_arm_emits_nothing(self):
        # The recorder above emits no verdict at all, so BOTH old GAPs must print —
        # and only because the arm measured nothing.
        _calls, out = self.drive()
        self.assertIn("GAP   C9f the three on_timeout arms", out)
        self.assertIn("GAP   C9g human takeover of a run conversation", out)

    def test_no_old_gap_when_the_arms_graded_something(self):
        _calls, out = self.drive(arm_verdicts=lambda tag: [(tag, True, "measured")])
        self.assertNotIn("GAP   C9f the three on_timeout arms", out)
        self.assertNotIn("GAP   C9g human takeover of a run conversation", out)
        self.assertIn("C9f armed", out)
        self.assertIn("C9g paused", out)

    OWN = ("r-own", AID + "e", "C9e's own revision abc12345 (/plan + /approve + /ship)",
           "/ship", "/ship_evidence")
    GRAPH = {"/plan": {"status": "succeeded", "reason": "-", "attempts": "1",
                       "outcome": "-", "error_class": "-", "outputs_present": "t"},
             "/approve": {"status": "succeeded", "reason": "-", "attempts": "0",
                          "outcome": "rejected", "error_class": "-", "outputs_present": "t"},
             "/ship": {"status": "skipped", "reason": "condition_default", "attempts": "0",
                       "outcome": "-", "error_class": "-", "outputs_present": "f"},
             "/ship_evidence": {"status": "skipped", "reason": "dependency_skipped",
                                "attempts": "0", "outcome": "-", "error_class": "-",
                                "outputs_present": "f"}}

    def test_a_started_run_is_never_piled_onto_a_second_one(self):
        # c9e_acquire_gate falls back ONLY when no run existed to measure.
        calls, out = self.drive(own_gate=("r-own", None, "its own run never opened", None,
                                         None))
        names = [c[0] for c in calls]
        self.assertEqual(names.count("c9_acquire_gate"), 1,
                         f"a second run behind a stalled one: {names}")
        self.assertIn("GAP   C9e rejection is a business outcome", out)

    def test_c9e_asks_for_its_own_revision_before_the_seed_twin(self):
        # The GAP this wiring closes: C9e used to reject whatever gate the lab happened
        # to hold, on a graph that guards nothing on the decision. It now asks the
        # authored-revision arm FIRST and only falls back when that arm says it got
        # nowhere — and the fallback is printed, not hidden.
        calls, out = self.drive()
        names = [c[0] for c in calls]
        self.assertEqual(names.count("c9e_own_gate"), 1, out[-400:])
        self.assertEqual(names.count("c9_acquire_gate"), 2,
                         f"C9a takes one twin gate, C9e the fallback twin gate: {names}")
        self.assertIn("GAP   C9e a dependant guarded on nodes.approve.outputs.decision",
                      out, "the fallback must GAP the dependant arm, never PASS on the "
                           "fan-out pair's rows")
        self.assertIn("  NOTE  C9e its own revision carries the guarded dependant", out,
                      "the missing precondition is said once; the CLAIM above is the GAP")

    def test_the_authored_gate_replaces_the_twin_run_and_grades_the_guard(self):
        calls, out = self.drive(own_gate=self.OWN, graph_rows=self.GRAPH)
        names = [c[0] for c in calls]
        self.assertEqual(names.count("c9_acquire_gate"), 1,
                         f"only C9a should need the seed's twin: {names}")
        self.assertNotIn("GAP   C9e a dependant guarded on nodes.approve.outputs.decision",
                         out)
        self.assertIn("PASS  C9e the dependant guarded on",
                      out, "the guard's own row is the verdict now")
        self.assertIn("PASS  C9e /ship NEVER RAN", out)
        self.assertIn("PASS  C9e the skip PROPAGATES", out)

    def test_no_wall_clock_left_falls_back_without_truncating_the_arms(self):
        calls, out = self.drive(spent=m.C9_BUDGET_S - 60)
        self.assertEqual(self._arms(calls), [],
                         "an arm that cannot fit the envelope is not started at all")
        self.assertIn("envelope is left", out)
        self.assertIn("GAP   C9f the three on_timeout arms", out)
        self.assertIn("GAP   C9g human takeover of a run conversation", out)


if __name__ == "__main__":
    unittest.main(verbosity=2 if "-v" in sys.argv else 1)
