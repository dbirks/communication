#!/usr/bin/env python3
"""test_leave_dirty_wrapper.py — run e2e/m4/test_leave_dirty.sh under pytest.

The shell test is the REAL proof that the twin's opt-in `leave_dirty` input leaves
the default fixture output byte-identical (docs/m4-contract.md § 7.1 C6d; README
note 5a): it drives the ACTUAL generated m4-exit.sh, which pytest cannot import.
This wrapper only invokes the shell script and asserts its exit code, so
`python3 -m pytest -q e2e/m4/` runs it too. A green here is a fixture-shape proof,
never the live C6d refusal (a mocked green is not done — 12-test-strategy.md).

usage: python3 e2e/m4/test_leave_dirty_wrapper.py [-v]
"""
import os
import subprocess
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SH = os.path.join(HERE, "test_leave_dirty.sh")


class LeaveDirtyShellTest(unittest.TestCase):
    def test_default_fixture_output_is_unchanged(self):
        self.assertTrue(os.path.exists(SH), f"{SH} must exist")
        r = subprocess.run(["bash", SH], capture_output=True, text=True, timeout=180)
        self.assertEqual(r.returncode, 0,
                         f"test_leave_dirty.sh failed:\nSTDOUT\n{r.stdout}\nSTDERR\n{r.stderr}")


if __name__ == "__main__":
    unittest.main(verbosity=2)
