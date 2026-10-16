#!/usr/bin/env python3
"""test_throwaway_launch_logic.py - offline proof that the throwaway worker-c
started for C6e/W6 gets its OWN /workspaces root.

Live evidence this guards (volume-identity): worker-c measured the SAME
volume_id as worker-a, making the cross-volume loss case (C6e, W6)
untestable — the engine saw "same volume" and reclaimed instead of refusing.
Root cause: start_throwaway mounted WS_BIND (.harness/workspaces) at
/workspaces, the very host directory compose.m4.yml gives worker-a at the
same container path, and ADR-0017 D2 hashes (st_dev, st_ino, path) — the same
directory at the same path is the same volume BY DEFINITION. The engine's
reclaim comparison runs on the WORKSPACES root (cmd/communication/worker.go
measures wsVol and passes wsVol.ID to RunWorkspaces.Prepare; internal/store/
postgres/run_workspace.go refuses only when the measured id differs), so a
throwaway OWNED REPOS volume alone could never produce volume_changed.

Every test here fakes m.run: no daemon, no container touched.

usage: python3 e2e/m4/test_throwaway_launch_logic.py [-v]
"""
import os
import re
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import e2e_m4_exit as m  # noqa: E402 — importing the driver is the point

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


class FakeRun:
    """Stand in for m.run: records every argv and answers rc=0."""

    def __init__(self):
        self.calls = []

    def __call__(self, cmd, **kw):
        argv = [str(c) for c in cmd]
        self.calls.append(argv)
        return 0, "ok"


def mounts_of(docker_run_argv):
    """{-v source: container path} for one `docker run` argv."""
    out = {}
    a = docker_run_argv
    for i, tok in enumerate(a):
        if tok == "-v" and i + 1 < len(a):
            src, _, dst = a[i + 1].rpartition(":")
            out[dst] = src
    return out


class ThrowawayLaunchTest(unittest.TestCase):
    def setUp(self):
        self.real_run, self.f = m.run, FakeRun()
        m.run = self.f
        m.FAILURES.clear()
        m.GAPS.clear()

    def tearDown(self):
        m.run = self.real_run

    def _launch(self, **kw):
        m.start_throwaway("worker-c-test", "required", **kw)
        runs = [c for c in self.f.calls if c[:3] == ["docker", "run", "-d"]]
        self.assertEqual(len(runs), 1, "exactly one docker run per throwaway")
        return mounts_of(runs[0])

    def test_workspaces_root_is_not_the_shared_bind(self):
        """The bug: /workspaces was WS_BIND — worker-a's own host directory."""
        mts = self._launch(repos_volume=True)
        self.assertIn("/workspaces", mts)
        self.assertNotEqual(os.path.realpath(mts["/workspaces"]),
                            os.path.realpath(m.WS_BIND),
                            "worker-c shares worker-a's workspaces storage -> "
                            "identical (st_dev, st_ino, path) -> identical "
                            "volume_id -> C6e/W6 cannot measure volume_changed")
        self.assertNotEqual(mts["/workspaces"], m.WS_BIND)

    def test_workspaces_root_is_unique_per_throwaway_name(self):
        mts_one = self._launch(repos_volume=True)  # launched as worker-c-test
        self.assertEqual(mts_one["/workspaces"],
                         os.path.join(m.SCRATCH, "worker-c-test", "workspaces"))
        self.f.calls.clear()
        m.start_throwaway("worker-c-other", "required", repos_volume=True)
        runs = [c for c in self.f.calls if c[:3] == ["docker", "run", "-d"]]
        mts_other = mounts_of(runs[-1])
        self.assertNotEqual(mts_one["/workspaces"], mts_other["/workspaces"],
                            "two throwaways must not share one workspaces root")

    def test_workspaces_bind_lives_under_the_throwaway_scratch(self):
        mts = self._launch(repos_volume=True)
        self.assertTrue(mts["/workspaces"].startswith(os.path.join(m.SCRATCH,
                                                                   "worker-c-test")),
                        f"own scratch root expected, got {mts['/workspaces']!r}")
        self.assertFalse(mts["/workspaces"].startswith(("/tmp", "/var/tmp",
                                                        "/dev/shm")),
                         "ADR-0017 D5: workspace roots live outside the temp tree")

    def test_repos_volume_unchanged_for_loss_arm(self):
        mts = self._launch(repos_volume=True)
        self.assertEqual(mts["/repos"], "communication-m4-worker-c-test-repos")
        self.assertTrue(any(c[:3] == ["docker", "volume", "create"]
                            for c in self.f.calls))

    def test_compose_worker_a_workspaces_bind_differs(self):
        """Static proof against the compose file: worker-a's host source for
        /workspaces must not be the throwaway's scratch bind."""
        text = open(os.path.join(REPO, "compose.m4.yml")).read()
        mts = self._launch(repos_volume=True)
        wa = re.search(r"worker-a:.*?volumes:(.*?)\n(?:    env|  [a-z])", text,
                       re.S)
        self.assertIsNotNone(wa, "worker-a volumes block found in compose.m4.yml")
        srcs = [ln.strip().split(":")[0] for ln in wa.group(1).splitlines()
                if ":/workspaces" in ln]
        self.assertTrue(srcs, "compose.m4.yml gives worker-a a /workspaces mount")
        wa_host = os.path.realpath(os.path.join(REPO, srcs[0]))
        self.assertNotEqual(os.path.realpath(mts["/workspaces"]), wa_host,
                            "the throwaway must measure a DIFFERENT workspaces "
                            "root than worker-a (ADR-0017 D2)")

    def test_launch_recorded_no_failure(self):
        self._launch(repos_volume=True)
        self.assertEqual(m.FAILURES, [], "the faked launch must pass its own check")


if __name__ == "__main__":
    unittest.main(verbosity=2)
