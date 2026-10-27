package assistant

// Tests for the one answer-shape helper every text-only turn shares
// (prose.go): the reasoning-block / fence shapes a live thinking model puts in
// front of the JSON object it was asked for, and the bounded excerpt that makes
// an unforeseen shape diagnosable. The literal reasoning tags are assembled
// from the package constants here too — never typed.

import (
	"strings"
	"testing"
	"unicode"
	"unicode/utf8"
)

// openTag is the complete opening reasoning tag (thinkOpen is its prefix).
const openTag = thinkOpen + ">"

// labAnswer is the object the lab's issue2 A8 turn asked for and, in the
// passing case, got: an insert_on_edge splitting the probe draft's
// approve -> build_until_verified edge.
const labAnswer = `{"op":"insert_on_edge","from":"approve","to":"build_until_verified","kind":"model.chat","id":"check_plan","config":{"prompt":"review the plan"},"summary":"Adds a plan check between approval and the build loop"}`

const jsonObject = `{"summary":"one","actions":[]}`

func TestStripModelProse(t *testing.T) {
	cases := []struct {
		name    string
		raw     string
		want    string
		wantErr string
	}{
		{name: "plain object", raw: jsonObject, want: jsonObject},
		{name: "surrounding whitespace", raw: "  \n\t" + jsonObject + "\n ", want: jsonObject},
		{name: "leading BOM", raw: "\ufeff" + jsonObject, want: jsonObject},
		{name: "BOM and whitespace before the object", raw: "\ufeff \n\ufeff" + jsonObject, want: jsonObject},
		{name: "trailing BOM", raw: jsonObject + "\ufeff\n", want: jsonObject},
		{name: "zero-width space and nbsp", raw: "\u00a0\u200b" + jsonObject, want: jsonObject},
		{
			name: "reasoning block opened and closed",
			raw:  openTag + "\nlet me look at the graph...\n" + thinkClose + jsonObject,
			want: jsonObject,
		},
		{
			name: "reasoning block opened inline",
			raw:  openTag + "hmm" + thinkClose + jsonObject,
			want: jsonObject,
		},
		{
			// The cc1acd1 A8 shape: the chat template emitted the opening
			// tag into the prompt, so the completion is reasoning text
			// closed by a bare THINK-CLOSE tag.
			name: "bare close tag with no opening tag",
			raw:  "I need to split the edge between approve and the build loop." + thinkClose + jsonObject,
			want: jsonObject,
		},
		{
			name: "bare close tag with only whitespace before it",
			raw:  "\ufeff\n" + thinkClose + jsonObject,
			want: jsonObject,
		},
		{
			name: "bare close tag then a fence",
			raw:  "reasoning" + thinkClose + "\n```json\n" + jsonObject + "\n```",
			want: jsonObject,
		},
		{
			name: "two opened blocks in a row",
			raw:  openTag + "first" + thinkClose + openTag + "second" + thinkClose + jsonObject,
			want: jsonObject,
		},
		{
			name: "opened block then a bare close tag",
			raw:  openTag + "first" + thinkClose + "more reasoning" + thinkClose + jsonObject,
			want: jsonObject,
		},
		{
			name: "two bare close tags",
			raw:  "reason" + thinkClose + "more" + thinkClose + jsonObject,
			want: jsonObject,
		},
		{
			name: "three blocks with whitespace between them",
			raw:  openTag + "a" + thinkClose + "\n\ufeff\n" + "b" + thinkClose + "\n" + openTag + "c" + thinkClose + "\n" + jsonObject,
			want: jsonObject,
		},
		{name: "json fence", raw: "```json\n" + jsonObject + "\n```", want: jsonObject},
		{name: "bare fence", raw: "```\n" + jsonObject + "\n```", want: jsonObject},
		{
			name: "fence around a reasoning block",
			raw:  "```json\n" + openTag + "inside" + thinkClose + jsonObject + "\n```",
			want: jsonObject,
		},
		{
			// A close tag INSIDE the answer is content, never a cut point.
			name: "close tag inside a string member stays put",
			raw:  `{"op":"update_prompt","node":"plan","prompt":"end ` + thinkClose + ` here"}`,
			want: `{"op":"update_prompt","node":"plan","prompt":"end ` + thinkClose + ` here"}`,
		},
		{
			name: "array answer stays put",
			raw:  "[" + labAnswer + "]",
			want: "[" + labAnswer + "]",
		},
		{
			// Prose with no reasoning tag is NOT scraped: the decoder
			// refuses, and the refusal carries the excerpt.
			name: "plain prose answer is untouched",
			raw:  "Sure! Here is the change you asked for.",
			want: "Sure! Here is the change you asked for.",
		},
		{
			name: "prose closed by a bare close tag then prose still refuses to decode",
			raw:  "reasoning" + thinkClose + "here you go: " + jsonObject,
			want: "here you go: " + jsonObject,
		},
		{
			name:    "opened block that never closes",
			raw:     openTag + "still reasoning",
			wantErr: "never closes",
		},
		{
			name:    "fence with no body",
			raw:     "```json",
			wantErr: "fenced answer has no body",
		},
		{
			name:    "fence never closed",
			raw:     "```json\n" + jsonObject,
			wantErr: "fenced answer is not closed",
		},
		{
			name:    "more wrappers than the peel budget",
			raw:     strings.Repeat(openTag+"x"+thinkClose, maxProseWraps+1) + jsonObject,
			wantErr: "more reasoning blocks or code fences",
		},
		{name: "empty answer", raw: "", want: ""},
		{name: "whitespace and BOM only", raw: " \ufeff ", want: ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := stripModelProse(tc.raw)
			if tc.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
					t.Fatalf("stripModelProse(%q) = %q, %v; want an error naming %q", tc.raw, got, err, tc.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatalf("stripModelProse(%q): %v", tc.raw, err)
			}
			if got != tc.want {
				t.Fatalf("stripModelProse(%q) = %q, want %q", tc.raw, got, tc.want)
			}
		})
	}
}

