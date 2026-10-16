#!/usr/bin/env python3
"""test_c2_logic.py - offline unit proof for e2e_m4_exit.py's C2 pure logic.

Runs WITHOUT a stack (stdlib unittest only): the /proc scan parser, THE central
"the sentinel is found in exactly one live process environment" verdict algebra
(PASS / FAIL / GAP), the env-not-a-file rule, the nowhere-durable absence rule
(an unreadable place GAPs, it never counts as a clean zero), the
lifecycle=node_attempt + attempt_id + cleaned-by-the-worker rule, and the
attempt-owns-its-conversation_turns rule that leaves M3's human turns alone.

A green here means the VERDICT ALGEBRA is right. It never substitutes for C2's
live read of /proc/<pid>/environ inside a running worker
(12-test-strategy.md: the attempt boundary is only proven by a real attempt).

usage: python3 e2e/m4/test_c2_logic.py [-v]
"""
import hashlib
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import e2e_m4_exit as m  # noqa: E402 — importing the driver is the point

SHA = hashlib.sha256(m.SENTINEL.encode()).hexdigest()
OTHER = hashlib.sha256(b"postgres://someone:else@db/app").hexdigest()
ATT = "01987a82-3333-7000-8000-abcdef012345"


def rec(pid, sha, cmd="/usr/local/bin/claude --acp"):
    return f"PROC|{pid}|{sha}|{cmd}"


def scan(*lines):
    return m.c2_proc_scan("\n".join(lines))


def one(rows):
    return dict(zip(("id", "delivery_mode", "target", "lifecycle", "attempt_id",
                     "turn_id", "cleaned", "cleaned_by"), rows))


def mat(attempt=ATT, mode="env", target="DATABASE_URL", life="node_attempt",
        turn="-", cleaned="f", by="-"):
    return one(("1", mode, target, life, attempt, turn, cleaned, by))


def ok_of(vs, needle):
    hits = [ok for label, ok, _ in vs if needle in label]
    assert hits, f"no verdict matching {needle!r} in {[l for l, _, _ in vs]}"
    return hits[0]


class ProcScanTest(unittest.TestCase):
    def test_scan_script_hashes_rather_than_prints_the_value(self):
        sh = m.c2_proc_scan_sh()
        self.assertIn("sha256sum", sh)
        self.assertIn("^DATABASE_URL=", sh)
        self.assertIn("SCAN_DONE", sh)
        self.assertNotIn(m.SENTINEL, sh)

    def test_proc_lines_parse_and_ragged_ones_are_dropped(self):
        text = "\n".join([rec("41", SHA), "NOTICE: something", rec("57", OTHER, ""),
                          "PROC|not-a-pid|zz|x", "SCAN_DONE"])
        got = m.c2_proc_scan(text)
        self.assertEqual([r["pid"] for r in got], ["41", "57"])
        self.assertEqual(got[0]["sha"], SHA)

    def test_empty_scan_is_zero_holders_not_a_crash(self):
        self.assertEqual(m.c2_proc_scan(""), [])
        self.assertEqual(m.c2_proc_scan(None), [])


class LiveHomeTest(unittest.TestCase):
    def test_exactly_one_holder_is_the_pass(self):
        v = m.c2_live_home_verdicts(scan(rec("41", SHA)), SHA)
        self.assertTrue(all(ok for _, ok, _ in v), v)

    def test_two_holders_is_a_fail_even_though_the_value_is_present(self):
        v = m.c2_live_home_verdicts(scan(rec("41", SHA), rec("77", SHA)), SHA)
        self.assertFalse(ok_of(v, "EXACTLY ONE"))

    def test_zero_holders_fails_rather_than_reading_the_scan_as_clean(self):
        v = m.c2_live_home_verdicts(scan(rec("41", OTHER)), SHA)
        self.assertFalse(ok_of(v, "EXACTLY ONE"))

    def test_an_unfinished_scan_gaps(self):
        v = m.c2_live_home_verdicts([rec("41", SHA)], SHA, scan_ok=False)
        self.assertIsNone(ok_of(v, "/proc scan answered"))

    def test_no_authorized_attempt_gaps_but_still_checks_foreign_holders(self):
        v = m.c2_live_home_verdicts([], SHA, authorized=False, holder="twin run")
        self.assertIsNone(ok_of(v, "exactly one live process"))
        self.assertTrue(ok_of(v, "un-authorized process"))
        self.assertFalse(ok_of(m.c2_live_home_verdicts(scan(rec("9", OTHER)), SHA,
                                                      authorized=False),
                               "un-authorized process"))


class EnvDeliveryTest(unittest.TestCase):
    def test_env_delivery_with_no_env_file_passes(self):
        self.assertTrue(all(ok for _, ok, _ in
                            m.c2_env_delivery_verdicts([mat()], 1, "1")),
                        m.c2_env_delivery_verdicts([mat()], 1, "1"))

    def test_a_landed_env_file_fails(self):
        self.assertFalse(ok_of(m.c2_env_delivery_verdicts([mat()], 0, "0"),
                               ".env.test.local"))

    def test_env_file_delivery_mode_fails_the_shape_arm(self):
        self.assertFalse(ok_of(m.c2_env_delivery_verdicts(
            [mat(mode="env_file", target="config/app.env")], 1, "1"), "never env_file"))

    def test_no_rows_gaps(self):
        self.assertIsNone(ok_of(m.c2_env_delivery_verdicts([], 1, "1"),
                                "secret_materializations rows"))

    def test_an_unreadable_dotenv_probe_gaps(self):
        self.assertIsNone(ok_of(m.c2_env_delivery_verdicts([mat()], None, ""),
                                ".env probe answered"))


