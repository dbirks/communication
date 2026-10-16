#!/usr/bin/env python3
"""test_c5_logic.py — offline unit proof for e2e_m4_exit.py's C5 pure logic.

Runs WITHOUT a stack (stdlib unittest only): the interrupted-by-lease-expiry
verdicts, the durable-boundary-survived-the-kill rule, the same-volume reclaim
rule, THE central one — "the retry resumed from the last checkpoint" read off
canned attempt + checkpoint rows (PASS / FAIL / GAP) — the append-not-overwrite
history rule, continue_workspace's HEAD/dirty rule, the final-state rule and the
maxAttempts budget arm. A green here means the VERDICT ALGEBRA is right; it never
substitutes for C5's live kill of a real worker container (12-test-strategy.md:
"validated state after crash/retry" is only proven by really killing one).

usage: python3 e2e/m4/test_c5_logic.py [-v]
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import e2e_m4_exit as m  # noqa: E402 — importing the driver is the point

HEAD = "9f3c1ab2d4e5f60718293a4b5c6d7e8f90a1b2c3"


def attempt(n=1, status="interrupted", error_class="interrupted", ctx=None,
            scheduled="2026-02-20 10:00:00+00"):
    return {"attempt_number": str(n), "status": status, "error_class": error_class,
            "retry_context": ctx if ctx is not None else "-", "scheduled_at": scheduled}


def ctx_json(n=1, error_class="interrupted", head=HEAD, paths=3):
    return ('{"attempt": %d, "error_class": "%s", "head_commit": "%s", '
            '"modified_path_count": %d}' % (n, error_class, head, paths))


def ok_of(verdicts, needle):
    hits = [ok for label, ok, _ in verdicts if needle in label]
    assert hits, f"no verdict matching {needle!r} in {[l for l, _, _ in verdicts]}"
    return hits[0]


def detail_of(verdicts, needle):
    return [d for label, _, d in verdicts if needle in label][0]


class EmitTest(unittest.TestCase):
    def tearDown(self):
        del m.FAILURES[:], m.GAPS[:], m.SKIPPED[:]

    def test_none_is_a_gap_not_a_pass(self):
        m.CTX.pop("c5", None)
        m.c5_emit([("x: no precondition", None, "the lab shipped no such node")])
        self.assertEqual(m.GAPS, ["x: no precondition: the lab shipped no such node"])
        self.assertEqual(m.FAILURES, [])

    def test_true_and_false_are_check(self):
        m.c5_emit([("y: holds", True, ""), ("z: broken", False, "observed 'failed'")])
        self.assertEqual(m.FAILURES, ["z: broken"])
        self.assertEqual(m.GAPS, [])


class CheckpointSetTest(unittest.TestCase):
    def test_sorted_ne_digest_pairs(self):
        self.assertEqual(
            m.c5_checkpoint_set("ne2|sha256:bb\nne1|sha256:aa\nNOTICE: x"),
            ["ne1:sha256:aa", "ne2:sha256:bb"])

    def test_empty_ledger_is_an_empty_set(self):
        self.assertEqual(m.c5_checkpoint_set(""), [])

    def test_parse_retry_context_rejects_garbage_as_none(self):
        self.assertIsNone(m.c5_parse_retry_context("-"))
        self.assertIsNone(m.c5_parse_retry_context("NULL"))
        self.assertIsNone(m.c5_parse_retry_context("{oops"))
        self.assertIsNone(m.c5_parse_retry_context("[1,2]"))
        self.assertEqual(m.c5_parse_retry_context('{"attempt": 1}'), {"attempt": 1})


class InterruptedTest(unittest.TestCase):
    def test_interrupted_by_lease_expiry_passes(self):
        v = m.c5_interrupted_verdicts({"status": "interrupted", "error_class": "interrupted"})
        self.assertTrue(all(ok for _, ok, _ in v), v)

    def test_a_dead_attempt_marked_failed_is_a_fail(self):
        v = m.c5_interrupted_verdicts({"status": "failed", "error_class": "process_exit"})
        self.assertFalse(ok_of(v, "is interrupted"))
        self.assertFalse(ok_of(v, "error_class=interrupted"))

    def test_missing_row_gaps(self):
        self.assertIsNone(ok_of(m.c5_interrupted_verdicts({}), "readable"))


class JournalTest(unittest.TestCase):
    def rows(self, typ="node.attempt.interrupted", reason="lease_expired",
             actor="system", extra=()):
        rows = [{"type": typ, "actor_kind": actor, "reason": reason}]
        return rows + [{"type": t, "actor_kind": "system", "reason": "-"} for t in extra]

    def test_clean_interruption_passes(self):
        v = m.c5_journal_verdicts(self.rows(extra=("node.attempt.retry_scheduled",)), "running")
        self.assertTrue(all(ok for _, ok, _ in v), v)

    def test_completed_event_for_a_killed_attempt_is_a_fail(self):
        v = m.c5_journal_verdicts(self.rows(extra=("node.attempt.completed",)), "running")
        self.assertFalse(ok_of(v, "NO node.attempt.completed"))

    def test_wrong_reason_or_actor_is_a_fail_not_an_implicit_pass(self):
        self.assertFalse(ok_of(m.c5_journal_verdicts(self.rows(reason="user_cancelled"),
                                                    "running"), "lease_expired"))
        self.assertFalse(ok_of(m.c5_journal_verdicts(self.rows(actor="user"), "running"),
                               "lease_expired"))
        self.assertFalse(ok_of(m.c5_journal_verdicts([], "running"), "lease_expired"))

    def test_run_must_be_running_or_interrupted(self):
        self.assertTrue(ok_of(m.c5_journal_verdicts(self.rows(), "interrupted"), "running'"))
        self.assertFalse(ok_of(m.c5_journal_verdicts(self.rows(), "completed"), "running'"))


class BoundaryTest(unittest.TestCase):
    before = ["ne1:sha256:" + "a" * 64, "ne2:sha256:" + "b" * 64]

    def test_identical_boundary_passes(self):
        v = m.c5_boundary_verdicts(self.before, list(self.before), "7", "7", "0")
        self.assertTrue(all(ok for _, ok, _ in v), v)

    def test_lost_checkpoint_row_is_a_fail(self):
        v = m.c5_boundary_verdicts(self.before, self.before[:1], "7", "7", "0")
        self.assertFalse(ok_of(v, "IDENTICAL"))
        self.assertFalse(ok_of(v, "queryable"))

    def test_changed_digest_is_a_fail(self):
        v = m.c5_boundary_verdicts(self.before, self.before[:1] + ["ne2:sha256:" + "c" * 64],
                                   "7", "7", "0")
        self.assertFalse(ok_of(v, "IDENTICAL"))

    def test_no_boundary_before_the_kill_gaps_the_arm(self):
        v = m.c5_boundary_verdicts([], [], "0", "0", "0")
        self.assertIsNone(ok_of(v, "durable checkpoint boundary"))
        self.assertIn("0 run_checkpoints rows", detail_of(v, "durable checkpoint boundary"))

    def test_artifact_moves_are_caught(self):
        self.assertFalse(ok_of(m.c5_boundary_verdicts(self.before, list(self.before),
                                                      "7", "6", "0"), "ready artifact count"))
        self.assertFalse(ok_of(m.c5_boundary_verdicts(self.before, list(self.before),
                                                      "7", "7", "2"), "'uploading'"))
        # an unparseable count never reads as a clean zero
        self.assertFalse(ok_of(m.c5_boundary_verdicts(self.before, list(self.before),
                                                      "7", "7", "?"), "'uploading'"))


class WorkspaceReclaimTest(unittest.TestCase):
    def test_same_volume_reclaim_passes(self):
        v = m.c5_workspace_verdicts({"state": "ready", "volume_id": "sha256:" + "v" * 64},
                                    {"state": "ready", "volume_id": "sha256:" + "v" * 64},
                                    [{"type": "workspace.reclaimed", "reason": "-"}])
        self.assertTrue(all(ok for _, ok, _ in v), v)

    def test_new_volume_is_a_fail_not_a_reclaim(self):
        v = m.c5_workspace_verdicts({"state": "ready", "volume_id": "sha256:" + "v" * 64},
                                    {"state": "ready", "volume_id": "sha256:" + "w" * 64}, [])
        self.assertFalse(ok_of(v, "volume_id unchanged"))

    def test_recovery_lost_event_is_caught(self):
        v = m.c5_workspace_verdicts({"state": "ready", "volume_id": "x"},
                                    {"state": "ready", "volume_id": "x"},
                                    [{"type": "workspace.recovery_lost",
                                      "reason": "volume_changed"}])
        self.assertFalse(ok_of(v, "recovery_lost"))

    def test_missing_workspace_row_gaps(self):
        self.assertIsNone(ok_of(m.c5_workspace_verdicts({}, {}, []), "same volume"))
        self.assertIsNone(ok_of(m.c5_workspace_verdicts({"state": "ready"},
                                                       {"state": "ready", "volume_id": "  "},
                                                       []), "same volume"))


class RetryFromCheckpointTest(unittest.TestCase):
    """The gate's central question: did attempt 2 resume FROM the boundary?"""

    def test_resume_from_checkpoint_passes(self):
        v = m.c5_retry_row_verdicts([attempt(), attempt(2, "running", "-", ctx_json())],
                                    HEAD, "3")
        self.assertTrue(all(ok for _, ok, _ in v), v)
        self.assertTrue(ok_of(v, "resumed FROM the checkpoint"))

    def test_head_from_scratch_fails_the_central_claim(self):
        v = m.c5_retry_row_verdicts([attempt(), attempt(2, "running", "-",
                                                       ctx_json(head="0" * 40))], HEAD, "3")
        self.assertFalse(ok_of(v, "resumed FROM the checkpoint"))

    def test_missing_retry_context_gaps_rather_than_fabricates(self):
        v = m.c5_retry_row_verdicts([attempt(), attempt(2, "running")], HEAD, "3")
        self.assertIsNone(ok_of(v, "carries retry_context"))
        self.assertEqual([l for l, _, _ in v if "resumed FROM the checkpoint" in l], [],
                         "no head_commit may be verdicted when retry_context is absent")

    def test_retry_context_without_a_head_gaps_that_arm(self):
        v = m.c5_retry_row_verdicts([attempt(), attempt(2, "running", "-",
                                                       '{"attempt": 1, "error_class": '
                                                       '"interrupted"}')], HEAD, "3")
        self.assertFalse(ok_of(v, "resumed FROM the checkpoint"))
        self.assertFalse(ok_of(v, "modified_path_count"))

    def test_no_attempt_two_gaps_the_retry_arm(self):
        v = m.c5_retry_row_verdicts([attempt()], HEAD, "3")
        self.assertIsNone(ok_of(v, "a second attempt exists"))

    def test_attempt_one_still_running_fails(self):
        v = m.c5_retry_row_verdicts([attempt(status="running"), attempt(2, "queued", "-",
                                                                      ctx_json())], HEAD, "3")
        self.assertFalse(ok_of(v, "attempt 1 of that node"))

    def test_no_rows_at_all_gaps(self):
        self.assertIsNone(ok_of(m.c5_retry_row_verdicts([], HEAD, "3"), "attempt rows"))

    def test_unreadable_head_before_gaps_the_boundary_comparison(self):
        v = m.c5_retry_row_verdicts([attempt(), attempt(2, "running", "-", ctx_json())], "", "3")
        self.assertEqual([label for label, _, _ in v
                          if "resumed FROM the checkpoint" in label], [],
                         "the head_commit arm must not be asserted without a recorded HEAD")

    def test_wrong_retry_context_attempt_number_fails(self):
        v = m.c5_retry_row_verdicts([attempt(), attempt(2, "running", "-", ctx_json(n=7))],
                                    HEAD, "3")
        self.assertFalse(ok_of(v, "names the interrupted attempt"))


