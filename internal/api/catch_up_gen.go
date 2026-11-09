package api

// The catch-up generator's reader and writer (ADR-0078 § Migration): the
// adapters that carry assistant.Caller and assistant views across the package
// boundary, exactly as assistant_notes.go does for the notes generator.
//
// The generator performs no authorization of its own — every read is issued
// AS THE CALLER who opened the page, through the same store seams the routes
// use (GetRun, ListRunNodes, ListPipelines, the chat transcript read), and
// the candidate list carries the caller's own membership predicate inside its
// own statement. A generator that could see more than the browser would be a
// hole, not a feature.
//
// The writes go through the store's OWN upsert and append — the generator
// borrows no side door: the work item is keyed by the PIECE OF WORK the run's
// refs name (project + group key: the issue, else the PR, else the run itself)
// and the tour is appended as a new version, with all of ADR-0078's store
// rules (race-safe versioning, refs merging, document validation, membership
// guards) still enforced by the store itself. Refs — and therefore the group
// key — are built here from the run's node outputs and inputs, the same fields
// the issue-to-pr template publishes (branch, pr_url, issue_number, commits),
// never from anything the model wrote: an answer that invents an issue number
// cannot name its way into somebody else's story, because the key it would
// need is not a member of the answer (ADR-0078 § Grouping).

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"strconv"
	"strings"
	"time"

	"github.com/dbirks/communication/internal/assistant"
	"github.com/dbirks/communication/internal/domain"
)

// --- the seams the generator needs from the store -----------------------

// CatchUpHeadStopView is one stop of an existing item's newest tour, as far as
// the generator may see it: the id, the title (the match key for the stable-id
// rule), the label and rank the reader saw, and the version that introduced
// it. The narrative is deliberately absent — a rewrite is told what the beats
// WERE, not shown the prose it is supposed to rewrite, which is the difference
// between carrying a story forward and paraphrasing oneself.
type CatchUpHeadStopView struct {
	ID             string
	Title          string
	Kind           string
	Importance     string
	AddedInVersion int
}

// CatchUpCandidateView is one run still owed a tour. ItemID is empty when no
// work item has claimed the run yet — which, once runs group, says nothing
// about whether the PIECE OF WORK already has a story: that is what
// CatchUpItemForGroup answers once the run's own refs have been read. TourHead
// is the item's newest tour version (0 when it has none).
type CatchUpCandidateView struct {
	RunID          string
	ProjectID      string
	ItemID         string
	ConversationID string
	TourHead       int
	HeadStops      []CatchUpHeadStopView
	// HeadReason is why the newest version said what it said.
	HeadReason string
}

// CatchUpGroupView is the work item a grouping key names: the piece of work
// this run belongs under, with the tour a rewrite must carry forward.
type CatchUpGroupView struct {
	ItemID         string
	ConversationID string
	TourHead       int
	Reason         string
	HeadStops      []CatchUpHeadStopView
	// PriorRunFailed is § Structure's failure fact as the store reads it: a
	// run this item carries ended failed, or the item's own resolution says
	// run_failed. The generator cannot see it anywhere else — it is the
	// difference between "a rewrite" and "the fix landing after the failure".
	PriorRunFailed bool
}

// CatchUpSweepCandidateView is one run the completion sweep owes a tour, with
// the caller the generator must act as: the human the run's own row
// attributes — triggered_by, else the author of the schedule or issue-trigger
// row that fired it, else the same walk up the bounded parent chain (the
// ADR-0062 attribution rule, resolved in the sweep read). A run whose human
// cannot be named is not swept at all: the generator will not forge a
// submitter to hang a write on, the same refusal agentturn_seams states for
// agent turns.
type CatchUpSweepCandidateView struct {
	Candidate CatchUpCandidateView
	Caller    Caller
}

// CatchUpRefsWrite is the generator's claim set: the numbers and SHAs the
// assistant saw, with no urls beside them. It is deliberately NOT the wire's
// CatchUpRefsView — a url on the write path would be a link this layer had to
// trust the model for, and the read path is the only place one is computed
// (CatchUpRefsView.WithRepository).
type CatchUpRefsWrite struct {
	IssueNumbers []int
	PRNumbers    []int
	CommitSHAs   []string
	RunIDs       []string
}

