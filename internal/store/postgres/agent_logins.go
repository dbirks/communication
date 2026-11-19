package postgres

// ADR-0085 (in-app agent sign-in): the agent_logins queue and the
// agent_account_status read, in both faces the rest of the system talks to —
// the worker-side AgentLoginStore (claim/prompt/poll/finish against a real
// launcher child) and the api-side AgentAccountStore behind the Settings
// "Agent accounts" routes.
//
// The rules this file carries are the apm_lock.go rules restated for logins:
//
//   - The claim is FOR UPDATE SKIP LOCKED + lease, ONE statement. A queued row
//     is open to the worker it names or to any worker when it names none; a
//     starting/awaiting_user/verifying row only re-opens to its own worker once
//     the lease lapsed (a login child outlived its claimer's process), so a
//     second worker can never run a sign-in against a credential volume that is
//     not its own.
//   - Every worker write is fenced on (id, claimed_by, an active status): a
//     worker that lost the lease — or a row the user cancelled — is refused
//     with ErrLeaseLost and writes nothing. The one polite exception is the
//     user's cancel itself: Poll reports it as a status (the driver must stop
//     its child, not error), and Finish over a cancelled row is a no-op — the
//     user's cancel wins a race with the worker's report.
//   - submitted_code is read and cleared in the SAME statement that reads it
//     (CTE select FOR UPDATE + UPDATE ... RETURNING): the pasted Antigravity
//     authorization code can be consumed exactly once, and no view of the row
//     ever selects it.
//   - State + its journal row in ONE transaction (ADR-0013): agent.login.*
//     rides the same commit as the status write it reports. Payloads carry
//     ids, launcher, worker and label — never a code, never a URL (ADR-0085
//     § Security/privacy).

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/dbirks/communication/internal/api"
	"github.com/dbirks/communication/internal/events"
	"github.com/dbirks/communication/internal/worker"
)

// agentLoginActiveSQL is the agent_logins.status set the partial unique index
// calls active — the fence every worker write and every cancel must hold.
const agentLoginActiveSQL = "('queued', 'starting', 'awaiting_user', 'verifying')"

// agentLoginErrorMaxChars bounds agent_logins.error: the launcher child's last
// stderr/stdout line is a human sentence, not a log stream. Truncation is by
// runes (left() counts characters), so a multi-byte tail cannot be cut mid rune.
const agentLoginErrorMaxChars = 500

// agentLoginLifetime is the ADR's created_at + 15 minutes, applied at create
// as now() + the interval so the row's own clock, not the API caller's, sets it.
const agentLoginCreateLifetimeSQL = `now() + interval '15 minutes'`

// ClaimAgentLogin wins at most one sign-in for workerID, in the apm-lock
// claim's one-statement shape: the CTE picks the oldest due row FOR UPDATE
// SKIP LOCKED (a queued row pinned to nobody or to this worker; a pinned
// starting/awaiting_user/verifying row whose lease has lapsed), and the
// UPDATE takes it — status drops to starting only when it was queued, so an
// expired-lease re-claim keeps the state the driver was mid-way through.
// The claim always pins worker_id and claimed_by to the claimer: the second
// an attempt starts, the credential volume it writes is this worker's. One
// guard rides the pick: an "any worker" row is skipped for a claimer that
// already holds an active row for the same organization+launcher, because
// pinning THAT row would collide with the one-active index — the skip is
// honest (that worker has a sign-in in flight), where an index error would
// wedge the claim loop on one unlucky row.
func (s *AgentLoginStore) ClaimAgentLogin(ctx context.Context, workerID string, launchers []string) (worker.AgentLoginClaim, bool, error) {
	if len(launchers) == 0 {
		return worker.AgentLoginClaim{}, false, nil
	}
	if workerID == "" {
		return worker.AgentLoginClaim{}, false, errors.New("postgres: claim agent login requires a worker id")
	}
	var c worker.AgentLoginClaim
	err := s.Pool.QueryRow(ctx, `
		WITH picked AS (
			SELECT id
			FROM agent_logins q
			WHERE q.launcher = ANY($3::text[]) AND ((q.status = 'queued' AND (q.worker_id = $1 OR (q.worker_id IS NULL AND NOT EXISTS (
			    -- Pinning this "any worker" row to $1 would collide with the
			    -- one-active index if $1 already holds an active row for the
			    -- same organization+launcher: skip it, do not error the claim.
			    SELECT 1 FROM agent_logins o
			    WHERE o.status IN `+agentLoginActiveSQL+`
			      AND o.organization_id = q.organization_id
			      AND o.launcher = q.launcher
			      AND o.worker_id = $1
			))))
			   OR (q.status IN ('starting', 'awaiting_user', 'verifying')
			       AND q.worker_id = $1 AND q.lease_expires_at < now()))
			ORDER BY q.created_at, q.id
			FOR UPDATE OF q SKIP LOCKED
			LIMIT 1
		)
		UPDATE agent_logins l
		SET status = CASE WHEN l.status = 'queued' THEN 'starting' ELSE l.status END,
		    claimed_by = $1,
		    worker_id = $1,
		    lease_expires_at = now() + make_interval(secs => $2::double precision),
		    updated_at = now()
		FROM picked p
		WHERE l.id = p.id
		RETURNING l.id::text, l.organization_id::text, l.launcher, COALESCE(l.worker_id, ''), l.expires_at`,
		workerID, worker.DefaultAgentLoginLease.Seconds(), launchers).
		Scan(&c.ID, &c.OrganizationID, &c.Launcher, &c.WorkerID, &c.ExpiresAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return worker.AgentLoginClaim{}, false, nil
	}
	if err != nil {
		return worker.AgentLoginClaim{}, false, fmt.Errorf("postgres: claim agent login: %w", err)
	}
	return c, true, nil
}

