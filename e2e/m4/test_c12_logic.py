#!/usr/bin/env python3
"""test_c12_logic.py - offline unit proof for e2e_m4_exit.py's C12 pure logic.

Runs WITHOUT a stack (stdlib unittest only): the authoring-subset refusal algebra
(exists()/now()/matches()/workspace.* and the three § 6 budget caps), the PINNED-run
verdict from canned run rows either side of a mid-run publish (PASS / FAIL / GAP), the
re-pin clause, the 409 canonicalization verdict, where the two digests separate, and the
documents the gate authors (each splice moves exactly one thing over the real seed twin
bytes).

A green here means the VERDICT ALGEBRA is right. It never substitutes for C12's live
drafts, publishes and mid-run publish against the real control plane and workers
(12-test-strategy.md: a mocked green is not done).

usage: python3 e2e/m4/test_c12_logic.py [-v]
"""
import os
import re
import sys
import unittest

try:  # the YAML probes below need a parser; the verdict algebra does not
    import yaml
except ImportError:  # pragma: no cover - environment without PyYAML
    yaml = None

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import e2e_m4_exit as m  # noqa: E402 — importing the driver is the point


def one(rows, needle):
    vs = [ok for l, ok, _d in rows if needle in l]
    assert len(vs) == 1, f"{needle!r} produced {len(vs)} verdicts: {[l for l, _o, _d in rows]}"
    return vs[0]


def detail(rows, needle):
    return [d for l, _o, d in rows if needle in l][0]


REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SEED_YAML = os.path.join(REPO, "docs", "compatibility", "probes", "m4", "pipeline.yaml")


def twin_doc():
    """Document #2 of the seed's probe file — the bytes C12 varies (the live gate reads
    them from GET /revisions/{id}/document?format=yaml)."""
    with open(SEED_YAML, encoding="utf-8") as f:
        raw = f.read()
    docs = [d for d in re.split(r"(?m)^---\s*$", raw) if "kind: Pipeline" in d]
    assert len(docs) >= 2, f"expected >=2 documents in {SEED_YAML}"
    return docs[1]


def vbody(*errs, valid=False):
    return {"valid": valid, "errors": [dict(e) for e in errs]}


def err(code, loc, hint="nope"):
    return {"source": "cel", "code": code, "instance_location": loc, "hint": hint}


def pin(rd="sha:OLDREV", pd="sha:OLDPLAN", rev="rev-1", status="running"):
    return {"revision_digest": rd, "plan_digest": pd, "pipeline_revision_id": rev,
            "status": status}


class C12aAuthoringSubset(unittest.TestCase):
    def test_each_probe_refused_with_the_named_code(self):
        rows = m.c12_refusal_verdicts([("now()", "cel_function_not_allowed",
                                        "/spec/nodes/0/config/passWhen",
                                        vbody(err("cel_function_not_allowed",
                                                  "/spec/nodes/0/config/passWhen")))])
        self.assertIs(True, one(rows, "now()"))

    def test_accepted_document_is_a_fail(self):
        rows = m.c12_refusal_verdicts([("workspace.*", "undeclared_root",
                                        "/spec/nodes/0/config/passWhen",
                                        vbody(valid=True))])
        self.assertIs(False, one(rows, "workspace.*"))

    def test_no_validate_body_is_a_gap(self):
        rows = m.c12_refusal_verdicts([("matches()", "cel_function_not_allowed", "/spec", None)])
        self.assertIsNone(one(rows, "matches()"))

    def test_wrong_code_at_the_right_place_fails_naming_both(self):
        rows = m.c12_refusal_verdicts([("now()", "cel_function_not_allowed",
                                        "/spec/nodes/0/config/passWhen",
                                        vbody(err("cel_compile_error",
                                                  "/spec/nodes/0/config/passWhen")))])
        self.assertIs(False, one(rows, "now()"))
        self.assertIn("cel_function_not_allowed", detail(rows, "now()"))

    def test_four_probes_share_one_builder(self):
        docs = m.c12_forbidden_docs()
        self.assertEqual(4, len(docs))
        self.assertEqual(["`exists()` macro", "`now()`", "`matches()`", "`workspace.*` root"],
                         [d[0] for d in docs])
        for _l, expr, _c, doc, loc in docs:
            self.assertIn(f"passWhen: {m.c12_scalar(expr)}", doc)
            self.assertIn("kind: until", doc)
            self.assertEqual("/spec/nodes/0/config/passWhen", loc)