// CatchUpWorkItemWrite is the generator's work-item upsert. ID names an
// existing item to revise; GroupKey names the piece of work (issue, PR) the
// item is keyed by when no id was read; with neither the (project, source run)
// identity of the pre-grouping store applies.
type CatchUpWorkItemWrite struct {
	ID             string
	ProjectID      string
	Shape          string
	Title          string
	Summary        string
	Resolution     string
	Refs           CatchUpRefsWrite
	SourceRunID    string
	ConversationID string
	GroupKey       string
}

// CatchUpStopWrite is one tour stop to append. Evidence objects already carry
// their server-assigned `type`; the payload rides through opaque, exactly as
// the read path serves it.
type CatchUpStopWrite struct {
	ID             string
	Title          string
	Narrative      string
	Kind           string
	Importance     string
	AddedInVersion int
	Evidence       []map[string]any
	Decision       *CatchUpDecisionView
}

// CatchUpGenStore is the generator's store arm: the candidate read and the
// two writes. It is deliberately NOT folded into CatchUpStore — nothing a
// browser-facing route may do grows a generation verb by accident; the only
// writer of a tour is the server's own assistant (ADR-0078 § Decision 7).
type CatchUpGenStore interface {
	CatchUpCandidates(ctx context.Context, c Caller, projectIDs []string,
		window time.Duration, limit int) ([]CatchUpCandidateView, error)
	// CatchUpSweepCandidates is the completion sweep's server-owned candidate
	// read (ADR-0078 § Trigger): the same window, limit and unclaimed rules as
	// CatchUpCandidates, applied to every project rather than one caller's —
	// which is sound for the sweep and only for the sweep, because the read
	// hands back, per candidate, the attributed human every later read and
	// write is issued as. The caller-scoped rule every browser-facing read
	// carries is not replaced here, it is PERSONALISED.
	CatchUpSweepCandidates(ctx context.Context, window time.Duration, limit int) ([]CatchUpSweepCandidateView, error)
	// CatchUpRunAlreadyToured reports whether a tour version claiming the run
	// was written after the run's newest move — the idempotency question two
	// replicas ask before either tells one story twice. It answers a boolean
	// about a run id the asking side already proved visible; it returns no
	// rows of anybody's data.
	CatchUpRunAlreadyToured(ctx context.Context, runID string) (bool, error)
	// CatchUpItemForGroup reads the work item a grouping key names; the
	// boolean is false when no piece of work carries it (yet).
	CatchUpItemForGroup(ctx context.Context, c Caller, projectID,
		groupKey string) (CatchUpGroupView, bool, error)
	UpsertCatchUpWorkItem(ctx context.Context, c Caller, in CatchUpWorkItemWrite) (string, error)
	AppendCatchUpTour(ctx context.Context, c Caller, itemID, runID, reason string,
		stops []CatchUpStopWrite) error
}

// The run reads the DATA block is folded from. Each is an existing route's
// store method — the generator sees exactly what the run page sees.
type (
	catchUpGenRunReader interface {
		GetRun(ctx context.Context, c Caller, runID string) (RunView, error)
		ListRunNodes(ctx context.Context, c Caller, runID string) ([]NodeExecutionView, error)
	}
	catchUpGenPipelineReader interface {
		ListPipelines(ctx context.Context, c Caller) ([]PipelineSummaryView, error)
	}
)

// CatchUpGenDeps is the wiring: the model broker, the store arm, the run
// reads, and the transcript reader the conversation tail is folded from.
type CatchUpGenDeps struct {
	// Broker is the assistant's egress (ADR-0034). nil means no generation:
	// the catch-up routes stay the pure reads they shipped as, and an empty
	// page is the honest answer, never a stub narrative.
	Broker    *assistant.Broker
	CatchUp   CatchUpGenStore
	Runs      catchUpGenRunReader
	Pipelines catchUpGenPipelineReader
	Chats     assistant.ChatTranscriptReader
	Logger    *slog.Logger
	// Cooldown overrides the generator's per-RUN floor between two attempts.
	// Zero means assistant.CatchUpGenCooldown (ten minutes); a deployment that
	// runs the generator against a real model in a short-lived lab may shorten
	// it — see COMMUNICATION_CATCHUP_GEN_COOLDOWN in `serve`'s environment.
	Cooldown time.Duration
	// MaxModelCallsPerWindow overrides the PER-REPLICA global cap on
	// generation model calls per assistant.CatchUpGenModelCallWindow (ten
	// minutes). nil means the shipped default (six); 0 disables generation
	// entirely — see COMMUNICATION_CATCHUP_GEN_PER_10M in `serve`'s
	// environment.
	MaxModelCallsPerWindow *int
}

