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

maxAttempts budget arm AND — offline against the REAL § 7.0 seed document — the C5h
scratch revision's input declarations (1c190fe: the copied node reads
`${{ inputs.leave_dirty }}`, the scratch declared only goal/repository/hold_seconds,
validate answered 200 with valid:false and publish refused with the compiler's
unknown_field).

usage: python3 e2e/m4/test_c5_logic.py [-v]
"""
import ast
import io
import json
import os
import re
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import e2e_m4_exit as m  # noqa: E402 — importing the driver is the point
import yamlmini as yaml  # noqa: E402 — stdlib YAML subset (CI's python3 has no PyYAML)

SEED_YAML = os.path.abspath(os.path.join(HERE, "..", "..", "docs", "compatibility",
                                         "probes", "m4", "pipeline.yaml"))
HEAD = "9f3c1ab2d4e5f60718293a4b5c6d7e8f90a1b2c3"


def twin_canonical():
    """Document #2 of the REAL § 7.0 seed (the deterministic twin the live arm
    splices), in the shape GET /api/v1/revisions/{id} serves canonical_document: the
    fixture parsed, re-exported canonically and parsed back, so the offline proof
    runs on the structure the API serves rather than the fixture's formatting (RC3)."""
    with open(SEED_YAML, encoding="utf-8") as f:
        raw = f.read()
    docs = [d for d in re.split(r"(?m)^---\s*$", raw) if "kind: Pipeline" in d]
    assert len(docs) >= 2, f"expected >=2 documents in {SEED_YAML}"
    return yaml.safe_load(yaml.safe_dump(yaml.safe_load(docs[1]), indent=4,
                                         sort_keys=True, allow_unicode=True))


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

import ast as _ast
import json as _json

DRIVER = os.path.join(HERE, "e2e_m4_exit.py")


def driver_src(name):
    """Source text of one module-level driver function (or MethodDef-free plain def):
    the pin for SEQUENCE claims — which door is asked before which POST, what reads
    what — that no canned ledger can express."""
    with open(DRIVER, encoding="utf-8") as fh:
        text = fh.read()
    fn = next((n for n in _ast.parse(text).body
               if isinstance(n, _ast.FunctionDef) and n.name == name), None)
    assert fn is not None, f"{name} is not a module-level def in {DRIVER}"
    return _ast.get_source_segment(text, fn)



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


class C5hScratchInputsTest(unittest.TestCase):
    """The 1c190fe GAP, offline and on the REAL seed twin: the scratch revision
    must declare every input its copied node reads, and only inputs the twin itself
    declares. A scratch the compiler refuses is not a budget arm — it is nothing."""

    def scratch(self):
        res = m.c5h_scratch_doc(twin_canonical(), "m4x-c5h-hold-test")
        self.assertEqual([], res["missing"],
                         f"the seed twin is not the shape C5h splices: {res['missing']}")
        self.assertIsInstance(res["doc"], str)
        return res, yaml.safe_load(res["doc"])

    def test_every_input_the_emitted_doc_reads_is_declared_by_that_same_doc(self):
        """The claim, read off the BYTES the driver posts: parse the emitted YAML and
        check every ${{ inputs.X }} inside spec.nodes against spec.inputs.properties."""
        _res, doc = self.scratch()
        declared = set((doc["spec"]["inputs"]["properties"] or {}).keys())
        read = m.doc_input_refs(doc["spec"]["nodes"])
        self.assertTrue(read, "a scratch node that reads no input holds nothing to kill")
        self.assertEqual([], sorted(set(read) - declared),
                         f"undeclared inputs the compiler would refuse with "
                         f"unknown_field: read={read} declared={sorted(declared)}")
        self.assertEqual(1, len(doc["spec"]["nodes"]), "C5h's scratch is ONE node")

    def test_the_real_twin_forces_leave_dirty_into_the_declaration(self):
        """The exact field 1c190fe died on. If the twin ever stops reading it the
        scratch must follow the twin, not a hard-coded list."""
        res, doc = self.scratch()
        read = set(m.doc_input_refs(doc["spec"]["nodes"]))
        twin_read = set(m.doc_input_refs(m.doc_body_node(twin_canonical(), m.C5H_NODE_ID)))
        self.assertEqual(twin_read, read,
                         "the scratch node reads a different input set than the twin's "
                         f"held node ({twin_read} vs {read}) — the copy is not verbatim")
        self.assertIn("leave_dirty", twin_read | read,
                      "the seed twin's held node no longer reads inputs.leave_dirty — "
                      "this regression test needs the twin's current binding set")
        self.assertEqual(sorted(set(twin_read) | set(res["input_refs"])),
                         sorted(res["input_refs"]),
                         f"the builder read {res['input_refs']} off a node binding "
                         f"{sorted(twin_read)}")
        for name in twin_read:
            self.assertIn(name, doc["spec"]["inputs"]["properties"],
                          f"inputs.{name} is read and undeclared")

    def test_declared_schemas_are_the_twins_copied_verbatim_and_nothing_invented(self):
        twin = twin_canonical()
        props = twin["spec"]["inputs"]["properties"]
        twin_required = twin["spec"]["inputs"]["required"]
        _res, doc = self.scratch()
        declared = doc["spec"]["inputs"]["properties"]
        for name, schema in declared.items():
            self.assertIn(name, props, f"inputs.{name} invented (the twin declares "
                                       f"{sorted(props)})")
            self.assertEqual(props[name], schema,
                             f"inputs.{name} re-authored instead of copied — its "
                             "default/type is what the run posts against")
        for name in doc["spec"]["inputs"]["required"]:
            self.assertIn(name, twin_required, "the scratch demands an input the twin "
                                              "does not demand")
        self.assertTrue(set(doc["spec"]["inputs"]["required"]) <= {"goal", "repository",
                                                                  "hold_seconds"},
                        "the live arm posts goal/repository/hold_seconds only — a "
                        "required input beyond those never reaches the scratch run")

    def test_the_real_twin_scratch_is_a_deep_copy_and_never_mutates_it(self):
        twin = twin_canonical()
        frozen = yaml.safe_dump(twin, indent=4, sort_keys=True, allow_unicode=True)
        res = m.c5h_scratch_doc(twin, "m4x-c5h-hold-copy")
        self.assertIsInstance(res["doc"], str)
        self.assertEqual(frozen, yaml.safe_dump(twin, indent=4, sort_keys=True,
                                                allow_unicode=True),
                         "the splice mutated the twin document — C1's key set is the "
                         "gate's own precondition")
        self.assertEqual(2, m.doc_body_node(twin, m.C5H_NODE_ID)["retry"]["maxAttempts"],
                         "the twin's own budget must still read 2 after the copy")

    def test_an_input_the_twin_does_not_declare_is_a_gap_reason_not_an_invention(self):
        doc = twin_canonical()
        held = m.doc_body_node(doc, m.C5H_NODE_ID)
        self.assertIsNotNone(held, "the twin's held implement node moved — the splice "
                                   "tests below would be testing nothing")
        held["config"]["env"]["M4_INVENTED"] = "${{ inputs.not_in_the_twin }}"
        res = m.c5h_scratch_doc(doc, "x")
        self.assertIsNone(res["doc"])
        self.assertTrue(any("inputs.not_in_the_twin" in why for why in res["missing"]),
                        f"missing={res['missing']}")
        self.assertIn(False, [ok for _l, ok, _d in m.c5h_doc_verdicts(res)])

    def test_the_doc_verdict_arm_fails_when_a_declaration_is_lost(self):
        """A builder that silently drops a declaration must not read as an honest
        splice (that is the 1c190fe shape of bug, verdict side)."""
        res = m.c5h_scratch_doc(twin_canonical(), "m4x-c5h-hold-test")
        honest = [ok for label, ok, _ in m.c5h_doc_verdicts(res) if "declared in" in label]
        self.assertEqual([True], honest, m.c5h_doc_verdicts(res))
        broken = dict(res, inputs_declared=[k for k in res["inputs_declared"]
                                           if k != "leave_dirty"])
        self.assertEqual([False], [ok for label, ok, _ in m.c5h_doc_verdicts(broken)
                                   if "declared in" in label])

    def test_the_arm_quotes_the_compiler_rather_than_a_truncated_repr(self):
        """The live leg's GAP line must carry c5h_publish_report's rendering (the
        compiler's code + message), not `str(vresp)[:240]`."""
        fn = next(n for n in ast.parse(open(os.path.join(HERE, "e2e_m4_exit.py"),
                                           encoding="utf-8").read()).body
                  if isinstance(n, ast.FunctionDef) and n.name == "c5h_scratch_arm")
        body = ast.unparse(fn)
        self.assertIn("c5h_publish_report(pub)", body,
                      "the publish GAP no longer reports the compiler's own words")
        self.assertNotIn("[:240]", body,
                         "a truncated repr() of the validate body is not the compiler's "
                         "refusal — report the errors themselves")

    def test_publish_report_carries_the_unknown_field_refusal(self):
        errs = [{"source": "compiler", "code": "unknown_field",
                 "instance_location": "/spec/nodes/0/config/env/M4_LEAVE_DIRTY",
                 "message": "inputs.leave_dirty selects an input the pipeline does not "
                            "declare (inputs.leave_dirty)"}]
        pub = {"validate_status": 200, "publish_status": 409, "revision_id": "",
               "vresp": {"valid": False, "errors": errs},
               "raw": '{"valid": false}\n{"code":"invalid_pipeline_document"}'}
        rep = m.c5h_publish_report(pub)
        for needle in ("validate=200", "publish=409", "valid=False", "unknown_field",
                       "selects an input the pipeline does not declare",
                       "invalid_pipeline_document"):
            self.assertIn(needle, rep, rep)
        self.assertIn("no draft", m.c5h_publish_report(None))


