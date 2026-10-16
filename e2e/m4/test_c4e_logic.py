#!/usr/bin/env python3
"""test_c4e_logic.py — offline unit proof for e2e_m4_exit.py's C4e arm.

live9/C4.out:66 GAPped "C4e the fenced turn adds no transcript after unpause —
the fenced attempt is /plan with attempts.turn_id NULL". § 7.1 C4e is only about
a still-running ACP child, so the driver now fences the REAL-Claude pipeline's
live /build_until_verified[1]/implement and reads C4e's row there. These tests
pin the parts that can be wrong WITHOUT a lab: the SQL the arm sends (domain_events
has no turn_id COLUMN), the verdict algebra that must GAP rather than green an
unmeasurable arm, and the sequencing that keeps the twin arms untouched while
making the agent arm run on every path where a manifest and a session exist.

A green here never substitutes for the live fence (12-test-strategy.md: a mocked
green is not done).

usage: python3 e2e/m4/test_c4e_logic.py [-v]
"""
import ast
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import e2e_m4_exit as m  # noqa: E402 — importing the driver is the point
from test_c4_logic import TABLES, table_aliases, unresolved_columns  # noqa: E402

DRIVER = os.path.join(HERE, "e2e_m4_exit.py")


def tree():
    with open(DRIVER, encoding="utf-8") as fh:
        return ast.parse(fh.read())


def body_of(fn_name):
    for node in tree().body:
        if isinstance(node, ast.FunctionDef) and node.name == fn_name:
            return ast.get_source_segment(open(DRIVER, encoding="utf-8").read(), node) or ""
    raise AssertionError(f"{fn_name} is not a module-level def in {DRIVER}")


def calls_in(fn_name):
    for node in tree().body:
        if isinstance(node, ast.FunctionDef) and node.name == fn_name:
            return [c for c in ast.walk(node) if isinstance(c, ast.Call)]
    raise AssertionError(f"{fn_name} is not a module-level def in {DRIVER}")


def kwargs_of(fn_name, callee):
    return [{k.arg: ast.unparse(k.value) for k in c.keywords}
            for c in calls_in(fn_name)
            if isinstance(c.func, ast.Name) and c.func.id == callee]


class C4eSqlTest(unittest.TestCase):
    TURN = "01a1457b-0000-7000-8000-000000000001"
    ATT = "01a1457b-0000-7000-8000-000000000002"

    def test_the_turn_reads_scope_on_the_payload_turn_id_not_a_missing_column(self):
        """§ 7.1 writes `where turn_id='$TURN'`, but domain_events has no turn_id
        column (00001 + 00005 add run_id/node_execution_id/attempt_id only) and
        BOTH writers of conversation.turn.interrupted append conversation-scoped
        with attempt_id NULL. Filtering on attempt_id — or on a column that does
        not exist — reads zero rows and GAPs a working product."""
        for sql in (m.c4e_turn_events_sql(self.TURN),
                    m.c4e_turn_types_sql(self.TURN),
                    m.c4e_transcript_seq_sql(self.TURN),
                    m.c4e_transcript_predates_sql(self.TURN, "2026-10-16 16:00:00+00")):
            self.assertIn("payload->>'turn_id'", sql, sql)
            self.assertNotIn("WHERE turn_id", sql, sql)
            self.assertNotIn("turn_id =", sql, sql)
            self.assertIn(self.TURN, sql, sql)

    def test_the_turn_event_read_asks_for_the_contract_row(self):
        sql = m.c4e_turn_events_sql(self.TURN)
        self.assertIn("conversation.turn.interrupted", sql)
        self.assertIn("actor_kind", sql)
        self.assertIn("payload->>'reason'", sql)
        self.assertIn("ORDER BY global_seq", sql)

    def test_the_transcript_read_is_the_contract_max_global_seq(self):
        sql = m.c4e_transcript_seq_sql(self.TURN)
        self.assertIn("max(global_seq)", sql)
        self.assertIn("conversation.message.agent", sql)

    def test_the_timing_read_compares_against_the_unpause_in_postgres_clock(self):
        sql = m.c4e_transcript_predates_sql(self.TURN, "2026-10-16 16:12:23+00")
        self.assertIn("max(occurred_at) <= '2026-10-16 16:12:23+00'::timestamptz", sql)

    def test_the_shape_read_qualifies_every_column_it_joins_on(self):
        """live4/C4.out's crash: attempts and node_executions BOTH carry status,
        so a bare status in a joined SELECT aborts the whole gate."""
        sql = m.c4e_attempt_shape_sql(self.ATT)
        self.assertEqual(unresolved_columns(sql), [], sql)
        aliases = table_aliases(sql)
        self.assertEqual(aliases.get("a"), "attempts")
        self.assertEqual(aliases.get("ne"), "node_executions")
        self.assertNotIn(" status", sql.replace("a.status", "").replace("ne.status", ""))

    def test_the_turn_and_attempt_reads_name_columns_the_migrations_have(self):
        for sql in (m.c4e_turn_row_sql(self.TURN), m.c4e_attempt_status_sql(self.ATT)):
            self.assertEqual(unresolved_columns(sql), [], sql)
        self.assertIn("stop_reason", m.c4e_turn_row_sql(self.TURN))
        self.assertIn("conversation_turns", m.c4e_turn_row_sql(self.TURN))

    def test_the_single_table_reads_name_columns_that_really_exist(self):
        """unresolved_columns only sees QUALIFIED names, and these reads are bare
        (one table, no join), so the columns are checked against the migration
        blocks directly — a status spelled wrong is a leg that reports nothing."""
        bare = {"conversation_turns": ("status", "stop_reason", "id"),
                "attempts": ("status", "error_class", "id")}
        for table, cols in bare.items():
            for col in cols:
                self.assertIn(col, TABLES[table], f"{table}.{col} is not in the schema")
        self.assertIn("coalesce(status", m.c4e_turn_row_sql(self.TURN))
        self.assertIn("coalesce(error_class", m.c4e_attempt_status_sql(self.ATT))
        self.assertNotIn("JOIN", m.c4e_attempt_status_sql(self.ATT).upper())