class RetryApiVerdictsTest(unittest.TestCase):
    def test_two_hundred_passes(self):
        v = m.c5_retry_api_verdicts(200, '{"status":"queued"}', [attempt(2, "queued")])
        self.assertTrue(all(ok for _, ok, _ in v), v)

    def test_budget_already_armed_is_a_gap_with_the_reason(self):
        v = m.c5_retry_api_verdicts(409, '{"error":"run_not_retriable"}',
                                    [attempt(), attempt(2, "running", "-", ctx_json())])
        self.assertIsNone(ok_of(v, "the UI's button"))
        self.assertIn("already armed attempt 2", detail_of(v, "the UI's button"))

    def test_refused_and_nothing_armed_is_a_fail(self):
        v = m.c5_retry_api_verdicts(409, '{"error":"run_not_retriable"}', [attempt()])
        self.assertFalse(ok_of(v, "re-queued the killed node"))

    def test_anything_else_is_a_fail(self):
        self.assertFalse(all(ok for _, ok, _ in m.c5_retry_api_verdicts(500, "oops", [])))
        self.assertFalse(all(ok for _, ok, _ in m.c5_retry_api_verdicts(403, "forbidden",
                                                                       [attempt(2, "queued")])))


class AppendOnlyTest(unittest.TestCase):
    """C5g — 'repeated attempts append, not overwrite' (ADR-0023 § 6) read off the
    ledger the way ADR-0023 § 3 shapes it: an ATTEMPT row is a LEASE, so
    control-plane kinds have none and a when-skipped worker has none either."""

    def row(self, key="/build_until_verified[1]/implement", ne="1", att="2",
            loc="worker", st="succeeded"):
        return {"key": key, "ne": ne, "attempts": att, "location": loc, "status": st}

    def test_one_node_execution_many_attempts_passes(self):
        v = m.c5_append_only_verdicts([
            self.row(att="2"), self.row(key="/build_until_verified[1]/test", att="1")])
        self.assertTrue(all(ok for _, ok, _ in v), v)

    def test_a_second_node_execution_for_one_key_fails(self):
        v = m.c5_append_only_verdicts([self.row(ne="2", att="3")])
        self.assertFalse(ok_of(v, "one node_executions row"))

    def test_a_worker_node_that_ran_with_no_attempt_row_fails(self):
        v = m.c5_append_only_verdicts([self.row(att="0")])
        self.assertFalse(ok_of(v, "one node_executions row"))
        self.assertIn("attempts appended", detail_of(v, "one node_executions row"))

    def test_a_control_plane_node_needs_no_attempt_row(self):
        # live4/C5's seven FAILs: /approve, /fan_out, /verdict, /publish_* and the
        # 00005 CHECK node_executions_control_plane_never_leased say zero is correct.
        for key in ("/approve", "/fan_out", "/verdict", "/publish_verified"):
            v = m.c5_append_only_verdicts([self.row(key=key, att="0", loc="control_plane")])
            self.assertTrue(ok_of(v, "one node_executions row"), v)
            self.assertIn("NO attempt rows", detail_of(v, "one node_executions row"))

    def test_a_control_plane_node_carrying_attempts_is_a_fail(self):
        v = m.c5_append_only_verdicts([self.row(key="/gate", att="1", loc="control_plane")])
        self.assertFalse(ok_of(v, "one node_executions row"))

    def test_a_skipped_node_was_never_attempted(self):
        v = m.c5_append_only_verdicts([self.row(key="/emit_items", att="0", st="skipped")])
        self.assertTrue(ok_of(v, "one node_executions row"), v)
        self.assertIn("never attempted", detail_of(v, "one node_executions row"))

    def test_a_skipped_node_with_attempts_is_a_fail(self):
        v = m.c5_append_only_verdicts([self.row(key="/emit_items", att="1", st="skipped")])
        self.assertFalse(ok_of(v, "one node_executions row"))

    def test_a_node_that_never_ran_needs_nothing_yet(self):
        for st in ("pending", "ready", "waiting"):
            v = m.c5_append_only_verdicts([self.row(att="0", st=st)])
            self.assertTrue(ok_of(v, "one node_executions row"), v)
        # but a not-yet-executed node with attempt rows is still a ledger lie
        self.assertFalse(ok_of(m.c5_append_only_verdicts([self.row(att="3", st="ready")]),
                              "one node_executions row"))

    def test_an_unknown_status_asserts_only_the_single_row(self):
        v = m.c5_append_only_verdicts([self.row(att="0", st="")])
        self.assertTrue(ok_of(v, "one node_executions row"), v)
        self.assertFalse(ok_of(m.c5_append_only_verdicts([self.row(ne="2", att="0", st="")]),
                              "one node_executions row"))


