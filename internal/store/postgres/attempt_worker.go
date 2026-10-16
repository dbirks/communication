package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/dbirks/communication/internal/events"
	pevents "github.com/dbirks/communication/internal/pipelines/events"
	"github.com/dbirks/communication/internal/pipelines/runtime"
	"github.com/dbirks/communication/internal/worker"
)

// AttemptStore is the M4 attempt loop's persistence face (docs/m4-contract.md
// § 4): it implements worker.AttemptStore over the fenced claim/lease/boundary
// writes of attempts.go, exactly as TurnStore implements worker.TurnStore for
// M2. Every fenced method answers a stale triple with worker.ErrLeaseLost and
// lands NOTHING (ADR-0016 § 9 obligation 2, reused verbatim for attempts);
// the boundary write CompleteAttempt is one transaction — outputs, digest,
// artifact refs, the run_checkpoints row, the node mirror and every event —
// or it is nothing at all (contract § 4 step 10, `12` case 3).
//
// Event payloads are the pinned structs of internal/pipelines/events (the
// § 3 vocabulary); this adapter never invents a second shape. The three
// correlation columns are stamped by runAppendTx from the claim, never from
// the caller (contract § 3's correlation rule).
type AttemptStore struct {
	Runs *RunStore
}

var _ worker.AttemptStore = (*AttemptStore)(nil)

// MaxInlineOutputsBytes is contract § 6's cap: inline outputs per attempt are
// ≤ 32 KiB serialized; oversize content must travel as a kind=json artifact
// whose ref lands in outputs instead. The cap is enforced HERE, before the
// boundary transaction opens, so a refusal cannot half-write anything.
const MaxInlineOutputsBytes = 32 * 1024

// ErrOutputsTooLarge is the § 6 named failure (`invalid_output` +
// `outputs_too_large`): the executor closes the attempt with that class
// itself rather than presenting an oversize envelope to CompleteAttempt.
var ErrOutputsTooLarge = errors.New("postgres: inline outputs exceed the 32 KiB cap (contract § 6)")

// attemptErrStaleLease aliases the loop's single branch target: every
// rejection paths to worker.ErrLeaseLost, including the store's own
// ErrLeaseLost raised inside the shared RunStore helpers.
func attemptErrStaleLease(err error) error {
	if errors.Is(err, ErrLeaseLost) {
		return worker.ErrLeaseLost
	}
	return err
}

// workerClaim maps the loop's claim back onto the store's triple-carrying
// shape. The fence uses AttemptID/WorkerID/FencingToken; the journal uses
// RunID/NodeExecutionID; the payload uses the joined columns.
func workerClaim(c worker.AttemptClaim) AttemptClaim {
	var deadline *time.Time
	out := AttemptClaim{
		AttemptID: c.AttemptID, NodeExecutionID: c.NodeExecutionID, RunID: c.RunID,
		ProjectID: c.ProjectID, OrganizationID: c.OrganizationID,
		NodeID: c.NodeID, NodeInstanceKey: c.NodeInstanceKey,
		Kind: c.Kind, AttemptNumber: c.AttemptNumber,
		WorkerID: c.WorkerID, FencingToken: c.FencingToken,
	}
	if !c.DeadlineAt.IsZero() {
		d := c.DeadlineAt
		deadline = &d
	}
	out.DeadlineAt = deadline
	return out
}

// ClaimAttempts wins up to `capacity` queued attempts for the worker and
// hydrates each claim's Config from the run's PINNED plan_snapshot (§ 4
// step 2; 00005 makes that column immutable per run, so the hydration reads
// no mutable state), then INTERPOLATES it: every expression binding is
// resolved here, by the control plane, against the run's persisted state
// (§ 4 step 6, § 5.1 step 3). Only a binding that cannot be resolved at all —
// a snapshot this process cannot program, a corrupt row — lands as an
// $unresolved marker the executor refuses honestly, because the worker never
// evaluates an expression (§ 4 step 14).
func (s *AttemptStore) ClaimAttempts(ctx context.Context, workerID string, capacity int) ([]worker.AttemptClaim, error) {
	claims, err := s.Runs.ClaimAttempts(ctx, workerID, capacity)
	if err != nil {
		return nil, attemptErrStaleLease(err)
	}
	if len(claims) == 0 {
		return nil, nil
	}
	configs := s.hydrateConfigs(ctx, claims)
	out := make([]worker.AttemptClaim, 0, len(claims))
	for _, c := range claims {
		var deadline time.Time
		if c.DeadlineAt != nil {
			deadline = *c.DeadlineAt
		}
		out = append(out, worker.AttemptClaim{
			AttemptID: c.AttemptID, NodeExecutionID: c.NodeExecutionID,
			RunID: c.RunID, ProjectID: c.ProjectID, OrganizationID: c.OrganizationID,
			WorkerID: c.WorkerID, FencingToken: c.FencingToken,
			NodeID: c.NodeID, NodeInstanceKey: c.NodeInstanceKey,
			Kind: c.Kind, AttemptNumber: c.AttemptNumber,
			DeadlineAt: deadline,
			Config:     configs[c.AttemptID],
		})
	}
	return out, nil
}

