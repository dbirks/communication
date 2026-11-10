package api

// The assistant handoff §6 setup writes, proved at the seam they claim to
// sit on: each executor runs the SAME store call the matching UI route runs,
// as the caller. The package's existing pattern is the store double
// (assistant_wiring_test.go, projects_test.go) — these doubles answer with the
// real sentinels (ErrProjectNotFound for a caller who may not manage,
// ErrRepositoryCredentialInvalid for a secret out of scope), so what the test
// pins is the executor's OWN behaviour: the arguments it hands the store, the
// row it logs, and the denial it reports when the store says no.

import (
	"context"
	"errors"
	"strings"
	"testing"

	as "github.com/dbirks/communication/internal/assistant"
	"github.com/dbirks/communication/internal/authz"
)

// --- the doubles ---------------------------------------------------------

type setupActStore struct {
	role authz.Role // the caller's role in the seeded project
	// observed writes
	projects    []prjCreateCall
	repos       []prjAddCall
	assignments []AssignmentCreateInput
	schedules   []ScheduleCreateInput
	cancelled   []string
	// answers
	secrets    []SecretView
	revisions  []RevisionSummaryView
	fullRevs   map[string]RevisionView
	assignment []AssignmentView
	run        RunView
	createErr  error
	created    ProjectView
}

var (
	setupMaintainer = Caller{UserID: "u-1", OrganizationID: "o-1"}
	setupViewer     = Caller{UserID: "u-2", OrganizationID: "o-1"}
)

func newSetupActStore(role authz.Role) *setupActStore {
	return &setupActStore{
		role: role,
		run:  RunView{RunSummaryView: RunSummaryView{ID: "r-1", ProjectID: "p-1"}},
		fullRevs: map[string]RevisionView{
			"sha-old": {ID: "rev-old", RevisionNumber: 1, VersionLabel: "r1"},
			"sha-new": {ID: "rev-new", RevisionNumber: 2, VersionLabel: "v2"},
		},
		revisions: []RevisionSummaryView{
			{RevisionNumber: 1, VersionLabel: "r1", RevisionDigest: "sha-old", Status: "published"},
			{RevisionNumber: 2, VersionLabel: "v2", RevisionDigest: "sha-new", Status: "published"},
		},
		assignment: []AssignmentView{{ID: "a-1", ProjectID: "p-1", PipelineID: "pl-1", PinnedRevisionID: "rev-old"}},
		secrets: []SecretView{
			{ID: "sec-1", Slug: "GITHUB_TOKEN", Delivery: "integration_broker", Purpose: "GitHub"},
			{ID: "sec-2", Slug: "DEPLOY_KEY", Delivery: "env", Purpose: "deploy"},
		},
	}
}

// canManage is the real predicate (internal/authz): the caller's CURRENT role
// on the project, never the turn's earlier read.
func (s *setupActStore) canManage(c Caller) bool {
	return authz.CanManage(c.IsOrgAdmin, s.role)
}

// CreateProject mirrors postgres.CreateProject's predicate — a caller is
// enough, and the creator comes back as the new project's maintainer (its own
// membership insert). `createErr` stands in for the store refusing.
func (s *setupActStore) CreateProject(_ context.Context, c Caller, name, slug, description string) (ProjectView, error) {
	if s.createErr != nil {
		return ProjectView{}, s.createErr
	}
	s.projects = append(s.projects, prjCreateCall{name: name, slug: slug, description: description})
	s.role = authz.RoleMaintainer
	s.created = ProjectView{ID: "p-new", Slug: slug, Name: name, Version: 1,
		MyRole: string(authz.RoleMaintainer)}
	return s.created, nil
}

