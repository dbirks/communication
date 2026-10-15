package postgres

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/dbirks/communication/internal/domain"
	"github.com/dbirks/communication/internal/events"
	"github.com/dbirks/communication/internal/worker"
)

// WorkspaceStore is the worker's persistence face for ADR-0017's topology:
// volume identities, workspace rows, and the per-repository rows a prepared
// run leaves behind. It implements worker.WorkspaceStore.
//
// The journal appends for workspace events live here rather than in the turn
// store, because a workspace is prepared once and released once while turns
// come and go, and because `workspace.recovery_lost` (case 20) has no turn to
// hang off: it is emitted by the prepare that discovered the volume changed.
type WorkspaceStore struct {
	Pool *pgxpool.Pool
}

var _ worker.WorkspaceStore = (*WorkspaceStore)(nil)

// wspVolumeColumns is the worker_volumes projection.
const wspVolumeColumns = `worker_id::text, root_kind, root_path, st_dev, st_ino,
	COALESCE(fstype, ''), volume_id, observed_at`

// RecordVolume upserts this worker's measured identity for one storage root
// (ADR-0017 D2 as corrected by probe V3).
//
// Identity is (st_dev, st_ino, root path) hashed, never st_dev alone: two
// different docker named volumes mounted at the same path report the same
// st_dev, so an st_dev-derived id would call a *replaced* volume the same one
// and silently reclaim workspaces whose bytes are gone. Re-measuring on every
// worker start is what makes a replaced volume visible as a changed id rather
// than as a workspace that should still be there.
func (s *WorkspaceStore) RecordVolume(ctx context.Context, v worker.VolumeRecord) error {
	if s == nil || s.Pool == nil {
		return errors.New("postgres: workspace store has no pool")
	}
	if v.WorkerID == "" || v.VolumeID == "" {
		return errors.New("postgres: RecordVolume requires a worker id and a volume id")
	}
	if !strings.HasPrefix(v.VolumeID, "sha256:") || len(v.VolumeID) != 7+64 {
		return fmt.Errorf("postgres: volume id %q is not a sha256 digest", v.VolumeID)
	}
	if !strings.HasPrefix(v.RootPath, "/") || strings.Contains(v.RootPath, "..") {
		// worker_volumes_path_absolute: an id computed from a relative path
		// would be compared against absolute paths forever and match nothing.
		return fmt.Errorf("postgres: volume root path %q is not absolute and traversal-free", v.RootPath)
	}
	_, err := s.Pool.Exec(ctx, `
		INSERT INTO worker_volumes (worker_id, root_kind, root_path, st_dev, st_ino, fstype, volume_id, observed_at)
		VALUES ($1::uuid, $2, $3, $4, $5, NULLIF($6, ''), $7, now())
		ON CONFLICT (worker_id, root_kind) DO UPDATE SET
			root_path   = EXCLUDED.root_path,
			st_dev      = EXCLUDED.st_dev,
			st_ino      = EXCLUDED.st_ino,
			fstype      = EXCLUDED.fstype,
			volume_id   = EXCLUDED.volume_id,
			observed_at = now()`,
		v.WorkerID, v.RootKind, v.RootPath, v.StDev, v.StIno, v.FSType, v.VolumeID)
	if err != nil {
		return fmt.Errorf("postgres: record volume %s for worker %s: %w", v.RootKind, v.WorkerID, err)
	}
	return nil
}

