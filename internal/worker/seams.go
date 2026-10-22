package worker

import (
	"context"
	"time"

	"github.com/dbirks/communication/internal/agent/apm"
	"github.com/dbirks/communication/internal/events"
)

// The seams between the unit service and the M3 slices that belong to other
// workers — packaged context, secrets, artifacts. They are declared here, in the
// consumer's own words, so internal/worker depends on nothing it does not need
// (AGENTS.md's dependency rule) and so the questions a unit asks are legible in
// one place.

// SecretMaterializer is the hook into internal/secrets' materialization.
//
// What this package may not know is a plaintext value — and what it cannot know,
// it cannot leak. `env`-mode entries do arrive here as strings, because the launch
// environment is their only delivery mechanism (ADR-0018 D4); that is exactly why
// they go into a child environment built from scratch and into nothing else: not
// the journal, not an artifact, not a log line.
type SecretMaterializer interface {
	// Materialize writes this unit's `env_file` mounts and reports the `env`
	// entries. Every refusal names one of events.Materialization* reasons
	// (ADR-0018 D4): a refusal whose only description is a git error quoting a
	// host path cannot be journalled.
	Materialize(ctx context.Context, req MaterializeRequest) (Materialized, error)
}

// Materialized is what a unit needs in order to launch with secrets present.
type Materialized struct {
	// Env is the `env`-mode entries as KEY=VALUE.
	Env []string
	// Files lists absolute paths written, for the cleanup assertion. A file that
	// survives cleanup moves the workspace to quarantined
	// (events.QuarantineSecretLeftBehind) and fails the unit: the alternative is
	// a secret left in a tree the next conversation gets launched into.
	Files []string
	// Redact replaces every occurrence of a value this unit materialized with a
	// marker and reports how many replacements it made. It is a black box: the
	// materializer knows the values, this package only calls the function, which
	// is what keeps the seam's "no plaintext here" promise while still letting
	// the turn sink honour 12-test-strategy case 12's invariant — a materialized
	// value must never land in the journal, not even when an agent `cat`s the
	// file it was written into. Nil when nothing was materialized.
	Redact func(text string) (string, int)
	// Done runs after cleanup has *asserted* every file gone: it closes the
	// secret_materializations rows and journals secret.removed. A unit that dies
	// before Done leaves the rows uncleaned, which is exactly what the worker's
	// startup sweep reads. Nil when nothing was materialized.
	Done func(ctx context.Context) error
}

// Secret mount lifecycles a materialize request can scope itself to —
// 00004's `secret_mounts.lifecycle` CHECK arms and ADR-0018 D1's ownership
// rule. `turn` (M3's default, and the only one M2/M3 ever honoured) covers
// every mount except the attempt-scoped arm; `node_attempt` is M4's arm: the
// mounts one *attempt* owns, materialized before its launch, removed when the
// attempt ends, and recorded with secret_materializations.attempt_id set
// (contract § 4 step 4).
const (
	LifecycleTurn        = "turn"
	LifecycleWorkspace   = "workspace"
	LifecycleNodeAttempt = "node_attempt"
)

// MaterializeRequest names the unit and the checkouts a mount may target.
type MaterializeRequest struct {
	OrganizationID string
	ProjectID      string
	WorkspaceID    string
	ConversationID string
	TurnID         string
	WorkerID       string
	AgentProfileID string
	// AttemptID is the node attempt this delivery belongs to. Empty for a
	// turn-scope unit (M2/M3); required, with Lifecycle='node_attempt', for
	// the attempt arm, whose ledger row must name the attempt (contract § 4
	// step 4 — the reserved arm finally used).
	AttemptID string
	// Lifecycle scopes which mounts this unit may deliver: "" or
	// LifecycleTurn selects every mount except the node_attempt arm (M3's
	// behaviour, unchanged), LifecycleNodeAttempt selects only the
	// node_attempt arm. A turn never delivers an attempt mount and an attempt
	// never delivers a turn mount: lifecycle is who owns the value's lifetime.
	Lifecycle string
	// PolicyDigest is the digest of the policy this unit is about to launch
	// under, recorded on secret.materialized so a reader can tie "the value was
	// present" to "under this ruleset". Empty means no policy was in play
	// (`disabled`/`permissive-dev` isolation), which the event reports rather
	// than hides.
	PolicyDigest string
	// Repos names every checkout this unit was prepared with — by id, name and
	// the two paths a mount needs (checkout to write into, mirror to exclude
	// through). It is passed in rather than re-read from `workspace_repos`
	// because those rows are written *after* materialization by design (the
	// exclusion set they persist must already be complete): a materializer that
	// queried the table would find nothing and refuse every project.
	Repos []MaterializeRepo
	// ExtraExclusions receives every path written, so the caller can extend the
	// project exclusion set before the first commit (ADR-0017 D6). The
	// materializer appends; the caller owns de-duplication and ordering.
	ExtraExclusions *[]string
}

// MaterializeRepo is one checkout the unit may write a file into.
type MaterializeRepo struct {
	ID           string
	Name         string
	CheckoutPath string
	MirrorPath   string
}

