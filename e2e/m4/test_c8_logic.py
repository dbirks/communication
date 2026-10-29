#!/usr/bin/env python3
"""test_c8_logic.py - offline unit proof for e2e_m4_exit.py's C8 pure logic.

Runs WITHOUT a stack (stdlib unittest only): the fan-out verdict algebra — the
max-in-flight verdict over canned journal commit points, the run-tree shape
verdict over a canned GET /runs/{id}/tree body, the 25 / 24+1 invoke arithmetic,
the depth+project inheritance rows, the zero-item scope, each authored
onChildFailure policy, the cancel cascade, and the detach/depth refusals.

A green here means the VERDICT ALGEBRA is right. It never substitutes for C8's
live 25-child fan-out against the real engine and both workers' capacity split
(12-test-strategy.md: bounded concurrency is only proven by measuring it).

usage: python3 e2e/m4/test_c8_logic.py [-v]
"""
import json
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import e2e_m4_exit as m  # noqa: E402 — importing the driver is the point
import yamlmini as yaml  # noqa: E402 — stdlib YAML subset (CI's python3 has no PyYAML)


def hits(rows, needle):
    """The verdicts whose label mentions `needle` (asserts the arm exists at all)."""
    out = [v for v in rows if needle in v[0]]
    assert out, f"no verdict matching {needle!r} in {[l for l, _o, _d in rows]}"
    return out


def oks(rows, needle):
    return [ok for _l, ok, _d in hits(rows, needle)]


def one(rows, needle):
    vs = oks(rows, needle)
    assert len(vs) == 1, f"{needle!r} produced {len(vs)} verdicts"
    return vs[0]


def err(code, loc):
    return {"code": code, "source": "compiler", "message": code, "instance_location": loc,
            "schema_location": None, "hint": ""}


def vbody(errors, valid=False):
    return {"valid": valid, "errors": errors, "notes": [], "digest_scope": "v1alpha1-canonical-1"}


def tree(parent="PARENT", n=25, key_prefix="/fan_out[", depth=1, keyed=True):
    kids = [{"run": {"id": f"K{i}", "status": "succeeded", "depth": depth},
             "node_instance_key": (key_prefix + str(i) + "]/invoke") if keyed else None,
             "depth": depth, "children": []} for i in range(1, n + 1)]
    return {"run": {"id": parent, "status": "running"}, "children": kids}


class SampleTest(unittest.TestCase):
    def test_parse_keeps_only_real_commit_points(self):
        pts = m.c8_running_samples("10|1\n11|2\nNOTICE: whatever\n12|3\n13|x\n")
        self.assertEqual([10, 11, 12], [s for s, _c in pts])
        self.assertEqual([1, 2, 3], [c for _s, c in pts])

    def test_empty_series_has_no_peak(self):
        self.assertEqual([], m.c8_running_samples(""))
        self.assertIsNone(m.c8_max_in_flight([]))
        self.assertIsNone(m.c8_max_in_flight(None))

    def test_thinning_never_hides_the_peak(self):
        pts = [(i, 1) for i in range(1, 100)] + [(50, 3)]
        out = m.c8_sample_series(pts, every=25)
        self.assertEqual(3, max(c for _s, c in out))
        self.assertLess(len(out), len(pts))
        self.assertEqual([], m.c8_sample_series([], 5))


class ConcurrencyTest(unittest.TestCase):
    def test_peak_within_cap_and_parallel_passes(self):
        vs = m.c8_concurrency_verdicts([(1, 1), (2, 3), (3, 2), (4, 0)])
        self.assertTrue(one(vs, "<= 3"))
        self.assertTrue(one(vs, "saw parallelism"))
        self.assertTrue(one(vs, "more than one commit point"))

    def test_over_run_is_a_fail_never_inferred(self):
        vs = m.c8_concurrency_verdicts([(1, 3), (2, 4), (3, 1)])
        self.assertFalse(one(vs, "<= 3"))

    def test_no_samples_is_a_gap(self):
        vs = m.c8_concurrency_verdicts([])
        self.assertIsNone(one(vs, "<= 3"))

    def test_serial_run_gaps_the_parallelism_proof(self):
        vs = m.c8_concurrency_verdicts([(i, 1) for i in range(1, 6)])
        self.assertTrue(one(vs, "<= 3"))
        self.assertIsNone(one(vs, "saw parallelism"))

    def test_single_point_sample_cannot_prove_the_cap(self):
        vs = m.c8_concurrency_verdicts([(9, 2)])
        self.assertTrue(one(vs, "<= 3"))
        self.assertIsNone(one(vs, "more than one commit point"))

    def test_cap_is_what_the_graph_authored(self):
        self.assertFalse(one(m.c8_concurrency_verdicts([(1, 3), (2, 3), (3, 2)], cap=2), "<= 2"))


