#!/usr/bin/env python3
"""Raw-protocol ACP compatibility probe (M0 spike, D-016).

Launches an ACP adapter as a stdio subprocess (JSON-RPC 2.0, newline-delimited
JSON) using only the Python standard library, drives the reference client
steps from communication-spec/04-agent-runtime.md and the protocol
compatibility table in communication-spec/12-test-strategy.md, and writes a
redacted results JSON. This is the raw-protocol baseline the Go SDK adapter
must reproduce.

Step groups are selectable with --steps (initialize + session/new always run
first). --mode-id sends ACP session/set_mode and --set-config sends
session/set_config_option after session/new, which is how a stricter permission
mode is reached; --cancel-repeats runs the cancel step N times, each in a fresh
session, and the cancel summary step is PASS only when every iteration returned
stopReason=cancelled.

Every step is recorded as PASS (observed, matched), FAIL (observed, did not
match) or GAP (could not test). Nothing is inferred — evidence is the literal
protocol traffic and filesystem state.
"""

import argparse
import datetime
import json
import os
import queue
import re
import shutil
import signal
import subprocess
import sys
import threading
import time

PROBE_VERSION = "0.0.3"
PROMPT_TIMEOUT = 180.0  # per prompt turn, seconds
REQUEST_TIMEOUT = 60.0  # non-prompt requests
CANCEL_RESPONSE_TIMEOUT = 30.0

# Optional step groups runnable via --steps. "streaming" keeps the original
# hello.txt flow (streaming + tool calls + permission observation under
# whatever mode the adapter defaults to); "permission" is the dedicated
# permission round-trip that first switches to a strict --mode-id.
STEP_GROUPS = ("streaming", "second-turn", "permission", "cancel",
               "restore", "malformed")
DEFAULT_STEPS = "streaming,second-turn,cancel,restore,malformed"
PERMISSION_PROMPT_ALLOW = (
    "Create a file named allowed.txt in the current directory containing "
    "exactly the word allowed. Then reply DONE.")
PERMISSION_PROMPT_REJECT = (
    "Create a file named rejected.txt in the current directory containing "
    "exactly the word rejected. Then reply DONE.")
CANCEL_PROMPT = "Run the shell command: sleep 60 ; then reply FINISHED."

INITIALIZE_PARAMS = {
    "protocolVersion": 1,
    "clientCapabilities": {"fs": {"readTextFile": False, "writeTextFile": False},
                           "terminal": False},
    "clientInfo": {"name": "communication-acp-probe", "version": PROBE_VERSION},
}

# Pinned adapter packages under test (docs/compatibility/ACP.md provenance).
ADAPTERS = {
    "claude": {"harness_cmd": "claude",
               "package": "@agentclientprotocol/claude-agent-acp",
               "version": "0.90.0"},
    "codex": {"harness_cmd": "codex",
              "package": "@agentclientprotocol/codex-acp",
              "version": "2.2.2"},
    "pi": {"harness_cmd": "pi-acp",
           "package": "pi-acp",
           "version": "0.0.34"},
}

SECRET_KEY_RE = re.compile(r"token|secret|key|authorization|cookie", re.I)
EMAIL_RE = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
# Account-identity keys, redacted only when they appear inside an
# "account"/"authStatus" object (e.g. ACP _auth/status_update messages).
ID_KEYS = {"email", "organization", "plan", "label", "name", "userid",
           "accountid", "orgid"}
IDENTITY_PARENT_KEYS = {"account", "authstatus"}
MAX_STR = 500


def now_iso():
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="milliseconds")


def clean(obj, _in_identity=False):
    """Deep-copy with secret-looking values redacted and long strings truncated."""
    if isinstance(obj, dict):
        out = {}
        for k, v in obj.items():
            kl = str(k).lower()
            if SECRET_KEY_RE.search(str(k)):
                out[k] = "[REDACTED]"
            elif _in_identity and kl in ID_KEYS and isinstance(v, str):
                out[k] = "[REDACTED]"
            else:
                out[k] = clean(v, _in_identity or kl in IDENTITY_PARENT_KEYS)
        return out
    if isinstance(obj, list):
        return [clean(v, _in_identity) for v in obj]
    if isinstance(obj, str):
        obj = EMAIL_RE.sub("[REDACTED:EMAIL]", obj)
        if len(obj) > MAX_STR:
            return obj[:MAX_STR] + "...[TRUNCATED]"
        return obj
    return obj


def text_of(update):
    """Concatenate every text node under an ACP update's content field."""
    if not isinstance(update, dict):
        return ""
    out = []

    def collect(node):
        if isinstance(node, dict):
            if isinstance(node.get("text"), str):
                out.append(node["text"])
            for v in node.values():
                collect(v)
        elif isinstance(node, list):
            for v in node:
                collect(v)

    collect(update.get("content"))
    return " ".join(out)


