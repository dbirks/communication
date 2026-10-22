package postgres

// ADR-0054 amendment 1 (server-side APM lock, implementation): the durable
// apm_lock_requests queue end to end against real PostgreSQL — queue a resolve,
// the claim arbitration, the one-transaction complete (digest + contents
// summary + journal event), the failure path, and cross-org invisibility.

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/dbirks/communication/internal/agent/apm"
	"github.com/dbirks/communication/internal/api"
	"github.com/dbirks/communication/internal/events"
)

// apmLockTestProfile creates a profile with a complete APM pin — the state a
// lock can only ever be dispatched for — and returns its id.
func apmLockTestProfile(t *testing.T, f *profWFixture, ctx context.Context, suffix string) string {
	t.Helper()
	name := f.profWName("lock-" + suffix)
	profile, err := f.api.CreateAgentProfile(ctx, f.caller(f.alice, true),
		api.AgentProfileCreateInput{Name: name, LauncherID: "claude"})
	if err != nil {
		t.Fatalf("CreateAgentProfile: %v", err)
	}
	if _, err := f.api.PatchAgentProfileAPM(ctx, f.caller(f.alice, true), profile.ID,
		api.AgentProfileAPMPatch{
			APMPackageRef: ptr("mattpocock/skills#v1.3.1"),
			APMTarget:     ptr("claude"),
			APMLockDigest: ptr("sha256:" + strings.Repeat("a", 64)),
		}); err != nil {
		t.Fatalf("PatchAgentProfileAPM: %v", err)
	}
	// The lock queue references the profile, so its rows must go before the
	// profile delete in the fixture cleanup runs (LIFO: registered here, it runs
	// before profWSetup's own cleanup).
	t.Cleanup(func() {
		if _, err := f.pool.Exec(ctx, `DELETE FROM apm_lock_requests WHERE profile_id = $1::uuid`, profile.ID); err != nil {
			t.Errorf("apm lock cleanup: %v", err)
		}
	})
	return profile.ID
}

func TestAPMLockRequestClaimAndComplete(t *testing.T) {
	f := profWSetup(t)
	ctx := testCtx(t)
	profileID := apmLockTestProfile(t, f, ctx, "complete")

	req, err := f.api.CreateAPMLockRequest(ctx, f.caller(f.alice, true), profileID)
	if err != nil {
		t.Fatalf("CreateAPMLockRequest: %v", err)
	}
	if req.Status != "queued" || req.RequestID == "" {
		t.Fatalf("queued request = %+v", req)
	}

	store := &TurnStore{Pool: f.pool}
	claim, ok, err := store.ClaimAPMLockRequest(ctx, f.worker)
	if err != nil {
		t.Fatalf("ClaimAPMLockRequest: %v", err)
	}
	if !ok {
		t.Fatal("the queued lock was never claimed")
	}
	if claim.ProfileID != profileID || claim.PackageRef != "mattpocock/skills#v1.3.1" ||
		claim.Target != "claude" {
		t.Fatalf("claim = %+v", claim)
	}

	// A second claimer must not take the row the first already holds: the claim's
	// lease is not due yet, so the due-scan skips it instead of waiting on it.
	if _, ok, err := store.ClaimAPMLockRequest(ctx, "01987a71-3333-7000-8000-abcdef012345"); err != nil || ok {
		t.Fatalf("second claim: ok=%v err=%v, want ok=false err=nil (lease held)", ok, err)
	}

	result := &apm.ResolveResult{
		LockDigest:  "sha256:" + strings.Repeat("a", 64),
		ResolvedRef: "v1.3.1",
		Commit:      "abc123def456",
		APMVersion:  "0.33.0",
		Contents: apm.Contents{
			Skills:       []string{"engineering"},
			Instructions: []string{"AGENTS.md"},
			MCPServers:   []string{"memory"},
		},
	}
	if err := store.CompleteAPMLockRequest(ctx, claim, result, nil); err != nil {
		t.Fatalf("CompleteAPMLockRequest: %v", err)
	}

	var status *string
	if err := f.pool.QueryRow(ctx,
		`SELECT status FROM apm_lock_requests WHERE id = $1::uuid`, claim.RequestID).Scan(&status); err != nil {
		t.Fatalf("read lock request status: %v", err)
	}
	if status == nil || *status != "done" {
		t.Errorf("lock request status = %v, want done", status)
	}
	var digest *string
	if err := f.pool.QueryRow(ctx,
		`SELECT apm_lock_digest FROM agent_profiles WHERE id = $1::uuid`, profileID).Scan(&digest); err != nil {
		t.Fatalf("read profile digest: %v", err)
	}
	if digest == nil || *digest != result.LockDigest {
		t.Errorf("apm_lock_digest = %v, want %q", digest, result.LockDigest)
	}
	var contentsJSON *string
	if err := f.pool.QueryRow(ctx,
		`SELECT apm_contents_summary::text FROM agent_profiles WHERE id = $1::uuid`, profileID).Scan(&contentsJSON); err != nil {
		t.Fatalf("read profile contents summary: %v", err)
	}
	var summary struct {
		Skills       []string `json:"skills"`
		Instructions []string `json:"instructions"`
		MCPServers   []string `json:"mcp_servers"`
		Truncated    bool     `json:"truncated"`
	}
	if err := json.Unmarshal([]byte(*contentsJSON), &summary); err != nil {
		t.Fatalf("decode apm_contents_summary: %v", err)
	}
	if len(summary.Skills) != 1 || summary.Skills[0] != "engineering" ||
		len(summary.Instructions) != 1 || summary.Instructions[0] != "AGENTS.md" ||
		len(summary.MCPServers) != 1 || summary.MCPServers[0] != "memory" || summary.Truncated {
		t.Errorf("contents summary = %+v", summary)
	}
	if n := profWCountEvents(t, f, ctx, events.TypeAgentProfileAPMLocked, profileID); n != 1 {
		t.Errorf("agent.profile.apm_locked rows = %d, want 1", n)
	}
}

