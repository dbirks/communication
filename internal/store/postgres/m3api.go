package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/dbirks/communication/internal/api"
	"github.com/dbirks/communication/internal/events"
)

// The API read side of the M3 routes (docs/m3-contract.md § 2). Same rule as
// every other read in this package: the permission predicate is part of the
// SQL, not a filter after it (09: "Every sensitive query includes project
// permission predicate, not a client-controlled header"), and a row the caller
// may not see is indistinguishable from a row that does not exist.
//
// These views also never carry a path. `root_path`, `checkout_path`,
// `mirror_path` and `admin_dir` exist in the schema and in sandbox plans;
// none of them exist in a browser-visible response (09: no accidental
// worker-service surface). The client-usable git identity is `run_ref`.

// APIWorkspaceStore exposes a *WorkspaceStore as api.WorkspaceStore.
type APIWorkspaceStore struct {
	S *WorkspaceStore
}

var (
	_ api.WorkspaceStore = APIWorkspaceStore{}
	_ api.WorkspaceStore = (*APIWorkspaceStore)(nil)
)

// wspAPIErr maps store errors onto the api sentinel.
func wspAPIErr(err error) error {
	switch {
	case err == nil:
		return nil
	case errors.Is(err, ErrNotFound), errors.Is(err, ErrProjectNotFound):
		return fmt.Errorf("%w: %w", api.ErrWorkspaceNotFound, err)
	default:
		return err
	}
}

// wsScope is the caller predicate every workspace read carries. Ids that are
// NULL come back as empty strings for the same reason artArtifactColumns does
// it: every downstream consumer treats "" as absent.
const wsScope = `
	FROM workspaces w
	LEFT JOIN memberships m ON m.project_id = w.project_id AND m.user_id = $1::uuid
	WHERE (w.organization_id = $2::uuid
	       AND ($3::boolean OR m.user_id IS NOT NULL))`

const wsColumns = `
	SELECT w.id::text, w.project_id::text, w.scope_kind,
	       COALESCE(w.conversation_id::text, ''), COALESCE(w.run_id::text, ''),
	       w.worker_id::text, w.volume_id, w.workspace_mode, w.state,
	       w.created_at, w.ready_at, w.released_at, w.lost_at,
	       COALESCE(m.role, ''),
	       COALESCE((SELECT e.payload->>'reason' FROM domain_events e
		         WHERE e.type = 'workspace.recovery_lost'
		           AND e.payload->>'workspace_id' = w.id::text
		         ORDER BY e.global_seq DESC LIMIT 1), '')`

func (a APIWorkspaceStore) pool() (*pgxpool.Pool, error) {
	if a.S == nil || a.S.Pool == nil {
		return nil, errors.New("postgres: APIWorkspaceStore has no pool")
	}
	return a.S.Pool, nil
}

// wsProjectPredicate names the project explicitly; wsScope supplies the
// caller half. They are composed in each query's WHERE rather than here
// because $4's meaning differs per route (project id, workspace id, ...).
const wsProjectPredicate = `w.project_id = $4::uuid`

// wsLiveFirst puts live rows (preparing/ready/quarantined) ahead of history,
// newest first within each half (listProjectWorkspaces).
const wsLiveFirst = `
	ORDER BY (w.state IN ('preparing', 'ready', 'quarantined')) DESC, w.created_at DESC`