class C5hDocVerdictsTest(unittest.TestCase):
    def test_honest_copy_passes_every_arm(self):
        res = m.c5h_scratch_doc(c5h_twin_canonical(), "m4x-c5h-hold")
        v = m.c5h_doc_verdicts(res)
        self.assertTrue(all(ok for _, ok, _ in v), str(v))
        self.assertEqual(len(v), 4, "copy / budget / input-declaration / shape")
        self.assertTrue(any("declared in" in label for label, _ok, _d in v), v)

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




def manual_twin():
    """The REAL § 7.0 seed twin (document 2 of the probe file) in canonical_document
    shape — the structure c5e_retry_scratch_doc copies its two nodes from. The fixture,
    never a fixture of a fixture: the arm's whole claim is that its nodes are copies."""
    return twin_canonical()


def manual_held(doc=None):
    return m.doc_body_node(doc or manual_twin(), m.C5H_NODE_ID)


def manual_plan(doc=None):
    return next(n for n in (doc or manual_twin())["spec"]["nodes"]
                if n.get("id") == m.C5E_SEED_STEP)


def manual_arm(status=200, may_post=True, run_st="failed", final_st="completed",
               rows=None, head=HEAD, dirty=1, seed_ne=1, seed_rows=None, body="{}",
               seed_node=None):
    """A complete, mutually consistent set of readings from the manual-retry arm: the
    killed node's attempt rows carry the boundary the seed recorded, and the seed itself
    gained nothing."""
    rows = rows if rows is not None else [
        attempt(1, "interrupted", "interrupted"),
        attempt(2, "queued", "-", ctx_json(1, "interrupted", head, 1))]
    return {"run_id": "run-m", "run_st": run_st, "cause": "node_execution_failed:/x",
            "final_st": final_st, "may_post": may_post, "status": status, "body": body,
            "rows": rows, "seed_rows": seed_rows if seed_rows is not None
            else [attempt(1, "succeeded", "-")],
            "seed_ne": {"ne": seed_ne, "attempts": 1},
            "seed_node": seed_node or m.C5E_SEED_NODE, "kill_node": m.C5E_KILL_NODE,
            "seed_step": m.C5E_SEED_EDIT, "policy": m.C5E_CONTINUE,
            "head_before": head, "dirty_before": dirty, "ckpts": [], "policies": {},
            "restore": None, "worker": "worker-a"}


