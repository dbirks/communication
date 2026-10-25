package api

// POST /api/v1/assistant/draft-proposals (ADR-0044): the assistant proposes
// ONE structural change to a draft from a closed operation set, validated
// against the draft itself. The server NEVER writes the draft: the response
// is a read of the draft plus one model call through the ADR-0034 broker,
// and the human applies the proposal with the normal version-checked PUT —
// so the proposal widens no authorization boundary and can never publish.

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/dbirks/communication/internal/assistant"
)

// ErrDraftForbidden is the 403 family of the draft proposal route: the
// caller can SEE the draft but may not WRITE it. The predicate the draft
// write applies today is the org-visibility check the committed store runs
// on ReplaceDraft (a draft of another organization answers the not-found
// sentinel, ADR-0014 §3 — so a caller who cannot see the draft gets 404,
// never 403, and existence stays hidden). A store that later splits the
// read and write predicates answers with THIS sentinel and the route maps
// it to 403; the adapter passes whatever the store says through.
var ErrDraftForbidden = errors.New("api: the caller may see the draft but may not write it")

// assistantProposalInvalidCode is the 422 problem code the UI branches on:
// the model's output was not one of the closed ops as applied to THIS
// draft. The detail names the reason (unknown_op, unknown_kind, bad_id,
// id_taken, unknown_node, target_has_dependents, no_edge, scope_mismatch,
// guarded_target, condition_source, error_route, edge_guarded, wrong_kind,
// prompt_kind_not_supported, empty_prompt).
const assistantProposalInvalidCode = "assistant_proposal_invalid"

// assistantDraftProposalInstructionCap is the instruction length bound
// (characters, per the ADR's request shape).
const assistantDraftProposalInstructionCap = 2000

// AssistantDraftProposalRequest is the request body: which draft at which
// version, and what the human asked for. draft_id travels in the body — the
// route is not a resource route; the draft is identified by the caller's own
// read, never by a path parameter a stranger could probe.
type AssistantDraftProposalRequest struct {
	DraftID     string `json:"draft_id"`
	Version     int    `json:"version"`
	Instruction string `json:"instruction"`
}

// AssistantDraftProposalResponse is the 200 body: the VALIDATED op (extra
// model fields were dropped by the typed decode), the node ids the UI
// highlights, the model's one-line summary and the draft version the
// proposal was checked against (the Apply PUT must echo it).
type AssistantDraftProposalResponse struct {
	Op      assistant.Proposal `json:"op"`
	NodeIDs []string           `json:"node_ids"`
	Summary string             `json:"summary"`
	Version int                `json:"version"`
}

func (h *asstHandlers) proposals(w http.ResponseWriter, r *http.Request) {
	c, ok := h.proposalCaller(w, r)
	if !ok {
		return
	}
	var body AssistantDraftProposalRequest
	if err := DecodeJSON(r, &body); err != nil {
		WriteProblem(w, http.StatusBadRequest, "Bad Request", err.Error())
		return
	}
	body.DraftID = strings.TrimSpace(body.DraftID)
	body.Instruction = strings.TrimSpace(body.Instruction)
	switch {
	case body.DraftID == "":
		WriteProblem(w, http.StatusBadRequest, "Bad Request", "draft_id is required.")
		return
	case body.Instruction == "":
		WriteProblem(w, http.StatusBadRequest, "Bad Request", "instruction is required.")
		return
	case utf8.RuneCountInString(body.Instruction) > assistantDraftProposalInstructionCap:
		WriteProblem(w, http.StatusBadRequest, "Bad Request",
			"instruction must be at most "+fmt.Sprintf("%d", assistantDraftProposalInstructionCap)+" characters.")
		return
	case body.Version < 1:
		WriteProblem(w, http.StatusBadRequest, "Bad Request", "version must be at least 1.")
		return
	}
	if h.broker == nil {
		// The feature is off: the same honest 503 the ask route answers
		// (ADR-0044 § 3 reuses ADR-0034's single egress site; no second
		// configuration exists).
		writeAssistantProblem(w, http.StatusServiceUnavailable, "assistant_not_configured",
			"the assistant is not enabled on this deployment (COMMUNICATION_ASSISTANT_BASE_URL is unset)")
		return
	}
	if h.drafts == nil {
		WriteProblem(w, http.StatusInternalServerError, "Internal Server Error",
			"api: the draft store is not wired to the assistant")
		return
	}

	// 1. Authorization = "may PUT this draft": the caller's own read of the
	// row, so a draft the caller cannot see is not-found (existence hidden)
	// and a draft the store says the caller may not write is 403.
	draft, err := h.drafts.GetDraft(r.Context(), c, body.DraftID)
	if err != nil {
		h.proposalDraftError(w, err)
		return
	}

	// 2. The proposal is checked at the version the UI is editing; a
	// mismatch is the SAME 409 the PUT answers (stale_draft_version with the
	// winner's version), so an applied proposal and a keystroke PUT share
	// one stale-draft story.
	if draft.Version != body.Version {
		m4WriteDraftConflict(w, &DraftConflictError{
			Kind: DraftConflictStaleVersion, DraftID: draft.ID, CurrentVersion: draft.Version,
			Detail: fmt.Sprintf("draft version is %d, not %d.", draft.Version, body.Version),
		})
		return
	}

	// 3. The draft's own bytes through the SAME loader the validate path
	// runs. A document the loader refuses cannot be proposed on.
	doc, err := assistant.LoadDraftDoc([]byte(draft.DocumentYAML))
	if err != nil {
		writeAssistantProposalProblem(w, "the draft cannot be proposed on: "+err.Error())
		return
	}

	// 4. ONE completion through the ADR-0034 broker (no tool loop): the
	// compact node summary plus the caller's profile list, never a config
	// value or a secret. CompleteText may re-ask a PROPOSAL answer exactly
	// once — when it is shape-malformed OR when it parses but the draft's
	// own structural rules refuse it; the two share the single re-ask
	// (assistant.CompleteText, ADR-0044 amendments 2026-10-25 and
	// 2026-10-26); when even that re-ask fails it returns the FIRST answer,
	// so the failure mapping below is the original answer's story.
	summaries, err := json.Marshal(doc.Summaries())
	if err != nil {
		h.proposalServer(w, r, err)
		return
	}
	system, user := assistant.ProposalPrompt(summaries, h.proposalProfiles(r), body.Instruction)
	raw, fail := h.broker.CompleteText(r.Context(), system, user)
	if fail != nil {
		// The same failure mapping the ask route uses: 503 unreachable,
		// 504 timeout, 502 malformed — each naming the cause in degraded.
		writeAssistantProblem(w, fail.Status, fail.Code, fail.Detail)
		return
	}

	// 5. The model's answer is untrusted input: exactly one JSON object from
	// the closed set, validated against THIS draft (a one-element array
	// around a valid object is unwrapped). Anything else is a 422 with the
	// reason named — the broker's single corrective re-ask was already spent
	// upstream in CompleteText, shared by malformed and structurally refused
	// answers (ADR-0044 amendments 2026-10-25 and 2026-10-26); this route
	// never asks the model again. The checks here stay authoritative: the
	// broker re-runs them only on the draft data the prompt carried, so an
	// error_route or edge_guarded refusal (config bytes never travel to the
	// model) surfaces here as the single-call 422 it always was.
	p, err := assistant.ExtractProposal(raw)
	if err != nil {
		writeAssistantProposalProblem(w, err.Error())
		return
	}
	if verr := assistant.ValidateProposal(doc, p); verr != nil {
		writeAssistantProposalProblem(w, verr.Error())
		return
	}

	// 6. The response names the touched nodes so the Studio canvas can
	// highlight them (data-highlight="assistant-proposed"), and the version
	// the proposal was checked against so the Apply PUT can CAS on it. The
	// draft row was only READ: version and bytes are exactly as found.
	WriteJSON(w, http.StatusOK, AssistantDraftProposalResponse{
		Op:      p,
		NodeIDs: proposalTouchedIDs(p),
		Summary: p.Summary,
		Version: draft.Version,
	})
}

