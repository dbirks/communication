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
        self.assertIn("running (retry armed)", detail_of(v, "the UI's button"),
                      "the GAP must quote § 7.1 C5b's own sentence — the engine owns "
                      "this retry, the contract's POST->200 line is the contradiction")

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
    """§ 7.1 C5g: "the run then reaches 'completed' with the same node_instance_key
    set as C1 (a retry appends, it never rewrites history)". The set is compared on
    C1's OWN iteration-normalizer (the [n] suffix counts loop passes, and the
    retried leg is free to pass on a different count — live18/C5 spent 1 iteration
    where C1's twin spent 2), while append-only stays falsifiable in BOTH
    directions: a REMOVED or RENAMED key still FAILS."""

    C1 = {"/gate", "/verdict",
          "/build_until_verified[1]/implement", "/build_until_verified[1]/test",
          "/build_until_verified[1]/review",
          "/build_until_verified[2]/implement", "/build_until_verified[2]/test",
          "/build_until_verified[2]/review"}
    ONE = {"/gate", "/verdict",
           "/build_until_verified[1]/implement", "/build_until_verified[1]/test",
           "/build_until_verified[1]/review"}
    keys = {"/gate", "/build_until_verified[1]/implement", "/build_until_verified[1]/test"}

    def detail(self, v, needle):
        return [d for l, _o, d in v if needle in l][0]

    def test_completed_with_c1_identical_keys(self):
        v = m.c5_final_verdicts("completed", self.C1, set(self.C1))
        self.assertTrue(all(ok for _, ok, _ in v), v)

    def test_a_different_iteration_count_is_not_a_rewritten_history(self):
        """The live18 FAIL: literal sets differed by the whole [2] iteration."""
        v = m.c5_final_verdicts("completed", self.C1, self.ONE)
        self.assertTrue(ok_of(v, "iteration-normalized"), v)
        self.assertTrue(ok_of(v, "no hole"), v)
        self.assertIn("C1's loop spent 2 iteration(s), this run 1",
                      self.detail(v, "iteration-normalized"))

    def test_a_removed_node_key_still_fails(self):
        other = {k for k in self.C1 if not k.endswith("/review")}
        self.assertFalse(ok_of(m.c5_final_verdicts("completed", self.C1, other),
                               "iteration-normalized"))

    def test_a_renamed_node_key_still_fails(self):
        other = {k.replace("/implement", "/impl") for k in self.C1}
        self.assertFalse(ok_of(m.c5_final_verdicts("completed", self.C1, other),
                               "iteration-normalized"))

    def test_an_extra_node_key_still_fails(self):
        self.assertFalse(ok_of(m.c5_final_verdicts("completed", self.C1, self.C1 | {"/extra"}),
                               "iteration-normalized"))

    def test_a_row_deleted_out_of_the_middle_fails_the_history_guard(self):
        """The hole guard is what keeps the claim falsifiable under normalization:
        [*]/test still exists (under [2]), so set equality alone would PASS a run
        whose retry DELETED a node_execution row."""
        other = self.C1 - {"/build_until_verified[1]/test"}
        v = m.c5_final_verdicts("completed", self.C1, other)
        self.assertTrue(ok_of(v, "iteration-normalized"))
        self.assertFalse(ok_of(v, "no hole"))
        self.assertIn("never at [1]", self.detail(v, "no hole"))

        three = self.C1 | {f"/build_until_verified[3]/{n}"
                           for n in ("implement", "test", "review")}
        v = m.c5_final_verdicts("completed", three, three - {"/build_until_verified[2]/test"})
        self.assertTrue(ok_of(v, "iteration-normalized"))
        self.assertFalse(ok_of(v, "no hole"))
        self.assertIn("missing [2]", self.detail(v, "no hole"))

    def test_a_loop_that_did_not_finish_the_last_iteration_leaves_no_hole(self):
        """Rows never written are not rows removed — the guard fires on holes only."""
        self.assertEqual(m.loop_history_holes(self.ONE), [])
        self.assertEqual(m.loop_history_holes({"/build_until_verified[2]/implement"}),
                         ["/build_until_verified[*]/implement: never at [1] "
                          "(present at [2])"])

    def test_no_c1_keys_gaps_the_identity_claim(self):
        self.assertIsNone(ok_of(m.c5_final_verdicts("completed", set(), self.keys),
                               "set is C1's twin set"))

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


