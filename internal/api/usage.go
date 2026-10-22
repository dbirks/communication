package api

// The "used by" usage reports behind the app-shell's Used-by panels (the
// design handoff's W5 backend unit): what workflows reference one agent
// profile or one node template, read from the stored graph JSON — the
// latest published revision of each pipeline plus each open draft — and
// answered as one bounded usage report.
//
// The vocabulary is settled by the handoff (docs/design/handoff-app-shell):
// Workflows = pipelines, Steps = node templates, Threads = one-off
// conversations, Take control = takeover (ADR-0043). The API vocabulary is
// unchanged unless an ADR says otherwise; this surface adds no new resource.

import (
	"errors"
	"net/http"
)

// UsageSource names where a workflow's use of a profile or a template was
// recorded: the workflow's LATEST published revision, or one of its open
// drafts. Old revisions never count (the latest published revision is the
// only current one; ADR-0021's immutability makes a revision's use final for
// its lifetime, but usage is reported against the current one).
type UsageSource string

const (
	UsageSourceRevision UsageSource = "revision"
	UsageSourceDraft    UsageSource = "draft"
)

// String renders the JSON member a client switches on.
func (s UsageSource) String() string {
	switch s {
	case UsageSourceDraft:
		return "draft"
	default:
		return "revision"
	}
}

// UsageUse is one row of a usage report: one node that references the
// subject (an agent profile or a node template) in one workflow.
type UsageUse struct {
	PipelineID   string      `json:"pipeline_id"`
	PipelineName string      `json:"pipeline_name"`
	Source       UsageSource `json:"source"`
	// RevisionNumber is the workflow's latest published revision the use
	// was found in; null for a use found in an open draft (ADR-0030's
	// nullable encoding: `type: ["integer", "null"]`, never `nullable`).
	RevisionNumber *int    `json:"revision_number"`
	DraftID        *string `json:"draft_id"`
	NodeID         string  `json:"node_id"`
	// NodeLabel is the human label of the referencing step; null when the
	// backend has no label to name it by (never a fabricated string).
	NodeLabel *string `json:"node_label"`
}

// AgentProfileUsage is GET /api/v1/agent-profiles/{profileId}/usage's body:
// the workflows that reference one agent profile.
type AgentProfileUsage struct {
	WorkflowCount int        `json:"workflow_count"`
	StepCount     int        `json:"step_count"`
	Uses          []UsageUse `json:"uses"`
	Truncated     bool       `json:"truncated"`
}

// NodeTemplateUsage is GET /api/v1/node-templates/{templateId}/usage's body:
// the same report shape, answered for one step template.
type NodeTemplateUsage struct {
	WorkflowCount int        `json:"workflow_count"`
	StepCount     int        `json:"step_count"`
	Uses          []UsageUse `json:"uses"`
	Truncated     bool       `json:"truncated"`
}

// usageMaxUses caps the uses array of one report; beyond the cap the
// response says so rather than silently truncating a count.
const usageMaxUses = 200

// --- agent-profile usage --------------------------------------------------

// getProfileUsage is GET /api/v1/agent-profiles/{profileId}/usage: the
// workflows that reference this agent profile. Read-only; any org member
// may ask, the answer is the caller's own organization's pipelines only.
func (h *cnvHandlers) getProfileUsage(w http.ResponseWriter, r *http.Request) {
	c, ok := h.caller(w, r)
	if !ok {
		return
	}
	profileID := r.PathValue("profileId")
	if !validUUID(profileID) {
		h.profileDenied(w, r, c, profileID, "profile.usage", "malformed profile id")
		WriteProblem(w, http.StatusNotFound, "Not Found", "No such agent profile.")
		return
	}
	usage, err := h.profiles.Usage(r.Context(), c, profileID)
	if err != nil {
		switch {
		case errors.Is(err, ErrProfileNotFound):
			h.profileDenied(w, r, c, profileID, "profile.usage",
				"no such agent profile, or it is not in your organization")
			WriteProblem(w, http.StatusNotFound, "Not Found", "No such agent profile.")
		default:
			h.serverError(w, r, cnvTarget{action: "profile.usage"}, err)
		}
		return
	}
	if usage.Uses == nil {
		usage.Uses = []UsageUse{}
	}
	WriteJSON(w, http.StatusOK, usage)
}

// --- node-template usage --------------------------------------------------

// getNodeTemplateUsage is GET /api/v1/node-templates/{templateId}/usage: the
// workflows that reference one step template. Read-only; any org member may
// ask, the answer is the caller's own organization's pipelines only.
func (h *ntHandlers) getNodeTemplateUsage(w http.ResponseWriter, r *http.Request) {
	c, ok := h.caller(w, r)
	if !ok {
		return
	}
	templateID := r.PathValue("templateId")
	if !validUUID(templateID) {
		h.denied(w, r, c, templateID, "no such object, or it is not visible to your organization")
		WriteProblem(w, http.StatusNotFound, "Not Found", "No such object.")
		return
	}
	usage, err := h.store.Usage(r.Context(), c, templateID)
	if err != nil {
		h.fail(w, r, c, templateID, err)
		return
	}
	if usage.Uses == nil {
		usage.Uses = []UsageUse{}
	}
	WriteJSON(w, http.StatusOK, usage)
}