def tail(path, n=2000):
    try:
        with open(path, "rb") as f:
            return f.read()[-n:].decode("utf-8", "replace")
    except OSError:
        return ""


class AgentProcess:
    """One ACP adapter subprocess with a JSON-RPC reader thread."""

    def __init__(self, cmd, stderr_path, transcript):
        self.cmd = cmd
        self.stderr_path = stderr_path
        self.transcript = transcript  # shared list, guarded by transcript_lock
        self.transcript_lock = threading.Lock()
        self._wlock = threading.Lock()
        self._cv = threading.Condition()
        self.responses = {}          # str(id) -> response msg
        self.notifications = []      # full notification msgs, in arrival order
        self.errors = []             # protocol-level surprises
        self.permission_log = []     # one entry per session/request_permission
        self.permission_mode = "allow"   # allow | cancel
        self.next_id = 1
        self._fd = None
        self.proc = None

    def log(self, direction, message):
        with self.transcript_lock:
            self.transcript.append({"t": now_iso(), "dir": direction,
                                    "msg": message})

    def start(self):
        self._fd = open(self.stderr_path, "ab")
        self.proc = subprocess.Popen(
            self.cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=self._fd, close_fds=True)
        self._reader = threading.Thread(target=self._read_loop, daemon=True)
        self._reader.start()

    # -- outbound -------------------------------------------------------
    def _write(self, raw, direction, payload):
        self.log(direction, payload)
        try:
            with self._wlock:
                self.proc.stdin.write(raw.encode() + b"\n")
                self.proc.stdin.flush()
        except (OSError, ValueError) as exc:
            self.errors.append(f"stdin write failed: {exc}")
            return False
        return True

    def _send(self, obj):
        return self._write(json.dumps(obj, separators=(",", ":")), "out", obj)

    def send_raw_line(self, line):
        return self._write(line, "out-raw", line)

    def notify(self, method, params):
        self._send({"jsonrpc": "2.0", "method": method, "params": params})

    def begin(self, method, params):
        rid = self.next_id
        self.next_id += 1
        self._send({"jsonrpc": "2.0", "id": rid, "method": method,
                    "params": params})
        return rid

    def wait(self, rid, timeout):
        deadline = time.monotonic() + timeout
        with self._cv:
            while str(rid) not in self.responses:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return None
                self._cv.wait(remaining)
            return self.responses.pop(str(rid))

    def request(self, method, params, timeout=REQUEST_TIMEOUT):
        return self.wait(self.begin(method, params), timeout)

    def has_response(self, rid):
        """True when the response to rid has already arrived (turn is over)."""
        with self._cv:
            return str(rid) in self.responses

    # -- inbound --------------------------------------------------------
    def _read_loop(self):
        for raw in self.proc.stdout:
            line = raw.decode("utf-8", "replace").rstrip("\r\n")
            if not line.strip():
                continue
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                self.errors.append("unparseable stdout line: " + line[:200])
                self.log("in-raw", line)
                continue
            self.log("in", msg)
            if not isinstance(msg, dict):
                self.errors.append("non-object stdout JSON")
                continue
            if "method" in msg and "id" in msg:
                self._handle_agent_request(msg)
            elif "method" in msg:
                with self._cv:
                    self.notifications.append(msg)
                    self._cv.notify_all()
            elif "id" in msg:
                with self._cv:
                    self.responses[str(msg["id"])] = msg
                    self._cv.notify_all()
            else:
                self.errors.append("unclassified message")
        try:
            self.proc.stdout.close()
        except OSError:
            pass

    # ACP v1 PermissionOptionKind values: allow_once, allow_always,
    # reject_once, reject_always. "cancel" must never pick an option: a
    # cancelled turn is answered with the cancelled outcome per spec.
    OPTION_PREFS = {
        "allow_once": ("allow_once", "allow_always"),
        "allow_always": ("allow_always", "allow_once"),
        "reject_once": ("reject_once", "reject_always"),
        "reject_always": ("reject_always", "reject_once"),
        "cancel": (),
    }

    def _pick_option(self, options):
        """Return (option, exact_kind_match) for the current permission_mode."""
        prefs = self.OPTION_PREFS.get(self.permission_mode, ())
        for want in prefs:
            for opt in options:
                if isinstance(opt, dict) and opt.get("kind") == want:
                    return opt, True
        return (None, False)

    def _handle_agent_request(self, msg):
        method, mid = msg.get("method"), msg.get("id")
        if method == "session/request_permission":
            params = msg.get("params") or {}
            options = [o for o in (params.get("options") or [])
                       if isinstance(o, dict)]
            entry = {"t": now_iso(),
                     "tool_call": params.get("toolCall"),
                     "option_kinds": [o.get("kind") for o in options],
                     "options": [{"optionId": o.get("optionId"),
                                  "kind": o.get("kind"),
                                  "name": o.get("name")} for o in options],
                     "client_response_mode": self.permission_mode,
                     "outcome": "cancelled",
                     "exact_kind_match": False}
            opt, exact = (None, False) if self.permission_mode == "cancel" \
                else self._pick_option(options)
            if opt is not None:
                oid = opt.get("optionId", opt.get("id"))
                entry["outcome"] = "selected:" + str(opt.get("kind", oid))
                entry["selected_option_id"] = oid
                entry["exact_kind_match"] = exact
                self._send({"jsonrpc": "2.0", "id": mid, "result":
                            {"outcome": {"outcome": "selected",
                                         "optionId": oid}}})
            else:
                self._send({"jsonrpc": "2.0", "id": mid, "result":
                            {"outcome": {"outcome": "cancelled"}}})
            self.permission_log.append(entry)
        else:
            self.errors.append("unsupported agent request: " + str(method))
            self._send({"jsonrpc": "2.0", "id": mid,
                        "error": {"code": -32601,
                                  "message": "Method not found"}})

    # -- lifecycle ------------------------------------------------------
    def stdin_close(self):
        with self._wlock:
            try:
                self.proc.stdin.close()
            except (OSError, ValueError):
                pass

    def shutdown(self):
        """Close stdin; SIGTERM after 5 s, SIGKILL after 10 more s."""
        self.stdin_close()
        if not self.wait_exit(5):
            self.term()
            if not self.wait_exit(10):
                self.kill()
                self.wait_exit(5)

    def term(self):
        try:
            self.proc.send_signal(signal.SIGTERM)
        except (OSError, ValueError):
            pass

    def kill(self):
        try:
            self.proc.kill()
        except (OSError, ValueError):
            pass

    def wait_exit(self, timeout):
        deadline = time.monotonic() + timeout
        while self.proc.poll() is None:
            if time.monotonic() > deadline:
                return False
            time.sleep(0.1)
        return True

    def alive(self):
        return self.proc is not None and self.proc.poll() is None


