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
import re
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import e2e_m4_exit as m  # noqa: E402 — importing the driver is the point
from test_c4_logic import TABLES, unresolved_columns  # noqa: E402 — the migration reader


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


class C3FanoutHandoutTest(unittest.TestCase):
    """§ 7.1 C3a measured over the leg's OWN fan-out queue (c3_build_queue)."""

    def groups(self, *pairs):
        return [{"worker": w, "n": str(n)} for w, n in pairs]

    def test_two_workers_with_overlap_passes_every_arm(self):
        v = m.c3_fanout_handout_verdicts(
            self.groups(("worker-a", 18), ("worker-b", 7)), 2, [(1, 1), (2, 4), (3, 0)])
        self.assertTrue(all(ok is True for _l, ok, _d in v), v)

    def test_single_worker_deep_queue_fails_the_handout_arm_not_gap(self):
        v = m.c3_fanout_handout_verdicts(self.groups(("worker-a", 25)), 2, [(1, 3)])
        arm = [ok for l, ok, _d in v if "BOTH online workers" in l][0]
        self.assertFalse(arm)  # both online, 25 queued, one claimant = measured FAIL

    def test_second_worker_offline_gaps_the_contention_arm(self):
        v = m.c3_fanout_handout_verdicts(self.groups(("worker-a", 25)), 1, [(1, 3)])
        arm = [ok for l, ok, _d in v if "BOTH online workers" in l][0]
        self.assertIsNone(arm)  # nothing to contend — never a PASS, never a fake FAIL

    def test_no_rows_at_all_is_a_gap_never_a_zero_pass(self):
        v = m.c3_fanout_handout_verdicts([], 2, [])
        self.assertTrue(all(ok is None for _l, ok, _d in v), v)

    def test_unreadable_counts_never_read_as_a_clean_zero(self):
        v = m.c3_fanout_handout_verdicts([{"worker": "worker-a", "n": "?"}], 2, [(1, 2)])
        self.assertIsNone([ok for l, ok, _d in v if "handed child attempts out" in l][0])

    def test_claimed_rows_without_any_worker_id_is_a_fail(self):
        v = m.c3_fanout_handout_verdicts(self.groups(("(unclaimed)", 25)), 2, [])
        self.assertFalse([ok for l, ok, _d in v if "handed child attempts out" in l][0])

    def test_serialised_claims_fail_the_overlap_arm(self):
        v = m.c3_fanout_handout_verdicts(self.groups(("worker-a", 9), ("worker-b", 3)),
                                         2, [(1, 1), (2, 1)])
        self.assertFalse([ok for l, ok, _d in v if "overlapped" in l][0])
        self.assertTrue([ok for l, ok, _d in v if "BOTH online workers" in l][0])

    def test_empty_samples_gap_the_overlap_arm(self):
        v = m.c3_fanout_handout_verdicts(self.groups(("worker-a", 5), ("worker-b", 5)),
                                         2, [])
        self.assertIsNone([ok for l, ok, _d in v if "overlapped" in l][0])

    def test_handout_groups_parses_rows_and_drops_ragged_lines(self):
        self.assertEqual(
            m.c3_handout_groups("worker-a|18\nworker-b|7\nNOTICE something\nbad\n\n"),
            [{"worker": "worker-a", "n": "18"}, {"worker": "worker-b", "n": "7"}])


