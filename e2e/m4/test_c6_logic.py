#!/usr/bin/env python3
"""test_c6_logic.py - offline unit proof for e2e_m4_exit.py's C6 pure logic.

Runs WITHOUT a stack (stdlib unittest only): the restore_checkpoint / honest-loss
verdict algebra — the authored-document splice over the real seed twin bytes, the
restored-to-checkpoint verdict from canned run_checkpoints + git readings, the
checkpoint_unavailable refusal verdict (409 + nothing reset), and the loss arm
(workspace_lost, no auto-retry, 'prior edits lost, rerun required', never
'resumed').

A green here means the VERDICT ALGEBRA is right. It never substitutes for C6's
live kill+restore and live cross-worker arm against the real worker
(12-test-strategy.md: a mocked green is not done).

usage: python3 e2e/m4/test_c6_logic.py [-v]
"""
import ast
import io
import json
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


REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DRIVER = os.path.join(os.path.dirname(os.path.abspath(__file__)), "e2e_m4_exit.py")
SEED_YAML = os.path.join(REPO, "docs", "compatibility", "probes", "m4", "pipeline.yaml")

BOUNDARY = "c0ffee" + "1" * 58


def driver_fn_src(name, path=DRIVER):
    """Source text of one module-level driver function — the pin for SEQUENCE claims
    (what reads what, in what order), which no canned ledger can express."""
    with open(path, encoding="utf-8") as fh:
        src = fh.read()
    fn = next((n for n in ast.parse(src).body
               if isinstance(n, ast.FunctionDef) and n.name == name), None)
    assert fn is not None, f"{name} is not a module-level def in {path}"
    seg = ast.get_source_segment(src, fn)
    assert seg, f"no source segment for {name}"
    return seg


def twin_doc():
    """Document #2 of the seed's probe file, in the shape the live gate now splices:
    the revision's canonical_document (GET /revisions/{id}) — here re-exported
    exactly like route 14 prints it (4-space indent, sequence bullets indented,
    alphabetical keys) and parsed back, so the offline proof runs on the SAME
    structure the API serves, not on the fixture's authored formatting (RC3)."""
    with open(SEED_YAML, encoding="utf-8") as f:
        raw = f.read()
    docs = [d for d in re.split(r"(?m)^---\s*$", raw) if "kind: Pipeline" in d]
    assert len(docs) >= 2, f"expected >=2 documents in {SEED_YAML}"
    return yaml.safe_load(yaml.safe_dump(yaml.safe_load(docs[1]), indent=4,
                                         sort_keys=True, allow_unicode=True))


def ckpt(node="/plan", volume="repos-a", worker="worker-a", committed="true", mpc="0",
         head=BOUNDARY):
    return f"ne-1@@{node}@@{volume}@@ws-1@@{worker}@@{committed}@@{mpc}@@{head}"


def restored_ev(key=None, frm=BOUNDARY, discarded=("repos/app/hello.py",)):
    return {"key": key or m.C6_KILL_KEY,
            "payload": {"node_instance_key": key or m.C6_KILL_KEY, "from_commit": frm,
                        "discarded_paths": list(discarded)}}


class C6aAuthoring(unittest.TestCase):
    def test_splice_applies_to_the_real_seed_twin(self):
        res = m.c6_restore_doc(twin_doc(), "m4x-c6-restore-test")
        self.assertEqual([], res["missing"], f"the seed twin is not the shape C6 splices: "
                                             f"{res['missing']}")
        self.assertEqual(1, res["doc"].count(f"workspacePolicy: {m.C6_RESTORE_POLICY}"))
        self.assertIn("args: [implement]", res["doc"], "the editing step must stay")
        v = m.c6_doc_verdicts(res)
        self.assertNotIn(False, [ok for _l, ok, _d in v], f"clean splice must PASS: {v}")

    def test_the_exported_shape_moves_EXACTLY_name_and_the_policy(self):
        # RC3: the live gate feeds the API's regenerated (4-space, alphabetical)
        # document. The edit is structural, so it changes exactly two values and
        # the emitted YAML parses back to precisely that edited document.
        base = twin_doc()
        frozen = yaml.safe_load(yaml.safe_dump(base))
        res = m.c6_restore_doc(base, "m4x-c6-exported")
        self.assertEqual([], res["missing"])
        self.assertEqual(frozen, base, "the splice must not mutate the caller's document")
        want = yaml.safe_load(yaml.safe_dump(frozen))
        want["metadata"]["name"] = "m4x-c6-exported"
        impl = [n for n in want["spec"]["nodes"] if n.get("id") == "build_until_verified"][0]
        impl = [n for n in impl["config"]["body"]["nodes"] if n["id"] == "implement"][0]
        impl["retry"]["workspacePolicy"] = m.C6_RESTORE_POLICY
        self.assertEqual(want, yaml.safe_load(res["doc"]),
                         "the re-emitted YAML is the edited document, nothing else")

    def test_refuses_a_doc_that_already_declares_the_policy(self):
        doc = twin_doc()
        impl = [n for n in doc["spec"]["nodes"] if n.get("id") == "build_until_verified"][0]
        impl = [n for n in impl["config"]["body"]["nodes"] if n["id"] == "implement"][0]
        impl["retry"]["workspacePolicy"] = m.C6_RESTORE_POLICY
        res = m.c6_restore_doc(doc, "x")
        self.assertIsNone(res["doc"])
        self.assertIn(False, [ok for _l, ok, _d in m.c6_doc_verdicts(res)],
                      "a seed that already restores must not read as C6a")

    def test_refuses_a_non_pipeline_document(self):
        for junk in ({"kind": "NotAPipeline"}, "kind: NotAPipeline\n", None):
            res = m.c6_restore_doc(junk, "x")
            self.assertIsNone(res["doc"])
            self.assertIn(False, [ok for _l, ok, _d in m.c6_doc_verdicts(res)])

    def test_refuses_a_doc_without_the_implement_retry_block(self):
        doc = twin_doc()
        impl = [n for n in doc["spec"]["nodes"] if n.get("id") == "build_until_verified"][0]
        impl = [n for n in impl["config"]["body"]["nodes"] if n["id"] == "implement"][0]
        impl.pop("retry")
        res = m.c6_restore_doc(doc, "x")
        self.assertIsNone(res["doc"], "no retry anchor => no honest splice")


class C6dWithDirtyTest(unittest.TestCase):
    def test_with_dirty_copies_and_sets_the_flag(self):
        base = {"goal": "ship it", "repository": "app"}
        got = m.with_dirty(base)
        self.assertIs(True, got["leave_dirty"])
        self.assertEqual("ship it", got["goal"])
        self.assertNotIn("leave_dirty", base, "with_dirty returns a COPY (C1's manifest stays)")

    def test_with_dirty_default_false_is_a_no_op(self):
        base = {"goal": "ship it"}
        self.assertNotIn("leave_dirty", m.with_dirty(base, on=False),
                         "off must leave the dict exactly as every other leg posts it")

    def test_with_dirty_degrades_on_bogus_inputs(self):
        self.assertEqual({"leave_dirty": True}, m.with_dirty(None))
        self.assertEqual({"leave_dirty": True}, m.with_dirty("nope"))


class C6dScratchAuthoring(unittest.TestCase):
    """The two-node scratch § 7.1 C6d publishes. The copies stay VERBATIM (id,
    dependsOn and retry aside): node A keeps the twin's own
    `M4_LEAVE_DIRTY: ${{ string(inputs.leave_dirty) }}` binding, so the dirty boundary is
    produced by the RUN INPUT the leg posts (with_dirty) rather than by a flag the gate
    baked into a document the twin never authored."""

    def test_splice_builds_the_two_node_scratch_from_the_real_twin(self):
        res = m.c6_dirty_scratch_doc(twin_doc(), "m4x-c6d-dirty-test")
        self.assertEqual([], res["missing"],
                         f"the seed twin is not the shape C6d splices: {res['missing']}")
        doc = res["doc"]
        self.assertEqual(1, doc.count(f"workspacePolicy: {m.C6_RESTORE_POLICY}"))
        self.assertEqual(2, doc.count("string(inputs.leave_dirty)"),
                         "both copies must keep the twin's leave_dirty binding — the RUN "
                         "input leaves the boundary dirty, the document must not decide it")
        self.assertNotIn('M4_LEAVE_DIRTY: "true"', doc)
        self.assertNotIn("M4_LEAVE_DIRTY: 'true'", doc)
        self.assertIn("dirty_seed", doc)
        self.assertIn("kill_target", doc)
        v = m.c6_dirty_doc_verdicts(res)
        self.assertNotIn(False, [ok for _l, ok, _d in v], f"a clean splice must PASS: {v}")

    def test_scratch_is_a_deep_copy_and_never_mutates_the_twin(self):
        base = twin_doc()
        frozen = yaml.safe_load(yaml.safe_dump(base))
        m.c6_dirty_scratch_doc(base, "m4x-c6d-exported")
        self.assertEqual(frozen, base, "the splice must not mutate the caller's document")

    def test_the_kill_node_carries_restore_and_one_budget(self):
        res = m.c6_dirty_scratch_doc(twin_doc(), "x")
        self.assertIsNotNone(res["doc"])
        parsed = yaml.safe_load(res["doc"])
        nodes = {n["id"]: n for n in parsed["spec"]["nodes"]}
        self.assertIn(m.C6D_SEED_NODE, nodes)
        kill = nodes[m.C6D_KILL_NODE]
        self.assertEqual(1, kill["retry"]["maxAttempts"])
        self.assertEqual(m.C6_RESTORE_POLICY, kill["retry"]["workspacePolicy"])
        self.assertEqual([m.C6D_SEED_NODE], kill["dependsOn"])
        # verbatim bindings on BOTH copies — nothing baked in.
        for node in (nodes[m.C6D_SEED_NODE], kill):
            self.assertEqual("${{ string(inputs.leave_dirty) }}",
                             node["config"]["env"]["M4_LEAVE_DIRTY"],
                             f"{node['id']} no longer rides the twin's leave_dirty input")
            self.assertEqual("${{ string(inputs.hold_seconds) }}",
                             node["config"]["env"]["M4_HOLD_SECONDS"])
            self.assertEqual("run_workspace", node["config"]["workspace"]["mode"])
        self.assertEqual(1, nodes[m.C6D_SEED_NODE]["retry"]["maxAttempts"])
        self.assertNotIn("dependsOn", nodes[m.C6D_SEED_NODE])

    def test_a_held_node_without_the_dirty_binding_refuses_to_author(self):
        """Without M4_LEAVE_DIRTY on the twin's node there is no uncommitted boundary to
        inherit, so the refusal would be authored, not measured."""
        doc = twin_doc()
        body = m.doc_body_node(doc, m.C5H_NODE_ID)
        del body["config"]["env"]["M4_LEAVE_DIRTY"]
        res = m.c6_dirty_scratch_doc(doc, "x")
        self.assertIsNone(res["doc"])
        self.assertTrue(any("M4_LEAVE_DIRTY" in why for why in res["missing"]),
                        f"missing={res['missing']}")

    def test_missing_held_node_refuses_to_author(self):
        doc = twin_doc()
        impl = [n for n in doc["spec"]["nodes"] if n.get("id") == "build_until_verified"][0]
        body = [n for n in impl["config"]["body"]["nodes"] if n["id"] == "implement"][0]
        body["config"]["workspace"]["mode"] = "read_only"
        res = m.c6_dirty_scratch_doc(doc, "x")
        self.assertIsNone(res["doc"],
                          "a read_only held checkout captures no dirty boundary — no splice")


