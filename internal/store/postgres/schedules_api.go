package postgres

// The schedule API adapter (ADR-0032 part 2): the three routes' store side,
// in the house shape — the permission predicate is part of the SQL, and a
// row outside the caller's view answers api's not-found sentinel, the same
// bytes a nonsense uuid produces.
//
// The adapter deliberately does NOT re-implement the schedule rules (cron
// parse, fireability, clock derivation, optimistic version): those are
// ScheduleStore's, already tested against real Postgres. What is added here
// is the caller: a visibility check folded into every read, and a
// maintainership check folded into the write, so a handler that forgot its
// role gate still cannot move a row it may not see.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/dbirks/communication/internal/api"
)

var _ api.ScheduleStore = APIScheduleStore{}

// APIScheduleStore exposes schedules as api.ScheduleStore. It rides the
// committed *ScheduleStore's pool and statements; S.Create/S.UpdateSchedule
// own the row's semantics, this file owns the caller.
type APIScheduleStore struct {
	S *ScheduleStore
}

func (a APIScheduleStore) store() (*ScheduleStore, error) {
	if a.S == nil {
		return nil, errors.New("postgres: APIScheduleStore has no store")
	}
	if _, err := m4Pool(a.S.Pool, "APIScheduleStore"); err != nil {
		return nil, err
	}
	return a.S, nil
}

// apiScheduleColumns is scheduleColumns qualified for the scoped join below
// (x = schedules), plus the caller's role on the owning project — the same
// COALESCE the assignment surface uses, so an org admin reads "maintainer"
// without a membership row and the handler's PATCH gate has one source.
const apiScheduleColumns = `x.id::text, x.project_id::text, x.assignment_id::text, x.cron_expr,
	x.inputs::text, x.enabled, x.next_run_at, x.last_run_at, COALESCE(x.last_run_id::text, ''),
	x.version, x.created_by::text, x.created_at, x.updated_at,
	COALESCE(m.role, CASE WHEN $3::boolean THEN 'maintainer' ELSE '' END)`

// apiScheduleScope is the FROM/WHERE visibility half: the caller's
// organization, and either admin or a membership. Every schedule query here
// splices it and adds its own id/project predicate LAST (parameter numbering
// in the fragments above assumes $1 user, $2 org, $3 admin).
const apiScheduleScope = `
	FROM schedules x
	JOIN projects p ON p.id = x.project_id
	LEFT JOIN memberships m ON m.project_id = p.id AND m.user_id = $1::uuid
	WHERE p.organization_id = $2::uuid
	  AND ($3::boolean OR m.user_id IS NOT NULL)`

func (a APIScheduleStore) scan(row pgx.Row) (api.ScheduleView, error) {
	var (
		v            api.ScheduleView
		inputs       string
		lastRunID    string
		lastRunAt    *time.Time
		assignmentID string
	)
	err := row.Scan(&v.ID, &v.ProjectID, &assignmentID, &v.CronExpr, &inputs, &v.Enabled,
		&v.NextRunAt, &lastRunAt, &lastRunID, &v.Version, &v.CreatedBy, &v.CreatedAt, &v.UpdatedAt,
		&v.MyRole)
	if errors.Is(err, pgx.ErrNoRows) {
		return api.ScheduleView{}, api.ErrScheduleNotFound
	}
	if err != nil {
		return api.ScheduleView{}, fmt.Errorf("postgres: scan api schedule: %w", err)
	}
	v.AssignmentID = assignmentID
	v.Inputs = json.RawMessage(inputs)
	if lastRunAt != nil && !lastRunAt.IsZero() {
		t := lastRunAt.UTC()
		v.LastRunAt = &t
	}
	if lastRunID != "" {
		id := lastRunID
		v.LastRunID = &id
	}
	return v, nil
}