// Volume reads the identity this worker recorded for one storage root. ok=false
// means the worker has never measured it — an M2-era worker row — which the
// contract reads as "unknown volume", and no M3 workspace may bind to one.
func (s *WorkspaceStore) Volume(ctx context.Context, workerID, rootKind string) (worker.VolumeRecord, bool, error) {
	if s == nil || s.Pool == nil {
		return worker.VolumeRecord{}, false, errors.New("postgres: workspace store has no pool")
	}
	row := s.Pool.QueryRow(ctx, `SELECT `+wspVolumeColumns+` FROM worker_volumes WHERE worker_id = $1::uuid AND root_kind = $2`,
		workerID, rootKind)
	var v worker.VolumeRecord
	err := row.Scan(&v.WorkerID, &v.RootKind, &v.RootPath, &v.StDev, &v.StIno, &v.FSType, &v.VolumeID, &v.ObservedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return worker.VolumeRecord{}, false, nil
	}
	if err != nil {
		return worker.VolumeRecord{}, false, fmt.Errorf("postgres: read volume %s for worker %s: %w", rootKind, workerID, err)
	}
	return v, true, nil
}

// ClaimWorkspace creates or returns the live workspace row for one scope.
//
// The returned Prepare decision is the whole of case 20's first arm: `reused`
// says the recorded volume still matches what the worker measures, `lost` says
// it does not (or the directory is gone), and the caller must then report
// `workspace.recovery_lost` and start a new row rather than pretend to resume.
func (s *WorkspaceStore) ClaimWorkspace(ctx context.Context, req worker.WorkspaceClaim) (worker.WorkspaceDecision, error) {
	if s == nil || s.Pool == nil {
		return worker.WorkspaceDecision{}, errors.New("postgres: workspace store has no pool")
	}
	if req.ProjectID == "" || req.WorkerID == "" || req.VolumeID == "" || req.RootPath == "" {
		return worker.WorkspaceDecision{}, errors.New("postgres: incomplete workspace claim")
	}
	if req.ConversationID == "" {
		return worker.WorkspaceDecision{}, errors.New("postgres: M3 workspaces are conversation-scoped (contract deviation D1 reserves the run scope for M4)")
	}
	if req.Mode != "worktree" && req.Mode != "clone" {
		return worker.WorkspaceDecision{}, fmt.Errorf("postgres: workspace mode %q is not worktree or clone", req.Mode)
	}

	var out worker.WorkspaceDecision
	err := s.inTx(ctx, func(tx pgx.Tx) error {
		// The conversation's live workspace, if any. FOR UPDATE so a second
		// turn on the same conversation cannot race a prepare: the unique
		// index workspaces_one_live_per_conversation_idx would answer 23505
		// anyway, and 409 is a worse answer than waiting.
		var (
			existingID, existingVolume, existingRoot, state string
			found                                           bool
		)
		row := tx.QueryRow(ctx, `
			SELECT id::text, volume_id, root_path, state
			FROM workspaces
			WHERE conversation_id = $1::uuid AND state IN ('preparing','ready','quarantined')
			FOR UPDATE`, req.ConversationID)
		switch err := row.Scan(&existingID, &existingVolume, &existingRoot, &state); {
		case errors.Is(err, pgx.ErrNoRows):
		case err != nil:
			return fmt.Errorf("postgres: look up live workspace: %w", err)
		default:
			found = true
		}

		if found {
			switch {
			case state == "quarantined":
				// A quarantined workspace is not reusable by definition (ADR-0017
				// D3): the reason it was quarantined is a security condition, and
				// reusing the tree would launch an agent back into it.
				out = worker.WorkspaceDecision{Kind: worker.DecisionQuarantined, WorkspaceID: existingID}
				return nil
			case existingVolume != req.VolumeID:
				// Case 20's honest arm: the disk this worker is on is not the
				// disk the workspace lives on. The old row is marked lost —
				// never rewritten in place, because "prior edits lost" has to
				// stay readable after the new row exists.
				if err := markWorkspaceTx(ctx, tx, existingID, "lost", req.Reason); err != nil {
					return err
				}
				out = worker.WorkspaceDecision{
					Kind:           worker.DecisionLost,
					WorkspaceID:    existingID,
					ExpectedVolume: existingVolume,
					FoundVolume:    req.VolumeID,
				}
			default:
				out = worker.WorkspaceDecision{Kind: worker.DecisionReused, WorkspaceID: existingID, RootPath: existingRoot, State: state}
				return nil
			}
		}

		// Create. agent_root is GENERATED (`root_path || '/work'`): an INSERT
		// that names it is refused with 428C9, which is the database enforcing
		// that the granted tree and the worker-only tree are siblings.
		var id, root string
		if err := tx.QueryRow(ctx, `
			INSERT INTO workspaces
				(organization_id, project_id, scope_kind, conversation_id, worker_id, volume_id, root_path, workspace_mode, state)
			VALUES ($1::uuid, $2::uuid, 'conversation', $3::uuid, $4::uuid, $5, $6, $7, 'preparing')
			RETURNING id::text, root_path`,
			req.OrganizationID, req.ProjectID, req.ConversationID, req.WorkerID,
			req.VolumeID, req.RootPath, req.Mode).Scan(&id, &root); err != nil {
			return fmt.Errorf("postgres: create workspace row: %w", err)
		}
		out = worker.WorkspaceDecision{Kind: worker.DecisionCreated, WorkspaceID: id, RootPath: root, State: "preparing"}
		return nil
	})
	if err != nil {
		return worker.WorkspaceDecision{}, err
	}
	return out, nil
}