class C6dScratchInputsTest(unittest.TestCase):
    """The 1c190fe class, C6d side: the scratch must declare EVERY input its copied
    nodes read (shared doc_input_refs, exactly like C5h's builder) and only inputs the
    twin itself declares. The compiler refused the C5h scratch with
    `unknown_field … inputs.leave_dirty selects an input the pipeline does not declare`
    — verified against the shipped Go compiler (loader -> schema -> compiler.Compile),
    and the same refusal is what a hard-coded goal/repository/hold_seconds list brings to
    THIS arm, because the copies keep the twin's leave_dirty binding. A scratch the
    compiler refuses publishes no revision, so there is no boundary and no refusal."""

    def scratch(self):
        res = m.c6_dirty_scratch_doc(twin_doc(), "m4x-c6d-dirty-test")
        self.assertEqual([], res["missing"],
                         f"the seed twin is not the shape C6d splices: {res['missing']}")
        self.assertIsInstance(res["doc"], str)
        return res, yaml.safe_load(res["doc"])

    def test_every_input_the_emitted_doc_reads_is_declared_by_that_same_doc(self):
        """Read off the BYTES the driver posts: parse the emitted YAML and check every
        inputs.X inside spec.nodes against spec.inputs.properties."""
        _res, doc = self.scratch()
        declared = set((doc["spec"]["inputs"]["properties"] or {}).keys())
        read = m.doc_input_refs(doc["spec"]["nodes"])
        self.assertIn("leave_dirty", read,
                      "the copies no longer ride the twin's leave_dirty binding — the "
                      "arm cannot leave a dirty boundary from the run input")
        self.assertTrue(read, "a scratch that reads no input holds nothing to kill")
        self.assertEqual([], sorted(set(read) - declared),
                         f"undeclared inputs the compiler would refuse with "
                         f"unknown_field: read={read} declared={sorted(declared)}")
        self.assertEqual(2, len(doc["spec"]["nodes"]), "C6d's scratch is TWO nodes")

    def test_the_declaration_is_the_shared_helper_not_a_hard_coded_list(self):
        """The builder reads the reference set off the copied NODES (so it follows the
        twin when its bindings move) and never from a list authored in this file."""
        res, _doc = self.scratch()
        twin_read = set(m.doc_input_refs(m.doc_body_node(twin_doc(), m.C5H_NODE_ID)))
        self.assertEqual(sorted(twin_read), sorted(res["input_refs"]),
                         f"the builder read {res['input_refs']} off nodes that read "
                         f"{sorted(twin_read)} — the copies are not verbatim")
        self.assertEqual(sorted(twin_read | {"goal"}), sorted(res["inputs_declared"]),
                         "spec.inputs is not the reference set plus the twin's required list")
        body = driver_fn_src("c6_dirty_scratch_doc")
        self.assertIn("doc_input_refs(", body,
                      "the scratch must use the shared input-reference reader (C5h's)")
        for dead in ('"hold_seconds"', '"leave_dirty"', '"goal", "repository"'):
            self.assertNotIn(dead, body,
                             f"{dead} is a hard-coded input list again — the compiler "
                             f"refuses a declaration that trails the twin's bindings")

    def test_declared_schemas_are_the_twins_copied_verbatim_and_nothing_invented(self):
        twin = twin_doc()
        props = twin["spec"]["inputs"]["properties"]
        twin_required = twin["spec"]["inputs"]["required"]
        _res, doc = self.scratch()
        declared = doc["spec"]["inputs"]["properties"]
        for name, schema in declared.items():
            self.assertIn(name, props, f"inputs.{name} invented (the twin declares "
                                       f"{sorted(props)})")
            self.assertEqual(props[name], schema,
                             f"inputs.{name} re-authored instead of copied — its type and "
                             "default are what the scratch run posts against")
        for name in doc["spec"]["inputs"]["required"]:
            self.assertIn(name, twin_required, "the scratch demands an input the twin "
                                              "does not demand")
        self.assertTrue(set(doc["spec"]["inputs"]["required"]) <= {"goal", "repository"},
                        "the live arm posts goal/repository (+ hold_seconds, leave_dirty) — "
                        "a required input beyond those never reaches the scratch run and "
                        "the POST would be refused outright")
        self.assertIn("leave_dirty", declared,
                      "leave_dirty is read and undeclared — the 1c190fe refusal")
        self.assertIs(False, declared["leave_dirty"].get("default"),
                      "the twin's default false is copied: the scratch's dirty arm is the "
                      "run input, not the document")

    def test_an_input_the_twin_does_not_declare_is_a_gap_reason_not_an_invention(self):
        doc = twin_doc()
        held = m.doc_body_node(doc, m.C5H_NODE_ID)
        self.assertIsNotNone(held, "the twin's held implement node moved — the splice "
                                   "tests above would be testing nothing")
        held["config"]["env"]["M4_INVENTED"] = "${{ inputs.not_in_the_twin }}"
        res = m.c6_dirty_scratch_doc(doc, "x")
        self.assertIsNone(res["doc"])
        self.assertTrue(any("inputs.not_in_the_twin" in why for why in res["missing"]),
                        f"missing={res['missing']}")
        self.assertIn(False, [ok for _l, ok, _d in m.c6_dirty_doc_verdicts(res)])

    def test_the_verdict_arm_fails_when_a_declaration_is_lost(self):
        """A builder that silently drops a declaration must not read as an honest splice
        (that is the 1c190fe shape of bug, verdict side)."""
        res = m.c6_dirty_scratch_doc(twin_doc(), "m4x-c6d-dirty-test")
        honest = [ok for label, ok, _ in m.c6_dirty_doc_verdicts(res) if "declared in" in label]
        self.assertEqual([True], honest, m.c6_dirty_doc_verdicts(res))
        broken = dict(res, inputs_declared=[k for k in res["inputs_declared"]
                                           if k != "leave_dirty"])
        self.assertEqual([False], [ok for label, ok, _ in m.c6_dirty_doc_verdicts(broken)
                                   if "declared in" in label])

    def test_the_publish_refusal_quotes_the_compiler(self):
        """C5h's lesson, reused rather than duplicated: /validate answers 200 with
        valid:false, so C6d's publish GAP carries the compiler's own code+message
        (c5h_publish_report) — the words that would have named this GAP's own cause
        (unknown_field on inputs.leave_dirty) at 1c190fe — not a truncated repr."""
        arm = driver_fn_src("c6d_dirty_arm")
        self.assertIn("c5h_publish_report(pub)", arm,
                      "the dirty-scratch publish GAP must carry the compiler's words")
        self.assertNotIn("[:240]", arm,
                         "a truncated repr() of the validate body is not the compiler's "
                         "refusal — report the errors themselves")
        errs = [{"source": "compiler", "code": "unknown_field",
                 "instance_location": "/spec/nodes/0/config/env/M4_LEAVE_DIRTY",
                 "message": "inputs.leave_dirty selects an input the pipeline does not "
                            "declare (fields goal, hold_seconds, repository)"}]
        report = m.c5h_publish_report({"validate_status": 200, "publish_status": 409,
                                       "revision_id": "", "vresp": {"valid": False,
                                                                    "errors": errs},
                                       "raw": ""})
        self.assertIn("unknown_field", report)
        self.assertIn("inputs.leave_dirty", report)

    def test_the_live_arm_posts_the_run_input_that_leaves_the_boundary_dirty(self):
        """(b) offline: with_dirty is what sets leave_dirty on the scratch RUN, and the
        refusal is only asked once the run is retriable."""
        arm = driver_fn_src("c6d_dirty_arm")
        self.assertIn("with_dirty(", arm,
                      "the scratch run must ride the twin's own leave_dirty input — "
                      "nothing else records committed=false at node A's boundary")
        self.assertIn("with_hold(", arm)
        kill = driver_fn_src("_c6d_kill_and_refuse")
        self.assertLess(kill.index("_c6d_wait_retriable(run_id)"),
                        kill.index('f"/api/v1/runs/{run_id}/retry"'),
                        "the run must reach route 31's retriable state BEFORE the retry "
                        "POST, or the refusal measures the run-status door (1c190fe)")
        self.assertIn("if not may_post", kill,
                      "the refusal may only be posted with BOTH precondition doors open")
        self.assertIn("run_retriable=c6_run_is_retriable(run_st)", kill)
        self.assertIn("want_node=\"/\" + C6D_SEED_NODE", kill,
                      "the dirty boundary must be attributed to completed node A, whose "
                      "checkpoint RetryPlan inherits")