class TreeTest(unittest.TestCase):
    def test_full_tree_passes(self):
        vs = m.c8_tree_verdicts(tree(), "PARENT", 25)
        self.assertTrue(one(vs, "shows every child"))
        self.assertTrue(one(vs, "DISTINCT runs"))
        self.assertTrue(one(vs, "node_instance_key"))
        self.assertTrue(one(vs, "root is the parent"))
        self.assertTrue(one(vs, "depth is 1"))

    def test_missing_child_is_a_fail(self):
        vs = m.c8_tree_verdicts(tree(n=24), "PARENT", 25)
        self.assertFalse(one(vs, "shows every child"))

    def test_unreadable_body_is_a_gap(self):
        for junk in (None, {}, "nope", {"run": {"id": "P"}}):
            self.assertIsNone(one(m.c8_tree_verdicts(junk, "P", 25), "shows every child"))

    def test_keyless_children_fail(self):
        vs = m.c8_tree_verdicts(tree(keyed=False), "P", 25)
        self.assertFalse(one(vs, "node_instance_key"))

    def test_duplicate_child_ids_fail_distinctness(self):
        doc = tree(n=3)
        doc["children"][1]["run"]["id"] = doc["children"][0]["run"]["id"]
        self.assertFalse(one(m.c8_tree_verdicts(doc, "P", 3), "DISTINCT runs"))

    def test_wrong_root_and_wrong_depth_fail(self):
        vs = m.c8_tree_verdicts(tree(parent="OTHER", depth=2), "P", 25)
        self.assertFalse(one(vs, "root is the parent"))
        self.assertFalse(one(vs, "depth is 1"))


class LedgerArithmeticTest(unittest.TestCase):
    def test_25_children_with_one_failure(self):
        vs = m.c8_child_count_verdicts("succeeded|24\nfailed|1")
        self.assertTrue(one(vs, "total 25"))
        self.assertTrue(one(vs, "1 failed child"))
        self.assertTrue(one(vs, "siblings preserved"))

    def test_lost_sibling_is_a_fail(self):
        vs = m.c8_child_count_verdicts("succeeded|23\nfailed|1")
        self.assertFalse(one(vs, "total 25"))
        self.assertFalse(one(vs, "siblings preserved"))

    def test_two_failures_is_a_fail(self):
        self.assertFalse(one(m.c8_child_count_verdicts("succeeded|23\nfailed|2"), "1 failed"))

    def test_no_rows_is_a_gap(self):
        self.assertIsNone(one(m.c8_child_count_verdicts(""), "readable"))

    def test_garbage_count_never_reads_as_zero(self):
        self.assertIsNone(one(m.c8_child_count_verdicts("succeeded|x"), "readable"))

    def test_depth_and_project_inheritance(self):
        vs = m.c8_depth_project_verdicts("1", "t", "PROJ")
        self.assertTrue(one(vs, "depth = parent.depth+1"))
        self.assertTrue(one(vs, "inherit project"))

    def test_wrong_depth_and_foreign_project_fail(self):
        vs = m.c8_depth_project_verdicts("2", "f", "PROJ")
        self.assertFalse(one(vs, "depth = parent.depth+1"))
        self.assertFalse(one(vs, "inherit project"))

    def test_missing_inheritance_rows_gap(self):
        vs = m.c8_depth_project_verdicts("", "", "PROJ")
        self.assertIsNone(one(vs, "depth = parent.depth+1"))
        self.assertIsNone(one(vs, "inherit project"))

    def test_invoke_keys_are_deduped_and_sorted(self):
        self.assertEqual(["/fan_out[1]/invoke", "/fan_out[2]/invoke"],
                         m.c8_invoke_keys("/fan_out[2]/invoke\n/fan_out[1]/invoke\n"
                                          "/fan_out[2]/invoke\n\n"))
        self.assertEqual([], m.c8_invoke_keys(None))


