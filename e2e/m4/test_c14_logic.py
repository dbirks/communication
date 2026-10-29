#!/usr/bin/env python3
"""test_c14_logic.py - offline unit proof for e2e_m4_exit.py's C14 pure logic.

Runs WITHOUT a stack (stdlib unittest only): the journal-window contiguity verdict
(no seq twice, no hole, no unmeasurable window), the terminal-event / duplicated-
succeeded-key verdicts from C14b's two SQL shapes, the SSE no-gap/no-duplicate
verdicts over a canned reconnect, the never-both-down sampling verdicts, the
advisory-lock handover verdict from per-replica acquire counts, the mid-roll
approval's exactly-once verdict, the final-state verdict, and C14c's
precondition machinery: the per-replica env var / recreate-command construction
(flag in the PROCESS env, never in argv), the off-replica arm verdicts, and the
try/finally restore state, and WHICH compose files the recreate rides: the -f list is
read from the RUNNING container's com.docker.compose.project.config_files label (a lab
brought up with a fourth overlay, compose.real.yml, must be recreated WITH it), with the
driver's own COMPOSE list only as a reported fallback.

A green here means the VERDICT ALGEBRA is right. It never substitutes for C14's
live roll — restarting api-a/api-b for real while a run advances, and reading the
journal, the SSE stream and the serve logs across it (12-test-strategy.md: a
mocked green is not done).

usage: python3 e2e/m4/test_c14_logic.py [-v]
"""
import json
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


    def test_no_other_projection_regressed_the_same_way(self):
        """Every GROUP BY in the driver must group on columns/expression ordinals that
        do NOT themselves contain the aggregate (HAVING may, ORDER BY may)."""
        src = open(os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                "e2e_m4_exit.py"), encoding="utf-8").read()
        for line in src.splitlines():
            if "GROUP BY" not in line or "count(" not in line:
                continue
            before = line.split("GROUP BY")[0]
            self.assertNotIn("count(", before, f"aggregate left of GROUP BY: {line.strip()}")
            self.assertIn("HAVING", line.split("GROUP BY")[1],
                          f"aggregate inside a GROUP BY clause: {line.strip()}")


class D4TerminalGroupBy(unittest.TestCase):
    """live2/C14.out:50-57 — `ERROR: aggregate functions are not allowed in GROUP BY`:
    the projection ended in `GROUP BY 1`, and ordinal 1 IS the selected expression,
    which carries count(*), so C14b's terminal-event arm could only ever GAP."""

    def test_the_group_by_names_the_column_not_the_aggregate(self):
        sql = m.c14_terminal_group_sql("RUN")
        head, _, tail = sql.partition("GROUP BY")
        self.assertIn("GROUP BY type", sql)
        self.assertNotIn("GROUP BY 1", sql)
        self.assertNotIn("count(", tail, "an aggregate leaked into the GROUP BY clause")
        self.assertIn("count(*)::text", head)
        self.assertIn("'run.completed'", head)
        self.assertIn("RUN", sql)

    def test_the_row_shape_still_feeds_the_verdicts(self):
        canned = "run.completed|1\nnode.scope.iteration|2\nnode.attempt.retry_scheduled|0"
        counts = {r[0]: m._int(r[1]) for r in m.psql_rows(canned, 2)}
        self.assertEqual({"run.completed": 1, "node.scope.iteration": 2,
                          "node.attempt.retry_scheduled": 0}, counts)
        self.assertTrue(one(m.c14_terminal_verdicts(counts, 0), "at most once"))
        for t in m.C14_DUP_TYPES:
            self.assertIn(f"'{t}'", m.c14_terminal_group_sql("R"))


