package postgres

import (
	"context"
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	pevents "github.com/dbirks/communication/internal/pipelines/events"
	"github.com/dbirks/communication/internal/pipelines/runtime"
)

// Row reads for the runtime adapter (docs/m4-contract.md § 5.1: every step
// "re-derives readiness from rows", so Postgres is the only truth the engine
// sees). These hydrate a complete runtime.State from runs / run_inputs /
// node_executions / attempts / approval_requests / run_checkpoints /
// pipeline_invocations plus the run's journal resume from domain_events;
// runtimestore.go's Transact calls them inside the lock it just took, and
// never caches the result — no per-run State survives a call.

// rteUUIDNamespace is the RFC 4122 namespace for every identity this adapter
// mints deterministically (seeded harness names like "worker-a" or "alice").
// Identity resolution is a PURE function — uuid or uuidv5(ns, name) — never a
// per-process registry, so two RuntimeStore instances over the same database
// compute exactly the same row ids (contract § 5's cross-replica honesty).
const rteUUIDNamespace = "2b9f1a66-3a3f5e2d-9c47-5117a6b8c9d0"

// rteParseUUID decodes a canonical (dash-hex) uuid string.
func rteParseUUID(s string) ([16]byte, error) {
	var out [16]byte
	h := strings.ReplaceAll(s, "-", "")
	if len(h) != 32 {
		return out, fmt.Errorf("postgres: %q is not a uuid", s)
	}
	raw, err := hex.DecodeString(h)
	if err != nil || len(raw) != 16 {
		return out, fmt.Errorf("postgres: %q is not a uuid", s)
	}
	copy(out[:], raw)
	return out, nil
}

// rteUUIDBytes renders the canonical lowercase dash form Postgres and the
// ledger speak.
func rteUUIDBytes(b [16]byte) string {
	h := hex.EncodeToString(b[:])
	return strings.Join([]string{h[0:8], h[8:12], h[12:16], h[16:20], h[20:32]}, "-")
}

// rteUUIDv5 is RFC 4122 version-5 (SHA-1) name-based uuid, implemented
// locally so the adapter mints deterministic ids without a new dependency.
func rteUUIDv5(ns [16]byte, name string) string {
	h := sha1.New()
	h.Write(ns[:])
	h.Write([]byte(name))
	sum := h.Sum(nil)
	var out [16]byte
	copy(out[:], sum[:16])
	out[6] = (out[6] & 0x0f) | 0x50 // version 5
	out[8] = (out[8] & 0x3f) | 0x80 // RFC 4122 variant
	return rteUUIDBytes(out)
}

// rteIdentity resolves a presented identity (worker id, user id, workspace
// id) to its ledger uuid: a uuid names itself, any other string is hashed
// through the fixed namespace. Pure, so it is safe from any goroutine and
// every replica.
func rteIdentity(name string) string {
	if name == "" || prjValidUUID(name) {
		return name
	}
	ns, err := rteParseUUID(rteUUIDNamespace)
	if err != nil {
		panic("postgres: bad runtime identity namespace: " + err.Error())
	}
	return rteUUIDv5(ns, name)
}

// rteRowUUID is the stable ledger uuid of one run-row reference: an existing
// row is already keyed by uuid and names itself; an id the advancer minted in
// this transaction (ne/at/ap/inv + counter) hashes under the RUN's uuid as
// namespace, so the same minted name always maps to the same row identity —
// deterministically, with no in-process id registry.
func rteRowUUID(runID, ref string) string {
	if ref == "" {
		return ""
	}
	if prjValidUUID(ref) {
		return ref
	}
	ns, err := rteParseUUID(runID)
	if err != nil {
		return ref
	}
	return rteUUIDv5(ns, ref)
}

// rteTimePtr maps the runtime's zero-time convention to a SQL NULL.
func rteTimePtr(t time.Time) any {
	if t.IsZero() {
		return nil
	}
	return t.UTC()
}

// rteTime reads a nullable timestamptz into the zero-time convention.
func rteTime(p *time.Time) time.Time {
	if p == nil {
		return time.Time{}
	}
	return *p
}

// rteJSON renders a runtime value as a jsonb parameter; nil stays NULL.
func rteJSON(v any) (string, error) {
	if v == nil {
		return "", nil
	}
	raw, err := json.Marshal(v)
	if err != nil {
		return "", err
	}
	if string(raw) == "null" {
		return "", nil
	}
	return string(raw), nil
}