// ListWorkspaces answers listProjectWorkspaces, repos included.
func (a APIWorkspaceStore) ListWorkspaces(ctx context.Context, c api.Caller, projectID string) ([]api.WorkspaceView, error) {
	pool, err := a.pool()
	if err != nil {
		return nil, err
	}
	if err := prjRequireCaller(callerFromAPI(c)); err != nil {
		return nil, err
	}
	// An invisible project answers 404, not "empty": a 200 with no rows would
	// tell a caller outside the project that the project exists and merely
	// has no workspaces, which is exactly the existence signal the uniform
	// not-found rule exists to withhold.
	var visible bool
	if err := pool.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM memberships m
			WHERE m.project_id = $2::uuid AND m.user_id = $1::uuid)
		   OR $3::boolean`, c.UserID, prjCleanUUID(projectID), c.IsOrgAdmin).
		Scan(&visible); err != nil {
		return nil, fmt.Errorf("postgres: workspace project visibility: %w", err)
	}
	if !visible {
		return nil, api.ErrWorkspaceNotFound
	}
	rows, err := pool.Query(ctx, wsColumns+wsScope+
		` AND `+wsProjectPredicate+wsLiveFirst,
		c.UserID, c.OrganizationID, c.IsOrgAdmin, prjCleanUUID(projectID))
	if err != nil {
		return nil, fmt.Errorf("postgres: list workspaces: %w", err)
	}
	defer rows.Close()
	var out []api.WorkspaceView
	var ids []string
	for rows.Next() {
		v, err := scanWorkspace(rows)
		if err != nil {
			return nil, err
		}
		v.Repos = []api.WorkspaceRepoView{}
		out = append(out, v)
		ids = append(ids, v.ID)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(ids) == 0 {
		return []api.WorkspaceView{}, nil
	}
	// One second query for all the repos rather than N+1 correlated reads:
	// the parent rows are already permission-filtered, so their ids are safe
	// inputs. The join supplies the name (workspace_repos has no name column
	// and a guessed one would mislabel a checkout).
	repoRows, err := pool.Query(ctx, `
		SELECT wr.workspace_id::text, wr.repository_id::text, r.name, wr.run_ref,
		       wr.base_commit, wr.head_commit,
		       wr.modified_paths::text, wr.excluded_paths::text, wr.id::text
		FROM workspace_repos wr
		JOIN repositories r ON r.id = wr.repository_id
		WHERE wr.workspace_id = ANY($1::uuid[])
		ORDER BY r.name`, ids)
	if err != nil {
		return nil, fmt.Errorf("postgres: list workspace repos: %w", err)
	}
	defer repoRows.Close()
	byWorkspace := map[string][]api.WorkspaceRepoView{}
	for repoRows.Next() {
		var (
			wsID, modRaw, excRaw string
			repo                 api.WorkspaceRepoView
			head                 *string
		)
		if err := repoRows.Scan(&wsID, &repo.RepositoryID, &repo.Name, &repo.RunRef,
			&repo.BaseCommit, &head, &modRaw, &excRaw, new(string)); err != nil {
			return nil, fmt.Errorf("postgres: scan workspace repo: %w", err)
		}
		repo.HeadCommit = head
		if err := json.Unmarshal([]byte(modRaw), &repo.ModifiedPaths); err != nil {
			return nil, fmt.Errorf("postgres: workspace repo manifest: %w", err)
		}
		if err := json.Unmarshal([]byte(excRaw), &repo.ExcludedPaths); err != nil {
			return nil, fmt.Errorf("postgres: workspace repo exclusions: %w", err)
		}
		if repo.ModifiedPaths == nil {
			repo.ModifiedPaths = []string{}
		}
		if repo.ExcludedPaths == nil {
			repo.ExcludedPaths = []string{}
		}
		byWorkspace[wsID] = append(byWorkspace[wsID], repo)
	}
	if err := repoRows.Err(); err != nil {
		return nil, err
	}
	for i := range out {
		if repos, ok := byWorkspace[out[i].ID]; ok {
			out[i].Repos = repos
		}
	}
	return out, nil
}

// GetWorkspace answers getWorkspace, authorized through the workspace's own
// project id.
func (a APIWorkspaceStore) GetWorkspace(ctx context.Context, c api.Caller, workspaceID string) (api.WorkspaceView, error) {
	pool, err := a.pool()
	if err != nil {
		return api.WorkspaceView{}, err
	}
	if err := prjRequireCaller(callerFromAPI(c)); err != nil {
		return api.WorkspaceView{}, err
	}
	if !prjValidUUID(workspaceID) {
		return api.WorkspaceView{}, ErrNotFound
	}
	row := pool.QueryRow(ctx, wsColumns+wsScope+
		` AND w.id = $4::uuid`,
		c.UserID, c.OrganizationID, c.IsOrgAdmin, workspaceID)
	v, err := scanWorkspaceRow(row)
	if err != nil {
		return api.WorkspaceView{}, wspAPIErr(err)
	}
	repos, err := a.reposFor(ctx, pool, v.ID)
	if err != nil {
		return api.WorkspaceView{}, err
	}
	v.Repos = repos
	return v, nil
}

func (a APIWorkspaceStore) reposFor(ctx context.Context, pool *pgxpool.Pool, workspaceID string) ([]api.WorkspaceRepoView, error) {
	rows, err := pool.Query(ctx, `
		SELECT wr.repository_id::text, r.name, wr.run_ref, wr.base_commit, wr.head_commit,
		       wr.modified_paths::text, wr.excluded_paths::text
		FROM workspace_repos wr
		JOIN repositories r ON r.id = wr.repository_id
		WHERE wr.workspace_id = $1::uuid
		ORDER BY r.name`, workspaceID)
	if err != nil {
		return nil, fmt.Errorf("postgres: list workspace repos: %w", err)
	}
	defer rows.Close()
	out := []api.WorkspaceRepoView{}
	for rows.Next() {
		var (
			repo           api.WorkspaceRepoView
			modRaw, excRaw string
		)
		if err := rows.Scan(&repo.RepositoryID, &repo.Name, &repo.RunRef, &repo.BaseCommit,
			&repo.HeadCommit, &modRaw, &excRaw); err != nil {
			return nil, fmt.Errorf("postgres: scan workspace repo: %w", err)
		}
		if err := json.Unmarshal([]byte(modRaw), &repo.ModifiedPaths); err != nil || repo.ModifiedPaths == nil {
			repo.ModifiedPaths = []string{}
		}
		if err := json.Unmarshal([]byte(excRaw), &repo.ExcludedPaths); err != nil || repo.ExcludedPaths == nil {
			repo.ExcludedPaths = []string{}
		}
		out = append(out, repo)
	}
	return out, rows.Err()
}

// scanWorkspace reads one wsColumns row from a pgx.Rows cursor.
func scanWorkspace(rows pgx.Rows) (api.WorkspaceView, error) {
	var v api.WorkspaceView
	var conversationID, runID, lostReason string
	if err := rows.Scan(&v.ID, &v.ProjectID, &v.ScopeKind, &conversationID, &runID,
		&v.WorkerID, &v.VolumeID, &v.WorkspaceMode, &v.State,
		&v.CreatedAt, &v.ReadyAt, &v.ReleasedAt, &v.LostAt, &v.MyRole, &lostReason); err != nil {
		return v, fmt.Errorf("postgres: scan workspace: %w", err)
	}
	wsViewFillOptionals(&v, conversationID, runID, lostReason)
	return v, nil
}

// scanWorkspaceRow reads one wsColumns row from a single-row query.
func scanWorkspaceRow(row pgx.Row) (api.WorkspaceView, error) {
	var v api.WorkspaceView
	var conversationID, runID, lostReason string
	err := row.Scan(&v.ID, &v.ProjectID, &v.ScopeKind, &conversationID, &runID,
		&v.WorkerID, &v.VolumeID, &v.WorkspaceMode, &v.State,
		&v.CreatedAt, &v.ReadyAt, &v.ReleasedAt, &v.LostAt, &v.MyRole, &lostReason)
	if err != nil {
		return v, err
	}
	wsViewFillOptionals(&v, conversationID, runID, lostReason)
	return v, nil
}

func wsViewFillOptionals(v *api.WorkspaceView, conversationID, runID, lostReason string) {
	if conversationID != "" {
		id := conversationID
		v.ConversationID = &id
	}
	if runID != "" {
		id := runID
		v.RunID = &id
	}
	if lostReason != "" {
		r := lostReason
		v.LostReason = &r
	}
}

// GetWorkspaceRepoStatus answers getWorkspaceRepoStatus from the row the
// worker wrote — never a live git call (09's worker-service prohibition).
// `recorded_at` is the workspace's own transition time: the row is written at
// prepare and updated at commit capture, and the workspace's released_at (or
// ready_at, or created_at, in that priority order) is the closest honest
// "when was this last observed" the schema keeps per workspace. A *per-column*
// staleness timestamp would require a trigger this schema does not have, and
// inventing one silently is worse than saying which clock is being used.
func (a APIWorkspaceStore) GetWorkspaceRepoStatus(ctx context.Context, c api.Caller, workspaceID, repositoryID string) (api.WorkspaceRepoStatusView, error) {
	pool, err := a.pool()
	if err != nil {
		return api.WorkspaceRepoStatusView{}, err
	}
	if err := prjRequireCaller(callerFromAPI(c)); err != nil {
		return api.WorkspaceRepoStatusView{}, err
	}
	if !prjValidUUID(workspaceID) || !prjValidUUID(repositoryID) {
		return api.WorkspaceRepoStatusView{}, api.ErrWorkspaceNotFound
	}
	var out api.WorkspaceRepoStatusView
	var modRaw, excRaw string
	err = pool.QueryRow(ctx, `
		SELECT wr.workspace_id::text, wr.repository_id::text, wr.run_ref, wr.base_commit,
		       wr.head_commit, wr.modified_paths::text, wr.excluded_paths::text,
		       COALESCE(m.role, ''),
		       COALESCE(w.released_at, w.ready_at, w.created_at)
		`+wsScopePredicated(),
		c.UserID, c.OrganizationID, c.IsOrgAdmin, workspaceID, repositoryID,
	).Scan(&out.WorkspaceID, &out.RepositoryID, &out.RunRef, &out.BaseCommit,
		&out.HeadCommit, &modRaw, &excRaw, &out.MyRole, &out.RecordedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return api.WorkspaceRepoStatusView{}, api.ErrWorkspaceNotFound
	}
	if err != nil {
		return api.WorkspaceRepoStatusView{}, fmt.Errorf("postgres: workspace repo status: %w", err)
	}
	if err := json.Unmarshal([]byte(modRaw), &out.ModifiedPaths); err != nil || out.ModifiedPaths == nil {
		out.ModifiedPaths = []string{}
	}
	if err := json.Unmarshal([]byte(excRaw), &out.ExcludedPaths); err != nil || out.ExcludedPaths == nil {
		out.ExcludedPaths = []string{}
	}
	out.Dirty = len(out.ModifiedPaths) > 0
	return out, nil
}

// wsScopePredicated is wsScope widened with the two extra ids the status route
// binds ($4 workspace, $5 repository).
func wsScopePredicated() string {
	return `
		FROM workspace_repos wr
		JOIN workspaces w ON w.id = wr.workspace_id
		LEFT JOIN memberships m ON m.project_id = w.project_id AND m.user_id = $1::uuid
		WHERE wr.workspace_id = $4::uuid AND wr.repository_id = $5::uuid
		  AND (w.organization_id = $2::uuid AND ($3::boolean OR m.user_id IS NOT NULL))`
}

func callerFromAPI(c api.Caller) Caller {
	return Caller{UserID: c.UserID, OrganizationID: c.OrganizationID, IsOrgAdmin: c.IsOrgAdmin}
}

// ------------------------------------------------------------- turn sandbox ---

// APITurnSandboxStore answers GET /api/v1/turns/{id}/sandbox from the journal.
// The store holds no worker handle: everything it can answer is what the
// worker already journalled, which is the point (case 13 asks a question about
// the journal, not about a process).
type APITurnSandboxStore struct {
	Pool *pgxpool.Pool
}

var (
	_ api.TurnSandboxStore = APITurnSandboxStore{}
	_ api.TurnSandboxStore = (*APITurnSandboxStore)(nil)
)

// GetTurnSandbox resolves turn → conversation → project under the caller's
// predicate and reads the turn's latest sandbox event.
func (a APITurnSandboxStore) GetTurnSandbox(ctx context.Context, c api.Caller, turnID string) (api.TurnSandboxView, error) {
	if a.Pool == nil {
		return api.TurnSandboxView{}, errors.New("postgres: turn sandbox store has no pool")
	}
	if err := prjRequireCaller(callerFromAPI(c)); err != nil {
		return api.TurnSandboxView{}, err
	}
	if !prjValidUUID(turnID) {
		return api.TurnSandboxView{}, api.ErrTurnSandboxNotFound
	}
	// The event half: newest sandbox event for this turn. Both kinds are
	// candidates because the honest answer to "what did this unit run under"
	// may be "nothing, and here is the stage that refused".
	var (
		workspaceID, workerID        string
		eventType                    string
		payloadRaw                   []byte
		conversationProject, convOrg string
		role                         string
	)
	err := a.Pool.QueryRow(ctx, `
		SELECT p.organization_id::text, c.project_id::text, COALESCE(m.role, ''),
		       COALESCE(e.type, ''), COALESCE(e.payload::text, '{}'),
		       COALESCE(e.payload->>'workspace_id', ''), COALESCE(e.payload->>'worker_id', '')
		FROM conversation_turns t
		JOIN conversations c ON c.id = t.conversation_id
		JOIN projects p ON p.id = c.project_id
		LEFT JOIN memberships m ON m.project_id = p.id AND m.user_id = $1::uuid
		LEFT JOIN LATERAL (
			SELECT ev.type, ev.payload FROM domain_events ev
			 WHERE ev.project_id = c.project_id
			   AND ev.type IN ('sandbox.verified', 'sandbox.enforcement_failed')
			   AND ev.payload->>'turn_id' = t.id::text
			 ORDER BY ev.global_seq DESC LIMIT 1
		) e ON TRUE
		WHERE t.id = $4::uuid
		  AND (p.organization_id = $2::uuid AND ($3::boolean OR m.user_id IS NOT NULL))`,
		c.UserID, c.OrganizationID, c.IsOrgAdmin, turnID).
		Scan(&convOrg, &conversationProject, &role, &eventType, &payloadRaw, &workspaceID, &workerID)
	if errors.Is(err, pgx.ErrNoRows) {
		return api.TurnSandboxView{}, api.ErrTurnSandboxNotFound
	}
	if err != nil {
		return api.TurnSandboxView{}, fmt.Errorf("postgres: turn sandbox read: %w", err)
	}
	_ = role // the route is viewer-or-above, which the predicate just enforced.
	view := api.TurnSandboxView{TurnID: turnID}
	if workspaceID != "" {
		id := workspaceID
		view.WorkspaceID = &id
	}
	if workerID != "" {
		id := workerID
		view.WorkerID = &id
	}
	switch eventType {
	case "":
		// A turn with no sandbox event: either it ran with no workspace (no
		// repositories — no policy was in play) or with a labelled isolation
		// mode. Both answers are "stage none, verified false, no child",
		// which is the honest default rather than a fabrication: the schema's
		// own words for that are `verified: only when the chain ran for this
		// unit`.
		view.Stage = "none"
		view.Backend = "none"
		view.Grants = []api.SandboxGrantView{}
		view.DeniedWhat = []string{}
		return view, nil
	case events.TypeSandboxVerified:
		var p events.SandboxVerifiedPayload
		if err := json.Unmarshal(payloadRaw, &p); err != nil {
			return api.TurnSandboxView{}, fmt.Errorf("postgres: sandbox.verified payload: %w", err)
		}
		view.Stage = "none" // the chain completed; the failure stages are where it stopped.
		view.Backend = p.Backend
		if p.BackendVersion != "" {
			v := p.BackendVersion
			view.BackendVersion = &v
		}
		if p.PolicyDigest != "" {
			d := p.PolicyDigest
			view.PolicyDigest = &d
		}
		if p.AfUnixMediation != "" {
			m := p.AfUnixMediation
			view.AfUnixMediation = &m
		}
		view.NetworkEnforced = p.NetworkEnforced
		view.Verified = p.Verified
		view.CommitGranted = p.CommitGranted
		for _, g := range p.Grants {
			view.Grants = append(view.Grants, api.SandboxGrantView{Role: g.Role, Access: g.Access})
		}
		if view.Grants == nil {
			view.Grants = []api.SandboxGrantView{}
		}
		view.DeniedWhat = []string{}
		// A sandbox.verified event only exists if the chain ran, which only
		// happens under `required` (permissive-dev and disabled units are
		// labelled and never emit it) — the mode is reported from that fact
		// rather than from a column nobody wrote.
		enforcement := "required"
		view.Enforcement = &enforcement
		// The child the chain verified was exec'd: sandbox.verified is written
		// by the launch path before the process starts, and the turn reaching
		// any transcript at all proves exec — but this read may serve a turn
		// that failed later, so child_started is only claimed here when the
		// turn actually produced transcript output.
		view.ChildStarted = turnProducedOutput(ctx, a.Pool, turnID)
		return view, nil
	case events.TypeSandboxEnforcementFailed:
		var p events.SandboxEnforcementFailedPayload
		if err := json.Unmarshal(payloadRaw, &p); err != nil {
			return api.TurnSandboxView{}, fmt.Errorf("postgres: sandbox.enforcement_failed payload: %w", err)
		}
		stage := p.Stage
		if stage == "" {
			stage = "none"
		}
		view.Stage = stage
		if p.Reason != "" {
			r := p.Reason
			view.Reason = &r
		}
		view.Backend = p.Backend
		if p.BackendVersion != "" {
			v := p.BackendVersion
			view.BackendVersion = &v
		}
		if p.PolicyDigest != "" {
			d := p.PolicyDigest
			view.PolicyDigest = &d
		}
		view.Verified = p.Verified
		view.ChildStarted = p.ChildStarted
		enforcement := "required"
		view.Enforcement = &enforcement
		view.Grants = []api.SandboxGrantView{}
		if p.Detail != "" {
			view.DeniedWhat = []string{p.Detail}
		} else {
			view.DeniedWhat = []string{}
		}
		return view, nil
	default:
		return api.TurnSandboxView{}, fmt.Errorf("postgres: unexpected sandbox event type %q", eventType)
	}
}

