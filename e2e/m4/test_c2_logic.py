#!/usr/bin/env python3
"""test_c2_logic.py - offline unit proof for e2e_m4_exit.py's C2 pure logic.

Runs WITHOUT a stack (stdlib unittest only): the /proc scan parser, THE central
"the sentinel is found in exactly one live process environment" verdict algebra
(PASS / FAIL / GAP), the env-not-a-file rule, the nowhere-durable absence rule
(an unreadable place GAPs, it never counts as a clean zero), the
lifecycle=node_attempt + attempt_id + cleaned-by-the-worker rule, and the
attempt-owns-its-conversation_turns rule that leaves M3's human turns alone.
And the authorization wiring live14 proved missing: C2 posts the AGENT variant
(the only profile-bearing, materialization-authorizable attempt) and aims its
live wait at the post-gate implement node, so § 7.1 C2a's "during the implement
attempt" window exists to be read at all (test_hold_logic.py's "only the fault
legs hold" list never named C2, and C2 no longer holds on the twin).

A green here means the VERDICT ALGEBRA is right. It never substitutes for C2's
live read of /proc/<pid>/environ inside a running worker
(12-test-strategy.md: the attempt boundary is only proven by a real attempt).

usage: python3 e2e/m4/test_c2_logic.py [-v]
"""
import hashlib
import os
import sys
import unittest
from unittest.mock import patch

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


class HoldWiringTest(unittest.TestCase):
    """C2 posts the AGENT variant (C2a is a read DURING an AUTHORIZED attempt;
    authorization is keyed on the agent profile per ADR-0018 D3, and a twin
    process.exec holds none — live14/C2.out GAPped "no attempt was authorized to
    hold DATABASE_URL" with hold_seconds proven working), and aims its live wait
    at the post-gate implement node."""

    def driver_body(self):
        import ast
        src = open(os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                "e2e_m4_exit.py"), encoding="utf-8").read()
        tree = ast.parse(src)
        node = next(n for n in tree.body
                    if isinstance(n, ast.FunctionDef) and n.name == "c2")
        return ast.get_source_segment(src, node)

    def test_c2_posts_the_agent_variant_the_allowlist_can_authorize(self):
        body = self.driver_body()
        self.assertIn('mvariant(facts, "agent")', body,
                      "c2() must post the agent revision: its /implement is agent.acp "
                      "under profile m4-implementer, the only attempt ADR-0018 D3's "
                      "profile-keyed allowlist can ever authorize (internal/secrets/"
                      "resolver.go denies AgentProfileID == \"\"; internal/worker/"
                      "procexec.go never asks for a mount for a profile-less attempt — "
                      "live14/C2.out: no materialization row lands for a twin attempt "
                      "no matter what is posted)")
        self.assertIn("post_c1_run(alice, ag,", body)
        self.assertNotIn("hold_seconds=C2_", body,
                         "the agent variant declares no hold_seconds — the model's own "
                         "turn is the hold (C1's agent leg and C4e post it the same way)")
        self.assertNotIn("require_fault_hold(", body,
                         "that precondition belongs to legs that POST hold_seconds on "
                         "the twin, not to C2's agent arm")
        self.assertEqual(m.C2_RUN_CAP_S, 1800,
                         "§ 7.1 C1c: the agent leg polls to terminal with a 30 min cap")
        self.assertGreaterEqual(m.C2_LIVE_WINDOW_S, 900,
                                "a real /plan turn and the gate precede the live "
                                "/implement attempt")

    def test_c2_aims_the_live_wait_at_the_held_post_gate_implement(self):
        body = self.driver_body()
        self.assertIn("wait_live_past_gate(", body,
                      "c2() uses the shared gate-then-live helper C4/C5/C6 use")
        self.assertIn("target=C2_LIVE_TARGET_KEY", body,
                      "an unaimed wait reads the environment of the held /plan BEFORE "
                      "the gate instead of the implement attempt (live8/C6.out)")
        self.assertEqual(m.C2_LIVE_TARGET_KEY, m.C_LIVE_TARGET_KEY,
                         "one post-gate held node, named once in the driver")
        self.assertTrue(any(m.C2_LIVE_TARGET_KEY.endswith(k)
                            for k in m.C2_IMPLEMENT_KEYS), "a held implement spelling")
        self.assertNotIn("c2_live_attempt(", body,
                         "the bare implement poll is gone: it verdicted on whatever "
                         "was live, gate or no gate")

    def test_claim_row_maps_onto_the_shape_c2_reads(self):
        row = {"id": "a-1", "key": "/build_until_verified[1]/implement",
               "worker": "worker-a", "token": "9", "attempt_number": "1", "turn": "-"}
        got = m.c2_live_from_claim(row)
        self.assertEqual((got["id"], got["key"], got["worker"], got["n"]),
                         ("a-1", "/build_until_verified[1]/implement", "worker-a", "1"))
        self.assertTrue(all(m.c2_attempt_is_live(s) for s in got["status"].split("/")),
                        "the catch-time read selects only leased/running, so the mapped "
                        "status says a worker holds it either way")
        self.assertIsNone(m.c2_live_from_claim(None))

    def test_only_leased_and_running_mean_a_worker_holds_the_attempt(self):
        for st in ("leased", "running", " LEASED "):
            self.assertTrue(m.c2_attempt_is_live(st), st)
        for st in ("succeeded", "failed", "queued", "interrupted", "", None):
            self.assertFalse(m.c2_attempt_is_live(st), st)

    def test_attempt_state_reads_the_one_row_and_never_invents_a_status(self):
        seen = []

        def fake_psql(sql):
            seen.append(sql)
            return "leased"
        with patch.object(m, "psql", fake_psql):
            self.assertEqual(m.c2_attempt_state("a-1"), "leased")
        self.assertIn("WHERE id = 'a-1'", seen[0])
        self.assertNotIn("run_id", seen[0], "the read is aimed at ONE attempt")
        with patch.object(m, "psql", lambda sql: (_ for _ in ()).throw(RuntimeError("down"))):
            self.assertEqual(m.c2_attempt_state("a-1"), "",
                             "an unreadable ledger is neither live nor closed")

    def test_a_held_attempt_proves_the_hold_and_a_printf_does_not(self):
        v = m.c2_hold_proof_verdicts(45, 46, "honours")
        self.assertTrue(v[0][1], v)
        self.assertFalse(m.c2_hold_proof_verdicts(45, 0, "honours")[0][1])
        self.assertIn("LAB FAULT", m.c2_hold_proof_verdicts(45, 0, "honours")[0][2])
        self.assertIn("M4_HOLD_SECONDS",
                      m.c2_hold_proof_verdicts(45, 0, "honours")[0][2])

    def test_a_stale_fixture_or_a_missing_read_never_passes_the_hold(self):
        self.assertFalse(m.c2_hold_proof_verdicts(45, 46, "stale")[0][1],
                         "the mounted script sleeps for nothing: no hold is real")
        self.assertIn("make_fixture_repo.sh", m.c2_hold_proof_verdicts(45, 46, "stale")[0][2])
        self.assertIsNone(m.c2_hold_proof_verdicts(45, None, "unreadable")[0][1],
                          "an unreadable ledger GAPs, it never passes by inference")
        self.assertIsNone(m.c2_hold_proof_verdicts(0, 30, "honours")[0][1],
                          "a twin leg that posted no hold has no window to prove")

    def test_the_agent_arm_grades_the_model_turn_as_the_hold(self):
        """C2's authorized variant posts NO hold_seconds (the agent revision declares
        none): the verdict grades the observed held stretch, and the mounted twin
        fixture — which the agent arm never runs for plan/implement — is irrelevant."""
        v = m.c2_hold_proof_verdicts(0, 120, "stale", agent=True)
        self.assertTrue(v[0][1], v)
        self.assertIn("model's turn is the hold", v[0][0])
        self.assertFalse(m.c2_hold_proof_verdicts(0, 1, "honours", agent=True)[0][1],
                         "a turn that closed inside the floor was not a window")
        self.assertIsNone(m.c2_hold_proof_verdicts(0, None, "unreadable", agent=True)[0][1],
                          "an unreadable ledger GAPs the agent window too")

    def test_held_shorter_than_posted_is_still_a_window_worth_reading(self):
        """The floor is the leg's own (<1s printf vs a real hold), not the full 45s —"""
        v = m.c2_hold_proof_verdicts(45, 8, "honours")
        self.assertTrue(v[0][1], v)
        self.assertIn("shorter than the 45s", v[0][2],
                      "but hold_diagnosis still says the window came up short")

    def test_nothing_ever_held_gaps_unless_the_run_died_first(self):
        kind, label, detail = m.c2_no_live_attempt_verdict("completed", "hold honoured? no")
        self.assertEqual((kind, label), ("gap", "C2a a live implement attempt to read"))
        self.assertIn(m.C2_LIVE_TARGET_KEY, detail)
        self.assertIn("hold honoured? no", detail)
        for st in ("failed", "cancelled", "interrupted"):
            self.assertEqual(m.c2_no_live_attempt_verdict(st)[0], "check",
                             f"{st} is the product's own failure, not an unmeasurable state")
        self.assertEqual(m.c2_no_live_attempt_verdict("running")[0], "gap")


