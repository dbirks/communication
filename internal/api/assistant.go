package api

// The read-only in-app assistant (ADR-0034, docs/design/assistant-v1.md): one
// route, POST /api/v1/assistant/ask, whose broker calls the SAME store methods
// the routes below already serve — with the caller's own Caller, so the
// assistant can never read a row the browser could not.
//
// Nothing here stores anything: no table, no transcript, no action trace
// (ADR-0034 "v1 stores nothing"). The turn lives in this request and dies with
// the response.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/dbirks/communication/internal/assistant"
)

// AssistantConfig is the serve-side egress quadruple, read from
// COMMUNICATION_ASSISTANT_BASE_URL / _API_KEY (or _API_KEY_FILE) / _MODEL /
// _TIMEOUT by cmd/communication/serve.go. The API key is only ever handed to
// the broker to put in a header: it is never logged, never echoed, never
// stored.
type AssistantConfig struct {
	BaseURL string
	APIKey  string
	Model   string
	// Timeout is the per-model-call deadline; zero means the broker's
	// assistant.DefaultTimeout applies.
	Timeout time.Duration
}

// AssistantDeps carries the read handles the tool registry is built over plus
// the egress configuration. Each interface is the narrow read half of the
// store the corresponding routes use, so mounting the assistant cannot widen
// what any of them can do.
type AssistantDeps struct {
	Projects  assistantProjectReader
	Runs      assistantRunReader
	Approvals assistantApprovalReader
	Pipelines assistantPipelineReader
	Profiles  assistantProfileReader
	// Brief is the ADR-0081 catch-up brief store: the same
	// postgres.APICatchUpStore the Catch up routes are mounted with. The
	// assistant's catchup.brief tool answers from it, so the page and the chat
	// model read one assembled fact set. Nil is the honest absence: the tool is
	// then not announced at all, rather than announced and refused.
	Brief CatchUpBriefStore
	// Threads is the assistant's thread.list read: the SAME cross-project
	// conversation list GET /api/v1/conversations serves the /threads page
	// with (ADR-0047), so a thread answer and the page cannot disagree about
	// which threads exist. Nil is the honest absence — the tool is then not
	// announced at all, the same rule as the brief above.
	Threads assistantThreadReader
	Config  AssistantConfig
}

// The narrow read surfaces ADR-0034's six tools need. Deliberately methods-only
// interfaces: there is no write method reachable from this file at all, which is
// the structural half of "the registry has no write entry".
type (
	assistantProjectReader interface {
		ListProjects(ctx context.Context, c Caller) ([]ProjectView, error)
	}
	assistantRunReader interface {
		ListProjectRuns(ctx context.Context, c Caller, projectID string) ([]RunSummaryView, error)
		ListRunNodes(ctx context.Context, c Caller, runID string) ([]NodeExecutionView, error)
	}
	assistantApprovalReader interface {
		ListProjectApprovals(ctx context.Context, c Caller, projectID string) ([]ApprovalView, error)
	}
	assistantPipelineReader interface {
		ListPipelines(ctx context.Context, c Caller) ([]PipelineSummaryView, error)
		ListPipelineRevisions(ctx context.Context, c Caller, pipelineID string) ([]RevisionSummaryView, error)
	}
	assistantProfileReader interface {
		ListAgentProfiles(ctx context.Context, c Caller) ([]AgentProfileView, error)
	}
	// assistantThreadReader is the /threads page's own read: the caller's
	// conversations across every project they belong to, scoped in the store's
	// SQL (a project the caller is not in contributes no rows). The tool needs
	// no cursor and no limit of its own — assistantThreadFetchLimit is the
	// server's page, and the tool's cap is the smaller one.
	assistantThreadReader interface {
		ListVisibleConversations(ctx context.Context, c Caller, limit int, cursor string) ([]ConversationSummaryView, string, error)
	}
	// assistantDraftAccess is the gate the draft-proposals route applies:
	// the caller's own read of the draft row. The write predicate the store
	// applies to PUT /drafts/{id} today IS this org-visibility check (see
	// APIPipelineStore.ReplaceDraft: a draft of another organization answers
	// the not-found sentinel), so no wider read is granted — a caller who
	// cannot see the draft gets the not-found sentinel (404, existence
	// hidden) and a store that later splits read and write answers
	// ErrDraftForbidden, which the route maps to 403.
	assistantDraftAccess interface {
		GetDraft(ctx context.Context, c Caller, draftID string) (DraftView, error)
	}
)

