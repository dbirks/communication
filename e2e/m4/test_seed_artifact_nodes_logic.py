#!/usr/bin/env python3
"""test_seed_artifact_nodes_logic.py — the seed's two artifact publishers vs the driver.

Two M4 exit arms used to GAP for the same reason: the published § 7.0 seed had no
bytes to read where the contract expects some.

  * § 7.1 C9f — "the run's other branches keep running: the sample's /plan artifact
    is still readable … while an unrelated gate waits". The seed twin's ONLY publisher
    (publish_verified -> review-evidence.md) sits downstream of /verdict, i.e. AFTER the
    gate, so a run parked at /approve held ZERO artifact rows and `c9f_branch_verdicts`
    could only report a gap (live16/C9.out).
  * § 7.1 C7b — `select count(*) from artifacts where run_id='$RUN' and name like
    'test-%'` expects maxIterations rows. The until body published nothing at all, and
    on the exhaustion run the post-gate publishers are cancelled with every other
    descendant (§ 5.1 step 5), so that count could never be anything but 0.

The seed answer is two `artifact.publish` nodes, added to BOTH documents because § 7.1
C1's cross-variant arm grades the compiled node_instance_key SETS for equality:

  /plan -> /publish_plan -> /approve                publishes plan-evidence.md
  implement -> test -> review -> /build_until_verified[n]/test_evidence
                                                    publishes test-<n>.json

This file is the offline half: the document shape (placement, dependsOn, names, the
`iteration` interpolation), the twin-identity claim, the position pointers the Go
compiler tests pin, and the constants the driver's verdicts read those names from. It
grades the SEED, not the engine — a green here proves the fixture is the one the
contract describes; only the live lab proves the engine writes and keeps those rows
readable (12-test-strategy.md: a mocked green never substitutes for the real thing).

usage: python3 e2e/m4/test_seed_artifact_nodes_logic.py [-v]
"""
import os
import re
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import e2e_m4_exit as m  # noqa: E402 — importing the driver is the point
import yamlmini as yaml  # noqa: E402 — stdlib YAML subset (CI's python3 has no PyYAML)

SEED = os.path.abspath(os.path.join(HERE, "..", "..", "docs", "compatibility",
                                    "probes", "m4", "pipeline.yaml"))
VARIANTS = ("agent (feature-development)", "twin (feature-development-deterministic)")


def seed_documents():
    """The two § 7.0 documents that compile to the graded node key set, as (parsed,
    raw text) pairs — document 3 (the C8 fan-out child) is not part of the claim."""
    with open(SEED, encoding="utf-8") as f:
        raw = f.read()
    docs = [d for d in re.split(r"(?m)^---\s*$", raw) if "kind: Pipeline" in d][:2]
    assert len(docs) == 2, f"the seed lost a document ({len(docs)} pipeline slices)"
    return [(yaml.safe_load(d), d) for d in docs]


def node(doc, node_id):
    for n in doc["spec"]["nodes"]:
        if n.get("id") == node_id:
            return n
    raise AssertionError(f"no node {node_id!r} in the root scope "
                         f"({[n.get('id') for n in doc['spec']['nodes']]})")


def until(doc):
    return node(doc, m.C7_UNTIL_KEY.strip("/"))


def body_nodes(doc):
    return until(doc)["config"]["body"]["nodes"]


def body_node(doc, node_id):
    for n in body_nodes(doc):
        if n.get("id") == node_id:
            return n
    raise AssertionError(f"no until-body node {node_id!r} ({body_ids(doc)})")


def body_ids(doc):
    """The until body's node ids, in declaration order."""
    return [n["id"] for n in body_nodes(doc)]


def body_of(node_):
    return ((node_.get("config") or {}).get("body") or {}).get("nodes") or []


def key_ids(doc):
    """The node ids an UNARMED run (inputs.fanout=false) books as node_instance_keys,
    with iteration suffixes folded to [*] — the shape C1's cross-variant arm normalizes
    to (collapse_iterations) and the shape the seed's twin claim is made of. The
    when-gated for_each books NO child key in that run (/fan_out is a terminal `skipped`
    row), so its body is compared separately below."""
    ids = set()
    for n in doc["spec"]["nodes"]:
        ids.add(n["id"])
        if n.get("kind") == "until":
            ids.update(f"{n['id']}[*]/{b['id']}" for b in body_of(n))
    return ids


