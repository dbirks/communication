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
import re
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import e2e_m4_exit as m  # noqa: E402 — importing the driver is the point
import yamlmini as yaml  # noqa: E402 — stdlib YAML subset (CI's python3 has no PyYAML)


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
                                   run_status="failed", skips=[], iter_rows=self._rows(),
                                   doc=SEEDED_GRAPH, inputs=SEEDED_INPUTS)
        self.assertTrue(one(v, "STILL WAITING"))
        self.assertTrue(one(v, "never SUCCEEDED"))
        self.assertTrue(one(v, "NEVER completed"))
        self.assertTrue(one(v, "rejected reply could"))
        self.assertTrue(one(v, "own inputs"))
        self.assertTrue(one(v, "reports 'succeeded'"))

    def test_a_completed_run_is_the_silent_false_coercion(self):
        v = m.c10_routing_verdicts(live={"status": "succeeded", "outcome": "approved"},
                                   final={"status": "succeeded", "outcome": None,
                                          "failed_cause": None},
                                   run_status="completed", iter_rows=[
                                       {"key": "/build_until_verified[1]/review",
                                        "status": "succeeded"}],
                                   skips=[{"key": "/publish_verified",
                                           "reason": "condition_default"}],
                                   doc=SEEDED_GRAPH, inputs=SEEDED_INPUTS)
        self.assertFalse(one(v, "STILL WAITING"))
        self.assertFalse(one(v, "never SUCCEEDED"))
        self.assertFalse(one(v, "NEVER completed"))
        self.assertFalse(one(v, "rejected reply could"))
        self.assertFalse(one(v, "reports 'succeeded'"))

    def test_business_termination_causes_fail_the_classification(self):
        for cause in ("until_exhausted", "not_approved"):
            v = m.c10_routing_verdicts(final={"status": "failed", "outcome": None,
                                              "failed_cause": cause}, run_status="failed")
            self.assertFalse(one(v, "business termination"), cause)

    def test_nothing_measured_gaps_every_arm(self):
        v = m.c10_routing_verdicts()
        self.assertTrue(all(ok is None for _l, ok, _d in v), str(v))


SEEDED_GRAPH = {
    "apiVersion": "communication.dev/v1alpha1", "kind": "Pipeline", "metadata": {"name": "t"},
    "spec": {"nodes": [
        {"id": "plan", "kind": "process.exec"},
        {"id": "approve", "kind": "human.approval", "dependsOn": ["plan"]},
        {"id": "build_until_verified", "kind": "until", "dependsOn": ["approve"]},
        {"id": "emit_items", "kind": "process.exec", "dependsOn": ["approve"],
         "when": "inputs.fanout == true"},
        {"id": "fan_out", "kind": "for_each", "dependsOn": ["emit_items"],
         "when": "inputs.fanout == true"},
        {"id": "verdict", "kind": "condition", "dependsOn": ["build_until_verified"]},
        {"id": "publish_verified", "kind": "artifact.publish", "dependsOn": ["verdict"],
         "when": "nodes.verdict.outputs.route == 'verified'"},
        {"id": "publish_needs_attention", "kind": "artifact.publish", "dependsOn": ["verdict"],
         "when": "nodes.verdict.outputs.route == 'needs_attention'"},
    ]},
}
# what the § 7.0 seed actually posts (seed.sh: fanout=false, fanout_count=0)
SEEDED_INPUTS = {"goal": "g", "repository": "app", "fanout": False, "fanout_count": 0}