// BuildAssistantBroker builds the ADR-0034 broker over the deps' read
// handles and egress config. A nil broker with a nil error is the
// "feature absent on this deployment" answer, not a failure. The v1 ask
// route and the ADR-0050 conversation routes share one broker so the whole
// assistant surface has one egress configuration.
func BuildAssistantBroker(deps AssistantDeps, logger *slog.Logger) (*assistant.Broker, error) {
	if strings.TrimSpace(deps.Config.BaseURL) == "" {
		return nil, nil
	}
	store := assistantStore{
		projects:  deps.Projects,
		runs:      deps.Runs,
		approvals: deps.Approvals,
		pipelines: deps.Pipelines,
		profiles:  deps.Profiles,
	}
	// The brief is the one read the assistant may not have: wrapping the store
	// only when it IS wired is what keeps the tool off the announced set when
	// it is not (assistant.announcedToolOrder), so a model is never told to ask
	// for a brief this deployment cannot assemble.
	// Each optional read is announced only over the handle that can answer it
	// (assistant.announcedToolOrder), so the type is chosen by what is wired.
	handle := assistantStoreHandle(store, deps)
	return assistant.New(assistant.Config{
		BaseURL: deps.Config.BaseURL,
		APIKey:  deps.Config.APIKey,
		Model:   deps.Config.Model,
		Timeout: deps.Config.Timeout,
		Logger:  logger,
	}, handle)
}

// RegisterAssistant mounts POST /api/v1/assistant/ask. With no base URL the
// route still answers — with 503 assistant_not_configured — so the palette gets
// a definite answer rather than a 404 that looks like a broken client, and the
// honest absence is stated in the problem document (ADR-0034's rollout rule:
// unset means the feature is absent).
func RegisterAssistant(s *Server, deps AssistantDeps) {
	h := &asstHandlers{srv: s}
	broker, err := BuildAssistantBroker(deps, s.logger)
	if err != nil {
		// A configured-but-invalid endpoint is a deployment error the
		// operator must see at startup; serve refuses on New, and a route
		// built without a broker answers 503 like the unset case.
		s.logger.Error("assistant: endpoint configured but unusable", "error", err.Error())
	} else {
		h.broker = broker
	}
	// ADR-0044's proposals route reuses this deps member when it ALSO
	// implements assistantDraftAccess (the concrete store adapter does:
	// the draft read is the store call GET /drafts/{id} makes, so the
	// proposal can never widen that boundary).
	if dr, ok := deps.Pipelines.(assistantDraftAccess); ok {
		h.drafts = dr
	}
	if pr, ok := deps.Profiles.(assistantProfileReader); ok {
		h.profiles = pr
	}
	// Per-principal throttle on every turn-generating POST (audit F2,
	// ADR-0077): each ask/proposal is billed model work behind it.
	s.HandleAuthed("POST /api/v1/assistant/ask", s.ThrottleAssistant(http.HandlerFunc(h.ask)))
	// ADR-0044: one bounded drafting proposal per request, read-only on the
	// server side (the human applies it through the normal version-checked
	// PUT). Mounted beside ask: same session + CSRF contract, same broker.
	s.HandleAuthed("POST /api/v1/assistant/draft-proposals", s.ThrottleAssistant(http.HandlerFunc(h.proposals)))
}

type asstHandlers struct {
	srv      *Server
	broker   *assistant.Broker
	drafts   assistantDraftAccess
	profiles assistantProfileReader
}