class C3RollupTest(unittest.TestCase):
    def rows(self, *specs):
        return [dict(key=k, attempt_number=str(n), held=str(h), workers=str(w))
                for k, n, h, w in specs]

    def test_all_clean_groups_pass_both_rules(self):
        v = m.c3_rollup_verdicts(self.rows(("/a", 1, 1, 1), ("/a", 2, 0, 1), ("/b", 1, 1, 1)))
        self.assertEqual(len(v), 2)
        self.assertTrue(all(ok for _l, ok, _d in v), v)

    def test_one_violating_group_fails_the_rule_and_is_quoted(self):
        v = m.c3_rollup_verdicts(self.rows(("/a", 1, 1, 1), ("/a", 2, 2, 1), ("/b", 1, 1, 2)))
        leased = [p for p in v if "one live claim" in p[0]][0]
        workers = [p for p in v if "distinct workers" in p[0]][0]
        self.assertFalse(leased[1] or workers[1])
        self.assertIn("1 violating group(s)", leased[2])
        self.assertIn("1 violating group(s)", workers[2])
        self.assertIn("/a", leased[2])

    def test_no_groups_yield_no_rules_not_a_pass(self):
        self.assertEqual(m.c3_rollup_verdicts([]), [])


class C3Emit3Test(unittest.TestCase):
    def setUp(self):
        self._saved = {k: dict(v) for k, v in m.CTX.items()}
        self._gaps, self._fails = list(m.GAPS), list(m.FAILURES)

    def tearDown(self):
        m.GAPS[:], m.FAILURES[:] = self._gaps, self._fails
        m.CTX.clear()
        m.CTX.update(self._saved)

    def test_none_gap_true_false_check(self):
        import io
        import contextlib
        with contextlib.redirect_stdout(io.StringIO()):
            m.c3_emit3([("g", None, "why"), ("p", True, ""), ("f", False, "d")])
        self.assertTrue(any(x.startswith("g:") for x in m.GAPS))
        self.assertIn("f", m.FAILURES)


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


# --- § 7.1 C3d is now a MEASURED verdict: the row's claim is that the sentence
# is RECORDED, so the verdict grades the recording (tee'd stdout + filed
# evidence) and cites C4's fence verdicts when they exist in this process.


def flat(s):
    return " ".join((s or "").split())


def arms(verdicts, needle):
    return [ok for label, ok, _ in verdicts if needle in label]


class _Quiet(unittest.TestCase):
    """Driver printers append to module-level FAILURES/GAPS/SKIPPED; a leg test
    that calls them must leave them exactly as it found them (test_c5_logic.py
    asserts on their contents)."""
    POOLS = ("VERDICTS", "DEFERRED", "FAILURES", "GAPS", "SKIPPED")

    def setUp(self):
        m._atexit_ok = False
        self.saved = {}
        for name in self.POOLS:
            pool = getattr(m, name)
            self.saved[name] = list(pool)
            pool.clear()

    def tearDown(self):
        for name in self.POOLS:
            getattr(m, name)[:] = self.saved[name]


class VerdictLedgerTest(_Quiet):
    def test_check_and_gap_record_their_leg(self):
        m.check("C4c the stale write was refused", True, "log grep > 0")
        m.gap("C9c bob's arm", "no membership row")
        self.assertEqual([v["leg"] for v in m.VERDICTS], ["C4C", "C9C"])
        self.assertEqual(m.ledger_of("C4C")[0]["verdict"], "PASS")

    def test_gate_query_never_swallows_a_two_digit_gate(self):
        for label in ("C1a ok", "C1i ok", "C10a ok", "C10c ok", "C1 ok"):
            m.check(label, True)
        self.assertEqual([v["leg"] for v in m.ledger_gate("C1")],
                         ["C1A", "C1I", "C1"])

    def test_rollup_is_empty_when_the_gate_never_printed(self):
        m.check("C12b budget refused", True)
        self.assertEqual(m.rollup("C4"), "")
        m.check("C4c refused", False)
        self.assertEqual(m.rollup("C4"), "FAIL")

    def test_rollup_all_gap_is_gap_not_pass(self):
        m.gap("C4a no lease", "nothing to freeze")
        self.assertEqual(m.rollup("C4"), "GAP")
        m.check("C4d retry succeeded", True)
        self.assertEqual(m.rollup("C4"), "PASS")

    def test_printed_by_tees_what_the_leg_actually_writes(self):
        _, printed = m.printed_by(m.show, "C3d NEGATIVE CONTROL", "hello fence")
        self.assertIn("hello fence", printed)
        self.assertEqual(m.rollup("C3"), "")   # show prints no verdict