class C6dAvailability(unittest.TestCase):
    def test_reader_parses_the_canned_boundary_row(self):
        rows = m.c6_ckpts(ckpt())
        self.assertEqual(["/plan"], [r["node"] for r in rows])
        self.assertEqual([True], [r["committed"] for r in rows])
        self.assertEqual(["repos-a"], [r["volume_id"] for r in rows])

    def test_attribution_names_the_inherited_boundary_node(self):
        """RetryPlan inherits the NEWEST checkpoint that is not the retried node's own,
        so a dirty row is only C6d's precondition when it is completed node A's."""
        dirty_a = "\n".join([ckpt(node="/dirty_seed", committed="false", mpc="1"),
                             ckpt(node="/kill_target", committed="true", mpc="0")])
        v = m.c6_avail_verdicts(m.c6_ckpts(dirty_a), want_node="/dirty_seed")
        self.assertIs(True, one(v, "uncommitted"))
        self.assertIs(True, one(v, "INHERITED boundary"), v)
        other = "\n".join([ckpt(node="/some_other", committed="false", mpc="2"),
                           ckpt(node="/dirty_seed", committed="true", mpc="0")])
        v = m.c6_avail_verdicts(m.c6_ckpts(other), want_node="/dirty_seed")
        self.assertIs(True, one(v, "uncommitted"), "a dirty row somewhere still exists")
        self.assertIs(False, one(v, "INHERITED boundary"),
                      "the dirty boundary is not node A's — the refusal would be "
                      "attributed to a boundary this retry does not read")
        absent = m.c6_avail_verdicts(m.c6_ckpts(ckpt(committed="false", mpc="1")),
                                     want_node="/dirty_seed")
        self.assertIs(None, one(absent, "INHERITED boundary"),
                      "node A recorded no row at all: GAP, never a guess")
        self.assertIs(True, one(absent, "uncommitted"))

    def test_dirty_boundary_arm_exists(self):
        v = m.c6_avail_verdicts(m.c6_ckpts(ckpt(committed="false", mpc="3")))
        self.assertIs(True, one(v, "uncommitted"))

    def test_committed_only_boundary_is_a_gap(self):
        v = m.c6_avail_verdicts(m.c6_ckpts(ckpt(committed="true", mpc="0")))
        self.assertIs(None, one(v, "uncommitted"))

    def test_unreadable_committed_flag_is_a_gap(self):
        v = m.c6_avail_verdicts(m.c6_ckpts(ckpt(committed="-", mpc="-")))
        self.assertIs(None, one(v, "uncommitted"))


class C6dDoors(unittest.TestCase):
    """§ 5 route 31 answers a POST /retry from TWO doors, in the contract's own order:
    the run-status door (run_not_retriable on a running or terminal-successful run) and
    the checkpoint door (checkpoint_unavailable when the inherited boundary is not
    provably committed). 1c190fe measured the FIRST and graded it as the second, so
    'no new attempt' counted the engine's own retry. The driver must therefore drive the
    scratch to a retriable state (failed/interrupted/cancelled) on an uncommitted
    recorded boundary BEFORE it asks — the shipped RetryRun (postgres/m4api_runs_write.go)
    checks the run row before it ever calls runtime/retry.go, which is what route 31 says."""

    def rows(self, node="/dirty_seed", committed="false", mpc="1"):
        return m.c6_ckpts(ckpt(node=node, committed=committed, mpc=mpc))

    def test_retriable_run_on_a_dirty_inherited_boundary_opens_both_doors(self):
        v, may = m.c6d_precondition_verdicts("failed", self.rows(),
                                             want_node="/dirty_seed")
        self.assertTrue(may, v)
        self.assertNotIn(False, [ok for _l, ok, _d in v], v)
        self.assertIs(True, one(v, "RETRIABLE"))

    def test_every_retriable_status_route_31_names_opens_the_run_door(self):
        for st in m.C6D_RETRIABLE_RUN_STATES:
            self.assertTrue(m.c6_run_is_retriable(st), st)
            _v, may = m.c6d_precondition_verdicts(st, self.rows(), want_node="/dirty_seed")
            self.assertTrue(may, f"{st} is retriable per route 31")

    def test_running_or_completed_never_opens_the_run_door(self):
        """A run still mid-flight GAPs C6d (WHO has to fail it is C5h's claim; an
        engine-owned 'running (retry armed)' row is C5b's own sentence), while a run that
        COMPLETED contradicts the arm's premise outright and reads FAIL."""
        for st in ("running", "queued", "waiting_human", "paused", "preparing"):
            self.assertFalse(m.c6_run_is_retriable(st), st)
            v, may = m.c6d_precondition_verdicts(st, self.rows(), want_node="/dirty_seed")
            self.assertFalse(may, f"{st}: the run-status door owns the answer")
            self.assertIs(None, one(v, "RETRIABLE"), f"{st} must GAP, not FAIL C6d: {v}")
        v, may = m.c6d_precondition_verdicts("completed", self.rows(),
                                             want_node="/dirty_seed")
        self.assertFalse(may, v)
        self.assertIs(False, one(v, "RETRIABLE"),
                      "nothing failed the run at all — that is a contradiction, not a GAP")
        v, may = m.c6d_precondition_verdicts("", self.rows(), want_node="/dirty_seed")
        self.assertFalse(may, v)
        self.assertIs(None, one(v, "RETRIABLE"),
                      "an unreadable run row is a GAP, never a guess")

    def test_a_committed_boundary_does_not_open_the_checkpoint_door(self):
        """Restore over a committed boundary is LEGAL — posting the refusal arm there
        would RESET the workspace this row measures and grade a 200 as a failed 409."""
        v, may = m.c6d_precondition_verdicts("failed",
                                             self.rows(committed="true", mpc="0"),
                                             want_node="/dirty_seed")
        self.assertFalse(may, v)
        self.assertIs(None, one(v, "uncommitted"), v)

    def test_a_dirty_boundary_on_another_node_does_not_open_the_checkpoint_door(self):
        ck = m.c6_ckpts("\n".join([ckpt(node="/other", committed="false", mpc="2"),
                                   ckpt(node="/dirty_seed", committed="true", mpc="0")]))
        v, may = m.c6d_precondition_verdicts("failed", ck, want_node="/dirty_seed")
        self.assertFalse(may, v)
        self.assertIs(False, one(v, "INHERITED boundary"), v)

    def test_no_checkpoint_rows_at_all_is_a_gap(self):
        v, may = m.c6d_precondition_verdicts("failed", [], want_node="/dirty_seed")
        self.assertFalse(may, v)
        self.assertIs(None, one(v, "uncommitted"), v)


PROBLEM_RETRIABLE = ('{"detail":"a failed run is not retriable","status":409,'
                     '"title":"Run Not Retriable","type":"https://communication.dev/'
                     'errors/run-not-retriable"}')