// MarkReady moves preparing -> ready and stamps ready_at, which the
// workspaces_state_timestamped CHECK requires of every state after preparing.
func (s *WorkspaceStore) MarkReady(ctx context.Context, workspaceID string) error {
	return s.setState(ctx, workspaceID, "ready", "")
}

// Quarantine moves the workspace to quarantined with the reason enum only.
//
// There is deliberately no free-text column reachable here: the git errors that
// would explain a quarantine quote absolute host paths, and those are not
// browser-visible material (contract § 3). The reason enum is the whole story
// the journal is allowed to carry.
func (s *WorkspaceStore) Quarantine(ctx context.Context, workspaceID, reason string) error {
	switch reason {
	case "secret_left_behind", "exclusion_failed", "worktree_unusable", "prepare_failed":
	default:
		return fmt.Errorf("postgres: workspace quarantine reason %q is not one the event schema allows", reason)
	}
	return s.setState(ctx, workspaceID, "quarantined", reason)
}

// Release moves the workspace to released after cleanup proved it.
func (s *WorkspaceStore) Release(ctx context.Context, workspaceID string) error {
	return s.setState(ctx, workspaceID, "released", "")
}

func (s *WorkspaceStore) setState(ctx context.Context, workspaceID, state, reason string) error {
	if s == nil || s.Pool == nil {
		return errors.New("postgres: workspace store has no pool")
	}
	query := `UPDATE workspaces SET state = $2`
	switch state {
	case "ready", "quarantined":
		query += `, ready_at = COALESCE(ready_at, now())`
	case "released":
		query += `, released_at = now()`
	case "lost":
		query += `, lost_at = now(), ready_at = COALESCE(ready_at, now())`
	default:
		return fmt.Errorf("postgres: workspace state %q is not writable through this path", state)
	}
	tag, err := s.Pool.Exec(ctx, query+` WHERE id = $1::uuid`, workspaceID, state)
	if err != nil {
		return fmt.Errorf("postgres: set workspace %s state %s (%s): %w", workspaceID, state, reason, err)
	}
	if tag.RowsAffected() == 0 {
		return fmt.Errorf("postgres: set workspace %s state %s: %w", workspaceID, state, ErrNotFound)
	}
	return nil
}

