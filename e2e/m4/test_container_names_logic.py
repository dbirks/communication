#!/usr/bin/env python3
"""test_container_names_logic.py - offline proof that e2e_m4_exit.py addresses
CONTAINERS, not compose SERVICE names, with raw `docker` calls.

Live evidence this guards (m4-exit C4c/C5b/W5): the real containers of the lab
stack are `communication-m4-worker-a-1` / `communication-m4-worker-b-1`
(`docker ps --filter label=com.docker.compose.project=communication-m4`), while
the driver hard-coded `WORKER_A = "communication-m4-worker-a"` — compose's
PREFIX, not a container. Consequences observed live: C4c's
`docker logs communication-m4-worker-a` matched 0 lines on live9 even though the
worker logs the fence refusal, C5b's `docker kill … rc=1` froze nothing, and W5
reported "no container this leg can prove belongs to communication-m4".

Every test here fakes `docker`/`docker compose` through m.run: no daemon, no
live stack, no container touched.

usage: python3 e2e/m4/test_container_names_logic.py [-v]
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import e2e_m4_exit as m  # noqa: E402 — importing the driver is the point

PROJ = "communication-m4"


class FakeDocker:
    """Stand in for m.run: answers compose `ps -q`, docker inspect/ps/logs/kill/
    exec and records every argv so the test can assert what was addressed."""

    def __init__(self, ps_refs=(), labels=None, names=(), compose_ps_rc=0, ps_rc=0,
                 kill_rc=0, exec_rc=0, logs_rc=0, logs=""):
        self.ps_refs, self.labels, self.names = list(ps_refs), dict(labels or {}), list(names)
        self.compose_ps_rc = compose_ps_rc
        self.ps_rc, self.kill_rc, self.exec_rc, self.logs_rc = ps_rc, kill_rc, exec_rc, logs_rc
        self.logs = logs
        self.calls = []

    def __call__(self, cmd, **kw):
        argv = [str(c) for c in cmd]
        self.calls.append(argv)
        if argv[:3] == ["docker", "compose", "-p"]:
            svc = argv[-1]
            if argv[-3:-1] == ["ps", "-q"]:
                if self.compose_ps_rc or svc == "worker-c" or not self.ps_refs:
                    return 1, f"no such service: {svc}"
                return 0, "\n".join(self.ps_refs)
            return 0, f"compose {' '.join(argv[5:])} ok"
        if argv[:2] == ["docker", "inspect"]:
            ref = argv[-1]
            name = self.labels.get("name:" + ref, f"{PROJ}-{ref}")
            proj = self.labels.get(ref, "")
            return 0, f"{proj}|/{name}"
        if argv[:2] == ["docker", "ps"]:
            return self.ps_rc, "\n".join(self.names)
        if argv[0:2] == ["docker", "logs"]:
            return self.logs_rc, self.logs or f"logs of {argv[2]}"
        if argv[0:2] == ["docker", "kill"]:
            return self.kill_rc, f"killed {argv[-1]}"
        if argv[0:2] == ["docker", "exec"]:
            return self.exec_rc, f"exec in {argv[2]}: {argv[-1]}"
        return 0, ""

    def verbs(self):
        """(verb, container-target) of every raw docker call the driver made."""
        out = []
        for c in self.calls:
            if c[:1] != ["docker"] or len(c) < 3 or c[1] == "compose":
                continue
            out.append((c[1], c[2] if c[1] in ("exec", "logs") else c[-1]))
        return out


A1 = f"{PROJ}-worker-a-1"


def fake_a(**kw):
    """The lab as compose really leaves it: worker-a's one container is
    communication-m4-worker-a-1, reported by `compose ps -q` and by docker ps."""
    kw.setdefault("ps_refs", ["1a2b3c4d5e6f"])
    kw.setdefault("labels", {"1a2b3c4d5e6f": PROJ, "name:1a2b3c4d5e6f": A1, A1: PROJ})
    kw.setdefault("names", ["communication-m4-worker-a-1", "communication-m4-worker-b-1"])
    return FakeDocker(**kw)


class ServiceNames(unittest.TestCase):
    def test_worker_constants_are_services_not_containers(self):
        """WORKER_A/WORKER_B feed compose subcommands; the -1 container is only ever
        obtained from the resolver."""
        self.assertEqual((m.WORKER_A, m.WORKER_B), ("worker-a", "worker-b"))
        self.assertEqual(m.COMPOSE_PROJECT, PROJ)
        self.assertEqual(m.COMPOSE[:3], ["docker", "compose", "-p"])
        self.assertIn(m.COMPOSE[3], (PROJ,))
        for svc in (m.WORKER_A, m.WORKER_B):
            self.assertFalse(svc.startswith(PROJ + "-"), svc)

    def test_c4_worker_service_and_container_prefix_stay_separate(self):
        self.assertEqual(m.c4_worker_service("worker-a"), "worker-a")
        self.assertIsNone(m.c4_worker_service("worker-c"))
        # the throwaway worker-c is a `docker run --name` container: its literal
        # name carries the prefix and it is NOT a compose service.
        self.assertTrue(m.C6_LOSS_WORKER.startswith(PROJ + "-"))
        self.assertIsNone(m.c4_worker_service(m.C6_LOSS_WORKER))


class Resolve(unittest.TestCase):
    def setUp(self):
        self.saved = m.run

    def tearDown(self):
        m.run = self.saved

    def test_compose_ps_ref_resolves_to_the_replica_container(self):
        m.run = fake_a()
        self.assertEqual(m.compose_container("worker-a"), A1)

    def test_service_prefix_alone_is_never_returned(self):
        """`communication-m4-worker-a` (no replica ordinal) is not a container."""
        f = fake_a(names=[f"{PROJ}-worker-a"], ps_refs=[])
        m.run = f
        self.assertEqual(m.compose_container("worker-a"), "")

    def test_foreign_project_container_is_refused(self):
        m.run = fake_a(labels={"1a2b3c4d5e6f": "other-stack",
                               "name:1a2b3c4d5e6f": "other-stack-worker-a-1",
                               "other-stack-worker-a-1": "other-stack"},
                       names=["other-stack-worker-a-1"])
        self.assertEqual(m.compose_container("worker-a"), "")

    def test_two_replicas_resolve_to_nothing_rather_than_a_guess(self):
        m.run = fake_a(ps_refs=["id-a", "id-b"],
                       labels={"id-a": PROJ, "id-b": PROJ,
                               "name:id-a": f"{PROJ}-worker-a-1",
                               "name:id-b": f"{PROJ}-worker-a-2"})
        self.assertEqual(m.compose_container("worker-a"), "")

    def test_falls_back_to_docker_ps_when_compose_cannot_answer(self):
        m.run = fake_a(compose_ps_rc=1)
        self.assertEqual(m.compose_container("worker-a"), A1)

    def test_throwaway_worker_c_is_not_resolvable_as_a_service(self):
        """compose has no worker-c; the resolver must not hand back the throwaway
        container the driver created with `docker run --name`."""
        m.run = fake_a(names=[m.C6_LOSS_WORKER, A1])
        self.assertEqual(m.compose_container("worker-c"), "")


class Verbs(unittest.TestCase):
    def setUp(self):
        self.saved = m.run

    def tearDown(self):
        m.run = self.saved

    def test_kill_targets_the_resolved_container(self):
        m.run = fake_a()
        rc, out, how = m.container_signal(m.C5_STOP_SIGNAL, m.WORKER_A)
        self.assertEqual(rc, 0)
        self.assertEqual(how, f"docker kill -s STOP {A1}")
        self.assertIn(A1, out)
        rc2, _o2, how2 = m.container_signal("KILL", m.WORKER_A)
        self.assertEqual(how2, f"docker kill {A1}", "KILL needs no -s")

    def test_kill_falls_back_to_compose_with_the_service_name(self):
        m.run = fake_a(kill_rc=125)
        rc, out, how = m.container_signal("KILL", m.WORKER_A)
        self.assertEqual(rc, 0, f"{out} {how}")
        self.assertEqual(how, f"docker compose -p {PROJ} kill KILL {m.WORKER_A}")

    def test_logs_targets_the_resolved_container(self):
        m.run = fake_a(logs="worker WARN terminal write rejected: lease lost")
        rc, out, how = m.container_logs(m.WORKER_A)
        self.assertEqual((rc, how), (0, f"docker logs {A1}"))
        self.assertEqual(m.c4_fence_log(out)[0], 1, "the fence refusal line is READ at last")

    def test_exec_targets_the_resolved_container(self):
        m.run = fake_a()
        rc, out = m.wexec("git rev-parse HEAD", worker=m.WORKER_A)
        self.assertEqual(rc, 0)
        self.assertIn(A1, out)

    def test_unresolvable_container_is_never_a_silent_empty_read(self):
        """rc None + how '' is the caller's GAP signal, not a 0-line log."""
        m.run = fake_a(ps_refs=[], ps_rc=1, names=[])
        for got in (m.container_signal("KILL", m.WORKER_A),
                    m.container_logs(m.WORKER_A),
                    m.container_exec(m.WORKER_A, "true")):
            rc, _out, how = got
            self.assertIsNone(rc, got)
            self.assertEqual(how, "", got)

    def test_no_raw_docker_verb_is_aimed_at_a_bare_service(self):
        m.run = fake_a()
        m.container_signal(m.C5_CONT_SIGNAL, m.WORKER_A)
        m.container_logs(m.WORKER_A)
        m.container_exec(m.WORKER_A, "true")
        for verb, target in m.run.verbs():
            if verb in ("kill", "logs", "exec"):
                self.assertEqual(target, A1, f"docker {verb} addressed {target!r}")


class NoStalePrefix(unittest.TestCase):
    """The literals the fix removed must not creep back into raw docker calls."""

    def test_driver_has_no_raw_docker_call_on_a_worker_constant(self):
        src = open(os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                "e2e_m4_exit.py"), encoding="utf-8").read()
        for bad in ('run(["docker", "logs", svc])', 'run(["docker", "kill", svc])',
                    '["docker", "kill", "-s", C5_STOP_SIGNAL, svc]',
                    '["docker", "kill", "-s", C5_CONT_SIGNAL, svc]',
                    '["docker", "exec", worker, "sh"'):
            self.assertNotIn(bad, src, bad)


if __name__ == "__main__":
    unittest.main(verbosity=2)
