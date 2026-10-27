package assistant

// This file is the ONE answer-shape helper every text-only assistant turn
// shares: ExtractProposal (ADR-0044), ParseInterpretation and
// ParseApprovalSummary (ADR-0052) all ask for exactly one JSON object and all
// read the model's reply through stripModelProse before they decode it.
//
// It exists because the three paths had drifted: proposal.go carried its own
// inline copy of the stripping rules, so a shape one path tolerated could
// still be refused by another, and none of them said what the model actually
// sent. The lab's issue2 A8 failure (acceptance cc1acd1, 2026-10-27) is the
// symptom: the thinking model's completion began with a bare THINK-CLOSE tag —
// the chat template had already emitted the opening tag into the PROMPT, so the
// reply was reasoning text, then the close tag, then the object. The old code
// only recognized a block that OPENS with the tag, so the decoder ran against
// the close tag itself and the browser was told nothing more than `invalid
// character '<' looking for beginning of value`. Both halves of that bug are
// fixed here: the shape is handled, and every malformed-answer refusal now
// carries a bounded, secret-checked prefix of the reply (modelAnswerExcerpt)
// so the next unforeseen shape is diagnosable from the error text alone.
//
// What is deliberately NOT done: scraping a JSON object out of arbitrary prose.
// Reasoning wrappers are peeled because they are a known, mechanical part of a
// thinking model's completion; an answer that is the object buried in
// conversation is the model not answering the question, and stays a refusal.

import (
	"errors"
	"fmt"
	"strings"
	"unicode"
)

// thinkOpen opens a reasoning model's think block and thinkClose ends it. Both
// are assembled by concatenation so the literal tag never appears in source —
// some models stop generating the moment they see one. thinkOpen is the tag's
// PREFIX (a completion may open it as the plain tag or with a variant suffix),
// matching the check the proposal path has always run.
const (
	thinkOpen  = "<" + "think"
	thinkClose = "<" + "/think>"
)

// fenceOpen wraps a model answer's body in a markdown code fence.
const fenceOpen = "```"

// maxProseWraps bounds how many reasoning blocks and fences stripModelProse
// will peel off one answer. Models wrap an answer once or twice; a completion
// with nine layers is not a formatting hiccup, and the peel stays bounded
// rather than looping on whatever it found.
const maxProseWraps = 8

// AnswerExcerptChars caps the reply prefix a malformed-answer refusal names
// (the brief's ~120 characters — enough to see the shape that broke the
// decode, too short to leak a whole answer into a problem detail).
const AnswerExcerptChars = 120

// trimModelWhitespace clips what a completion may hide behind at either end:
// the Unicode space set, the BOM / zero-width no-break space (U+FEFF) a
// streaming template can emit before anything else, the no-break space and the
// zero-width space. None of them are JSON, so all of them make the decoder
// complain before it ever sees the object — and TrimSpace alone misses U+FEFF,
// which is not a Unicode space.
func trimModelWhitespace(s string) string {
	return strings.TrimFunc(s, func(r rune) bool {
		switch r {
		case '\u000c', '\ufeff', '\u00a0', '\u200b':
			return true
		}
		return unicode.IsSpace(r)
	})
}

// stripModelProse reduces a model answer to the body the JSON decoder must
// read, peeling (in a loop, so any order composes):
//
//   - a leading reasoning block that OPENS with the THINK-OPEN tag and closes
//     with the THINK-CLOSE tag;
//   - a leading reasoning block whose opening tag the chat template already
//     emitted into the prompt — the completion is reasoning text closed by a
//     bare THINK-CLOSE tag, then the answer (how Qwen3-class thinking models
//     are served when the template ends inside the think block). This shape is
//     only recognized while the answer has NOT begun: bytes that already start
//     a JSON object/array or a fence are left exactly as they are, so a
//     THINK-CLOSE tag inside a string member is never a cut point;
//   - any number of those blocks in a row (a model that thinks, answers, and
//     thinks again);
//   - one ``` or ```json fence around the body;
//   - whitespace and BOMs between every layer.
//
// An unclosed think block, an unclosed fence, a fence with no body and more
// wrappers than maxProseWraps are refusals; so is everything the decoder still
// cannot read as exactly one JSON value.
func stripModelProse(raw string) (string, error) {
	s := trimModelWhitespace(raw)
	for range maxProseWraps {
		body, peeled, err := peelModelProse(s)
		if err != nil {
			return "", err
		}
		if !peeled {
			return s, nil
		}
		s = body
	}
	return "", errors.New("the answer is wrapped in more reasoning blocks or code fences than the assistant accepts")
}