// hydrateConfigs resolves one node's compiled config per claimed attempt in a
// single read of the immutable pinned snapshot. A node whose plan entry is
// missing yields no Config at all — the executor's honest refusal, not this
// read's failure. Errors degrade to "no config", never to a lost claim: the
// lease is already committed here, and a claim the worker cannot run closes
// through the loop, visibly, rather than silently going unclaimed.
func (s *AttemptStore) hydrateConfigs(ctx context.Context, claims []AttemptClaim) map[string]map[string]any {
	ids := make([]string, 0, len(claims))
	for _, c := range claims {
		ids = append(ids, c.NodeExecutionID)
	}
	rows, err := s.Runs.Pool.Query(ctx, `
		SELECT ne.id::text, COALESCE(r.plan_snapshot, '{}'::jsonb)::text
		FROM node_executions ne JOIN runs r ON r.id = ne.run_id
		WHERE ne.id = ANY($1::uuid[])`, ids)
	if err != nil {
		return nil
	}
	defer rows.Close()
	type planRef struct {
		nodeID  string
		scope   string
		payload []byte
	}
	byNode := map[string]planRef{}
	for rows.Next() {
		var (
			id      string
			payload string
		)
		if err := rows.Scan(&id, &payload); err != nil {
			return nil
		}
		byNode[id] = planRef{payload: []byte(payload)}
	}
	if err := rows.Err(); err != nil {
		return nil
	}
	out := map[string]map[string]any{}
	plans := map[string]*planShape{}
	for _, c := range claims {
		ref, ok := byNode[c.NodeExecutionID]
		if !ok {
			continue
		}
		key := c.RunID
		plan, have := plans[key]
		if !have {
			plan = parsePlanShape(ref.payload)
			plans[key] = plan
		}
		if cfg := plan.nodeConfig(scopePathNoIndexes(c.ScopeKey), c.NodeID); cfg != nil {
			out[c.AttemptID] = cfg
		}
	}
	s.resolveBindings(ctx, claims, out)
	return out
}

// resolveBindings closes the loop § 4 step 6 opens: the plan snapshot carries
// bindings, the run's rows carry the state they mean, and the claimed attempt
// must arrive carrying the RESULT. Resolution runs through the runtime's own
// ResolveNodeConfig — the same Evaluator, ConfigTree and vars assembly the
// advancer decided this node with — never a second one (ADR-0022 § 3).
//
// A claim whose config is already all literals costs one map walk and no read.
// When a run's bindings cannot be resolved (no programmable snapshot, a row
// this read cannot hydrate), the $unresolved markers STAY: the lease is already
// committed, so the honest outcome is the executor's binding_error close, not a
// swallowed claim. Each evaluation this performs is added to
// runs.expression_evaluations, the same counter and cap the advancer pays.
func (s *AttemptStore) resolveBindings(ctx context.Context, claims []AttemptClaim, configs map[string]map[string]any) {
	byRun := map[string][]AttemptClaim{}
	for _, c := range claims {
		if cfg, ok := configs[c.AttemptID]; ok && configHasUnresolved(cfg) {
			byRun[c.RunID] = append(byRun[c.RunID], c)
		}
	}
	for runID, pending := range byRun {
		s.resolveRunBindings(ctx, runID, pending, configs)
	}
}