class KillLandedTest(unittest.TestCase):
    """live4/C5's root cause: the twin's /plan step closes in <1s, so a kill issued
    after reading the ledger arrives AFTER the node completed. The gate only earns
    its interrupted-write claims when the freeze proves the lease was live."""

    def test_state_classification(self):
        self.assertEqual(m.c5_attempt_state({"status": "interrupted"}), "interrupted")
        self.assertEqual(m.c5_attempt_state({"status": "succeeded"}), "closed")
        self.assertEqual(m.c5_attempt_state({"status": "running"}), "live")
        self.assertEqual(m.c5_attempt_state({"status": "queued"}), "live")
        self.assertEqual(m.c5_attempt_state({}), "")
        self.assertEqual(m.c5_attempt_state({"status": "waiting"}), "")
        self.assertEqual(m.c5_attempt_state(None), "")

    def test_freeze_proof_needs_the_lease_live_at_and_across_the_signal(self):
        self.assertIs(m.c5_freeze_proof("running", "running"), True)
        self.assertIs(m.c5_freeze_proof("leased", "leased"), True)
        self.assertIs(m.c5_freeze_proof("succeeded", "succeeded"), False)
        self.assertIs(m.c5_freeze_proof("running", "succeeded"), False)
        self.assertIsNone(m.c5_freeze_proof("", "running"))
        self.assertIsNone(m.c5_freeze_proof("running", "waiting"))

    def test_an_interrupted_attempt_after_a_proved_freeze_is_a_pass(self):
        v = m.c5_kill_landed_verdicts("interrupted", 2, True)
        self.assertTrue(all(ok for _, ok, _ in v), v)
        self.assertIn("kill #2", detail_of(v, "died holding a live lease"))

    def test_a_wasted_pick_is_a_gap_never_a_blame(self):
        v = m.c5_kill_landed_verdicts("closed", 4, False)
        self.assertIsNone(ok_of(v, "died holding a live lease"))
        self.assertIn("wasted", detail_of(v, "died holding a live lease"))

    def test_a_terminal_write_that_survived_the_freeze_is_a_fail(self):
        v = m.c5_kill_landed_verdicts("closed", 1, True)
        self.assertFalse(ok_of(v, "died holding a live lease"))

    def test_a_lease_nobody_interrupted_fails_only_when_the_freeze_was_proved(self):
        self.assertFalse(ok_of(m.c5_kill_landed_verdicts("live", 1, True),
                              "died holding a live lease"))
        self.assertIsNone(ok_of(m.c5_kill_landed_verdicts("live", 1, None),
                               "died holding a live lease"))

    def test_an_unreadable_ledger_gaps_the_kill(self):
        self.assertIsNone(ok_of(m.c5_kill_landed_verdicts("", 3, None),
                               "died holding a live lease"))

    def test_a_run_that_stops_offering_live_attempts_gaps_too(self):
        v = m.c5_kill_landed_verdicts("unattainable", 2, False)
        self.assertIsNone(ok_of(v, "died holding a live lease"))
        self.assertIn("idle", detail_of(v, "died holding a live lease"))