class SkipAttribution(unittest.TestCase):
    """docs/m4-exit-status.md row C10b: the old arm ("no condition_default skip may
    appear") was unsatisfiable on the seeded graph, which skips /emit_items on
    inputs.fanout=false BY DESIGN (live4/C10.out:58 vs :76). The re-scoped pair must
    FAIL on a business-reject skip over the routing the failure could move, and must
    NOT fire on the skip the run's own inputs explain."""

    def watched(self):
        return m.c10_routing_watch(SEEDED_GRAPH)[0]

    def test_the_watch_set_is_derived_not_hard_coded(self):
        self.assertEqual(self.watched(), {"/build_until_verified", "/verdict",
                                          "/publish_verified", "/publish_needs_attention"})
        self.assertNotIn("/emit_items", self.watched(),
                         "the fan-out branch is not downstream of the failing reviewer")

    def test_a_condition_default_skip_on_a_verdict_target_FAILS(self):
        for key in ("/verdict", "/publish_verified", "/publish_needs_attention"):
            v = m.c10_skip_verdicts([{"key": key, "reason": "condition_default"}],
                                    doc=SEEDED_GRAPH, inputs=SEEDED_INPUTS)
            self.assertFalse(one(v, "rejected reply could"), key)

    def test_the_seeded_fanout_skip_does_NOT_fail_the_verdict(self):
        """live4/C10.out:76 — /emit_items skipped with condition_default while the run
        posted fanout=false: the graph's own `when`, not a routing change."""
        v = m.c10_skip_verdicts([{"key": "/emit_items", "reason": "condition_default"},
                                 {"key": "/fan_out", "reason": "dependency_skipped"}],
                                doc=SEEDED_GRAPH, inputs=SEEDED_INPUTS)
        self.assertTrue(one(v, "rejected reply could"), str(v))
        self.assertTrue(one(v, "own inputs"), str(v))

    def test_the_exclusion_is_the_input_value_never_the_node_name(self):
        """The SAME /emit_items skip on a run that POSTED fanout=true is unexplained —
        a gate that excused `/emit_items` by name would pass right here."""
        v = m.c10_skip_verdicts([{"key": "/emit_items", "reason": "condition_default"}],
                                doc=SEEDED_GRAPH, inputs={"fanout": True})
        self.assertFalse(one(v, "own inputs"), str(v))
        self.assertIn("should have RUN", detail(v, "own inputs"))

    def test_run_inputs_rows_are_read_as_validated_values(self):
        rows = [{"name": "fanout", "origin": "default", "value": "false"},
                {"name": "goal", "origin": "user", "value": '"g"'}]
        v = m.c10_skip_verdicts([{"key": "/emit_items", "reason": "condition_default"}],
                                doc=SEEDED_GRAPH, inputs=rows)
        self.assertTrue(one(v, "own inputs"), str(v))
        self.assertTrue(m.c10_inputs_map(rows)["fanout"] is False)
        self.assertEqual(m.c10_inputs_map(rows)["goal"], "g")

    def test_a_skip_no_input_can_explain_is_unattributable_not_passed(self):
        v = m.c10_skip_verdicts([{"key": "/publish_verified", "reason": "dependency_skipped"},
                                 {"key": "/?", "reason": "condition_default"}],
                                doc=SEEDED_GRAPH, inputs=SEEDED_INPUTS)
        self.assertIsNone(one(v, "own inputs"), str(v))
        self.assertTrue(one(v, "rejected reply could"), str(v))

    def test_a_scope_sampled_after_it_closed_is_a_gap_not_the_bug(self):
        """live4/C10.out:54's other half: the arm may only be graded on a row read
        WHILE the scope was waiting. A post-mortem row GAPs; it never becomes the
        routing FAIL."""
        # ADR-0075: the vocabulary is 00005's node_executions CHECK, not invented
        # names. `ready` is what an until scope actually sits at while its body's
        # attempt is being retried — live4 measured that row and threw it away.
        for waiting in ({"status": "running", "outcome": None},
                        {"status": "ready", "outcome": "-"},
                        {"status": "pending", "outcome": ""},
                        {"status": "leased", "outcome": ""},
                        {"status": "waiting", "outcome": None}):
            self.assertEqual(m.c10_live_scope(waiting), waiting, str(waiting))
        for late in ({"status": "succeeded", "outcome": "approved"},
                     {"status": "failed", "outcome": None, "failed_cause": "child_failed"},
                     {"status": "interrupted", "outcome": None},
                     {"status": "running", "outcome": "approved"}, {}, None):
            self.assertIsNone(m.c10_live_scope(late), str(late))

    def test_unreadable_skips_or_document_gap_never_pass(self):
        self.assertTrue(all(ok is None for _l, ok, _d in
                            m.c10_skip_verdicts(None, doc=SEEDED_GRAPH,
                                                inputs=SEEDED_INPUTS)))
        no_doc = m.c10_skip_verdicts([{"key": "/emit_items", "reason": "condition_default"}],
                                     doc=None, inputs=SEEDED_INPUTS)
        self.assertTrue(all(ok is None for _l, ok, _d in no_doc), str(no_doc))
        no_inputs = m.c10_skip_verdicts([{"key": "/emit_items", "reason": "condition_default"}],
                                        doc=SEEDED_GRAPH, inputs=None)
        self.assertTrue(any(ok is None for _l, ok, _d in no_inputs), str(no_inputs))

    def test_no_skips_at_all_is_a_clean_pass(self):
        v = m.c10_skip_verdicts([], doc=SEEDED_GRAPH, inputs=SEEDED_INPUTS)
        self.assertTrue(all(ok is True for _l, ok, _d in v), str(v))

    def test_a_document_with_nothing_to_walk_never_invents_a_watch_list(self):
        self.assertEqual(m.c10_routing_watch(None)[0], {})
        self.assertEqual(m.c10_routing_watch({"spec": {"nodes": []}})[0], {})
        self.assertEqual(m.c10_downstream_ids(SEEDED_GRAPH, "approve"),
                         ["build_until_verified", "emit_items", "fan_out",
                          "publish_needs_attention", "publish_verified", "verdict"])


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

    def test_retry_getting_it_right_gaps_only_until_the_authored_arm_grades_it(self):
        """The shipped fixture cannot flip its answer (seed.sh:306 says it answers
        byte-identically every attempt) and it must not be edited — so ADR-0075
        authors a marker-aware reviewer revision for this arm. Until that arm has
        produced a chain the row GAPs and NAMES the authored arm; once it has, the
        row is graded there and is never tallied twice from here."""
        v = m.c10_retry_verdicts(self._rows())
        self.assertIsNone(one(v, "CONTINUES on a valid reply"))
        d = detail(v, "CONTINUES on a valid reply")
        self.assertIn("make_fixture_repo.sh", d)
        self.assertIn("ADR-0075", d)
        self.assertEqual([], [l for l, _o, _dd in
                              m.c10_retry_verdicts(self._rows(), tilt_ran=True)
                              if "CONTINUES on a valid reply" in l])

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
    # a small until-body twin in the canonical-document shape (what
    # GET /revisions/{id} serves; the fixture's authored indentation is NOT the
    # splice target any more — RC3)
    TWIN = {
        "apiVersion": "communication.dev/v1alpha1",
        "kind": "Pipeline",
        "metadata": {"name": "feature-development-deterministic"},
        "spec": {"nodes": [
            {"id": "plan", "kind": "process.exec",
             "config": {"executable": "m4-exit.sh", "args": ["plan"]}},
            {"id": "build_until_verified", "kind": "until", "config": {"body": {"nodes": [
                {"id": "review", "kind": "process.exec",
                 "config": {"executable": "m4-exit.sh", "args": ["review"]},
                 "outputs": {"type": "object", "required": ["approved", "evidence"],
                             "properties": {
                                 "approved": {"type": "boolean"},
                                 "evidence": {"type": "string"},
                                 "findings": {"type": "array",
                                              "items": {"type": "string"}}}}},
            ]}}},
        ]},
    }

    def twin(self):
        return yaml.safe_load(yaml.safe_dump(self.TWIN, indent=4, sort_keys=True))

    def test_the_single_splice_lands_and_nothing_else_moves(self):
        frozen = yaml.safe_load(yaml.safe_dump(self.twin()))
        base = self.twin()
        sp = m.c10_malformed_doc(base, "m4x-c10-invalid-x")
        self.assertEqual(sp["missing"], [], str(sp["missing"]))
        self.assertEqual(frozen, base, "the splice must not mutate the caller's doc")
        self.assertIn("evidence: {type: boolean}", sp["doc"])
        self.assertIn("args: [review]", sp["doc"])
        self.assertIn("name: m4x-c10-invalid-x", sp["doc"])
        self.assertNotIn("evidence: {type: string}", sp["doc"])
        want = yaml.safe_load(yaml.safe_dump(frozen))
        want["metadata"]["name"] = "m4x-c10-invalid-x"
        review = want["spec"]["nodes"][1]["config"]["body"]["nodes"][0]
        review["outputs"]["properties"]["evidence"] = {"type": "boolean"}
        self.assertEqual(want, yaml.safe_load(sp["doc"]),
                         "only the declared type (and the gate's own name) moved")

    def test_the_splice_survives_route_14s_regenerated_shape(self):
        # RC3's literal output shape: 4-space indent, bullets indented under their
        # key, alphabetical keys, quoted short strings. The old byte splices found
        # `name:` at two spaces and `- id: review` as the bullet's first key — the
        # structural edit finds the value wherever the printer put it.
        reg = yaml.safe_dump(self.TWIN, indent=4, sort_keys=True)
        self.assertNotIn("- id: review", reg)      # the shape the regexes died on
        self.assertTrue(any(l == "    name: feature-development-deterministic"
                            for l in reg.splitlines()))
        sp = m.c10_malformed_doc(yaml.safe_load(reg), "m4x-c10-invalid-r")
        self.assertEqual([], sp["missing"], str(sp["missing"]))
        self.assertTrue(all(ok is True for _l, ok, _d in m.c10_doc_verdicts(sp)),
                        str(m.c10_doc_verdicts(sp)))

    def test_the_doc_gate_passes_only_on_the_type_splice(self):
        sp = m.c10_malformed_doc(self.twin(), "m4x-c10-invalid-y")
        v = m.c10_doc_verdicts(sp)
        self.assertTrue(all(ok is True for _l, ok, _d in v), str(v))

    def test_a_second_review_node_refuses_to_guess(self):
        two = yaml.safe_load(yaml.safe_dump(self.twin()))
        two["spec"]["nodes"][1]["config"]["body"]["nodes"].append(
            {"id": "review", "kind": "process.exec"})
        sp = m.c10_malformed_doc(two, "m4x-c10-invalid-z")
        self.assertIsNone(sp["doc"])
        self.assertTrue(any("exactly one" in x for x in sp["missing"]), str(sp["missing"]))
        self.assertFalse(any(ok is True for _l, ok, _d in m.c10_doc_verdicts(sp)), str(sp))

    def test_a_non_pipeline_document_gaps(self):
        for junk in ({"apiVersion": "v1", "kind": "Thing"}, "apiVersion: v1\nkind: Thing\n"):
            sp = m.c10_malformed_doc(junk, "n")
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


