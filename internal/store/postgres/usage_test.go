package postgres

// TestUsageReports: the "used by" reports behind GET /api/v1/agent-profiles/
// {profileId}/usage and GET /api/v1/node-templates/{templateId}/usage, against
// a real Postgres. The fixtures are seeded with raw SQL (the same idiom the
// m4 migration tests use) and the assertions are over the reports the store
// builds from the stored graph JSON: latest published revision + open drafts,
// old revisions ignored, other organizations excluded, invisible subject →
// not found.

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/dbirks/communication/internal/api"
)

// usagePlanJSON builds one compiled-plan object whose node carries a profile
// name, plus an optional template pin on that node.
func usagePlanJSON(nodeID, profile, templateID string) string {
	node := map[string]any{"id": nodeID, "kind": "agent.acp", "scope": "/", "profile": profile}
	if templateID != "" {
		node["templateRefs"] = []map[string]string{{"template_id": templateID}}
	}
	doc := map[string]any{"api_version": "communication.dev/v1alpha1", "kind": "Pipeline", "name": "Usage"}
	plan := map[string]any{
		"version":      "v1",
		"digest_scope": "v1alpha1-canonical-1",
		"cel_version":  "v1",
		"document":     doc,
		"inputs":       map[string]any{},
		"outputs":      map[string]any{},
		"policies":     map[string]any{"maxConcurrentNodes": 4},
		"scopes":       []map[string]any{{"key": "/", "kind": "root", "entryNodes": []string{nodeID}, "terminalNodes": []string{}}},
		"nodes":        []map[string]any{node},
	}
	b, err := json.Marshal(plan)
	if err != nil {
		panic(err)
	}
	return string(b)
}

// usageSetup opens the migrated test database and a scratch organization the
// usage fixtures own without touching the shared 'default' org.
func usageSetup(t *testing.T) (ctx context.Context, pool *pgxpool.Pool, orgID string, userID string) {
	t.Helper()
	ctx = testCtx(t)
	pool, err := Open(ctx, mustMigrate(t))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(pool.Close)
	bg := context.Background()
	if err := pool.QueryRow(bg,
		`INSERT INTO organizations (slug, name) VALUES ('usage-org', 'Usage org') RETURNING id`).Scan(&orgID); err != nil {
		t.Fatalf("insert usage org: %v", err)
	}
	if err := pool.QueryRow(bg,
		`INSERT INTO users (organization_id, display_name) VALUES ($1, 'usage-user') RETURNING id`,
		orgID).Scan(&userID); err != nil {
		t.Fatalf("insert usage user: %v", err)
	}
	t.Cleanup(func() {
		bg := context.Background()
		pool.Exec(bg, `DELETE FROM pipeline_revision_template_refs WHERE pipeline_revision_id IN
			(SELECT id FROM pipeline_revisions WHERE organization_id = $1::uuid)`, orgID)
		pool.Exec(bg, `DELETE FROM pipeline_revisions WHERE organization_id = $1::uuid`, orgID)
		pool.Exec(bg, `DELETE FROM pipeline_drafts WHERE pipeline_id IN
			(SELECT id FROM pipelines WHERE organization_id = $1::uuid)`, orgID)
		pool.Exec(bg, `DELETE FROM pipelines WHERE organization_id = $1::uuid`, orgID)
		pool.Exec(bg, `DELETE FROM agent_profile_versions WHERE organization_id = $1::uuid`, orgID)
		pool.Exec(bg, `DELETE FROM agent_profiles WHERE organization_id = $1::uuid`, orgID)
		pool.Exec(bg, `DELETE FROM node_templates WHERE organization_id = $1::uuid`, orgID)
		pool.Exec(bg, `DELETE FROM users WHERE id = $1::uuid`, userID)
		pool.Exec(bg, `DELETE FROM organizations WHERE id = $1::uuid`, orgID)
	})
	return ctx, pool, orgID, userID
}

