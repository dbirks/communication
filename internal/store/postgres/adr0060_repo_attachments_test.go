package postgres

// ADR-0060 (docs/adr/ADR-0060-repo-attachments.md): an assignment names one
// repository of its project, or none (repository_id NULL — the whole
// project, the legacy / any-repo meaning). Uniqueness is
// (project_id, pipeline_id, repository_id) with NULLS NOT DISTINCT, and the
// run-side repository is recorded at insert, never later. These tests pin
// that contract against the real database: the duplicate arms, the
// coexistence arm, the composite FK, the run-list filters and the JSON
// null-for-whole-project shape.

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/dbirks/communication/internal/api"
)

// a60Repo inserts one repository of the fixture project, named
// octo/<label>, the way the issue-trigger fixture names its own.
func a60Repo(t *testing.T, f *m4Fixture, label string) string {
	t.Helper()
	var id string
	if err := f.pool.QueryRow(testCtx(t), `
		INSERT INTO repositories (project_id, name, git_url, created_by)
		VALUES ($1, 'octo/' || $3, 'https://github.com/octo/' || $3 || '.git', $2)
		RETURNING id`, f.projectID, f.userID, label).Scan(&id); err != nil {
		t.Fatalf("insert repository %s: %v", label, err)
	}
	return id
}

// TestRepoAttachmentUniqueness is migration 00015's assignment side: one
// assignment per (project, pipeline, repository) with NULLS NOT DISTINCT —
// the project-wide pin is a first-class value, so a second one is a conflict
// exactly like a second repository pin, while a repository pin and a
// project-wide pin of the same pipeline coexist.
func TestRepoAttachmentUniqueness(t *testing.T) {
	ctx := testCtx(t)
	f := m4Setup(t)
	repoA := a60Repo(t, f, "widgets")
	repoB := a60Repo(t, f, "gadgets")

	// The repository pin: a named repository, read back as the row's own.
	repoPinned, err := f.pipelines.CreateAssignment(ctx, NewAssignment{
		ProjectID: f.projectID, PipelineID: f.pipelineID,
		PinnedRevisionID: f.revisionID, CreatedBy: f.userID, RepositoryID: repoA,
	})
	if err != nil {
		t.Fatalf("create repository assignment: %v", err)
	}
	if repoPinned.RepositoryID != repoA {
		t.Fatalf("repository assignment read back = %q, want %q", repoPinned.RepositoryID, repoA)
	}
	// The whole-project pin: empty in, empty out — NULL, not a blank byte.
	whole, err := f.pipelines.CreateAssignment(ctx, NewAssignment{
		ProjectID: f.projectID, PipelineID: f.pipelineID,
		PinnedRevisionID: f.revisionID, CreatedBy: f.userID,
	})
	if err != nil {
		t.Fatalf("create project-wide assignment (the repository pin coexists): %v", err)
	}
	if whole.RepositoryID != "" {
		t.Fatalf("project-wide assignment read back repository = %q, want empty", whole.RepositoryID)
	}
	// NULLS NOT DISTINCT: a second whole-project pin of the same pipeline is
	// the same duplicate as a second repository pin.
	if _, err := f.pipelines.CreateAssignment(ctx, NewAssignment{
		ProjectID: f.projectID, PipelineID: f.pipelineID,
		PinnedRevisionID: f.revisionID, CreatedBy: f.userID, RepositoryID: repoA,
	}); !errors.Is(err, ErrConflict) {
		t.Errorf("second assignment to the same repository = %v, want ErrConflict", err)
	}
	if _, err := f.pipelines.CreateAssignment(ctx, NewAssignment{
		ProjectID: f.projectID, PipelineID: f.pipelineID,
		PinnedRevisionID: f.revisionID, CreatedBy: f.userID,
	}); !errors.Is(err, ErrConflict) {
		t.Errorf("second project-wide assignment of one pipeline = %v, want ErrConflict", err)
	}
	// The triple is the key: another repository of the same pipeline is fine.
	if _, err := f.pipelines.CreateAssignment(ctx, NewAssignment{
		ProjectID: f.projectID, PipelineID: f.pipelineID,
		PinnedRevisionID: f.revisionID, CreatedBy: f.userID, RepositoryID: repoB,
	}); err != nil {
		t.Errorf("assignment to a second repository = %v, want none", err)
	}
	// The composite FK: the named repository must be the assignment's
	// project's. A repository of another project is a refusal, not a row.
	var otherProject, otherRepo string
	if err := f.pool.QueryRow(ctx, `
		INSERT INTO projects (organization_id, slug, name, created_by)
		VALUES ($1, 'a60-other-' || $3, 'A60 other', $2) RETURNING id`,
		f.orgID, f.userID, migFixtureToken(t)).Scan(&otherProject); err != nil {
		t.Fatalf("insert other project: %v", err)
	}
	t.Cleanup(func() {
		bg := context.Background()
		if _, err := f.pool.Exec(bg, `DELETE FROM repositories WHERE project_id = $1`, otherProject); err != nil {
			t.Errorf("cleanup other repositories: %v", err)
		}
		if _, err := f.pool.Exec(bg, `DELETE FROM projects WHERE id = $1`, otherProject); err != nil {
			t.Errorf("cleanup other project: %v", err)
		}
	})
	if err := f.pool.QueryRow(ctx, `
		INSERT INTO repositories (project_id, name, git_url, created_by)
		VALUES ($1, 'octo/elsewhere', 'https://github.com/octo/elsewhere.git', $2)
		RETURNING id`, otherProject, f.userID).Scan(&otherRepo); err != nil {
		t.Fatalf("insert other repository: %v", err)
	}
	if _, err := f.pipelines.CreateAssignment(ctx, NewAssignment{
		ProjectID: f.projectID, PipelineID: f.pipelineID,
		PinnedRevisionID: f.revisionID, CreatedBy: f.userID, RepositoryID: otherRepo,
	}); err == nil {
		t.Error("assignment naming a repository of another project accepted")
	} else if code := migPgCode(t, err); code != "23503" {
		t.Errorf("cross-project repository code = %s, want 23503", code)
	}
}