func (s *AttemptStore) resolveRunBindings(ctx context.Context, runID string,
	claims []AttemptClaim, configs map[string]map[string]any) {
	tx, err := s.Runs.Pool.Begin(ctx)
	if err != nil {
		return
	}
	defer func() { _ = tx.Rollback(ctx) }()
	prog, err := hydrateProgramTx(ctx, tx, runID)
	if err != nil || prog == nil {
		return
	}
	st, err := hydrateTx(ctx, tx, runID)
	if err != nil || st == nil || st.Run == nil {
		return
	}
	rows := map[string]*runtime.NodeExecution{}
	for _, n := range st.Nodes {
		rows[n.ID] = n
	}
	before := st.Run.ExpressionEvaluations
	for _, c := range claims {
		row, ok := rows[c.NodeExecutionID]
		if !ok {
			continue
		}
		cfg, rerr := runtime.ResolveNodeConfig(prog, st, row)
		if rerr != nil {
			// The contract's answer to a binding that will not evaluate is the
			// attempt's binding_error close, so the marker stays and says why
			// (bounded, never a panic and never a half-resolved value).
			markBindingDetail(configs[c.AttemptID], rerr.Error())
			continue
		}
		configs[c.AttemptID] = cfg
	}
	evals := st.Run.ExpressionEvaluations - before
	// The hydration read closes before the counter is paid: the claim's lease
	// is already committed, so nothing here may hold a connection or a lock
	// while another writer updates the same run row.
	if err := tx.Commit(ctx); err != nil {
		return
	}
	if evals > 0 {
		_, _ = s.Runs.BumpExpressionEvaluations(ctx, runID, evals)
	}
}

// configHasUnresolved reports whether any nested config value still carries an
// expression binding the worker must not evaluate.
func configHasUnresolved(v any) bool {
	switch t := v.(type) {
	case map[string]any:
		if _, marker := t["$unresolved"]; marker {
			return true
		}
		for _, child := range t {
			if configHasUnresolved(child) {
				return true
			}
		}
	case []any:
		for _, child := range t {
			if configHasUnresolved(child) {
				return true
			}
		}
	case string:
		if strings.Contains(t, "${{") {
			return true
		}
	}
	return false
}

// markBindingDetail annotates every unresolved marker of one config with a
// bounded reason, so the attempt's binding_error says what the control plane
// could not evaluate instead of leaving it a mystery.
func markBindingDetail(cfg map[string]any, detail string) {
	if len(detail) > 512 {
		detail = detail[:512]
	}
	var walk func(v any)
	walk = func(v any) {
		switch t := v.(type) {
		case map[string]any:
			if _, marker := t["$unresolved"]; marker {
				t["detail"] = detail
			}
			for _, child := range t {
				walk(child)
			}
		case []any:
			for _, child := range t {
				walk(child)
			}
		}
	}
	walk(cfg)
}

// planShape decodes exactly the three fields of one compiled plan node the
// claim hydration reads (compiler/plan.go's plan, version
// v1alpha1-plan-1). It is a read of the stored JSON contract, not a second
// compiler: anything the plan holds beyond this stays opaque to the worker.
type planShape struct {
	Nodes []planShapeNode `json:"nodes"`
}

func parsePlanShape(raw []byte) *planShape {
	var p planShape
	if err := json.Unmarshal(raw, &p); err != nil {
		return &planShape{}
	}
	return &p
}

func (p *planShape) nodeConfig(scope, id string) map[string]any {
	node := p.find(scope, id)
	if node == nil {
		return nil
	}
	cfg := map[string]any{}
	for _, b := range node.ConfigBindings {
		rel, ok := configRelPath(b.Pointer)
		if !ok {
			continue
		}
		val := any(b.Literal)
		if len(b.ExprIDs) > 0 {
			// A binding the advancer resolves, not the worker (§ 4 step 14).
			val = map[string]any{"$unresolved": true, "expr_ids": b.ExprIDs,
				"position": b.Position, "template": b.Template}
		}
		if next, ok := insertConfigPath(cfg, strings.Split(rel, "/"), val).(map[string]any); ok {
			cfg = next
		}
	}
	if len(cfg) == 0 {
		return map[string]any{}
	}
	return cfg
}

type planShapeNode struct {
	ID             string `json:"id"`
	Scope          string `json:"scope"`
	Kind           string `json:"kind"`
	ConfigBindings []struct {
		Pointer  string   `json:"pointer"`
		Position string   `json:"position"`
		ExprIDs  []string `json:"exprIds,omitempty"`
		Template string   `json:"template,omitempty"`
		Literal  any      `json:"literal,omitempty"`
	} `json:"configBindings,omitempty"`
	// DeclaredOutputs is the node's own outputs JSON Schema — the boundary's
	// validation source (ADR-0022 § 4 rule 2). Engine-shaped keys
	// (exit_code/stdout_*) ride in the envelope alongside the payload, so an
	// author who forbids unknown properties must declare them (§ 4 step 7).
	DeclaredOutputs any `json:"outputs,omitempty"`
}