class D6AdvisoryLockProbe(unittest.TestCase):
    """live2/C14.out:63 — the probe demanded a NEW acquisition line, but noteLeadership
    logs only a not-held→held transition inside one process and the driver releases the
    session lock every tick, so 0/0 is what a blind probe produces, not a product bug."""

    def test_zero_before_count_is_a_gap_never_a_fail(self):
        v = m.c14_lock_verdicts({"api-a": 0, "api-b": 0}, {"api-a": 0, "api-b": 0})
        self.assertIsNone(one(v, "advisory lock moves to a surviving replica"))
        d = detail(v, "advisory lock moves to a surviving replica")
        self.assertIn("unfalsifiable", d)
        self.assertIn("ledger", d, "the GAP must point at the arms that DO prove safety")

    def test_a_visible_lock_still_gives_a_falsifiable_verdict(self):
        self.assertFalse(one(m.c14_lock_verdicts({"api-a": 2, "api-b": 0},
                                                 {"api-a": 2, "api-b": 0}),
                             "advisory lock moves to a surviving replica"))
        self.assertTrue(one(m.c14_lock_verdicts({"api-a": 2, "api-b": 0},
                                                {"api-a": 2, "api-b": 1}),
                            "advisory lock moves to a surviving replica"))

    def test_readable_but_empty_log_is_zero_marks_not_unreadable(self):
        """compose `logs --since <now>` with no lines yet in the window returns rc=0 and
        empty output: that is a READABLE log with zero marks, so it must report
        {service: 0} (and GAP via the 0-count branch of c14_lock_verdicts). Only a
        non-zero rc (or a raising invocation) means the logs could not be read."""
        real = m.run
        try:
            for rc, out, want in ((0, "", {"api-a": 0, "api-b": 0}),
                                 (0, "   \n", {"api-a": 0, "api-b": 0}),
                                 (0, "api-b-1 | m4 driver acquired the advisory lock\n",
                                  {"api-a": 0, "api-b": 1}),
                                 (1, "docker: not found", None)):
                m.run = lambda cmd, _rc=rc, _out=out: (_rc, _out)
                self.assertEqual(want, m.c14_lock_marks(), f"rc={rc} out={out!r}")

            def boom(cmd):
                raise OSError("compose unreadable")
            m.run = boom
            self.assertIsNone(m.c14_lock_marks())
        finally:
            m.run = real
        # the 0-count dict still GAPs — never a PASS by silence
        self.assertIsNone(one(m.c14_lock_verdicts({"api-a": 0, "api-b": 0},
                                                  {"api-a": 0, "api-b": 0}),
                             "advisory lock moves to a surviving replica"))
        self.assertIsNone(one(m.c14_off_replica_verdicts(
            "api-a", "api-b", {"/x": 200}, (201, "r"), ["queued", "running"],
            {"api-a": 0, "api-b": 0}), "never claims the driver's advisory lock"))

    def test_compose_log_prefix_is_matched_tolerantly(self):
        log = ("api-a  | 2026-10-16T03:00:00Z INF m4 driver acquired the advisory lock\n"
               "api-b  | 2026-10-16T03:00:01Z INF something else\n"
               "api-a    | m4 driver acquired the advisory lock\n"
               "worker-a | m4 driver acquired the advisory lock\n")
        self.assertEqual({"api-a": 2, "api-b": 0}, m.c14_lock_lines(log))
        self.assertEqual({"api-a": 0}, m.c14_lock_lines("", ("api-a",)))

    def test_compose_prints_the_container_instance_name_not_the_service(self):
        """`docker compose logs` prefixes `api-a-1  |` (service + replica number).
        The old pattern required `api-a` to be followed by a space or `|`, so every
        real line was invisible and the counts read 0 for both arms (live22)."""
        log = ("api-a-1  | 2026-10-16T03:00:00Z INF m4 driver acquired the advisory lock\n"
               "api-a-1  | 2026-10-16T03:00:02Z INF m4 driver acquired the advisory lock\n"
               "api-b-1  | 2026-10-16T03:00:01Z INF something else\n"
               "api-a-2  | m4 driver acquired the advisory lock\n")
        self.assertEqual({"api-a": 3, "api-b": 0}, m.c14_lock_lines(log))

    def test_instance_suffix_never_lets_a_prefix_sibling_score(self):
        """`api-a` must not claim `api-ab-1 | ...` lines: the instance suffix is
        anchored to digits + separator, so a longer service name cannot match."""
        log = ("api-ab-1 | 2026-10-16T03:00:00Z INF m4 driver acquired the advisory lock\n"
               "api-a1   | m4 driver acquired the advisory lock\n"
               "api-a-1x | m4 driver acquired the advisory lock\n")
        self.assertEqual({"api-a": 0, "api-ab": 1},
                         m.c14_lock_lines(log, ("api-a", "api-ab")))