class C6dRefusal(unittest.TestCase):
    def test_clean_409_refusal_passes(self):
        v = m.c6_unavailable_verdicts(409, "application/problem+json", "checkpoint_unavailable",
                                      BOUNDARY, BOUNDARY, "3", "3", "0", 1)
        self.assertNotIn(False, [ok for _l, ok, _d in v], f"a clean refusal must PASS: {v}")

    def test_no_request_is_a_gap(self):
        v = m.c6_unavailable_verdicts(None, "", "", BOUNDARY, BOUNDARY, "3", "3", "0", 1)
        self.assertTrue(all(ok is None for _l, ok, _d in v), f"unissued arm must GAP: {v}")

    def test_fail_wrong_status_or_code(self):
        v = m.c6_unavailable_verdicts(200, "application/json", "", BOUNDARY, BOUNDARY,
                                      "3", "3", "0", 2)
        self.assertIs(False, one(v, "-> 409"))
        self.assertIs(False, one(v, "problem+json"))

    def test_fail_a_refusal_that_reset_anything(self):
        moved = "d00d" + "2" * 60
        v = m.c6_unavailable_verdicts(409, "application/problem+json", "checkpoint_unavailable",
                                      BOUNDARY, moved, "3", "0", "1", 2)
        self.assertIs(False, one(v, "NOTHING was reset"))
        self.assertIs(False, one(v, "zero run.checkpoint_restored"))
        self.assertIs(False, one(v, "no new attempt"))

    def test_an_unreadable_worktree_gaps_instead_of_passing_vacuously(self):
        """C6ResetWindowTest's lesson, applied to the refusal: live19 read HEAD inside
        the dead worker's container, got '', and the nothing-was-reset check PASSED on
        the empty read. Nothing is not a measurement."""
        v = m.c6_unavailable_verdicts(409, "application/problem+json", "checkpoint_unavailable",
                                      "", "", "", "", "0", 1, body="{}",
                                      attempts_before=1)
        self.assertIs(None, one(v, "NOTHING was reset"), v)
        self.assertTrue(one(v, "problem+json"),
                        "the refusal itself is still measured from the wire")
        half = m.c6_unavailable_verdicts(409, "application/problem+json",
                                         "checkpoint_unavailable", BOUNDARY, "", "1", "1",
                                         "0", 1, body="{}", attempts_before=1)
        self.assertTrue(one(half, "NOTHING was reset"),
                        "one readable side plus an unchanged count is a measurement")

    def test_the_run_status_door_on_a_retriable_run_is_a_fail_not_a_gap(self):
        """Once the driver has VERIFIED runs.status is retriable, a run-not-retriable
        answer is the engine's own door ordering (RetryRun checks the run row before it
        asks runtime/retry.go for the plan): § 5 says a failed run IS retriable, so this
        FAILs and is reported — the sequencing excuse only covers a run the ENGINE still
        owns (§ 7.1 C5b's 'running (retry armed)')."""
        v = m.c6_unavailable_verdicts(409, "application/problem+json", "", BOUNDARY, BOUNDARY,
                                      "3", "3", "0", 1, body=PROBLEM_RETRIABLE,
                                      attempts_before=1, restored_before="0",
                                      run_retriable=True)
        self.assertIs(True, one(v, "-> 409"))
        self.assertIs(False, one(v, "run-status door refused"), v)
        self.assertIs(False, one(v, "no new attempt"), v)
        self.assertIn("failed/interrupted/cancelled",
                      [d for l, _o, d in v if "run-status door refused" in l][0])

    def test_the_run_status_door_while_the_engine_retries_still_gaps(self):
        """The 1c190fe case, unchanged: run 'running', so nothing below the run-status
        door is attributable."""
        v = m.c6_unavailable_verdicts(409, "application/problem+json", "", BOUNDARY, BOUNDARY,
                                      "3", "3", "0", 2, body=PROBLEM_RETRIABLE,
                                      attempts_before=1, restored_before="0",
                                      run_retriable=False)
        self.assertIs(None, one(v, "checkpoint_unavailable"), v)
        self.assertIs(None, one(v, "no new attempt"), v)


class C6bRestored(unittest.TestCase):
    def test_full_restore_passes(self):
        cks = m.c6_ckpts(ckpt())
        v = m.c6_restored_verdicts(restored_ev(), cks, BOUNDARY, BOUNDARY, "0", 2)
        self.assertNotIn(False, [ok for _l, ok, _d in v], f"a real restore must PASS: {v}")

    def test_seed_planted_must_be_named_by_the_disclosure(self):
        """§ 7.1 C6b is about the FILES the reset destroyed: with the live leg's
        planted untracked file, an honest disclosure that does not name it (the
        empty list of a tree nobody dirtied, live19, or some other file) FAILs."""
        cks = m.c6_ckpts(ckpt())
        named = m.c6_restored_verdicts(restored_ev(discarded=("m4-c6-uncommitted.txt",)),
                                       cks, BOUNDARY, BOUNDARY, "0", 2,
                                       seed="m4-c6-uncommitted.txt")
        self.assertTrue(one(named, "discarded_paths"))
        empty = m.c6_restored_verdicts(restored_ev(discarded=()), cks, BOUNDARY,
                                       BOUNDARY, "0", 2, seed="m4-c6-uncommitted.txt")
        self.assertIs(False, one(empty, "discarded_paths"))
        wrong = m.c6_restored_verdicts(restored_ev(discarded=("other.txt",)), cks, BOUNDARY,
                                       BOUNDARY, "0", 2, seed="m4-c6-uncommitted.txt")
        self.assertIs(False, one(wrong, "discarded_paths"))

    def test_missing_event_is_a_gap(self):
        v = m.c6_restored_verdicts(None, m.c6_ckpts(ckpt()), BOUNDARY, BOUNDARY, "0", 2)
        self.assertTrue(all(ok is None for _l, ok, _d in v), f"no event => GAP: {v}")

    def test_uncompiled_policy_is_a_gap(self):
        v = m.c6_restored_verdicts(restored_ev(), [], BOUNDARY, BOUNDARY, "0", 2,
                                   policy_in_plan=False)
        self.assertTrue(all(ok is None for _l, ok, _d in v), f"no plan => GAP: {v}")

    def test_the_policy_is_measured_from_the_revisions_compiled_plan(self):
        """live13 C6b read vresp['plan'] — the validate response (api ValidateResponse)
        has NO plan member, so the leg GAPped forever on a phantom field. The
        compiled plan is only ever published at GET /revisions/{id} -> compiled_plan.

        The pin is on the PHANTOM READ, not on the string `.get("plan")`: a `.get("plan")`
        on a node-by-id map (C9e's `by_id.get("plan")`, counting the twin's /plan nodes)
        is a different fact entirely and is not this file's to change."""
        self.assertIn("c6_policy_in_plan", defined_functions())
        called, _args = calls_and_args("c6")
        self.assertIn("c6_policy_in_plan", called,
                      "C6 must measure the policy where the API publishes the plan")
        with open(DRIVER, encoding="utf-8") as fh:
            src = fh.read()
        phantom = []
        for node in ast.walk(ast.parse(src)):
            if not (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
                    and node.func.attr == "get" and node.args
                    and isinstance(node.args[0], ast.Constant)
                    and node.args[0].value == "plan"):
                continue
            near = ast.unparse(node.func.value).lower()
            same_line = src.splitlines()[node.lineno - 1].lower()
            if any(k in near for k in ("vresp", "valid", "pub", "resp", "json")) \
                    or any(k in same_line for k in ("vresp", "validate", "publish")):
                phantom.append(f"L{node.lineno}: {ast.unparse(node)}")
        self.assertEqual([], phantom,
                         "a plan member read off a VALIDATE/PUBLISH response is the "
                         "phantom field live13 GAPped on (api.ValidateResponse has none)")
        fn = next(n for n in ast.parse(src).body if isinstance(n, ast.FunctionDef)
                  and n.name == "c6_policy_in_plan")
        self.assertIn("compiled_plan", ast.unparse(fn))

    def test_fail_wrong_head_or_dirty_worktree_or_wrong_boundary(self):
        ev = restored_ev(key="/other", frm="beef" + "3" * 60, discarded=())
        v = m.c6_restored_verdicts(ev, m.c6_ckpts(ckpt(node="/verdict")), BOUNDARY,
                                   "aaaa" + "4" * 60, "2", 1)
        self.assertIs(False, one(v, "names the killed node"))
        self.assertIs(False, one(v, "from_commit"))
        self.assertIs(False, one(v, "discarded_paths"))
        self.assertIs(False, one(v, "HEAD equals the boundary"))
        self.assertIs(False, one(v, "status --porcelain is EMPTY"))
        self.assertIs(False, one(v, "attempt 2 exists"))


class C6eLoss(unittest.TestCase):
    def att(self, n, status="failed", ec="workspace_lost"):
        return {"attempt_number": str(n), "status": status, "error_class": ec}

    def test_honest_loss_passes(self):
        ev = {"reason": "different_worker", "expected": "repos-a", "found": "repos-c",
              "worker": "worker-c"}
        v = m.c6_loss_verdicts(ev, "failed", "workspace_lost", [self.att(2)], "0",
                               m.C6_LOSS_SENTENCE + " — the tree is gone", False, base=2)
        self.assertNotIn(False, [ok for _l, ok, _d in v], f"an honest loss must PASS: {v}")

    def test_same_volume_reclaim_is_a_gap_not_a_pass(self):
        v = m.c6_loss_verdicts(None, "completed", None, [self.att(1)], "0", "", True)
        self.assertTrue(all(ok is None for _l, ok, _d in v), f"no loss happened: {v}")

    def test_fail_wrong_reason_and_resumed_wording(self):
        v = m.c6_loss_verdicts({"reason": "oops"}, "running", "infra",
                               [self.att(2, "running", "infra"), self.att(3)], "1",
                               "the workspace was resumed from the mirror", False, base=2)
        self.assertIs(False, one(v, "names the reason"))
        self.assertIs(False, one(v, "error_class='workspace_lost'"))
        self.assertIs(False, one(v, "NO automatic retry"))
        self.assertIs(False, one(v, "rerun required"))
        self.assertIs(False, one(v, "NEVER described as 'resumed'"))

    def test_volume_changed_reason_also_passes(self):
        ev = {"reason": "volume_changed", "expected": "repos-a", "found": "-",
              "worker": "worker-a"}
        v = m.c6_loss_verdicts(ev, "failed", "workspace_lost", [self.att(1)], "0",
                               "prior edits lost, rerun required", False, base=1)
        self.assertNotIn(False, [ok for _l, ok, _d in v], f"{v}")


