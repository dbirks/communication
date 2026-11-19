package worker

// ADR-0085 (in-app agent sign-in): the worker half's persistence port. The
// control plane queues an `agent_logins` row; a worker claims it (FOR UPDATE
// SKIP LOCKED + lease, the APM-lock idiom), runs the launcher's sign-in child
// against its own credential volume, and reports the link/code and the outcome
// back through fenced writes. Every write is fenced on (id, claimed_by) and an
// active status: a worker that lost the lease — or a row the user cancelled —
// gets ErrLeaseLost and must stop the child.

import (
	"context"
	"errors"
	"time"
)

// ErrAgentLoginStopped is returned by AgentLoginSession.WaitCode when the user
// cancelled the sign-in or it expired.
var ErrAgentLoginStopped = errors.New("agent login stopped")

// Agent login statuses (agent_logins.status).
const (
	AgentLoginQueued       = "queued"
	AgentLoginStarting     = "starting"
	AgentLoginAwaitingUser = "awaiting_user"
	AgentLoginVerifying    = "verifying"
	AgentLoginSucceeded    = "succeeded"
	AgentLoginFailed       = "failed"
	AgentLoginCancelled    = "cancelled"
	AgentLoginExpired      = "expired"
)

// Agent account states (agent_account_status.state).
const (
	AgentAccountSignedIn  = "signed_in"
	AgentAccountSignedOut = "signed_out"
	AgentAccountUnknown   = "unknown"
)

// AgentLoginLaunchers are the launcher ids with an in-app sign-in driver.
var AgentLoginLaunchers = []string{"codex", "antigravity"}

// DefaultAgentLoginLease is the lease a claim takes and each heartbeat renews.
const DefaultAgentLoginLease = 60 * time.Second

// AgentLoginClaim is one sign-in won by ClaimAgentLogin.
type AgentLoginClaim struct {
	ID             string
	OrganizationID string
	Launcher       string
	WorkerID       string
	// ExpiresAt is when the attempt gives up (created_at + 15 min); the driver
	// finishes the row as expired after it.
	ExpiresAt time.Time
}

// AgentLoginStore is implemented by the Postgres adapter.
type AgentLoginStore interface {
	// ClaimAgentLogin wins at most one queued row whose worker_id is NULL or
	// workerID (or a starting/awaiting_user/verifying row whose lease expired
	// and whose worker_id is workerID), sets status starting, claimed_by and
	// lease_expires_at = now()+DefaultAgentLoginLease. Only rows whose launcher
	// is in launchers (the drivers this worker has) are claimable, so a worker
	// without a launcher's credential volume never takes its sign-in.
	// ok=false when none.
	ClaimAgentLogin(ctx context.Context, workerID string, launchers []string) (AgentLoginClaim, bool, error)
	// SetAgentLoginPrompt records what the user must see and moves the row to
	// awaiting_user. userCode is "" for Antigravity (stored as NULL).
	SetAgentLoginPrompt(ctx context.Context, c AgentLoginClaim, verificationURL, userCode string, needsCode bool) error
	// PollAgentLogin renews the lease and returns the row's current status
	// plus, when a code was submitted, that code — clearing submitted_code and
	// moving the row to verifying in the same statement. code is "" when none
	// was waiting. A cancelled row returns status cancelled (no error) so the
	// driver can stop its child; a lost lease returns ErrLeaseLost.
	PollAgentLogin(ctx context.Context, c AgentLoginClaim) (status, code string, err error)
	// FinishAgentLogin writes a terminal status (succeeded|failed|expired|
	// cancelled), the account label (may be "") and a human error sentence
	// (may be ""), clears submitted_code, and journals agent.login.<status>.
	FinishAgentLogin(ctx context.Context, c AgentLoginClaim, status, accountLabel, errText string) error
	// UpsertAgentAccountStatus records this worker's view of one launcher's
	// sign-in state (checked_at = now()).
	UpsertAgentAccountStatus(ctx context.Context, workerID, launcher, state, accountLabel, detail string) error
}

// AgentLoginPrompt is what a driver reports once the provider has issued a
// link (and, for Codex, a device code).
type AgentLoginPrompt struct {
	VerificationURL string
	UserCode        string
	NeedsCode       bool
}

// AgentLoginSession is the driver-side view of one claimed sign-in: the loop
// implements it over the store so drivers never see the claim or the store.
type AgentLoginSession interface {
	// Prompt publishes the link/code to the user.
	Prompt(ctx context.Context, p AgentLoginPrompt) error
	// WaitCode blocks until the user submits a code (returns it), the row is
	// cancelled or expires (returns ErrAgentLoginStopped), or ctx ends.
	WaitCode(ctx context.Context) (string, error)
	// Stopped reports whether the user cancelled or the attempt expired; a
	// driver waiting on the provider checks it between polls.
	Stopped(ctx context.Context) (bool, error)
}

// AgentLoginResult is a driver's outcome.
type AgentLoginResult struct {
	// AccountLabel is the signed-in identity when the harness reports one.
	AccountLabel string
}

// AgentAccountState is one status probe's answer.
type AgentAccountState struct {
	State        string // AgentAccountSignedIn | SignedOut | Unknown
	AccountLabel string
	Detail       string
}

// AgentLoginDriver runs one launcher's sign-in child and status probe.
type AgentLoginDriver interface {
	// Login runs the sign-in to completion. A nil error means signed in. An
	// error is reported to the user as its Error() text, so it must be a human
	// sentence that never contains a code or token.
	Login(ctx context.Context, s AgentLoginSession) (AgentLoginResult, error)
	// Status probes whether the credential volume is signed in.
	Status(ctx context.Context) (AgentAccountState, error)
}