class ContinueWorkspaceTest(unittest.TestCase):
    def test_edits_preserved_and_no_restore_event(self):
        v = m.c5_continue_verdicts(HEAD, HEAD, "3", "4", "0")
        self.assertTrue(all(ok for _, ok, _ in v), v)

    def test_reset_worktree_fails(self):
        v = m.c5_continue_verdicts(HEAD, "0" * 40, "3", "0", "0")
        self.assertFalse(ok_of(v, "HEAD_AFTER_RETRY_START"))
        self.assertFalse(ok_of(v, "did not shrink"))

    def test_restore_event_present_means_the_wrong_policy_ran(self):
        v = m.c5_continue_verdicts(HEAD, HEAD, "3", "3", "1")
        self.assertFalse(ok_of(v, "checkpoint_restored"))

    def test_unreadable_worktree_gaps(self):
        v = m.c5_continue_verdicts(HEAD, "", "3", "", "0")
        self.assertIsNone(ok_of(v, "HEAD unchanged"))
        self.assertEqual([l for l, _, _ in m.c5_continue_verdicts("", "", "3", "4", "0")
                          if "did not shrink" in l], [],
                         "nothing is verdicted when HEAD could not be read at all")


class FinalStateTest(unittest.TestCase):
    keys = {"/build_until_verified[1]/implement", "/build_until_verified[1]/test", "/gate"}

    def test_completed_with_c1_identical_keys(self):
        v = m.c5_final_verdicts("completed", self.keys, set(self.keys))
        self.assertTrue(all(ok for _, ok, _ in v), v)

    def test_a_rewritten_history_fails(self):
        v = m.c5_final_verdicts("completed", self.keys, self.keys | {"/extra"})
        self.assertFalse(ok_of(v, "SET identical"))

    def test_iteration_normalised_fallback_reports_the_difference(self):
        other = {"/build_until_verified[2]/implement", "/build_until_verified[2]/test", "/gate"}
        v = m.c5_final_verdicts("completed", self.keys, other)
        self.assertFalse(ok_of(v, "SET identical"))
        self.assertTrue(ok_of(v, "iteration-normalized"))

    def test_no_c1_keys_gaps_the_identity_claim(self):
        self.assertIsNone(ok_of(m.c5_final_verdicts("completed", set(), self.keys),
                               "matches C1's twin run"))

    def test_run_that_did_not_complete_fails(self):
        self.assertFalse(ok_of(m.c5_final_verdicts("failed", self.keys, self.keys),
                              "reached 'completed'"))