class BudgetArmScratchPreconditionTest(unittest.TestCase):
    """live17/C5 (C5h's scratch arms, 0a0d6a9): every § 7.1 C5h row PASSED on the
    gate's own maxAttempts=1 scratch revision, yet the leg still printed the OLD
    twin-budget GAP — "the killed node is authored with attempt_limit=2 in the § 7.0
    twin … no node … has a budget of 1" — and the gate summary counted it (GAP=4).
    The precondition stops being a gap the moment something else measures C5h; it
    only stays a gap while NOTHING does."""

    scratch = [("C5h the scratch node is authored with a budget of 1", True,
                "node_executions.attempt_limit='1'"),
               ("C5h the retry is REFUSED", True, "retry_scheduled=0 attempts=[1]")]

    def tearDown(self):
        del m.FAILURES[:], m.GAPS[:]

    def test_scratch_verdicts_present_the_precondition_is_a_note_not_a_gap(self):
        v = m.c5_budget_verdicts("2", "completed", "-", scratch_ran=True)
        self.assertIs(ok_of(v, "maxAttempts=1"), m.C5_NOTE)
        d = detail_of(v, "maxAttempts=1")
        self.assertIn("scratch", d)
        self.assertIn("attempt_limit=2", d)      # the twin's budget is still explained

    def test_a_note_costs_the_gate_no_gap_and_no_pass(self):
        del m.FAILURES[:], m.GAPS[:]
        m.c5_emit(m.c5_budget_verdicts("2", "completed", "-", scratch_ran=True))
        self.assertEqual(m.GAPS, [])
        self.assertEqual(m.FAILURES, [])

    def test_scratch_arm_that_could_not_run_keeps_the_gap(self):
        for ran in (False, None, []):
            v = m.c5_budget_verdicts("2", "completed", "-", scratch_ran=ran)
            self.assertIsNone(ok_of(v, "maxAttempts=1"), f"scratch_ran={ran!r}")
            self.assertIn("scratch arm produced no verdicts",
                          detail_of(v, "maxAttempts=1"))

    def test_an_unmeasurable_limit_with_a_ran_scratch_arm_is_still_a_note(self):
        self.assertIs(ok_of(m.c5_budget_verdicts("", "completed", "-", scratch_ran=True),
                            "maxAttempts=1"), m.C5_NOTE)

    def test_a_twin_budget_of_one_is_graded_on_the_run_however_scratched(self):
        v = m.c5_budget_verdicts("1", "failed", "node_execution_failed:/implement",
                                 scratch_ran=True)
        self.assertTrue(ok_of(v, "maxAttempts=1"), v)
        self.assertFalse(ok_of(m.c5_budget_verdicts("1", "completed", "-", scratch_ran=True),
                               "maxAttempts=1"))


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

    def script(self, statuses, rows, decide=True, target=None):
        """Run wait_live_past_gate against canned ledger reads (one status +
        one live-claim row per poll). Returns (result, gate_calls, checks).
        `target` is the node the leg aims at (None = C4's 'anything that is live')."""
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
            out = m.wait_live_past_gate(object(), "p-1", "run-1", 60, "C5a", target=target)
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

    def test_a_refused_decision_retries_until_the_cap_and_reports_the_stall(self):
        out, calls, checks = self.script(["waiting_human"] * 40, [None] * 40, decide=False)
        self.assertIsNone(out)
        self.assertGreater(len(calls), 1, "the decide route is retried, not assumed")
        self.assertIn(False, [ok for _lbl, ok in checks],
                      f"a window that ended still waiting_human must be a FAIL, not "
                      f"silence: {checks}")
        self.assertTrue(any(lbl.startswith("C5a ") for lbl, ok in checks if ok is False),
                        str(checks))

    def test_action_table(self):
        self.assertEqual(m.gate_then_live_action("running", True, False), ("live", False))
        self.assertEqual(m.gate_then_live_action("waiting_human", False, False),
                         ("approve", False))
        self.assertEqual(m.gate_then_live_action("waiting_human", False, True),
                         ("wait", True))
        self.assertEqual(m.gate_then_live_action("completed", False, True),
                         ("terminal", True))
        self.assertEqual(m.gate_then_live_action("queued", False, True), ("wait", True))

    def test_a_claim_at_another_node_is_not_the_target(self):
        """live8/C6.out: the kill landed on /plan because the poll took WHATEVER was
        held; /plan is held BEFORE the gate, and the retry then named a node that did
        not exist. With a target, a claim at another node is not 'live'."""
        plan = dict(self.LIVE, key="/plan")
        self.assertEqual(m.gate_then_live_action("running", plan, True, m.C_LIVE_TARGET_KEY),
                         ("wait", True), "a pre-gate /plan claim is waited past, not killed")
        self.assertEqual(m.gate_then_live_action("running", plan, False, m.C_LIVE_TARGET_KEY),
                         ("wait", False), "a held claim somewhere else releases no kill "
                         "and decides no gate — the run is simply not at the target yet")
        held = dict(self.LIVE, key=m.C_LIVE_TARGET_KEY)
        self.assertEqual(m.gate_then_live_action("running", held, True, m.C_LIVE_TARGET_KEY),
                         ("live", True))
        self.assertEqual(m.gate_then_live_action("running", held, True), ("live", True),
                         "no target: C4's behaviour is unchanged — any claim is a claim")

    def test_the_wait_waits_past_a_pre_gate_claim_to_the_target(self):
        """/plan held (hold_seconds), the gate, then the target's own held attempt:
        the wait must return the TARGET row, not the first thing it saw live."""
        out, calls, checks = self.script(
            ["running", "waiting_human", "waiting_human", "running"],
            [dict(self.LIVE, key="/plan"), None, None,
             dict(self.LIVE, key=m.C_LIVE_TARGET_KEY)],
            target=m.C_LIVE_TARGET_KEY)
        self.assertEqual(out["key"], m.C_LIVE_TARGET_KEY, f"returned {out!r}")
        self.assertEqual(calls, ["p-1"], "the gate was decided exactly once")
        self.assertTrue(any("approval gate was decided" in lbl and ok
                            for lbl, ok in checks), str(checks))

    def test_the_poll_of_a_targeted_wait_is_finer_than_2s(self):
        """A 45s hold is only findable if the poll is faster than the steps it is
        chasing; live8/W2.out's 'finish faster than the poll's 2s interval' says the
        2s tick was the driver's own blindness. The targeted tick is a constant."""
        self.assertLess(m.C_LIVE_POLL_S, 2)
        src = open(os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                "e2e_m4_exit.py"), encoding="utf-8").read()
        body = src[src.index("def wait_live_past_gate("):src.index("def c5_kill_landed_verdicts")]
        self.assertIn("tick = C_LIVE_POLL_S if target else 2", body)
        self.assertIn("time.sleep(tick)", body)


