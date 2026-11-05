#!/usr/bin/env python3
"""test_c14_logic.py - offline unit proof for e2e_m4_exit.py's C14 pure logic.

Runs WITHOUT a stack (stdlib unittest only): the journal-window contiguity verdict
(no seq twice, no hole, no unmeasurable window), the terminal-event / duplicated-
succeeded-key verdicts from C14b's two SQL shapes, the SSE no-gap/no-duplicate
verdicts over a canned reconnect, the never-both-down sampling verdicts, the
advisory-lock handover verdict from the POSTGRES probe (pg_locks ×
pg_stat_activity.client_addr × docker container IPs: the generated SQL, the
holder attribution, the handover windows and the verdicts) and the backed-up
per-replica log-mark counting it replaced, the mid-roll
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
import re
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
                     m.c14_lock_verdicts(None, None),
                     m.c14_lock_pg_verdicts(None, None),
                     m.c14_lock_pg_verdicts({"samples": 500, "held": 0, "by_replica": {},
                                             "events": [], "simultaneous": [],
                                             "unattributed": {}, "empty_addr": 0,
                                             "other_key_samples": 0, "bases": [], "pids": {},
                                             "addr_map": {}, "container": {}, "env": None,
                                             "errors": [], "calls": 12, "backend": {},
                                             "replica_backend_svcs": [], "holder_svcs": [],
                                             "attribution": "none", "span_ms": None}, []),
                     [m.c14_off_replica_lock_row("api-a", "api-b", None, None)],
                     [m.c14_off_replica_lock_row("api-a", "api-b",
                                                 {"samples": 3, "held": 0, "events": [],
                                                  "by_replica": {}, "simultaneous": [],
                                                  "unattributed": {}, "empty_addr": 0,
                                                  "other_key_samples": 0, "bases": [],
                                                  "pids": {}, "addr_map": {}, "container": {},
                                                  "env": None, "errors": [], "calls": 1,
                                                  "backend": {}, "replica_backend_svcs": [],
                                                  "holder_svcs": [], "attribution": "backends",
                                                  "span_ms": None}, None)],
                     m.c14_approval_verdicts({}, None)):
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


# --- # C14's POSTGRES lock probe: tests for the SQL it generates, the holder ATTRIBUTION
# (client_addr × docker container IP, application_name when one exists) and the verdicts the
# samples produce — plus the live half with docker/psql stubbed.
#
# Why this exists at all: the serve-LOG probe above it (`Lock`, `LockBlindness`) is the backed-up
# old path and it cannot see the thing it grades. noteLeadership
# (internal/store/postgres/m4driver.go) prints the acquisition line once per not-held→held
# transition per PROCESS and Tick releases the session lock every pass, so a handover across a
# restart need not print anything (docs/m4-live-findings.md D6; the last acceptance read "no
# acquisition line exists in the history the probe can read" / "api-b shows none either, so the
# log probe is blind"). pg_locks (locktype='advisory', granted) on the driver's own key IS the
# live holder — that is what these tests cover.
#
# The SQL text is checked for shape and for the read-only guarantee; the PARSE fixture is the
# literal output of that script run against a real PostgreSQL 18.6 with a second connection
# holding the driver's advisory lock (e2e's own probe, not a hand-typed impression). The
# attribution tests are the point of the exercise: an unattributable backend must GAP with its
# address named, never be guessed onto a replica. Nothing here touches a container.


class LockProbeSql(unittest.TestCase):
    def test_the_probe_key_is_the_driver_key_it_cannot_be_renamed_here(self):
        """The one string that decides which advisory lock is 'the m4 driver's'. It is
        m4driver.go's m4DriverAdvisoryLockKey, so if the Go side ever re-keys, this test is
        the failure that says the probe is now measuring somebody else's lock."""
        src = open(os.path.join(m.REPO_DIR, "internal", "store", "postgres",
                                "m4driver.go"), encoding="utf-8").read()
        go = re.search(r'm4DriverAdvisoryLockKey\s*=\s*"([^"]+)"', src)
        self.assertIsNotNone(go, "m4DriverAdvisoryLockKey vanished from m4driver.go")
        self.assertEqual(go.group(1), m.C14_M4_LOCK_KEY)

    def test_the_key_halves_are_the_driver_own_hash_split_as_pg_locks_stores_it(self):
        """pg_locks stores a 64-bit advisory key as classid = the high word and objid = the
        low word; hashtextextended(key, 0) is exactly what m4DriverTryLock hashes."""
        hi, lo = m.c14_lock_key_halves_sql()
        self.assertEqual("(hashtextextended('communication/m4-reconciler', 0) "
                         "& 4294967295::bigint)", lo)
        self.assertEqual("((hashtextextended('communication/m4-reconciler', 0) >> 32) "
                         "& 4294967295::bigint)", hi)
        esc = m.c14_lock_key_halves_sql("don't")
        self.assertIn("hashtextextended('don''t', 0)", esc[0])

    def test_the_match_fragment_names_only_the_drivers_key(self):
        """rcnAdvisoryLockKey / evtAppendLockPrefix / advancerLockPrefix all hold advisory
        locks in the same database; matching those would attribute another subsystem's lock
        to the driver (and make the off-replica claim pass on the reconciler's tick)."""
        match = m.c14_lock_holder_match_sql()
        self.assertIn("communication/m4-reconciler", match)
        self.assertEqual([], [other for other in ("turn-lease", "journal", "advance", "evt",
                                                  "rcn") if other in match], match)
        self.assertIn("locktype", "l.locktype")     # the caller adds locktype/granted
        self.assertIn("classid", match)
        self.assertIn("objid", match)

    def test_the_script_is_one_statement_per_line_and_read_only(self):
        script = m.c14_lock_probe_script(samples=3, every_s=0.01)
        lines = [l for l in script.splitlines() if l.strip()]
        self.assertEqual(1 + 2 * 3 + 1, len(lines), script)     # env + (sample, sleep)*3 + be
        for line in lines:
            self.assertTrue(line.endswith(";"), line)
            self.assertNotIn(";", line[:-1], "two statements on one line would share a "
                                             "snapshot and stop sampling the live table")
        joined = script.upper()
        for write in (r"\bINSERT\b", r"\bUPDATE\b", r"\bDELETE\b", r"\bTRUNCATE\b",
                      r"\bCREATE\b", r"\bDROP\b", r"\bGRANT\b", r"\bREVOKE\b",
                      r"\bALTER\b", r"\bSET\s+SESSION\s+AUTHORIZATION\b"):
            self.assertIsNone(re.search(write, joined),
                              f"{write} — the probe must not touch anything "
                              "(l.granted is a column, not a privilege)")
        for takes_lock in (r"PG_ADVISORY_LOCK", r"PG_TRY_ADVISORY_LOCK", r"PG_ADVISORY_UNLOCK",
                           r"PG_ADVISORY_XACT_LOCK", r"FOR\s+UPDATE", r"PG_LOCK_ACQUIRE"):
            self.assertIsNone(re.search(takes_lock, joined),
                              "a probe that TAKES the lock moves the thing it measures")
        self.assertIn("PG_SLEEP", joined)
        self.assertIn("PG_LOCKS", joined)
        self.assertIn("PG_STAT_ACTIVITY", joined)

    def test_the_script_carries_the_key_once_and_the_sample_count_exactly(self):
        script = m.c14_lock_probe_script(samples=5, every_s=0.02)
        self.assertEqual(5, len([l for l in script.splitlines()
                                 if l.startswith("SELECT json_build_array('s',")]))
        self.assertEqual(5, script.count("SELECT pg_sleep(0.020);"))
        self.assertEqual(1, len([l for l in script.splitlines()
                                 if l.startswith("SELECT json_build_array('env'")]))
        self.assertEqual(1, len([l for l in script.splitlines()
                                 if l.startswith("SELECT json_build_array('be'")]))

    def test_a_key_with_a_quote_is_escaped_not_an_injection(self):
        script = m.c14_lock_probe_script(samples=1, key="it's a key")
        self.assertIn("'it''s a key'", script)

    def test_the_script_selects_the_identity_columns_attribution_needs(self):
        script = m.c14_lock_probe_script(samples=1)
        for col in ("application_name", "client_addr", "client_port", "backend_start",
                    "objsubid", "l.pid", "usename", "datname"):
            self.assertIn(col, script, f"{col} missing — attribution cannot be scored")

    def test_sample_rate_and_count_are_clamped_not_infinite(self):
        self.assertIn("SELECT pg_sleep(0.040);", m.c14_lock_probe_script(samples=1))
        self.assertEqual(1, len([l for l in m.c14_lock_probe_script(samples=0).splitlines()
                                 if "'s', 1," in l]))
        self.assertIn("SELECT pg_sleep(5.000);", m.c14_lock_probe_script(samples=1, every_s=99))
        self.assertIn("SELECT pg_sleep(0.000);", m.c14_lock_probe_script(samples=1, every_s=-1))


