package api

// ADR-0052: the approval summarization pass and free-text interpretation.
// Two routes over the existing model egress (ADR-0034's broker), both read-only
// and both authorized exactly like GET /approvals/{id}: a gate the caller
// cannot see answers the uniform 404.
//
//   * POST /approvals/{id}/summary — the model writes a short decider summary
//     and a small set of suggested actions from the gate summary + its
//     artifact references. Cached in memory keyed on the gate's `version`.
//   * POST /approvals/{id}/interpret — the model restates the approver's
//     free-text reply and PROPOSES a decision. It never decides: the UI shows
//     the proposal and the human calls the existing `decide` endpoint.
//
// Nothing here is persisted (no table; ADR-0052 explains the in-memory
// per-version cache) and nothing authorizes anything — the model is not a
// decider, only a reader over the caller's own gate.

import (
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"unicode/utf8"

	"github.com/dbirks/communication/internal/assistant"
)

// summaryGateMax bounds the gate summary and the artifact references sent to
// the model (the "bounded size" the ADR pins): a gate summary is already
// capped at 64 KiB by the schema, but the model turn only needs a working set.
const (
	summaryGateMax   = 16 << 10 // 16 KiB of gate summary
	summaryRefsMax   = 8 << 10  // 8 KiB of artifact references
	summaryCacheMax  = 256      // in-memory entries; overflow clears (honest)
	interpretTextMax = 2000     // runes of free-text reply (the ask route's bound)
)

// RegisterApprovalSummary mounts the two ADR-0052 routes. With no assistant
// egress the routes still answer — with 503 assistant_not_configured — so the
// UI keeps the gate's own summary + static Approve/Reject instead of a blank.
func RegisterApprovalSummary(s *Server, approvals ApprovalStore, cfg AssistantConfig) {
	h := &approvalSummaryHandlers{srv: s, approvals: approvals}
	broker, err := assistant.NewTextOnly(assistant.Config{
		BaseURL: cfg.BaseURL,
		APIKey:  cfg.APIKey,
		Model:   cfg.Model,
		Logger:  s.logger,
	})
	if err != nil {
		if !errors.Is(err, assistant.ErrNotConfigured) {
			// A configured-but-invalid endpoint is a deployment error the
			// operator must see; like the ask route, the route then answers 503.
			s.logger.Error("approval summary: assistant endpoint configured but unusable", "error", err.Error())
		}
	}
	h.broker = broker
	s.HandleAuthed("POST /api/v1/approvals/{approvalId}/summary", http.HandlerFunc(h.summary))
	s.HandleAuthed("POST /api/v1/approvals/{approvalId}/interpret", http.HandlerFunc(h.interpret))
}

type approvalSummaryHandlers struct {
	srv       *Server
	approvals ApprovalStore
	broker    *assistant.Broker

	mu     sync.Mutex
	cache  map[string]assistant.ApprovalSummary
	logger *slog.Logger
}

func (h *approvalSummaryHandlers) log() *slog.Logger {
	if h.logger != nil {
		return h.logger
	}
	if h.srv != nil {
		return h.srv.logger
	}
	return slog.Default()
}

// caller is the same principal-derived identity every approval route uses.
func (h *approvalSummaryHandlers) caller(w http.ResponseWriter, r *http.Request) (Caller, bool) {
	p, ok := PrincipalFrom(r.Context())
	if !ok {
		h.log().Error("approval summary: no principal in context")
		WriteProblem(w, http.StatusInternalServerError, "Internal Server Error", "api: no principal in context")
		return Caller{}, false
	}
	return Caller{UserID: p.UserID, OrganizationID: p.OrganizationID, IsOrgAdmin: p.IsOrgAdmin}, true
}

// loadGate is the shared authorization: the SAME store read GET /approvals/{id}
// makes, so a gate of a project the caller cannot see is ErrApprovalNotFound
// (the uniform 404, existence hidden).
func (h *approvalSummaryHandlers) loadGate(w http.ResponseWriter, r *http.Request, c Caller, approvalID string) (ApprovalView, bool) {
	ap, err := h.approvals.GetApproval(r.Context(), c, approvalID)
	if err != nil {
		switch {
		case errors.Is(err, ErrApprovalNotFound), errors.Is(err, ErrRunNotFound):
			WriteProblem(w, http.StatusNotFound, "Not Found", "No such approval.")
		default:
			h.log().ErrorContext(r.Context(), "approval summary: gate read failed",
				slog.String("approval_id", approvalID), slog.Any("error", err))
			WriteProblem(w, http.StatusInternalServerError, "Internal Server Error",
				"The server could not complete the request. Use the request id when reporting it.")
		}
		return ApprovalView{}, false
	}
	return ap, true
}