class C3dRecordedTest(_Quiet):
    GOOD = flat(m.C3_NEGATIVE_CONTROL)

    def verdicts(self, printed=None, recorded=None, roll="", lines=0):
        return m.c3d_verdicts(m.C3D_HEAD + " " + (self.GOOD if printed is None else printed),
                              self.GOOD if recorded is None else recorded, roll, lines)

    def test_report_lines_wrap_without_breaking_the_sentence(self):
        joined = flat("\n".join(m.c3d_report_lines()))
        self.assertIn(self.GOOD, joined)

    def test_recorded_and_printed_passes(self):
        v = self.verdicts(roll="PASS", lines=12)
        self.assertEqual(set(ok for _, ok, _ in v), {True}, v)

    def test_absent_sentence_fails(self):
        self.assertEqual(arms(self.verdicts(printed=""), "own printed report"), [False])

    def test_evidence_that_drifted_from_the_sentence_fails(self):
        self.assertEqual(arms(self.verdicts(recorded="SKIP LOCKED is fine"),
                              "gate's evidence"), [False])

    def test_sentence_that_lost_the_fence_clause_fails_its_elements(self):
        gutted = " ".join(re.sub(r"fenc\w*", "queue", self.GOOD).split())
        self.assertEqual(arms(self.verdicts(printed=gutted), "C3d's elements"), [False])

    def test_a_sentence_claiming_exactly_once_execution_fails_the_control(self):
        self.assertEqual(arms(self.verdicts(printed=self.GOOD + " The claim guarantees "
                                            "exactly-once execution."),
                              "does not itself claim"), [False])

    def test_unmeasured_c4_is_a_gap_never_a_pass(self):
        self.assertEqual(arms(self.verdicts(), "proof it points at"), [None])
        self.assertEqual(arms(self.verdicts(roll="GAP", lines=3), "proof it points at"), [None])

    def test_c4_fail_fails_the_row_that_defers_to_it(self):
        self.assertEqual(arms(self.verdicts(roll="FAIL", lines=9), "proof it points at"), [False])

    def test_deferred_regrade_cites_c4_once_it_has_printed(self):
        m.check("C4c the stale owner's write was refused by the fence", True, "log grep=2")
        m.defer_regrade("C3d", m.c3d_cite_c4)
        _, printed = m.printed_by(m.run_deferred_regrades)
        self.assertIn("[regraded after C4]", printed)
        self.assertEqual([v["verdict"] for v in m.VERDICTS if "regraded" in v["label"]],
                         ["PASS"])

    def test_regrade_prints_nothing_when_c4_never_ran(self):
        m.defer_regrade("C3d", m.c3d_cite_c4)
        _, printed = m.printed_by(m.run_deferred_regrades)
        self.assertNotIn("regraded", printed)


# --- C4e: every table.column the arm's SQL names, resolved off the migrations --
# 1c190fe's C4e GAPped "max(global_seq) before the unpause='0'". Before blaming
# the product the arm's OWN reads must be proven schema-true — C7a GAPped on a
# column no migration created and C3a on an ORDER BY position absent from its
# select list, both silently read as 0. These tests resolve C4e's SQL the same
# mechanical way, offline.

_TURN, _ATT = "01a1882a-1a95-7978-ae38-80817c1b2027", "713f2311-7239-507b-b7ce-b2b9f8a6ce92"