class EngineFlagCommands(unittest.TestCase):
    """C14c SETS UP its own precondition: it recreates ONLY api-a with
    COMMUNICATION_PIPELINE_SCHEDULER_A=off (and restores it in a finally). The
    command must stay project-pinned and the flag must travel in the PROCESS ENV,
    never in argv; which -f files it rides is RecreateConfigFiles' business below."""

    def test_env_var_is_per_replica(self):
        self.assertEqual("COMMUNICATION_PIPELINE_SCHEDULER_A", m.c14_sched_env_var("api-a"))
        self.assertEqual("COMMUNICATION_PIPELINE_SCHEDULER_B", m.c14_sched_env_var("api-b"))
        self.assertIsNone(m.c14_sched_env_var("worker-a"))
        self.assertIsNone(m.c14_sched_env_var(None))

    def test_recreate_cmd_reuses_the_drivers_compose_files(self):
        """FALLBACK shape (no -f list handed in): same -p communication-m4 + the same
        three -f files the driver's restarts and rolls use — a bare `docker compose`
        would read the wrong lab."""
        cmd = m.c14_recreate_cmd("api-a")
        n = len(m.COMPOSE)
        self.assertEqual(list(m.COMPOSE), cmd[:n])
        self.assertIn("-p", cmd)
        self.assertIn(m.COMPOSE_PROJECT, cmd)
        self.assertIn("-f", cmd)
        self.assertIn("compose.m4.yml", cmd)
        self.assertEqual(["up", "-d", "--no-deps", "--force-recreate", "api-a"], cmd[n:])

    def test_the_flag_never_lands_in_argv(self):
        """Env passed via the process env, not argv: no value and no variable name
        may show up in the command (it would also fool § 7.0's bring-up reader)."""
        cmd = m.c14_recreate_cmd("api-b")
        self.assertEqual([], [a for a in cmd if "SCHEDULER" in a.upper()], str(cmd))
        self.assertEqual([], [a for a in cmd if a in ("on", "off")], str(cmd))

    def test_recreate_env_overrides_exactly_the_one_variable(self):
        saved = dict(m.COMPOSE_ENV)
        env = m.c14_recreate_env("api-a", "off")
        self.assertEqual("off", env["COMMUNICATION_PIPELINE_SCHEDULER_A"])
        self.assertEqual(saved.get("COMMUNICATION_PIPELINE_SCHEDULER_B"),
                         env.get("COMMUNICATION_PIPELINE_SCHEDULER_B"),
                         "api-b's flag is untouched by api-a's recreate")
        self.assertEqual(saved["HOST_UID"], env["HOST_UID"], "the base env is inherited")
        self.assertEqual(saved, m.COMPOSE_ENV, "COMPOSE_ENV itself is never mutated")

    def test_a_service_with_no_flag_of_its_own_is_a_hard_error(self):
        """Recreating worker-a with COMMUNICATION_PIPELINE_SCHEDULER_A in the env
        would be a silent no-op — the construction refuses instead."""
        with self.assertRaises(ValueError):
            m.c14_recreate_env("worker-a", "off")
        self.assertEqual("worker-a", m.c14_recreate_cmd("worker-a")[-1])


class RestoreState(unittest.TestCase):
    """The try/finally restore reports what it LEFT behind; unreadable is never a
    silent 'on' — later gates must see the truth about the lab."""

    def test_ready_replica_with_a_readable_log(self):
        self.assertEqual("on", m.c14_restore_state({"api-a": "on"}, "api-a", True))
        self.assertEqual("off", m.c14_restore_state({"api-a": "off"}, "api-a", True))

    def test_not_ready_or_unreadable_is_unobservable(self):
        self.assertEqual("unobservable", m.c14_restore_state({"api-a": "on"}, "api-a", False))
        self.assertEqual("unobservable", m.c14_restore_state(None, "api-a", True))
        self.assertEqual("unobservable", m.c14_restore_state({}, "api-a", True))