class TargetPickerTest(unittest.TestCase):
    """The target-node picker C5/C6/W5/W6 aim their fault at (live8: the kill landed
    on /plan, held BEFORE the approval gate)."""

    def test_default_target_is_the_first_loop_body(self):
        self.assertEqual(m.C_LIVE_TARGET_KEY, "/build_until_verified[1]/implement")
        self.assertEqual(m.C6_KILL_KEY, m.C_LIVE_TARGET_KEY,
                         "one name for the kill's target, not two that can drift")

    def test_no_target_means_any_held_claim(self):
        self.assertTrue(m.live_row_matches_target({"key": "/plan"}))
        self.assertTrue(m.live_row_matches_target({"key": "/plan"}, None))
        self.assertFalse(m.live_row_matches_target(None))
        self.assertFalse(m.live_row_matches_target({}))

    def test_a_target_asks_for_that_node_alone(self):
        self.assertTrue(m.live_row_matches_target({"key": m.C_LIVE_TARGET_KEY},
                                                  m.C_LIVE_TARGET_KEY))
        self.assertFalse(m.live_row_matches_target({"key": "/plan"}, m.C_LIVE_TARGET_KEY))
        self.assertFalse(m.live_row_matches_target({"key": None}, m.C_LIVE_TARGET_KEY),
                         "an unreadable key is not a match — the poll keeps waiting")
        self.assertFalse(m.live_row_matches_target("/plan", m.C_LIVE_TARGET_KEY),
                         "a row without a key field cannot be claimed at the target")

    def test_wait_live_attempt_row_filters_the_ledger_read(self):
        """The read itself stays c5_live_attempt_row's ONE argument (every test in
        test_c4/c5/c6_logic.py patches it with a one-argument stub); the filter is
        applied on the row it returns."""
        seen, plan = [], {"id": "a-1", "key": "/plan", "worker": "worker-a"}

        def fake(run_id):
            seen.append(run_id)
            return plan
        orig = m.c5_live_attempt_row
        m.c5_live_attempt_row = fake
        try:
            self.assertIs(m.wait_live_attempt_row("r-1"), plan, "no target: the row stands")
            self.assertIsNone(m.wait_live_attempt_row("r-1", m.C_LIVE_TARGET_KEY),
                              "with a target, /plan is not a live attempt")
            self.assertEqual(seen, ["r-1", "r-1"], "one ledger read per poll")
        finally:
            m.c5_live_attempt_row = orig