// rteJSONArray renders a slice member as jsonb with '[]' for empty — the
// columns (artifact_refs, output_errors, depends_on) are NOT NULL DEFAULT [].
func rteJSONArray(v any) (string, error) {
	s, err := rteJSON(v)
	if err != nil || s != "" {
		return s, err
	}
	return "[]", nil
}

// rteDecodeJSON reads a nullable jsonb column into the runtime value the
// engine holds: absent/NULL is nil, an object/map is map[string]any, an
// array is []any. Numbers decode as encoding/json decodes them (float64);
// that encoding is the ledger's, and every reader of a State sees the same
// decoded form, so row comparisons stay stable across hydrations.
func rteDecodeJSON(raw []byte) (any, error) {
	if len(raw) == 0 || string(raw) == "null" {
		return nil, nil
	}
	var v any
	if err := json.Unmarshal(raw, &v); err != nil {
		return nil, fmt.Errorf("postgres: decode runtime jsonb: %w", err)
	}
	return v, nil
}

// rteRepoStates reads run_checkpoints.repo_states into the engine's shape,
// restoring the capture bookkeeping (committed, modified_path_count) the
// boundary wrote — retry-time decisions read these flags, never a memory
// (ADR-0023 § 6).
func rteRepoStates(raw []byte) ([]runtime.RepoState, error) {
	if len(raw) == 0 || string(raw) == "null" || string(raw) == "[]" {
		return nil, nil
	}
	var docs []struct {
		RepositoryID          string `json:"repository_id"`
		BaseCommit            string `json:"base_commit"`
		HeadCommit            string `json:"head_commit"`
		ModifiedPathsArtifact string `json:"modified_paths_artifact"`
		ModifiedPathCount     int64  `json:"modified_path_count"`
		Committed             bool   `json:"committed"`
	}
	if err := json.Unmarshal(raw, &docs); err != nil {
		return nil, fmt.Errorf("postgres: decode checkpoint repo_states: %w", err)
	}
	out := make([]runtime.RepoState, 0, len(docs))
	for _, d := range docs {
		out = append(out, runtime.RepoState{
			RepositoryID:          d.RepositoryID,
			BaseCommit:            d.BaseCommit,
			HeadCommit:            d.HeadCommit,
			ModifiedPathsArtifact: d.ModifiedPathsArtifact,
			ModifiedPathCount:     d.ModifiedPathCount,
			Committed:             d.Committed,
		})
	}
	return out, nil
}

// -------------------------------------------------------------------- hydrate

// hydrateProgramTx rebuilds the run's OWN compiled program from
// runs.plan_snapshot (ADR-0023 § 2: the run executes the plan it pinned, not
// whatever plan the process happens to have wired). Runs created through the
// API always carry one; a run row that predates the pin (a hand-seeded
// fixture) yields nil, and the caller decides whether its wired advancer is
// an acceptable stand-in.
func hydrateProgramTx(ctx context.Context, tx pgx.Tx, runID string) (*runtime.Program, error) {
	var raw []byte
	if err := tx.QueryRow(ctx,
		`SELECT COALESCE(plan_snapshot, '{}'::jsonb)::text FROM runs WHERE id = $1::uuid`, runID).
		Scan(&raw); err != nil {
		if isNoRows(err) {
			return nil, ErrRunNotFound
		}
		return nil, fmt.Errorf("postgres: hydrate plan snapshot of run %s: %w", runID, err)
	}
	if runtime.EmptyPlanSnapshot(raw) {
		return nil, nil
	}
	prog, diags := runtime.PreparePlanSnapshot(raw)
	if !diags.Valid() {
		// A snapshot that cannot be programmed is corrupt data, and corrupt
		// data is a typed refusal the handler answers — not a nil *Program
		// reaching the advancer and panicking inside the request.
		return nil, fmt.Errorf("postgres: run %s pins an unexecutable plan snapshot: %v",
			runID, diags[0])
	}
	return prog, nil
}

