#!/usr/bin/env python3
"""test_regrade_logic.py - offline proof that the FINAL SUMMARY reflects the
deferred regrades (the 1c190fe acceptance-run bug this task fixes).

Shape of the failure: rows that cite another gate's verdict (C3d cites C4's
fence; the four C11c structural rows cite C8b/C14a/C12a/C12b/C13b/C13c/C1f/
C2c) print GAP in place when the witness has not run yet, promising "regraded
at exit". In ~/.cache/pi-orch/communication/accept/20261029-100606-1c190fe/
m4.out the regrade DID run — its "=== deferred regrades" section shows all
five rows rolling up to PASS — but it ran via atexit AFTER finish() had
already printed "=== summary" from the stale GAPS list, so the summary still
carried the five GAP lines and counted them in GAP=33.

These tests replay that run's recorded verdict lines (same legs, same line
counts as m4.out) through the driver's own printers, call finish(), and
assert the summary: PASS only when every cited verdict PASSed, FAIL when any
cited one FAILed, GAP only where a cited gate truly never printed.

usage: uvx --offline pytest e2e/m4/test_regrade_logic.py -q
"""
import json
import os
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import e2e_m4_exit as m  # noqa: E402 — importing the driver is the point


GOOD = " ".join((m.C3_NEGATIVE_CONTROL or "").split())


def passes(label, n):
    """n PASS lines for leg LABEL, like a gate printing its verdict lines."""
    for i in range(n):
        m.check(f"{label} line {i + 1}", True, "recorded verdict line")


class _LedgerSandbox(unittest.TestCase):
    """Run the driver's own printers/finish() with the module pools sandboxed."""
    POOLS = ("VERDICTS", "DEFERRED", "FAILURES", "GAPS", "SKIPPED")

    def setUp(self):
        m._atexit_ok = False
        self.saved = {name: list(getattr(m, name)) for name in self.POOLS}
        for pool in self.saved.values():
            pool.clear()
        self.saved_extra = (list(m.C11C_INPLACE), m.printed_by_c3d[0],
                            m.EVIDENCE.get("C3d"))
        m.C11C_INPLACE.clear()
        m.printed_by_c3d[0] = ""
        m.EVIDENCE.pop("C3d", None)

    def tearDown(self):
        for name in self.POOLS:
            getattr(m, name)[:] = self.saved[name]
        inplace, printed_c3d, ev = self.saved_extra
        m.C11C_INPLACE[:] = inplace
        m.printed_by_c3d[0] = printed_c3d
        if ev is None:
            m.EVIDENCE.pop("C3d", None)
        else:
            m.EVIDENCE["C3d"] = ev

    # --- the two legs exactly as the driver runs them -----------------------

    def c3_leg(self):
        """C3 as in m4.out: the C3d rows print, the C4-citing one GAPs, the
        regrade is deferred (C4 runs after C3 in GATES)."""
        m.printed_by_c3d[0] = m.C3D_HEAD + " " + GOOD
        m.EVIDENCE["C3d"] = GOOD
        m.c3_emit3(m.c3d_verdicts(m.printed_by_c3d[0], GOOD,
                                  m.rollup("C4"), len(m.ledger_gate("C4"))))
        m.defer_regrade("C3d", m.c3d_cite_c4)

    def c11_leg(self):
        """C11 as in m4.out: the four structural rows whose later witnesses
        (C12/C13/C14) have not printed yet GAP in place, then defer."""
        m.C11C_INPLACE[:] = m.c11c_structural_verdicts()
        m.c11_emit(m.C11C_INPLACE)
        m.defer_regrade("C11c", m.c11c_regrade)

    def pre_c11_witnesses(self):
        """Witnesses that DID print before C11 in that run: C8B=PASS×5,
        C1F=PASS×12, C2C=PASS×6, C10A/C10B/C7C/C2D PASS."""
        passes("C8b", 5)
        passes("C1f", 12)
        passes("C2c", 6)
        passes("C10a", 4)
        passes("C10b", 2)
        passes("C7c", 3)
        passes("C2d", 3)

    def post_gates(self):
        """The later gates as they printed in m4.out: C4's 21 lines (19 PASS,
        2 GAP), C14A×14, C12A×4, C12B×4, C13B×7, C13C×4 — all PASS."""
        for i in range(19):
            m.check(f"C4c line {i + 1}", True, "recorded verdict line")
        m.gap("C4c finished_at IS NULL (§ 7.1's literal expectation)",
              "the schema forbids the NULL the contract line expects")
        m.gap("C4e the fenced turn had a transcript to keep quiet",
              "max(global_seq) before the unpause='0'")
        passes("C14a", 14)
        passes("C12a", 4)
        passes("C12b", 4)
        passes("C13b", 7)
        passes("C13c", 4)

    def finish(self):
        rc, printed = m.printed_by(m.finish)
        return rc, printed

    def gap_lines(self, printed):
        return [ln for ln in printed.splitlines() if ln.startswith("  GAP     ")]


