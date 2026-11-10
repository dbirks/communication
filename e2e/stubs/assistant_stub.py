#!/usr/bin/env python3
"""assistant_stub.py — deterministic speech + judge stub for the lab's
assistant acceptance proofs (ADR-0079 decision model, ADR-0080 server-side
speech; wire shapes per docs/design/assistant-handoff/CONTRACT.md § 3-§ 4).

Stdlib only (http.server / json / email.parser). Serves on 0.0.0.0:8098
(override the port with STUB_PORT for tests):

  POST /v1/audio/transcriptions   OpenAI-compatible ASR. Requires
                                  `Authorization: Bearer stub-key`, a
                                  multipart body with a non-empty `file`
                                  part and a `model` field equal to
                                  $STUB_SPEECH_MODEL (default
                                  "qwen3-asr-stub"). Answers the one fixed
                                  transcript and counts it. Audio bytes are
                                  held only long enough to validate the
                                  request — never written anywhere.
  POST /v1/chat/completions       The judge. 503 while its state is "down";
                                  otherwise reads the LAST user message as
                                  {"tool","class","args","role","page"} and
                                  answers the fixed table:
                                    read / navigate -> allow,
                                      "It only looks things up."
                                    draft_edit      -> allow,
                                      "Draft edits can be undone."
                                    project.create / repo.add -> ask,
                                      "Creates a project and connects a
                                       repository."
                                    anything else  -> ask,
                                      "Changes real state: <tool>."
                                  Replied as an OpenAI chat completion whose
                                  message content is the contract's
                                  {"decision","reason"} JSON object.
  POST /control/judge             {"state":"down"|"ok"} flips the judge
                                  (default ok). Lab control only.
  GET  /control/stats             {"transcriptions":n,"judge_calls":n,
                                  "judge_state":"ok"}
  GET  /healthz                   200 while the process is up.

`stub-key` is a fixed lab constant, not a secret; nothing here talks to any
real model.
"""
import json
import os
import re
import threading
from email.parser import BytesParser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

DEFAULT_PORT = 8098
DEFAULT_SPEECH_MODEL = "qwen3-asr-stub"
EXPECTED_AUTHORIZATION = "Bearer stub-key"
TRANSCRIPT_TEXT = "what workflows do I have"
# 25 MiB is generous against the API's own 10 MiB audio cap (CONTRACT § 4);
# the stub refuses anything bigger rather than buffering it.
MAX_BODY_BYTES = 25 * 1024 * 1024

_BOUNDARY_RE = re.compile(r'boundary="?([^";]+)"?')
_NAME_RE = re.compile(r'name="([^"]*)"')
_FILENAME_RE = re.compile(r'filename="([^"]*)"')


class StubState:
    """Shared, lock-guarded stub state (counters + judge switch)."""

    def __init__(self, speech_model=None):
        self._lock = threading.Lock()
        self.speech_model = (
            speech_model
            if speech_model is not None
            else os.environ.get("STUB_SPEECH_MODEL", DEFAULT_SPEECH_MODEL)
        )
        self.transcriptions = 0
        self.judge_calls = 0
        self.judge_state = "ok"

    def record_transcription(self):
        with self._lock:
            self.transcriptions += 1

    def record_judge_call(self):
        with self._lock:
            self.judge_calls += 1

    def set_judge_state(self, state):
        with self._lock:
            self.judge_state = state

    def judge_down(self):
        with self._lock:
            return self.judge_state == "down"

    def snapshot(self):
        with self._lock:
            return {
                "transcriptions": self.transcriptions,
                "judge_calls": self.judge_calls,
                "judge_state": self.judge_state,
            }


def parse_multipart(body, boundary):
    """Split a multipart/form-data body without cgi.FieldStorage.

    Returns ({field_name: str_value}, {part_name: (filename, bytes)}).
    Manual boundary split + email header parse: stdlib-only and exact — the
    Go server's forwarded body uses short \\r\\n boundaries, which is what
    this reads.
    """
    fields, files = {}, {}
    delimiter = b"--" + boundary.encode("utf-8")
    for chunk in body.split(delimiter):
        # Preamble/epilogue and the final "--" closer carry no part.
        if chunk in (b"", b"--", b"--\r\n", b"\r\n"):
            continue
        if chunk.startswith(b"\r\n"):
            chunk = chunk[2:]
        if chunk.endswith(b"\r\n"):
            chunk = chunk[:-2]
        head, sep, payload = chunk.partition(b"\r\n\r\n")
        if not sep:
            continue
        headers = BytesParser().parsebytes(head)
        disposition = headers.get("Content-Disposition", "")
        name_match = _NAME_RE.search(disposition)
        if not name_match:
            continue
        name = name_match.group(1)
        filename_match = _FILENAME_RE.search(disposition)
        if filename_match is not None:
            files[name] = (filename_match.group(1), payload)
        else:
            fields[name] = payload.decode("utf-8", "replace")
    return fields, files