class C6cFinal(unittest.TestCase):
    def test_completed_same_keyset_passes(self):
        keys = {"/plan", "/approve", "/build_until_verified", "/verdict", "/publish_verified",
                "/emit_items", "/fan_out", "/publish_needs_attention"}
        pol = {m.C6_KILL_KEY.strip("/"): m.C6_RESTORE_POLICY}
        v = m.c6_final_verdicts("completed", {"policies": pol}, keys, keys)
        self.assertNotIn(False, [ok for _l, ok, _d in v], f"{v}")

    def test_fail_run_not_completed_or_wrong_mode(self):
        v = m.c6_final_verdicts("failed", {"policies": {}}, {"/plan", "/verdict"},
                                {"/plan", "/verdict", "/extra"})
        self.assertIs(False, one(v, "reached 'completed'"))
        self.assertIs(False, one(v, "workspace_policies"))
        self.assertIs(False, one(v, "iteration-normalized"))

    def test_a_different_iteration_count_is_the_same_graph(self):
        """§ 7.1 C6c's "the run completed" pair is graded on the SAME normalizer as
        C5g/C1: the restore-retry's until-loop may pass on a different iteration
        count than C1's twin spent (live18/C6: 1 vs 2) without that being a rewrite
        of history."""
        loop = lambda n: {f"/build_until_verified[{n}]/{b}"
                          for b in ("implement", "test", "review")}
        k1 = {"/plan", "/verdict"} | loop(1) | loop(2)
        k6 = {"/plan", "/verdict"} | loop(1)
        v = m.c6_final_verdicts("completed",
                                {"policies": {m.C6_KILL_KEY: m.C6_RESTORE_POLICY}}, k1, k6)
        self.assertIs(True, one(v, "iteration-normalized"), v)
        self.assertIs(True, one(v, "no hole"), v)
        self.assertIn("spent 2 iteration(s), this run 1",
                      [d for l, _o, d in v if "iteration-normalized" in l][0])

    def test_a_removed_or_renamed_node_key_still_fails(self):
        """The normalization must not sand off the append-only claim."""
        loop = lambda n: {f"/build_until_verified[{n}]/{b}"
                          for b in ("implement", "test", "review")}
        k1 = {"/plan", "/verdict"} | loop(1)
        pol = {"policies": {m.C6_KILL_KEY: m.C6_RESTORE_POLICY}}
        self.assertIs(False, one(m.c6_final_verdicts("completed", pol, k1,
                                                     k1 - {"/verdict"}),
                                 "iteration-normalized"))
        self.assertIs(False, one(m.c6_final_verdicts("completed", pol, k1,
                                                     {k.replace("/implement", "/impl")
                                                      for k in k1}),
                                 "iteration-normalized"))

    def test_a_row_deleted_mid_history_fails_the_hole_guard(self):
        loop = lambda n: {f"/build_until_verified[{n}]/{b}"
                          for b in ("implement", "test", "review")}
        k1 = {"/plan", "/verdict"} | loop(1) | loop(2) | loop(3)
        v = m.c6_final_verdicts("completed",
                                {"policies": {m.C6_KILL_KEY: m.C6_RESTORE_POLICY}},
                                k1, k1 - {"/build_until_verified[2]/test"})
        self.assertIs(True, one(v, "iteration-normalized"))
        self.assertIs(False, one(v, "no hole"))
        self.assertIn("missing [2]", [d for l, _o, d in v if "no hole" in l][0])

    def test_missing_c1_set_is_a_gap_not_an_invention(self):
        """The equality needs TWO measured sets — an empty C1 side (C1 did not run
        in this pass) GAPs instead of failing the product for a lab gap."""
        v = m.c6_final_verdicts("completed", {"policies": {m.C6_KILL_KEY: m.C6_RESTORE_POLICY}},
                                set(), {"/plan"})
        self.assertIsNone(one(v, "key set equals C1"))

    def test_missing_run_retried_row_is_a_gap_not_an_empty_map(self):
        """run.retried is written by the MANUAL RetryRun (runtime/retry.go); when
        the engine's budget armed attempt 2 itself (§ 7.1 C5b 'running (retry
        armed)') and the POST was refused, NO row exists — that absence must GAP
        with the reason, never read as policies={} (live11/C6.out FAILed on {} for
        exactly this non-event)."""
        v = m.c6_final_verdicts("completed", {"policies": None}, {"/plan"}, {"/plan"})
        self.assertIsNone(one(v, "workspace_policies"))
        d = [d for l, _o, d in v if "workspace_policies" in l][0]
        self.assertIn("run.retried", d)
        self.assertIn("RetryRun", d)


class C6dTwoDoorsTest(unittest.TestCase):
    """Two 409 doors answer POST /retry: the run-status door (run-not-retriable,
    fires while the ENGINE's auto-retry keeps the run 'running (retry armed)') and
    the checkpoint door (checkpoint_unavailable). live11/C6.out hit the first and
    was graded against the second. The checkpoint-door arms GAP with the
    sequencing reason; 'no new attempt' compares BEFORE to AFTER so the engine's
    own attempt 2 is never charged to a refusal that predates it."""

    PROBLEM = ('{"detail":"a running run is not retriable; retry a failed, '
               'interrupted or cancelled one","status":409,"title":"Run Not '
               'Retriable","type":"https://communication.dev/errors/'
               'run-not-retriable"}')

    def test_run_status_door_gaps_the_checkpoint_arms(self):
        v = m.c6_unavailable_verdicts(409, "application/problem+json", "", BOUNDARY,
                                      BOUNDARY, "3", "3", "0", 2, body=self.PROBLEM,
                                      attempts_before=2)
        self.assertIs(True, one(v, "-> 409"), "it IS a 409 — the door just is not that one")
        self.assertIsNone(one(v, "checkpoint_unavailable"))
        self.assertIsNone(one(v, "no new attempt"))
        d = [d for l, _o, d in v if "no new attempt" in l][0]
        self.assertIn("predates it", d)
        self.assertIsNot(False, one(v, "NOTHING was reset"))
        self.assertTrue(one(v, "NOTHING was reset"))
        self.assertTrue(one(v, "zero run.checkpoint_restored"))

    def test_checkpoint_door_still_verdicts_normally(self):
        v = m.c6_unavailable_verdicts(409, "application/problem+json",
                                      "checkpoint_unavailable", BOUNDARY, BOUNDARY,
                                      "3", "3", "0", 1, body="{}", attempts_before=1)
        self.assertNotIn(False, [ok for _l, ok, _d in v], f"{v}")
        self.assertTrue(one(v, "problem+json"))
        self.assertTrue(one(v, "no new attempt"))

    def test_checkpoint_door_that_appended_fails_against_the_before_count(self):
        v = m.c6_unavailable_verdicts(409, "application/problem+json",
                                      "checkpoint_unavailable", BOUNDARY, BOUNDARY,
                                      "3", "3", "0", 2, body="{}", attempts_before=1)
        self.assertIs(False, one(v, "no new attempt"))

    def test_windowed_count_charges_the_refusal_not_the_engines_own_reset(self):
        """live19/C6.out: 'GAP … the ENGINE owns the auto-retry' beside 'FAIL C6d
        zero run.checkpoint_restored events — count=1' — the single event was
        attempt 2's own reset, which the refusal did not append. The arm is
        BEFORE against AFTER: same count across the POST proves the refusal wrote
        nothing; a count that grows in the window still FAILs."""
        v = m.c6_unavailable_verdicts(409, "application/problem+json",
                                      "checkpoint_unavailable", BOUNDARY, BOUNDARY,
                                      "3", "3", "1", 1, body="{}", attempts_before=1,
                                      restored_before="1")
        self.assertTrue(one(v, "zero run.checkpoint_restored"),
                        "the engine's pre-existing restore is not this refusal's output")
        grew = m.c6_unavailable_verdicts(409, "application/problem+json",
                                         "checkpoint_unavailable", BOUNDARY, BOUNDARY,
                                         "3", "3", "2", 1, body="{}", attempts_before=1,
                                         restored_before="1")
        self.assertIs(False, one(grew, "zero run.checkpoint_restored"))
        legacy = m.c6_unavailable_verdicts(409, "application/problem+json",
                                           "checkpoint_unavailable", BOUNDARY, BOUNDARY,
                                           "3", "3", "0", 1, body="{}")
        self.assertTrue(one(legacy, "zero run.checkpoint_restored"),
                        "no before-count falls back to the all-time zero")


def calls_and_args(fn_name, path=DRIVER):
    """(called_names, {name: [literal-arg-lists]}) for one driver function."""
    with open(path, encoding="utf-8") as fh:
        tree = ast.parse(fh.read())
    for node in tree.body:
        if isinstance(node, ast.FunctionDef) and node.name == fn_name:
            called, args = set(), {}
            for sub in ast.walk(node):
                if isinstance(sub, ast.Call) and isinstance(sub.func, ast.Name):
                    called.add(sub.func.id)
                    args.setdefault(sub.func.id, []).append(
                        [a.value if isinstance(a, ast.Constant) else None for a in sub.args])
            return called, args
    raise AssertionError(f"{fn_name} is not a module-level def in {path}")


def defined_functions(path=DRIVER):
    with open(path, encoding="utf-8") as fh:
        return {n.name for n in ast.parse(fh.read()).body
                if isinstance(n, ast.FunctionDef)}


LIVE_ROW = {"id": "a-1", "key": m.C6_KILL_KEY, "worker": "worker-a", "token": "7",
            "attempt_number": "1", "turn": "-"}


class Clock:
    """Monotonic fake clock so a 300s cap costs no wall time."""

    def __init__(self):
        self.now = 1000.0

    def time(self):
        self.now += 1.0
        return self.now

    def sleep(self, secs):
        self.now += secs


def run_gate_script(statuses, rows, decide=True, tag="C6b", cap=300, target=None):
    """Drive m.wait_live_past_gate over canned ledger reads (one run_status + one
    live-claim row per poll). Returns (result, decide_calls, checks). Nothing is
    killed here — the live kill stays C6's § 7 run."""
    calls, checks, pos = [], [], [0]
    pairs = list(zip(statuses, rows))

    def at(i):
        return pairs[min(i, len(pairs) - 1)]

    def live_row(run_id):
        row = at(pos[0])[1]
        pos[0] += 1
        return row

    def approve(client, project_id, run_id):
        calls.append(project_id)
        return decide

    def check(label, ok, detail=""):
        checks.append((label, ok))
        return ok

    orig = (m.time, m.run_status, m.c5_live_attempt_row, m.approve_gate, m.check)
    m.time = Clock()
    m.run_status = lambda run_id: at(pos[0])[0]
    m.c5_live_attempt_row = live_row
    m.approve_gate = approve
    m.check = check
    try:
        out = m.wait_live_past_gate(object(), "p-1", "run-1", cap, tag, target=target)
    finally:
        (m.time, m.run_status, m.c5_live_attempt_row, m.approve_gate, m.check) = orig
    return out, calls, checks


