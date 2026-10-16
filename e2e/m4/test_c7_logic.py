#!/usr/bin/env python3
"""test_c7_logic.py - offline unit proof for e2e_m4_exit.py's C7 pure logic.

Runs WITHOUT a stack (stdlib unittest only): the `until`-never-passes verdict
algebra — exhausted-at-maxIterations over canned node_executions rows, the
journal story (pass_when_result=false x3 then node.scope.failed then run.failed),
the per-iteration artifact set, the authored route to needs_attention, the
expression-evaluation budget count, the indeterminate-is-not-false arms, the
carryForward witness, and the document splices that re-author the seed twin
(maxIterations 3 + the fixture's edit-free step as implementer).

A green here means the VERDICT ALGEBRA is right. It never substitutes for C7's
live exhaustion run against the real advancer (12-test-strategy.md: a bounded
loop is only proven by watching it stop at the bound).

usage: python3 e2e/m4/test_c7_logic.py [-v]
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import e2e_m4_exit as m  # noqa: E402 — importing the driver is the point


def hits(rows, needle):
    out = [v for v in rows if needle in v[0]]
    assert out, f"no verdict matching {needle!r} in {[l for l, _o, _d in rows]}"
    return out


def oks(rows, needle):
    return [ok for _l, ok, _d in hits(rows, needle)]


def one(rows, needle):
    vs = oks(rows, needle)
    assert len(vs) == 1, f"{needle!r} produced {len(vs)} verdicts"
    return vs[0]


K = "/build_until_verified"
BODY = ("implement", "test", "review")


def canned_rows(iters=3, statuses="succeeded", nodes=BODY, attempts=1, outputs=True):
    """node_executions rows shaped like C7's ledger read (with the probe witness)."""
    lines = []
    for n in range(1, iters + 1):
        for node in list(nodes) + [m.C7_PROBE_NODE]:
            out = '{"plan": "x"}' if outputs else "<none>"
            lines.append(f"{K}[{n}]/{node}|{statuses}|{attempts}|{out}")
    return "\n".join(lines)


class C7aExhausted(unittest.TestCase):
    def test_pass_exactly_three_iterations(self):
        rows = m.c7_body_rows(canned_rows(3))
        v = m.c7_exhausted_verdicts(rows, "failed", "until_exhausted")
        self.assertEqual(3, m.c7_iteration_count(rows))
        self.assertNotIn(False, [ok for _l, ok, _d in v], f"expected a clean PASS: {v}")

    def test_gap_without_a_run_row_or_any_rows(self):
        v = m.c7_exhausted_verdicts([], "", "")
        self.assertTrue(all(ok is None for _l, ok, _d in v), f"no rows must GAP: {v}")

    def test_fail_run_completed(self):
        v = m.c7_exhausted_verdicts(m.c7_body_rows(canned_rows(3)), "completed", None)
        self.assertIs(False, one(v, "failed|until_exhausted"))

    def test_fail_loop_overshoots_the_bound(self):
        rows = m.c7_body_rows(canned_rows(4))
        v = m.c7_exhausted_verdicts(rows, "failed", "until_exhausted")
        self.assertIs(False, one(v, "no overshoot"))
        self.assertIs(False, one(v, "body rows, all terminal"))

    def test_fail_bound_stopped_early(self):
        rows = m.c7_body_rows(canned_rows(2))
        self.assertIs(False, one(m.c7_exhausted_verdicts(rows, "failed",
                                                        "until_exhausted"), "no overshoot"))

    def test_fail_non_terminal_row_never_counts_as_exhausted(self):
        rows = m.c7_body_rows(canned_rows(3, statuses="running"))
        self.assertIs(False, one(m.c7_exhausted_verdicts(rows, "failed",
                                                        "until_exhausted"),
                                 "body rows, all terminal"))

    def test_fail_outputs_overwritten_or_missing(self):
        v = m.c7_exhausted_verdicts(m.c7_body_rows(canned_rows(3, outputs=False)),
                                    "failed", "until_exhausted")
        self.assertIs(False, one(v, "outputs are preserved"))

    def test_fail_missing_attempt_count_is_gap_not_zero(self):
        text = canned_rows(3).replace("|1|", "|n|")
        self.assertIs(None, one(m.c7_exhausted_verdicts(m.c7_body_rows(text), "failed",
                                                       "until_exhausted"), "attempt_count"))

    def test_append_only_duplicate_key_fails(self):
        text = canned_rows(3) + f"\n{K}[3]/test|succeeded|1|{{}}"
        self.assertIs(False, one(m.c7_exhausted_verdicts(m.c7_body_rows(text), "failed",
                                                        "until_exhausted"), "append-only"))


