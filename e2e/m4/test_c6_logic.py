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
import os
import re
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import e2e_m4_exit as m  # noqa: E402 — importing the driver is the point


def one(rows, needle):
    vs = [ok for l, ok, _d in rows if needle in l]
    assert len(vs) == 1, f"{needle!r} produced {len(vs)} verdicts: {[l for l, _o, _d in rows]}"
    return vs[0]


REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SEED_YAML = os.path.join(REPO, "docs", "compatibility", "probes", "m4", "pipeline.yaml")

BOUNDARY = "c0ffee" + "1" * 58


def twin_doc():
    """Document #2 of the seed's probe file — the same bytes C6 splices (the live
    gate reads them from GET /revisions/{id}/document?format=yaml)."""
    with open(SEED_YAML, encoding="utf-8") as f:
        raw = f.read()
    docs = [d for d in re.split(r"(?m)^---\s*$", raw) if "kind: Pipeline" in d]
    assert len(docs) >= 2, f"expected >=2 documents in {SEED_YAML}"
    doc = docs[1]
    return doc if "apiVersion:" in doc[:600] else ("apiVersion: v1alpha1\n" + doc)


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

    def test_refuses_a_doc_that_already_declares_the_policy(self):
        res = m.c6_restore_doc(twin_doc() + f"workspacePolicy: {m.C6_RESTORE_POLICY}\n", "x")
        self.assertIsNone(res["doc"])
        self.assertIn(False, [ok for _l, ok, _d in m.c6_doc_verdicts(res)],
                      "a seed that already restores must not read as C6a")

    def test_refuses_a_non_pipeline_document(self):
        res = m.c6_restore_doc("kind: NotAPipeline\n", "x")
        self.assertIsNone(res["doc"])
        self.assertIn(False, [ok for _l, ok, _d in m.c6_doc_verdicts(res)])

    def test_refuses_a_doc_without_the_implement_retry_block(self):
        doc = "\n".join(l for l in twin_doc().splitlines() if "retriableErrors" not in l)
        res = m.c6_restore_doc(doc, "x")
        self.assertIsNone(res["doc"], "no retry anchor => no honest splice")


class C6dAvailability(unittest.TestCase):
    def test_reader_parses_the_canned_boundary_row(self):
        rows = m.c6_ckpts(ckpt())
        self.assertEqual(["/plan"], [r["node"] for r in rows])
        self.assertEqual([True], [r["committed"] for r in rows])
        self.assertEqual(["repos-a"], [r["volume_id"] for r in rows])

    def test_dirty_boundary_arm_exists(self):
        v = m.c6_avail_verdicts(m.c6_ckpts(ckpt(committed="false", mpc="3")))
        self.assertIs(True, one(v, "uncommitted"))

    def test_committed_only_boundary_is_a_gap(self):
        v = m.c6_avail_verdicts(m.c6_ckpts(ckpt(committed="true", mpc="0")))
        self.assertIs(None, one(v, "uncommitted"))

    def test_unreadable_committed_flag_is_a_gap(self):
        v = m.c6_avail_verdicts(m.c6_ckpts(ckpt(committed="-", mpc="-")))
        self.assertIs(None, one(v, "uncommitted"))


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


class C6bRestored(unittest.TestCase):
    def test_full_restore_passes(self):
        cks = m.c6_ckpts(ckpt())
        v = m.c6_restored_verdicts(restored_ev(), cks, BOUNDARY, BOUNDARY, "0", 2)
        self.assertNotIn(False, [ok for _l, ok, _d in v], f"a real restore must PASS: {v}")

    def test_missing_event_is_a_gap(self):
        v = m.c6_restored_verdicts(None, m.c6_ckpts(ckpt()), BOUNDARY, BOUNDARY, "0", 2)
        self.assertTrue(all(ok is None for _l, ok, _d in v), f"no event => GAP: {v}")

    def test_uncompiled_policy_is_a_gap(self):
        v = m.c6_restored_verdicts(restored_ev(), [], BOUNDARY, BOUNDARY, "0", 2,
                                   policy_in_plan=False)
        self.assertTrue(all(ok is None for _l, ok, _d in v), f"no plan => GAP: {v}")

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
        self.assertIs(False, one(v, "key set equals C1"))

    def test_missing_c1_set_is_a_fail_not_an_invention(self):
        v = m.c6_final_verdicts("completed", {"policies": {}}, set(), {"/plan"})
        self.assertIs(False, one(v, "key set equals C1"))


if __name__ == "__main__":
    unittest.main(verbosity=2 if "-v" in sys.argv else 1)