class LockProbeParse(unittest.TestCase):
    """The literal output of c14_lock_probe_script() run against a real PostgreSQL 18.6
    while a second connection held pg_try_advisory_lock(hashtextextended('communication/m4-"
    "reconciler',0)). The only hand-written part is the container-IP table (no docker here)."""

    RAW = "\n".join([
        '["env", "ci", "180006", "1608226700", "376037640"]',
        '["s", 1, "1793314520000", null, ["4029004804:1453269123"]]',
        '["s", 2, "1793314520057", [["127091", "", "172.18.0.4/32", "46050", "communication",'
        ' "communication", "idle", "1793314518881", "1", "ExclusiveLock"]], '
        '["4029004804:1453269123"]]',
        '["s", 3, "1793314520114", null, null]',
        'not a json line at all',
        '["be", "communication", 3, ["172.18.0.1/32", "172.18.0.4/32", ""], ["", "pgstat"]',
    ]) + "\n"

    def test_env_and_backend_lines_parse(self):
        p = m.c14_lock_parse_probe_output(self.RAW)
        self.assertEqual({"database": "ci", "version": "180006",
                          "key_hi": "1608226700", "key_lo": "376037640"}, p["env"],
                         "the env line is the server's own answer, database and all")
        self.assertIsNone(p["backends"],
                          "the 'be' line is truncated mid-array: junk, never guessed at")
        self.assertEqual(1, p["junk"], "the truncated 'be' line is junk, never a guess")

    def test_a_whole_backend_line_is_the_attribution_diagnosis_input(self):
        p = m.c14_lock_parse_probe_output(
            '["be", "communication", 3, ["172.18.0.4/32", "172.18.0.5/32", ""], '
            '["", "psql"]]\n')
        self.assertEqual({"database": "communication", "count": 3,
                          "addrs": ["172.18.0.4/32", "172.18.0.5/32", ""],
                          "app_names": ["", "psql"]}, p["backends"])

    def test_holder_rows_become_named_fields_and_empty_ones_stay_empty(self):
        p = m.c14_lock_parse_probe_output(self.RAW)
        self.assertEqual(3, len(p["samples"]))
        self.assertEqual([], p["samples"][0]["holders"])
        self.assertEqual(["4029004804:1453269123"], p["samples"][0]["other_keys"])
        h = p["samples"][1]["holders"][0]
        self.assertEqual("127091", h["pid"])
        self.assertEqual("", h["application_name"],
                         "pgx sends no application_name: this is the column that CANNOT "
                         "identify a replica today, and the probe must say so")
        self.assertEqual("172.18.0.4/32", h["client_addr"])
        self.assertEqual("1793314518881", h["backend_start_ms"])
        self.assertEqual("1", h["objsubid"])

    def test_a_misshapen_holder_array_is_dropped_not_zipped_into_wrong_fields(self):
        raw = '["s", 1, "1", [["only","three"]], null]\n'
        self.assertEqual([], m.c14_lock_parse_probe_output(raw)["samples"][0]["holders"])

    def test_empty_and_none_text_parse_as_nothing_rather_than_crashing(self):
        for text in ("", None, "\n \n", "[", "[7]", '["s"]'):
            p = m.c14_lock_parse_probe_output(text)
            self.assertEqual([], p["samples"])
            self.assertIsNone(p["env"])


class LockAttribution(unittest.TestCase):
    IP_MAP = {"api-a": {"container": "communication-m4-api-a-1", "ips": ["172.18.0.4"]},
              "api-b": {"container": "communication-m4-api-b-1", "ips": ["172.18.0.5/16"]}}

    def test_an_inet_and_a_bare_ip_are_the_same_address(self):
        self.assertEqual("172.18.0.4", m.c14_lock_norm_addr("172.18.0.4/32"))
        self.assertEqual("172.18.0.4", m.c14_lock_norm_addr(" 172.18.0.4 "))
        self.assertEqual("::1", m.c14_lock_norm_addr("::1/128"))
        for empty in ("", None, "NULL", "none", "<no value>", "-", "   "):
            self.assertEqual("", m.c14_lock_norm_addr(empty), repr(empty))

    def test_the_index_names_every_service_claiming_an_ip(self):
        idx = m.c14_lock_ip_index(self.IP_MAP, ("api-a", "api-b"))
        self.assertEqual(["api-a"], idx["172.18.0.4"])
        self.assertEqual(["api-b"], idx["172.18.0.5"])
        shared = m.c14_lock_ip_index({"api-a": {"ips": ["10.0.0.9"]},
                                      "api-b": {"ips": ["10.0.0.9"]}}, ("api-a", "api-b"))
        self.assertEqual(["api-a", "api-b"], shared["10.0.0.9"],
                         "an ip two replicas report is an ambiguity, not a coin flip")

    def test_a_label_names_a_replica_without_waking_a_prefix_sibling(self):
        self.assertEqual("api-a", m.c14_lock_service_in_label("api-a"))
        self.assertEqual("api-a", m.c14_lock_service_in_label("communication-m4-api-a-1"))
        self.assertEqual("api-b", m.c14_lock_service_in_label("serve/api-b"))
        self.assertIsNone(m.c14_lock_service_in_label("api-ab-1"))
        self.assertIsNone(m.c14_lock_service_in_label(""))
        self.assertIsNone(m.c14_lock_service_in_label(None))
        self.assertIsNone(m.c14_lock_service_in_label("communication-m4-api-a-1-api-b-2"),
                          "a label naming BOTH replicas is nobody's identity")

    def test_a_holder_is_attributed_by_container_ip(self):
        idx = m.c14_lock_ip_index(self.IP_MAP, ("api-a", "api-b"))
        svc, basis, why = m.c14_attribute_holder({"client_addr": "172.18.0.4/32"}, idx)
        self.assertEqual(("api-a", "ip"), (svc, basis))
        self.assertEqual("", why)

    def test_application_name_wins_when_serve_ever_sets_one(self):
        idx = m.c14_lock_ip_index(self.IP_MAP, ("api-a", "api-b"))
        svc, basis, _why = m.c14_attribute_holder({"application_name": "communication/m4-api-b",
                                                   "client_addr": "172.18.0.4/32"}, idx)
        self.assertEqual(("api-b", "name"), (svc, basis))

    def test_an_unknown_address_is_refused_with_that_address_named(self):
        """The lab-NAT case: every backend arrives as the gateway. Guessing 'probably api-a'
        would be the exact failure this brief exists to remove."""
        idx = m.c14_lock_ip_index(self.IP_MAP, ("api-a", "api-b"))
        svc, basis, why = m.c14_attribute_holder({"client_addr": "172.17.0.1/32"}, idx)
        self.assertIsNone(svc)
        self.assertIsNone(basis)
        self.assertIn("172.17.0.1", why)
        self.assertIn("not an IP of any replica container", why)

    def test_an_ambiguous_address_is_refused(self):
        idx = m.c14_lock_ip_index({"api-a": {"ips": ["10.0.0.9"]},
                                   "api-b": {"ips": ["10.0.0.9"]}}, ("api-a", "api-b"))
        svc, _basis, why = m.c14_attribute_holder({"client_addr": "10.0.0.9"}, idx)
        self.assertIsNone(svc)
        self.assertIn("more than one replica", why)

    def test_a_unix_socket_holder_is_refused_as_such(self):
        svc, _basis, why = m.c14_attribute_holder({"client_addr": None}, {})
        self.assertIsNone(svc)
        self.assertIn("unix-socket", why)