def step(steps, name, result, evidence):
    steps.append({"step": name, "result": result, "evidence": evidence})


def detect_harness_version(label):
    tool = ADAPTERS[label]["harness_cmd"]
    try:
        cp = subprocess.run([tool, "--version"], capture_output=True,
                            text=True, timeout=30)
        return (cp.stdout or "").strip() or "unknown"
    except (OSError, subprocess.TimeoutExpired):
        return "unknown"


def make_repo(workdir_root, label):
    repo = os.path.join(workdir_root, f"{label}-repo")
    if os.path.exists(repo):
        shutil.rmtree(repo)
    os.makedirs(repo)
    subprocess.run(["git", "init", "-q", "."], cwd=repo, check=True)
    with open(os.path.join(repo, "README.md"), "w") as f:
        f.write("# acp-probe-fixture\n")
    subprocess.run(["git", "add", "README.md"], cwd=repo, check=True)
    subprocess.run(["git", "-c", "user.name=acp-probe",
                    "-c", "user.email=acp-probe@localhost",
                    "commit", "-q", "-m", "init"], cwd=repo, check=True)
    return repo


def do_initialize(agent, steps, record=True):
    """Send initialize; returns (ok, protocol_version, capabilities, raw)."""
    resp = agent.request("initialize", INITIALIZE_PARAMS,
                         timeout=REQUEST_TIMEOUT)
    if resp is None:
        if record:
            step(steps, "initialize", "FAIL", "timeout waiting for initialize response")
        return False, None, {}, None
    if "error" in resp:
        if record:
            step(steps, "initialize", "FAIL", {"error": resp["error"]})
        return False, None, {}, resp
    res = resp.get("result") or {}
    caps = res.get("agentCapabilities") or {}
    if record:
        evidence = {
            "protocolVersion": res.get("protocolVersion"),
            "agentCapabilities": caps,
            "authMethods": res.get("authMethods"),
        }
        if res.get("agentInfo") is not None:
            evidence["agentInfo"] = res["agentInfo"]
        step(steps, "initialize", "PASS", evidence)
    return True, res.get("protocolVersion"), caps, res


