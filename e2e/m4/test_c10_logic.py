#!/usr/bin/env python3
"""test_c10_logic.py - offline unit proof for e2e_m4_exit.py's C10 pure logic.

Runs WITHOUT a stack (stdlib unittest only): the invalid_output-is-not-business-
fail verdict from canned attempt/node rows (PASS / FAIL / GAP), the JSON-Schema
location scan over attempts.output_errors, the outputs-not-visible invariant, the
routing-never-changed verdicts (a completed run or a condition_default skip IS the
"read as not approved" bug), the retried-per-policy arm (including the honest GAP
where the shipped fixture cannot answer differently on attempt 2), the model.chat
precondition GAP, and the single-splice document authoring gate.

A green here means the VERDICT ALGEBRA is right. It never substitutes for C10's
live leg — publishing the schema-invalid reviewer, running it against the real
worker and reading attempts/node_executions/domain_events (12-test-strategy.md: a
mocked green is not done).

usage: python3 e2e/m4/test_c10_logic.py [-v]
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


BAD = [{"keyword": "type", "location": "#/properties/evidence/type",
        "message": "expected boolean, got string"}]
GOOD_ATT = {"id": "a1", "status": "failed", "error_class": "invalid_output",
            "output_errors": '[{"location": "#/properties/evidence/type"}]', "outputs": "-"}
LEAKED = {"id": "a1", "status": "succeeded", "error_class": "-",
          "output_errors": "[]", "outputs": '{"approved":true,"evidence":"x"}'}


class OutputErrors(unittest.TestCase):
    def test_parses_psql_jsonb_text(self):
        self.assertEqual(m.c10_output_errors('[{"location": "#"}]'), [{"location": "#"}])

    def test_passes_through_api_lists(self):
        self.assertEqual(m.c10_output_errors(BAD), BAD)
        self.assertEqual(m.c10_output_errors({"a": 1}), [{"a": 1}])

    def test_empty_array_is_a_real_nothing_not_an_unreadable(self):
        self.assertEqual(m.c10_output_errors("[]"), [])

    def test_garbage_and_null_spellings_are_unreadable(self):
        for raw in (None, "", "<none>", "NULL", "null", "not json", "3"):
            self.assertIsNone(m.c10_output_errors(raw), repr(raw))

    def test_locations_are_scanned_not_inferred(self):
        locs, n = m.c10_schema_locations(BAD)
        self.assertEqual(n, 1)
        self.assertTrue(any("/properties/evidence" in x for x in locs), str(locs))
        self.assertEqual(m.c10_schema_locations([]), ([], 0))
        self.assertEqual(m.c10_schema_locations(None), (None, 0))


class Attempt(unittest.TestCase):
    def test_malformed_reply_is_an_execution_error(self):
        v = m.c10_attempt_verdicts(GOOD_ATT, completed_seen=False)
        self.assertTrue(one(v, "status='failed'"))
        self.assertTrue(one(v, "error_class is invalid_output"))
        self.assertTrue(one(v, "output_errors is populated"))
        self.assertTrue(one(v, "NO node.attempt.completed"))

    def test_a_succeeded_review_is_the_business_read_bug(self):
        v = m.c10_attempt_verdicts(LEAKED, completed_seen=True)
        self.assertFalse(one(v, "status='failed'"))
        self.assertFalse(one(v, "error_class is invalid_output"))
        self.assertFalse(one(v, "output_errors is populated"))
        self.assertFalse(one(v, "NO node.attempt.completed"))

    def test_no_attempt_row_is_a_gap_never_a_pass(self):
        for att in (None, {}):
            v = m.c10_attempt_verdicts(att)
            self.assertTrue(any(ok is None for _l, ok, _d in v), str(v))

    def test_unreadable_completion_events_gap_the_absence(self):
        v = m.c10_attempt_verdicts(GOOD_ATT, completed_seen=None)
        self.assertIsNone(one(v, "NO node.attempt.completed"))
        self.assertIn("unmeasurable", detail(v, "NO node.attempt.completed"))


class Visibility(unittest.TestCase):
    def test_null_outputs_everywhere_passes(self):
        v = m.c10_visibility_verdicts(GOOD_ATT, {"status": "failed", "outputs": "-"})
        self.assertTrue(one(v, "carries NO outputs"))
        self.assertTrue(one(v, "keeps outputs NULL"))

    def test_a_published_output_is_a_fail_not_a_gap(self):
        v = m.c10_visibility_verdicts(LEAKED, {"status": "succeeded",
                                              "outputs": '{"approved":true}'})
        self.assertFalse(one(v, "carries NO outputs"))
        self.assertFalse(one(v, "keeps outputs NULL"))

    def test_absent_columns_gap(self):
        v = m.c10_visibility_verdicts({"status": "failed"}, {})
        self.assertTrue(all(ok is None for _l, ok, _d in v), str(v))


class Routing(unittest.TestCase):
    def _rows(self):
        return [{"key": "/build_until_verified[1]/test", "status": "succeeded"},
                {"key": "/build_until_verified[1]/review", "status": "failed"}]

    def test_waiting_scope_and_failed_run_pass(self):
        v = m.c10_routing_verdicts(live={"status": "running", "outcome": None},
                                   final={"status": "failed", "outcome": None,
                                          "failed_cause": "attempt_limit"},
                                   run_status="failed", skipped_cond=0, iter_rows=self._rows())
        self.assertTrue(one(v, "STILL WAITING"))
        self.assertTrue(one(v, "never SUCCEEDED"))
        self.assertTrue(one(v, "NEVER completed"))
        self.assertTrue(one(v, "business reject"))
        self.assertTrue(one(v, "reports 'succeeded'"))

    def test_a_completed_run_is_the_silent_false_coercion(self):
        v = m.c10_routing_verdicts(live={"status": "succeeded", "outcome": "approved"},
                                   final={"status": "succeeded", "outcome": None,
                                          "failed_cause": None},
                                   run_status="completed", skipped_cond=3,
                                   iter_rows=[{"key": "/build_until_verified[1]/review",
                                               "status": "succeeded"}])
        self.assertFalse(one(v, "STILL WAITING"))
        self.assertFalse(one(v, "never SUCCEEDED"))
        self.assertFalse(one(v, "NEVER completed"))
        self.assertFalse(one(v, "business reject"))
        self.assertFalse(one(v, "reports 'succeeded'"))

    def test_business_termination_causes_fail_the_classification(self):
        for cause in ("until_exhausted", "not_approved"):
            v = m.c10_routing_verdicts(final={"status": "failed", "outcome": None,
                                              "failed_cause": cause}, run_status="failed")
            self.assertFalse(one(v, "business termination"), cause)

    def test_nothing_measured_gaps_every_arm(self):
        v = m.c10_routing_verdicts()
        self.assertTrue(all(ok is None for _l, ok, _d in v), str(v))


class Retry(unittest.TestCase):
    def _rows(self, n=2, ec="invalid_output", last=None):
        rows = [{"attempt_number": i, "status": "failed", "error_class": ec}
                for i in range(1, n + 1)]
        if last:
            rows[-1]["status"], rows[-1]["error_class"] = "succeeded", None
        return rows

    def test_two_attempts_of_invalid_output_pass(self):
        v = m.c10_retry_verdicts(self._rows(), retry_events=[{"error_class": "invalid_output"}])
        self.assertTrue(one(v, "RETRIED per policy"))
        self.assertTrue(one(v, "budget was respected"))
        self.assertTrue(one(v, "EVERY failed reviewer attempt"))
        self.assertTrue(one(v, "retry_scheduled names"))

    def test_no_second_attempt_fails_the_retry_arm(self):
        v = m.c10_retry_verdicts(self._rows(n=1), retry_events=[])
        self.assertFalse(one(v, "RETRIED per policy"))
        self.assertFalse(one(v, "retry_scheduled names"))

    def test_over_budget_fails(self):
        self.assertFalse(one(m.c10_retry_verdicts(self._rows(n=3)), "budget was respected"))

    def test_wrong_error_class_is_a_fail(self):
        v = m.c10_retry_verdicts(self._rows(ec="agent_error"))
        self.assertFalse(one(v, "EVERY failed reviewer attempt"))

    def test_retry_getting_it_right_gaps_when_the_fixture_cannot_flip(self):
        v = m.c10_retry_verdicts(self._rows())
        self.assertIsNone(one(v, "CONTINUES on a valid reply"))
        self.assertIn("make_fixture_repo.sh", detail(v, "CONTINUES on a valid reply"))

    def test_retry_getting_it_right_passes_on_a_real_success(self):
        v = m.c10_retry_verdicts(self._rows(n=2, last=True))
        self.assertTrue(one(v, "the retry gets it RIGHT"))


class Chat(unittest.TestCase):
    def test_no_model_chat_node_is_a_precise_gap(self):
        v = m.c10_chat_verdicts(None, endpoint_configured=False)
        self.assertIsNone(one(v, "model.chat fails identically"))
        self.assertIn("ADR-0024", detail(v, "model.chat fails identically"))
        self.assertIn("no provider endpoint", detail(v, "model.chat fails identically"))

    def test_a_model_chat_attempt_is_verdicted_like_any_other(self):
        v = m.c10_chat_verdicts(GOOD_ATT)
        self.assertTrue(one(v, "C10c its error_class"))
        self.assertTrue(all(l.startswith("C10c") for l, _o, _d in v), str(v))


class Doc(unittest.TestCase):
    TWIN = """apiVersion: communication.dev/v1alpha1
