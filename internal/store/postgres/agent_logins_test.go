package postgres

// ADR-0085 (in-app agent sign-in) against a real PostgreSQL: the agent_logins
// queue end to end (create → claim → prompt → submit → poll → finish), the
// read-and-clear of submitted_code in one statement, the one-active partial
// unique index, the claim pinning and lease reclaims, the user-cancel-wins
// race, the journal rows that must ride the same commit as the status writes
// they report, and the Settings list over live workers. A fake would exercise
// none of the constraints that make this queue safe (AGENTS.md).

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/dbirks/communication/internal/api"
	"github.com/dbirks/communication/internal/events"
	"github.com/dbirks/communication/internal/worker"
)

// agentLoginFixture is cnvSetup (org, users, a live worker) plus the agent
// sign-in stores and the deletes a sign-in fixture leaves behind: the journal
// rows first (outbox before domain_events), then the status rows, the login
// rows and the workers this fixture registered. Cleanups are LIFO, so this
// one runs before cnvFixture.delete drops the users agent_logins references.
type agentLoginFixture struct {
	*cnvFixture
	logins   *AgentLoginStore
	accounts APIAgentAccountStore
	workers  []string
}

func agentLoginSetup(t *testing.T) *agentLoginFixture {
	t.Helper()
	f := &agentLoginFixture{cnvFixture: cnvSetup(t)}
	f.logins = &AgentLoginStore{Pool: f.pool}
	f.accounts = APIAgentAccountStore{S: f.logins, Registry: &WorkerRegistry{Pool: f.pool}}
	t.Cleanup(func() { f.erase() })
	return f
}

func (f *agentLoginFixture) erase() {
	ctx := context.Background()
	logins := `SELECT id::text FROM agent_logins WHERE requested_by = ANY($1::uuid[])`
	users := append([]string{f.alice, f.bob, f.carl, f.outsider, f.mallory}, f.extra...)
	for _, q := range []struct {
		sql  string
		args []any
	}{
		{`DELETE FROM outbox WHERE global_seq IN (SELECT global_seq FROM domain_events WHERE payload->>'login_id' IN (` + logins + `))`, []any{users}},
		{`DELETE FROM domain_events WHERE payload->>'login_id' IN (` + logins + `)`, []any{users}},
		{`DELETE FROM agent_account_status WHERE worker_id = ANY($1::text[])`, []any{f.workers}},
		{`DELETE FROM agent_logins WHERE requested_by = ANY($1::uuid[])`, []any{users}},
		{`DELETE FROM workers WHERE id = ANY($1::uuid[])`, []any{f.workers}},
	} {
		if _, err := f.pool.Exec(ctx, q.sql, q.args...); err != nil {
			f.t.Errorf("agent login cleanup %q: %v", q.sql, err)
		}
	}
}

// newWorker registers a live worker through the real registry — the same
// id::text the worker half will claim with.
func (f *agentLoginFixture) newWorker(suffix string) string {
	f.t.Helper()
	id, err := (&WorkerRegistry{Pool: f.pool}).Register(
		testCtx(f.t), "agentlogin-"+migFixtureToken(f.t)+"-"+suffix, "lab", "dev")
	if err != nil {
		f.t.Fatalf("register worker %q: %v", suffix, err)
	}
	f.workers = append(f.workers, id)
	return id
}

func (f *agentLoginFixture) caller(user string) api.Caller {
	return api.Caller{UserID: user, OrganizationID: f.orgID, IsOrgAdmin: true}
}

func (f *agentLoginFixture) otherOrgCaller() api.Caller {
	return api.Caller{UserID: f.mallory, OrganizationID: f.elseOrg, IsOrgAdmin: true}
}

func agentLoginCountEvents(t *testing.T, f *agentLoginFixture, ctx context.Context, typ, loginID string) int {
	t.Helper()
	var n int
	if err := f.pool.QueryRow(ctx, `
		SELECT count(*) FROM domain_events
		WHERE type = $1 AND payload->>'login_id' = $2`, typ, loginID).Scan(&n); err != nil {
		t.Fatalf("count %s events: %v", typ, err)
	}
	return n
}

