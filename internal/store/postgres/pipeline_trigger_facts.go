package postgres

// ADR-0066 step 2: the read behind the publish-time/validate-time WARNING.
//
// `input_unfillable_by_trigger` asks one question per (required input without
// a default, assigned trigger) pair: can this trigger put a value behind that
// input when it fires? The answer is rows, not guessing — an issue trigger
// carries its MAPPING (the explicit issue_input, or "" for the default
// single-github-issue-input rule) plus every name its template inputs carry;
// a schedule fills only the literal names of its own inputs object — a
// schedule fills no issue (ADR-0066 § Decision).
//
// What the read does NOT do is resolve that mapping. Which input a mapping
// names is a fact about the input specs it is applied to, and the warning is
// computed against the specs under validation — the DRAFT on the Inputs tab,
// the new revision at publish — by api.InputUnfillableWarnings. Baking the
// PINNED revision's resolution into these rows made a draft that had just
// gained its first github_issue input read as unfillable, because the
// revision the assignment was pinned to predated it (rcn-1j).
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
// name the warning quotes, the trigger's own inputs, its explicit issue_input
// mapping ("" = the default rule), and the trigger's own word.
//
// The seventh column is that word (`trigger_label` in the warning): a
// schedule's handle IS its cron expression, and an issue trigger's is its
// event — the row heading already names the repository, so the warning's
// sentence must not repeat it (rcn-1j review defect).
const pipelineTriggerFactsSQL = `
	SELECT 'schedule', s.id::text, s.project_id::text, s.cron_expr,
	       s.inputs::text, '', s.cron_expr
	FROM schedules s
	JOIN assignments a ON a.id = s.assignment_id
	JOIN pipelines p ON p.id = a.pipeline_id
	WHERE p.id = $1::uuid AND p.organization_id = $2::uuid AND s.enabled
	UNION ALL
	SELECT 'issue', t.id::text, t.project_id::text,
	       COALESCE(r.name, '?') || ' #' || t.event,
	       t.inputs::text, COALESCE(t.issue_input, ''), t.event
	FROM issue_triggers t
	JOIN assignments a ON a.id = t.assignment_id
	JOIN pipelines p ON p.id = a.pipeline_id
	JOIN repositories r ON r.id = t.repository_id
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
		)
		if err := rows.Scan(&fact.Kind, &fact.ID, &fact.ProjectID, &fact.Name, &inputs,
			&fact.IssueInput, &fact.Label); err != nil {
			return nil, fmt.Errorf("postgres: scan trigger fill facts: %w", err)
		}
		fills, err := triggerFillNames(json.RawMessage(inputs))
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

// triggerFillNames is the fills half of one fact row: the literal names the
// trigger's own inputs object carries — the names a fire stamps whatever it
// fires at. The issue trigger's github_issue mapping is NOT resolved here: it
// is carried as `IssueInput` and applied to the input specs under validation
// (api.InputUnfillableWarnings), so a draft's new issue input reads as
// fillable the moment the draft declares it.
func triggerFillNames(inputs json.RawMessage) ([]string, error) {
	values, _, err := scheduleCleanInputs(inputs)
	if err != nil {
		return nil, err
	}
	fills := issueTriggerInputNames(values) // sorted
	sort.Strings(fills)
	return fills, nil
}