def composite_bodies(doc):
    """{composite node id: [child ids]} for every scope-owning node."""
    return {n["id"]: [b["id"] for b in body_of(n)]
            for n in doc["spec"]["nodes"] if body_of(n)}


def expected_key_ids(iterations=2):
    """The driver's expected key map, folded to the same suffix-free id shape."""
    out = set()
    for key in m.expected_node_keys(iterations):
        head, sep, tail = key.rpartition("/")
        out.add(tail if "[" not in head else f"{head.lstrip('/').split('[')[0]}[*]/{tail}")
    return out


class BothDocumentsCarryThePublishers(unittest.TestCase):
    """§ 7.1 C1's twin claim is an EXACT key-set match, so anything one document
    publishes the other must publish too — a pre-gate artifact in the twin only would
    fix C9f by breaking C1."""

    @classmethod
    def setUpClass(cls):
        cls.docs = seed_documents()

    def test_the_key_sets_are_identical_across_variants(self):
        (agent, _), (twin, _) = self.docs
        self.assertEqual(key_ids(agent), key_ids(twin),
                         "the deterministic twin no longer compiles to the agent "
                         "variant's node_instance_key set")

    def test_the_publishers_are_declared_in_both_documents(self):
        for (doc, _raw), variant in zip(self.docs, VARIANTS):
            with self.subTest(variant):
                self.assertEqual("artifact.publish", node(doc, "publish_plan")["kind"])
                self.assertEqual("artifact.publish", body_node(doc, m.C7_EVIDENCE_NODE)["kind"])

    def test_the_composite_bodies_match_too(self):
        (agent, _), (twin, _) = self.docs
        self.assertEqual(composite_bodies(agent), composite_bodies(twin),
                         "the until bodies and the for_each body must agree across the "
                         "two documents (C1 grades the compiled key set for equality)")

    def test_the_driver_expected_key_set_is_the_documents_key_set(self):
        """`expected_node_keys` is the expected side of C1d/C5g/C6c: if it and the seed
        drift, the live ledger is graded against a map nobody published."""
        for (doc, _raw), variant in zip(self.docs, VARIANTS):
            with self.subTest(variant):
                self.assertEqual(sorted(key_ids(doc)), sorted(expected_key_ids(2)),
                                 "expected_node_keys and pipeline.yaml disagree, so the "
                                 "C1d key-set comparison cannot be trusted")


class PreGatePlanPublication(unittest.TestCase):
    """§ 7.1 C9f's readable half. Placement is the whole arm: a publisher that is not an
    ANTECEDENT of the gate leaves the waiting run with nothing to read."""

    @classmethod
    def setUpClass(cls):
        cls.docs = seed_documents()

    def test_publish_plan_hangs_only_off_the_plan_node(self):
        for (doc, _raw), variant in zip(self.docs, VARIANTS):
            with self.subTest(variant):
                pub = node(doc, "publish_plan")
                self.assertEqual(["plan"], pub["dependsOn"],
                                 "the publication must not wait on the gate it feeds")
                self.assertNotIn("when", pub,
                                 "a condition-guarded pre-gate artifact is how C9f ended "
                                 "up with zero rows: the arm needs a row on EVERY branch")

    def test_the_gate_waits_for_the_publication(self):
        for (doc, _raw), variant in zip(self.docs, VARIANTS):
            with self.subTest(variant):
                gate = node(doc, "approve")
                self.assertEqual("human.approval", gate["kind"])
                self.assertIn("publish_plan", gate["dependsOn"],
                              "the ledger must hold the plan artifact BEFORE the run goes "
                              "waiting_human — that is when C9f reads it")
                self.assertIn("plan", gate["dependsOn"])

    def test_the_published_name_is_the_one_the_driver_reads(self):
        for (doc, _raw), variant in zip(self.docs, VARIANTS):
            with self.subTest(variant):
                cfg = node(doc, "publish_plan")["config"]
                self.assertEqual(m.C9F_PLAN_ARTIFACT, cfg["name"])
                self.assertEqual("markdown", cfg["kind"])
                self.assertEqual("text/markdown", cfg["mediaType"])
                self.assertEqual("output_json", cfg["from"]["mode"])
                self.assertEqual("${{ nodes.plan.outputs }}", cfg["from"]["value"],
                                 "the artifact carries /plan's own outputs")

    def test_the_name_survives_the_drivers_read_route(self):
        """The arm asks for a row NAMED plan-evidence.md, so the projection it reads
        through must actually carry names."""
        self.assertIn("name", m.c1f_artifact_sql("run-1"))
        rows = m.c1f_parse_artifacts(
            "a1|plan-evidence.md|markdown|text/markdown|" + "0" * 64 + "|standard|0|ready")
        self.assertEqual([m.C9F_PLAN_ARTIFACT], [r["name"] for r in rows])