func agentLoginEventActor(t *testing.T, f *agentLoginFixture, ctx context.Context, typ, loginID string) string {
	t.Helper()
	var kind string
	if err := f.pool.QueryRow(ctx, `
		SELECT actor_kind FROM domain_events
		WHERE type = $1 AND payload->>'login_id' = $2`, typ, loginID).Scan(&kind); err != nil {
		t.Fatalf("read %s event actor: %v", typ, err)
	}
	return kind
}

func agentLoginColumn(t *testing.T, f *agentLoginFixture, ctx context.Context, id, column string) any {
	t.Helper()
	var value any
	if err := f.pool.QueryRow(ctx, `SELECT `+column+` FROM agent_logins WHERE id = $1::uuid`, id).Scan(&value); err != nil {
		t.Fatalf("read agent_logins.%s: %v", column, err)
	}
	return value
}

// TestAgentLoginAntigravityEndToEnd walks the paste-back flow the ADR is about:
// an admin queues a sign-in, a worker claims it, the user pastes the
// authorization code, the worker's poll consumes it exactly once, and the
// finish lands the terminal status with its journal row in one commit.
func TestAgentLoginAntigravityEndToEnd(t *testing.T) {
	f := agentLoginSetup(t)
	ctx := testCtx(t)
	workerID := f.newWorker("e2e")

	view, err := f.accounts.CreateAgentLogin(ctx, f.caller(f.alice), "antigravity", "")
	if err != nil {
		t.Fatalf("CreateAgentLogin: %v", err)
	}
	if view.Status != "queued" || view.Launcher != "antigravity" || view.WorkerID != nil ||
		view.NeedsCode {
		t.Fatalf("queued view = %+v", view)
	}
	if _, err := time.Parse(time.RFC3339, view.ExpiresAt); err != nil {
		t.Errorf("expires_at %q is not RFC 3339: %v", view.ExpiresAt, err)
	}
	if n := agentLoginCountEvents(t, f, ctx, events.TypeAgentLoginStarted, view.ID); n != 1 {
		t.Errorf("agent.login.started rows = %d, want 1", n)
	}
	if kind := agentLoginEventActor(t, f, ctx, events.TypeAgentLoginStarted, view.ID); kind != events.ActorKindHuman {
		t.Errorf("agent.login.started actor kind = %q, want human", kind)
	}

	// A second attempt while the first is active is refused by the one-active
	// partial unique index, not by a check-then-insert race.
	if _, err := f.accounts.CreateAgentLogin(ctx, f.caller(f.alice), "antigravity", ""); !errors.Is(err, api.ErrAgentLoginActive) {
		t.Fatalf("second CreateAgentLogin err = %v, want ErrAgentLoginActive", err)
	}

	claim, ok, err := f.logins.ClaimAgentLogin(ctx, workerID, worker.AgentLoginLaunchers)
	if err != nil || !ok {
		t.Fatalf("ClaimAgentLogin: ok=%v err=%v", ok, err)
	}
	if claim.ID != view.ID || claim.OrganizationID != f.orgID || claim.Launcher != "antigravity" ||
		claim.WorkerID != workerID {
		t.Fatalf("claim = %+v", claim)
	}
	// The lease is held: nobody else — not even a second tick of the same
	// worker — wins the row until it lapses.
	if _, ok, err := f.logins.ClaimAgentLogin(ctx, workerID, worker.AgentLoginLaunchers); err != nil || ok {
		t.Fatalf("second claim: ok=%v err=%v, want ok=false err=nil (lease held)", ok, err)
	}

	if err := f.logins.SetAgentLoginPrompt(ctx, claim, "https://accounts.google.com/o/oauth2/auth?x=1", "", true); err != nil {
		t.Fatalf("SetAgentLoginPrompt: %v", err)
	}
	view, err = f.accounts.GetAgentLogin(ctx, f.caller(f.alice), view.ID)
	if err != nil {
		t.Fatalf("GetAgentLogin: %v", err)
	}
	if view.Status != "awaiting_user" || !view.NeedsCode || view.UserCode != nil {
		t.Fatalf("awaiting view = %+v, want awaiting_user, needs_code, no user code", view)
	}
	if view.VerificationURL == nil || !strings.HasPrefix(*view.VerificationURL, "https://accounts.google.com/") {
		t.Errorf("verification_url = %v, want the Google link", view.VerificationURL)
	}

	const pastedCode = "4/0abcDEF-xyz"
	if err := f.accounts.SubmitAgentLoginCode(ctx, f.caller(f.alice), view.ID, pastedCode); err != nil {
		t.Fatalf("SubmitAgentLoginCode: %v", err)
	}
	// The view never carries the pasted code — the type has no such member and
	// the row read here still predates the poll's consume.
	if got := agentLoginColumn(t, f, ctx, view.ID, "submitted_code"); got == nil {
		t.Fatal("submitted_code was cleared before any poll read it")
	}

	status, code, err := f.logins.PollAgentLogin(ctx, claim)
	if err != nil {
		t.Fatalf("PollAgentLogin: %v", err)
	}
	if status != "verifying" || code != pastedCode {
		t.Fatalf("first poll = (%q, %q), want (verifying, %q)", status, code, pastedCode)
	}
	// The same statement that returned the code cleared it: a second poll is
	// empty and the column is NULL again.
	if status, code, err := f.logins.PollAgentLogin(ctx, claim); err != nil || code != "" || status != "verifying" {
		t.Fatalf("second poll = (%q, %q, %v), want (verifying, \"\", nil)", status, code, err)
	}
	if got := agentLoginColumn(t, f, ctx, view.ID, "submitted_code"); got != nil {
		t.Fatalf("submitted_code after consume = %v, want NULL", got)
	}

	if err := f.logins.FinishAgentLogin(ctx, claim, worker.AgentLoginSucceeded, "david@example.com", ""); err != nil {
		t.Fatalf("FinishAgentLogin: %v", err)
	}
	view, err = f.accounts.GetAgentLogin(ctx, f.caller(f.alice), view.ID)
	if err != nil {
		t.Fatalf("GetAgentLogin after finish: %v", err)
	}
	if view.Status != "succeeded" || view.AccountLabel == nil || *view.AccountLabel != "david@example.com" {
		t.Fatalf("finished view = %+v", view)
	}
	if got := agentLoginColumn(t, f, ctx, view.ID, "lease_expires_at"); got != nil {
		t.Errorf("lease_expires_at after finish = %v, want NULL", got)
	}
	if n := agentLoginCountEvents(t, f, ctx, events.TypeAgentLoginSucceeded, view.ID); n != 1 {
		t.Errorf("agent.login.succeeded rows = %d, want 1", n)
	}
	if kind := agentLoginEventActor(t, f, ctx, events.TypeAgentLoginSucceeded, view.ID); kind != events.ActorKindWorker {
		t.Errorf("agent.login.succeeded actor kind = %q, want worker", kind)
	}
	// A terminal row releases the slot: the next attempt for the same
	// (org, launcher, any) is creatable again.
	if _, err := f.accounts.CreateAgentLogin(ctx, f.caller(f.alice), "antigravity", ""); err != nil {
		t.Errorf("CreateAgentLogin after a terminal row: %v, want the slot free", err)
	}
	// The error sentence is a display string: over-long text is truncated to
	// the column's bound, not refused and not stored whole.
	longClaim, ok, err := f.logins.ClaimAgentLogin(ctx, workerID, worker.AgentLoginLaunchers)
	if err != nil || !ok {
		t.Fatalf("claim follow-up: ok=%v err=%v", ok, err)
	}
	if err := f.logins.FinishAgentLogin(ctx, longClaim, worker.AgentLoginFailed, "", strings.Repeat("e", 600)); err != nil {
		t.Fatalf("FinishAgentLogin long error: %v", err)
	}
	if got := agentLoginColumn(t, f, ctx, longClaim.ID, "error"); got == nil || len(got.(string)) != 500 {
		t.Errorf("error length = %v, want the 500-char truncation", got)
	}
}

