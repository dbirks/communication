package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/dbirks/communication/internal/authz"
)

// --- fake store ---------------------------------------------------------

// prjFakeStore is an in-memory ProjectStore: enough behaviour to exercise the
// handlers' status codes, validation and denial recording without a database.
// The database behaviour itself is covered by
// internal/store/postgres/projects_test.go.
type prjFakeStore struct {
	byID      map[string]ProjectView
	repos     map[string][]RepositoryView
	members   map[string][]MemberView
	nextID    int
	created   []prjCreateCall
	added     []prjAddCall
	patched   []prjPatchCall
	put       []prjPutCall
	denied    []prjDenial
	customErr error // returned by the next call instead of the normal answer
}

type prjCreateCall struct{ name, slug, description string }
type prjAddCall struct {
	projectID, name, gitURL, defaultBranch, credentialSecretID string
}
type prjPatchCall struct {
	projectID, repositoryID, credentialSecretID string
}
type prjPutCall struct {
	projectID, userID, role string
}
type prjDenial struct {
	projectID, action string
}

func prjNewFakeStore() *prjFakeStore {
	return &prjFakeStore{
		byID:    map[string]ProjectView{},
		repos:   map[string][]RepositoryView{},
		members: map[string][]MemberView{},
		nextID:  1,
	}
}

func (f *prjFakeStore) addProject(p ProjectView) string {
	if p.ID == "" {
		p.ID = fmt.Sprintf("p%d", f.nextID)
	}
	f.nextID++
	if p.Version == 0 {
		p.Version = 1
	}
	f.byID[p.ID] = p
	if _, ok := f.members[p.ID]; !ok {
		f.members[p.ID] = []MemberView{{UserID: "u-1", DisplayName: "David", Role: "maintainer"}}
	}
	return p.ID
}