def turn_summary(agent, mark, resp):
    updates = [m for m in agent.notifications[mark:]
               if m.get("method") == "session/update"]
    kinds, texts = {}, []
    for m in updates:
        upd = (m.get("params") or {}).get("update") or {}
        k = upd.get("sessionUpdate", "<missing>")
        kinds[k] = kinds.get(k, 0) + 1
        if k in ("agent_message_chunk", "agent_thought_chunk"):
            texts.append(text_of(upd))
    stop = None
    if resp and "result" in resp:
        stop = (resp["result"] or {}).get("stopReason")
    return {"stopReason": stop, "session_update_counts": kinds,
            "message_text": "".join(texts)}


def hello_state(repo):
    path = os.path.join(repo, "hello.txt")
    exists = os.path.isfile(path)
    content = None
    if exists:
        with open(path, "r") as f:
            content = f.read()
    return {"hello_txt_exists": exists,
            "hello_txt_is_hello": content is not None
            and content.rstrip("\n") == "hello",
            "hello_txt_content_repr": None if content is None
            else repr(content[:50])}


def file_state(repo, name):
    """Existence + short content sample of a fixture file in the repo."""
    path = os.path.join(repo, name)
    exists = os.path.isfile(path)
    content = None
    if exists:
        with open(path, "r", errors="replace") as f:
            content = f.read()
    return {"file": name, "file_exists": exists,
            "file_content_repr": None if content is None else repr(content[:50])}


def session_option_state(result):
    """Compact, redaction-safe view of modes + configOptions from ACP results."""
    result = result if isinstance(result, dict) else {}
    out = {}
    modes = result.get("modes")
    if isinstance(modes, dict) and modes:
        out["currentModeId"] = modes.get("currentModeId")
        out["availableModes"] = [{"id": m.get("id"), "name": m.get("name"),
                                  "description": m.get("description")}
                                 for m in modes.get("availableModes") or []
                                 if isinstance(m, dict)]
    opts = result.get("configOptions")
    if isinstance(opts, list) and opts:
        out["configOptions"] = [
            {"id": o.get("id"), "category": o.get("category"),
             "type": o.get("type"), "currentValue": o.get("currentValue"),
             "values": [v.get("value") for v in o.get("options") or []
                        if isinstance(v, dict) and v.get("value") is not None]}
            for o in opts if isinstance(o, dict)]
    return out


def parse_steps(raw):
    names = [n.strip() for n in (raw or "").split(",") if n.strip()]
    bad = [n for n in names if n not in STEP_GROUPS]
    if bad:
        raise ValueError("unknown --steps value(s): " + ", ".join(bad)
                         + "; choose from " + ", ".join(STEP_GROUPS))
    return names


def parse_set_config(items):
    out = []
    for item in items or []:
        if "=" not in item:
            raise ValueError("--set-config expects id=value, got " + repr(item))
        cid, val = item.split("=", 1)
        out.append((cid.strip(), val.strip()))
    return out


def updates_since(agent, mark, update_kind):
    out = []
    for m in agent.notifications[mark:]:
        upd = (m.get("params") or {}).get("update") or {}
        if upd.get("sessionUpdate") == update_kind:
            out.append(upd)
    return out


def do_set_mode(agent, session_id, mode_id, steps):
    """ACP v1 session/set_mode {"sessionId","modeId"} (protocol/v1/session-modes)."""
    mark = len(agent.notifications)
    resp = agent.request("session/set_mode",
                         {"sessionId": session_id, "modeId": mode_id})
    if resp is None:
        step(steps, "session/set_mode", "FAIL",
             {"modeId": mode_id, "reason": "timeout waiting for response"})
        return False
    if "error" in resp:
        step(steps, "session/set_mode", "FAIL",
             {"modeId": mode_id, "error": resp["error"]})
        return False
    res = resp.get("result") or {}
    step(steps, "session/set_mode", "PASS",
         dict({"modeId": mode_id,
               "result_field_names": sorted(res.keys()),
               "current_mode_update_notifications":
                   [u.get("currentModeId") for u in
                    updates_since(agent, mark, "current_mode_update")]},
              **session_option_state(res)))
    return True


def do_set_config(agent, session_id, config_id, value, steps):
    """ACP v1 session/set_config_option {"sessionId","configId","value"}."""
    name = "session/set_config_option " + config_id
    mark = len(agent.notifications)
    resp = agent.request("session/set_config_option",
                         {"sessionId": session_id, "configId": config_id,
                          "value": value})
    if resp is None:
        step(steps, name, "FAIL", {"value": value,
                                   "reason": "timeout waiting for response"})
        return False
    if "error" in resp:
        step(steps, name, "FAIL", {"value": value, "error": resp["error"]})
        return False
    res = resp.get("result") or {}
    opts = res.get("configOptions") or []
    cur = next((o.get("currentValue") for o in opts
                if isinstance(o, dict) and o.get("id") == config_id), None)
    step(steps, name, "PASS" if cur == value else "FAIL",
         dict({"requested_value": value, "observed_currentValue": cur,
               "config_option_update_notifications":
                   [len(u.get("configOptions") or []) for u in
                    updates_since(agent, mark, "config_option_update")]},
              **session_option_state(res)))
    return True


