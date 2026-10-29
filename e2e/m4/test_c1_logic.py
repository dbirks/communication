#!/usr/bin/env python3
"""test_c1_logic.py — offline unit proof for e2e_m4_exit.py's C1 pure helpers.

Runs WITHOUT a stack (stdlib unittest only): manifest normalization against a
canned seed-manifest/1 shaped exactly like docs/compatibility/probes/m4/
README.md documents, key-set algebra, SSE frame parsing, the § 7.1 C1h
journal-shape and ADR-0023 § 3 correlation rules against canned envelopes
built from api/schemas/event-envelope.schema.json's members, and the C1g
result-binding checks. A green here means the LOGIC is right; it never
substitutes for C1's live § 7 run (12-test-strategy.md).

usage: python3 e2e/m4/test_c1_logic.py [-v]
"""
import json
import os
import re
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import e2e_m4_exit as m  # noqa: E402 — import of the driver is the point
import yamlmini as yaml  # noqa: E402 — stdlib YAML subset (CI's python3 has no PyYAML)

HEX_A = "sha256:" + "a" * 64
HEX_B = "sha256:" + "b" * 64
HEX_C = "sha256:" + "c" * 64
HEX_D = "sha256:" + "d" * 64


def manifest_doc(**breaks):
    """A faithful m4-seed-manifest/1 (README format) with surgical mutations."""
    doc = {
        "schema": "m4-seed-manifest/1",
        "seeded_at": "2026-10-15T09:00:00Z",
        "stack": {"compose_project": "communication-m4", "url": "http://localhost:18091"},
        "users": {"alice": "u-a", "bob": "u-b", "carol": "u-c", "dan": "u-d"},
        "project": {"id": "p-1", "slug": "m4-exit"},
        "repositories": {"app": {"id": "r-1", "git_url": "file:///srv/m4/fixtures/app.git"}},
        "profiles": {"m4-planner": "pf-1", "m4-implementer": "pf-2", "m4-reviewer": "pf-3"},
        "secret": {"id": "s-1", "slug": "test-database-url", "mount_id": "sm-1",
                   "env_name": "DATABASE_URL", "lifecycle": "node_attempt",
                   "allowed_profile": "m4-implementer"},
        "pipelines": {
            "feature-development": {
                "pipeline_id": "pi-a", "slug": "feature-development", "revision_id": "rv-a",
                "revision_number": 1, "version_label": "1.0.0", "revision_digest": HEX_A,
                "plan_digest": HEX_B, "assignment_id": "as-a", "run_id": "run-agent"},
            "feature-development-deterministic": {
                "pipeline_id": "pi-t", "slug": "feature-development-deterministic",
                "revision_id": "rv-t", "revision_number": 1, "version_label": "1.0.0",
                "revision_digest": HEX_C, "plan_digest": HEX_D, "assignment_id": "as-t",
                "run_id": "run-twin"},
            "issue-implementation": {
                "pipeline_id": "pi-i", "slug": "issue-implementation", "revision_id": "rv-i",
                "revision_number": 1, "version_label": "1.0.0", "revision_digest": HEX_A,
                "plan_digest": HEX_B, "assignment_id": "as-i"},
        },
        "runs": [
            {"run_id": "run-agent", "variant": "agent", "pipeline_slug": "feature-development",
             "revision_digest": HEX_A, "plan_digest": HEX_B,
             "inputs": {"goal": "Document and fix add() in hello.py", "repository": "app",
                        "fanout": False, "fanout_count": 0}},
            {"run_id": "run-twin", "variant": "twin",
             "pipeline_slug": "feature-development-deterministic",
             "revision_digest": HEX_C, "plan_digest": HEX_D,
             "inputs": {"goal": "Document and fix add() in hello.py", "repository": "app",
                        "fanout": False, "fanout_count": 0}},
        ],
        "fixture": {"git_url": "file:///srv/m4/fixtures/app.git",
                    "generator": "e2e/m4/make_fixture_repo.sh"},
    }
    for k, v in breaks.items():
        target = doc
        parts = k.split(".")
        for p in parts[:-1]:
            target = target[p]
        if v is None:
            target.pop(parts[-1], None)
        else:
            target[parts[-1]] = v
    return doc


class ManifestTest(unittest.TestCase):
    def test_happy_path(self):
        facts = m.validate_manifest(manifest_doc())
        self.assertEqual(facts["agent"]["revision_digest"], HEX_A)
        self.assertEqual(facts["twin"]["plan_digest"], HEX_D)
        self.assertEqual(facts["twin"]["run_id"], "run-twin")
        self.assertEqual(facts["agent"]["project_id"], "p-1")
        self.assertEqual(facts["agent"]["inputs"]["repository"], "app")
        self.assertEqual(facts["agent"]["inputs"]["fanout"], False)

    def test_wrong_schema_tag_is_loud(self):
        with self.assertRaisesRegex(ValueError, "schema tag"):
            m.validate_manifest(manifest_doc(schema="m4-seed-manifest/0"))

    def test_missing_twin_run_is_loud(self):
        doc = manifest_doc()
        doc["pipelines"]["feature-development-deterministic"].pop("run_id")
        doc["runs"] = [r for r in doc["runs"] if r["variant"] != "twin"]
        with self.assertRaisesRegex(ValueError, "twin run_id"):
            m.validate_manifest(doc)

    def test_missing_digest_is_loud(self):
        doc = manifest_doc()
        doc["pipelines"]["feature-development"]["plan_digest"] = ""
        with self.assertRaisesRegex(ValueError, "plan_digest"):
            m.validate_manifest(doc)

    def test_run_id_resolves_from_runs_list_alone(self):
        doc = manifest_doc()
        doc["pipelines"]["feature-development"].pop("run_id")  # README shows both shapes
        self.assertEqual(m.validate_manifest(doc)["agent"]["run_id"], "run-agent")