func (f *prjFakeStore) ListProjects(ctx context.Context, c Caller) ([]ProjectView, error) {
	if f.customErr != nil {
		return nil, f.customErr
	}
	ids := make([]string, 0, len(f.byID))
	for id := range f.byID {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	out := make([]ProjectView, 0, len(ids))
	for _, id := range ids {
		p := f.byID[id]
		if authz.CanView(c.IsOrgAdmin, authz.Role(p.MyRole)) {
			out = append(out, prjAsCaller(p, c))
		}
	}
	return out, nil
}

func (f *prjFakeStore) CreateProject(ctx context.Context, c Caller, name, slug, description string) (ProjectView, error) {
	if f.customErr != nil {
		return ProjectView{}, f.customErr
	}
	f.created = append(f.created, prjCreateCall{name, slug, description})
	for _, p := range f.byID {
		if p.Slug == slug {
			return ProjectView{}, ErrProjectConflict
		}
	}
	p := ProjectView{
		ID:          fmt.Sprintf("p%d", f.nextID),
		Slug:        slug,
		Name:        name,
		Description: description,
		CreatedAt:   prjFixedTime,
		Version:     1,
		MyRole:      string(authz.RoleMaintainer),
	}
	f.nextID++
	f.byID[p.ID] = p
	f.members[p.ID] = []MemberView{{UserID: c.UserID, DisplayName: "David", Role: "maintainer"}}
	return p, nil
}

func (f *prjFakeStore) GetProject(ctx context.Context, c Caller, projectID string) (ProjectView, error) {
	if f.customErr != nil {
		return ProjectView{}, f.customErr
	}
	p, ok := f.byID[projectID]
	if !ok {
		return ProjectView{}, ErrProjectNotFound
	}
	if !authz.CanView(c.IsOrgAdmin, authz.Role(p.MyRole)) {
		return ProjectView{}, ErrProjectNotFound
	}
	return prjAsCaller(p, c), nil
}

// prjAsCaller mirrors the store's COALESCE(m.role, 'maintainer'): an org admin
// with no explicit membership is reported as maintainer (Project.my_role in
// api/openapi.yaml).
func prjAsCaller(p ProjectView, c Caller) ProjectView {
	if c.IsOrgAdmin && p.MyRole == "" {
		p.MyRole = string(authz.RoleMaintainer)
	}
	return p
}

func (f *prjFakeStore) ListRepositories(ctx context.Context, c Caller, projectID string) ([]RepositoryView, error) {
	if f.customErr != nil {
		return nil, f.customErr
	}
	if _, err := f.GetProject(ctx, c, projectID); err != nil {
		return nil, err
	}
	return f.repos[projectID], nil
}

func (f *prjFakeStore) AddRepository(ctx context.Context, c Caller, projectID, name, gitURL, defaultBranch, credentialSecretID string) (RepositoryView, error) {
	if f.customErr != nil {
		return RepositoryView{}, f.customErr
	}
	p, err := f.GetProject(ctx, c, projectID)
	if err != nil {
		return RepositoryView{}, err
	}
	if !authz.CanManage(c.IsOrgAdmin, authz.Role(p.MyRole)) {
		return RepositoryView{}, ErrProjectNotFound
	}
	// The fake repeats the contract's one refusal the handlers must map:
	// a credential the store deems invalid for the project.
	if credentialSecretID == prjTBadCredential {
		return RepositoryView{}, ErrRepositoryCredentialInvalid
	}
	f.added = append(f.added, prjAddCall{projectID, name, gitURL, defaultBranch, credentialSecretID})
	for _, r := range f.repos[projectID] {
		if r.Name == name {
			return RepositoryView{}, ErrProjectConflict
		}
	}
	r := RepositoryView{
		ID:            fmt.Sprintf("r%d", f.nextID),
		ProjectID:     projectID,
		Name:          name,
		GitURL:        gitURL,
		DefaultBranch: defaultBranch,
		CreatedAt:     prjFixedTime,
	}
	prjApplyCredential(&r, credentialSecretID)
	f.nextID++
	f.repos[projectID] = append(f.repos[projectID], r)
	return r, nil
}

// prjTBadCredential is the fixture's "the store refused this credential".
const prjTBadCredential = "00000000-0000-7000-8000-00000000badc"

func prjApplyCredential(r *RepositoryView, credentialSecretID string) {
	r.CredentialSecretID = nil
	r.Credential = "none"
	if credentialSecretID != "" {
		cred := credentialSecretID
		r.CredentialSecretID = &cred
		r.Credential = "configured"
	}
}

func (f *prjFakeStore) PatchRepositoryCredential(ctx context.Context, c Caller, projectID, repositoryID, credentialSecretID string) (RepositoryView, error) {
	if f.customErr != nil {
		return RepositoryView{}, f.customErr
	}
	p, err := f.GetProject(ctx, c, projectID)
	if err != nil {
		return RepositoryView{}, err
	}
	if !authz.CanManage(c.IsOrgAdmin, authz.Role(p.MyRole)) {
		return RepositoryView{}, ErrProjectNotFound
	}
	if credentialSecretID == prjTBadCredential {
		return RepositoryView{}, ErrRepositoryCredentialInvalid
	}
	f.patched = append(f.patched, prjPatchCall{projectID, repositoryID, credentialSecretID})
	for i, r := range f.repos[projectID] {
		if r.ID != repositoryID {
			continue
		}
		prjApplyCredential(&r, credentialSecretID)
		f.repos[projectID][i] = r
		return r, nil
	}
	return RepositoryView{}, ErrProjectNotFound
}

func (f *prjFakeStore) ListMembers(ctx context.Context, c Caller, projectID string) ([]MemberView, error) {
	if f.customErr != nil {
		return nil, f.customErr
	}
	if _, err := f.GetProject(ctx, c, projectID); err != nil {
		return nil, err
	}
	return f.members[projectID], nil
}

func (f *prjFakeStore) PutMember(ctx context.Context, c Caller, projectID, userID, role string) (MemberView, error) {
	if f.customErr != nil {
		return MemberView{}, f.customErr
	}
	p, err := f.GetProject(ctx, c, projectID)
	if err != nil {
		return MemberView{}, err
	}
	if !authz.CanManage(c.IsOrgAdmin, authz.Role(p.MyRole)) {
		return MemberView{}, ErrProjectNotFound
	}
	f.put = append(f.put, prjPutCall{projectID, userID, role})
	member := MemberView{UserID: userID, DisplayName: "User " + userID, Role: role}
	next := f.members[projectID]
	replaced := false
	for i := range next {
		if next[i].UserID == userID {
			next[i].Role = role
			replaced = true
		}
	}
	if !replaced {
		next = append(next, member)
	}
	f.members[projectID] = next
	// The fake mirrors the real store: adding a member makes the project
	// visible to them.
	f.byID[projectID] = p
	return member, nil
}

func (f *prjFakeStore) RecordDenied(ctx context.Context, c Caller, projectID, action string) error {
	f.denied = append(f.denied, prjDenial{projectID, action})
	return nil
}

// --- test helpers -------------------------------------------------------

var prjFixedTime = func() time.Time {
	t, err := time.Parse(time.RFC3339, "2026-10-14T18:00:00Z")
	if err != nil {
		panic(err)
	}
	return t.UTC()
}()

func prjServer(t *testing.T, store ProjectStore, auth Authenticator) *Server {
	t.Helper()
	s := New(Config{ReplicaName: "replica-a", Version: "dev", PublicURL: "http://localhost:8080",
		Logger: discardLogger()}, fakeReadiness{expected: 1}, auth, nil)
	RegisterProjects(s, store)
	return s
}

// prjAs returns an authenticator for a principal with the given identity.
func prjAs(userID string, orgAdmin bool) Authenticator {
	return principalAuth(&Principal{
		UserID:         userID,
		OrganizationID: "o-1",
		DisplayName:    userID,
		CSRFToken:      prjCSRF,
		IsOrgAdmin:     orgAdmin,
	}, nil)
}

const prjCSRF = "csrf-token-value"

// prjPost builds a same-origin browser-style mutation: JSON body, the
// session's CSRF token and an Origin matching the server's public URL.
func prjPost(method, path, body string) *http.Request {
	r := httptest.NewRequest(method, "http://localhost:8080"+path, strings.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set(HeaderCSRFToken, prjCSRF)
	r.Header.Set("Origin", "http://localhost:8080")
	return r
}

// prjFields returns the JSON object's member names, sorted.
func prjFields(t *testing.T, raw []byte) []string {
	t.Helper()
	var m map[string]json.RawMessage
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatalf("decode JSON object %q: %v", raw, err)
	}
	names := make([]string, 0, len(m))
	for k := range m {
		names = append(names, k)
	}
	sort.Strings(names)
	return names
}

func prjWantFields(t *testing.T, raw []byte, want ...string) {
	t.Helper()
	got := prjFields(t, raw)
	wantSorted := append([]string(nil), want...)
	sort.Strings(wantSorted)
	if strings.Join(got, ",") != strings.Join(wantSorted, ",") {
		t.Errorf("JSON members = %v, want %v (body %s)", got, wantSorted, raw)
	}
}

func prjEqual(t *testing.T, got, want any, what string) {
	t.Helper()
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Errorf("%s = %v, want %v", what, got, want)
	}
}