class OffReplicaTest(unittest.TestCase):
    """§ 7.1 C14c: the arm recreates ONE replica with its engine off and keeps BOTH
    replicas up: the off one serves reads and never claims the driver's advisory
    lock, the on one keeps advancing the run POSTed to the off one, and the
    restore leaves the lab as it was found. (The OLD arm stopped the on replica and
    demanded 'stays queued while alone'; § 7.1's comparison — off vs a replica that
    KEEPS ADVANCING — is what the verdicts below now encode.)"""

    # Shaped exactly as `docker compose logs --no-color` prints it: the CONTAINER
    # instance name (service + `-<n>`) padded, then `|`.
    LOG = ("api-a-1  | 2026-10-16T03:00:00Z INF serving on :8080 replica=api-a\n"
           "api-b-1  | 2026-10-16T03:00:00Z INF pipeline scheduler disabled on this replica "
           "(COMMUNICATION_PIPELINE_SCHEDULER=off)\n"
           "api-b-1  | 2026-10-16T03:00:01Z INF serving on :8080 replica=api-b\n")

    def test_off_lines_parse_with_compose_padding(self):
        self.assertEqual({"api-a": 0, "api-b": 1}, m.c14_scheduler_off_lines(self.LOG))
        self.assertEqual({"api-a": 0}, m.c14_scheduler_off_lines("", ("api-a",)))

    def test_off_lines_still_parse_unprefixed_compose_output(self):
        """Some compose invocations print the bare service column; both shapes must
        read the same engine state or the verdict depends on the log reader."""
        bare = self.LOG.replace("api-a-1", "api-a").replace("api-b-1", "api-b")
        self.assertEqual(m.c14_scheduler_off_lines(self.LOG),
                         m.c14_scheduler_off_lines(bare))

    def test_a_replica_that_never_printed_the_mark_reads_on(self):
        log = ("api-a-1  | 2026-10-16T03:00:00Z INF serving on :8080 replica=api-a\n"
               "api-b-1  | 2026-10-16T03:00:00Z INF pipeline scheduler disabled on this "
               "replica (COMMUNICATION_PIPELINE_SCHEDULER=off)\n")
        self.assertEqual({"api-a": "on", "api-b": "off"},
                         m.c14_engine_states(m.c14_scheduler_off_lines(log)))

    def test_off_mark_never_leaks_to_a_prefix_sibling(self):
        log = "api-ab-1 | INF pipeline scheduler disabled on this replica\n"
        self.assertEqual({"api-a": 0, "api-ab": 1},
                         m.c14_scheduler_off_lines(log, ("api-a", "api-ab")))
        # api-a stays 'on' — its engine state is not stolen from a longer name.
        self.assertEqual({"api-a": "on", "api-ab": "off"},
                         m.c14_engine_states(m.c14_scheduler_off_lines(log, ("api-a", "api-ab"))))

    def test_states_map_zero_to_on(self):
        self.assertEqual({"api-a": "on", "api-b": "off"},
                         m.c14_engine_states(m.c14_scheduler_off_lines(self.LOG)))
        self.assertIsNone(m.c14_engine_states(None))

    def test_pair_needs_exactly_one_off(self):
        self.assertEqual(("api-b", "api-a"),
                         m.c14_off_pair({"api-a": "on", "api-b": "off"}))
        self.assertIsNone(m.c14_off_pair({"api-a": "on", "api-b": "on"}))   # live4's lab
        self.assertIsNone(m.c14_off_pair({"api-a": "off", "api-b": "off"}))  # rollback lab
        self.assertIsNone(m.c14_off_pair(None))

    def good(self, **kw):
        args = dict(off="api-a", on="api-b",
                    reads={"/api/v1/system/readiness": 200, "/api/v1/system/scheduler": 200,
                           "/api/v1/runs/{id} (served by api-a mid-arm)": 200},
                    posted=(201, "r-1"), advance=["queued", "running", "completed"],
                    lock_marks={"api-a": 0, "api-b": 3}, restore=("api-a", "on"))
        args.update(kw)
        return m.c14_off_replica_verdicts(**args)

    def test_clean_off_replica_arm_passes_every_claim(self):
        vs = self.good()
        self.assertEqual([True] * 5, [ok for _l, ok, _d in vs], vs)
        self.assertTrue(all("C14c" in l for l, _ok, _d in vs), vs)

    def test_a_non_read_becomes_a_fail_not_a_pass(self):
        vs = self.good(reads={"/api/v1/system/scheduler": 502})
        self.assertIs(False, one(vs, "serves READS"))

    def test_a_run_the_on_replica_never_advances_is_a_fail_not_a_gap(self):
        """With the on replica's engine up the whole window, a run stuck at 'queued'
        means NOTHING advanced it — that FAILs. No sample at all only GAPs."""
        self.assertIs(False, one(self.good(advance=["queued"] * 4), "keeps advancing"))
        self.assertIsNone(one(self.good(advance=[]), "keeps advancing"))
        self.assertIsNone(one(self.good(advance=["", None]), "keeps advancing"))

    def test_the_arm_carries_one_advance_claim_not_the_old_stays_queued_pair(self):
        """The OLD arm stopped the on replica and demanded the run 'stay queued while
        {off} is the only replica up' plus a post-restore 'picks it up'. § 7.1's
        comparison is off vs a replica that KEEPS ADVANCING — one claim, both up."""
        labels = [l for l, _o, _d in self.good()]
        self.assertEqual(1, len([l for l in labels if "advanc" in l]), labels)
        self.assertFalse([l for l in labels if "only replica up" in l], labels)
        self.assertFalse([l for l in labels if "picks the run up" in l], labels)

    def test_zero_lock_marks_on_both_sides_is_blindness_not_a_pass(self):
        # docs/m4-live-findings.md D6: an unreadable/never-marked log GAPs the arm.
        self.assertIsNone(one(self.good(lock_marks={"api-a": 0, "api-b": 0}), "advisory lock"))
        self.assertIsNone(one(self.good(lock_marks=None), "advisory lock"))
        self.assertIs(False, one(self.good(lock_marks={"api-a": 2, "api-b": 1}),
                                 "advisory lock"))

    def test_missing_read_and_post_gap_their_own_arms(self):
        vs = self.good(reads={}, posted=None)
        self.assertIsNone(one(vs, "serves READS"))
        self.assertIsNone(one(vs, "is accepted"))
        self.assertIs(False, one(self.good(posted=(403, None)), "is accepted"))

    def test_restore_is_only_claimed_when_the_arm_recreated(self):
        """A lab that came up with one replica off was measured as FOUND — the arm
        recreated nothing, so it must not claim (or fail) a restore."""
        labels = [l for l, _o, _d in self.good(restore=None)]
        self.assertFalse([l for l in labels if "restore" in l], labels)

    def test_restore_verdict_is_its_own_pure_claim(self):
        """The gap path (precondition recreate ran, arm never measured) still owes
        the evidence a restore verdict — c14_restore_verdicts is callable alone."""
        self.assertEqual([], m.c14_restore_verdicts(None))
        self.assertEqual([True], [ok for _l, ok, _d in
                                  m.c14_restore_verdicts(("api-a", "on"))])
        self.assertEqual([False], [ok for _l, ok, _d in
                                   m.c14_restore_verdicts(("api-a", "off"))])
        self.assertEqual([None], [ok for _l, ok, _d in
                                  m.c14_restore_verdicts(("api-a", "unobservable"))])
        rows = [l for l, _o, _d in self.good() if "C14c restore" in l]
        self.assertEqual([m.c14_restore_verdicts(("api-a", "on"))[0][0]], rows)

    def test_restore_rows_report_what_the_finally_left_behind(self):
        self.assertIs(True, one(self.good(restore=("api-a", "on")), "C14c restore"))
        # engine still off after the finally = the lab is crippled for later gates.
        self.assertIs(False, one(self.good(restore=("api-a", "off")), "C14c restore"))
        # readiness/logs unreadable is an unproven restore: GAP, never a silent PASS.
        self.assertIsNone(one(self.good(restore=("api-a", "unobservable")), "C14c restore"))