class C5eManualRetryScratchDocTest(unittest.TestCase):
    """c5e_retry_scratch_doc: the gate's OWN retriable subject is TWO copies of the twin's
    held node — a seed that SUCCEEDS (so a boundary exists to inherit) and a budget-1 node
    the kill fails the run on — with nothing else from the twin carried over."""

    def test_continue_build_is_two_verbatim_copies_with_one_budget_each(self):
        src = manual_twin()
        res = m.c5e_retry_scratch_doc(src, "m4x-c5e-retry")
        self.assertEqual(res["missing"], [], res["missing"])
        self.assertIsInstance(res["doc"], str)
        doc = res["doc"]
        self.assertEqual(doc.count("maxAttempts:"), 2, doc)
        self.assertNotIn("maxAttempts: 2", doc, "the shipped budget must not survive")
        self.assertNotIn("kind: until", doc)
        self.assertNotIn("human.approval", doc)
        self.assertNotIn("workspacePolicy:", doc,
                         "C5e's arm stays on the retry's DEFAULT mode; inventing a "
                         "policy into the document would test a mode the twin never chose")
        self.assertNotIn("backoff", doc)
        self.assertIn("m4x-c5e-retry", doc)
        parsed = yaml.safe_load(doc)
        nodes = parsed["spec"]["nodes"]
        self.assertEqual([n["id"] for n in nodes],
                         [m.C5E_SEED_NODE, m.C5E_KILL_NODE])
        # the killed node is the twin's held step, config and all
        self.assertEqual(nodes[1]["config"], manual_held(src)["config"])
        self.assertEqual(nodes[1]["retry"], {"maxAttempts": 1})
        self.assertEqual(nodes[1]["dependsOn"], [m.C5E_SEED_NODE])
        self.assertEqual(nodes[0]["config"], manual_held(src)["config"],
                         "the dirty-seed arm keeps the held step verbatim: its own "
                         "unstaged edit is the modified_path_count the retry must carry")
        self.assertNotIn("dependsOn", nodes[0])
        # the source document is untouched — the twin's key set is C1's property
        self.assertEqual(manual_held(src)["retry"]["maxAttempts"], 2)

    def test_edit_free_seed_switches_only_the_step_and_its_output_contract(self):
        src = manual_twin()
        res = m.c5e_retry_scratch_doc(src, "m4x-c6c-restore", policy=m.C6_RESTORE_POLICY,
                                      seed_step=m.C5E_SEED_STEP,
                                      kill_node=m.C6C_KILL_NODE)
        self.assertEqual(res["missing"], [], res["missing"])
        parsed = yaml.safe_load(res["doc"])
        seed, kill = parsed["spec"]["nodes"]
        self.assertEqual(seed["config"]["args"], [m.C5E_SEED_STEP],
                         "the seed must run the twin's edit-free step or its boundary "
                         "would read uncommitted and restore would be refused")
        self.assertEqual(seed["outputs"], manual_plan(src)["outputs"],
                         "the outputs schema is the one that step's stdout satisfies, "
                         "copied — not one this arm invented")
        self.assertEqual(kill["retry"], {"maxAttempts": 1,
                                         "workspacePolicy": m.C6_RESTORE_POLICY})
        self.assertEqual(kill["config"], manual_held(src)["config"])
        self.assertEqual(res["doc"].count("workspacePolicy:"), 1)
        self.assertEqual(res["policy"], m.C6_RESTORE_POLICY)

    def test_declares_every_input_either_copy_reads(self):
        res = m.c5e_retry_scratch_doc(manual_twin(), "m4x-c5e-retry")
        self.assertTrue(res["inputs_declared"])
        self.assertEqual(sorted(set(res["input_refs"])),
                         ["hold_seconds", "leave_dirty", "repository"],
                         "the held copy still reads inputs.leave_dirty (M4_LEAVE_DIRTY); "
                         "an undeclared selection is the unknown_field failure class")
        self.assertEqual(sorted(res["input_props"]),
                         ["goal", "hold_seconds", "leave_dirty", "repository"])

    def test_refuses_a_source_it_cannot_copy(self):
        no_dirty = manual_twin()
        del no_dirty["spec"]["inputs"]["properties"]["leave_dirty"]
        res = m.c5e_retry_scratch_doc(no_dirty, "n")
        self.assertIsNone(res["doc"])
        self.assertTrue(any("inputs.leave_dirty" in why for why in res["missing"]),
                        res["missing"])
        res = m.c5e_retry_scratch_doc(manual_twin(), "n", policy=m.C6_RESTORE_POLICY,
                                      seed_step=m.C5E_SEED_STEP)
        self.assertTrue(any("leave_dirty" in w for w in res["missing"])
                        or res["inputs_declared"],
                        "the restore arm declares the SAME bindings as the continue arm")
        no_plan = manual_twin()
        no_plan["spec"]["nodes"] = [n for n in no_plan["spec"]["nodes"]
                                    if n.get("id") != m.C5E_SEED_STEP]
        res = m.c5e_retry_scratch_doc(no_plan, "n", seed_step=m.C5E_SEED_STEP)
        self.assertIsNone(res["doc"])
        self.assertTrue(any("plan" in why for why in res["missing"]), res["missing"])
        # a plan seed needs the twin's OWN outputs schema for the edit-free step
        no_out = manual_twin()
        del next(n for n in no_out["spec"]["nodes"]
                 if n.get("id") == m.C5E_SEED_STEP)["outputs"]
        res = m.c5e_retry_scratch_doc(no_out, "n", seed_step=m.C5E_SEED_STEP)
        self.assertIsNone(res["doc"])
        self.assertTrue(any("json_from_stdout" in why for why in res["missing"]),
                        res["missing"])
        res = m.c5e_retry_scratch_doc(None, "n")
        self.assertIsNone(res["doc"])
        self.assertTrue(any("source document" in why for why in res["missing"]))
        res = m.c5e_retry_scratch_doc(manual_twin(), "n", seed_step="review")
        self.assertIsNone(res["doc"])
        self.assertTrue(any("third" in why for why in res["missing"]), res["missing"])

    def test_a_held_node_that_no_longer_shows_the_shipped_budget_is_refused(self):
        twin = manual_twin()
        manual_held(twin)["retry"] = {"maxAttempts": 5}
        res = m.c5e_retry_scratch_doc(twin, "n")
        self.assertIsNone(res["doc"])
        self.assertTrue(any("maxAttempts: 2" in why for why in res["missing"]),
                        "this arm measures the budget the DOCUMENT authors; a copy that "
                        "no longer shows it changes two variables at once")