// AssistantAskBody is POST /api/v1/assistant/ask's request document.
type AssistantAskBody struct {
	Question string              `json:"question"`
	Context  AssistantAskContext `json:"context,omitempty"`
}

// AssistantAskContext is the UI's view of where the question was asked. Every
// member is untrusted input: a route or palette href that is not a known app
// route contributes nothing rather than being forwarded to the model.
type AssistantAskContext struct {
	Route        string                  `json:"route,omitempty"`
	ProjectID    string                  `json:"project_id,omitempty"`
	PaletteIndex []AssistantPaletteEntry `json:"palette_index,omitempty"`
	// Page is the composer's context chip (CONTRACT §2), the same shape the
	// conversation post carries. It is cleaned exactly like that path cleans
	// it, so a label that closes a tag contributes nothing useful.
	Page *assistant.TurnContextPage `json:"page,omitempty"`
}

// AssistantPaletteEntry is one row of the client's jump index.
type AssistantPaletteEntry struct {
	Label     string `json:"label,omitempty"`
	Secondary string `json:"secondary,omitempty"`
	To        string `json:"to,omitempty"`
}

// --- the route ------------------------------------------------------------

// ask answers one question with one bounded read-only turn. Session-authed and
// CSRF-checked like every other POST (ADR-0014), and authorized as the caller:
// the broker holds no store handle it does not pass this Caller to.
func (h *asstHandlers) ask(w http.ResponseWriter, r *http.Request) {
	p, ok := PrincipalFrom(r.Context())
	if !ok {
		WriteProblem(w, http.StatusInternalServerError, "Internal Server Error",
			"api: no principal in context")
		return
	}
	var body AssistantAskBody
	if err := DecodeJSON(r, &body); err != nil {
		WriteProblem(w, http.StatusBadRequest, "Bad Request", err.Error())
		return
	}
	question := strings.TrimSpace(body.Question)
	switch {
	case question == "":
		WriteProblem(w, http.StatusBadRequest, "Bad Request", "question is required.")
		return
	case utf8.RuneCountInString(question) > assistant.MaxQuestionRunes:
		WriteProblem(w, http.StatusBadRequest, "Bad Request",
			"question must be at most "+strconv.Itoa(assistant.MaxQuestionRunes)+" characters.")
		return
	}
	if h.broker == nil {
		// The feature is off: an honest 503 that names the cause, so the UI can
		// keep the jump list on screen instead of showing a blank answer.
		writeAssistantProblem(w, http.StatusServiceUnavailable, "assistant_not_configured",
			"the assistant is not enabled on this deployment (COMMUNICATION_ASSISTANT_BASE_URL is unset)")
		return
	}
	c := assistant.Caller{UserID: p.UserID, OrganizationID: p.OrganizationID, IsOrgAdmin: p.IsOrgAdmin}
	qc := assistant.QuestionContext{
		Route:     strings.TrimSpace(body.Context.Route),
		ProjectID: strings.TrimSpace(body.Context.ProjectID),
		// The page block rides through the same cleaning the conversation turn
		// applies (bounded, no control characters, no angle brackets), so the
		// chip's label and status can reach the model as data and nothing else.
		Page: assistant.CleanPageContext(body.Context.Page),
	}
	for _, e := range body.Context.PaletteIndex {
		if len(qc.Palette) >= assistant.MaxItems {
			break
		}
		qc.Palette = append(qc.Palette, assistant.PaletteEntry{
			Label: strings.TrimSpace(e.Label), Secondary: strings.TrimSpace(e.Secondary), To: strings.TrimSpace(e.To),
		})
	}

	answer, bad := h.broker.Ask(r.Context(), c, question, qc)
	if bad != nil {
		writeAssistantProblem(w, bad.Status, bad.Code, bad.Detail)
		return
	}
	// A page-context sign-off (CONTRACT §2) is data for the UI's quiet
	// "assumed you meant X (on screen)" line, not prose: the final
	// `Assumed: …` line comes off the markdown and rides beside it.
	markdown, assumed := assistant.SplitAssumedLine(answer.AnswerMarkdown)
	answer.AnswerMarkdown = markdown
	WriteJSON(w, http.StatusOK, assistantAskAnswer{Answer: answer, Assumed: assumed})
}