class AbsenceTest(unittest.TestCase):
    def test_zero_everywhere_passes(self):
        v = m.c2_absence_verdicts([{"place": "domain_events", "count": 0},
                                   {"place": "logs", "count": "0"}])
        self.assertEqual([ok for _, ok, _ in v], [True, True])

    def test_any_hit_fails(self):
        self.assertFalse(ok_of(m.c2_absence_verdicts([{"place": "artifacts", "count": 2}]),
                               "artifacts"))

    def test_an_unreadable_place_gaps_never_passes(self):
        v = m.c2_absence_verdicts([{"place": "mirror refs", "count": None},
                                   {"place": "mirror refs", "count": "boom"}])
        self.assertIsNone(v[0][1])
        self.assertIsNone(v[1][1])
        self.assertIn("UNPROVEN", v[1][2])

    def test_no_findings_is_no_verdict(self):
        self.assertEqual(m.c2_absence_verdicts([]), [])

    def test_phase_labels_the_lines(self):
        self.assertTrue(m.c2_absence_verdicts([{"place": "x", "count": 0}],
                                              phase="C2d")[0][0].startswith("C2d x"))


class MaterializationTest(unittest.TestCase):
    def test_attempt_stamped_and_cleaned_by_the_worker_passes(self):
        v = m.c2_materialization_verdicts([mat(cleaned="t", by="worker")], ATT)
        self.assertTrue(all(ok for _, ok, _ in v), v)

    def test_a_turn_stamped_row_fails_the_unit_of_work_arm(self):
        v = m.c2_materialization_verdicts([mat(attempt="-", turn="t-1")], ATT)
        self.assertFalse(ok_of(v, "stamped attempt_id"))

    def test_m3_lifecycle_fails(self):
        self.assertFalse(ok_of(m.c2_materialization_verdicts(
            [mat(life="turn", cleaned="t", by="worker")], ATT), "lifecycle is node_attempt"))

    def test_an_uncleaned_row_fails_after_the_boundary_only(self):
        self.assertFalse(ok_of(m.c2_materialization_verdicts([mat()], ATT), "UNMOUNTED"))
        self.assertEqual(len(m.c2_materialization_verdicts([mat()], ATT, terminal=False)), 3)

    def test_a_reconciler_cleanup_is_not_the_workers_defer(self):
        self.assertFalse(ok_of(m.c2_materialization_verdicts(
            [mat(cleaned="t", by="reconciler")], ATT), "UNMOUNTED"))

    def test_no_rows_gaps(self):
        self.assertIsNone(ok_of(m.c2_materialization_verdicts([], ATT),
                                "row for the attempt"))


class TurnOwnershipTest(unittest.TestCase):
    def test_an_attempt_stamped_turn_passes(self):
        v = m.c2_turn_ownership_verdicts(
            [{"attempt": ATT, "key": "/implement", "turn": "t1", "stamp": ATT,
              "status": "succeeded"}], "7")
        self.assertTrue(all(ok for _, ok, _ in v), v)

    def test_a_null_stamp_on_a_terminal_attempt_fails(self):
        self.assertFalse(ok_of(m.c2_turn_ownership_verdicts(
            [{"attempt": ATT, "key": "/implement", "turn": "t1", "stamp": "-",
              "status": "succeeded"}], "7"), "node_attempt_id"))

    def test_a_still_running_attempt_gaps(self):
        self.assertIsNone(ok_of(m.c2_turn_ownership_verdicts(
            [{"attempt": ATT, "key": "/implement", "turn": "t1", "stamp": "-",
              "status": "running"}], "7"), "node_attempt_id"))

    def test_no_agent_population_gaps(self):
        self.assertIsNone(ok_of(m.c2_turn_ownership_verdicts([], "7"),
                                "conversation_turns rows are readable"))

    def test_a_missing_human_count_never_passes_by_inference(self):
        self.assertFalse(ok_of(m.c2_turn_ownership_verdicts(
            [{"attempt": ATT, "key": "/implement", "turn": "t1", "stamp": ATT,
              "status": "succeeded"}], None), "UNTOUCHED"))


class SqlTest(unittest.TestCase):
    def test_scan_sql_covers_every_inventory_place(self):
        sql = m.c2_db_scan_sql(["runs.detail", "domain_events.payload"])
        self.assertEqual(sql.count("SELECT"), 2)
        self.assertIn("UNION ALL", sql)
        self.assertIn("t.payload::text LIKE", sql)
        self.assertEqual(m.c2_db_scan_sql([]), "")

    def test_inventory_sql_names_only_operational_tables(self):
        sql = m.c2_place_inventory_sql()
        self.assertIn("information_schema.columns", sql)
        for t in ("conversation_turns", "attempts", "domain_events", "audit_events",
                  "artifacts", "secret_materializations"):
            self.assertIn(f"'{t}'", sql, t)
        # the encrypted store is the ONE legitimate home of the value: it is
        # swept for ciphertext/commitment separately, never as a plaintext place
        for t in ("secret_versions", "secret_metadata"):
            self.assertNotIn(f"'{t}'", sql, t)


if __name__ == "__main__":
    unittest.main(verbosity=2 if "-v" in sys.argv else 1)