// hydrateTx reads the run's FULL row set inside the caller's transaction.
// Called only after the advancer lock and the run row lock are held, so the
// scan is the run's truth at this instant (contract § 5.1 step 1).
func hydrateTx(ctx context.Context, tx pgx.Tx, runID string) (*runtime.State, error) {
	run, err := hydrateRunTx(ctx, tx, runID)
	if err != nil {
		return nil, err
	}
	st := runtime.NewState(run)

	if err := hydrateNodesTx(ctx, tx, st, runID); err != nil {
		return nil, err
	}
	if err := hydrateAttemptsTx(ctx, tx, st, runID); err != nil {
		return nil, err
	}
	if err := hydrateApprovalsTx(ctx, tx, st, runID); err != nil {
		return nil, err
	}
	if err := hydrateCheckpointsTx(ctx, tx, st, runID); err != nil {
		return nil, err
	}
	if err := hydrateInvocationsTx(ctx, tx, st, runID); err != nil {
		return nil, err
	}
	if err := hydrateJournalTx(ctx, tx, st, runID); err != nil {
		return nil, err
	}

	// The engine mints new row ids from a per-Kind counter (State.NewID).
	// Every engine-minted id in a run is contiguous per Kind (1..N, no gaps:
	// nothing is deleted), so counting this run's committed rows of each Kind
	// is exactly the re-derivation of that counter — after a restart, or on
	// another replica, the next mint continues where the ledger stopped and
	// never collides with a persisted uuid (01 invariant 3's row-identity
	// twin). The seeds are applied through NewID itself, never by touching
	// unexported state.
	seed := func(kind string, n int) {
		for i := 0; i < n; i++ {
			st.NewID(kind)
		}
	}
	seed("ne", len(st.Nodes))
	seed("at", len(st.Attempts))
	seed("ap", len(st.Approvals))
	seed("inv", len(st.Invocations))
	return st, nil
}

// hydrateRunTx reads the run row (already locked by the caller's FOR UPDATE
// is not required — the lock statement uses this same projection) plus its
// validated inputs.
func hydrateRunTx(ctx context.Context, tx pgx.Tx, runID string) (*runtime.Run, error) {
	var (
		id, orgID, projectID, pipelineID, revisionID string
		revDigest, planDigest, status                string
		cause, paused                                *string
		cancelled                                    *time.Time
		depth, evals                                 int
		volume                                       *string
		createdAt                                    time.Time
		started, finished                            *time.Time
	)
	err := tx.QueryRow(ctx, `
		SELECT id::text, organization_id::text, project_id::text, pipeline_id::text,
		       pipeline_revision_id::text, revision_digest, plan_digest, status,
		       failed_cause, paused_reason, cancel_requested_at, depth,
		       worker_volume_id, expression_evaluations,
		       created_at, started_at, finished_at
		FROM runs WHERE id = $1::uuid`, runID).
		Scan(&id, &orgID, &projectID, &pipelineID, &revisionID,
			&revDigest, &planDigest, &status,
			&cause, &paused, &cancelled, &depth,
			&volume, &evals, &createdAt, &started, &finished)
	if err != nil {
		if isNoRows(err) {
			return nil, ErrRunNotFound
		}
		return nil, fmt.Errorf("postgres: hydrate run %s: %w", runID, err)
	}
	run := &runtime.Run{
		ID: id, OrganizationID: orgID, ProjectID: projectID,
		PipelineID: pipelineID, RevisionID: revisionID,
		RevisionDigest: revDigest, PlanDigest: planDigest,
		Status: status, FailedCause: derefStr(cause), PausedReason: derefStr(paused),
		CancelRequestedAt:     cancelled,
		Depth:                 depth,
		WorkerVolumeID:        derefStr(volume),
		ExpressionEvaluations: evals,
		CreatedAt:             createdAt,
		StartedAt:             rteTime(started), FinishedAt: rteTime(finished),
	}
	rows, err := tx.Query(ctx, `
		SELECT name, value FROM run_inputs WHERE run_id = $1::uuid ORDER BY name`, runID)
	if err != nil {
		return nil, fmt.Errorf("postgres: hydrate run inputs %s: %w", runID, err)
	}
	defer rows.Close()
	inputs := map[string]any{}
	for rows.Next() {
		var name string
		var raw []byte
		if err := rows.Scan(&name, &raw); err != nil {
			return nil, fmt.Errorf("postgres: scan run input: %w", err)
		}
		v, err := rteDecodeJSON(raw)
		if err != nil {
			return nil, fmt.Errorf("postgres: run input %s: %w", name, err)
		}
		inputs[name] = v
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("postgres: read run inputs: %w", err)
	}
	if len(inputs) > 0 {
		run.Inputs = inputs
	}
	return run, nil
}