class PerIterationTestEvidence(unittest.TestCase):
    """§ 7.1 C7b's `name like 'test-%'` count, made publishable from inside the loop."""

    @classmethod
    def setUpClass(cls):
        cls.docs = seed_documents()

    def test_the_evidence_node_is_inside_the_until_body(self):
        for (doc, _raw), variant in zip(self.docs, VARIANTS):
            with self.subTest(variant):
                self.assertEqual(list(m.C7_BODY_NODES) + [m.C7_EVIDENCE_NODE], body_ids(doc),
                                 "the evidence publisher is appended LAST so the review "
                                 "node keeps the /spec/nodes/2/config/body/nodes/2 pointer "
                                 "the compiler tests pin")
                self.assertNotIn(m.C7_EVIDENCE_NODE, m.C7_BODY_NODES,
                                 "C7a's `3 iterations × 3 body nodes = 9 rows` counts the "
                                 "loop's WORK nodes; the publisher is measured by C7b")

    def test_it_publishes_the_test_output_of_its_own_iteration(self):
        for (doc, _raw), variant in zip(self.docs, VARIANTS):
            with self.subTest(variant):
                ev = body_node(doc, m.C7_EVIDENCE_NODE)
                self.assertEqual(["test"], ev["dependsOn"])
                cfg = ev["config"]
                self.assertEqual("json", cfg["kind"])
                self.assertEqual("application/json", cfg["mediaType"])
                self.assertEqual("output_json", cfg["from"]["mode"])
                self.assertEqual("${{ nodes.test.outputs }}", cfg["from"]["value"])

    def test_the_name_carries_the_iteration_root_so_the_rows_stay_distinct(self):
        """One name per iteration is the append-only half of C7b: a literal `test.json`
        would publish the same NAME maxIterations times, the contract's count would still
        read 3, and the distinct-evidence-per-iteration claim would be false."""
        for (doc, _raw), variant in zip(self.docs, VARIANTS):
            with self.subTest(variant):
                name = body_node(doc, m.C7_EVIDENCE_NODE)["config"]["name"]
                self.assertEqual(m.C7_ARTIFACT_PREFIX + "${{ iteration }}.json", name)
                self.assertIn("iteration", name)
                self.assertTrue(name.startswith(m.C7_ARTIFACT_PREFIX))
                self.assertEqual([], [n for n in m.c7_artifact_names_expected()
                                      if not re.match(r"^test-\d+\.json$", n)],
                                 "the set the verdict compares against is the same spelling "
                                 "the document publishes")

    def test_the_exhaustion_splice_keeps_the_evidence_node(self):
        """C7's own revision is authored FROM the published twin; if the splice dropped
        the evidence node the arm it exists to measure would have no rows again."""
        _agent, (twin, _traw) = self.docs
        sp = m.c7_exhaustion_doc(twin, "m4x-seedart-c7", 3)
        self.assertEqual([], sp["missing"], str(sp["missing"]))
        ids = body_ids(yaml.safe_load(sp["doc"]))
        self.assertIn(m.C7_EVIDENCE_NODE, ids)
        self.assertEqual(ids[-1], m.C7_PROBE_NODE,
                         "the C7d witness is still appended after it")

    def test_the_c9f_deadline_splice_keeps_the_pre_gate_publisher(self):
        _agent, (twin, _traw) = self.docs
        for arm in m.C9F_TIMEOUT_ARMS:
            with self.subTest(arm=arm):
                sp = m.c9f_deadline_doc(twin, "m4x-seedart-c9f", arm)
                self.assertEqual([], sp["missing"], str(sp["missing"]))
                doc = yaml.safe_load(sp["doc"])
                self.assertIn("publish_plan", node(doc, "approve")["dependsOn"])
                self.assertEqual(m.C9F_PLAN_ARTIFACT,
                                 node(doc, "publish_plan")["config"]["name"])
                self.assertEqual(int(m.C9F_DEADLINE_S), int(sp["deadline_seconds"]))


