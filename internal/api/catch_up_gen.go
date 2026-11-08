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
// borrows no side door: the work item is keyed by (project, source_run_id)
// and the tour is appended as a new version, with all of ADR-0078's store
// rules (race-safe versioning, document validation, membership guards) still
// enforced by the store itself. Refs are built here from the run's node
// outputs and inputs — the same fields the issue-to-pr template publishes
// (branch, pr_url, issue_number, commits) — never from anything the model
// wrote.

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
)

// --- the seams the generator needs from the store -----------------------

// CatchUpHeadStopView is one stop of an existing item's newest tour, as far
// as the generator may see it: the id, the title (the match key for the
// stable-id rule) and the version that introduced it.
type CatchUpHeadStopView struct {
	ID             string
	Title          string
	AddedInVersion int
}

// CatchUpCandidateView is one run still owed a tour. ItemID is empty when no
// work item names the run yet; TourHead is the item's newest tour version (0
// when it has none).
type CatchUpCandidateView struct {
	RunID          string
	ProjectID      string
	ItemID         string
	ConversationID string
	TourHead       int
	HeadStops      []CatchUpHeadStopView
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
// existing item to revise ("" = key on project + source run).
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
	UpsertCatchUpWorkItem(ctx context.Context, c Caller, in CatchUpWorkItemWrite) (string, error)
	AppendCatchUpTour(ctx context.Context, c Caller, itemID, reason string,
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
}

// CatchUpGeneratorTrigger is the seam the list route calls once it has
// answered. A notification, not a request — the caller has been served, and
// whatever the pass does must never change that answer or make it wait
// (ADR-0071 § Decision 6's rule, reused whole).
type CatchUpGeneratorTrigger interface {
	CatchUpItemsListed(ctx context.Context, c Caller, projectIDs []string)
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
		Model:  deps.Broker,
		Source: source,
		Writer: &catchUpGenWriter{store: deps.CatchUp},
		Log:    log,
	})
	if g == nil {
		return nil
	}
	return &catchUpTrigger{gen: g}
}

type catchUpTrigger struct {
	gen *assistant.CatchUpGenerator
}

func (t *catchUpTrigger) CatchUpItemsListed(ctx context.Context, c Caller, projectIDs []string) {
	t.gen.CatchUpItemsListed(ctx, catchUpAsstCaller(c), projectIDs)
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
		}
		for _, st := range row.HeadStops {
			cand.HeadStops = append(cand.HeadStops, assistant.CatchUpExistingStop{
				ID: st.ID, Title: st.Title, AddedInVersion: st.AddedInVersion,
			})
		}
		out = append(out, cand)
	}
	return out, nil
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
	return w.store.AppendCatchUpTour(ctx, caller, itemID, a.Reason, stops)
}

// --- caller conversion -----------------------------------------------------

func catchUpAPICaller(c assistant.Caller) Caller {
	return Caller{UserID: c.UserID, OrganizationID: c.OrganizationID, IsOrgAdmin: c.IsOrgAdmin}
}

func catchUpAsstCaller(c Caller) assistant.Caller {
	return assistant.Caller{UserID: c.UserID, OrganizationID: c.OrganizationID, IsOrgAdmin: c.IsOrgAdmin}
}
