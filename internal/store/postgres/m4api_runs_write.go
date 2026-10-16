package postgres

// The WRITE half of the run-family API adapter (docs/m4-contract.md § 2.1
// routes 22/28-31 and § 5.5): CreateRun, PauseRun, ResumeRun, CancelRun,
// RetryRun on APIRunStore (the struct — with its read half — lives in
// m4api_runs_read.go), plus M4Children, the runtime.ChildResolver behind
// pipeline.invoke.
//
// The same two rules as the rest of this file family:
//
//   - The permission predicate is part of the SQL (m4RunAccessSQL mirrors
//     m4api_stream.go's m4RunScopeSQL and adds the caller's role). A run in
//     an invisible project answers api.ErrRunNotFound wrapped over
//     ErrRunNotFound — the same bytes a random uuid produces.
//   - Every mutation writes state + its § 3 journal row in ONE transaction,
//     by handing the event to the committed single-statement methods
//     (RunStore.CreateRun / SetRunStatus / RequestCancel), which append
//     inside their own transaction. RetryRun's journal is owned by the
//     engine (MemStore.Retry appends run.retried inside
//     RuntimeStore.settle's transaction), so this layer never re-writes it.
//
// Nothing here re-implements the engine: Retry is RuntimeStore.Retry, the
// cancel cascade is the advancer's, and a child run pins exactly what its
// resolved revision already carries (§ 5.5: "resolved at run start and
// stored on the invocation, never re-resolved mid-flight").

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/dbirks/communication/internal/api"
	"github.com/dbirks/communication/internal/events"
	"github.com/dbirks/communication/internal/pipelines/runtime"
)

// ------------------------------------------------------------ shared helpers

// m4RunsPool resolves APIRunStore's pool. The nil-store case is a plain
// error (a 500), never a nil-deref inside a handler.
func m4RunsPool(a APIRunStore) (*pgxpool.Pool, error) {
	if a.Runs == nil {
		return nil, errors.New("postgres: APIRunStore has no run store")
	}
	return m4Pool(a.Runs.Pool, "APIRunStore")
}

// m4RunContribute is api.rnCanContribute's rule restated for the store side
// (authz has no contributor predicate of its own).
func m4RunContribute(isOrgAdmin bool, role string) bool {
	if isOrgAdmin {
		return true
	}
	return role == "maintainer" || role == "contributor"
}

// m4LoadRunForWrite loads a run the caller may MUTATE: visibility and role
// first (one predicate-scoped query), then the committed row read.
func m4LoadRunForWrite(ctx context.Context, a APIRunStore, c api.Caller, runID string) (Run, string, error) {
	pool, err := m4RunReadPool(a)
	if err != nil {
		return Run{}, "", err
	}
	if err := prjRequireCaller(callerFromAPI(c)); err != nil {
		return Run{}, "", err
	}
	// The read half's predicate, reused verbatim: the two halves of this
	// adapter must never disagree about what a caller may see.
	_, role, err := m4RunReadScope(ctx, pool, c, runID)
	if err != nil {
		return Run{}, "", err
	}
	if !m4RunContribute(c.IsOrgAdmin, role) {
		return Run{}, "", m4RunReadNotFound()
	}
	r, err := a.Runs.GetRun(ctx, runID)
	if errors.Is(err, ErrRunNotFound) {
		return Run{}, "", m4RunReadNotFound()
	}
	if err != nil {
		return Run{}, "", err
	}
	return r, role, nil
}

// m4RunConflict is route 28-31's typed 409 carrying the run's current status.
func m4RunConflict(kind, detail string, r Run) *api.RunConflictError {
	return &api.RunConflictError{Kind: kind, Detail: detail, RunID: r.ID, RunStatus: r.Status}
}

// m4RunActor picks the journal actor for a human or system action.
func m4RunActor(actorID string) (kind, id string) {
	if actorID == "" {
		return events.ActorKindSystem, "system"
	}
	return events.ActorKindHuman, actorID
}

