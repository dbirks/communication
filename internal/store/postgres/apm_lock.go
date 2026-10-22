package postgres

// ADR-0054 amendment 1 (server-side APM lock, implementation): the durable
// lock-request queue and its two worker-side fences, plus the control-plane
// reads behind POST /api/v1/agent-profiles/{profileId}/apm/lock and
// GET .../apm/lock.
//
// The rules this file carries are the ones the rest of the package already
// states for the turn and attempt claims, restated for the lock:
//
//   - The permission predicate is part of the SQL. agent_profiles is
//     organization-scoped, so the create read is org-scoped (invisible subject →
//     not-found) and the write right is the organization admin's — the same
//     library-role gate the PATCH triple uses.
//   - State + its journal row in ONE transaction (ADR-0013): the profile's
//     digest + contents summary and the agent.profile.apm_locked append ride the
//     same transaction as the request's done/failed transition. A resolve that
//     failed writes only the failed status — the profile keeps whatever digest
//     (if any) it already holds, and the launch gate stays authoritative.
//   - An invisible profile is not found, never an empty answer (ADR-0014 §3).

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/dbirks/communication/internal/agent/apm"
	"github.com/dbirks/communication/internal/events"
	"github.com/dbirks/communication/internal/worker"
)

// apmLockStatusClaimed / apmLockStatusDone / apmLockStatusFailed / apmLockStatusQueued
// are the apm_lock_requests.status CHECK values (migration 00013). The empty
// status a "no request yet" read answers is owned by the api layer, not here.
const (
	apmLockStatusQueued  = "queued"
	apmLockStatusClaimed = "claimed"
	apmLockStatusDone    = "done"
	apmLockStatusFailed  = "failed"
)

// apmLockClaimSQL is the lock-request claim, written in the same shape as the
// turn and attempt claims: FOR UPDATE SKIP LOCKED over the due rows, lease from
// now + DefaultAPMLockResolveTimeout, one row. The due predicate re-reads a
// claimed row once its lease has expired, so a worker that died mid-resolve
// leaves the lock to be retried by whoever next asks for it — the lease is the
// same arithmetic the fenced writes use elsewhere.
const apmLockClaimSQL = `
	UPDATE apm_lock_requests r
	SET status = 'claimed',
	    claimed_by = $1::uuid,
	    lease_expires_at = now() + make_interval(secs => $2::double precision),
	    updated_at = now()
	FROM (
		SELECT r2.id AS request_id
		FROM apm_lock_requests r2
		WHERE r2.status = 'queued'
		   OR (r2.status = 'claimed' AND r2.lease_expires_at IS NOT NULL AND r2.lease_expires_at < now())
		ORDER BY r2.created_at, r2.id
		FOR UPDATE OF r2 SKIP LOCKED
		LIMIT 1
	) w
	WHERE r.id = w.request_id
	RETURNING r.id, r.profile_id::text, r.organization_id::text, r.package_ref, r.target, r.claimed_by::text, r.lease_expires_at, r.status`

// ClaimAPMLockRequest wins at most one due lock request for workerID. The claim
// itself is the pinned single statement; the worker id comes back on the row and
// the caller keys its resolve at the pin the row names.
func (s *TurnStore) ClaimAPMLockRequest(ctx context.Context, workerID string) (worker.APMLockClaim, bool, error) {
	var (
		c          worker.APMLockClaim
		requestID  string
		profileID  string
		orgID      string
		packageRef string
		target     string
		owner      string
		status     string
	)
	err := s.Pool.QueryRow(ctx, apmLockClaimSQL, workerID, worker.DefaultAPMLockResolveTimeout.Seconds()).
		Scan(&requestID, &profileID, &orgID, &packageRef, &target, &owner, &c.LeaseExpiresAt, &status)
	if err != nil && errors.Is(err, pgx.ErrNoRows) {
		return worker.APMLockClaim{}, false, nil
	}
	if err != nil {
		return worker.APMLockClaim{}, false, fmt.Errorf("postgres: claim apm lock: %w", err)
	}
	c.RequestID = requestID
	c.ProfileID = profileID
	c.OrganizationID = orgID
	c.PackageRef = packageRef
	c.Target = target
	c.WorkerID = owner
	return c, true, nil
}

// apmLockRequest is one apm_lock_requests row as the store answers it: the
// pending/claimed/done/failed state plus the bounded failure detail.
type apmLockRequest struct {
	RequestID string
	ProfileID string
	Status    string
	Error     string
}