class FullAcceptanceRegrade(_LedgerSandbox):
    """The 1c190fe replay: every cited gate printed PASS, so the summary must
    carry the regraded PASSes — not the five stale GAPs."""

    def run_replayed(self):
        m.gap("W11 the attempt list shows attempt 1 interrupted",
              "this leg performs no kill")          # the run's own unrelated GAP
        self.c3_leg()
        self.pre_c11_witnesses()
        self.c11_leg()
        self.post_gates()
        return self.finish()

    def test_regrades_run_before_the_summary_is_built(self):
        _rc, printed = self.run_replayed()
        self.assertLess(printed.index("deferred regrades"),
                        printed.index("=== summary"),
                        "the regrade must fold in before the summary is built")

    def test_every_cited_row_regrades_to_pass(self):
        _rc, printed = self.run_replayed()
        promoted = [ln for ln in printed.splitlines() if "[regraded" in ln]
        self.assertEqual(len(promoted), 5, promoted)
        self.assertTrue(all(ln.startswith("  PASS  ") for ln in promoted), promoted)
        joined = "\n".join(promoted)
        self.assertIn("C3d the proof it points at is measured in this process "
                      "(C4's fence) [regraded after C4]", joined)
        self.assertIn("C4's 21 verdict lines here roll up to PASS", joined)
        for claim in ("C11c outputs are project-scoped data", "C11c outputs are size-capped",
                      "C11c outputs are redaction-scanned",
                      "C11c an expression over injected output cannot escape "
                      "ADR-0022's allowlist"):
            self.assertIn(f"{claim} [regraded once its witnesses printed]", joined)
        self.assertIn("C14A=PASS over 14 verdict line(s)", joined)
        self.assertIn("C13C=PASS over 4 verdict line(s)", joined)
        self.assertIn("C12B=PASS over 4 verdict line(s)", joined)

    def test_stale_gap_lines_are_gone_from_the_summary(self):
        _rc, printed = self.run_replayed()
        gaps = self.gap_lines(printed)
        for ln in gaps:
            self.assertNotIn("C3d the proof it points at", ln)
            self.assertNotIn("C11c", ln)
            self.assertNotIn("NOT PRINTED", ln)
            self.assertNotIn("regraded at exit once C4 prints", ln)
        self.assertEqual(len(gaps), 3, gaps)   # C4c + C4e + W11 only
        self.assertIn("W11 the attempt list shows attempt 1 interrupted", "\n".join(gaps))

    def test_the_tally_counts_the_regraded_verdicts(self):
        rc, printed = self.run_replayed()
        tally = [ln for ln in printed.splitlines() if "FAIL=" in ln]
        self.assertEqual(len(tally), 1, tally)
        self.assertIn("FAIL=0", tally[0])
        self.assertIn("GAP=3", tally[0])       # NOT the stale 8 (3 + the five ghosts)
        self.assertEqual(rc, 0)


class RegradeFailsOnAFailedWitness(_LedgerSandbox):
    """A cited verdict that FAILed must make the row's summary line a FAIL,
    replacing (not stacking on) its in-place GAP."""

    def test_fail_promotes_to_a_counted_fail(self):
        self.c3_leg()
        self.pre_c11_witnesses()
        self.c11_leg()
        self.post_gates()
        m.check("C14a no cross-project event reaches this stream", False,
                "1 foreign frame")             # C14a's own line FAILs
        rc, printed = self.finish()
        self.assertIn("  FAIL  C11c outputs are project-scoped data [regraded once "
                      "its witnesses printed]", printed)
        self.assertIn("its own witness says it does not hold", printed)
        self.assertIn("C14A=FAIL", printed)
        for ln in self.gap_lines(printed):
            self.assertNotIn("project-scoped", ln)     # GAP replaced, not stacked
        self.assertIn("C11c outputs are project-scoped data [regraded once its "
                      "witnesses printed]", m.FAILURES)
        self.assertEqual(rc, 1)


class RegradeKeepsTrulyUnmeasuredRowsGap(_LedgerSandbox):
    """GAP stays only when a cited gate truly never printed (or only GAPped)."""

    def test_witnesses_that_never_printed_keep_their_gap(self):
        self.c3_leg()
        self.pre_c11_witnesses()
        self.c11_leg()
        # C4/C12/C13/C14 never run — a --only C1..C11 style pass.
        rc, printed = self.finish()
        self.assertNotIn("[regraded", printed)
        gaps = "\n".join(self.gap_lines(printed))
        self.assertIn("C3d the proof it points at is measured in this process", gaps)
        for phrase in ("project-scoped data", "size-capped", "redaction-scanned",
                       "cannot escape ADR-0022's allowlist"):
            self.assertIn(phrase, gaps)
        self.assertIn("GAP=5", printed)
        self.assertEqual(rc, 0)

    def test_a_witness_that_only_gapped_is_still_unmeasured_not_passing(self):
        self.c3_leg()
        self.pre_c11_witnesses()
        self.c11_leg()
        m.gap("C4c the fenced attempt is interrupted", "no lease to freeze")
        m.gap("C4c the stale owner's refusal is observed in its own log", "log unreadable")
        rc, printed = self.finish()
        self.assertNotIn("[regraded", printed)
        self.assertIn("C3d the proof it points at", "\n".join(self.gap_lines(printed)))
        self.assertEqual(rc, 0)