class C6GateFirstSequencingTest(unittest.TestCase):
    """live4/C6.out: `GAP C6b a live attempt to kill — no attempt on run … was ever
    held by a worker within 300s`. The kill target (/implement, one node deeper
    than /approve) only leases AFTER the gate is decided, so C6's bare
    c4_wait_live_attempt poll graded itself against an empty ledger — the same
    driver bug C5 had. These tests pin C6's ordering offline."""

    def test_gate_is_decided_before_the_driver_waits_for_a_live_attempt(self):
        out, calls, checks = run_gate_script(
            ["waiting_human", "waiting_human", "running"], [None, None, LIVE_ROW])
        self.assertEqual(out, LIVE_ROW)
        self.assertEqual(calls, ["p-1"], "exactly one decide attempt once it succeeded")
        self.assertTrue(any("approval gate was decided" in lbl and ok
                            for lbl, ok in checks), str(checks))

    def test_the_verdict_lines_are_tagged_c6b(self):
        _out, _calls, checks = run_gate_script(["waiting_human", "running"],
                                               [None, LIVE_ROW])
        self.assertTrue(any(lbl.startswith("C6b ") and ok for lbl, ok in checks),
                        f"C6's report must own its line: {checks}")

    def test_a_live_claim_needs_no_gate_decision(self):
        out, calls, _ = run_gate_script(["running"], [LIVE_ROW])
        self.assertEqual(out, LIVE_ROW)
        self.assertEqual(calls, [])

    def test_terminal_run_stops_the_wait(self):
        out, calls, _ = run_gate_script(["cancelled"], [None])
        self.assertIsNone(out)
        self.assertEqual(calls, [])

    def test_a_window_that_never_left_the_gate_is_a_fail_not_a_silent_none(self):
        out, calls, checks = run_gate_script(["waiting_human"] * 40, [None] * 40,
                                             decide=False)
        self.assertIsNone(out)
        self.assertGreater(len(calls), 1, "the decide route is retried, not assumed")
        self.assertIn(False, [ok for _lbl, ok in checks],
                      f"still waiting_human at the cap must be reported: {checks}")

    def test_c6_calls_the_gate_first_wait(self):
        called, args = calls_and_args("c6")
        self.assertIn("wait_live_past_gate", called, sorted(called))
        self.assertEqual([a[4] for a in args["wait_live_past_gate"]], ["C6b"],
                         "C6 must label its own verdict lines")

    def test_the_wait_is_aimed_at_the_kill_target_not_at_whatever_is_held(self):
        """live8/C6.out: the kill landed on /plan — the twin holds /plan open BEFORE
        /approve, so the first held attempt the poll saw was the wrong node, and the
        retry C6 then posted named /build_until_verified[1]/implement, a node that did
        not exist yet (the API answered that with a 500)."""
        src = open(DRIVER, encoding="utf-8").read()
        fn = next(n for n in ast.parse(src).body if isinstance(n, ast.FunctionDef)
                  and n.name == "c6")
        kws = [{k.arg: ast.unparse(k.value) for k in c.keywords}
               for c in ast.walk(fn) if isinstance(c, ast.Call)
               and isinstance(c.func, ast.Name) and c.func.id == "wait_live_past_gate"]
        self.assertTrue(kws, "c6 posts no run to wait on")
        for kw in kws:
            self.assertEqual(kw.get("target"), "C6_KILL_KEY",
                             f"the kill must land on {m.C6_KILL_KEY}: {kw}")
        plan = dict(LIVE_ROW, key="/plan")
        out, calls, checks = run_gate_script(["running", "waiting_human", "running"],
                                             [plan, None, LIVE_ROW], target=m.C6_KILL_KEY)
        self.assertEqual(out, LIVE_ROW, f"a pre-gate /plan claim is not the kill target: {out}")
        self.assertEqual(calls, ["p-1"], "the gate was decided exactly once")
        self.assertTrue(any("approval gate was decided" in lbl and ok
                            for lbl, ok in checks), str(checks))

    def test_the_bare_live_attempt_poll_is_gone_driver_wide(self):
        names = defined_functions()
        self.assertNotIn("c4_wait_live_attempt", names, "one gate-first wait for all "
                                                        "three kills — no dead twin")
        for fn in ("c4", "c5", "c6"):
            called, _args = calls_and_args(fn)
            self.assertNotIn("c4_wait_live_attempt", called, f"{fn} still waits on a "
                                                             "lease without the gate")


class C6ResetWindowTest(unittest.TestCase):
    """live19/C6.out graded the reset from the DEAD worker's container: the run's
    affinity (§ 4's claim predicate) pins the engine's retry to the owning worker,
    so while `compose kill` held it down no worker-side reset could have happened
    — HEAD read '' (the empty read also passed the dirty-set check vacuously), and
    the one event the ledger held predated every observation. These pins keep the
    disclosure produced BEFORE the kill (so the reset has real files to name) and
    the reset's evidence read AFTER the worker is back."""

    def _c6_src(self):
        src = open(DRIVER, encoding="utf-8").read()
        fn = next(n for n in ast.parse(src).body if isinstance(n, ast.FunctionDef)
                  and n.name == "c6")
        return ast.get_source_segment(src, fn)

    def test_the_seed_is_planted_before_the_kill(self):
        body = self._c6_src()
        self.assertLess(body.index("C6_DISCARD_SEED"), body.index('COMPOSE + ["kill", owner]'),
                        "the uncommitted file must exist while the attempt is held, "
                        "so the reset has something real to destroy and disclose")

    def test_the_reset_is_observed_from_the_live_retry_not_the_corpse(self):
        body = self._c6_src()
        self.assertLess(body.index('COMPOSE + ["start", owner]'),
                        body.index("c6_restore_event(run_id)"),
                        "the reset's evidence can only exist once the owning worker "
                        "is back and its retried attempt has run the reset")
        # C6d's windowed event arm lives in the leg that measures C6d (the dirty
        # scratch) since the refusal moved there: the twin's retry is C6b/C6c's
        # restore, and grading a refusal on a COMMITTED boundary at the run-status
        # door is what made 1c190fe's rows unattributable.
        self.assertNotIn("restored_before=n_restored_before", body,
                         "c6's own retry is the restore, not C6d's refusal arm")
        kill = driver_fn_src("_c6d_kill_and_refuse")
        self.assertIn("restored_before=n_restored_before", kill,
                      "C6d's event arm must stay windowed around the refusal")
        self.assertLess(kill.index('"start", killed'),
                        kill.index("c6_unavailable_verdicts("),
                        "the refusal's readings are taken from the LIVE worker, not the "
                        "corpse — the killed worker is composed back up first")

    def test_the_verdict_carries_the_seed_into_the_disclosure_claim(self):
        body = self._c6_src()
        self.assertIn("seed=C6_DISCARD_SEED", body,
                      "c6_restored_verdicts must be shown the planted file")




def detail_of(rows, needle):
    hits = [d for l, _o, d in rows if needle in l]
    assert hits, f"no verdict matching {needle!r}"
    return hits[0]



class C6cManualRetryScratchTest(unittest.TestCase):
    """The scratch C6c publishes is C5e's instrument with the ONE variable that makes a
    restore legal: a seed boundary that reads COMMITTED (the edit-free step), where
    C6d's same-shape scratch buys the opposite state on purpose."""

    def build(self):
        return m.c5e_retry_scratch_doc(twin_doc(), "m4x-c6c-restore",
                                       policy=m.C6_RESTORE_POLICY, seed_step=m.C5E_SEED_STEP,
                                       kill_node=m.C6C_KILL_NODE)

    def test_the_seed_is_the_edit_free_step_and_the_kill_carries_the_mode(self):
        res = self.build()
        self.assertEqual(res["missing"], [], res["missing"])
        parsed = yaml.safe_load(res["doc"])
        seed, kill = parsed["spec"]["nodes"]
        self.assertEqual((seed["id"], kill["id"]), (m.C5E_SEED_NODE, m.C6C_KILL_NODE))
        self.assertEqual(seed["config"]["args"], [m.C5E_SEED_STEP])
        self.assertEqual(kill["retry"], {"maxAttempts": 1,
                                         "workspacePolicy": m.C6_RESTORE_POLICY})
        self.assertEqual(res["doc"].count("workspacePolicy:"), 1)
        self.assertEqual(res["doc"].count("maxAttempts:"), 2)
        self.assertNotIn("kind: until", res["doc"])

    def test_it_is_NOT_c6d_dirty_scratch(self):
        """Attribution, in one assertion: the refusal arm's seed leaves its edit in the
        tree (committed=false → 409); the accept arm's seed writes nothing (committed=true
        → 200). Swap them and C6c grades C6d's door — the 1c190fe error."""
        accept = yaml.safe_load(self.build()["doc"])["spec"]["nodes"][0]
        refuse = yaml.safe_load(m.c6_dirty_scratch_doc(twin_doc(), "m4x-c6d")["doc"]
                                )["spec"]["nodes"][0]
        self.assertEqual(accept["config"]["args"], [m.C5E_SEED_STEP])
        self.assertEqual(refuse["config"]["args"], ["implement"])

    def test_the_honesty_rows_all_pass_on_the_published_shape(self):
        v = m.c5e_retry_doc_verdicts(self.build())
        self.assertTrue(all(ok for _l, ok, _d in v), [(l, d) for l, ok, d in v if not ok])
        self.assertTrue(any("COMMITTED clean tree" in l for l, _o, _d in v),
                        "the seed row must SAY why the edit-free step is the one this "
                        "arm needs, not just that a seed exists")