class KeySetTest(unittest.TestCase):
    def test_expected_two_iteration_set(self):
        exp = m.expected_node_keys(2)
        # 9 root keys (the seed's eight plus /publish_plan, the pre-gate artifact
        # publisher § 7.1 C9f reads) + 2 iterations × 4 body nodes (implement, test,
        # review and the per-iteration test_evidence publisher § 7.1 C7b counts).
        self.assertEqual(len(exp), 9 + 8)
        self.assertEqual(exp["/publish_plan"], "succeeded")
        self.assertEqual(exp["/publish_needs_attention"], "skipped")
        self.assertEqual(exp["/emit_items"], "skipped")
        self.assertEqual(exp["/fan_out"], "skipped")
        self.assertEqual(exp["/build_until_verified[2]/review"], "succeeded")
        self.assertEqual(exp["/build_until_verified[2]/test_evidence"], "succeeded")
        self.assertNotIn("/build_until_verified[3]/review", exp)
        self.assertNotIn("/build_until_verified[1]", exp)  # composite is unsuffixed

    def test_the_expected_set_matches_the_seed_document_node_ids(self):
        """The key set is a READING of the seed, so it is checked against the seed.
        Both documents must carry the same node ids (that identity is what C1's
        cross-variant arm compares), the pre-gate publisher must sit upstream of the
        gate, and the evidence publisher must live inside the until body."""
        path = os.path.join(m.REPO_DIR, "docs", "compatibility", "probes", "m4",
                            "pipeline.yaml")
        with open(path, encoding="utf-8") as f:
            docs = [d for d in re.split(r"(?m)^---\s*$", f.read())
                    if "kind: Pipeline" in d][:2]
        root_ids, body_ids = [], []
        for doc in docs:
            spec = yaml.safe_load(doc)["spec"]
            nodes = spec["nodes"]
            root_ids.append(tuple(n["id"] for n in nodes))
            until = next(n for n in nodes if n["kind"] == "until")
            body_ids.append(tuple(n["id"] for n in until["config"]["body"]["nodes"]))
            approve = next(n for n in nodes if n["kind"] == "human.approval")
            publish = next(n for n in nodes
                           if n["id"] == m.C9F_PUBLISH_PLAN_KEY.strip("/"))
            self.assertEqual(["plan"], publish["dependsOn"],
                             "the pre-gate publisher must depend on nothing but /plan")
            self.assertIn(publish["id"], approve["dependsOn"],
                          "/approve must wait for the publication C9f reads")
            self.assertEqual("artifact.publish", publish["kind"])
            self.assertEqual(m.C9F_PLAN_ARTIFACT, publish["config"]["name"])
            evidence = next(n for n in until["config"]["body"]["nodes"]
                            if n["id"] == m.C7_EVIDENCE_NODE)
            self.assertEqual("artifact.publish", evidence["kind"])
            self.assertEqual(["test"], evidence["dependsOn"])
            self.assertEqual(m.C7_ARTIFACT_PREFIX + "${{ iteration }}" + ".json",
                             evidence["config"]["name"],
                             "the per-iteration name is what C7b's expected set spells:")
        self.assertEqual(root_ids[0], root_ids[1], "both documents declare the same node ids")
        self.assertEqual(body_ids[0], body_ids[1], "both until bodies declare the same node ids")
        self.assertEqual(sorted(k for k in m.expected_node_keys(1) if "[" not in k),
                         sorted("/" + i for i in root_ids[0]),
                         "C1_ROOT_KEYS is the seed's root list, not a remembered one")
        loop = [k for k in m.expected_node_keys(1)
                if k.startswith(m.C7_UNTIL_KEY + "[")]
        self.assertEqual(sorted({k.rsplit("/", 1)[1] for k in loop}), sorted(body_ids[0]),
                         "the until body's expected keys are the seed's body list")

    def test_observed_iterations(self):
        keys = set(m.expected_node_keys(3))
        self.assertEqual(m.observed_iterations(keys), 3)
        self.assertEqual(m.observed_iterations({"/plan"}), 0)

    def test_collapse_and_compare(self):
        a = set(m.expected_node_keys(1))
        b = set(m.expected_node_keys(2))
        self.assertEqual(m.collapse_iterations(a), m.collapse_iterations(b))
        same, oa, ob = m.compare_key_sets(a, b)
        self.assertFalse(same)
        self.assertEqual(ob, ["/build_until_verified[2]/implement",
                              "/build_until_verified[2]/review",
                              "/build_until_verified[2]/test",
                              "/build_until_verified[2]/test_evidence"])
        self.assertEqual(oa, [])

    def test_cross_variant_identity(self):
        # The twin claim: same 10 node ids in both documents — key sets equal at
        # equal iteration counts whatever the kinds behind them are.
        agent = set(m.expected_node_keys(2))
        twin = {k.replace("/implement", "/implement") for k in agent}
        self.assertEqual(m.collapse_iterations(agent), m.collapse_iterations(twin))


def ok_of(verdicts, needle):
    hits = [ok for label, ok, _ in verdicts if needle in label]
    assert hits, f"no verdict matching {needle!r} in {[l for l, _, _ in verdicts]}"
    return hits[0]


def detail_of(verdicts, needle):
    return [d for label, _, d in verdicts if needle in label][0]