class LockSummarize(unittest.TestCase):
    IP_MAP = {"api-a": {"container": "c-a", "ips": ["172.18.0.4"]},
              "api-b": {"container": "c-b", "ips": ["172.18.0.5"]}}

    def _state(self, samples, backends=None, addr_map=None):
        return {"env": {"database": "communication"}, "samples": samples,
                "backends": backends if backends is not None else
                [{"database": "communication", "count": 3,
                  "addrs": ["172.18.0.4/32", "172.18.0.5/32"], "app_names": [""]}],
                "addr_map": addr_map if addr_map is not None else self.IP_MAP,
                "errors": [], "calls": 1}

    def _held(self, n, addr, ts=1000.0):
        return {"n": n, "ts_ms": ts, "other_keys": [],
                "holders": [{"pid": str(500 + n), "application_name": "",
                             "client_addr": addr, "client_port": "1", "usename": "u",
                             "datname": "d", "state": "idle", "backend_start_ms": "900",
                             "objsubid": "1", "mode": "ExclusiveLock"}]}

    def test_a_holder_on_a_container_ip_is_the_holders_basis(self):
        obs = m.c14_lock_summarize(self._state([self._held(1, "172.18.0.5/32")]),
                                   ("api-a", "api-b"))
        self.assertEqual("holders", obs["attribution"])
        self.assertEqual({"api-a": 0, "api-b": 1}, obs["by_replica"])
        self.assertEqual(["ip"], obs["bases"])
        self.assertEqual(1, obs["held"])

    def test_no_holder_but_recognised_backend_addrs_still_proves_the_probe(self):
        """The distinction the GAP reason needs: 'the attribution path works and nobody held
        it' is not the same fact as 'the probe cannot tell replicas apart'."""
        obs = m.c14_lock_summarize(self._state([]), ("api-a", "api-b"))
        self.assertEqual("backends", obs["attribution"])
        self.assertEqual(["api-a", "api-b"], obs["replica_backend_svcs"])
        self.assertEqual(0, obs["held"])

    def test_a_nat_where_every_backend_is_the_gateway_attributes_nothing(self):
        obs = m.c14_lock_summarize(
            self._state([self._held(1, "172.17.0.1/32")],
                        backends=[{"database": "communication", "count": 2,
                                   "addrs": ["172.17.0.1/32"], "app_names": [""]}],
                        addr_map={"api-a": {"container": "c-a", "ips": ["172.17.0.1"]},
                                  "api-b": {"container": "c-b", "ips": ["172.17.0.1"]}}),
            ("api-a", "api-b"))
        self.assertEqual("none", obs["attribution"])
        self.assertEqual({"172.17.0.1": 1}, obs["unattributed"])

    def test_two_replicas_holding_the_same_key_at_once_is_recorded(self):
        both = {"n": 9, "ts_ms": 1000.0, "other_keys": [],
                "holders": [self._held(1, "172.18.0.4/32")["holders"][0],
                            dict(self._held(2, "172.18.0.5/32")["holders"][0], pid="999")]}
        obs = m.c14_lock_summarize(self._state([both]), ("api-a", "api-b"))
        self.assertEqual([9], obs["simultaneous"])
        self.assertEqual({"api-a": 1, "api-b": 1}, obs["by_replica"])

    def test_other_advisory_keys_are_counted_as_the_catalog_being_readable(self):
        smp = self._held(1, "172.18.0.4/32")
        smp["other_keys"] = ["4029004804:1453269123"]
        obs = m.c14_lock_summarize(self._state([smp]), ("api-a", "api-b"))
        self.assertEqual(1, obs["other_key_samples"])

    def test_duty_note_reports_samples_and_rate_never_a_pass(self):
        obs = m.c14_lock_summarize(self._state([self._held(1, "172.18.0.4/32", ts=1000),
                                                self._held(2, "172.18.0.4/32", ts=2000)]),
                                   ("api-a", "api-b"))
        note = m.c14_lock_duty_note(obs)
        self.assertIn("2 live pg_locks observation(s)", note)
        self.assertIn("~2.0 Hz", note)
        self.assertIn("2 found it granted", note)
        self.assertIn("0 saw other advisory keys", note)
        quiet = m.c14_lock_summarize(self._state([self._held(1, "172.18.0.4/32", ts=1000),
                                                   {"n": 2, "ts_ms": 2000.0, "holders": [],
                                                    "other_keys": ["9:9"]}]),
                                     ("api-a", "api-b"))
        self.assertIn("1 found it granted, 1 saw other advisory keys",
                      m.c14_lock_duty_note(quiet))

    def test_the_attribution_note_names_the_failed_address_and_the_go_one_liner(self):
        obs = m.c14_lock_summarize(
            self._state([self._held(1, "172.17.0.1/32")],
                        backends=[{"database": "communication", "count": 2,
                                   "addrs": ["172.17.0.1/32"], "app_names": [""]}],
                        addr_map={"api-a": {"container": "c-a", "ips": ["172.18.0.4"]},
                                  "api-b": {"container": "c-b", "ips": ["172.18.0.5"]}}),
            ("api-a", "api-b"))
        note = m.c14_lock_attribution_note(obs)
        self.assertIn("CANNOT attribute a holder to a replica", note)
        self.assertIn("172.17.0.1", note)
        self.assertIn('application_name', note,
                      "the report must say WHICH Go change would make this observable")
        self.assertIn("internal/store/postgres/db.go", note)

    def test_no_state_is_no_measurement(self):
        obs = m.c14_lock_summarize(None, ("api-a", "api-b"))
        self.assertEqual(0, obs["samples"])
        self.assertEqual("none", obs["attribution"])
        self.assertEqual({"api-a": 0, "api-b": 0}, obs["by_replica"])


class LockHandover(unittest.TestCase):
    def test_the_window_closes_at_the_first_sign_of_life_not_the_last_probe(self):
        """t_back (the self-watcher saw it answer) precedes t_ready (the arm's readiness wait
        returned). A holder after the replica was already answering again is not 'the lock
        stayed with a dead replica', so the EARLIER evidence closes the window."""
        w = m.c14_lock_roll_windows([{"svc": "api-a", "peer": "api-b", "t_restart": 100.0,
                                      "t_gone": 100.4, "t_back": 105.0, "t_ready": 106.0}])[0]
        self.assertEqual(100400, w["start_ms"], "the window is when it ACTUALLY went away")
        self.assertEqual(105000, w["end_ms"])
        self.assertEqual(100000, w["t_restart_ms"])
        only_ready = m.c14_lock_roll_windows([{"svc": "api-a", "peer": "api-b",
                                               "t_restart": 100.0, "t_gone": 100.4,
                                               "t_ready": 106.0}])[0]
        self.assertEqual(106000, only_ready["end_ms"], "with no self-watcher read, t_ready "
                                                       "is the best return evidence there is")

    def test_a_restart_that_never_looked_down_still_gets_a_grace_window(self):
        w = m.c14_lock_roll_windows([{"svc": "api-a", "peer": "api-b", "t_restart": 100.0,
                                      "t_ready": 103.0}])[0]
        self.assertIsNone(w["t_gone_ms"])
        self.assertEqual(100000 + int(m.C14_LOCK_PROBE_GRACE_S * 1000), w["start_ms"])
        self.assertEqual(103000, w["end_ms"])

    def test_a_step_with_no_clock_is_no_window(self):
        self.assertEqual([], m.c14_lock_roll_windows([{"svc": "api-a"}, None]))
        self.assertEqual([], m.c14_lock_roll_windows([]))

    def _obs(self, events):
        return {"events": events, "samples": 10, "held": len(events),
                "by_replica": {}, "attribution": "holders"}

    def test_a_peer_holder_inside_the_window_is_the_handover(self):
        ev = [{"ts_ms": 100600, "n": 1, "replicas": ["api-b"],
               "holders": [{"pid": "7", "service": "api-b", "basis": "ip",
                            "backend_start_ms": "100500"}]}]
        hand = m.c14_lock_handover(self._obs(ev), [{"svc": "api-a", "peer": "api-b",
                                                    "t_restart": 100.0, "t_gone": 100.4,
                                                    "t_ready": 106.0}])
        self.assertEqual(1, len(hand["peer_hits"]))
        self.assertEqual([], hand["own_hits"])
        self.assertEqual([], hand["stale_in_window"])
        rows = m.c14_lock_pg_verdicts(self._obs(ev), [{"svc": "api-a", "peer": "api-b",
                                                      "t_restart": 100.0, "t_gone": 100.4,
                                                      "t_ready": 106.0}])
        self.assertIs(True, rows[2][1], rows[2][2])
        self.assertIn("stayed up", rows[2][2])

    def test_a_backend_that_predates_the_restart_did_not_move_anything(self):
        """Postgres reaps a dead session's lock when it notices the client is gone; a holder
        whose backend started BEFORE the roll is that lag, not a lock stuck on a corpse — and
        certainly not a handover. It must GAP, never FAIL and never PASS."""
        ev = [{"ts_ms": 100600, "n": 1, "replicas": ["api-a"],
               "holders": [{"pid": "7", "service": "api-a", "basis": "ip",
                            "backend_start_ms": "99000"}]}]
        steps = [{"svc": "api-a", "peer": "api-b", "t_restart": 100.0, "t_gone": 100.4,
                  "t_ready": 106.0}]
        hand = m.c14_lock_handover(self._obs(ev), steps)
        self.assertEqual([], hand["fresh_in_window"])
        self.assertEqual(1, len(hand["stale_in_window"]))
        rows = m.c14_lock_pg_verdicts(self._obs(ev), steps)
        self.assertIsNone(rows[2][1])
        self.assertIn("PRE-DATE the restart", rows[2][2])

    def test_a_fresh_holder_that_is_the_down_replica_itself_fails(self):
        ev = [{"ts_ms": 100600, "n": 1, "replicas": ["api-a"],
               "holders": [{"pid": "7", "service": "api-a", "basis": "ip",
                            "backend_start_ms": "100500"}]}]
        steps = [{"svc": "api-a", "peer": "api-b", "t_restart": 100.0, "t_gone": 100.4,
                  "t_ready": 106.0}]
        rows = m.c14_lock_pg_verdicts(self._obs(ev), steps)
        self.assertIs(False, rows[2][1])
        self.assertIn("the replica that was DOWN", rows[2][2])

    def test_a_holder_outside_every_window_proves_exclusivity_not_a_handover(self):
        ev = [{"ts_ms": 90000, "n": 1, "replicas": ["api-b"],
               "holders": [{"pid": "7", "service": "api-b", "basis": "ip",
                            "backend_start_ms": "80000"}]}]
        steps = [{"svc": "api-a", "peer": "api-b", "t_restart": 100.0, "t_gone": 100.4,
                  "t_ready": 106.0}]
        hand = m.c14_lock_handover(self._obs(ev), steps)
        self.assertEqual(1, len(hand["outside"]))
        rows = m.c14_lock_pg_verdicts(self._obs(ev), steps)
        self.assertIsNone(rows[2][1], "no holder sampled in-window is unmeasured")
        self.assertIn("NO sample caught", rows[2][2])

    def test_an_unattributed_holder_cannot_be_a_hit_at_all(self):
        ev = [{"ts_ms": 100600, "n": 1, "replicas": [],
               "holders": [{"pid": "7", "service": None, "basis": None,
                            "backend_start_ms": "100500"}]}]
        hand = m.c14_lock_handover(self._obs(ev), [{"svc": "api-a", "peer": "api-b",
                                                    "t_restart": 100.0, "t_gone": 100.4,
                                                    "t_ready": 106.0}])
        self.assertEqual([], hand["fresh_in_window"] + hand["stale_in_window"])