def c4e_sqls():
    """{name: (sql, table|None)} — every SQL string C4e sends, with its single
    table (None for the joined read, which the QUALIFIED checker covers instead).
    transcript_predates takes the unpause timestamp as its second argument."""
    return {
        "turn_events": (m.c4e_turn_events_sql(_TURN), "domain_events"),
        "turn_types": (m.c4e_turn_types_sql(_TURN), "domain_events"),
        "transcript_seq": (m.c4e_transcript_seq_sql(_TURN), "domain_events"),
        "transcript_predates": (m.c4e_transcript_predates_sql(
            _TURN, "2026-10-29 14:57:49.093411+00"), "domain_events"),
        "turn_row": (m.c4e_turn_row_sql(_TURN), "conversation_turns"),
        "attempt_status": (m.c4e_attempt_status_sql(_ATT), "attempts"),
        "attempt_shape": (m.c4e_attempt_shape_sql(_ATT), None),
    }


_SQL_WORDS = {"select", "from", "where", "and", "or", "not", "null", "is", "in",
              "coalesce", "max", "count", "order", "by", "asc", "desc", "limit",
              "true", "false", "join", "on", "as", "case", "when", "then", "else",
              "end", "distinct", "left", "right", "inner", "outer", "cross", "text",
              "jsonb", "uuid", "bigint", "integer", "boolean", "timestamptz", "now",
              "json_build_array", "group", "having", "union", "all", "exists"}


def bare_columns(sql, tables):
    """The identifiers a read uses UNQUALIFIED: literals (the turn id, the event
    types, the '|' separators), ::casts and function names are stripped, so what
    remains must be a column of one of the `tables` the statement selects from —
    this is the check a joined-free `WHERE typpe = ...` typo can only be caught
    by, since unresolved_columns only sees QUALIFIED names."""
    text = re.sub(r"'[^']*'", "@", sql.lower())            # literals are data
    text = re.sub(r"::[a-z_][a-z0-9_]*", "@", text)        # casts are types
    text = re.sub(r"[a-z_][a-z0-9_]*\s*\(", "@", text)    # function names
    return sorted({w for w in re.findall(r"[a-z_][a-z0-9_]*", text)
                   if w != "@" and w not in _SQL_WORDS and w not in tables})


class C4eSchemaResolutionTest(unittest.TestCase):
    """§ 7.1 C4e's five ledger reads, plus the joined shape read, against the
    real CREATE TABLE / ADD COLUMN text — a renamed or invented column reads as
    zero rows and GAPs a working product (C7a's failure mode)."""

    def test_qualified_columns_resolve_against_the_migrations(self):
        for name, (sql, _table) in sorted(c4e_sqls().items()):
            self.assertEqual(unresolved_columns(sql), [], f"{name}: {sql}")

    def test_bare_columns_exist_in_their_single_table(self):
        for name, (sql, table) in sorted(c4e_sqls().items()):
            if table is None:
                continue                              # joined read: qualified only
            for col in bare_columns(sql, (table,)):
                self.assertIn(col, TABLES[table],
                              f"{name} names {table}.{col}, which no migration "
                              f"created — columns here are {sorted(TABLES[table])}")

    def test_the_domain_events_reads_use_only_00001_columns_plus_the_payload(self):
        """domain_events grew run/node/attempt ids in 00005 but NO turn_id column —
        the arm scopes on payload->>'turn_id' (the product's own transcript read,
        internal/store/postgres/m3api.go, joins the same way), so 'turn_id' must
        NEVER appear as a bare column in a domain_events read."""
        for name, (sql, table) in sorted(c4e_sqls().items()):
            if table != "domain_events":
                continue
            stripped = re.sub(r"'[^']*'", "@", sql.lower())
            self.assertNotIn("turn_id", stripped,
                             f"{name} filtered on a domain_events.turn_id COLUMN — "
                             "the migrations do not have one")

    def test_no_read_orders_by_a_position_its_select_lacks(self):
        """C3a's sibling failure: ORDER BY n pointing past the select list aborts
        psql, which the driver then reports as an empty read. C4e orders by the
        named global_seq column, which the bare-column test has just proven real."""
        for name, (sql, _table) in sorted(c4e_sqls().items()):
            order = re.search(r"ORDER BY\s+(\d+)", sql, re.I)
            self.assertIsNone(order, f"{name} orders by position: {sql}")