class C6cRetriedVerdictsTest(unittest.TestCase):
    """§ 7.1 C6c's mode claim is a JOURNAL claim, and run.retried is written by the
    manual retry alone: this is where it is finally graded."""

    def reading(self, status=200, policies="default", restore="self", may_post=True,
                final_st="completed", run_st="failed", body="{}",
                cause="node_execution_failed:/restore_target"):
        key = "/" + m.C6C_KILL_NODE
        if policies == "default":
            policies = {key: m.C6_RESTORE_POLICY}
        ev = None if restore is None else {
            "key": key if restore == "self" else str(restore),
            "payload": {"node_instance_key": key, "from_commit": BOUNDARY,
                        "discarded_paths": []}}
        return {"run_id": "run-c", "run_st": run_st, "cause": cause, "final_st": final_st,
                "may_post": may_post, "status": status, "body": body, "rows": [], "seed_rows": [],
                "seed_ne": {"ne": 1, "attempts": 1}, "seed_node": m.C5E_SEED_NODE,
                "kill_node": m.C6C_KILL_NODE, "seed_step": m.C5E_SEED_STEP,
                "policy": m.C6_RESTORE_POLICY, "head_before": BOUNDARY, "dirty_before": "0",
                "ckpts": [], "policies": policies, "restore": ev, "worker": "worker-a"}

    def test_an_accepted_restore_passes_the_pair_and_the_mode(self):
        v = m.c6c_retried_verdicts(self.reading())
        self.assertTrue(all(ok is True for _l, ok, _d in v),
                        [(l, ok, d) for l, ok, d in v if ok is not True])
        self.assertIn(m.C6_RESTORE_POLICY, detail_of(v, "names restore_checkpoint for")
                      if hasattr(self, "detail_of") else str(v))

    def test_the_mode_map_is_read_for_the_retried_node_by_key(self):
        v = m.c6c_retried_verdicts(self.reading(policies={"/other": "continue_workspace"}))
        self.assertIs(one(v, "names restore_checkpoint for"), False)
        v = m.c6c_retried_verdicts(self.reading(policies={}))
        self.assertIs(one(v, "names restore_checkpoint for"), False,
                      "an EMPTY map is not 'the mode ran' — run.retried carried no policy")

    def test_a_missing_journal_row_is_a_gap_never_an_empty_map(self):
        # pol=None means the SELECT found no run.retried row at all (c6_retry_policies'
        # own contract); reading it as {} would grade the mode claim against nothing.
        v = m.c6c_retried_verdicts(self.reading(policies=None, restore=None))
        self.assertIs(one(v, "journalled run.retried"), False,
                      "the POST was ACCEPTED and runtime/retry.go wrote no journal row — "
                      "that is the product contradicting its own path, not a missing read")
        self.assertIs(one(v, "names restore_checkpoint for"), None)
        self.assertIs(one(v, "names ONLY the node"), None)
        self.assertIn("(no run.retried row)", detail_of(v, "journalled run.retried"))
        v = m.c6c_retried_verdicts(self.reading(status=None, may_post=False,
                                                policies=None, restore=None))
        self.assertIs(one(v, "journalled run.retried"), None,
                      "never posted → nothing was expected in the journal: GAP")

    def test_no_retry_work_means_no_pair(self):
        v = m.c6c_retried_verdicts(self.reading(status=409,
                                                body='{"code":"checkpoint_unavailable"}',
                                                policies={}, restore=None))
        self.assertIs(one(v, "the pair of events"), None)

    def test_the_seed_losing_its_solo_row_is_a_fail(self):
        v = m.c6c_retried_verdicts(self.reading(
            policies={"/" + m.C6C_KILL_NODE: m.C6_RESTORE_POLICY,
                      "/" + m.C5E_SEED_NODE: "restore_checkpoint"}))
        self.assertIs(one(v, "names ONLY the node"), False)

    def test_a_run_that_completed_without_the_reset_is_the_mode_not_being_implemented(self):
        v = m.c6c_retried_verdicts(self.reading(restore=None))
        self.assertIs(one(v, "the pair of events"), False,
                      "the retry was accepted and the run closed, yet nothing reset the "
                      "workspace — restore_checkpoint silently continuing instead is the "
                      "product gap the row exists to catch")
        self.assertIn("restore_checkpoint", detail_of(v, "the pair of events")
                      if hasattr(self, "detail_of") else str(v))

    def test_an_unclosed_run_GAPs_the_pair_and_the_completion(self):
        v = m.c6c_retried_verdicts(self.reading(restore=None, final_st="running"))
        self.assertIs(one(v, "the pair of events"), None,
                      "the reset is a worker-side act pinned to the volume's owner; an "
                      "attempt not yet claimed says nothing about the mode")
        self.assertIs(one(v, "reached 'completed'"), None)
        self.assertIn("C6e", detail_of(v, "the pair of events")
                      if hasattr(self, "detail_of") else str(v))

    def test_a_terminal_retry_that_did_not_complete_fails_the_completion_row_only(self):
        v = m.c6c_retried_verdicts(self.reading(final_st="failed"))
        self.assertIs(one(v, "reached 'completed'"), False)
        self.assertIs(one(v, "the pair of events"), True,
                      "the reset ran; what killed the retry afterwards is C6e/C9's row")


class C6RetryDoorVerdictsTest(unittest.TestCase):
    """The shipped restore twin answers route 31's RUN-status door, and this leg says so
    under C6's own label instead of borrowing C5e's (live20 printed the same 409 twice)."""

    def rows(self):
        return [{"attempt_number": "1", "status": "interrupted"},
                {"attempt_number": "2", "status": "running"}]

    def test_an_unasked_post_is_a_note_that_names_where_the_journal_lives(self):
        v = m.c6_retry_door_verdicts(None, "", "running", self.rows())
        self.assertIs(v[0][1], m.C5_NOTE, "the ENGINE armed this retry (§ 7.1 C5b); the "
                                          "manual journal is C6c's arm, so this is neither "
                                          "a PASS nor a GAP")
        self.assertTrue(v[0][0].startswith("C6b"),
                        "no C5e-labelled line may come out of the C6 leg again")
        self.assertIn("C6c", v[0][2])

    def test_a_refusal_on_a_retriable_run_is_a_fail(self):
        v = m.c6_retry_door_verdicts(
            409, '{"type":"https://communication.dev/errors/run-not-retriable"}',
            "cancelled", self.rows())
        self.assertIs(v[0][1], False)
        self.assertIn("retriable", v[0][2])

    def test_an_accepted_post_on_the_twin_passes_both_modes_being_live(self):
        v = m.c6_retry_door_verdicts(200, '{"run_id":"r"}', "failed", self.rows())
        self.assertIs(v[0][1], True)

    def test_a_refusal_the_door_is_entitled_to_gives_no_verdict_of_its_own(self):
        v = m.c6_retry_door_verdicts(409, '{"code":"run_not_retriable"}', "running",
                                     self.rows())
        self.assertIs(v[0][1], m.C5_NOTE)
        v = m.c6_retry_door_verdicts(500, "boom", "running", self.rows())
        self.assertIs(v[0][1], m.C5_NOTE, "an unrecognised answer on a run the door may "
                                          "refuse is reported, not sorted into a verdict")
        v = m.c6_retry_door_verdicts(500, "boom", "failed", self.rows())
        self.assertIs(v[0][1], None, "a 500 on a run route 31 admits is the arm's own "
                                     "failure to measure: GAP, never PASS")


class C6cModeArmNoteInFinalVerdictsTest(unittest.TestCase):
    """The mode arm's NOTE-vs-GAP rule: a claim measured on the manual retry is a NOTE on
    the twin; one measured NOWHERE stays the GAP it always was."""

    keys = {"/plan", "/approve", "/build_until_verified[1]/implement"}

    def test_graded_elsewhere_is_a_note(self):
        v = m.c6_final_verdicts("completed", {"policies": None}, self.keys, self.keys,
                               manual_graded=True)
        label, ok, why = next((l, o, d) for l, o, d in v if "workspace_policies" in l)
        self.assertIs(ok, m.C5_NOTE)
        self.assertIn("RUN-status door", why)
        self.assertIn("c6c_retried_verdicts", why,
                      "the NOTE must point at where the row was measured")

    def test_unmeasured_stays_a_gap_that_blames_itself(self):
        v = m.c6_final_verdicts("completed", {"policies": None}, self.keys, self.keys)
        _label, ok, why = next((l, o, d) for l, o, d in v if "workspace_policies" in l)
        self.assertIsNone(ok)
        self.assertIn("c5e_retry_door_arm", why, "the GAP now names the arm that should "
                                                 "have measured it, so a reader can see "
                                                 "this is the driver's subject, not a "
                                                 "product refusal to retry")
        self.assertIn("absent row as an empty map", why)

    def test_a_run_retried_row_on_the_twin_is_still_graded_in_place(self):
        v = m.c6_final_verdicts(
            "completed",
            {"policies": {"/build_until_verified[1]/implement": m.C6_RESTORE_POLICY}},
            self.keys, self.keys, manual_graded=True)
        self.assertIs(one(v, "workspace_policies names"), True)

    def test_the_note_never_enters_the_ledger_as_a_pass(self):
        del m.FAILURES[:], m.GAPS[:]
        v = m.c6_final_verdicts("completed", {"policies": None}, self.keys, self.keys,
                               manual_graded=True)
        m.c5_emit(v)
        self.assertEqual(m.FAILURES, [])
        self.assertEqual(m.GAPS, [], "a NOTE is printed, not recorded: the row's verdict "
                                     "lives in c6c_retried_verdicts")