// nodeOutputs reads one plan node's declared outputs schema. A nil answer
// means either no entry or a node that declares no schema, and both are "the
// plan promises nothing about this envelope" — accepted, never invented.
func (p *planShape) nodeOutputs(scope, id string) any {
	n := p.find(scope, id)
	if n == nil {
		return nil
	}
	return n.DeclaredOutputs
}

func (p *planShape) find(scope, id string) *planShapeNode {
	if p == nil {
		return nil
	}
	for i := range p.Nodes {
		n := &p.Nodes[i]
		if n.ID == id && n.Scope == scope {
			return n
		}
	}
	return nil
}

// configRelPath maps a plan pointer like /spec/nodes/3/config/argv/0 to the
// config-relative path argv/0. A pointer that never entered "config" is not
// this node's config.
func configRelPath(pointer string) (string, bool) {
	i := strings.Index(pointer, "/config/")
	if i < 0 {
		return "", false
	}
	rel := pointer[i+len("/config/"):]
	if rel == "" {
		return "", false
	}
	return rel, true
}

// insertConfigPath builds the nested value a config pointer names: numeric
// segments index arrays, everything else is an object. It RETURNS the
// container because growing a []any reallocates — a mutation written through
// a copy taken out of an interface (the map entry) would be silently lost,
// which is exactly the mangled-hydration class this function must not ship.
// A collision with a different container kind drops the later binding — the
// executor sees the gap and refuses, which is honest.
func insertConfigPath(cur any, segs []string, val any) any {
	if len(segs) == 0 {
		return cur
	}
	seg := segs[0]
	leaf := len(segs) == 1
	switch c := cur.(type) {
	case map[string]any:
		if leaf {
			c[seg] = val
			return c
		}
		child, ok := c[seg]
		if !ok || child == nil {
			child = newConfigContainer(segs[1])
		}
		c[seg] = insertConfigPath(child, segs[1:], val)
		return c
	case []any:
		idx, err := strconv.Atoi(seg)
		if err != nil || idx < 0 {
			return c
		}
		for len(c) <= idx {
			c = append(c, nil)
		}
		if leaf {
			c[idx] = val
			return c
		}
		if c[idx] == nil {
			c[idx] = newConfigContainer(segs[1])
		}
		c[idx] = insertConfigPath(c[idx], segs[1:], val)
		return c
	}
	return cur
}

func newConfigContainer(nextSeg string) any {
	if _, err := strconv.Atoi(nextSeg); err == nil {
		return []any{}
	}
	return map[string]any{}
}

var planIndexSegment = regexp.MustCompile(`\[[0-9]{1,9}\]`)

// scopePathNoIndexes strips the [i] suffixes from a scope key so it addresses
// the plan scope the node was compiled into (ADR-0023 § 1: instance keys
// carry the runtime indices, plan scopes do not).
func scopePathNoIndexes(scopeKey string) string {
	return planIndexSegment.ReplaceAllString(scopeKey, "")
}

// RenewAttempt renews the attempt lease and the paired turn lease in one
// statement set (ADR-0023 § 4's two-lease rule, implemented by
// RunStore.RenewAttemptLease).
func (s *AttemptStore) RenewAttempt(ctx context.Context, c worker.AttemptClaim) error {
	return attemptErrStaleLease(s.Runs.RenewAttemptLease(ctx, workerClaim(c)))
}

// BeginAttempt moves leased→running and appends node.attempt.started in the
// SAME fenced transaction (§ 3 row 20), reusing the merged RunStore
// primitive so the fence, the mirror rules and the journal cannot drift from
// the control plane's reads. The honesty fields carry what this call can
// actually observe: sandbox_verified is false because the verify-then-launch
// chain belongs to the executor, which journals sandbox.verified with the
// real grant facts; worker_affinity reads the run's one-way door, which by
// § 4 step 3 was set in the very transaction that made this attempt
// claimable — a committed fact by here, so a pre-transaction read reports
// the same value the transaction would.
func (s *AttemptStore) BeginAttempt(ctx context.Context, c worker.AttemptClaim) error {
	st := workerClaim(c)
	var affinity bool
	if err := s.Runs.Pool.QueryRow(ctx,
		`SELECT worker_affinity IS NOT NULL FROM runs WHERE id = $1::uuid`, st.RunID).
		Scan(&affinity); err != nil {
		return fmt.Errorf("postgres: read affinity for attempt %s: %w", st.AttemptID, err)
	}
	return attemptErrStaleLease(s.Runs.BeginAttempt(ctx, st, RunEvent{
		Type: string(pevents.TypeNodeAttemptStarted), ActorKind: events.ActorKindWorker, ActorID: st.WorkerID,
		Payload: pevents.NodeAttemptStarted{
			ProjectID: st.ProjectID, RunID: st.RunID, NodeInstanceKey: st.NodeInstanceKey,
			AttemptNumber: st.AttemptNumber, ErrorClass: "", WorkerAffinity: affinity,
			SandboxVerified: false,
		},
	}))
}