class RegradeRunsOnce(_LedgerSandbox):
    """finish() drains DEFERRED; the atexit fallback must then print nothing,
    so a row can never be regraded or superseded twice."""

    def test_second_drain_prints_nothing(self):
        self.c3_leg()
        self.pre_c11_witnesses()
        self.c11_leg()
        self.post_gates()
        _rc, first = self.finish()
        self.assertEqual(first.count("[regraded"), 5)
        _rc2, second = m.printed_by(m.run_deferred_regrades)
        self.assertNotIn("[regraded", second)
        self.assertNotIn("deferred regrades", second)
        self.assertEqual(len(m.GAPS), 2)      # C4c + C4e only, unchanged by the drain


class SupersedeGapUnit(_LedgerSandbox):
    def test_only_the_exact_row_is_dropped(self):
        m.gap("C3d the proof it points at is measured", "why one")
        m.gap("C3d the proof it points at is measured twice", "why two")
        m.gap("C3d the recorded sentence carries elements", "why three")
        removed = m.supersede_gap("C3d the proof it points at is measured")
        self.assertEqual(removed, 1)
        self.assertEqual(len(m.GAPS), 2)
        self.assertTrue(any("twice" in g for g in m.GAPS))
        self.assertTrue(any("recorded sentence" in g for g in m.GAPS))

    def test_superseding_an_absent_row_is_a_noop(self):
        self.assertEqual(m.supersede_gap("C11c outputs are size-capped"), 0)
        self.assertEqual(m.GAPS, [])


# ===========================================================================
# The CROSS-SHARD witness and its merged regrade (acceptance.yml's m4 matrix)
# ===========================================================================
# Shape of the failure this section proves closed (acceptance run 41983100425,
# d82abbe): the § 7 gates run as SIX driver processes on SIX fresh stacks, so a
# row graded off ANOTHER gate's witness read "NOT PRINTED" in the process that
# owned the row — and filed a GAP that still let the shard job pass:
#
#   m4-core-b.out   GAP C11c outputs are project-scoped data — nothing measured
#                   this claim in this driver process — C8B=NOT PRINTED;
#                   C14A=NOT PRINTED          (C8 runs in fanout, C14 in core-b)
#   m4-core-b.out   GAP C11c outputs are redaction-scanned — … C1F/C2C/C13C …
#   m4-fence.out    GAP C5g the retried run's node_instance_key set is C1's twin
#                   set … no C1 key set in this pass (CTX['c1'] empty)
#   m4-restore.out  GAP C6c the key set equals C1's … c1_keys=0 c6_keys=17
#
# The fix has three halves, each proven below: (1) every shard writes a witness
# file (its verdict lines + the node_instance_key sets later gates compare
# against); (2) a row whose witness runs in another shard prints PENDING, not
# GAP, and is recorded in that witness file; (3) the stackless `--regrade` pass
# merges every shard's witness and owes each promised row a real verdict — a
# witness no shard measured FAILs, naming the leg and the shard that owned it.
#
# The recorded line counts below are the ones the real run printed (C8b=5,
# C14a=14, C12a/C12b=4, C13b=7, C13c=4, C1f=8, C2c=6, C2d=3, C10a=5, C10b=11,
# C7c=1, C4=15) and the key sets are the driver's OWN expected_node_keys table,
# so the fixtures are shaped like the real output, not like a convenience.

TWIN_KEYS = sorted(m.expected_node_keys(2).keys())        # C1's twin: 2 iterations
RETRY_KEYS = sorted(m.expected_node_keys(1).keys())       # C5/C6 retry: 1 iteration

ALL_SHARDS = ("fence", "restore", "watch", "fanout", "core-a", "core-b")


def lines(leg, n, verdict="PASS"):
    """n recorded verdict lines for LEG, as a shard's witness file carries them."""
    return [{"leg": m._leg_of(f"{leg} line {i + 1}"), "verdict": verdict,
             "label": f"{leg} line {i + 1}", "detail": ""} for i in range(n)]


def pending_line(label):
    return [{"leg": m._leg_of(label), "verdict": "PENDING", "label": label,
             "detail": "another shard holds the witness"}]


def shard(shard_name, gates, verdicts=None, witnesses=None):
    """One shard's witness document, shaped like write_witness() emits it."""
    return {"version": m.WITNESS_VERSION, "shard": shard_name, "gates": sorted(gates),
            "verdicts": list(verdicts or []), "witnesses": dict(witnesses or {})}