func notConfigured(w http.ResponseWriter) {
	writeAssistantProblem(w, http.StatusServiceUnavailable, "assistant_not_configured",
		"the assistant is not enabled on this deployment (COMMUNICATION_ASSISTANT_BASE_URL is unset)")
}

// summary answers POST /approvals/{id}/summary. The result is cached in memory
// keyed on (approval id, gate version): a gate's version increments exactly
// once, for exactly one decision, so a cached summary stays honest until the
// gate is decided (at which point the version changes and the cache misses).
func (h *approvalSummaryHandlers) summary(w http.ResponseWriter, r *http.Request) {
	c, ok := h.caller(w, r)
	if !ok {
		return
	}
	approvalID := r.PathValue("approvalId")
	ap, ok := h.loadGate(w, r, c, approvalID)
	if !ok {
		return
	}
	if h.broker == nil {
		notConfigured(w)
		return
	}

	key := approvalID + ":" + strconv.Itoa(ap.Version)
	if v, hit := h.cacheGet(key); hit {
		WriteJSON(w, http.StatusOK, v)
		return
	}

	gate := truncateBytes(ap.Summary, summaryGateMax)
	refs := truncateBytes(string(ap.ArtifactRefs), summaryRefsMax)
	out, fail := h.broker.SummarizeApproval(r.Context(), gate, refs)
	if fail != nil {
		writeAssistantProblem(w, fail.Status, fail.Code, fail.Detail)
		return
	}
	h.cachePut(key, out)
	WriteJSON(w, http.StatusOK, out)
}

// interpret answers POST /approvals/{id}/interpret. The model proposes a
// decision and note; it never writes one.
func (h *approvalSummaryHandlers) interpret(w http.ResponseWriter, r *http.Request) {
	c, ok := h.caller(w, r)
	if !ok {
		return
	}
	approvalID := r.PathValue("approvalId")
	var body struct {
		Text string `json:"text"`
	}
	if err := DecodeJSON(r, &body); err != nil {
		h.badRequest(w, err)
		return
	}
	reply := strings.TrimSpace(body.Text)
	switch {
	case reply == "":
		WriteProblem(w, http.StatusBadRequest, "Bad Request", "text is required.")
		return
	case utf8.RuneCountInString(reply) > interpretTextMax:
		WriteProblem(w, http.StatusBadRequest, "Bad Request",
			"text must be at most "+strconv.Itoa(interpretTextMax)+" characters.")
		return
	}
	ap, ok := h.loadGate(w, r, c, approvalID)
	if !ok {
		return
	}
	if h.broker == nil {
		notConfigured(w)
		return
	}

	gate := truncateBytes(ap.Summary, summaryGateMax)
	out, fail := h.broker.InterpretReply(r.Context(), gate, reply)
	if fail != nil {
		writeAssistantProblem(w, fail.Status, fail.Code, fail.Detail)
		return
	}
	WriteJSON(w, http.StatusOK, out)
}

// --- in-memory per-version cache ------------------------------------------

// cacheGet returns the cached summary for a key (approval id + version). A hit
// means the gate has not been decided since the summary was computed, so the
// cached text is still honest.
func (h *approvalSummaryHandlers) cacheGet(key string) (assistant.ApprovalSummary, bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.cache == nil {
		return assistant.ApprovalSummary{}, false
	}
	v, ok := h.cache[key]
	return v, ok
}

// cachePut stores a freshly computed summary for its key, evicting the whole
// map when it would exceed the bound.
func (h *approvalSummaryHandlers) cachePut(key string, v assistant.ApprovalSummary) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.cache == nil {
		h.cache = make(map[string]assistant.ApprovalSummary)
	}
	if len(h.cache) >= summaryCacheMax {
		// Honest eviction: a cache that cannot bound itself would be a leak.
		// Clearing is the simple, safe bound (summaries are recomputable).
		h.cache = make(map[string]assistant.ApprovalSummary)
	}
	h.cache[key] = v
}

func (h *approvalSummaryHandlers) badRequest(w http.ResponseWriter, err error) {
	status, title := http.StatusBadRequest, "Invalid Request Body"
	switch {
	case errors.Is(err, ErrBodyTooLarge):
		status, title = http.StatusRequestEntityTooLarge, "Request Body Too Large"
	case errors.Is(err, ErrBodyEmpty):
		status, title = http.StatusBadRequest, "Request Body Required"
	}
	WriteProblem(w, status, title, "The request body must be a JSON object matching this endpoint's schema.")
}

// truncateBytes clips s to n bytes without splitting a UTF-8 rune, so a large
// gate summary cannot inflate a model turn.
func truncateBytes(s string, n int) string {
	if len(s) <= n {
		return s
	}
	for n > 0 && (s[n]&0xC0) == 0x80 {
		n--
	}
	return s[:n]
}