class TargetCallSiteTest(unittest.TestCase):
    """Which legs AIM their wait at a node — read off the driver's own call sites.
    C4 is deliberately absent: it fences whatever lease it catches (live8 proves that
    works for a pause) and its tests pin the no-target behaviour."""

    def kwargs_of(self, fn_name, callee):
        import ast
        tree = ast.parse(open(self.driver(), encoding="utf-8").read())
        out = []
        for node in tree.body:
            if isinstance(node, ast.FunctionDef) and node.name == fn_name:
                for sub in ast.walk(node):
                    if (isinstance(sub, ast.Call) and isinstance(sub.func, ast.Name)
                            and sub.func.id == callee):
                        out.append({k.arg: ast.unparse(k.value) for k in sub.keywords})
        assert out, f"{fn_name} never calls {callee}"
        return out

    def driver(self):
        return os.path.join(os.path.dirname(os.path.abspath(__file__)), "e2e_m4_exit.py")

    def test_the_kill_legs_aim_at_the_target_node(self):
        for fn in ("c5", "c6", "w2"):
            for kw in self.kwargs_of(fn, "wait_live_past_gate"):
                self.assertIn(kw.get("target"), ("C_LIVE_TARGET_KEY", "C6_KILL_KEY"),
                              f"{fn} waits for any held attempt instead of the kill's "
                              f"own node: {kw}")

    def test_c4_keeps_the_any_live_claim_default(self):
        for kw in self.kwargs_of("c4", "wait_live_past_gate"):
            self.assertNotIn("target", kw, "C4's fence lands on whatever lease it catches "
                                           "(it passes 20/1 on live8 — do not move it)")

    def test_the_shared_kill_sequence_aims_at_the_target_too(self):
        import ast
        src = open(self.driver(), encoding="utf-8").read()
        tree = ast.parse(src)
        fn = next(n for n in tree.body
                  if isinstance(n, ast.FunctionDef) and n.name == "w_kill_worker_mid_node")
        self.assertEqual([ast.unparse(d) for d in fn.args.defaults][-1], "C_LIVE_TARGET_KEY",
                         "W5/W6 inherit the kill's target node from the shared sequence")



# --- live11 sequencing fixes: the contract's C5e POST->200 vs C5b "running        #
# (retry armed)" contradiction, the modified_path_count carry states, and the      #
# W6-killer: a one-argument show() inside w_kill_worker_mid_node's finally.        #

C5E_PROBLEM_JSON = ('{"detail":"a running run is not retriable; retry a failed, '
                    'interrupted or cancelled one","run_id":"01a1","run_status":'
                    '"running","status":409,"title":"Run Not Retriable","type":'
                    '"https://communication.dev/errors/run-not-retriable"}')


class RetryApiProblemJsonFormTest(unittest.TestCase):
    """live11/C5.out graded the budget-already-armed 409 as FAIL because the wire
    form is dashed/spaced ("Run Not Retriable", ".../run-not-retriable") and the
    matcher only knew run_not_retriable. The refusal of a run the ENGINE is already
    retrying is a GAP with the contract contradiction stated — never a FAIL of the
    product, and never a forced 200."""

    def test_real_problem_json_body_with_a_budget_armed_retry_is_a_gap(self):
        v = m.c5_retry_api_verdicts(409, C5E_PROBLEM_JSON,
                                    [attempt(), attempt(2, "running", "-", ctx_json())])
        self.assertIsNone(ok_of(v, "the UI's button"))
        d = detail_of(v, "the UI's button")
        self.assertIn("contradicts", d, "the GAP reason must name the contract conflict")
        self.assertIn("running (retry armed)", d)

    def test_run_not_retriable_without_any_retry_is_still_a_fail(self):
        v = m.c5_retry_api_verdicts(409, C5E_PROBLEM_JSON, [attempt()])
        self.assertIs(False, ok_of(v, "re-queued the killed node"))

    def test_detection_covers_every_wire_spelling(self):
        for body in ('{"code":"run_not_retriable"}', C5E_PROBLEM_JSON,
                     '{"type":"https://communication.dev/errors/run-not-retriable"}',
                     '{"title":"Run Not Retriable"}'):
            self.assertTrue(m.c5_run_not_retriable(409, body), body[:60])
        self.assertFalse(m.c5_run_not_retriable(200, C5E_PROBLEM_JSON))
        self.assertFalse(m.c5_run_not_retriable(409, "forbidden"))