class C10cScratchDoc(unittest.TestCase):
    """The C10c scratch-pipeline authoring: TWO model.chat nodes — the malformed
    node (exact malformed reply, dependsOn the control) and the VALID-reply
    CONTROL node — each declaring the model.chat ENVELOPE on the node's OWN
    outputs (required [text, json], `json` = the seed reviewer's declared schema
    verbatim) and each carrying the PERMISSIVE config.responseSchema
    {type: object}: the endpoint only has to produce an object, so the
    instructed malformed reply IS producible, and the boundary's refusal lands
    on the reply's content (/json/...), never the envelope."""

    def twin(self):
        return yaml.safe_load(yaml.safe_dump(Doc.TWIN, indent=4, sort_keys=True))

    def test_two_nodes_envelope_and_permissive_wire(self):
        base = self.twin()
        review = base["spec"]["nodes"][1]["config"]["body"]["nodes"][0]
        sp = m.c10c_scratch_doc(base, "m4x-c10c-chat-x")
        self.assertEqual(sp["missing"], [], str(sp["missing"]))
        self.assertIsInstance(sp["doc"], str)
        doc = yaml.safe_load(sp["doc"])
        self.assertEqual(doc["kind"], "Pipeline")
        self.assertEqual(doc["metadata"]["name"], "m4x-c10c-chat-x")
        nodes = doc["spec"]["nodes"]
        self.assertEqual(len(nodes), 2,
                         "the scratch pipeline is the malformed node + the VALID control")
        by_id = {n["id"]: n for n in nodes}
        self.assertEqual(set(by_id), {m.C10C_CONTROL_NODE_ID, m.C10C_NODE_ID})
        env = m.c10c_envelope_outputs(review["outputs"])
        self.assertEqual(env["required"], ["text", "json"])
        self.assertEqual(env["properties"]["text"], {"type": "string"})
        self.assertEqual(env["properties"]["json"], review["outputs"],
                         "the reviewer's declared schema must sit in the json slot VERBATIM")
        for nid in (m.C10C_CONTROL_NODE_ID, m.C10C_NODE_ID):
            node = by_id[nid]
            self.assertEqual(node["kind"], "model.chat")
            self.assertEqual(node["retry"], {"maxAttempts": 1})
            cfg = node["config"]
            self.assertEqual(cfg["model"], m.C10C_MODEL,
                             "the default arm names the configured gateway model; "
                             "c10c_chat_model re-picks it off the WORKER's allowlist "
                             "when the configured one is not listed (the gateway "
                             "retired qwen3-8-27b — a literal here is a stale claim)")
            self.assertEqual(cfg["temperature"], 0)
            self.assertGreaterEqual(cfg["maxTokens"], m.C10C_MAX_TOKENS,
                                    "a reasoning model spends part of the budget thinking: "
                                    "200 tokens truncated the completion, and a truncated "
                                    "reply fails for a reason that is NOT the schema")
            self.assertEqual(cfg["reasoningEffort"], m.C10C_REASONING_EFFORT,
                             "ADR-0041's knob keeps the thinking bounded (the endpoint "
                             "may ignore it; the worker only sends it when set)")
            self.assertEqual(cfg["responseSchema"], {"type": "object"},
                             "the PERMISSIVE wire constraint: the endpoint only has to "
                             "produce an object, so the instructed reply is producible")
            self.assertEqual(node["outputs"], env,
                             "the node's OWN outputs is the ENVELOPE — the refusal must be "
                             "about the reply's content, not the envelope")
            self.assertTrue(all(k in ("role", "content") and v
                                for msg in cfg["messages"] for k, v in msg.items()))
        prompts = {n["id"]: [x for x in n["config"]["messages"] if x["role"] == "user"][0]["content"]
                   for n in nodes}
        self.assertIn(m.C10C_REPLY, prompts[m.C10C_NODE_ID])
        self.assertIn("${{ inputs.goal }}", prompts[m.C10C_NODE_ID])
        self.assertIn(m.C10C_CONTROL_REPLY, prompts[m.C10C_CONTROL_NODE_ID])
        self.assertNotIn(m.C10C_REPLY, prompts[m.C10C_CONTROL_NODE_ID],
                         "the control must be told the VALID reply only")
        self.assertEqual(by_id[m.C10C_NODE_ID]["dependsOn"], [m.C10C_CONTROL_NODE_ID],
                         "the malformed node runs AFTER the control, so the control's "
                         "success is measured before the malformed node can fail the run")

    def test_the_prompts_carry_the_malformed_and_the_valid_replies(self):
        sp = m.c10c_scratch_doc(self.twin(), "m4x-c10c-chat-y")
        # doc_yaml_emit renders the prompt as a YAML double-quoted scalar, so the
        # replies' quotes are escaped; unescape before asserting the shape.
        plain = sp["doc"].replace(chr(92) + chr(34), chr(34))
        self.assertIn("\"approved\": \"yes\"", plain)      # the malformed reply
        self.assertIn("\"evidence\": 42", plain)            # the malformed reply
        self.assertIn("\"approved\": true", plain)          # the VALID control reply
        self.assertEqual(sp["doc"].count("kind: model.chat"), 2)
        self.assertTrue(all(ok is True for _l, ok, _d in m.c10c_doc_verdicts(sp)),
                        str(m.c10c_doc_verdicts(sp)))

    def test_the_builder_does_not_mutate_the_source(self):
        frozen = yaml.safe_load(yaml.safe_dump(self.twin()))
        base = self.twin()
        m.c10c_scratch_doc(base, "m4x-c10c-chat-z")
        self.assertEqual(frozen, base, "the seed twin document must stay untouched")

    def test_no_review_node_or_wrong_schema_shape_is_a_refusal(self):
        no_review = self.twin()
        no_review["spec"]["nodes"][1]["config"]["body"]["nodes"] = []
        sp = m.c10c_scratch_doc(no_review, "m4x-c10c-norev")
        self.assertIsNone(sp["doc"])
        self.assertTrue(sp["missing"])
        two = self.twin()
        two["spec"]["nodes"][1]["config"]["body"]["nodes"].append(
            {"id": "review", "kind": "process.exec"})
        sp = m.c10c_scratch_doc(two, "m4x-c10c-two")
        self.assertIsNone(sp["doc"])
        self.assertTrue(any("exactly one" in x for x in sp["missing"]), str(sp["missing"]))
        bad = self.twin()
        rev = bad["spec"]["nodes"][1]["config"]["body"]["nodes"][0]
        rev["outputs"]["properties"]["approved"] = {"type": "string"}
        sp = m.c10c_scratch_doc(bad, "m4x-c10c-bad")
        self.assertIsNone(sp["doc"])
        self.assertTrue(sp["missing"], "a reviewer whose approved slot is not "
                                       "{type: boolean} cannot carry the C10 shape")
        for junk in ({"apiVersion": "v1", "kind": "Thing"}, "apiVersion: v1\n"):
            self.assertTrue(m.c10c_scratch_doc(junk, "m4x-c10c-junk")["missing"])


class C10cEnv(unittest.TestCase):
    """The C10c precondition probe: the worker reads COMMUNICATION_MODEL_CHAT_*
    (never the stale COMMUNICATION_MODEL_PROVIDER_BASE_URL), the endpoint is
    echoed as set/unset only, the allowlist is not a secret and is echoed."""

    def test_the_probe_names_the_worker_envs_and_never_echoes_the_url(self):
        cmd = m.c10c_env_probe_cmd()
        self.assertIn(m.C10C_BASE_URL_ENV, cmd)
        self.assertIn(m.C10C_MODELS_ENV, cmd)
        self.assertNotIn("COMMUNICATION_MODEL_PROVIDER_BASE_URL", cmd)
        self.assertIn("echo set", cmd)          # set/unset spelling only
        self.assertIn("printenv " + m.C10C_MODELS_ENV, cmd)
        self.assertNotIn("printenv " + m.C10C_BASE_URL_ENV, cmd)

    def test_the_probe_out_parser(self):
        self.assertEqual(m.c10c_env_probe_out("set\nqwen3-8-27b\n"),
                         (True, ["qwen3-8-27b"]))
        self.assertEqual(m.c10c_env_probe_out("set\na, b\n"), (True, ["a", "b"]))
        self.assertEqual(m.c10c_env_probe_out("set\n"), (True, []))
        self.assertEqual(m.c10c_env_probe_out("unset\n\n"), (False, []))
        self.assertEqual(m.c10c_env_probe_out("unset"), (False, []))
        for junk in ("", "  ", "garbage\nset\n", "set x\n"):
            self.assertEqual(m.c10c_env_probe_out(junk), (None, None))