func (s *setupActStore) AddRepository(_ context.Context, c Caller, projectID, name, gitURL, defaultBranch, credentialSecretID string) (RepositoryView, error) {
	if !s.canManage(c) {
		return RepositoryView{}, ErrProjectNotFound // the store's defence-in-depth answer
	}
	if credentialSecretID != "" && credentialSecretID != "sec-1" {
		return RepositoryView{}, ErrRepositoryCredentialInvalid
	}
	s.repos = append(s.repos, prjAddCall{projectID: projectID, name: name, gitURL: gitURL,
		defaultBranch: defaultBranch, credentialSecretID: credentialSecretID})
	return RepositoryView{ID: "repo-1", ProjectID: projectID, Name: name, GitURL: gitURL,
		DefaultBranch: defaultBranch}, nil
}

func (s *setupActStore) GetProject(_ context.Context, c Caller, projectID string) (ProjectView, error) {
	if projectID == s.created.ID && s.created.ID != "" {
		return s.created, nil
	}
	if !authz.CanView(c.IsOrgAdmin, s.role) {
		return ProjectView{}, ErrProjectNotFound
	}
	return ProjectView{ID: projectID, MyRole: string(s.role)}, nil
}

func (s *setupActStore) ListSecrets(_ context.Context, _ Caller, projectID string) ([]SecretView, error) {
	if projectID == "" {
		return nil, ErrProjectNotFound
	}
	return s.secrets, nil
}

func (s *setupActStore) ListPipelineRevisions(_ context.Context, _ Caller, pipelineID string) ([]RevisionSummaryView, error) {
	if pipelineID == "" {
		return nil, ErrPipelineNotFound
	}
	return s.revisions, nil
}

func (s *setupActStore) GetRevision(_ context.Context, _ Caller, digestOrID string) (RevisionView, error) {
	rev, ok := s.fullRevs[digestOrID]
	if !ok {
		return RevisionView{}, ErrPipelineNotFound
	}
	return rev, nil
}

func (s *setupActStore) ListAssignments(_ context.Context, c Caller, projectID string, _ AssignmentListFilter) ([]AssignmentView, error) {
	if !s.canManage(c) {
		return nil, ErrAssignmentNotFound
	}
	return s.assignment, nil
}

func (s *setupActStore) CreateAssignment(_ context.Context, c Caller, projectID string, in AssignmentCreateInput) (AssignmentView, error) {
	if !s.canManage(c) {
		return AssignmentView{}, ErrAssignmentNotFound
	}
	s.assignments = append(s.assignments, in)
	return AssignmentView{ID: "a-new", ProjectID: projectID, PipelineID: in.PipelineID,
		PinnedRevisionID: in.PinnedRevisionID}, nil
}

func (s *setupActStore) CreateSchedule(_ context.Context, c Caller, projectID string, in ScheduleCreateInput) (ScheduleView, error) {
	if !s.canManage(c) {
		return ScheduleView{}, ErrScheduleNotFound
	}
	s.schedules = append(s.schedules, in)
	return ScheduleView{ID: "sc-1", ProjectID: projectID, AssignmentID: in.AssignmentID,
		CronExpr: in.CronExpr}, nil
}

// GetRun / CancelRun mirror APIRunStore's write predicate: the caller's own
// read, then contribute-or-viewer-or-nothing (m4RunContribute), so a viewer
// never learns the run exists.
func (s *setupActStore) GetRun(_ context.Context, c Caller, runID string) (RunView, error) {
	if s.run.ID != runID || s.role == authz.RoleViewer && !c.IsOrgAdmin {
		return RunView{}, ErrRunNotFound
	}
	return s.run, nil
}

func (s *setupActStore) CancelRun(_ context.Context, c Caller, runID string) (RunView, error) {
	if _, err := s.GetRun(context.Background(), c, runID); err != nil {
		return RunView{}, err
	}
	s.cancelled = append(s.cancelled, runID)
	return s.run, nil
}