// TestRepoAttachmentRunFilters is the run side: runs record the repository
// they work on (set at insert, empty = none), and the project run list
// narrows by that repository or by the assignment (ADR-0060 § 5).
func TestRepoAttachmentRunFilters(t *testing.T) {
	ctx := testCtx(t)
	f := m4Setup(t)
	repoA := a60Repo(t, f, "widgets")

	assign, err := f.pipelines.CreateAssignment(ctx, NewAssignment{
		ProjectID: f.projectID, PipelineID: f.pipelineID,
		PinnedRevisionID: f.revisionID, CreatedBy: f.userID,
	})
	if err != nil {
		t.Fatalf("create assignment: %v", err)
	}
	newRun := NewRun{
		OrganizationID: f.orgID, ProjectID: f.projectID, PipelineID: f.pipelineID,
		PipelineRevisionID: f.revisionID, AssignmentID: assign.ID,
		RevisionDigest: f.digest, PlanDigest: f.planDigest,
		PlanSnapshot: json.RawMessage(`{"nodes":[]}`), PoliciesSnapshot: json.RawMessage(`{}`),
		TriggeredBy: f.userID,
	}
	withRepo := newRun
	withRepo.RepositoryID = repoA
	withRepoRun, _, err := f.runs.CreateRun(ctx, withRepo)
	if err != nil {
		t.Fatalf("create repository run: %v", err)
	}
	if withRepoRun.RepositoryID != repoA {
		t.Fatalf("run repository = %q, want %q", withRepoRun.RepositoryID, repoA)
	}
	withoutRepoRun, _, err := f.runs.CreateRun(ctx, newRun)
	if err != nil {
		t.Fatalf("create plain run: %v", err)
	}
	if withoutRepoRun.RepositoryID != "" {
		t.Fatalf("plain run repository = %q, want empty", withoutRepoRun.RepositoryID)
	}

	byRepo, err := f.runs.ListProjectRuns(ctx, f.projectID, "", repoA, "")
	if err != nil {
		t.Fatalf("list by repository: %v", err)
	}
	if len(byRepo) != 1 || byRepo[0].ID != withRepoRun.ID {
		t.Fatalf("repository filter listed %d runs, want only %s", len(byRepo), withRepoRun.ID)
	}
	byAssignment, err := f.runs.ListProjectRuns(ctx, f.projectID, "", "", assign.ID)
	if err != nil {
		t.Fatalf("list by assignment: %v", err)
	}
	if len(byAssignment) != 2 {
		t.Fatalf("assignment filter listed %d runs, want both", len(byAssignment))
	}
}

