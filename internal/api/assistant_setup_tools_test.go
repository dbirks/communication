package api

// Assistant handoff §6 (CONTRACT §5): the SetupReader implementation over the
// real, permission-checked stores. The stores are fakes here that answer with
// the caller in hand, so "the assistant sees what the caller sees" is a tested
// property; the GitHub half runs through the real adapter against an httptest
// server, because a credential that reached the wrong host or the wrong header
// is exactly the bug these rows exist to prevent.

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	as "github.com/dbirks/communication/internal/assistant"
	"github.com/dbirks/communication/internal/integrations/github"
)

// secretSentinel is what a fake world's VALUE looks like. It is the string
// every assertion below forbids: nothing the assistant may see can hold it, and
// a payload that did would be the leak ADR-0018 exists to close.
const secretSentinel = "ghp_live_NOT_A_REAL_TOKEN_0000000000000000"

// --- the caller-scoped fake world ---------------------------------------

type setupStore struct {
	mu          sync.Mutex
	projects    map[string][]ProjectView // by user id
	repos       map[string][]RepositoryView
	secrets     map[string][]SecretView
	pipelines   []PipelineSummaryView
	pipelineGet map[string]PipelineView
	revisions   map[string][]RevisionSummaryView
	assigns     map[string][]AssignmentView
	profiles    []AgentProfileView
	schedules   map[string][]ScheduleView
	// values is the half of the world no read may reach: the plaintext the
	// store "holds" for a secret, in the test the same way the database holds
	// it encrypted.
	values map[string]string

	resolved   []string // repository ids a credential was resolved for
	named      []string // secret ids resolved through the § 6 check seam
	consumers  []string // consumers those check resolves named
	calls      []string
	issueState string
}

func newSetupStore() *setupStore {
	return &setupStore{
		projects:    map[string][]ProjectView{},
		repos:       map[string][]RepositoryView{},
		secrets:     map[string][]SecretView{},
		pipelineGet: map[string]PipelineView{},
		revisions:   map[string][]RevisionSummaryView{},
		assigns:     map[string][]AssignmentView{},
		schedules:   map[string][]ScheduleView{},
		values:      map[string]string{},
	}
}

func (f *setupStore) note(name string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, name)
}

func (f *setupStore) ListProjects(_ context.Context, c Caller) ([]ProjectView, error) {
	f.note("projects")
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]ProjectView{}, f.projects[c.UserID]...), nil
}

func (f *setupStore) seesProject(c Caller, projectID string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, p := range f.projects[c.UserID] {
		if p.ID == projectID {
			return true
		}
	}
	return false
}

func (f *setupStore) ListRepositories(_ context.Context, c Caller, projectID string) ([]RepositoryView, error) {
	f.note("repos:" + projectID)
	if !f.seesProject(c, projectID) {
		return nil, ErrProjectNotFound
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]RepositoryView{}, f.repos[projectID]...), nil
}

func (f *setupStore) ListSecrets(_ context.Context, c Caller, projectID string) ([]SecretView, error) {
	f.note("secrets:" + projectID)
	if !f.seesProject(c, projectID) {
		return nil, ErrProjectNotFound
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]SecretView{}, f.secrets[projectID]...), nil
}

func (f *setupStore) ListPipelines(_ context.Context, _ Caller) ([]PipelineSummaryView, error) {
	f.note("pipelines")
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]PipelineSummaryView{}, f.pipelines...), nil
}

func (f *setupStore) GetPipeline(_ context.Context, _ Caller, pipelineID string) (PipelineView, error) {
	f.note("pipeline:" + pipelineID)
	f.mu.Lock()
	defer f.mu.Unlock()
	if v, ok := f.pipelineGet[pipelineID]; ok {
		return v, nil
	}
	return PipelineView{}, ErrPipelineNotFound
}

func (f *setupStore) ListPipelineRevisions(_ context.Context, _ Caller, pipelineID string) ([]RevisionSummaryView, error) {
	f.note("revisions:" + pipelineID)
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]RevisionSummaryView{}, f.revisions[pipelineID]...), nil
}