class CrossVariantKeySetTest(unittest.TestCase):
    """§ 7.1 C1's cross-variant arm: the agent variant and its deterministic twin
    walked the same GRAPH. Graded on the shared normalizer + hole guard, so the
    verdict follows the graph and not the model's iteration count (live12 passed
    only because both legs happened to loop twice)."""

    AGENT = set(m.expected_node_keys(3))     # the model looped three times
    TWIN = set(m.expected_node_keys(2))      # the fixture loops twice (§ 7.1 C1d)

    def test_different_loop_counts_pass_on_equal_normalized_sets(self):
        v = m.c1_cross_variant_keyset_verdicts(self.AGENT, self.TWIN)
        self.assertTrue(ok_of(v, "iteration-normalized"), v)
        self.assertTrue(ok_of(v, "no hole"), v)
        d = detail_of(v, "iteration-normalized")
        self.assertIn("agent loop spent 3 iteration(s), the twin 2", d)
        self.assertIn("literal sets differ", d)

    def test_equal_loop_counts_still_pass(self):
        v = m.c1_cross_variant_keyset_verdicts(self.TWIN, set(self.TWIN))
        self.assertTrue(ok_of(v, "iteration-normalized"), v)
        self.assertIn("literal sets identical", detail_of(v, "iteration-normalized"))

    def test_a_node_missing_from_one_leg_still_fails(self):
        v = m.c1_cross_variant_keyset_verdicts(self.AGENT - {"/verdict"}, self.TWIN)
        self.assertFalse(ok_of(v, "iteration-normalized"), v)
        v = m.c1_cross_variant_keyset_verdicts(self.AGENT, self.TWIN | {"/extra_node"})
        self.assertFalse(ok_of(v, "iteration-normalized"), v)

    def test_a_renamed_node_still_fails(self):
        twin = {k.replace("/implement", "/impl") for k in self.TWIN}
        self.assertFalse(ok_of(m.c1_cross_variant_keyset_verdicts(self.AGENT, twin),
                               "iteration-normalized"))

    def test_a_hole_in_either_legs_history_fails_the_guard(self):
        """The hole guard keeps the claim falsifiable under normalization: [*]/test
        still exists (under [2]), so set equality alone would PASS a leg whose row
        was deleted out of the MIDDLE of its own iteration history."""
        v = m.c1_cross_variant_keyset_verdicts(self.AGENT, self.TWIN - {"/build_until_verified[1]/test"})
        self.assertTrue(ok_of(v, "iteration-normalized"), v)
        self.assertFalse(ok_of(v, "no hole"), v)
        self.assertIn("never at [1]", detail_of(v, "no hole"))

        v = m.c1_cross_variant_keyset_verdicts(self.AGENT - {"/build_until_verified[2]/test"},
                                               self.TWIN)
        self.assertTrue(ok_of(v, "iteration-normalized"), v)
        self.assertFalse(ok_of(v, "no hole"), v)
        self.assertIn("missing [2]", detail_of(v, "no hole"))

    def test_a_loop_that_did_not_finish_its_last_iteration_is_not_a_hole(self):
        """Rows never written are not rows removed (the agent leg killed mid-[4])."""
        agent = self.AGENT | {f"/build_until_verified[4]/{n}" for n in ("implement",)}
        v = m.c1_cross_variant_keyset_verdicts(agent, self.TWIN)
        self.assertTrue(ok_of(v, "iteration-normalized"), v)
        self.assertTrue(ok_of(v, "no hole"), v)

    def test_a_missing_leg_is_a_gap_not_a_pass(self):
        for pair in ((None, self.TWIN), (self.AGENT, None), (set(), self.TWIN)):
            v = m.c1_cross_variant_keyset_verdicts(*pair)
            self.assertIsNone(ok_of(v, "iteration-normalized"), pair)
            self.assertIn("TWO ledger-complete runs", detail_of(v, "iteration-normalized"))

    def test_exact_keys_are_still_asserted_where_the_contract_demands_them(self):
        """§ 7.1 C1i: "replay the whole thing a second time (fresh run, same
        revision) and assert an identical node_instance_key set and an identical
        plan_digest" — same revision, so the RAW set comparison is the claim, and it
        must survive. The cross-variant exact arm must not."""
        src = open(os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                "e2e_m4_exit.py"), encoding="utf-8").read()
        self.assertIn('check("C1i twin re-run: node_instance_key SET identical '
                      '(ledger rows, exact)",', src)
        self.assertNotIn("cross-variant key set identical, EXACT", src,
                         "the arm that PASSed only when both legs looped equally")
        self.assertIn("c1_cross_variant_keyset_verdicts(", src)
        self.assertIn('check(f"C1d {label}: no unexpected node kinds/keys', src)


def row(seq, typ, node=None, attempt=None):
    return {"global_seq": seq, "type": typ, "node_execution_id": node, "attempt_id": attempt}