// setupActions wires every §6 executor over one double.
func setupActions(s *setupActStore) map[string]as.ActionExecutor {
	return NewAssistantActions(AssistantActionsDeps{
		Projects: s, ProjectWrites: s, Secrets: s, Revisions: s,
		AssignmentWrites: s, Schedules: s, RunStop: s,
	})
}

func asCaller(c Caller) as.Caller {
	return as.Caller{UserID: c.UserID, OrganizationID: c.OrganizationID, IsOrgAdmin: c.IsOrgAdmin}
}

func runSetupAction(t *testing.T, acts map[string]as.ActionExecutor, tool string, c Caller,
	args map[string]string) (string, *as.ChangeRecord, error) {
	t.Helper()
	fn := acts[tool]
	if fn == nil {
		t.Fatalf("the runner never announced %s", tool)
	}
	return fn(context.Background(), asCaller(c), tool, args)
}

// --- the allowed caller creates the real row -----------------------------

func TestAssistantSetupActionsAnnouncedOnlyWhenWired(t *testing.T) {
	if got := NewAssistantActions(AssistantActionsDeps{}); len(got) != 0 {
		t.Fatalf("an unwired deployment announced actions: %v", keysOf(got))
	}
	s := newSetupActStore(authz.RoleMaintainer)
	acts := setupActions(s)
	for _, tool := range []string{"project.create", "repo.add", "assignment.set", "run.cancel", "schedule.create"} {
		if acts[tool] == nil {
			t.Errorf("%s is not wired", tool)
		}
	}
}

func TestAssistantSetupProjectCreateWithRepoAndCredential(t *testing.T) {
	s := newSetupActStore(authz.RoleMaintainer)
	ack, change, err := runSetupAction(t, setupActions(s), "project.create", setupMaintainer, map[string]string{
		"name": "home-lab", "repo_url": "https://github.com/acme/app.git",
		"credential": "GITHUB_TOKEN", "default_branch": "trunk",
	})
	if err != nil {
		t.Fatalf("project.create: %v", err)
	}
	if len(s.projects) != 1 || s.projects[0].name != "home-lab" || s.projects[0].slug != "home-lab" {
		t.Fatalf("the project row is wrong: %+v", s.projects)
	}
	if len(s.repos) != 1 {
		t.Fatalf("the repository was not added through the project route's call: %+v", s.repos)
	}
	got := s.repos[0]
	if got.projectID != "p-new" || got.name != "app" ||
		got.gitURL != "https://github.com/acme/app.git" || got.defaultBranch != "trunk" ||
		got.credentialSecretID != "sec-1" {
		t.Fatalf("AddRepository saw %+v; want the new project, app, the canonical url, trunk and sec-1", got)
	}
	if change == nil || change.Kind != "project_create" || change.ProjectID == nil || *change.ProjectID != "p-new" {
		t.Fatalf("change row = %+v", change)
	}
	if change.UndoPayload != nil {
		t.Error("a created project is never undoable")
	}
	if !strings.Contains(ack, "home-lab") || !strings.Contains(ack, "acme/app") {
		t.Fatalf("ack = %q", ack)
	}
}

func TestAssistantSetupProjectCreateDefaultsTheBranchToMain(t *testing.T) {
	s := newSetupActStore(authz.RoleMaintainer)
	if _, _, err := runSetupAction(t, setupActions(s), "project.create", setupMaintainer,
		map[string]string{"name": "home-lab", "repo_url": "acme/app"}); err != nil {
		t.Fatalf("project.create: %v", err)
	}
	if len(s.repos) != 1 || s.repos[0].defaultBranch != "main" || s.repos[0].gitURL != "https://github.com/acme/app.git" {
		t.Fatalf("repository call = %+v; want main and the canonical https remote", s.repos)
	}
}