// --- tests --------------------------------------------------------------

func TestCreateProjectReturns201WithContractShape(t *testing.T) {
	store := prjNewFakeStore()
	srv := prjServer(t, store, prjAs("u-1", false))

	rec := do(t, srv, prjPost(http.MethodPost, "/api/v1/projects",
		`{"name":"Widgets","description":"Widget incubator"}`))
	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, want 201 (body %s)", rec.Code, rec.Body)
	}
	prjWantFields(t, rec.Body.Bytes(),
		"id", "slug", "name", "description", "created_at", "version", "my_role")
	body := decodeBody(t, rec)
	prjEqual(t, body["slug"], "widgets", "derived slug")
	prjEqual(t, body["name"], "Widgets", "name")
	prjEqual(t, body["description"], "Widget incubator", "description")
	prjEqual(t, body["version"], float64(1), "version")
	prjEqual(t, body["my_role"], "maintainer", "my_role")
	prjEqual(t, body["created_at"], "2026-10-14T18:00:00Z", "created_at is RFC 3339")
	if got := rec.Header().Get(HeaderReplica); got != "replica-a" {
		t.Errorf("%s = %q, want replica-a", HeaderReplica, got)
	}
	if len(store.created) != 1 || store.created[0].slug != "widgets" {
		t.Errorf("store saw %+v, want one create with slug widgets", store.created)
	}
}

func TestCreateProjectExplicitSlug(t *testing.T) {
	store := prjNewFakeStore()
	srv := prjServer(t, store, prjAs("u-1", false))
	rec := do(t, srv, prjPost(http.MethodPost, "/api/v1/projects",
		`{"name":"Widgets","slug":"widget-lab"}`))
	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, want 201 (body %s)", rec.Code, rec.Body)
	}
	prjEqual(t, decodeBody(t, rec)["slug"], "widget-lab", "slug")
}

