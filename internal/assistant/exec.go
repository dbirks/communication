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
	if !b.announced(name) {
		// A tool this deployment does not announce is a tool it cannot answer:
		// the honest refusal is the same one an unknown name gets, and it makes
		// zero store calls, so an optional read that was never wired cannot be
		// reached by a model that invented its wire name.
		t.refused(name, nil, "unknown_tool")
		b.logger().Info("assistant tool refused", slog.String("tool", name), slog.String("reason", "unknown_tool"))
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
	payload, _ := capPayloadTo(raw, tl.resultCap())
	ok := ToolCall{Name: name, Args: args, OK: true, Summary: execSummary(name, args, raw)}
	t.record(ok, payload)
	// Two payload shapes, two link derivations: a tool whose rows come back as
	// an array derives them from the rows; the one tool whose payload is a
	// single assembled object (the catch-up brief) reads its own sections.
	// Both then pass the same allowlist, and a rejected href is counted rather
	// than rendered — the design's "records the drop" — so a probe cannot use
	// the answer surface to enumerate routes. The rejected href itself is not
	// logged either, for the same reason.
	var links []Link
	switch {
	case tl.linksRaw != nil:
		links = tl.linksRaw(t, args, payload)
	case tl.links != nil:
		links = tl.links(t, args, rows(payload))
	}
	for _, l := range links {
		href, allowed := b.allowedHref(l.Href)
		if !allowed {
			t.dropped++
			continue
		}
		l.Href = href
		t.links = append(t.links, l)
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
		if project := strArg(args, "project_id"); project != "" {
			s = fmt.Sprintf("Listed %d runs for project %s", n, short(project))
		} else {
			s = fmt.Sprintf("Listed %d runs across the caller's projects", n)
		}
	case "run.nodes":
		s = fmt.Sprintf("Read %d node executions for run %s", n, short(strArg(args, "run_id")))
	case "approval.pending":
		if project := strArg(args, "project_id"); project != "" {
			s = fmt.Sprintf("Listed %d pending approvals for project %s", n, short(project))
		} else {
			s = fmt.Sprintf("Listed %d pending approvals across the caller's projects", n)
		}
	case "pipeline.revisions":
		s = fmt.Sprintf("Listed %d published revisions for pipeline %s", n, short(strArg(args, "pipeline_id")))
	case "thread.list":
		// The transparency line says THREAD, the /threads page's word (finding
		// F-7): a person reading the disclosure should not learn a new noun.
		if launcher := strArg(args, "launcher"); launcher != "" {
			s = fmt.Sprintf("Listed %d threads from launcher %s", n, bounded(launcher, 32))
		} else if project := strArg(args, "project_id"); project != "" {
			s = fmt.Sprintf("Listed %d threads for project %s", n, short(project))
		} else {
			s = fmt.Sprintf("Listed %d agent threads across the caller's projects", n)
		}
	case "palette.search":
		s = fmt.Sprintf("Found %d matches for %q", n, bounded(strArg(args, "needle"), 60))
	case "catchup.brief":
		// The brief is one object, not a row count: the line names the window
		// the answer is about, which is the fact a reader of the transcript
		// needs ("the 24h brief", not "1 result").
		s = fmt.Sprintf("Read the %s catch-up brief", catchUpBriefWindowLabel(args, raw))
	default:
		s = fmt.Sprintf("Read %d results from %s", n, name)
	}
	return bounded(s, 200)
}

// catchUpBriefWindowLabel names the window the brief answered: the assembler's
// own `window.key` when the payload carries it (the window the interval was
// resolved for, which for `unseen` is what the reader actually got), else the
// window the model asked for, else the default the tool applies.
func catchUpBriefWindowLabel(args map[string]any, raw json.RawMessage) string {
	var body struct {
		Window struct {
			Key string `json:"key"`
		} `json:"window"`
	}
	if err := json.Unmarshal(raw, &body); err == nil && strings.TrimSpace(body.Window.Key) != "" {
		return bounded(body.Window.Key, 16)
	}
	if window := strArg(args, "window"); window != "" {
		return bounded(window, 16)
	}
	return "unseen"
}

// strArg is one validated string argument of a call (bounded like parseArgs
// leaves it).
func strArg(args map[string]any, key string) string {
	s, _ := args[key].(string)
	return bounded(strings.TrimSpace(s), 200)
}

// truncatedMarker is the cut's receipt on an array payload.
var truncatedMarker = json.RawMessage(
	`{"truncated":true,"note":"rows beyond the 64 item / 2 KiB cap are not shown; the list is not complete"}`)

// capPayload enforces the ≤64 items / ≤2 KB per result rule and reports the
// cut instead of hiding it.
func capPayload(raw json.RawMessage) (json.RawMessage, bool) {
	return capPayloadTo(raw, MaxResultBytes)
}

// capPayloadTo is capPayload with one tool's own byte budget. The registry
// default is MaxResultBytes; the tool that names a larger one justifies it at
// its own definition (maxCatchUpBriefBytes), so the budget is still a constant
// the code owns rather than a thing a response can widen.
func capPayloadTo(raw json.RawMessage, maxBytes int) (json.RawMessage, bool) {
	if maxBytes <= 0 {
		maxBytes = MaxResultBytes
	}
	if len(raw) == 0 {
		return json.RawMessage(`[]`), false
	}
	var arr []json.RawMessage
	if err := json.Unmarshal(raw, &arr); err != nil {
		return boundedJSONTo(raw, maxBytes), len(raw) > maxBytes
	}
	truncated := false
	if len(arr) > MaxItems {
		arr, truncated = arr[:MaxItems], true
	}
	out, err := json.Marshal(arr)
	if err != nil {
		return json.RawMessage(`[]`), truncated
	}
	if len(out) <= maxBytes && !truncated {
		return out, false
	}
	truncated = true
	for len(arr) >= 0 {
		trimmed, err := json.Marshal(append(append([]json.RawMessage{}, arr...), truncatedMarker))
		if err == nil && len(trimmed) <= maxBytes {
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
	return boundedJSONTo(raw, MaxResultBytes)
}

// boundedJSONTo is boundedJSON at one tool's own budget.
func boundedJSONTo(raw json.RawMessage, maxBytes int) json.RawMessage {
	if len(raw) <= maxBytes {
		return raw
	}
	return json.RawMessage(fmt.Sprintf(`{"truncated":true,"data":%q}`, string(bounded(string(raw), maxBytes-64))))
}