class C12bBudgets(unittest.TestCase):
    def test_expression_cap_document_carries_exactly_n_bindings(self):
        self.assertEqual(65, m.c12_exprs_doc("x", 65).count(m.BIND_OPEN))
        self.assertEqual(64, m.c12_exprs_doc("x", 64).count(m.BIND_OPEN))

    def test_expression_budget_code_is_the_only_pass(self):
        ok = m.c12_code_verdict("65 compiled expressions",
                                vbody(err("expression_budget_exceeded", "/spec/nodes/64")),
                                "expression_budget_exceeded")
        self.assertIs(True, ok[1])
        bad = m.c12_code_verdict("65 compiled expressions",
                                 vbody(err("cel_compile_error", "/spec/nodes/64")),
                                 "expression_budget_exceeded")
        self.assertIs(False, bad[1])
        self.assertIn("cel_compile_error", bad[2])
        self.assertIsNone(m.c12_code_verdict("65 compiled expressions", None,
                                             "expression_budget_exceeded")[1])

    def test_literal_fanout_document_holds_the_over_cap_array(self):
        doc = m.c12_fanout_doc("x", m.C12_ITEMS_CAP + 1)
        self.assertEqual(m.C12_ITEMS_CAP + 1, doc.count("{n: "))
        self.assertIn("kind: for_each", doc)

    def test_wide_until_body_lowers_only_its_own_budget(self):
        doc = m.c12_exec_budget_doc("x")
        self.assertEqual(m.C12_BODY_NODES, doc.count("- id: b"))
        self.assertIn(f"maxNodeExecutions: {m.C12_EXEC_BUDGET}", doc)
        self.assertNotIn(m.BIND_OPEN, doc.split("  nodes:")[1])
        self.assertIn(f"maxIterations: {m.C12_MAX_ITER}", doc)

    def test_literal_fanout_accepts_either_owner_of_the_refusal(self):
        # The shipped schema types for_each.config.items as a bindingValue, so a
        # literal array — of ANY length — is refused by the schema before the
        # compiler's graph_too_large cap can be reached (§ 2.1 route 6's schema).
        schema = {"source": "schema", "code": "schema_shape",
                  "instance_location": "/spec/nodes/0/config/items",
                  "message": "got array, want string"}
        got = m.c12_literal_fanout_verdict(vbody(schema))
        self.assertIs(True, got[1], got[2])
        self.assertIn("bindingValue", got[2])
        comp = {"source": "compiler", "code": "graph_too_large",
                "instance_location": "/spec/nodes/0/config/items", "hint": "the limit is 1000"}
        self.assertIs(True, m.c12_literal_fanout_verdict(vbody(comp))[1])
        # a refusal that never names the items location is not this cap
        self.assertIs(False, m.c12_literal_fanout_verdict(
            vbody(err("cel_compile_error", "/spec/nodes/0/config/prompt")))[1])
        self.assertIs(False, m.c12_literal_fanout_verdict(vbody(schema, valid=True))[1])
        self.assertIsNone(m.c12_literal_fanout_verdict(None)[1])
        # and the § 6 cap's OWN code is never credited to this arm
        self.assertNotIn(m.C12_FANOUT_RUN_CODE, m.C12_LITERAL_FANOUT_CODES)

    def test_run_owned_cap_reads_the_code_off_the_run(self):
        v = m.c12_run_code_verdicts("1001 evaluated items", "fanout_items_exceeded",
                                    "failed", "fanout_items_exceeded")
        self.assertIs(True, one(v, "1001 evaluated items"))
        v = m.c12_run_code_verdicts("1001 evaluated items", "fanout_items_exceeded",
                                    "completed", "")
        self.assertIs(False, one(v, "1001 evaluated items"))
        v = m.c12_run_code_verdicts("1001 evaluated items", "fanout_items_exceeded", "", "")
        self.assertIsNone(one(v, "1001 evaluated items"))