class JournalTest(unittest.TestCase):
    """Canned journal slices in the envelope shape api/schemas/
    event-envelope.schema.json pins (correlation rule from its member
    descriptions: worker rows set node_execution_id AND attempt_id; control-
    plane gate rows set the former with attempt_id null)."""

    def happy(self):
        return [
            row(10, "run.created", None, None),
            row(11, "node.attempt.started", "n-plan", "a-plan"),
            row(12, "node.attempt.completed", "n-plan", "a-plan"),
            row(13, "approval.requested", "n-approve", None),
            row(14, "run.waiting_human", "n-approve", None),
            row(15, "approval.decided", "n-approve", None),
            row(16, "node.attempt.started", "n-impl1", "a-impl1"),
            row(17, "node.attempt.completed", "n-impl1", "a-impl1"),
            row(18, "run.checkpoint_saved", "n-impl1", "a-impl1"),
            row(19, "node.attempt.completed", "n-test1", "a-test1"),
            row(20, "node.attempt.completed", "n-rev1", "a-rev1"),
            row(21, "node.scope.iteration", "n-buv", None),
            row(22, "node.attempt.completed", "n-impl2", "a-impl2"),
            row(23, "node.attempt.completed", "n-test2", "a-test2"),
            row(24, "node.attempt.completed", "n-rev2", "a-rev2"),
            row(25, "node.scope.completed", "n-buv", None),
            row(26, "node.execution_skipped", "n-items", None),
            row(27, "node.attempt.completed", "n-pub", "a-pub"),
            row(28, "run.checkpoint_saved", "n-test2", "a-test2"),
            row(29, "run.completed", None, None),
        ]

    def labels(self, rows):
        return {lbl: ok for lbl, ok, _ in m.journal_shape(rows)}

    def test_happy_slice(self):
        verdicts = self.labels(self.happy())
        self.assertTrue(all(verdicts.values()), str(verdicts))

    def test_first_must_be_run_created(self):
        rows = self.happy()[1:]
        self.assertFalse(self.labels(rows)["journal opens with run.created"])

    def test_must_close_with_run_completed(self):
        rows = self.happy()[:-1] + [row(29, "run.checkpoint_saved", "n-test2", "a-test2")]
        self.assertFalse(self.labels(rows)["journal closes with run.completed"])

    def test_regression_in_sequence_detected(self):
        rows = self.happy()
        rows[7]["global_seq"] = 5  # replayed row out of order
        self.assertFalse(self.labels(rows)[
            "run slice strictly ascending in global_seq (the run's own slice is the "
            "contiguity contract; global gaps belong to other runs)"])

    def test_worker_row_missing_attempt_id_fails_correlation(self):
        rows = self.happy()
        rows[6]["attempt_id"] = None
        self.assertFalse(self.labels(rows)[
            "worker attempt rows carry node_execution_id AND attempt_id"])

    def test_gate_row_with_attempt_id_fails_correlation(self):
        rows = self.happy()
        rows[3]["attempt_id"] = "a-bogus"
        self.assertFalse(self.labels(rows)[
            "control-plane gate rows: node_execution_id set, attempt_id NULL"])

    def test_milestone_chain_is_a_subsequence_not_an_exact_set(self):
        # § 7.1 C1h names run.created → node.attempt.* → run.checkpoint_saved →
        # node.scope.* → run.completed. The journal carries ~30 other types
        # between them (live5/C1.out: 46 rows), so the claim is an ORDERED
        # SUBSEQUENCE; dropping the scope completion is what breaks it.
        rows = [r for r in self.happy() if not r["type"].startswith("node.scope.")]
        self.assertFalse(self.labels(rows)[
            "milestone chain run.created→node.attempt.*→checkpoint→scope→completed "
            "appears in order (§ 7.1 C1h, subsequence not exact-set)"])

    def test_checkpoint_before_the_gate_is_not_an_ordering_failure(self):
        # live5/C1.out FAILed a run that had every milestone: the twin checkpoints
        # /plan BEFORE the gate opens, so first-occurrence monotonicity is not a
        # contract rule. Move /plan's checkpoint ahead of approval.requested.
        rows = self.happy()
        ck = rows.pop(8)                                  # run.checkpoint_saved n-impl1
        rows.insert(3, ck)
        verdicts = self.labels(rows)
        self.assertTrue(verdicts[
            "milestone chain run.created→node.attempt.*→checkpoint→scope→completed "
            "appears in order (§ 7.1 C1h, subsequence not exact-set)"])
        self.assertTrue(verdicts[
            "gate milestones approval.requested→approval.decided present and in order"])

    def test_gate_decision_out_of_order_fails_the_gate_verdict(self):
        rows = self.happy()
        rows[3], rows[5] = dict(rows[5], global_seq=13), dict(rows[3], global_seq=15)
        self.assertFalse(self.labels(rows)[
            "gate milestones approval.requested→approval.decided present and in order"])

    def test_milestone_subsequence_helper_matches_prefixes(self):
        types = ["run.created", "node.scope.completed", "node.attempt.started",
                 "run.checkpoint_saved", "node.scope.completed", "run.completed"]
        hit = m.milestone_subsequence(types, m.JOURNAL_MILESTONES)
        self.assertEqual([t for _, t in hit], ["run.created", "node.attempt.started",
                                                "run.checkpoint_saved", "node.scope.completed",
                                                "run.completed"])
        self.assertIsNone(m.milestone_subsequence(["run.created", "run.completed"],
                                                  m.JOURNAL_MILESTONES))

    def test_attempt_events_between_terminals_required(self):
        rows = [r for r in self.happy() if r["type"] not in m.ATTEMPT_CORRELATED_TYPES]
        self.assertFalse(self.labels(rows)[
            "node.attempt.* events present between the terminals"])


class SseTest(unittest.TestCase):
    STREAM = "\n".join([
        ": heartbeat",
        "id: 41",
        "event: domain-event",
        "data: " + json.dumps({"global_seq": 41, "type": "run.created"}),
        "",
        ": heartbeat",
        "id: 42",
        "data: " + json.dumps({"global_seq": 42, "type": "node.attempt.started"}),
        "",
        "id: 43",
        "data: {not json",
        "",
        "id: 44",
        "data: " + json.dumps({"global_seq": 44, "type": "run.completed"}),
        ""])  # stream closes without the final blank line

    def test_frames_parse_heartbeats_and_junk_are_honest(self):
        frames = m.parse_sse(self.STREAM)
        self.assertEqual([f["type"] for f in frames],
                         ["run.created", "node.attempt.started", "run.completed"])
        self.assertEqual(len(frames._junk), 1)  # the malformed data frame is noted, not crashy

    def test_empty_stream(self):
        self.assertEqual(m.parse_sse(""), [])