class ZeroItemTest(unittest.TestCase):
    def test_clean_zero_item_run_passes(self):
        vs = m.c8_zero_item_verdicts(
            "succeeded", '{"items":0,"scope_key":"/fan_out"}', "[]", "completed")
        self.assertEqual([True, True, True, True], [ok for _l, ok, _d in vs])

    def test_skip_instead_of_empty_completion_is_a_fail(self):
        vs = m.c8_zero_item_verdicts("skipped", '{"items":0}', "[]", "completed")
        self.assertFalse(vs[0][1])

    def test_missing_journal_line_gaps_only_itself(self):
        vs = m.c8_zero_item_verdicts("succeeded", None, "[]", "completed")
        self.assertIsNone(vs[1][1])
        self.assertTrue(vs[0][1] and vs[2][1] and vs[3][1])

    def test_nonempty_children_array_fails(self):
        self.assertFalse(m.c8_zero_item_verdicts("succeeded", '{"items":0}',
                                                 '[{"child_run_id":"k"}]', "completed")[2][1])

    def test_run_that_never_completes_fails(self):
        vs = m.c8_zero_item_verdicts("succeeded", '{"items":0}', "[]", "failed")
        self.assertFalse(vs[3][1])

    def test_items_not_zero_is_a_fail(self):
        self.assertFalse(one(m.c8_zero_item_verdicts("succeeded", '{"items":3}', "[]",
                                                     "completed"), "node.scope.completed"))


class PolicyTest(unittest.TestCase):
    def test_collect_and_continue_completes_the_scope(self):
        vs = m.c8_policy_verdicts("collect_and_continue", "succeeded", None, 25, 24, 0)
        self.assertTrue(one(vs, "scope COMPLETES"))
        self.assertTrue(one(vs, "children ran"))

    def test_collect_and_continue_that_failed_the_scope_is_a_fail(self):
        self.assertFalse(one(m.c8_policy_verdicts("collect_and_continue", "failed",
                                                  "child_failed", 25, 24, 0),
                             "scope COMPLETES"))

    def test_stop_cancels_queued_and_keeps_completed(self):
        vs = m.c8_policy_verdicts("stop", "failed", "child_failed", 9, 5, 4)
        self.assertTrue(one(vs, "failed_cause=child_failed"))
        self.assertTrue(one(vs, "queued siblings cancelled"))
        self.assertTrue(one(vs, "preserved"))

    def test_stop_that_ran_everything_did_not_stop(self):
        vs = m.c8_policy_verdicts("stop", "failed", "child_failed", 25, 24, 0)
        self.assertFalse(one(vs, "queued siblings cancelled"))

    def test_stop_without_evidence_gaps(self):
        vs = m.c8_policy_verdicts("stop", "failed", "child_failed", None, None, None)
        self.assertTrue(one(vs, "failed_cause=child_failed"))
        self.assertIsNone(one(vs, "queued siblings cancelled"))
        self.assertIsNone(one(vs, "preserved"))

    def test_fail_after_all_wants_all_25_then_fail(self):
        self.assertTrue(one(m.c8_policy_verdicts("fail_after_all", "failed", "child_failed",
                                                 25, 24, 0), "then the scope fails"))
        self.assertFalse(one(m.c8_policy_verdicts("fail_after_all", "failed", "child_failed",
                                                  13, 12, 0), "then the scope fails"))
        self.assertIsNone(one(m.c8_policy_verdicts("fail_after_all", "failed", "child_failed",
                                                   None, None, None), "then the scope fails"))

    def test_unknown_policy_gaps_instead_of_defaulting(self):
        self.assertIsNone(one(m.c8_policy_verdicts("detach", "succeeded", None, 25, 24, 0),
                              "onChildFailure policy"))