class C12cPinnedRun(unittest.TestCase):
    ROWS = ("sha:OLDREV|sha:OLDPLAN|rev-1|running",)

    def test_c12_row_parses_the_pin(self):
        got = m.c12_row("sha:R|sha:P|rev-9|running")
        self.assertEqual("sha:R", got["revision_digest"])
        self.assertEqual("rev-9", got["pipeline_revision_id"])
        self.assertEqual("running", got["status"])

    def test_c12_row_refuses_a_half_read(self):
        for bad in ("", "sha:R|sha:P", "sha:R|<none>|rev-9|running", None):
            self.assertIsNone(m.c12_row(bad), bad)

    def _emit(self, **kw):
        base = dict(before=m.c12_row(self.ROWS[0]),
                    after=m.c12_row(self.ROWS[0]), event_rd="", revisions_ok=True,
                    nodes_before="{\"nodes\":[]}", nodes_after="{\"nodes\":[]}",
                    pinned_late=True)
        base.update(kw)
        return m.c12_pin_verdicts(**base)

    def test_pinned_run_passes_on_every_member(self):
        rows = self._emit()
        for _l, ok, _d in rows:
            self.assertIs(True, ok, _l)

    def test_a_moved_digest_fails_and_prints_both_sides(self):
        moved = m.c12_row("sha:OLDREV|sha:NEWPLAN|rev-1|running")
        rows = self._emit(after=moved)
        self.assertIs(False, one(rows, "plan_digest"))
        self.assertIn("sha:NEWPLAN", detail(rows, "plan_digest"))
        self.assertIs(True, one(rows, "run's revision_digest"), detail(rows, "revision_digest"))

    def test_a_run_row_that_never_arrived_is_a_gap_not_a_pass(self):
        rows = self._emit(before=None, after=None)
        self.assertIsNone(one(rows, "run's revision_digest"))
        self.assertIsNone(one(rows, "plan_digest"))
        self.assertIsNone(one(rows, "pipeline_revision_id"))

    def test_publish_event_belongs_to_the_org_not_the_run(self):
        self.assertIs(True, one(self._emit(event_rd=""), "journal carries no revision_digest"))
        self.assertIs(False, one(self._emit(event_rd="sha:NEWREV"),
                                "journal carries no revision_digest"))
        self.assertIsNone(one(self._emit(event_rd=None), "journal carries no revision_digest"))

    def test_node_output_must_be_byte_identical(self):
        self.assertIs(True, one(self._emit(), "/nodes plan view"))
        self.assertIs(False, one(self._emit(nodes_after="{\"nodes\":[1]}"),
                                 "/nodes plan view"))
        self.assertIsNone(one(self._emit(nodes_before=None), "/nodes plan view"))

    def test_progress_moves_the_body_but_never_the_pinned_plan(self):
        # The live run keeps executing across the publish (§ 5.1), so the raw body
        # moves with its own progress columns. That is not C12c's failure: only a
        # plan-derived column moving (or an execution vanishing) is.
        before = ('{"node_executions":[{"node_instance_key":"/plan","node_id":"plan",'
                  '"kind":"process.exec","scope_key":"/","execution_location":"worker",'
                  '"depends_on":[],"attempt_limit":3,"status":"running","attempt_count":1}]}')
        progressed = before.replace('"status":"running","attempt_count":1',
                                    '"status":"succeeded","attempt_count":2')
        got = m.c12_nodes_identity_verdict(before, progressed)
        self.assertIs(True, got[1], got[2])
        self.assertIn("attempt_count", got[2])
        moved_plan = before.replace('"execution_location":"worker"',
                                    '"execution_location":"control_plane"')
        self.assertIs(False, m.c12_nodes_identity_verdict(before, moved_plan)[1])
        vanished = '{"node_executions":[]}'
        self.assertIs(False, m.c12_nodes_identity_verdict(before, vanished)[1])
        self.assertIn("left the run's own list", m.c12_nodes_identity_verdict(before,
                                                                              vanished)[2])

    def test_revisions_list_identifies_by_digest_not_id(self):
        # § 2.1 route 5: a revision SUMMARY carries no id.
        rows = [{"revision_number": 2, "revision_digest": "sha:NEW", "status": "published"}]
        self.assertIs(True, m.c12_revision_listed(rows, "rev-2", "sha:NEW"))
        self.assertIs(False, m.c12_revision_listed(rows, "rev-9", "sha:OTHER"))
        self.assertIs(False, m.c12_revision_listed(rows, "rev-2", ""))  # no id member exists
        self.assertIsNone(m.c12_revision_listed(None, "rev-2", "sha:NEW"))
        self.assertIsNone(m.c12_revision_listed(rows, "", ""))

    def test_later_nodes_on_the_pinned_plan(self):
        self.assertIs(True, one(self._emit(pinned_late=True), "LATER nodes"))
        self.assertIs(False, one(self._emit(pinned_late=False), "LATER nodes"))
        self.assertIsNone(one(self._emit(pinned_late=None), "LATER nodes"))

    def test_revision_listing_reads_three_ways(self):
        self.assertIs(True, one(self._emit(revisions_ok=True), "GET /pipelines"))
        self.assertIs(False, one(self._emit(revisions_ok=False), "GET /pipelines"))
        self.assertIsNone(one(self._emit(revisions_ok=None), "GET /pipelines"))

    def test_repin_touches_new_runs_only(self):
        old = m.c12_row("sha:R|sha:P|rev-1|running")
        rows = m.c12_repin_verdicts(old, old, 200, {"pinned_revision_id": "rev-2"},
                                   {**m.c12_row("sha:R2|sha:P2|rev-2|queued"),
                                    "moved": True, "old_revision_id": "rev-1",
                                    "old_revision_digest": "sha:R"})
        for _l, ok, _d in rows:
            self.assertIs(True, ok, _l)
        rows = m.c12_repin_verdicts(old, m.c12_row("sha:NEW|sha:P|rev-9|running"), 200,
                                   {"pinned_revision_id": "rev-2"}, None)
        self.assertIs(False, one(rows, "live run is NOT moved"))
        self.assertIsNone(one(rows, "NEW run"))
        rows = m.c12_repin_verdicts(old, old, 403, None, None)
        self.assertIs(False, one(rows, "PATCH /assignments"))
        self.assertIsNone(one(rows, "live run is NOT moved"))