// TestAgentLoginCancelWinsTheRace covers the Codex dialog's other ending: the
// user cancels while the device code is on screen. The poll must answer with
// the status rather than an error (the driver stops its child), the finish
// after a cancel is a no-op (the journal records one ending, the user's), and
// a late fenced write still refuses with the lost lease.
func TestAgentLoginCancelWinsTheRace(t *testing.T) {
	f := agentLoginSetup(t)
	ctx := testCtx(t)
	workerID := f.newWorker("cancel")

	view, err := f.accounts.CreateAgentLogin(ctx, f.caller(f.alice), "codex", "")
	if err != nil {
		t.Fatalf("CreateAgentLogin: %v", err)
	}
	claim, ok, err := f.logins.ClaimAgentLogin(ctx, workerID, worker.AgentLoginLaunchers)
	if err != nil || !ok {
		t.Fatalf("ClaimAgentLogin: ok=%v err=%v", ok, err)
	}
	if err := f.logins.SetAgentLoginPrompt(ctx, claim, "https://auth.openai.com/codex/device", "ABC-123", false); err != nil {
		t.Fatalf("SetAgentLoginPrompt: %v", err)
	}
	view, err = f.accounts.GetAgentLogin(ctx, f.caller(f.alice), view.ID)
	if err != nil {
		t.Fatalf("GetAgentLogin: %v", err)
	}
	if view.UserCode == nil || *view.UserCode != "ABC-123" || view.NeedsCode {
		t.Fatalf("codex prompt view = %+v, want the device code and no paste-back", view)
	}

	if err := f.accounts.CancelAgentLogin(ctx, f.caller(f.alice), view.ID); err != nil {
		t.Fatalf("CancelAgentLogin: %v", err)
	}
	if n := agentLoginCountEvents(t, f, ctx, events.TypeAgentLoginCancelled, view.ID); n != 1 {
		t.Fatalf("agent.login.cancelled rows = %d, want 1", n)
	}
	if status, code, err := f.logins.PollAgentLogin(ctx, claim); err != nil || status != "cancelled" || code != "" {
		t.Fatalf("poll after cancel = (%q, %q, %v), want (cancelled, \"\", nil)", status, code, err)
	}
	if err := f.logins.FinishAgentLogin(ctx, claim, worker.AgentLoginSucceeded, "late@example.com", ""); err != nil {
		t.Fatalf("FinishAgentLogin over a cancelled row = %v, want the no-op nil", err)
	}
	if got := agentLoginColumn(t, f, ctx, view.ID, "status"); got != "cancelled" {
		t.Errorf("status after the late finish = %v, want cancelled (the user's cancel won)", got)
	}
	if n := agentLoginCountEvents(t, f, ctx, events.TypeAgentLoginSucceeded, view.ID); n != 0 {
		t.Errorf("agent.login.succeeded rows = %d, want 0 — the cancelled row journals one ending", n)
	}
	if err := f.logins.SetAgentLoginPrompt(ctx, claim, "https://x", "", false); !errors.Is(err, worker.ErrLeaseLost) {
		t.Errorf("late prompt after cancel err = %v, want ErrLeaseLost", err)
	}
	// Cancelling a terminal row is not an error, and it journals nothing more.
	if err := f.accounts.CancelAgentLogin(ctx, f.caller(f.alice), view.ID); err != nil {
		t.Errorf("second CancelAgentLogin err = %v, want nil (already terminal)", err)
	}
	if n := agentLoginCountEvents(t, f, ctx, events.TypeAgentLoginCancelled, view.ID); n != 1 {
		t.Errorf("agent.login.cancelled rows = %d, want still 1", n)
	}
}