class C6cArmSequencingTest(unittest.TestCase):
    """Sequence pins: no POST at a closed door, the accepted-restore arm graded BEFORE the
    leg's final verdicts, and nothing left dead behind it."""

    def test_c6_asks_the_door_only_when_the_run_is_retriable(self):
        src = driver_fn_src("c6")
        ask = src.index('retry", {"reason": "restore"}')
        gate = src.index("if c6_run_is_retriable(run_st6):")
        self.assertLess(gate, ask)
        self.assertLess(src.index("manual6, manual6_body = None"), ask)

    def test_the_restore_arm_is_graded_before_the_final_verdicts(self):
        src = driver_fn_src("c6")
        arm = src.index('c5e_retry_door_arm(alice, facts, twin, "C6c"')
        self.assertLess(arm, src.index("c6_final_verdicts("),
                        "c6_final_verdicts' mode arm reads the arm's outcome")
        self.assertIn("policy=C6_RESTORE_POLICY", src[arm:arm + 400])
        self.assertIn("seed_step=C5E_SEED_STEP", src[arm:arm + 400],
                      "the committed boundary is the accept arm's precondition")
        self.assertIn("manual_graded=", src[src.index("c6_final_verdicts("):])
        self.assertIn("c5_emit(c6_final_verdicts(", src,
                      "c6_emit would print the mode arm's NOTE as a PASS")

    def test_the_arm_itself_reuses_the_c6d_instrument_helpers(self):
        src = driver_fn_src("c5e_retry_door_arm") + driver_fn_src("_c5e_kill_and_retry")
        for helper in ("c6_worktree_read(", "c6_ckpts(", "c6_retry_policies(",
                       "c6_restore_event(", "_c6d_wait_retriable(", "wait_worker_row("):
            self.assertIn(helper, src, f"{helper} — the C6d fix's readers, reused")




class C6cRestoreArmDryRunTest(unittest.TestCase):
    """EXECUTE the accepted-restore arm offline against the same mocked lab: with the
    edit-free seed the CHECKPOINT door opens, run.retried names restore_checkpoint for
    the node the retry re-queued, and the pair of events lands in one journal. The
    sabotage case is the destructive one: an UNCOMMITTED seed boundary must stop the POST
    entirely, because a retry accepted there would reset work C6d says nothing may touch."""

    KEY = "/" + m.C6C_KILL_NODE

    def setUp(self):
        self.log = []
        self.saved = {}
        self.seed_committed = "true"
        self.restored = True

    def tearDown(self):
        for name, value in self.saved.items():
            setattr(m, name, value)
        self.saved.clear()
        del m.FAILURES[:], m.GAPS[:]

    def patch(self, name, value):
        self.saved.setdefault(name, getattr(m, name))
        setattr(m, name, value)

    def fake_psql(self, sql, *a, **kw):
        if "FROM runs WHERE id" in sql:
            return f"failed|node_execution_failed:{self.KEY}"
        if "FROM run_checkpoints c" in sql:
            return "\n".join([
                f"ne-1@@/{m.C5E_SEED_NODE}@@vol-a@@ws-1@@worker-a@@{self.seed_committed}"
                f"@@{'0' if self.seed_committed == 'true' else '1'}@@{BOUNDARY}",
                f"ne-2@@{self.KEY}@@vol-a@@ws-1@@worker-a@@true@@0@@{BOUNDARY}"])
        if "a.attempt_number::text || chr(9)" in sql:
            if f"'{self.KEY}'" in sql:
                ctx = json.dumps({"attempt": 1, "error_class": "interrupted",
                                  "head_commit": BOUNDARY, "modified_path_count": 0})
                return "\n".join([
                    "1\tinterrupted\tinterrupted\t-\t2026-02-20 10:00:00+00",
                    f"2\trunning\t-\t{ctx}\t2026-02-20 10:04:00+00"])
            return "1\tsucceeded\t-\t-\t2026-02-20 09:50:00+00"
        if "count(DISTINCT ne.id)" in sql:
            return f"/{m.C5E_SEED_NODE}|1|1\n{self.KEY}|1|2"
        if "workspace_policies" in sql:
            return json.dumps({self.KEY: m.C6_RESTORE_POLICY})
        if "run.checkpoint_restored" in sql:
            if not self.restored:
                return ""
            payload = json.dumps({"node_instance_key": self.KEY,
                                  "from_commit": BOUNDARY, "discarded_paths": []})
            return f"{self.KEY}@@{payload}"
        raise AssertionError(f"unmocked psql read: {sql[:90]}")

    def run_arm(self, seed_committed="true", restored=True):
        self.seed_committed, self.restored = seed_committed, restored
        for name, value in (("psql", self.fake_psql),
                            ("wait_live_past_gate", lambda *a, **kw: {
                                "id": "att-9", "worker": "worker-b", "key": self.KEY}),
                            ("c4_worker_service", lambda w: "worker-b"),
                            ("c6_worktree_read", lambda rid, svc: (BOUNDARY, "0")),
                            ("wait_worker_row", lambda svc, t: True),
                            ("C5_KILL_WAIT_S", 0),
                            ("hold_window", lambda sec: 1),
                            ("_c6d_wait_retriable", lambda rid, cap=None: "failed"),
                            ("watch_run", lambda *a, **kw: ("completed", None)),
                            ("run_status", lambda rid: "completed")):
            self.patch(name, value)

        def _run(cmd, *a, **kw):
            self.log.append((cmd[3] if len(cmd) > 3 else "?", cmd[-1]))
            return 0, "mocked"

        self.patch("run", _run)

        class Resp:
            def __init__(self, status, text):
                self.status, self.text = status, text
                self.headers = {}

            def json(self):
                return json.loads(self.text)

        class Fake:
            def __init__(self, log):
                self.log = log

            def post(self, base, path, body=None):
                self.log.append(("post", path, body))
                return Resp(200, '{"run_id":"run-c"}')

            def get(self, base, path):
                return Resp(200, "{}")

        return m._c5e_kill_and_retry(Fake(self.log), {"project_id": "p"}, {}, "run-c",
                                     "C6c", m.C6_RESTORE_POLICY, m.C5E_SEED_STEP,
                                     m.C6C_KILL_NODE, grade=m.c6c_retried_verdicts)

    def capture(self, fn):
        buf, old = io.StringIO(), sys.stdout
        sys.stdout = buf
        try:
            res = fn()
        finally:
            sys.stdout = old
        return res, buf.getvalue()

    def test_the_accepted_restore_grades_the_mode_from_the_journal(self):
        (out, printed), _ = self.capture(lambda: self.run_arm()), None
        self.assertTrue(out["may_post"], printed[-500:])
        self.assertEqual(out["status"], 200)
        self.assertEqual(out["policies"], {self.KEY: m.C6_RESTORE_POLICY})
        self.assertEqual(out["restore"]["key"], self.KEY)
        self.assertEqual(m.FAILURES, [], "\n".join(m.FAILURES) + "\n" + printed[-600:])
        self.assertEqual(m.GAPS, [], "\n".join(m.GAPS) + "\n" + printed[-600:])
        self.assertIn(f"workspace_policies names {m.C6_RESTORE_POLICY}", printed)
        self.assertIn("the pair of events is journalled", printed)
        self.assertIn("PASS", printed)

    def test_a_dirty_seed_boundary_stops_the_post_before_the_door(self):
        # C6d's state on C6c's instrument: the CHECKPOINT door would refuse (and if the
        # engine ever accepted it, it would reset the uncommitted work C6d protects), so
        # the arm must not ask at all.
        (out, printed), _ = self.capture(lambda: self.run_arm(seed_committed="false")), None
        self.assertFalse(out["may_post"])
        self.assertIsNone(out["status"])
        self.assertNotIn("post", [k[0] for k in out and self.log if k[0] == "post"
                                  and str(k[1]).endswith("/retry")])
        self.assertIn("NOT posted", printed)
        # The ONE failure is the arm's own premise: m4-exit.sh documents leave_dirty=0 as
        # "writes nothing, stdout byte-for-byte unchanged", and the seed runs the EDIT-FREE
        # plan step, so a boundary recorded uncommitted is the lab contradicting the
        # contract (same reading c6d_precondition_verdicts gives a completed run). The
        # row's own claims stay GAPs — nothing was asked of the route.
        self.assertEqual([f for f in m.FAILURES if "COMMITTED" in f], m.FAILURES,
                         "\n".join(m.FAILURES))
        self.assertTrue(any("run.retried" in g for g in m.GAPS), m.GAPS)
        self.assertFalse(any("posts exactly this" in g for g in m.GAPS + m.FAILURES),
                         "the POST never happened, so its row must not be judged")

    def test_a_reset_that_never_landed_GAPs_the_pair_and_says_whose_row_it_becomes(self):
        (out, printed), _ = self.capture(lambda: self.run_arm(restored=False)), None
        self.assertEqual(out["status"], 200)
        self.assertTrue(any("the pair of events" in f for f in m.FAILURES),
                        "accepted, completed, and NOTHING reset: that is the mode not "
                        "being implemented, and it must FAIL rather than quietly GAP"
                        + "\n".join(m.FAILURES))
        self.assertIn("restore_checkpoint retry that silently continues", printed)


if __name__ == "__main__":
    unittest.main(verbosity=2 if "-v" in sys.argv else 1)