// ListProjectSchedules is the project list, oldest first (the UI's grouping
// order). An invisible project yields the empty slice — the handler has
// already gated the read; this predicate is what keeps a mistyped projectID
// from answering another tenant's rows.
func (a APIScheduleStore) ListProjectSchedules(ctx context.Context, c api.Caller, projectID string) ([]api.ScheduleView, error) {
	s, err := a.store()
	if err != nil {
		return nil, err
	}
	cc := callerFromAPI(c)
	if err := prjRequireCaller(cc); err != nil {
		return nil, err
	}
	rows, err := s.Pool.Query(ctx, `SELECT `+apiScheduleColumns+apiScheduleScope+`
		  AND x.project_id = $4::uuid
		ORDER BY x.created_at, x.id`,
		cc.UserID, cc.OrganizationID, cc.IsOrgAdmin, projectID)
	if err != nil {
		return nil, fmt.Errorf("postgres: api list schedules: %w", err)
	}
	defer rows.Close()
	out := []api.ScheduleView{}
	for rows.Next() {
		v, err := a.scan(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

// GetSchedule is the PATCH route's read: caller-scoped, and it carries
// MyRole so the handler can apply the maintainer gate without a second
// round trip (assignment PATCH's shape).
func (a APIScheduleStore) GetSchedule(ctx context.Context, c api.Caller, scheduleID string) (api.ScheduleView, error) {
	s, err := a.store()
	if err != nil {
		return api.ScheduleView{}, err
	}
	cc := callerFromAPI(c)
	if err := prjRequireCaller(cc); err != nil {
		return api.ScheduleView{}, err
	}
	return a.scan(s.Pool.QueryRow(ctx, `SELECT `+apiScheduleColumns+apiScheduleScope+`
		  AND x.id = $4::uuid`,
		cc.UserID, cc.OrganizationID, cc.IsOrgAdmin, scheduleID))
}

// CreateSchedule is the project POST. The row's semantics — cron parse,
// fireability, input validation against the pinned revision, first slot —
// are ScheduleStore.Create's, unchanged; this method adds only the caller's
// right to touch the project at all (the CreateAssignment predicate's shape:
// visible to the caller's org, admin or member) and the created_by stamp.
func (a APIScheduleStore) CreateSchedule(ctx context.Context, c api.Caller, projectID string,
	in api.ScheduleCreateInput) (api.ScheduleView, error) {
	s, err := a.store()
	if err != nil {
		return api.ScheduleView{}, err
	}
	cc := callerFromAPI(c)
	if err := prjRequireCaller(cc); err != nil {
		return api.ScheduleView{}, err
	}
	var ok bool
	err = s.Pool.QueryRow(ctx, `
		SELECT true
		FROM projects p
		LEFT JOIN memberships m ON m.project_id = p.id AND m.user_id = $1::uuid
		WHERE p.id = $2::uuid AND p.organization_id = $3::uuid
		  AND ($4::boolean OR m.user_id IS NOT NULL)`,
		cc.UserID, projectID, cc.OrganizationID, cc.IsOrgAdmin).Scan(&ok)
	if errors.Is(err, pgx.ErrNoRows) {
		return api.ScheduleView{}, api.ErrScheduleNotFound
	}
	if err != nil {
		return api.ScheduleView{}, fmt.Errorf("postgres: api resolve schedule project: %w", err)
	}
	if _, _, err := scheduleCleanInputs(in.Inputs); err != nil {
		return api.ScheduleView{}, schedInputsProblem(err)
	}
	sc, err := s.Create(ctx, NewSchedule{
		ProjectID:    projectID,
		AssignmentID: in.AssignmentID,
		CronExpr:     in.CronExpr,
		Inputs:       in.Inputs,
		Enabled:      in.Enabled,
		CreatedBy:    cc.UserID,
	})
	if err != nil {
		return api.ScheduleView{}, schedAPIErr(err)
	}
	return schedViewOf(sc, ""), nil
}

// UpdateSchedule is the PATCH write. The maintainer gate is SQL here, not
// only in the handler: the scoped read requires role = maintainer (or
// admin), so a row the caller can see but must not edit answers the same
// 404 as nonsense — the handler's 403 is the polite arm of the same fact.
// The optimistic version rides ScheduleUpdate unchanged.
func (a APIScheduleStore) UpdateSchedule(ctx context.Context, c api.Caller, scheduleID string,
	in api.SchedulePatchInput) (api.ScheduleView, error) {
	s, err := a.store()
	if err != nil {
		return api.ScheduleView{}, err
	}
	cc := callerFromAPI(c)
	if err := prjRequireCaller(cc); err != nil {
		return api.ScheduleView{}, err
	}
	var found bool
	err = s.Pool.QueryRow(ctx, `SELECT true`+apiScheduleScope+`
		  AND x.id = $4::uuid AND ($3::boolean OR m.role = 'maintainer')`,
		cc.UserID, cc.OrganizationID, cc.IsOrgAdmin, scheduleID).Scan(&found)
	if errors.Is(err, pgx.ErrNoRows) {
		return api.ScheduleView{}, api.ErrScheduleNotFound
	}
	if err != nil {
		return api.ScheduleView{}, fmt.Errorf("postgres: api check schedule write scope: %w", err)
	}
	if in.Inputs != nil {
		if _, _, err := scheduleCleanInputs(*in.Inputs); err != nil {
			return api.ScheduleView{}, schedInputsProblem(err)
		}
	}
	sc, err := s.UpdateSchedule(ctx, ScheduleUpdate{
		ID:              scheduleID,
		ExpectedVersion: in.Version,
		CronExpr:        in.CronExpr,
		Inputs:          in.Inputs,
		Enabled:         in.Enabled,
	})
	if err != nil {
		return api.ScheduleView{}, schedAPIErr(err)
	}
	return schedViewOf(sc, ""), nil
}

// --- mapping helpers ----------------------------------------------------

// schedAPIErr translates the schedule store's facts into the API's
// sentinels; everything else stays a plain error and answers 500 (never a
// database message to a browser).
func schedAPIErr(err error) error {
	switch {
	case err == nil:
		return nil
	case errors.Is(err, ErrScheduleNotFound):
		return api.ErrScheduleNotFound
	case errors.Is(err, ErrScheduleStaleVersion):
		return api.ErrScheduleStaleVersion
	case errors.Is(err, ErrScheduleNotFireable):
		return api.ErrScheduleNotFireable
	default:
		return err
	}
}

// schedInputsProblem is the malformed-inputs 422: the pinned-revision
// refusal already travels as *api.RunInputsInvalid through Create/Update;
// this covers the shape/name refusals scheduleCleanInputs makes before that.
func schedInputsProblem(err error) error {
	return &api.RunInputsInvalid{
		Detail: "the schedule's inputs are not a legal input map",
		Errors: []api.ValidateError{{Code: "invalid_input", Source: "inputs", Message: err.Error()}},
	}
}

// schedViewOf flattens a Schedule row into the wire shape. role is the
// caller's project role where the read derived one ("" elsewhere: the POST
// and PATCH responses are the row, not the caller's view of it).
func schedViewOf(sc Schedule, role string) api.ScheduleView {
	v := api.ScheduleView{
		ID: sc.ID, ProjectID: sc.ProjectID, AssignmentID: sc.AssignmentID,
		CronExpr: sc.CronExpr, Inputs: sc.Inputs, Enabled: sc.Enabled,
		NextRunAt: sc.NextRunAt, Version: sc.Version, CreatedBy: sc.CreatedBy,
		CreatedAt: sc.CreatedAt, UpdatedAt: sc.UpdatedAt, MyRole: role,
	}
	if !sc.LastRunAt.IsZero() {
		t := sc.LastRunAt
		v.LastRunAt = &t
	}
	if sc.LastRunID != "" {
		id := sc.LastRunID
		v.LastRunID = &id
	}
	return v
}