class C12dCanonicalization(unittest.TestCase):
    def test_invariance_variant_moves_bytes_not_content(self):
        base = m.c12_rename(twin_doc(), "m4x-c12d")
        variant = m.c12_invariance_variant(base)
        self.assertNotEqual(base, variant)
        self.assertTrue(m.c12_variant_is_same_doc(base, variant))
        self.assertIn('name: "m4x-c12d"', variant)
        self.assertIn("# c12 canonicalization probe", variant)

    def test_a_value_move_is_caught_by_the_probe_itself(self):
        base = m.c12_rename(twin_doc(), "m4x-c12d")
        self.assertFalse(m.c12_variant_is_same_doc(base, m.c12_budget_number_doc(base, "x")
                                                   .get("doc") or ""))
        self.assertFalse(m.c12_variant_is_same_doc(base, ""))
        self.assertFalse(m.c12_variant_is_same_doc(base, base))

    def test_republish_verdicts(self):
        rows = m.c12_republish_verdicts(409, {"code": "revision_already_published",
                                             "existing_revision_id": "rev-1"}, "rev-1",
                                       201, {"id": "rev-2"})
        for _l, ok, _d in rows:
            self.assertIs(True, ok, _l)
        rows = m.c12_republish_verdicts(409, {"code": "revision_already_published"},
                                       "rev-1", 201, {})
        self.assertIs(False, one(rows, "names the EXISTING revision id"))
        rows = m.c12_republish_verdicts(201, {"id": "rev-2"}, "rev-1", 201, {})
        self.assertIs(False, one(rows, "409 revision_already_published"))
        rows = m.c12_republish_verdicts(None, None, "rev-1", None, None)
        self.assertIsNone(one(rows, "409 revision_already_published"))
        self.assertIsNone(one(rows, "budget number publishes normally"))


class C12dProblemCode(unittest.TestCase):
    def test_409_reads_the_code_from_the_problem_type_uri(self):
        # ADR-0014: {type,title,status,detail} — the code arrives as the type URI's
        # last segment (revision-already-published), never as a `code` member.
        body = {"type": "https://communication.dev/errors/revision-already-published",
                "title": "Revision Already Published", "status": 409,
                "detail": "a revision with this document's digest is already published (r-1).",
                "existing_revision_id": "r-1"}
        rows = m.c12_republish_verdicts(409, body, "r-1", 201, {"id": "r-2"})
        self.assertIs(True, one(rows, "409 revision_already_published"), detail(rows, "409"))
        self.assertIs(True, one(rows, "names the EXISTING revision id"))
        self.assertIs(True, one(rows, "budget number publishes normally"))

    def test_a_literal_code_member_still_wins(self):
        rows = m.c12_republish_verdicts(409, {"code": "revision_already_published",
                                             "type": "about:blank",
                                             "existing_revision_id": "r-1"}, "r-1", 201, {})
        self.assertIs(True, one(rows, "409 revision_already_published"))

    def test_a_different_409_is_still_a_fail(self):
        rows = m.c12_republish_verdicts(
            409, {"type": "https://communication.dev/errors/draft-changed-since-validation"},
            "r-1", 201, {})
        self.assertIs(False, one(rows, "409 revision_already_published"), detail(rows, "409"))
        self.assertIs(False, one(rows, "names the EXISTING revision id"))


class C12eDigestSplit(unittest.TestCase):
    def test_whitespace_moves_the_revision_only(self):
        b, a = m.c12_row("sha:R1|sha:P|rev-1|x"), m.c12_row("sha:R2|sha:P|rev-1|x")
        rows = m.c12_digest_split_verdicts("whitespace-only prompt wording", ("revision",), b, a)
        self.assertIs(True, one(rows, "whitespace-only"))
        rows = m.c12_digest_split_verdicts("whitespace-only prompt wording", ("revision",), b, b)
        self.assertIs(False, one(rows, "whitespace-only"))

    def test_operator_moves_both(self):
        b, a = m.c12_row("sha:R1|sha:P1|rev-1|x"), m.c12_row("sha:R2|sha:P2|rev-1|x")
        rows = m.c12_digest_split_verdicts("a passWhen operator", ("revision", "plan"), b, a)
        self.assertIs(True, one(rows, "passWhen operator"))
        rows = m.c12_digest_split_verdicts("a passWhen operator", ("revision", "plan"), b, b)
        self.assertIs(False, one(rows, "passWhen operator"))

    def test_an_unreadable_row_is_a_gap(self):
        rows = m.c12_digest_split_verdicts("x", ("revision",), None, m.c12_row("a|b|c|d"))
        self.assertIsNone(rows[0][1])