class SeedSpliceNeedlesStillUnique(unittest.TestCase):
    """Editing two documents is also an edit to the bytes the C12 probes splice: every
    needle must still occur EXACTLY once, and the twin's comment block must still fit
    inside c12_splice's 600-character window."""

    @classmethod
    def setUpClass(cls):
        cls.docs = seed_documents()

    def test_the_c12_needles_occur_once_in_the_twin(self):
        (_twin_parsed, raw), = self.docs[1:]
        for needle in (m.C12_PROMPT_NEEDLE, m.C12_WS_FROM,
                       "outputs.result.successful == true", "maxNodeExecutions: 200"):
            with self.subTest(needle=needle):
                self.assertEqual(1, raw.count(needle),
                                 f"{needle!r} occurs {raw.count(needle)} times — the C12 "
                                 "splice refuses a needle it cannot locate exactly once")

    def test_the_twin_header_still_fits_the_splice_window(self):
        (_twin_parsed, raw), = self.docs[1:]
        self.assertLessEqual(raw.index("apiVersion:"), 600,
                             "c12_splice looks for apiVersion:/kind: Pipeline inside the "
                             "first 600 characters of the document's text, so the twin's "
                             "leading comment block may not grow (README's seed-pipeline "
                             "note 5); the new nodes' comments sit inside spec.nodes")

    def test_the_positional_pointers_the_go_tests_pin_are_untouched(self):
        """compiler/body_scope_test.go reads the review prompt at
        /spec/nodes/2/config/body/nodes/2/config/prompt, so the new nodes must be
        APPENDED to both lists, never inserted before an existing node."""
        (agent, _raw), (twin, _traw) = self.docs
        for doc, variant in zip((agent, twin), VARIANTS):
            with self.subTest(variant):
                self.assertEqual("build_until_verified", doc["spec"]["nodes"][2]["id"],
                                 "/spec/nodes/2 moved")
                self.assertEqual("review", body_ids(doc)[2],
                                 "/spec/nodes/2/config/body/nodes/2 moved")


class DriverConstantsMatchTheSeed(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.docs = seed_documents()

    def test_the_c9f_publisher_key_and_name_are_the_documents(self):
        (agent, _), (twin, _) = self.docs
        for doc in (agent, twin):
            self.assertEqual("/" + node(doc, "publish_plan")["id"], m.C9F_PUBLISH_PLAN_KEY)
            self.assertEqual(node(doc, "publish_plan")["config"]["name"], m.C9F_PLAN_ARTIFACT)

    def test_the_hold_arithmetic_excludes_the_publishers(self):
        """Only the twin's process.exec steps take M4_HOLD_SECONDS, so the two new nodes
        move neither W11's held-step cap nor the fault legs' kill window."""
        (_twin, raw), = self.docs[1:]
        held = raw.count("M4_HOLD_SECONDS: ${{ string(inputs.hold_seconds) }}")
        self.assertEqual(4, held, "plan, implement, test and review hold; the publishers "
                                  "must not — artifact.publish has no such env")
        cap = int(re.search(r"maxIterations:\s*(\d+)", raw).group(1))
        self.assertEqual(m.W11_HOLD_STEPS_MAX, 1 + (held - 1) * cap)
        self.assertEqual(m.C_FAULT_HOLD_STEPS, held)


if __name__ == "__main__":
    unittest.main(verbosity=2)