# The literal label docker records on the shared lab's api-a container today (a lab
# brought up by lab_reset.sh, i.e. with the real-model-key overlay as a FOURTH file).
_LAB_DIR = "/home/david/.cache/comm-lab"
_LAB_FILES = [_LAB_DIR + "/" + f for f in
              ("compose.yml", "compose.harness.yml", "compose.m4.yml", "compose.real.yml")]
_LAB = ",".join(_LAB_FILES)


class RecreateConfigFiles(unittest.TestCase):
    """C14c recreates ONE replica of a lab it did NOT bring up. lab_reset.sh composes
    a FOURTH file (compose.real.yml — the real model-key mounts) that the driver's own
    COMPOSE list never names, so the recreate must ride the -f list docker recorded on
    the running container (com.docker.compose.project.config_files) and its directory
    (com.docker.compose.project.working_dir); COMPOSE's three files are only a
    fallback, and a fallback is always said out loud in the evidence."""

    LAB_DIR = _LAB_DIR
    FILES = _LAB_FILES
    LABEL = _LAB

    def test_the_label_parses_into_the_ordered_f_args(self):
        self.assertEqual(self.FILES, m.c14_compose_label_paths(self.LABEL))
        cmd = m.c14_recreate_cmd("api-a", m.c14_compose_label_paths(self.LABEL))
        self.assertEqual(["docker", "compose", "-p", m.COMPOSE_PROJECT], cmd[:4])
        self.assertEqual(self.FILES, m.c14_compose_f_args(cmd))
        self.assertEqual(["up", "-d", "--no-deps", "--force-recreate", "api-a"],
                         cmd[4 + 2 * len(self.FILES):])

    def test_the_lab_recreates_itself_with_its_own_four_files(self):
        """The regression this gate existed to fix: a compose.real.yml lab recreated
        from the driver's three files comes back WITHOUT the real model-key mounts.
        With the label, the driver's relative files are nowhere in the command."""
        cmd = m.c14_recreate_cmd("api-a", self.LABEL)      # raw label string works too
        self.assertEqual(self.FILES, m.c14_compose_f_args(cmd))
        for rel in m.c14_compose_f_args(m.COMPOSE):
            self.assertNotIn(rel, cmd, f"{rel} would replace the lab's own file: {cmd}")
        self.assertIn("compose.real.yml", " ".join(m.c14_compose_f_args(cmd)))

    def test_the_flag_still_never_lands_in_argv(self):
        cmd = m.c14_recreate_cmd("api-a", self.LABEL)
        self.assertEqual([], [a for a in cmd if "SCHEDULER" in a.upper()], str(cmd))
        self.assertEqual([], [a for a in cmd if a in ("on", "off")], str(cmd))

    def test_a_json_list_label_is_accepted(self):
        """`{{json ...}}` prints a JSON array; a path list is a path list."""
        self.assertEqual(self.FILES, m.c14_compose_label_paths(json.dumps(self.FILES)))

    def test_an_untrustworthy_label_is_empty_not_invented(self):
        for raw in ("", "   ", None, 7, "<no value>", "[]", "null", "{}",
                    '["/lab/a.yml"',           # unparsable JSON: never comma-split
                    "[1, 2]",                  # not paths
                    "[null]", ",, ,", "<no value>"):
            self.assertEqual([], m.c14_compose_label_paths(raw), repr(raw))

    def test_blank_and_repeated_entries_collapse_in_order(self):
        self.assertEqual(["/lab/a.yml", "/lab/b.yml"],
                         m.c14_compose_label_paths(" /lab/a.yml ,, <no value> ,"
                                                   " /lab/b.yml,/lab/a.yml "))

    def test_no_label_means_the_drivers_own_compose_files(self):
        """The documented fallback: same command as before this fix, so a lab whose
        label cannot be read is still recreated — and reported (below)."""
        for files in (None, [], "", "<no value>", ["", "  "]):
            self.assertEqual(list(m.COMPOSE) + ["up", "-d", "--no-deps",
                                                "--force-recreate", "api-a"],
                             m.c14_recreate_cmd("api-a", files), repr(files))
            self.assertEqual("fallback", m.c14_recreate_plan("api-a", files)["source"])

    def test_the_plan_carries_the_working_dir_only_with_label_files(self):
        """The lab lives outside the repo; its compose files resolve their relative
        contexts in the working_dir docker recorded. Without label files the driver
        keeps running compose from REPO_DIR like every other lever."""
        plan = m.c14_recreate_plan("api-a", self.LABEL, self.LAB_DIR)
        self.assertEqual("label", plan["source"])
        self.assertEqual(self.FILES, plan["files"])
        self.assertEqual(self.LAB_DIR, plan["cwd"])
        self.assertEqual(self.FILES, m.c14_compose_f_args(plan["cmd"]))
        self.assertEqual(m.REPO_DIR, m.c14_recreate_plan("api-a", self.LABEL, "")["cwd"])
        self.assertEqual(m.REPO_DIR, m.c14_recreate_plan("api-a", self.LABEL, "../lab")["cwd"])
        self.assertEqual(m.REPO_DIR, m.c14_recreate_plan("api-a", "<no value>",
                                                         self.LAB_DIR)["cwd"],
                         "a working_dir without label files does not move the command")

    def test_the_fallback_plan_says_so_in_the_evidence(self):
        label_note = m.c14_recreate_source_note("api-a", m.c14_recreate_plan("api-a", self.LABEL,
                                                                             self.LAB_DIR))
        self.assertNotIn("WARNING", label_note)
        self.assertIn("compose.real.yml", label_note)
        self.assertIn(m.C14_CONFIG_FILES_LABEL, label_note)
        self.assertIn("4 -f file(s)", label_note)
        for plan in (m.c14_recreate_plan("api-a", "<no value>"), None):
            note = m.c14_recreate_source_note("api-a", plan)
            self.assertIn("WARNING", note)
            self.assertIn("falls back", note)
            self.assertIn("compose.real.yml", note)
            self.assertEqual([], [f for f in m.c14_compose_f_args(m.COMPOSE)
                                  if f != "compose.real.yml" and f not in note],
                             "the note names every file the fallback actually rides")


