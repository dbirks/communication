#!/usr/bin/env python3
"""test_assistant_stub.py — offline unit proof for e2e/stubs/assistant_stub.py.

Starts the real ThreadingHTTPServer on a free port in a thread (no stack, no
network beyond loopback) and drives every branch of the contract: the ASR
auth/model/file rules and its counter, the judge's fixed table (read,
navigate, draft_edit, project.create/repo.add, other risky), its down state,
the /control/judge switch, /control/stats, and /healthz. Stdlib unittest only.

usage: python3 -m unittest e2e/stubs/test_assistant_stub.py
"""
import http.client
import json
import os
import sys
import threading
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import assistant_stub  # noqa: E402


def multipart_body(boundary, parts):
    """parts: list of (name, filename_or_None, bytes)."""
    chunks = []
    for name, filename, value in parts:
        disposition = 'form-data; name="%s"' % name
        if filename is not None:
            disposition += '; filename="%s"' % filename
        chunks.append(
            ("--%s\r\nContent-Disposition: %s\r\n\r\n" % (boundary, disposition)).encode()
            + value
            + b"\r\n"
        )
    chunks.append(("--%s--\r\n" % boundary).encode())
    return b"".join(chunks)


class StubTestCase(unittest.TestCase):
    def setUp(self):
        self.state = assistant_stub.StubState(speech_model="qwen3-asr-stub")
        self.server = assistant_stub.make_server(state=self.state, host="127.0.0.1", port=0)
        self.thread = threading.Thread(
            target=lambda: self.server.serve_forever(poll_interval=0.05), daemon=True)
        self.thread.start()
        self.addCleanup(self._stop)
        self.port = self.server.server_address[1]

    def _stop(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)
        self.assertFalse(self.thread.is_alive(), "stub server thread did not stop")

    def _request(self, method, path, body=None, headers=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        try:
            conn.request(method, path, body=body, headers=headers or {})
            resp = conn.getresponse()
            payload = resp.read()
            return resp.status, payload
        finally:
            conn.close()

    def _json(self, method, path, obj=None, headers=None):
        body = json.dumps(obj).encode() if obj is not None else None
        hdrs = {"Content-Type": "application/json"}
        hdrs.update(headers or {})
        status, payload = self._request(method, path, body=body, headers=hdrs)
        return status, json.loads(payload) if payload else None

    def _transcribe(self, parts=None, boundary="B", auth="Bearer stub-key", content_type=None):
        if parts is None:
            parts = [
                ("model", None, b"qwen3-asr-stub"),
                ("file", "audio.webm", b"\x1a\x45\xdf\xa3fake-audio"),
            ]
        body = multipart_body(boundary, parts)
        if content_type is None:
            content_type = "multipart/form-data; boundary=%s" % boundary
        hdrs = {"Content-Type": content_type, "Content-Length": str(len(body))}
        if auth is not None:
            hdrs["Authorization"] = auth
        return self._request("POST", "/v1/audio/transcriptions", body=body, headers=hdrs)

    def _judge(self, call):
        envelope = {
            "model": "judge-stub",
            "temperature": 0,
            "messages": [
                {"role": "system", "content": "fixed system prompt"},
                {"role": "user", "content": json.dumps(call)},
            ],
        }
        return self._json("POST", "/v1/chat/completions", envelope,
                          headers={"Authorization": "Bearer stub-key"})

    def _verdict(self, call):
        status, reply = self._judge(call)
        self.assertEqual(status, 200)
        choice = reply["choices"][0]
        self.assertEqual(choice["finish_reason"], "stop")
        self.assertEqual(choice["index"], 0)
        self.assertEqual(choice["message"]["role"], "assistant")
        verdict = json.loads(choice["message"]["content"])
        self.assertEqual(set(verdict), {"decision", "reason"})
        return verdict


class HealthAndUnknown(StubTestCase):
    def test_healthz(self):
        status, payload = self._request("GET", "/healthz")
        self.assertEqual(status, 200)
        self.assertTrue(payload)

    def test_unknown_paths_are_404(self):
        self.assertEqual(self._request("GET", "/v1/nope")[0], 404)
        self.assertEqual(self._request("POST", "/v1/nope")[0], 404)


class Transcription(StubTestCase):
    def test_happy_path_answers_fixed_text_and_counts(self):
        status, payload = self._json("GET", "/control/stats")
        self.assertEqual(payload["transcriptions"], 0)
        status, body = self._transcribe()
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body), {"text": "what workflows do I have"})
        _, payload = self._json("GET", "/control/stats")
        self.assertEqual(payload["transcriptions"], 1)

    def test_missing_authorization_is_401(self):
        status, _ = self._transcribe(auth=None)
        self.assertEqual(status, 401)

    def test_wrong_key_is_401(self):
        status, _ = self._transcribe(auth="Bearer other-key")
        self.assertEqual(status, 401)

    def test_empty_file_is_400(self):
        status, _ = self._transcribe(parts=[
            ("model", None, b"qwen3-asr-stub"),
            ("file", "audio.webm", b""),
        ])
        self.assertEqual(status, 400)

    def test_missing_file_is_400(self):
        status, _ = self._transcribe(parts=[("model", None, b"qwen3-asr-stub")])
        self.assertEqual(status, 400)

    def test_wrong_model_is_400(self):
        status, _ = self._transcribe(parts=[
            ("model", None, b"whisper"),
            ("file", "audio.webm", b"audio"),
        ])
        self.assertEqual(status, 400)

    def test_missing_model_is_400(self):
        status, _ = self._transcribe(parts=[("file", "audio.webm", b"audio")])
        self.assertEqual(status, 400)

    def test_non_multipart_is_400(self):
        status, _ = self._request(
            "POST", "/v1/audio/transcriptions",
            body=b"{}", headers={"Authorization": "Bearer stub-key",
                                 "Content-Type": "application/json"})
        self.assertEqual(status, 400)

    def test_unauthorized_request_does_not_count(self):
        self._transcribe(auth="Bearer nope")
        _, payload = self._json("GET", "/control/stats")
        self.assertEqual(payload["transcriptions"], 0)