// AttemptSecrets is the node_attempt-shaped SecretMaterializer: the same
// materialization machinery M3's turn uses (one materializer, per ADR-0018 D4)
// plus the read that tells an attempt which checkouts its mounts may target.
// The turn unit learns its repos from its own preparation; an agent.acp attempt
// consumes a workspace someone else prepared in § 4 step 3, so it has to ask.
type AttemptSecrets interface {
	SecretMaterializer
	// ReposForWorkspace lists the prepared checkouts of one run workspace —
	// id, name and the two paths a mount needs — as the authorized roots for
	// this attempt's deliveries. No workspace, no repos: an empty slice is the
	// honest answer for a run with no repositories, not an error.
	ReposForWorkspace(ctx context.Context, workspaceID string) ([]MaterializeRepo, error)
}

// ArtifactCapturer is the hook into internal/artifacts (ADR-0020).
type ArtifactCapturer interface {
	// Capture stores one artifact — exclusion, secret scan and redaction count
	// included, row and event in one fenced transaction. A failure here must not
	// fail the turn: an artifact is a record of the work, not the work
	// (contract deviation D9 — an M3 failure loses artifacts, not edits).
	Capture(ctx context.Context, req CaptureRequest) (string, error)
}

// CaptureRequest is one artifact's material.
type CaptureRequest struct {
	OrganizationID string
	ProjectID      string
	WorkspaceID    string
	ConversationID string
	TurnID         string
	RepositoryID   string
	WorkerID       string
	// FencingToken completes the lease triple: the artifact row and its
	// artifact.created event land in one transaction that proves this worker
	// still owns the turn (ADR-0016 § 9.2). The check is owner+token against a
	// turn that may already be terminal — capture runs after the terminal write,
	// by design (D9), and a stolen lease has a different token either way.
	FencingToken int64
	// Kind is checkpoint or diff: the capture ADR-0017 D8 proves. Nothing here
	// may imply that rehydration works — D-024 stays Open.
	Kind     string
	Name     string
	Summary  string
	Manifest []string
	// Content is the artifact's bytes for a file artifact — one agent-produced
	// report the capture rule declares publishable (contract § 4.7: files the
	// contract names become artifacts). Empty means the store builds the bytes
	// from Summary/Manifest itself (the checkpoint capture).
	Content []byte
	// MediaType names Content's type when Content is set.
	MediaType string
	// ExcludedPaths is re-filtered by the artifact store itself. A git-level
	// exclusion must never be the only thing standing between a `.env` and an
	// artifact, which is why this field is load-bearing rather than
	// informational.
	ExcludedPaths []string
}

// APMTyper is the packaged-context seam. It is an interface rather than the
// concrete *APMStager so the digest-mismatch refusal — the one control that sees
// probe A5's finding — can be tested without an apm binary.
type APMTyper interface {
	Stage(context.Context, apm.StageRequest) (*apm.StagedContext, error)
	// Resolve locks a package ref and reports its lock digest + contents
	// summary (ADR-0054 Option B, part 1) without deploying anything.
	Resolve(context.Context, apm.ResolveRequest) (*apm.ResolveResult, error)
}

// APMStager wraps apm.Stage and apm.Resolve with the binary pin, so every
// packaged-context operation is produced in one place with one reason.
type APMStager struct {
	// Binary is the apm executable — vendored at 0.33.0 in the worker image
	// (ADR-0008 D1). Its absence while a profile pins a package is a launch
	// failure rather than a silent skip: running without the packaged context the
	// profile promises would be a different agent than the one configured.
	Binary string
	// Timeout bounds one install. A hung apm would otherwise sit on a turn lease
	// doing nothing.
	Timeout time.Duration
}

// Stage installs a profile's packages into one checkout and reports the paths the
// caller must exclude.
func (a *APMStager) Stage(ctx context.Context, req apm.StageRequest) (*apm.StagedContext, error) {
	if a.Binary != "" {
		req.APMPath = a.Binary
	}
	if req.Timeout == 0 && a.Timeout > 0 {
		req.Timeout = a.Timeout
	}
	return apm.Stage(ctx, req)
}

// Resolve locks a package ref and reports the lock digest it resolved to plus
// the names-only contents summary. The binary pin and timeout mirror Stage's.
func (a *APMStager) Resolve(ctx context.Context, req apm.ResolveRequest) (*apm.ResolveResult, error) {
	if a.Binary != "" {
		req.APMPath = a.Binary
	}
	if req.Timeout == 0 && a.Timeout > 0 {
		req.Timeout = a.Timeout
	}
	return apm.Resolve(ctx, req)
}

// quarantineReason maps a failure kind onto the only quarantine reasons the event
// schema allows (events.ValidQuarantineReason). A fourth string would be a bug,
// so this is a function rather than a caller's choice.
func quarantineReason(kind string) string {
	switch kind {
	case "secret":
		return events.QuarantineSecretLeftBehind
	case "exclusion":
		return events.QuarantineExclusionFailed
	case "worktree":
		return events.QuarantineWorktreeUnusable
	default:
		return ""
	}
}

// normalizeMode resolves the workspace mode a unit runs in. An empty profile
// value is ADR-0010's default, not an absence of decision.
func normalizeMode(mode string) (string, error) {
	switch mode {
	case "":
		return "worktree", nil
	case "worktree", "clone":
		return mode, nil
	default:
		return "", errUnknownMode(mode)
	}
}

func errUnknownMode(mode string) error {
	return &configError{msg: "worker: workspace mode " + mode + " is not worktree or clone"}
}

// configError is a configuration-level refusal: nothing about the data, nothing
// retryable, and it never quarantines anything because no work had been done.
type configError struct{ msg string }

func (e *configError) Error() string { return e.msg }
