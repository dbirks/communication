#!/usr/bin/env python3
"""test_c3c4_logic.py — offline unit proof for e2e_m4_exit.py's C3/C4 pure logic.

Runs WITHOUT a stack (stdlib unittest only): the claim-hand-out verdicts over
canned attempt groups (§ 7.1 C3b), the single-claim + fencing-sequence verdicts
(C3c), the fenced-attempt "published nothing" verdicts and event-shape verdicts
(C4b/C4c), the worker-log refusal grep (C4c), the transcript-quiescence rule
(C4e) and the ledger-vs-API agreement rule. A green here means the VERDICT
ALGEBRA is right — it never substitutes for C3/C4's live two-worker § 7 run
(12-test-strategy.md: a mocked green is not done).

usage: python3 e2e/m4/test_c3c4_logic.py [-v]
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import e2e_m4_exit as m  # noqa: E402 — importing the driver is the point


def group(key="/build_until_verified[1]/implement", attempt_number=1, held=1, workers=1):
    return {"key": key, "attempt_number": str(attempt_number),
            "held": str(held), "workers": str(workers)}


class PsqlRowsTest(unittest.TestCase):
    def test_equal_length_rows_only(self):
        self.assertEqual(m.psql_rows("a|1|1|1\nb|2|0|0", 4), [["a", "1", "1", "1"],
                                                              ["b", "2", "0", "0"]])

    def test_ragged_and_blank_lines_are_dropped_not_verdicted(self):
        self.assertEqual(m.psql_rows("NOTICE: whatever\na|1|1|1\n\na|1", 4),
                         [["a", "1", "1", "1"]])

    def test_empty_input(self):
        self.assertEqual(m.psql_rows("", 4), [])

    def test_truthy_covers_postgres_and_python_spellings(self):
        for t in ("t", "T", "true", "True", "1"):
            self.assertTrue(m.truthy(t), t)
        for f in ("f", "false", "0", "", None, "NULL"):
            self.assertFalse(m.truthy(f), repr(f))


class C3HandoutTest(unittest.TestCase):
    def test_single_live_claim_one_worker_passes(self):
        v = m.c3_handout_verdicts([group()])
        self.assertTrue(all(ok for _, ok, _ in v), v)
        self.assertEqual(len(v), 2)

    def test_two_live_claims_of_one_attempt_is_a_fail_not_an_error(self):
        v = m.c3_handout_verdicts([group(held=2)])
        self.assertFalse([ok for l, ok, _ in v if "leased<=1" in l][0])
        self.assertTrue([ok for l, ok, _ in m.c3_handout_verdicts([group(held=1)])
                         if "leased<=1" in l][0])

    def test_two_distinct_workers_for_one_attempt_fails(self):
        verdicts = m.c3_handout_verdicts([group(workers=2)])
        self.assertFalse([ok for l, ok, _ in verdicts if "distinct workers" in l][0])
        self.assertTrue([ok for l, ok, _ in verdicts if "leased<=1" in l][0])

    def test_never_claimed_row_is_not_a_violation(self):
        self.assertTrue(all(ok for _, ok, _ in m.c3_handout_verdicts(
            [group(held=0, workers=0)])))

    def test_junk_numbers_fail_loudly_instead_of_crashing(self):
        v = m.c3_handout_verdicts([{"key": "/x", "held": "?", "workers": ""}])
        self.assertEqual([ok for _, ok, _ in v], [False, False])  # unparseable != clean zero
        v2 = m.c3_handout_verdicts([{"key": "/x", "held": "2x", "workers": "3"}])
        self.assertFalse([ok for l, ok, _ in v2 if "leased<=1" in l][0])


class C3ClaimTest(unittest.TestCase):
    GOOD = {"key": "/build_until_verified[1]/implement", "id": "a-1",
            "distinct_workers": "1", "fencing_token": "7", "status": "succeeded"}

    def test_clean_claim_passes_both(self):
        self.assertTrue(all(ok for _, ok, _ in m.c3_claim_verdicts(self.GOOD)))

    def test_two_workers_is_a_fail(self):
        self.assertFalse([ok for l, ok, _ in
                          m.c3_claim_verdicts(dict(self.GOOD, distinct_workers="2"))][0])

    def test_zero_token_never_passes_the_fence_check(self):
        self.assertFalse([ok for l, ok, _ in
                          m.c3_claim_verdicts(dict(self.GOOD, fencing_token="0"))][1])

    def test_missing_keys_are_fails_not_crashes(self):
        self.assertEqual([ok for _, ok, _ in m.c3_claim_verdicts({})], [False, False])


class C3TokenSequenceTest(unittest.TestCase):
    def test_max_equals_draws_passes(self):
        self.assertTrue(all(ok for _, ok, _ in m.c3_token_verdicts("12", "12")))

    def test_max_below_draws_is_a_gap_shaped_fail(self):
        # A token higher than the sequence's last_value is impossible; lower means
        # the ledger's claims were not the only draws — the equality is the claim.
        self.assertFalse([ok for _, ok, _ in m.c3_token_verdicts("9", "12")][0])

    def test_zero_zero_never_passes(self):
        self.assertFalse([ok for _, ok, _ in m.c3_token_verdicts("0", "0")][0])

    def test_unreadable_is_a_fail(self):
        for pair in (("12", ""), ("", "12"), (None, None)):
            self.assertFalse([ok for _, ok, _ in m.c3_token_verdicts(*pair)][0], pair)


class C3RunIdsTest(unittest.TestCase):
    def setUp(self):
        self._saved = dict(m.CTX)
        m.CTX.clear()

    def tearDown(self):
        m.CTX.clear()
        m.CTX.update(self._saved)

    def test_c1_runs_win(self):
        m.CTX["c1"] = {"runs": ["r1", None, "r2"]}
        ids, src = m.c3_run_ids({"twin": {"run_id": "seed"}})
        self.assertEqual(ids, ["r1", "r2"])
        self.assertIn("C1", src)

    def test_manifest_fallback(self):
        ids, src = m.c3_run_ids({"agent": {"run_id": "ra"}, "twin": {"run_id": "rt"},
                                 "junk": "x"})
        self.assertEqual(sorted(ids), ["ra", "rt"])

    def test_nothing_to_read_is_empty_never_invented(self):
        self.assertEqual(m.c3_run_ids(None), ([], "the § 7.0 seed manifest runs"))


def _k(pairs):  # tiny helper: labels out of a [(label, ok, detail)] list
    return [p[0] for p in pairs]


class C4LiveAttemptTest(unittest.TestCase):
    ROW = ("a-1|/build_until_verified[1]/implement|worker-a|7|1|"
           "0197-0000-0000-0000-000000000001")

    def test_parses_the_poll_row(self):
        r = m.c4_live_attempt(self.ROW)
        self.assertEqual(r["id"], "a-1")
        self.assertEqual(r["worker"], "worker-a")
        self.assertEqual(r["token"], "7")
        self.assertNotEqual(r["turn"], "-")

    def test_no_live_row_is_none(self):
        self.assertIsNone(m.c4_live_attempt(""))
        self.assertIsNone(m.c4_live_attempt("ERROR: relation \"attempts\" does not exist"))

    def test_dash_turn_means_no_acp_turn(self):
        self.assertEqual(m.c4_live_attempt(self.ROW.replace(
            "0197-0000-0000-0000-000000000001", "-"))["turn"], "-")

    def test_container_map_refuses_unknown_workers(self):
        """The map yields compose SERVICE names: `communication-m4-worker-a` is the
        container PREFIX and no container docker can address (live9/C4c read 0 log
        lines off it), so it must never come back from this helper."""
        self.assertEqual(m.c4_worker_service("worker-a"), m.WORKER_A)
        self.assertEqual(m.c4_worker_service("worker-b"), m.WORKER_B)
        self.assertIsNone(m.c4_worker_service("worker-c"))
        self.assertIsNone(m.c4_worker_service("production-worker"))
        for svc in (m.WORKER_A, m.WORKER_B):
            self.assertFalse(svc.startswith(m.COMPOSE_PROJECT),
                             f"{svc} is a container prefix, not a service name")


class C4FenceLogTest(unittest.TestCase):
    LOG = ("\n".join([
        "worker info claimed attempt=a-1 token=7",
        'worker WARN terminal write rejected: lease lost turn_id="t-1"',
        "worker debug heartbeat",
        'worker WARN lease lost; stopping all writes for the turn turn_id="t-1"']))

    def test_counts_the_owner_s_own_refusals(self):
        n, sample = m.c4_fence_log(self.LOG)
        self.assertEqual(n, 2)
        self.assertTrue(any("lease lost" in s for s in sample))

    def test_a_clean_log_proves_nothing_and_must_not_pass(self):
        n, sample = m.c4_fence_log("worker info claimed attempt=a-1 token=7")
        self.assertEqual((n, sample), (0, []))

    def test_contract_wording_also_matches(self):
        self.assertEqual(m.c4_fence_log("ERROR stale owner write refused by fence")[0], 1)

    def test_empty_and_none_are_zero(self):
        self.assertEqual(m.c4_fence_log("")[0], 0)
        self.assertEqual(m.c4_fence_log(None)[0], 0)

    def test_sample_is_bounded(self):
        n, sample = m.c4_fence_log("lease lost\n" * 40)
        self.assertEqual((n, len(sample)), (40, m.FENCE_LOG_SAMPLE))


def _dead(**breaks):
    row = {"status": "interrupted", "outputs_null": "t", "artifacts_ready": "0",
           "checkpoints": "0", "completed_events": "0"}
    row.update(breaks)
    return row


class C4DeadAttemptTest(unittest.TestCase):
    def test_quiet_dead_attempt_passes_all_five(self):
        v = m.c4_dead_attempt_verdicts(_dead())
        self.assertEqual(len(v), 5)
        self.assertTrue(all(ok for _, ok, _ in v), v)

    def test_a_leaked_artifact_fails(self):
        self.assertFalse([ok for l, ok, _ in m.c4_dead_attempt_verdicts(
            _dead(artifacts_ready="1")) if "artifacts" in l][0])

    def test_a_leaked_checkpoint_fails(self):
        self.assertFalse([ok for l, ok, _ in m.c4_dead_attempt_verdicts(
            _dead(checkpoints="2")) if "run_checkpoints" in l][0])

    def test_a_completed_event_for_a_dead_attempt_fails(self):
        self.assertFalse([ok for l, ok, _ in m.c4_dead_attempt_verdicts(
            _dead(completed_events="1")) if "node.attempt.completed" in l][0])

    def test_outputs_present_fails(self):
        self.assertFalse([ok for l, ok, _ in m.c4_dead_attempt_verdicts(
            _dead(outputs_null="f")) if "NO outputs" in l][0])

    def test_succeeded_row_is_never_read_as_a_good_fence(self):
        v = m.c4_dead_attempt_verdicts(_dead(status="succeeded", outputs_null="f"))
        self.assertEqual([ok for _, ok, _ in v][:2], [False, False])

    def test_missing_row_is_a_fail_not_a_crash(self):
        self.assertFalse(any(ok for _, ok, _ in m.c4_dead_attempt_verdicts({})))


def _ev(type, actor_kind="system", reason="lease_expired"):
    return {"type": type, "actor_kind": actor_kind, "reason": reason}


class C4EventTest(unittest.TestCase):
    GOOD = [_ev("node.attempt.started", "worker", "-"),
            _ev("node.attempt.interrupted"),
            _ev("node.attempt.retry_scheduled", "system", "-")]

    def test_reconciler_interrupt_with_retry_follows(self):
        self.assertTrue(all(ok for _, ok, _ in m.c4_event_verdicts(
            self.GOOD, "node.attempt.interrupted", need_follow=True)))

    def test_worker_written_interruption_is_a_fail(self):
        bad = [_ev("node.attempt.interrupted", "worker")]
        self.assertFalse([ok for l, ok, _ in m.c4_event_verdicts(
            bad, "node.attempt.interrupted") if "actor_kind" in l][0])

    def test_takeover_reason_is_not_lease_expired(self):
        bad = [_ev("node.attempt.interrupted", "system", "human_takeover")]
        self.assertFalse([ok for l, ok, _ in m.c4_event_verdicts(
            bad, "node.attempt.interrupted") if "reason" in l][0])

    def test_run_failed_counts_as_the_following_terminal(self):
        v = m.c4_event_verdicts([_ev("node.attempt.interrupted"),
                                 _ev("run.failed", "system", "infra")],
                                "node.attempt.interrupted", need_follow=True)
        self.assertTrue([ok for l, ok, _ in v if "follows" in l][0])

    def test_following_event_BEFORE_the_interrupt_fails(self):
        v = m.c4_event_verdicts([_ev("node.attempt.retry_scheduled", "system", "-"),
                                 _ev("node.attempt.interrupted")],
                                "node.attempt.interrupted", need_follow=True)
        self.assertFalse([ok for l, ok, _ in v if "follows" in l][0])

    def test_missing_interrupt_fails_every_arm(self):
        v = m.c4_event_verdicts([_ev("node.attempt.completed", "worker", "-")],
                                "node.attempt.interrupted", need_follow=True)
        self.assertEqual([ok for _, ok, _ in v], [False, False, False, False])

    def test_turn_arm_of_c4e(self):
        self.assertTrue(all(ok for _, ok, _ in m.c4_event_verdicts(
            [_ev("conversation.turn.interrupted")], "conversation.turn.interrupted")))


class C4TranscriptTest(unittest.TestCase):
    def test_quiescent_turn_passes(self):
        self.assertTrue(all(ok for _, ok, _ in m.c4_transcript_verdicts(
            "4412", "4412", "t")))

    def test_a_row_appended_after_the_wake_up_fails(self):
        v = m.c4_transcript_verdicts("4412", "4413", "f")
        self.assertEqual([ok for _, ok, _ in v], [False, False])

    def test_postgres_says_a_row_postdates_unpause_even_if_seq_is_flat(self):
        self.assertFalse([ok for l, ok, _ in m.c4_transcript_verdicts(
            "4412", "4412", "f") if "predates" in l][0])

    def test_no_turn_means_no_verdicts(self):
        self.assertEqual(m.c4_transcript_verdicts("0", "0", "t", has_turn=False), [])

    def test_zero_zero_is_quiet_not_missing(self):
        self.assertTrue(all(ok for _, ok, _ in m.c4_transcript_verdicts("0", "0", "t")))


class C4RetryTokenTest(unittest.TestCase):
    def test_strictly_greater_token_passes(self):
        self.assertTrue(all(ok for _, ok, _ in m.c4_retry_verdicts("t")))

    def test_equal_or_null_token_is_not_a_proof(self):
        for gt in ("f", "", None, "NULL"):
            self.assertFalse(any(ok for _, ok, _ in m.c4_retry_verdicts(gt)), repr(gt))


class C4ApiAgreementTest(unittest.TestCase):
    LEDGER = {"status": "interrupted", "error_class": "interrupted"}
    API = {"id": "a-1", "status": "interrupted", "error_class": "interrupted",
           "detail": "lease expired", "attempt_number": 1}

    def test_agreeing_body_passes(self):
        self.assertTrue(all(ok for _, ok, _ in m.c4_api_verdicts(self.LEDGER, self.API)))

    def test_api_claiming_success_while_the_ledger_is_interrupted_fails(self):
        self.assertFalse([ok for l, ok, _ in m.c4_api_verdicts(
            self.LEDGER, dict(self.API, status="succeeded")) if "status" in l][0])

    def test_lease_machinery_in_the_body_fails(self):
        for leak in ("worker_id", "fencing_token", "lease_expires_at"):
            self.assertFalse([ok for l, ok, _ in m.c4_api_verdicts(
                self.LEDGER, dict(self.API, **{leak: 7})) if "lease machinery" in l][0], leak)

    def test_no_json_body_is_a_fail_not_a_skip(self):
        v = m.c4_api_verdicts(self.LEDGER, None)
        self.assertEqual(len(v), 1)
        self.assertFalse(v[0][1])

    def test_error_class_mismatch_fails(self):
        self.assertFalse([ok for l, ok, _ in m.c4_api_verdicts(
            self.LEDGER, dict(self.API, error_class="infra")) if "error_class" in l][0])


class C3NegativeControlTest(unittest.TestCase):
    def test_the_sentence_is_recorded_and_disclaims_execution(self):
        s = m.C3_NEGATIVE_CONTROL
        self.assertIn("not the execution", s)
        self.assertIn("fenc", s.lower())
        self.assertNotIn("exactly-once execution is guaranteed", s)


if __name__ == "__main__":
    unittest.main(verbosity=2)