def recorded_run(pend_c11c=True):
    """The six shards of run 41983100425 as witness files: core-a owns C1's twin key
    set, fence/restore their own retried key sets, and core-b left its cross-shard
    C11c arms PENDING."""
    core_a = shard("core-a", ["C1", "C2", "C7", "C9", "C10", "W1", "W3", "W7"],
                   lines("C1f", 8) + lines("C2c", 6) + lines("C2d", 3) +
                   lines("C10a", 5) + lines("C10b", 11) + lines("C7c", 1),
                   {"c1_twin_keys": TWIN_KEYS, "c1_agent_keys": TWIN_KEYS})
    fanout = shard("fanout", ["C8"], lines("C8b", 5))
    core_b = shard("core-b", ["C11", "C12", "C13", "C14", "W4", "W8", "W9", "W10"],
                   lines("C12a", 4) + lines("C12b", 4) + lines("C13b", 7) +
                   lines("C13c", 4) + lines("C14a", 14) +
                   (pending_line("C11c outputs are project-scoped data") +
                    pending_line("C11c outputs are schema-validated") +
                    pending_line("C11c outputs are redaction-scanned") +
                    pending_line("C11c the reviewer's permission mode is its own "
                                 "profile (04)") if pend_c11c else []))
    fence = shard("fence", ["C3", "C4", "C5", "W2"],
                  lines("C4c", 15) + pending_line(m.C5G_KEYSET_CLAIM),
                  {"c5_run_keys": RETRY_KEYS})
    restore = shard("restore", ["C6"],
                    lines("C6b", 4) + pending_line(m.C6C_KEYSET_CLAIM),
                    {"c6_run_keys": RETRY_KEYS})
    watch = shard("watch", ["W5", "W6", "W11"], lines("W5a", 3))
    return [core_a, fanout, core_b, fence, restore, watch]


class _CrossShardSandbox(_LedgerSandbox):
    """The shard/regrade pools AND the module's contract flags are sandboxed: a
    test that leaves --expect-regrade on would silently convert every later
    test's GAPs into PENDING lines."""

    def setUp(self):
        super().setUp()
        self.saved_pending = list(m.PENDING_ROWS)
        self.saved_witness = dict(m.SHARD_WITNESS)
        self.saved_ctx = dict(m.CTX)
        self.saved_flags = (m.WITNESS_PATH[0], m.SHARD_NAME[0], m.REGRADE_CONTRACT[0])
        m.PENDING_ROWS.clear()
        m.SHARD_WITNESS.clear()
        m.CTX.clear()
        m.WITNESS_PATH[0] = ""
        m.SHARD_NAME[0] = ""
        m.REGRADE_CONTRACT[0] = False
        self.tmp = tempfile.mkdtemp(prefix="m4witness-")

    def tearDown(self):
        m.PENDING_ROWS[:] = self.saved_pending
        m.SHARD_WITNESS.clear()
        m.SHARD_WITNESS.update(self.saved_witness)
        m.CTX.clear()
        m.CTX.update(self.saved_ctx)
        m.WITNESS_PATH[0], m.SHARD_NAME[0], m.REGRADE_CONTRACT[0] = self.saved_flags
        super().tearDown()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def reset_pools(self):
        for pool in ("VERDICTS", "DEFERRED", "FAILURES", "GAPS", "SKIPPED"):
            getattr(m, pool).clear()
        m.PENDING_ROWS.clear()

    def write(self, doc, name=None):
        path = os.path.join(self.tmp, (name or doc["shard"]) + ".json")
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(doc, fh)
        return path

    def regrade(self, docs, expect=ALL_SHARDS):
        self.reset_pools()
        paths = [self.write(d) for d in docs]
        rc, printed = m.printed_by(lambda: m.run_regrade(paths, list(expect)))
        return rc, printed