class C5eManualRetryDocVerdictsTest(unittest.TestCase):
    def test_a_clean_build_passes_every_honesty_row(self):
        for policy, step in ((None, m.C5E_SEED_EDIT), (m.C6_RESTORE_POLICY, m.C5E_SEED_STEP)):
            res = m.c5e_retry_scratch_doc(manual_twin(), "n", policy=policy, seed_step=step)
            v = m.c5e_retry_doc_verdicts(res)
            self.assertEqual(len(v), 5, [l for l, _o, _d in v])
            self.assertTrue(all(ok for _l, ok, _d in v), [(l, d) for l, ok, d in v if not ok])

    def test_each_row_fires_on_its_own_sabotage(self):
        res = m.c5e_retry_scratch_doc(manual_twin(), "n")
        no_seed = dict(res, applied=[a for a in res["applied"]
                                     if not a.startswith("'" + m.C5E_SEED_NODE)])
        self.assertIs(ok_of(m.c5e_retry_doc_verdicts(no_seed), "the seed node is a copy"),
                      False)
        no_kill = dict(res, applied=[a for a in res["applied"]
                                     if not a.startswith("'" + m.C5E_KILL_NODE)])
        self.assertIs(ok_of(m.c5e_retry_doc_verdicts(no_kill), "COPIED VERBATIM"), False)
        # a mode appears in the document but was never declared (or the reverse)
        extra = dict(res, doc=res["doc"] + "workspacePolicy: restore_checkpoint\n")
        self.assertIs(ok_of(m.c5e_retry_doc_verdicts(extra), "ONE variable differs"), False)
        doctored = []
        for a in res["applied"]:
            if a.startswith("retry blocks carried"):
                a = ('retry blocks carried by the scratch: [{"id": "' + m.C5E_SEED_NODE
                     + '", "retry": {"maxAttempts": 2, "workspacePolicy": '
                     + '"restore_checkpoint"}, "kind": "process.exec", "args": '
                     + '["implement"], "workspace": {"mode": "run_workspace"}}]')
            doctored.append(a)
        leaked = dict(res, applied=doctored)
        self.assertIs(ok_of(m.c5e_retry_doc_verdicts(leaked), "ONE variable differs"), False)
        undeclared = dict(res, inputs_declared=False, input_props=[])
        self.assertIs(ok_of(m.c5e_retry_doc_verdicts(undeclared), "declared in spec.inputs"),
                      False)


class C5ePreconditionTest(unittest.TestCase):
    """Both of route 31's doors, graded in RetryRun's order — and the pair of arms differs
    ONLY at the second one, because runtime/retry.go asks a different question of the
    inherited boundary in each mode."""

    def ck(self, node, committed, head=HEAD, mpc=1):
        return {"node": node, "volume_id": "repos-a", "worker": "worker-a",
                "committed": committed, "mpc": mpc, "head": head}

    def test_retriable_run_on_a_recorded_boundary_licenses_the_continue_post(self):
        v, may = m.c5e_precondition_verdicts("failed", [self.ck("/boundary_seed", False)],
                                             "/boundary_seed")
        self.assertTrue(may)
        self.assertTrue(all(ok for _l, ok, _d in v), v)

    def test_restore_needs_the_boundary_COMMITTED_and_says_so(self):
        v, may = m.c5e_precondition_verdicts(
            "failed", [self.ck("/boundary_seed", False)], "/boundary_seed",
            policy=m.C6_RESTORE_POLICY)
        self.assertFalse(may, "an uncommitted boundary is C6d's 409, not an accepted "
                              "restore — POSTing through it grades the refusal row")
        self.assertIs(ok_of(v, "recorded COMMITTED"), False)

    def test_restore_on_a_committed_boundary_licenses_the_post(self):
        v, may = m.c5e_precondition_verdicts(
            "interrupted", [self.ck("/boundary_seed", True, mpc=0)], "/boundary_seed",
            policy=m.C6_RESTORE_POLICY)
        self.assertTrue(may, v)

    def test_engine_owned_running_run_GAPs_not_FAILs(self):
        for st in ("running", "paused", "queued"):
            v, may = m.c5e_precondition_verdicts(st, [self.ck("/boundary_seed", True)],
                                                 "/boundary_seed")
            self.assertFalse(may)
            self.assertIsNone(ok_of(v, "route 31 RE-OPENS"),
                              f"{st}: the ENGINE owns that retry (§ 7.1 C5b) — the arm "
                              "has no subject, which is a GAP and not a product FAIL")
            self.assertIn("running (retry armed)", detail_of(v, "route 31 RE-OPENS"))

    def test_a_run_that_completed_contradicts_the_arms_premise(self):
        v, may = m.c5e_precondition_verdicts("completed", [self.ck("/boundary_seed", True)],
                                             "/boundary_seed")
        self.assertFalse(may)
        self.assertIs(ok_of(v, "route 31 RE-OPENS"), False)

    def test_unreadable_ledger_and_missing_boundary_gap(self):
        v, may = m.c5e_precondition_verdicts("", [self.ck("/boundary_seed", True)], "/x")
        self.assertFalse(may)
        self.assertIsNone(ok_of(v, "route 31 RE-OPENS"))
        v, may = m.c5e_precondition_verdicts("failed", [], "/boundary_seed")
        self.assertTrue(may, "runtime/retry.go:116-138 refuses a RESTORE on a missing "
                             "boundary and asks NOTHING of continue_workspace — the gate "
                             "keeps its 200 and loses its comparison, which is a GAP")
        self.assertIsNone(ok_of(v, "RECORDED"))
        v, may = m.c5e_precondition_verdicts("failed", [{"node": "/boundary_seed",
                                                        "head": HEAD,
                                                        "committed": False}],
                                             "/boundary_seed")
        self.assertTrue(may)
        self.assertIs(ok_of(v, "RECORDED"), True,
                      "continue_workspace asks nothing of the boundary's committed flag — "
                      "it needs a recorded HEAD to carry, and this row has one (the same "
                      "row reads FAIL for the restore arm, C6d's premise)")
        for pol in (m.C5E_CONTINUE, m.C6_RESTORE_POLICY):
            v, may = m.c5e_precondition_verdicts("failed", [{"node": "/other",
                                                            "head": HEAD,
                                                            "committed": True}],
                                                 "/boundary_seed", policy=pol)
            self.assertIsNone(ok_of(v, "RECORDED" if pol == m.C5E_CONTINUE else "COMMITTED"),
                              "a boundary on some OTHER node is not the one this retry "
                              "inherits (RetryPlan takes the newest row that is not the "
                              "retried node's own)")
        v, may = m.c5e_precondition_verdicts("cancelled", [], "/boundary_seed",
                                             policy=m.C6_RESTORE_POLICY)
        self.assertFalse(may, "restore without a recorded boundary is the refusal § 7.1 "
                              "C6d names, so the arm does not ask and its rows GAP")
        self.assertIsNone(ok_of(v, "COMMITTED"))