func hydrateNodesTx(ctx context.Context, tx pgx.Tx, st *runtime.State, runID string) error {
	rows, err := tx.Query(ctx, `
		SELECT id::text, node_id, kind, node_instance_key, scope_key, execution_location,
		       status, outputs, outcome, error_class, failed_cause,
		       artifact_refs, depends_on, attempt_count, attempt_limit, in_flight,
		       waiting_reason, created_at, ready_at, finished_at
		FROM node_executions WHERE run_id = $1::uuid
		ORDER BY created_at, id::text`, runID)
	if err != nil {
		return fmt.Errorf("postgres: hydrate node executions %s: %w", runID, err)
	}
	defer rows.Close()
	for rows.Next() {
		var (
			n                              runtime.NodeExecution
			outputs, refs, depends         []byte
			outcome, class, cause, waiting *string
			ready, finished                *time.Time
		)
		if err := rows.Scan(&n.ID, &n.NodeID, &n.Kind, &n.InstanceKey, &n.ScopeKey,
			&n.Location, &n.Status, &outputs, &outcome, &class, &cause,
			&refs, &depends, &n.AttemptCount, &n.AttemptLimit, &n.InFlight,
			&waiting, &n.CreatedAt, &ready, &finished); err != nil {
			return fmt.Errorf("postgres: scan node execution: %w", err)
		}
		n.RunID = runID
		n.Outcome = derefStr(outcome)
		n.ErrorClass = derefStr(class)
		n.FailedCause = derefStr(cause)
		n.Waiting = derefStr(waiting)
		n.ReadyAt = rteTime(ready)
		n.FinishedAt = rteTime(finished)
		v, err := rteDecodeJSON(outputs)
		if err != nil {
			return fmt.Errorf("postgres: node %s outputs: %w", n.InstanceKey, err)
		}
		n.Outputs = v
		if n.ArtifactRefs, err = decodeRefArray(refs); err != nil {
			return fmt.Errorf("postgres: node %s artifact refs: %w", n.InstanceKey, err)
		}
		if depends != nil {
			var deps []string
			if err := json.Unmarshal(depends, &deps); err != nil {
				return fmt.Errorf("postgres: node %s depends_on: %w", n.InstanceKey, err)
			}
			n.DependsOn = deps
		}
		st.Nodes = append(st.Nodes, &n)
	}
	return rows.Err()
}

func hydrateAttemptsTx(ctx context.Context, tx pgx.Tx, st *runtime.State, runID string) error {
	rows, err := tx.Query(ctx, `
		SELECT a.id::text, a.node_execution_id::text, a.attempt_number, a.status,
		       a.error_class, a.detail, a.output_errors,
		       COALESCE(a.worker_id::text, ''), a.lease_expires_at, a.fencing_token,
		       a.scheduled_at, a.deadline_at, a.cancel_requested_at,
		       a.outputs, a.outputs_digest, a.artifact_refs, a.overrides, a.retry_context,
		       a.created_at, a.started_at, a.finished_at
		FROM attempts a WHERE a.run_id = $1::uuid
		ORDER BY a.node_execution_id, a.attempt_number`, runID)
	if err != nil {
		return fmt.Errorf("postgres: hydrate attempts %s: %w", runID, err)
	}
	defer rows.Close()
	for rows.Next() {
		var (
			a                                           runtime.Attempt
			errClass, detail, digest                    *string
			lease, deadline, cancelReq                  *time.Time
			outputs, errsArr, refs, overrides, retryCtx []byte
			started, finished                           *time.Time
		)
		if err := rows.Scan(&a.ID, &a.NodeExecutionID, &a.AttemptNumber, &a.Status,
			&errClass, &detail, &errsArr,
			&a.WorkerID, &lease, &a.FencingToken,
			&a.ScheduledAt, &deadline, &cancelReq,
			&outputs, &digest, &refs, &overrides, &retryCtx,
			&a.CreatedAt, &started, &finished); err != nil {
			return fmt.Errorf("postgres: scan attempt: %w", err)
		}
		a.RunID = runID
		a.ErrorClass = derefStr(errClass)
		a.Detail = derefStr(detail)
		a.OutputsDigest = derefStr(digest)
		a.LeaseExpiresAt = rteTime(lease)
		a.DeadlineAt = rteTime(deadline)
		a.CancelRequested = cancelReq
		a.StartedAt = rteTime(started)
		a.FinishedAt = rteTime(finished)
		var err error
		if a.Outputs, err = rteDecodeJSON(outputs); err != nil {
			return fmt.Errorf("postgres: attempt %s outputs: %w", a.ID, err)
		}
		if a.OutputErrors, err = decodeRefArray(errsArr); err != nil {
			return fmt.Errorf("postgres: attempt %s output errors: %w", a.ID, err)
		}
		if a.ArtifactRefs, err = decodeRefArray(refs); err != nil {
			return fmt.Errorf("postgres: attempt %s artifact refs: %w", a.ID, err)
		}
		if a.Overrides, err = rteDecodeMap(overrides); err != nil {
			return fmt.Errorf("postgres: attempt %s overrides: %w", a.ID, err)
		}
		if a.RetryContext, err = rteDecodeMap(retryCtx); err != nil {
			return fmt.Errorf("postgres: attempt %s retry context: %w", a.ID, err)
		}
		st.Attempts = append(st.Attempts, &a)
	}
	return rows.Err()
}