def only(verdicts):
    """One (label, ok, detail) from a single-line arm, with the row spelled out on
    failure."""
    assert len(verdicts) == 1, verdicts
    return verdicts[0]


class C4eShapeVerdictTest(unittest.TestCase):
    """The arm's own gate: an agent.acp attempt with a turn, or it says GAP."""

    def test_agent_acp_attempt_with_a_turn_is_the_measurable_case(self):
        label, ok, _d = only(m.c4e_agent_shape_verdicts(
            {"kind": "agent.acp", "turn": "t-1", "conversation": "c-1",
             "key": "/build_until_verified[1]/implement"}))
        self.assertTrue(ok, label)

    def test_a_process_exec_claim_gaps_rather_than_passes(self):
        _l, ok, _d = only(m.c4e_agent_shape_verdicts(
            {"kind": "process.exec", "turn": "(none)", "conversation": "(none)",
             "key": "/plan"}))
        self.assertIsNone(ok, "an unmeasurable arm is a GAP — never a PASS, and never a "
                              "FAIL of a product that was never asked to do this")

    def test_agent_acp_without_a_turn_is_a_fail(self):
        """§ 4 step 6 stamps attempts.turn_id in the SAME transaction as the claim,
        so an agent.acp attempt with no turn is a product bug, not a lab artefact."""
        _l, ok, _d = only(m.c4e_agent_shape_verdicts(
            {"kind": "agent.acp", "turn": "(none)", "conversation": "(none)",
             "key": "/build_until_verified[1]/implement"}))
        self.assertIs(ok, False, ok)

    def test_a_vanished_row_gaps(self):
        _l, ok, _d = only(m.c4e_agent_shape_verdicts(None))
        self.assertIsNone(ok)

    def test_no_turn_spellings_are_never_mistaken_for_a_turn(self):
        for turn in ("", "-", "(none)", "null", "None"):
            _l, ok, _d = only(m.c4e_agent_shape_verdicts(
                {"kind": "agent.acp", "turn": turn, "conversation": "c-1", "key": "/x"}))
            self.assertIsNot(ok, True, f"{turn!r} read as a turn: {ok}")


class C4eTurnRowTest(unittest.TestCase):
    def test_interrupted_without_stop_reason_passes_both_halves(self):
        v = m.c4e_turn_row_verdicts({"status": "interrupted", "stop_reason": "(none)"})
        self.assertEqual([ok for _l, ok, _d in v], [True, True], v)

    def test_a_stop_reason_on_an_interrupted_turn_fails(self):
        """00003's conversation_turn_interrupted_unreasoned: nothing reported an
        outcome, so a turn that claims one is lying."""
        _l, ok, _d = m.c4e_turn_row_verdicts(
            {"status": "interrupted", "stop_reason": "end_turn"})[1]
        self.assertIs(ok, False)

    def test_a_still_running_turn_fails_and_the_reason_half_gaps(self):
        v = m.c4e_turn_row_verdicts({"status": "running", "stop_reason": "(none)"})
        self.assertIs(v[0][1], False, v)
        self.assertIsNone(v[1][1], "there is no interrupted row to score a stop_reason on")

    def test_no_row_is_a_gap(self):
        _l, ok, _d = only(m.c4e_turn_row_verdicts(None))
        self.assertIsNone(ok)