// RecordRepos persists what a prepare actually established, in one transaction
// with the state move that makes it visible (ADR-0017 D3: `preparing → ready`
// and the rows describing the tree are one fact).
func (s *WorkspaceStore) RecordRepos(ctx context.Context, workspaceID string, repos []worker.WorkspaceRepo, markReady bool) error {
	if s == nil || s.Pool == nil {
		return errors.New("postgres: workspace store has no pool")
	}
	return s.inTx(ctx, func(tx pgx.Tx) error {
		for _, r := range repos {
			if r.RepositoryID == "" || r.CheckoutPath == "" || r.MirrorPath == "" || r.AdminDir == "" || r.MirrorVolumeID == "" {
				return fmt.Errorf("postgres: workspace_repos row for %s is incomplete", r.RepositoryID)
			}
			excluded, err := wspJSONList(r.ExcludedPaths)
			if err != nil {
				return err
			}
			// One event per workspace, not one per repository: `workspace.prepared`
			// is the fact that the tree is what the rows say it is, and the rows
			// are the per-repository detail. The controlled event vocabulary has
			// five workspace types and inventing a sixth (a repo-level "prepared")
			// would put an unrecognized type in a browser-visible stream.
			if _, err := tx.Exec(ctx, `
				INSERT INTO workspace_repos
					(workspace_id, repository_id, checkout_path, mirror_path, mirror_volume_id,
					 admin_dir, run_ref, base_commit, head_commit, excluded_paths)
				VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, NULLIF($9,''), $10::jsonb)
				ON CONFLICT (workspace_id, repository_id) DO UPDATE SET
					checkout_path = EXCLUDED.checkout_path,
					mirror_path   = EXCLUDED.mirror_path,
					mirror_volume_id = EXCLUDED.mirror_volume_id,
					admin_dir     = EXCLUDED.admin_dir,
					run_ref       = EXCLUDED.run_ref,
					base_commit   = EXCLUDED.base_commit,
					head_commit   = COALESCE(workspace_repos.head_commit, EXCLUDED.head_commit),
					excluded_paths = EXCLUDED.excluded_paths`,
				workspaceID, r.RepositoryID, r.CheckoutPath, r.MirrorPath, r.MirrorVolumeID,
				r.AdminDir, r.RunRef, r.BaseCommit, r.HeadCommit, excluded); err != nil {
				return fmt.Errorf("postgres: record workspace %s repo %s: %w", workspaceID, r.RepositoryID, err)
			}
		}
		if markReady {
			tag, err := tx.Exec(ctx, `
				UPDATE workspaces SET state = 'ready', ready_at = COALESCE(ready_at, now())
				WHERE id = $1::uuid AND state = 'preparing'`, workspaceID)
			if err != nil {
				return fmt.Errorf("postgres: mark workspace %s ready: %w", workspaceID, err)
			}
			if tag.RowsAffected() == 0 {
				return fmt.Errorf("postgres: workspace %s was not preparing (someone else moved its state)", workspaceID)
			}
		}
		return nil
	})
}

// WorkspaceRepos reads the rows back — the worker's own re-attach path, and the
// source for the status endpoint's manifest.
func (s *WorkspaceStore) WorkspaceRepos(ctx context.Context, workspaceID string) ([]worker.WorkspaceRepoState, error) {
	if s == nil || s.Pool == nil {
		return nil, errors.New("postgres: workspace store has no pool")
	}
	rows, err := s.Pool.Query(ctx, `
		SELECT wr.id::text, wr.repository_id::text, wr.checkout_path, wr.mirror_path, wr.mirror_volume_id,
		       wr.admin_dir, wr.run_ref, wr.base_commit, COALESCE(wr.head_commit, ''),
		       wr.excluded_paths, wr.modified_paths, w.project_id::text, w.organization_id::text
		FROM workspace_repos wr JOIN workspaces w ON w.id = wr.workspace_id
		WHERE wr.workspace_id = $1::uuid ORDER BY wr.repository_id`, workspaceID)
	if err != nil {
		return nil, fmt.Errorf("postgres: read workspace %s repos: %w", workspaceID, err)
	}
	defer rows.Close()
	var out []worker.WorkspaceRepoState
	for rows.Next() {
		var (
			r                                   worker.WorkspaceRepoState
			excluded, modified, projectID, orgs string
		)
		if err := rows.Scan(&r.RowID, &r.RepositoryID, &r.CheckoutPath, &r.MirrorPath, &r.MirrorVolumeID,
			&r.AdminDir, &r.RunRef, &r.BaseCommit, &r.HeadCommit, &excluded, &modified, &projectID, &orgs); err != nil {
			return nil, fmt.Errorf("postgres: scan workspace repo: %w", err)
		}
		r.ExcludedPaths = wspFromJSONList(excluded)
		r.ModifiedPaths = wspFromJSONList(modified)
		r.ProjectID, r.OrganizationID = projectID, orgs
		out = append(out, r)
	}
	return out, rows.Err()
}