class ResultBindingsTest(unittest.TestCase):
    GOOD = {"implementation_summary": "added docstring; corrected assertion",
            "review_approved": True, "iterations": 2}

    def test_twin_exact(self):
        self.assertTrue(all(ok for _, ok, _ in m.result_bindings_ok(self.GOOD, "twin")))

    def test_twin_three_iterations_is_a_lie(self):
        bad = dict(self.GOOD, iterations=3)
        self.assertFalse([ok for _, ok, _ in m.result_bindings_ok(bad, "twin")][2])

    def test_agent_may_finish_in_one_iteration(self):
        """live25: a real Claude model read the planted test, fixed it and got the
        reviewer's approval in iteration 1. The agent leg may not FAIL on iteration
        count — the twin leg is the deterministic loop proof."""
        for it in (1, 2, 3, 4):
            self.assertTrue(all(ok for _, ok, _ in
                                m.result_bindings_ok(dict(self.GOOD, iterations=it), "agent")),
                            f"iterations={it}")

    def test_agent_iterations_must_be_a_bounded_positive_int(self):
        # 0 (never ran), 5 (past the loop's maxIterations: 4 bound), True (a bool
        # masquerading as 1) and "2" (a string) are all FAILs, not crashes.
        for bad_it in (0, 5, True, "2", None, 2.0, -1):
            self.assertFalse([ok for _, ok, _ in
                              m.result_bindings_ok(dict(self.GOOD, iterations=bad_it),
                                                   "agent")][2],
                             f"iterations={bad_it!r}")

    def test_string_approved_never_passes_as_true(self):
        bad = dict(self.GOOD, review_approved="true")
        self.assertFalse([ok for _, ok, _ in m.result_bindings_ok(bad, "agent")][1])

    def test_empty_summary_fails(self):
        bad = dict(self.GOOD, implementation_summary="   ")
        self.assertFalse([ok for _, ok, _ in m.result_bindings_ok(bad, "agent")][0])

    def test_non_dict_bindings_are_fails_not_crashes(self):
        for junk in (None, "x", []):
            verdicts = [ok for _, ok, _ in m.result_bindings_ok(junk, "twin")]
            self.assertEqual(verdicts, [False, False, False], repr(junk))


class C1FArtifactRowsTest(unittest.TestCase):
    """live5/C1f FAILed a run whose artifact the driver had just PRINTED: the
    SELECT carries 8 columns but the filter required 7 space-separated parts, so
    every row was dropped and the check saw []. The rows below are the literal
    ledger line from that run."""

    LEDGER = ("01a144d3-01ba-773b-9442-e90c8ade4b43|review-evidence.md|markdown|"
              "text/markdown|f6ed997b6b0a7203fcebe3d3cf6b775edfb112d705033bf7fd9851c15ee6ae12"
              "|standard|0|ready")

    def test_published_evidence_row_parses_and_passes(self):
        rows = m.c1f_parse_artifacts(self.LEDGER)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["name"], m.C1F_EVIDENCE_NAME)
        self.assertEqual(rows[0]["state"], "ready")
        verdicts = m.c1f_evidence_verdicts(rows)
        self.assertTrue(verdicts[0][1], str(verdicts))

    def test_wrong_media_type_is_a_fail_with_the_row_in_the_detail(self):
        rows = m.c1f_parse_artifacts(self.LEDGER.replace("text/markdown", "text/plain"))
        label, ok, detail = m.c1f_evidence_verdicts(rows)[0]
        self.assertFalse(ok)
        self.assertIn("review-evidence.md", detail)

    def test_no_evidence_row_names_what_was_journaled(self):
        rows = m.c1f_parse_artifacts(
            "a-1|stdout.log|archive|text/plain|" + "b" * 64 + "|standard|0|ready")
        label, ok, detail = m.c1f_evidence_verdicts(rows)[0]
        self.assertFalse(ok)
        self.assertIn("stdout.log", detail)

    def test_ragged_lines_are_dropped_not_verdicted(self):
        self.assertEqual(m.c1f_parse_artifacts("|\nnot-an-artifact-line\n" + self.LEDGER),
                         m.c1f_parse_artifacts(self.LEDGER))

    def test_sql_carries_every_column_the_parser_indexes(self):
        sql = m.c1f_artifact_sql("run-1")
        for col in m.C1F_ARTIFACT_COLS:
            self.assertIn(col, sql, col)
        self.assertEqual(sql.count("|| '|' ||"), len(m.C1F_ARTIFACT_COLS) - 1, sql)
        self.assertIn("WHERE run_id = 'run-1'", sql)