class C4eFirstTranscriptTest(unittest.TestCase):
    """The 1c190fe fix as pure algebra: the fence may only land on a turn that
    already journaled a transcript row; otherwise the arm GAPs BEFORE pausing."""

    LABEL = "C4e the fenced turn had a transcript to keep quiet"

    def arms(self, seq, status, cap=180):
        v = m.c4e_first_transcript_gap(seq, status, cap)
        return [(ok, d) for l, ok, d in v]

    def test_a_transcript_means_no_pre_verdict_the_post_fence_line_will_pass_it(self):
        self.assertEqual(m.c4e_first_transcript_gap("4471", "running", 180), [])

    def test_an_empty_transcript_while_live_is_a_gap_not_a_fail(self):
        got = self.arms("0", "running")
        self.assertEqual([ok for ok, _ in got], [None])
        self.assertIn("0 streamed transcript rows", got[0][1])
        self.assertIn("message.agent/thought/tool.call/tool.update", got[0][1])
        self.assertIn("GAP, never PASS", got[0][1])

    def test_an_attempt_that_closed_itself_says_so_in_the_gap(self):
        got = self.arms("0", "succeeded")
        self.assertEqual([ok for ok, _ in got], [None])
        self.assertIn("reached 'succeeded' on its own", got[0][1])

    def test_still_fencable_until_the_attempt_itself_goes_terminal(self):
        for live in ("", "running", "leased", "unreadable"):
            self.assertTrue(m.c4e_first_chunk_still_fencable(live), live)
        for dead in ("succeeded", "failed", "cancelled", "interrupted"):
            self.assertFalse(m.c4e_first_chunk_still_fencable(dead), dead)

    def test_the_arm_waits_for_the_first_chunk_BEFORE_it_pauses(self):
        """Ordering is the whole fix: 1c190fe paused seconds after the lease, so
        before=0/after=0 measured silence over nothing."""
        with open(os.path.join(os.path.dirname(os.path.abspath(__file__)),
                               "e2e_m4_exit.py"), encoding="utf-8") as fh:
            src = fh.read()
        body = src[src.index("def c4e_agent_turn"):]
        body = body[:body.index("\ndef ")]
        self.assertIn("wait_c4e_first_transcript", body)
        self.assertLess(body.index("wait_c4e_first_transcript"),
                        body.index('COMPOSE + ["pause", owner]'),
                        "the pause precedes the transcript wait — the fence would "
                        "land on an empty transcript again")
        self.assertGreater(m.C4E_FIRST_CHUNK_S, m.C4E_FREEZE_S,
                           "the wait cap must leave room for a real turn's first "
                           "flush before the arm gives up")

    def test_the_pre_transcript_backstop_still_never_passes_on_zero(self):
        self.assertEqual([ok for _, ok, _ in m.c4e_pre_transcript_verdict("0")], [None])
        self.assertEqual([ok for _, ok, _ in m.c4e_pre_transcript_verdict("4471")],
                         [True])


# --- c4e-fence: the streamed-transcript set, over the lab turn's own journal ---
# Lab read of turn 01a188d5-7154-… (the run that GAPped "the attempt reached
# 'succeeded' on its own before any conversation.message.agent row landed (0 rows
# in 180s)"): conversation.tool.call ×5, conversation.tool.update ×20,
# conversation.permission.requested ×4, conversation.permission.decided ×4,
# conversation.message.agent ×1 — and the ONE agent-text row landed only at turn
# END. 09-api-events-data.md (M2/ADR-0016) fixes that family and states "the
# transcript is `domain_events` scoped by `conversation_id`": the transcript is
# the stream, so § 7.1 C4e's max(global_seq) sample on type=
# 'conversation.message.agent' alone can never fence a turn mid-flight. The arm
# now fences on the first STREAMED row and the quiet check compares the streamed
# max across the unpause — with turn.* excluded (the contract itself expects the
# system's conversation.turn.interrupted to land AFTER the fence) and the
# permission pair excluded (its decided half is the approver's write, not the
# stale worker's).