class C12Documents(unittest.TestCase):
    def test_each_splice_moves_exactly_one_thing(self):
        doc = twin_doc()
        for fn, label in ((m.c12_one_word_doc, "one prompt word"),
                          (m.c12_ws_doc, "whitespace-only wording"),
                          (m.c12_operator_doc, "passWhen operator"),
                          (m.c12_budget_number_doc, "one changed budget number")):
            got = fn(doc, "m4x-probe")
            self.assertEqual([], got["missing"], label)
            self.assertNotEqual(doc, got["doc"], label)
            self.assertIn("name: m4x-probe", got["doc"])

    def test_a_needle_that_does_not_occur_once_is_a_missing_splice(self):
        got = m.c12_splice(twin_doc(), "n", "Plan written for", "x", "arm")
        self.assertIsNone(got["doc"])
        self.assertTrue(any("arm" in why for why in got["missing"]), got["missing"])
        got = m.c12_splice("not a pipeline", "n", "Plan for", "x", "arm")
        self.assertIsNone(got["doc"])

    def test_whitespace_splice_keeps_the_expression_text(self):
        got = m.c12_ws_doc(twin_doc(), "n")["doc"]
        self.assertIn("${{  inputs.goal  }}", got)
        self.assertNotIn(m.C12_WS_FROM, got)


EXPORT_4SPACE = (
    "apiVersion: communication.dev/v1alpha1\n"
    "kind: Pipeline\n"
    "metadata:\n"
    "    name: m4-exit-twin\n"
    "    description: a deterministic twin\n"
    "spec:\n"
    "    policies:\n"
    "        maxConcurrentNodes: 2\n"
    "        maxDurationSeconds: 3600\n"
    "    nodes: []\n")


@unittest.skipIf(yaml is None, "PyYAML is not installed in this environment")
class C12ProbeDocumentsAreValidYaml(unittest.TestCase):
    """Every C12 probe must be VALID YAML carrying exactly ONE semantic problem. A
    document the loader itself refuses (loader/invalid_yaml) proves nothing about the
    CEL subset or the § 6 caps — the live pass found two such generators (an
    expression starting with a double quote, and node fields indented by 4)."""

    def probes(self):
        docs = {f"C12a {label}": doc
                for label, _e, _c, doc, _loc in m.c12_forbidden_docs()}
        docs["C12b 65 expressions"] = m.c12_exprs_doc("m4x-c12b", m.C12_EXPR_CAP + 1)
        docs["C12b 64 expressions"] = m.c12_exprs_doc("m4x-c12b", m.C12_EXPR_CAP)
        docs["C12b 1001 literal items"] = m.c12_fanout_doc("m4x-c12b", m.C12_ITEMS_CAP + 1)
        docs["C12b 1001 evaluated items"] = m.c12_fanout_run_doc("m4x-c12b",
                                                                  m.C12_ITEMS_CAP + 1)
        docs["C12b wide until body"] = m.c12_exec_budget_doc("m4x-c12b")
        return docs

    def test_each_generated_probe_document_parses_as_yaml(self):
        for label, doc in self.probes().items():
            self.assertTrue(doc, label)
            try:
                loaded = list(yaml.safe_load_all(doc))
            except yaml.YAMLError as e:
                self.fail(f"{label} is not valid YAML: {str(e)[:400]}")
            self.assertEqual("Pipeline", loaded[0]["kind"], label)

    def test_the_yaml_holds_the_semantic_error_not_a_parse_error(self):
        matches_doc = dict(self.probes())["C12a `matches()`"]
        node = list(yaml.safe_load_all(matches_doc))[0]["spec"]["nodes"][0]
        self.assertEqual("until", node["kind"])
        self.assertEqual('"x".matches(".*")', node["config"]["passWhen"])
        over = list(yaml.safe_load_all(self.probes()["C12b 65 expressions"]))[0]
        self.assertEqual(m.C12_EXPR_CAP + 1, len(over["spec"]["nodes"]))
        self.assertEqual(m.C12_EXPR_CAP + 1,
                         sum(str(n["config"].get("prompt", "")).count(m.BIND_OPEN)
                             for n in over["spec"]["nodes"]))
        exact = list(yaml.safe_load_all(self.probes()["C12b 64 expressions"]))[0]
        self.assertEqual(m.C12_EXPR_CAP, len(exact["spec"]["nodes"]))
        fan = list(yaml.safe_load_all(self.probes()["C12b 1001 literal items"]))[0]
        self.assertEqual(m.C12_ITEMS_CAP + 1,
                         len(fan["spec"]["nodes"][0]["config"]["items"]))
        ev = list(yaml.safe_load_all(self.probes()["C12b 1001 evaluated items"]))[0]
        self.assertEqual(f"${{{{ inputs.{m.C12_FAN_ITEMS_INPUT} }}}}",
                         ev["spec"]["nodes"][0]["config"]["items"])
        self.assertEqual(m.C12_ITEMS_CAP + 1,
                         len(ev["spec"]["inputs"]["properties"]
                             [m.C12_FAN_ITEMS_INPUT]["default"]))
        wide = list(yaml.safe_load_all(self.probes()["C12b wide until body"]))[0]
        self.assertEqual(m.C12_BODY_NODES,
                         len(wide["spec"]["nodes"][0]["config"]["body"]["nodes"]))
        self.assertEqual(m.C12_EXEC_BUDGET, wide["spec"]["policies"]["maxNodeExecutions"])