// turnProducedOutput reports whether the turn ever put a transcript row on the
// journal — the observable proxy for "a process ran" that does not require a
// worker round-trip.
func turnProducedOutput(ctx context.Context, pool *pgxpool.Pool, turnID string) bool {
	var exists bool
	err := pool.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM conversation_turns t
			 WHERE t.id = $1::uuid AND t.status IN ('running', 'completed'))`,
		prjCleanUUID(turnID)).Scan(&exists)
	return err == nil && exists
}

// ----------------------------------------------------------- system sandbox ---

// APISystemSandboxStore answers GET /api/v1/system/sandbox from the workers
// table (registration data, ADR-0019 D5) plus the pinned values this binary
// ships. The pinned digest is computed from code, not read from a worker's
// report, so the fleet view can *disagree* with a worker — which is the whole
// point of a fleet view.
type APISystemSandboxStore struct {
	Pool *pgxpool.Pool
	// PinnedBackendVersion and PolicyDigest come from the sandbox package the
	// deployment built this binary against.
	PinnedBackendVersion string
	PolicyDigest         string
}

var (
	_ api.SystemSandboxStore = APISystemSandboxStore{}
	_ api.SystemSandboxStore = (*APISystemSandboxStore)(nil)
)

func (a APISystemSandboxStore) ListWorkerSandbox(ctx context.Context) ([]api.WorkerSandboxStatusView, error) {
	if a.Pool == nil {
		return nil, errors.New("postgres: system sandbox store has no pool")
	}
	rows, err := a.Pool.Query(ctx, `
		SELECT w.id::text, w.sandbox_backend, w.sandbox_version, w.sandbox_enforcement,
		       w.sandbox_verified, w.sandbox_notes::text,
		       COALESCE((SELECT json_agg(json_build_object(
					'root_kind', v.root_kind, 'volume_id', v.volume_id)
				   ORDER BY v.root_kind)
		          FROM worker_volumes v WHERE v.worker_id = w.id), '[]'::json)::text
		FROM workers w
		WHERE w.status <> 'offline'
		ORDER BY w.name`)
	if err != nil {
		return nil, fmt.Errorf("postgres: list worker sandbox state: %w", err)
	}
	defer rows.Close()
	var out []api.WorkerSandboxStatusView
	for rows.Next() {
		var (
			v          api.WorkerSandboxStatusView
			version    *string
			notesRaw   string
			volumesRaw string
		)
		if err := rows.Scan(&v.WorkerID, &v.Backend, &version, &v.Enforcement,
			&v.Verified, &notesRaw, &volumesRaw); err != nil {
			return nil, fmt.Errorf("postgres: scan worker sandbox state: %w", err)
		}
		v.BackendVersion = version
		if err := json.Unmarshal([]byte(notesRaw), &v.Notes); err != nil || v.Notes == nil {
			v.Notes = []string{}
		}
		if err := json.Unmarshal([]byte(volumesRaw), &v.Volumes); err != nil {
			v.Volumes = nil
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

func (a APISystemSandboxStore) Deployment() (string, string) {
	return a.PinnedBackendVersion, a.PolicyDigest
}

// UpdateSandboxState writes the columns migration 00004 added for it. The
// worker calls it after its startup gate, with what it *observed*: a
// `required` worker that never ran the self-test writes `verified=false`, and
// the ops page reads that honestly ("a green check next to required on a
// worker that never verified would be a false guarantee" — the contract's
// words, made unfalsifiable by writing only observed facts).
func (r *WorkerRegistry) UpdateSandboxState(ctx context.Context, workerID, backend, backendVersion, enforcement string, verified bool, notes []string) error {
	if r == nil || r.Pool == nil {
		return errors.New("postgres: worker registry has no pool")
	}
	raw, err := json.Marshal(notes)
	if err != nil {
		return fmt.Errorf("postgres: encode sandbox notes: %w", err)
	}
	if len(notes) == 0 {
		raw = []byte("[]")
	}
	var version any
	if backendVersion != "" {
		version = backendVersion
	}
	tag, err := r.Pool.Exec(ctx, `
		UPDATE workers
		   SET sandbox_backend = $2, sandbox_version = $3, sandbox_enforcement = $4,
		       sandbox_verified = $5, sandbox_notes = $6::jsonb
		 WHERE id = $1::uuid`,
		prjCleanUUID(workerID), backend, version, enforcement, verified, string(raw))
	if err != nil {
		return fmt.Errorf("postgres: update worker sandbox state: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return fmt.Errorf("postgres: update worker sandbox state %s: %w", workerID, ErrNotFound)
	}
	return nil
}