func hydrateApprovalsTx(ctx context.Context, tx pgx.Tx, st *runtime.State, runID string) error {
	rows, err := tx.Query(ctx, `
		SELECT id::text, node_execution_id::text, kind, summary, artifact_refs,
		       approver_roles, COALESCE((SELECT array_agg(u::text) FROM unnest(approver_user_ids) u), '{}'),
		       deadline_at, on_timeout, re_requested, state, decision, comments,
		       COALESCE(decided_by::text, ''), decided_at, version, created_at
		FROM approval_requests WHERE run_id = $1::uuid
		ORDER BY created_at, id::text`, runID)
	if err != nil {
		return fmt.Errorf("postgres: hydrate approvals %s: %w", runID, err)
	}
	defer rows.Close()
	for rows.Next() {
		var (
			ap                 runtime.Approval
			refs               []byte
			roles, userIDs     []string
			decision, comments *string
			decidedAt          *time.Time
		)
		if err := rows.Scan(&ap.ID, &ap.NodeExecutionID, &ap.Kind, &ap.Summary, &refs,
			&roles, &userIDs, &ap.DeadlineAt, &ap.OnTimeout, &ap.ReRequested,
			&ap.State, &decision, &comments, &ap.DecidedBy, &decidedAt,
			&ap.Version, &ap.CreatedAt); err != nil {
			return fmt.Errorf("postgres: scan approval: %w", err)
		}
		ap.RunID = runID
		ap.Decision = derefStr(decision)
		ap.Comments = derefStr(comments)
		ap.DecidedAt = rteTime(decidedAt)
		ap.ApproverRoles = roles
		ap.ApproverUserIDs = userIDs
		v, err := decodeRefArray(refs)
		if err != nil {
			return fmt.Errorf("postgres: approval %s artifact refs: %w", ap.ID, err)
		}
		ap.ArtifactRefs = v
		st.Approvals = append(st.Approvals, &ap)
	}
	return rows.Err()
}

func hydrateCheckpointsTx(ctx context.Context, tx pgx.Tx, st *runtime.State, runID string) error {
	rows, err := tx.Query(ctx, `
		SELECT node_execution_id::text, attempt_id::text, inputs_digest, outputs_digest,
		       artifact_refs, repo_states, workspace_id::text, volume_id, worker_id::text,
		       plan_digest, created_at
		FROM run_checkpoints WHERE run_id = $1::uuid
		ORDER BY created_at, node_execution_id::text`, runID)
	if err != nil {
		return fmt.Errorf("postgres: hydrate checkpoints %s: %w", runID, err)
	}
	defer rows.Close()
	for rows.Next() {
		var (
			c           runtime.CheckpointRecord
			refs, repos []byte
		)
		if err := rows.Scan(&c.NodeExecutionID, &c.AttemptID, &c.InputsDigest, &c.OutputsDigest,
			&refs, &repos, &c.WorkspaceID, &c.VolumeID, &c.WorkerID,
			&c.PlanDigest, &c.CreatedAt); err != nil {
			return fmt.Errorf("postgres: scan checkpoint: %w", err)
		}
		c.RunID = runID
		v, err := decodeRefArray(refs)
		if err != nil {
			return fmt.Errorf("postgres: checkpoint artifact refs: %w", err)
		}
		c.ArtifactRefs = v
		rs, err := rteRepoStates(repos)
		if err != nil {
			return err
		}
		c.RepoStates = rs
		st.Checkpoints = append(st.Checkpoints, c)
	}
	return rows.Err()
}

