package postgres

// The "used by" usage reports behind GET /api/v1/agent-profiles/{id}/usage
// and GET /api/v1/node-templates/{id}/usage. Read-only scans over the stored
// graph JSON — the compiled plan a published revision carries (ADR-0021's
// canonical document is the authored text, the compiled plan is the
// machine-readable graph the usage walk reads) — over the LATEST published
// revision plus each OPEN draft of the caller's organization.
//
// No migration, no new table, no cached count: the report is computed from
// the rows the product already writes (publish stamps the pipeline_revision_
// template_refs pins; ADR-0049 §2.4 writes them in the same transaction as the
// revision), and drafts carry the compiled plan of their last validation.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"

	"github.com/jackc/pgx/v5"

	"github.com/dbirks/communication/internal/api"
)

// usageMaxUses caps the uses array of one report; beyond the cap the
// response says so rather than silently truncating a count.
const usageMaxUses = 200

var (
	_ api.ProfileStore      = APIConversationStore{}
	_ api.ProfileStore      = (*APIConversationStore)(nil)
	_ api.NodeTemplateStore = APINodeTemplateStore{}
	_ api.NodeTemplateStore = (*APINodeTemplateStore)(nil)
)

// usageSource is one graph source a usage report walks: the LATEST
// published revision of a pipeline, or one of its open drafts. A pipeline
// with both counts once in workflow_count; its uses are separate rows.
type usageSource struct {
	PipelineID     string
	PipelineName   string
	Source         api.UsageSource
	RevisionNumber int
	DraftID        string
	CompiledPlan   json.RawMessage
}

// usageTemplateRef pins one node to one template revision (ADR-0049 §2.3).
type usageTemplateRef struct {
	TemplateID string `json:"template_id"`
}

// usageNode is the slice of one compiled plan the usage walk reads.
type usageNode struct {
	ID           string             `json:"id"`
	Profile      string             `json:"profile,omitempty"`
	TemplateRefs []usageTemplateRef `json:"templateRefs,omitempty"`
}

// usagePlan is the compiled-plan envelope the usage walk reads.
type usagePlan struct {
	Nodes []usageNode `json:"nodes"`
}

