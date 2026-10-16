package postgres

// M4 serve-side adapters for the assignment surface (routes 17–20) and the
// pipeline-gate surface (routes 34–36). Same two rules as m4api.go: the
// permission predicate is part of the SQL, and every mutation writes state +
// its § 3 journal row in ONE transaction.
//
// The engine is never re-implemented here: DecideApproval runs the committed
// RuntimeStore.Decide CAS (hydrate-per-transaction, advancer pass, journal
// append in the same commit), so "exactly one decision wins" (12 case 9d /
// C9d) is one CAS, not a read-then-write in this layer.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/dbirks/communication/internal/api"
	"github.com/dbirks/communication/internal/events"
	"github.com/dbirks/communication/internal/pipelines/compiler"
	"github.com/dbirks/communication/internal/pipelines/runtime"
)

// -------------------------------------------------------------- assignments

// m4AssignmentColumns is one assignment row in api.AssignmentView order, with
// the pinned revision's digest/label joined in (route 17 promises "pinned
// revision digests") and the caller's role for the handler's maintainer gate.
// Params: $1 caller user, $2 caller organization, $3 caller is org admin.
const m4AssignmentColumns = `
	x.id, x.project_id, x.pipeline_id, x.pinned_revision_id,
	r.revision_digest, r.version_label,
	x.max_concurrent_runs, x.budget_overrides, x.enabled, x.version,
	x.created_at, x.updated_at,
	COALESCE(m.role, CASE WHEN $3::boolean THEN 'maintainer' ELSE '' END),
	r.compiled_plan`

// m4AssignmentScope is the predicate: the assignment's PROJECT must be in the
// caller's organization and the caller must hold a membership there (or be an
// org admin). A cross-organization assignment answers
// api.ErrAssignmentNotFound — the same bytes a random uuid produces.
const m4AssignmentScope = `
	FROM assignments x
	JOIN projects p ON p.id = x.project_id
	JOIN pipeline_revisions r ON r.id = x.pinned_revision_id
	LEFT JOIN memberships m ON m.project_id = p.id AND m.user_id = $1::uuid
	WHERE p.organization_id = $2::uuid
	  AND ($3::boolean OR m.user_id IS NOT NULL)`

// APIAssignmentStore exposes assignments as api.AssignmentStore (routes
// 17–20). It rides the committed *PipelineStore's pool (the assignment rows
// and the revision pin are that store's tables) and re-runs its statements
// inside a transaction so assignment.created / assignment.updated ride the
// same commit as the row they describe.
type APIAssignmentStore struct {
	S *PipelineStore
}

func (a APIAssignmentStore) pool() (*pgxpool.Pool, error) {
	if a.S == nil {
		return nil, errors.New("postgres: APIAssignmentStore has no store")
	}
	return m4Pool(a.S.Pool, "APIAssignmentStore")
}

func m4AssignmentViewScan(id, projectID, pipelineID, revID, digest string, label *string,
	maxConcurrent int, overrides []byte, enabled bool, version int, createdAt, updatedAt time.Time,
	role string, plan []byte) (api.AssignmentView, error) {
	effective, err := m4EffectiveBudgets(plan, orEmptyJSON(overrides))
	if err != nil {
		return api.AssignmentView{}, err
	}
	return api.AssignmentView{
		ID: id, ProjectID: projectID, PipelineID: pipelineID,
		PinnedRevisionID: revID, PinnedRevisionDigest: digest, PinnedVersionLabel: label,
		MaxConcurrentRuns: maxConcurrent,
		BudgetOverrides:   orEmptyJSON(overrides),
		EffectiveBudgets:  effective,
		Enabled:           enabled, Version: version,
		CreatedAt: createdAt, UpdatedAt: updatedAt,
		MyRole: role,
	}, nil
}

