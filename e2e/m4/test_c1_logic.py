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
        self.assertEqual(len(exp), 8 + 6)
        self.assertEqual(exp["/publish_needs_attention"], "skipped")
        self.assertEqual(exp["/emit_items"], "skipped")
        self.assertEqual(exp["/fan_out"], "skipped")
        self.assertEqual(exp["/build_until_verified[2]/review"], "succeeded")
        self.assertNotIn("/build_until_verified[3]/review", exp)
        self.assertNotIn("/build_until_verified[1]", exp)  # composite is unsuffixed

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
                              "/build_until_verified[2]/test"])
        self.assertEqual(oa, [])

    def test_cross_variant_identity(self):
        # The twin claim: same 8 node ids both documents — key sets equal at
        # equal iteration counts whatever the kinds behind them are.
        agent = set(m.expected_node_keys(2))
        twin = {k.replace("/implement", "/implement") for k in agent}
        self.assertEqual(m.collapse_iterations(agent), m.collapse_iterations(twin))


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

    def test_milestone_order_enforced(self):
        rows = self.happy()
        # swap: scope completion before the gate was ever requested
        rows[0], rows[3] = dict(rows[3], global_seq=10), dict(rows[0], global_seq=13)
        self.assertFalse(self.labels(rows)[
            "milestone chain run.created→approval.*→checkpoint→scope→completed"])

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

    def test_agent_at_least_two(self):
        self.assertTrue(all(ok for _, ok, _ in
                            m.result_bindings_ok(dict(self.GOOD, iterations=3), "agent")))
        self.assertFalse([ok for _, ok, _ in
                          m.result_bindings_ok(dict(self.GOOD, iterations=1), "agent")][2])

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


if __name__ == "__main__":
    unittest.main(verbosity=2)