// SetAgentLoginPrompt records what the user must see (the link; Codex's device
// code; whether a paste-back is wanted) and moves the row to awaiting_user.
// Empty userCode/verificationURL store NULL, not ” — the UI renders absence
// honestly. A refused write is a lost lease (or a cancelled row): the driver
// stops its child.
func (s *AgentLoginStore) SetAgentLoginPrompt(ctx context.Context, c worker.AgentLoginClaim, verificationURL, userCode string, needsCode bool) error {
	tag, err := s.Pool.Exec(ctx, `
		UPDATE agent_logins
		SET verification_url = NULLIF($3, ''),
		    user_code = NULLIF($4, ''),
		    needs_code = $5,
		    status = 'awaiting_user',
		    updated_at = now()
		WHERE id = $1::uuid AND claimed_by = $2
		  AND status IN `+agentLoginActiveSQL,
		c.ID, c.WorkerID, verificationURL, userCode, needsCode)
	if err != nil {
		return fmt.Errorf("postgres: set agent login prompt: %w", err)
	}
	if tag.RowsAffected() == 1 {
		return nil
	}
	return s.agentLoginFenceLost(ctx, c.ID, false)
}

// PollAgentLogin renews the lease and consumes one submitted code, all in the
// same statement: the CTE selects the row FOR UPDATE (the fence) together with
// the old submitted_code, and the UPDATE clears the code and moves the row to
// verifying exactly when it handed the code out — so a code can never be read
// twice, and a second poll after a submit reads "" with status verifying. A
// cancelled row returns status cancelled and no error: the driver stops its
// child and finishes nothing. A lost lease returns ErrLeaseLost.
func (s *AgentLoginStore) PollAgentLogin(ctx context.Context, c worker.AgentLoginClaim) (status, code string, err error) {
	var rowStatus, oldCode string
	err = s.Pool.QueryRow(ctx, `
		WITH row AS (
			SELECT id, submitted_code
			FROM agent_logins
			WHERE id = $1::uuid AND claimed_by = $2
			  AND status IN `+agentLoginActiveSQL+`
			FOR UPDATE
		)
		UPDATE agent_logins l
		SET lease_expires_at = now() + make_interval(secs => $3::double precision),
		    status = CASE WHEN r.submitted_code IS NOT NULL THEN 'verifying' ELSE l.status END,
		    submitted_code = CASE WHEN r.submitted_code IS NOT NULL THEN NULL ELSE l.submitted_code END
		FROM row r
		WHERE l.id = r.id
		RETURNING l.status, COALESCE(r.submitted_code, '')`,
		c.ID, c.WorkerID, worker.DefaultAgentLoginLease.Seconds()).Scan(&rowStatus, &oldCode)
	if errors.Is(err, pgx.ErrNoRows) {
		lostErr := s.agentLoginFenceLost(ctx, c.ID, true)
		var cancelled agentLoginCancelledError
		if errors.As(lostErr, &cancelled) {
			return worker.AgentLoginCancelled, "", nil
		}
		return "", "", lostErr
	}
	if err != nil {
		return "", "", fmt.Errorf("postgres: poll agent login: %w", err)
	}
	return rowStatus, oldCode, nil
}