// usageDraft inserts one draft (any status) and returns its id. The compiled
// plan is inlined as a JSON literal: the fixture's plan is a literal string,
// and the parameter path for jsonb through pgx here is not worth fighting.
func usageDraft(t *testing.T, ctx context.Context, pool *pgxpool.Pool, pipeID, status, plan, sourceSHA, editedBy string) string {
	t.Helper()
	sqlText := fmt.Sprintf(`INSERT INTO pipeline_drafts (pipeline_id, status, document_text, source_sha256, edited_by, version, canonical_document, compiled_plan)
		VALUES ($1::uuid, $2, 'kind: Pipeline', $3, $4::uuid, 1, '{"kind":"Pipeline"}'::jsonb, '%s'::jsonb) RETURNING id`, plan)
	var id string
	if err := pool.QueryRow(ctx, sqlText, pipeID, status, sourceSHA, editedBy).Scan(&id); err != nil {
		t.Fatalf("insert draft: %v", err)
	}
	return id
}

// usageRevision inserts one revision (status) off a draft and returns its id.
func usageRevision(t *testing.T, ctx context.Context, pool *pgxpool.Pool, pipeID, draftID, orgID, status string, number int, versionLabel, plan, publishedBy, revDigest, planDigest string) string {
	t.Helper()
	sqlText := fmt.Sprintf(`INSERT INTO pipeline_revisions
			(pipeline_id, draft_id, organization_id, revision_number, version_label, api_version,
			 canonical_document, document_text, revision_digest, compiled_plan, plan_digest, schema_digest, cel_env_digest, status, published_by)
		VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, 'communication.dev/v1alpha1', '{"kind":"Pipeline"}'::jsonb, 'kind: Pipeline', $6, '%s'::jsonb, $7, $8, $9, $10, $11) RETURNING id`, plan)
	var id string
	if err := pool.QueryRow(ctx, sqlText,
		pipeID, draftID, orgID, number, versionLabel, revDigest,
		planDigest, m4Digest("usage-schema"), m4Digest("usage-cel"), status, publishedBy).Scan(&id); err != nil {
		t.Fatalf("insert revision: %v", err)
	}
	return id
}

