#!/usr/bin/env python3
"""test_cdiag_logic.py — offline unit proof for the failed-attempt evidence dump.

When a gate observes a run that did not complete, the harness must print the
attempt's full death certificate (node_instance_key, attempt_number, status,
error_class, detail, output_errors) plus the transport's last words
(agent.session.disconnected reason/detail/stderr_tail) and the last agent
message. This tests the PURE renderers of those reads against canned bodies —
a green here means the LOGIC is right; it never substitutes for a live gate.

usage: python3 e2e/m4/test_cdiag_logic.py [-v]
"""
import json
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import e2e_m4_exit as m  # noqa: E402 — importing the driver is the point


def node_detail(**breaks):
    """A GET /runs/{id}/nodes/{ne} body shaped like api/openapi.yaml's
    NodeExecutionDetail, with surgical mutations."""
    doc = {
        "id": "2da517cd-985b-581f-a687-e750992e1513",
        "run_id": "01a17cbc-92f3-717d-b713-a2a19ed21775",
        "node_instance_key": "/build_until_verified[1]/implement",
        "kind": "agent.acp",
        "status": "failed",
        "attempt_count": 1,
        "attempts": [
            {
                "id": "ee7b7284-e929-5266-8fe7-b0a25b540967",
                "attempt_number": 1,
                "status": "failed",
                "error_class": "infra",
                "detail": ("agent session disconnected before the turn ended "
                           "(agent_process_exited: exit status 1)"),
                "output_errors": [],
            },
            {
                "id": "e7064500-f2ce-5fee-b494-dd0370793e09",
                "attempt_number": 2,
                "status": "succeeded",
                "error_class": None,
                "detail": None,
                "output_errors": [],
            },
        ],
    }
    doc.update(breaks)
    return doc


class EvidenceField(unittest.TestCase):
    def test_none_is_dash(self):
        self.assertEqual(m.evidence_field(None), "-")

    def test_string_collapses_whitespace(self):
        self.assertEqual(m.evidence_field("a\n b\t c"), "a b c")

    def test_structures_are_compact_json(self):
        self.assertEqual(m.evidence_field([{"code": "x", "message": "y"}]),
                         '[{"code":"x","message":"y"}]')

    def test_long_field_is_clipped_with_visible_marker(self):
        s = m.evidence_field("z" * (m.ATTEMPT_EVIDENCE_FIELD_CHARS + 50))
        self.assertTrue(s.endswith("…"))
        self.assertEqual(len(s), m.ATTEMPT_EVIDENCE_FIELD_CHARS + 1)

    def test_always_single_line(self):
        s = m.evidence_field('line1\nline2\r\nline3\u2028unicode')
        self.assertNotIn("\n", s)
        self.assertNotIn("\r", s)


class AttemptFailureLines(unittest.TestCase):
    def test_only_failed_and_interrupted_attempts_are_certificates(self):
        lines = m.attempt_failure_lines(node_detail())
        self.assertEqual(len(lines), 1)
        self.assertIn("ee7b7284-e929-5266-8fe7-b0a25b540967", lines[0])
        self.assertNotIn("e7064500", "".join(lines))

    def test_line_carries_every_required_column(self):
        line = m.attempt_failure_lines(node_detail())[0]
        for needle in ("attempt ee7b7284-e929-5266-8fe7-b0a25b540967",
                       "[/build_until_verified[1]/implement]", "#1",
                       "status=failed", "error_class=infra",
                       "agent_process_exited", "output_errors=[]"):
            self.assertIn(needle, line, line)

    def test_interrupted_counts(self):
        doc = node_detail(attempts=[{
            "id": "a-1", "attempt_number": 3, "status": "interrupted",
            "error_class": "interrupted", "detail": "worker_shutdown",
            "output_errors": None}])
        lines = m.attempt_failure_lines(doc)
        self.assertEqual(len(lines), 1)
        self.assertIn("status=interrupted", lines[0])
        self.assertIn("detail=worker_shutdown", lines[0])

    def test_invalid_output_evidence_is_printed(self):
        errs = [{"code": "schema", "instancePath": "/summary",
                 "message": "is required"}]
        doc = node_detail(attempts=[{
            "id": "a-9", "attempt_number": 1, "status": "failed",
            "error_class": "invalid_output", "detail": "no JSON object found",
            "output_errors": errs}])
        line = m.attempt_failure_lines(doc)[0]
        self.assertIn("error_class=invalid_output", line)
        self.assertIn('"instancePath":"/summary"', line)

    def test_multiline_detail_stays_one_line(self):
        doc = node_detail(attempts=[{
            "id": "a-1", "attempt_number": 1, "status": "failed",
            "error_class": "infra",
            "detail": "line one\nline two\ttabbed", "output_errors": []}])
        lines = m.attempt_failure_lines(doc)
        self.assertEqual(len(lines), 1)
        self.assertIn("detail=line one line two tabbed", lines[0])

    def test_unreadable_bodies_yield_nothing(self):
        for bad in (None, [], "text", {}, {"attempts": "not-a-list"},
                    {"attempts": [None, "x", {"status": "queued"}]}):
            self.assertEqual(m.attempt_failure_lines(bad), [])


