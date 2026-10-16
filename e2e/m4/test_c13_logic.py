#!/usr/bin/env python3
"""test_c13_logic.py - offline unit proof for e2e_m4_exit.py's C13 pure logic.

Runs WITHOUT a stack (stdlib unittest only): the § 2.2 validate-body reader, the
located-refusal verdict algebra (PASS / FAIL / GAP), the seven deferred kinds'
milestone-naming count, the secret-literal redaction + publish-block rules, the
CEL root table (accept vs. refuse-by-name), the no-route rule for immutable
revisions and run.override, and the honest limit-free scheduler verdict.

A green here means the VERDICT ALGEBRA is right. It never substitutes for C13's
live POSTs against the shipped schema/loader/compiler through the API
(12-test-strategy.md: a refusal is only proven by asking the real engine).

usage: python3 e2e/m4/test_c13_logic.py [-v]
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import e2e_m4_exit as m  # noqa: E402 — importing the driver is the point


def err(code, loc, source="compiler", msg="refused", hint=""):
    return {"code": code, "source": source, "message": msg, "instance_location": loc,
            "schema_location": None, "hint": hint}


def body(errors, valid=False):
    return {"valid": valid, "errors": errors, "notes": [], "digest_scope": "v1alpha1-canonical-1"}


def deferred(seven=True, milestone=True, extra=None):
    kinds = m.C13_DEFERRED_KINDS if seven else m.C13_DEFERRED_KINDS[:6]
    out = []
    for i, (k, ms) in enumerate(kinds):
        out.append(err("kind_not_implemented", f"/spec/nodes/{i}/kind", "compiler",
                       f"kind {k} is not implemented before {ms}" if milestone else
                       f"kind {k} is not implemented", "later"))
    return body(out + (extra or []))


def ok_of(vs, needle):
    hits = [ok for label, ok, _ in vs if needle in label]
    assert hits, f"no verdict matching {needle!r} in {[l for l, _, _ in vs]}"
    return hits[0]


def detail_of(vs, needle):
    hits = [d for label, _ok, d in vs if needle in label]
    assert hits, f"no verdict matching {needle!r} in {[l for l, _, _ in vs]}"
    return hits[0]


class BodyTest(unittest.TestCase):
    def test_only_a_real_validate_body_counts(self):
        self.assertTrue(m.c13_validate_ok(body([])))
        for junk in (None, {}, {"errors": "nope"}, {"valid": False}, [{}]):
            self.assertFalse(m.c13_validate_ok(junk), junk)

    def test_location_match_is_exact_or_document_suffix(self):
        v = body([err("schema_shape", "/spec/nodes/0/config/typo", "schema")])
        self.assertEqual(len(m.c13_errors_at(v, "/spec/nodes/0/config/typo")), 1)
        self.assertEqual(len(m.c13_errors_at(v, "/config/typo")), 1)
        self.assertEqual(m.c13_errors_at(v, "/spec/nodes/1/config/typo"), [])
        self.assertEqual(len(m.c13_errors_at(v, "/spec/nodes/0/config")), 1)   # block prefix
        wide = body([err("schema_shape", "/spec/nodes/10/config/typo", "schema")])
        self.assertEqual(m.c13_errors_at(wide, "/spec/nodes/1"), [])          # boundary, not fuzzy
        self.assertEqual(len(m.c13_errors_at(wide, "/spec/nodes/10")), 1)
        self.assertEqual(m.c13_errors_at(None, "/spec"), [])


class RefusalVerdictTest(unittest.TestCase):
    def test_pass_needs_the_code_at_the_location(self):
        v = body([err("unsupported_session_mode", "/spec/nodes/0/config/sessionMode")])
        label, ok, detail = m.c13_refusal_verdict(
            "x", v, "/spec/nodes/0/config/sessionMode", ("unsupported_session_mode",))
        self.assertTrue(ok)
        self.assertIn("unsupported_session_mode", detail)

    def test_wrong_code_is_a_fail_not_a_pass(self):
        v = body([err("unknown_profile", "/spec/nodes/0/config/sessionMode")])
        self.assertFalse(m.c13_refusal_verdict("x", v, "/spec/nodes/0/config/sessionMode",
                                              ("unsupported_session_mode",))[1])

    def test_valid_true_is_always_a_fail(self):
        v = body([], valid=True)
        self.assertFalse(m.c13_refusal_verdict("x", v, "/spec/nodes/0/config/typo")[1])

    def test_no_body_is_a_gap_never_a_pass(self):
        self.assertIsNone(m.c13_refusal_verdict("x", None, "/spec/nodes/0/config")[1])

    def test_refusal_somewhere_else_does_not_count(self):
        v = body([err("schema_shape", "/spec/policies/maxDurationSeconds", "schema")])
        self.assertFalse(m.c13_refusal_verdict("x", v, "/spec/policies/maxConcurrentNodes",
                                               ("schema_shape",))[1])


class DeferredKindsTest(unittest.TestCase):
    def test_seven_refusals_naming_their_milestone_pass(self):
        vs = m.c13_deferred_kind_verdicts(deferred(), "invalid")
        self.assertTrue(ok_of(vs, "exactly seven"))
        for k, _ms in m.C13_DEFERRED_KINDS:
            self.assertTrue(ok_of(vs, f"kind: {k}"), k)
        self.assertTrue(ok_of(vs, "status='invalid'"))

    def test_six_refusals_is_a_fail(self):
        vs = m.c13_deferred_kind_verdicts(deferred(seven=False), "invalid")
        self.assertFalse(ok_of(vs, "exactly seven"))
        self.assertFalse(ok_of(vs, "integration.action"))

    def test_milestone_less_message_is_a_fail(self):
        vs = m.c13_deferred_kind_verdicts(deferred(milestone=False), "invalid")
        self.assertFalse(ok_of(vs, "kind: parallel"))

    def test_schema_noise_gaps_the_arm_it_cannot_judge(self):
        v = deferred(seven=False, extra=[err("schema_shape", "/spec/nodes/6/config", "schema")])
        vs = m.c13_deferred_kind_verdicts(v, "invalid")
        self.assertIsNone(ok_of(vs, "kind: integration.action"))
        self.assertFalse(ok_of(vs, "exactly seven"))

    def test_unreadable_draft_status_gaps_only_that_verdict(self):
        vs = m.c13_deferred_kind_verdicts(deferred(), None)
        self.assertIsNone(ok_of(vs, "status='invalid'"))
        self.assertTrue(ok_of(vs, "exactly seven"))

    def test_no_body_at_all_is_one_gap(self):
        vs = m.c13_deferred_kind_verdicts(None, "invalid")
        self.assertEqual([ok for _l, ok, _d in vs], [None])


class SecretLiteralTest(unittest.TestCase):
    DOC = body([err("secret_literal_detected", "/spec/nodes/0/config/env/DATABASE_URL")])
    RAW = '{"valid": false, "code": "secret_literal_detected", "value": "[REDACTED]"}'

    def test_pass_when_located_redacted_and_blocked(self):
        vs = m.c13_secret_verdicts(self.DOC, self.RAW, 422,
                                   {"code": "secret_literal_detected"})
        self.assertTrue(ok_of(vs, "secret_literal_detected"))
        self.assertTrue(ok_of(vs, "redacts the literal value"))
        self.assertTrue(ok_of(vs, "cannot succeed"))
        self.assertTrue(ok_of(vs, "blocks publish"))

    def test_a_leaked_value_is_a_fail(self):
        vs = m.c13_secret_verdicts(self.DOC, '{"v": "%s"}' % m.C13_SECRET_LITERAL, 422, {})
        self.assertFalse(ok_of(vs, "redacts the literal value"))

    def test_a_successful_publish_is_a_fail(self):
        vs = m.c13_secret_verdicts(self.DOC, self.RAW, 201, {"id": "r"})
        self.assertFalse(ok_of(vs, "cannot succeed"))
        self.assertFalse(ok_of(vs, "blocks publish"))

    def test_draft_not_valid_short_circuit_is_a_gap_not_a_pass(self):
        vs = m.c13_secret_verdicts(self.DOC, self.RAW, 409, {"code": "draft_not_valid"})
        self.assertTrue(ok_of(vs, "cannot succeed"))
        self.assertIsNone(ok_of(vs, "blocks publish"))

    def test_no_publish_attempt_gaps_both_publish_arms(self):
        vs = m.c13_secret_verdicts(self.DOC, self.RAW, None, None)
        self.assertIsNone(ok_of(vs, "cannot succeed"))


class RootTableTest(unittest.TestCase):
    def test_declared_roots_accept_clean_and_member_refused(self):
        for errs in ([], [err("unknown_field", "/spec/nodes/2/config/prompt")]):
            v = body(errs)
            self.assertTrue(m.c13_root_verdict("item", v, "/spec/nodes/2/config/prompt")[1], errs)

    def test_declared_root_refused_by_the_engine_is_a_fail(self):
        v = body([err("undeclared_root", "/spec/nodes/3/config/prompt", msg="unknown root items")])
        self.assertFalse(m.c13_root_verdict("items", v, "/spec/nodes/3/config/prompt")[1])

    def test_reserved_root_must_be_named_by_undeclared_root(self):
        v = body([err("undeclared_root", "/spec/nodes/8/config/prompt",
                      msg="reserved identifier: loop")])
        label, ok, detail = m.c13_reserved_root_verdict(v, "/spec/nodes/8/config/prompt")
        self.assertTrue(ok)
        self.assertIn("reserved identifier", detail)

    def test_reserved_root_compiling_clean_is_the_scary_fail(self):
        self.assertFalse(m.c13_reserved_root_verdict(body([]), "/spec/nodes/8/config/prompt")[1])
        wrong = body([err("cel_compile_error", "/spec/nodes/8/config/prompt")])
        self.assertFalse(m.c13_reserved_root_verdict(wrong, "/spec/nodes/8/config/prompt")[1])

    def test_all_eight_declared_roots_are_measured(self):
        self.assertEqual(len(m.C13_ROOTS), 8)
        self.assertNotIn(m.C13_RESERVED_ROOT, m.C13_ROOTS)
        self.assertEqual(len(m.C13_DEFERRED_KINDS), 7)
        # ADR-0022 § 2 is positional: seven roots are probed in a pipeline scope,
        # `parameters` only exists in the NodeTemplate probe.
        in_scope = {r for r, _e, _n in (m.C13D_PIPELINE_SCOPE + m.C13D_FOREACH_SCOPE
                                        + m.C13D_UNTIL_SCOPE)}
        self.assertEqual(in_scope | {"parameters"}, set(m.C13_ROOTS))
        self.assertEqual({r for r, _e, _n in m.C13D_OUT_OF_SCOPE},
                         {"item", "items", "previous", "iteration", "parameters"})

    def test_out_of_scope_refusal_passes_and_clean_compile_fails(self):
        v = body([err("undeclared_root", "/spec/nodes/0/config/prompt",
                      msg='root "item" is not declared for this position')])
        label, ok, detail = m.c13_out_of_scope_verdict("item", v, "/spec/nodes/0/config/prompt")
        self.assertTrue(ok, detail)
        self.assertFalse(m.c13_out_of_scope_verdict("item", body([]),
                                                    "/spec/nodes/0/config/prompt")[1])
        other = body([err("unknown_field", "/spec/nodes/0/config/prompt")])
        self.assertFalse(m.c13_out_of_scope_verdict("item", other,
                                                    "/spec/nodes/0/config/prompt")[1])
        self.assertIsNone(m.c13_out_of_scope_verdict("item", None,
                                                     "/spec/nodes/0/config/prompt")[1])

    def test_parameters_root_needs_template_scope_and_the_publish_block(self):
        good = body([err("template_publish_deferred", "/kind", "compiler",
                         msg="publishing templates is deferred to M5")])
        self.assertTrue(m.c13_parameters_root_verdict(good)[1])
        self.assertFalse(m.c13_parameters_root_verdict(body([]))[1])
        refused = body([err("undeclared_root", "/spec/config/prompt",
                            msg='root "parameters" is not declared')])
        self.assertFalse(m.c13_parameters_root_verdict(refused)[1])
        self.assertIsNone(m.c13_parameters_root_verdict(None)[1])


class RouteAndOpsTest(unittest.TestCase):
    def test_no_route_only_counts_when_the_row_resolves(self):
        self.assertTrue(m.c13_route_verdict("x", 405, True)[1])
        self.assertTrue(m.c13_route_verdict("x", 404, True)[1])
        self.assertFalse(m.c13_route_verdict("x", 200, True)[1])
        self.assertFalse(m.c13_route_verdict("x", 403, True)[1])
        self.assertIsNone(m.c13_route_verdict("x", 404, False)[1])

    def test_override_needs_no_route_and_no_event(self):
        vs = m.c13_override_verdict(404, {"run.created", "run.completed"})
        self.assertTrue(all(ok for _l, ok, _d in vs))
        vs = m.c13_override_verdict(200, {"run.override.applied"})
        self.assertFalse(any(ok for _l, ok, _d in vs))
        vs = m.c13_override_verdict(404, None)
        self.assertEqual([ok for _l, ok, _d in vs], [True, None])

    def test_scheduler_body_must_not_imply_limits(self):
        self.assertTrue(m.c13_limit_verdict({"queued": 1, "workers": []})[0][1])
        self.assertFalse(m.c13_limit_verdict({"cpu": 4, "memory_mb": 512})[0][1])
        self.assertIsNone(m.c13_limit_verdict(None)[0][1])


class DeprecateVerdictTest(unittest.TestCase):
    def test_status_flips_and_no_run_row_moves(self):
        runs = "r1|completed\nr2|waiting_human"
        vs = m.c13_deprecate_verdicts("published|sha256:a", "deprecated|sha256:a", runs, runs, True)
        self.assertTrue(all(ok for _l, ok, _d in vs))

    def test_a_moved_run_row_is_a_fail(self):
        vs = m.c13_deprecate_verdicts("published|a", "deprecated|a", "r1|completed",
                                      "r1|failed", True)
        self.assertFalse(ok_of(vs, "touches no existing run"))

    def test_unreadable_run_side_gaps(self):
        vs = m.c13_deprecate_verdicts("published|a", "deprecated|a", "r1|completed", None, True)
        self.assertIsNone(ok_of(vs, "touches no existing run"))

    def test_no_scratch_revision_gaps_the_whole_arm(self):
        vs = m.c13_deprecate_verdicts("", "", "", "", False)
        self.assertEqual([ok for _l, ok, _d in vs], [None])


class ProbeDocTest(unittest.TestCase):
    def test_probe_documents_are_yaml_the_api_can_read(self):
        doc = m.c13_doc("m4x-c13a", m.C13_SEVENTH)
        # c13_doc builds on the seed document, whose provenance comment block rides
        # ahead of the mapping — the claim is "YAML the API can read", not byte 0.
        self.assertIn("apiVersion: communication.dev/v1alpha1", doc)
        self.assertIn("kind: Pipeline", doc)
        self.assertEqual(doc.count("kind: parallel"), 1)

    def test_root_document_probes_each_root_where_it_is_in_scope(self):
        """The gate may not ask for `item.x` at pipeline scope and call a refusal a
        bug: ADR-0022 § 2 puts item/items in a for_each body and previous/iteration
        in an until body. The pointers the verdicts read come from the same table
        that writes the nodes, so probe and pointer cannot drift."""
        roots, pointers, loop_at = m.c13_root_probe_doc("m4x-c13d")
        self.assertIn("kind: for_each", roots)
        self.assertIn("kind: until", roots)
        self.assertIn("resultBindings", roots)
        self.assertIn("${{ item.x }}", roots)
        self.assertIn("${{ items.x }}", roots)
        self.assertIn('iteration > 1 ? "2+" : "1"', roots)
        self.assertIn('has(previous.review_note)', roots)
        self.assertIn("${{ loop.x }}", roots)
        self.assertNotIn("parameters", roots)
        self.assertEqual(set(pointers), set(m.C13_ROOTS) - {"parameters"})
        for root, at in pointers.items():
            self.assertTrue(at.endswith("/config/prompt"), f"{root} @ {at}")
            nested = root in ("item", "items", "previous", "iteration")
            self.assertEqual("/config/body/nodes/" in at, nested, f"{root} @ {at}")
            probe = {"iteration": 'iteration > 1', "previous": "previous.review_note"}
            self.assertIn(probe.get(root, root), roots, f"{root} @ {at}")
        self.assertTrue(loop_at.endswith("/config/prompt"))

    def test_misuse_document_places_every_positional_root_out_of_scope(self):
        doc, pointers = m.c13_root_misuse_doc("m4x-c13d-misuse")
        self.assertEqual(set(pointers), {"item", "items", "previous", "iteration",
                                        "parameters"})
        for root, at in pointers.items():
            self.assertTrue(at.startswith("/spec/nodes/"), f"{root} at {at}")
            self.assertEqual(at.count("/config/"), 1, f"{root} must sit at pipeline scope")
            self.assertIn(m.BIND_OPEN + root if root != "iteration"
                          else "iteration > 1", doc)

    def test_template_document_declares_the_parameters_root(self):
        doc = m.c13_template_doc("m4x-c13d-template")
        self.assertIn("kind: NodeTemplate", doc)
        self.assertIn("${{ parameters.review_instructions }}", doc)


class GateCompilerProbeSyncTest(unittest.TestCase):
    """The compiler's own evidence (internal/pipelines/compiler/testdata/c13d-*.yaml)
    is a byte-for-byte copy of these documents. If a builder moves and the copy does
    not, the Go test proves something the gate no longer sends — so it fails here."""

    COPIES = {"c13d-roots-in-scope.yaml": lambda n: m.c13_root_probe_doc(n)[0],
              "c13d-roots-misuse.yaml": lambda n: m.c13_root_misuse_doc(n),
              "c13d-parameters-template.yaml": lambda n: m.c13_template_doc(n)}

    def test_compiler_testdata_matches_the_documents_the_gate_builds(self):
        root = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..",
                            "internal", "pipelines", "compiler", "testdata")
        for name, build in self.COPIES.items():
            with open(os.path.join(root, name), encoding="utf-8") as f:
                stored = f.read()
            # Compare from the mapping's first key: the copy carries a regeneration
            # note above it, the seed document carries a provenance block above that.
            body, doc = stored[stored.index("apiVersion"):], build(
                "m4x-c13d-roots" if "roots-in" in name else
                ("m4x-c13d-misuse" if "misuse" in name else "m4x-c13d-template"))
            doc = doc[0] if isinstance(doc, tuple) else doc
            doc = doc[doc.index("apiVersion"):]
            self.assertEqual(body, doc, f"{name}: the gate's document moved away from the "
                                        "compiler testdata — regenerate the copy")


class OpsPageRenderTest(unittest.TestCase):
    """C13f's browser half: the ops page SAYS the absence and shows no limit column.
    The honest sentence names cpu/memory/disk itself, so the limit-column verdict has
    to ignore that one line — and only that line."""

    HONEST = '  - paragraph: Resource limits: not implemented \u2014 runs have no cpu, '\
             'memory or disk caps in this release.'
    PANEL = ('- generic [ref=e1]:\n'
             '  - heading "Operations" [level=1] [ref=e2]\n'
             '  - term "attempts queued" [ref=e3]\n'
             '  - columnheader "Worker" [ref=e4]\n'
             '  - columnheader "Active attempts / capacity" [ref=e5]\n')

    def snap(self, extra=""):
        """snap() = the panel with the honest line; snap("no-honest") drops it; any
        other string is an EXTRA rendered line added under the honest one."""
        text = self.PANEL + ("" if extra == "no-honest" else self.HONEST + "\n")
        if extra not in ("", "honest", "no-honest"):
            text += extra + "\n"
        return m.pw_snapshot_nodes(text)

    def test_the_honest_line_passes_both_verdicts(self):
        vs = m.c13_ops_page_verdicts(self.snap("honest"))
        self.assertEqual([ok for _l, ok, _d in vs], [True, True], vs)

    def test_no_honest_sentence_is_a_fail_not_a_gap(self):
        vs = m.c13_ops_page_verdicts(self.snap("no-honest"))
        self.assertIs(False, ok_of(vs, "says 'resource limits: not implemented'"), vs)
        self.assertTrue(ok_of(vs, "renders NO cpu/memory/disk limit column"))

    def test_a_limit_column_fails_even_next_to_the_honest_line(self):
        vs = m.c13_ops_page_verdicts(self.snap('  - columnheader "Memory limit" [ref=e9]'))
        self.assertTrue(ok_of(vs, "says 'resource limits: not implemented'"))
        self.assertIs(False, ok_of(vs, "renders NO cpu/memory/disk limit column"))
        self.assertIn("memory", detail_of(vs, "renders NO cpu/memory/disk limit column").lower())

    def test_a_plain_prose_mention_counts_too(self):
        # `implementation` must not trip the word list (word boundaries, not substrings).
        vs = m.c13_ops_page_verdicts(self.snap('  - paragraph: the implementation has no caps'))
        self.assertTrue(ok_of(vs, "renders NO cpu/memory/disk limit column"), vs)

    def test_no_snapshot_gaps_instead_of_passing(self):
        vs = m.c13_ops_page_verdicts([])
        self.assertEqual([ok for _l, ok, _d in vs], [None, None], vs)
        vs = m.c13_ops_page_verdicts([], "nothing rendered")
        self.assertEqual([ok for _l, ok, _d in vs], [None, None], vs)

    def test_raw_snapshot_text_can_carry_the_sentence(self):
        nodes = m.pw_snapshot_nodes(self.PANEL)
        vs = m.c13_ops_page_verdicts(nodes, self.HONEST)
        self.assertTrue(ok_of(vs, "says 'resource limits: not implemented'"), vs)


if __name__ == "__main__":
    unittest.main(verbosity=2 if "-v" in sys.argv else 1)