// CatchUpGeneratorTrigger is the seam the visits route calls once it has
// answered. A notification, not a request — the caller has been served, and
// whatever the pass does must never change that answer or make it wait
// (ADR-0071 § Decision 6's rule, reused whole). The list route is not a
// trigger: the sidebar badge reads it on every page (ADR-0078 § Migration,
// Trigger note).
type CatchUpGeneratorTrigger interface {
	CatchUpVisitRecorded(ctx context.Context, c Caller, projectIDs []string)
}

// CatchUpSweeper is the other trigger — not a route's, but the serve
// ticker's (ADR-0078 § Trigger): one goroutine per replica calls it every
// COMMUNICATION_CATCHUP_GEN_SWEEP, and the runs that finished untoured get
// their stories without anybody opening the page. It is a separate interface
// from the visit trigger on purpose: nothing a browser route holds gains the
// power to run the whole fleet's backlog by asking.
type CatchUpSweeper interface {
	CatchUpCompletionSweep(ctx context.Context)
}

// BuildCatchUpGenerator returns the trigger, or nil when this deployment
// cannot generate. A nil trigger is the honest absence, not a failure — the
// same rule BuildAssistantNotesGenerator states.
func BuildCatchUpGenerator(deps CatchUpGenDeps) CatchUpGeneratorTrigger {
	log := deps.Logger
	if log == nil {
		log = slog.New(slog.NewTextHandler(io.Discard, nil))
	}
	if deps.Broker == nil || deps.CatchUp == nil || deps.Runs == nil ||
		deps.Pipelines == nil || deps.Chats == nil {
		return nil
	}
	source := &catchUpGenReader{
		store: deps.CatchUp, runs: deps.Runs, pipelines: deps.Pipelines,
		chats: deps.Chats, log: log,
	}
	g := assistant.NewCatchUpGenerator(assistant.CatchUpDeps{
		Model:                  deps.Broker,
		Source:                 source,
		Writer:                 &catchUpGenWriter{store: deps.CatchUp},
		Log:                    log,
		Cooldown:               deps.Cooldown,
		MaxModelCallsPerWindow: deps.MaxModelCallsPerWindow,
	})
	if g == nil {
		return nil
	}
	return &catchUpTrigger{gen: g}
}

type catchUpTrigger struct {
	gen *assistant.CatchUpGenerator
}

func (t *catchUpTrigger) CatchUpVisitRecorded(ctx context.Context, c Caller, projectIDs []string) {
	t.gen.CatchUpVisitRecorded(ctx, catchUpAsstCaller(c), projectIDs)
}

// The built generator carries the sweep face — that is how serve's ticker
// reaches it (see CatchUpSweeper); the compile-time proof lives here because
// a silently-missing method would only surface as a serve-side type-assert
// failure at runtime.
var _ CatchUpSweeper = (*catchUpTrigger)(nil)

// CatchUpCompletionSweep runs one sweep synchronously — the serve ticker IS
// the background already; spawning here would only let beats pile up on a
// slow model. The pass itself caps what one tick spends.
func (t *catchUpTrigger) CatchUpCompletionSweep(ctx context.Context) {
	t.gen.CatchUpCompletionSweep(ctx)
}

// --- the recap generator (POST /catch-up/recap) --------------------------

// CatchUpRecapDeps is the recap route's wiring. Broker is the SAME egress the
// tour generator and the assistant speak through — one deployment, one model,
// one cost site (ADR-0034) — and it is the only member the builder needs:
// unlike the tour pass, the recap performs no store reads of its own. The
// route hands it the caller's own items, read through the caller's own routes
// before the completion is asked for.
type CatchUpRecapDeps struct {
	Broker *assistant.Broker
	Logger *slog.Logger
}