class C10cArm(unittest.TestCase):
    """The C10c arm-result rule: a VALID model reply is a GAP, never a PASS; the
    NOTE carries the raw reply's size/shape, never its secrets."""

    MALFORMED_ATT = {"id": "a1", "status": "failed", "error_class": "invalid_output",
                     "output_errors": '[{"code": "response_schema_mismatch", '
                                      '"message": "at /approved: got string, want '
                                      'boolean | at /evidence: got number, want string"}]',
                     "outputs": "-"}
    VALID_ATT = {"id": "a1", "status": "succeeded", "error_class": "-",
                 "output_errors": "[]",
                 "outputs": m.json.dumps({"text": m.json.dumps(
                     {"approved": True, "evidence": "ok"}),
                     "model": "qwen3-8-27b"})}

    def test_a_valid_reply_is_a_gap_never_a_pass(self):
        att, note = m.c10c_arm_result(self.VALID_ATT)
        self.assertIsNone(att)
        self.assertIn("SUCCEEDED", note)
        self.assertIn("GAP", note)
        v = m.c10_chat_verdicts(None, endpoint_configured=True, arm_note=note)
        self.assertIsNone(one(v, "model.chat fails identically"))
        self.assertIn("SUCCEEDED", detail(v, "model.chat fails identically"))

    def test_a_malformed_reply_is_graded_like_c10a(self):
        att, note = m.c10c_arm_result(self.MALFORMED_ATT)
        self.assertIs(att, self.MALFORMED_ATT)
        self.assertIsNone(note)
        v = m.c10_chat_verdicts(att, endpoint_configured=True)
        self.assertTrue(one(v, "C10c the malformed reviewer attempt closed"))
        self.assertTrue(one(v, "C10c its error_class"))

    def test_no_attempt_row_keeps_the_gap(self):
        att, note = m.c10c_arm_result(None)
        self.assertIsNone(att)
        self.assertIn("no attempt row", note)
        v = m.c10_chat_verdicts(None, endpoint_configured=True, arm_note=note)
        self.assertIsNone(one(v, "model.chat fails identically"))

    def test_the_reply_note_never_prints_the_reply_bytes(self):
        note = m.c10c_reply_note(self.VALID_ATT)
        self.assertIn("chars", note)
        self.assertIn("json dict", note)
        self.assertIn("evidence", note)
        self.assertNotIn("qwen3", note)
        note = m.c10c_reply_note(self.MALFORMED_ATT)
        self.assertIn("got string, want boolean", note)
        self.assertIn("not recorded", note)

    def test_the_gate_wires_the_arm(self):
        body = open(os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                 "e2e_m4_exit.py"), encoding="utf-8").read()
        body = body.split("def c10():")[1].split("def c11(")[0]
        self.assertIn("c10c_scratch_arm", body)
        self.assertIn("c10_chat_precondition", body)


class C10cGuard(unittest.TestCase):
    """C10c honesty guard (live34 regression): the gate may PASS only on a
    schema violation of the MODEL'S REPLY. A config error that stopped the
    model before the call (e.g. invalid_model_chat_config) is a single FAIL —
    the status/class lines must not PASS for a reason that is not the claim —
    and the attempt's completion events are measured, not omitted."""

    CONFIG_ATT = {"id": "a1", "status": "failed", "error_class": "invalid_output",
                  "output_errors": '[{"code": "invalid_model_chat_config", '
                                   '"message": "model.chat: config.temperature must be '
                                   'a number between 0 and 2"}]',
                  "outputs": "-"}

    def test_config_error_is_a_single_fail_not_status_class_passes(self):
        v = m.c10_chat_verdicts(self.CONFIG_ATT, completed_seen=False)
        self.assertEqual(len(v), 1, str(v))
        self.assertFalse(one(v, "failed for a reason other than its reply's schema"))
        d = detail(v, "failed for a reason other than its reply's schema")
        self.assertIn("invalid_model_chat_config", d)
        for l, _o, _dd in v:
            self.assertNotIn("C10c the malformed reviewer attempt closed", l)
            self.assertNotIn("C10c its error_class", l)
            self.assertNotIn("output_errors is populated", l)

    def test_schema_violation_named_by_code_and_reply_path_is_graded(self):
        att = {"id": "a2", "status": "failed", "error_class": "invalid_output",
               "output_errors": '[{"code": "response_schema_mismatch", '
                                '"message": "at /approved: got string, want boolean"}]',
               "outputs": "-"}
        self.assertIsNone(m.c10c_non_schema_reason(att))
        v = m.c10_chat_verdicts(att, completed_seen=False)
        self.assertTrue(one(v, "C10c the malformed reviewer attempt closed"))
        self.assertTrue(one(v, "C10c its error_class"))

    def test_plain_json_schema_entries_pass_the_guard(self):
        self.assertIsNone(m.c10c_non_schema_reason(GOOD_ATT))
        self.assertIsNone(m.c10c_non_schema_reason({"status": "failed",
                                                    "output_errors": BAD}))

    def test_unreadable_or_empty_output_errors_fail(self):
        for raw in (None, "not json", "[]"):
            att = dict(self.CONFIG_ATT, output_errors=raw)
            v = m.c10_chat_verdicts(att)
            self.assertFalse(one(v, "failed for a reason other than its reply's schema"),
                             repr(raw))

    def test_completed_seen_is_measured_not_omitted(self):
        v = m.c10_chat_verdicts(GOOD_ATT, completed_seen=True)
        self.assertFalse(one(v, "NO node.attempt.completed"))
        v = m.c10_chat_verdicts(GOOD_ATT, completed_seen=False)
        self.assertTrue(one(v, "NO node.attempt.completed"))
        v = m.c10_chat_verdicts(GOOD_ATT, completed_seen=None)
        self.assertIsNone(one(v, "NO node.attempt.completed"))

    def test_the_gate_wires_completed_for_the_c10c_attempt(self):
        body = open(os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                 "e2e_m4_exit.py"), encoding="utf-8").read()
        body = body.split("def c10():")[1].split("def c11(")[0]
        i = body.index("c10_chat_verdicts(")
        tail = body[i:i + 400]
        self.assertIn("completed_seen=c10_completed_for(", tail)


class C10cReplyLocation(unittest.TestCase):
    """The pass-36 regression (offline): C10c must grade the boundary refusing
    the MALFORMED REPLY — every attempts.output_errors instance_location under
    /json (the envelope's json slot holds the reviewer schema) — not the
    model.chat ENVELOPE missing fields (a violation at / or /text fires for a
    VALID reply too and is not the claim)."""

    REPLY_ATT = {"id": "a1", "status": "failed", "error_class": "invalid_output",
                 "output_errors": m.json.dumps([
                     {"keyword": "type",
                      "location": "#/properties/json/properties/approved/type",
                      "instance_location": "/json/approved",
                      "message": "expected boolean, got string"},
                     {"keyword": "type",
                      "location": "#/properties/json/properties/evidence/type",
                      "instance_location": "/json/evidence",
                      "message": "expected string, got number"}]),
                 "outputs": "-"}

    def test_a_refusal_at_the_envelope_is_not_the_claim(self):
        for inst in ("/", "/text", "/model"):
            att = {"id": "a9", "status": "failed", "error_class": "invalid_output",
                   "output_errors": m.json.dumps([{"keyword": "required",
                                                   "location": "#",
                                                   "instance_location": inst,
                                                   "message": "missing property "
                                                   "'approved'"}]),
                   "outputs": "-"}
            v = m.c10c_reply_location_verdict(att)
            self.assertFalse(one(v, "not the envelope"), repr(inst))
            self.assertIn("instance_location", detail(v, "not the envelope"), inst)

    def test_the_malformed_reply_refusal_under_json_passes(self):
        v = m.c10c_reply_location_verdict(self.REPLY_ATT)
        self.assertTrue(one(v, "not the envelope"), str(v))
        d = detail(v, "not the envelope")
        self.assertIn("/json/approved", d)
        self.assertIn("/json/evidence", d)

    def test_no_instance_location_recorded_is_a_fail_not_a_pass(self):
        att = {"id": "a2", "status": "failed", "error_class": "invalid_output",
               "output_errors": "[]", "outputs": "-"}
        self.assertFalse(one(m.c10c_reply_location_verdict(att), "not the envelope"))

    def test_no_attempt_row_is_a_gap(self):
        self.assertIsNone(one(m.c10c_reply_location_verdict(None), "not the envelope"))

    def test_the_locations_are_extracted_from_the_worker_entry_shape(self):
        self.assertEqual(m.c10c_reply_instance_locations(self.REPLY_ATT),
                         ["/json/approved", "/json/evidence"])
        self.assertEqual(m.c10c_reply_instance_locations(GOOD_ATT), [])
        self.assertEqual(m.c10c_reply_instance_locations(None), [])

    def test_the_verdict_rides_into_the_c10c_gate(self):
        v = m.c10_chat_verdicts(self.REPLY_ATT, completed_seen=False)
        self.assertTrue(one(v, "not the envelope"), str(v))
        self.assertTrue(one(v, "C10c the malformed reviewer attempt closed"))
        envelope = {"id": "a3", "status": "failed", "error_class": "invalid_output",
                    "output_errors": m.json.dumps([{"keyword": "required",
                                                    "location": "#",
                                                    "instance_location": "/",
                                                    "message": "missing property "
                                                    "'approved'"}]),
                    "outputs": "-"}
        v = m.c10_chat_verdicts(envelope, completed_seen=False)
        self.assertFalse(one(v, "not the envelope"),
                         "an envelope-level refusal must FAIL the C10c gate")