def permission_round(agent, prompt, session_id, repo, fname, text,
                     client_mode, expect, steps, mode_desc):
    """One permission-gated turn: expect 'allow' -> file created, 'reject' -> absent."""
    agent.errors.clear()
    rid, mark, perms_before, t0 = prompt(session_id, text, client_mode)
    resp = agent.wait(rid, PROMPT_TIMEOUT)
    summ = turn_summary(agent, mark, resp)
    perms = agent.permission_log[perms_before:]
    fstate = file_state(repo, fname)
    offered = [k for entry in perms for k in entry["option_kinds"]]
    ev = {"session_mode": mode_desc,
          "client_reply_mode": client_mode,
          "prompt_file": fname,
          "stopReason": summ["stopReason"],
          "permission_requests": len(perms),
          "permission_option_kinds": [entry["option_kinds"] for entry in perms],
          "permission_options_offered": [entry["options"] for entry in perms],
          "permission_outcomes": [entry["outcome"] for entry in perms],
          "permission_exact_kind_match": [entry["exact_kind_match"]
                                           for entry in perms],
          "permission_tool_titles": [
              (entry.get("tool_call") or {}).get("title")
              if isinstance(entry.get("tool_call"), dict) else None
              for entry in perms],
          "seconds_prompt_to_response": round(time.monotonic() - t0, 1),
          "agent_message_text_excerpt": summ["message_text"][:200],
          "session_update_counts": summ["session_update_counts"]}
    ev.update(fstate)
    name = "permission " + expect
    first = perms[0] if perms else None
    want_prefix = "allow" if expect == "allow" else "reject"
    if resp is None:
        step(steps, name, "FAIL",
             dict(ev, reason="timeout waiting for session/prompt response"))
        return
    if first is None:
        step(steps, name, "GAP",
             dict(ev, reason="agent sent no session/request_permission in this "
                  "mode, so the round-trip could not be exercised"))
        return
    if not first["exact_kind_match"]:
        if not any(isinstance(k, str) and k.startswith(want_prefix)
                   for k in offered):
            step(steps, name, "GAP",
                 dict(ev, reason="adapter offered no " + want_prefix
                      + "* PermissionOptionKind (observed kinds: "
                      + ",".join(str(k) for k in offered) + ")"))
            return
        step(steps, name, "FAIL",
             dict(ev, reason="probe could not select the intended "
                  + want_prefix + "* option"))
        return
    ok = fstate["file_exists"] if expect == "allow" else not fstate["file_exists"]
    reason = None if ok else (
        "permission request arrived but the file was not created"
        if expect == "allow" else
        "file was created even though the request was rejected")
    step(steps, name, "PASS" if ok else "FAIL", dict(ev, reason=reason))


def cancel_once(agent, prompt, session_id, after, steps, label, mode_desc):
    """Start a long tool call, cancel it, record stopReason + latency."""
    agent.errors.clear()
    rid, mark, perms_before, t0 = prompt(session_id, CANCEL_PROMPT, "allow")
    time.sleep(after)
    # A turn that already finished before session/cancel was sent does not
    # exercise cancellation at all (e.g. Claude auto-backgrounds `sleep 60`).
    ended_before = agent.has_response(rid)
    agent.permission_mode = "cancel"  # any pending permission request is refused
    agent.notify("session/cancel", {"sessionId": session_id})
    t_cancel = time.monotonic()
    resp = agent.wait(rid, CANCEL_RESPONSE_TIMEOUT)
    agent.permission_mode = "allow"
    summ = turn_summary(agent, mark, resp)
    perms = agent.permission_log[perms_before:]
    rec = {"iteration": label,
           "session_mode": mode_desc,
           "cancel_sent_while_turn_open": not ended_before,
           "observed_stopReason": summ["stopReason"],
           "cancelled": summ["stopReason"] == "cancelled",
           "seconds_after_cancel": round(time.monotonic() - t_cancel, 1),
           "seconds_prompt_to_response": round(time.monotonic() - t0, 1),
           "permission_requests": len(perms),
           "permission_outcomes": [p["outcome"] for p in perms],
           "session_update_counts": summ["session_update_counts"],
           "protocol_errors": list(agent.errors)}
    if ended_before:
        res = "GAP"
        rec["reason"] = ("turn already ended (stopReason="
                         + str(summ["stopReason"]) + ") before session/cancel "
                         "was sent, so cancellation was not exercised")
    else:
        res = "PASS" if rec["cancelled"] else "FAIL"
    step(steps, "cancel " + label, res, rec)
    return rec