class C7bJournal(unittest.TestCase):
    def events(self, pw=False, cause="until_exhausted", evid=3):
        ev = [{"type": "node.scope.iteration",
               "payload": {"scope_key": K, "iteration": i, "pass_when_result": pw}}
              for i in range(1, 4)]
        ev.append({"type": "node.scope.failed", "payload": {"scope_key": K, "kind": "until",
                                                            "failed_cause": cause,
                                                            "evidence": [f"e{i}" for i
                                                                         in range(evid)]}})
        ev.append({"type": "run.failed", "payload": {"failed_cause": cause,
                                                     "evidence_artifacts": ["test-1"]}})
        return ev

    def test_pass_story_in_order(self):
        v = m.c7_event_verdicts(self.events())
        self.assertNotIn(False, [ok for _l, ok, _d in v], str(v))

    def test_fail_indeterminate_pass_when_result(self):
        v = m.c7_event_verdicts(self.events(pw=None))
        self.assertIs(False, one(v, "pass_when_result=false"))

    def test_fail_true_predicate_on_an_exhausted_run(self):
        self.assertIs(False, one(m.c7_event_verdicts(self.events(pw=True)),
                                 "pass_when_result=false"))

    def test_fail_empty_evidence(self):
        v = m.c7_event_verdicts(self.events(evid=0))
        self.assertIs(False, one(v, "node.scope.failed{failed_cause"))

    def test_fail_run_completed_present(self):
        ev = self.events() + [{"type": "run.completed", "payload": {}}]
        self.assertIs(False, one(m.c7_event_verdicts(ev), "NO run.completed"))

    def test_gap_no_journal_rows(self):
        self.assertTrue(all(ok is None for _l, ok, _d in m.c7_event_verdicts([])),
                        "an unreadable journal must GAP")

    def test_fail_predicate_error_is_not_exhaustion(self):
        self.assertIs(False, one(m.c7_event_verdicts(self.events(cause="predicate_error")),
                                 "node.scope.failed{failed_cause"))


class C7bArtifacts(unittest.TestCase):
    def test_pass_three_distinct(self):
        self.assertNotIn(False, [ok for _l, ok, _d in m.c7_artifact_verdicts(
            ["test-1", "test-2", "test-3", "review-evidence.md"])])

    def test_fail_iteration_evidence_collapsed(self):
        self.assertIs(False, one(m.c7_artifact_verdicts(["test-1", "test-1"]),
                                 f"{m.C7_MAX_ITERATIONS} distinct"))

    def test_gap_nothing_written(self):
        self.assertIs(None, one(m.c7_artifact_verdicts([]), "distinct"))


class C7fRoute(unittest.TestCase):
    ROOT = "\n".join([
        "/plan|succeeded|-", "/approve|succeeded|-",
        f"{K}|failed|-", "/verdict|succeeded|needs_attention",
        "/publish_verified|skipped|-", "/publish_needs_attention|succeeded|-",
        f"{K}[1]/implement|failed|-"])

    def test_pass_authored_exhausted_path(self):
        v = m.c7_route_verdicts(self.ROOT, {"iterations": 3})
        self.assertNotIn(False, [ok for _l, ok, _d in v], str(v))

    def test_fail_verified_arm_ran(self):
        bad = self.ROOT.replace("/publish_verified|skipped|-",
                                "/publish_verified|succeeded|-")
        self.assertIs(False, one(m.c7_route_verdicts(bad, {"iterations": 3}),
                                 "/publish_verified skipped"))

    def test_fail_wrong_route(self):
        bad = self.ROOT.replace("/verdict|succeeded|needs_attention",
                                "/verdict|succeeded|verified")
        self.assertIs(False, one(m.c7_route_verdicts(bad, {"iterations": 3}), "default route"))

    def test_gap_no_rows_and_gap_missing_iterations(self):
        self.assertIs(None, one(m.c7_route_verdicts("", {"iterations": 3}),
                                "needs_attention"))
        self.assertIs(None, one(m.c7_route_verdicts(self.ROOT, {}), "reports iterations"))


class C7gBudget(unittest.TestCase):
    def test_pass_counted(self):
        self.assertNotIn(False, [ok for _l, ok, _d in m.c7_budget_verdicts("9", 9)])

    def test_fail_zero_means_never_counted(self):
        self.assertIs(False, one(m.c7_budget_verdicts("0"), "counted (> 0"))

    def test_fail_over_the_cap(self):
        self.assertIs(False, one(m.c7_budget_verdicts(str(m.C7_EVAL_CAP + 1)), "counted (> 0"))

    def test_fail_api_disagrees_with_ledger(self):
        self.assertIs(False, one(m.c7_budget_verdicts("12", 7), "GET /runs"))

    def test_gap_unreadable(self):
        self.assertTrue(all(ok is None for _l, ok, _d in m.c7_budget_verdicts(None, None)))