// apmLockContentsJSON is the wire shape of agent_profiles.apm_contents_summary
// (migration 00013): the names-only lock summary the resolve computed, in the
// {skills, instructions, mcp_servers, truncated} shape the AgentProfileView
// exposes. It is a summary, not a payload.
type apmLockContentsJSON struct {
	Skills       []string `json:"skills"`
	Instructions []string `json:"instructions"`
	MCPServers   []string `json:"mcp_servers"`
	Truncated    bool     `json:"truncated"`
}

func (c apmLockContentsJSON) marshal() ([]byte, error) {
	return json.Marshal(c)
}

// apmLockBoundedError caps the failure detail a worker-reported resolve error
// may carry into the apm_lock_requests.error column: a resolve's stderr tail is
// already bounded upstream, and this is the second bound so a long stream can
// never become a journal-adjacent row.
func apmLockBoundedError(err error) string {
	return boundedErrorText(err, 512)
}

// CompleteAPMLockRequest closes a claimed lock request in one transaction and
// reports the resolve outcome. The fence is the same one a turn fence uses: the
// request row is locked and the (status, worker) pair must still be ours, or the
// write is refused with ErrLeaseLost and nothing lands.
func (s *TurnStore) CompleteAPMLockRequest(ctx context.Context, c worker.APMLockClaim, result *apm.ResolveResult, resolveErr error) error {
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("postgres: begin complete apm lock: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var status, claimedBy string
	var lease *time.Time
	if err := tx.QueryRow(ctx,
		`SELECT status, claimed_by::text, lease_expires_at FROM apm_lock_requests WHERE id = $1::uuid FOR UPDATE`,
		c.RequestID).Scan(&status, &claimedBy, &lease); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return worker.ErrLeaseLost
		}
		return fmt.Errorf("postgres: fence apm lock %s: %w", c.RequestID, err)
	}
	if status != apmLockStatusClaimed || claimedBy != c.WorkerID {
		return worker.ErrLeaseLost
	}

	if resolveErr != nil {
		if _, err := tx.Exec(ctx,
			`UPDATE apm_lock_requests SET status = $2, error = $3, updated_at = now() WHERE id = $1::uuid`,
			c.RequestID, apmLockStatusFailed, apmLockBoundedError(resolveErr)); err != nil {
			return fmt.Errorf("postgres: fail apm lock %s: %w", c.RequestID, err)
		}
		if err := tx.Commit(ctx); err != nil {
			return fmt.Errorf("postgres: commit fail apm lock %s: %w", c.RequestID, err)
		}
		return nil
	}
	if result == nil {
		if _, err := tx.Exec(ctx,
			`UPDATE apm_lock_requests SET status = $2, error = $3, updated_at = now() WHERE id = $1::uuid`,
			c.RequestID, apmLockStatusFailed, apmLockBoundedError(errors.New("apm: resolve reported success without a result"))); err != nil {
			return fmt.Errorf("postgres: fail apm lock %s: %w", c.RequestID, err)
		}
		if err := tx.Commit(ctx); err != nil {
			return fmt.Errorf("postgres: commit fail apm lock %s: %w", c.RequestID, err)
		}
		return nil
	}

	contents := apmLockContentsJSON{
		Skills:       result.Contents.Skills,
		Instructions: result.Contents.Instructions,
		MCPServers:   result.Contents.MCPServers,
		Truncated:    result.Contents.Truncated,
	}
	contentsJSON, err := contents.marshal()
	if err != nil {
		return fmt.Errorf("postgres: encode apm lock contents summary: %w", err)
	}
	if _, err := tx.Exec(ctx, `
		UPDATE agent_profiles
		SET apm_lock_digest = $1, apm_contents_summary = $2::jsonb
		WHERE id = $3::uuid AND organization_id = $4::uuid`,
		result.LockDigest, contentsJSON, c.ProfileID, c.OrganizationID); err != nil {
		return fmt.Errorf("postgres: record apm lock %s: %w", c.RequestID, err)
	}
	if _, err := tx.Exec(ctx, `
		UPDATE apm_lock_requests SET status = $2, error = NULL, updated_at = now() WHERE id = $1::uuid`,
		c.RequestID, apmLockStatusDone); err != nil {
		return fmt.Errorf("postgres: complete apm lock %s: %w", c.RequestID, err)
	}
	if _, err := AppendEvent(ctx, tx, events.New{
		Type:           events.TypeAgentProfileAPMLocked,
		OrganizationID: c.OrganizationID,
		Actor:          events.Actor{Kind: events.ActorKindWorker, ID: c.WorkerID},
		Payload: events.AgentProfileAPMLockedPayload{
			ProfileID:     c.ProfileID,
			APMPackageRef: c.PackageRef,
			APMTarget:     c.Target,
			APMLockDigest: result.LockDigest,
			ResolvedRef:   result.ResolvedRef,
			Commit:        result.Commit,
			APMVersion:    result.APMVersion,
		},
	}); err != nil {
		return fmt.Errorf("postgres: append apm lock event %s: %w", c.RequestID, err)
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("postgres: commit complete apm lock %s: %w", c.RequestID, err)
	}
	return nil
}