func hydrateInvocationsTx(ctx context.Context, tx pgx.Tx, st *runtime.State, runID string) error {
	rows, err := tx.Query(ctx, `
		SELECT id::text, node_execution_id::text, child_run_id::text, child_project_id::text,
		       pipeline_id::text, resolved_revision_id::text, wait_policy, depth, created_at
		FROM pipeline_invocations WHERE run_id = $1::uuid
		ORDER BY created_at, id::text`, runID)
	if err != nil {
		return fmt.Errorf("postgres: hydrate invocations %s: %w", runID, err)
	}
	defer rows.Close()
	for rows.Next() {
		var iv runtime.Invocation
		if err := rows.Scan(&iv.ID, &iv.NodeExecutionID, &iv.ChildRunID, &iv.ChildProjectID,
			&iv.PipelineID, &iv.ResolvedRevisionID, &iv.WaitPolicy, &iv.Depth, &iv.CreatedAt); err != nil {
			return fmt.Errorf("postgres: scan invocation: %w", err)
		}
		iv.RunID = runID
		st.Invocations = append(st.Invocations, iv)
	}
	return rows.Err()
}

// hydrateJournalTx resumes the journal: every run-correlated domain_events
// row, in commit order. This is not decoration — cascadeCancel re-derives
// "the cancel was already journaled" from st.Events (advancer.go), so a
// process that skipped the resume would re-append. The payload comes back
// as its stored jsonb bytes: the journal is append-only, the engine never
// rewrites one, and the conformance prefix comparisons see the ledger's own
// encoding on both sides of a write.
func hydrateJournalTx(ctx context.Context, tx pgx.Tx, st *runtime.State, runID string) error {
	rows, err := tx.Query(ctx, `
		SELECT type, actor_kind, actor_id, payload, occurred_at,
		       COALESCE(node_execution_id::text, ''), COALESCE(attempt_id::text, '')
		FROM domain_events WHERE run_id = $1::uuid
		ORDER BY global_seq`, runID)
	if err != nil {
		return fmt.Errorf("postgres: hydrate journal %s: %w", runID, err)
	}
	defer rows.Close()
	for rows.Next() {
		var (
			rec pevents.Record
			raw []byte
		)
		if err := rows.Scan(&rec.Type, &rec.ActorKind, &rec.ActorID, &raw, &rec.Timestamp,
			&rec.NodeExecutionID, &rec.AttemptID); err != nil {
			return fmt.Errorf("postgres: scan journal row: %w", err)
		}
		rec.RunID = runID
		rec.OrganizationID = st.Run.OrganizationID
		rec.ProjectID = st.Run.ProjectID
		rec.Payload = json.RawMessage(append([]byte(nil), raw...))
		st.Events = append(st.Events, rec)
	}
	return rows.Err()
}

// decodeRefArray reads a NOT NULL '[]'-defaulted jsonb array column.
func decodeRefArray(raw []byte) ([]any, error) {
	if len(raw) == 0 || string(raw) == "null" {
		return []any{}, nil
	}
	var out []any
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// rteDecodeMap reads a nullable jsonb object column into a map (absent/NULL
// stays nil — the engine's own nil-vs-empty distinction is restored by the
// writer, so the reader mirrors it).
func rteDecodeMap(raw []byte) (map[string]any, error) {
	if len(raw) == 0 || string(raw) == "null" {
		return nil, nil
	}
	var out map[string]any
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// isNoRows is the ErrNoRows test every read here shares.
func isNoRows(err error) bool {
	return errors.Is(err, pgx.ErrNoRows)
}