// agentLoginCancelledError marks "the row exists and the user cancelled it"
// inside the fence-loss path: it is not a lease problem, and PollAgentLogin
// turns it into a status answer rather than an error.
type agentLoginCancelledError struct{}

func (agentLoginCancelledError) Error() string { return "postgres: agent login was cancelled" }

// agentLoginFenceLost decides why a fenced write landed on nothing. A row that
// is gone or that another worker holds is the lost lease; the cancelled row is
// reported distinctly because cancel races the worker by design. finishMode
// (the FinishAgentLogin call) folds the cancelled case into plain success at
// the caller — the user's cancel wins.
func (s *AgentLoginStore) agentLoginFenceLost(ctx context.Context, loginID string, cancelledIsStatus bool) error {
	var status string
	err := s.Pool.QueryRow(ctx, `SELECT status FROM agent_logins WHERE id = $1::uuid`, loginID).Scan(&status)
	if errors.Is(err, pgx.ErrNoRows) {
		return worker.ErrLeaseLost
	}
	if err != nil {
		return fmt.Errorf("postgres: fence agent login %s: %w", loginID, err)
	}
	if cancelledIsStatus && status == worker.AgentLoginCancelled {
		return agentLoginCancelledError{}
	}
	return worker.ErrLeaseLost
}

// agentLoginTerminalStatuses are the only statuses a worker may report; the
// user's side of the queue (cancel) belongs to the API half.
var agentLoginTerminalStatuses = map[string]bool{
	worker.AgentLoginSucceeded: true,
	worker.AgentLoginFailed:    true,
	worker.AgentLoginExpired:   true,
	worker.AgentLoginCancelled: true,
}