// assistantAskAnswer is the one-shot ask's 200 body: the broker's answer with
// the optional `assumed` member the page context can earn. Embedding keeps
// every existing member (and its nullability) exactly as assistant.Answer
// renders it; `assumed` is absent on the answers that did not use the page.
type assistantAskAnswer struct {
	*assistant.Answer
	Assumed string `json:"assumed,omitempty"`
}

// writeAssistantProblem is the problem+json answer with the one extra member the
// design pins: `degraded` naming the cause, so the UI branches on a code rather
// than a sentence (docs/design/assistant-v1.md § ask).
func writeAssistantProblem(w http.ResponseWriter, status int, code, detail string) {
	if detail == "" {
		detail = code
	}
	if status <= 0 {
		status = http.StatusServiceUnavailable
	}
	w.Header().Set("Content-Type", ProblemJSON)
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(struct {
		Type     string `json:"type"`
		Title    string `json:"title"`
		Status   int    `json:"status"`
		Detail   string `json:"detail,omitempty"`
		Degraded string `json:"degraded"`
	}{Type: "about:blank", Title: http.StatusText(status), Status: status,
		Detail: asstBounded(detail), Degraded: code})
}

// asstBounded clips an endpoint-derived detail string, so a refusal that quotes
// a gateway's message cannot inflate a response or echo an unbounded body.
func asstBounded(detail string) string {
	const limit = 400
	if len(detail) <= limit {
		return detail
	}
	cut := limit
	for cut > 0 && (detail[cut]&0xC0) == 0x80 {
		cut--
	}
	return detail[:cut]
}

// --- the store adapter ----------------------------------------------------

// assistantStore is the bridge ADR-0034 describes: the broker's tool call
// becomes the very same store call its HTTP route makes, so the payload the
// model reads is the payload the browser would have read (08-assistant.md's
// "one control source" rule). It holds no handle of its own and passes the
// caller through every method.
type assistantStore struct {
	projects  assistantProjectReader
	runs      assistantRunReader
	approvals assistantApprovalReader
	pipelines assistantPipelineReader
	profiles  assistantProfileReader
}

var _ assistant.Store = assistantStore{}

// assistantBriefStore is assistantStore plus the ADR-0081 brief read. It is a
// distinct type on purpose: the assistant decides which optional reads to
// announce by what its store handle can answer, and a deployment that mounted
// the assistant without the catch-up store must not announce a brief it cannot
// assemble (tools.go's announcedToolOrder).
type assistantBriefStore struct {
	assistantStore
	brief CatchUpBriefStore
}

var _ assistant.CatchUpBriefReader = assistantBriefStore{}

// CatchUpBrief answers the assistant's catchup.brief tool as this caller:
// the same assembled brief GET /catch-up/brief serves, through the same
// assembler, so the page and the chat answer cannot disagree about what
// happened. No headline is attached — that is the route's model-side half
// (attachHeadline), and the tool documents a payload with no model-written
// section in it anyway. An unknown window is the tool's mistake, not the
// caller's: the tool validates the vocabulary before asking.
func (a assistantBriefStore) CatchUpBrief(ctx context.Context, c assistant.Caller,
	window string) (json.RawMessage, error) {
	brief, err := AssembleCatchUpBrief(ctx, a.brief, asstCaller(c),
		CatchUpBriefScope{Window: strings.TrimSpace(window)}, time.Now())
	if err != nil {
		return nil, asstStoreErr(err)
	}
	return asstJSON(brief)
}