class C1cUnattendedPermissionTest(unittest.TestCase):
    """The agent arm's /plan attempt dies on the unattended permission prompt
    (docs/design/attempt-permissions.md, ADR-0016 ask_unattended) — a known design
    limit, so C1c reports GAP for that leg, and only for that leg."""

    LIVE5 = [{"global_seq": "39", "type": "conversation.permission.requested",
              "status": "-", "decided_by": "-"},
             {"global_seq": "40", "type": "conversation.permission.decided",
              "status": "cancelled", "decided_by": "node_policy:ask_unattended"}]

    def test_plan_attempt_cancelled_by_unattended_policy_is_a_gap(self):
        why = m.c1_unattended_permission_gap("failed", "node_execution_failed:/plan", self.LIVE5)
        self.assertIsNotNone(why)
        self.assertIn("docs/design/attempt-permissions.md", why)
        self.assertIn("node_policy:ask_unattended", why)

    def test_same_journal_but_a_different_failed_node_stays_a_fail(self):
        self.assertIsNone(m.c1_unattended_permission_gap(
            "failed", "node_execution_failed:/build_until_verified[1]/implement", self.LIVE5))

    def test_no_permission_cancellation_stays_a_fail(self):
        self.assertIsNone(m.c1_unattended_permission_gap(
            "failed", "node_execution_failed:/plan",
            [{"type": "conversation.permission.requested", "status": "-",
              "decided_by": "-"}]))

    def test_completed_or_timeout_never_goes_soft(self):
        self.assertIsNone(m.c1_unattended_permission_gap("completed", "", self.LIVE5))
        self.assertIsNone(m.c1_unattended_permission_gap("failed", "", self.LIVE5))
        self.assertIsNone(m.c1_unattended_permission_gap("failed", "stale_lease:/plan", self.LIVE5))
        self.assertIsNone(m.c1_unattended_permission_gap(
            "failed", "node_execution_failed:/plan", []))


MIG05 = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..",
                     "internal", "store", "postgres", "migrations", "00005_m4_pipelines.sql")
_SKIP_PREFIX = ("constraint", "check", "unique", "primary", "foreign", "exclude")


def create_table_columns(path, names):
    """{table: [first-token column names]} from a migration's CREATE TABLE blocks."""
    with open(path, encoding="utf-8") as fh:
        src = fh.read()
    out = {}
    for name in names:
        hit = re.search(rf"CREATE TABLE {name} \((.*?)\n\);", src, re.S)
        assert hit, f"CREATE TABLE {name} not found in {path}"
        cols = []
        for line in hit.group(1).splitlines():
            line = line.split("--")[0].strip()
            if not line or line.lower().startswith(_SKIP_PREFIX):
                continue
            cols.append(line.split()[0].lower())
        out[name] = cols
    return out


class C1RunDigestSqlTest(unittest.TestCase):
    """live4's C1 gate aborted at C1e: `ERROR: column "digest_scope" does not
    exist`. runs carries revision_digest + plan_digest but NO digest_scope
    (00005_m4_pipelines.sql's runs block); digest_scope is a column of the
    pinned pipeline_revisions row, so the check reads it through the pin."""

    @classmethod
    def setUpClass(cls):
        cls.SQL = m.c1_run_digest_sql("run-1")
        cls.cols = create_table_columns(MIG05, ("runs", "pipeline_revisions"))

    def test_digest_scope_is_a_revision_column_and_not_a_run_column(self):
        self.assertIn("digest_scope", self.cols["pipeline_revisions"])
        self.assertNotIn("digest_scope", self.cols["runs"])
        for col in ("revision_digest", "plan_digest", "pipeline_revision_id", "id"):
            self.assertIn(col, self.cols["runs"], col)

    def test_digest_scope_is_read_through_the_pinned_revision(self):
        for hit in re.finditer(r"\bdigest_scope\b", self.SQL):
            self.assertEqual(self.SQL[:hit.start()].rsplit(" ", 1)[-1], "pr.",
                             f"unqualified digest_scope at {hit.start()}: {self.SQL}")
        self.assertIn("JOIN pipeline_revisions pr ON pr.id = r.pipeline_revision_id", self.SQL)

    def test_every_qualified_column_exists_in_the_migration(self):
        aliases = {"r": "runs", "pr": "pipeline_revisions"}
        bad = [f"{a}.{c} -> {aliases[a]}.{c}" for a, c in
               re.findall(r"\b([a-z]+)\.([a-z_]+)\b", self.SQL.lower())
               if a in aliases and c not in self.cols[aliases[a]]]
        self.assertEqual(bad, [], self.SQL)

    def test_the_run_id_is_the_only_hole(self):
        self.assertIn("WHERE r.id = 'run-1'", self.SQL)
        self.assertNotIn("{", self.SQL)