def _drive(args, transcript, steps, state):
    want = parse_steps(args.steps)
    set_config = parse_set_config(args.set_config)
    os.makedirs(args.workdir_root, exist_ok=True)
    stderr_dir = os.path.join(args.workdir_root, "logs")
    os.makedirs(stderr_dir, exist_ok=True)
    repo = make_repo(args.workdir_root, args.label)

    def new_agent(tag):
        return AgentProcess([args.agent_cmd],
                            os.path.join(stderr_dir,
                                         f"{args.label}-{tag}-stderr.log"),
                            transcript)

    agent = new_agent("1")
    agent.start()
    state["agent"] = agent

    # 1. initialize (prerequisite for every step group)
    ok, _pv, caps, init_res = do_initialize(agent, steps)
    if not ok:
        return

    def open_session(tag, record):
        """session/new; returns (sessionId, result) or (None, None)."""
        resp = agent.request("session/new", {"cwd": repo, "mcpServers": []})
        sid, ev = None, None
        if resp is None:
            ev = "timeout waiting for session/new response"
        elif "error" in resp:
            err = resp["error"]
            ev = {"error": err}
            if init_res and init_res.get("authMethods"):
                ev["advertised_authMethods"] = init_res["authMethods"]
            if re.search(r"auth", json.dumps(err), re.I):
                ev = dict(ev, reason="authentication required; run stopped, "
                          "no interactive login attempted")
        else:
            res = resp.get("result") or {}
            sid = res.get("sessionId")
            ev = ({"sessionId_prefix": str(sid)[:8] + "…",
                   "result_field_names": sorted(res.keys()),
                   **session_option_state(res)} if sid else {"result": res})
        if record:
            step(steps, "session/new" if tag == "primary"
                 else f"session/new ({tag})",
                 "PASS" if sid else "FAIL", ev)
        return sid, (resp.get("result") or {} if sid else None)

    # 2. session/new (primary session)
    session_id, sess_res = open_session("primary", True)
    if not session_id:
        return
    state["session_options"] = session_option_state(sess_res)

    def prompt(sid, text, client_mode="allow"):
        agent.permission_mode = client_mode
        mark = len(agent.notifications)
        perms_before = len(agent.permission_log)
        rid = agent.begin("session/prompt",
                          {"sessionId": sid,
                           "prompt": [{"type": "text", "text": text}]})
        return rid, mark, perms_before, time.monotonic()

    # 3. optional stricter mode / config option before any prompt
    mode_desc = "adapter default (no session/set_mode)"
    if args.mode_id:
        done = do_set_mode(agent, session_id, args.mode_id, steps)
        mode_desc = ("session/set_mode modeId=" + args.mode_id
                     if done else "session/set_mode modeId=" + args.mode_id
                     + " FAILED; adapter kept " + str((sess_res.get("modes") or {})
                                                      .get("currentModeId")))
    for cid, cval in set_config:
        if do_set_config(agent, session_id, cid, cval, steps):
            mode_desc += f"; session/set_config_option {cid}={cval}"
        else:
            mode_desc += f"; session/set_config_option {cid}={cval} FAILED"

    # 4. prompt + streaming + tool calls + permission observation (default flow)
    if "streaming" in want:
        agent.errors.clear()
        rid, mark, perms_before, _t0 = prompt(
            session_id,
            "Create a file named hello.txt in the current directory containing "
            "exactly the word hello. Then reply DONE.")
        resp = agent.wait(rid, PROMPT_TIMEOUT)
        summ = turn_summary(agent, mark, resp)
        perms = agent.permission_log[perms_before:]
        hstate = hello_state(repo)
        base_ev = {"prompt": "create hello.txt", "stopReason": summ["stopReason"],
                   "session_update_counts": summ["session_update_counts"],
                   "permission_requests": len(perms),
                   "permission_option_kinds": [p["option_kinds"] for p in perms],
                   **hstate}
        if resp is None:
            for nm in ("streaming", "tool_calls", "permission (default flow)"):
                step(steps, nm, "FAIL",
                     "timeout waiting for session/prompt response")
        else:
            nchunk = summ["session_update_counts"].get("agent_message_chunk", 0)
            ncall = summ["session_update_counts"].get("tool_call", 0)
            step(steps, "streaming", "PASS" if nchunk >= 1 else "FAIL",
                 dict(base_ev, agent_message_chunks=nchunk))
            step(steps, "tool_calls", "PASS" if ncall >= 1 else "FAIL",
                 dict(base_ev, tool_calls=ncall))
            if len(perms) >= 1 and hstate["hello_txt_exists"]:
                step(steps, "permission (default flow)", "PASS", base_ev)
            elif len(perms) == 0 and hstate["hello_txt_exists"]:
                step(steps, "permission (default flow)", "GAP",
                     dict(base_ev, reason="agent did not request permission "
                          "under the mode in effect (" + mode_desc + ")"))
            else:
                step(steps, "permission (default flow)", "FAIL",
                     dict(base_ev, reason="permission request flow or file "
                          "creation did not complete"))

    # 5. second turn
    if "second-turn" in want:
        rid, mark, _pb, _t0 = prompt(session_id, "Reply with the single word SECOND.")
        resp = agent.wait(rid, PROMPT_TIMEOUT)
        summ = turn_summary(agent, mark, resp)
        if resp is None:
            step(steps, "second turn", "FAIL",
                 "timeout waiting for session/prompt response")
        else:
            has_second = "SECOND" in summ["message_text"]
            step(steps, "second turn",
                 "PASS" if summ["stopReason"] == "end_turn" and has_second
                 else "FAIL",
                 {"stopReason": summ["stopReason"], "saw_SECOND": has_second,
                  "reply_excerpt": summ["message_text"][:200],
                  "session_update_counts": summ["session_update_counts"]})

    # 6. dedicated permission round-trips: allow then reject
    if "permission" in want:
        permission_round(agent, prompt, session_id, repo, "allowed.txt",
                         PERMISSION_PROMPT_ALLOW, "allow_once", "allow", steps,
                         mode_desc)
        permission_round(agent, prompt, session_id, repo, "rejected.txt",
                         PERMISSION_PROMPT_REJECT, "reject_once", "reject",
                         steps, mode_desc)

    # 7. cancel reliability: N independent iterations, each in a fresh session
    if "cancel" in want:
        n = max(1, args.cancel_repeats)
        recs = []
        for i in range(n):
            # Cancel is measured on a fresh session without session/set_mode,
            # so the numbers stay comparable with the baseline runs in
            # results-{claude,codex}.json (session/set_mode is per-session).
            sid, sres = open_session(f"cancel-{i + 1}", False)
            if not sid:
                step(steps, f"cancel {i + 1}/{n}", "FAIL",
                     {"reason": "could not open a session for this iteration"})
                continue
            c_mode = ("fresh session, no session/set_mode; currentModeId="
                      + str(((sres or {}).get("modes") or {}).get("currentModeId")))
            recs.append(cancel_once(agent, prompt, sid, args.cancel_after,
                                    steps, f"{i + 1}/{n}", c_mode))
        nc = sum(1 for r in recs if r["cancelled"])
        open_at_cancel = sum(1 for r in recs
                             if r.get("cancel_sent_while_turn_open"))
        summary = {"cancelled": f"{nc}/{len(recs)} of {n}",
                   "cancelled_ratio": f"{nc}/{n}",
                   "turns_still_open_when_cancel_sent":
                       f"{open_at_cancel}/{len(recs)}",
                   "iterations": recs}
        if nc == n and n:
            res = "PASS"
        elif open_at_cancel == 0:
            res = "GAP"
            summary["reason"] = ("no iteration had an open turn when "
                                 "session/cancel was sent")
        else:
            res = "FAIL"
        step(steps, f"cancel reliability ({n} repeats)", res, summary)

    # 8. restart + native restore
    if "restore" in want:
        old_session, old_caps = session_id, caps
        agent.shutdown()
        agent = new_agent("2")
        agent.start()
        state["agent"] = agent
        ok, _pv2, caps2, _res2 = do_initialize(agent, steps, record=False)
        if not ok:
            step(steps, "restart + native restore", "FAIL",
                 "re-initialize after restart failed or timed out")
            return
        if caps2.get("loadSession") is True:
            mark = len(agent.notifications)
            resp = agent.request("session/load",
                                 {"sessionId": old_session, "cwd": repo,
                                  "mcpServers": []}, timeout=REQUEST_TIMEOUT)
            nupd = sum(1 for m in agent.notifications[mark:]
                       if m.get("method") == "session/update")
            if resp is None:
                step(steps, "restart + native restore", "FAIL",
                     "timeout waiting for session/load response")
            elif "error" in resp:
                step(steps, "restart + native restore", "FAIL",
                     {"error": resp["error"]})
            else:
                step(steps, "restart + native restore",
                     "PASS" if nupd >= 1 else "FAIL",
                     {"replayed_session_updates": nupd,
                      "result_field_names":
                          sorted((resp.get("result") or {}).keys())})
        else:
            step(steps, "restart + native restore", "GAP",
                 {"reason": "loadSession not advertised",
                  "agentCapabilities": caps2})

    # 9. malformed input on the live (or restarted) process
    if "malformed" in want:
        alive_before = agent.alive()
        agent.errors.clear()
        agent.send_raw_line("{not json")
        resp = agent.request("session/new", {"cwd": repo, "mcpServers": []})
        step(steps, "malformed input",
             "PASS" if alive_before and agent.alive() and resp is not None
             and "error" not in resp else "FAIL",
             {"process_alive_after": agent.alive(),
              "valid_session_new_response": "timeout" if resp is None
              else ("error" if "error" in resp else "result"),
              "new_sessionId_present": bool(((resp or {}).get("result") or {})
                                            .get("sessionId")),
              "stderr_tail": tail(agent.stderr_path)})