func TestUsageReports(t *testing.T) {
	ctx, pool, orgID, userID := usageSetup(t)
	bg := context.Background()

	var profileID string
	if err := pool.QueryRow(bg, `
		INSERT INTO agent_profiles (id, organization_id, name, launcher_id, permission_mode, created_at)
		VALUES ('01987a71-7000-7000-8000-abcdef012345', $1::uuid, 'Claude Code', 'claude', 'ask', now())
		RETURNING id`, orgID).Scan(&profileID); err != nil {
		t.Fatalf("insert profile: %v", err)
	}

	var templateID string
	if err := pool.QueryRow(bg, `
		INSERT INTO node_templates (id, organization_id, slug, display_name, kind, description, status, created_by, created_at, updated_at)
		VALUES ('01987a71-7000-7000-8000-abcdef012345', $1::uuid, 'code-reviewer', 'Code reviewer', 'agent.acp', '', 'active', $2::uuid, now(), now())
		RETURNING id`, orgID, userID).Scan(&templateID); err != nil {
		t.Fatalf("insert template: %v", err)
	}

	// Pipeline A: its latest published revision uses the template.
	var pipeA string
	if err := pool.QueryRow(bg, `
		INSERT INTO pipelines (id, organization_id, slug, display_name, description, created_by)
		VALUES ('01987a71-8000-8000-8000-abcdef012345', $1::uuid, 'usage-alpha', 'Usage Alpha', '', $2::uuid) RETURNING id`,
		orgID, userID).Scan(&pipeA); err != nil {
		t.Fatalf("insert pipeline A: %v", err)
	}
	draftA := usageDraft(t, ctx, pool, pipeA, "published", usagePlanJSON("implement", "", templateID), m4Hex("usage-alpha-src"), userID)
	_ = usageRevision(t, ctx, pool, pipeA, draftA, orgID, "published", 1, "1.0.0", usagePlanJSON("implement", "", templateID), userID, m4Digest("usage-rev-a"), m4Digest("usage-plan-a"))

	// Pipeline B: published revision uses Codex; an open draft uses Claude Code.
	var pipeB string
	if err := pool.QueryRow(bg, `
		INSERT INTO pipelines (id, organization_id, slug, display_name, description, created_by)
		VALUES ('01987a71-8000-8000-8000-abcdef012346', $1::uuid, 'usage-beta', 'Usage Beta', '', $2::uuid) RETURNING id`,
		orgID, userID).Scan(&pipeB); err != nil {
		t.Fatalf("insert pipeline B: %v", err)
	}
	draftB := usageDraft(t, ctx, pool, pipeB, "published", usagePlanJSON("implement", "Codex", ""), m4Hex("usage-beta-src"), userID)
	if _, err := pool.Exec(bg, `
		UPDATE pipeline_drafts SET compiled_plan = $2::jsonb, canonical_document = '{"kind":"Pipeline"}'::jsonb
		WHERE id = $1::uuid`, draftB, usagePlanJSON("implement", "Codex", "")); err != nil {
		t.Fatalf("update draft B: %v", err)
	}
	_ = usageRevision(t, ctx, pool, pipeB, draftB, orgID, "published", 1, "1.0.0", usagePlanJSON("implement", "Codex", ""), userID, m4Digest("usage-rev-b"), m4Digest("usage-plan-b"))
	draftBOpen := usageDraft(t, ctx, pool, pipeB, "draft", usagePlanJSON("review", "Claude Code", ""), m4Hex("usage-beta-src2"), userID)
	_ = draftBOpen

	// Pipeline C: revision 1 uses Claude Code, revision 2 uses Codex — the
	// latest published revision (2) is the only one that counts.
	var pipeC string
	if err := pool.QueryRow(bg, `
		INSERT INTO pipelines (id, organization_id, slug, display_name, description, created_by)
		VALUES ('01987a71-8000-8000-8000-abcdef012347', $1::uuid, 'usage-gamma', 'Usage Gamma', '', $2::uuid) RETURNING id`,
		orgID, userID).Scan(&pipeC); err != nil {
		t.Fatalf("insert pipeline C: %v", err)
	}
	draftC := usageDraft(t, ctx, pool, pipeC, "published", usagePlanJSON("implement", "Claude Code", ""), m4Hex("usage-gamma-src"), userID)
	_ = usageRevision(t, ctx, pool, pipeC, draftC, orgID, "published", 1, "1.0.0", usagePlanJSON("implement", "Claude Code", ""), userID, m4Digest("usage-rev-c1"), m4Digest("usage-plan-c1"))
	draftC2 := usageDraft(t, ctx, pool, pipeC, "published", usagePlanJSON("implement", "Codex", ""), m4Hex("usage-gamma-src2"), userID)
	_ = usageRevision(t, ctx, pool, pipeC, draftC2, orgID, "published", 2, "2.0.0", usagePlanJSON("implement", "Codex", ""), userID, m4Digest("usage-rev-c2"), m4Digest("usage-plan-c2"))

	// Pipeline D: latest published revision uses the profile.
	var pipeD string
	if err := pool.QueryRow(bg, `
		INSERT INTO pipelines (id, organization_id, slug, display_name, description, created_by)
		VALUES ('01987a71-8000-8000-8000-abcdef012348', $1::uuid, 'usage-delta', 'Usage Delta', '', $2::uuid) RETURNING id`,
		orgID, userID).Scan(&pipeD); err != nil {
		t.Fatalf("insert pipeline D: %v", err)
	}
	draftD := usageDraft(t, ctx, pool, pipeD, "published", usagePlanJSON("plan", "Claude Code", ""), m4Hex("usage-delta-src"), userID)
	_ = usageRevision(t, ctx, pool, pipeD, draftD, orgID, "published", 1, "1.0.0", usagePlanJSON("plan", "Claude Code", ""), userID, m4Digest("usage-rev-d"), m4Digest("usage-plan-d"))

	// Second organization: its own pipeline + profile, to prove the report
	// never crosses the tenant boundary.
	var org2ID string
	if err := pool.QueryRow(bg, `INSERT INTO organizations (slug, name) VALUES ('usage-org-2', 'Usage org two') RETURNING id`).Scan(&org2ID); err != nil {
		t.Fatalf("insert usage org two: %v", err)
	}
	var user2ID string
	if err := pool.QueryRow(bg, `INSERT INTO users (organization_id, display_name) VALUES ($1, 'usage-user-2') RETURNING id`, org2ID).Scan(&user2ID); err != nil {
		t.Fatalf("insert usage user two: %v", err)
	}
	var profile2ID string
	if err := pool.QueryRow(bg, `
		INSERT INTO agent_profiles (id, organization_id, name, launcher_id, permission_mode, created_at)
		VALUES ('01987a71-7000-7000-8000-abcdef012346', $1::uuid, 'Claude Code', 'claude', 'ask', now())
		RETURNING id`, org2ID).Scan(&profile2ID); err != nil {
		t.Fatalf("insert profile two: %v", err)
	}
	var pipeE string
	if err := pool.QueryRow(bg, `
		INSERT INTO pipelines (id, organization_id, slug, display_name, description, created_by)
		VALUES ('01987a71-8000-8000-8000-abcdef012349', $1::uuid, 'usage-epsilon', 'Usage Epsilon', '', $2::uuid) RETURNING id`,
		org2ID, user2ID).Scan(&pipeE); err != nil {
		t.Fatalf("insert pipeline E: %v", err)
	}
	draftE := usageDraft(t, ctx, pool, pipeE, "published", usagePlanJSON("implement", "Claude Code", ""), m4Hex("usage-epsilon-src"), user2ID)
	_ = usageRevision(t, ctx, pool, pipeE, draftE, org2ID, "published", 1, "1.0.0", usagePlanJSON("implement", "Claude Code", ""), user2ID, m4Digest("usage-rev-e"), m4Digest("usage-plan-e"))

	// --- profile usage: the profile is used by a revision node (pipe D)
	// and by a draft node (pipe B); pipe C's older revision is ignored.
	profileReport, err := APIConversationStore{S: &CnvStore{Pool: pool}}.Usage(ctx, api.Caller{
		UserID: userID, OrganizationID: orgID, IsOrgAdmin: false}, profileID)
	if err != nil {
		t.Fatalf("profile usage: %v", err)
	}
	if len(profileReport.Uses) != 2 || profileReport.Truncated {
		t.Fatalf("profile usage = %d workflows / %d steps / %d uses, want 2/2/2: %+v truncated=%v",
			profileReport.WorkflowCount, profileReport.StepCount, len(profileReport.Uses), profileReport.Uses, profileReport.Truncated)
	}
	var sawDraft, sawRevision bool
	for _, u := range profileReport.Uses {
		t.Logf("USE: %+v", u)
		switch {
		case u.PipelineID == pipeB && u.Source == api.UsageSourceDraft && u.NodeID == "review":
			sawDraft = true
		case u.PipelineID == pipeD && u.Source == api.UsageSourceRevision && u.NodeID == "plan":
			sawRevision = true
		}
	}
	if !sawDraft || !sawRevision {
		t.Errorf("profile uses missing the draft and revision arms: %+v", profileReport.Uses)
	}
	for _, u := range profileReport.Uses {
		if u.PipelineID == pipeC {
			t.Errorf("old revision of pipeC reported as a use: %+v", u)
		}
	}

	// The same profile in another organization is invisible here: the
	// report above is scoped to the caller's organization only.
	_, err = APIConversationStore{S: &CnvStore{Pool: pool}}.Usage(ctx, api.Caller{
		UserID: userID, OrganizationID: orgID, IsOrgAdmin: false}, "01987a71-9999-7999-8999-abcdef012345")
	if err == nil {
		t.Fatal("usage for a profile id outside the organization answered 200")
	}

	// --- template usage: pipe A's latest published revision uses it.
	tmplReport, err := APINodeTemplateStore{Pool: pool}.Usage(ctx, api.Caller{
		UserID: userID, OrganizationID: orgID, IsOrgAdmin: false}, templateID)
	if err != nil {
		t.Fatalf("template usage: %v", err)
	}
	if tmplReport.WorkflowCount != 1 || tmplReport.StepCount != 1 || len(tmplReport.Uses) != 1 {
		t.Fatalf("template usage = %d workflows / %d steps / %d uses, want 1/1/1",
			tmplReport.WorkflowCount, tmplReport.StepCount, len(tmplReport.Uses))
	}
	if tmplReport.Uses[0].PipelineID != pipeA || tmplReport.Uses[0].Source != api.UsageSourceRevision {
		t.Errorf("template use = %+v", tmplReport.Uses[0])
	}

	// The template the other organization uses is not this one's answer.
	_, err = APINodeTemplateStore{Pool: pool}.Usage(ctx, api.Caller{
		UserID: userID, OrganizationID: orgID, IsOrgAdmin: false}, "01987a71-8888-6888-8888-abcdef012345")
	if err == nil {
		t.Fatal("template usage for a template id outside the organization answered 200")
	}
}