class C7cIndeterminate(unittest.TestCase):
    def test_pass_validate_refusal_and_gap_the_eval_arm(self):
        vresp = {"valid": False, "errors": [{"code": "unknown_field",
                                             "instance_location": "/spec/nodes/2/config/passWhen"}]}
        v = m.c7_predicate_error_verdicts(vresp=vresp)
        self.assertIs(True, one(v, "refused at validate"))
        self.assertIs(None, one(v, "at eval time"))

    def test_pass_eval_error_stops_at_iteration_one(self):
        v = m.c7_predicate_error_verdicts(
            scope_row={"status": "failed", "outcome": "-", "failed_cause": "predicate_error"},
            run_st="failed", events=[{"type": "node.scope.failed", "payload": {}}],
            body_rows=canned_rows(1))
        self.assertNotIn(False, [ok for _l, ok, _d in v], str(v))

    def test_fail_loop_kept_going_past_the_error(self):
        v = m.c7_predicate_error_verdicts(
            scope_row={"status": "failed", "outcome": "-", "failed_cause": "predicate_error"},
            run_st="failed", events=[], body_rows=canned_rows(2))
        self.assertIs(False, one(v, "iterations_stopped=1"))

    def test_fail_predicate_counted_false_and_run_completed(self):
        v = m.c7_predicate_error_verdicts(
            scope_row={"status": "succeeded", "outcome": "-", "failed_cause": None},
            run_st="completed", events=[{"type": "run.completed", "payload": {}}],
            body_rows=canned_rows(3))
        self.assertIs(False, one(v, "never counted false"))
        self.assertIs(False, one(v, "NO run.completed"))


class C7dCarryForward(unittest.TestCase):
    def test_pass_empty_then_non_empty(self):
        v = m.c7_carry_verdicts("1|skipped\n2|succeeded\n3|succeeded")
        self.assertIs(True, one(v, "`previous` empty on iteration 1"))
        self.assertIs(None, one(v, "prompt echoes"), "the twin has no prompt — honest GAP")

    def test_fail_previous_never_arrived(self):
        self.assertIs(False, one(m.c7_carry_verdicts("1|skipped\n2|skipped\n3|skipped"),
                                 "`previous` empty on iteration 1"))

    def test_fail_iteration_one_read_previous(self):
        self.assertIs(False, one(m.c7_carry_verdicts("1|succeeded\n2|succeeded"),
                                 "`previous` empty on iteration 1"))

    def test_gap_no_witness_rows(self):
        self.assertIs(None, one(m.c7_carry_verdicts(""), "`previous` empty on iteration 1"))


class C7DocSplices(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        path = os.path.join(m.REPO_DIR, "docs", "compatibility", "probes", "m4", "pipeline.yaml")
        with open(path, encoding="utf-8") as f:
            cls.twin = f.read().split("\n---\n")[1]

    def test_splice_produces_a_never_passing_loop(self):
        sp = m.c7_exhaustion_doc(self.twin, "m4x-c7-unit")
        self.assertEqual([], sp["missing"], str(sp["missing"]))
        doc = sp["doc"]
        self.assertIn("maxIterations: 3", doc)
        self.assertNotIn("maxIterations: 4", doc)
        self.assertNotIn("args: [implement]", doc)
        self.assertIn("args: [plan]", doc)
        self.assertIn("nodes.implement.outputs.plan", doc)
        self.assertIn(f"id: {m.C7_PROBE_NODE}", doc)
        self.assertIn("carryForward: true", doc)
        self.assertNotIn(False, [ok for _l, ok, _d in m.c7_doc_verdicts(sp)], str(sp["applied"]))

    def test_body_node_indent_survives_the_splice(self):
        lines = m.c7_exhaustion_doc(self.twin, "m4x-c7-unit")["doc"].splitlines()
        probe = lines.index(f"        - id: {m.C7_PROBE_NODE}")
        self.assertTrue(lines[probe + 1].startswith("          kind: "), lines[probe + 1])
        self.assertEqual("      resultBindings:", lines[lines.index("      resultBindings:")])

    def test_c7c_pass_when_replacement_keeps_indentation(self):
        sp = m.c7_exhaustion_doc(self.twin, "m4x-c7-c",
                                pass_when="nodes.review.outputs.verdict == true")
        self.assertEqual([], sp["missing"], str(sp["missing"]))
        line = [l for l in sp["doc"].splitlines() if l.strip().startswith("passWhen:")][0]
        self.assertEqual("      passWhen: nodes.review.outputs.verdict == true", line)

    def test_missing_splices_are_said_loudly_not_silently(self):
        sp = m.c7_exhaustion_doc("apiVersion: communication.dev/v1alpha1\nkind: Pipeline\n"
                                 "metadata:\n  name: x\n", "m4x-c7-short")
        self.assertIsNone(sp["doc"])
        self.assertTrue(sp["missing"])
        self.assertIs(False, one(m.c7_doc_verdicts(sp), "every required splice applied"))

    def test_non_pipeline_document_is_rejected(self):
        sp = m.c7_exhaustion_doc("# just notes\nnothing here\n", "m4x-c7-junk")
        self.assertIsNone(sp["doc"])
        self.assertTrue(any("Pipeline" in x for x in sp["missing"]))

    def test_the_noop_step_is_the_fixtures_own_edit_free_branch(self):
        # C7 must not edit the fixture: `plan` prints JSON and calls no in_app/sed path.
        helper = os.path.join(m.REPO_DIR, "e2e", "m4", "make_fixture_repo.sh")
        with open(helper, encoding="utf-8") as f:
            text = f.read()
        block = text.split("case \"$step\" in")[1].split("implement)")[0]
        self.assertNotIn("sed -i", block)
        self.assertNotIn("in_app", block)


if __name__ == "__main__":
    unittest.main(verbosity=2 if "-v" in sys.argv else 1)
