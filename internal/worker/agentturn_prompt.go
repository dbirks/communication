package worker

import (
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"
)

// Prompt assembly for the output contract (ADR-0022 § 4 rule 2, ADR-0023 § 6).
//
// The boundary judges an agent.acp reply against the node's DECLARED outputs
// schema; before this file the agent never saw that schema and never learned
// why a reply was refused (lab live16: three attempts, each over the declared
// maxLength, each answered the same prompt). Two rules follow:
//
//  1. Every agent.acp prompt states the declared schema's machine-checked
//     constraints (types, required names, enums, length bounds) up front, so
//     attempt 1 can answer compliantly.
//  2. When the PREVIOUS attempt failed invalid_output, the retry_context
//     carries validation_errors ({path, rule, got, want} — schema sentences
//     only, never secret material); each is named verbatim in the next prompt
//     so the agent corrects the field that broke instead of repeating it.
//
// Both sections are bounded: the whole decoration caps at maxPromptDecoration
// bytes, so a hostile schema cannot grow the prompt without limit.

const (
	maxPromptDecoration   = 4096
	maxConstraintLines    = 32
	maxFeedbackLines      = 8 // mirrors runtime.maxRetryValidationErrors
	maxEnumValues         = 12
	maxFeedbackFieldChars = 200
)

// decorateAgentPrompt returns the prompt actually sent to the session: the
// plan's prompt plus (a) the declared output constraints and (b), on a retry
// whose predecessor was schema-refused, the validation feedback.
func decorateAgentPrompt(prompt string, c AttemptClaim) string {
	var b strings.Builder
	b.WriteString(prompt)
	if sec := outputConstraintsSection(c.OutputsSchema); sec != "" {
		b.WriteString("\n\n")
		b.WriteString(sec)
	}
	if sec := validationFeedbackSection(c.RetryContext); sec != "" {
		b.WriteString("\n\n")
		b.WriteString(sec)
	}
	out := b.String()
	budget := maxPromptDecoration
	if dec := len(out) - len(prompt); dec > budget {
		cut := len(prompt) + budget
		for cut > len(prompt) && !utf8.ValidString(out[:cut]) {
			cut--
		}
		out = out[:cut]
	}
	return out
}

// outputConstraintsSection renders the machine-checkable promises of the
// node's declared outputs schema. A schema this function cannot read (nil,
// non-object, no properties) yields "" — the plan promises nothing the agent
// is told about, which is honest, never a fabricated summary.
func outputConstraintsSection(schema any) string {
	obj, ok := jsonMap(schema)
	if !ok {
		return ""
	}
	var lines []string
	walkSchemaObject(obj, "", 1, &lines)
	if len(lines) == 0 {
		return ""
	}
	if len(lines) > maxConstraintLines {
		lines = lines[:maxConstraintLines]
	}
	return "Output schema constraints (your reply is machine-checked against them; a violating reply fails the attempt as invalid_output):\n" +
		strings.Join(lines, "\n")
}

func walkSchemaObject(obj map[string]any, prefix string, depth int, lines *[]string) {
	if depth > 3 || len(*lines) >= maxConstraintLines {
		return
	}
	props, _ := jsonMap(obj["properties"])
	if len(props) == 0 {
		return
	}
	required := stringSet(obj["required"])
	names := make([]string, 0, len(props))
	for name := range props {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		if len(*lines) >= maxConstraintLines {
			return
		}
		path := name
		if prefix != "" {
			path = prefix + "." + name
		}
		prop, _ := jsonMap(props[name])
		if prop == nil {
			continue
		}
		*lines = append(*lines, "- "+path+": "+describeConstraints(prop, required[name]))
		// Descend one structure level so nested rules are visible too:
		// object properties and array-of-object items.
		if typeIs(prop, "object") {
			walkSchemaObject(prop, path, depth+1, lines)
			continue
		}
		if items, _ := jsonMap(prop["items"]); items != nil && typeIs(items, "object") {
			walkSchemaObject(items, path+"[]", depth+1, lines)
		}
	}
}

func describeConstraints(prop map[string]any, req bool) string {
	parts := make([]string, 0, 6)
	if t := typeOf(prop); t != "" {
		parts = append(parts, t)
	}
	if req {
		parts = append(parts, "required")
	}
	if enum, _ := jsonList(prop["enum"]); len(enum) > 0 {
		shown := enum
		if len(shown) > maxEnumValues {
			shown = shown[:maxEnumValues]
		}
		vals := make([]string, 0, len(shown))
		for _, v := range shown {
			vals = append(vals, jsonScalar(v))
		}
		parts = append(parts, "one of ["+strings.Join(vals, ", ")+"]")
	}
	for _, kw := range []struct{ key, label string }{
		{"minLength", "minLength"}, {"maxLength", "maxLength"},
		{"minItems", "minItems"}, {"maxItems", "maxItems"},
		{"pattern", "pattern"}, {"format", "format"},
	} {
		if v, ok := prop[kw.key]; ok {
			if s, _ := jsonScalarOr(v); s != "" {
				parts = append(parts, kw.label+" "+s)
			}
		}
	}
	for _, kw := range []struct{ key, label string }{
		{"minimum", "minimum"}, {"maximum", "maximum"},
	} {
		if v, ok := prop[kw.key]; ok {
			if s, ok2 := numberScalar(v); ok2 {
				parts = append(parts, kw.label+" "+s)
			}
		}
	}
	if len(parts) == 0 {
		return "any JSON value"
	}
	return strings.Join(parts, ", ")
}