class C10cControl(unittest.TestCase):
    """C10c's CONTROL (offline): the SAME declarations with the VALID reply
    {\"approved\": true, \"evidence\": \"ok\"} must SUCCEED — a failed control means
    the declaration itself is unsatisfiable, so the malformed refusal proves
    nothing and C10c FAILs."""

    GOOD_CTRL = {"status": "succeeded",
                 "outputs": m.json.dumps({"text": m.json.dumps(
                     {"approved": True, "evidence": "ok"}),
                     "model": "qwen3-8-27b",
                     "json": {"approved": True, "evidence": "ok"}})}

    def test_the_valid_reply_succeeds_with_approved_true(self):
        v = m.c10c_control_verdicts(self.GOOD_CTRL)
        self.assertTrue(one(v, "SUCCEEDED"), str(v))
        self.assertTrue(one(v, "outputs.json.approved is true"), str(v))

    def test_a_failed_control_is_a_fail_never_a_gap_or_pass(self):
        v = m.c10c_control_verdicts({"status": "failed", "outputs": "-"})
        self.assertFalse(one(v, "SUCCEEDED"), str(v))
        v = m.c10c_control_verdicts({"status": "succeeded", "outputs": "-"})
        self.assertTrue(one(v, "SUCCEEDED"))
        self.assertIsNone(one(v, "outputs.json.approved is true"))

    def test_an_unreadable_control_row_gaps_never_passes(self):
        for ctrl in (None, {}, {"status": None}):
            v = m.c10c_control_verdicts(ctrl)
            self.assertTrue(all(ok is None for _l, ok, _d in v), repr(ctrl))

    def test_the_control_rides_into_the_c10c_gate(self):
        v = m.c10_chat_verdicts(C10cReplyLocation.REPLY_ATT, control=self.GOOD_CTRL)
        self.assertTrue(one(v, "SUCCEEDED"))
        self.assertTrue(one(v, "outputs.json.approved is true"))
        v = m.c10_chat_verdicts(C10cReplyLocation.REPLY_ATT,
                                control={"status": "failed", "outputs": "-"})
        self.assertFalse(one(v, "SUCCEEDED"),
                         "a failed control means the declaration is unsatisfiable: "
                         "the C10c gate must FAIL")
        v = m.c10_chat_verdicts(C10cReplyLocation.REPLY_ATT)
        self.assertFalse(any("control" in l for l, _o, _d in v),
                         "no control row passed: no control verdicts invented")

    def test_the_gate_wires_the_control_row(self):
        body = open(os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                 "e2e_m4_exit.py"), encoding="utf-8").read()
        body = body.split("def c10():")[1].split("def c11(")[0]
        i = body.index("c10_chat_verdicts(")
        self.assertIn("control=ctrl", body[i:i + 400])
        self.assertIn("c10c_scratch_arm(alice, facts)", body)


class C10cLabCause(unittest.TestCase):
    """C10c's GAP must NAME the measured cause of an unset worker endpoint:
    the running worker-a container's compose config_files label is read (the
    same label C14 recreates from) and compose.real.yml — the ONLY layer in
    the repo that sets COMMUNICATION_MODEL_CHAT_BASE_URL (the endpoint is
    worker process env by design; a model.chat node can never choose its own
    endpoint) — is looked for BY NAME among the files the container reports.
    An unreadable label invents no cause; the gate never blames a file the
    container does not mention."""

    THREE = ["/lab/compose.yml", "/lab/compose.harness.yml", "/lab/compose.m4.yml"]
    FOUR = THREE + ["/lab/compose.real.yml"]

    def test_missing_overlay_is_named_as_the_cause(self):
        cause, names = m.c10c_endpoint_cause(self.THREE)
        self.assertIn("compose.real.yml", cause)
        self.assertIn("not among", cause)
        self.assertIn("--up", cause)  # the driver's own bring-up is the named gap
        self.assertEqual(names, ["compose.yml", "compose.harness.yml", "compose.m4.yml"])

    def test_unreadable_label_invents_no_cause(self):
        for files in (None, [], ["", "  "], ["<no value>"], ["null"]):
            cause, names = m.c10c_endpoint_cause(files)
            self.assertIsNone(cause, repr(files))
            self.assertEqual(names, [], repr(files))

    def test_overlay_present_but_endpoint_unset_is_its_own_cause(self):
        cause, names = m.c10c_endpoint_cause(self.FOUR)
        self.assertIn("compose.real.yml", cause)
        self.assertIn("IS among", cause)
        self.assertIn("unset", cause)
        self.assertNotIn("not among", cause)
        self.assertEqual(names[-1], "compose.real.yml")

    def test_the_gap_carries_the_measured_cause(self):
        v = m.c10_chat_verdicts(None, endpoint_configured=False,
                                cause="composed from [compose.yml] — "
                                      "compose.real.yml is not among them")
        self.assertIsNone(one(v, "model.chat fails identically"))
        d = detail(v, "model.chat fails identically")
        self.assertIn("measured cause", d)
        self.assertIn("compose.real.yml", d)

    def test_a_measured_attempt_row_never_wears_the_lab_cause(self):
        v = m.c10_chat_verdicts(GOOD_ATT, cause="whatever the label said")
        self.assertTrue(all("measured cause" not in d for _l, _o, d in v), str(v))

    def test_the_leg_requirements_name_the_env_only_endpoint_and_the_fixture(self):
        req = " | ".join(m.c10c_leg_requirements())
        self.assertIn("COMMUNICATION_LLM_BASE_URL", req)
        self.assertIn("COMMUNICATION_LLM_MODEL", req)
        self.assertIn("LLMC_API_KEY", req)
        self.assertIn("172.17.0.1", req)          # the bridge route C11 proves
        self.assertIn("chat/completions", req)    # the fixture is OpenAI-shaped
        self.assertIn(m.C10C_REPLY, req)          # malformed reply served on demand
        self.assertIn(m.C10C_CONTROL_REPLY, req)  # and the valid control reply
        self.assertIn("NO edit", req)             # compose.real.yml is NOT edited
        self.assertIn("NO change", req)           # the other three files do not move

    def test_the_gate_wires_the_cause(self):
        full = open(os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                 "e2e_m4_exit.py"), encoding="utf-8").read()
        body = full.split("def c10():")[1].split("def c11(")[0]
        self.assertIn("chat_att, endpoint, cause = c10_chat_precondition(run_id)", body)
        i = body.index("c10_chat_verdicts(")
        self.assertIn("cause=cause", body[i:i + 400])
        pre = full.split("def c10():")[0]
        self.assertIn("c10c_precondition_cause", pre)
        self.assertIn("c14_container_compose_labels(WORKER_A)", pre)



