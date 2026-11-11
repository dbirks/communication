package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"strings"
	"testing"
	"time"
)

// TestACPEchoRefusesWithoutItsGate is the reason this command can ship inside the
// production image: without the variable naming it, the binary has no ACP agent
// in it, and it says so rather than serving one.
func TestACPEchoRefusesWithoutItsGate(t *testing.T) {
	t.Setenv(envACPMode, "")
	var out, errOut strings.Builder
	if code := runACPEcho(strings.NewReader(""), &out, &errOut); code != 2 {
		t.Fatalf("exit = %d, want 2 (refused), out=%q err=%q", code, out.String(), errOut.String())
	}
	if !strings.Contains(errOut.String(), envACPMode) {
		t.Errorf("refusal does not name its gate: %q", errOut.String())
	}
	if out.Len() != 0 {
		t.Errorf("a refused harness wrote to the protocol stream: %q", out.String())
	}
}

// TestACPEchoAnswersTheHandshake drives the echo exactly as a peer does — one
// JSON-RPC object per line on stdin, answers on stdout — so what is proven is the
// wire contract ADR-0082 spike S2 depends on: initialize, session/new, and a
// prompt turn that streams its message chunk before it stops.
func TestACPEchoAnswersTheHandshake(t *testing.T) {
	t.Setenv(envACPMode, "1")
	t.Setenv(envACPModeProbe, "delivered-by-secret-file")

	agentIn, toAgent := io.Pipe()    // the test writes toAgent; the echo reads agentIn
	fromAgent, agentOut := io.Pipe() // the echo writes agentOut; the test reads fromAgent
	done := make(chan int, 1)
	send := func(line string) {
		if _, err := io.WriteString(toAgent, line+"\n"); err != nil {
			t.Errorf("write to the echo: %v", err)
		}
	}
	go func() {
		done <- runACPEcho(agentIn, agentOut, io.Discard)
	}()

	// Handshake first, then the turn: the prompt must name the session the agent
	// handed back, which is the ordering a real client (internal/agent/acp.handle)
	// uses and the one spike S2 is a proof about.
	send(`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{"fs":{"readTextFile":false,"writeTextFile":false},"terminal":false}}}`)
	send(`{"jsonrpc":"2.0","id":2,"method":"session/new","params":{"cwd":"/data/workspaces/run/abc","mcpServers":[]}}`)
	lines := readLines(fromAgent, 2, 5*time.Second)
	byID := map[string]map[string]any{}
	for _, line := range lines {
		var msg map[string]any
		if err := json.Unmarshal([]byte(line), &msg); err != nil {
			t.Fatalf("echo wrote a line that is not JSON-RPC: %q", line)
		}
		if id, ok := msg["id"]; ok {
			byID[fmt.Sprintf("%v", id)] = msg
		}
	}

	init := byID["1"]
	if init == nil || init["error"] != nil {
		t.Fatalf("initialize was not answered: %v", lines)
	}
	result := init["result"].(map[string]any)
	if result["protocolVersion"].(float64) != 1 {
		t.Errorf("initialize protocolVersion = %v, want 1", result["protocolVersion"])
	}
	if info, ok := result["agentInfo"].(map[string]any); !ok || info["name"] != acpEchoName {
		t.Errorf("initialize agentInfo = %v, want the echo to name itself", result["agentInfo"])
	}

	newSession := byID["2"]
	if newSession == nil {
		t.Fatalf("session/new was not answered within the deadline: %v", lines)
	}
	if newSession["error"] != nil {
		t.Fatalf("session/new refused: %v", newSession["error"])
	}
	sessionID, _ := newSession["result"].(map[string]any)["sessionId"].(string)
	if sessionID == "" {
		t.Fatalf("session/new returned no sessionId: %v", newSession["result"])
	}

	send(`{"jsonrpc":"2.0","id":3,"method":"session/prompt","params":{"sessionId":` + jsonQuote(sessionID) + `,"prompt":[{"type":"text","text":"hello from kind"}]}}`)
	// The turn's two messages: the streamed chunk, then the answer that ended it.
	lines = append(lines, readLines(fromAgent, 2, 5*time.Second)...)
	var notifications []map[string]any
	for _, line := range lines {
		var msg map[string]any
		if err := json.Unmarshal([]byte(line), &msg); err != nil {
			t.Fatalf("echo wrote a line that is not JSON-RPC: %q", line)
		}
		if id, ok := msg["id"]; ok {
			byID[fmt.Sprintf("%v", id)] = msg
			continue
		}
		notifications = append(notifications, msg)
	}

	prompt := byID["3"]
	if prompt == nil {
		t.Fatalf("session/prompt was never answered: %v", lines)
	}
	if prompt["error"] != nil {
		t.Fatalf("session/prompt refused: %v", prompt["error"])
	}
	if got := prompt["result"].(map[string]any)["stopReason"]; got != "end_turn" {
		t.Errorf("prompt stopReason = %v, want end_turn", got)
	}

	// The turn streamed its answer as an agent_message_chunk before stopping, and
	// the chunk carries the probe value: the only way that value reaches the agent
	// is as a file in the per-attempt Secret (ADR-0082 Decision 6).
	var chunks []string
	for _, n := range notifications {
		if n["method"] != "session/update" {
			continue
		}
		params, _ := n["params"].(map[string]any)
		update, _ := params["update"].(map[string]any)
		// The union is flattened on the wire with a `sessionUpdate` discriminator
		// (what the SDK's own session/update encoder writes), which is what the
		// client's handle.SessionUpdate reads back.
		if kind, _ := update["sessionUpdate"].(string); kind != "agent_message_chunk" {
			continue
		}
		content, _ := update["content"].(map[string]any)
		if text, ok := content["text"].(string); ok {
			chunks = append(chunks, text)
		}
	}
	if len(chunks) != 1 {
		t.Fatalf("agent_message_chunk count = %d, want the one reply the echo streams: %v", len(chunks), notifications)
	}
	for _, want := range []string{"hello from kind", "delivered-by-secret-file", acpEchoName} {
		if !strings.Contains(chunks[0], want) {
			t.Errorf("reply %q does not quote %q", chunks[0], want)
		}
	}
	if !strings.Contains(chunks[0], sessionID) {
		t.Errorf("reply %q is not about the session the client opened (%q)", chunks[0], sessionID)
	}

	// Closing the peer ends the connection, and with it the process's role.
	_ = agentIn.Close()
	select {
	case code := <-done:
		if code != 0 {
			t.Errorf("acp-echo exited %d after its peer hung up, want 0", code)
		}
	case <-time.After(5 * time.Second):
		t.Error("acp-echo was still running five seconds after its peer closed stdin")
	}
}

// jsonQuote renders a Go string as a JSON string literal, so a session id built
// from a cwd is inserted into a request the way encoding/json would.
func jsonQuote(s string) string {
	b, err := json.Marshal(s)
	if err != nil {
		return `""`
	}
	return string(b)
}

// readLines waits for n protocol lines, failing rather than hanging the suite.
func readLines(r io.Reader, n int, timeout time.Duration) []string {
	goal := make(chan []string, 1)
	go func() {
		scanner := bufio.NewScanner(r)
		scanner.Buffer(make([]byte, 1<<20), 1<<20)
		out := make([]string, 0, n)
		for len(out) < n && scanner.Scan() {
			if line := strings.TrimSpace(scanner.Text()); line != "" {
				out = append(out, line)
			}
		}
		goal <- out
	}()
	select {
	case out := <-goal:
		if len(out) < n {
			return out
		}
		return out
	case <-time.After(timeout):
		return nil
	}
}