class EvidenceRedactionTest(unittest.TestCase):
    """C2's own rule: the sentinel's VALUE never enters the report — presence and
    digests only — including on the failure path that has every reason to print it."""

    def test_a_mirror_hit_names_the_ref_and_redacts_the_matching_text(self):
        out = f"refs/heads/master:hello.py:{m.C2_ENV_NAME}={m.SENTINEL}\nrc=0"
        with patch.object(m, "run", lambda cmd, **kw: (0, out)):
            n, listing = m.c2_git_mirror_grep("worker-a", "/repos/p/app.git")
        self.assertEqual(n, 1)
        self.assertNotIn(m.SENTINEL, listing, "the leaked line IS the secret")
        self.assertIn("REDACTED", listing)
        self.assertIn("refs/heads/master", listing)

    def test_a_clean_mirror_and_the_scan_script_carry_no_value(self):
        with patch.object(m, "run", lambda cmd, **kw: (0, "rc=1")):
            self.assertEqual(m.c2_git_mirror_grep("worker-a", "/repos/p/app.git")[0], 0)
        self.assertNotIn(m.SENTINEL, m.c2_proc_scan_sh())
        self.assertNotIn(m.SENTINEL, m.c2_place_inventory_sql())
        v = m.c2_live_home_verdicts([{"pid": "4", "sha": "a" * 64, "cmd": "m4-exit.sh"}],
                                    "b" * 64)
        self.assertNotIn(m.SENTINEL, " ".join(d for _, _, d in v))


if __name__ == "__main__":
    unittest.main(verbosity=2 if "-v" in sys.argv else 1)