class C1eDeclaredInputsTest(unittest.TestCase):
    """live8/C1.out: `FAIL C1e run_inputs: 5 validated rows … count=6 …
    'hold_seconds=default'`. The number in the assertion could not know that cefe995
    gave the twin a sixth declared input. C1e's expected row set is therefore READ
    from the run's pinned revision, and the origin checks stay."""

    SIX = ["acceptance_criteria", "fanout", "fanout_count", "goal", "hold_seconds",
           "leave_dirty", "repository"]
    SIX_ORIGINS = ["acceptance_criteria=default", "fanout=submitted",
                   "fanout_count=submitted", "goal=submitted", "hold_seconds=default",
                   "leave_dirty=default", "repository=submitted"]

    def test_live8s_own_six_rows_pass_against_six_declared_inputs(self):
        label, ok, detail = m.c1e_inputs_verdict(self.SIX, self.SIX_ORIGINS)
        self.assertTrue(ok, detail)
        self.assertIn("7 declared", label)
        self.assertIn("count=7", detail)

    def test_a_row_that_was_never_validated_is_a_named_fail(self):
        _l, ok, detail = m.c1e_inputs_verdict(self.SIX, [o for o in self.SIX_ORIGINS
                                                         if not o.startswith("goal")])
        self.assertFalse(ok)
        self.assertIn("missing=['goal']", detail)

    def test_an_extra_row_is_a_named_fail_too(self):
        _l, ok, detail = m.c1e_inputs_verdict(self.SIX, self.SIX_ORIGINS
                                              + ["surprise=submitted"])
        self.assertFalse(ok)
        self.assertIn("extra=['surprise']", detail)

    def test_the_origin_checks_survive_the_count_fix(self):
        _l, ok, detail = m.c1e_inputs_verdict(self.SIX, [o.replace("goal=submitted",
                                                                   "goal=default")
                                                         for o in self.SIX_ORIGINS])
        self.assertFalse(ok, "goal must be a SUBMITTED value, not a default")
        self.assertIn("required_not_submitted=['goal']", detail)

    def test_an_unreadable_revision_is_a_gap_never_a_guessed_number(self):
        _l, ok, detail = m.c1e_inputs_verdict([], self.SIX_ORIGINS)
        self.assertIsNone(ok, "no declared set read = no count asserted")
        self.assertIn("did not read back", detail)
        _l2, ok2, _d2 = m.c1e_inputs_verdict(["", " goal ", "goal"],
                                             ["goal=submitted"], required=("goal",))
        self.assertTrue(ok2, "blank and duplicate names collapse")

    def test_the_count_comes_from_the_twins_own_document(self):
        """The expected set is the seed twin's declared inputs, not a constant."""
        path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..",
                            "docs", "compatibility", "probes", "m4", "pipeline.yaml")
        docs = [d for d in re.split(r"(?m)^---\s*$", open(path, encoding="utf-8").read())
                if "kind: Pipeline" in d]
        twin = next(d for d in docs if "feature-development-deterministic" in d)
        declared = sorted((yaml.safe_load(twin)["spec"]["inputs"]["properties"]))
        self.assertEqual(declared, self.SIX)
        self.assertTrue(m.c1e_inputs_verdict(declared, self.SIX_ORIGINS)[1],
                        "the live8 reading passes against the document it ran")

    def test_the_driver_no_longer_carries_a_hardcoded_input_count(self):
        src = open(os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                "e2e_m4_exit.py"), encoding="utf-8").read()
        self.assertNotIn("run_inputs: 5", src, "the old label carried the count")
        self.assertNotIn("n_inputs ==", src)
        self.assertIn("c1e_inputs_verdict(declared, origins)", src)

    def test_the_declared_input_read_is_a_join_onto_the_pinned_revision(self):
        sql = m.c1_declared_input_names_sql("run-1")
        self.assertIn("JOIN pipeline_revisions pr ON pr.id = r.pipeline_revision_id", sql)
        self.assertIn("canonical_document", sql)
        self.assertIn("{spec,inputs,properties}", sql)
        self.assertIn("WHERE r.id = 'run-1'", sql)
        cols = create_table_columns(MIG05, ("runs", "pipeline_revisions", "run_inputs"))
        self.assertIn("canonical_document", cols["pipeline_revisions"])
        self.assertIn("pipeline_revision_id", cols["runs"])
        for col in ("name", "origin", "value"):
            self.assertIn(col, cols["run_inputs"], col)