class AutoRetryOwnershipTest(unittest.TestCase):
    """C5e on the shipped twin measures the ENGINE's retry (§ 7.1 C5b keeps the
    run 'running (retry armed)' with attempt_limit 2)."""

    def test_engine_armed_retry_passes_the_measured_arm(self):
        v = m.c5_auto_retry_verdicts(1, [attempt(), attempt(2, "queued", "-", ctx_json())],
                                     409)
        self.assertTrue(ok_of(v, "the engine armed the retry"))

    def test_manual_post_200_is_graded_on_the_ui_route(self):
        v = m.c5_auto_retry_verdicts(0, [attempt(), attempt(2, "queued", "-", ctx_json())],
                                     200)
        self.assertTrue(ok_of(v, "the UI's route"))

    def test_scheduled_event_without_an_attempt_two_fails(self):
        v = m.c5_auto_retry_verdicts(1, [attempt()], 409)
        self.assertIs(False, ok_of(v, "the engine armed the retry"))

    def test_no_event_and_no_attempt_is_a_gap(self):
        v = m.c5_auto_retry_verdicts(0, [attempt()], 409)
        self.assertIsNone(ok_of(v, "a retry exists"))


class ModifiedPathCarryStatesTest(unittest.TestCase):
    """The engine carries modified_path_count only from the recorded boundary
    (runtime/retry.go omits a zero count); the verdict must report WHICH of the
    four states was observed instead of reading every absence as one FAIL."""

    def rows(self, ctx, dirty_before):
        return m.c5_retry_row_verdicts([attempt(), attempt(2, "running", "-", ctx)],
                                       HEAD, dirty_before)

    def test_carried_and_equal_passes(self):
        self.assertTrue(ok_of(self.rows(ctx_json(paths=3), "3"), "modified_path_count"))

    def test_carried_but_wrong_fails(self):
        self.assertIs(False, ok_of(self.rows(ctx_json(paths=5), "3"), "modified_path_count"))

    def test_absent_with_a_dirty_worktree_fails(self):
        no_mpc = '{"attempt": 1, "error_class": "interrupted"}'
        self.assertIs(False, ok_of(self.rows(no_mpc, "3"), "modified_path_count"))

    def test_absent_with_a_clean_worktree_is_a_gap_with_the_reason(self):
        no_mpc = '{"attempt": 1, "error_class": "interrupted"}'
        v = self.rows(no_mpc, "0")
        self.assertIsNone(ok_of(v, "modified_path_count"))
        self.assertIn("already written", detail_of(v, "modified_path_count"),
                      "the GAP must name the twin-shape reason (§ 7.1's ~40s node)")

    def test_absent_with_an_unreadable_worktree_is_a_gap(self):
        no_mpc = '{"attempt": 1, "error_class": "interrupted"}'
        for unreadable in ("", None, "-"):
            v = self.rows(no_mpc, unreadable)
            self.assertIsNone(ok_of(v, "modified_path_count"), repr(unreadable))

    def test_carried_but_unreadable_worktree_is_a_gap(self):
        v = self.rows(ctx_json(paths=2), "")
        self.assertIsNone(ok_of(v, "modified_path_count"),
                          "a carried number cannot be CHECKED against a reading that "
                          "never landed — but it must not silently PASS either")


class ShowAritySweepTest(unittest.TestCase):
    """live11/W6.out died inside w_kill_worker_mid_node's finally: `show(label)` —
    show(label, out) raised TypeError and bricked the whole leg after a perfectly
    landed kill. This sweep fails OFFLINE for every such call in the driver."""

    def test_every_show_call_in_the_driver_takes_an_out(self):
        import ast
        path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "e2e_m4_exit.py")
        tree = ast.parse(open(path, encoding="utf-8").read())
        offenders = []
        for node in ast.walk(tree):
            if (isinstance(node, ast.Call) and isinstance(node.func, ast.Name)
                    and node.func.id == "show"):
                kwout = any(k.arg in ("out", "label") for k in node.keywords)
                if len(node.args) < 2 and not kwout:
                    offenders.append(node.lineno)
        self.assertEqual(offenders, [],
                         f"show() call(s) at line(s) {offenders} miss the out argument")


