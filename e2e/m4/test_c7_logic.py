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
import yamlmini as yaml  # noqa: E402 — stdlib YAML subset (CI's python3 has no PyYAML)


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
    """§ 7.1 C7b's psql line (`name like 'test-%'` # 3) graded against the seed's own
    names: pipeline.yaml's until body publishes `test-<iteration>.json` from its
    `test_evidence` node, so the expected set is spelled out, not prefix-counted."""

    NAMES = ["plan-evidence.md", "test-1.json", "test-2.json", "test-3.json"]

    def test_pass_three_distinct(self):
        rows = m.c7_artifact_verdicts(self.NAMES + ["review-evidence.md"])
        self.assertNotIn(False, [ok for _l, ok, _d in rows], str(rows))
        self.assertEqual(2, len(rows), str(rows))

    def test_the_expected_names_are_the_seed_published_ones(self):
        self.assertEqual(["test-1.json", "test-2.json", "test-3.json"],
                         m.c7_artifact_names_expected())

    def test_fail_iteration_evidence_collapsed(self):
        self.assertIs(False, one(m.c7_artifact_verdicts(["test-1.json", "test-1.json"]),
                                 f"{m.C7_MAX_ITERATIONS} distinct"))

    def test_fail_when_only_the_unnamed_prefix_shows_up(self):
        # Three rows, one iteration twice and one missing: the prefix alone cannot tell
        # that story, the names can.
        self.assertIs(False, one(m.c7_artifact_verdicts(
            ["test-1.json", "test-1.json", "test-2.json"]),
            f"{m.C7_MAX_ITERATIONS} distinct"))

    def test_zero_rows_is_a_fail_now_that_the_seed_publishes_them(self):
        """The old helper GAPped an empty ledger because the shipped twin published its
        only artifact AFTER the gate, so no exhaustion run could ever have had a 'test-%'
        row (live16/C7.out). The seed now publishes one per iteration, so zero rows is
        the evidence § 7.1 C7b names going missing — a FAIL, never a GAP."""
        rows = m.c7_artifact_verdicts([])
        self.assertIs(False, one(rows, "distinct"), str(rows))
        self.assertIn("ZERO", hits(rows, "distinct")[0][2])
        self.assertIn(m.C7_EVIDENCE_NODE, hits(rows, "distinct")[0][2])

    def test_rows_that_are_not_evidence_do_not_satisfy_the_arm(self):
        rows = m.c7_artifact_verdicts(["plan-evidence.md", "review-evidence.md"])
        self.assertIs(False, one(rows, "distinct"), str(rows))

    def test_a_failed_read_is_the_only_gap(self):
        rows = m.c7_artifact_verdicts(None)
        self.assertIs(None, one(rows, "distinct"), str(rows))
        self.assertIn("read failed", hits(rows, "distinct")[0][2])

    def test_the_evidence_node_is_a_fourth_body_row_but_not_a_work_node(self):
        """C7a's arithmetic is the contract's (`3 iterations × 3 body nodes = 9 rows`), so
        the seed's fourth, unconditional until-body node — the evidence publisher — must
        NOT be folded into C7_BODY_NODES: the live read returns 12 body rows for an
        exhausted run and the arm still counts nine."""
        self.assertEqual(("implement", "test", "review"), m.C7_BODY_NODES)
        self.assertNotIn(m.C7_EVIDENCE_NODE, m.C7_BODY_NODES)
        rows = canned_rows(3, nodes=m.C7_BODY_NODES + (m.C7_EVIDENCE_NODE,))
        verdicts = m.c7_exhausted_verdicts(m.c7_body_rows(rows), "failed", "until_exhausted")
        self.assertNotIn(False, [ok for _l, ok, _d in verdicts], str(verdicts))
        self.assertIn("9 body rows",
                      " ".join(l for l, _o, _d in verdicts), str(verdicts))
        self.assertIn("9 rows", " ".join(d for _l, _o, d in verdicts), str(verdicts))