class LedgerAttemptFallback(unittest.TestCase):
    def _row(self, key="#1/implement", n=1, status="failed", eclass="infra",
             detail="d", oerrs=[]):
        return json.dumps([key, n, status, eclass, detail, oerrs])

    def test_parses_one_line_per_row(self):
        text = self._row() + "\n" + self._row(n=2, status="interrupted",
                                              eclass=None, detail=None)
        lines = m.ledger_attempt_failure_lines(text)
        self.assertEqual(len(lines), 2)
        self.assertIn("[#1/implement] #1 status=failed error_class=infra", lines[0])
        self.assertIn("#2 status=interrupted error_class=- detail=-", lines[1])

    def test_output_errors_render_as_json(self):
        lines = m.ledger_attempt_failure_lines(
            self._row(oerrs=[{"code": "outputs_too_large"}]))
        self.assertIn('output_errors=[{"code":"outputs_too_large"}]', lines[0])

    def test_unparsable_line_is_reported_not_dropped(self):
        lines = m.ledger_attempt_failure_lines("not json\n" + self._row())
        self.assertEqual(len(lines), 2)
        self.assertTrue(lines[0].startswith("(unparsed attempt row:"))

    def test_empty_input(self):
        self.assertEqual(m.ledger_attempt_failure_lines(""), [])
        self.assertEqual(m.ledger_attempt_failure_lines(None), [])


class AgentDeathLines(unittest.TestCase):
    def _row(self, seq=383, reason="agent_process_exited", detail="exit status 1",
             stderr="Error: gateway 502", attempt="ee7b7284"):
        return json.dumps([seq, reason, detail, stderr, attempt])

    def test_fields_and_nulls(self):
        lines = m.agent_death_lines(self._row())
        self.assertEqual(len(lines), 1)
        for needle in ("seq=383", "attempt=ee7b7284", "reason=agent_process_exited",
                       "detail=exit status 1", "stderr_tail=Error: gateway 502"):
            self.assertIn(needle, lines[0])
        lines = m.agent_death_lines(json.dumps([9, "process_exited", None, None, None]))
        self.assertEqual(
            lines[0], "seq=9 attempt=- reason=process_exited detail=- stderr_tail=-")

    def test_unparsable_reported(self):
        lines = m.agent_death_lines("garbage")
        self.assertEqual(len(lines), 1)
        self.assertTrue(lines[0].startswith("(unparsed disconnect row:"))

    def test_empty(self):
        self.assertEqual(m.agent_death_lines(""), [])


class AgentMessageTail(unittest.TestCase):
    def test_limit_and_clip(self):
        text = "\n".join(json.dumps([400 - i, f"msg {i}\nwrapped"]) for i in range(4))
        lines = m.agent_message_tail_lines(text, limit=2, clip=20)
        self.assertEqual(len(lines), 2)
        self.assertEqual(lines[0], "seq=400 text=msg 0 wrapped")

    def test_clip_marks_truncation(self):
        text = json.dumps([7, "x" * 100])
        lines = m.agent_message_tail_lines(text, limit=2, clip=10)
        self.assertEqual(lines[0], "seq=7 text=" + "x" * 10 + "…")

    def test_null_text_and_unparsable(self):
        lines = m.agent_message_tail_lines(json.dumps([5, None]) + "\nzzz")
        self.assertEqual(lines[0], "seq=5 text=-")
        self.assertTrue(lines[1].startswith("(unparsed message row:"))

    def test_empty(self):
        self.assertEqual(m.agent_message_tail_lines(""), [])


class DumpWiring(unittest.TestCase):
    """dump_failed_attempts must survive a dead API and a dead psql without
    raising — the dump runs inside the failure path itself."""

    class Boom:
        def get(self, *a, **k):
            raise OSError("connection refused")

    def test_dead_client_and_dead_psql_do_not_raise(self):
        import unittest.mock as mock
        with mock.patch.object(m, "psql", side_effect=RuntimeError("psql down")), \
                mock.patch.object(m, "show"):
            m.dump_failed_attempts(self.Boom(), "run-1")

    class Dead403:
        class R:
            status, text = 403, "forbidden"

        def get(self, *a, **k):
            return Dead403.R()

    def test_unauthorized_nodes_route_falls_back_to_the_ledger(self):
        import unittest.mock as mock
        shown = []
        row = json.dumps(["/implement", 1, "failed", "infra", "d", []])
        calls = []

        def fake_psql(sql):
            calls.append(sql)
            return row if "FROM attempts" in sql else ""
        with mock.patch.object(m, "psql", side_effect=fake_psql), \
                mock.patch.object(m, "show",
                                  side_effect=lambda label, out: shown.append(label)):
            m.dump_failed_attempts(self.Dead403(), "run-1")
        self.assertTrue(any("ledger fallback" in s for s in shown),
                        f"a non-200 nodes route must not hide the dump: {shown}")
        self.assertTrue(any("FROM attempts" in c for c in calls))

    def test_client_none_uses_ledger_fallback(self):
        import unittest.mock as mock
        shown = []
        row = json.dumps(["/implement", 1, "failed", "infra", "d", []])
        with mock.patch.object(m, "psql", return_value=row) as p, \
                mock.patch.object(m, "show",
                                  side_effect=lambda label, out: shown.append(label)):
            m.dump_failed_attempts(None, "run-1")
        self.assertTrue(any("ledger fallback" in s for s in shown), shown)
        self.assertTrue(any("agent.session.disconnected" in s for s in shown), shown)
        self.assertTrue(any("last agent message" in s for s in shown), shown)
        self.assertTrue(p.called)


if __name__ == "__main__":
    unittest.main()