func (f *setupStore) ListAssignments(_ context.Context, c Caller, projectID string, _ AssignmentListFilter) ([]AssignmentView, error) {
	f.note("assignments:" + projectID)
	if !f.seesProject(c, projectID) {
		return nil, ErrProjectNotFound
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]AssignmentView{}, f.assigns[projectID]...), nil
}

func (f *setupStore) ListAgentProfiles(_ context.Context, _ Caller) ([]AgentProfileView, error) {
	f.note("profiles")
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]AgentProfileView{}, f.profiles...), nil
}

func (f *setupStore) ListProjectSchedules(_ context.Context, c Caller, projectID string) ([]ScheduleView, error) {
	f.note("schedules:" + projectID)
	if !f.seesProject(c, projectID) {
		return nil, ErrProjectNotFound
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]ScheduleView{}, f.schedules[projectID]...), nil
}

// ResolveRepositoryCredential is the ADR-0061 seam: it answers with the value
// the "database" holds for the credential that repository row names.
func (f *setupStore) ResolveRepositoryCredential(_ context.Context, repositoryID, _, _ string) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.resolved = append(f.resolved, repositoryID)
	for _, rows := range f.repos {
		for _, repo := range rows {
			if repo.ID != repositoryID || repo.CredentialSecretID == nil {
				continue
			}
			if v, ok := f.values[*repo.CredentialSecretID]; ok {
				return v, nil
			}
		}
	}
	return "", errors.New("postgres: repository GitHub credential could not be resolved")
}

func (f *setupStore) resolvedRepos() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string{}, f.resolved...)
}

// ResolveSecretForCheck is the handoff § 6 seam: it opens a credential no
// repository row uses. The fake "database" holds the value like it holds every
// other, and an empty value stands for a refusal.
func (f *setupStore) ResolveSecretForCheck(_ context.Context, _ Caller, secretID, consumer string) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.named = append(f.named, secretID)
	f.consumers = append(f.consumers, consumer)
	if v, ok := f.values[secretID]; ok && v != "" {
		return v, nil
	}
	return "", errors.New("postgres: secret is not resolvable for a check")
}

func (f *setupStore) namedChecks() ([]string, []string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string{}, f.named...), append([]string{}, f.consumers...)
}

// --- the fixture world ---------------------------------------------------

// oneSetupWorld is: project p-1 (slug feature-delivery) with one repository
// bound to one integration_broker secret, a sample pipeline assigned to it,
// one agent profile and one schedule. The second caller cannot see it at all.
func oneSetupWorld() *setupStore {
	store := newSetupStore()
	credID := "sec-1"
	secret := SecretView{
		ID: credID, Slug: "github-token", Scope: "project",
		Purpose: "GitHub credential for the private mirror", Delivery: "integration_broker",
	}
	store.projects["u-1"] = []ProjectView{{ID: "p-1", Slug: "feature-delivery", Name: "Feature Delivery", MyRole: "maintainer"}}
	store.secrets["p-1"] = []SecretView{secret, {
		ID: "sec-2", Slug: "test-database-url", Scope: "project",
		Purpose: "integration test database", Delivery: "env_file",
	}}
	store.values[credID] = secretSentinel
	store.values["sec-2"] = "postgres://other:secret@db/test"
	credCopy := credID
	store.repos["p-1"] = []RepositoryView{{
		ID: "r-1", ProjectID: "p-1", Name: "app", GitURL: "https://github.com/acme/app.git",
		DefaultBranch: "main", CredentialSecretID: &credCopy, Credential: "configured",
	}}
	store.pipelines = []PipelineSummaryView{
		{ID: "pl-1", Slug: "issue-to-pr", DisplayName: "Issue to PR", LatestRevisionNumber: 3, RevisionCount: 3},
		{ID: "pl-2", Slug: "team-review", DisplayName: "Team review", LatestRevisionNumber: 1, RevisionCount: 1},
	}
	store.pipelineGet["pl-1"] = PipelineView{ID: "pl-1", Slug: "issue-to-pr", DisplayName: "Issue to PR", LatestRevisionNumber: 3}
	store.revisions["pl-1"] = []RevisionSummaryView{
		{RevisionNumber: 3, VersionLabel: "v3", Status: "published", PublishedAt: time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC)},
		{RevisionNumber: 2, VersionLabel: "v2", Status: "published"},
	}
	pin := "rev-3"
	label := "v3"
	store.assigns["p-1"] = []AssignmentView{{
		ID: "as-1", ProjectID: "p-1", PipelineID: "pl-1", PinnedRevisionID: pin,
		PinnedRevisionDigest: "sha256:0123456789abcdef0123456789abcdef", PinnedVersionLabel: &label,
		Enabled: true,
	}}
	runner := "gpt-5"
	store.profiles = []AgentProfileView{
		{ID: "ap-1", Name: "Codex", LauncherID: "codex", PermissionMode: "auto", Version: 2, Model: &runner},
	}
	next := time.Date(2026, 11, 16, 6, 0, 0, 0, time.UTC)
	store.schedules["p-1"] = []ScheduleView{
		{ID: "sc-1", ProjectID: "p-1", AssignmentID: "as-1", CronExpr: "0 6 * * 1-5", Enabled: true, NextRunAt: next},
	}
	return store
}