// assistantThreadStore is the v1 store handle plus the caller's thread read,
// and assistantBriefThreadStore is the same plus the ADR-0081 brief. There is
// one TYPE PER COMBINATION on purpose: the assistant decides which optional
// reads to announce by what its store handle can ANSWER
// (assistant.announcedToolOrder is a type assertion), and a wrapper that
// embedded the Store INTERFACE would promote only Store's own methods and
// silently unannounce catchup.brief on a deployment that wired both reads —
// which is exactly what serve wires. The combinations are pinned by
// internal/api/assistant_threads_test.go.
type assistantThreadStore struct {
	assistantStore
	threads assistantThreadReader
}

type assistantBriefThreadStore struct {
	assistantBriefStore
	threads assistantThreadReader
}

var (
	_ assistant.ThreadListReader   = assistantThreadStore{}
	_ assistant.ThreadListReader   = assistantBriefThreadStore{}
	_ assistant.CatchUpBriefReader = assistantBriefThreadStore{}
)

// assistantStoreHandle is the broker's store handle for ONE deployment: the six
// v1 reads, plus each optional read whose service is wired, in the type that
// answers exactly those reads and no others.
func assistantStoreHandle(store assistantStore, deps AssistantDeps) assistant.Store {
	switch {
	case deps.Brief != nil && deps.Threads != nil:
		return assistantBriefThreadStore{
			assistantBriefStore: assistantBriefStore{assistantStore: store, brief: deps.Brief},
			threads:             deps.Threads,
		}
	case deps.Brief != nil:
		return assistantBriefStore{assistantStore: store, brief: deps.Brief}
	case deps.Threads != nil:
		return assistantThreadStore{assistantStore: store, threads: deps.Threads}
	default:
		return store
	}
}

// assistantThreadFetchLimit is how deep the thread.list read goes: one page of
// the cross-project list (the store caps it at 200 and orders newest first),
// which is several times the 30 threads the tool may answer with, so the
// project / launcher / window filters after it have rows left to keep. It is
// not a dump — the rows are projected onto the tool's documented fields before
// the registry's byte cap sees them (assistant.compactThreadRow).
const assistantThreadFetchLimit = 100

// listAgentThreadsAs answers assistant.ThreadListReader off a wired reader: the
// cross-project thread list the /threads page reads, no scope filter (the tool
// owns the filters), through the same membership predicate in the store's SQL
// the route uses. Both combination types share it so their answers cannot drift.
func listAgentThreadsAs(reader assistantThreadReader, ctx context.Context,
	c assistant.Caller) (json.RawMessage, error) {
	if reader == nil {
		return nil, assistant.ErrNotFound
	}
	items, _, err := reader.ListVisibleConversations(ctx, asstCaller(c), assistantThreadFetchLimit, "")
	if err != nil {
		return nil, asstStoreErr(err)
	}
	return asstJSON(emptyIfNil(items))
}

func (a assistantThreadStore) ListAgentThreads(ctx context.Context, c assistant.Caller) (json.RawMessage, error) {
	return listAgentThreadsAs(a.threads, ctx, c)
}

func (a assistantBriefThreadStore) ListAgentThreads(ctx context.Context, c assistant.Caller) (json.RawMessage, error) {
	return listAgentThreadsAs(a.threads, ctx, c)
}

func asstCaller(c assistant.Caller) Caller {
	return Caller{UserID: c.UserID, OrganizationID: c.OrganizationID, IsOrgAdmin: c.IsOrgAdmin}
}

// asstJSON encodes a route payload; a nil slice is the empty array, never null,
// so the model reads "no rows" rather than an absence it can invent a meaning for.
func asstJSON(v any) (json.RawMessage, error) {
	blob, err := json.Marshal(v)
	if err != nil {
		return nil, err
	}
	if string(blob) == "null" {
		return json.RawMessage(`[]`), nil
	}
	return blob, nil
}