// usageSources returns every source of one organization — the latest
// published revision and every open draft of each of its (non-archived)
// pipelines — for the usage walk. The visibility predicate is the
// organization's, in SQL; a foreign organization's pipelines answer no rows.
func usageSources(ctx context.Context, q prjQuerier, orgID string) ([]usageSource, error) {
	out := []usageSource{}

	rows, err := q.Query(ctx, `
		SELECT p.id::text, p.display_name, pr.revision_number, ''::text, pr.compiled_plan
		FROM pipelines p
		JOIN pipeline_revisions pr ON pr.pipeline_id = p.id
		WHERE p.organization_id = $1::uuid AND p.archived_at IS NULL AND pr.status = 'published'
		  AND pr.revision_number = (SELECT max(pr2.revision_number) FROM pipeline_revisions pr2
		                             WHERE pr2.pipeline_id = p.id)
		ORDER BY p.display_name, pr.revision_number`, orgID)
	if err != nil {
		return nil, fmt.Errorf("postgres: api usage sources (revision): %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var src usageSource
		var plan json.RawMessage
		if err := rows.Scan(&src.PipelineID, &src.PipelineName, &src.RevisionNumber, &src.DraftID, &plan); err != nil {
			return nil, fmt.Errorf("postgres: scan api usage source: %w", err)
		}
		src.Source = api.UsageSourceRevision
		src.CompiledPlan = plan
		out = append(out, src)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("postgres: read api usage sources: %w", err)
	}

	rows, err = q.Query(ctx, `
		SELECT p.id::text, p.display_name, 0, d.id::text, d.compiled_plan
		FROM pipeline_drafts d
		JOIN pipelines p ON p.id = d.pipeline_id
		WHERE p.organization_id = $1::uuid AND p.archived_at IS NULL AND d.status <> 'published'
		ORDER BY p.display_name, d.updated_at DESC`, orgID)
	if err != nil {
		return nil, fmt.Errorf("postgres: api usage sources (draft): %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var src usageSource
		var plan json.RawMessage
		if err := rows.Scan(&src.PipelineID, &src.PipelineName, &src.RevisionNumber, &src.DraftID, &plan); err != nil {
			return nil, fmt.Errorf("postgres: scan api usage source: %w", err)
		}
		src.Source = api.UsageSourceDraft
		src.CompiledPlan = plan
		out = append(out, src)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("postgres: read api usage sources: %w", err)
	}
	return out, nil
}

// usageNodes reads one compiled plan into its node slice; an empty plan
// (an unvalidated draft) has no nodes.
func usageNodes(plan json.RawMessage) ([]usageNode, error) {
	if len(plan) == 0 {
		return nil, nil
	}
	var p usagePlan
	if err := json.Unmarshal(plan, &p); err != nil {
		return nil, fmt.Errorf("postgres: read usage compiled plan: %w", err)
	}
	return p.Nodes, nil
}

// usageUses flattens one subject's references across every source into
// report rows, ordered deterministically. A use found in a published
// revision carries revision_number + null draft_id; a use found in an open
// draft carries the draft_id + null revision_number.
func usageUses(ctx context.Context, q prjQuerier, orgID, subjectID, subjectLabel string, byTemplate bool) ([]api.UsageUse, error) {
	srcs, err := usageSources(ctx, q, orgID)
	if err != nil {
		return nil, err
	}
	var uses []api.UsageUse
	for _, src := range srcs {
		nodes, err := usageNodes(src.CompiledPlan)
		if err != nil {
			return nil, err
		}
		for _, n := range nodes {
			if byTemplate {
				for _, ref := range n.TemplateRefs {
					if ref.TemplateID != subjectID {
						continue
					}
					var revisionNumber *int
					var draftID *string
					if src.Source == api.UsageSourceRevision {
						v := src.RevisionNumber
						revisionNumber = &v
					} else {
						draftID = &src.DraftID
					}
					uses = append(uses, api.UsageUse{
						PipelineID:     src.PipelineID,
						PipelineName:   src.PipelineName,
						Source:         src.Source,
						RevisionNumber: revisionNumber,
						DraftID:        draftID,
						NodeID:         n.ID,
						NodeLabel:      &subjectLabel,
					})
				}
				continue
			}
			if n.Profile != subjectLabel {
				continue
			}
			var revisionNumber *int
			var draftID *string
			if src.Source == api.UsageSourceRevision {
				v := src.RevisionNumber
				revisionNumber = &v
			} else {
				draftID = &src.DraftID
			}
			uses = append(uses, api.UsageUse{
				PipelineID:     src.PipelineID,
				PipelineName:   src.PipelineName,
				Source:         src.Source,
				RevisionNumber: revisionNumber,
				DraftID:        draftID,
				NodeID:         n.ID,
				NodeLabel:      &subjectLabel,
			})
		}
	}
	return uses, nil
}

// usageReport shapes one subject's uses into the wire report: the number
// of workflows that use it, the number of step uses, the capped uses and
// whether the cap bit is set.
func usageReport(uses []api.UsageUse) (api.AgentProfileUsage, api.NodeTemplateUsage) {
	sort.SliceStable(uses, func(i, j int) bool {
		if uses[i].PipelineName != uses[j].PipelineName {
			return uses[i].PipelineName < uses[j].PipelineName
		}
		if uses[i].Source != uses[j].Source {
			return uses[i].Source < uses[j].Source
		}
		return uses[i].NodeID < uses[j].NodeID
	})
	workflowCount := 0
	seen := map[string]bool{}
	for _, u := range uses {
		if !seen[u.PipelineID] {
			seen[u.PipelineID] = true
			workflowCount++
		}
	}
	stepCount := len(uses)
	truncated := false
	out := uses
	if len(uses) > usageMaxUses {
		out = uses[:usageMaxUses]
		truncated = true
	}
	return api.AgentProfileUsage{
		WorkflowCount: workflowCount,
		StepCount:     stepCount,
		Uses:          out,
		Truncated:     truncated,
	}, api.NodeTemplateUsage{
		WorkflowCount: workflowCount,
		StepCount:     stepCount,
		Uses:          out,
		Truncated:     truncated,
	}
}

// Usage implements api.ProfileStore.Usage: the workflows that reference
// this agent profile. The subject is resolved inside the caller's
// organization (a foreign profile answers ErrProfileNotFound, byte-identical
// to nonsense), then the org's sources are walked for the profile's name.
func (a APIConversationStore) Usage(ctx context.Context, c api.Caller, profileID string) (api.AgentProfileUsage, error) {
	s, err := a.store()
	if err != nil {
		return api.AgentProfileUsage{}, err
	}
	if err := prjRequireCaller(callerFromAPI(c)); err != nil {
		return api.AgentProfileUsage{}, err
	}
	if !prjValidUUID(profileID) {
		return api.AgentProfileUsage{}, ErrProfileNotFound
	}
	var subjectID, subjectLabel string
	if err := s.Pool.QueryRow(ctx,
		`SELECT id::text, name FROM agent_profiles WHERE id = $1::uuid AND organization_id = $2::uuid`,
		profileID, c.OrganizationID).Scan(&subjectID, &subjectLabel); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return api.AgentProfileUsage{}, ErrProfileNotFound
		}
		return api.AgentProfileUsage{}, fmt.Errorf("postgres: api usage agent profile %s: %w", profileID, err)
	}
	uses, err := usageUses(ctx, s.Pool, c.OrganizationID, subjectID, subjectLabel, false)
	if err != nil {
		return api.AgentProfileUsage{}, err
	}
	usage, _ := usageReport(uses)
	return usage, nil
}

// Usage implements api.NodeTemplateStore.Usage: the workflows that reference
// this step template. The template is resolved inside the caller's
// organization (a foreign template answers ErrNodeTemplateNotFound), then
// the org's sources are walked for its id.
func (a APINodeTemplateStore) Usage(ctx context.Context, c api.Caller, templateID string) (api.NodeTemplateUsage, error) {
	pool, err := a.pool()
	if err != nil {
		return api.NodeTemplateUsage{}, err
	}
	if err := prjRequireCaller(callerFromAPI(c)); err != nil {
		return api.NodeTemplateUsage{}, err
	}
	if !prjValidUUID(templateID) {
		return api.NodeTemplateUsage{}, api.ErrNodeTemplateNotFound
	}
	var subjectLabel string
	if err := pool.QueryRow(ctx,
		`SELECT display_name FROM node_templates WHERE id = $1::uuid AND organization_id = $2::uuid`,
		templateID, c.OrganizationID).Scan(&subjectLabel); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return api.NodeTemplateUsage{}, api.ErrNodeTemplateNotFound
		}
		return api.NodeTemplateUsage{}, fmt.Errorf("postgres: api usage node template %s: %w", templateID, err)
	}
	uses, err := usageUses(ctx, pool, c.OrganizationID, templateID, subjectLabel, true)
	if err != nil {
		return api.NodeTemplateUsage{}, err
	}
	_, report := usageReport(uses)
	return report, nil
}