@unittest.skipIf(yaml is None, "PyYAML is not installed in this environment")
class C12dVariantIsContentBlind(unittest.TestCase):
    """C12d's variant changes BYTES only: re-parsing both documents must give the same
    value — on the seed's 2-space source AND on the server's 4-space canonical export,
    whose indentation the first generator assumed away and so emitted '' (a variant 12KB
    shorter than its base, i.e. no variant at all)."""

    def _cases(self):
        seed = twin_doc()
        exported = yaml.dump(yaml.safe_load(seed), sort_keys=False, indent=4, width=100000)
        return {"seed (2-space)": seed, "canonical export (4-space)": exported}

    def test_variant_reparses_equal_to_its_original(self):
        for label, doc in self._cases().items():
            base = m.c12_rename(doc, "m4x-c12d")
            variant = m.c12_invariance_variant(base)
            self.assertTrue(variant, f"{label}: the generator produced no variant")
            self.assertNotEqual(base, variant, label)
            self.assertEqual(yaml.safe_load(base), yaml.safe_load(variant), label)
            self.assertEqual("m4x-c12d", yaml.safe_load(variant)["metadata"]["name"], label)
            self.assertTrue(m.c12_variant_is_same_doc(base, variant), label)

    def test_rename_and_variant_survive_the_4space_export(self):
        renamed = m.c12_rename(EXPORT_4SPACE, "m4x-c12d")
        self.assertIn("    name: m4x-c12d", renamed)
        self.assertNotIn("m4-exit-twin", renamed)
        variant = m.c12_invariance_variant(renamed)
        self.assertTrue(variant)
        self.assertEqual(yaml.safe_load(renamed), yaml.safe_load(variant))
        self.assertTrue(m.c12_variant_is_same_doc(renamed, variant))

    def test_a_value_move_is_still_caught(self):
        for label, doc in self._cases().items():
            base = m.c12_rename(doc, "m4x-c12d")
            sem = m.c12_budget_number_doc(base, "m4x-c12d-sem")
            self.assertEqual([], sem["missing"], label)
            self.assertFalse(m.c12_variant_is_same_doc(base, sem["doc"]), label)
            self.assertNotEqual(yaml.safe_load(base), yaml.safe_load(sem["doc"]), label)