// BuildCatchUpRecapGenerator returns the recap's model arm, or nil when this
// deployment has no egress. A nil generator is the honest absence: the route
// answers 503 assistant_not_configured and the page keeps the recap it
// already has, exactly the rule the tour builder states for the pass.
func BuildCatchUpRecapGenerator(deps CatchUpRecapDeps) CatchUpRecapGenerator {
	if deps.Broker == nil {
		return nil
	}
	g := assistant.NewCatchUpRecapGenerator(assistant.CatchUpRecapDeps{
		Model: deps.Broker, Log: deps.Logger,
	})
	if g == nil || !g.Configured() {
		return nil
	}
	return g
}

// --- the reader ----------------------------------------------------------

// catchUpGenReader is the generator's reader. It implements both faces the
// generator knows: the caller-scoped CatchUpSource and the sweep's
// CatchUpSweepSource.
var _ assistant.CatchUpSweepSource = (*catchUpGenReader)(nil)

type catchUpGenReader struct {
	store     CatchUpGenStore
	runs      catchUpGenRunReader
	pipelines catchUpGenPipelineReader
	chats     assistant.ChatTranscriptReader
	log       *slog.Logger
}

func (r *catchUpGenReader) CandidateRuns(ctx context.Context, c assistant.Caller,
	projectIDs []string) ([]assistant.CatchUpCandidate, error) {
	rows, err := r.store.CatchUpCandidates(ctx, catchUpAPICaller(c), projectIDs,
		assistant.CatchUpGenWindow, 4*assistant.CatchUpGenMaxPerPass)
	if err != nil {
		return nil, err
	}
	out := make([]assistant.CatchUpCandidate, 0, len(rows))
	for _, row := range rows {
		cand := assistant.CatchUpCandidate{
			RunID: row.RunID, ProjectID: row.ProjectID, ItemID: row.ItemID,
			ConversationID: row.ConversationID, TourHead: row.TourHead,
			HeadReason: row.HeadReason,
		}
		for _, st := range row.HeadStops {
			cand.HeadStops = append(cand.HeadStops, assistant.CatchUpExistingStop{
				ID: st.ID, Title: st.Title, Kind: st.Kind, Importance: st.Importance,
				AddedInVersion: st.AddedInVersion,
			})
		}
		out = append(out, cand)
	}
	return out, nil
}

// ExistingItem answers the grouping question the candidate read cannot: the
// candidate row is keyed on the RUN, while the piece of work an issue-naming
// run belongs to is named by a key only the run's own outputs can say. Not
// finding one is the ordinary answer for a first run, never an error; a read
// that fails is, because generating over it would write a twin story.
func (r *catchUpGenReader) ExistingItem(ctx context.Context, c assistant.Caller,
	projectID, groupKey string) (assistant.CatchUpExistingItem, error) {
	if groupKey == "" {
		return assistant.CatchUpExistingItem{}, nil
	}
	row, found, err := r.store.CatchUpItemForGroup(ctx, catchUpAPICaller(c), projectID, groupKey)
	if err != nil || !found {
		return assistant.CatchUpExistingItem{}, err
	}
	item := assistant.CatchUpExistingItem{
		ItemID: row.ItemID, ConversationID: row.ConversationID,
		TourHead: row.TourHead, HeadReason: row.Reason,
		PriorRunFailed: row.PriorRunFailed,
	}
	for _, st := range row.HeadStops {
		item.HeadStops = append(item.HeadStops, assistant.CatchUpExistingStop{
			ID: st.ID, Title: st.Title, Kind: st.Kind, Importance: st.Importance,
			AddedInVersion: st.AddedInVersion,
		})
	}
	return item, nil
}