class ContainerLabelRead(unittest.TestCase):
    """The READ behind the plan: only a container compose_container() has PROVEN to
    report com.docker.compose.project=communication-m4 may supply the -f list, and the
    project label is re-read beside the two paths so a stale reference cannot steer the
    recreate at another stack. docker is stubbed — this class never touches a
    container."""

    LAB = _LAB
    LAB_DIR = _LAB_DIR

    def setUp(self):
        self.saved = (m.compose_container, m.run)
        self.calls = []

    def tearDown(self):
        m.compose_container, m.run = self.saved

    def _stub(self, name, rc, out):
        m.compose_container = lambda svc: name

        def fake_run(cmd, **kw):
            self.calls.append([str(a) for a in cmd])
            return rc, out
        m.run = fake_run

    def test_an_unresolvable_service_reads_as_no_label(self):
        self._stub("", 0, "")
        self.assertEqual(([], ""), m.c14_container_compose_labels("api-a"))
        self.assertEqual([], self.calls, "no inspect without a proven container")

    def test_the_proven_container_supplies_the_files(self):
        self._stub("communication-m4-api-a-1", 0,
                   f"{m.COMPOSE_PROJECT}|{self.LAB}|{self.LAB_DIR}")
        files, wd = m.c14_container_compose_labels("api-a")
        self.assertEqual(_LAB_FILES, files)
        self.assertEqual(self.LAB_DIR, wd)
        self.assertEqual(["communication-m4-api-a-1"], [c[-1] for c in self.calls])
        plan = m.c14_recreate_plan("api-a", files, wd)
        self.assertEqual("label", plan["source"])
        self.assertEqual(self.LAB_DIR, plan["cwd"])

    def test_a_container_from_another_project_never_steers_the_recreate(self):
        for out in (f"communication-other|{self.LAB}|{self.LAB_DIR}", "|" + self.LAB + "|",
                    "other-project|/elsewhere/compose.yml|/elsewhere"):
            self._stub("communication-m4-api-a-1", 0, out)
            self.assertEqual(([], ""), m.c14_container_compose_labels("api-a"), out)

    def test_a_failing_or_unreadable_inspect_is_the_reported_fallback(self):
        self._stub("communication-m4-api-a-1", 1, "no such object")
        self.assertEqual(([], ""), m.c14_container_compose_labels("api-a"))
        self._stub("communication-m4-api-a-1", 0, "")
        self.assertEqual(([], ""), m.c14_container_compose_labels("api-a"))
        plan = m.c14_recreate_plan_for_service("api-a")
        self.assertEqual("fallback", plan["source"])
        self.assertEqual(list(m.COMPOSE) + ["up", "-d", "--no-deps", "--force-recreate",
                                            "api-a"], plan["cmd"])

    def test_a_docker_that_cannot_be_reached_never_crashes_the_recreate_path(self):
        """An exception here would abort the gate BETWEEN recreating api-a off and the
        finally that restores it — unreadable must degrade to the fallback."""
        def boom(*a, **kw):
            raise FileNotFoundError("docker not on PATH")
        m.compose_container = boom
        self.assertEqual(([], ""), m.c14_container_compose_labels("api-a"))
        self._stub("communication-m4-api-a-1", 0, f"{m.COMPOSE_PROJECT}|{self.LAB}|")
        m.run = boom
        self.assertEqual(([], ""), m.c14_container_compose_labels("api-a"))


if __name__ == "__main__":
    unittest.main(verbosity=2 if "-v" in sys.argv else 1)