class C12bOverCapItemsAreCompact(unittest.TestCase):
    """live3/C12.out:70 — the arm fanned over `m4-exit.sh items`' {number,title}
    objects, whose 1001-element outputs envelope was 41893 bytes OVER § 6's 32 KiB
    inline cap: /emit failed with node_execution_failed:/emit and /fan never started,
    so the verdict blamed the advancer for the worker's own cap."""

    INLINE_CAP = 32 * 1024

    def setUp(self):
        self.doc = m.c12_fanout_run_doc("m4x-c12b", m.C12_ITEMS_CAP + 1)

    def test_the_document_still_fans_over_the_named_count(self):
        self.assertTrue(self.doc)
        self.assertIn(f"items: '${{{{ inputs.{m.C12_FAN_ITEMS_INPUT} }}}}'", self.doc)
        self.assertIn(f"{m.C12_FAN_ITEMS_INPUT}:", self.doc)
        self.assertNotIn("M4_FANOUT_COUNT", self.doc, "the oversized /emit fixture is back")
        self.assertNotIn("- id: emit", self.doc)

    def test_the_compact_payload_fits_the_inline_cap(self):
        """The COUNT is the point of the cap, so the items must be the smallest legal
        thing that still counts: 1001 integers, well inside § 6's inline bound."""
        import json
        blob = json.dumps(list(range(1, m.C12_ITEMS_CAP + 2)))
        self.assertLess(len(blob.encode()), self.INLINE_CAP,
                        "the over-cap items would themselves need the artifact path")
        block = m.c12_compact_items_yaml(m.C12_ITEMS_CAP + 1)
        self.assertIn("type: array", block)
        parsed = yaml.safe_load("properties:\n" + block)["properties"]
        self.assertEqual(list(range(1, m.C12_ITEMS_CAP + 2)),
                         parsed[m.C12_FAN_ITEMS_INPUT]["default"],
                         "the default array is not 1001 integers")

    def test_the_splice_refuses_a_header_it_does_not_understand(self):
        self.assertEqual("", m.c12_with_input("kind: Pipeline\nnodes:\n", "      x:\n"))
        spliced = m.c12_with_input("a: 1\n  inputs:\n    p: 1\n  outputs:\n      q: 2\n",
                                   "      fan_items:\n        type: array\n")
        self.assertIn("fan_items", spliced.split("  outputs:")[0])
        self.assertIn("q: 2", spliced)

    def test_the_scope_cause_is_read_not_hard_coded(self):
        """Item 4's other half: the arm graded the run row alone with scope_cause="",
        which could not tell the advancer's named cause from the scope's."""
        seen = []
        keep = m.psql
        try:
            m.psql = lambda sql: seen.append(sql) or "fanout_items_exceeded"
            got = m.c12_scope_causes("RUN")
        finally:
            m.psql = keep
        self.assertEqual("fanout_items_exceeded", got)
        self.assertEqual(1, len(seen))
        self.assertIn("failed_cause", seen[0])
        self.assertIn("node_executions", seen[0])
        self.assertIn("RUN", seen[0])
        src = open(os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                "e2e_m4_exit.py"), encoding="utf-8").read()
        body = " ".join(src.split("def c12():")[1].split("# --- C13 pure logic")[0].split())
        self.assertNotIn('C12_FANOUT_RUN_CODE, st or "", cause, "")', body,
                         "the evaluated-items arm still passes a hard-coded empty cause")
        self.assertIn("c12_run_cap", body,
                      "the arm bypasses the reader that takes BOTH causes")

    def test_a_cause_named_only_on_the_scope_row_still_passes(self):
        ok = m.c12_run_code_verdicts("1001 evaluated items", "fanout_items_exceeded",
                                     "failed", "node_execution_failed:/fan",
                                     "fanout_items_exceeded")
        self.assertTrue(one(ok, "1001 evaluated items"))
        self.assertIn("fanout_items_exceeded", detail(ok, "1001 evaluated items"))
        bad = m.c12_run_code_verdicts("1001 evaluated items", "fanout_items_exceeded",
                                      "failed", "node_execution_failed:/emit", "")
        self.assertFalse(one(bad, "1001 evaluated items"))
        self.assertIn("scope_cause=''", detail(bad, "1001 evaluated items"))


@unittest.skipIf(yaml is None, "PyYAML is not installed in this environment")
class C12cPinnedWordingWitness(unittest.TestCase):
    """live3/C12.out:100 — the witness greped approval_requests.summary for the RAW
    `Plan for ${{ inputs.goal }}` needle, but the summary is INTERPOLATED at gate
    creation (`Plan for Document and fix add() in hello.py`, exactly what C9a read
    back), so the arm could never be true and the run looked unpinned."""

    GOAL = "Document and fix add() in hello.py"

    def test_pinned_wording_is_the_interpolated_prefix(self):
        pinned, new = m.c12_pinned_wordings(self.GOAL)
        self.assertEqual(f"Plan for {self.GOAL}", pinned)
        self.assertEqual(f"Plan written for {self.GOAL}", new)

    def test_a_summary_with_the_pinned_wording_passes(self):
        summ = f'{{"summary":"{m.c12_pinned_wordings(self.GOAL)[0]}","state":"pending"}}'
        ok, why = m.c12_pinned_wording_witness(summ, self.GOAL)
        self.assertIs(True, ok, why)

    def test_the_new_revisions_wording_fails_and_names_both_sides(self):
        summ = "summary: " + m.c12_pinned_wordings(self.GOAL)[1]
        ok, why = m.c12_pinned_wording_witness(summ, self.GOAL)
        self.assertIs(False, ok)
        self.assertIn("Plan written for", why)
        self.assertIn("present=False", why)

    def test_the_raw_needle_never_matches_a_real_summary(self):
        """The regression guard: the OLD comparison, spelled out, is False — which is
        why the arm reported a product bug it never measured."""
        summ = f"Plan for {self.GOAL}"
        self.assertNotIn(m.C12_PROMPT_NEEDLE, summ)
        self.assertTrue(m.c12_pinned_wording_witness(summ, self.GOAL)[0])

    def test_unreadable_inputs_are_gaps(self):
        for summ, goal in ((None, self.GOAL), ("", self.GOAL),
                           (f"Plan for {self.GOAL}", ""),
                           (f"Plan for {self.GOAL}", None)):
            ok, why = m.c12_pinned_wording_witness(summ, goal)
            self.assertIsNone(ok, f"{summ!r}/{goal!r} -> {why}")
            self.assertTrue(why)

    def test_wordings_that_do_not_differ_cannot_witness_anything(self):
        ok, why = m.c12_pinned_wording_witness("anything", self.GOAL,
                                               needle="same", repl="same")
        self.assertIsNone(ok)
        self.assertIn("cannot distinguish", why)