class CancelAndRefusalTest(unittest.TestCase):
    def test_clean_cascade_passes(self):
        vs = m.c8_cancel_verdicts("cancelled", '{"cascade":true,"children":["a"]}',
                                  ["cancelled", "failed", "completed"], ["att-1"])
        self.assertEqual([True, True, True], [ok for _l, ok, _d in vs])

    def test_child_left_running_is_a_fail(self):
        vs = m.c8_cancel_verdicts("cancelled", '{"cascade":true}', ["cancelled", "running"], [])
        self.assertFalse(vs[1][1])
        self.assertFalse(vs[2][1])

    def test_no_cascade_event_gaps(self):
        self.assertIsNone(m.c8_cancel_verdicts("cancelled", None, ["cancelled"], [])[0][1])

    def test_detach_refused_at_validate(self):
        vs = m.c8_detach_verdict(vbody([err("unsupported_policy",
                                            "/spec/policies/cancelPolicy")]))
        self.assertTrue(one(vs, "detach is refused"))

    def test_detach_silently_ignored_is_a_fail(self):
        self.assertFalse(one(m.c8_detach_verdict(vbody([], True)), "detach is refused"))

    def test_unreadable_validate_body_gaps(self):
        for junk in (None, {}, {"errors": "nope"}):
            self.assertIsNone(one(m.c8_detach_verdict(junk), "detach is refused"))

    def test_self_invoke_depth_guard(self):
        chain = {"two_root_status": "completed", "two_depths": ["1", "2"],
                 "third_attempted": True, "depth3_rows": 0}
        vs = m.c8_depth_guard_verdicts(vbody([err("child_depth_exceeded", "/spec/nodes/0")]),
                                       chain)
        self.assertTrue(one(vs, "child_depth_exceeded"))
        self.assertTrue(one(vs, "two-level chain succeeds"))
        self.assertTrue(one(vs, "third level refused"))

    def test_depth_guard_without_a_body_gaps(self):
        vs = m.c8_depth_guard_verdicts(None, None)
        self.assertIsNone(one(vs, "child_depth_exceeded"))
        self.assertIsNone(one(vs, "two-level chain succeeds"))
        self.assertIsNone(one(vs, "third level refused"))

    def test_valid_self_invoke_is_a_fail(self):
        self.assertFalse(one(m.c8_depth_guard_verdicts(vbody([], True), None),
                             "child_depth_exceeded"))

    def test_a_depth_3_row_is_a_fail_never_a_refusal(self):
        """If the product BOOKED a depth-3 run it did not refuse — the gate reports
        that, it does not hide it behind a status code."""
        chain = {"two_root_status": "completed", "two_depths": ["1", "2"],
                 "third_attempted": True, "depth3_rows": 1}
        self.assertFalse(one(m.c8_depth_guard_verdicts(None, chain), "third level refused"))

    def test_third_level_never_attempted_gaps(self):
        for chain in ({"two_root_status": "completed", "two_depths": ["1", "2"],
                       "third_attempted": False, "depth3_rows": 0},
                      {"two_root_status": "completed", "two_depths": ["1", "2"],
                       "third_attempted": True, "depth3_rows": None}):
            self.assertIsNone(one(m.c8_depth_guard_verdicts(None, chain),
                                  "third level refused"), str(chain))

    def test_two_level_arm_needs_depth_2_and_a_completed_root(self):
        base = {"third_attempted": True, "depth3_rows": 0}
        shallow = dict(base, two_root_status="completed", two_depths=["1"])
        self.assertFalse(one(m.c8_depth_guard_verdicts(None, shallow),
                             "two-level chain succeeds"))
        stuck = dict(base, two_root_status="running", two_depths=["1", "2"])
        self.assertFalse(one(m.c8_depth_guard_verdicts(None, stuck),
                             "two-level chain succeeds"))
        unreadable = dict(base, two_root_status=None, two_depths=None)
        self.assertIsNone(one(m.c8_depth_guard_verdicts(None, unreadable),
                              "two-level chain succeeds"))