def run_probe(args):
    adapter = ADAPTERS[args.label]
    started_at = now_iso()
    transcript, steps, state = [], [], {"agent": None}
    try:
        _drive(args, transcript, steps, state)
    except Exception:
        import traceback
        steps.append({"step": "probe error", "result": "FAIL",
                      "evidence": clean(traceback.format_exc(limit=15))})
    return finish(args, adapter, started_at, steps, transcript, state)


def finish(args, adapter, started_at, steps, transcript, state):
    agent = state.get("agent")
    if agent is not None:
        try:
            agent.kill()
        except Exception:
            pass
        lock = agent.transcript_lock
    else:
        lock = threading.Lock()
    with lock:
        excerpt = [clean(e) for e in transcript[:40]] \
            + [clean(e) for e in transcript[-20:]]
    results = {
        "label": args.label,
        "adapter_package": adapter["package"],
        "adapter_version": adapter["version"],
        "harness_version": detect_harness_version(args.label),
        "os": " ".join((os.uname().sysname, os.uname().release)),
        "python": sys.version.split()[0],
        "probe": "acp_probe.py " + PROBE_VERSION,
        "probe_options": {
            "steps": args.steps,
            "mode_id": args.mode_id,
            "set_config": [f"{c}={v}" for c, v in parse_set_config(args.set_config)],
            "cancel_repeats": args.cancel_repeats,
            "cancel_after_seconds": args.cancel_after,
            "agent_cmd": args.agent_cmd,
            "workdir_root": args.workdir_root,
        },
        "session_options": state.get("session_options"),
        "started_at": started_at,
        "finished_at": now_iso(),
        "steps": steps,
        "transcript_excerpt": excerpt,
    }
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, "w") as f:
        json.dump(clean(results), f, indent=2)
        f.write("\n")
    for s in steps:
        print(f"[{s['result']}] {s['step']}")
    print(f"wrote {args.out}")
    return 0