class LockPgVerdicts(unittest.TestCase):
    OBS = {"samples": 1200, "held": 4, "by_replica": {"api-a": 0, "api-b": 4},
           "events": [{"ts_ms": 100600, "n": "c3s9", "replicas": ["api-b"],
                       "holders": [{"pid": "77", "service": "api-b", "basis": "ip",
                                    "backend_start_ms": "100500"}]}],
           "simultaneous": [], "unattributed": {}, "empty_addr": 0,
           "other_key_samples": 300, "bases": ["ip"], "pids": {"77": 4},
           "addr_map": {"api-a": ["172.18.0.4"], "api-b": ["172.18.0.5"]},
           "container": {"api-a": "c-a", "api-b": "c-b"}, "env": None, "errors": [],
           "calls": 30, "backend": {"database": "communication", "count": 4,
                                    "addrs": ["172.18.0.4", "172.18.0.5"],
                                    "app_names": [""]},
           "replica_backend_svcs": ["api-a", "api-b"], "holder_svcs": ["api-b"],
           "attribution": "holders", "span_ms": 60000}
    STEPS = [{"svc": "api-a", "peer": "api-b", "t_restart": 100.0, "t_gone": 100.4,
              "t_ready": 106.0}]

    def labels(self, rows):
        return [l for l, _o, _d in rows]

    def test_three_claims_and_the_log_mark_is_only_the_footnote(self):
        rows = m.c14_lock_pg_verdicts(self.OBS, self.STEPS, ("api-a", "api-b"),
                                       {"api-a": 0, "api-b": 0})
        self.assertEqual(3, len(rows))
        self.assertTrue(any("ATTRIBUTE" in l for l in self.labels(rows)))
        self.assertTrue(any("at most ONE replica" in l for l in self.labels(rows)))
        self.assertTrue(any("SURVIVING replica" in l for l in self.labels(rows)))
        self.assertEqual([], [l for l in self.labels(rows)
                              if "serve logs 'm4 driver acquired" in l],
                         "the log mark must not be a graded label any more")

    def test_the_clean_case_passes_on_the_pg_reading(self):
        rows = m.c14_lock_pg_verdicts(self.OBS, self.STEPS, ("api-a", "api-b"))
        self.assertEqual([True, True, True], [ok for _l, ok, _d in rows], rows)
        self.assertIn("api-b", rows[2][2])

    def test_no_probe_run_is_three_gaps_and_says_the_log_cannot_replace_it(self):
        for obs in (None, "unreadable", 7):
            rows = m.c14_lock_pg_verdicts(obs, self.STEPS, ("api-a", "api-b"), None)
            self.assertEqual([None, None, None], [ok for _l, ok, _d in rows], rows)
            self.assertTrue(all("pg_locks probe never ran" in d for _l, _o, d in rows), rows)

    def test_a_blind_attribution_gaps_and_names_the_address_and_the_fix(self):
        nat = dict(self.OBS, attribution="none", holder_svcs=[], by_replica={"api-a": 0,
                                                                             "api-b": 0},
                   unattributed={"172.17.0.1": 4}, replica_backend_svcs=[],
                   backend=dict(self.OBS["backend"], addrs=["172.17.0.1"], count=2))
        rows = m.c14_lock_pg_verdicts(nat, self.STEPS, ("api-a", "api-b"), {"api-a": 0,
                                                                            "api-b": 0})
        self.assertIsNone(rows[0][1], "an unattributable holder is a GAP, not a PASS")
        self.assertIsNone(rows[1][1], "exclusivity was never observed either way")
        self.assertIn("172.17.0.1", rows[0][2])
        self.assertIn("application_name", rows[0][2],
                      "the report must name the one-line Go change that would fix it")
        self.assertIn("SURVIVING", self.labels(rows)[2])
        self.assertIsNone(rows[2][1])

    def test_recognised_backends_but_no_holder_passes_the_probe_and_gaps_the_rest(self):
        quiet = dict(self.OBS, held=0, events=[], holder_svcs=[], attribution="backends",
                     by_replica={"api-a": 0, "api-b": 0})
        rows = m.c14_lock_pg_verdicts(quiet, self.STEPS, ("api-a", "api-b"))
        self.assertEqual([True, None, None], [ok for _l, ok, _d in rows], rows)
        self.assertIn("attribution path is live", rows[0][2])
        self.assertIn("unmeasured", rows[2][2])

    def test_two_replicas_holding_it_at_once_twice_is_the_product_bug(self):
        both = dict(self.OBS, simultaneous=["c9s3", "c9s17"], by_replica={"api-a": 6,
                                                                         "api-b": 4},
                    holder_svcs=["api-a", "api-b"])
        rows = m.c14_lock_pg_verdicts(both, self.STEPS, ("api-a", "api-b"))
        self.assertIs(False, rows[1][1])
        self.assertIn("product bug", rows[1][2])

    def test_one_double_holder_sample_needs_a_second_before_it_accuses(self):
        """pg_lock_status is not a snapshot of the whole table: a single reading that names
        two holders can be a scan that straddled a release and the next acquire. GAP, and say
        what would make it a FAIL."""
        once = dict(self.OBS, simultaneous=["c9s3"], by_replica={"api-a": 6, "api-b": 4},
                    holder_svcs=["api-a", "api-b"])
        rows = m.c14_lock_pg_verdicts(once, self.STEPS, ("api-a", "api-b"))
        self.assertIsNone(rows[1][1])
        self.assertIn("SECOND such sample", rows[1][2])

    def test_no_roll_windows_means_the_handover_was_never_measurable(self):
        rows = m.c14_lock_pg_verdicts(self.OBS, [], ("api-a", "api-b"))
        self.assertIsNone(rows[2][1])
        self.assertIn("no restart windows", rows[2][2])
        self.assertEqual([True, True], [ok for _l, ok, _d in rows[:2]])

    def test_the_backup_log_reading_is_printed_and_named_as_the_backup(self):
        rows = m.c14_lock_pg_verdicts(dict(self.OBS, held=0, events=[], holder_svcs=[],
                                           attribution="backends",
                                           by_replica={"api-a": 0, "api-b": 0}),
                                      self.STEPS, ("api-a", "api-b"), {"api-a": 0, "api-b": 0})
        d = rows[2][2]
        self.assertIn("serve-log acquire marks in the window: {'api-a': 0, 'api-b': 0}", d)
        self.assertIn("backup reading", d)
        self.assertIsNone(rows[2][1], "0 log marks stay the blindness they always were (D6)")