// TestExtractProposalLabReasoningShapes walks the exact answers the live
// gateway produced for issue2 A8 (a thinking model whose opening reasoning tag
// came from the chat template, so the reply begins with the bare close tag)
// through the extraction the route runs. Every one of these was refused with
// `invalid character '<' looking for beginning of value` before prose.go.
func TestExtractProposalLabReasoningShapes(t *testing.T) {
	cases := []struct {
		name string
		raw  string
	}{
		{"bare close tag then the object", "I should split the first edge." + thinkClose + labAnswer},
		{"bare close tag then a fence", "I should split the first edge." + thinkClose + "\n```json\n" + labAnswer + "\n```"},
		{"BOM then a bare close tag", "\ufeff" + thinkClose + labAnswer},
		{"BOM only", "\ufeff" + labAnswer},
		{"opened block then a bare close tag", openTag + "thinking" + thinkClose + "more" + thinkClose + labAnswer},
		{"two opened blocks", openTag + "one" + thinkClose + openTag + "two" + thinkClose + labAnswer},
		{"opened block, close tag, then a fence", openTag + "hmm" + thinkClose + "```json\n" + labAnswer + "\n```"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			p, err := ExtractProposal(tc.raw)
			if err != nil {
				t.Fatalf("ExtractProposal(%q): %v", tc.raw, err)
			}
			if p.Op != "insert_on_edge" || p.From != "approve" || p.ID != "check_plan" {
				t.Fatalf("parsed %+v", p)
			}
		})
	}
}

// TestExtractProposalRefusalCarriesTheReplyPrefix is the diagnosability half
// of the fix: when an answer is genuinely not JSON, the refusal — which is what
// the browser's error line and the api log show, since the proposal turn stores
// nothing — names a bounded prefix of the reply.
func TestExtractProposalRefusalCarriesTheReplyPrefix(t *testing.T) {
	raw := "Certainly! The change you want is a reviewer step, and here is how I would write " +
		"it, first let me describe the graph in some detail so that the answer is clear to you."
	_, err := ExtractProposal(raw)
	if err == nil {
		t.Fatal("want a refusal for a prose answer")
	}
	if !strings.Contains(err.Error(), "the answer is not a JSON object") {
		t.Fatalf("error = %v", err)
	}
	if !strings.Contains(err.Error(), "Certainly! The change you want is a reviewer step") {
		t.Fatalf("error does not name the reply: %v", err)
	}
	if utf8.RuneCountInString(err.Error()) > AnswerExcerptChars+160 {
		t.Fatalf("error is longer than the excerpt budget: %d runes: %v", utf8.RuneCountInString(err.Error()), err)
	}
}

