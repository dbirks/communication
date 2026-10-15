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
}

// MaterializeRequest names the unit and the checkouts a mount may target.
type MaterializeRequest struct {
	OrganizationID string
	ProjectID      string
	WorkspaceID    string
	ConversationID string
	TurnID         string
	WorkerID       string
	AgentProfileID string
	// Repos maps repository id to its checkout path, so a repository-scoped mount
	// can be resolved without the materializer knowing the workspace layout.
	Repos map[string]string
	// ExtraExclusions receives every path written, so the caller can extend the
	// project exclusion set before the first commit (ADR-0017 D6). The
	// materializer appends; the caller owns de-duplication and ordering.
	ExtraExclusions *[]string
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
	TurnID         string
	RepositoryID   string
	// Kind is checkpoint or diff: the capture ADR-0017 D8 proves. Nothing here
	// may imply that rehydration works — D-024 stays Open.
	Kind     string
	Name     string
	Summary  string
	Manifest []string
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
}

// APMStager wraps apm.Stage with the binary pin, so a refusal is produced in one
// place with one reason.
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