// TestAgentLoginClaimPinningAndLeaseReuse is the credential-volume rule: a row
// pinned to worker A can never be claimed by worker B — not queued, not after
// its lease lapsed — while A itself re-wins its own lapsed row without losing
// the status the driver was mid-way through.
func TestAgentLoginClaimPinningAndLeaseReuse(t *testing.T) {
	f := agentLoginSetup(t)
	ctx := testCtx(t)
	workerA := f.newWorker("pin-a")
	workerB := f.newWorker("pin-b")

	view, err := f.accounts.CreateAgentLogin(ctx, f.caller(f.alice), "codex", workerA)
	if err != nil {
		t.Fatalf("CreateAgentLogin: %v", err)
	}
	if view.WorkerID == nil || *view.WorkerID != workerA {
		t.Fatalf("pinned view = %+v, want worker_id %s", view, workerA)
	}
	if _, ok, err := f.logins.ClaimAgentLogin(ctx, workerB, worker.AgentLoginLaunchers); err != nil || ok {
		t.Fatalf("worker B claim: ok=%v err=%v, want ok=false (row pinned to A)", ok, err)
	}
	claim, ok, err := f.logins.ClaimAgentLogin(ctx, workerA, worker.AgentLoginLaunchers)
	if err != nil || !ok {
		t.Fatalf("worker A claim: ok=%v err=%v", ok, err)
	}
	if err := f.logins.SetAgentLoginPrompt(ctx, claim, "https://auth.openai.com/codex/device", "CODE-1", false); err != nil {
		t.Fatalf("SetAgentLoginPrompt: %v", err)
	}

	// The lease lapsed mid-awaiting: B still cannot take A's credential volume,
	// and A's re-claim keeps awaiting_user rather than resetting to starting.
	if _, err := f.pool.Exec(ctx,
		`UPDATE agent_logins SET lease_expires_at = now() - interval '1 second' WHERE id = $1::uuid`, claim.ID); err != nil {
		t.Fatalf("expire lease: %v", err)
	}
	if _, ok, err := f.logins.ClaimAgentLogin(ctx, workerB, worker.AgentLoginLaunchers); err != nil || ok {
		t.Fatalf("worker B claim on lapsed A row: ok=%v err=%v, want ok=false", ok, err)
	}
	reclaim, ok, err := f.logins.ClaimAgentLogin(ctx, workerA, worker.AgentLoginLaunchers)
	if err != nil || !ok {
		t.Fatalf("worker A re-claim: ok=%v err=%v", ok, err)
	}
	if reclaim.ID != claim.ID {
		t.Fatalf("re-claim = %+v, want the same row", reclaim)
	}
	if got := agentLoginColumn(t, f, ctx, claim.ID, "status"); got != "awaiting_user" {
		t.Errorf("status after re-claim = %v, want awaiting_user kept", got)
	}

	// The claim's index guard: an "any worker" row for the same launcher is
	// allowed beside A's active row (different coalesce key), but pinning it
	// to A would collide with the one-active index — so A's claim skips it
	// (and has nothing else due), while B, holding no codex row, takes it.
	anyView, err := f.accounts.CreateAgentLogin(ctx, f.caller(f.alice), "codex", "")
	if err != nil {
		t.Fatalf("CreateAgentLogin any-worker: %v", err)
	}
	if _, ok, err := f.logins.ClaimAgentLogin(ctx, workerA, worker.AgentLoginLaunchers); err != nil || ok {
		t.Fatalf("worker A claim with the any-worker row outstanding: ok=%v err=%v, want ok=false (index skip)", ok, err)
	}
	claimedB, ok, err := f.logins.ClaimAgentLogin(ctx, workerB, worker.AgentLoginLaunchers)
	if err != nil || !ok {
		t.Fatalf("worker B claim of the any-worker row: ok=%v err=%v", ok, err)
	}
	if claimedB.ID != anyView.ID {
		t.Fatalf("worker B took %s, want the any-worker row %s", claimedB.ID, anyView.ID)
	}

	// A claim with a stale worker identity is the lost lease on every fence:
	// neither poll, prompt nor finish writes through it.
	stranger := claim
	stranger.WorkerID = workerB
	if _, _, err := f.logins.PollAgentLogin(ctx, stranger); !errors.Is(err, worker.ErrLeaseLost) {
		t.Errorf("stranger poll err = %v, want ErrLeaseLost", err)
	}
	if err := f.logins.FinishAgentLogin(ctx, stranger, worker.AgentLoginFailed, "", "gone"); !errors.Is(err, worker.ErrLeaseLost) {
		t.Errorf("stranger finish err = %v, want ErrLeaseLost", err)
	}
	if got := agentLoginColumn(t, f, ctx, claim.ID, "status"); got != "awaiting_user" {
		t.Errorf("status after refused stranger writes = %v, want awaiting_user", got)
	}
}