class WitnessFileRoundTrip(_CrossShardSandbox):
    """write_witness: the shard's ledger and CTX half-shapes in one JSON file."""

    def test_the_ledger_and_key_sets_are_written(self):
        m.CTX["gate_selection"] = {"C1", "C2"}
        m.SHARD_NAME[0] = "core-a"
        m.CTX["c1"] = {"twin": {"keys": set(TWIN_KEYS)}, "agent": None}
        m.witness_shard("c5_run_keys", {"/plan", "/verdict"})
        m.check("C1d twin: full node_instance_key set", True, "17 keys")
        path = os.path.join(self.tmp, "m4-witness.json")
        self.assertTrue(m.write_witness(path))
        with open(path, encoding="utf-8") as fh:
            doc = json.load(fh)
        self.assertEqual(doc["version"], m.WITNESS_VERSION)
        self.assertEqual(doc["shard"], "core-a")
        self.assertEqual(doc["gates"], ["C1", "C2"])
        self.assertEqual([v["label"] for v in doc["verdicts"]],
                         ["C1d twin: full node_instance_key set"])
        self.assertEqual(doc["verdicts"][0]["leg"], "C1D")
        self.assertEqual(doc["verdicts"][0]["verdict"], "PASS")
        self.assertEqual(sorted(doc["witnesses"]), ["c1_twin_keys", "c5_run_keys"])
        self.assertEqual(doc["witnesses"]["c1_twin_keys"], TWIN_KEYS)

    def test_a_shard_without_c1_writes_no_key_set_rather_than_an_empty_one(self):
        m.SHARD_NAME[0] = "fence"
        path = os.path.join(self.tmp, "fence.json")
        m.write_witness(path)
        with open(path, encoding="utf-8") as fh:
            doc = json.load(fh)
        self.assertNotIn("c1_twin_keys", doc["witnesses"],
                         "an absent witness must not arrive as an empty list")

    def test_an_unwritable_witness_is_a_fail_not_a_silent_gap(self):
        # The regrade job can only grade what the shard wrote: no file, no verdict.
        self.assertFalse(m.write_witness(os.path.join(self.tmp, "no-such-dir",
                                                      "m4-witness.json")))
        self.assertTrue(any("witness file written" in f for f in m.FAILURES), m.FAILURES)

    def test_load_witness_names_a_foreign_file(self):
        bad = os.path.join(self.tmp, "foreign.json")
        with open(bad, "w", encoding="utf-8") as fh:
            fh.write('{"version": 99, "shard": "core-a"}')
        doc, why = m.load_witness(bad)
        self.assertIsNone(doc)
        self.assertIn("foreign.json", why)
        missing, why2 = m.load_witness(os.path.join(self.tmp, "gone.json"))
        self.assertIsNone(missing)
        self.assertIn("gone.json", why2)