class LockOffReplicaPgRow(unittest.TestCase):
    """C14c's 'the off replica never CLAIMS the lock' claim, and the precedence: the pg
    reading decides; the log mark is consulted only when the probe never ran."""

    OBS_ON = {"samples": 900, "held": 5, "by_replica": {"api-a": 0, "api-b": 5},
              "events": [{"ts_ms": 1.0, "n": "c1s2", "replicas": ["api-b"],
                          "holders": [{"pid": "9", "service": "api-b", "basis": "ip"}]}],
              "simultaneous": [], "unattributed": {}, "empty_addr": 0,
              "other_key_samples": 200, "bases": ["ip"], "pids": {}, "addr_map": {},
              "container": {}, "env": None, "errors": [], "calls": 22,
              "backend": {"database": "communication", "count": 4,
                          "addrs": ["172.18.0.4", "172.18.0.5"], "app_names": [""]},
              "replica_backend_svcs": ["api-a", "api-b"], "holder_svcs": ["api-b"],
              "attribution": "holders", "span_ms": 1000}

    def test_the_on_replica_holding_and_the_off_one_never_is_a_pass(self):
        label, ok, why = m.c14_off_replica_lock_row("api-a", "api-b", self.OBS_ON,
                                                    {"api-a": 0, "api-b": 0})
        self.assertIn("api-a never claims", label)
        self.assertIs(True, ok)
        self.assertIn("holds the lock in none of them", why)
        self.assertIn("900 live pg_locks observation", why)

    def test_the_off_replica_caught_holding_is_the_product_bug(self):
        off_holds = dict(self.OBS_ON, by_replica={"api-a": 3, "api-b": 5},
                         holder_svcs=["api-a", "api-b"],
                         events=[{"ts_ms": 1.0, "n": "c1s2", "replicas": ["api-a"],
                                  "holders": [{"pid": "9", "service": "api-a",
                                               "basis": "ip"}]}])
        _label, ok, why = m.c14_off_replica_lock_row("api-a", "api-b", off_holds, None)
        self.assertIs(False, ok)
        self.assertIn("ticks the driver at all", why)

    def test_an_off_holder_from_before_the_arm_is_a_linger_not_a_claim(self):
        """C14c recreates api-a's process to turn its engine OFF; the OLD backend's session
        lock can outlive the container until Postgres notices. A holder whose backend started
        before the window opened cannot be the off replica claiming the lock — GAP, never
        FAIL, and never a PASS either."""
        lingering = dict(self.OBS_ON, by_replica={"api-a": 2, "api-b": 5},
                         holder_svcs=["api-a", "api-b"],
                         window=[1000.0, 9000.0],
                         events=[{"ts_ms": 2000.0, "n": "c1s2", "replicas": ["api-a"],
                                  "holders": [{"pid": "9", "service": "api-a", "basis": "ip",
                                               "addr": "172.18.0.4",
                                               "backend_start_ms": "900"}]}])
        _label, ok, why = m.c14_off_replica_lock_row("api-a", "api-b", lingering, None)
        self.assertIsNone(ok)
        self.assertIn("PRE-DATES the arm", why)
        # the SAME sample with a backend that started inside the window is the product bug
        fresh = dict(lingering, window=[1000.0, 9000.0],
                     events=[{"ts_ms": 2000000.0, "n": "c1s2", "replicas": ["api-a"],
                              "holders": [{"pid": "9", "service": "api-a", "basis": "ip",
                                           "addr": "172.18.0.4",
                                           "backend_start_ms": "1000001"}]}])
        self.assertIs(False, m.c14_off_replica_lock_row("api-a", "api-b", fresh, None)[1])
        # and with no window at all (the probe recorded nothing) the holder still counts
        self.assertIs(False, m.c14_off_replica_lock_row("api-a", "api-b",
                                                        dict(lingering, window=None),
                                                        None)[1])

    def test_silence_with_no_attribution_is_a_gap_whatever_the_log_says(self):
        quiet = dict(self.OBS_ON, attribution="none", holder_svcs=[],
                     by_replica={"api-a": 0, "api-b": 0}, unattributed={"172.17.0.1": 2},
                     events=[], held=0)
        _label, ok, why = m.c14_off_replica_lock_row("api-a", "api-b", quiet,
                                                     {"api-a": 0, "api-b": 9})
        self.assertIsNone(ok)
        self.assertIn("CANNOT attribute", why)

    def test_no_probe_falls_back_to_the_log_and_keeps_its_blindness_rule(self):
        self.assertIs(True, m.c14_off_replica_lock_row("api-a", "api-b", None,
                                                       {"api-a": 0, "api-b": 3})[1])
        self.assertIsNone(m.c14_off_replica_lock_row("api-a", "api-b", None,
                                                     {"api-a": 0, "api-b": 0})[1])
        self.assertIs(False, m.c14_off_replica_lock_row("api-a", "api-b", None,
                                                        {"api-a": 2, "api-b": 1})[1])
        self.assertIsNone(m.c14_off_replica_lock_row("api-a", "api-b", None, None)[1])
        self.assertIn("backup", m.c14_off_replica_lock_row("api-a", "api-b", None,
                                                           {"api-a": 0, "api-b": 3})[2])

    def test_the_arm_passes_the_probe_through_and_the_pg_reading_wins(self):
        """The log probe would have PASSED this arm (api-b ticked, api-a printed nothing);
        the Postgres reading caught api-a holding the lock — the pg evidence decides."""
        off_holds = dict(self.OBS_ON, by_replica={"api-a": 3, "api-b": 5},
                         holder_svcs=["api-a", "api-b"],
                         events=[{"ts_ms": 1.0, "n": "c1s2", "replicas": ["api-a"],
                                  "holders": [{"pid": "9", "service": "api-a",
                                               "basis": "ip"}]}])
        rows = [r for r in c14_off_replica_verdicts_through(off_holds)]
        self.assertIs(False, one(rows, "never claims the driver's advisory lock"))
        self.assertEqual(5, len(rows), rows)

    def test_the_arm_still_decides_from_the_log_when_the_probe_never_ran(self):
        rows = c14_off_replica_verdicts_through(None)
        self.assertIs(True, one(rows, "never claims the driver's advisory lock"))


def c14_off_replica_verdicts_through(lock_obs):
    """c14_off_replica_verdicts with everything else clean — so the only moving part is the
    lock evidence."""
    return m.c14_off_replica_verdicts(
        off="api-a", on="api-b",
        reads={"/api/v1/system/readiness": 200, "/api/v1/system/scheduler": 200},
        posted=(201, "r-1"), advance=["queued", "running"],
        lock_marks={"api-a": 0, "api-b": 3}, restore=("api-a", "on"), lock_obs=lock_obs)



class LockProbeLiveStubbed(unittest.TestCase):
    """The docker/psql half, with both stubbed: what the probe COMMANDS, what a failed read
    becomes, and how a container's addresses get read. No container is touched here — the
    literal Postgres proof is the run that produced LockProbeParse's fixture."""

    def setUp(self):
        self.saved = (m.run, m.compose_container)
        self.calls = []

    def tearDown(self):
        m.run, m.compose_container = self.saved

    def _run(self, rc, out):
        def fake(cmd, **kw):
            self.calls.append(([str(a) for a in cmd], kw))
            return rc, out
        m.run = fake

    def test_a_probe_call_is_one_read_only_psql_on_this_projects_postgres(self):
        self._run(0, "")
        empty = m.c14_lock_probe_once(samples=2, every_s=0.001)
        self.assertEqual([], empty["samples"],
                         "rc=0 with no rows is a READABLE window that caught nothing (the "
                         "lesson c14_lock_marks already learned from D6), not a failed read")
        (cmd, kw), = self.calls
        self.assertEqual(["docker", "compose", "-p", m.COMPOSE_PROJECT], cmd[:4])
        self.assertIn("exec", cmd)
        self.assertIn("-T", cmd)
        self.assertEqual("postgres", cmd[cmd.index("exec") + 2], cmd)
        psql_argv = cmd[cmd.index("psql"):]
        self.assertEqual("-", psql_argv[psql_argv.index("-f") + 1],
                         "the script goes in on STDIN (-f -), not in argv")
        self.assertIn("-tA", psql_argv, "unaligned tuples-only output: what the parser reads")
        self.assertIn("--no-psqlrc", psql_argv, "a host ~/.psqlrc must not steer the probe")
        self.assertIn("ON_ERROR_STOP=1", " ".join(psql_argv),
                      "a script that errors half-way must return rc!=0, not a short read")
        self.assertIn("SELECT json_build_array('env'", kw["input"])
        self.assertNotIn("SCHEDULER", " ".join(cmd), "no flag in argv (compose env's job)")
        self.assertLess(kw["timeout"], 120, "a bounded read — a wedged psql must not hang "
                                           "the roll")

    def test_a_failed_read_is_none_not_zero_samples(self):
        self._run(1, "psql: error: the server closed the connection")
        self.assertIsNone(m.c14_lock_probe_once(samples=1, every_s=0.001))

        def boom(cmd, **kw):
            raise OSError("docker: no socket")
        m.run = boom
        self.assertIsNone(m.c14_lock_probe_once(samples=1, every_s=0.001))
        self._run(0, '["s", 1, "1793314520000", null, null]\n')
        self.assertEqual(1, len(m.c14_lock_probe_once(samples=1, every_s=0.001)["samples"]))

    def test_a_raising_docker_is_none_not_an_exception(self):
        """The probe runs in a thread next to the roll: an exception here would kill the
        sampler and leave the arm with no evidence at all."""
        def boom(cmd, **kw):
            raise OSError("docker: no socket")
        m.run = boom
        self.assertIsNone(m.c14_lock_probe_once(samples=1, every_s=0.001))

    def test_docker_inspect_addresses_reads_both_shapes_docker_prints(self):
        user_defined = {"NetworkSettings": {"IPAddress": "",
                                            "Networks": {"communication-m4_default":
                                                         {"IPAddress": "172.18.0.4/16",
                                                          "GlobalIPv6Address": ""}}}}
        bridge = {"NetworkSettings": {"IPAddress": "172.17.0.4", "Networks": None}}
        self.assertEqual(["172.18.0.4/16"], m.c14_inspect_addresses(user_defined))
        self.assertEqual(["172.17.0.4"], m.c14_inspect_addresses(bridge))
        for junk in (None, [], {}, "", {"NetworkSettings": None}):
            self.assertEqual([], m.c14_inspect_addresses(junk), repr(junk))

    def test_replica_addresses_resolve_the_container_first(self):
        m.compose_container = lambda svc: f"{m.COMPOSE_PROJECT}-{svc}-1"
        self._run(0, '[{"Name":"/communication-m4-api-a-1","NetworkSettings":'
                     '{"Networks":{"communication-m4_default":{"IPAddress":"172.18.0.4"}}}}]')
        table = m.c14_replica_addresses(("api-a",))
        self.assertEqual({"api-a": {"container": "communication-m4-api-a-1",
                                   "ips": ["172.18.0.4"]}}, table)
        self.assertEqual([f"{m.COMPOSE_PROJECT}-api-a-1"], [c[-1] for c, _kw in self.calls])

    def test_an_unresolvable_or_uninspectable_container_has_no_address(self):
        m.compose_container = lambda svc: ""
        self.assertEqual({"api-a": {"container": "", "ips": []}},
                         m.c14_replica_addresses(("api-a",)) or {"api-a": {"container": "",
                                                                           "ips": []}})
        self.assertIsNone(m.c14_replica_addresses(("api-a",)), "no ips at all -> None")
        m.compose_container = lambda svc: "communication-m4-api-a-1"
        self._run(1, "no such object")
        self.assertIsNone(m.c14_replica_addresses(("api-a",)))
        self._run(0, "not json")
        self.assertIsNone(m.c14_replica_addresses(("api-a",)))

    def test_the_probe_threads_samples_in_and_stops_cleanly(self):
        real = m.c14_lock_probe_once
        out = {"env": {"database": "communication"}, "backends": None, "junk": 0,
               "samples": [{"n": 1, "ts_ms": 1000.0, "other_keys": [],
                            "holders": [{"pid": "7", "application_name": "",
                                         "client_addr": "172.18.0.5/32", "client_port": "1",
                                         "usename": "u", "datname": "d", "state": "idle",
                                         "backend_start_ms": "900", "objsubid": "1",
                                         "mode": "ExclusiveLock"}]}]}
        reads = [{"__count__": 1}]

        def fake_once(samples=None, every_s=None, key=None, timeout_s=None):
            if reads and reads[0]["__count__"] <= 0:
                return None
            reads[0]["__count__"] -= 1
            return dict(out, backends={"database": "communication", "count": 2,
                                       "addrs": ["172.18.0.5/32"], "app_names": [""]})
        m.c14_lock_probe_once = fake_once
        m.c14_replica_addresses = lambda services: {"api-a": {"container": "c-a",
                                                              "ips": ["172.18.0.4"]},
                                                    "api-b": {"container": "c-b",
                                                              "ips": ["172.18.0.5"]}}
        try:
            probe = C14LockProbe_for_test()
            obs = probe.start().stop()
        finally:
            m.c14_lock_probe_once, m.c14_replica_addresses = real, m.c14_replica_addresses
        self.assertEqual("holders", obs["attribution"])
        self.assertGreater(obs["by_replica"]["api-b"], 0, obs)
        self.assertEqual(0, obs["by_replica"]["api-a"])
        self.assertGreaterEqual(obs["calls"], 1)

    def test_a_postgres_that_stops_answering_is_recorded_and_the_arm_gaps(self):
        real_once, real_addr = m.c14_lock_probe_once, m.c14_replica_addresses
        m.c14_lock_probe_once = lambda *a, **kw: None
        m.c14_replica_addresses = lambda services: {"api-a": {"container": "c-a",
                                                              "ips": ["172.18.0.4"]}}
        try:
            obs = C14LockProbe_for_test(tag="C14b").start().stop()
        finally:
            m.c14_lock_probe_once, m.c14_replica_addresses = real_once, real_addr
        self.assertEqual(0, obs["samples"])
        self.assertTrue(obs["errors"], "every failed read must be reported")
        rows = m.c14_lock_pg_verdicts(obs, [{"svc": "api-a", "peer": "api-b",
                                             "t_restart": 1.0, "t_gone": 1.5, "t_ready": 9.0}])
        self.assertEqual([None, None, None], [ok for _l, ok, _d in rows], rows)
        self.assertIn("probe errors", rows[0][2])

    def test_an_address_that_moved_during_the_window_is_reported_not_reassigned(self):
        """C14c recreates api-a before it starts sampling, so api-a's ip can change inside a
        window. Attribution must use the union and the drift must be visible."""
        real_addr = m.c14_replica_addresses
        m.c14_replica_addresses = lambda services: {"api-a": {"container": "c-a",
                                                              "ips": ["172.18.0.9"]}}
        try:
            probe = C14LockProbe_for_test()
            probe.addr_map = {"api-a": {"container": "c-a", "ips": ["172.18.0.4"]}}
            obs = probe.summary()          # the end read happens here (patched -> .9)
        finally:
            m.c14_replica_addresses = real_addr
        self.assertEqual(["172.18.0.4", "172.18.0.9"], obs["addr_map"]["api-a"],
                         "attribution scores the union, so a holder is still named")
        self.assertEqual({"api-a": {"start": ["172.18.0.4"], "end": ["172.18.0.9"]}},
                         obs["addr_drift"],
                         "and the reader can see the address moved under the window")

    def test_the_roll_records_the_down_window_the_handover_is_judged_in(self):
        """c14_roll_one must stamp t_restart / t_gone / t_ready, or the pg verdicts have no
        window to place holders in."""
        real = (m.run, m.Client, m.c14_wait_replica)
        m.run = lambda cmd, **kw: (0, "restarted")
        class Refused:
            def get(self, base, path, timeout=None):
                raise OSError("connection refused")
        m.Client = lambda *a, **kw: Refused()
        m.c14_wait_replica = lambda base, timeout=120: True
        try:
            step = {}
            ok, ready = m.c14_roll_one("api-a", "http://localhost:18092",
                                      "http://localhost:18093", [], step)
        finally:
            m.run, m.Client, m.c14_wait_replica = real
        self.assertEqual((True, True), (ok, ready))
        self.assertEqual("api-a", step["svc"])
        self.assertTrue(step.get("t_restart") <= step.get("t_ready"), step)
        rows = m.c14_lock_pg_verdicts({"samples": 1, "held": 0, "by_replica": {}, "events": [],
                                       "simultaneous": [], "unattributed": {}, "empty_addr": 0,
                                       "other_key_samples": 0, "bases": [], "pids": {},
                                       "addr_map": {}, "container": {}, "env": None,
                                       "errors": [], "calls": 1, "backend": {},
                                       "replica_backend_svcs": [], "holder_svcs": [],
                                       "attribution": "none", "span_ms": None}, [step])
        windows = m.c14_lock_roll_windows([step])
        self.assertEqual(1, len(windows), "the roll produced a window the probe can score")
        self.assertTrue(all(ok is None for _l, ok, _d in rows),
                        "with nothing sampled the arm GAPs — never a PASS by silence")