// m4LiveAttemptIDs names the attempts still holding leases when a run stops
// being scheduled — run.paused's in_flight_attempts (§ 3 row 3). It is a
// read of record, not a lock: the pause write itself is SetRunStatus's
// transaction, and an attempt that finishes in between is reported by its own
// terminal event, not by this payload.
func m4LiveAttemptIDs(ctx context.Context, q prjQuerier, runID string) ([]string, error) {
	rows, err := q.Query(ctx, `
		SELECT id::text FROM attempts
		WHERE run_id = $1::uuid AND status IN ('leased','running') ORDER BY id`, runID)
	if err != nil {
		return nil, fmt.Errorf("postgres: live attempts of run %s: %w", runID, err)
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, fmt.Errorf("postgres: scan live attempt: %w", err)
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

// -------------------------------------------------------------- create (22)

// m4RunPin is the pinned identity one POST /runs resolves to: the assignment
// (or nothing) plus the revision whose digests become the run's.
type m4RunPin struct {
	assignmentID      string
	maxConcurrentRuns int
	budgetOverrides   json.RawMessage
	enabled           bool
	projectID         string
	pipelineID        string
	revisionID        string
	revisionDigest    string
	planDigest        string
	digestScope       string
	plan              json.RawMessage
	revisionStatus    string
}

// CreateRun is route 22: resolve the pin, validate inputs against the pinned
// revision's spec.inputs, enforce assignments.max_concurrent_runs, and write
// the run + its inputs + its idempotency key + run.created in ONE
// transaction through RunStore.CreateRun (which owns that shape). The bool
// is 12 case 1's first-creation-vs-replay answer.
func (a APIRunStore) CreateRun(ctx context.Context, c api.Caller, in api.RunCreateInput) (api.RunView, bool, error) {
	pool, err := m4RunsPool(a)
	if err != nil {
		return api.RunView{}, false, err
	}
	cc := callerFromAPI(c)
	if err := prjRequireCaller(cc); err != nil {
		return api.RunView{}, false, err
	}
	if !prjValidUUID(in.ProjectID) {
		return api.RunView{}, false, fmt.Errorf("%w: %w", api.ErrProjectNotFound, ErrProjectNotFound)
	}
	// Route 22 is project-scoped: a project the caller cannot see is the same
	// 404 nonsense produces, and no row is written for it. The role gate is
	// the handler's (it renders the 403 from the project view); this layer
	// only ever refuses visibility.
	if _, err := m4RunReadProjectScope(ctx, pool, c, in.ProjectID); err != nil {
		return api.RunView{}, false, err
	}

	pin, err := m4ResolvePin(ctx, pool, cc, in)
	if err != nil {
		return api.RunView{}, false, err
	}
	if pin.projectID != in.ProjectID {
		// The assignment lives in another project: the caller may see both
		// objects and still must not be able to start a run "in" the wrong
		// one — the URL's project is the claim being made.
		return api.RunView{}, false, fmt.Errorf("%w: %w (pin lives in %s)",
			api.ErrProjectNotFound, ErrProjectNotFound, pin.projectID)
	}
	if !pin.enabled {
		return api.RunView{}, false, &api.RunConflictError{
			Kind:   api.RunConflictState,
			Detail: "assignment " + pin.assignmentID + " is disabled; re-enable it before starting a run",
		}
	}
	if pin.revisionStatus != "published" {
		return api.RunView{}, false, fmt.Errorf("%w: %w (revision %s is %s)",
			api.ErrPipelineNotFound, ErrPipelineNotFound, pin.revisionID, pin.revisionStatus)
	}

	// § 5.1's concurrency layers, in order: the assignment ceiling is the one
	// this route owns (workers.capacity is the claim SQL's, the run's node
	// ceiling is the advancer's). Counted from rows, never from a memory.
	if pin.assignmentID != "" {
		var live int
		if err := pool.QueryRow(ctx, `
			SELECT count(*) FROM runs
			WHERE assignment_id = $1::uuid
			  AND status IN ('queued','preparing','running','waiting_human','paused')`,
			pin.assignmentID).Scan(&live); err != nil {
			return api.RunView{}, false, fmt.Errorf("postgres: count active runs of assignment %s: %w", pin.assignmentID, err)
		}
		if live >= pin.maxConcurrentRuns {
			return api.RunView{}, false, &api.RunConflictError{
				Kind: api.RunConflictState,
				Detail: fmt.Sprintf("assignment %s has %d active runs and allows %d (max_concurrent_runs)",
					pin.assignmentID, live, pin.maxConcurrentRuns),
			}
		}
	}

	inputs, err := m4ValidateRunInputs(pin.plan, in.Inputs)
	if err != nil {
		return api.RunView{}, false, err
	}

	newRun := NewRun{
		OrganizationID:     c.OrganizationID,
		ProjectID:          pin.projectID,
		PipelineID:         pin.pipelineID,
		PipelineRevisionID: pin.revisionID,
		AssignmentID:       pin.assignmentID,
		RevisionDigest:     pin.revisionDigest,
		PlanDigest:         pin.planDigest,
		PlanSnapshot:       pin.plan,
		PoliciesSnapshot:   m4PoliciesSnapshot(pin.plan, pin.budgetOverrides),
		Depth:              0,
		TriggeredBy:        in.TriggeredBy,
		Inputs:             inputs,
		Key:                in.Key,
		RequestSHA:         in.RequestSHA,
	}
	kind, id := m4RunActor(in.TriggeredBy)
	newRun.Event = &RunEvent{
		Type: events.TypeRunCreated, ActorKind: kind, ActorID: id,
		Payload: events.RunCreatedPayload{
			ProjectID:      pin.projectID,
			RunID:          "", // filled inside the create tx, from the row's own id
			PipelineID:     pin.pipelineID,
			RevisionID:     pin.revisionID,
			RevisionDigest: pin.revisionDigest,
			PlanDigest:     pin.planDigest,
			DigestScope:    pin.digestScope,
			AssignmentID:   pin.assignmentID,
			Depth:          0,
			InputNames:     m4InputNames(inputs),
			Priority:       0,
		},
	}

	run, created, err := a.createRunPinned(ctx, newRun)
	if err != nil {
		if errors.Is(err, ErrIdempotencyMismatch) {
			return api.RunView{}, false, &api.RunConflictError{
				Kind:   api.RunConflictIdempotencyMismatch,
				Detail: "idempotency key was already used with a different request body",
			}
		}
		if m4UniqueViolation(err) {
			// The revision or assignment row vanished under a FK, or two
			// concurrent creates raced the idempotency key: re-read is the
			// caller's job, this is a refusal, never a partial run.
			return api.RunView{}, false, fmt.Errorf("%w: %w (duplicate key)", api.ErrRunNotFound, ErrRunNotFound)
		}
		return api.RunView{}, false, err
	}
	view, err := a.m4RunReadView(ctx, pool, run, "maintainer")
	if err != nil {
		return api.RunView{}, false, err
	}
	return view, created, nil
}

// createRunPinned writes the run, its inputs, its idempotency key and its
// run.created row in ONE transaction. It re-runs RunStore.CreateRun's exact
// statements inside a tx (m4api.go's header rule for API writes that carry an
// event) because run.created's payload names the run it describes
// (RunCreatedPayload.run_id is required) and only the same transaction that
// minted the id can supply it. The run either exists pinned, with every
// input row, the key claiming it and the journal row, or nothing happened.
func (a APIRunStore) createRunPinned(ctx context.Context, in NewRun) (Run, bool, error) {
	ev := in.Event
	in.Event = nil // appended here, once the run id exists

	tx, err := a.Runs.Pool.Begin(ctx)
	if err != nil {
		return Run{}, false, fmt.Errorf("postgres: begin create run tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	run, err := a.Runs.scanRun(tx.QueryRow(ctx, `
		INSERT INTO runs
			(organization_id, project_id, pipeline_id, pipeline_revision_id, assignment_id,
			 revision_digest, plan_digest, plan_snapshot, policies_snapshot, repo_snapshot,
			 depth, parent_run_id, triggered_by, priority)
		VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, NULLIF($5, '')::uuid,
		        $6, $7, $8::jsonb, $9::jsonb, COALESCE(NULLIF($10, '')::jsonb, '[]'::jsonb),
		        $11, NULLIF($12, '')::uuid, NULLIF($13, '')::uuid, $14)
		RETURNING `+runColumns,
		in.OrganizationID, in.ProjectID, in.PipelineID, in.PipelineRevisionID, in.AssignmentID,
		in.RevisionDigest, in.PlanDigest, string(orEmptyJSON(in.PlanSnapshot)),
		string(orEmptyJSON(in.PoliciesSnapshot)), string(in.RepoSnapshot),
		in.Depth, in.ParentRunID, in.TriggeredBy, in.Priority))
	if err != nil {
		return Run{}, false, fmt.Errorf("postgres: insert run for project %s: %w", in.ProjectID, err)
	}

	for name, input := range in.Inputs {
		origin := input.Origin
		if origin == "" {
			origin = "submitted"
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO run_inputs (run_id, name, value, origin)
			VALUES ($1::uuid, $2, $3::jsonb, $4)`,
			run.ID, name, string(orEmptyJSON(input.Value)), origin); err != nil {
			return Run{}, false, fmt.Errorf("postgres: insert input %q for run %s: %w", name, run.ID, err)
		}
	}

	if in.Key != "" {
		var newRunID string
		err := tx.QueryRow(ctx, `
			INSERT INTO run_idempotency_keys (project_id, key, run_id, request_sha256)
			VALUES ($1::uuid, $2, $3::uuid, $4)
			ON CONFLICT (project_id, key) DO NOTHING
			RETURNING run_id::text`,
			in.ProjectID, in.Key, run.ID, in.RequestSHA).Scan(&newRunID)
		if errors.Is(err, pgx.ErrNoRows) {
			// The key was taken before: the winner's run is the answer (never
			// the loser's), unless the body disagrees (12 case 1's 409 arm).
			var winner, sha string
			if err := tx.QueryRow(ctx, `
				SELECT run_id::text, request_sha256 FROM run_idempotency_keys
				WHERE project_id = $1::uuid AND key = $2`, in.ProjectID, in.Key).
				Scan(&winner, &sha); err != nil {
				return Run{}, false, fmt.Errorf("postgres: read idempotency key: %w", err)
			}
			if sha != in.RequestSHA {
				return Run{}, false, ErrIdempotencyMismatch
			}
			stored, err := a.Runs.scanRun(tx.QueryRow(ctx, `
				SELECT `+runColumns+` FROM runs WHERE id = $1::uuid`, winner))
			if err != nil {
				return Run{}, false, fmt.Errorf("postgres: read idempotent run %s: %w", winner, err)
			}
			// A replay touches no row — including no journal row: the loser's
			// insert above is discarded with this rollback.
			return stored, false, nil
		}
		if err != nil {
			return Run{}, false, fmt.Errorf("postgres: claim idempotency key %q: %w", in.Key, err)
		}
	}

	if ev != nil {
		if p, ok := ev.Payload.(events.RunCreatedPayload); ok {
			p.RunID = run.ID
			p.ProjectID = run.ProjectID
			p.PipelineID = run.PipelineID
			p.RevisionID = run.PipelineRevisionID
			p.RevisionDigest = run.RevisionDigest
			p.PlanDigest = run.PlanDigest
			p.AssignmentID = run.AssignmentID
			p.Depth = run.Depth
			p.ParentRunID = run.ParentRunID
			p.Priority = run.Priority
			ev.Payload = p
		}
		if _, err := runAppendTx(ctx, tx, run.ID, "", "", *ev); err != nil {
			return Run{}, false, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return Run{}, false, fmt.Errorf("postgres: commit create run: %w", err)
	}
	return run, true, nil
}

// m4ResolvePin reads the assignment's pin, or the directly named revision,
// under the caller's visibility. The assignment path carries the project and
// the ceilings; the direct path has neither (a direct start is an
// assignment-less run, so the ceiling layer does not apply).
func m4ResolvePin(ctx context.Context, pool *pgxpool.Pool, c Caller, in api.RunCreateInput) (m4RunPin, error) {
	if in.AssignmentID != "" && in.PipelineRevisionID != "" {
		return m4RunPin{}, fmt.Errorf("%w: name an assignment_id or a pipeline_revision_id, never both",
			ErrRunNotFound)
	}
	if in.AssignmentID != "" {
		if !prjValidUUID(in.AssignmentID) {
			return m4RunPin{}, fmt.Errorf("%w: %w", api.ErrAssignmentNotFound, ErrPipelineNotFound)
		}
		var pin m4RunPin
		var overrides []byte
		err := pool.QueryRow(ctx, `
			SELECT a.id::text, a.project_id::text, a.pipeline_id::text, a.pinned_revision_id::text,
			       a.max_concurrent_runs, a.enabled, a.budget_overrides::text,
			       r.revision_digest, r.plan_digest, r.digest_scope, r.compiled_plan::text, r.status
			FROM assignments a
			JOIN projects p ON p.id = a.project_id
			LEFT JOIN memberships m ON m.project_id = p.id AND m.user_id = $1::uuid
			JOIN pipeline_revisions r ON r.id = a.pinned_revision_id
			WHERE a.id = $4::uuid
			  AND p.organization_id = $2::uuid
			  AND ($3::boolean OR m.user_id IS NOT NULL)`,
			c.UserID, c.OrganizationID, c.IsOrgAdmin, in.AssignmentID).
			Scan(&pin.assignmentID, &pin.projectID, &pin.pipelineID, &pin.revisionID,
				&pin.maxConcurrentRuns, &pin.enabled, &overrides,
				&pin.revisionDigest, &pin.planDigest, &pin.digestScope, &pin.plan, &pin.revisionStatus)
		if errors.Is(err, pgx.ErrNoRows) {
			return m4RunPin{}, fmt.Errorf("%w: %w", api.ErrAssignmentNotFound, ErrPipelineNotFound)
		}
		if err != nil {
			return m4RunPin{}, fmt.Errorf("postgres: resolve assignment pin %s: %w", in.AssignmentID, err)
		}
		pin.budgetOverrides = json.RawMessage(overrides)
		return pin, nil
	}
	if !prjValidUUID(in.PipelineRevisionID) {
		return m4RunPin{}, fmt.Errorf("%w: %w", api.ErrPipelineNotFound, ErrPipelineNotFound)
	}
	var pin m4RunPin
	err := pool.QueryRow(ctx, `
		SELECT r.pipeline_id::text, r.id::text, r.revision_digest, r.plan_digest,
		       r.digest_scope, r.compiled_plan::text, r.status, r.organization_id::text
		FROM pipeline_revisions r
		JOIN pipelines pl ON pl.id = r.pipeline_id
		WHERE r.id = $2::uuid AND r.organization_id = $1::uuid AND pl.organization_id = $1::uuid`,
		c.OrganizationID, in.PipelineRevisionID).
		Scan(&pin.pipelineID, &pin.revisionID, &pin.revisionDigest, &pin.planDigest,
			&pin.digestScope, &pin.plan, &pin.revisionStatus, new(string))
	if errors.Is(err, pgx.ErrNoRows) {
		return m4RunPin{}, fmt.Errorf("%w: %w", api.ErrPipelineNotFound, ErrPipelineNotFound)
	}
	if err != nil {
		return m4RunPin{}, fmt.Errorf("postgres: resolve revision pin %s: %w", in.PipelineRevisionID, err)
	}
	pin.projectID = in.ProjectID
	pin.maxConcurrentRuns = 0 // no assignment ⇒ no per-assignment ceiling (§ 5.1)
	pin.enabled = true
	return pin, nil
}

// m4PoliciesSnapshot is the run's copy of the ceilings it will actually be
// held to: the pinned plan's policies and budget record, with the
// assignment's overrides layered on top. Overrides may only LOWER (route 18
// refuses a raise at assignment time, ErrBudgetOverridesRaise), so applying
// them is a min, never a replace — and the plan keeps the record of what was
// declared, which is what the UI's "the assignment lowered this" needs.
func m4PoliciesSnapshot(plan json.RawMessage, overrides json.RawMessage) json.RawMessage {
	out := map[string]any{}
	var p struct {
		Policies map[string]any `json:"policies"`
		Budgets  map[string]any `json:"budgets"`
	}
	if len(plan) > 0 {
		_ = json.Unmarshal(plan, &p)
	}
	for k, v := range p.Policies {
		out[k] = v
	}
	if len(p.Budgets) > 0 {
		out["budgets"] = p.Budgets
	}
	var over map[string]any
	if len(overrides) > 0 {
		_ = json.Unmarshal(overrides, &over)
	}
	for k, v := range over {
		if cur, ok := out[k]; ok && m4Lower(k, cur, v) {
			out[k] = v
		}
	}
	b, err := json.Marshal(out)
	if err != nil {
		return json.RawMessage(`{}`)
	}
	return b
}

// m4Lower reports whether override v actually lowers ceiling cur. Only
// numbers are comparable ceilings; a non-numeric policy is left alone rather
// than guessed at.
func m4Lower(_ string, cur, v any) bool {
	cf, cok := toNumber(cur)
	vf, vok := toNumber(v)
	return cok && vok && vf < cf
}

func toNumber(v any) (float64, bool) {
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

// m4ValidateRunInputs checks the submitted inputs against the pinned plan's
// spec.inputs (a JSON Schema object, § 9.1 route 22) and produces the store
// rows: every declared input the run will actually see, with its origin. An
// absent optional takes its schema default (origin "default"); a missing
// required or an undeclared name is the 422 in § 2.2's unit shape.
func m4ValidateRunInputs(plan json.RawMessage, submitted map[string]json.RawMessage) (map[string]RunInput, error) {
	var p struct {
		Inputs struct {
			Properties           map[string]json.RawMessage `json:"properties"`
			Required             []string                   `json:"required"`
			AdditionalProperties *bool                      `json:"additionalProperties"`
		} `json:"inputs"`
	}
	if len(plan) > 0 {
		_ = json.Unmarshal(plan, &p)
	}
	required := map[string]bool{}
	for _, name := range p.Inputs.Required {
		required[name] = true
	}
	open := p.Inputs.AdditionalProperties == nil || *p.Inputs.AdditionalProperties

	var bad []api.ValidateError
	out := map[string]RunInput{}
	for name, raw := range submitted {
		decl, known := p.Inputs.Properties[name]
		if !known {
			if !open || len(p.Inputs.Properties) == 0 {
				bad = append(bad, api.ValidateError{
					Code: "unknown_input", Source: "run",
					Message: fmt.Sprintf("input %q is not declared by the pinned revision", name),
				})
				continue
			}
			out[name] = RunInput{Value: raw, Origin: "submitted"}
			continue
		}
		if msg := m4JSONTypeMismatch(decl, raw); msg != "" {
			bad = append(bad, api.ValidateError{
				Code: "invalid_input", Source: "run",
				Message: fmt.Sprintf("input %q: %s", name, msg),
			})
			continue
		}
		out[name] = RunInput{Value: raw, Origin: "submitted"}
	}
	for name, decl := range p.Inputs.Properties {
		if _, sent := out[name]; sent {
			continue
		}
		var d struct {
			Default json.RawMessage `json:"default"`
		}
		_ = json.Unmarshal(decl, &d)
		if len(d.Default) > 0 {
			out[name] = RunInput{Value: d.Default, Origin: "default"}
			continue
		}
		if required[name] {
			bad = append(bad, api.ValidateError{
				Code: "missing_input", Source: "run",
				Message: fmt.Sprintf("input %q is required by the pinned revision and was not submitted", name),
			})
		}
	}
	if len(bad) > 0 {
		sort.Slice(bad, func(i, j int) bool { return bad[i].Message < bad[j].Message })
		return nil, &api.RunInputsInvalid{
			Detail: fmt.Sprintf("%d input(s) failed validation against the pinned revision", len(bad)),
			Errors: bad,
		}
	}
	return out, nil
}

// m4JSONTypeMismatch is the honest subset of JSON Schema type checking M4
// needs at run-creation time: the declared primitive types, checked against
// the submitted JSON value. Anything schema-shaped beyond that was the
// publish-time validator's job (ADR-0021), and re-running a whole validator
// here would disagree with it. "" means "no objection".
func m4JSONTypeMismatch(decl, value json.RawMessage) string {
	var s struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(decl, &s); err != nil || s.Type == "" {
		return ""
	}
	var probe any
	if err := json.Unmarshal(value, &probe); err != nil {
		return "value is not valid JSON"
	}
	switch s.Type {
	case "string":
		if _, ok := probe.(string); !ok {
			return "expected a string"
		}
	case "number":
		if _, ok := probe.(float64); !ok {
			return "expected a number"
		}
	case "integer":
		f, ok := probe.(float64)
		if !ok {
			return "expected an integer"
		}
		if f != float64(int64(f)) {
			return "expected an integer"
		}
	case "boolean":
		if _, ok := probe.(bool); !ok {
			return "expected a boolean"
		}
	case "object":
		if _, ok := probe.(map[string]any); !ok {
			return "expected an object"
		}
	case "array":
		if _, ok := probe.([]any); !ok {
			return "expected an array"
		}
	case "null":
		if probe != nil {
			return "expected null"
		}
	}
	return ""
}

func m4InputNames(inputs map[string]RunInput) []string {
	out := make([]string, 0, len(inputs))
	for name := range inputs {
		out = append(out, name)
	}
	sort.Strings(out)
	return out
}

// ------------------------------------------------------ pause / resume (28/29)

// PauseRun is route 28: status=paused, paused_reason=manual, and FUTURE
// scheduling only stops — live attempts keep their leases and report their
// real outcomes (§ 5.3), which is why run.paused names them. waiting_human,
// an already-paused run and a terminal run refuse with run_state_conflict.
func (a APIRunStore) PauseRun(ctx context.Context, c api.Caller, runID string) (api.RunView, error) {
	r, role, err := m4LoadRunForWrite(ctx, a, c, runID)
	if err != nil {
		return api.RunView{}, err
	}
	switch {
	case runTerminalStatuses[r.Status]:
		return api.RunView{}, m4RunConflict(api.RunConflictState, "a "+r.Status+" run cannot be paused", r)
	case r.Status == "waiting_human":
		return api.RunView{}, m4RunConflict(api.RunConflictState,
			"the run waits on a gate; decide the approval or cancel the run instead of pausing it", r)
	case r.Status == "paused":
		return api.RunView{}, m4RunConflict(api.RunConflictState, "the run is already paused", r)
	}

	pool := a.Runs.Pool
	inFlight, err := m4LiveAttemptIDs(ctx, pool, r.ID)
	if err != nil {
		return api.RunView{}, err
	}

	kind, id := m4RunActor(c.UserID)
	updated, err := a.Runs.SetRunStatus(ctx, r.ID, RunStatusInput{
		Status: "paused", PausedReason: "manual",
		Event: &RunEvent{
			Type: events.TypeRunPaused, ActorKind: kind, ActorID: id,
			Payload: events.RunPausedPayload{
				ProjectID: r.ProjectID, RunID: r.ID, PausedReason: "manual",
				InFlightAttempts: inFlight, RequestedBy: c.UserID,
			},
		},
	})
	if err != nil {
		if errors.Is(err, ErrRunNotTransitionable) {
			return api.RunView{}, m4RunConflict(api.RunConflictState,
				"the run moved under this pause request: "+r.Status+" → paused is not a legal edge", r)
		}
		return api.RunView{}, err
	}
	return a.m4RunReadView(ctx, pool, updated, role)
}

// ResumeRun is route 29: paused → queued, clearing whichever reason is
// recorded — human_takeover included (§ 5.3's return-control leg) — and
// run.resumed names the reason it cleared. The advancer re-derives readiness
// from the rows afterwards; this route never touches an in-memory plan.
func (a APIRunStore) ResumeRun(ctx context.Context, c api.Caller, runID string) (api.RunView, error) {
	r, role, err := m4LoadRunForWrite(ctx, a, c, runID)
	if err != nil {
		return api.RunView{}, err
	}
	if r.Status != "paused" {
		return api.RunView{}, m4RunConflict(api.RunConflictState,
			"only a paused run resumes; this one is "+r.Status, r)
	}
	kind, id := m4RunActor(c.UserID)
	clearing := r.PausedReason
	if clearing == "" {
		clearing = "manual"
	}
	// The reason being cleared is known from the locked row, so the payload
	// rides SetRunStatus's own transaction: a resume that journaled after the
	// commit could name a reason it never cleared.
	updated, err := a.Runs.SetRunStatus(ctx, r.ID, RunStatusInput{
		Status: "queued",
		Event: &RunEvent{
			Type: events.TypeRunResumed, ActorKind: kind, ActorID: id,
			Payload: events.RunResumedPayload{
				ProjectID: r.ProjectID, RunID: r.ID, PausedReason: clearing,
			},
		},
	})
	if err != nil {
		if errors.Is(err, ErrRunNotTransitionable) {
			return api.RunView{}, m4RunConflict(api.RunConflictState,
				"the run moved under this resume request", r)
		}
		return api.RunView{}, err
	}
	return a.m4RunReadView(ctx, a.Runs.Pool, updated, role)
}

// --------------------------------------------------------- cancel (30) / retry (31)

// CancelRun is route 30's first half: a REQUEST. cancel_requested_at is the
// flag; the advancer cascades queued/ready rows, marks live attempts
// cancel-requested and recurses into pipeline_invocations children (§ 5.5).
// run.cancel_requested therefore reports cascade:true with the children the
// advancer is about to walk — read from the invocation rows, never guessed —
// and a terminal run refuses.
func (a APIRunStore) CancelRun(ctx context.Context, c api.Caller, runID string) (api.RunView, error) {
	r, role, err := m4LoadRunForWrite(ctx, a, c, runID)
	if err != nil {
		return api.RunView{}, err
	}
	if runTerminalStatuses[r.Status] {
		return api.RunView{}, m4RunConflict(api.RunConflictState,
			"the run is already "+r.Status+", there is nothing left to cancel", r)
	}
	children, err := m4ChildRunIDs(ctx, a.Runs.Pool, r.ID)
	if err != nil {
		return api.RunView{}, err
	}
	kind, id := m4RunActor(c.UserID)
	updated, err := a.Runs.RequestCancel(ctx, r.ID, &RunEvent{
		Type: events.TypeRunCancelRequested, ActorKind: kind, ActorID: id,
		Payload: events.RunCancelRequestedPayload{
			ProjectID: r.ProjectID, RunID: r.ID, Cascade: true,
			Children: children, RequestedBy: c.UserID,
		},
	})
	if err != nil {
		if errors.Is(err, ErrRunNotFound) {
			return api.RunView{}, fmt.Errorf("%w: %w", api.ErrRunNotFound, err)
		}
		return api.RunView{}, err
	}
	return a.m4RunReadView(ctx, a.Runs.Pool, updated, role)
}

// m4ChildRunIDs lists the live children of one run from pipeline_invocations
// (§ 5.5's cascade targets).
func m4ChildRunIDs(ctx context.Context, pool *pgxpool.Pool, runID string) ([]string, error) {
	rows, err := runOn(ctx, pool).Query(ctx, `
		SELECT i.child_run_id::text
		FROM pipeline_invocations i
		JOIN runs cr ON cr.id = i.child_run_id
		WHERE i.run_id = $1::uuid
		  AND cr.status NOT IN ('completed','failed','cancelled','interrupted')
		ORDER BY i.child_run_id`, runID)
	if err != nil {
		return nil, fmt.Errorf("postgres: children of run %s: %w", runID, err)
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, fmt.Errorf("postgres: scan child run id: %w", err)
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

// RetryRun is route 31: the engine does the reopening (RuntimeStore.Retry
// re-queues targets with retry_context, restarts a dead `until` iteration
// rather than the loop, and refuses restore_checkpoint when a repository is
// not committed at the boundary — the whole reopen or none of it, journal
// included). This layer supplies the authorization, the retriability
// verdict, the default target list, and the retry-time inputs as run input
// rows. running and completed runs refuse with run_not_retriable; a
// checkpoint arm that cannot restore refuses with checkpoint_unavailable and
// resets nothing.
func (a APIRunStore) RetryRun(ctx context.Context, c api.Caller, runID string, in api.RunRetryInput) (api.RunView, error) {
	r, role, err := m4LoadRunForWrite(ctx, a, c, runID)
	if err != nil {
		return api.RunView{}, err
	}
	if r.Status == "running" || r.Status == "completed" {
		return api.RunView{}, m4RunConflict(api.RunConflictNotRetriable,
			"a "+r.Status+" run is not retriable; retry a failed, interrupted or cancelled one", r)
	}
	// The refusal above is a fact about the run; the engine is only needed to
	// act on it, so an unwired adapter refuses here, not before.
	if a.Runtime == nil {
		return api.RunView{}, errors.New("postgres: APIRunStore has no runtime store")
	}
	targets := in.NodeInstanceKeys
	if len(targets) == 0 {
		targets, err = m4NonSucceededTerminalKeys(ctx, a.Runs.Pool, r.ID)
		if err != nil {
			return api.RunView{}, err
		}
		if len(targets) == 0 {
			return api.RunView{}, m4RunConflict(api.RunConflictNotRetriable,
				"no failed, interrupted or cancelled node execution to retry", r)
		}
	}

	// Retry-time inputs are RUN inputs (route 31), and they are written
	// before the engine's reopen: a stored input that never made it into
	// run.retried is a cosmetic gap, whereas a run.retried naming inputs that
	// were never stored would be a false record. The event itself is appended
	// inside RuntimeStore.settle's transaction.
	if err := m4RecordRetryInputs(ctx, a.Runs.Pool, r.ID, in.Inputs); err != nil {
		return api.RunView{}, err
	}
	overrides := map[string]any{}
	for name, raw := range in.Inputs {
		var v any
		if err := json.Unmarshal(raw, &v); err != nil {
			return api.RunView{}, fmt.Errorf("postgres: retry input %q: %w", name, err)
		}
		overrides[name] = v
	}
	requestedBy := in.RequestedBy
	if requestedBy == "" {
		requestedBy = c.UserID
	}
	if err := a.Runtime.Retry(ctx, r.ID, requestedBy, targets, overrides); err != nil {
		var missing runtime.ErrCheckpointUnavailable
		if errors.As(err, &missing) {
			return api.RunView{}, m4RunConflict(api.RunConflictCheckpointUnavailable,
				missing.Reason+" (node "+missing.NodeInstanceKey+")", r)
		}
		// A target the run has no row for is the client's mistake, not the
		// engine's: 404 with a stable code, and the reopen has already been
		// refused whole (validate-then-mutate), so nothing moved.
		var unknown runtime.ErrNodeExecutionNotFound
		if errors.As(err, &unknown) {
			return api.RunView{}, &api.NodeExecutionNotFound{NodeInstanceKey: unknown.InstanceKey}
		}
		return api.RunView{}, err
	}
	updated, err := a.Runs.GetRun(ctx, r.ID)
	if err != nil {
		return api.RunView{}, err
	}
	return a.m4RunReadView(ctx, a.Runs.Pool, updated, role)
}

// m4RecordRetryInputs upserts the retry's inputs as run_inputs rows with
// origin 'override' — the third origin the enum admits, and the only one a
// retry produces (route 31: "Retry-time Inputs are recorded as run inputs").
func m4RecordRetryInputs(ctx context.Context, pool *pgxpool.Pool, runID string, inputs map[string]json.RawMessage) error {
	for name, raw := range inputs {
		if _, err := pool.Exec(ctx, `
			INSERT INTO run_inputs (run_id, name, value, origin)
			VALUES ($1::uuid, $2, $3::jsonb, 'override')
			ON CONFLICT (run_id, name)
			DO UPDATE SET value = EXCLUDED.value, origin = 'override'`,
			runID, name, string(raw)); err != nil {
			return fmt.Errorf("postgres: record retry input %q on run %s: %w", name, runID, err)
		}
	}
	return nil
}

// m4NonSucceededTerminalKeys is route 31's default target list: every node
// execution in a terminal-but-not-succeeded state.
func m4NonSucceededTerminalKeys(ctx context.Context, pool *pgxpool.Pool, runID string) ([]string, error) {
	rows, err := pool.Query(ctx, `
		SELECT node_instance_key FROM node_executions
		WHERE run_id = $1::uuid AND status IN ('failed','cancelled','interrupted')
		ORDER BY node_instance_key`, runID)
	if err != nil {
		return nil, fmt.Errorf("postgres: retry targets of run %s: %w", runID, err)
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var key string
		if err := rows.Scan(&key); err != nil {
			return nil, fmt.Errorf("postgres: scan retry target: %w", err)
		}
		out = append(out, key)
	}
	return out, rows.Err()
}

// ------------------------------------------------------------- M4Children

// M4Children is the runtime.ChildResolver behind pipeline.invoke (ADR-0023
// § 10, contract § 5.5). The advancer owns the invocation row, the waiting
// state and the cascade; this owns starting the run AND resolving the target,
// because both are API-transaction acts: the child pins the revision resolved at
// ITS start (assignment pin first, then the newest published revision of the
// target pipeline), lives in the parent's project with depth = parent.depth + 1,
// and answers from an existing booking so a retried advancer pass never spawns a
// second child. The authored target is a pipeline NAME (`pipeline:
// issue-implementation`), so only here — where the organization's pipeline
// library is reachable — does the invocation get a pipeline_id to carry.
type M4Children struct {
	Runs    *RunStore
	Runtime *RuntimeStore
}

var _ runtime.ChildResolver = (*M4Children)(nil)

// CreateChild starts (or replays) the child run of one pipeline.invoke node
// execution. Inside an advancer pass the caller's context carries that pass's
// transaction (see withPassTx), so the child run row and the parent's
// node-execution rows commit together or not at all; a direct caller (an API
// route, a test) gets its own transaction as it always did.
func (ch *M4Children) CreateChild(ctx context.Context, req runtime.ChildRequest) (runtime.ChildOutcome, error) {
	if ch == nil || ch.Runs == nil {
		return runtime.ChildOutcome{}, errors.New("postgres: M4Children has no run store")
	}
	pool := ch.Runs.Pool
	parent, err := ch.Runs.GetRun(ctx, req.ParentRunID)
	if errors.Is(err, ErrRunNotFound) {
		return runtime.ChildOutcome{}, fmt.Errorf("postgres: create child of unknown parent run %s: %w", req.ParentRunID, err)
	}
	if err != nil {
		return runtime.ChildOutcome{}, err
	}
	if req.Depth == 0 {
		req.Depth = parent.Depth + 1
	}
	if req.Depth != parent.Depth+1 {
		return runtime.ChildOutcome{}, fmt.Errorf("postgres: child depth %d disagrees with parent %d + 1", req.Depth, parent.Depth)
	}
	if req.Depth > 2 {
		// runs_depth_check says the same thing in the database; saying it here
		// turns a CHECK failure into a named failure (§ 6's child_depth_exceeded).
		return runtime.ChildOutcome{}, fmt.Errorf("postgres: child_depth_exceeded at depth %d", req.Depth)
	}

	// Idempotence per (parentRunID, nodeExecutionID): the invocation row is the
	// record that a child was ever booked for this node execution, so it
	// answers first. The node execution is named by its LEDGER uuid — inside an
	// advance it is still a minted id (advancer.go's NewID("ne")) and the row it
	// refers to lives in the parent's open transaction — so the lookup hashes it
	// the way the write-back will (rteColID), rather than handing "ne2" to a uuid
	// column and aborting the pass.
	var (
		existing   string
		bookedPipe string
		bookedRev  string
	)
	err = runOn(ctx, pool).QueryRow(ctx, `
		SELECT child_run_id::text, pipeline_id::text, resolved_revision_id::text
		FROM pipeline_invocations
		WHERE run_id = $1::uuid AND node_execution_id = $2::uuid`,
		req.ParentRunID, rteColID(req.ParentRunID, req.NodeExecutionID)).Scan(&existing, &bookedPipe, &bookedRev)
	if err == nil {
		return runtime.ChildOutcome{
			ChildRunID: existing, PipelineID: bookedPipe, ResolvedRevisionID: bookedRev,
		}, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return runtime.ChildOutcome{}, fmt.Errorf("postgres: look up invocation of node execution %s: %w", req.NodeExecutionID, err)
	}

	// The target revision is resolved AT RUN START (§ 5.5): the project's
	// assignment pin when one exists, otherwise the newest published revision
	// of the target pipeline in the parent's organization.
	pin, err := m4ResolveChildRevision(ctx, pool, parent.OrganizationID, parent.ProjectID, req.Target)
	if err != nil {
		return runtime.ChildOutcome{}, err
	}
	inputs, err := m4ChildInputs(pin.plan, req.Inputs)
	if err != nil {
		return runtime.ChildOutcome{}, err
	}
	kind, actor := m4RunActor("")
	created := NewRun{
		OrganizationID:     parent.OrganizationID,
		ProjectID:          parent.ProjectID,
		PipelineID:         pin.pipelineID,
		PipelineRevisionID: pin.revisionID,
		AssignmentID:       pin.assignmentID,
		RevisionDigest:     pin.revisionDigest,
		PlanDigest:         pin.planDigest,
		PlanSnapshot:       pin.plan,
		PoliciesSnapshot:   m4PoliciesSnapshot(pin.plan, pin.budgetOverrides),
		Priority:           req.Priority,
		Depth:              req.Depth,
		ParentRunID:        parent.ID,
		Inputs:             inputs,
		Event: &RunEvent{
			Type: events.TypeRunCreated, ActorKind: kind, ActorID: actor,
			Payload: events.RunCreatedPayload{
				ProjectID: parent.ProjectID, PipelineID: pin.pipelineID,
				RevisionID: pin.revisionID, RevisionDigest: pin.revisionDigest,
				PlanDigest: pin.planDigest, DigestScope: pin.digestScope,
				AssignmentID: pin.assignmentID, Depth: req.Depth,
				ParentRunID: parent.ID, InputNames: m4InputNames(inputs),
				Priority: req.Priority,
			},
		},
	}
	child, _, err := ch.Runs.CreateRun(ctx, created)
	if err != nil {
		return runtime.ChildOutcome{}, fmt.Errorf("postgres: create child run of %s for node execution %s: %w",
			parent.ID, req.NodeExecutionID, err)
	}
	// ONE writer books the pipeline_invocations row: the PARENT's advance
	// transaction (postgres.RuntimeStore.writeRowsTx -> insertInvocationTx).
	// It has to be that one, because the row references the node execution that
	// transaction created and no other transaction can see it yet — a booking
	// made here would fail its foreign key on every first pass. What this owns
	// is the RESOLUTION (§ 5.5: at run start, once), and it reports the ids it
	// resolved so the booking carries them instead of the authored name.
	//
	// The retried-pass guarantee stays intact: a pass that committed is answered
	// by the hydrated invocation row (advancer.go's InvocationFor, so this
	// resolver is never called again), and a caller that arrives with a node
	// execution whose booking is already visible is answered above.
	return runtime.ChildOutcome{
		ChildRunID: child.ID, PipelineID: pin.pipelineID, ResolvedRevisionID: pin.revisionID,
	}, nil
}

// ChildStatus reports a child run's status for the advancer's poll. A child
// that is gone answers with the terminal pair the engine can act on rather
// than an error: a missing row must not hang a waiting parent.
func (ch *M4Children) ChildStatus(ctx context.Context, childRunID string) (string, string, error) {
	if ch == nil || ch.Runs == nil {
		return "", "", errors.New("postgres: M4Children has no run store")
	}
	r, err := ch.Runs.GetRun(ctx, childRunID)
	if errors.Is(err, ErrRunNotFound) {
		return "interrupted", "child_run_missing", nil
	}
	if err != nil {
		return "", "", err
	}
	return r.Status, r.FailedCause, nil
}

// CancelChild requests cancellation of a live child (§ 5.5's cascade). The
// child's own children are listed on ITS run.cancel_requested row, which the
// advancer walks on its next pass; this only flags the row.
func (ch *M4Children) CancelChild(ctx context.Context, childRunID string, reason string) error {
	if ch == nil || ch.Runs == nil {
		return errors.New("postgres: M4Children has no run store")
	}
	r, err := ch.Runs.GetRun(ctx, childRunID)
	if errors.Is(err, ErrRunNotFound) {
		return nil // already gone: the cascade has nothing left to do
	}
	if err != nil {
		return err
	}
	if runTerminalStatuses[r.Status] {
		return nil
	}
	children, err := m4ChildRunIDs(ctx, ch.Runs.Pool, r.ID)
	if err != nil {
		return err
	}
	if _, err := ch.Runs.RequestCancel(ctx, r.ID, &RunEvent{
		Type: events.TypeRunCancelRequested, ActorKind: events.ActorKindSystem, ActorID: "system",
		Payload: events.RunCancelRequestedPayload{
			ProjectID: r.ProjectID, RunID: r.ID, Cascade: true,
			Children: children, RequestedBy: reason,
		},
	}); err != nil {
		return fmt.Errorf("postgres: cancel child run %s: %w", childRunID, err)
	}
	return nil
}

// m4ChildPin is a resolved child target.
type m4ChildPin struct {
	assignmentID    string
	budgetOverrides json.RawMessage
	pipelineID      string
	revisionID      string
	revisionDigest  string
	planDigest      string
	digestScope     string
	plan            json.RawMessage
}

// m4ResolveChildRevision resolves a pipeline.invoke target at run start.
// The target arrives as the author wrote it, so it goes through
// m4ResolveChildTarget first; everything after that is the pin (§ 5.5).
func m4ResolveChildRevision(ctx context.Context, pool *pgxpool.Pool, orgID, projectID, target string) (m4ChildPin, error) {
	pipelineID, err := m4ResolveChildTarget(ctx, pool, orgID, target)
	if err != nil {
		return m4ChildPin{}, err
	}
	var pin m4ChildPin
	var overrides []byte
	err = runOn(ctx, pool).QueryRow(ctx, `
		SELECT a.id::text, a.budget_overrides::text, a.pinned_revision_id::text,
		       r.revision_digest, r.plan_digest, r.digest_scope, r.compiled_plan::text
		FROM assignments a
		JOIN pipeline_revisions r ON r.id = a.pinned_revision_id
		JOIN pipelines pl ON pl.id = a.pipeline_id
		WHERE a.project_id = $3::uuid AND a.pipeline_id = $2::uuid
		  AND pl.organization_id = $1::uuid
		  AND a.enabled AND r.status = 'published'`,
		orgID, pipelineID, projectID).
		Scan(&pin.assignmentID, &overrides, &pin.revisionID,
			&pin.revisionDigest, &pin.planDigest, &pin.digestScope, &pin.plan)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return m4ChildPin{}, fmt.Errorf("postgres: resolve assignment pin of pipeline %s: %w", pipelineID, err)
	}
	if err == nil {
		pin.pipelineID = pipelineID
		pin.budgetOverrides = json.RawMessage(overrides)
		return pin, nil
	}
	// No assignment in the parent's project: the newest published revision.
	err = runOn(ctx, pool).QueryRow(ctx, `
		SELECT r.id::text, r.revision_digest, r.plan_digest, r.digest_scope, r.compiled_plan::text
		FROM pipeline_revisions r
		JOIN pipelines pl ON pl.id = r.pipeline_id
		WHERE r.pipeline_id = $2::uuid AND r.organization_id = $1::uuid
		  AND pl.organization_id = $1::uuid AND r.status = 'published'
		ORDER BY r.revision_number DESC LIMIT 1`, orgID, pipelineID).
		Scan(&pin.revisionID, &pin.revisionDigest, &pin.planDigest, &pin.digestScope, &pin.plan)
	if errors.Is(err, pgx.ErrNoRows) {
		return m4ChildPin{}, fmt.Errorf("%w: pipeline %s has no published revision to invoke",
			ErrPipelineNotFound, pipelineID)
	}
	if err != nil {
		return m4ChildPin{}, fmt.Errorf("postgres: resolve published revision of pipeline %s: %w", pipelineID, err)
	}
	pin.pipelineID = pipelineID
	return pin, nil
}

// m4ResolveChildTarget turns an authored pipeline.invoke target into a pipeline
// id inside the parent's organization. The authored value is a pipeline NAME:
// `pipeline: issue-implementation` (docs/compatibility/probes/m4/pipeline.yaml:
// 222) is what an author writes and what the compiler checks against
// compiler.Registries.PipelineRevs, which the API layer owns — so the name
// reaches here unresolved, and pipelines' unique key is
// (organization_id, slug) (migration 00005:58-68), which is exactly the scope
// this lookup uses: a parent can invoke a sibling definition in ITS
// organization and nothing else. A literal uuid is accepted too, so an author
// who wrote the id still resolves.
func m4ResolveChildTarget(ctx context.Context, pool *pgxpool.Pool, orgID, target string) (string, error) {
	if prjValidUUID(target) {
		return target, nil
	}
	var id string
	err := runOn(ctx, pool).QueryRow(ctx, `
		SELECT id::text FROM pipelines
		WHERE organization_id = $1::uuid AND slug = $2`, orgID, target).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", fmt.Errorf("%w: pipeline.invoke target %q is not a pipeline of organization %s",
			ErrPipelineNotFound, target, orgID)
	}
	if err != nil {
		return "", fmt.Errorf("postgres: resolve pipeline.invoke target %q: %w", target, err)
	}
	return id, nil
}

func m4ChildInputs(plan json.RawMessage, in map[string]any) (map[string]RunInput, error) {
	submitted := map[string]json.RawMessage{}
	for name, v := range in {
		raw, err := json.Marshal(v)
		if err != nil {
			return nil, fmt.Errorf("postgres: encode child input %q: %w", name, err)
		}
		submitted[name] = raw
	}
	if len(submitted) == 0 {
		return nil, nil
	}
	return m4ValidateRunInputs(plan, submitted)
}
