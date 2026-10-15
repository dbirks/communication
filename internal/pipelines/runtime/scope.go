package runtime

import (
	"strconv"
	"strings"
	"time"

	pevents "github.com/dbirks/communication/internal/pipelines/events"
)

// ScopeState is a composite node's own bookkeeping (contract § 5.1 step 6).
// It lives on the composite's node-execution row so the advancer can re-derive
// "which iteration am I on" from rows alone — the property that makes a
// crash mid-loop restart the same iteration rather than the loop (ADR-0023 § 6:
// "an until whose iteration 2 died restarts iteration 2, not the loop").
type ScopeState struct {
	// Kind is until or for_each (the only composites M4 executes;
	// parallel/join are refused at validate per ADR-0024 § 2).
	Kind string
	// Iteration is the until's current iteration, 1-based. It only advances
	// when the previous iteration's rows are all terminal and its predicate
	// evaluated false.
	Iteration int
	// Previous is the prior iteration's resultBindings: the `previous` CEL
	// root, an empty object on iteration 1 (ADR-0022 § 2 as amended).
	Previous map[string]any
	// StartedAt anchors a scope maxDurationSeconds bound (until body).
	StartedAt time.Time

	// Items is the for_each's evaluated item list (nil until evaluated).
	Items []any
	// NextIndex is the next for_each index to start.
	NextIndex int
	// ChildResults accumulates one entry per settled index, in index order
	// (contract § 5.1 step 6: a for_each ends when every index key is
	// terminal). Outputs.children is exactly this list (ADR-0023 § 8).
	ChildResults []ChildResult
	// StopRequested records that onChildFailure: stop fired: no new index
	// starts, queued siblings are cancelled, completed ones are preserved
	// (12 case 8).
	StopRequested bool
	// FailAfterAll records that a failure under fail_after_all must fail the
	// scope only once every index has run.
	FailAfterAll bool

	// Evidence is the per-iteration / per-batch record § 3 row 17 promises:
	// case 7's "full evidence" after until_exhausted is this list.
	Evidence []IterationEvidence

	// CarryForward is until's config flag: previous is only threaded when
	// the author asked for it (03's carryForward, contract § 9.1 row 18).
	CarryForward bool
}

// IterationEvidence is one closed until iteration or for_each batch close
// (node.scope.iteration's payload shape, § 3 row 17).
type IterationEvidence struct {
	Iteration            int
	PassWhenResult       *bool
	PredicateErrorDetail string
	Items                int
}

// ChildResult is one for_each index's terminal record:
// outputs.children = [{index, key, status, outcome, outputs, artifact_refs}]
// (ADR-0023 § 8). For a pipeline.invoke body this also names the child run.
type ChildResult struct {
	Index        int    `json:"index"`
	Key          string `json:"key"`
	Status       string `json:"status"`
	Outcome      string `json:"outcome,omitempty"`
	Outputs      any    `json:"outputs,omitempty"`
	ArtifactRefs []any  `json:"artifact_refs,omitempty"`
	ChildRunID   string `json:"child_run_id,omitempty"`
	ErrorClass   string `json:"error_class,omitempty"`
}

// ------------------------------------------------------------------- the row set

// State is everything one run owns: the rows the Postgres adapter keeps in
// runs / node_executions / attempts / approval_requests / run_checkpoints /
// pipeline_invocations, plus the journal appends. The advancer only ever reads
// and writes a State, which is what makes "the transaction re-derives
// readiness from row state" (ADR-0023 § 5) a testable claim.
type State struct {
	Run         *Run
	Nodes       []*NodeExecution
	Attempts    []*Attempt
	Approvals   []*Approval
	Checkpoints []CheckpointRecord
	Invocations []Invocation
	Events      []pevents.Record

	seq map[string]int
	// FencingSeq is the monotonic claim counter — attempt_fencing_seq's
	// in-memory twin. Drawn once per claim, never reset (01 invariant 3).
	FencingSeq int64
}

// NewState wraps a run row. The run's inputs (validated by the API per
// contract § 2 route 22) are already on Run.Inputs.
func NewState(run *Run) *State {
	return &State{Run: run, seq: map[string]int{}}
}

// NewID mints a deterministic row id per kind (r1, ne2, at3…). Tests compare
// ids literally, which a random uuid would forbid.
func (st *State) NewID(kind string) string {
	st.seq[kind]++
	return kind + strconv.Itoa(st.seq[kind])
}

// Node returns the row with this instance key, or nil.
func (st *State) Node(instanceKey string) *NodeExecution {
	for _, n := range st.Nodes {
		if n.InstanceKey == instanceKey {
			return n
		}
	}
	return nil
}

// NodesInScope returns every row whose scope key matches (one scope instance).
func (st *State) NodesInScope(scopeKey string) []*NodeExecution {
	var out []*NodeExecution
	for _, n := range st.Nodes {
		if n.ScopeKey == scopeKey {
			out = append(out, n)
		}
	}
	return out
}

// AttemptsFor returns a node execution's attempts in attempt_number order.
func (st *State) AttemptsFor(nodeExecID string) []*Attempt {
	var out []*Attempt
	for _, a := range st.Attempts {
		if a.NodeExecutionID == nodeExecID {
			out = append(out, a)
		}
	}
	return out
}