# ================= C14b: the SURVIVING-backend handover grading =================
# Recorded from acceptance run 41983100425 (core-b). The probe caught the driver's
# advisory key granted INSIDE both roll windows — to the PEER's long-lived backend
# (api-b's session during api-a's window, api-a's post-restart session during
# api-b's window). The old algebra compared each holder's backend_start against the
# ROLLED replica's restart clock and called both "stale" (GAP); the corrected
# algebra grades a peer holder by the restarts of the service it BELONGS TO — and
# "held by a SURVIVING replica while the rolled replica is down" is exactly what
# was observed.

RUN4198_STEPS = [
    {"svc": "api-a", "peer": "http://localhost:18093",
     "t_restart": 1793861815.950, "t_ready": 1793861818.293, "ready": True},
    {"svc": "api-b", "peer": "http://localhost:18092",
     "t_restart": 1793861818.548, "t_ready": 1793861820.845, "ready": True},
]
RUN4198_EVENTS = [
    {"ts_ms": 1793861817000.0, "n": "c2s18", "replicas": ["api-b"],
     "holders": [{"pid": "101", "service": "api-b", "basis": "ip",
                  "addr": "172.18.0.4", "state": "idle", "objsubid": "1",
                  # api-b booted long before either roll: its session legitimately
                  # predates API-A's restart — that is survivorship, not staleness
                  "backend_start_ms": 1793861700000.0}]},
    {"ts_ms": 1793861818314.0, "n": "c2s34", "replicas": ["api-a"],
     "holders": [{"pid": "806", "service": "api-a", "basis": "ip",
                  "addr": "172.18.0.7", "state": "idle", "objsubid": "1",
                  "backend_start_ms": 1793861817500.0}]},
    {"ts_ms": 1793861820342.0, "n": "c3s9", "replicas": ["api-a"],
     "holders": [{"pid": "827", "service": "api-a", "basis": "ip",
                  "addr": "172.18.0.7", "state": "idle", "objsubid": "1",
                  # api-a's NEW session (born after api-a's own restart) — older
                  # than api-b's restart only by seconds, which says nothing
                  "backend_start_ms": 1793861818600.0}]},
    {"ts_ms": 1793861820875.0, "n": "c3s22", "replicas": ["api-b"],
     "holders": [{"pid": "839", "service": "api-b", "basis": "ip",
                  "addr": "172.18.0.4", "state": "idle", "objsubid": "1",
                  "backend_start_ms": 1793861819900.0}]},
]


def _obs(events, **kw):
    obs = {"events": events, "samples": 120, "held": len(events),
           "by_replica": {}, "attribution": "holders", "simultaneous": [],
           "unattributed": {}, "empty_addr": 0, "other_key_samples": 4,
           "bases": ["ip"], "pids": {}, "addr_map": {}, "container": {},
           "env": None, "errors": [], "calls": 3,
           "backend": {"database": "communication", "count": 8,
                       "addrs": ["172.18.0.4", "172.18.0.7"], "app_names": ["psql"]},
           "replica_backend_svcs": ["api-a", "api-b"], "holder_svcs": [],
           "span_ms": 6000}
    obs.update(kw)
    for e in events:
        for h in e.get("holders") or []:
            if h.get("service"):
                obs["by_replica"][h["service"]] = \
                    obs["by_replica"].get(h["service"], 0) + 1
    obs["holder_svcs"] = sorted(s for s, c in obs["by_replica"].items() if c)
    return obs