// The project stays when the repository half fails, and the ack says so: the
// row is real, so a clean-looking refusal would be a lie about the app.
func TestAssistantSetupProjectCreateKeepsProjectWhenCredentialNameInvisible(t *testing.T) {
	s := newSetupActStore(authz.RoleMaintainer)
	ack, change, err := runSetupAction(t, setupActions(s), "project.create", setupMaintainer, map[string]string{
		"name": "home-lab", "repo_url": "https://github.com/acme/app.git", "credential": "NOPE_TOKEN",
	})
	if err != nil {
		t.Fatalf("the project half succeeded, so the action must not fail: %v", err)
	}
	if len(s.projects) != 1 {
		t.Fatalf("the project was not kept: %+v", s.projects)
	}
	if len(s.repos) != 0 {
		t.Fatalf("the repository was added with an invisible credential: %+v", s.repos)
	}
	if !strings.Contains(ack, "NOPE_TOKEN") || !strings.Contains(ack, "NOT added") {
		t.Fatalf("ack hides the failed half: %q", ack)
	}
	if change == nil || change.Kind != "project_create" {
		t.Fatalf("change row = %+v", change)
	}
}

func TestAssistantSetupRepoAddAssignmentCancelSchedule(t *testing.T) {
	s := newSetupActStore(authz.RoleMaintainer)
	acts := setupActions(s)

	if _, change, err := runSetupAction(t, acts, "repo.add", setupMaintainer, map[string]string{
		"project_id": "p-1", "repo_url": "git@github.com:acme/app.git", "credential": "github_token",
	}); err != nil || change.Kind != "repo_add" {
		t.Fatalf("repo.add: %v %+v", err, change)
	}
	if len(s.repos) != 1 || s.repos[0].name != "app" || s.repos[0].credentialSecretID != "sec-1" {
		t.Fatalf("repo.add call = %+v", s.repos)
	}

	// assignment.set pins the LATEST PUBLISHED revision, resolved to the
	// store's own id — the newest one in the caller's list is rev-new (r2).
	_, change, err := runSetupAction(t, acts, "assignment.set", setupMaintainer, map[string]string{
		"project_id": "p-1", "pipeline_id": "pl-1",
	})
	if err != nil {
		t.Fatalf("assignment.set: %v", err)
	}
	if len(s.assignments) != 1 || s.assignments[0].PinnedRevisionID != "rev-new" ||
		s.assignments[0].PipelineID != "pl-1" {
		t.Fatalf("assignment call = %+v; want the pin on rev-new", s.assignments)
	}
	if !strings.Contains(change.Summary, "v2") {
		t.Fatalf("the change row does not name the pinned revision: %q", change.Summary)
	}

	if _, change, err := runSetupAction(t, acts, "run.cancel", setupMaintainer,
		map[string]string{"run_id": "r-1"}); err != nil || change.Kind != "run_cancel" {
		t.Fatalf("run.cancel: %v %+v", err, change)
	}
	if len(s.cancelled) != 1 || s.cancelled[0] != "r-1" {
		t.Fatalf("cancel calls = %v", s.cancelled)
	}

	if _, change, err := runSetupAction(t, acts, "schedule.create", setupMaintainer, map[string]string{
		"project_id": "p-1", "pipeline_id": "pl-1", "cron": "0 7 * * 1-5",
	}); err != nil || change.Kind != "schedule_create" {
		t.Fatalf("schedule.create: %v %+v", err, change)
	}
	if len(s.schedules) != 1 || s.schedules[0].AssignmentID != "a-1" || s.schedules[0].CronExpr != "0 7 * * 1-5" {
		t.Fatalf("schedule call = %+v; want the project's assignment on pl-1", s.schedules)
	}
	for _, ch := range []*as.ChangeRecord{change} {
		if ch.UndoPayload != nil {
			t.Error("none of the setup kinds is undoable")
		}
	}
}