class C12IdempotencyKey(unittest.TestCase):
    """live4/C12: c12_run_cap posted the gate's own LABEL as the run's idempotency
    key — 'C12b 1001-item fan-out' — and the API refused the whole arm with 422
    'idempotency key must match ^[A-Za-z0-9._-]{1,128}$.' before the over-cap
    document was ever run. The pattern below is READ from api/openapi.yaml, never
    copied, so the helper fails the day the API tightens."""

    OPENAPI = os.path.join(REPO, "api", "openapi.yaml")

    def patterns(self):
        text = open(self.OPENAPI, encoding="utf-8").read()
        header = re.search(r"name: Idempotency-Key[\s\S]{0,800}?pattern: \"([^\"]+)\"", text)
        body = re.search(r"\n        idempotency:\n +type: string\n +pattern: \"([^\"]+)\"", text)
        self.assertTrue(header and body, "the idempotency pattern vanished from openapi.yaml")
        return header.group(1), body.group(1)

    def test_header_and_body_agree_and_the_helper_follows_them(self):
        pat, pat2 = self.patterns()
        self.assertEqual(pat, pat2)
        rx = re.compile(pat)
        for label in ("C12b 1001-item fan-out", "C12c", "exec budget cap / nodes",
                      "1001 evaluated items", "", "—", "a/b", "x" * 400):
            key = m.idem_key(label, "20261016T081233Z")
            self.assertTrue(rx.match(key), f"{label!r} -> {key!r} breaks {pat}")
            self.assertTrue(key, "an empty key is not a key")

    def test_the_stamp_survives_and_only_the_prefix_shrinks(self):
        rx = re.compile(self.patterns()[0])
        key = m.idem_key("C12b 1001-item fan-out", "20261016T081233Z")
        self.assertEqual("C12b-1001-item-fan-out-20261016T081233Z", key)
        long = m.idem_key("n" * 300, "20261016T081233Z")
        self.assertTrue(rx.match(long))
        self.assertTrue(long.endswith("20261016T081233Z"), long)
        self.assertLessEqual(len(long), 128)

    def test_case_underscores_and_dots_are_kept_as_is(self):
        # unlike metadata.name, the key class allows uppercase and '_'
        self.assertEqual("C12b_x.1-2", m.idem_key("C12b_x.1-2", ""))
        self.assertEqual("m4x-c12c-pin-20261016T081233Z",
                         m.idem_key("m4x-c12c-pin", "20261016T081233Z"))

    def test_two_calls_in_the_same_second_on_different_labels_differ(self):
        a = m.idem_key("C12b 1001-item fan-out", "20261016T081233Z")
        b = m.idem_key("C12b node-exec budget", "20261016T081233Z")
        self.assertNotEqual(a, b, "a stamped key must not collapse two arms onto one run")

    def test_driver_posts_idempotency_keys_through_the_helper(self):
        """No gate hands the API a raw label again: every literal the driver posts
        as `idempotency` must itself satisfy the pattern."""
        _pat, = self.patterns()[:1]
        rx = re.compile(_pat)
        src = open(os.path.join(os.path.dirname(os.path.abspath(__file__)),
                               "e2e_m4_exit.py"), encoding="utf-8").read()
        for literal in re.findall(r'"idempotency": f?"([^"]+)"', src):
            probe = re.sub(r"\{[^}]*\}", "x", literal)
            self.assertTrue(rx.match(probe) and len(probe) <= 128 and probe,
                            f"posted idempotency literal {literal!r} breaks {_pat}")
        self.assertIn("c7_post_run(alice, facts, rid, idem_key(tag), label)", src)


if __name__ == "__main__":
    unittest.main(verbosity=2 if "-v" in sys.argv else 1)