// TestRepoAttachmentAPIAssignmentView is the JSON contract: the response
// carries null — never "" — for a project-wide assignment's repository_id
// and repository_name, and the name for the repository it names.
func TestRepoAttachmentAPIAssignmentView(t *testing.T) {
	ctx := testCtx(t)
	f := m4Setup(t)
	repo := a60Repo(t, f, "widgets")
	caller := api.Caller{UserID: f.userID, OrganizationID: f.orgID, IsOrgAdmin: true}
	store := APIAssignmentStore{S: f.pipelines}
	scoped, err := store.CreateAssignment(ctx, caller, f.projectID, api.AssignmentCreateInput{
		PipelineID: f.pipelineID, PinnedRevisionID: f.revisionID, RepositoryID: repo,
	})
	if err != nil {
		t.Fatalf("create repository assignment: %v", err)
	}
	if scoped.RepositoryID == nil || *scoped.RepositoryID != repo {
		t.Fatalf("repository assignment repository_id = %v, want %s", scoped.RepositoryID, repo)
	}
	if scoped.RepositoryName == nil || *scoped.RepositoryName != "octo/widgets" {
		t.Fatalf("repository assignment repository_name = %v, want octo/widgets", scoped.RepositoryName)
	}
	whole, err := store.CreateAssignment(ctx, caller, f.projectID, api.AssignmentCreateInput{
		PipelineID: f.pipelineID, PinnedRevisionID: f.revisionID,
	})
	if err != nil {
		t.Fatalf("create project-wide assignment: %v", err)
	}
	if whole.RepositoryID != nil || whole.RepositoryName != nil {
		t.Fatalf("project-wide assignment repository members = (%v, %v), want (null, null)",
			whole.RepositoryID, whole.RepositoryName)
	}

	listed, err := store.ListAssignments(ctx, caller, f.projectID, api.AssignmentListFilter{})
	if err != nil {
		t.Fatalf("list assignments: %v", err)
	}
	if len(listed) != 2 {
		t.Fatalf("listed %d assignments, want the repository pin and the project-wide pin", len(listed))
	}
	// The list answer carries the repository name too — the page renders it.
	for _, v := range listed {
		if v.ID == scoped.ID && (v.RepositoryName == nil || *v.RepositoryName != "octo/widgets") {
			t.Errorf("listed repository assignment name = %v, want octo/widgets", v.RepositoryName)
		}
	}
	got, err := store.GetAssignment(ctx, caller, whole.ID)
	if err != nil {
		t.Fatalf("get project-wide assignment: %v", err)
	}
	if got.RepositoryID != nil || got.RepositoryName != nil {
		t.Fatalf("got project-wide assignment repository members = (%v, %v), want (null, null)",
			got.RepositoryID, got.RepositoryName)
	}
}

// TestRepoAttachmentIssueTriggerMismatch is the trigger arm: a trigger on a
// repository-scoped assignment must watch that same repository, and a
// project-wide assignment may pick any repository of the project.
func TestRepoAttachmentIssueTriggerMismatch(t *testing.T) {
	ctx := testCtx(t)
	f := itSetup(t)
	repoB := a60Repo(t, f.m4Fixture, "gadgets")
	// A repository-scoped pin of the same pipeline, alongside the fixture's
	// project-wide one.
	scoped, err := f.pipelines.CreateAssignment(ctx, NewAssignment{
		ProjectID: f.projectID, PipelineID: f.pipelineID,
		PinnedRevisionID: f.revisionID, CreatedBy: f.userID, RepositoryID: repoB,
	})
	if err != nil {
		t.Fatalf("create repository assignment: %v", err)
	}
	// The fixture's repository cleanup runs before the assignment cleanup;
	// the scoped pin names this repository, so trigger, pin and repository
	// go first of their own.
	t.Cleanup(func() {
		bg := context.Background()
		if _, err := f.pool.Exec(bg, `DELETE FROM issue_triggers WHERE project_id = $1 AND assignment_id = $2`, f.projectID, scoped.ID); err != nil {
			t.Errorf("cleanup scoped triggers: %v", err)
		}
		if _, err := f.pool.Exec(bg, `DELETE FROM assignments WHERE id = $1`, scoped.ID); err != nil {
			t.Errorf("cleanup scoped assignment: %v", err)
		}
	})
	enabled := true
	apiStore := APIIssueTriggerStore{S: f.triggers}
	apiCaller := api.Caller{UserID: f.userID, OrganizationID: f.orgID, IsOrgAdmin: true}
	newTrigger := func(assignmentID, repositoryID string) api.IssueTriggerCreateInput {
		return api.IssueTriggerCreateInput{
			AssignmentID: assignmentID, RepositoryID: repositoryID,
			Event: "opened", Labels: []string{}, Inputs: json.RawMessage(`{}`), Enabled: &enabled,
		}
	}
	// The fixture's trigger watches the fixture's repository; the scoped
	// pin is a different one, so the mismatch is the refusal.
	if _, err := apiStore.CreateIssueTrigger(ctx, apiCaller, f.projectID, newTrigger(scoped.ID, f.repository)); !errors.Is(err, api.ErrIssueTriggerRepositoryMismatch) {
		t.Fatalf("mismatching trigger on a repository-scoped assignment = %v, want the mismatch refusal", err)
	}
	if _, err := apiStore.CreateIssueTrigger(ctx, apiCaller, f.projectID, newTrigger(scoped.ID, repoB)); err != nil {
		t.Fatalf("matching trigger on a repository-scoped assignment: %v", err)
	}
	// The fixture's project-wide assignment still accepts any repository.
	if _, err := apiStore.CreateIssueTrigger(ctx, apiCaller, f.projectID, newTrigger(f.assignment, repoB)); err != nil {
		t.Fatalf("trigger on a project-wide assignment picking another repository: %v", err)
	}
}