// peelModelProse removes ONE leading reasoning block or ONE leading fence and
// reports whether it removed anything. The caller loops; each peel strictly
// shortens the string, so the loop terminates.
func peelModelProse(s string) (string, bool, error) {
	if strings.HasPrefix(s, thinkOpen) {
		i := strings.Index(s, thinkClose)
		if i < 0 {
			return "", false, errors.New("the answer's think block never closes")
		}
		return trimModelWhitespace(s[i+len(thinkClose):]), true, nil
	}
	if !startsJSONAnswer(s) && strings.Contains(s, thinkClose) {
		// The opening tag came from the chat template, so this completion opens
		// as reasoning and is closed by a bare close tag.
		i := strings.Index(s, thinkClose)
		return trimModelWhitespace(s[i+len(thinkClose):]), true, nil
	}
	if strings.HasPrefix(s, fenceOpen) {
		end := strings.IndexByte(s, '\n')
		if end < 0 {
			return "", false, errors.New("the fenced answer has no body")
		}
		body := s[end+1:]
		closeIdx := strings.LastIndex(body, fenceOpen)
		if closeIdx < 0 {
			return "", false, errors.New("the fenced answer is not closed")
		}
		return trimModelWhitespace(body[:closeIdx]), true, nil
	}
	return s, false, nil
}

// startsJSONAnswer reports whether the answer has already begun: its first byte
// opens a JSON object or array, or a fence that must hold one. Once it has,
// stripModelProse touches nothing — the JSON decoder itself decides.
func startsJSONAnswer(s string) bool {
	return strings.HasPrefix(s, "{") || strings.HasPrefix(s, "[") || strings.HasPrefix(s, fenceOpen)
}

// modelAnswerExcerpt is the diagnosable half of a malformed-answer refusal: the
// first AnswerExcerptChars characters of the RAW reply (raw, not stripped — the
// prefix IS the diagnosis) as one line. Every control character and zero-width
// character becomes a space and runs of spaces collapse, so the excerpt can
// neither inflate a response with a wall of newlines nor inject a fake log
// line. If the excerpt still matches the egress scanner's secret shapes, not a
// character of it is repeated: the answer is untrusted output, and a model that
// echoes a token must not have that token handed back to a browser in a
// problem detail.
func modelAnswerExcerpt(raw string) string {
	s := trimModelWhitespace(raw)
	if s == "" {
		return "the answer was empty"
	}
	r := []rune(s)
	clipped := len(r) > AnswerExcerptChars
	if clipped {
		r = r[:AnswerExcerptChars]
	}
	var b strings.Builder
	b.Grow(len(s))
	for _, c := range r {
		switch c {
		case '\u000c', '\ufeff', '\u200b', '\u00a0':
			b.WriteRune(' ')
		default:
			if unicode.IsControl(c) {
				b.WriteRune(' ')
				continue
			}
			b.WriteRune(c)
		}
	}
	text := strings.Join(strings.Fields(b.String()), " ")
	if text == "" {
		return "the answer was only whitespace"
	}
	if secretShape.FindString(text) != "" {
		return "the answer began with secret-shaped material that is not repeated here"
	}
	tail := ""
	if clipped {
		tail = "…"
	}
	return "the answer began: '" + text + tail + "'"
}

// malformedAnswerError is the refusal every text-only path reports when the
// answer is not the one JSON object it asked for: the decoder's own complaint,
// plus the bounded excerpt of what the model actually sent.
func malformedAnswerError(raw string, cause error) error {
	return fmt.Errorf("%v (%s)", cause, modelAnswerExcerpt(raw))
}