// SweepCandidates serves the completion sweep's candidate read, mapping each
// store row to an assistant candidate plus the caller it is generated AS (the
// attributed human the sweep read resolved).
func (r *catchUpGenReader) SweepCandidates(ctx context.Context) ([]assistant.CatchUpSweepCandidate, error) {
	rows, err := r.store.CatchUpSweepCandidates(ctx, assistant.CatchUpGenWindow,
		4*assistant.CatchUpGenMaxPerPass)
	if err != nil {
		return nil, err
	}
	out := make([]assistant.CatchUpSweepCandidate, 0, len(rows))
	for _, row := range rows {
		cand := assistant.CatchUpCandidate{
			RunID: row.Candidate.RunID, ProjectID: row.Candidate.ProjectID,
			ItemID: row.Candidate.ItemID, ConversationID: row.Candidate.ConversationID,
			TourHead: row.Candidate.TourHead, HeadReason: row.Candidate.HeadReason,
		}
		for _, st := range row.Candidate.HeadStops {
			cand.HeadStops = append(cand.HeadStops, assistant.CatchUpExistingStop{
				ID: st.ID, Title: st.Title, Kind: st.Kind, Importance: st.Importance,
				AddedInVersion: st.AddedInVersion,
			})
		}
		out = append(out, assistant.CatchUpSweepCandidate{
			Caller:    catchUpAsstCaller(row.Caller),
			Candidate: cand,
		})
	}
	return out, nil
}

// RunAlreadyToured is the two-replica idempotency question, answered by the
// claim table the tour append itself writes. It carries no caller: the answer
// is one boolean about a run the asking side already proved visible, and the
// store read joins nothing else.
func (r *catchUpGenReader) RunAlreadyToured(ctx context.Context, runID string) (bool, error) {
	return r.store.CatchUpRunAlreadyToured(ctx, runID)
}

// RunFacts folds one run into the generator's factual summary. A transcript
// read that fails degrades to "the thread says nothing" rather than losing
// the generation — the story is still honest about the run itself; a run or
// node read that fails is the error, because then there is no block at all.
func (r *catchUpGenReader) RunFacts(ctx context.Context, c assistant.Caller,
	runID string) (assistant.CatchUpRunFacts, error) {
	caller := catchUpAPICaller(c)
	run, err := r.runs.GetRun(ctx, caller, runID)
	if err != nil {
		return assistant.CatchUpRunFacts{}, err
	}
	nodes, err := r.runs.ListRunNodes(ctx, caller, runID)
	if err != nil {
		return assistant.CatchUpRunFacts{}, err
	}
	facts := assistant.CatchUpRunFacts{
		Workflow:   r.workflowName(ctx, caller, run.PipelineID),
		Title:      derefString(run.Title),
		Status:     run.Status,
		StartedBy:  derefString(run.TriggeredBy),
		StartedAt:  catchUpTime(run.StartedAt),
		FinishedAt: catchUpTime(run.FinishedAt),
	}
	facts.RepositoryID = derefString(run.RepositoryID)
	facts.Goal = catchUpGoalFromInputs(run.Inputs)
	if n := catchUpInputInt(run.Inputs, "issue_number"); n > 0 {
		facts.IssueNumber = n
	}
	for _, ne := range nodes {
		facts.Nodes = append(facts.Nodes, assistant.CatchUpNodeFact{
			Key: ne.NodeInstanceKey, Status: ne.Status,
			ErrorClass: derefString(ne.ErrorClass), Error: derefString(ne.FailedCause),
		})
		catchUpHarvestOutputs(ne.Outputs, &facts)
	}
	facts.HadCodeRefs = facts.Branch != "" || facts.PRNumber > 0 || facts.PRURL != "" ||
		len(facts.Commits) > 0 || facts.IssueNumber > 0
	// The grouping key is derived from the SAME server-side read of the run's
	// outputs that the refs come from (domain.CatchUpGroupKey: an issue names
	// the piece of work, else a PR does, else the run is the piece of work),
	// so it is a fact about the run rather than a claim about the story —
	// ADR-0078 § Grouping. An empty key is the honest "no grouping read was
	// possible", not a guess.
	facts.GroupKey = domain.CatchUpGroupKey(facts.RepositoryID, facts.IssueNumber,
		facts.PRNumber, runID)
	if conv := derefString(run.SourceConversationID); conv != "" {
		transcript, terr := r.chats.ReadChatTranscript(ctx, c, conv)
		if terr != nil {
			r.log.Warn("catch up: conversation tail unavailable",
				slog.String("run_id", runID), slog.String("error", terr.Error()))
		} else {
			tail := catchUpTail(transcript.Lines, assistant.CatchUpGenMaxLines)
			lines := make([]assistant.ChatLine, 0, len(tail))
			for _, l := range tail {
				lines = append(lines, assistant.ChatLine{Author: l.Author, Text: l.Text})
			}
			facts.Lines = lines
		}
	}
	return facts, nil
}