def lab_turn_rows(end_landed):
    """The 01a188d5 ledger read as (global_seq, type) in journal order; the
    end_landed flag adds the turn-end conversation.message.agent ×1 and
    conversation.turn.completed ×1 rows the lab saw only after 'succeeded'."""
    types = []
    for _call in range(5):                       # tool.call ×5, each followed by
        types.append("conversation.tool.call")   # tool.update ×20 total
        types += ["conversation.tool.update"] * 4
    for _pair in range(4):                       # permission.requested/decided ×4
        types.append("conversation.permission.requested")
        types.append("conversation.permission.decided")
    rows = [(4401 + i, t) for i, t in enumerate(types)]
    if end_landed:
        rows.append((4434, "conversation.message.agent"))    # the ONLY text row
        rows.append((4435, "conversation.turn.completed"))   # …at turn end
    return rows


def seq_max(rows, types):
    """What `select coalesce(max(global_seq),0) … and type IN (types)` returns,
    computed in Python over the fixture."""
    return max((seq for seq, typ in rows if typ in set(types)), default=0)


class C4eStreamedTranscriptTest(unittest.TestCase):
    """The streamed set itself, pinned off the 01a188d5 fixture: the types, the
    two reads' shared IN-list, the fence-on-stream, the vacuity guard, and the
    quiet comparison the arm actually makes."""

    MID = lab_turn_rows(end_landed=False)     # the turn as it was WHILE streaming
    FULL = lab_turn_rows(end_landed=True)     # …and as it closed on its own

    def test_the_fixture_is_the_ledger_read_it_cites(self):
        from collections import Counter
        counts = Counter(t for _seq, t in self.FULL)
        self.assertEqual(counts["conversation.tool.call"], 5)
        self.assertEqual(counts["conversation.tool.update"], 20)
        self.assertEqual(counts["conversation.permission.requested"], 4)
        self.assertEqual(counts["conversation.permission.decided"], 4)
        self.assertEqual(counts["conversation.message.agent"], 1)
        self.assertEqual(counts["conversation.turn.completed"], 1)
        self.assertEqual(self.FULL[-2], (4434, "conversation.message.agent"),
                         "the fixture's single agent-text row must land at the END "
                         "of the journal — that is the lab observation C4e reacts to")

    def test_the_transcript_set_is_exactly_the_streamed_types(self):
        self.assertEqual(set(m.C4E_TRANSCRIPT_TYPES), {"conversation.message.agent",
                        "conversation.thought", "conversation.tool.call",
                        "conversation.tool.update"})
        for typ in m.C4E_TRANSCRIPT_TYPES:
            self.assertTrue(typ.startswith("conversation."), typ)

    def test_both_silence_reads_share_one_in_list(self):
        seq_sql = m.c4e_transcript_seq_sql(_TURN)
        ts_sql = m.c4e_transcript_predates_sql(_TURN, "2026-10-29 14:57:49+00")
        types = re.findall(r"'conversation\.[a-z.]+?'", seq_sql)
        self.assertEqual(types, ["'conversation.message.agent'",
                                 "'conversation.thought'",
                                 "'conversation.tool.call'",
                                 "'conversation.tool.update'"], seq_sql)
        self.assertEqual(re.findall(r"'conversation\.[a-z.]+?'", ts_sql), types,
                         "the seq and timing arms watch different sets")
        self.assertIn("type IN (", seq_sql)
        self.assertIn("'conversation.message.agent'", seq_sql,
                      "§ 7.1's sampled type stays INSIDE the set — the arm widens "
                      "the read, it does not replace the contract's sample")
        for sql in (seq_sql, ts_sql):
            self.assertNotIn("conversation.turn", sql,
                             "the contract EXPECTS the system's turn.interrupted "
                             "row AFTER the fence — counting it would fail the "
                             "quiet arm on the product's own correct write")
            self.assertNotIn("permission", sql,
                             "permission.decided is the approver's write, not the "
                             "stale worker's — unattributable to the fence")

    def test_the_agent_text_read_was_still_empty_mid_turn_on_the_lab_journal(self):
        """The old contract's read, replayed: at every mid-turn moment of 01a188d5
        the message.agent-only max was 0 — waiting for it can NEVER fence that
        turn, which is exactly the '0 rows in 180s' GAP."""
        self.assertEqual(seq_max(self.MID, ("conversation.message.agent",)), 0)
        gap = m.c4e_first_transcript_gap("0", "succeeded", 180)
        self.assertEqual([ok for _l, ok, _d in gap], [None])
        self.assertIn("reached 'succeeded' on its own", gap[0][2],
                      "a turn that text-only-closed must still say the lab's reason")

    def test_the_streamed_read_fences_that_same_turn_mid_flight(self):
        streamed = seq_max(self.MID, m.C4E_TRANSCRIPT_TYPES)
        self.assertEqual(streamed, 4425, "the turn's last streamed tool.update row "
                         "(tool.call/tool.update are the journal's first 25 rows)")
        self.assertGreater(streamed, 0,
                           "permission rows sit ABOVE the streamed max but are "
                           "not part of it — the fence key is the stream")
        self.assertEqual(m.c4e_first_transcript_gap(str(streamed), "running", 180),
                         [], "the fixed read sees 01a188d5's stream and fences")
        self.assertEqual([ok for _, ok, _ in m.c4e_pre_transcript_verdict(str(streamed))],
                         [True], "the post-fence precondition PASSes on the stream")

    def test_a_journal_of_only_turn_and_permission_rows_stays_vacuous(self):
        """The guard the widening must NOT erode: rows the streamed set excludes
        are still silence-over-nothing for C4e — GAP with the exact reason."""
        rows = [(4501 + i, t) for i, t in enumerate(
            ["conversation.permission.requested", "conversation.permission.decided",
             "conversation.turn.started", "conversation.turn.completed"])]
        self.assertEqual(seq_max(rows, m.C4E_TRANSCRIPT_TYPES), 0)
        got = m.c4e_first_transcript_gap("0", "running", 180)
        self.assertEqual([ok for _l, ok, _d in got], [None])
        self.assertIn("0 streamed transcript rows", got[0][2])
        self.assertIn("GAP, never PASS", got[0][2])

    def test_the_quiet_arm_compares_the_streamed_max_across_the_unpause(self):
        before = seq_max(self.MID, m.C4E_TRANSCRIPT_TYPES)
        after = before                       # the fenced worker wrote NOTHING new
        v = m.c4e_transcript_verdicts(str(before), str(after), "t")
        self.assertEqual([ok for _l, ok, _d in v], [True, True], v)

    def test_a_stale_tool_update_after_the_fence_breaks_the_quiet_arm(self):
        """§ 7.1 C4e's failure mode is a tool.update by the stale owner, not only
        a text row — the widened set catches exactly what the contract's sample
        missed at 01a188d5."""
        before = seq_max(self.MID, m.C4E_TRANSCRIPT_TYPES)
        after = seq_max(self.MID + [(4434, "conversation.tool.update")],
                        m.C4E_TRANSCRIPT_TYPES)
        v = m.c4e_transcript_verdicts(str(before), str(after), "t")
        self.assertIs(v[0][1], False, f"a stale streamed row must FAIL: {v}")

    def test_the_systems_post_fence_interrupted_row_keeps_the_arm_quiet(self):
        """The reconciler writes conversation.turn.interrupted AFTER the fence by
        design (§ 7.1 C4e names that row as the PASS half) — it must not trip the
        silence arm."""
        before = seq_max(self.MID, m.C4E_TRANSCRIPT_TYPES)
        after = seq_max(self.MID + [(4434, "conversation.turn.interrupted")],
                        m.C4E_TRANSCRIPT_TYPES)
        self.assertEqual(after, before)
        v = m.c4e_transcript_verdicts(str(before), str(after), "t")
        self.assertEqual([ok for _l, ok, _d in v], [True, True], v)