func TestAPMLockRequestFailureMarksFailed(t *testing.T) {
	f := profWSetup(t)
	ctx := testCtx(t)
	profileID := apmLockTestProfile(t, f, ctx, "failed")

	req, err := f.api.CreateAPMLockRequest(ctx, f.caller(f.alice, true), profileID)
	if err != nil {
		t.Fatalf("CreateAPMLockRequest: %v", err)
	}
	if req.Status != "queued" {
		t.Fatalf("queued request = %+v", req)
	}
	claim, ok, err := (&TurnStore{Pool: f.pool}).ClaimAPMLockRequest(ctx, f.worker)
	if err != nil || !ok {
		t.Fatalf("claim: ok=%v err=%v", ok, err)
	}
	resolveErr := apm.ErrResolveFailed
	if err := (&TurnStore{Pool: f.pool}).CompleteAPMLockRequest(ctx, claim, nil, resolveErr); err != nil {
		t.Fatalf("CompleteAPMLockRequest: %v", err)
	}
	var status *string
	if err := f.pool.QueryRow(ctx,
		`SELECT status FROM apm_lock_requests WHERE id = $1::uuid`, claim.RequestID).Scan(&status); err != nil {
		t.Fatalf("read failed lock request: %v", err)
	}
	if status == nil || *status != "failed" {
		t.Errorf("lock request status = %v, want failed", status)
	}
	var errorText *string
	if err := f.pool.QueryRow(ctx,
		`SELECT error FROM apm_lock_requests WHERE id = $1::uuid`, claim.RequestID).Scan(&errorText); err != nil {
		t.Fatalf("read failed lock error: %v", err)
	}
	if errorText == nil || !strings.Contains(*errorText, apm.ErrResolveFailed.Error()) {
		t.Errorf("failed lock error = %v, want the bounded resolve refusal", errorText)
	}
	var digest *string
	if err := f.pool.QueryRow(ctx,
		`SELECT apm_lock_digest FROM agent_profiles WHERE id = $1::uuid`, profileID).Scan(&digest); err != nil {
		t.Fatalf("read profile digest: %v", err)
	}
	// The failed resolve must not move the profile's recorded lock: whatever
	// digest the pin already carried (the manual-lock one from the fixture) stays.
	if digest == nil || *digest != "sha256:"+strings.Repeat("a", 64) {
		t.Errorf("apm_lock_digest = %v, want the pin's digest unchanged", digest)
	}
	if n := profWCountEvents(t, f, ctx, events.TypeAgentProfileAPMLocked, profileID); n != 0 {
		t.Errorf("agent.profile.apm_locked rows = %d, want 0 on the failure path", n)
	}
}

func TestAPMLockRequestCrossOrgInvisible(t *testing.T) {
	f := profWSetup(t)
	ctx := testCtx(t)
	profileID := apmLockTestProfile(t, f, ctx, "crossorg")

	otherOrgCaller := api.Caller{UserID: f.elseOrg, OrganizationID: f.elseOrg, IsOrgAdmin: true}
	if _, err := f.api.CreateAPMLockRequest(ctx, otherOrgCaller, profileID); !errors.Is(err, api.ErrProfileNotFound) {
		t.Fatalf("cross-org CreateAPMLockRequest err = %v, want ErrProfileNotFound", err)
	}
	if _, err := f.api.GetAPMLockRequest(ctx, otherOrgCaller, profileID); !errors.Is(err, api.ErrProfileNotFound) {
		t.Fatalf("cross-org GetAPMLockRequest err = %v, want ErrProfileNotFound", err)
	}
}