func (r *catchUpGenReader) workflowName(ctx context.Context, c Caller, pipelineID string) string {
	if r.pipelines == nil || pipelineID == "" {
		return ""
	}
	pipes, err := r.pipelines.ListPipelines(ctx, c)
	if err != nil {
		// A name is decoration on the block; losing it must not cost the tour.
		return ""
	}
	for _, p := range pipes {
		if p.ID == pipelineID {
			if p.DisplayName != "" {
				return p.DisplayName
			}
			return p.Slug
		}
	}
	return ""
}

// catchUpTail keeps the LAST n lines — the end of the thread is where the
// outcome lives, and it is the bounded half a passing reader actually reads.
func catchUpTail(lines []assistant.ChatTranscriptLine, n int) []assistant.ChatTranscriptLine {
	if len(lines) <= n {
		return lines
	}
	return lines[len(lines)-n:]
}

func catchUpTime(t *time.Time) string {
	if t == nil || t.IsZero() {
		return ""
	}
	return t.UTC().Format(time.RFC3339)
}

// catchUpGoalFromInputs names the run's goal: the value of an input called
// goal/task/brief, else the first input's value, bounded. It is data quoted
// to the model, and the prompt already says what that means.
func catchUpGoalFromInputs(inputs []RunInputValueView) string {
	for _, name := range [...]string{"goal", "task", "brief", "issue_body", "prompt"} {
		for _, in := range inputs {
			if strings.EqualFold(in.Name, name) {
				return catchUpInputText(in.Value)
			}
		}
	}
	if len(inputs) > 0 {
		return catchUpInputText(inputs[0].Value)
	}
	return ""
}

func catchUpInputText(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var s string
	if err := json.Unmarshal(raw, &s); err == nil {
		return s
	}
	return string(raw)
}

func catchUpInputInt(inputs []RunInputValueView, name string) int {
	for _, in := range inputs {
		if !strings.EqualFold(in.Name, name) {
			continue
		}
		var n json.Number
		dec := json.NewDecoder(strings.NewReader(strings.TrimSpace(string(in.Value))))
		dec.UseNumber()
		if err := dec.Decode(&n); err != nil {
			return 0
		}
		i, err := strconv.Atoi(n.String())
		if err != nil || i < 0 {
			return 0
		}
		return i
	}
	return 0
}

// catchUpHarvestOutputs reads the code-naming outputs off one node's output
// envelope — the fields the issue-to-pr template publishes (branch, pr_url,
// issue_number) plus the shapes an agent report tends to carry (pr_number,
// commits, sha). This is the ONLY source of a ref: the model never supplies
// one, so an invented number is unrepresentable by construction rather than
// filtered after the fact.
func catchUpHarvestOutputs(raw json.RawMessage, facts *assistant.CatchUpRunFacts) {
	if len(raw) == 0 || string(raw) == "null" {
		return
	}
	var obj map[string]any
	if err := json.Unmarshal(raw, &obj); err != nil {
		return
	}
	var visit func(m map[string]any, depth int)
	visit = func(m map[string]any, depth int) {
		for k, v := range m {
			switch value := v.(type) {
			case string:
				switch strings.ToLower(k) {
				case "branch", "head_branch":
					if facts.Branch == "" {
						facts.Branch = strings.TrimSpace(value)
					}
				case "pr_url", "pull_request_url", "pr", "pull_url":
					if facts.PRURL == "" && strings.HasPrefix(value, "http") {
						facts.PRURL = strings.TrimSpace(value)
						if n := catchUpNumberFromTail(facts.PRURL); n > 0 {
							facts.PRNumber = n
						}
					}
				case "commit_sha", "sha", "head_sha", "commit":
					if len(value) >= 7 && len(value) <= 64 {
						facts.Commits = append(facts.Commits, value)
					}
				}
			case float64:
				n := int(value)
				if n <= 0 {
					continue
				}
				switch strings.ToLower(k) {
				case "issue_number":
					facts.IssueNumber = n
				case "pr_number", "pull_request_number", "pull_request":
					if facts.PRNumber == 0 {
						facts.PRNumber = n
					}
				}
			case []any:
				if strings.ToLower(k) == "commits" || strings.ToLower(k) == "commit_shas" {
					for _, item := range value {
						if s, ok := item.(string); ok && len(s) >= 7 && len(s) <= 64 {
							facts.Commits = append(facts.Commits, s)
						}
					}
				} else if depth < 1 {
					for _, item := range value {
						if nested, ok := item.(map[string]any); ok {
							visit(nested, depth+1)
						}
					}
				}
			case map[string]any:
				if depth < 1 {
					visit(value, depth+1)
				}
			}
		}
	}
	visit(obj, 0)
	if len(facts.Commits) > 8 {
		facts.Commits = facts.Commits[:8]
	}
}