func TestModelAnswerExcerpt(t *testing.T) {
	t.Run("empty answers", func(t *testing.T) {
		if got := modelAnswerExcerpt(""); got != "the answer was empty" {
			t.Fatalf("empty: %q", got)
		}
		if got := modelAnswerExcerpt(" \n \ufeff"); got != "the answer was empty" {
			t.Fatalf("BOM only: %q", got)
		}
		// Control characters are not whitespace, but they say nothing a
		// maintainer could read either.
		if got := modelAnswerExcerpt("\x01\x02\x03 \n"); got != "the answer was only whitespace" {
			t.Fatalf("control only: %q", got)
		}
	})

	t.Run("clips to the cap on a rune boundary", func(t *testing.T) {
		raw := strings.Repeat("é", AnswerExcerptChars*3)
		got := modelAnswerExcerpt(raw)
		if !strings.HasSuffix(got, "…'") {
			t.Fatalf("no clip marker: %q", got)
		}
		body := strings.TrimSuffix(strings.TrimPrefix(got, "the answer began: '"), "…'")
		if utf8.RuneCountInString(body) != AnswerExcerptChars {
			t.Fatalf("body is %d runes, want %d: %q", utf8.RuneCountInString(body), AnswerExcerptChars, body)
		}
	})

	t.Run("one line, no control characters", func(t *testing.T) {
		raw := "line one\nline\ttwo\rline\u200bthree" + thinkClose + labAnswer
		got := modelAnswerExcerpt(raw)
		if strings.ContainsAny(got, "\n\r\t") {
			t.Fatalf("control characters survived: %q", got)
		}
		for _, r := range got {
			if unicode.IsControl(r) {
				t.Fatalf("control rune %q in %q", r, got)
			}
		}
		if !strings.Contains(got, "line one line two") {
			t.Fatalf("collapsed text changed meaning: %q", got)
		}
	})

	t.Run("secret-shaped answers are not repeated", func(t *testing.T) {
		for _, raw := range []string{
			"sk-" + strings.Repeat("A", 24) + " is the key the draft needs",
			`{"authorization": "Bearer supersecretvalue"}`,
			"-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJ",
			"token=" + strings.Repeat("z", 12) + " then the object",
		} {
			got := modelAnswerExcerpt(raw)
			if !strings.Contains(got, "secret-shaped material") {
				t.Fatalf("excerpt of %q leaked: %q", raw, got)
			}
			if strings.Contains(got, raw[:min(8, len(raw))]) {
				t.Fatalf("excerpt repeats material from %q: %q", raw, got)
			}
		}
	})
}

// TestSharedStripperCoversEveryTextOnlyPath is the unification the A8 fix is
// judged on: the proposal, approval-summary and interpretation paths all peel
// the same shapes, so a thinking model cannot fail one route and satisfy
// another.
func TestSharedStripperCoversEveryTextOnlyPath(t *testing.T) {
	const summaryAnswer = `{"summary":"The gate is waiting on the build loop.","actions":[{"label":"Approve","intent":"approve","risk":"proceed"},{"label":"Reject","intent":"reject","risk":"refuse"}]}`
	const interpretAnswer = `{"interpretation":"The approver wants the tests fixed first.","proposed":{"decision":"request_changes","comments":"fix the tests"}}`
	wrappers := []struct{ name, prefix, suffix string }{
		{"bare close tag", "reasoning about the gate" + thinkClose, ""},
		{"opened block", openTag + "reasoning" + thinkClose, ""},
		{"leading BOM", "\ufeff", ""},
		{"json fence", "```json\n", "\n```"},
		{"block then fence", openTag + "reasoning" + thinkClose + "\n```json\n", "\n```"},
	}
	for _, w := range wrappers {
		t.Run(w.name, func(t *testing.T) {
			got, err := ParseApprovalSummary(w.prefix + summaryAnswer + w.suffix)
			if err != nil {
				t.Fatalf("ParseApprovalSummary: %v", err)
			}
			if got.Summary == "" || len(got.Actions) != 2 || got.Actions[0].Label != "Approve" {
				t.Fatalf("summary = %+v", got)
			}
			out, err := ParseInterpretation(w.prefix + interpretAnswer + w.suffix)
			if err != nil {
				t.Fatalf("ParseInterpretation: %v", err)
			}
			if out.Proposed.Decision != "request_changes" || out.Interpretation == "" {
				t.Fatalf("interpretation = %+v", out)
			}
			p, err := ExtractProposal(w.prefix + labAnswer + w.suffix)
			if err != nil {
				t.Fatalf("ExtractProposal: %v", err)
			}
			if p.Op != "insert_on_edge" {
				t.Fatalf("proposal = %+v", p)
			}
		})
	}
}

// TestTextOnlyRefusalsCarryTheExcerpt pins the summary and interpretation
// refusals too: neither path stores the model's reply, so their 502 details are
// the only record of the shape.
func TestTextOnlyRefusalsCarryTheExcerpt(t *testing.T) {
	raw := "Sure — here is a short paragraph about the gate instead of the JSON you asked for."
	if _, err := ParseApprovalSummary(raw); err == nil || !strings.Contains(err.Error(), "Sure — here is") {
		t.Fatalf("ParseApprovalSummary refusal = %v", err)
	}
	if _, err := ParseInterpretation(raw); err == nil || !strings.Contains(err.Error(), "Sure — here is") {
		t.Fatalf("ParseInterpretation refusal = %v", err)
	}
	if _, err := ParseApprovalSummary(openTag + "reasoning with no close tag"); err == nil ||
		!strings.Contains(err.Error(), "never closes") || !strings.Contains(err.Error(), "the answer began:") {
		t.Fatalf("unclosed block refusal = %v", err)
	}
}