func setupReaderFor(store *setupStore, gh *github.Client) as.SetupReader {
	deps := AssistantSetupDeps{
		Projects: store, Secrets: store, Pipelines: store, Assignments: store,
		Profiles: store, Schedules: store, Credentials: store, NamedCredentials: store,
	}
	// A nil client stays nil: a typed nil in the interface would read as
	// "wired" and then panic, which is the deployment bug this seam's own
	// honest-degradation rule exists to avoid.
	if gh != nil {
		deps.RepoGet, deps.IssueLister = gh, gh
	}
	return NewAssistantSetupReader(deps)
}

func callerOne() as.Caller { return as.Caller{UserID: "u-1", OrganizationID: "o-1"} }

// --- credential.list ------------------------------------------------------

// TestAssistantCredentialListNeverCarriesAValue is the contract's headline
// rule: the seeded secret's plaintext appears nowhere in the payload, while its
// name, kind, scope and using projects do.
func TestAssistantCredentialListNeverCarriesAValue(t *testing.T) {
	store := oneSetupWorld()
	raw, err := setupReaderFor(store, nil).CredentialList(context.Background(), callerOne())
	if err != nil {
		t.Fatalf("CredentialList: %v", err)
	}
	body := string(raw)
	if strings.Contains(body, secretSentinel) || strings.Contains(body, "postgres://") {
		t.Fatalf("credential.list carried a secret value: %s", body)
	}
	if strings.Contains(strings.ToLower(body), "value") {
		t.Errorf("credential.list named a value field at all: %s", body)
	}
	var rows []map[string]any
	if err := json.Unmarshal(raw, &rows); err != nil {
		t.Fatalf("payload is not an array of rows: %v (%s)", err, body)
	}
	if len(rows) != 1 {
		t.Fatalf("payload = %s, want the one git/GitHub credential (the env_file secret is not one)", body)
	}
	row := rows[0]
	if row["name"] != "github-token" || row["scope"] != "project" {
		t.Errorf("row = %v, want the slug and the scope", row)
	}
	if row["kind"] != "github" {
		t.Errorf("row kind = %v, want \"github\" for a broker credential", row["kind"])
	}
	used, ok := row["used_by"].([]any)
	if !ok || len(used) != 1 || used[0] != "feature-delivery" {
		t.Errorf("row used_by = %v, want [feature-delivery]", row["used_by"])
	}
	for key := range row {
		switch key {
		case "name", "kind", "scope", "used_by":
		default:
			t.Errorf("row carries an unexpected member %q: %v", key, row)
		}
	}
}

func TestAssistantCredentialListIsTheCallersOwn(t *testing.T) {
	store := oneSetupWorld()
	raw, err := setupReaderFor(store, nil).CredentialList(context.Background(),
		as.Caller{UserID: "u-other", OrganizationID: "o-1"})
	if err != nil {
		t.Fatalf("CredentialList as an invisible caller: %v", err)
	}
	if strings.TrimSpace(string(raw)) != "[]" {
		t.Errorf("a caller with no projects saw %s, want the empty array", raw)
	}
}