class PolicyArmDocTest(unittest.TestCase):
    """C8e's own parent revision: the copy is ONLY the policy line (plus the
    schema-legal rename) or the arm measures nothing."""

    def twin(self, policy="collect_and_continue"):
        return {"apiVersion": "communication.dev/v1alpha1", "kind": "Pipeline",
                "metadata": {"name": m.TW_SLUG},
                "spec": {"nodes": [
                    {"id": "fan_out", "kind": "for_each",
                     "config": {"items": "x", "maxConcurrency": 3,
                                "onChildFailure": policy}},
                    {"id": "plan", "kind": "process.exec",
                     "config": {"executable": "m4-exit.sh"}}]}}

    def test_stop_copy_swaps_only_the_policy(self):
        src = self.twin()
        res = m.c8e_policy_doc(src, "m4x-c8e-stop-1", "stop")
        self.assertIsNotNone(res["doc"])
        self.assertIn("onChildFailure: stop", res["doc"])
        self.assertNotIn("collect_and_continue", res["doc"])
        self.assertEqual(["metadata.name",
                          "/fan_out onChildFailure: collect_and_continue -> stop"],
                         res["applied"])
        self.assertEqual(m.TW_SLUG, src["metadata"]["name"], "the seed copy stays untouched")
        self.assertEqual("collect_and_continue",
                         src["spec"]["nodes"][0]["config"]["onChildFailure"])

    def test_fail_after_all_copy_and_source_sanity_guards(self):
        res = m.c8e_policy_doc(self.twin(), "m4x-c8e-faa-1", "fail_after_all")
        self.assertIn("onChildFailure: fail_after_all", res["doc"])
        already = m.c8e_policy_doc(self.twin("fail_after_all"), "x", "fail_after_all")
        self.assertIsNone(already["doc"])       # measuring the seed's own value proves nothing
        seed_arm = m.c8e_policy_doc(self.twin(), "x", "collect_and_continue")
        self.assertIsNone(seed_arm["doc"])      # that arm is C8d's, already live
        nofan = m.c8e_policy_doc({"apiVersion": "a", "kind": "Pipeline",
                                  "metadata": {"name": "n"}, "spec": {"nodes": []}},
                                 "x", "stop")
        self.assertIsNone(nofan["doc"])
        self.assertIsNone(m.c8e_policy_doc(None, "x", "stop")["doc"])

    def test_counts_by_status(self):
        self.assertEqual({"succeeded": 24, "failed": 1},
                         m.c8_counts_by_status("succeeded|24\nfailed|1\n"))
        self.assertEqual({}, m.c8_counts_by_status(None))
        self.assertEqual({"cancelled": 12}, m.c8_counts_by_status("cancelled|12\nnotarow\n"))
        self.assertNotIn("succeeded", m.c8_counts_by_status("succeeded|x"))

    def test_stop_event_verdict_is_tri_state(self):
        self.assertTrue(one(m.c8_stop_event_verdict(3), "on_child_failure_stop"))
        self.assertFalse(one(m.c8_stop_event_verdict(0), "on_child_failure_stop"))
        self.assertIsNone(one(m.c8_stop_event_verdict(None), "on_child_failure_stop"))


class ChainLevelDocTest(unittest.TestCase):
    """C8f's chain levels are seed-header documents with only inputs/outputs and the
    single invoke node swapped — the shape known to publish, not an invented one."""

    def test_chain_doc_shape_round_trips(self):
        doc = m.c8_chain_doc("m4x-c8f-l2", "m4x-c8f-l3")
        self.assertIn("apiVersion: communication.dev/v1alpha1", doc)
        parsed = yaml.safe_load(doc)
        self.assertEqual("m4x-c8f-l2", parsed["metadata"]["name"])
        spec = parsed["spec"]
        self.assertEqual(1, spec["policies"]["maxChildDepth"])
        self.assertNotIn("required", spec["inputs"], "POST /runs {} must pin it")
        self.assertEqual(1, spec["inputs"]["properties"]["number"]["default"])
        self.assertEqual(1, len(spec["nodes"]))
        node = spec["nodes"][0]
        self.assertEqual("pipeline.invoke", node["kind"])
        self.assertEqual("m4x-c8f-l3", node["config"]["pipeline"])
        self.assertEqual(1, node["config"]["inputs"]["number"],
                         "issue-implementation declares number as an INTEGER")
        self.assertEqual("cascade", spec["policies"]["cancelPolicy"])

    def test_empty_when_header_unreadable(self):
        keep = m._C13_HEADER.get("header")
        try:
            m._C13_HEADER["header"] = ""
            self.assertEqual("", m.c8_chain_doc("n", "t"))
        finally:
            m._C13_HEADER.pop("header", None)
            if keep is not None:
                m._C13_HEADER["header"] = keep