// ListAssignments is route 17: the project's assignments under the caller's
// predicate, newest first. An invisible project yields the empty list (the
// handler has already 403/404'd a project the caller may not read; the
// predicate here is what keeps a wrong projectID from leaking rows).
func (a APIAssignmentStore) ListAssignments(ctx context.Context, c api.Caller, projectID string) ([]api.AssignmentView, error) {
	pool, err := a.pool()
	if err != nil {
		return nil, err
	}
	cc := callerFromAPI(c)
	if err := prjRequireCaller(cc); err != nil {
		return nil, err
	}
	rows, err := pool.Query(ctx, `
		SELECT `+m4AssignmentColumns+`
		`+m4AssignmentScope+`
		  AND x.project_id = $4::uuid
		ORDER BY x.created_at DESC, x.id DESC`,
		cc.UserID, cc.OrganizationID, cc.IsOrgAdmin, projectID)
	if err != nil {
		return nil, fmt.Errorf("postgres: api list assignments: %w", err)
	}
	defer rows.Close()
	out := []api.AssignmentView{}
	for rows.Next() {
		v, err := m4ScanAssignment(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

func m4ScanAssignment(row pgx.Row) (api.AssignmentView, error) {
	var (
		id, projectID, pipelineID, revID, digest string
		label                                    *string
		maxConcurrent                            int
		overrides                                []byte
		enabled                                  bool
		version                                  int
		createdAt, updatedAt                     time.Time
		role                                     string
		plan                                     []byte
	)
	if err := row.Scan(&id, &projectID, &pipelineID, &revID, &digest, &label,
		&maxConcurrent, &overrides, &enabled, &version, &createdAt, &updatedAt,
		&role, &plan); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			// The predicate missed: the same bytes a random uuid produces.
			return api.AssignmentView{}, api.ErrAssignmentNotFound
		}
		return api.AssignmentView{}, fmt.Errorf("postgres: scan api assignment: %w", err)
	}
	return m4AssignmentViewScan(id, projectID, pipelineID, revID, digest, label,
		maxConcurrent, overrides, enabled, version, createdAt, updatedAt, role, plan)
}

// CreateAssignment is route 18: the pin, the ceilings and assignment.created
// in one commit. The pin is validated in SQL — the revision must be
// published, belong to pipeline_id and live in the caller's organization —
// and a refusal answers the not-found sentinel, never "that revision exists
// but you may not have it". A second assignment of one pipeline to one
// project is api.ErrAssignmentConflict (UNIQUE (project_id, pipeline_id)).
func (a APIAssignmentStore) CreateAssignment(ctx context.Context, c api.Caller, projectID string,
	in api.AssignmentCreateInput) (api.AssignmentView, error) {
	pool, err := a.pool()
	if err != nil {
		return api.AssignmentView{}, err
	}
	cc := callerFromAPI(c)
	if err := prjRequireCaller(cc); err != nil {
		return api.AssignmentView{}, err
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		return api.AssignmentView{}, fmt.Errorf("postgres: begin create assignment: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// The project must be visible to the caller: assignments belong to the
	// caller's organization, and the maintainership gate is the handler's.
	var orgID, role string
	err = tx.QueryRow(ctx, `
		SELECT p.organization_id::text,
		       COALESCE(m.role, CASE WHEN $4::boolean THEN 'maintainer' ELSE '' END)
		FROM projects p
		LEFT JOIN memberships m ON m.project_id = p.id AND m.user_id = $1::uuid
		WHERE p.id = $2::uuid AND p.organization_id = $3::uuid
		  AND ($4::boolean OR m.user_id IS NOT NULL)`,
		cc.UserID, projectID, cc.OrganizationID, cc.IsOrgAdmin).Scan(&orgID, &role)
	if errors.Is(err, pgx.ErrNoRows) {
		return api.AssignmentView{}, api.ErrAssignmentNotFound
	}
	if err != nil {
		return api.AssignmentView{}, fmt.Errorf("postgres: resolve assignment project: %w", err)
	}

	// The pin: published, of this pipeline, in this organization.
	var (
		revDigest  string
		revLabel   *string
		plan       []byte
		revStatus  string
		revPipeID  string
		revOrgID   string
		revFoundOK bool
	)
	err = tx.QueryRow(ctx, `
		SELECT r.revision_digest, r.version_label, r.compiled_plan, r.status, r.pipeline_id::text,
		       p.organization_id::text, true
		FROM pipeline_revisions r JOIN pipelines p ON p.id = r.pipeline_id
		WHERE r.id = $1::uuid AND r.pipeline_id = $2::uuid`,
		in.PinnedRevisionID, in.PipelineID).
		Scan(&revDigest, &revLabel, &plan, &revStatus, &revPipeID, &revOrgID, &revFoundOK)
	if errors.Is(err, pgx.ErrNoRows) {
		return api.AssignmentView{}, api.ErrPipelineNotFound
	}
	if err != nil {
		return api.AssignmentView{}, fmt.Errorf("postgres: resolve assignment pin: %w", err)
	}
	if revStatus != "published" || revOrgID != cc.OrganizationID {
		return api.AssignmentView{}, api.ErrPipelineNotFound
	}

	overrides := orEmptyJSON(in.BudgetOverrides)
	effective, err := m4BudgetsFromPlan(plan, overrides)
	if err != nil {
		return api.AssignmentView{}, err
	}
	effectiveRaw, err := json.Marshal(effective)
	if err != nil {
		return api.AssignmentView{}, fmt.Errorf("postgres: encode effective budgets: %w", err)
	}

	maxConcurrent := in.MaxConcurrentRuns
	if maxConcurrent == 0 {
		maxConcurrent = 1
	}
	var (
		id        string
		createdAt time.Time
	)
	err = tx.QueryRow(ctx, `
		INSERT INTO assignments
			(project_id, pipeline_id, pinned_revision_id, max_concurrent_runs,
			 budget_overrides, created_by)
		VALUES ($1::uuid, $2::uuid, $3::uuid, $4, COALESCE(NULLIF($5, '')::jsonb, '{}'::jsonb), $6::uuid)
		RETURNING id::text, created_at`,
		projectID, in.PipelineID, in.PinnedRevisionID, maxConcurrent,
		string(overrides), cc.UserID).
		Scan(&id, &createdAt)
	if m4UniqueViolation(err) {
		return api.AssignmentView{}, api.ErrAssignmentConflict
	}
	if err != nil {
		return api.AssignmentView{}, fmt.Errorf("postgres: api create assignment: %w", err)
	}

	budgetMap, err := m4JSONAsMap(overrides)
	if err != nil {
		return api.AssignmentView{}, err
	}
	if err := m4AppendAppendable(ctx, tx, events.TypeAssignmentCreated, orgID, projectID, cc.UserID,
		events.AssignmentCreatedPayload{
			ProjectID: projectID, AssignmentID: id, PipelineID: in.PipelineID,
			PinnedRevisionID: in.PinnedRevisionID, RevisionDigest: revDigest,
			MaxConcurrentRuns: maxConcurrent, BudgetOverrides: budgetMap,
		}); err != nil {
		return api.AssignmentView{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return api.AssignmentView{}, fmt.Errorf("postgres: commit create assignment: %w", err)
	}
	return api.AssignmentView{
		ID: id, ProjectID: projectID, PipelineID: in.PipelineID,
		PinnedRevisionID: in.PinnedRevisionID, PinnedRevisionDigest: revDigest,
		PinnedVersionLabel: revLabel,
		MaxConcurrentRuns:  maxConcurrent, BudgetOverrides: overrides,
		EffectiveBudgets: json.RawMessage(effectiveRaw),
		Enabled:          true, Version: 1, CreatedAt: createdAt, UpdatedAt: createdAt,
		MyRole: role,
	}, nil
}

// GetAssignment is route 19/20's precondition read (the handler needs the
// row's role and id before it will accept the mutation).
func (a APIAssignmentStore) GetAssignment(ctx context.Context, c api.Caller, assignmentID string) (api.AssignmentView, error) {
	pool, err := a.pool()
	if err != nil {
		return api.AssignmentView{}, err
	}
	cc := callerFromAPI(c)
	if err := prjRequireCaller(cc); err != nil {
		return api.AssignmentView{}, err
	}
	return m4ScanAssignment(pool.QueryRow(ctx, `
		SELECT `+m4AssignmentColumns+`
		`+m4AssignmentScope+`
		  AND x.id = $4::uuid`,
		cc.UserID, cc.OrganizationID, cc.IsOrgAdmin, assignmentID))
}

// UpdateAssignment is route 19. The PATCH body carries no version member
// (api.AssignmentPatchInput has none), so the caller's read is the version
// GetAssignment returned a moment ago; this re-reads it and hands it to the
// CAS, which makes the loser of a genuine concurrent PATCH the row that
// moved first: 409 with the winner's version in the detail rather than a
// silent overwrite of someone else's re-pin.
func (a APIAssignmentStore) UpdateAssignment(ctx context.Context, c api.Caller, assignmentID string,
	in api.AssignmentPatchInput) (api.AssignmentView, error) {
	current, err := a.GetAssignment(ctx, c, assignmentID)
	if err != nil {
		return api.AssignmentView{}, err
	}
	return a.updateWithVersion(ctx, c, assignmentID, in, current.Version)
}

// updateWithVersion is the CAS arm UpdateAssignment runs, exposed to the
// package's tests so a stale version can be produced deterministically
// instead of by racing two connections.
func (a APIAssignmentStore) updateWithVersion(ctx context.Context, c api.Caller, assignmentID string,
	in api.AssignmentPatchInput, expectedVersion int) (api.AssignmentView, error) {
	pool, err := a.pool()
	if err != nil {
		return api.AssignmentView{}, err
	}
	cc := callerFromAPI(c)
	if err := prjRequireCaller(cc); err != nil {
		return api.AssignmentView{}, err
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		return api.AssignmentView{}, fmt.Errorf("postgres: begin update assignment: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var (
		beforeID, beforePipe, beforeRev, beforeDigest string
		beforeMax                                     int
		beforeOverrides                               []byte
		beforeEnabled                                 bool
		orgID, projectID                              string
		plan                                          []byte
	)
	err = tx.QueryRow(ctx, `
		SELECT x.id::text, x.pipeline_id::text, x.pinned_revision_id::text, r.revision_digest,
		       x.max_concurrent_runs, x.budget_overrides, x.enabled,
		       p.organization_id::text, x.project_id::text, r.compiled_plan
		`+m4AssignmentScope+`
		  AND x.id = $4::uuid
		FOR UPDATE OF x`,
		cc.UserID, cc.OrganizationID, cc.IsOrgAdmin, assignmentID).
		Scan(&beforeID, &beforePipe, &beforeRev, &beforeDigest,
			&beforeMax, &beforeOverrides, &beforeEnabled, &orgID, &projectID, &plan)
	if errors.Is(err, pgx.ErrNoRows) {
		return api.AssignmentView{}, api.ErrAssignmentNotFound
	}
	if err != nil {
		return api.AssignmentView{}, fmt.Errorf("postgres: lock assignment: %w", err)
	}

	// Re-pin validation runs exactly as at creation: published, of this
	// pipeline, in this organization.
	if in.PinnedRevisionID != nil {
		var (
			status, pipeID, revOrg, digest string
			revPlan                        []byte
		)
		err = tx.QueryRow(ctx, `
			SELECT r.status, r.pipeline_id::text, p.organization_id, r.revision_digest, r.compiled_plan
			FROM pipeline_revisions r JOIN pipelines p ON p.id = r.pipeline_id
			WHERE r.id = $1::uuid`, in.PinnedRevisionID).
			Scan(&status, &pipeID, &revOrg, &digest, &revPlan)
		if errors.Is(err, pgx.ErrNoRows) {
			return api.AssignmentView{}, api.ErrPipelineNotFound
		}
		if err != nil {
			return api.AssignmentView{}, fmt.Errorf("postgres: resolve re-pin: %w", err)
		}
		if status != "published" || pipeID != beforePipe || revOrg != cc.OrganizationID {
			return api.AssignmentView{}, api.ErrPipelineNotFound
		}
		plan = revPlan
	}

	overrides := orEmptyJSON(beforeOverrides)
	if in.BudgetOverrides != nil {
		overrides = orEmptyJSON(*in.BudgetOverrides)
	}
	if _, err := m4BudgetsFromPlan(plan, overrides); err != nil {
		return api.AssignmentView{}, err
	}
	maxConcurrent := beforeMax
	if in.MaxConcurrentRuns != nil {
		maxConcurrent = *in.MaxConcurrentRuns
	}

	var (
		id, revID, digest string
		version           int
		updatedAt         time.Time
	)
	err = tx.QueryRow(ctx, `
		UPDATE assignments
		SET pinned_revision_id = COALESCE(NULLIF($2, '')::uuid, pinned_revision_id),
		    max_concurrent_runs = COALESCE(NULLIF($3, 0), max_concurrent_runs),
		    budget_overrides = COALESCE(NULLIF($4, '')::jsonb, budget_overrides),
		    enabled = COALESCE($5::boolean, enabled),
		    version = version + 1, updated_at = now()
		WHERE id = $1::uuid AND version = $6
		RETURNING id::text, pinned_revision_id::text, version, updated_at`,
		assignmentID, derefAnyStr(in.PinnedRevisionID), derefInt(in.MaxConcurrentRuns),
		derefJSON(in.BudgetOverrides), in.Enabled, expectedVersion).
		Scan(&id, &revID, &version, &updatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return api.AssignmentView{}, m4AssignmentStale(assignmentID, expectedVersion,
			a.currentVersionLocked(ctx, tx, assignmentID))
	}
	if err != nil {
		return api.AssignmentView{}, fmt.Errorf("postgres: api update assignment: %w", err)
	}
	if in.PinnedRevisionID != nil {
		digest, err = m4RevisionDigestLocked(ctx, tx, revID)
		if err != nil {
			return api.AssignmentView{}, err
		}
	} else {
		revID, digest = beforeRev, beforeDigest
	}

	afterOverrides := overrides
	if in.BudgetOverrides != nil {
		afterOverrides = orEmptyJSON(*in.BudgetOverrides)
	}
	afterMap, err := m4JSONAsMap(afterOverrides)
	if err != nil {
		return api.AssignmentView{}, err
	}
	beforeMap, err := m4JSONAsMap(orEmptyJSON(beforeOverrides))
	if err != nil {
		return api.AssignmentView{}, err
	}
	before, after := m4AssignmentDelta(beforeRev, beforeDigest, beforeMax, beforeMap, beforeEnabled,
		revID, digest, maxConcurrent, afterMap, in)
	if err := m4AppendAppendable(ctx, tx, events.TypeAssignmentUpdated, orgID, projectID, cc.UserID,
		events.AssignmentUpdatedPayload{
			ProjectID: projectID, AssignmentID: id, PipelineID: beforePipe,
			PinnedRevisionID: revID, RevisionDigest: digest,
			MaxConcurrentRuns: maxConcurrent, BudgetOverrides: afterMap,
			Before: before, After: after,
		}); err != nil {
		return api.AssignmentView{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return api.AssignmentView{}, fmt.Errorf("postgres: commit update assignment: %w", err)
	}
	return a.GetAssignment(ctx, c, assignmentID)
}

func (a APIAssignmentStore) currentVersionLocked(ctx context.Context, tx pgx.Tx, assignmentID string) int {
	var v int
	_ = tx.QueryRow(ctx, `SELECT version FROM assignments WHERE id = $1::uuid`, assignmentID).Scan(&v)
	return v
}

func m4RevisionDigestLocked(ctx context.Context, tx pgx.Tx, revisionID string) (string, error) {
	var digest string
	if err := tx.QueryRow(ctx, `
		SELECT revision_digest FROM pipeline_revisions WHERE id = $1::uuid`, revisionID).
		Scan(&digest); err != nil {
		return "", fmt.Errorf("postgres: read revision %s digest: %w", revisionID, err)
	}
	return digest, nil
}

// m4AssignmentStale is the CAS arm: 409 with the winner's version in the
// detail, so the loser re-reads the truth instead of guessing.
func m4AssignmentStale(assignmentID string, want, got int) *api.RunConflictError {
	return &api.RunConflictError{
		Kind:   "assignment_stale_version",
		RunID:  "",
		Detail: fmt.Sprintf("assignment %s is at version %d, not %d: re-read it before patching.", assignmentID, got, want),
	}
}

// DeleteAssignment is route 20. Runs reference the REVISION for everything
// that executes, so the assignment's departure must not disturb them: the
// adapter detaches referencing runs' assignment_id (SET NULL) rather than
// refusing, which is what makes the route's promise true. § 3 carries no
// assignment.deleted row — the removal is proven by the row being gone and
// the runs still pinning their digest.
func (a APIAssignmentStore) DeleteAssignment(ctx context.Context, c api.Caller, assignmentID string) error {
	pool, err := a.pool()
	if err != nil {
		return err
	}
	cc := callerFromAPI(c)
	if err := prjRequireCaller(cc); err != nil {
		return err
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("postgres: begin delete assignment: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var projectID string
	err = tx.QueryRow(ctx, `
		SELECT x.project_id::text
		`+m4AssignmentScope+`
		  AND x.id = $4::uuid
		FOR UPDATE OF x`,
		cc.UserID, cc.OrganizationID, cc.IsOrgAdmin, assignmentID).Scan(&projectID)
	if errors.Is(err, pgx.ErrNoRows) {
		return api.ErrAssignmentNotFound
	}
	if err != nil {
		return fmt.Errorf("postgres: lock assignment %s: %w", assignmentID, err)
	}
	if _, err := tx.Exec(ctx, `
		UPDATE runs SET assignment_id = NULL WHERE assignment_id = $1::uuid`, assignmentID); err != nil {
		return fmt.Errorf("postgres: detach runs from assignment %s: %w", assignmentID, err)
	}
	if _, err := tx.Exec(ctx, `DELETE FROM assignments WHERE id = $1::uuid`, assignmentID); err != nil {
		return fmt.Errorf("postgres: api delete assignment %s: %w", assignmentID, err)
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("postgres: commit delete assignment: %w", err)
	}
	return nil
}

// RecordDenied writes the audit row for a refused assignment request.
func (a APIAssignmentStore) RecordDenied(ctx context.Context, c api.Caller, resourceID, action string) error {
	pool, err := a.pool()
	if err != nil {
		return err
	}
	return m4Denied(ctx, pool, c, resourceID, action)
}

// m4AssignmentDelta builds the assignment.updated before{}/after{} snapshots:
// only the members the PATCH moved (§ 3 row 36 — the journal answers "what
// did that PATCH do?" without a diff).
func m4AssignmentDelta(beforeRev, beforeDigest string, beforeMax int,
	beforeBudget map[string]any, beforeEnabled bool,
	afterRev, afterDigest string, afterMax int,
	afterBudget map[string]any, in api.AssignmentPatchInput,
) (map[string]any, map[string]any) {
	before := map[string]any{}
	after := map[string]any{}
	if in.PinnedRevisionID != nil && *in.PinnedRevisionID != beforeRev {
		before["pinned_revision_id"] = beforeRev
		before["revision_digest"] = beforeDigest
		after["pinned_revision_id"] = afterRev
		after["revision_digest"] = afterDigest
	}
	if in.MaxConcurrentRuns != nil && *in.MaxConcurrentRuns != beforeMax {
		before["max_concurrent_runs"] = beforeMax
		after["max_concurrent_runs"] = afterMax
	}
	if in.BudgetOverrides != nil && fmt.Sprint(beforeBudget) != fmt.Sprint(afterBudget) {
		before["budget_overrides"] = beforeBudget
		after["budget_overrides"] = afterBudget
	}
	if in.Enabled != nil && *in.Enabled != beforeEnabled {
		before["enabled"] = beforeEnabled
		after["enabled"] = *in.Enabled
	}
	return before, after
}

// m4BudgetsFromPlan reads the revision's declared ceilings out of its
// compiled plan (plan.budgets + plan.policies) and applies the assignment's
// overrides, refusing any override that RAISES a declared ceiling
// (ErrBudgetOverridesRaise: "an assignment is a governor, not an upgrade
// path"). The result is route 17's effective ceilings.
func m4BudgetsFromPlan(plan []byte, overrides json.RawMessage) (map[string]any, error) {
	declared, err := m4DeclaredCeilings(plan)
	if err != nil {
		return nil, err
	}
	ov, err := m4JSONAsMap(overrides)
	if err != nil {
		return nil, err
	}
	effective := make(map[string]any, len(declared)+len(ov))
	for k, v := range declared {
		effective[k] = v
	}
	for k, want := range ov {
		wantN, numeric := m4AsNumber(want)
		if !numeric {
			return nil, fmt.Errorf("postgres: budget_overrides.%s must be a number: %w",
				k, api.ErrBudgetOverridesRaise)
		}
		if cur, has := declared[k]; has {
			curN, _ := m4AsNumber(cur)
			if wantN > curN {
				return nil, fmt.Errorf("postgres: budget_overrides.%s %v raises the declared ceiling %v: %w",
					k, wantN, curN, api.ErrBudgetOverridesRaise)
			}
		}
		effective[k] = wantN
	}
	return effective, nil
}

// m4EffectiveBudgets is the read-side of the same rule: a stored row whose
// overrides already raise nothing renders the merged ceilings.
func m4EffectiveBudgets(plan []byte, overrides json.RawMessage) (json.RawMessage, error) {
	m, err := m4BudgetsFromPlan(plan, overrides)
	if err != nil {
		// A row already in the database never fails a read over a rule that
		// was checked at write time: fall back to the overrides alone.
		if errors.Is(err, api.ErrBudgetOverridesRaise) {
			return orEmptyJSON(overrides), nil
		}
		return nil, err
	}
	raw, err := json.Marshal(m)
	if err != nil {
		return nil, fmt.Errorf("postgres: encode effective budgets: %w", err)
	}
	return json.RawMessage(raw), nil
}

// m4DeclaredCeilings flattens the ceilings an assignment may govern: the
// engine's cap table (compiler.DefaultBudgets — the same numbers a plan is
// checked against when it carries none of its own) overlaid by the revision
// plan's budgets and numeric policy members.
func m4DeclaredCeilings(plan []byte) (map[string]any, error) {
	out := map[string]any{}
	raw, err := json.Marshal(compiler.DefaultBudgets())
	if err != nil {
		return nil, fmt.Errorf("postgres: encode engine ceilings: %w", err)
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, fmt.Errorf("postgres: decode engine ceilings: %w", err)
	}
	if len(plan) == 0 {
		return out, nil
	}
	var doc struct {
		Budgets  map[string]any `json:"budgets"`
		Policies map[string]any `json:"policies"`
	}
	if err := json.Unmarshal(plan, &doc); err != nil {
		return nil, fmt.Errorf("postgres: read plan ceilings: %w", err)
	}
	for k, v := range doc.Budgets {
		if n, ok := m4AsNumber(v); ok {
			out[k] = n
		}
	}
	for k, v := range doc.Policies {
		if n, ok := m4AsNumber(v); ok {
			out[k] = n
		}
	}
	return out, nil
}

func m4JSONAsMap(raw json.RawMessage) (map[string]any, error) {
	if len(raw) == 0 {
		return map[string]any{}, nil
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		return nil, fmt.Errorf("postgres: expected a JSON object of ceilings: %w", err)
	}
	if m == nil {
		m = map[string]any{}
	}
	return m, nil
}

func m4AsNumber(v any) (float64, bool) {
	switch n := v.(type) {
	case float64:
		return n, true
	case int:
		return float64(n), true
	case int64:
		return float64(n), true
	case json.Number:
		f, err := n.Float64()
		return f, err == nil
	}
	return 0, false
}

// ------------------------------------------------------------------- gates

// m4ApprovalColumns is one gate row in api.ApprovalView order, with the
// instance key of the node that opened it (the gate table carries only the
// node_execution id) and the caller's role. Params: $1 user, $2 org,
// $3 isOrgAdmin.
const m4ApprovalColumns = `
	x.id, x.project_id, x.run_id, x.node_execution_id, n.node_instance_key,
	x.kind, x.summary, x.artifact_refs, x.approver_roles,
	array_to_string(x.approver_user_ids, ',')::text,
	x.deadline_at, x.on_timeout, x.re_requested, x.state, x.decision, x.comments,
	x.decided_by, x.decided_at, x.version, x.created_at,
	COALESCE(m.role, CASE WHEN $3::boolean THEN 'maintainer' ELSE '' END),
	r.status, r.organization_id::text`

const m4ApprovalScope = `
	FROM approval_requests x
	JOIN projects p ON p.id = x.project_id
	JOIN runs r ON r.id = x.run_id
	JOIN node_executions n ON n.id = x.node_execution_id
	LEFT JOIN memberships m ON m.project_id = p.id AND m.user_id = $1::uuid
	WHERE p.organization_id = $2::uuid
	  AND ($3::boolean OR m.user_id IS NOT NULL)`

// APIApprovalStore exposes the durable gate ledger as api.ApprovalStore
// (routes 34–36). The reads enforce visibility in SQL; the decision is
// delegated to the committed RuntimeStore.Decide CAS — one transaction, one
// winner — so this adapter never writes a gate row itself.
type APIApprovalStore struct {
	// R is the runtime adapter whose Decide applies § 5.3's CAS (and, with
	// it, the advancer pass that lets the run leave waiting_human).
	R *RuntimeStore
}

func (a APIApprovalStore) pool() (*pgxpool.Pool, error) {
	if a.R == nil {
		return nil, errors.New("postgres: APIApprovalStore has no runtime store")
	}
	return m4Pool(a.R.Pool, "APIApprovalStore")
}

func m4ScanApproval(row pgx.Row) (api.ApprovalView, error) {
	var (
		v                  api.ApprovalView
		refs               []byte
		roles              []string
		userIDs            string
		decision, comments *string
		decidedBy          *string
		decidedAt          *time.Time
	)
	var runStatus, orgID string
	if err := row.Scan(&v.ID, &v.ProjectID, &v.RunID, &v.NodeExecutionID, &v.NodeInstanceKey,
		&v.Kind, &v.Summary, &refs, &roles, &userIDs,
		&v.DeadlineAt, &v.OnTimeout, &v.ReRequested, &v.State, &decision, &comments,
		&decidedBy, &decidedAt, &v.Version, &v.CreatedAt, &v.MyRole,
		&runStatus, &orgID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return api.ApprovalView{}, api.ErrApprovalNotFound
		}
		return api.ApprovalView{}, fmt.Errorf("postgres: scan api approval: %w", err)
	}
	v.ArtifactRefs = m4OrEmptyJSONArray(refs)
	v.ApproverRoles = roles
	if roles == nil {
		v.ApproverRoles = []string{}
	}
	v.ApproverUserIDs = m4SplitIDs(userIDs)
	v.Decision = decision
	v.Comments = comments
	v.DecidedBy = decidedBy
	v.DecidedAt = decidedAt
	return v, nil
}

// m4SplitIDs reads the uuid[] column flattened to text by the projection
// (array_to_string keeps a text[] scan honest across driver versions that
// disagree on uuid element OIDs).
func m4SplitIDs(s string) []string {
	out := []string{}
	start := 0
	for i := 0; i <= len(s); i++ {
		if i == len(s) || s[i] == ',' {
			if i > start {
				out = append(out, s[start:i])
			}
			start = i + 1
		}
	}
	return out
}

// ListProjectApprovals is route 34's "needs attention" order: pending gates
// first by deadline (the urgent one is the one about to expire), then
// decided history newest first.
func (a APIApprovalStore) ListProjectApprovals(ctx context.Context, c api.Caller, projectID string) ([]api.ApprovalView, error) {
	pool, err := a.pool()
	if err != nil {
		return nil, err
	}
	cc := callerFromAPI(c)
	if err := prjRequireCaller(cc); err != nil {
		return nil, err
	}
	rows, err := pool.Query(ctx, `
		SELECT `+m4ApprovalColumns+`
		`+m4ApprovalScope+`
		  AND x.project_id = $4::uuid
		ORDER BY CASE WHEN x.state = 'pending' THEN 0 ELSE 1 END,
		         CASE WHEN x.state = 'pending' THEN x.deadline_at END ASC NULLS FIRST,
		         x.created_at DESC, x.id DESC`,
		cc.UserID, cc.OrganizationID, cc.IsOrgAdmin, projectID)
	if err != nil {
		return nil, fmt.Errorf("postgres: api list approvals: %w", err)
	}
	defer rows.Close()
	out := []api.ApprovalView{}
	for rows.Next() {
		v, err := m4ScanApproval(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

func (a APIApprovalStore) GetApproval(ctx context.Context, c api.Caller, approvalID string) (api.ApprovalView, error) {
	pool, err := a.pool()
	if err != nil {
		return api.ApprovalView{}, err
	}
	cc := callerFromAPI(c)
	if err := prjRequireCaller(cc); err != nil {
		return api.ApprovalView{}, err
	}
	return m4ScanApproval(pool.QueryRow(ctx, `
		SELECT `+m4ApprovalColumns+`
		`+m4ApprovalScope+`
		  AND x.id = $4::uuid`,
		cc.UserID, cc.OrganizationID, cc.IsOrgAdmin, approvalID))
}

// m4RunTerminal is § 3 row 29's run_terminal arm: a gate whose run has
// finished is not decidable, and the answer names that reason rather than
// pretending the gate is still live.
func m4RunTerminal(status string) bool {
	switch status {
	case "completed", "failed", "cancelled":
		return true
	}
	return false
}

// DecideApproval is route 36: the decision-time authorization read, then ONE
// CAS through RuntimeStore.Decide. Exactly one caller wins (12 C9d); the
// loser gets approval_already_decided carrying the winner's
// state/decision/decider/version, never a silent overwrite. A refusal
// (lost access / not a designated approver / run terminal) is journaled as
// approval.denied and leaves the gate pending at its old version.
func (a APIApprovalStore) DecideApproval(ctx context.Context, c api.Caller, approvalID, decision, comments string,
	version int, authorize api.ApproverAuthorize) (api.ApprovalView, error) {
	pool, err := a.pool()
	if err != nil {
		return api.ApprovalView{}, err
	}
	cc := callerFromAPI(c)
	if err := prjRequireCaller(cc); err != nil {
		return api.ApprovalView{}, err
	}
	current, err := a.GetApproval(ctx, c, approvalID)
	if err != nil {
		return api.ApprovalView{}, err
	}

	var runStatus string
	if err := pool.QueryRow(ctx, `SELECT status FROM runs WHERE id = $1::uuid`, current.RunID).
		Scan(&runStatus); err != nil {
		return api.ApprovalView{}, fmt.Errorf("postgres: read gate run state: %w", err)
	}
	if m4RunTerminal(runStatus) {
		if err := a.journalDenied(ctx, pool, cc, current, api.ApprovalDeniedRunTerminal); err != nil {
			return api.ApprovalView{}, err
		}
		return current, &api.ApprovalConflictError{
			Kind: api.ApprovalDeniedRunTerminal, ApprovalID: current.ID,
			State: current.State, Decision: derefStr(current.Decision),
			DecidedBy: derefStr(current.DecidedBy), Version: current.Version,
			Detail: "the run this gate belongs to is already " + runStatus + ".",
		}
	}

	// A gate that is already decided answers the CAS arm WITHOUT touching
	// the journal: RuntimeStore.Decide's § 5.3 arms append nothing for a CAS
	// miss, and a second denial row for a decided gate would be a lie about
	// a second attempt changing anything.
	if current.State != "pending" {
		return current, &api.ApprovalConflictError{
			Kind: api.ApprovalDeniedAlreadyDecided, ApprovalID: current.ID,
			State: current.State, Decision: derefStr(current.Decision),
			DecidedBy: derefStr(current.DecidedBy), Version: current.Version,
			Detail: "this gate was decided already.",
		}
	}

	inner := func(ap *runtime.Approval, decider string) (bool, string) {
		if authorize == nil {
			return true, ""
		}
		view, err := a.GetApproval(ctx, c, approvalID)
		if err != nil {
			// No gate, no grant: fail closed with the lost-access arm (the
			// handler's currentRole read has the same shape).
			return false, api.ApprovalDeniedLostAccess
		}
		return authorize(view, decider)
	}
	if err := a.R.Decide(ctx, current.RunID, approvalID, decision, comments, cc.UserID, version, inner); err != nil {
		var conflict runtime.ErrApprovalConflict
		if errors.As(err, &conflict) {
			kind := conflict.Reason
			switch kind {
			case "stale_version":
				kind = api.ApprovalDeniedAlreadyDecided
			case "":
				kind = api.ApprovalDeniedAlreadyDecided
			}
			latest, lerr := a.GetApproval(ctx, c, approvalID)
			if lerr != nil {
				return api.ApprovalView{}, lerr
			}
			return latest, &api.ApprovalConflictError{
				Kind: kind, ApprovalID: approvalID,
				State: latest.State, Decision: derefStr(latest.Decision),
				DecidedBy: derefStr(latest.DecidedBy), Version: latest.Version,
				Detail: conflict.Error(),
			}
		}
		return api.ApprovalView{}, fmt.Errorf("postgres: decide approval %s: %w", approvalID, err)
	}
	return a.GetApproval(ctx, c, approvalID)
}

// journalDenied appends one approval.denied row (§ 3 row 29) for a refusal
// the runtime's Decide never reached. A refusal is not a decision — the gate
// keeps its state and version — but the attempt is auditable.
func (a APIApprovalStore) journalDenied(ctx context.Context, pool *pgxpool.Pool, cc Caller,
	ap api.ApprovalView, reason string) error {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("postgres: begin approval denial: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var orgID string
	if err := tx.QueryRow(ctx, `
		SELECT organization_id::text FROM runs WHERE id = $1::uuid`, ap.RunID).Scan(&orgID); err != nil {
		return fmt.Errorf("postgres: resolve gate org: %w", err)
	}
	if err := m4AppendAppendable(ctx, tx, events.TypeApprovalDenied, orgID, ap.ProjectID, cc.UserID,
		events.ApprovalDeniedPayload{
			ProjectID: ap.ProjectID, RunID: ap.RunID, ApprovalID: ap.ID, Reason: reason,
		}); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("postgres: commit approval denial: %w", err)
	}
	return nil
}

// RecordDenied writes the audit row for a refused gate request.
func (a APIApprovalStore) RecordDenied(ctx context.Context, c api.Caller, approvalID, action string) error {
	pool, err := a.pool()
	if err != nil {
		return err
	}
	return m4Denied(ctx, pool, c, approvalID, action)
}

// m4OrEmptyJSONArray keeps a jsonb array column non-null in the view (the
// Approval schema always carries artifact_refs, even when empty).
func m4OrEmptyJSONArray(b []byte) json.RawMessage {
	if len(b) == 0 || string(b) == "null" {
		return json.RawMessage("[]")
	}
	return json.RawMessage(b)
}