// catchUpNumberFromTail reads the trailing integer of a url (…/pull/123),
// which is how a pull request is numbered in every url this platform has ever
// seen. No match is zero, and zero is "no PR number", not a guess.
func catchUpNumberFromTail(url string) int {
	tail := url
	if i := strings.LastIndexByte(tail, '/'); i >= 0 {
		tail = tail[i+1:]
	}
	if i := strings.IndexByte(tail, '?'); i >= 0 {
		tail = tail[:i]
	}
	n, err := strconv.Atoi(strings.TrimSpace(tail))
	if err != nil || n <= 0 {
		return 0
	}
	return n
}

// --- the writer -----------------------------------------------------------

type catchUpGenWriter struct {
	store CatchUpGenStore
}

func (w *catchUpGenWriter) WriteCatchUpTour(ctx context.Context, c assistant.Caller,
	a assistant.CatchUpTourWrite) error {
	caller := catchUpAPICaller(c)
	itemID, err := w.store.UpsertCatchUpWorkItem(ctx, caller, CatchUpWorkItemWrite{
		ID: a.ExistingID, ProjectID: a.ProjectID, Shape: a.Shape,
		Title: a.Title, Summary: a.Summary, Resolution: a.Resolution,
		Refs: CatchUpRefsWrite{
			IssueNumbers: a.Refs.IssueNumbers, PRNumbers: a.Refs.PRNumbers,
			CommitSHAs: a.Refs.CommitSHAs, RunIDs: a.Refs.RunIDs,
		},
		SourceRunID: a.RunID, ConversationID: a.ConversationID,
		GroupKey: a.GroupKey,
	})
	if err != nil {
		return fmt.Errorf("api: catch-up generator could not upsert the work item: %w", err)
	}
	stops := make([]CatchUpStopWrite, 0, len(a.Stops))
	for _, st := range a.Stops {
		ev := make([]map[string]any, 0, len(st.Evidence))
		for _, e := range st.Evidence {
			m := map[string]any{"type": e.Type}
			for k, v := range e.Payload {
				if k == "type" {
					continue // the server's type wins, always
				}
				m[k] = v
			}
			ev = append(ev, m)
		}
		write := CatchUpStopWrite{
			ID: st.ID, Title: st.Title, Narrative: st.Narrative, Kind: st.Kind,
			Importance: st.Importance, AddedInVersion: st.AddedInVersion,
			Evidence: ev,
		}
		if st.Decision != nil {
			write.Decision = &CatchUpDecisionView{
				Prompt: st.Decision.Prompt, Options: st.Decision.Options,
				AllowText: st.Decision.AllowText,
			}
		}
		stops = append(stops, write)
	}
	// The run id rides along so appending the tour is what CLAIMS the run:
	// a run is owed a story until a story names it (ADR-0078 § Grouping), and
	// writing the claim anywhere earlier would let a failed completion strand
	// a run with no tour and no retry.
	return w.store.AppendCatchUpTour(ctx, caller, itemID, a.RunID, a.Reason, stops)
}

// --- caller conversion -----------------------------------------------------

func catchUpAPICaller(c assistant.Caller) Caller {
	return Caller{UserID: c.UserID, OrganizationID: c.OrganizationID, IsOrgAdmin: c.IsOrgAdmin}
}

func catchUpAsstCaller(c Caller) assistant.Caller {
	return assistant.Caller{UserID: c.UserID, OrganizationID: c.OrganizationID, IsOrgAdmin: c.IsOrgAdmin}
}