class PendingIsNotAGap(_CrossShardSandbox):
    """A cross-gate row whose witness runs in another shard's stack prints PENDING
    (and is booked in PENDING_ROWS, not GAPS) — but ONLY while the regrade job is
    contracted to run; a lone shard keeps the honest GAP."""

    def core_b_c11_leg(self, witnesses=True):
        """C11 as the CORE-B shard runs it: C12/C13/C14 print here (later in GATES),
        C8/C10/C7/C1/C2 print in another shard's process."""
        m.CTX["gate_selection"] = {"C11", "C12", "C13", "C14", "W4", "W8", "W9", "W10"}
        m.REGRADE_CONTRACT[0] = True
        m.SHARD_NAME[0] = "core-b"
        m.C11C_INPLACE[:] = m.c11c_structural_verdicts()
        m.c11_emit(m.C11C_INPLACE)
        if witnesses:
            for leg, n in (("C12a", 4), ("C12b", 4), ("C13b", 7), ("C13c", 4),
                           ("C14a", 14)):
                passes(leg, n)
            m.defer_regrade("C11c", m.c11c_regrade)

    def test_cross_shard_arms_print_pending_not_gap(self):
        """The four arms with a witness in another shard are PENDING; the two whose
        witnesses run LATER IN THIS SHARD stay GAPs the exit-time regrade owns."""
        self.core_b_c11_leg(witnesses=False)
        self.assertEqual(len(m.PENDING_ROWS), 4, m.PENDING_ROWS)
        for phrase in ("project-scoped data", "schema-validated", "redaction-scanned",
                       "its own profile"):
            self.assertTrue(any(phrase in p for p in m.PENDING_ROWS), phrase)
        self.assertEqual(len(m.GAPS), 2, m.GAPS)
        self.assertTrue(all("size-capped" in g or "allowlist" in g for g in m.GAPS),
                        m.GAPS)
        self.assertEqual([v["verdict"] for v in m.VERDICTS
                          if v["label"].startswith("C11c")].count("PENDING"), 4)

    def test_a_witness_in_another_shard_is_pending_on_the_printed_line(self):
        m.CTX["gate_selection"] = {"C11", "C12", "C13", "C14"}
        m.REGRADE_CONTRACT[0] = True
        _rc, printed = m.printed_by(lambda: m.gap(m.C5G_KEYSET_CLAIM, "no C1 key here"))
        self.assertIn("  PENDING " + m.C5G_KEYSET_CLAIM +
                      " (regraded by m4 (regrade)) — no C1 key here", printed)
        self.assertIn("C1 run in ANOTHER shard's stack", printed)
        self.assertIn("STRUCTURE", printed,
                      "the row must say what a cross-stack comparison may claim")


    def test_arms_whose_witnesses_run_here_still_regrade_in_process(self):
        """C12/C13/C14 print in core-b: those two arms must NOT stay pending — the
        exit-time regrade still owes them a real verdict, and takes them out of the
        PENDING pool when it prints it."""
        self.core_b_c11_leg(witnesses=False)
        for leg, n in (("C12a", 4), ("C12b", 4), ("C13b", 7)):
            passes(leg, n)
        m.printed_by(m.c11c_regrade)
        promoted = [(v["label"], v["verdict"]) for v in m.VERDICTS
                    if "regraded" in v["label"]]
        self.assertEqual([v for _l, v in promoted], ["PASS", "PASS"], promoted)
        self.assertTrue(any("size-capped" in l for l, _v in promoted), promoted)
        self.assertTrue(any("allowlist" in l for l, _v in promoted), promoted)
        self.assertEqual([p for p in m.PENDING_ROWS
                          if p.startswith("C11c outputs are size-capped")
                          or p.startswith("C11c an expression over injected")], [],
                         "a promoted row leaves the PENDING pool, not just the GAP one")
        self.assertEqual(len(m.PENDING_ROWS), 4, m.PENDING_ROWS)

    def test_keyset_rows_go_pending_when_c1_runs_elsewhere(self):
        m.CTX["gate_selection"] = {"C3", "C4", "C5", "W2"}
        m.REGRADE_CONTRACT[0] = True
        m.c5_emit(m.c5_final_verdicts("completed", set(), set(m.expected_node_keys(1))))
        self.assertEqual(m.GAPS, [], m.GAPS)
        self.assertEqual(len(m.PENDING_ROWS), 1, m.PENDING_ROWS)
        self.assertIn(m.C5G_KEYSET_CLAIM, m.PENDING_ROWS[0])
        self.assertEqual(m.SHARD_WITNESS["c5_run_keys"], RETRY_KEYS,
                         "the shard must publish the key set it measured")

    def test_restore_shard_publishes_its_key_set_and_pends_the_row(self):
        m.CTX["gate_selection"] = {"C6"}
        m.REGRADE_CONTRACT[0] = True
        m.c5_emit(m.c6_final_verdicts("completed", {"policies": None}, set(),
                                      set(m.expected_node_keys(1)), manual_graded=True))
        self.assertEqual(m.SHARD_WITNESS["c6_run_keys"], RETRY_KEYS)
        self.assertEqual(len(m.PENDING_ROWS), 1, m.PENDING_ROWS)

    def test_no_contract_means_the_old_honest_gap(self):
        """A lone `jobs=m4:core-b` dispatch has no regrade job: the row must stay a
        GAP, because nothing downstream would ever grade it."""
        m.CTX["gate_selection"] = {"C11", "C12", "C13", "C14"}
        m.C11C_INPLACE[:] = m.c11c_structural_verdicts()
        m.c11_emit(m.C11C_INPLACE)
        self.assertEqual(m.PENDING_ROWS, [])
        self.assertTrue(m.GAPS, "expected GAPs with no regrade contracted")

    def test_a_full_single_process_run_keeps_the_in_process_gap(self):
        """No --only, every gate in reach: the exit-time regrade owns these rows, so
        nothing may be blamed on 'another shard'."""
        m.REGRADE_CONTRACT[0] = True
        m.C11C_INPLACE[:] = m.c11c_structural_verdicts()
        m.c11_emit(m.C11C_INPLACE)
        self.assertEqual(m.PENDING_ROWS, [])
        self.assertEqual(len(m.GAPS), 6, m.GAPS)

    def test_summary_counts_pending_and_the_shard_still_exits_clean(self):
        self.core_b_c11_leg()                 # incl. this shard's own witnesses
        rc, printed = m.printed_by(m.finish)
        self.assertEqual(rc, 0, "PENDING is the regrade job's duty, not this job's FAIL")
        self.assertIn("GAP=0", printed,
                      "the in-shard witnesses promoted, nothing left as a GAP")
        self.assertIn("PENDING=4", printed)
        self.assertIn("PENDING C11c outputs are project-scoped data", printed)
        self.assertIn("m4 (regrade)` job grades them", printed,
                      "the summary must say who owes those rows a verdict")
        self.assertNotIn("NOT PRINTED  ", printed)

    def test_supersede_clears_a_pending_row_a_regrade_resolved(self):
        m.gap("C11c outputs are size-capped", "witness not printed")  # GAP pool path
        m.pending("C11c outputs are project-scoped data", "another shard holds C8b")
        self.assertEqual(len(m.PENDING_ROWS), 1)
        m.supersede_gap("C11c outputs are project-scoped data")
        self.assertEqual(m.PENDING_ROWS, [])