// A workflow with nothing published has nothing to pin: the executor says so
// and the assignment row is never written (the model must report it, not
// invent a revision).
func TestAssistantSetupAssignmentSetRefusesAnUnpublishedWorkflow(t *testing.T) {
	s := newSetupActStore(authz.RoleMaintainer)
	s.revisions = []RevisionSummaryView{{RevisionNumber: 3, VersionLabel: "d3", RevisionDigest: "sha-x", Status: "draft"}}
	_, change, err := runSetupAction(t, setupActions(s), "assignment.set", setupMaintainer,
		map[string]string{"project_id": "p-1", "pipeline_id": "pl-1"})
	if err == nil || !strings.Contains(err.Error(), "no published revision") {
		t.Fatalf("an unpublished workflow was pinned: %v %+v", err, change)
	}
	if len(s.assignments) != 0 {
		t.Fatalf("the assignment row was written anyway: %+v", s.assignments)
	}
}

func TestAssistantSetupScheduleCreateRefusesABadCron(t *testing.T) {
	s := newSetupActStore(authz.RoleMaintainer)
	_, _, err := runSetupAction(t, setupActions(s), "schedule.create", setupMaintainer,
		map[string]string{"project_id": "p-1", "pipeline_id": "pl-1", "cron": "every morning"})
	if err == nil || !strings.Contains(err.Error(), "cron") {
		t.Fatalf("a malformed cron reached the store: %v", err)
	}
	if len(s.schedules) != 0 {
		t.Fatalf("the schedule row was written anyway: %+v", s.schedules)
	}
}

// --- the viewer is refused by the store, and says so ---------------------

func TestAssistantSetupActionsViewerDenied(t *testing.T) {
	for _, tc := range []struct {
		tool string
		args map[string]string
	}{
		{"repo.add", map[string]string{"project_id": "p-1", "repo_url": "acme/app"}},
		{"assignment.set", map[string]string{"project_id": "p-1", "pipeline_id": "pl-1"}},
		{"run.cancel", map[string]string{"run_id": "r-1"}},
		{"schedule.create", map[string]string{"project_id": "p-1", "pipeline_id": "pl-1", "cron": "0 7 * * 1-5"}},
	} {
		t.Run(tc.tool, func(t *testing.T) {
			s := newSetupActStore(authz.RoleViewer)
			_, _, err := runSetupAction(t, setupActions(s), tc.tool, setupViewer, tc.args)
			if !errors.Is(err, as.ErrActionDenied) {
				t.Fatalf("%s as a viewer = %v; want ErrActionDenied", tc.tool, err)
			}
		})
	}
}

// project.create is the §6 case with NO project to be a viewer of: the route
// is open to any authenticated caller (the store stamps the creator as the new
// project's maintainer), so the assistant's executor must not invent a gate the
// UI does not have. What it must do is pass the store's own refusal through —
// which is what the same call answers for a caller outside the organization.
func TestAssistantSetupProjectCreateCarriesNoExtraGate(t *testing.T) {
	// The route has no project to gate on — any authenticated caller may
	// create one — so the executor adds no rule of its own...
	s := newSetupActStore("")
	if _, change, err := runSetupAction(t, setupActions(s), "project.create", setupViewer,
		map[string]string{"name": "home-lab"}); err != nil || change == nil {
		t.Fatalf("project.create refused a caller the route accepts: %v %+v", err, change)
	}
	if len(s.projects) != 1 {
		t.Fatalf("no project row: %+v", s.projects)
	}
	// ...and the store's own refusal travels as the runner's stable denial.
	s2 := newSetupActStore("")
	s2.createErr = ErrProjectNotFound
	if _, _, err := runSetupAction(t, setupActions(s2), "project.create", setupMaintainer,
		map[string]string{"name": "home-lab"}); !errors.Is(err, as.ErrActionDenied) {
		t.Fatalf("the store's refusal did not travel as ErrActionDenied: %v", err)
	}
	if len(s2.projects) != 0 {
		t.Fatalf("a refused create still wrote a row: %+v", s2.projects)
	}
}

func keysOf(m map[string]as.ActionExecutor) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}