class C10bLiveVocabulary(unittest.TestCase):
    """§ 7.1 C10b's 'the ledger read shows the scope still waiting on the attempt',
    with the vocabulary read off 00005's OWN node_executions CHECK instead of
    invented (ADR-0075). live4/C10.out:41 had already MEASURED a `ready` until-scope
    row and threw it away as 'already closed' because the old tuple did not name
    'ready' — a GAP on a row the driver was holding."""

    MIGRATION = os.path.join(os.path.dirname(os.path.abspath(__file__)), os.pardir,
                             os.pardir, "internal", "store", "postgres", "migrations",
                             "00005_m4_pipelines.sql")

    def read(self):
        with open(self.MIGRATION, encoding="utf-8") as fh:
            return fh.read()

    def _node_statuses(self):
        """(terminal, non-terminal) straight out of 00005: the column CHECK names every
        status the table can hold, `node_executions_terminal_timestamped` names which
        of them are terminal. The live set is the difference — exactly what § 7.1
        C10b's 'still waiting on the attempt' needs."""
        src = self.read()
        held = re.search(r"status\s+text\s+NOT NULL DEFAULT 'pending'\s*\n\s*"
                         r"CHECK \(status IN \(([^)]*)\)\)", src)
        term = re.search(r"CONSTRAINT node_executions_terminal_timestamped\s+CHECK "
                         r"\(status NOT IN \(([^)]*)\)", src)
        self.assertIsNotNone(held, "no node_executions status IN (...) column CHECK")
        self.assertIsNotNone(term, "no node_executions_terminal_timestamped CONSTRAINT")
        split = lambda blob: [x.strip().strip("'") for x in blob.split(",") if x.strip()]
        all_st, terminal = split(held.group(1)), split(term.group(1))
        return terminal, [x for x in all_st if x not in terminal]

    def test_the_vocabulary_IS_the_migrations_check(self):
        term, live = self._node_statuses()
        self.assertEqual(sorted(live), sorted(m.C10_WAITING),
                         "C10b's live set drifted from the ledger's non-terminal vocabulary")
        self.assertEqual(sorted(term), sorted(m.C10_TERMINAL_NODE_STATES),
                         "C10b's terminal set drifted from the ledger's terminal vocabulary")
        self.assertEqual(set(live) & set(term), set(), "a status cannot be both")
        self.assertEqual(["pending", "ready", "leased", "running", "waiting"], live,
                         "00005's own non-terminal vocabulary moved — so must the arm")
        self.assertIn("ready", m.C10_WAITING, "the status live4 measured and discarded")

    def test_the_c4c_amendment_quotes_the_real_constraint(self):
        """ADR-0075's C4c half rests on ONE sentence of schema. If it ever stops being
        the schema's sentence, the amendment has to be re-read, not re-quoted."""
        src = " ".join(self.read().split())
        self.assertIn("CONSTRAINT attempts_terminal_timestamped CHECK ((status IN "
                      "('succeeded','failed', 'cancelled','interrupted')) = "
                      "(finished_at IS NOT NULL))", src)

    def test_ready_is_a_live_sample(self):
        """The exact row live4 discarded: an until scope sits at `ready` with no
        outcome while its body's attempt is being retried."""
        row = {"key": m.C10_UNTIL_KEY, "status": "ready", "outcome": "-"}
        self.assertEqual(m.c10_live_scope(row), row)
        self.assertEqual(m.c10_live_scope_why(row), "")
        for st, _t in [("pending", 0), ("leased", 0), ("running", 0), ("waiting", 0)]:
            self.assertEqual(m.c10_live_scope({"status": st, "outcome": None}),
                             {"status": st, "outcome": None}, st)

    def test_a_terminal_or_outcome_carrying_row_is_not_a_sample_and_says_why(self):
        for row, needle in (({"status": "succeeded", "outcome": "approved"}, "terminal"),
                            ({"status": "failed", "outcome": None,
                              "failed_cause": "child_failed"}, "terminal"),
                            ({"status": "running", "outcome": "approved"}, "outcome")):
            self.assertIsNone(m.c10_live_scope(row), str(row))
            self.assertIn(needle, m.c10_live_scope_why(row), str(row))

    def test_an_unknown_status_is_never_quietly_a_live_sample(self):
        """A run status ('waiting_human') is NOT a node_executions status, and the
        old tuple mixed the two vocabularies. An unrecognised row says so."""
        for st in ("waiting_human", "queued", "", "succeeded_elsewhere"):
            self.assertIsNone(m.c10_live_scope({"status": st, "outcome": None}), st)
            self.assertIn("no vocabulary", m.c10_live_scope_why({"status": st,
                                                                 "outcome": None}), st)
        self.assertIn("did not read", m.c10_live_scope_why(None))
        self.assertIn("did not read", m.c10_live_scope_why({}))