// RecordCommit is the post-commit write, and the *ref read* is the proof rather
// than the exit status: probe P8 saw a commit that printed
// `packed-refs.lock: Permission denied` on stderr and still succeeded, and
// another whose ref update failed at exit 128 while the command looked fine.
// Callers therefore read the ref and pass what git answered.
func (s *WorkspaceStore) RecordCommit(ctx context.Context, rec worker.CommitRecord) error {
	if s == nil || s.Pool == nil {
		return errors.New("postgres: workspace store has no pool")
	}
	manifest, err := wspJSONList(rec.ModifiedPaths)
	if err != nil {
		return err
	}
	return s.inTx(ctx, func(tx pgx.Tx) error {
		tag, err := tx.Exec(ctx, `
			UPDATE workspace_repos
			SET head_commit = NULLIF($2,''), modified_paths = $3::jsonb
			WHERE id = $1::uuid`, rec.RowID, rec.HeadCommit, manifest)
		if err != nil {
			return fmt.Errorf("postgres: record commit for workspace repo %s: %w", rec.RowID, err)
		}
		if tag.RowsAffected() == 0 {
			return fmt.Errorf("postgres: record commit for workspace repo %s: %w", rec.RowID, ErrNotFound)
		}
		return wspAppendTx(ctx, tx, rec.OrganizationID, rec.ProjectID, "", events.TypeWorkspaceCommitted, events.WorkspaceCommittedPayload{
			WorkspaceID: rec.WorkspaceID, ProjectID: rec.ProjectID, RepositoryID: rec.RepositoryID,
			RunRef: rec.RunRef, HeadCommit: rec.HeadCommit,
		})
	})
}

// LiveWorkspaceForConversation reads the row the turn loop re-attaches to,
// including the volume it was recorded on so the caller can compare against what
// it measures now (case 20's question is asked at prepare, not at recovery).
func (s *WorkspaceStore) LiveWorkspaceForConversation(ctx context.Context, conversationID string) (worker.WorkspaceRow, bool, error) {
	if s == nil || s.Pool == nil {
		return worker.WorkspaceRow{}, false, errors.New("postgres: workspace store has no pool")
	}
	var w worker.WorkspaceRow
	err := s.Pool.QueryRow(ctx, `
		SELECT id::text, organization_id::text, project_id::text, worker_id::text, volume_id,
		       root_path, agent_root, workspace_mode, state
		FROM workspaces
		WHERE conversation_id = $1::uuid AND state IN ('preparing','ready','quarantined')
		ORDER BY created_at DESC LIMIT 1`, conversationID).
		Scan(&w.ID, &w.OrganizationID, &w.ProjectID, &w.WorkerID, &w.VolumeID,
			&w.RootPath, &w.AgentRoot, &w.Mode, &w.State)
	if errors.Is(err, pgx.ErrNoRows) {
		return worker.WorkspaceRow{}, false, nil
	}
	if err != nil {
		return worker.WorkspaceRow{}, false, fmt.Errorf("postgres: read live workspace for %s: %w", conversationID, err)
	}
	return w, true, nil
}

