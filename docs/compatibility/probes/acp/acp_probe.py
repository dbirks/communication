#!/usr/bin/env python3
"""Raw-protocol ACP compatibility probe (M0 spike, D-016).

Launches an ACP adapter as a stdio subprocess (JSON-RPC 2.0, newline-delimited
JSON) using only the Python standard library, drives the reference client
steps from communication-spec/04-agent-runtime.md and the protocol
compatibility table in communication-spec/12-test-strategy.md, and writes a
redacted results JSON. This is the raw-protocol baseline the Go SDK adapter
must reproduce.

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

PROBE_VERSION = "0.0.1"
PROMPT_TIMEOUT = 180.0  # per prompt turn, seconds
REQUEST_TIMEOUT = 60.0  # non-prompt requests
CANCEL_RESPONSE_TIMEOUT = 30.0

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
}

SECRET_KEY_RE = re.compile(r"token|secret|key|authorization|cookie", re.I)
MAX_STR = 500


def now_iso():
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="milliseconds")


def clean(obj):
    """Deep-copy with secret-looking values redacted and long strings truncated."""
    if isinstance(obj, dict):
        return {k: ("[REDACTED]" if SECRET_KEY_RE.search(str(k)) else clean(v))
                for k, v in obj.items()}
    if isinstance(obj, list):
        return [clean(v) for v in obj]
    if isinstance(obj, str) and len(obj) > MAX_STR:
        return obj[:MAX_STR] + "...[TRUNCATED]"
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

    def _pick_option(self, options):
        for want in ("allow_once", "allow_always"):
            for opt in options:
                if isinstance(opt, dict) and opt.get("kind") == want:
                    return opt
        return None

    def _handle_agent_request(self, msg):
        method, mid = msg.get("method"), msg.get("id")
        if method == "session/request_permission":
            params = msg.get("params") or {}
            options = params.get("options") or []
            entry = {"t": now_iso(),
                     "tool_call": params.get("toolCall"),
                     "option_kinds": [o.get("kind") for o in options
                                      if isinstance(o, dict)],
                     "outcome": "cancelled"}
            opt = None if self.permission_mode == "cancel" \
                else self._pick_option(options)
            if opt is not None:
                oid = opt.get("optionId", opt.get("id"))
                entry["outcome"] = "selected:" + opt.get("kind", str(oid))
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


def _drive(args, transcript, steps, state):
    adapter = ADAPTERS[args.label]
    stderr_dir = os.path.join(os.path.expanduser("~"), ".cache",
                              "communication-lab", "m0-acp-probe")
    os.makedirs(stderr_dir, exist_ok=True)
    os.makedirs(args.workdir_root, exist_ok=True)
    repo = make_repo(args.workdir_root, args.label)

    def new_agent(tag):
        return AgentProcess([args.agent_cmd],
                            os.path.join(stderr_dir,
                                         f"{args.label}-{tag}-stderr.log"),
                            transcript)

    agent = new_agent("1")
    agent.start()
    state["agent"] = agent

    # 1. initialize
    ok, _pv, caps, _res = do_initialize(agent, steps)
    if not ok:
        return

    # 2. session/new
    resp = agent.request("session/new", {"cwd": repo, "mcpServers": []})
    session_id = None
    if resp is None:
        step(steps, "session/new", "FAIL", "timeout waiting for session/new response")
        return
    if "error" in resp:
        err = resp["error"]
        ev = {"error": err, "advertised_authMethods": (_res or {}).get("authMethods")}
        if re.search(r"auth", json.dumps(err), re.I):
            step(steps, "session/new", "FAIL",
                 dict(ev, reason="authentication required; run stopped, "
                      "no interactive login attempted"))
        else:
            step(steps, "session/new", "FAIL", ev)
        return
    session_id = (resp.get("result") or {}).get("sessionId")
    if session_id:
        step(steps, "session/new", "PASS",
             {"sessionId_prefix": str(session_id)[:8] + "…",
              "result_field_names": sorted((resp.get("result") or {}).keys())})
    else:
        step(steps, "session/new", "FAIL", {"result": resp.get("result")})
        return

    def prompt(text, timeout=PROMPT_TIMEOUT):
        mark = len(agent.notifications)
        perms_before = len(agent.permission_log)
        agent.permission_mode = "allow"
        rid = agent.begin("session/prompt",
                          {"sessionId": session_id,
                           "prompt": [{"type": "text", "text": text}]})
        return rid, mark, perms_before, time.monotonic()

    # 3. prompt + streaming + permission
    agent.errors.clear()
    rid, mark, perms_before, _t0 = prompt(
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
        step(steps, "streaming", "FAIL", "timeout waiting for session/prompt response")
        step(steps, "tool_calls", "FAIL", "timeout waiting for session/prompt response")
        step(steps, "permission", "FAIL", "timeout waiting for session/prompt response")
        return
    nchunk = summ["session_update_counts"].get("agent_message_chunk", 0)
    ncall = summ["session_update_counts"].get("tool_call", 0)
    step(steps, "streaming", "PASS" if nchunk >= 1 else "FAIL",
         dict(base_ev, agent_message_chunks=nchunk))
    step(steps, "tool_calls", "PASS" if ncall >= 1 else "FAIL",
         dict(base_ev, tool_calls=ncall))
    if len(perms) >= 1 and hstate["hello_txt_exists"]:
        step(steps, "permission", "PASS", base_ev)
    elif len(perms) == 0 and hstate["hello_txt_exists"]:
        step(steps, "permission", "GAP",
             dict(base_ev, reason="agent did not request permission under "
                  "default mode"))
    else:
        step(steps, "permission", "FAIL",
             dict(base_ev, reason="permission request flow or file creation "
                  "did not complete"))

    # 4. second turn
    rid, mark, _pb, _t0 = prompt("Reply with the single word SECOND.")
    resp = agent.wait(rid, PROMPT_TIMEOUT)
    summ = turn_summary(agent, mark, resp)
    if resp is None:
        step(steps, "second turn", "FAIL", "timeout waiting for session/prompt response")
    else:
        has_second = "SECOND" in summ["message_text"]
        step(steps, "second turn",
             "PASS" if summ["stopReason"] == "end_turn" and has_second else "FAIL",
             {"stopReason": summ["stopReason"], "saw_SECOND": has_second,
              "reply_excerpt": summ["message_text"][:200],
              "session_update_counts": summ["session_update_counts"]})

    # 5. cancel during long tool call
    agent.errors.clear()
    rid, mark, perms_before, t0 = prompt(
        "Run the shell command: sleep 60 ; then reply FINISHED.")
    time.sleep(5.0)
    agent.permission_mode = "cancel"  # new/pending permission requests get cancelled
    agent.notify("session/cancel", {"sessionId": session_id})
    t_cancel = time.monotonic()
    resp = agent.wait(rid, CANCEL_RESPONSE_TIMEOUT)
    agent.permission_mode = "allow"
    summ = turn_summary(agent, mark, resp)
    perms = agent.permission_log[perms_before:]
    elapsed_total = round((time.monotonic() - t0), 1)
    if resp is None:
        step(steps, "cancel", "FAIL",
             {"reason": "no prompt response within 30 s of session/cancel",
              "permission_requests": len(perms),
              "session_update_counts": summ["session_update_counts"]})
    else:
        step(steps, "cancel",
             "PASS" if summ["stopReason"] == "cancelled" else "FAIL",
             {"observed_stopReason": summ["stopReason"],
              "seconds_prompt_to_response": elapsed_total,
              "seconds_after_cancel": round(time.monotonic() - t_cancel, 1),
              "permission_requests": len(perms),
              "permission_outcomes": [p["outcome"] for p in perms]})

    # 6. restart + native restore
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
                  "result_field_names": sorted((resp.get("result") or {}).keys())})
    else:
        step(steps, "restart + native restore", "GAP",
             {"reason": "loadSession not advertised",
              "agentCapabilities": caps2})

    # 7. malformed input on the fresh process
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
    return finish(args, adapter, started_at, steps, transcript, state["agent"])


def finish(args, adapter, started_at, steps, transcript, agent):
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
                    help="root for disposable <label>-repo fixtures")
    args = ap.parse_args()
    if not os.path.isabs(args.agent_cmd):
        ap.error("--agent-cmd must be an absolute path")
    return run_probe(args)


if __name__ == "__main__":
    sys.exit(main())