class HandoverSurvivor(unittest.TestCase):
    """The mis-grade fixed: backend_start_ms is stale only against a restart of the
    service the holder BELONGS TO."""

    def test_the_recorded_run_41983100425_evidence_now_passes(self):
        obs = _obs(RUN4198_EVENTS)
        hand = m.c14_lock_handover(obs, RUN4198_STEPS)
        self.assertEqual([], hand["stale_in_window"],
                         "no holder in that recording predates a restart of its OWN "
                         "service — none of them is a corpse backend")
        self.assertEqual(2, len(hand["peer_hits"]),
                         "the two in-window samples name the SURVIVING replica")
        self.assertEqual([], hand["own_hits"])
        rows = m.c14_lock_pg_verdicts(obs, RUN4198_STEPS)
        self.assertIs(True, rows[2][1], rows[2][2])
        self.assertIn("stayed up", rows[2][2])
        self.assertIn("PREDATES", rows[2][2],
                      "the row must EXPLAIN why a pre-restart peer backend is the "
                      "handover and not its refutation")

    def test_a_peer_backend_that_predates_the_PEERS_own_restart_is_a_corpse(self):
        """api-b restarted at 60; a sample inside api-a's window naming an api-b
        backend born at 55 can only be api-b's DEAD pre-restart session: GAP, the
        amnesty rule protects corpses in BOTH directions."""
        steps = [{"svc": "api-b", "peer": "http://localhost:18092",
                  "t_restart": 60.0, "t_ready": 63.0},
                 {"svc": "api-a", "peer": "http://localhost:18093",
                  "t_restart": 100.0, "t_gone": 100.4, "t_ready": 106.0}]
        ev = [{"ts_ms": 101000, "n": "c1s2", "replicas": ["api-b"],
               "holders": [{"pid": "7", "service": "api-b", "basis": "ip",
                            "backend_start_ms": "55000"}]}]
        hand = m.c14_lock_handover(_obs(ev), steps)
        self.assertEqual(1, len(hand["stale_in_window"]), hand)
        self.assertEqual([], hand["peer_hits"])
        self.assertIsNone(m.c14_lock_pg_verdicts(_obs(ev), steps)[2][1])

    def test_a_peer_backend_born_after_the_peers_restart_is_still_a_hit(self):
        steps = [{"svc": "api-b", "peer": "http://localhost:18092",
                  "t_restart": 60.0, "t_ready": 63.0},
                 {"svc": "api-a", "peer": "http://localhost:18093",
                  "t_restart": 100.0, "t_gone": 100.4, "t_ready": 106.0}]
        ev = [{"ts_ms": 101000, "n": "c1s2", "replicas": ["api-b"],
               "holders": [{"pid": "8", "service": "api-b", "basis": "ip",
                            "backend_start_ms": "70000"}]}]
        rows = m.c14_lock_pg_verdicts(_obs(ev), steps)
        self.assertIs(True, rows[2][1], rows[2][2])

    def test_the_rolled_replicas_own_clock_still_decides_its_own_samples(self):
        """(regression pin) the rolled replica inside its own window: a backend
        older than THAT restart is the un-reaped corpse — the rule the old algebra
        got right, kept exactly."""
        ev = [{"ts_ms": 100600, "n": "c1s2", "replicas": ["api-a"],
               "holders": [{"pid": "7", "service": "api-a", "basis": "ip",
                            "backend_start_ms": "99000"}]}]
        steps = [{"svc": "api-a", "peer": "api-b", "t_restart": 100.0,
                  "t_gone": 100.4, "t_ready": 106.0}]
        rows = m.c14_lock_pg_verdicts(_obs(ev), steps)
        self.assertIsNone(rows[2][1])
        self.assertIn("PRE-DATE the restart of the very service they belong to",
                      rows[2][2])


# ================= C14b: the FORCED two-replica race ============================

class RaceProbe(unittest.TestCase):
    RUN = "019ece4b-1d3d-7a33-9b1f-0f2b7a990b42"

    def test_the_script_samples_the_runs_advancer_key_granted_and_waiting(self):
        script = m.c14_adv_race_script(self.RUN, samples=3, every_s=0.04)
        self.assertIn("communication/advancer/", script)
        self.assertIn(self.RUN, script)
        self.assertIn("l.granted::text", script,
                      "a granted=false waiter IS the evidence — the driver's-key "
                      "probe filters granted; this one must not")
        self.assertIn("hashtextextended", script)
        self.assertNotIn("pg_try_advisory_lock", script)
        self.assertNotIn("pg_advisory_lock(", script,
                         "the probe must never take the lock it measures")
        self.assertIn("pg_sleep", script)

    def test_parse_and_summarize_a_recorded_overlap(self):
        """One psql line as the real probe prints it: api-a holds the run's advancer
        key (granted=t, transaction-level objsubid=0), api-b waits on THE SAME key
        (granted=f). That pair, attributed by client_addr × container IPs, is what
        'both replicas advance the same run in one instant' reads as."""
        lines = [
            '["x", 1, "1793861819123", [["806","t","0","ExclusiveLock","",'
            '"172.18.0.7","1793861816400","idle in transaction"],'
            '["827","f","0","ExclusiveLock","","172.18.0.4","1793861819000",'
            '"active"]]]',
            '["y"]',   # well-formed JSON, wrong shape: counts as junk
            '["x", 2, "1793861819423", [["806","t","0","ExclusiveLock","",'
            '"172.18.0.7","1793861816400","idle in transaction"]]]',
        ]
        parsed = m.c14_adv_race_parse_output("\n".join(lines))
        self.assertEqual(2, len(parsed["samples"]))
        self.assertEqual(1, parsed["junk"])
        addr_map = {"api-a": {"container": "communication-m4-api-a-1",
                              "ips": ["172.18.0.7"]},
                    "api-b": {"container": "communication-m4-api-b-1",
                              "ips": ["172.18.0.4"]}}
        obs = m.c14_adv_race_summarize(parsed, addr_map)
        self.assertTrue(obs["overlap"])
        self.assertEqual(1, len(obs["pairs"]))
        p = obs["pairs"][0]
        self.assertEqual(["api-a"], sorted({g["service"] for g in p["granted"]}))
        self.assertEqual(["api-b"], sorted({w["service"] for w in p["waiting"]}))

    def test_a_holder_or_waiter_that_cannot_be_attributed_never_makes_a_pair(self):
        parsed = m.c14_adv_race_parse_output(
            '["x", 1, "1793861819123", [["806","t","0","ExclusiveLock","",'
            '"172.17.0.1","1793861816400","idle in transaction"],'
            '["827","f","0","ExclusiveLock","","172.17.0.1","1793861819000",'
            '"active"]]]')
        obs = m.c14_adv_race_summarize(
            parsed, {"api-a": {"ips": ["172.18.0.7"]}, "api-b": {"ips": ["172.18.0.4"]}})
        self.assertFalse(obs["overlap"])
        self.assertEqual([], obs["pairs"],
                         "everything behind one NAT address names no replica — no pair")

    def test_the_wedge_liveness_read_excludes_its_own_query(self):
        """The marker sits inside the liveness-check SELECT's OWN query text too:
        without the pg_backend_pid() exclusion the wedge proves itself by tautology
        and the arm fires decides it cannot prove are made against a held row."""
        seen = {}
        real = m.psql
        m.psql = lambda sql: seen.update(sql=sql) or "0"
        try:
            self.assertIs(False, m.c14_race_wedge_seen())
        finally:
            m.psql = real
        self.assertIn("pg_backend_pid()", seen["sql"])
        self.assertIn(m.C14_RACE_MARKER, seen["sql"])

    def test_the_wedge_is_one_implicit_transaction_holding_the_run_row(self):
        """psql -c runs the multi-statement string as ONE simple query / implicit
        transaction: the FOR UPDATE lives across the pg_sleep and dies with the
        implicit COMMIT — no kill, no dangling writer, no row written."""
        calls = {}

        class FakePopen:
            def __init__(self, cmd, **kw):
                calls["cmd"] = " ".join(cmd)
                self.pid = 4242

        real_popen = m.subprocess.Popen
        m.subprocess.Popen = FakePopen
        try:
            proc, how = m.c14_race_wedge_start("019ece4b-1d3d", m.C14_RACE_WEDGE_S)
        finally:
            m.subprocess.Popen = real_popen
        self.assertIn("FROM runs WHERE id = '019ece4b-1d3d'::uuid FOR UPDATE",
                      calls["cmd"])
        self.assertIn(m.C14_RACE_MARKER, calls["cmd"])
        self.assertIn(f"pg_sleep({m.C14_RACE_WEDGE_S})", calls["cmd"])
        self.assertNotIn("UPDATE runs SET", calls["cmd"],
                         "the wedge locks the row, it never writes a column")
        self.assertIs(proc.pid, 4242)

    def test_t_f_are_the_real_psql_booleans(self):
        parsed = m.c14_adv_race_parse_output(
            '["x", 1, "100", [["9","f","0","ExclusiveLock","","172.18.0.4","90",'
            '"active"]]]')
        row = parsed["samples"][0]["rows"][0]
        obs = m.c14_adv_race_summarize(
            parsed, {"api-b": {"ips": ["172.18.0.4"]}})
        self.assertEqual("f", row["granted"],
                         "parse keeps psql's literal; summarize maps t/f")
        self.assertEqual([], obs["pairs"], "a lone waiter names no overlap")