def decide_judge(request):
    """The stub's fixed judgment over one {"tool","class",...} call JSON."""
    tool = request.get("tool")
    cls = request.get("class")
    tool = tool if isinstance(tool, str) else ""
    cls = cls if isinstance(cls, str) else ""
    if cls in ("read", "navigate"):
        return "allow", "It only looks things up."
    if cls == "draft_edit":
        return "allow", "Draft edits can be undone."
    if tool in ("project.create", "repo.add"):
        return "ask", "Creates a project and connects a repository."
    return "ask", "Changes real state: %s." % tool


def make_handler(state):
    class StubHandler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"
        server_version = "assistant-stub/1"

        def log_message(self, fmt, *args):  # keep lab logs quiet
            pass

        # -- helpers ------------------------------------------------------
        def _send_json(self, status, payload):
            body = json.dumps(payload).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _read_body(self):
            try:
                length = int(self.headers.get("Content-Length") or 0)
            except ValueError:
                return None
            if length < 0 or length > MAX_BODY_BYTES:
                return None
            return self.rfile.read(length) if length else b""

        # -- routes -------------------------------------------------------
        def do_GET(self):
            if self.path == "/healthz":
                self._send_json(200, {"status": "ok"})
            elif self.path == "/control/stats":
                self._send_json(200, state.snapshot())
            else:
                self._send_json(404, {"error": {"message": "not found"}})

        def do_POST(self):
            body = self._read_body()
            if body is None:
                self._send_json(400, {"error": {"message": "unreadable body"}})
                return
            if self.path == "/v1/audio/transcriptions":
                self._handle_transcription(body)
            elif self.path == "/v1/chat/completions":
                self._handle_judge(body)
            elif self.path == "/control/judge":
                self._handle_control_judge(body)
            else:
                self._send_json(404, {"error": {"message": "not found"}})

        def _handle_transcription(self, body):
            if self.headers.get("Authorization") != EXPECTED_AUTHORIZATION:
                self._send_json(401, {"error": {"message": "missing or wrong key"}})
                return
            content_type = self.headers.get("Content-Type", "")
            boundary_match = _BOUNDARY_RE.search(content_type)
            if not content_type.startswith("multipart/form-data") or not boundary_match:
                self._send_json(400, {"error": {"message": "expected multipart/form-data"}})
                return
            fields, files = parse_multipart(body, boundary_match.group(1))
            audio = files.get("file")
            if audio is None or not audio[1]:
                # Validated, then dropped: the bytes are never stored.
                self._send_json(400, {"error": {"message": "missing or empty file"}})
                return
            if fields.get("model") != state.speech_model:
                self._send_json(400, {"error": {"message": "unexpected model"}})
                return
            state.record_transcription()
            self._send_json(200, {"text": TRANSCRIPT_TEXT})

        def _handle_judge(self, body):
            if state.judge_down():
                self._send_json(503, {"error": {"message": "stub judge is down"}})
                return
            try:
                envelope = json.loads(body)
            except (ValueError, UnicodeDecodeError):
                self._send_json(400, {"error": {"message": "body is not json"}})
                return
            messages = envelope.get("messages") if isinstance(envelope, dict) else None
            content = None
            if isinstance(messages, list):
                for message in reversed(messages):
                    if isinstance(message, dict) and message.get("role") == "user":
                        content = message.get("content")
                        break
            if not isinstance(content, str):
                self._send_json(400, {"error": {"message": "no user message content"}})
                return
            try:
                call = json.loads(content)
            except ValueError:
                self._send_json(400, {"error": {"message": "user content is not json"}})
                return
            if not isinstance(call, dict):
                self._send_json(400, {"error": {"message": "user content is not an object"}})
                return
            decision, reason = decide_judge(call)
            state.record_judge_call()
            self._send_json(200, {
                "id": "stub",
                "object": "chat.completion",
                "choices": [{
                    "index": 0,
                    "message": {
                        "role": "assistant",
                        "content": json.dumps({"decision": decision, "reason": reason}),
                    },
                    "finish_reason": "stop",
                }],
            })

        def _handle_control_judge(self, body):
            try:
                payload = json.loads(body)
            except (ValueError, UnicodeDecodeError):
                self._send_json(400, {"error": {"message": "body is not json"}})
                return
            new_state = payload.get("state") if isinstance(payload, dict) else None
            if new_state not in ("down", "ok"):
                self._send_json(400, {"error": {"message": 'state must be "down" or "ok"'}})
                return
            state.set_judge_state(new_state)
            self._send_json(200, {"judge_state": new_state})

    return StubHandler


def make_server(state=None, host="0.0.0.0", port=None):
    """Build the ThreadingHTTPServer (used by compose and by the unittest)."""
    state = state or StubState()
    port = DEFAULT_PORT if port is None else port
    httpd = ThreadingHTTPServer((host, port), make_handler(state))
    httpd.stub_state = state
    return httpd


def main():
    port = int(os.environ.get("STUB_PORT", str(DEFAULT_PORT)))
    make_server(port=port).serve_forever()


if __name__ == "__main__":
    main()