// AppendAttemptEvent is the fenced journal append for every event an attempt
// body emits while it runs; the three correlation columns come from the claim.
func (s *AttemptStore) AppendAttemptEvent(ctx context.Context, c worker.AttemptClaim, ev worker.AttemptEvent) error {
	st := workerClaim(c)
	actorKind := ev.ActorKind
	if actorKind == "" {
		actorKind = events.ActorKindWorker
	}
	actorID := ev.ActorID
	if actorID == "" {
		actorID = st.WorkerID
	}
	return attemptErrStaleLease(s.Runs.runWithFencedTx(ctx, st, true, func(ctx context.Context, tx pgx.Tx) error {
		_, err := runAppendTx(ctx, tx, st.RunID, st.NodeExecutionID, st.AttemptID, RunEvent{
			Type: ev.Type, ActorKind: actorKind, ActorID: actorID, Payload: ev.Payload,
		})
		return err
	}))
}

// CancelRequestedAttempt reads the attempt's cancel flag under the current
// triple (§ 4 step 11's read on the renewal tick).
func (s *AttemptStore) CancelRequestedAttempt(ctx context.Context, c worker.AttemptClaim) (time.Time, bool, error) {
	at, ok, err := s.Runs.CancelRequested(ctx, workerClaim(c))
	return at, ok, attemptErrStaleLease(err)
}