// boundedErrorText caps err's message into the bounded failure detail.
func boundedErrorText(err error, max int) string {
	text := err.Error()
	if len(text) > max {
		return text[:max]
	}
	return text
}

// --- control-plane reads: create + latest status -----------------------

// CreateAPMLockRequest queues an APM lock resolve for one profile: the caller
// must hold the organization admin's write right (the library role) and the
// profile must carry both an apm_package_ref and an apm_target. The missing
// coordinate is the ADR-0030 half-pin refusal under the ADR-0030 code, so a
// lock can never be dispatched for a pin that does not exist.
func (s *CnvStore) CreateAPMLockRequest(ctx context.Context, c Caller, profileID string) (apmLockRequest, error) {
	if err := prjRequireCaller(c); err != nil {
		return apmLockRequest{}, err
	}
	p, err := cnvProfileRow(ctx, s.Pool, profileID, c.OrganizationID)
	if err != nil {
		return apmLockRequest{}, err
	}
	if !c.IsOrgAdmin {
		return apmLockRequest{}, ErrProfileForbidden
	}
	if p.APMPackageRef == "" || p.APMTarget == "" {
		return apmLockRequest{}, profileRefused(ProfileCodeAPMIncomplete,
			"an apm lock needs both apm_package_ref and apm_target; set the pin before locking.")
	}
	var req apmLockRequest
	var errText *string
	if err := s.Pool.QueryRow(ctx, `
		INSERT INTO apm_lock_requests (organization_id, profile_id, package_ref, target, status)
		VALUES ($1::uuid, $2::uuid, $3, $4, $5)
		RETURNING id::text, status, error`,
		c.OrganizationID, p.ID, p.APMPackageRef, p.APMTarget, apmLockStatusQueued).Scan(&req.RequestID, &req.Status, &errText); err != nil {
		return apmLockRequest{}, fmt.Errorf("postgres: create apm lock: %w", err)
	}
	req.ProfileID = p.ID
	if errText != nil {
		req.Error = *errText
	}
	return req, nil
}

// GetAPMLockRequest returns the latest lock request of one profile, newest
// first (created_at, then id — uuidv7 ids are time-ordered). The answer is
// org-scoped through the same profile read the write paths use, so a profile in
// another organization is not found rather than read.
func (s *CnvStore) GetAPMLockRequest(ctx context.Context, c Caller, profileID string) (apmLockRequest, error) {
	if err := prjRequireCaller(c); err != nil {
		return apmLockRequest{}, err
	}
	if _, err := cnvProfileRow(ctx, s.Pool, profileID, c.OrganizationID); err != nil {
		return apmLockRequest{}, err
	}
	var req apmLockRequest
	var errorText *string
	err := s.Pool.QueryRow(ctx, `
		SELECT id::text, status, error FROM apm_lock_requests
		WHERE profile_id = $1::uuid AND organization_id = $2::uuid
		ORDER BY created_at DESC, id DESC
		LIMIT 1`, profileID, c.OrganizationID).Scan(&req.RequestID, &req.Status, &errorText)
	if errors.Is(err, pgx.ErrNoRows) {
		// No lock request has ever been made for this profile: the honest answer is
		// the unlocked state, which the caller already reads off apm_contents.
		return apmLockRequest{RequestID: "", Status: "", Error: ""}, nil
	}
	if err != nil {
		return apmLockRequest{}, fmt.Errorf("postgres: get apm lock: %w", err)
	}
	req.ProfileID = profileID
	if errorText != nil {
		req.Error = *errorText
	}
	return req, nil
}