class C5eManualRetryVerdictsTest(unittest.TestCase):
    """§ 7.1 C5e's expectation list, graded on the run the MANUAL retry re-opened."""

    def test_the_full_reading_passes_every_claim(self):
        v = m.c5e_manual_retry_verdicts(manual_arm())
        self.assertTrue(all(ok is True for _l, ok, _d in v),
                        [(l, ok, d) for l, ok, d in v if ok is not True])
        self.assertIn("C5e", v[0][0])

    def test_the_same_algebra_labels_C6c(self):
        a = manual_arm()
        self.assertTrue(all("C6c" in l for l, _o, _d in m.c5e_manual_retry_verdicts(a,
                                                                                    tag="C6c")))

    def test_a_refusal_on_a_verified_retriable_run_is_a_FAIL(self):
        v = m.c5e_manual_retry_verdicts(manual_arm(
            status=409, body='{"type":"https://communication.dev/errors/run-not-retriable"}'))
        self.assertIs(ok_of(v, "the UI's button posts exactly this"), False)
        self.assertIn("RETRIABLE", detail_of(v, "the UI's button posts exactly this"))

    def test_any_other_answer_is_a_FAIL(self):
        for status in (500, 403, 404):
            v = m.c5e_manual_retry_verdicts(manual_arm(status=status, body="oops"))
            self.assertIs(ok_of(v, "the UI's button posts exactly this"), False)

    def test_an_unposted_retry_GAPs_everything_it_could_not_measure(self):
        v = m.c5e_manual_retry_verdicts(manual_arm(status=None, may_post=False))
        self.assertIsNone(ok_of(v, "the UI's button posts exactly this"))
        self.assertIn("never asked the route", detail_of(v, "posts exactly this"))
        for needle in ("APPENDED", "retry_context from the LAST CHECKPOINT",
                       "head_commit = $HEAD_BEFORE", "modified_path_count = $DIRTY_BEFORE",
                       "gained NOTHING", "RE-OPENED"):
            self.assertIsNone(ok_of(v, needle), needle)
        # the ledger facts that DO stand on their own are still graded
        self.assertIs(ok_of(v, "attempt 1 of the retried node"), True)

    def test_a_boundary_that_disagrees_with_the_worktree_reading_is_a_FAIL(self):
        off = [attempt(1, "interrupted", "interrupted"),
               attempt(2, "queued", "-", ctx_json(1, "interrupted", "f" * 40, 1))]
        v = m.c5e_manual_retry_verdicts(manual_arm(rows=off, head=HEAD))
        self.assertIs(ok_of(v, "head_commit = $HEAD_BEFORE"), False)
        v = m.c5e_manual_retry_verdicts(manual_arm(dirty=7))
        self.assertIs(ok_of(v, "modified_path_count = $DIRTY_BEFORE"), False)
        self.assertIn("DIRTY_BEFORE=7", detail_of(v, "modified_path_count = $DIRTY_BEFORE"))

    def test_a_missing_carry_or_a_missing_context_GAPs_its_own_arm(self):
        v = m.c5e_manual_retry_verdicts(manual_arm(head=""))
        self.assertIsNone(ok_of(v, "head_commit = $HEAD_BEFORE"))
        v = m.c5e_manual_retry_verdicts(manual_arm(dirty=None))
        self.assertIsNone(ok_of(v, "modified_path_count = $DIRTY_BEFORE"))
        no_ctx = m.c5e_manual_retry_verdicts(
            manual_arm(rows=[attempt(1, "interrupted", "interrupted"),
                             attempt(2, "queued", "-")]))
        self.assertIs(ok_of(no_ctx, "retry_context from the LAST CHECKPOINT"), False,
                      "route 31 says the retried attempt is TOLD the previous attempt's "
                      "facts; an accepted retry that armed attempt 2 with NO context at "
                      "all contradicts its own route row — that is a FAIL, not a gap")
        self.assertIn("NULL", detail_of(no_ctx, "retry_context from the LAST CHECKPOINT"))
        self.assertIsNone(ok_of(no_ctx, "head_commit = $HEAD_BEFORE"))
        ragged = m.c5e_manual_retry_verdicts(
            manual_arm(rows=[attempt(1, "interrupted", "interrupted"),
                             attempt(2, "queued", "-", ctx='{"attempt": 1, "err')]))
        self.assertIsNone(ok_of(ragged, "retry_context from the LAST CHECKPOINT"),
                          "a context the driver could not parse is the READ failing, "
                          "not the product refusing to write it")

    def test_retry_work_that_touched_the_finished_node_is_a_FAIL(self):
        v = m.c5e_manual_retry_verdicts(manual_arm(seed_ne=2))
        self.assertIs(ok_of(v, "gained NOTHING"), False)
        v = m.c5e_manual_retry_verdicts(manual_arm(seed_rows=[attempt(1, "succeeded", "-"),
                                                             attempt(2, "queued", "-")]))
        self.assertIs(ok_of(v, "gained NOTHING"), False)

    def test_the_reopen_is_read_from_the_runs_row_not_the_post_code(self):
        for fin, want in (("running", True), ("completed", True), ("failed", False),
                          ("", None)):
            v = m.c5e_manual_retry_verdicts(manual_arm(final_st=fin))
            self.assertIs(ok_of(v, "RE-OPENED the failed run"), want, (fin, v))