kind: Pipeline
metadata:
  name: feature-development-deterministic
spec:
  nodes:
  - id: build_until_verified
    kind: until
    config:
      body:
        nodes:
        - id: review
          kind: process.exec
          config:
            executable: m4-exit.sh
            args: [review]
          outputs:
            type: object
            required: [approved, evidence]
            properties:
              approved: {type: boolean}
              evidence: {type: string}
              findings: {type: array, items: {type: string}}
"""

    def test_the_single_splice_lands_and_nothing_else_moves(self):
        sp = m.c10_malformed_doc(self.TWIN, "m4x-c10-invalid-x")
        self.assertEqual(sp["missing"], [], str(sp["missing"]))
        self.assertIn("evidence: {type: boolean}", sp["doc"])
        self.assertIn("args: [review]", sp["doc"])
        self.assertIn("name: m4x-c10-invalid-x", sp["doc"])
        self.assertNotIn("evidence: {type: string}", sp["doc"])

    def test_the_doc_gate_passes_only_on_the_type_splice(self):
        sp = m.c10_malformed_doc(self.TWIN, "m4x-c10-invalid-y")
        v = m.c10_doc_verdicts(sp)
        self.assertTrue(all(ok is True for _l, ok, _d in v), str(v))

    def test_a_second_review_node_refuses_to_guess(self):
        two = self.TWIN + "        - id: review\n          kind: process.exec\n"
        sp = m.c10_malformed_doc(two, "m4x-c10-invalid-z")
        self.assertIsNone(sp["doc"])
        self.assertTrue(any("exactly one" in x for x in sp["missing"]), str(sp["missing"]))
        self.assertFalse(any(ok is True for _l, ok, _d in m.c10_doc_verdicts(sp)), str(sp))

    def test_a_non_pipeline_document_gaps(self):
        sp = m.c10_malformed_doc("apiVersion: v1\nkind: Thing\n", "n")
        self.assertIsNone(sp["doc"])
        self.assertTrue(sp["missing"])


class Words(unittest.TestCase):
    def test_helpers_never_pass_on_absent_evidence(self):
        """The README rule: an unmeasurable arm is None (GAP), never True."""
        for rows in (m.c10_attempt_verdicts(None), m.c10_visibility_verdicts(None, None),
                     m.c10_routing_verdicts(), m.c10_retry_verdicts([]),
                     m.c10_chat_verdicts(None), m.c10_doc_verdicts({})):
            self.assertTrue(any(ok is None for _l, ok, _d in rows),
                            f"{rows} passes with nothing measured")

    def test_c10_is_registered_not_stubbed(self):
        body = open(os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                 "e2e_m4_exit.py"), encoding="utf-8").read()
        body = body.split("def c10():")[1].split("def c11(")[0]
        self.assertEqual([g for g, _f in m.GATES].index("C10") + 1, 10)
        self.assertEqual(body.count('skip("C10"'), 1, "c10() is still a SKIP stub")
        for needle in ("c10_malformed_doc", "c10_attempt_verdicts", "c10_sample_failing_scope",
                       "c10_chat_verdicts", "c10_post_run"):
            self.assertIn(needle, body, needle)


if __name__ == "__main__":
    unittest.main(verbosity=2 if "-v" in sys.argv else 1)
