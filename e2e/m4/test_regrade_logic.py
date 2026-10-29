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
import os
import sys
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


if __name__ == "__main__":
    unittest.main(verbosity=2)