// validationFeedbackSection turns retry_context.validation_errors into the
// correction note. It states the facts the block already holds — path, rule,
// got, want — in one sentence each; it never re-derives or editorialises
// beyond "reply again".
func validationFeedbackSection(retryCtx map[string]any) string {
	if retryCtx == nil {
		return ""
	}
	errs, _ := jsonList(retryCtx["validation_errors"])
	if len(errs) == 0 {
		return ""
	}
	if len(errs) > maxFeedbackLines {
		errs = errs[:maxFeedbackLines]
	}
	clauses := make([]string, 0, len(errs))
	for _, e := range errs {
		m, _ := jsonMap(e)
		if m == nil {
			continue
		}
		path, _ := m["path"].(string)
		rule, _ := m["rule"].(string)
		if path == "" || rule == "" {
			continue
		}
		path = capField(path)
		rule = capField(rule)
		got, _ := capScalar(m["got"])
		want, _ := capScalar(m["want"])
		msg, _ := m["message"].(string)
		switch rule {
		case "maxLength":
			clauses = append(clauses, fmt.Sprintf("%s exceeded maxLength (got %s, want at most %s)", path, got, want))
		case "minLength":
			clauses = append(clauses, fmt.Sprintf("%s fell below minLength (got %s, want at least %s)", path, got, want))
		case "required":
			clauses = append(clauses, fmt.Sprintf("%s is missing a required value (%s)", path, capField(msg)))
		case "type":
			clauses = append(clauses, fmt.Sprintf("%s has the wrong type (got %s, want %s)", path, got, want))
		case "enum":
			clauses = append(clauses, fmt.Sprintf("%s is not an allowed value (%s)", path, capField(msg)))
		default:
			line := fmt.Sprintf("%s violated %s", path, rule)
			if got != "" || want != "" {
				line += fmt.Sprintf(" (got %s, want %s)", got, want)
			} else if msg != "" {
				line += fmt.Sprintf(" (%s)", capField(msg))
			}
			clauses = append(clauses, line)
		}
	}
	if len(clauses) == 0 {
		return ""
	}
	return "Your previous reply was rejected: " + strings.Join(clauses, "; ") +
		". Reply again, keeping every field within its declared output constraints."
}

// ------------------------------------------------------------- JSON helpers
//
// The claim carries the plan snapshot (decoding: float64/json.Number for
// numbers) and the retry_context (decoding: float64) as plain JSON values, so
// this file never imports the runtime package — same rule as the rest of
// attemptport.go's vocabulary.

func jsonMap(v any) (map[string]any, bool) {
	m, ok := v.(map[string]any)
	return m, ok
}

func jsonList(v any) ([]any, bool) {
	l, ok := v.([]any)
	return l, ok
}

func stringSet(v any) map[string]bool {
	set := map[string]bool{}
	items, _ := jsonList(v)
	for _, it := range items {
		if s, ok := it.(string); ok {
			set[s] = true
		}
	}
	return set
}

func typeIs(prop map[string]any, want string) bool {
	return typeOf(prop) == want
}

func typeOf(prop map[string]any) string {
	switch t := prop["type"].(type) {
	case string:
		return t
	case []any:
		names := make([]string, 0, len(t))
		for _, v := range t {
			if s, ok := v.(string); ok {
				names = append(names, s)
			}
		}
		return strings.Join(names, "|")
	}
	return ""
}

// jsonScalar renders one JSON scalar for the enum list.
func jsonScalar(v any) string {
	switch t := v.(type) {
	case string:
		return strconv.Quote(capField(t))
	case bool:
		return strconv.FormatBool(t)
	case float64:
		return formatNumber(t)
	case json.Number:
		return t.String()
	case int64:
		return strconv.FormatInt(t, 10)
	case nil:
		return "null"
	default:
		return "?"
	}
}

func jsonScalarOr(v any) (string, bool) {
	s, ok := capScalar(v)
	if ok {
		return s, true
	}
	if b, isBool := v.(bool); isBool {
		return strconv.FormatBool(b), true
	}
	return "", false
}

func capScalar(v any) (string, bool) {
	switch t := v.(type) {
	case string:
		return capField(t), true
	case float64:
		return formatNumber(t), true
	case json.Number:
		return t.String(), true
	case int64:
		return strconv.FormatInt(t, 10), true
	}
	return "", false
}

func numberScalar(v any) (string, bool) { return capScalar(v) }

func formatNumber(f float64) string { return strconv.FormatFloat(f, 'g', -1, 64) }

func capField(s string) string {
	s = strings.ReplaceAll(strings.TrimSpace(s), "\n", " ")
	if len(s) > maxFeedbackFieldChars {
		s = s[:maxFeedbackFieldChars]
	}
	return s
}