class C5eManualArmSequencingTest(unittest.TestCase):
    """The arm's SHAPE is its correctness claim: route 31 answers the run-status door
    first, so the retry is asked only after the ledger shows the run retriable, only
    after the worker is back (the reopened attempt needs its volume's owner), and never
    before the twin's own workspace reads have been taken."""

    def test_c5_posts_the_manual_retry_only_on_a_retriable_run(self):
        src = driver_src("c5")
        ask = src.index('/retry", {"reason": "crash"}')
        gate = src.index("run_retriable = c6_run_is_retriable(run_st)")
        self.assertLess(gate, ask, "the POST must be gated on the ledger's run status")
        self.assertIn("if run_retriable:", src[gate:ask],
                      "the twin is engine-owned by § 7.1 C5b's sentence; POSTing at that "
                      "door is what produced live20's 409 GAP")
        self.assertLess(src.index("NOT asked"), ask + 400)

    def test_the_arm_drives_the_run_to_retriable_before_it_asks(self):
        src = driver_src("_c5e_kill_and_retry")
        ask = src.index('/retry", {"reason": "crash"}')
        self.assertLess(src.index("_c6d_wait_retriable("), ask,
                        "route 31's run-status door fires first (_c6d_wait_retriable is "
                        "the poll the C6d fix introduced — reused, not re-authored)")
        self.assertLess(src.index("c5e_precondition_verdicts("), ask)
        self.assertLess(src.index("compose start"), ask,
                        "the killed worker comes back BEFORE the retry: the reopened "
                        "attempt is pinned to the container that owns the workspace")
        self.assertLess(src.index('/retry", {"reason": "crash"}'), src.index("watch_run("),
                        "an accepted retry leaves live work behind unless the arm drains it")
        self.assertIn("if may_post:", src[:ask], "a door that is not open stops the POST")

    def test_the_arm_runs_after_the_twins_workspace_reads(self):
        src = driver_src("c5")
        self.assertLess(src.index("c5_emit(c5_retry_row_verdicts(rows"),
                        src.index("arm = None if manual_status == 200 else c5e_retry_door_arm("),
                        "the arm kills a worker; run first and the twin's workspace would "
                        "be released under C5f's reads (a run reaches terminal during the "
                        "arm's own hold)")

    def test_the_published_document_resolves_before_the_lab_sees_it(self):
        src = driver_src("c5e_retry_scratch_doc") + driver_src("c5e_retry_doc_verdicts")
        self.assertIn('out["refs"] = c5e_scratch_ref_pairs(scratch)', src,
                      "the census is taken off the ASSEMBLED document, not off a list of "
                      "what this file believes it dropped")
        self.assertIn('sp["nodes"] = [seed, kill]',
                      driver_src("c5e_retry_scratch_doc"))
        self.assertNotIn("json.loads(json.dumps(canonical))", driver_src("c5e_retry_scratch_doc"),
                         "a deep copy of the twin drags spec.outputs/resultBindings — the "
                         "bindings that made the first C5e/C6c draft a publish 409 "
                         "(compile-proved: unknown_dependency@/spec/resultBindings/"
                         "implementation_summary for the copied shape, valid=true for this)")
        verdicts = driver_src("c5e_retry_doc_verdicts")
        self.assertIn("unresolved", verdicts)
        self.assertIn("unknown_dependency@/spec/resultBindings/", verdicts,
                      "the row names the diagnostic the compiler actually answers, so a "
                      "reader can match the arm's own check against the lab's refusal")

    def test_the_scratch_is_copied_and_the_compiler_is_quoted_on_refusal(self):
        src = driver_src("c5e_retry_door_arm")
        self.assertIn("doc_revision_canonical(admin", src)
        self.assertIn("c5e_retry_scratch_doc(", src)
        self.assertIn("c5h_publish_report(pub)", src,
                      "/validate answers 200 with valid:false — the GAP must quote the "
                      "compiler, not a truncated repr")
        self.assertIn("c5_emit(c5e_retry_doc_verdicts(res))", src)
        self.assertIn("require_fault_hold(", src)
        self.assertIn("with_hold(inputs, C_FAULT_HOLD_SECONDS)", src)
        self.assertNotIn("with_dirty(", src,
                         "leave_dirty stays at the twin's default: the seed's boundary "
                         "state is chosen by which step it runs, not by a flag this arm "
                         "would have baked in")

    def test_the_twin_side_line_becomes_a_note_once_the_arm_graded_the_row(self):
        v = m.c5_retry_api_verdicts(None, "", [attempt(), attempt(2, "queued", "-",
                                                                  ctx_json())],
                                    run_retriable=False, measured_elsewhere=True)
        self.assertIs(v[0][1], m.C5_NOTE, "a NOTE, never a PASS and never a GAP")
        self.assertIn("retriable scratch", v[0][2])
        v = m.c5_retry_api_verdicts(None, "", [attempt(), attempt(2, "queued", "-",
                                                                  ctx_json())],
                                    run_retriable=False)
        self.assertIsNone(v[0][1], "with no arm behind it the row stays a visible GAP")
        self.assertIn("unmeasured", v[0][2])

    def test_an_accepted_post_still_gradues_the_200_row(self):
        v = m.c5_retry_api_verdicts(200, '{"run_id":"r"}', [attempt(2, "queued")],
                                    run_retriable=True)
        self.assertIs(ok_of(v, "posts exactly this"), True)


class C5eNoteEmissionTest(unittest.TestCase):
    def tearDown(self):
        del m.FAILURES[:], m.GAPS[:], m.SKIPPED[:]

    def test_a_note_is_printed_and_never_recorded_as_a_verdict(self):
        m.c5_emit([("C5e POST /runs/{id}/retry — measured elsewhere", m.C5_NOTE, "see below")])
        self.assertEqual(m.FAILURES, [])
        self.assertEqual(m.GAPS, [])

    def test_the_unposted_note_line_never_appears_in_the_c6_leg(self):
        src = driver_src("c6")
        self.assertNotIn("c5_retry_api_verdicts(", src,
                         "C6's restore leg posted the same request and printed the answer "
                         "under a C5e label (live20's second GAP); it grades its own door "
                         "row now")