// proposalCaller is the session principal reduced to the caller's own
// identity — the route's authorizer is the caller, never a broker handle.
func (h *asstHandlers) proposalCaller(w http.ResponseWriter, r *http.Request) (Caller, bool) {
	p, ok := PrincipalFrom(r.Context())
	if !ok {
		WriteProblem(w, http.StatusInternalServerError, "Internal Server Error",
			"api: no principal in context")
		return Caller{}, false
	}
	return Caller{UserID: p.UserID, OrganizationID: p.OrganizationID, IsOrgAdmin: p.IsOrgAdmin}, true
}

// proposalDraftError maps the draft store's error onto the route's contract:
// the not-found sentinel is the uniform 404 (a draft of another organization
// and a nonsense id answer identically), the forbidden sentinel is a plain
// 403, everything else is a server error.
func (h *asstHandlers) proposalDraftError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, ErrPipelineNotFound):
		WriteProblem(w, http.StatusNotFound, "Not Found", "No such object.")
	case errors.Is(err, ErrDraftForbidden):
		WriteProblem(w, http.StatusForbidden, "Forbidden",
			"You cannot write this draft.")
	default:
		h.proposalServer(w, nil, err)
	}
}

func (h *asstHandlers) proposalServer(w http.ResponseWriter, r *http.Request, err error) {
	h.srv.logger.Error("assistant draft proposal failed", "error", err.Error())
	WriteProblem(w, http.StatusInternalServerError, "Internal Server Error", "The draft proposal could not be completed.")
}

// proposalProfiles best-effort lists the caller's agent profile names for
// the prompt (an agent.acp config must pick one). A failure degrades the
// prompt, never the request.
func (h *asstHandlers) proposalProfiles(r *http.Request) []string {
	if h.profiles == nil {
		return nil
	}
	items, err := h.profiles.ListAgentProfiles(r.Context(), h.proposalCallerValue(r))
	if err != nil {
		return nil
	}
	out := make([]string, 0, len(items))
	for _, p := range items {
		if p.Name != "" {
			out = append(out, p.Name)
		}
	}
	return out
}

func (h *asstHandlers) proposalCallerValue(r *http.Request) Caller {
	p, _ := PrincipalFrom(r.Context())
	return Caller{UserID: p.UserID, OrganizationID: p.OrganizationID, IsOrgAdmin: p.IsOrgAdmin}
}

// proposalTouchedIDs names every node the applied op would move: the new
// node plus the endpoints of the edge it rewrites.
func proposalTouchedIDs(p assistant.Proposal) []string {
	switch p.Op {
	case assistant.OpInsertAfter:
		return []string{p.ID, p.After}
	case assistant.OpInsertOnEdge:
		return []string{p.ID, p.From, p.To}
	default:
		return []string{p.Node}
	}
}

// writeAssistantProposalProblem renders the 422: the stable code the UI
// branches on, with the typed reason (and the node it names) in the detail.
func writeAssistantProposalProblem(w http.ResponseWriter, detail string) {
	m4WriteTypedProblemExtra(w, http.StatusUnprocessableEntity, assistantProposalInvalidCode,
		"Assistant Proposal Invalid", detail, struct {
			Code string `json:"code"`
		}{Code: assistantProposalInvalidCode})
}