// TestAgentLoginScopingAndStateRefusals covers the API half's refusals: another
// organization's row is not found (never read), a code submitted to a row that
// did not ask for one is the state 409, and an unknown launcher has no account
// surface at all.
func TestAgentLoginScopingAndStateRefusals(t *testing.T) {
	f := agentLoginSetup(t)
	ctx := testCtx(t)

	view, err := f.accounts.CreateAgentLogin(ctx, f.caller(f.alice), "antigravity", "")
	if err != nil {
		t.Fatalf("CreateAgentLogin: %v", err)
	}
	if _, err := f.accounts.GetAgentLogin(ctx, f.otherOrgCaller(), view.ID); !errors.Is(err, api.ErrAgentLoginNotFound) {
		t.Errorf("cross-org Get err = %v, want NotFound", err)
	}
	if err := f.accounts.SubmitAgentLoginCode(ctx, f.otherOrgCaller(), view.ID, "x"); !errors.Is(err, api.ErrAgentLoginNotFound) {
		t.Errorf("cross-org Submit err = %v, want NotFound", err)
	}
	if err := f.accounts.CancelAgentLogin(ctx, f.otherOrgCaller(), view.ID); !errors.Is(err, api.ErrAgentLoginNotFound) {
		t.Errorf("cross-org Cancel err = %v, want NotFound", err)
	}
	// Not found for Mallory is not visible for her, and still untouched by her:
	// the row's own organization sees it unchanged.
	if again, err := f.accounts.GetAgentLogin(ctx, f.caller(f.alice), view.ID); err != nil || again.Status != "queued" {
		t.Errorf("row after cross-org attempts = %+v, %v, want unchanged queued", again, err)
	}

	// A queued row has not asked for a code; Submit answers the state 409.
	if err := f.accounts.SubmitAgentLoginCode(ctx, f.caller(f.alice), view.ID, "too-early"); !errors.Is(err, api.ErrAgentLoginState) {
		t.Errorf("submit on queued row err = %v, want ErrAgentLoginState", err)
	}

	// A claimed Codex row asks for a device code, not a paste-back: needs_code
	// stays false and Submit refuses with the state 409, same organization.
	workerID := f.newWorker("state-codex")
	codexView, err := f.accounts.CreateAgentLogin(ctx, f.caller(f.alice), "codex", workerID)
	if err != nil {
		t.Fatalf("CreateAgentLogin codex: %v", err)
	}
	claim, ok, err := f.logins.ClaimAgentLogin(ctx, workerID, worker.AgentLoginLaunchers)
	if err != nil || !ok {
		t.Fatalf("claim codex: ok=%v err=%v", ok, err)
	}
	if err := f.logins.SetAgentLoginPrompt(ctx, claim, "https://auth.openai.com/codex/device", "XYZ-123", false); err != nil {
		t.Fatalf("SetAgentLoginPrompt: %v", err)
	}
	if err := f.accounts.SubmitAgentLoginCode(ctx, f.caller(f.alice), codexView.ID, "not-wanted"); !errors.Is(err, api.ErrAgentLoginState) {
		t.Errorf("submit on needs_code=false row err = %v, want ErrAgentLoginState", err)
	}

	// Unknown launcher: there is no account surface to sign into → NotFound.
	if _, err := f.accounts.CreateAgentLogin(ctx, f.caller(f.alice), "claude", ""); !errors.Is(err, api.ErrAgentLoginNotFound) {
		t.Errorf("CreateAgentLogin claude err = %v, want NotFound", err)
	}
	// A well-formed id with no row is NotFound too.
	if _, err := f.accounts.GetAgentLogin(ctx, f.caller(f.alice), "00000000-0000-7000-8000-000000000099"); !errors.Is(err, api.ErrAgentLoginNotFound) {
		t.Errorf("Get of a missing row err = %v, want NotFound", err)
	}
}