class RaceVerdicts(unittest.TestCase):
    OVERLAP = {"samples": 40, "junk": 0, "bases": ["ip"], "attributed": {"api-a": 12,
                                                                         "api-b": 12},
               "overlap": True,
               "pairs": [{"ts_ms": 1793861819123.0, "n": 7,
                          "granted": [{"pid": "806", "service": "api-a", "basis": "ip",
                                       "objsubid": "0", "granted": True,
                                       "mode": "ExclusiveLock"}],
                          "waiting": [{"pid": "827", "service": "api-b", "basis": "ip",
                                       "objsubid": "0", "granted": False,
                                       "mode": "ExclusiveLock"}]}]}
    RACE = {"wedge": {"started": True, "observed": True, "gone": True},
            "pause": {"svc": "api-a", "paused": True, "resumed": True, "ready": True},
            "overlap": OVERLAP, "reason": ""}
    RESULTS = [{"svc": "api-a", "status": 200, "replica": "api-a"},
               {"svc": "api-b", "status": 409, "replica": "api-b"}]
    LEDGER = {"decided": 1, "dup_succeeded": 0, "terminal": "completed"}

    def test_the_clean_forced_race_passes_all_four_rows(self):
        rows = m.c14_race_verdicts(self.RACE, self.RESULTS, self.LEDGER)
        self.assertEqual([True, True, True, True], [ok for _l, ok, _d in rows], rows)
        self.assertIn("granted to ['api-a']", rows[0][2])
        self.assertIn("api-b", rows[0][2])
        self.assertIn("version CAS", rows[1][2])

    def test_both_sides_committing_is_the_product_failure(self):
        rows = m.c14_race_verdicts(
            self.RACE, [{"svc": "api-a", "status": 200}, {"svc": "api-b", "status": 200}],
            {"decided": 2, "dup_succeeded": 1, "terminal": "completed"})
        self.assertIs(True, rows[0][1], "the race was still forced — that is its own row")
        self.assertIs(False, rows[1][1], "two replicas applied one transition: FAIL")
        self.assertIn("BOTH decides committed", rows[1][2])

    def test_no_overlap_sample_is_an_honest_gap_never_a_pass(self):
        race = dict(self.RACE, overlap={"samples": 40, "pairs": [], "overlap": False,
                                        "attributed": {}, "bases": [], "junk": 0})
        rows = m.c14_race_verdicts(race, self.RESULTS, self.LEDGER)
        self.assertIsNone(rows[0][1])
        self.assertIn("never a verdict about the product", rows[0][2])

    def test_an_arm_that_never_forced_gaps_all_four_rows_with_its_reason(self):
        rows = m.c14_race_verdicts({"reason": "the wedge could not start: OSError"}, [])
        self.assertEqual([None, None, None, None], [ok for _l, ok, _d in rows])
        for _l, _ok, d in rows:
            self.assertIn("wedge", d.lower())

    def test_no_clean_winner_is_ungraded(self):
        rows = m.c14_race_verdicts(
            self.RACE,
            [{"svc": "api-a", "status": None, "error": "timeout"},
             {"svc": "api-b", "status": 500}], {"decided": 0, "dup_succeeded": 0,
                                                "terminal": "waiting_human"})
        self.assertIsNone(rows[1][1], "nothing won — refused-vs-timed-out is unreadable")
        self.assertIsNone(rows[2][1])

    def test_the_raced_run_ending_broken_fails_the_intact_row(self):
        rows = m.c14_race_verdicts(self.RACE, self.RESULTS,
                                   {"decided": 1, "dup_succeeded": 0, "terminal": "failed"})
        self.assertIs(False, rows[2][1])

    def test_a_replica_left_frozen_fails_the_lever_row(self):
        race = dict(self.RACE, pause={"svc": "api-a", "paused": True, "resumed": False,
                                      "ready": False})
        rows = m.c14_race_verdicts(race, self.RESULTS, self.LEDGER)
        self.assertIs(False, rows[3][1],
                      "the lab not handed back is never a silent PASS")

    def test_the_race_arm_is_wired_into_the_live_gate(self):
        body = open(os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                 "e2e_m4_exit.py"), encoding="utf-8").read()
        c14_body = body.split("def c14():")[1].split("def _playwright_stub")[0]
        self.assertIn("c14_race_forced(alice, facts, pid)", c14_body)
        self.assertNotIn('the two-replica race is NOT forced', c14_body,
                         "the old reworded-GAP call must be GONE, not reworded again")


# ================= C14c: the flag off EVERYWHERE ================================

class AllOffVerdicts(unittest.TestCase):
    TURN = {"status": "completed", "worker": "019ece4b-0000-7000-8000-00000000000a",
            "token": 41, "verified": 1, "workspace": 1, "replayed": 200}
    STATES = {"api-a": "off", "api-b": "off"}
    READY = {"api-a": True, "api-b": True}
    RESTORE = [("api-a", "on"), ("api-b", "on")]

    def rows(self, states=STATES, ready=None, posted=(201, "r1"), seen=("queued",) * 6,
             turn=TURN, restore=RESTORE, blocked=""):
        return m.c14_all_off_verdicts(states, ready if ready is not None else self.READY,
                                      posted, list(seen), turn, restore, blocked=blocked)

    def test_intact_m2_m3_and_a_run_that_stays_queued_pass(self):
        rows = self.rows()
        self.assertIs(True, one(rows, "leaves M2/M3 intact"), detail(rows, "intact"))
        self.assertIs(True, one(rows, "STAYS 'queued'"))
        self.assertIn("claim/lease/fence", detail(rows, "leaves M2/M3 intact"))
        self.assertTrue(any("restore: api-a" in l and ok is True
                            for l, ok, _d in rows), rows)
        self.assertTrue(any("restore: api-b" in l and ok is True
                            for l, ok, _d in rows), rows)

    def test_a_turn_that_died_with_the_engines_off_fails(self):
        rows = self.rows(turn=dict(self.TURN, status="failed"))
        self.assertIs(False, one(rows, "leaves M2/M3 intact"))

    def test_a_run_advancing_while_both_engines_are_off_fails(self):
        rows = self.rows(seen=("queued", "queued", "running"))
        self.assertIs(False, one(rows, "STAYS 'queued'"),
                      "the advancer started despite the flag: the product bug "
                      "this half of the row exists to catch")

    def test_an_incomplete_reading_never_passes(self):
        for turn in (dict(self.TURN, token=0), dict(self.TURN, verified=0),
                     dict(self.TURN, workspace=0), dict(self.TURN, replayed=404)):
            rows = self.rows(turn=turn)
            self.assertIs(False, one(rows, "leaves M2/M3 intact"), turn)
        for missing in ("worker", "verified", "replayed"):
            turn = dict(self.TURN)
            del turn[missing]
            rows = self.rows(turn=turn)
            self.assertIsNone(one(rows, "leaves M2/M3 intact"),
                              f"{missing} unreadable is a GAP, not a FAIL of the product")

    def test_an_arm_that_never_got_both_off_gaps_everything(self):
        for states in ({"api-a": "off", "api-b": "on"}, None, {},
                       {"api-a": "on", "api-b": "on"}):
            rows = self.rows(states=states)
            self.assertIsNone(one(rows, "leaves M2/M3 intact"), states)
            self.assertIsNone(one(rows, "STAYS 'queued'"))
        rows = self.rows(states=None, blocked="the recreate of api-a answered rc=1")
        self.assertIn("recreate of api-a", detail(rows, "leaves M2/M3 intact"))
        self.assertIn("recreate of api-a", detail(rows, "STAYS 'queued'"))

    def test_a_restore_that_left_an_engine_off_fails_its_row(self):
        rows = self.rows(restore=[("api-a", "off"), ("api-b", "on")])
        offs = [ok for l, ok, _d in rows if "restore: api-a" in l]
        self.assertEqual([False], offs, "later gates inherit a crippled lab — FAIL")

    def test_the_live_turn_reading_shape_is_proven_offline(self):
        """c14_m2_turn_evidence reads conversation_turns / domain_events / workspaces
        through psql — the pure shape is pinned here with stubbed reads."""
        real = (m.psql, m.Client)
        try:
            m.psql = lambda sql: ("completed|019ece4b-aaaa|41"
                                  if "conversation_turns" in sql else
                                  "1" if "domain_events" in sql or "workspaces" in sql
                                  else "")

            class Ok:
                def get(self, base, path):
                    return m.Resp(200, {}, b"{}", path)

            m.Client = lambda *a, **kw: Ok()
            out = m.c14_m2_turn_evidence(m.Client("alice"), "c" * 36, "t" * 36,
                                         wait_s=1)
        finally:
            m.psql, m.Client = real
        self.assertEqual("completed", out["status"])
        self.assertEqual(41, out["token"])
        self.assertEqual(1, out["verified"])
        self.assertEqual(1, out["workspace"])
        self.assertEqual(200, out["replayed"])

    def test_the_both_off_arm_is_wired_after_the_one_off_verdicts(self):
        body = open(os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                 "e2e_m4_exit.py"), encoding="utf-8").read()
        arm = body.split("def c14_off_replica(")[1].split("def c14_wait_replica(")[0]
        self.assertIn("c14_all_off(alice, facts, project_id, roll=roll)", arm)
        self.assertNotIn("needs a separate bring-up", body,
                         "the old 'a § 7.0 lab decision' GAP text is gone")


def C14LockProbe_for_test(services=("api-a", "api-b"), tag="C14test"):
    """A probe whose loop cannot spin: one sample per call and no sleep at all — the stubbed
    c14_lock_probe_once returns instantly, so stop() must not have to wait for it."""
    return m.C14LockProbe(services=services, samples=1, every_s=0.0, tag=tag)


if __name__ == "__main__":
    unittest.main(verbosity=2 if "-v" in sys.argv else 1)