class C1PermissionVerdictsTest(unittest.TestCase):
    """§ 7.1 C1j / ADR-0036 condition (a): under a prompting-mode profile the
    agent asks, and the NODE POLICY answers in the open. Every prompt must close
    exactly once with status=decided + decided_by=node_policy:
    preapproved_within_sandbox, and no verdict may exist without a request.
    Rows are the dicts the driver builds from c1_permission_events_sql's single
    pipe-joined column."""

    POLICY = m.PERMISSION_DECIDED_BY_POLICY
    REQ = m.PERMISSION_TYPE_REQUESTED
    DEC = m.PERMISSION_TYPE_DECIDED

    @classmethod
    def setUpClass(cls):
        cls.request = {"type": cls.REQ, "permission_request_id": "perm-1",
                       "status": "-", "decided_by": "-"}
        cls.decided = {"type": cls.DEC, "permission_request_id": "perm-1",
                       "status": "decided", "decided_by": cls.POLICY}

    def rows(self, *extra):
        return [dict(self.request), dict(self.decided), *extra]

    def test_happy_path_two_prompts_all_four_checks_pass(self):
        rows = [{"type": self.REQ, "permission_request_id": "perm-1",
                 "status": "-", "decided_by": "-"},
                {"type": self.DEC, "permission_request_id": "perm-1",
                 "status": "decided", "decided_by": self.POLICY},
                {"type": self.REQ, "permission_request_id": "perm-2",
                 "status": "-", "decided_by": "-"},
                {"type": self.DEC, "permission_request_id": "perm-2",
                 "status": "decided", "decided_by": self.POLICY}]
        verdicts = m.permission_verdicts_ok(rows)
        self.assertEqual([ok for _, ok, _ in verdicts], [True, True, True, True],
                         verdicts)
        self.assertIn("2 request(s), 2 decision(s)", detail_of(verdicts, "at least one"))

    def test_zero_requests_fails_the_first_check(self):
        v = m.permission_verdicts_ok([dict(self.decided)])
        self.assertFalse(ok_of(v, "at least one"), "a verdict with nobody asking")
        self.assertIn("0 request(s)", detail_of(v, "at least one"))

    def test_empty_and_none_journal_fail_the_first_check(self):
        for rows in (None, [], ""):
            # a request with an empty id still counts as a request (see
            # test_the_blank_request_id_matches_a_blank_decision_id), so the
            # zero-request arm is only really zero.
            v = m.permission_verdicts_ok(rows)
            self.assertFalse(ok_of(v, "at least one"), repr(rows))

    def test_unanswered_request_fails_the_second_check(self):
        v = m.permission_verdicts_ok([dict(self.request)])
        self.assertTrue(ok_of(v, "at least one"), v)
        self.assertFalse(ok_of(v, "exactly one decided row"), "prompt left open")
        self.assertIn("unanswered=['perm-1']", detail_of(v, "exactly one decided row"))

    def test_request_decided_twice_fails_the_second_check(self):
        dup = {"type": self.DEC, "permission_request_id": "perm-1",
               "status": "decided", "decided_by": self.POLICY}
        v = m.permission_verdicts_ok(self.rows(dup))
        self.assertFalse(ok_of(v, "exactly one decided row"), "answered twice")
        self.assertIn("doubled=['perm-1']", detail_of(v, "exactly one decided row"))

    def test_cancelled_decision_fails_the_third_check(self):
        """A cancelled prompt means nobody answered it — the isolation evidence
        is that the profile DECIDED, not that the row exists."""
        cancelled = {"type": self.DEC, "permission_request_id": "perm-1",
                     "status": "cancelled", "decided_by": self.POLICY}
        v = m.permission_verdicts_ok([dict(self.request), cancelled])
        self.assertTrue(ok_of(v, "exactly one decided row"), v)
        self.assertFalse(ok_of(v, "status=decided"), "cancelled is not decided")
        self.assertIn("cancelled", detail_of(v, "status=decided"))

    def test_human_decided_by_fails_the_third_check(self):
        human = {"type": self.DEC, "permission_request_id": "perm-1",
                 "status": "decided", "decided_by": "user:interactive"}
        v = m.permission_verdicts_ok([dict(self.request), human])
        self.assertFalse(ok_of(v, "status=decided"), "a phantom human decided")
        self.assertIn("user:interactive", detail_of(v, "status=decided"))

    def test_decision_for_an_unrequested_id_fails_the_fourth_check(self):
        orphan = {"type": self.DEC, "permission_request_id": "perm-9",
                  "status": "decided", "decided_by": self.POLICY}
        v = m.permission_verdicts_ok(self.rows(orphan))
        self.assertTrue(ok_of(v, "exactly one decided row"), v)
        self.assertTrue(ok_of(v, "status=decided"), v)
        self.assertFalse(ok_of(v, "without a matching request"), "fabricated verdict")
        self.assertIn("perm-9", detail_of(v, "without a matching request"))

    def test_non_dict_rows_are_ignored_not_crashes(self):
        for junk in (None, "perm-1", 42, [], {}):
            v = m.permission_verdicts_ok([junk])
            self.assertFalse(ok_of(v, "at least one"), repr(junk))
        v = m.permission_verdicts_ok(self.rows(None, "x", 7, [], {}))
        self.assertEqual([ok for _, ok, _ in v], [True, True, True, True],
                         "junk alongside a real pair still passes")

    def test_the_blank_request_id_matches_a_blank_decision_id(self):
        """A row keyed `id` instead of `permission_request_id` reads as the empty
        id. Requested and decided are compared on the SAME projection, so the
        pair stays internally consistent (checks 2-4 pass) — the gate's real
        teeth are check 3's decided_by, which a payload missing that field still
        fails. Pinned so a future change to either projection is a deliberate
        one."""
        rows = [{"type": self.REQ, "id": "perm-1"},
                {"type": self.DEC, "id": "perm-1", "status": "decided"}]
        v = m.permission_verdicts_ok(rows)
        self.assertEqual([ok for _, ok, _ in v], [True, True, False, True], v)
        self.assertIn("decided_by", detail_of(v, "status=decided"))


class C1PermissionEventsSqlTest(unittest.TestCase):
    """The read behind C1j: one pipe-joined column off the RUN journal. If the
    run id or either event type drifts, permission_verdicts_ok silently sees []
    and the gate reports "no requests" instead of the truth."""

    @classmethod
    def setUpClass(cls):
        cls.SQL = m.c1_permission_events_sql("run-1")

    def test_sql_names_the_run_id_and_both_event_types(self):
        self.assertIn("'run-1'", self.SQL)
        self.assertIn("'conversation.permission.requested'", self.SQL)
        self.assertIn("'conversation.permission.decided'", self.SQL)
        self.assertIn("WHERE run_id = ", self.SQL)
        self.assertIn("domain_events", self.SQL)

    def test_sql_carries_the_verdict_fields_and_ordering(self):
        for col in ("permission_request_id", "status", "decided_by"):
            self.assertIn(f"payload->>'{col}'", self.SQL, col)
        self.assertIn("ORDER BY global_seq", self.SQL)
        self.assertNotIn("{", self.SQL, "the only substitution is already applied")

    def test_every_json_arrow_projection_is_parenthesised(self):
        """Live pass 28 crashed with "operator does not exist: text ->> unknown":
        in Postgres `||` binds tighter than `->>`, so a bare payload->>'x' inside
        a concatenation is parsed as (text || payload) ->> 'x'. Every occurrence
        must sit directly inside its own parentheses."""
        for i in range(len(self.SQL)):
            if self.SQL.startswith("payload->>", i):
                self.assertEqual("(", self.SQL[i - 1],
                                 f"unparenthesised payload->> at {i}: "
                                 f"...{self.SQL[max(0, i - 30):i + 40]}...")
        # and there really are occurrences to check (a vacuous pass is not proof)
        self.assertEqual(self.SQL.count("payload->>"), 3)

    def test_the_event_type_constants_are_the_ones_in_the_sql(self):
        for const in (m.PERMISSION_TYPE_REQUESTED, m.PERMISSION_TYPE_DECIDED):
            self.assertIn(f"'{const}'", m.c1_permission_events_sql("run-2"), const)
        # the decider the verdicts grade on is the profile, spelled once
        self.assertEqual("node_policy:preapproved_within_sandbox",
                         m.PERMISSION_DECIDED_BY_POLICY)


if __name__ == "__main__":
    unittest.main(verbosity=2)