class SeedShapeTest(unittest.TestCase):
    def test_run_inputs_arm_the_branch_without_touching_the_rest(self):
        inp = m.c8_inputs({"goal": "ship it", "repository": "app", "fanout": False,
                           "fanout_count": 0}, 25)
        self.assertEqual({"goal": "ship it", "repository": "app", "fanout": True,
                          "fanout_count": 25}, inp)

    def test_missing_or_unparseable_manifest_reads_as_no_facts(self):
        import tempfile
        keep = m.MANIFEST_PATH
        try:
            m.MANIFEST_PATH = "/nonexistent/seed-manifest.json"
            self.assertEqual({}, m.c8_seed_facts())
            with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
                f.write("{ not json")
                m.MANIFEST_PATH = f.name
            self.assertEqual({}, m.c8_seed_facts())
            with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
                json.dump({"project": {"id": "P"}, "pipelines": {},
                           "runs": [{"pipeline_slug": m.FD_SLUG, "inputs": {}}]}, f)
                m.MANIFEST_PATH = f.name
            self.assertEqual({}, m.c8_seed_facts())
        finally:
            m.MANIFEST_PATH = keep

    def test_seed_facts_take_the_TWIN_assignment_verbatim(self):
        """docs/m4-contract.md § 7.1 C8's counts come from the LEDGER, so the gate
        arms the deterministic twin; the agent variant's /plan dies on an unattended
        permission prompt (ADR-0016) and live4/C8 measured that instead of fan-out."""
        import tempfile
        keep = m.MANIFEST_PATH
        try:
            with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
                json.dump({"project": {"id": "P"},
                           "pipelines": {m.FD_SLUG: {"pipeline_id": "AGENT_PIPE",
                                                     "revision_id": "AGENT_R",
                                                     "assignment_id": "AGENT_A"},
                                         m.TW_SLUG: {"pipeline_id": "TWIN_PIPE",
                                                     "revision_id": "TWIN_R",
                                                     "assignment_id": "TWIN_A"},
                                         m.II_SLUG: {"pipeline_id": "CHILD",
                                                     "revision_id": "CREV"}},
                           "runs": [{"pipeline_slug": m.FD_SLUG, "variant": "agent",
                                     "inputs": {"goal": "agent goal", "fanout": False}},
                                    {"pipeline_slug": m.TW_SLUG, "variant": "twin",
                                     "inputs": {"goal": "g", "fanout": False}}]}, f)
                m.MANIFEST_PATH = f.name
            got = m.c8_seed_facts()
            self.assertEqual("TWIN_A", got["assignment_id"])
            self.assertEqual("TWIN_R", got["revision_id"])
            self.assertEqual("TWIN_PIPE", got["pipeline_id"])
            self.assertEqual("CHILD", got["child_pipeline_id"])
            self.assertEqual("g", got["inputs"]["goal"])
        finally:
            m.MANIFEST_PATH = keep

    def test_an_agent_only_manifest_is_no_facts_at_all(self):
        """The agent variant is not a fallback: a fan-out arm that cannot reach
        /fan_out unattended is a GAP naming the missing twin, never an agent run."""
        import tempfile
        keep = m.MANIFEST_PATH
        try:
            with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
                json.dump({"project": {"id": "P"},
                           "pipelines": {m.FD_SLUG: {"pipeline_id": "PIPE", "revision_id": "R",
                                                     "assignment_id": "A"},
                                         m.II_SLUG: {"pipeline_id": "CHILD"}},
                           "runs": [{"pipeline_slug": m.FD_SLUG, "inputs": {}}]}, f)
                m.MANIFEST_PATH = f.name
            self.assertEqual({}, m.c8_seed_facts())
        finally:
            m.MANIFEST_PATH = keep

    def test_twin_run_is_found_by_variant_alone(self):
        """seed.sh's runs[] name the variant; the slug is not always repeated."""
        import tempfile
        keep = m.MANIFEST_PATH
        try:
            with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
                json.dump({"project": {"id": "P"},
                           "pipelines": {m.TW_SLUG: {"pipeline_id": "TP", "revision_id": "TR",
                                                     "assignment_id": "TA"},
                                         m.II_SLUG: {"pipeline_id": "CHILD"}},
                           "runs": [{"variant": "twin", "inputs": {"goal": "tg"}}]}, f)
                m.MANIFEST_PATH = f.name
            self.assertEqual("tg", m.c8_seed_facts()["inputs"]["goal"])
        finally:
            m.MANIFEST_PATH = keep

    def test_children_verdicts_survive_an_unreadable_children_array(self):
        """live4/C8: the C8d detail string iterated `children` while the verdict
        guarded it — the TypeError took the cancel and depth arms down with it."""
        v = m.c8_children_verdicts(None)
        self.assertEqual([None, None], [ok for _l, ok, _d in v])
        self.assertEqual("unparsed entries", [d for _l, _o, d in v][0])
        v = m.c8_children_verdicts([])
        self.assertEqual([False, None], [ok for _l, ok, _d in v])
        kids = [{"child_run_id": f"r{n}", "number": n} for n in range(1, m.C8_ITEMS + 1)]
        v = m.c8_children_verdicts(kids)
        self.assertTrue(all(ok for _l, ok, _d in v), v)
        bad = kids[:m.C8_ITEMS - 1] + [{"number": m.C8_ITEMS}]
        self.assertFalse([ok for _l, ok, _d in m.c8_children_verdicts(bad)][1])
        # a non-dict entry is a malformed child: the verdict says so, no TypeError
        mixed = [{"child_run_id": "r1"}, "not-a-child"]
        lmixed = m.c8_children_verdicts(mixed)
        self.assertFalse([ok for _l, ok, _d in lmixed][1])
        self.assertEqual("[['child_run_id']]", [d for _l, _o, d in lmixed][1])

    def test_self_invoke_document_splices_a_real_invoke_node(self):
        doc = m.C8_SELF_DOC_NODE.replace("@@NAME@@", "issue-implementation")
        self.assertIn("kind: for_each", doc)
        self.assertIn("pipeline: 'issue-implementation'", doc)
        self.assertEqual(m.C8_ITEMS, 25)
        self.assertEqual(m.C8_MAX_CONCURRENCY, json.loads('{"cap": 3}')["cap"])
        self.assertEqual(3, m.C8_MAX_CONCURRENCY)