class WKillWorkerMidNodeOfflineTest(unittest.TestCase):
    """Exercise the shared kill sequence with docker/psql MOCKED (unit-test layer
    only — it never substitutes for the live kill) so call-shape regressions like
    the live11/W6.out TypeError fail offline. restart=False must hand the drained
    worker back WITHOUT composing a start."""

    def drive(self, restart):
        import contextlib
        import io
        import time as time_mod
        seq = ["running|-", "running|-", "interrupted|interrupted"]
        docker, orig = {}, {}

        def fake_psql(sql):
            if "status || '|' || coalesce(error_class" in sql:
                return seq.pop(0) if seq else "interrupted|interrupted"
            if "node_execution_id" in sql:
                return "ne-1"
            raise AssertionError("unexpected psql: " + sql[:120])

        def fake_run(cmd, *a, **kw):
            docker.setdefault("cmds", []).append(list(cmd))
            return 0, ""

        patches = {
            "psql": fake_psql,
            "run": fake_run,
            "wait_worker_row": lambda name, timeout=120: ("w-c", name),
            "wait_live_past_gate": lambda client, project_id, run_id, timeout, tag,
                                        target=None: {"id": "att-1", "worker": "worker-a",
                                                      "key": m.C_LIVE_TARGET_KEY,
                                                      "attempt_number": "1"},
            "c4_worker_service": lambda name: "worker-a",
            "w5_container_of": lambda service: "communication-m4-worker-a-1",
            "w_deliver_signal": lambda sig, service, container, tag: (
                0, container, f"docker kill{' -s ' + sig if sig != 'KILL' else ''} "
                              f"{container}"),
            "hold_window": lambda cap, **kw: cap,
        }
        for name, fn in patches.items():
            orig[name] = getattr(m, name)
            setattr(m, name, fn)
        buf = io.StringIO()
        orig_sleep = time_mod.sleep
        time_mod.sleep = lambda s: None
        try:
            with contextlib.redirect_stdout(buf):
                facts = m.w_kill_worker_mid_node(object(), "p-1", "r-1", "TST",
                                                 restart=restart)
        finally:
            time_mod.sleep = orig_sleep
            for name, fn in orig.items():
                setattr(m, name, fn)
        return facts, docker.get("cmds", []), buf.getvalue()

    def test_restart_false_hands_the_drained_worker_back(self):
        facts, cmds, out = self.drive(restart=False)
        self.assertIsNotNone(facts, "the mocked kill must complete, not raise — "
                                    "live11/W6.out raised TypeError here")
        self.assertEqual(facts["state"], "interrupted")
        self.assertEqual(facts["owner"], "worker-a")
        self.assertTrue(any("stays DOWN" in ln for ln in out.splitlines()),
                        "the drain hand-off line must be reported (the live11 crash "
                        "site ran show(label) and died)")
        for cmd in cmds:
            self.assertNotIn("start", cmd, f"restart=False must never compose-start: {cmd}")

    def test_restart_true_brings_the_worker_back(self):
        facts, cmds, _out = self.drive(restart=True)
        self.assertEqual(facts["state"], "interrupted")
        self.assertTrue(any(cmd[-2:] == ["start", "worker-a"] or
                            "start" in cmd and "worker-a" in cmd for cmd in cmds),
                        f"restart=True must restore the killed worker: {cmds}")


