package assistant

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"
)

// The workflow.draft read tool (lab evidence: the acceptance journey's
// "add a step to feature-development's draft" spent turns hunting the
// draft id through palette.search before it reached draft.get /
// draft.apply). It answers "what is the open draft of workflow X?" in
// ONE read fan, as the caller's own reads.

// DraftLocator is the narrow face behind workflow.draft. The runner
// type-asserts it on the wired DraftService: a service without it simply
// does not announce the tool (the honest-degradation rule — an absent
// service means the model never asks for it). Every read is the
// caller's own, so a workflow the caller cannot see is not in the
// caller's list and answers ErrNotFound: existence stays hidden (the
// 404 rule of internal/api/conversations.go).
type DraftLocator interface {
	PipelineDraft(ctx context.Context, c Caller, ref string) (PipelineDraftView, error)
}

// PipelineDraftView is the workflow.draft answer: the resolved workflow,
// its open draft (nil when there is none — the tool's hint then names
// the draft service's create-from-latest-revision behaviour) and its
// latest published revision (nil when nothing is published yet).
type PipelineDraftView struct {
	PipelineID  string
	Slug        string
	DisplayName string
	Draft       *OpenDraft
	LatestRev   *PublishedRevision
}

// OpenDraft is the workflow's open draft summary (the draft the user
// would see on the workflow page's drafts tab).
type OpenDraft struct {
	DraftID   string
	Version   int
	Status    string
	UpdatedAt time.Time
}

// PublishedRevision is the workflow's latest published revision summary.
type PublishedRevision struct {
	Number       int
	VersionLabel string
}

// execWorkflowDraft is workflow.draft (class read): the lookup as the
// caller through the draft service's locator face — the same store
// reads the user's own routes use, so a workflow the caller cannot see
// answers the not-found sentinel and existence stays hidden (the 404
// rule), and a lost read right is the stable forbidden refusal.
func (r *ConversationRunner) execWorkflowDraft(ctx context.Context, c Caller, call toolCallRequest, name string) execOutcome {
	tl, _ := r.localTool(name)
	args, err := parseToolArgs(tl, call.Function.Arguments)
	if err != nil {
		return execOutcome{call: ToolCall{Name: name, OK: false, Reason: "bad_arguments"}}
	}
	if r.locator == nil {
		return execOutcome{call: ToolCall{Name: name, OK: false, Reason: "unavailable"}}
	}
	view, err := r.locator.PipelineDraft(ctx, c, args["pipeline"])
	if err != nil {
		reason := "not_found"
		if errors.Is(err, ErrForbidden) {
			reason = "forbidden"
		}
		return execOutcome{call: ToolCall{Name: name, Args: stringArgView(args), OK: false, Reason: reason}}
	}
	summary := "Looked up workflow " + fallback(view.Slug, view.PipelineID)
	if view.Draft != nil {
		summary += " (open draft " + short(view.Draft.DraftID) + ", version " + fmt.Sprint(view.Draft.Version) + ")"
	} else {
		summary += " (no open draft)"
	}
	return execOutcome{
		call:    ToolCall{Name: name, Args: stringArgView(args), OK: true, Summary: bounded(summary, 200)},
		payload: workflowDraftPayload(view),
	}
}

// workflowDraftPayload is the tool result of a successful lookup: the
// resolved workflow (so the model can confirm it matched the right one),
// its open draft or the honest hint that there is none — naming the
// draft service's existing behaviour of opening a draft from the latest
// published revision — and the latest published revision.
func workflowDraftPayload(v PipelineDraftView) json.RawMessage {
	obj := map[string]any{
		"pipeline_id":  v.PipelineID,
		"slug":         v.Slug,
		"display_name": v.DisplayName,
		"draft":        nil,
	}
	if v.Draft != nil {
		obj["draft"] = map[string]any{
			"draft_id":   v.Draft.DraftID,
			"version":    v.Draft.Version,
			"status":     v.Draft.Status,
			"updated_at": v.Draft.UpdatedAt,
		}
	} else {
		obj["hint"] = "no open draft: draft.get or draft.apply with this pipeline id opens a draft from the latest published revision"
	}
	if v.LatestRev != nil {
		obj["latest_revision"] = map[string]any{
			"number":        v.LatestRev.Number,
			"version_label": v.LatestRev.VersionLabel,
		}
	} else {
		obj["latest_revision"] = nil
	}
	out, _ := json.Marshal(obj)
	return json.RawMessage(bounded(string(out), MaxResultBytes))
}