class SqlReaderTest(unittest.TestCase):
    """live2/C8.out:11 — `NameError: name 'c8_sql' is not defined` killed the gate at
    its first ledger read (c8_scope_row), so C8b-C8h never ran and C3a/C3c (which read
    C8's deep queue) had nothing to contend on. c8_sql is the same honest reader the
    other gates define (c7_sql/c10_sql/c11_sql): text on success, None + a printed
    note when psql refuses — a ledger that will not answer is never a zero."""

    def test_c8_sql_exists_and_is_the_reader_the_helpers_call(self):
        self.assertTrue(callable(getattr(m, "c8_sql", None)),
                        "c8_sql must be defined: every c8_* reader calls it")
        src = open(os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                "e2e_m4_exit.py"), encoding="utf-8").read()
        self.assertIn("def c8_sql(", src)
        self.assertEqual(0, src.count("\nc8_sql = "), "no shadow assignment")

    def test_reads_psql_text_verbatim(self):
        keep = m.psql
        try:
            m.psql = lambda sql: "succeeded|pending|-|[]"
            self.assertEqual("succeeded|pending|-|[]",
                             m.c8_sql("SELECT 1", "scope row"))
        finally:
            m.psql = keep

    def test_a_refusing_ledger_is_none_not_a_zero(self):
        import io
        import contextlib
        keep = m.psql
        buf = io.StringIO()
        try:
            def boom(_sql):
                raise RuntimeError("psql failed rc=1: ERROR: relation does not exist")
            m.psql = boom
            with contextlib.redirect_stdout(buf):
                self.assertIsNone(m.c8_sql("SELECT 1", "scope row"))
        finally:
            m.psql = keep
        self.assertIn("scope row", buf.getvalue(),
                      "the psql failure must be printed, not swallowed")
        self.assertNotIn("PASS", buf.getvalue())

    def test_scope_row_survives_an_unreadable_ledger(self):
        """The exact call that crashed the gate must now return {} (a GAP upstream)."""
        keep = m.psql
        try:
            def boom(_sql):
                raise RuntimeError("psql failed rc=1")
            m.psql = boom
            self.assertEqual({}, m.c8_scope_row("00000000-0000-0000-0000-000000000000"))
        finally:
            m.psql = keep