func TestAssistantCredentialListCountsAnOrgSecretOnce(t *testing.T) {
	store := oneSetupWorld()
	store.projects["u-1"] = append(store.projects["u-1"],
		ProjectView{ID: "p-2", Slug: "other", Name: "Other", MyRole: "member"})
	// An org-scope secret is returned by every project's read; it appears once.
	store.secrets["p-2"] = append(store.secrets["p-2"], SecretView{
		ID: "sec-1", Slug: "github-token", Scope: "org",
		Purpose: "GitHub credential", Delivery: "integration_broker",
	})
	raw, err := setupReaderFor(store, nil).CredentialList(context.Background(), callerOne())
	if err != nil {
		t.Fatalf("CredentialList: %v", err)
	}
	var rows []map[string]any
	if err := json.Unmarshal(raw, &rows); err != nil {
		t.Fatalf("payload: %v (%s)", err, raw)
	}
	if len(rows) != 1 {
		t.Fatalf("payload = %s, want one row seen through two projects", raw)
	}
}

// --- repo.check -----------------------------------------------------------

// ghServer answers GitHub's repository read the way api.github.com does, and
// reports the Authorization header it saw so the credential path is visible.
func ghServer(t *testing.T, handler func(w http.ResponseWriter, r *http.Request)) (*github.Client, func() *string) {
	t.Helper()
	var lastAuth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		auth := r.Header.Get("Authorization")
		lastAuth = auth
		if r.URL.Path != "/repos/acme/app" {
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"message":"Not Found"}`))
			return
		}
		handler(w, r)
	}))
	t.Cleanup(srv.Close)
	client := &github.Client{BaseURL: srv.URL}
	return client, func() *string { return &lastAuth }
}

func ghRepoBody(push bool) string {
	perms := `"permissions":{"pull":true,"push":false,"admin":false}`
	if push {
		perms = `"permissions":{"pull":true,"push":true,"admin":false}`
	}
	return `{"full_name":"acme/app","default_branch":"trunk","private":true,` + perms + `}`
}

func TestAssistantRepoCheckReachableWithPush(t *testing.T) {
	store := oneSetupWorld()
	client, auth := ghServer(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(ghRepoBody(true)))
	})
	raw, err := setupReaderFor(store, client).RepoCheck(context.Background(), callerOne(),
		"https://github.com/acme/app.git", "github-token")
	if err != nil {
		t.Fatalf("RepoCheck: %v", err)
	}
	var got map[string]any
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatalf("payload is not an object: %v (%s)", err, raw)
	}
	if got["reachable"] != true || got["can_push"] != true {
		t.Errorf("payload = %s, want reachable and can_push true", raw)
	}
	if got["repo"] != "acme/app" || got["default_branch"] != "trunk" {
		t.Errorf("payload = %s, want the repository GitHub named and its own default branch", raw)
	}
	if got["credential"] != "github-token" {
		t.Errorf("payload = %s, want the credential named", raw)
	}
	if strings.Contains(string(raw), secretSentinel) {
		t.Errorf("repo.check carried the token value: %s", raw)
	}
	if *auth() != "Bearer "+secretSentinel {
		t.Errorf("GitHub saw Authorization %q, want the resolved credential as a bearer token", *auth())
	}
	if got := store.resolvedRepos(); len(got) != 1 || got[0] != "r-1" {
		t.Errorf("resolved through %v, want the repository row that authorizes the credential", got)
	}
}

func TestAssistantRepoCheckAcceptsEveryURLForm(t *testing.T) {
	store := oneSetupWorld()
	calls := 0
	client, _ := ghServer(t, func(w http.ResponseWriter, _ *http.Request) {
		calls++
		_, _ = w.Write([]byte(ghRepoBody(false)))
	})
	reader := setupReaderFor(store, client)
	for _, url := range []string{
		"https://github.com/acme/app.git", "https://github.com/acme/app",
		"ssh://git@github.com/acme/app.git", "git@github.com:acme/app.git", "acme/app",
	} {
		got := map[string]any{}
		raw, err := reader.RepoCheck(context.Background(), callerOne(), url, "github-token")
		if err != nil {
			t.Fatalf("RepoCheck(%q): %v", url, err)
		}
		if err := json.Unmarshal(raw, &got); err != nil {
			t.Fatalf("RepoCheck(%q) payload: %v", url, err)
		}
		if got["reachable"] != true || got["repo"] != "acme/app" || got["can_push"] != false {
			t.Errorf("RepoCheck(%q) = %s", url, raw)
		}
	}
	if calls != 5 {
		t.Errorf("GitHub was called %d times for 5 URL forms", calls)
	}
}

func TestAssistantRepoCheckUnreachableIsNotAnError(t *testing.T) {
	store := oneSetupWorld()
	client, _ := ghServer(t, func(http.ResponseWriter, *http.Request) {}) // 404 by the path rule
	raw, err := setupReaderFor(store, client).RepoCheck(context.Background(), callerOne(),
		"acme/app", "github-token")
	if err != nil {
		t.Fatalf("a 404 must not be an error, got %v", err)
	}
	var got map[string]any
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatalf("payload: %v (%s)", err, raw)
	}
	if got["reachable"] != false {
		t.Errorf("payload = %s, want reachable:false", raw)
	}
	if got["default_branch"] != "" || got["can_push"] != false {
		t.Errorf("payload = %s, want no branch and no push claim on a repository it could not read", raw)
	}
	if got["credential"] != "github-token" {
		t.Errorf("payload = %s, want the credential it tried named", raw)
	}
	if strings.Contains(string(raw), secretSentinel) {
		t.Errorf("payload carried the token: %s", raw)
	}
}

func TestAssistantRepoCheckRefusesAnUnusableCredentialAnonymous(t *testing.T) {
	// A credential that names a row GitHub answers 404 for must not be retried
	// anonymously: the fail-closed rule of ADR-0061, restated at the tool.
	store := oneSetupWorld()
	client, auth := ghServer(t, func(http.ResponseWriter, *http.Request) {})
	store.values["sec-1"] = "" // the resolve fails
	got := map[string]any{}
	raw, err := setupReaderFor(store, client).RepoCheck(context.Background(), callerOne(),
		"acme/app", "github-token")
	if err != nil {
		t.Fatalf("RepoCheck: %v", err)
	}
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatalf("payload: %v", err)
	}
	if got["reachable"] != false {
		t.Errorf("payload = %s, want reachable:false for a credential that will not open", raw)
	}
	if *auth() != "" {
		t.Errorf("an anonymous retry happened: %q", *auth())
	}
}

func TestAssistantRepoCheckBadURLIsThe404Rule(t *testing.T) {
	store := oneSetupWorld()
	client, _ := ghServer(t, func(w http.ResponseWriter, _ *http.Request) {
		t.Error("a non-GitHub URL must never reach GitHub")
	})
	for _, url := range []string{
		"", "   ", "not a url", "https://gitlab.com/acme/app", "git@host:acme/app",
		"https://github.com/acme/app/issues/3", "acme/app/extra",
	} {
		_, err := setupReaderFor(store, client).RepoCheck(context.Background(), callerOne(), url, "")
		if !errors.Is(err, as.ErrNotFound) {
			t.Errorf("RepoCheck(%q) err = %v, want assistant.ErrNotFound", url, err)
		}
	}
}

func TestAssistantRepoCheckUnknownCredentialIsThe404Rule(t *testing.T) {
	store := oneSetupWorld()
	client, _ := ghServer(t, func(http.ResponseWriter, *http.Request) {})
	_, err := setupReaderFor(store, client).RepoCheck(context.Background(), callerOne(),
		"acme/app", "someone-elses-token")
	if !errors.Is(err, as.ErrNotFound) {
		t.Errorf("an unseen credential name err = %v, want assistant.ErrNotFound (existence hidden)", err)
	}
}

// addRepoWorld adds the handoff § 6 step-2 state to the fixture world: an
// org-scope GITHUB_TOKEN that NO repository references yet (fresh install,
// repo.check before AddRepository).
func addRepoWorld() *setupStore {
	store := oneSetupWorld()
	store.secrets["p-1"] = append(store.secrets["p-1"], SecretView{
		ID: "sec-org", Slug: "org-github-token", Scope: "org",
		Purpose: "GitHub credential", Delivery: "integration_broker",
	})
	store.values["sec-org"] = secretSentinel
	return store
}

func TestAssistantRepoCheckUsesACredentialNoRepositoryUses(t *testing.T) {
	store := addRepoWorld()
	client, auth := ghServer(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(ghRepoBody(true)))
	})
	raw, err := setupReaderFor(store, client).RepoCheck(context.Background(), callerOne(),
		"acme/app", "org-github-token")
	if err != nil {
		t.Fatalf("RepoCheck: %v", err)
	}
	var got map[string]any
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatalf("payload is not an object: %v (%s)", err, raw)
	}
	if got["reachable"] != true || got["can_push"] != true {
		t.Errorf("payload = %s, want the check to use the unused credential", raw)
	}
	if got["credential"] != "org-github-token" {
		t.Errorf("payload = %s, want the credential named", raw)
	}
	if strings.Contains(string(raw), secretSentinel) {
		t.Errorf("repo.check payload carried the token value: %s", raw)
	}
	if *auth() != "Bearer "+secretSentinel {
		t.Errorf("GitHub saw Authorization %q, want the named credential as a bearer token", *auth())
	}
	// It went through the check seam under the repo.check consumer, never the
	// repository-row resolver.
	named, consumers := store.namedChecks()
	if len(named) != 1 || named[0] != "sec-org" || len(consumers) != 1 || consumers[0] != ghConsumerRepoCheck {
		t.Errorf("check resolves = %v/%v, want sec-org under %q", named, consumers, ghConsumerRepoCheck)
	}
	if got := store.resolvedRepos(); len(got) != 0 {
		t.Errorf("resolved through repository rows %v, want none", got)
	}
}

func TestAssistantRepoCheckUnusedCredentialRefusedIsNotAnonymous(t *testing.T) {
	// The fail-closed rule restated on the new seam: a credential no repository
	// uses that the store will not open is reachable:false, never an anonymous
	// GitHub request.
	store := addRepoWorld()
	client, auth := ghServer(t, func(http.ResponseWriter, *http.Request) {
		t.Error("a refused credential must not reach GitHub anonymously")
	})
	store.values["sec-org"] = "" // the check resolve refuses
	raw, err := setupReaderFor(store, client).RepoCheck(context.Background(), callerOne(),
		"acme/app", "org-github-token")
	if err != nil {
		t.Fatalf("RepoCheck: %v", err)
	}
	var got map[string]any
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatalf("payload: %v", err)
	}
	if got["reachable"] != false || got["credential"] != "org-github-token" {
		t.Errorf("payload = %s, want reachable:false naming the refused credential", raw)
	}
	if *auth() != "" {
		t.Errorf("an anonymous retry happened: %q", *auth())
	}
}

// --- workflow.list / workflow.inspect -------------------------------------

func TestAssistantWorkflowListRows(t *testing.T) {
	store := oneSetupWorld()
	raw, err := setupReaderFor(store, nil).WorkflowList(context.Background(), callerOne())
	if err != nil {
		t.Fatalf("WorkflowList: %v", err)
	}
	var rows []map[string]any
	if err := json.Unmarshal(raw, &rows); err != nil {
		t.Fatalf("payload: %v (%s)", err, raw)
	}
	if len(rows) != 2 {
		t.Fatalf("payload = %s, want both library rows", raw)
	}
	want := map[string]map[string]any{
		"pl-1": {"slug": "issue-to-pr", "name": "Issue to PR", "latest_revision": float64(3), "sample": true},
		"pl-2": {"slug": "team-review", "name": "Team review", "latest_revision": float64(1), "sample": false},
	}
	for _, row := range rows {
		w, ok := want[row["id"].(string)]
		if !ok {
			t.Errorf("row %v names a pipeline the caller's library does not list", row)
			continue
		}
		for key, value := range w {
			if row[key] != value {
				t.Errorf("row %v %s = %v, want %v", row["id"], key, row[key], value)
			}
		}
	}
	byID := map[string]map[string]any{}
	for _, row := range rows {
		byID[row["id"].(string)] = row
	}
	if assigned := byID["pl-1"]["assigned_to"]; len(assigned.([]any)) != 1 || assigned.([]any)[0] != "feature-delivery" {
		t.Errorf("pl-1 assigned_to = %v, want [feature-delivery]", assigned)
	}
	if assigned := byID["pl-2"]["assigned_to"]; len(assigned.([]any)) != 0 {
		t.Errorf("pl-2 assigned_to = %v, want the empty list", assigned)
	}
}

func TestAssistantWorkflowInspectCarriesRevisionsAndPins(t *testing.T) {
	store := oneSetupWorld()
	raw, err := setupReaderFor(store, nil).WorkflowInspect(context.Background(), callerOne(), "pl-1")
	if err != nil {
		t.Fatalf("WorkflowInspect: %v", err)
	}
	var got struct {
		Pipeline struct {
			ID   string `json:"id"`
			Name string `json:"name"`
		} `json:"pipeline"`
		Revisions      []map[string]any `json:"revisions"`
		RevisionsTotal int              `json:"revisions_total"`
		Assignments    []map[string]any `json:"assignments"`
	}
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatalf("payload shape: %v (%s)", err, raw)
	}
	if got.Pipeline.ID != "pl-1" || got.Pipeline.Name != "Issue to PR" {
		t.Errorf("pipeline = %+v", got.Pipeline)
	}
	if len(got.Revisions) != 2 || got.Revisions[0]["revision"] != float64(3) ||
		got.Revisions[0]["version_label"] != "v3" {
		t.Errorf("revisions = %v", got.Revisions)
	}
	if got.RevisionsTotal != 2 {
		t.Errorf("revisions_total = %d, want 2", got.RevisionsTotal)
	}
	if len(got.Assignments) != 1 || got.Assignments[0]["project"] != "feature-delivery" ||
		got.Assignments[0]["pinned_version_label"] != "v3" {
		t.Errorf("assignments = %v", got.Assignments)
	}
}

func TestAssistantWorkflowInspectInvisiblePipelineIs404(t *testing.T) {
	store := oneSetupWorld()
	if _, err := setupReaderFor(store, nil).WorkflowInspect(context.Background(), callerOne(), "pl-9"); !errors.Is(err, as.ErrNotFound) {
		t.Errorf("err = %v, want assistant.ErrNotFound for a pipeline the caller cannot see", err)
	}
	if _, err := setupReaderFor(store, nil).WorkflowInspect(context.Background(), callerOne(), "  "); !errors.Is(err, as.ErrNotFound) {
		t.Errorf("err = %v, want assistant.ErrNotFound for a blank reference", err)
	}
}

// --- profile.list / schedule.list -----------------------------------------

func TestAssistantProfileListRows(t *testing.T) {
	store := oneSetupWorld()
	raw, err := setupReaderFor(store, nil).ProfileList(context.Background(), callerOne())
	if err != nil {
		t.Fatalf("ProfileList: %v", err)
	}
	var rows []map[string]any
	if err := json.Unmarshal(raw, &rows); err != nil {
		t.Fatalf("payload: %v (%s)", err, raw)
	}
	if len(rows) != 1 {
		t.Fatalf("payload = %s", raw)
	}
	row := rows[0]
	if row["id"] != "ap-1" || row["name"] != "Codex" || row["launcher"] != "codex" ||
		row["permission_mode"] != "auto" || row["model"] != "gpt-5" || row["version"] != float64(2) {
		t.Errorf("row = %v, want the profile's launch descriptor", row)
	}
}

func TestAssistantScheduleListRows(t *testing.T) {
	store := oneSetupWorld()
	raw, err := setupReaderFor(store, nil).ScheduleList(context.Background(), callerOne(), "p-1")
	if err != nil {
		t.Fatalf("ScheduleList: %v", err)
	}
	var rows []map[string]any
	if err := json.Unmarshal(raw, &rows); err != nil {
		t.Fatalf("payload: %v (%s)", err, raw)
	}
	if len(rows) != 1 {
		t.Fatalf("payload = %s", raw)
	}
	row := rows[0]
	if row["cron"] != "0 6 * * 1-5" || row["enabled"] != true || row["assignment_id"] != "as-1" {
		t.Errorf("row = %v", row)
	}
	if next, _ := row["next_run_at"].(string); !strings.HasPrefix(next, "2026-11-16T06:00:00Z") {
		t.Errorf("next_run_at = %v, want the UTC RFC3339 clock", row["next_run_at"])
	}
	if last, ok := row["last_run_at"]; ok && last != "" {
		t.Errorf("last_run_at = %v, want absent-or-empty on a schedule that never fired", last)
	}

	// A project the caller cannot see is the 404 rule, not a shorter answer.
	if _, err := setupReaderFor(store, nil).ScheduleList(context.Background(), callerOne(), "p-9"); !errors.Is(err, as.ErrNotFound) {
		t.Errorf("err = %v, want assistant.ErrNotFound for an invisible project", err)
	}
}

// --- issue.list -----------------------------------------------------------

func TestAssistantIssueListUsesTheRepositoryCredential(t *testing.T) {
	store := oneSetupWorld()
	var auth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/repos/acme/app/issues" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		auth = r.Header.Get("Authorization")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`[{"number":12,"title":"Fix the flake","state":"open",` +
			`"labels":[{"name":"bug"}],"html_url":"https://github.com/acme/app/issues/12"},` +
			`{"number":13,"title":"Ship it","state":"open","labels":[]}]`))
	}))
	t.Cleanup(srv.Close)
	raw, err := setupReaderFor(store, &github.Client{BaseURL: srv.URL}).
		IssueList(context.Background(), callerOne(), "p-1", "r-1")
	if err != nil {
		t.Fatalf("IssueList: %v", err)
	}
	if auth != "Bearer "+secretSentinel {
		t.Errorf("GitHub saw %q, want the repository's own credential", auth)
	}
	var rows []map[string]any
	if err := json.Unmarshal(raw, &rows); err != nil {
		t.Fatalf("payload: %v (%s)", err, raw)
	}
	if len(rows) != 2 || rows[0]["number"] != float64(12) || rows[0]["title"] != "Fix the flake" {
		t.Fatalf("payload = %s", raw)
	}
	if strings.Contains(string(raw), secretSentinel) {
		t.Errorf("payload carried the token: %s", raw)
	}
	// A repository of another project is the 404 rule.
	if _, err := setupReaderFor(store, &github.Client{BaseURL: srv.URL}).
		IssueList(context.Background(), callerOne(), "p-9", "r-1"); !errors.Is(err, as.ErrNotFound) {
		t.Errorf("err = %v, want assistant.ErrNotFound for a repository outside the project", err)
	}
}

// --- the honest-degradation rule ------------------------------------------

func TestAssistantSetupReaderNeedsTheProjectList(t *testing.T) {
	if reader := NewAssistantSetupReader(AssistantSetupDeps{}); reader != nil {
		t.Error("NewAssistantSetupReader with no project store must return nil, so no tool is announced")
	}
	store := oneSetupWorld()
	reader := setupReaderFor(store, nil)
	// With no GitHub half, the two integration tools answer the 404 rule and
	// every other read still works.
	if _, err := reader.RepoCheck(context.Background(), callerOne(), "acme/app", ""); !errors.Is(err, as.ErrNotFound) {
		t.Errorf("repo.check without a GitHub client err = %v, want assistant.ErrNotFound", err)
	}
	if _, err := reader.IssueList(context.Background(), callerOne(), "p-1", "r-1"); !errors.Is(err, as.ErrNotFound) {
		t.Errorf("issue.list without a GitHub client err = %v, want assistant.ErrNotFound", err)
	}
	if raw, err := reader.ProfileList(context.Background(), callerOne()); err != nil || len(raw) == 0 {
		t.Errorf("profile.list must work without GitHub: raw=%s err=%v", raw, err)
	}
}