class C4eTranscriptArmTest(unittest.TestCase):
    def test_an_empty_transcript_never_blanks_the_arm_into_a_pass(self):
        """before==after=='0' satisfies 'unchanged max(global_seq)' over NOTHING. The
        precondition line has to say so (GAP) instead of greening the arm."""
        _l, ok, _d = only(m.c4e_pre_transcript_verdict("0"))
        self.assertIsNone(ok)
        _l, ok, _d = only(m.c4e_pre_transcript_verdict("17"))
        self.assertIs(ok, True)
        _l, ok, _d = only(m.c4e_pre_transcript_verdict(""))
        self.assertIsNone(ok, "unreadable psql text is not evidence of a quiet turn")

    def test_a_stale_append_after_the_unpause_fails_the_quiet_arm(self):
        v = m.c4_transcript_verdicts("41", "44", "t", has_turn=True)
        self.assertIs(v[0][1], False, v)
        self.assertIs(v[1][1], True, v)

    def test_a_late_row_by_timestamp_fails_the_timing_arm(self):
        v = m.c4_transcript_verdicts("41", "41", "f", has_turn=True)
        self.assertIs(v[0][1], True, v)
        self.assertIs(v[1][1], False, v)

    def test_the_arm_says_nothing_without_a_turn(self):
        self.assertEqual(m.c4_transcript_verdicts("1", "1", "t", has_turn=False), [])

    def test_an_all_empty_transcript_does_not_green_the_comparison(self):
        """0 == 0 over nothing is the vacuous PASS the arm must never print — but a
        row that DID land after the fence is the failure § 7.1 C4e names, so that
        case is always reported."""
        self.assertEqual(m.c4e_transcript_verdicts("0", "0", "t", has_turn=True), [])
        v = m.c4e_transcript_verdicts("0", "7", "f", has_turn=True)
        self.assertIs(v[0][1], False, f"a late first chunk must FAIL, not vanish: {v}")
        v = m.c4e_transcript_verdicts("41", "41", "t", has_turn=True)
        self.assertEqual([ok for _l, ok, _d in v], [True, True], v)
        self.assertEqual(m.c4e_transcript_verdicts("0", "0", "t", has_turn=False), [])


class C4eAttemptRowTest(unittest.TestCase):
    def test_the_turns_attempt_must_have_been_interrupted_too(self):
        """ADR-0023 § 4 renews attempt and turn in ONE statement, so a fenced turn
        without a fenced attempt is the pairing breaking — C4e is not measured on a
        lease that never expired."""
        v = m.c4e_attempt_verdicts({"status": "interrupted", "error_class": "interrupted"})
        self.assertIs(v[0][1], True, v)
        for status in ("running", "leased", "succeeded"):
            v = m.c4e_attempt_verdicts({"status": status, "error_class": "-"})
            self.assertIs(v[0][1], False, f"{status}: {v}")
        self.assertIsNone(m.c4e_attempt_verdicts(None)[0][1])


class C4eJournalTest(unittest.TestCase):
    """§ 7.1 C4e's literal: 'conversation.turn.interrupted{reason:'lease_expired'} is
    present'. The contract names the reason, not the actor — the reconciler's pass
    writes 'system', the attempt's own fenced close writes 'worker', and both are
    legal writers of a turn row (ADR-0016 § 4 / ADR-0023 § 4)."""

    def row(self, typ="conversation.turn.interrupted", actor="system", reason="lease_expired"):
        return {"type": typ, "actor_kind": actor, "reason": reason}

    def test_the_reconciler_row_passes(self):
        v = m.c4e_turn_event_verdicts([self.row()])
        self.assertEqual([ok for _l, ok, _d in v], [True, True, True], v)

    def test_the_attempt_paired_close_row_also_passes(self):
        v = m.c4e_turn_event_verdicts([self.row(actor="worker")])
        self.assertEqual([ok for _l, ok, _d in v], [True, True, True], v)

    def test_no_row_is_a_fail_not_a_gap(self):
        """By the time this reads, the arm has proved the agent.acp attempt and its
        turn existed — a missing conversation.turn.interrupted is the product "
        "orphaning a lease, which is exactly what C4e was written to catch."""
        v = m.c4e_turn_event_verdicts([])
        self.assertEqual(len(v), 1, v)
        self.assertIs(v[0][1], False, v)

    def test_a_reason_that_is_not_lease_expired_fails(self):
        for reason in ("worker_shutdown", "human_takeover", "-"):
            v = m.c4e_turn_event_verdicts([self.row(reason=reason)])
            self.assertIs(v[1][1], False, f"reason={reason}: {v}")

    def test_a_mixed_reason_set_fails(self):
        v = m.c4e_turn_event_verdicts([self.row(), self.row(reason="worker_shutdown")])
        self.assertIs(v[1][1], False, v)

    def test_an_actor_that_may_not_close_a_turn_fails(self):
        v = m.c4e_turn_event_verdicts([self.row(actor="human")])
        self.assertEqual([v[0][1], v[2][1]], [True, False], v)