// CompleteAttempt is the boundary transaction (contract § 4 step 10):
// validated outputs + outputs_digest + artifact refs + the node's business
// outcome + the run_checkpoints row, with node.attempt.completed and
// run.checkpoint_saved appended in the same fenced transaction, and the
// worker's active_attempts released only by that same commit (§ 4 step 1).
// A stale triple lands nothing.
func (s *AttemptStore) CompleteAttempt(ctx context.Context, c worker.AttemptClaim,
	outputs any, outputsDigest string, artifactRefs []any, outcome string, ckpt worker.AttemptCheckpoint) error {

	st := workerClaim(c)
	if outputs == nil {
		return fmt.Errorf("postgres: cannot complete attempt %s without outputs (01 invariant 4): %w",
			st.AttemptID, ErrConflict)
	}
	// ADR-0022 § 4 rule 2 / contract § 4 step 8: a produced envelope is
	// JSON-Schema-validated against its node's DECLARED outputs BEFORE any of it
	// becomes visible — this write, not an adapter, owns the guarantee, so
	// process.exec, agent.acp and model.chat are refused identically (C10c). A
	// refused reply closes the attempt failed with its schema locations in
	// output_errors and carries NO outputs, and the node returns to ready for
	// the advancer's policy-driven retry.
	rej, err := s.declaredOutputRejection(ctx, st, outputs)
	if err != nil {
		return err
	}
	if rej != nil {
		return s.rejectOutputs(ctx, st, rej)
	}
	raw, err := json.Marshal(outputs)
	if err != nil {
		return fmt.Errorf("postgres: encode outputs for attempt %s: %w", st.AttemptID, err)
	}
	if len(raw) > MaxInlineOutputsBytes {
		return fmt.Errorf("%w for attempt %s (%d bytes)", ErrOutputsTooLarge, st.AttemptID, len(raw))
	}
	if !runDigestRe.MatchString(outputsDigest) {
		return fmt.Errorf("postgres: outputs_digest %q is not sha256:<64 hex> (attempt %s)", outputsDigest, st.AttemptID)
	}
	if ckpt.VolumeID == "" {
		return fmt.Errorf("postgres: attempt %s completed without a checkpoint volume: a boundary that names no volume promises a restore nobody can perform (D-024 is same-volume only)", st.AttemptID)
	}
	refs := attemptNzAny(artifactRefs)
	refsRaw, err := json.Marshal(refs)
	if err != nil {
		return fmt.Errorf("postgres: encode artifact refs: %w", err)
	}
	repoStates := make([]pevents.RepoState, 0, len(ckpt.RepoStates))
	for _, r := range ckpt.RepoStates {
		repoStates = append(repoStates, pevents.RepoState{
			RepositoryID: r.RepositoryID, BaseCommit: r.BaseCommit,
			HeadCommit: r.HeadCommit, ModifiedPathsArtifact: r.ModifiedPathsArtifact,
		})
	}
	// plan_digest belongs to the RUN (the pinned column 00005 froze at
	// creation), so the store fills what the executor cannot carry: a blank
	// here would fail the CHECK anyway, and an invented digest would poison
	// the restore-vs-recompute decision D-024 hangs on it.
	planDigest := ckpt.PlanDigest
	if planDigest == "" {
		if err := s.Runs.Pool.QueryRow(ctx,
			`SELECT plan_digest FROM runs WHERE id = $1::uuid`, st.RunID).Scan(&planDigest); err != nil {
			return fmt.Errorf("postgres: read the run's pinned plan_digest for attempt %s: %w", st.AttemptID, err)
		}
	}
	return attemptErrStaleLease(s.Runs.FinishAttempt(ctx, st, AttemptFinish{
		Status: "succeeded", Outputs: raw, OutputsDigest: outputsDigest,
		ArtifactRefs: refsRaw, NodeOutcome: attemptNzStr(outcome, "passed"),
		Checkpoint: &NewCheckpoint{
			InputsDigest: ckpt.InputsDigest, OutputsDigest: ckpt.OutputsDigest,
			ArtifactRefs: refsRaw, RepoStates: json.RawMessage(marshalOrEmptyArray(ckpt.RepoStates)),
			WorkspaceID: ckpt.WorkspaceID, VolumeID: ckpt.VolumeID, PlanDigest: planDigest,
		},
		Events: []RunEvent{
			{Type: string(pevents.TypeNodeAttemptCompleted), ActorKind: events.ActorKindWorker, ActorID: st.WorkerID,
				Payload: pevents.NodeAttemptCompleted{
					ProjectID: st.ProjectID, RunID: st.RunID, NodeInstanceKey: st.NodeInstanceKey,
					AttemptNumber: st.AttemptNumber, OutputsDigest: outputsDigest,
					Outputs: outputs, ArtifactRefs: refs, CheckpointSaved: true,
				}},
			{Type: string(pevents.TypeRunCheckpointSaved), ActorKind: events.ActorKindWorker, ActorID: st.WorkerID,
				Payload: pevents.RunCheckpointSaved{
					ProjectID: st.ProjectID, RunID: st.RunID,
					Checkpoint: pevents.Checkpoint{
						NodeInstanceKey: st.NodeInstanceKey,
						InputsDigest:    ckpt.InputsDigest, OutputsDigest: ckpt.OutputsDigest,
						RepoStates: repoStates, ArtifactRefs: refs, VolumeID: ckpt.VolumeID,
					},
				}},
		},
	}))
}

// declaredOutputRejection reads the attempt's node out of its run's PINNED
// plan_snapshot (the same immutable source § 4 step 2's claim hydrates Config
// from) and answers whether the completion envelope violates the outputs schema
// that node declares. nil means ACCEPTED: the node declares no schema, the
// snapshot is a hand-seeded placeholder with no entry for the node, or the
// envelope satisfies the schema. A non-nil error is the unusable-schema arm —
// the boundary refuses to answer either way rather than closing a success it
// could not check.
func (s *AttemptStore) declaredOutputRejection(ctx context.Context, st AttemptClaim, outputs any) (*runtime.OutputRejection, error) {
	if s.Runs == nil || s.Runs.Pool == nil {
		return nil, errors.New("postgres: attempt store has no pool to read the pinned plan")
	}
	var (
		snapshot []byte
		nodeID   string
		scopeKey string
		execLoc  string
	)
	if err := s.Runs.Pool.QueryRow(ctx, `
		SELECT ne.node_id, ne.scope_key, ne.execution_location, COALESCE(r.plan_snapshot, '{}'::jsonb)::text
		FROM node_executions ne JOIN runs r ON r.id = ne.run_id
		WHERE ne.id = $1::uuid`, st.NodeExecutionID).Scan(&nodeID, &scopeKey, &execLoc, &snapshot); err != nil {
		if isNoRows(err) {
			// No node row: FinishAttempt's own fence is the place that says so.
			return nil, nil
		}
		return nil, fmt.Errorf("postgres: read the pinned plan of attempt %s: %w", st.AttemptID, err)
	}
	if execLoc != "" && execLoc != "worker" {
		// A control-plane row reaching this write is the fence's business, not
		// the schema check's — the engine owns that kind's outputs (§ 4 step 8).
		return nil, nil
	}
	if runtime.EmptyPlanSnapshot(snapshot) {
		return nil, nil
	}
	plan := parsePlanShape(snapshot)
	scope := scopePathNoIndexes(scopeKey)
	declared := plan.nodeOutputs(scope, nodeID)
	if declared == nil {
		// A node with no entry in the snapshot, or one that declares no outputs
		// schema: the plan promises nothing about this envelope and the boundary
		// invents no promise to check it against.
		return nil, nil
	}
	rej, err := runtime.CheckNodeOutputs("\x00attempt\x00"+scope+"\x00"+nodeID, st.NodeInstanceKey, declared, outputs)
	if err != nil {
		return nil, fmt.Errorf("postgres: attempt %s cannot be validated against its plan: %w", st.AttemptID, err)
	}
	return rej, nil
}