class C10bTiltArm(unittest.TestCase):
    """ADR-0075's authored retry arm: the seed twin's shipped reviewer answers
    byte-identically on EVERY attempt (docs/compatibility/probes/m4/seed.sh:306 says
    so), and make_fixture_repo.sh must not be edited — so the gate authors its OWN
    reviewer revision whose step counts its attempts in the run workspace's scratch
    and answers malformed once, then valid. These tests prove the authoring is the
    one-node change it claims to be and that the verdict algebra fails loudly."""

    TWIN = {
        "apiVersion": "communication.dev/v1alpha1", "kind": "Pipeline",
        "metadata": {"name": "feature-development-deterministic"},
        "spec": {"nodes": [
            {"id": "plan", "kind": "process.exec",
             "config": {"executable": "m4-exit.sh", "args": ["plan"]}},
            {"id": "build_until_verified", "kind": "until",
             "config": {"maxIterations": 4, "carryForward": True,
                        "passWhen": "nodes.review.outputs.approved == true",
                        "body": {"nodes": [
                            {"id": "implement", "kind": "process.exec",
                             "config": {"executable": "m4-exit.sh", "args": ["implement"]}},
                            {"id": "review", "kind": "process.exec",
                             "config": {"executable": "m4-exit.sh", "args": ["review"]},
                             "retry": {"maxAttempts": 2,
                                       "backoff": {"baseSeconds": 5, "multiplier": 2,
                                                   "maxSeconds": 60, "jitter": True},
                                       "retriableErrors": ["infra", "interrupted"]},
                             "outputs": {"type": "object",
                                         "required": ["approved", "evidence"],
                                         "properties": {"approved": {"type": "boolean"},
                                                        "evidence": {"type": "string"}}}},
                        ]}}},
        ]},
    }

    def twin(self):
        return yaml.safe_load(yaml.safe_dump(self.TWIN, indent=4, sort_keys=True))

    def review(self, doc):
        return doc["spec"]["nodes"][1]["config"]["body"]["nodes"][1]

    def test_only_the_reviewers_step_cwd_retry_and_the_bound_move(self):
        base = self.twin()
        frozen = yaml.safe_load(yaml.safe_dump(base))
        sp = m.c10b_tilt_doc(base, "m4x-c10-tilt-a")
        self.assertEqual(sp["missing"], [], str(sp["missing"]))
        self.assertEqual(frozen, base, "the author must not mutate the caller's document")
        want = yaml.safe_load(yaml.safe_dump(frozen))
        want["metadata"]["name"] = "m4x-c10-tilt-a"
        want["spec"]["nodes"][1]["config"]["maxIterations"] = 3
        node = want["spec"]["nodes"][1]["config"]["body"]["nodes"][1]
        node["config"]["executable"] = m.C10B_TILT_STEP
        node["config"]["args"] = ["-c", m.c10b_tilt_script()]
        node["config"]["cwd"] = m.C10B_TILT_CWD
        # The backoff is WIDENED in place: the seed's own shape survives with its
        # window pulled out, so a diff of the document shows the retry's timing and
        # nothing else about the retry policy moving.
        node["retry"]["backoff"] = {"baseSeconds": m.C10B_TILT_BACKOFF_S, "multiplier": 1,
                                   "maxSeconds": m.C10B_TILT_BACKOFF_S, "jitter": False}
        node["retry"]["maxAttempts"] = m.C10B_TILT_MAX_ATTEMPTS
        node["retry"]["retriableErrors"] = ["infra", "interrupted", "invalid_output"]
        # Pinned, not inherited: a retry that restored a checkpoint would wipe the
        # scratch counter and the reviewer would answer malformed forever.
        node["retry"]["workspacePolicy"] = "continue_workspace"
        self.assertEqual(want, yaml.safe_load(sp["doc"]),
                         "the authored arm moved a node other than the reviewer's step, "
                         "cwd and backoff (or the loop bound)")
        self.assertNotIn("m4-exit.sh", sp["doc"].split("id: review")[1].split("id: ")[0]
                         .split("retry:")[0],
                         "the reviewer's step is the authored one, not the shipped helper")

    def test_the_authored_step_counts_once_and_flips_its_answer(self):
        script = m.c10b_tilt_script()
        self.assertIn(m.C10B_TILT_MARKER, script)
        self.assertIn('if [ "$tries" -le 1 ]', script)
        self.assertIn(m.C10B_MALFORMED_REPLY, script)
        self.assertIn(m.C10B_VALID_REPLY, script)
        self.assertIn('"$tries" -le 1', script)
        # The malformed answer must be the § 7.1 C10a literal: a STRING for approved.
        self.assertIn('"approved": "yes"', m.C10B_MALFORMED_REPLY)
        self.assertIn('"approved": true', m.C10B_VALID_REPLY)
        self.assertIsNone(re.search(r"(^|[;&|]\s*)(rm|unlink)(\s|$)", script),
                          "the reviewer's step may count a file, never delete one")
        self.assertNotIn("$(", script.replace("$((", "<arith>("))
        self.assertNotIn("`", script)
        self.assertIn("$((", script), "the counter is shell arithmetic, not a subshell call"

    def test_the_author_refuses_a_twin_it_cannot_tilt(self):
        for mutate, needle in (
                (lambda d: d["spec"]["nodes"][1]["config"].pop("maxIterations"),
                 "maxIterations"),
                (lambda d: d["spec"]["nodes"][1]["config"].__setitem__("maxIterations", 2),
                 "iteration 2"),
                (lambda d: self.review(d)["outputs"]["properties"]["approved"].update(
                    {"type": "string"}), "boolean"),
                (lambda d: d["spec"]["nodes"][1]["config"]["body"]["nodes"].pop(1),
                 "review node")):
            doc = self.twin()
            mutate(doc)
            sp = m.c10b_tilt_doc(doc, "m4x-c10-tilt-r")
            self.assertIsNone(sp["doc"], str(mutate))
            self.assertTrue(any(needle in x for x in sp["missing"]),
                            f"{needle}: {sp['missing']}")
            self.assertFalse(any(ok is True for _l, ok, _d in m.c10b_tilt_doc_verdicts(sp)),
                             str(m.c10b_tilt_doc_verdicts(sp)))

    def test_the_honesty_gate_passes_only_the_authored_shape(self):
        sp = m.c10b_tilt_doc(self.twin(), "m4x-c10-tilt-b")
        v = m.c10b_tilt_doc_verdicts(sp)
        self.assertTrue(all(ok is True for _l, ok, _d in v), str(v))
        self.assertTrue(any("approved" in l and "BOOLEAN" in l for l, _o, _d in v), str(v))
        self.assertTrue(any("continue_workspace" in l for l, _o, _d in v),
                        "the counter's survival is a graded claim, not an assumption")
        self.assertTrue(any(m.C10B_TILT_MARKER in l for l, _o, _d in v), str(v))

    def test_attempt_chain_helper(self):
        ok, first, right, n = m.c10b_attempt_chain_ok(
            [{"attempt_number": 1, "status": "failed", "error_class": "invalid_output"},
             {"attempt_number": 2, "status": "succeeded", "error_class": "-"}])
        self.assertEqual((ok, first, right, n), (True, True, True, 2))
        self.assertEqual(m.c10b_attempt_chain_ok([])[:2], (False, False))
        self.assertEqual(m.c10b_attempt_chain_ok(None)[:2], (False, False))
        self.assertEqual(m.c10b_attempt_chain_ok(
            [{"attempt_number": 1, "status": "failed", "error_class": "agent_error"}])[:3],
            (True, False, False))

    CHAIN = [{"attempt_number": 1, "status": "failed", "error_class": "invalid_output"},
             {"attempt_number": 2, "status": "succeeded", "error_class": "-"}]
    ITERS = [{"n": 1, "node": "review", "status": "succeeded"},
             {"n": 2, "node": "implement", "status": "succeeded"}]
    LIVE = {"status": "ready", "outcome": "-"}

    def test_the_arm_passes_on_the_measured_shape(self):
        v = m.c10b_tilt_verdicts(chain=self.CHAIN, live=self.LIVE, live_why="",
                                iter_rows=self.ITERS, run_st="completed", completed=True)
        self.assertNotIn(False, [ok for _l, ok, _d in v], str(v))
        self.assertTrue(one(v, "FIRST attempt closed failed|invalid_output"))
        self.assertTrue(one(v, "CONTINUES on a valid reply"))
        self.assertTrue(one(v, "mid-failure sample"))

    def test_the_arm_fails_when_the_marker_never_flipped(self):
        v = m.c10b_tilt_verdicts(
            chain=[{"attempt_number": 1, "status": "failed", "error_class": "invalid_output"},
                   {"attempt_number": 2, "status": "failed", "error_class": "invalid_output"}],
            live=self.LIVE, live_why="", iter_rows=[{"n": 1, "node": "review",
                                                     "status": "failed"}],
            run_st="failed", completed=False)
        self.assertIs(False, one(v, "CONTINUES on a valid reply"))
        self.assertIs(False, one(v, "node.attempt.completed reached"))

    def test_the_arm_fails_when_a_reply_was_accepted_while_nothing_waited(self):
        v = m.c10b_tilt_verdicts(
            chain=self.CHAIN, live={"status": "succeeded", "outcome": "approved"},
            live_why="the scope row read back terminal ('succeeded') — a post-mortem row",
            iter_rows=self.ITERS, run_st="completed", completed=True)
        self.assertIs(False, one(v, "mid-failure sample"))
        self.assertIn("post-mortem", detail(v, "mid-failure sample"),
                      "the row that FAILs carries the closed window — no second line")

    def test_the_arm_gaps_only_on_rows_that_never_arrived(self):
        v = m.c10b_tilt_verdicts(chain=[], live=None,
                                live_why="the tilt run reached 'failed' before a live "
                                         "mid-failure scope row could be read",
                                iter_rows=[], run_st="", completed=None)
        self.assertIsNone(one(v, "FIRST attempt closed"))
        self.assertIsNone(one(v, "CONTINUES on a valid reply"))
        self.assertIsNone(one(v, "mid-failure sample"))
        self.assertIn("reached 'failed' before a live", detail(v, "mid-failure sample"),
                      "the GAP says the window it could not land")
        self.assertIsNone(one(v, "node.attempt.completed reached"))
        self.assertEqual([], [l for l, _o, _d in v if "window that closed" in l],
                         "one claim, one row: the why rides in the row it explains")

    def test_an_unpublished_arm_never_passes_the_retry_claim(self):
        v = m.c10b_tilt_verdicts(chain=self.CHAIN, live=self.LIVE, iter_rows=self.ITERS,
                                 run_st="completed", completed=True, published=False)
        self.assertIsNone(one(v, "CONTINUES on a valid reply"))
        self.assertEqual(1, len(v), str(v))


class C10bRetryHandoff(unittest.TestCase):
    """The malformed twin's chain still carries C10a; the 'retry gets it right' claim
    moves to the authored arm (ADR-0075) and must be graded ONCE."""
    CHAIN = [{"attempt_number": 1, "status": "failed", "error_class": "invalid_output"},
             {"attempt_number": 2, "status": "failed", "error_class": "invalid_output"}]

    def test_all_malformed_attempts_gap_and_name_the_authored_arm(self):
        v = m.c10_retry_verdicts(self.CHAIN, retry_events=[{"error_class": "invalid_output"}])
        self.assertIsNone(one(v, "CONTINUES on a valid reply"))
        d = detail(v, "CONTINUES on a valid reply")
        self.assertIn("ADR-0075", d)
        self.assertIn("make_fixture_repo.sh", d)
        self.assertIn("did not run", d)

    def test_the_gap_is_not_printed_twice_when_the_authored_arm_graded_it(self):
        v = m.c10_retry_verdicts(self.CHAIN, retry_events=[], tilt_ran=True,
                                tilt_why="the tilt run reached 'failed' early")
        self.assertEqual([], [l for l, _o, _d in v if "CONTINUES on a valid reply" in l],
                         str(v))
        self.assertTrue(one(v, "RETRIED per policy"), "the chain's own claims still grade")

    def test_a_real_success_on_the_malformed_chain_still_passes_here(self):
        chain = self.CHAIN[:1] + [{"attempt_number": 2, "status": "succeeded",
                                   "error_class": "-"}]
        v = m.c10_retry_verdicts(chain, tilt_ran=False)
        self.assertTrue(one(v, "retry gets it RIGHT"))


