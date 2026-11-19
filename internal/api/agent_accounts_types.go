package api

// ADR-0085 (in-app agent sign-in): the API contract types and the store port
// for the Settings "Agent accounts" tab. Shapes mirror api/openapi.yaml
// (AgentLogin, AgentAccount, AgentAccountList). Handlers live in
// agent_accounts.go; the Postgres adapter implements AgentAccountStore.

import (
	"context"
	"errors"
)

// AgentLoginView is the AgentLogin schema. It never carries submitted_code.
type AgentLoginView struct {
	ID              string  `json:"id"`
	Launcher        string  `json:"launcher"`
	WorkerID        *string `json:"worker_id"`
	Status          string  `json:"status"`
	VerificationURL *string `json:"verification_url"`
	UserCode        *string `json:"user_code"`
	NeedsCode       bool    `json:"needs_code"`
	AccountLabel    *string `json:"account_label"`
	Error           *string `json:"error"`
	ExpiresAt       string  `json:"expires_at"` // RFC 3339
	CreatedAt       string  `json:"created_at"`
	UpdatedAt       string  `json:"updated_at"`
}

// AgentAccountView is the AgentAccount schema.
type AgentAccountView struct {
	WorkerID     string          `json:"worker_id"`
	WorkerName   string          `json:"worker_name"`
	Launcher     string          `json:"launcher"`
	State        string          `json:"state"` // signed_in | signed_out | unknown
	AccountLabel *string         `json:"account_label"`
	Detail       *string         `json:"detail"`
	CheckedAt    *string         `json:"checked_at"`
	Login        *AgentLoginView `json:"login"`
}

// AgentAccountList is the listAgentAccounts response body.
type AgentAccountList struct {
	Items []AgentAccountView `json:"items"`
}

// Store errors the handlers map to HTTP statuses.
var (
	// ErrAgentLoginNotFound → 404 (also for another organization's row).
	ErrAgentLoginNotFound = errors.New("agent login not found")
	// ErrAgentLoginActive → 409: a sign-in for this launcher and worker is
	// already queued, starting, awaiting the user or verifying.
	ErrAgentLoginActive = errors.New("agent login already active")
	// ErrAgentLoginState → 409: the row is not awaiting a pasted code.
	ErrAgentLoginState = errors.New("agent login is not waiting for a code")
)

// AgentAccountStore is the persistence port. Every method is called only after
// the handler has checked Caller.IsOrgAdmin.
type AgentAccountStore interface {
	// ListAgentAccounts returns one row per live worker × sign-in launcher
	// (codex, antigravity), state "unknown" when the worker never reported.
	ListAgentAccounts(ctx context.Context, c Caller) ([]AgentAccountView, error)
	// CreateAgentLogin queues a sign-in (expires_at = now()+15m) and journals
	// agent.login.started. workerID "" means any worker.
	CreateAgentLogin(ctx context.Context, c Caller, launcher, workerID string) (AgentLoginView, error)
	GetAgentLogin(ctx context.Context, c Caller, loginID string) (AgentLoginView, error)
	// SubmitAgentLoginCode stores the pasted code on an awaiting_user row with
	// needs_code; ErrAgentLoginState otherwise.
	SubmitAgentLoginCode(ctx context.Context, c Caller, loginID, code string) error
	// CancelAgentLogin moves an active row to cancelled (journals
	// agent.login.cancelled); a terminal row is left as is (nil error).
	CancelAgentLogin(ctx context.Context, c Caller, loginID string) error
}
