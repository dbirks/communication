package assistant

import (
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
)

// toolOutcome is one executed call: the client-facing record plus the payload
// the model sees back. The payload never reaches the browser — the response
// documents the call, not the rows (docs/design/assistant-v1.md: tool_calls is
// transparency, not a replay log).
type toolOutcome struct {
	call    ToolCall
	payload json.RawMessage
}

// writeVerbs name, for the record, why a tool the model asked for was refused:
// v1's registry has no write entry at all, so a write-shaped name gets its own
// reason code rather than the generic one.
var writeVerbs = []string{"create", "put", "post", "patch", "delete", "remove", "publish", "decide",
	"approve", "reject", "cancel", "retry", "pause", "resume", "start", "stop", "write", "add", "update"}

func claimedName(t *turn, call toolCallRequest) string {
	name := bounded(strings.TrimSpace(call.Function.Name), 80)
	if name == "" {
		name = "unnamed"
	}
	return name
}

// isWriteShaped reports whether a name asks for a mutation, by segment:
// "run.cancel" and "cancel_run" both do.
func isWriteShaped(name string) bool {
	lower := strings.ToLower(name)
	for _, verb := range writeVerbs {
		for _, part := range []string{".", "_", "-"} {
			for _, seg := range strings.Split(lower, part) {
				if seg == verb || strings.HasPrefix(seg, verb+"e") || strings.HasPrefix(seg, verb+"s") {
					return true
				}
			}
		}
	}
	return false
}

// refused records a call that made zero store calls, with no data and no
// resource name (the 404 rule); its summary names the stable reason only.
func (t *turn) refused(name string, args map[string]any, reason string) {
	t.record(ToolCall{Name: name, Args: args, OK: false, Reason: reason,
		Summary: refusedSummary(reason)}, nil)
}

func (t *turn) record(call ToolCall, payload json.RawMessage) {
	t.calls = append(t.calls, call)
	t.results = append(t.results, toolOutcome{call: call, payload: payload})
}

// exec runs one requested call through the closed registry. Every store read
// happens with t.caller, so the route's own authorization rule is the
// assistant's rule.
func (t *turn) exec(call toolCallRequest) {
	b := t.b
	name := claimedName(t, call)
	// The model answered with the wire name it was announced with; decode it
	// back to the registry name through the map built from the same registry.
	// An unknown wire name falls through to the unknown-tool refusal below,
	// exactly as an unknown registry name does today.
	if reg, ok := b.wire[name]; ok {
		name = reg
	}
	tl, known := b.tools[name]
	if !known {
		reason := "unknown_tool"
		if isWriteShaped(name) {
			reason = "write_not_allowed"
		}
		t.refused(name, nil, reason)
		b.logger().Info("assistant tool refused", slog.String("tool", name), slog.String("reason", reason))
		return
	}
	args, err := parseArgs(tl, call.Function.Arguments)
	if err != nil {
		t.refused(name, nil, "bad_arguments")
		return
	}
	t.toolRuns++
	raw, err := tl.read(t, args)
	if err != nil {
		reason := "unavailable"
		switch {
		case errors.Is(err, ErrNotFound):
			// The 404 rule of internal/api/conversations.go: the caller may not
			// know this exists. No rows and no name, so the answer has nothing
			// with which to leak one.
			reason = "not_found"
		case errors.Is(err, ErrForbidden):
			reason = "forbidden"
		}
		t.refused(name, args, reason)
		b.logger().Info("assistant tool denied", slog.String("tool", name), slog.String("reason", reason))
		return
	}
	payload, _ := capPayload(raw)
	ok := ToolCall{Name: name, Args: args, OK: true, Summary: execSummary(name, args, raw)}
	t.record(ok, payload)
	if tl.links != nil {
		for _, l := range tl.links(t, args, rows(payload)) {
			if href, allowed := b.allowedHref(l.Href); allowed {
				l.Href = href
				t.links = append(t.links, l)
			} else {
				// The design's "records the drop": counted and logged, never
				// rendered. The rejected href itself is not logged either, so a
				// probe cannot use the answer surface to enumerate routes.
				t.dropped++
			}
		}
	}
}

// refusedSummary is the transparency line of a call that never executed:
// it names the stable reason code and, per ADR-0034's 404 rule, no rows
// and no resource name — so a refusal can be read without leaking that a
// project the caller cannot see even exists.
func refusedSummary(reason string) string {
	if reason == "" {
		reason = "unknown"
	}
	return bounded("Not executed: "+reason, 200)
}

// execSummary writes the transparency line of one executed call, from the
// tool name, the validated arguments and the row count — never by the model
// and never from raw row content (docs/design/assistant-v1.md: tool_calls is
// transparency, not a replay log).
func execSummary(name string, args map[string]any, raw json.RawMessage) string {
	n := len(rows(raw))
	var s string
	switch name {
	case "project.list":
		s = fmt.Sprintf("Listed %d projects", n)
	case "run.list":
		s = fmt.Sprintf("Listed %d runs for project %s", n, short(strArg(args, "project_id")))
	case "run.nodes":
		s = fmt.Sprintf("Read %d node executions for run %s", n, short(strArg(args, "run_id")))
	case "approval.pending":
		s = fmt.Sprintf("Listed %d pending approvals for project %s", n, short(strArg(args, "project_id")))
	case "pipeline.revisions":
		s = fmt.Sprintf("Listed %d published revisions for pipeline %s", n, short(strArg(args, "pipeline_id")))
	case "palette.search":
		s = fmt.Sprintf("Found %d matches for %q", n, bounded(strArg(args, "needle"), 60))
	default:
		s = fmt.Sprintf("Read %d results from %s", n, name)
	}
	return bounded(s, 200)
}

// strArg is one validated string argument of a call (bounded like parseArgs
// leaves it).
func strArg(args map[string]any, key string) string {
	s, _ := args[key].(string)
	return bounded(strings.TrimSpace(s), 200)
}

var truncatedMarker = json.RawMessage(
	`{"truncated":true,"note":"rows beyond the 64 item / 2 KiB cap are not shown; the list is not complete"}`)

// capPayload enforces the ≤64 items / ≤2 KB per result rule and reports the
// cut instead of hiding it.
func capPayload(raw json.RawMessage) (json.RawMessage, bool) {
	if len(raw) == 0 {
		return json.RawMessage(`[]`), false
	}
	var arr []json.RawMessage
	if err := json.Unmarshal(raw, &arr); err != nil {
		return boundedJSON(raw), false
	}
	truncated := false
	if len(arr) > MaxItems {
		arr, truncated = arr[:MaxItems], true
	}
	out, err := json.Marshal(arr)
	if err != nil {
		return json.RawMessage(`[]`), truncated
	}
	if len(out) <= MaxResultBytes && !truncated {
		return out, false
	}
	truncated = true
	for len(arr) >= 0 {
		trimmed, err := json.Marshal(append(append([]json.RawMessage{}, arr...), truncatedMarker))
		if err == nil && len(trimmed) <= MaxResultBytes {
			return trimmed, true
		}
		if len(arr) == 0 {
			break
		}
		arr = arr[:len(arr)-1]
	}
	return append(json.RawMessage(nil), truncatedMarker...), true
}

// boundedJSON clips a non-array payload to the per-result byte cap.
func boundedJSON(raw json.RawMessage) json.RawMessage {
	if len(raw) <= MaxResultBytes {
		return raw
	}
	return json.RawMessage(fmt.Sprintf(`{"truncated":true,"data":%q}`, string(bounded(string(raw), MaxResultBytes-64))))
}
