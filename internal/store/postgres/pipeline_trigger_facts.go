package postgres

// ADR-0066 step 2: the read behind the publish-time WARNING.
//
// `input_unfillable_by_trigger` asks one question per (required input without
// a default, assigned trigger) pair: can this trigger put a value behind that
// input when it fires? The answer is rows, not guessing — an issue trigger
// fills its mapped github_issue input (the explicit issue_input or the
// single-issue-input default, resolved against the PINNED revision's plan,
// the same resolution the fire itself uses) plus every name its template
// inputs carry; a schedule fills only the literal names of its own inputs
// object — a schedule fills no issue (ADR-0066 § Decision).
//
// The scope is the PIPELINE, not the project: the warning serves the org-level
// pipeline editor (validate/publish), so every assignment of the caller's
// organization counts, and a pipeline of another organization answers the
// empty list exactly like one that has no triggers at all.

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"

	"github.com/dbirks/communication/internal/api"
)

// pipelineTriggerFactsSQL reads the enabled triggers behind every assignment
// of one pipeline in the caller's organization: kind, id, project, the human
// name the warning quotes, the trigger's own inputs, and the explicit
// issue_input mapping plus the pinned revision's plan (empty-text fragments
// for the schedule arms, which resolve nothing).
const pipelineTriggerFactsSQL = `
	SELECT 'schedule', s.id::text, s.project_id::text, s.cron_expr,
	       s.inputs::text, '', '{}'::jsonb
	FROM schedules s
	JOIN assignments a ON a.id = s.assignment_id
	JOIN pipelines p ON p.id = a.pipeline_id
	WHERE p.id = $1::uuid AND p.organization_id = $2::uuid AND s.enabled
	UNION ALL
	SELECT 'issue', t.id::text, t.project_id::text,
	       COALESCE(r.name, '?') || ' #' || t.event,
	       t.inputs::text, COALESCE(t.issue_input, ''), r2.compiled_plan
	FROM issue_triggers t
	JOIN assignments a ON a.id = t.assignment_id
	JOIN pipelines p ON p.id = a.pipeline_id
	JOIN repositories r ON r.id = t.repository_id
	JOIN pipeline_revisions r2 ON r2.id = a.pinned_revision_id
	WHERE p.id = $1::uuid AND p.organization_id = $2::uuid AND t.enabled
	ORDER BY 1, 2`

// ListPipelineTriggerFacts implements api.TriggerFactStore.
func (a APIPipelineStore) ListPipelineTriggerFacts(ctx context.Context, c api.Caller,
	pipelineID string) ([]api.TriggerFillFacts, error) {
	pool, err := a.pool()
	if err != nil {
		return nil, err
	}
	if !prjValidUUID(pipelineID) {
		return []api.TriggerFillFacts{}, nil
	}
	rows, err := pool.Query(ctx, pipelineTriggerFactsSQL, pipelineID, c.OrganizationID)
	if err != nil {
		return nil, fmt.Errorf("postgres: list trigger fill facts for pipeline %s: %w", pipelineID, err)
	}
	defer rows.Close()

	out := []api.TriggerFillFacts{}
	for rows.Next() {
		var (
			fact   api.TriggerFillFacts
			inputs string
			issue  string
			plan   []byte
		)
		if err := rows.Scan(&fact.Kind, &fact.ID, &fact.ProjectID, &fact.Name, &inputs, &issue, &plan); err != nil {
			return nil, fmt.Errorf("postgres: scan trigger fill facts: %w", err)
		}
		fills, err := triggerFillNames(json.RawMessage(inputs), fact.Kind, issue, json.RawMessage(plan))
		if err != nil {
			return nil, fmt.Errorf("postgres: trigger %s %s fill names: %w", fact.Kind, fact.ID, err)
		}
		fact.Fills = fills
		out = append(out, fact)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("postgres: read trigger fill facts: %w", err)
	}
	return out, nil
}

// triggerFillNames is the fills half of one fact row: the names the trigger's
// own inputs object carries, plus — for an issue trigger — the resolved
// github_issue mapping. An unusable mapping (a legacy row whose default went
// ambiguous under a re-pin) contributes only its literal names, exactly like
// the fire, which fills nothing there rather than guessing.
func triggerFillNames(inputs json.RawMessage, kind, issueInput string, plan json.RawMessage) ([]string, error) {
	values, _, err := scheduleCleanInputs(inputs)
	if err != nil {
		return nil, err
	}
	fills := issueTriggerInputNames(values) // sorted
	if kind == "issue" {
		if fill, err := resolveIssueTriggerInput(plan, issueInput); err == nil && fill != "" {
			if _, dup := values[fill]; !dup {
				fills = append(fills, fill)
			}
		}
	}
	sort.Strings(fills)
	return fills, nil
}