class MergedRegrade(_CrossShardSandbox):
    """`--regrade <witness files…>`: the cross-gate rows, graded over the union."""

    def test_all_witnesses_present_every_cross_gate_row_passes(self):
        rc, printed = self.regrade(recorded_run())
        self.assertEqual(rc, 0, [f for f in m.FAILURES])
        graded = [ln for ln in printed.splitlines()
                  if ln.startswith("  PASS  ") and "[regraded" in ln]
        self.assertEqual(len(graded), 11, graded)     # 6 arms + 2x2 keyset rows + C3d
        for phrase in ("C8B=PASS over 5 verdict line(s)", "C14A=PASS over 14",
                       "C2C=PASS over 6", "C2D=PASS over 3", "C1F=PASS over 8",
                       "C10B=PASS over 11", "C7C=PASS over 1"):
            self.assertIn(phrase, printed, phrase)
        self.assertIn("FAIL=0  GAP=0  PENDING=0", printed)

    def test_a_missing_witness_fails_naming_the_leg_and_its_shard(self):
        docs = recorded_run()
        docs[0]["verdicts"] = [v for v in docs[0]["verdicts"]
                               if not v["label"].startswith("C2c")]
        rc, printed = self.regrade(docs)
        self.assertEqual(rc, 1)
        row = next(ln for ln in printed.splitlines()
                   if ln.startswith("  FAIL  ") and "redaction-scanned" in ln)
        self.assertIn("C2C printed no verdict line anywhere", row)
        self.assertIn("core-a", row, "the row must say which shard owed the witness")
        self.assertNotIn("C2D printed no verdict line", row,
                         "only the witness that is truly absent is named")

    def test_a_witness_that_only_gapped_is_named_as_gapped_not_missing(self):
        docs = recorded_run()
        for v in docs[0]["verdicts"]:
            if v["label"].startswith("C2d"):
                v["verdict"] = "GAP"
        rc, printed = self.regrade(docs)
        self.assertEqual(rc, 1)
        row = next(ln for ln in printed.splitlines()
                   if ln.startswith("  FAIL  ") and "own profile" in ln)
        self.assertIn("every one of them GAPped", row)

    def test_a_failed_witness_fails_the_row_it_would_have_proved(self):
        docs = recorded_run()
        for v in docs[1]["verdicts"]:
            if v["label"].startswith("C8b"):
                v["verdict"] = "FAIL"
        rc, printed = self.regrade(docs)
        self.assertEqual(rc, 1)
        self.assertIn("does not hold", next(ln for ln in printed.splitlines()
                                            if "project-scoped" in ln))

    def test_a_shard_whose_witness_never_arrived_fails_naming_it(self):
        docs = recorded_run()
        rc, printed = self.regrade([d for d in docs if d["shard"] != "fanout"])
        self.assertEqual(rc, 1)
        row = next(ln for ln in printed.splitlines()
                   if ln.startswith("  FAIL  ") and "every shard left a witness" in ln)
        self.assertIn("fanout", row)

    def test_a_pending_row_no_rule_grades_is_a_fail(self):
        """A future cross-gate row that prints PENDING without registering a regrade
        rule must not ride through ungraded."""
        docs = recorded_run()
        docs[0]["verdicts"] += pending_line("C9z a row nobody regrades")
        rc, printed = self.regrade(docs)
        self.assertEqual(rc, 1)
        row = next(ln for ln in printed.splitlines()
                   if ln.startswith("  FAIL  ") and "left pending" in ln)
        self.assertIn("C9z a row nobody regrades", row)
        self.assertIn("core-a", row)

    def test_keyset_rows_compare_structure_across_fresh_stacks(self):
        """C1 looped twice, the retry once: the literal sets differ by the whole [2]
        iteration and the row still PASSes — the claim is the graph, and the row
        says which two stacks the sets came from."""
        rc, printed = self.regrade(recorded_run())
        self.assertEqual(rc, 0, m.FAILURES)
        rows = [ln for ln in printed.splitlines()
                if ln.startswith("  PASS  ") and "C5g" in ln]
        self.assertEqual(len(rows), 2, rows)
        self.assertIn("[regraded across stacks: fence vs core-a]", rows[0])
        self.assertIn("FRESH STACKS", rows[0])
        self.assertIn("c1_only=[] run_only=[]", rows[0])

    def test_a_renamed_or_removed_node_key_still_fails_across_stacks(self):
        for break_it in ("rename", "remove"):
            docs = recorded_run()
            for d in docs:
                if d["shard"] == "fence":
                    ks = list(d["witnesses"]["c5_run_keys"])
                    if break_it == "rename":
                        ks = [k.replace("/implement", "/impl") for k in ks]
                    else:
                        ks = [k for k in ks if not k.endswith("/review")]
                    d["witnesses"]["c5_run_keys"] = sorted(ks)
            rc, printed = self.regrade(docs)
            self.assertEqual(rc, 1, break_it)
            row = next(ln for ln in printed.splitlines()
                       if ln.startswith("  FAIL  ") and "C5g" in ln)
            self.assertIn("iteration-normalized", row)
            self.assertIn("c1_only=['/build" if break_it == "remove"
                          else "run_only=['/build", row,
                          "the diff must name the keys the two sets disagree on")

    def test_a_key_set_no_shard_recorded_fails_naming_the_side(self):
        docs = recorded_run()
        for d in docs:
            if d["shard"] == "core-a":
                d["witnesses"].pop("c1_twin_keys")
        rc, printed = self.regrade(docs)
        self.assertEqual(rc, 1)
        for row in (ln for ln in printed.splitlines()
                    if ln.startswith("  FAIL  ") and "key set" in ln):
            self.assertIn("no shard's witness carried C1's twin node_instance_key set",
                          row)

    def test_c3d_citation_is_regraded_over_the_merged_c4_lines(self):
        rc, printed = self.regrade(recorded_run())
        row = next(ln for ln in printed.splitlines()
                   if ln.startswith("  PASS  ") and "C3d the proof" in ln)
        self.assertIn("C4's 15 verdict lines across the shards roll up to PASS", row)

    def test_a_fence_that_only_gapped_fails_the_citation(self):
        docs = recorded_run()
        for d in docs:
            if d["shard"] == "fence":
                for v in d["verdicts"]:
                    if v["label"].startswith("C4c"):
                        v["verdict"] = "GAP"
        rc, printed = self.regrade(docs)
        self.assertEqual(rc, 1)
        row = next(ln for ln in printed.splitlines()
                   if ln.startswith("  FAIL  ") and "C3d the proof" in ln)
        self.assertIn("none of them measured the fence", row)

    def test_a_pending_c3d_row_with_no_c4_lines_anywhere_fails(self):
        """C3 alone in a shard (a future shard split): the row printed PENDING and
        the merged record must still answer it — with no C4 lines, that is a FAIL."""
        docs = recorded_run()
        for d in docs:
            if d["shard"] == "fence":
                d["verdicts"] = [v for v in d["verdicts"]
                                 if not v["label"].startswith("C4c")] + \
                    pending_line("C3d the proof it points at is measured in this "
                                 "process (C4's fence)")
        rc, printed = self.regrade(docs)
        self.assertEqual(rc, 1)
        row = next(ln for ln in printed.splitlines()
                   if ln.startswith("  FAIL  ") and "C3d the proof" in ln)
        self.assertIn("C4 printed 0 verdict line(s)", row)

    def test_unreadable_witness_file_is_named_not_guessed(self):
        self.reset_pools()
        good = self.write(recorded_run()[0])
        bad = os.path.join(self.tmp, "broken.json")
        with open(bad, "w", encoding="utf-8") as fh:
            fh.write("{not json")
        rc, printed = m.printed_by(lambda: m.run_regrade([good, bad], ["core-a"]))
        self.assertEqual(rc, 1)
        self.assertIn("broken.json", printed)

    def test_no_witnesses_at_all_fails_instead_of_printing_nothing(self):
        self.reset_pools()
        rc, printed = m.printed_by(lambda: m.run_regrade([], []))
        self.assertEqual(rc, 1)
        self.assertIn("no readable witness file", printed)