def main():
    ap = argparse.ArgumentParser(
        description="Raw-protocol ACP compatibility probe (stdlib only).")
    ap.add_argument("--agent-cmd", required=True,
                    help="absolute path to the ACP adapter executable")
    ap.add_argument("--label", required=True, choices=sorted(ADAPTERS),
                    help="adapter row under test")
    ap.add_argument("--out", required=True, help="results JSON output path")
    ap.add_argument("--workdir-root", required=True,
                    help="root for disposable <label>-repo fixtures and "
                         "<root>/logs/*.stderr transcripts")
    ap.add_argument("--steps", default=DEFAULT_STEPS,
                    help="comma list of step groups to run (default: "
                         + DEFAULT_STEPS + "). Groups: "
                         + ", ".join(STEP_GROUPS)
                         + ". initialize and session/new always run first.")
    ap.add_argument("--mode-id", default=None,
                    help="ACP v1 session/set_mode modeId to activate after "
                         "session/new (use an id from session/new modes.availableModes)")
    ap.add_argument("--set-config", action="append", default=[],
                    metavar="ID=VALUE",
                    help="ACP v1 session/set_config_option {configId, value}; "
                         "repeatable (e.g. --set-config mode=default)")
    ap.add_argument("--cancel-repeats", type=int, default=1,
                    help="run the cancel step N times in fresh sessions "
                         "(default 1); PASS only if all N returned "
                         "stopReason=cancelled")
    ap.add_argument("--cancel-after", type=float, default=5.0,
                    help="seconds after session/prompt before sending "
                         "session/cancel (default 5)")
    args = ap.parse_args()
    if not os.path.isabs(args.agent_cmd):
        ap.error("--agent-cmd must be an absolute path")
    if args.cancel_repeats < 1:
        ap.error("--cancel-repeats must be >= 1")
    try:
        parse_steps(args.steps)
        parse_set_config(args.set_config)
    except ValueError as exc:
        ap.error(str(exc))
    return run_probe(args)


if __name__ == "__main__":
    sys.exit(main())