func TestCreateProjectValidation(t *testing.T) {
	for _, tt := range []struct {
		name, body, detailPart string
	}{
		{"missing name", `{"slug":"x"}`, "name is required"},
		{"blank name", `{"name":"   "}`, "name is required"},
		{"name too long", `{"name":"` + strings.Repeat("a", 201) + `"}`, "at most 200 characters"},
		{"description too long", `{"name":"W","description":"` + strings.Repeat("d", 2001) + `"}`, "at most 2000 characters"},
		{"uppercase slug", `{"name":"W","slug":"Widgets"}`, "slug must match"},
		{"slug with space", `{"name":"W","slug":"bad slug"}`, "slug must match"},
		{"slug too long", `{"name":"W","slug":"` + strings.Repeat("a", 41) + `"}`, "slug must match"},
		{"slug leading hyphen", `{"name":"W","slug":"-widgets"}`, "slug must match"},
		{"slug trailing hyphen", `{"name":"W","slug":"widgets-"}`, "slug must match"},
		{"nothing sluggable", `{"name":"???"}`, "derive a slug"},
	} {
		t.Run(tt.name, func(t *testing.T) {
			store := prjNewFakeStore()
			srv := prjServer(t, store, prjAs("u-1", false))
			rec := do(t, srv, prjPost(http.MethodPost, "/api/v1/projects", tt.body))
			if rec.Code != http.StatusUnprocessableEntity {
				t.Fatalf("status = %d, want 422 (body %s)", rec.Code, rec.Body)
			}
			p := decodeProblem(t, rec)
			if !strings.Contains(p.Detail, tt.detailPart) {
				t.Errorf("detail = %q, want it to mention %q", p.Detail, tt.detailPart)
			}
			if len(store.created) != 0 {
				t.Errorf("store was written despite validation failure: %+v", store.created)
			}
		})
	}
}

func TestCreateProjectDuplicateSlugIs409(t *testing.T) {
	store := prjNewFakeStore()
	store.addProject(ProjectView{Slug: "widgets", Name: "Widgets", MyRole: "maintainer"})
	srv := prjServer(t, store, prjAs("u-1", false))

	rec := do(t, srv, prjPost(http.MethodPost, "/api/v1/projects", `{"name":"Widgets"}`))
	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409 (body %s)", rec.Code, rec.Body)
	}
	p := decodeProblem(t, rec)
	prjEqual(t, p.Status, http.StatusConflict, "problem status")
	if !strings.Contains(p.Detail, "slug") {
		t.Errorf("detail = %q, want it to name the slug", p.Detail)
	}
}

func TestMutationsRequireCSRFToken(t *testing.T) {
	for _, tt := range []struct{ name, csrf, origin string }{
		{"missing token", "", "http://localhost:8080"},
		{"wrong token", "not-the-token", "http://localhost:8080"},
		{"foreign origin", prjCSRF, "https://evil.example"},
	} {
		t.Run(tt.name, func(t *testing.T) {
			store := prjNewFakeStore()
			srv := prjServer(t, store, prjAs("u-1", false))
			r := prjPost(http.MethodPost, "/api/v1/projects", `{"name":"Widgets"}`)
			if tt.csrf == "" {
				r.Header.Del(HeaderCSRFToken)
			} else {
				r.Header.Set(HeaderCSRFToken, tt.csrf)
			}
			r.Header.Set("Origin", tt.origin)
			rec := do(t, srv, r)
			if rec.Code != http.StatusForbidden {
				t.Fatalf("status = %d, want 403 (body %s)", rec.Code, rec.Body)
			}
			decodeProblem(t, rec)
			if len(store.created) != 0 {
				t.Errorf("store written despite CSRF rejection: %+v", store.created)
			}
		})
	}
}

func TestUnauthenticatedRequestsAre401(t *testing.T) {
	srv := prjServer(t, prjNewFakeStore(), principalAuth(nil, ErrUnauthenticated))
	rec := do(t, srv, request(http.MethodGet, "http://localhost:8080/api/v1/projects", nil))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
	decodeProblem(t, rec)
}

func TestListProjectsAlwaysReturnsAnItemsArray(t *testing.T) {
	srv := prjServer(t, prjNewFakeStore(), prjAs("u-1", false))
	rec := do(t, srv, request(http.MethodGet, "http://localhost:8080/api/v1/projects", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %s)", rec.Code, rec.Body)
	}
	prjEqual(t, strings.TrimSpace(rec.Body.String()), `{"items":[]}`, "empty list is an array, not null")
}

func TestGetProjectNonMemberIs404AndAudits(t *testing.T) {
	store := prjNewFakeStore()
	id := store.addProject(ProjectView{Slug: "secret", Name: "Secret", MyRole: ""})
	srv := prjServer(t, store, prjAs("u-9", false))

	rec := do(t, srv, request(http.MethodGet, "http://localhost:8080/api/v1/projects/"+id, nil))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404 (body %s)", rec.Code, rec.Body)
	}
	decodeProblem(t, rec)
	prjEqual(t, store.denied, []prjDenial{{projectID: id, action: "project.get"}}, "audit denial")
}

func TestGetProjectUnknownIs404AndAudits(t *testing.T) {
	store := prjNewFakeStore()
	srv := prjServer(t, store, prjAs("u-1", false))
	rec := do(t, srv, request(http.MethodGet, "http://localhost:8080/api/v1/projects/nope", nil))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
	if len(store.denied) != 1 || store.denied[0].action != "project.get" {
		t.Errorf("denials = %+v, want one project.get", store.denied)
	}
}