// TestAgentAccountListUnknownForLiveWorker reads the Settings half: a live
// worker lists exactly the launchers it reported a status for (one row each,
// codex before antigravity), a launcher it never reported is not offered,
// offline workers are absent entirely, the probe
// upsert overwrites its own key, and the login beside a row is the org's most
// recent attempt for that launcher and worker.
func TestAgentAccountListUnknownForLiveWorker(t *testing.T) {
	f := agentLoginSetup(t)
	ctx := testCtx(t)
	live := f.newWorker("list-live")
	gone := f.newWorker("list-gone")
	if _, err := f.pool.Exec(ctx, `UPDATE workers SET status = 'offline' WHERE id = $1::uuid`, gone); err != nil {
		t.Fatalf("take worker offline: %v", err)
	}

	items, err := f.accounts.ListAgentAccounts(ctx, f.caller(f.alice))
	if err != nil {
		t.Fatalf("ListAgentAccounts: %v", err)
	}
	// A worker that never reported a launcher's status has no driver for it
	// (or has not probed yet): that launcher is not offered for it at all.
	if mine := agentLoginMyItems(items, live); len(mine) != 0 {
		t.Fatalf("items for a live worker with no status rows = %+v, want none", mine)
	}
	for _, item := range items {
		if item.WorkerID == gone {
			t.Errorf("offline worker %s appears in the list", gone)
		}
	}

	if err := f.logins.UpsertAgentAccountStatus(ctx, live, "codex",
		worker.AgentAccountSignedIn, "david@example.com", "account/read answered"); err != nil {
		t.Fatalf("UpsertAgentAccountStatus: %v", err)
	}
	// The upsert keyed by (worker_id, launcher): the second write replaces the
	// probe answer, it does not add a row or resurrect the old label.
	if err := f.logins.UpsertAgentAccountStatus(ctx, live, "codex",
		worker.AgentAccountSignedOut, "", ""); err != nil {
		t.Fatalf("UpsertAgentAccountStatus overwrite: %v", err)
	}
	if err := f.logins.UpsertAgentAccountStatus(ctx, live, "antigravity",
		worker.AgentAccountUnknown, "", ""); err != nil {
		t.Fatalf("UpsertAgentAccountStatus antigravity: %v", err)
	}
	if _, err := f.accounts.CreateAgentLogin(ctx, f.caller(f.alice), "antigravity", live); err != nil {
		t.Fatalf("CreateAgentLogin pinned to the live worker: %v", err)
	}

	items, err = f.accounts.ListAgentAccounts(ctx, f.caller(f.alice))
	if err != nil {
		t.Fatalf("ListAgentAccounts after probe: %v", err)
	}
	mine := agentLoginMyItems(items, live)
	if len(mine) != 2 {
		t.Fatalf("items after probe = %d, want 2", len(mine))
	}
	codex, anti := mine[0], mine[1]
	if codex.State != worker.AgentAccountSignedOut || codex.AccountLabel != nil ||
		codex.Detail != nil || codex.CheckedAt == nil {
		t.Errorf("codex row after overwrite = %+v, want signed_out with a fresh checked_at and null label/detail", codex)
	}
	if anti.State != worker.AgentAccountUnknown || anti.Login == nil || anti.Login.Status != "queued" ||
		anti.Login.WorkerID == nil || *anti.Login.WorkerID != live {
		t.Errorf("antigravity row = %+v, want unknown with the queued pinned login", anti)
	}

	var rows int
	if err := f.pool.QueryRow(ctx,
		`SELECT count(*) FROM agent_account_status WHERE worker_id = $1 AND launcher = 'codex'`, live).Scan(&rows); err != nil {
		t.Fatalf("count account status rows: %v", err)
	}
	if rows != 1 {
		t.Errorf("agent_account_status rows for (worker, codex) = %d, want 1 (the upsert replaced)", rows)
	}
}

// agentLoginMyItems filters the list down to one worker's rows, keeping the
// list's own order (the shared lab database legitimately has other fixtures'
// workers; this test's assertions are only ever about its own).
func agentLoginMyItems(items []api.AgentAccountView, workerID string) []api.AgentAccountView {
	var out []api.AgentAccountView
	for _, item := range items {
		if item.WorkerID == workerID {
			out = append(out, item)
		}
	}
	return out
}