class C7aNoRoute(unittest.TestCase):
    """§ 7.1 C7 has arms a-d — there is NO C7f — and § 5.1 step 5
    (docs/m4-contract.md:777-779) says a failed stop-policy node "fails the run ... and
    CANCELS QUEUED DESCENDANTS". The exhausted loop's /verdict therefore never routes
    (live2/C1.out:49-51 observed: /verdict and both publish arms `cancelled`), which is
    what these verdicts assert. The old C7f arms demanded the opposite, so /verdict
    could never satisfy them."""

    ROOT = "\n".join([
        "/plan|succeeded|-", "/approve|succeeded|-",
        f"{K}|failed|-",
        "/verdict|cancelled|-", "/publish_verified|cancelled|-",
        "/publish_needs_attention|cancelled|-",
        f"{K}[1]/implement|failed|-"])

    def test_cancelled_descendants_pass(self):
        v = m.c7_no_route_verdicts(self.ROOT, {"iterations": 3})
        self.assertNotIn(False, [ok for _l, ok, _d in v], str(v))
        self.assertTrue(any("CANCELLED" in l for l, _o, _d in v), str(v))

    def test_a_routed_verdict_after_the_run_failed_is_a_fail(self):
        bad = self.ROOT.replace("/verdict|cancelled|-", "/verdict|succeeded|needs_attention")
        self.assertIs(False, one(m.c7_no_route_verdicts(bad, {"iterations": 3}),
                                 "/verdict never ran"))

    def test_a_publish_arm_that_ran_is_a_fail(self):
        bad = self.ROOT.replace("/publish_needs_attention|cancelled|-",
                                "/publish_needs_attention|succeeded|-")
        self.assertIs(False, one(m.c7_no_route_verdicts(bad, {"iterations": 3}),
                                 "neither publish arm ran"))

    def test_a_route_outcome_on_a_dead_row_is_a_fail(self):
        bad = self.ROOT.replace("/verdict|cancelled|-", "/verdict|cancelled|needs_attention")
        self.assertIs(False, one(m.c7_no_route_verdicts(bad, {"iterations": 3}),
                                 "no route outcome"))

    def test_gaps_when_the_rows_do_not_exist(self):
        self.assertIs(None, one(m.c7_no_route_verdicts("", {"iterations": 3}), "CANCELLED"))
        no_verdict = "\n".join(l for l in self.ROOT.splitlines()
                               if not l.startswith("/verdict|"))
        self.assertIs(None, one(m.c7_no_route_verdicts(no_verdict, {"iterations": 3}),
                                "/verdict never ran"))
        live = self.ROOT.replace("/verdict|cancelled|-", "/verdict|running|-")
        self.assertIs(None, one(m.c7_no_route_verdicts(live, {"iterations": 3}),
                                "/verdict never ran"))
        self.assertIs(None, one(m.c7_no_route_verdicts(self.ROOT, {}), "reports iterations"))

    def test_the_driver_never_emits_a_c7f_verdict(self):
        """A verdict the contract does not define cannot be routed by /verdict, and
        cannot be graded against § 7.1 — no C7f-prefixed LABEL may exist anywhere."""
        import re as _re
        src = open(os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                "e2e_m4_exit.py"), encoding="utf-8").read()
        whole = " ".join(src.split())
        self.assertEqual([], _re.findall(r'["\(]\s*C7f\b', src),
                         "a C7f verdict label survived in the driver")
        self.assertIn("no C7f arm", whole, "the C7a arm must cite why the label is gone")
        self.assertIn("5.1 step 5", whole)
        self.assertNotIn("c7_route_verdicts", whole, "the old C7f helper survived")
        self.assertIn("c7_no_route_verdicts", whole)