func TestOrgAdminSeesProjectWithoutMembership(t *testing.T) {
	store := prjNewFakeStore()
	id := store.addProject(ProjectView{Slug: "secret", Name: "Secret", MyRole: ""})
	srv := prjServer(t, store, prjAs("u-admin", true))

	rec := do(t, srv, request(http.MethodGet, "http://localhost:8080/api/v1/projects/"+id, nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %s)", rec.Code, rec.Body)
	}
	prjEqual(t, decodeBody(t, rec)["my_role"], "maintainer", "admin my_role")
}

func TestReadsReturnContractShapes(t *testing.T) {
	store := prjNewFakeStore()
	id := store.addProject(ProjectView{Slug: "widgets", Name: "Widgets", MyRole: "contributor"})
	store.repos[id] = []RepositoryView{{
		ID: "r1", ProjectID: id, Name: "communication", GitURL: "https://github.com/example/communication.git",
		DefaultBranch: "main", CreatedAt: prjFixedTime, Credential: "none",
	}}
	store.members[id] = []MemberView{{UserID: "u-1", DisplayName: "David", Role: "contributor"}}
	srv := prjServer(t, store, prjAs("u-1", false))

	for _, tt := range []struct {
		path string
		item []string
	}{
		{"/api/v1/projects/" + id + "/repos", []string{"id", "project_id", "name", "git_url", "default_branch", "created_at", "credential", "credential_secret_id"}},
		{"/api/v1/projects/" + id + "/members", []string{"user_id", "display_name", "role"}},
	} {
		rec := do(t, srv, request(http.MethodGet, "http://localhost:8080"+tt.path, nil))
		if rec.Code != http.StatusOK {
			t.Fatalf("GET %s: status = %d, want 200 (body %s)", tt.path, rec.Code, rec.Body)
		}
		prjWantFields(t, rec.Body.Bytes(), "items")
		var list struct {
			Items []map[string]json.RawMessage `json:"items"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &list); err != nil {
			t.Fatalf("decode %s: %v", rec.Body, err)
		}
		if len(list.Items) != 1 {
			t.Fatalf("items = %d, want 1", len(list.Items))
		}
		got := make([]string, 0, len(list.Items[0]))
		for k := range list.Items[0] {
			got = append(got, k)
		}
		sort.Strings(got)
		want := append([]string(nil), tt.item...)
		sort.Strings(want)
		if strings.Join(got, ",") != strings.Join(want, ",") {
			t.Errorf("item members = %v, want %v", got, want)
		}
	}
}

func TestViewerCannotAddRepositoryButCanRead(t *testing.T) {
	store := prjNewFakeStore()
	id := store.addProject(ProjectView{Slug: "widgets", Name: "Widgets", MyRole: "viewer"})
	srv := prjServer(t, store, prjAs("u-1", false))

	rec := do(t, srv, prjPost(http.MethodPost, "/api/v1/projects/"+id+"/repos",
		`{"name":"communication","git_url":"https://github.com/example/communication.git"}`))
	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403 (body %s)", rec.Code, rec.Body)
	}
	decodeProblem(t, rec)
	if len(store.added) != 0 {
		t.Errorf("store.added = %+v, want nothing", store.added)
	}
	prjEqual(t, store.denied, []prjDenial{{projectID: id, action: "repository.add"}}, "audit denial")

	// Reading is still allowed for a viewer.
	rec = do(t, srv, request(http.MethodGet, "http://localhost:8080/api/v1/projects/"+id+"/repos", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("GET repos as viewer: status = %d, want 200", rec.Code)
	}
}

func TestMaintainerCanAddAndChangeMembers(t *testing.T) {
	store := prjNewFakeStore()
	id := store.addProject(ProjectView{Slug: "widgets", Name: "Widgets", MyRole: "maintainer"})
	srv := prjServer(t, store, prjAs("u-1", false))

	rec := do(t, srv, prjPost(http.MethodPost, "/api/v1/projects/"+id+"/repos",
		`{"name":"communication","git_url":"git@github.com:example/communication.git"}`))
	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, want 201 (body %s)", rec.Code, rec.Body)
	}
	prjWantFields(t, rec.Body.Bytes(),
		"id", "project_id", "name", "git_url", "default_branch", "created_at", "credential", "credential_secret_id")
	body := decodeBody(t, rec)
	prjEqual(t, body["project_id"], id, "project_id")
	prjEqual(t, body["default_branch"], "main", "default_branch defaults to main")
	prjEqual(t, store.added, []prjAddCall{{
		projectID: id, name: "communication", gitURL: "git@github.com:example/communication.git", defaultBranch: "main",
	}}, "store call")

	rec = do(t, srv, prjPost(http.MethodPut, "/api/v1/projects/"+id+"/members/u-2", `{"role":"contributor"}`))
	if rec.Code != http.StatusOK {
		t.Fatalf("PUT member: status = %d, want 200 (body %s)", rec.Code, rec.Body)
	}
	prjWantFields(t, rec.Body.Bytes(), "user_id", "display_name", "role")
	prjEqual(t, decodeBody(t, rec)["role"], "contributor", "role")
}

func TestAddRepositoryValidationAndConflicts(t *testing.T) {
	store := prjNewFakeStore()
	id := store.addProject(ProjectView{Slug: "widgets", Name: "Widgets", MyRole: "maintainer"})
	store.repos[id] = []RepositoryView{{ID: "r1", ProjectID: id, Name: "communication", DefaultBranch: "main"}}
	srv := prjServer(t, store, prjAs("u-1", false))

	for _, tt := range []struct {
		name, body, detailPart string
		status                 int
	}{
		{"bad name", `{"name":"bad name","git_url":"https://git/x.git"}`, "repository name must match", http.StatusUnprocessableEntity},
		{"empty name", `{"name":"","git_url":"https://git/x.git"}`, "repository name must match", http.StatusUnprocessableEntity},
		{"dot name", `{"name":"..","git_url":"https://git/x.git"}`, "must not be . or ..", http.StatusUnprocessableEntity},
		{"http scheme", `{"name":"x","git_url":"http://github.com/example/repo.git"}`, "git_url must be https://, ssh://, git@host:path or file://", http.StatusUnprocessableEntity},
		{"bare host", `{"name":"x","git_url":"https://github.com"}`, "git_url must be https://, ssh://, git@host:path or file://", http.StatusUnprocessableEntity},
		{"duplicate name", `{"name":"communication","git_url":"https://github.com/example/communication.git"}`, "already exists", http.StatusConflict},
	} {
		t.Run(tt.name, func(t *testing.T) {
			rec := do(t, srv, prjPost(http.MethodPost, "/api/v1/projects/"+id+"/repos", tt.body))
			if rec.Code != tt.status {
				t.Fatalf("status = %d, want %d (body %s)", rec.Code, tt.status, rec.Body)
			}
			p := decodeProblem(t, rec)
			if !strings.Contains(p.Detail, tt.detailPart) {
				t.Errorf("detail = %q, want it to mention %q", p.Detail, tt.detailPart)
			}
		})
	}
}

func TestPutMemberRejectsUnknownRole(t *testing.T) {
	store := prjNewFakeStore()
	id := store.addProject(ProjectView{Slug: "widgets", Name: "Widgets", MyRole: "maintainer"})
	srv := prjServer(t, store, prjAs("u-1", false))

	rec := do(t, srv, prjPost(http.MethodPut, "/api/v1/projects/"+id+"/members/u-2", `{"role":"owner"}`))
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d, want 422 (body %s)", rec.Code, rec.Body)
	}
	decodeProblem(t, rec)
	if len(store.put) != 0 {
		t.Errorf("store.put = %+v, want nothing", store.put)
	}

	rec = do(t, srv, prjPost(http.MethodPut, "/api/v1/projects/does-not-exist/members/u-2", `{"role":"viewer"}`))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404 (body %s)", rec.Code, rec.Body)
	}
}

func TestStoreInternalErrorIs500WithoutLeaking(t *testing.T) {
	store := prjNewFakeStore()
	store.customErr = errStoreDown
	srv := prjServer(t, store, prjAs("u-1", false))

	rec := do(t, srv, request(http.MethodGet, "http://localhost:8080/api/v1/projects", nil))
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500 (body %s)", rec.Code, rec.Body)
	}
	p := decodeProblem(t, rec)
	if strings.Contains(p.Detail, "pool") || strings.Contains(rec.Body.String(), "connection timeout") {
		t.Errorf("internal detail leaked to the client: %q", p.Detail)
	}
}

func TestDeriveSlug(t *testing.T) {
	for _, tt := range []struct{ name, want string }{
		{"Widgets", "widgets"},
		{"Widget  Lab!", "widget-lab"},
		{"  Trimmed Now  ", "trimmed-now"},
		{"Ünicode Name", "nicode-name"},
		{"a/b@c", "a-b-c"},
		{"2026 Roadmap", "2026-roadmap"},
		{"!!!", ""},
		{strings.Repeat("a", 50), strings.Repeat("a", 40)},
		{"run " + strings.Repeat("x", 45), "run-" + strings.Repeat("x", 36)},
	} {
		if got := prjDeriveSlug(tt.name); got != tt.want {
			t.Errorf("prjDeriveSlug(%q) = %q, want %q", tt.name, got, tt.want)
		}
		if tt.want != "" && !prjSlugPattern.MatchString(tt.want) {
			t.Errorf("derived slug %q does not satisfy the slug pattern", tt.want)
		}
	}
}

func TestProjectRoutesAreNotFoundForOtherMethods(t *testing.T) {
	srv := prjServer(t, prjNewFakeStore(), prjAs("u-1", false))
	rec := do(t, srv, prjPost(http.MethodDelete, "/api/v1/projects/p1", ``))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404 (body %s)", rec.Code, rec.Body)
	}
	decodeProblem(t, rec)
}

// --- ADR-0061: the repository's GitHub credential -------------------------

// prjTBrokerCredential is the fixture's integration_broker secret id;
// prjTBadCredential (defined with the fake store) is the id the store refuses.
const prjTBrokerCredential = "01987a6c-0000-7000-8000-00000000b0b1"

// TestAddRepositoryCredentialShape pins the ADR-0061 response contract: a
// create with a credential carries credential_secret_id and the derived
// credential "configured"; one without carries an explicit null and "none".
// No field could carry the value even if something tried.
func TestAddRepositoryCredentialShape(t *testing.T) {
	store := prjNewFakeStore()
	id := store.addProject(ProjectView{Slug: "widgets", Name: "Widgets", MyRole: "maintainer"})
	srv := prjServer(t, store, prjAs("u-1", false))

	rec := do(t, srv, prjPost(http.MethodPost, "/api/v1/projects/"+id+"/repos",
		`{"name":"backend","git_url":"https://github.com/example/backend.git","credential_secret_id":"`+prjTBrokerCredential+`"}`))
	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, want 201 (body %s)", rec.Code, rec.Body)
	}
	prjWantFields(t, rec.Body.Bytes(),
		"id", "project_id", "name", "git_url", "default_branch", "created_at",
		"credential_secret_id", "credential")
	body := decodeBody(t, rec)
	prjEqual(t, body["credential_secret_id"], prjTBrokerCredential, "credential_secret_id")
	prjEqual(t, body["credential"], "configured", "credential")
	prjEqual(t, store.added, []prjAddCall{{
		projectID: id, name: "backend", gitURL: "https://github.com/example/backend.git",
		defaultBranch: "main", credentialSecretID: prjTBrokerCredential,
	}}, "store call")

	rec = do(t, srv, prjPost(http.MethodPost, "/api/v1/projects/"+id+"/repos",
		`{"name":"frontend","git_url":"https://github.com/example/frontend.git"}`))
	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, want 201 (body %s)", rec.Code, rec.Body)
	}
	body = decodeBody(t, rec)
	if v, ok := body["credential_secret_id"]; !ok || v != nil {
		t.Errorf("wire credential_secret_id = %v (present=%v), want explicit null", v, ok)
	}
	prjEqual(t, body["credential"], "none", "credential without a secret")
}

// TestAddRepositoryCredentialRefused pins the typed 422 `invalid_credential_secret`:
// a malformed id is refused by the handler, a secret the store deems invalid
// (another project's, or an env-mode one) is refused with the same code, and
// neither write reaches the store.
func TestAddRepositoryCredentialRefused(t *testing.T) {
	store := prjNewFakeStore()
	id := store.addProject(ProjectView{Slug: "widgets", Name: "Widgets", MyRole: "maintainer"})
	srv := prjServer(t, store, prjAs("u-1", false))

	for _, tt := range []struct{ name, cred string }{
		{"malformed id", "not-a-uuid"},
		{"store-refused secret", prjTBadCredential},
	} {
		t.Run(tt.name, func(t *testing.T) {
			before := len(store.added)
			rec := do(t, srv, prjPost(http.MethodPost, "/api/v1/projects/"+id+"/repos",
				`{"name":"cred-repo","git_url":"https://github.com/example/cred.git","credential_secret_id":"`+tt.cred+`"}`))
			if rec.Code != http.StatusUnprocessableEntity {
				t.Fatalf("status = %d, want 422 (body %s)", rec.Code, rec.Body)
			}
			if !strings.Contains(rec.Body.String(), "invalid_credential_secret") {
				t.Errorf("body has no invalid_credential_secret code: %s", rec.Body)
			}
			if len(store.added) != before {
				t.Errorf("store was called with a refused credential: %+v", store.added)
			}
		})
	}
}

// TestPatchRepositoryCredentialSetsAndClears is the ADR's null-clears rule:
// a patch with a uuid configures, a patch with null clears, a patch naming no
// field or a malformed value refuses, an unknown repository is the same 404
// every repository route gives, and a read-only role cannot patch at all.
func TestPatchRepositoryCredentialSetsAndClears(t *testing.T) {
	store := prjNewFakeStore()
	id := store.addProject(ProjectView{Slug: "widgets", Name: "Widgets", MyRole: "maintainer"})
	// The route names the repository by uuid (pathUUID rules), so the fixture
	// row carries one too.
	const repoID = "01987a6f-7a8b-7c9d-a0e1-f2b3c4d5e6f1"
	store.repos[id] = []RepositoryView{{
		ID: repoID, ProjectID: id, Name: "communication",
		GitURL: "https://github.com/example/communication.git", DefaultBranch: "main",
		CreatedAt: prjFixedTime, Credential: "none",
	}}
	srv := prjServer(t, store, prjAs("u-1", false))
	base := "/api/v1/projects/" + id + "/repos/" + repoID

	rec := do(t, srv, prjPost(http.MethodPatch, base,
		`{"credential_secret_id":"`+prjTBrokerCredential+`"}`))
	if rec.Code != http.StatusOK {
		t.Fatalf("set: status = %d, want 200 (body %s)", rec.Code, rec.Body)
	}
	body := decodeBody(t, rec)
	prjEqual(t, body["credential"], "configured", "set credential")
	prjEqual(t, body["credential_secret_id"], prjTBrokerCredential, "set credential_secret_id")

	rec = do(t, srv, prjPost(http.MethodPatch, base, `{"credential_secret_id":null}`))
	if rec.Code != http.StatusOK {
		t.Fatalf("clear: status = %d, want 200 (body %s)", rec.Code, rec.Body)
	}
	body = decodeBody(t, rec)
	if v, ok := body["credential_secret_id"]; !ok || v != nil {
		t.Errorf("cleared credential_secret_id = %v (present=%v), want explicit null", v, ok)
	}
	prjEqual(t, body["credential"], "none", "cleared credential")
	if len(store.patched) != 2 ||
		store.patched[0].credentialSecretID != prjTBrokerCredential ||
		store.patched[1].credentialSecretID != "" {
		t.Errorf("store patch calls = %+v, want set then clear", store.patched)
	}

	for _, tt := range []struct {
		name, body string
		want       int
		code       string
	}{
		{"missing field", `{}`, 422, ""},
		{"malformed id", `{"credential_secret_id":"nope"}`, 422, "invalid_credential_secret"},
		{"store-refused id", `{"credential_secret_id":"` + prjTBadCredential + `"}`, 422, "invalid_credential_secret"},
	} {
		t.Run(tt.name, func(t *testing.T) {
			rec := do(t, srv, prjPost(http.MethodPatch, base, tt.body))
			if rec.Code != tt.want {
				t.Fatalf("status = %d, want %d (body %s)", rec.Code, tt.want, rec.Body)
			}
			if tt.code != "" && !strings.Contains(rec.Body.String(), tt.code) {
				t.Errorf("body has no %s code: %s", tt.code, rec.Body)
			}
		})
	}

	rec = do(t, srv, prjPost(http.MethodPatch,
		"/api/v1/projects/"+id+"/repos/01987a6f-7a8b-7c9d-a0e1-f2b3c4d5e6ff",
		`{"credential_secret_id":null}`))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("unknown repository: status = %d, want 404 (body %s)", rec.Code, rec.Body)
	}

	// A viewer (read-only role) cannot patch: the same 403 the other
	// mutations give, and the store sees nothing.
	store2 := prjNewFakeStore()
	id2 := store2.addProject(ProjectView{Slug: "other", Name: "Other", MyRole: "viewer"})
	store2.repos[id2] = []RepositoryView{{ID: "01987a6f-7a8b-7c9d-a0e1-f2b3c4d5e6f1", ProjectID: id2, Name: "communication", Credential: "none"}}
	srv2 := prjServer(t, store2, prjAs("u-view", false))
	rec = do(t, srv2, prjPost(http.MethodPatch,
		"/api/v1/projects/"+id2+"/repos/01987a6f-7a8b-7c9d-a0e1-f2b3c4d5e6f1",
		`{"credential_secret_id":null}`))
	if rec.Code != http.StatusForbidden {
		t.Fatalf("viewer patch: status = %d, want 403 (body %s)", rec.Code, rec.Body)
	}
	if len(store2.patched) != 0 {
		t.Errorf("store.patched = %+v, want nothing", store2.patched)
	}
}
