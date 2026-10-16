package assistant

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
)

// secretShape matches material that must never leave the host in a prompt
// (ADR-0018, ADR-0024's "fail closed on egress"): a provider-style token, an
// AWS key id, a GitHub token, a Slack token, a PEM header, or a key=value pair
// whose key names a secret. The scan is a refusal, not a redaction: a prompt
// that was secretly a token is a prompt the assistant must not send at all.
var secretShape = regexp.MustCompile(
	`(?i)(` +
		`\b(sk|pk|rk|ghp|gho|ghu|ghs|ghr|xox[abprs])-?[A-Za-z0-9_-]{16,}` +
		`|\bAKIA[0-9A-Z]{16}\b` +
		`|-----BEGIN [A-Z ]*PRIVATE KEY-----` +
		`|\b(secret|token|password|passwd|api[_-]?key|authorization|bearer|credential)s?["']?\s*[:=]\s*["']?[^\s"',;]{6,}` +
		`)`)

// scanForSecrets refuses the turn before a single byte is sent. It scans the
// marshaled request body, so it covers the question, the route context, the
// client-supplied palette index and any tool output that had already been
// folded back in.
func scanForSecrets(req chatRequest) *Failure {
	body, err := json.Marshal(req)
	if err != nil {
		return failure(FailBadModelResponse, "the request body cannot be serialized", 500)
	}
	if len(body) > MaxPromptBytes*4 {
		return failure(FailBadModelResponse, fmt.Sprintf(
			"the request body is %d bytes over the %d byte cap for one turn", len(body), MaxPromptBytes*4), 500)
	}
	if loc := secretShape.Find(body); loc != nil {
		// The match itself is never echoed: a refused prompt that contained a
		// token must not have it repeated back in a response or a log line.
		return failure("secret_in_request", ErrSecretInPrompt.Error(), 400)
	}
	return nil
}

// safeRoute accepts the UI's current route only if it is a known app route; the
// browser is untrusted, so an unknown route simply contributes nothing.
func (t *turn) safeRoute(route string) string {
	href, ok := t.b.allowedHref(route)
	if !ok {
		return ""
	}
	return href
}

// paletteIndex renders the client-supplied jump index as bounded data for the
// model, with every off-allowlist entry dropped before it can be echoed.
func (t *turn) paletteIndex() string {
	if len(t.qc.Palette) == 0 {
		return ""
	}
	kept := make([]PaletteEntry, 0, len(t.qc.Palette))
	for _, e := range t.qc.Palette {
		href, ok := t.b.allowedHref(e.To)
		if !ok {
			t.dropped++
			continue
		}
		e.To, e.Label, e.Secondary = href, bounded(e.Label, 80), bounded(e.Secondary, 80)
		if strings.TrimSpace(e.Label) == "" {
			continue
		}
		kept = append(kept, e)
		if len(kept) >= 16 {
			break
		}
	}
	if len(kept) == 0 {
		return ""
	}
	blob, err := json.Marshal(kept)
	if err != nil {
		return ""
	}
	return bounded(string(blob), MaxResultBytes*2)
}

// cleanMarkdown is the last pass over the model's text: it keeps the answer as
// prose and strips markdown links whose target is not an allowed app route, so
// a hallucinated URL cannot survive into the rendered answer even though the UI
// sanitizes the markdown too (ADR-0020's viewer rules).
func (b *Broker) cleanMarkdown(text string) string {
	text = strings.TrimSpace(text)
	if len(text) > 8<<10 {
		text = bounded(text, 8<<10)
	}
	return linkSyntax.ReplaceAllStringFunc(text, func(match string) string {
		groups := linkSyntax.FindStringSubmatch(match)
		if len(groups) < 4 {
			return match
		}
		if _, ok := b.allowedHref(strings.TrimSpace(groups[3])); ok {
			return match
		}
		// Downgrade to plain text: the label may be true, the destination is not.
		return groups[2]
	})
}

var linkSyntax = regexp.MustCompile(`(?s)(\[([^\]\n]{0,200})\]\(([^)\n]{0,400})\))`)