// WorkspaceEvent appends a workspace-scoped journal event on the worker's
// behalf. It is a separate transaction from the state write it describes:
// ADR-0017 D3's ordering note says the event follows the transition, and the
// transition is the durable fact — an event that failed to append leaves the
// row correct rather than half-applied.
func (s *WorkspaceStore) WorkspaceEvent(ctx context.Context, organizationID, projectID, conversationID string, ev worker.TurnEvent) error {
	if s == nil || s.Pool == nil {
		return errors.New("postgres: workspace store has no pool")
	}
	return s.inTx(ctx, func(tx pgx.Tx) error {
		return wspAppendTx(ctx, tx, organizationID, projectID, conversationID, ev.Type, ev.Payload)
	})
}

// ------------------------------------------------------------- internals

// wspAppendTx inserts one journal row with a worker actor. conversationID may
// be empty (a workspace event with no turn behind it).
func wspAppendTx(ctx context.Context, tx pgx.Tx, organizationID, projectID, conversationID, eventType string, payload any) error {
	if eventType == "" {
		return errors.New("postgres: workspace event requires a type")
	}
	raw, err := prjPayloadJSON(payload)
	if err != nil {
		return err
	}
	if err := LockEventJournal(ctx, tx, projectID, organizationID); err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `
		INSERT INTO domain_events
			(type, organization_id, project_id, conversation_id, actor_kind, actor_id, payload)
		VALUES ($1, $2::uuid, NULLIF($3,'')::uuid, NULLIF($4,'')::uuid, 'worker',
		        COALESCE((SELECT current_setting('communication.worker_id', true))::text, 'system'), $5::jsonb)`,
		eventType, organizationID, prjCleanUUID(projectID), prjCleanUUID(conversationID), raw)
	if err != nil {
		return fmt.Errorf("postgres: append %s: %w", eventType, err)
	}
	return nil
}

// markWorkspaceTx moves a row to a terminal-ish state inside a transaction.
func markWorkspaceTx(ctx context.Context, tx pgx.Tx, workspaceID, state, reason string) error {
	column := "ready_at"
	switch state {
	case "lost":
		column = "lost_at"
	case "released":
		column = "released_at"
	}
	tag, err := tx.Exec(ctx, fmt.Sprintf(`
		UPDATE workspaces SET state = $2, %s = now(), ready_at = COALESCE(ready_at, now())
		WHERE id = $1::uuid AND state IN ('preparing','ready','quarantined')`, column),
		workspaceID, state)
	if err != nil {
		return fmt.Errorf("postgres: mark workspace %s %s (%s): %w", workspaceID, state, reason, err)
	}
	if tag.RowsAffected() == 0 {
		return fmt.Errorf("postgres: mark workspace %s %s: %w", workspaceID, state, ErrNotFound)
	}
	return nil
}

// wspJSONList renders a path list for a jsonb column. An empty list is `[]`,
// never NULL: the artifact filter reads this column and "unknown" must not be
// expressible as a NULL that some caller coalesces differently.
func wspJSONList(paths []string) (string, error) {
	if paths == nil {
		paths = []string{}
	}
	for _, p := range paths {
		if strings.HasPrefix(p, "/") || strings.Contains(p, "..") {
			return "", fmt.Errorf("postgres: excluded path %q is not a safe relative path", p)
		}
	}
	out, err := json.Marshal(paths)
	if err != nil {
		return "", fmt.Errorf("postgres: encode path list: %w", err)
	}
	return string(out), nil
}

func wspFromJSONList(raw string) []string {
	var out []string
	if raw == "" {
		return nil
	}
	if err := json.Unmarshal([]byte(raw), &out); err != nil {
		return nil
	}
	return out
}