class C4eGapSentenceTest(unittest.TestCase):
    def test_the_no_live_attempt_sentence_names_the_target_and_refuses_a_pass(self):
        why = m.c4e_no_live_gap("run-1", "waiting_human", 900)
        self.assertIn("/build_until_verified[1]/implement", why)
        self.assertIn("run-1", why)
        self.assertIn("waiting_human", why)
        self.assertIn("GAP, never PASS", why)

    def test_the_target_is_the_post_gate_implement_node(self):
        self.assertEqual(m.C4E_TARGET_KEY, "/build_until_verified[1]/implement")
        self.assertEqual(m.C4E_FREEZE_S, m.C_FAULT_LEASE_S, "C4e fences exactly as C4 fences")
        self.assertGreaterEqual(m.C4E_FREEZE_S, 30 + 15, "lease 30s + reconciler tick 15s")


class C4eEmitTest(unittest.TestCase):
    def test_none_is_a_gap_and_everything_else_is_a_verdict(self):
        printed = []
        orig_check, orig_gap = m.check, m.gap
        m.check = lambda label, ok, detail="": (printed.append(("check", label, ok)), True)[1]
        m.gap = lambda label, why: printed.append(("gap", label, why))
        try:
            m.c4e_emit([("measured", True, "yes"), ("refused", False, "no"),
                        ("unmeasurable", None, "why")])
        finally:
            m.check, m.gap = orig_check, orig_gap
        self.assertEqual(printed, [("check", "measured", True), ("check", "refused", False),
                                   ("gap", "unmeasurable", "why")])


class C4eSequencingTest(unittest.TestCase):
    """The arm has to actually RUN: live9 finished the twin leg and never looked for
    an agent.acp attempt. The twin arms stay exactly where they were."""

    def test_c4_runs_the_agent_arm_on_every_path_that_could_measure_it(self):
        src = body_of("c4")
        self.assertGreaterEqual(src.count("c4e_agent_turn("), 5,
                                "the twin leg's four early exits (no twin variant, no run, "
                                "no live lease, unknown owner) plus its normal end all hand "
                                "off to C4e — one call per exit or the arm hides")

    def test_the_arm_waits_for_its_own_node_not_any_live_claim(self):
        kw = kwargs_of("c4e_agent_turn", "wait_live_past_gate")
        self.assertEqual(len(kw), 1, kw)
        self.assertEqual(kw[0].get("target"), "C4E_TARGET_KEY",
                         "a held /plan on the agent leg is not C4e's target — the twin "
                         "arm's any-live-claim default is what caught /plan on live9")
        arm = " ".join(body_of("c4e_agent_turn").split())
        self.assertIn('"C4e", target=C4E_TARGET_KEY', arm,
                      "the wait is tagged C4e so its lines belong to this gate")

    def test_the_arm_does_not_post_the_fault_hold(self):
        """The real Claude turn IS the hold; a hold_seconds input belongs to the twin's
        process.exec fixture, and posting it here would grade a sleep the node never
        reads (README: only the fault legs post it)."""
        for c in calls_in("c4e_agent_turn"):
            self.assertNotIn("hold_seconds", [k.arg for k in c.keywords], ast.unparse(c))

    def test_the_arm_cleans_up_after_itself(self):
        """An abandoned agent run keeps spending real Claude turns on the lab's shared
        worker capacity after the evidence is read (C8f/C8g's cancel route)."""
        self.assertIn("/cancel", body_of("c4e_agent_turn"))

    def test_the_twin_arms_are_unchanged(self):
        src = open(DRIVER, encoding="utf-8").read()
        for line in ("C4a the attempt about to be fenced",
                     "C4c the fenced attempt is interrupted",
                     "C4d the retry (attempt N+1) succeeded and the run completed",
                     "C4e no transcript row appended after unpause"):
            self.assertIn(line, src, f"C4's arm line {line!r} moved")

    def test_the_twin_no_longer_prints_a_bogus_c4e_gap(self):
        """live9's GAP was the twin arm announcing a measurement it could not make.
        The verdict now comes from the agent arm; the twin prints a NOTE."""
        src = body_of("c4")
        self.assertNotIn('gap("C4e', src)
        self.assertIn("C4e note — why this attempt carries no transcript arm", src)



if __name__ == "__main__":
    unittest.main(verbosity=2 if "-v" in sys.argv else 1)