class C7aScopeIterations(unittest.TestCase):
    """The until scope reports how many iterations it spent on its OWN terminal journal
    row — node.scope.failed.iterations_stopped (§ 3 row 19), node.scope.completed.
    iterations (§ 3 row 18) on the pass path. node_executions has NO iterations column
    (contract § 1's CREATE TABLE carries no scope-state column; internal/pipelines/
    runtime/scope_state.go says so outright), so acceptance 1c190fe's
    'iterations=None' GAP was the arm reading a phantom column (`SELECT
    iterations::text FROM node_executions` errors on every run), NOT the loop failing
    to record its bound — the engine wrote iterations_stopped the whole time. These
    tests pin the journal read and the verdict built on it."""

    @staticmethod
    def failed_row(it, key=K):
        return [{"type": "node.scope.failed",
                 "payload": {"node_instance_key": key, "failed_cause": "until_exhausted",
                             "iterations_stopped": it}}]

    def test_reads_iterations_stopped_off_the_scope_own_failed_row(self):
        got = m.c7_scope_iterations_from_events(self.failed_row(3))
        self.assertEqual(3, got)
        v = m.c7_no_route_verdicts(C7aNoRoute.ROOT, {"iterations": got})
        self.assertIs(True, one(v, "reports iterations"), str(v))

    def test_wrong_count_is_a_fail_not_a_gap(self):
        for wrong in (0, 2, 4):
            got = m.c7_scope_iterations_from_events(self.failed_row(wrong))
            self.assertEqual(wrong, got)
            self.assertIs(False,
                          one(m.c7_no_route_verdicts(C7aNoRoute.ROOT, {"iterations": got}),
                              "reports iterations"), wrong)

    def test_reads_iterations_off_the_completed_row_too(self):
        ev = [{"type": "node.scope.completed",
               "payload": {"node_instance_key": K, "kind": "until", "iterations": 2}}]
        self.assertEqual(2, m.c7_scope_iterations_from_events(ev))

    def test_the_scope_own_terminal_row_wins_and_nothing_else_counts(self):
        ev = self.failed_row(3) + [
            {"type": "node.scope.iteration",
             "payload": {"node_instance_key": K, "iteration": 2}},
            {"type": "run.failed", "payload": {"failed_cause": "until_exhausted"}}]
        self.assertEqual(3, m.c7_scope_iterations_from_events(ev))

    def test_other_scopes_rows_do_not_feed_the_counter(self):
        self.assertIsNone(m.c7_scope_iterations_from_events(self.failed_row(3, key="/fan_out")))

    def test_missing_or_malformed_counter_is_the_gap(self):
        bad = [None, [],
               [{"type": "node.scope.failed", "payload": {}}],
               [{"type": "node.scope.failed", "payload": {"node_instance_key": K}}],
               [{"type": "node.scope.failed",
                 "payload": {"node_instance_key": K, "iterations_stopped": "3"}}],
               [{"type": "node.scope.failed",
                 "payload": {"node_instance_key": K, "iterations_stopped": None}}],
               [{"type": "node.scope.failed",
                 "payload": {"node_instance_key": K, "iterations_stopped": True}}],
               [{"type": "node.scope.failed", "payload": "not-a-dict"}],
               "not-a-list-of-dicts"]
        for case in bad:
            self.assertIsNone(m.c7_scope_iterations_from_events(case), case)
            self.assertIs(None,
                          one(m.c7_no_route_verdicts(C7aNoRoute.ROOT,
                                                     {"iterations":
                                                      m.c7_scope_iterations_from_events(case)}),
                              "reports iterations"), case)

    def test_the_driver_never_reads_the_phantom_column_again(self):
        """The GAP's root cause: a SELECT of a column the schema never had. It must
        not come back, in the driver or in a helper next to it."""
        src = open(os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                "e2e_m4_exit.py"), encoding="utf-8").read()
        self.assertNotIn("SELECT iterations::text FROM node_executions WHERE", src)
        self.assertNotIn("def c7_scope_iterations(", src)
        self.assertIn("c7_scope_iterations_from_events", src)


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
            seed = f.read().split("\n---\n")[1]
        # the shape the live gate now splices: the revision's canonical_document,
        # re-exported exactly like route 14 (4-space indent, bullets indented under
        # their key, alphabetical) and parsed back — RC3's literal output shape.
        cls.twin = yaml.safe_load(yaml.safe_dump(yaml.safe_load(seed), indent=4,
                                                 sort_keys=True, allow_unicode=True))

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

    def test_the_exported_shape_moves_exactly_the_c7_values(self):
        # RC3: on the API's regenerated document every splice must still land, and
        # ONLY the intended values may move (name, maxIterations, the implementer's
        # step/required/property, the summary→plan binding, the witness node).
        frozen = yaml.safe_load(yaml.safe_dump(self.twin))
        sp = m.c7_exhaustion_doc(self.twin, "m4x-c7-unit")
        self.assertEqual([], sp["missing"], str(sp["missing"]))
        self.assertEqual(frozen, self.twin, "the splice must not mutate the caller's doc")
        got = yaml.safe_load(sp["doc"])
        want = yaml.safe_load(yaml.safe_dump(frozen))
        want["metadata"]["name"] = "m4x-c7-unit"
        until = [n for n in want["spec"]["nodes"] if n.get("kind") == "until"][0]
        until["config"]["maxIterations"] = 3
        until["config"]["resultBindings"]["implementation_summary"] = \
            "${{ nodes.implement.outputs.plan }}"
        impl = [n for n in until["config"]["body"]["nodes"] if n["id"] == "implement"][0]
        impl["config"]["args"] = [m.C7_NOOP_STEP]
        impl["outputs"]["required"] = ["plan"]
        impl["outputs"]["properties"] = {("plan" if k == "summary" else k): v
                                         for k, v in impl["outputs"]["properties"].items()}
        until["config"]["body"]["nodes"].append(
            yaml.safe_load(yaml.safe_dump(m.C7_PROBE_NODE_SPEC)))
        self.assertEqual(want, got, "exactly the C7 values moved")

    def test_the_witness_node_lands_inside_the_until_body(self):
        # the old text splice asserted byte indentation of `- id: prev_probe`;
        # the structural edit asserts POSITION instead (appended last in the body,
        # before resultBindings semantically — resultBindings stays the until's).
        sp = m.c7_exhaustion_doc(self.twin, "m4x-c7-unit")
        until = [n for n in yaml.safe_load(sp["doc"])["spec"]["nodes"] if n.get("kind") == "until"][0]
        self.assertEqual(m.C7_PROBE_NODE,
                         until["config"]["body"]["nodes"][-1]["id"])
        self.assertEqual("has(previous.review_feedback)",
                         until["config"]["body"]["nodes"][-1]["when"])
        self.assertEqual({"implementation_summary", "review_feedback", "approved"},
                         set(until["config"]["resultBindings"]))

    def test_c7c_pass_when_replacement_moves_only_the_predicate(self):
        before = yaml.safe_load(yaml.safe_dump(self.twin))["spec"]["nodes"][2]["config"]["passWhen"]
        sp = m.c7_exhaustion_doc(self.twin, "m4x-c7-c",
                                 pass_when="nodes.review.outputs.verdict == true")
        self.assertEqual([], sp["missing"], str(sp["missing"]))
        line = [l for l in sp["doc"].splitlines() if l.strip().startswith("passWhen:")][0]
        self.assertEqual("passWhen: nodes.review.outputs.verdict == true", line.strip())
        until = [n for n in yaml.safe_load(sp["doc"])["spec"]["nodes"] if n.get("kind") == "until"][0]
        self.assertEqual("nodes.review.outputs.verdict == true", until["config"]["passWhen"])
        self.assertNotEqual(before, until["config"]["passWhen"])

    def test_missing_splices_are_said_loudly_not_silently(self):
        sp = m.c7_exhaustion_doc({"apiVersion": "communication.dev/v1alpha1",
                                  "kind": "Pipeline", "metadata": {"name": "x"}},
                                 "m4x-c7-short")
        self.assertIsNone(sp["doc"])
        self.assertTrue(sp["missing"])
        self.assertIs(False, one(m.c7_doc_verdicts(sp), "every required splice applied"))

    def test_non_pipeline_document_is_rejected(self):
        for junk in ({"notes": "just notes"}, "# just notes\nnothing here\n"):
            sp = m.c7_exhaustion_doc(junk, "m4x-c7-junk")
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