class DriverQueryTest(unittest.TestCase):
    """The four DRIVER bugs the last C8 diagnosis found. Each one hid a real product
    behaviour behind a broken reader: the re-wrapped children array, the 'true'-vs-'t'
    inheritance flag, the journal sweep that control-plane invokes never populate
    (ADR-0023 § 3 — no lease, no node.attempt.* events), and the 2-space node spliced
    into a 4-space yaml.Marshal export. The product side of the depth guard is fixed
    and committed; the driver just has to be able to see it."""

    def setUp(self):
        self.keep, self.seen = m.psql, []
        m.psql = lambda sql: self.seen.append(sql) or ""

    def tearDown(self):
        m.psql = self.keep

    def test_scope_row_reads_children_without_rewrapping_them(self):
        """jsonb_path_query_array(outputs,'$.children') wraps the matched array in ANOTHER
        array: [] -> [[]] and 25 entries -> 1. The verdicts then measured the driver."""
        m.c8_scope_row("R")
        sql = self.seen[-1]
        self.assertIn("(outputs -> 'children')::text", sql)
        self.assertNotIn("jsonb_path_query_array", sql)

    def test_scope_row_children_text_is_the_bare_array(self):
        keep = m.psql
        try:
            m.psql = lambda sql: "succeeded|-|-|[]"
            row = m.c8_scope_row("R")
        finally:
            m.psql = keep
        self.assertEqual("[]", row["children"])
        self.assertTrue(one(m.c8_zero_item_verdicts(row["status"], '{"items": 0}',
                                                    row["children"], "completed"),
                            "outputs.children is the EMPTY array"))

    def test_child_project_inheritance_emits_t_not_true(self):
        """(c.project_id = '…')::text prints 'true'; the verdict wants 't'. The gate
        GAPped inheritance on children that had it."""
        m.c8_child_shape("R", "PROJ")
        sql = self.seen[-1]
        self.assertIn("CASE WHEN c.project_id = 'PROJ' THEN 't' ELSE 'f' END", sql)
        self.assertNotIn("c.project_id = 'PROJ')::text", sql)
        vs = m.c8_depth_project_verdicts("1", "t", "PROJ")
        self.assertTrue(one(vs, "children inherit project"))
        self.assertFalse(one(m.c8_depth_project_verdicts("1", "f", "PROJ"),
                             "children inherit project"))

    def test_concurrency_sweep_reads_node_executions_not_the_journal(self):
        """ADR-0023 § 3: a control-plane invoke never takes a lease and emits no
        node.attempt.* events, so the journal sweep returned nothing and C8c could
        only ever GAP. The in-flight curve comes from ready_at (+1) / finished_at (-1)
        over the parent's own pipeline.invoke rows."""
        sql = m.c8_running_sample_sql("R")
        self.assertIn("kind = 'pipeline.invoke'", sql)
        self.assertIn("SELECT ready_at AS ts, 1 AS d", sql)
        self.assertIn("SELECT finished_at AS ts, -1 AS d", sql)
        self.assertIn(m.C8_FAN_OUT_KEY, sql)
        self.assertIn(m.C8_INVOKE_SUFFIX, sql)
        self.assertNotIn("domain_events", sql)
        self.assertNotIn("node.attempt.", sql)
        self.assertIn("ORDER BY ts, d", sql)   # -1 before +1: a boundary touch is not overlap
        self.assertIn("run_id = 'R'", sql)

    def test_sweep_rows_still_feed_the_peak_verdicts(self):
        pts = m.c8_running_samples("1|1\n2|2\n3|3\n4|2\n5|3\n6|2\n7|1\n8|0\n")
        self.assertEqual(3, m.c8_max_in_flight(pts))
        vs = m.c8_concurrency_verdicts(pts)
        self.assertTrue(one(vs, "<= 3"))
        self.assertTrue(one(vs, "saw parallelism"))

    def test_self_invoke_document_is_one_valid_yaml_export(self):
        """The splice target was the yaml.Marshal'd GET /revisions/{id}/document (4-space
        node indentation) while C8_SELF_DOC_NODE is written at the seed's 2 spaces, so the
        draft died invalid_yaml before the compiler ever saw the self-invoke."""
        doc = m.c13_doc("issue-implementation",
                        m.C8_SELF_DOC_NODE.replace("@@NAME@@", "issue-implementation"))
        self.assertIn("apiVersion: communication.dev/v1alpha1", doc,
                      "c13_doc must produce the seed header")
        parsed = yaml.safe_load(doc)
        nodes = parsed["spec"]["nodes"]
        self.assertEqual("for_each", nodes[0]["kind"])
        self.assertEqual(1, nodes[0]["config"]["maxConcurrency"])
        self.assertEqual("collect_and_continue", nodes[0]["config"]["onChildFailure"])
        invoke = nodes[0]["config"]["body"]["nodes"][0]
        self.assertEqual("pipeline.invoke", invoke["kind"])
        self.assertEqual("issue-implementation", parsed["metadata"]["name"])
        self.assertEqual("issue-implementation", invoke["config"]["pipeline"])
        # configPipelineInvoke.inputs values are bindingOrString: a bare 1 is a
        # schema_shape error that would drown the child_depth_exceeded being measured.
        self.assertEqual("1", invoke["config"]["inputs"]["number"])
        self.assertIsInstance(invoke["config"]["inputs"]["number"], str)

    def test_self_invoke_is_built_from_the_seed_document_not_a_revision_export(self):
        src = open(os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                "e2e_m4_exit.py"), encoding="utf-8").read()
        body = src[src.index("def c8():"):src.index("# --- C9 pure logic")]
        self.assertIn("self_doc = c13_doc(", body)
        self.assertNotIn("src.text.replace", body)
        self.assertEqual(1, body.count("c8_depth_guard_verdicts("),
                        "the depth guard emits exactly once, from the live probe")


if __name__ == "__main__":
    unittest.main(verbosity=2 if "-v" in sys.argv else 1)