def c5h_twin_canonical():
    """The § 7.0 twin's canonical_document shape, small: an until body whose
    implement node is the held node C5 kills inside."""
    return {
            "apiVersion": "communication.dev/v1alpha1", "kind": "Pipeline",
            "metadata": {"name": "feature-development-deterministic"},
            "spec": {
                "inputs": {"type": "object", "required": ["goal", "repository"],
                           "properties": {
                               "goal": {"type": "string", "minLength": 1},
                               "repository": {"type": "string", "minLength": 1},
                               "hold_seconds": {"type": "integer", "minimum": 0,
                                                "default": 0}}},
                "policies": {"workspaceMode": "worktree", "maxConcurrentNodes": 1},
                "nodes": [
                    {"id": "plan", "kind": "process.exec"},
                    {"id": "build_until_verified", "kind": "until", "config": {"body": {"nodes": [
                        {"id": "implement", "kind": "process.exec", "timeoutSeconds": 900,
                         "retry": {"maxAttempts": 2, "backoff": {"baseSeconds": 10},
                                   "retriableErrors": ["infra", "interrupted"]},
                         "config": {"executable": "m4-exit.sh", "args": ["implement"],
                                    "env": {"M4_HOLD_SECONDS":
                                                "${{ string(inputs.hold_seconds) }}"},
                                    "cwd": "repos/app",
                                    "workspace": {"mode": "run_workspace",
                                                  "repositories":
                                                      ["${{ inputs.repository }}"]}},
                         "outputs": {"type": "object", "required": ["summary"],
                                     "properties": {"summary": {"type": "string"}}}},
                        {"id": "test", "kind": "process.exec", "dependsOn": ["implement"]},
                    ]}}},
            ],
        },
    }


class C5hScratchDocTest(unittest.TestCase):
    """c5h_scratch_doc: the gate's OWN C5h revision is a deep copy of the twin's
    held node with ONE variable — retry := maxAttempts 1 — and nothing else."""

    def test_copy_lifts_the_held_node_with_only_the_budget_changed(self):
        src = c5h_twin_canonical()
        res = m.c5h_scratch_doc(src, "m4x-c5h-hold")
        self.assertEqual(res["missing"], [])
        doc = res["doc"]
        self.assertIsInstance(doc, str)
        self.assertEqual(doc.count("executable: m4-exit.sh"), 1)
        self.assertIn("maxAttempts: 1", doc)
        self.assertNotIn("maxAttempts: 2", doc)         # the twin's budget is gone
        self.assertNotIn("kind: until", doc)            # no loop, no gate
        self.assertNotIn("backoff", doc)                # old retry block fully replaced
        self.assertIn("M4_HOLD_SECONDS", doc)           # the hold survived the copy
        self.assertIn("inputs.hold_seconds", doc)
        self.assertIn("m4x-c5h-hold", doc)
        # The source document is untouched — the twin's key set is C1's property.
        impl = src["spec"]["nodes"][1]["config"]["body"]["nodes"][0]
        self.assertEqual(impl["retry"]["maxAttempts"], 2)

    def test_refuses_a_source_that_is_not_the_twin(self):
        for bad, needle in (
            (None, "source document"),
            ({"apiVersion": "x", "kind": "Pipeline", "spec": {}}, "held node"),
        ):
            res = m.c5h_scratch_doc(bad, "m4x-c5h-hold")
            self.assertIsNone(res["doc"])
            self.assertTrue(any(needle in why for why in res["missing"]),
                            f"{bad!r}: missing={res['missing']}")

    def test_refuses_a_held_node_without_the_hold_or_the_inputs(self):
        no_hold = c5h_twin_canonical()
        del no_hold["spec"]["nodes"][1]["config"]["body"]["nodes"][0]["config"]["env"]
        res = m.c5h_scratch_doc(no_hold, "n")
        self.assertIsNone(res["doc"])
        self.assertTrue(any("M4_HOLD_SECONDS" in why for why in res["missing"]))
        no_input = c5h_twin_canonical()
        del no_input["spec"]["inputs"]["properties"]["hold_seconds"]
        res = m.c5h_scratch_doc(no_input, "n")
        self.assertIsNone(res["doc"])
        self.assertTrue(any("inputs.hold_seconds" in why for why in res["missing"]))
        other_exec = c5h_twin_canonical()
        other_exec["spec"]["nodes"][1]["config"]["body"]["nodes"][0]["config"]["executable"] = "other"
        res = m.c5h_scratch_doc(other_exec, "n")
        self.assertIsNone(res["doc"])
        self.assertTrue(any("m4-exit.sh" in why for why in res["missing"]))