// inTx runs one transaction on the pool. It is a method rather than an inline
// Begin/Commit pair at each call site because every workspace write has to be
// all-or-nothing for the reason ADR-0017 D3 gives: a workspace marked `ready`
// whose workspace_repos rows did not land is the "ready workspace that silently
// lacks a repository" state, and a partially-committed write is how you get one.
func (s *WorkspaceStore) inTx(ctx context.Context, fn func(tx pgx.Tx) error) error {
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("postgres: begin workspace transaction: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := fn(tx); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("postgres: commit workspace transaction: %w", err)
	}
	return nil
}

// ---------------------------------------------------------------- profiles ---

// ProfileReader reads the execution axes of the agent profile a conversation is
// pinned to. It lives with the workspace store because both are the worker's
// read-side of M3's schema, and because the axes' meaning depends on the same
// CHECK constraints the workspace rows are validated against.
//
// Deviation D10 is load-bearing here: ADR-0008's profile *revisions* do not exist
// in M3's schema, so these are columns on agent_profiles rather than on a frozen
// revision row. ADR-0008 says a run keeps the revision it started with; with no
// revisions, a conversation that changes profile mid-run changes its sandbox
// policy mid-run too. That is a real gap in the isolation story, it is not one
// this milestone may close by inventing a table, and the worker reports it
// rather than pretending the read is a pin: see the profile_drifted warning.
type ProfileReader struct {
	Pool *pgxpool.Pool
}

// ProfileFor returns the axes for a conversation's current profile.
func (p *ProfileReader) ProfileFor(ctx context.Context, conversationID string) (worker.ProfileAxes, error) {
	if p == nil || p.Pool == nil {
		return worker.ProfileAxes{}, errors.New("postgres: profile reader has no pool")
	}
	var (
		out                              worker.ProfileAxes
		apmRef, apmTarget, apmLockDigest sql.NullString
		workspaceMode, enforcement       string
	)
	// conversation_id is the only input, and the join is the authority on which
	// profile applies: a worker that accepted a profile id from its own config
	// would let a worker-side setting choose an agent's sandbox policy.
	err := p.Pool.QueryRow(ctx, `
		SELECT ap.id::text, ap.launcher_id, ap.workspace_mode,
		       ap.sandbox_enforcement, ap.commit_granted,
		       ap.apm_package_ref, ap.apm_target, ap.apm_lock_digest
		FROM conversations c JOIN agent_profiles ap ON ap.id = c.agent_profile_id
		WHERE c.id = $1::uuid`, conversationID).
		Scan(&out.AgentProfileID, &out.LauncherID, &workspaceMode,
			&enforcement, &out.CommitGranted, &apmRef, &apmTarget, &apmLockDigest)
	if errors.Is(err, pgx.ErrNoRows) {
		return worker.ProfileAxes{}, fmt.Errorf("postgres: conversation %s has no readable agent profile", conversationID)
	}
	if err != nil {
		return worker.ProfileAxes{}, fmt.Errorf("postgres: read profile axes for %s: %w", conversationID, err)
	}
	out.WorkspaceMode = workspaceMode
	// The profile's requested enforcement is returned, not applied: the worker's
	// registered mode is the ceiling (ADR-0019 D6), so a profile asking for
	// `disabled` on a `required` worker gets `required` and the refusal is
	// recorded by the launcher, not negotiated here.
	out.SandboxEnforcement = domain.EnforcementMode(enforcement)
	out.APMPackageRef = apmRef.String
	out.APMTarget = apmTarget.String
	out.APMLockDigest = apmLockDigest.String
	if apmRef.String != "" && !apmLockDigest.Valid {
		// A profile that stages packaged context without a recorded lock digest
		// cannot be checked against probe A5's finding (an install whose content
		// moved while --frozen reported success). Staging it anyway would be a
		// silent "we trust whatever apm put there today".
		return worker.ProfileAxes{}, fmt.Errorf("postgres: profile %s pins apm_package_ref=%s with no apm_lock_digest: refusing to stage unverifiable packaged context", out.AgentProfileID, apmRef.String)
	}
	return out, nil
}