// FinishAgentLogin writes the terminal status, the account label and the human
// error sentence, clears submitted_code and the lease, and journals
// agent.login.<status> in the same transaction (ADR-0013). The sentence is
// truncated to 500 chars here rather than refused: it is already a redacted
// one-line summary from the driver, and losing its tail beats losing the
// outcome. A cancelled row is a no-op nil — the user cancelled first and the
// journal says so once; any other refused write is the lost lease.
func (s *AgentLoginStore) FinishAgentLogin(ctx context.Context, c worker.AgentLoginClaim, status, accountLabel, errText string) error {
	if !agentLoginTerminalStatuses[status] {
		return fmt.Errorf("postgres: finish agent login: %q is not a terminal agent login status", status)
	}
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("postgres: begin finish agent login: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var orgID, launcher, workerID string
	err = tx.QueryRow(ctx, `
		UPDATE agent_logins
		SET status = $3,
		    account_label = NULLIF($4, ''),
		    error = NULLIF(left($5, `+fmt.Sprint(agentLoginErrorMaxChars)+`), ''),
		    submitted_code = NULL,
		    lease_expires_at = NULL,
		    updated_at = now()
		WHERE id = $1::uuid AND claimed_by = $2
		  AND status IN `+agentLoginActiveSQL+`
		RETURNING organization_id::text, launcher, COALESCE(worker_id, '')`,
		c.ID, c.WorkerID, status, accountLabel, errText).Scan(&orgID, &launcher, &workerID)
	if errors.Is(err, pgx.ErrNoRows) {
		if fenceErr := s.agentLoginFenceLost(ctx, c.ID, true); errors.Is(fenceErr, agentLoginCancelledError{}) {
			return nil
		} else if fenceErr != nil {
			return fenceErr
		}
		return worker.ErrLeaseLost
	}
	if err != nil {
		return fmt.Errorf("postgres: finish agent login %s: %w", c.ID, err)
	}
	if _, err := AppendEvent(ctx, tx, events.New{
		Type:           agentLoginEventType(status),
		OrganizationID: orgID,
		Actor:          events.Actor{Kind: events.ActorKindWorker, ID: c.WorkerID},
		Payload: events.AgentLoginPayload{
			LoginID:      c.ID,
			Launcher:     launcher,
			WorkerID:     workerID,
			AccountLabel: accountLabel,
		},
	}); err != nil {
		return fmt.Errorf("postgres: append agent login event %s: %w", c.ID, err)
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("postgres: commit finish agent login %s: %w", c.ID, err)
	}
	return nil
}

// agentLoginEventType maps a terminal status to its journal type. The map is
// closed by the CHECK: only the four statuses Finish accepts name a type.
func agentLoginEventType(status string) string {
	return "agent.login." + status
}

// UpsertAgentAccountStatus records this worker's view of one launcher's
// sign-in state (registration, after every attempt, every 10 minutes). Empty
// label/detail store NULL; checked_at is the database's now(), not the
// worker's clock.
func (s *AgentLoginStore) UpsertAgentAccountStatus(ctx context.Context, workerID, launcher, state, accountLabel, detail string) error {
	if workerID == "" {
		return errors.New("postgres: upsert agent account status requires a worker id")
	}
	_, err := s.Pool.Exec(ctx, `
		INSERT INTO agent_account_status (worker_id, launcher, state, account_label, detail, checked_at)
		VALUES ($1, $2, $3, NULLIF($4, ''), NULLIF($5, ''), now())
		ON CONFLICT (worker_id, launcher) DO UPDATE SET
			state         = EXCLUDED.state,
			account_label = EXCLUDED.account_label,
			detail        = EXCLUDED.detail,
			checked_at    = EXCLUDED.checked_at`,
		workerID, launcher, state, accountLabel, detail)
	if err != nil {
		return fmt.Errorf("postgres: upsert agent account status: %w", err)
	}
	return nil
}

// ------------------------------------------------------------- worker store ---

// AgentLoginStore is the worker.AgentLoginStore adapter over the agent_logins
// queue and the agent_account_status table (the interface lives in
// internal/worker so the worker half never imports this package; the reverse
// import here is the direction AGENTS.md allows).
type AgentLoginStore struct {
	Pool *pgxpool.Pool
}

var (
	_ worker.AgentLoginStore = (*AgentLoginStore)(nil)
)

// ------------------------------------------------------------- api adapter ---

// APIAgentAccountStore exposes the agent-accounts surface through the
// interface internal/api's Settings handlers depend on. Like APIWorkerStore it
// lives here because package api must not import this one. The live-worker set
// is the workers registry's own liveness rule — a stale heartbeat reads
// offline whatever the row says — so the tab cannot offer a sign-in to a worker
// that is gone.
type APIAgentAccountStore struct {
	S        *AgentLoginStore
	Registry *WorkerRegistry

	// HeartbeatInterval is the worker's configured heartbeat period; zero uses
	// the registry default. It sets which workers count as live for the list.
	HeartbeatInterval time.Duration
}

var (
	_ api.AgentAccountStore = APIAgentAccountStore{}
	_ api.AgentAccountStore = (*APIAgentAccountStore)(nil)
)

// agentLoginViewColumns is the AgentLogin projection — and the column list no
// view of a login ever leaves submitted_code off, because it was never on.
const agentLoginViewColumns = `id::text, launcher, worker_id, status, verification_url, user_code,
	needs_code, account_label, error, expires_at, created_at, updated_at`

type agentLoginRowScanner interface {
	Scan(dest ...any) error
}

// agentLoginViewRow is the scan buffer for agentLoginViewColumns: the API view
// plus the three timestamps in their native time.Time form, formatted only when
// the view is finished. Both the single-row reads and the DISTINCT ON list read
// share these targets so the projection is stated exactly once.
type agentLoginViewRow struct {
	v         api.AgentLoginView
	expiresAt time.Time
	createdAt time.Time
	updatedAt time.Time
}

func (r *agentLoginViewRow) targets() []any {
	return []any{&r.v.ID, &r.v.Launcher, &r.v.WorkerID, &r.v.Status, &r.v.VerificationURL,
		&r.v.UserCode, &r.v.NeedsCode, &r.v.AccountLabel, &r.v.Error,
		&r.expiresAt, &r.createdAt, &r.updatedAt}
}

func (r *agentLoginViewRow) finish() api.AgentLoginView {
	r.v.ExpiresAt = agentLoginTime(r.expiresAt)
	r.v.CreatedAt = agentLoginTime(r.createdAt)
	r.v.UpdatedAt = agentLoginTime(r.updatedAt)
	return r.v
}

// scanAgentLoginView reads one agentLoginViewColumns row into the API view:
// timestamps as RFC 3339 UTC, nullable columns as nil pointers.
func scanAgentLoginView(row agentLoginRowScanner) (api.AgentLoginView, error) {
	var r agentLoginViewRow
	if err := row.Scan(r.targets()...); err != nil {
		return api.AgentLoginView{}, err
	}
	return r.finish(), nil
}

func agentLoginTime(t time.Time) string {
	return t.UTC().Format(time.RFC3339)
}

// ListAgentAccounts implements api.AgentAccountStore: one row per live worker ×
// sign-in launcher, ordered by worker name then codex before antigravity. A
// worker that never reported reads "unknown" with no label, detail or
// checked_at — the honest absence, not a guessed signed_out. The login beside
// a row is that organization's most recent attempt for the launcher on this
// worker or pinned to nobody (newest created_at first), active or not: it is
// what the dialog reopens onto.
func (a APIAgentAccountStore) ListAgentAccounts(ctx context.Context, c api.Caller) ([]api.AgentAccountView, error) {
	if err := prjRequireCaller(callerFromAPI(c)); err != nil {
		return nil, err
	}
	if a.S == nil || a.S.Pool == nil {
		return nil, errors.New("postgres: agent account store has no pool")
	}
	if a.Registry == nil {
		return nil, errors.New("postgres: agent account store has no worker registry")
	}
	workers, err := a.Registry.ListWorkersWithLiveness(ctx, a.HeartbeatInterval)
	if err != nil {
		return nil, err
	}
	var live []Worker
	ids := make([]string, 0, len(workers))
	for _, wk := range workers {
		if wk.Status != WorkerStatusOnline {
			continue
		}
		live = append(live, wk)
		ids = append(ids, wk.ID)
	}

	type accountStatus struct {
		state        string
		accountLabel *string
		detail       *string
		checkedAt    *string
	}
	statuses := make(map[string]accountStatus, len(ids)*len(worker.AgentLoginLaunchers))
	if len(ids) > 0 {
		rows, err := a.S.Pool.Query(ctx, `
			SELECT worker_id, launcher, state, account_label, detail, checked_at
			FROM agent_account_status
			WHERE worker_id = ANY($1::text[])`, ids)
		if err != nil {
			return nil, fmt.Errorf("postgres: read agent account statuses: %w", err)
		}
		defer rows.Close()
		for rows.Next() {
			var workerID, launcher, state string
			var label, detail *string
			var checkedAt time.Time
			if err := rows.Scan(&workerID, &launcher, &state, &label, &detail, &checkedAt); err != nil {
				return nil, fmt.Errorf("postgres: scan agent account status: %w", err)
			}
			st := agentLoginTime(checkedAt)
			statuses[workerID+"\x00"+launcher] = accountStatus{state: state, accountLabel: label, detail: detail, checkedAt: &st}
		}
		if err := rows.Err(); err != nil {
			return nil, fmt.Errorf("postgres: read agent account statuses: %w", err)
		}
	}

	// One read for every live worker's most recent attempt: the DISTINCT ON is
	// (worker, launcher) newest-first, the same (created_at, id) tie order the
	// claim index and uuidv7 make canonical elsewhere.
	logins := make(map[string]api.AgentLoginView, len(ids)*len(worker.AgentLoginLaunchers))
	if len(ids) > 0 {
		rows, err := a.S.Pool.Query(ctx, `
			SELECT DISTINCT ON (w.wid, l.launcher) w.wid AS row_worker, `+agentLoginViewColumns+`
			FROM (SELECT unnest($1::text[]) AS wid) w
			JOIN agent_logins l
			  ON l.organization_id = $2::uuid
			 AND (l.worker_id = w.wid OR l.worker_id IS NULL)
			ORDER BY w.wid, l.launcher, l.created_at DESC, l.id DESC`,
			ids, c.OrganizationID)
		if err != nil {
			return nil, fmt.Errorf("postgres: read agent account logins: %w", err)
		}
		defer rows.Close()
		for rows.Next() {
			var rowWorker string
			var r agentLoginViewRow
			if err := rows.Scan(append([]any{&rowWorker}, r.targets()...)...); err != nil {
				return nil, fmt.Errorf("postgres: scan agent account login: %w", err)
			}
			logins[rowWorker+"\x00"+r.v.Launcher] = r.finish()
		}
		if err := rows.Err(); err != nil {
			return nil, fmt.Errorf("postgres: read agent account logins: %w", err)
		}
	}

	out := make([]api.AgentAccountView, 0, len(live)*len(worker.AgentLoginLaunchers))
	for _, wk := range live { // ListWorkersWithLiveness is already name-ordered
		for _, launcher := range worker.AgentLoginLaunchers { // codex, antigravity
			key := wk.ID + "\x00" + launcher
			view := api.AgentAccountView{
				WorkerID:   wk.ID,
				WorkerName: wk.Name,
				Launcher:   launcher,
			}
			// A worker reports a status row only for the launchers it has a
			// sign-in driver (and so a credential volume) for; a launcher it
			// never reported is not offered for that worker at all, so the tab
			// never shows a Sign in button the worker cannot honour.
			st, ok := statuses[key]
			if !ok {
				continue
			}
			view.State, view.AccountLabel, view.Detail, view.CheckedAt =
				st.state, st.accountLabel, st.detail, st.checkedAt
			if login, ok := logins[key]; ok {
				v := login
				view.Login = &v
			}
			out = append(out, view)
		}
	}
	return out, nil
}

// CreateAgentLogin queues a sign-in for one launcher (workerID "" = any
// worker), expires_at = now()+15 minutes on the database's clock, and journals
// agent.login.started with the admin as actor in the same transaction. The
// one-active partial index, not a read-then-insert, is what refuses the second
// concurrent attempt: its 23505 becomes ErrAgentLoginActive.
func (a APIAgentAccountStore) CreateAgentLogin(ctx context.Context, c api.Caller, launcher, workerID string) (api.AgentLoginView, error) {
	if err := prjRequireCaller(callerFromAPI(c)); err != nil {
		return api.AgentLoginView{}, err
	}
	if a.S == nil || a.S.Pool == nil {
		return api.AgentLoginView{}, errors.New("postgres: agent account store has no pool")
	}
	if !agentLoginLauncherKnown(launcher) {
		// The route is /agent-accounts/{launcher}/logins: an unknown launcher
		// has no account surface to log into, which is the 404 the handler maps.
		return api.AgentLoginView{}, api.ErrAgentLoginNotFound
	}
	tx, err := a.S.Pool.Begin(ctx)
	if err != nil {
		return api.AgentLoginView{}, fmt.Errorf("postgres: begin create agent login: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	view, err := scanAgentLoginView(tx.QueryRow(ctx, `
		INSERT INTO agent_logins
			(organization_id, launcher, worker_id, status, requested_by, expires_at)
		VALUES ($1::uuid, $2, NULLIF($3, ''), 'queued', $4::uuid, `+agentLoginCreateLifetimeSQL+`)
		RETURNING `+agentLoginViewColumns,
		c.OrganizationID, launcher, workerID, c.UserID))
	if err != nil {
		if pgConflictCode(err, "23505") {
			return api.AgentLoginView{}, api.ErrAgentLoginActive
		}
		return api.AgentLoginView{}, fmt.Errorf("postgres: create agent login: %w", err)
	}
	if _, err := AppendEvent(ctx, tx, events.New{
		Type:           events.TypeAgentLoginStarted,
		OrganizationID: c.OrganizationID,
		Actor:          events.Human(c.UserID),
		Payload: events.AgentLoginPayload{
			LoginID:  view.ID,
			Launcher: launcher,
			WorkerID: workerID,
		},
	}); err != nil {
		return api.AgentLoginView{}, fmt.Errorf("postgres: append agent login started: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return api.AgentLoginView{}, fmt.Errorf("postgres: commit create agent login: %w", err)
	}
	return view, nil
}

// GetAgentLogin reads one login, scoped to the caller's organization: another
// organization's row is not found, never read (ADR-0014 §3).
func (a APIAgentAccountStore) GetAgentLogin(ctx context.Context, c api.Caller, loginID string) (api.AgentLoginView, error) {
	if err := prjRequireCaller(callerFromAPI(c)); err != nil {
		return api.AgentLoginView{}, err
	}
	if a.S == nil || a.S.Pool == nil {
		return api.AgentLoginView{}, errors.New("postgres: agent account store has no pool")
	}
	view, err := scanAgentLoginView(a.S.Pool.QueryRow(ctx, `
		SELECT `+agentLoginViewColumns+`
		FROM agent_logins
		WHERE id = $1::uuid AND organization_id = $2::uuid`,
		loginID, c.OrganizationID))
	if errors.Is(err, pgx.ErrNoRows) {
		return api.AgentLoginView{}, api.ErrAgentLoginNotFound
	}
	if err != nil {
		return api.AgentLoginView{}, fmt.Errorf("postgres: get agent login: %w", err)
	}
	return view, nil
}

// SubmitAgentLoginCode stores the pasted code for the worker's next poll. Only
// an awaiting_user row that asked for a code (needs_code) accepts one — a
// Codex row (device code, nothing to paste) or any other state refuses with
// ErrAgentLoginState, a row outside the organization is NotFound. The value
// arrives already validated and trimmed by the handler; it is never logged and
// never returned.
func (a APIAgentAccountStore) SubmitAgentLoginCode(ctx context.Context, c api.Caller, loginID, code string) error {
	if err := prjRequireCaller(callerFromAPI(c)); err != nil {
		return err
	}
	if a.S == nil || a.S.Pool == nil {
		return errors.New("postgres: agent account store has no pool")
	}
	tag, err := a.S.Pool.Exec(ctx, `
		UPDATE agent_logins
		SET submitted_code = $3, updated_at = now()
		WHERE id = $1::uuid AND organization_id = $2::uuid
		  AND status = 'awaiting_user' AND needs_code`,
		loginID, c.OrganizationID, code)
	if err != nil {
		return fmt.Errorf("postgres: submit agent login code: %w", err)
	}
	if tag.RowsAffected() == 1 {
		return nil
	}
	var exists bool
	if err := a.S.Pool.QueryRow(ctx, `
		SELECT true FROM agent_logins WHERE id = $1::uuid AND organization_id = $2::uuid`,
		loginID, c.OrganizationID).Scan(&exists); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return api.ErrAgentLoginNotFound
		}
		return fmt.Errorf("postgres: submit agent login code probe: %w", err)
	}
	return api.ErrAgentLoginState
}

// CancelAgentLogin moves an active row to cancelled and journals
// agent.login.cancelled (the admin as actor) in one transaction, clearing any
// stored code with it. A terminal row is left exactly as it is and answers nil
// — cancelling a finished sign-in is not an error, and the journal already
// holds the truth. A row outside the organization is NotFound.
func (a APIAgentAccountStore) CancelAgentLogin(ctx context.Context, c api.Caller, loginID string) error {
	if err := prjRequireCaller(callerFromAPI(c)); err != nil {
		return err
	}
	if a.S == nil || a.S.Pool == nil {
		return errors.New("postgres: agent account store has no pool")
	}
	tx, err := a.S.Pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("postgres: begin cancel agent login: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var launcher, workerID string
	err = tx.QueryRow(ctx, `
		UPDATE agent_logins
		SET status = 'cancelled', submitted_code = NULL, updated_at = now()
		WHERE id = $1::uuid AND organization_id = $2::uuid
		  AND status IN `+agentLoginActiveSQL+`
		RETURNING launcher, COALESCE(worker_id, '')`,
		loginID, c.OrganizationID).Scan(&launcher, &workerID)
	if errors.Is(err, pgx.ErrNoRows) {
		var status string
		probeErr := a.S.Pool.QueryRow(ctx, `
			SELECT status FROM agent_logins WHERE id = $1::uuid AND organization_id = $2::uuid`,
			loginID, c.OrganizationID).Scan(&status)
		if errors.Is(probeErr, pgx.ErrNoRows) {
			return api.ErrAgentLoginNotFound
		}
		if probeErr != nil {
			return fmt.Errorf("postgres: cancel agent login probe: %w", probeErr)
		}
		return nil // terminal: the cancel already happened or never needed to
	}
	if err != nil {
		return fmt.Errorf("postgres: cancel agent login: %w", err)
	}
	if _, err := AppendEvent(ctx, tx, events.New{
		Type:           events.TypeAgentLoginCancelled,
		OrganizationID: c.OrganizationID,
		Actor:          events.Human(c.UserID),
		Payload: events.AgentLoginPayload{
			LoginID:  loginID,
			Launcher: launcher,
			WorkerID: workerID,
		},
	}); err != nil {
		return fmt.Errorf("postgres: append agent login cancelled: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("postgres: commit cancel agent login: %w", err)
	}
	return nil
}

// agentLoginLauncherKnown is the store's copy of the worker package's driver
// list (agentlogin_port.go owns it; the list is the launcher CHECK's two
// values, pinned against drift by a test).
func agentLoginLauncherKnown(launcher string) bool {
	for _, l := range worker.AgentLoginLaunchers {
		if l == launcher {
			return true
		}
	}
	return false
}