class CrossGateRowRegistry(_CrossShardSandbox):
    """The registry itself: which rows may ever print PENDING, and the shard
    selection rule that decides it."""

    def test_only_the_named_cross_gate_rows_are_registered(self):
        self.assertEqual(m.cross_gate_witness_gates(m.C5G_KEYSET_CLAIM), ("C1",))
        self.assertEqual(m.cross_gate_witness_gates(m.C6C_KEYSET_CLAIM), ("C1",))
        self.assertEqual(m.cross_gate_witness_gates("C6c key-set equality against C1"),
                         ("C1",))
        self.assertEqual(m.cross_gate_witness_gates(
            "C3d the proof it points at is measured in this process (C4's fence)"),
            ("C4",))
        self.assertEqual(m.cross_gate_witness_gates("C11c outputs are size-capped"),
                         ("C12",))
        self.assertEqual(m.cross_gate_witness_gates("C11c outputs are project-scoped data"),
                         ("C14", "C8"))

    def test_ordinary_rows_are_not_registered(self):
        for label in ("C4c the fenced attempt is interrupted",
                      "C10b the retry gets it right", "W9 approval renders a 404",
                      "C11b the collector logged nothing",
                      "C6c run.retried's workspace_policies names restore_checkpoint"):
            self.assertEqual(m.cross_gate_witness_gates(label), (), label)

    def test_gates_default_to_running_here(self):
        self.assertTrue(m.gate_in_this_pass("C1"), "no --only means every gate ran")
        m.CTX["gate_selection"] = {"C3", "C4"}
        self.assertTrue(m.gate_in_this_pass("c4"))
        self.assertFalse(m.gate_in_this_pass("C1"))

    def test_pending_rows_are_recorded_as_pending_verdict_lines(self):
        m.pending("C5g the retried run's node_instance_key set is C1's twin set", "why")
        entry = m.VERDICTS[-1]
        self.assertEqual(entry["verdict"], "PENDING")
        self.assertEqual(entry["leg"], "C5G")

    def test_a_pending_line_never_rolls_up_as_measured(self):
        m._record("PENDING", "C5g the retried run's node_instance_key set", "x")
        self.assertEqual(m.rollup("C5g"), "GAP",
                         "a leg whose only lines are PENDING is unmeasured, never PASS")

    def test_row_family_matches_a_shard_pending_row_to_its_regrade_verdict(self):
        self.assertEqual(m.row_family(m.C5G_KEYSET_CLAIM),
                         m.row_family(m.C5G_KEYSET_CLAIM + " — iteration-normalized (x)"))
        self.assertNotEqual(
            m.row_family("C11c outputs are size-capped"),
            m.row_family("C11c outputs are project-scoped data"))


if __name__ == "__main__":
    unittest.main(verbosity=2 if "-v" in sys.argv else 1)