class ManualArmDryRunTest(unittest.TestCase):
    """EXECUTE c5e_retry_door_arm's live half offline with the lab mocked: the canned
    ledger, a fake client and a recorded call order. The verdict algebra above proves the
    reducer; this proves the SEQUENCE the reducer is argued from — that the arm kills,
    waits for route 31's retriable state, brings the worker back, grades both doors and
    only then posts — and that it survives a run that never turns retriable without ever
    asking the route. Nothing here touches a socket, a container or Postgres."""

    def setUp(self):
        self.log = []
        self.saved = {}
        self.retriable = "failed"
        self.seed, self.kill = m.C5E_SEED_NODE, m.C5E_KILL_NODE
        self.ckpt_rows = [
            f"ne-1@@/{self.seed}@@vol-a@@ws-1@@worker-a@@true@@0@@{HEAD}",
            f"ne-2@@/{self.kill}@@vol-a@@ws-1@@worker-a@@false@@1@@{HEAD}",
        ]
        self.attempt_rows = {
            f"/{self.kill}": [f"1\tinterrupted\tinterrupted\t-\t2026-02-20 10:00:00+00",
                              f"2\tqueued\t-\t{ctx_json(1, 'interrupted', HEAD, 1)}"
                              f"\t2026-02-20 10:04:00+00"],
            f"/{self.seed}": ["1\tsucceeded\t-\t-\t2026-02-20 09:50:00+00"],
        }

    def tearDown(self):
        for name, value in self.saved.items():
            setattr(m, name, value)
        self.saved.clear()
        del m.FAILURES[:], m.GAPS[:]

    def patch(self, name, value):
        self.saved.setdefault(name, getattr(m, name))
        setattr(m, name, value)

    def fake_psql(self, sql, *a, **kw):
        if "FROM runs WHERE id" in sql:
            return f"{self.retriable}|node_execution_failed:/{self.kill}"
        if "FROM run_checkpoints c" in sql:
            return "\n".join(self.ckpt_rows)
        if "a.attempt_number::text || chr(9)" in sql:
            for key, rows in self.attempt_rows.items():
                if f"'{key}'" in sql:
                    return "\n".join(rows)
            return ""
        if "count(DISTINCT ne.id)" in sql:
            return f"/{self.seed}|1|1\n/{self.kill}|1|2"
        if "workspace_policies" in sql:
            return json.dumps({f"/{self.kill}": m.C5E_CONTINUE}).replace("'", "''")
        if "run.checkpoint_restored" in sql:
            return ""
        raise AssertionError(f"unmocked psql read: {sql[:90]}")

    def run_arm(self, retriable="failed", post_status=200):
        self.retriable = retriable
        self.patch("psql", self.fake_psql)
        self.patch("wait_live_past_gate", lambda *a, **kw: {
            "id": "att-1", "worker": "worker-a", "key": "/" + self.kill})
        self.patch("c4_worker_service", lambda w: "worker-a")
        self.patch("c6_worktree_read", lambda rid, svc: (HEAD, "1"))
        self.patch("wait_worker_row", lambda svc, t: True)
        self.patch("C5_KILL_WAIT_S", 0)     # the dry run never waits out a lease
        self.patch("watch_run", lambda *a, **kw: ("completed", None))
        self.patch("run_status", lambda rid: self.retriable)
        self.patch("hold_window", lambda s: 1)

        def _run(cmd, *a, **kw):
            self.log.append(("compose", cmd[-1]))
            return 0, "mocked compose"

        self.patch("run", _run)

        def _wait(rid, cap=None):
            self.log.append(("wait_retriable", self.retriable))
            return self.retriable

        self.patch("_c6d_wait_retriable", _wait)
        arm_cls = m.Client

        class Resp:
            def __init__(self, status, text):
                self.status, self.text = status, text
                self.headers = {"Content-Type": "application/json"}

            def json(self):
                return json.loads(self.text)

        class Fake:
            def __init__(self, log, post_status):
                self.log, self.post_status = log, post_status

            def post(self, base, path, body=None):
                self.log.append(("post", path))
                if path.endswith("/retry"):
                    return Resp(self.post_status, '{"run_id":"run-m"}'
                                if self.post_status == 200 else
                                '{"type":"https://communication.dev/'
                                'errors/run-not-retriable"}')
                return Resp(201, '{"run_id":"run-m"}')

            def get(self, base, path):
                return Resp(200, "{}")

        self.patch("Client", arm_cls)
        client = Fake(self.log, post_status)
        out = m._c5e_kill_and_retry(client, {"project_id": "p"}, {}, "run-m", "C5e",
                                    m.C5E_CONTINUE, m.C5E_SEED_EDIT, self.kill,
                                    grade=m.c5e_manual_retry_verdicts)
        return out, self.log

    def capture(self, fn):
        buf = io.StringIO()
        old = sys.stdout
        sys.stdout = buf
        try:
            res = fn()
        finally:
            sys.stdout = old
        return res, buf.getvalue()

    def test_the_sequence_reaches_the_route_only_after_the_door_opens(self):
        (out, printed), log = self.capture(lambda: self.run_arm()), None
        out, log = out
        self.assertIsNotNone(out)
        kinds = [k for k in log]
        self.assertEqual([k[0] for k in kinds][:2], ["compose", "wait_retriable"],
                         f"the kill must precede the retriable poll: {kinds}")
        self.assertIn(("compose", "worker-a"), log)
        self.assertLess(index_of(log, "wait_retriable"), index_of(log, "post"),
                        "the retry must not be asked before the run is retriable "
                        "(1c190fe posted at the closed door)")
        self.assertLess(index_of(log, "wait_retriable"), index_of(log, "post"))
        # the worker is back up BEFORE the retry: the reopened attempt is pinned to the
        # container that owns the workspace (ADR-0023 § 4's claim predicate)
        self.assertLess(last_index_of(log, "compose", "worker-a"), index_of(log, "post"))
        self.assertEqual(out["run_st"], "failed")
        self.assertTrue(out["may_post"])
        self.assertEqual(out["status"], 200)
        self.assertEqual([r["attempt_number"] for r in out["rows"]], ["1", "2"])
        self.assertEqual(out["final_st"], "completed", "the arm drained its own run")
        self.assertIn("C5e POST /runs/{id}/retry -> 200", printed,
                      "the arm grades ITSELF: the verdict lines land in the same evidence "
                      "trail as the doors, the POST and the attempt rows")
        self.assertEqual(m.FAILURES, [], printed[-400:])
        self.assertEqual(m.GAPS, [], "the canned ledger satisfies every claim of the row: "
                                     + "\n".join(m.GAPS))

    def test_a_run_that_stays_running_is_never_asked(self):
        # § 7.1 C5b's engine-owned state on a budget-2 run: the door stays shut, the arm
        # must not knock, and the row's claims GAP rather than grade the wrong door.
        (out, printed), _ = self.capture(lambda: self.run_arm(retriable="running")), None
        out, log = out
        self.assertIsNotNone(out)
        self.assertFalse(out["may_post"])
        self.assertIsNone(out["status"])
        self.assertNotIn("post", [k[0] for k in log
                                  if k[0] == "post" and k[1].endswith("/retry")])
        self.assertIn("NOT posted", printed)
        self.assertTrue(any("never asked the route" in g for g in m.GAPS), m.GAPS)
        self.assertEqual(m.FAILURES, [], "an unaskable door is a GAP, never a FAIL")

    def test_a_refusal_after_the_door_opened_is_a_failure_not_an_excuse(self):
        (out, printed), _ = self.capture(
            lambda: self.run_arm(retriable="failed", post_status=409)), None
        out, log = out
        self.assertEqual(out["status"], 409)
        self.assertEqual([f for f in m.FAILURES if "posts exactly this" in f],
                         m.FAILURES, "\n".join(m.FAILURES) + "\n" + printed[-600:])
        self.assertIn("RETRIABLE", printed,
                      "the FAIL's own reason must say WHY the door should have opened")
        self.assertIn("RETRIABLE", m.FAILURES[0] + printed,
                      "route 31 refused a run its own list admits — that is the product "
                      "contradiction, not the soft GAP 1c190fe printed")


