// Package github is Communication's read-only GitHub adapter: the "query"
// half of communication-spec/07-config-integrations.md's
// trigger/query/action provider contract, restricted to reading issues so a
// user can start a run from one.
//
// ANONYMOUS ONLY, BY DESIGN. Every request this package makes is
// unauthenticated, so only public repositories are readable. No token, no
// Authorization header, nothing read from the environment: GitHub's own
// unauthenticated rate budget is small (60 requests/hour per IP), which the
// caller sees as a typed RateLimitError rather than a hang. Token support
// belongs to the scoped secrets path (ADR-0018: keyrings, `SecretRef`
// materialization, never env scraping) and is deliberately not implemented
// here — see ADR-0031.
//
// The read half only: no webhook receiver, no trigger, no `integration.query`
// node kind (it stays in the compiler's deferredKinds), and no comment/close/
// PR action. Those need the `triggers`/`invocations` tables and delivery-ID
// dedupe that milestone M6 owns (`11-build-roadmap.md`: "duplicate webhook
// does not duplicate logical work").
//
// Nothing in this package depends on a GitHub SDK: net/http plus
// encoding/json, and the types here are plain Go so `internal/domain` stays
// free of third-party wire formats.
package github

import (
	"context"
	"errors"
	"fmt"
	"time"
)

// The contract this package speaks (07-config-integrations.md "Initial GitHub
// adapter"; api.github.com's media type and version pin).
const (
	// DefaultBaseURL is the production API root. Client.BaseURL overrides it,
	// which is how the tests point the client at an httptest server.
	DefaultBaseURL = "https://api.github.com"

	acceptHeader   = "application/vnd.github+json"
	apiVersion     = "2022-11-28"
	apiVersionHead = "X-GitHub-Api-Version"

	// userAgent is required by GitHub's API terms for anonymous traffic and
	// identifies the control plane rather than a browser.
	userAgent = "communication-control-plane/0.1 (read-only issue query)"

	// requestTimeout bounds one call. A hung GitHub must not hold an HTTP
	// handler open: 10 s is generous for a single 50-row page.
	requestTimeout = 10 * time.Second

	// MaxBodyBytes is what Issue.Body keeps. GitHub allows 128 KiB bodies; a
	// run input prefilled from one does not need the tail, and an unbounded
	// string would ride into the prompt, the journal and the browser.
	MaxBodyBytes = 4000

	// perPage bounds one fetched page, as the brief pins it.
	defaultPerPage = 50
	maxPerPage     = 100

	// maxResponseBytes caps a decoded page so a hostile or buggy upstream
	// cannot make the control plane allocate without limit.
	maxResponseBytes = 16 << 20
)

// Repository is a GitHub repository addressed by owner and name — the pair a
// git remote resolves to, and the only GitHub identity this package needs.
type Repository struct {
	Owner string
	Name  string
}

// String is the canonical `owner/repo` form, and the form that must never be
// rebuilt from user-supplied strings by a caller.
func (r Repository) String() string {
	if r.Owner == "" {
		return r.Name
	}
	return r.Owner + "/" + r.Name
}

// Issue is one GitHub issue reduced to what starting a run needs. Nothing
// here is authoritative: `07` is explicit that GitHub owns the issue data and
// Communication caches the minimum to act on it.
type Issue struct {
	Number  int
	Title   string
	Body    string
	Labels  []string
	HTMLURL string
	State   string
	// UpdatedAt is GitHub's `updated_at`, which is also its comment-sorted
	// listing key. A value GitHub sent unparseably stays the zero Time.
	UpdatedAt time.Time
	// BodyTruncated reports that Body lost its tail at MaxBodyBytes, so a
	// caller can say "body truncated" instead of silently reading less.
	BodyTruncated bool
}

// IssueQuery narrows ListIssues. The zero value asks for what the product
// brief wants: open issues, newest-updated first, GitHub's default ordering.
type IssueQuery struct {
	// State is open, closed or all; empty means open.
	State string
	// Label is a single label name to filter by; empty means no filter.
	Label string
	// PerPage is rows to fetch in one request, 1..100; 0 means 50.
	PerPage int
}

// IssueLister is the query surface: read issues, change nothing. It is the
// interface the API handlers take, so a test can drive a route without a
// network and a later token-backed implementation can replace this package's
// Client without touching a handler.
type IssueLister interface {
	ListIssues(ctx context.Context, repo Repository, q IssueQuery) ([]Issue, error)
}

// Sentinel errors for the three cases a handler must distinguish. Wrap-check
// them with errors.Is; the concrete types carry the detail.
var (
	// ErrNotGitHubRepository: the remote is not a GitHub repository at all
	// (a GitLab or self-hosted git URL, a local file:// path).
	ErrNotGitHubRepository = errors.New("github: not a GitHub repository")
	// ErrRateLimited: GitHub refused for budget rather than for content. The
	// caller should back off, not retry immediately.
	ErrRateLimited = errors.New("github: rate limited")
	// ErrRepositoryNotFound: GitHub answered 404. An anonymous request cannot
	// tell "does not exist" from "private", and says so.
	ErrRepositoryNotFound = errors.New("github: repository not found")
)

// NotGitHubRepositoryError is ParseRepository's answer for a remote it cannot
// read as GitHub. The URL travels with it so the API can name the field that
// was wrong without echoing a credential-bearing URL back.
type NotGitHubRepositoryError struct{ GitURL string }

func (e *NotGitHubRepositoryError) Error() string {
	return fmt.Sprintf("github: %s is not a GitHub repository url", e.GitURL)
}

// Unwrap makes errors.Is(err, ErrNotGitHubRepository) true.
func (e *NotGitHubRepositoryError) Unwrap() error { return ErrNotGitHubRepository }

// RateLimitError is a 403/429 whose X-RateLimit-Remaining is 0. Reset is the
// header's instant, zero when GitHub did not send one.
type RateLimitError struct {
	Limit int
	Reset time.Time
}

func (e *RateLimitError) Error() string {
	if e.Reset.IsZero() {
		return "github: rate limited (anonymous budget exhausted)"
	}
	return fmt.Sprintf("github: rate limited (anonymous budget exhausted, resets %s)",
		e.Reset.UTC().Format(time.RFC3339))
}

// Unwrap makes errors.Is(err, ErrRateLimited) true.
func (e *RateLimitError) Unwrap() error { return ErrRateLimited }

// NotFoundError names the repository GitHub refused to see.
type NotFoundError struct{ Repository string }

func (e *NotFoundError) Error() string {
	return fmt.Sprintf("github: repository %s not found (an anonymous request cannot read private repositories)", e.Repository)
}

// Unwrap makes errors.Is(err, ErrRepositoryNotFound) true.
func (e *NotFoundError) Unwrap() error { return ErrRepositoryNotFound }

// APIError is any other non-2xx answer. Message is GitHub's own `message`
// member when the body carried one, so an operator can tell a bad label from
// a server-side failure without a second request.
type APIError struct {
	Status  int
	Message string
}

func (e *APIError) Error() string {
	if e.Message == "" {
		return fmt.Sprintf("github: unexpected status %d", e.Status)
	}
	return fmt.Sprintf("github: upstream returned %d: %s", e.Status, e.Message)
}

// States GitHub accepts on the issues endpoint.
const (
	StateOpen   = "open"
	StateClosed = "closed"
	StateAll    = "all"
)

func validState(s string) bool {
	switch s {
	case StateOpen, StateClosed, StateAll:
		return true
	default:
		return false
	}
}
