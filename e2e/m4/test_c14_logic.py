#!/usr/bin/env python3
"""test_c14_logic.py - offline unit proof for e2e_m4_exit.py's C14 pure logic.

Runs WITHOUT a stack (stdlib unittest only): the journal-window contiguity verdict
(no seq twice, no hole, no unmeasurable window), the terminal-event / duplicated-
succeeded-key verdicts from C14b's two SQL shapes, the SSE no-gap/no-duplicate
verdicts over a canned reconnect, the never-both-down sampling verdicts, the
advisory-lock handover verdict from per-replica acquire counts, the mid-roll
approval's exactly-once verdict, and the final-state verdict.

A green here means the VERDICT ALGEBRA is right. It never substitutes for C14's
live roll — restarting api-a/api-b for real while a run advances, and reading the
journal, the SSE stream and the serve logs across it (12-test-strategy.md: a
mocked green is not done).

usage: python3 e2e/m4/test_c14_logic.py [-v]
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import e2e_m4_exit as m  # noqa: E402 — importing the driver is the point


def one(rows, needle):
    vs = [ok for l, ok, _d in rows if needle in l]
    assert len(vs) == 1, f"{needle!r} produced {len(vs)} verdicts: {[l for l, _o, _d in rows]}"
    return vs[0]


def detail(rows, needle):
    return [d for l, _o, d in rows if needle in l][0]


class Scan(unittest.TestCase):
    def test_clean_run_of_seqs(self):
        self.assertEqual(m.c14_scan_seqs(["1", "2", "3", "4"]), ([], [], []))

    def test_duplicate_seq_is_a_double_advance(self):
        dups, regress, _miss = m.c14_scan_seqs([1, 2, 2, 3])
        self.assertEqual(dups, [2])
        self.assertEqual(regress, ["2>2"])          # a repeat is also not ascending

    def test_hole_is_reported_but_a_slice_is_not_a_window(self):
        # one run's own slice legitimately interleaves with other runs: the CALLER
        # decides which list is a gap-free window (see the verdicts below).
        _d, _r, miss = m.c14_scan_seqs([10, 11, 14])
        self.assertEqual(miss, [12, 13])

    def test_unparseable_seqs_are_dropped_not_zeroed(self):
        self.assertEqual(m.c14_scan_seqs(["7", "oops", 8]), ([], [], []))
        self.assertEqual(m.c14_scan_seqs([]), ([], [], []))


class Journal(unittest.TestCase):
    def test_contiguous_window_and_ordered_slice_pass(self):
        v = m.c14_journal_verdicts(["5", "6", "7", "8"], ["5", "7"])
        self.assertTrue(one(v, "no advance is duplicated"))
        self.assertTrue(one(v, "the journal window is contiguous"))
        self.assertTrue(one(v, "journal slice stays strictly ascending"))

    def test_duplicated_seq_fails_the_duplicate_arm_only(self):
        v = m.c14_journal_verdicts([5, 6, 6, 7], [5, 6, 7])
        self.assertFalse(one(v, "no advance is duplicated"))
        self.assertTrue(one(v, "the journal window is contiguous"))

    def test_hole_in_the_window_is_a_gap_not_a_pass(self):
        v = m.c14_journal_verdicts([5, 6, 9], [5, 9])
        self.assertIsNone(one(v, "the journal window is contiguous"))
        self.assertIn("missing [7, 8]", detail(v, "the journal window is contiguous"))
        self.assertTrue(one(v, "no advance is duplicated"))

    def test_empty_window_gaps_everything(self):
        for win in ([], None):
            v = m.c14_journal_verdicts(win, [])
            self.assertIsNone(one(v, "the journal window is contiguous"), str(win))
            self.assertEqual(len(v), 1, f"an unreadable window says one thing: {v}")
        v = m.c14_journal_verdicts(["5"], [])
        self.assertIsNone(one(v, "journal slice stays strictly ascending"))

    def test_out_of_order_slice_fails(self):
        v = m.c14_journal_verdicts([1, 2, 3], [3, 2])
        self.assertFalse(one(v, "journal slice stays strictly ascending"))


class Terminal(unittest.TestCase):
    def test_single_terminal_and_no_duplicated_key_pass(self):
        v = m.c14_terminal_verdicts({"run.completed": 1, "node.scope.iteration": 2,
                                     "node.attempt.retry_scheduled": 1}, 0)
        self.assertTrue(one(v, "no duplicated terminal event"))
        self.assertTrue(one(v, "two 'succeeded' ledger rows"))

    def test_two_run_completed_rows_is_the_duplicate_advance(self):
        v = m.c14_terminal_verdicts({"run.completed": 2}, 0)
        self.assertFalse(one(v, "no duplicated terminal event"))

    def test_two_succeeded_rows_for_one_key_fails(self):
        v = m.c14_terminal_verdicts({"run.completed": 1}, 1)
        self.assertFalse(one(v, "two 'succeeded' ledger rows"))
        self.assertIn("1 duplicated key", detail(v, "two 'succeeded' ledger rows"))

    def test_unreadable_counts_gap_never_pass(self):
        v = m.c14_terminal_verdicts(None, None)
        self.assertIsNone(one(v, "no duplicated terminal event"))
        self.assertIsNone(one(v, "two 'succeeded' ledger rows"))
        v = m.c14_terminal_verdicts({}, None)
        self.assertIsNone(one(v, "no duplicated terminal event"))


class Sse(unittest.TestCase):
    def test_no_gap_no_duplicate_across_the_reconnect(self):
        # leg 1: 10..12, reconnect at Last-Event-ID=12, leg 2: 13..15
        v = m.c14_sse_verdicts([10, 11, 12, 13, 14, 15], [10, 11, 12, 13, 14, 15],
                               reconnected=1, foreign=0)
        self.assertTrue(one(v, "no event crosses the roll twice"))
        self.assertTrue(one(v, "every journalled event"))
        self.assertTrue(one(v, "ascending seq order"))
        self.assertTrue(one(v, "reconnect with Last-Event-ID"))
        self.assertTrue(one(v, "no cross-project event"))

    def test_replayed_event_after_the_resume_fails(self):
        v = m.c14_sse_verdicts([10, 11, 12, 12, 13], [10, 11, 12, 13], 1, 0)
        self.assertFalse(one(v, "no event crosses the roll twice"))

    def test_missing_event_fails_the_no_gap_arm(self):
        v = m.c14_sse_verdicts([10, 11, 13], [10, 11, 12, 13], 1, 0)
        self.assertFalse(one(v, "every journalled event"))
        self.assertIn("12", detail(v, "every journalled event"))

    def test_out_of_order_delivery_fails(self):
        v = m.c14_sse_verdicts([11, 10, 12], [10, 11, 12], 1, 0)
        self.assertFalse(one(v, "ascending seq order"))

    def test_cross_project_row_fails(self):
        v = m.c14_sse_verdicts([10, 11], [10, 11], 1, 1)
        self.assertFalse(one(v, "no cross-project event"))

    def test_no_frames_gaps_the_whole_arm(self):
        for frames in ([], None):
            v = m.c14_sse_verdicts(frames, [10], 1, 0)
            self.assertIsNone(one(v, "no gap and no duplicate"), str(frames))
            self.assertEqual(len(v), 1)

    def test_uninterrupted_stream_gaps_the_resume_arm(self):
        v = m.c14_sse_verdicts([10, 11], [10, 11], 0, 0)
        self.assertIsNone(one(v, "reconnect with Last-Event-ID"))
        self.assertIn("never dropped", detail(v, "reconnect with Last-Event-ID"))

    def test_unreadable_journal_slice_gaps_the_no_gap_arm(self):
        v = m.c14_sse_verdicts([10, 11], None, 1, 0)
        self.assertIsNone(one(v, "every journalled event"))


class Roll(unittest.TestCase):
    def test_all_probes_answer(self):
        s = [("api-a", "lb", True), ("api-a", "other", True),
             ("api-b", "lb", True), ("api-b", "other", True)]
        v = m.c14_roll_verdicts(s)
        self.assertEqual(len(v), 4)
        self.assertTrue(all(ok is True for _l, ok, _d in v))

    def test_peer_down_during_the_roll_fails_the_one_at_a_time_rule(self):
        s = [("api-a", "lb", True), ("api-a", "other", True),
             ("api-b", "lb", True), ("api-b", "other", True), ("api-b", "other", False)]
        v = m.c14_roll_verdicts(s)
        self.assertTrue(one(v, "the lb answers every probe while api-a restarts"))
        self.assertFalse(one(v, "the surviving replica answers every probe while api-b "
                               "restarts"))
        self.assertIn("1/2", detail(v, "the surviving replica answers every probe while api-b "
                                       "restarts"))

    def test_lb_down_fails(self):
        v = m.c14_roll_verdicts([("api-a", "lb", False), ("api-a", "other", True)])
        self.assertFalse(one(v, "the lb answers every probe while api-a restarts"))

    def test_nothing_sampled_gaps(self):
        v = m.c14_roll_verdicts([])
        self.assertEqual(len(v), 1)
        self.assertIsNone(v[0][1])


class Lock(unittest.TestCase):
    def test_new_acquisition_after_the_roll_is_a_pass(self):
        v = m.c14_lock_verdicts({"api-a": 1, "api-b": 0}, {"api-a": 1, "api-b": 1})
        self.assertTrue(one(v, "advisory lock moves to a surviving replica"))
        self.assertIn("api-b", detail(v, "advisory lock moves to a surviving replica"))

    def test_no_new_acquisition_fails(self):
        v = m.c14_lock_verdicts({"api-a": 1, "api-b": 0}, {"api-a": 1, "api-b": 0})
        self.assertFalse(one(v, "advisory lock moves to a surviving replica"))

    def test_unreadable_logs_gap(self):
        for before, after in ((None, None), ({"api-a": 0}, None), (None, {"api-a": 1})):
            v = m.c14_lock_verdicts(before, after)
            self.assertIsNone(one(v, "advisory lock moves to a surviving replica"))


class State(unittest.TestCase):
    def test_completed_is_the_same_outcome_as_no_roll(self):
        self.assertTrue(one(m.c14_state_verdicts("completed"), "the roll changed the timing"))

    def test_any_other_state_fails(self):
        for st in ("failed", "interrupted", "", None):
            v = m.c14_state_verdicts(st)
            self.assertFalse(one(v, "the roll changed the timing"), str(st))


class Approval(unittest.TestCase):
    def test_lands_exactly_once(self):
        v = m.c14_approval_verdicts({"status": 200}, 1)
        self.assertTrue(one(v, "is accepted (200)"))
        self.assertTrue(one(v, "EXACTLY ONCE"))

    def test_two_decided_rows_is_the_double_write(self):
        v = m.c14_approval_verdicts({"status": 200}, 2)
        self.assertTrue(one(v, "is accepted (200)"))
        self.assertFalse(one(v, "EXACTLY ONCE"))

    def test_refused_decision_fails(self):
        v = m.c14_approval_verdicts({"status": 409}, 0)
        self.assertFalse(one(v, "is accepted (200)"))
        self.assertFalse(one(v, "EXACTLY ONCE"))

    def test_unreadable_count_gaps_the_once_arm(self):
        v = m.c14_approval_verdicts({"status": 200}, None)
        self.assertIsNone(one(v, "EXACTLY ONCE"))
        v = m.c14_approval_verdicts(None, None)
        self.assertFalse(one(v, "is accepted (200)"))


class Words(unittest.TestCase):
    def test_helpers_never_pass_on_absent_evidence(self):
        """The README rule: an unmeasurable arm is None (GAP), never True."""
        for rows in (m.c14_journal_verdicts([], []), m.c14_terminal_verdicts(None, None),
                     m.c14_sse_verdicts([], [], None, None), m.c14_roll_verdicts([]),
                     m.c14_lock_verdicts(None, None), m.c14_approval_verdicts({}, None)):
            self.assertTrue(any(ok is None for _l, ok, _d in rows),
                            f"{rows} passes with nothing measured")

    def test_c14_is_registered_not_stubbed(self):
        body = open(os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                 "e2e_m4_exit.py"), encoding="utf-8").read()
        body = body.split("def c14():")[1].split("def w1(")[0]
        self.assertEqual([g for g, _f in m.GATES].index("C14") + 1, 14)
        # the ONLY skip left in the gate is the absent-stack precondition; the body
        # itself must roll, not skip.
        self.assertEqual(body.count('skip("C14"'), 1, "c14() is still a SKIP stub")
        self.assertIn("c14_roll_one", body)
        self.assertIn("C14Stream", body)


if __name__ == "__main__":
    unittest.main(verbosity=2 if "-v" in sys.argv else 1)