class BudgetArmTest(unittest.TestCase):
    def test_limit_one_refusal_fails_the_run_honestly(self):
        v = m.c5_budget_verdicts("1", "failed",
                                 "node_execution_failed:/build_until_verified[1]/implement")
        self.assertTrue(all(ok for _, ok, _ in v), v)

    def test_limit_one_but_run_completed_is_a_fail(self):
        self.assertFalse(ok_of(m.c5_budget_verdicts("1", "completed", "-"), "maxAttempts=1"))

    def test_a_node_authored_with_more_attempts_has_no_precondition_so_gap(self):
        v = m.c5_budget_verdicts("2", "completed", "-")
        self.assertIsNone(ok_of(v, "maxAttempts=1"))
        self.assertIn("attempt_limit=2", detail_of(v, "maxAttempts=1"))

    def test_unreadable_limit_gaps(self):
        self.assertIsNone(ok_of(m.c5_budget_verdicts("", "completed", "-"), "maxAttempts=1"))


class GateFirstSequencingTest(unittest.TestCase):
    """live5/C5 printed `GAP C5a a live attempt to kill — no attempt … was ever
    held by a worker within 300s (status='waiting_human')`: the deterministic
    twin parks at /approve BEFORE its long steps, so nothing leases until someone
    decides the gate. The kill mechanics were fine; the SEQUENCE was missing.
    These tests pin the sequence against a scripted ledger — no container is
    killed here, that stays C5's live leg."""

    LIVE = {"id": "a-1", "key": "/build_until_verified[1]/test", "worker": "worker-a",
            "token": "7", "attempt_number": "1", "turn": "-"}

    class Clock:
        def __init__(self):
            self.now = 1000.0

        def time(self):
            self.now += 1.0
            return self.now

        def sleep(self, secs):
            self.now += secs

    def script(self, statuses, rows, decide=True):
        """Run c5_wait_live_past_gate against canned ledger reads (one status +
        one live-claim row per poll). Returns (result, gate_calls, checks)."""
        calls, checks, pos = [], [], [0]
        pairs = list(zip(statuses, rows))

        def at(i):
            return pairs[min(i, len(pairs) - 1)]

        def run_status(run_id):
            return at(pos[0])[0]

        def live_row(run_id):
            row = at(pos[0])[1]
            pos[0] += 1
            return row

        def approve(client, project_id, run_id):
            calls.append(project_id)
            return decide

        def check(label, ok, detail=""):
            checks.append((label, ok))
            return ok

        orig = (m.time, m.run_status, m.c5_live_attempt_row, m.approve_gate, m.check)
        m.time = self.Clock()
        m.run_status = run_status
        m.c5_live_attempt_row = live_row
        m.approve_gate = approve
        m.check = check
        try:
            out = m.c5_wait_live_past_gate(object(), "p-1", "run-1", 60)
        finally:
            (m.time, m.run_status, m.c5_live_attempt_row, m.approve_gate,
             m.check) = orig
        return out, calls, checks

    def test_gate_is_decided_before_the_driver_waits_for_a_claim(self):
        out, calls, checks = self.script(
            ["waiting_human", "waiting_human", "running"], [None, None, self.LIVE])
        self.assertEqual(out, self.LIVE)
        self.assertEqual(calls, ["p-1"], "exactly one decide attempt once it succeeded")
        self.assertTrue(any("approval gate was decided" in lbl and ok
                            for lbl, ok in checks), str(checks))

    def test_a_live_claim_needs_no_gate_decision(self):
        out, calls, checks = self.script(["running"], [self.LIVE])
        self.assertEqual(out, self.LIVE)
        self.assertEqual(calls, [])

    def test_terminal_run_stops_the_wait_instead_of_burning_the_window(self):
        out, calls, _ = self.script(["failed"], [None])
        self.assertIsNone(out)
        self.assertEqual(calls, [], "a dead run has no gate to decide")

    def test_a_refused_decision_retries_until_the_cap_and_reports_nothing(self):
        out, calls, _ = self.script(["waiting_human"] * 40, [None] * 40, decide=False)
        self.assertIsNone(out)
        self.assertGreater(len(calls), 1, "the decide route is retried, not assumed")

    def test_action_table(self):
        self.assertEqual(m.c5_gate_then_live_action("running", True, False), ("live", False))
        self.assertEqual(m.c5_gate_then_live_action("waiting_human", False, False),
                         ("approve", False))
        self.assertEqual(m.c5_gate_then_live_action("waiting_human", False, True),
                         ("wait", True))
        self.assertEqual(m.c5_gate_then_live_action("completed", False, True),
                         ("terminal", True))
        self.assertEqual(m.c5_gate_then_live_action("queued", False, True), ("wait", True))


if __name__ == "__main__":
    unittest.main(verbosity=2 if "-v" in sys.argv else 1)