// LastAttempt returns the highest-numbered attempt, or nil.
func (st *State) LastAttempt(nodeExecID string) *Attempt {
	var last *Attempt
	for _, a := range st.Attempts {
		if a.NodeExecutionID == nodeExecID &&
			(last == nil || a.AttemptNumber > last.AttemptNumber) {
			last = a
		}
	}
	return last
}

// LiveAttempts returns attempts a worker currently holds (leased or running).
func (st *State) LiveAttempts() []*Attempt {
	var out []*Attempt
	for _, a := range st.Attempts {
		if a.Status == AttemptLeased || a.Status == AttemptRunning {
			out = append(out, a)
		}
	}
	return out
}

// ClaimableAttempts returns queued attempts whose persisted backoff landing
// time has passed (attempts.scheduled_at is the COMPUTED landing time, not a
// hint — contract § 1).
func (st *State) ClaimableAt(now time.Time) []*Attempt {
	var out []*Attempt
	for _, a := range st.Attempts {
		if a.Status == AttemptQueued && !a.ScheduledAt.After(now) {
			out = append(out, a)
		}
	}
	return out
}

// CheckpointFor returns the boundary record of one node execution.
func (st *State) CheckpointFor(nodeExecID string) (CheckpointRecord, bool) {
	for _, c := range st.Checkpoints {
		if c.NodeExecutionID == nodeExecID {
			return c, true
		}
	}
	return CheckpointRecord{}, false
}

// PendingApprovals returns live gates.
func (st *State) PendingApprovals() []*Approval {
	var out []*Approval
	for _, ap := range st.Approvals {
		if ap.State == ApprovalPending {
			out = append(out, ap)
		}
	}
	return out
}

// InvocationFor returns the child-run relationship of one node execution.
func (st *State) InvocationFor(nodeExecID string) (Invocation, bool) {
	for _, iv := range st.Invocations {
		if iv.NodeExecutionID == nodeExecID {
			return iv, true
		}
	}
	return Invocation{}, false
}

// AppendEvent records a journal append. The Store decides the transaction;
// this type only carries the rows.
func (st *State) AppendEvent(rec pevents.Record) {
	if rec.Timestamp.IsZero() {
		rec.Timestamp = st.Run.CreatedAt
	}
	st.Events = append(st.Events, rec)
}

// ------------------------------------------------------------------ scope keys

// ScopeRoot is the root scope's key — the same spelling the compiler uses.
const ScopeRoot = "/"

// ScopeInstanceKey builds the runtime scope key of one composite instance:
// the parent instance's key + the owner id with its index + "/".
// /build_until_verified[2]/ is where iteration 2's body rows live.
func ScopeInstanceKey(parentScopeKey, ownerID string, index int) string {
	base := strings.TrimSuffix(parentScopeKey, "/")
	if base == "" {
		base = ""
	}
	return base + "/" + ownerID + "[" + strconv.Itoa(index) + "]/"
}

// ForEachScopeInstanceKey is ScopeInstanceKey spelled for a for_each index
// (index is 0-based for items; until iterations are 1-based — ADR-0023 § 1's
// plan suffixes [1] and [0] say which is which).
func ForEachScopeInstanceKey(parentScopeKey, ownerID string, index int) string {
	return ScopeInstanceKey(parentScopeKey, ownerID, index)
}

// buildInstanceKey composes ADR-0023 § 1's text path from the plan node's
// Path plus the live indices of the composite ancestors: every non-final
// segment that has a live index carries [i], the node's own segment never
// does (the composite /build_until_verified has exactly one row; its body
// rows carry [i] — contract C7a counts them that way).
func buildInstanceKey(path []string, idx map[string]int) string {
	var b strings.Builder
	for i, seg := range path {
		b.WriteString("/" + seg)
		if i < len(path)-1 {
			if n, ok := idx[seg]; ok {
				b.WriteString("[" + strconv.Itoa(n) + "]")
			}
		}
	}
	return b.String()
}

// scopeKeyOf is the instance scope key of a composite's body instance: the
// composite's own path as a directory with its own segment carrying [index]
// and every ancestor segment carrying its live index. /fan_out[3]/until_x[2]/
// is where for_each item 3's until iteration 2 runs.
func scopeKeyOf(compositePath []string, idx map[string]int, index int) string {
	var b strings.Builder
	for i, seg := range compositePath {
		b.WriteString("/" + seg)
		if i == len(compositePath)-1 {
			b.WriteString("[" + strconv.Itoa(index) + "]")
		} else if n, ok := idx[seg]; ok {
			b.WriteString("[" + strconv.Itoa(n) + "]")
		}
	}
	return b.String() + "/"
}

// childIdx extends the live-index map for descending into a composite's body
// instance (every body node's instance key derives from this).
func childIdx(idx map[string]int, ownerID string, index int) map[string]int {
	out := make(map[string]int, len(idx)+1)
	for k, v := range idx {
		out[k] = v
	}
	out[ownerID] = index
	return out
}