class C4eFirstChunkPollTest(unittest.TestCase):
    """wait_c4e_first_transcript's loop without a lab: the psql answers faked at
    the helper seam. The attempt-status read returns `status|error_class`, so a
    poll that asked psql_rows for ONE column would drop every row as ragged and
    read a live attempt as 'unreadable' forever — the 2-column contract is
    pinned here."""

    def poll(self, seq_answers, status_answer):
        saved_psql, saved_sleep = m.psql, m.time.sleep
        saved_time = m.time.time
        calls = {"seq": 0}
        ticks = {"t": 1_000_000.0}

        def fake_time():                       # 5s per read: a bounded virtual poll
            ticks["t"] += 5.0
            return ticks["t"]
        try:
            def fake_psql(sql):
                if "max(global_seq)" in sql:
                    i = calls["seq"]
                    calls["seq"] += 1
                    return seq_answers[min(i, len(seq_answers) - 1)]
                if "FROM attempts" in sql:
                    return status_answer
                raise AssertionError(f"unexpected poll read: {sql}")
            m.psql = fake_psql
            m.time.sleep = lambda s: None
            m.time.time = fake_time
            return m.wait_c4e_first_transcript(_TURN, _ATT, 180), calls
        finally:
            m.psql, m.time.sleep = saved_psql, saved_sleep
            m.time.time = saved_time

    def test_it_waits_until_the_first_row_lands(self):
        (seq, status), calls = self.poll(["0", "0", "4471"], "running|-")
        self.assertEqual(seq, "4471")
        self.assertEqual(status, "running")
        self.assertEqual(calls["seq"], 3)

    def test_it_stops_when_the_attempt_closes_itself(self):
        (seq, status), _c = self.poll(["0"], "succeeded|-")
        self.assertEqual((seq, status), ("0", "succeeded"))
        gap = m.c4e_first_transcript_gap(seq, status, 180)
        self.assertEqual([ok for _, ok, _ in gap], [None])
        self.assertIn("on its own", gap[0][2])

    def test_an_unreadable_status_row_never_stops_the_wait_early(self):
        # psql_rows drops a 1-field row against ncols=2: status stays
        # "unreadable", which is NOT terminal — the loop must run to the cap.
        (seq, status), calls = self.poll(["0"], "(no row)")
        self.assertEqual(status, "unreadable")
        self.assertGreater(calls["seq"], 1)   # it kept polling, did not bail


class PsqlSurfacingTest(unittest.TestCase):
    """The C7a/C3a failure SHAPE: a psql error must abort loudly with its rc,
    stderr and the SQL — never be handed back as the empty string or '0' that a
    count verdict then reads as a clean zero."""

    def test_error_rc_raises_naming_rc_stderr_and_sql(self):
        saved, calls = m.run, []
        try:
            def fake_run(cmd, **kw):
                calls.append(cmd)
                return 1, 'ERROR:  column "nope" does not exist'
            m.run = fake_run
            with self.assertRaises(RuntimeError) as ctx:
                m.psql("SELECT nope FROM attempts")
            self.assertIn('column "nope" does not exist', str(ctx.exception))
            self.assertIn("SELECT nope FROM attempts", str(ctx.exception))
            self.assertIn("rc=1", str(ctx.exception))
            self.assertEqual(calls[0][-1], "SELECT nope FROM attempts")
        finally:
            m.run = saved

    def test_success_is_the_stripped_single_value(self):
        saved, m.run = m.run, lambda cmd, **kw: (0, "  4471\n")
        try:
            self.assertEqual(m.psql("SELECT 4471"), "4471")
        finally:
            m.run = saved


if __name__ == "__main__":
    unittest.main(verbosity=2)