class C10bRoutingTakesTheAuthoredSample(unittest.TestCase):
    """The routing claim ('the scope was STILL WAITING when the reply was rejected, so
    `approved: \'yes\' == true` was never reached') is a statement about a WINDOW, and
    the malformed twin's window is shipped-speed: live4/C10.out:41 sampled 420 s and
    never landed a non-terminal row. ADR-0075's authored arm widens the retry backoff
    and lands it — so the row is graded from that sample, SAYING where it came from,
    instead of GAPping while an equally true row sits unused."""

    FINAL = {"status": "failed", "outcome": "-", "failed_cause": "child_failed"}

    def test_its_own_sample_still_wins(self):
        v = m.c10_routing_verdicts(live={"status": "running", "outcome": None},
                                   final=self.FINAL, run_status="failed",
                                   tilt_live={"status": "ready", "outcome": "-"})
        d = detail(v, "STILL WAITING")
        self.assertTrue(one(v, "STILL WAITING"))
        self.assertIn("the malformed twin's own sample", d, d)
        self.assertIn("'running'", d)

    def test_the_authored_sample_grads_the_row_when_the_twins_window_closed(self):
        v = m.c10_routing_verdicts(live=None, live_why="the scope row read back terminal",
                                   final=self.FINAL, run_status="failed",
                                   tilt_live={"status": "ready", "outcome": "-"})
        self.assertIs(True, one(v, "STILL WAITING"), str(v))
        d = detail(v, "STILL WAITING")
        self.assertIn("authored arm", d)
        self.assertIn("ready", d)
        self.assertIn("pending", d, "the row names the vocabulary it measured against")

    def test_a_leak_on_the_authored_sample_is_still_a_fail(self):
        v = m.c10_routing_verdicts(final=self.FINAL, run_status="failed",
                                   tilt_live={"status": "succeeded", "outcome": "approved"})
        self.assertIs(False, one(v, "STILL WAITING"), str(v))

    def test_no_sample_from_either_side_gaps_naming_both_reasons(self):
        v = m.c10_routing_verdicts(live=None, live_why="twin window closed", final=self.FINAL,
                                   run_status="failed", tilt_live=None,
                                   tilt_why="the tilt run reached 'failed' early")
        self.assertIsNone(one(v, "STILL WAITING"), str(v))
        d = detail(v, "STILL WAITING")
        self.assertIn("twin window closed", d)
        self.assertIn("tilt run reached", d)


class DriverWiresTheRetryArm(unittest.TestCase):
    """The gate, not just the algebra: the authored arm runs inside c10() and the
    reason a sample closed rides to the GAP text."""

    def source(self):
        return open(os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                 "e2e_m4_exit.py"), encoding="utf-8").read()

    def test_the_authored_arm_runs_before_the_rows_it_grads(self):
        body = self.source().split("def c10():")[1].split("\ndef c11(")[0]
        self.assertLess(body.index("c10b_retry_arm("), body.index("c10_routing_verdicts("),
                        "the routing row takes the authored arm's mid-failure sample, so "
                        "the arm has to have run first")
        self.assertIn("tilt_live=tilt_live", body)
        self.assertIn("tilt_why=tilt_why", body)
        self.assertEqual(1, body.count("c10b_retry_arm("),
                         "one authored arm per gate — a second chain would double the rows")

    def test_c10_runs_the_authored_arm_and_hands_it_to_the_retry_verdicts(self):
        body = self.source().split("def c10():")[1].split("\ndef c11(")[0]
        self.assertIn("c10b_retry_arm(alice, admin, twin, src, suffix)", body)
        self.assertIn("tilt_ran=tilt_ran, tilt_why=tilt_why", body)
        self.assertLess(body.index("c10b_retry_arm("), body.index("c10_retry_verdicts("))

    def test_the_sampler_returns_its_reason_and_the_gate_shows_it(self):
        pre = self.source().split("def c10():")[0]
        self.assertIn("def c10_sample_retry_backoff(", pre)
        self.assertIn("def c10_sample_failing_scope(", pre)
        body = self.source().split("def c10():")[1].split("\ndef c11(")[0]
        self.assertIn("live, seen, live_why = c10_sample_failing_scope(", body)
        self.assertIn('CTX["c10_sample_why"]', body)

    def test_the_live_set_is_not_hardcoded_a_second_time(self):
        src = self.source()
        self.assertNotIn('"waiting_attempt"', src, "the invented node-status vocabulary "
                                                  "must not come back")
        self.assertIn("C10_TERMINAL_NODE_STATES", src)

class CompletedRead(unittest.TestCase):
    """c10_completed_for's reading, pinned after run 42045469577's C10b FAIL
    ('succeeded attempt=2, journal read=ok'): node.attempt.completed carries the
    attempt uuid in the domain_events ATTEMPT_ID COLUMN — FinishAttempt's fenced
    append passes c.AttemptID into runAppendTx (internal/store/postgres/
    attempts.go) — while the NodeAttemptCompleted PAYLOAD carries
    project/run/node_instance_key/attempt_NUMBER, never the attempt row id
    (internal/pipelines/events/events.go). The old `payload::text LIKE '%uuid%'`
    could therefore only ever count 0: the C10b line FAILed on a completion that
    was journaled, and C10a's 'NO node.attempt.completed for the malformed
    attempt' PASSed vacuously. The reading must name the column."""

    def test_sql_reads_the_attempt_id_column_not_the_payload(self):
        sql = m.c10_completed_sql("run-1", "att-1")
        self.assertIn("type = 'node.attempt.completed'", sql)
        self.assertIn("attempt_id::text = 'att-1'", sql)
        self.assertNotIn("payload::text LIKE", sql,
                         "the attempt uuid is not in the payload — a LIKE over it "
                         "is how run 42045469577 read a journaled completion as absent")
        self.assertIn("run_id = 'run-1'", sql)

    def test_count_maps_to_true_false_and_gap(self):
        import unittest.mock as mock
        seen = []
        with mock.patch.object(m, "c10_sql",
                               side_effect=lambda sql, what: seen.append(sql) or "1"):
            self.assertIs(True, m.c10_completed_for("run-1", "att-1"))
        with mock.patch.object(m, "c10_sql", return_value="0"):
            self.assertIs(False, m.c10_completed_for("run-1", "att-1"))
        with mock.patch.object(m, "c10_sql", return_value=None):
            self.assertIsNone(m.c10_completed_for("run-1", "att-1"))
        with mock.patch.object(m, "c10_sql", return_value="garbage"):
            self.assertIsNone(m.c10_completed_for("run-1", "att-1"),
                              "a ledger that will not answer is a GAP, never a zero")
        self.assertTrue(seen and seen[0] == m.c10_completed_sql("run-1", "att-1"))

    def test_no_attempt_id_is_a_gap_without_a_query(self):
        import unittest.mock as mock
        with mock.patch.object(m, "c10_sql", side_effect=AssertionError(
                "must not query the ledger for an attempt the chain never named")):
            self.assertIsNone(m.c10_completed_for("run-1", None))
            self.assertIsNone(m.c10_completed_for("run-1", ""))

    def test_tilt_verdicts_grade_the_read(self):
        chain = [{"attempt_number": 1, "status": "failed", "error_class": "invalid_output",
                  "id": "a1"},
                 {"attempt_number": 2, "status": "succeeded", "error_class": None,
                  "id": "a2"}]
        live = {"status": "succeeded"}
        base = dict(chain=chain, live=live, iter_rows=[{"n": 1}, {"n": 2}],
                    run_st="completed")
        v = m.c10b_tilt_verdicts(completed=True, **base)
        self.assertIs(True, one(v, "reached the routing layer"))
        v = m.c10b_tilt_verdicts(completed=False, **base)
        self.assertIs(False, one(v, "reached the routing layer"))
        v = m.c10b_tilt_verdicts(completed=None, **base)
        self.assertIsNone(one(v, "reached the routing layer"))
        self.assertIn("journal read=unreadable", detail(v, "reached the routing layer"))


if __name__ == "__main__":
    unittest.main(verbosity=2 if "-v" in sys.argv else 1)