class C5hDocVerdictsTest(unittest.TestCase):
    def test_honest_copy_passes_every_arm(self):
        res = m.c5h_scratch_doc(c5h_twin_canonical(), "m4x-c5h-hold")
        v = m.c5h_doc_verdicts(res)
        self.assertTrue(all(ok for _, ok, _ in v), str(v))
        self.assertEqual(len(v), 3)

    def test_missing_splices_are_a_loud_fail(self):
        v = m.c5h_doc_verdicts({"doc": None, "applied": [], "missing": ["the twin's held node"]})
        self.assertIn(False, [ok for _, ok, _ in v])
        self.assertFalse(any(ok for _, ok, _ in v if ok is not None))

    def test_shape_arm_catches_a_second_budget(self):
        res = m.c5h_scratch_doc(c5h_twin_canonical(), "n")
        res["doc"] = res["doc"] + "      maxAttempts: 2\n"
        v = m.c5h_doc_verdicts(res)
        self.assertIs(v[-1][1], False, str(v[-1]))


def refusal(**kw):
    base = {"attempt_limit": "1", "att_status": "interrupted", "att_class": "interrupted",
            "sched": 0, "attempts": [1], "run_status": "failed",
            "run_cause": "node_execution_failed:/implement", "manual_status": 200,
            "manual_body": '{"run_id": "r-1"}', "manual_attempt2": True,
            "attempts_after": [1, 2]}
    base.update(kw)
    return {k: v for k, v in base.items() if v is not None}


class C5hRefusalVerdictsTest(unittest.TestCase):
    """§ 7.1 C5h: with maxAttempts=1 the retry is refused, the RUN fails honestly,
    and the manual POST behaves as § 5 route 31 says."""

    def graded(self, needle, a):
        hits = [(ok, d) for label, ok, d in m.c5h_refusal_verdicts(a) if needle in label]
        self.assertEqual(len(hits), 1, f"{needle!r}: {hits}")
        return hits[0]

    def test_full_refusal_passes_every_arm(self):
        v = m.c5h_refusal_verdicts(refusal())
        self.assertTrue(all(ok for _, ok, _ in v), str(v))

    def test_an_engine_armed_retry_is_a_fail_not_a_refusal(self):
        self.assertIs(self.graded("retry is REFUSED", refusal(sched=1))[0], False)
        self.assertIs(self.graded("retry is REFUSED", refusal(attempts=[1, 2]))[0], False)
        self.assertIs(self.graded("retry is REFUSED",
                                 refusal(attempts=[1, 2], sched=None))[0], None)

    def test_a_run_that_survived_the_exhaustion_fails_the_psql_line(self):
        self.assertIs(self.graded("RUN fails honestly", refusal(run_status="running"))[0],
                      False)
        self.assertIs(self.graded("RUN fails honestly", refusal(run_status="completed",
                                                                run_cause="-"))[0], False)
        self.assertIs(self.graded("RUN fails honestly", refusal(run_status=""))[0], None)

    def test_manual_retry_arms(self):
        ok, _ = self.graded("manual POST", refusal())
        self.assertIs(ok, True)
        ok, _ = self.graded("manual POST", refusal(manual_status=409,
                                                   manual_body='{"code": "run_not_retriable"}'))
        self.assertIs(ok, False, "a failed run is retriable per route 31 — a 409 here is "
                                 "the contradiction the gate must report")
        ok, _ = self.graded("manual POST", refusal(manual_status=None, manual_body=""))
        self.assertIs(ok, None)
        ok, _ = self.graded("manual POST", refusal(manual_status=500, manual_body="boom"))
        self.assertIs(ok, False)

    def test_attempt_two_requeued_arm(self):
        self.assertIs(self.graded("re-queued", refusal(manual_attempt2=False))[0], False)
        self.assertEqual([label for label, _, _ in m.c5h_refusal_verdicts(
            refusal(manual_attempt2=None, attempts_after=None))
            if "re-queued" in label], [])

    def test_unreadable_preconditions_gap(self):
        self.assertIs(self.graded("authored with a budget of 1",
                                  refusal(attempt_limit=""))[0], None)
        self.assertIs(self.graded("authored with a budget of 1",
                                  refusal(attempt_limit="2"))[0], False)
        self.assertIs(self.graded("interrupted (status", refusal(att_class=""))[0], None)
        self.assertIs(self.graded("interrupted (status",
                                  refusal(att_status="failed", att_class="infra"))[0], False)
        self.assertIs(self.graded("retry is REFUSED", refusal(sched=None))[0], None)
        self.assertIs(self.graded("retry is REFUSED", refusal(attempts=None))[0], None)


if __name__ == "__main__":
    unittest.main(verbosity=2 if "-v" in sys.argv else 1)