// rejectOutputs closes the attempt as the execution error it is (invalid_output,
// never a business verdict) with its JSON-Schema locations as the evidence and
// NOTHING else: no outputs on the attempt, none on the node, no checkpoint, no
// node.attempt.completed, and the node back to ready so the advancer decides
// retry vs terminal from the retry policy (ADR-0023 § 5, contract § 4 step 8).
func (s *AttemptStore) rejectOutputs(ctx context.Context, st AttemptClaim, rej *runtime.OutputRejection) error {
	errs := rej.Entries()
	detail := attemptBounded(rej.Error(), 512)
	return attemptErrStaleLease(s.Runs.FinishAttempt(ctx, st, AttemptFinish{
		Status: "failed", ErrorClass: runtime.ErrInvalidOutput, Detail: detail,
		OutputErrors: json.RawMessage(marshalOrEmptyArray(errs)),
		NodeStatus:   "ready",
		Events: []RunEvent{
			{Type: string(pevents.TypeNodeAttemptFailed), ActorKind: events.ActorKindWorker, ActorID: st.WorkerID,
				Payload: pevents.NodeAttemptFailed{
					ProjectID: st.ProjectID, RunID: st.RunID, NodeInstanceKey: st.NodeInstanceKey,
					AttemptNumber: st.AttemptNumber, ErrorClass: runtime.ErrInvalidOutput,
					Detail: detail, OutputErrors: errs,
				}},
		},
	}))
}

// FailAttempt closes the attempt with an ADR-0023 § 7 class under the fence;
// the NODE returns to ready and the ADVANCER decides retry vs terminal from
// rows — this call never terminalizes the node and never schedules the next
// attempt (§ 5.1, runtime store.go's failLocked parity).
func (s *AttemptStore) FailAttempt(ctx context.Context, c worker.AttemptClaim, class, detail string, outputErrors []any) error {
	st := workerClaim(c)
	if !validAttemptErrorClass(class) {
		return fmt.Errorf("postgres: %q is not an ADR-0023 § 7 error class (attempt %s)", class, st.AttemptID)
	}
	return attemptErrStaleLease(s.Runs.FinishAttempt(ctx, st, AttemptFinish{
		Status: "failed", ErrorClass: class, Detail: detail,
		OutputErrors: json.RawMessage(marshalOrEmptyArray(outputErrors)),
		NodeStatus:   "ready",
		Events: []RunEvent{
			{Type: string(pevents.TypeNodeAttemptFailed), ActorKind: events.ActorKindWorker, ActorID: st.WorkerID,
				Payload: pevents.NodeAttemptFailed{
					ProjectID: st.ProjectID, RunID: st.RunID, NodeInstanceKey: st.NodeInstanceKey,
					AttemptNumber: st.AttemptNumber, ErrorClass: class,
					Detail: attemptBounded(detail, 512), OutputErrors: attemptNzAny(outputErrors),
				}},
		},
	}))
}