def index_of(log, kind):
    return next(i for i, k in enumerate(log) if k[0] == kind)


def last_index_of(log, kind, needle):
    hits = [i for i, k in enumerate(log) if k[0] == kind and needle in k]
    return hits[-1]




class C5eScratchReferenceTest(unittest.TestCase):
    """The lab's first C5e/C6c pass never reached the kill: the draft was refused with
    `validate errors [compiler/unknown_dependency@/spec/resultBindings/
    implementation_summary, ...]` because the scratch kept the twin's run-output bindings
    while dropping the until loop they bind. These are the checks that keep that shape
    from coming back — built off the REAL seed document, both arms."""

    def builds(self):
        return (m.c5e_retry_scratch_doc(manual_twin(), "m4x-c5e-probe"),
                m.c5e_retry_scratch_doc(manual_twin(), "m4x-c6c-probe",
                                        policy=m.C6_RESTORE_POLICY,
                                        seed_step=m.C5E_SEED_STEP,
                                        kill_node=m.C6C_KILL_NODE))

    def test_the_document_carries_no_binding_to_a_node_it_dropped(self):
        for res in self.builds():
            self.assertEqual(res["missing"], [], res["missing"])
            parsed = yaml.safe_load(res["doc"])
            self.assertEqual(sorted(parsed["spec"]), ["inputs", "nodes", "policies"],
                             "spec.outputs and spec.resultBindings bind "
                             "/build_until_verified; a scratch that copies the twin "
                             "wholesale copies that claim too")
            self.assertIsNone(parsed["spec"].get("resultBindings"))
            ids = {n["id"] for n in parsed["spec"]["nodes"]}
            self.assertEqual(ids, {m.C5E_SEED_NODE, res["kill_node"]})
            self.assertEqual(res["node_ids"], [m.C5E_SEED_NODE, res["kill_node"]])

    def test_every_reference_the_draft_makes_resolves_inside_it(self):
        for res in self.builds():
            self.assertTrue(res["refs"], "a scratch with NO edge at all would not run "
                                         "the killed node after its boundary seed")
            ids = set(res["node_ids"])
            unresolved = [r for r in res["refs"] if r[1] not in ids]
            self.assertEqual(unresolved, [], f"{res['policy']}: {res['refs']}")
            self.assertIn((m.C5E_KILL_NODE, m.C5E_SEED_NODE),
                          self.builds()[0]["refs"],
                          "the edge that makes the seed the inherited boundary")
            self.assertIs(ok_of(m.c5e_retry_doc_verdicts(res), "resolves to a node"), True)

    def test_the_reference_census_catches_the_shape_the_compiler_refused(self):
        # Negative control, on the exact bytes that died: put the twin's own bindings back.
        twin = manual_twin()
        bindings = twin["spec"].get("resultBindings")
        self.assertTrue(bindings, "the seed twin binds its run outputs — that is the "
                                 "shape that must be refused here, not in the lab")
        for res in self.builds():
            doctored = yaml.safe_load(res["doc"])
            doctored["spec"]["resultBindings"] = json.loads(json.dumps(bindings))
            refs = m.c5e_scratch_ref_pairs(doctored)
            self.assertIn(("/spec", "build_until_verified"), refs, refs)
            v = m.c5e_retry_doc_verdicts(dict(res, refs=refs))
            self.assertIs(ok_of(v, "resolves to a node"), False,
                          "the arm must name the dangling binding itself, not learn it "
                          "from a 409 in the lab")
            self.assertIn("build_until_verified", detail_of(v, "resolves to a node"))

    def test_only_the_inputs_the_arm_posts_are_required(self):
        # The scratch DECLARES leave_dirty (the held copy's M4_LEAVE_DIRTY binding reads
        # it, and an undeclared selection is the unknown_field class) but must not REQUIRE
        # it: the arm leaves the twin's default false in place, and a run POST missing a
        # required input is refused before any node runs.
        for res in self.builds():
            parsed = yaml.safe_load(res["doc"])["spec"]["inputs"]
            self.assertEqual(sorted(parsed["required"]), ["goal", "hold_seconds", "repository"],
                             f"{res['policy']}: required={parsed['required']}")
            self.assertIn("leave_dirty", parsed["properties"])
            self.assertIs(res["inputs_declared"], True)

    def test_the_census_reads_expressions_and_edges_alike(self):
        doc = {"spec": {"nodes": [
            {"id": "a", "config": {"prompt": "read ${{ nodes.gone.outputs.x }}"}},
            {"id": "b", "dependsOn": ["a", "missing"]},
        ], "outputs": {"x": "${{ nodes.also_gone.outputs.y }}"}}}
        refs = m.c5e_scratch_ref_pairs(doc)
        self.assertEqual(sorted(refs), sorted([("a", "gone"), ("b", "a"), ("b", "missing"),
                                               ("/spec", "also_gone")]), refs)
        self.assertEqual(m.c5e_scratch_ref_pairs(None), [])
        self.assertEqual(m.c5e_scratch_ref_pairs({"spec": {}}), [])


if __name__ == "__main__":
    unittest.main(verbosity=2 if "-v" in sys.argv else 1)