class Judge(StubTestCase):
    def test_envelope_shape(self):
        status, reply = self._judge({"tool": "workflow.list", "class": "read",
                                     "args": {}, "role": "owner", "page": ""})
        self.assertEqual(status, 200)
        self.assertEqual(reply["id"], "stub")
        self.assertEqual(reply["object"], "chat.completion")

    def test_read_allows(self):
        verdict = self._verdict({"tool": "workflow.list", "class": "read",
                                 "args": {}, "role": "owner", "page": "/projects"})
        self.assertEqual(verdict, {"decision": "allow", "reason": "It only looks things up."})

    def test_navigate_allows(self):
        verdict = self._verdict({"tool": "page.navigate", "class": "navigate",
                                 "args": {}, "role": "member", "page": ""})
        self.assertEqual(verdict, {"decision": "allow", "reason": "It only looks things up."})

    def test_draft_edit_allows(self):
        verdict = self._verdict({"tool": "message.draft", "class": "draft_edit",
                                 "args": {}, "role": "owner", "page": ""})
        self.assertEqual(verdict, {"decision": "allow", "reason": "Draft edits can be undone."})

    def test_project_create_asks(self):
        verdict = self._verdict({"tool": "project.create", "class": "risky",
                                 "args": {"name": "x"}, "role": "owner", "page": ""})
        self.assertEqual(verdict, {"decision": "ask",
                                   "reason": "Creates a project and connects a repository."})

    def test_repo_add_asks(self):
        verdict = self._verdict({"tool": "repo.add", "class": "risky",
                                 "args": {}, "role": "maintainer", "page": ""})
        self.assertEqual(verdict, {"decision": "ask",
                                   "reason": "Creates a project and connects a repository."})

    def test_other_risky_asks_with_tool_name(self):
        verdict = self._verdict({"tool": "run.cancel", "class": "risky",
                                 "args": {"run_id": "r1"}, "role": "owner", "page": ""})
        self.assertEqual(verdict, {"decision": "ask", "reason": "Changes real state: run.cancel."})

    def test_last_user_message_wins(self):
        envelope = {
            "messages": [
                {"role": "system", "content": "fixed"},
                {"role": "user", "content": json.dumps({"tool": "run.cancel", "class": "risky"})},
                {"role": "assistant", "content": "earlier"},
                {"role": "user", "content": json.dumps({"tool": "workflow.list", "class": "read"})},
            ],
        }
        status, reply = self._json("POST", "/v1/chat/completions", envelope)
        self.assertEqual(status, 200)
        verdict = json.loads(reply["choices"][0]["message"]["content"])
        self.assertEqual(verdict["decision"], "allow")

    def test_counts_judge_calls(self):
        self._judge({"tool": "workflow.list", "class": "read"})
        self._judge({"tool": "run.cancel", "class": "risky"})
        _, payload = self._json("GET", "/control/stats")
        self.assertEqual(payload["judge_calls"], 2)

    def test_down_judge_is_503_and_uncounted(self):
        self._json("POST", "/control/judge", {"state": "down"})
        status, payload = self._judge({"tool": "workflow.list", "class": "read"})
        self.assertEqual(status, 503)
        self.assertIn("error", payload)
        _, stats = self._json("GET", "/control/stats")
        self.assertEqual(stats["judge_calls"], 0)
        self.assertEqual(stats["judge_state"], "down")

    def test_control_judge_flips_back_to_ok(self):
        self._json("POST", "/control/judge", {"state": "down"})
        status, _ = self._judge({"tool": "workflow.list", "class": "read"})
        self.assertEqual(status, 503)
        status, payload = self._json("POST", "/control/judge", {"state": "ok"})
        self.assertEqual(status, 200)
        self.assertEqual(payload["judge_state"], "ok")
        verdict = self._verdict({"tool": "workflow.list", "class": "read"})
        self.assertEqual(verdict["decision"], "allow")

    def test_control_judge_rejects_bad_state(self):
        status, _ = self._json("POST", "/control/judge", {"state": "chaos"})
        self.assertEqual(status, 400)
        _, stats = self._json("GET", "/control/stats")
        self.assertEqual(stats["judge_state"], "ok")

    def test_bad_bodies_are_400(self):
        status, _ = self._request("POST", "/v1/chat/completions", body=b"not json",
                                  headers={"Content-Type": "application/json"})
        self.assertEqual(status, 400)
        status, _ = self._json("POST", "/v1/chat/completions", {"messages": []})
        self.assertEqual(status, 400)
        status, _ = self._json("POST", "/v1/chat/completions",
                               {"messages": [{"role": "user", "content": "prose, not json"}]})
        self.assertEqual(status, 400)
        status, _ = self._json("POST", "/v1/chat/completions",
                               {"messages": [{"role": "user", "content": json.dumps([1, 2])}]})
        self.assertEqual(status, 400)
        _, stats = self._json("GET", "/control/stats")
        self.assertEqual(stats["judge_calls"], 0)

    def test_default_state_is_ok(self):
        _, stats = self._json("GET", "/control/stats")
        self.assertEqual(stats["judge_state"], "ok")


class SpeechModelEnv(unittest.TestCase):
    def test_default_speech_model_from_env(self):
        os.environ["STUB_SPEECH_MODEL"] = "env-model"
        try:
            state = assistant_stub.StubState()
            self.assertEqual(state.speech_model, "env-model")
        finally:
            del os.environ["STUB_SPEECH_MODEL"]

    def test_explicit_speech_model_wins_over_env(self):
        os.environ["STUB_SPEECH_MODEL"] = "env-model"
        try:
            state = assistant_stub.StubState(speech_model="explicit")
            self.assertEqual(state.speech_model, "explicit")
        finally:
            del os.environ["STUB_SPEECH_MODEL"]


if __name__ == "__main__":
    unittest.main()