// asstStoreErr keeps the route's authorization vocabulary: the 404 family of
// ADR-0014 §3 (a resource you may not know exists) becomes assistant.ErrNotFound
// so the broker's refusal carries a code and no name, and the 403 family becomes
// assistant.ErrForbidden. Anything else stays an unavailable tool.
func asstStoreErr(err error) error {
	switch {
	case err == nil:
		return nil
	case errors.Is(err, ErrProjectNotFound), errors.Is(err, ErrRunNotFound),
		errors.Is(err, ErrApprovalNotFound), errors.Is(err, ErrPipelineNotFound),
		errors.Is(err, ErrConversationNotFound), errors.Is(err, ErrAssignmentNotFound):
		return fmt.Errorf("%w: %w", assistant.ErrNotFound, err)
	case errors.Is(err, ErrConversationForbidden), errors.Is(err, ErrProfileForbidden),
		errors.Is(err, ErrArtifactForbidden), errors.Is(err, ErrSecretForbidden):
		return fmt.Errorf("%w: %w", assistant.ErrForbidden, err)
	default:
		return err
	}
}

func (a assistantStore) ListProjects(ctx context.Context, c assistant.Caller) (json.RawMessage, error) {
	if a.projects == nil {
		return nil, assistant.ErrNotFound
	}
	items, err := a.projects.ListProjects(ctx, asstCaller(c))
	if err != nil {
		return nil, asstStoreErr(err)
	}
	return asstJSON(emptyIfNil(items))
}

func (a assistantStore) ListPipelines(ctx context.Context, c assistant.Caller) (json.RawMessage, error) {
	if a.pipelines == nil {
		return nil, assistant.ErrNotFound
	}
	items, err := a.pipelines.ListPipelines(ctx, asstCaller(c))
	if err != nil {
		return nil, asstStoreErr(err)
	}
	return asstJSON(emptyIfNil(items))
}

func (a assistantStore) ListProjectRuns(ctx context.Context, c assistant.Caller, projectID string) (json.RawMessage, error) {
	if a.runs == nil {
		return nil, assistant.ErrNotFound
	}
	items, err := a.runs.ListProjectRuns(ctx, asstCaller(c), projectID)
	if err != nil {
		return nil, asstStoreErr(err)
	}
	return asstJSON(emptyIfNil(items))
}

func (a assistantStore) ListRunNodes(ctx context.Context, c assistant.Caller, runID string) (json.RawMessage, error) {
	if a.runs == nil {
		return nil, assistant.ErrNotFound
	}
	items, err := a.runs.ListRunNodes(ctx, asstCaller(c), runID)
	if err != nil {
		return nil, asstStoreErr(err)
	}
	return asstJSON(emptyIfNil(items))
}

func (a assistantStore) ListProjectApprovals(ctx context.Context, c assistant.Caller, projectID string) (json.RawMessage, error) {
	if a.approvals == nil {
		return nil, assistant.ErrNotFound
	}
	items, err := a.approvals.ListProjectApprovals(ctx, asstCaller(c), projectID)
	if err != nil {
		return nil, asstStoreErr(err)
	}
	return asstJSON(emptyIfNil(items))
}

func (a assistantStore) ListPipelineRevisions(ctx context.Context, c assistant.Caller, pipelineID string) (json.RawMessage, error) {
	if a.pipelines == nil {
		return nil, assistant.ErrNotFound
	}
	items, err := a.pipelines.ListPipelineRevisions(ctx, asstCaller(c), pipelineID)
	if err != nil {
		return nil, asstStoreErr(err)
	}
	return asstJSON(emptyIfNil(items))
}

func (a assistantStore) ListAgentProfiles(ctx context.Context, c assistant.Caller) (json.RawMessage, error) {
	if a.profiles == nil {
		return nil, assistant.ErrNotFound
	}
	items, err := a.profiles.ListAgentProfiles(ctx, asstCaller(c))
	if err != nil {
		return nil, asstStoreErr(err)
	}
	return asstJSON(emptyIfNil(items))
}

// emptyIfNil turns a nil slice into a typed empty slice for the encoder. The
// generic parameter is what keeps this one helper cover all seven views.
func emptyIfNil[S ~[]E, E any](s S) any {
	if s == nil {
		var zero S
		return zero
	}
	return s
}