// InterruptAttemptOwn closes the worker's OWN attempt honestly (§ 3 row 23's
// worker-side arms). lease_expired and worker_gone belong to the reconciler
// and are refused here; the paired turn is closed and journalled in the same
// transaction (§ 4 step 12).
func (s *AttemptStore) InterruptAttemptOwn(ctx context.Context, c worker.AttemptClaim, reason string) error {
	st := workerClaim(c)
	switch reason {
	case worker.InterruptReasonWorkerShutdown, worker.InterruptReasonHumanTakeover,
		"process_group_kill_timeout":
	case "lease_expired", "worker_gone":
		return fmt.Errorf("postgres: interrupt reason %q belongs to the reconciler, never to a live worker (attempt %s)", reason, st.AttemptID)
	default:
		return fmt.Errorf("postgres: unknown attempt interrupt reason %q (contract § 3 row 23)", reason)
	}
	return attemptErrStaleLease(s.Runs.FinishAttempt(ctx, st, AttemptFinish{
		Status: "interrupted", ErrorClass: "interrupted", NodeStatus: "ready",
		CloseTurnReason: reason,
		Events: []RunEvent{
			{Type: string(pevents.TypeNodeAttemptInterrupted), ActorKind: events.ActorKindWorker, ActorID: st.WorkerID,
				Payload: pevents.NodeAttemptInterrupted{
					ProjectID: st.ProjectID, RunID: st.RunID, NodeInstanceKey: st.NodeInstanceKey,
					AttemptNumber: st.AttemptNumber, Reason: reason,
				}},
		},
	}))
}

// CancelAttemptOwn closes a cancel-requested attempt after the executor
// stopped (§ 4 step 11). before_claim belongs to the advancer; a worker that
// never got the ack writes InterruptAttemptOwn instead, and this call is not
// made. The node moves cancelled with it — MemStore.CancelAttempt's shape —
// and the node.execution_cancelled pair rides in the same transaction.
func (s *AttemptStore) CancelAttemptOwn(ctx context.Context, c worker.AttemptClaim, reason string) error {
	st := workerClaim(c)
	switch reason {
	case worker.CancelReasonACPAck, worker.CancelReasonProcessTerminated:
	case "before_claim":
		return fmt.Errorf("postgres: cancel reason before_claim belongs to the advancer (attempt %s)", st.AttemptID)
	default:
		return fmt.Errorf("postgres: unknown attempt cancel reason %q (contract § 3 row 24)", reason)
	}
	return attemptErrStaleLease(s.Runs.FinishAttempt(ctx, st, AttemptFinish{
		Status: "cancelled", ErrorClass: "cancelled", NodeStatus: "cancelled",
		Events: []RunEvent{
			{Type: string(pevents.TypeNodeAttemptCancelled), ActorKind: events.ActorKindWorker, ActorID: st.WorkerID,
				Payload: pevents.NodeAttemptCancelled{
					ProjectID: st.ProjectID, RunID: st.RunID, NodeInstanceKey: st.NodeInstanceKey,
					AttemptNumber: st.AttemptNumber, Reason: reason,
				}},
			{Type: string(pevents.TypeNodeExecutionCancelled), ActorKind: events.ActorKindWorker, ActorID: st.WorkerID,
				Payload: pevents.NodeExecutionCancelled{
					ProjectID: st.ProjectID, RunID: st.RunID, NodeInstanceKey: st.NodeInstanceKey,
					Reason: "run_cancelled",
				}},
		},
	}))
}

// validAttemptErrorClass is ADR-0023 § 7's closed enum — the same words the
// attempts_error_class CHECK holds (contract § 1). The names are the worker
// package's constants so the two ends of one call cannot drift apart.
func validAttemptErrorClass(class string) bool {
	switch class {
	case worker.ErrorClassInfra, worker.ErrorClassInterrupted, worker.ErrorClassTimeout,
		worker.ErrorClassAgentError, worker.ErrorClassInvalidOutput, worker.ErrorClassPredicateError,
		worker.ErrorClassSandboxEnforcementFail, worker.ErrorClassWorkspaceLost,
		worker.ErrorClassBindingError, worker.ErrorClassApprovalExpired, worker.ErrorClassCancelled:
		return true
	default:
		return false
	}
}

var runDigestRe = regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)

func marshalOrEmptyArray(v any) []byte {
	raw, err := json.Marshal(v)
	if err != nil || raw == nil || string(raw) == "null" {
		return []byte("[]")
	}
	return raw
}

func attemptNzAny(in []any) []any {
	if in == nil {
		return []any{}
	}
	return in
}

func attemptNzStr(v, def string) string {
	if v == "" {
		return def
	}
	return v
}

// attemptBounded mirrors the loop's own `bounded` (worker/runner.go): byte
// truncation with an ellipsis. attempts.detail's 512-byte CHECK counts bytes,
// and FinishAttempt re-truncates with LEFT(...) as the final backstop, so the
// event copy and the row copy cannot disagree about the ceiling.
func attemptBounded(s string, max int) string {
	if len(s) <= max {
		return s
	}
	return s[:max] + "…"
}
