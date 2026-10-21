package assistant

import (
	"context"
	"strings"
	"testing"
)

func TestInterpretReplyCoercion(t *testing.T) {
	answer := `{
		"interpretation": "The approver wants to approve once the flaky test is fixed.",
		"proposed": {"decision":"REQUEST_CHANGES","comments":"` + strings.Repeat("x", 9000) + `"}
	}`
	b := fakeSummaryModel(t, answer)
	out, fail := b.InterpretReply(context.Background(), "gate summary", "approve after fixing the test")
	if fail != nil {
		t.Fatalf("completion: %v", fail)
	}
	if out.Proposed.Decision != "request_changes" {
		t.Fatalf("decision = %q", out.Proposed.Decision)
	}
	// Comments bounded to the decide endpoint's 8 KiB bound.
	if len(out.Proposed.Comments) > InterpretCommentsMax {
		t.Fatalf("comments = %d bytes, want <= %d", len(out.Proposed.Comments), InterpretCommentsMax)
	}
	if out.Interpretation == "" {
		t.Fatal("interpretation empty")
	}
}

func TestInterpretReplyUnknownDecisionIsReject(t *testing.T) {
	b := fakeSummaryModel(t, `{"interpretation":"unclear","proposed":{"decision":"maybe_later","comments":"hold"}}`)
	out, fail := b.InterpretReply(context.Background(), "gate", "?")
	if fail != nil {
		t.Fatalf("completion: %v", fail)
	}
	if out.Proposed.Decision != "reject" {
		t.Fatalf("ambiguous decision coerced to %q, want reject", out.Proposed.Decision)
	}
}

func TestInterpretReplyInterpretationFallsBackToComments(t *testing.T) {
	b := fakeSummaryModel(t, `{"interpretation":"   ","proposed":{"decision":"approve","comments":"looks good, go"}}`)
	out, fail := b.InterpretReply(context.Background(), "gate", "lgtm")
	if fail != nil {
		t.Fatalf("completion: %v", fail)
	}
	if out.Interpretation != "looks good, go" {
		t.Fatalf("interpretation = %q", out.Interpretation)
	}
	if out.Proposed.Decision != "approve" {
		t.Fatalf("decision = %q", out.Proposed.Decision)
	}
}

func TestInterpretReplyEmptyRefused(t *testing.T) {
	b := fakeSummaryModel(t, `{"interpretation":"","proposed":{"decision":"","comments":"  "}}`)
	_, fail := b.InterpretReply(context.Background(), "gate", "x")
	if fail == nil {
		t.Fatal("expected a malformed failure for an empty answer")
	}
	if fail.Code != FailBadModelResponse {
		t.Fatalf("code = %q", fail.Code)
	}
}

func TestInterpretReplyMalformed(t *testing.T) {
	b := fakeSummaryModel(t, "definitely not json")
	if _, fail := b.InterpretReply(context.Background(), "gate", "x"); fail == nil || fail.Code != FailBadModelResponse {
		t.Fatalf("want malformed, got %v", fail)
	}
}
