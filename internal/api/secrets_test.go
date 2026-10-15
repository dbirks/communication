package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/dbirks/communication/internal/authz"
)

// The secret surface is the one part of M3 whose central claim is a *negative*:
// no route returns a value. A test can only prove a negative over a closed set,
// so this file closes the set three ways — every route is exercised against a
// store that was handed a sentinel value, every response body is scanned for that
// sentinel and for a member named value, and the interface and view types are
// reflected over so the shape cannot acquire the field later.

const (
	secTSentinel  = "dckr_pat_TSENTINELvalue"
	secTProject   = "11111111-1111-4111-8111-111111111111"
	secTOther     = "22222222-2222-4222-8222-222222222222"
	secTSecret    = "33333333-3333-4333-8333-333333333333"
	secTSecretB   = "44444444-4444-4444-8444-444444444444"
	secTMount     = "55555555-5555-4555-8555-555555555555"
	secTRepo      = "66666666-6666-4666-8666-666666666666"
	secTProfile   = "77777777-7777-4777-8777-777777777777"
	secTNow       = "2026-03-01T10:00:00Z"
	secTLBOrigins = "http://localhost:8080"
)

// --- fake secret store --------------------------------------------------

type secFakeStore struct {
	secrets          map[string]SecretView
	byProject        map[string][]string
	mounts           map[string]SecretMountView
	materializations map[string][]SecretMaterializationView
	created          []SecretCreateInput
	versions         []secVersionCall
	policies         []secPolicyCall
	mountCreates     []SecretMountInput
	deletes          []secDeleteCall
	loaded           []string
	err              error
}

type secVersionCall struct {
	projectID, secretID string
	value               []byte
}
type secPolicyCall struct {
	projectID, secretID string
	in                  SecretPolicyInput
}
type secDeleteCall struct{ projectID, mountID string }

func secNewFakeStore() *secFakeStore {
	return &secFakeStore{
		secrets:          map[string]SecretView{},
		byProject:        map[string][]string{},
		mounts:           map[string]SecretMountView{},
		materializations: map[string][]SecretMaterializationView{},
	}
}

func secTime() time.Time { t, _ := time.Parse(time.RFC3339, secTNow); return t }

func (f *secFakeStore) putSecret(projectID string, v SecretView) {
	v.CreatedAt = secTime()
	if v.ID == "" {
		v.ID = fmt.Sprintf("%08d-0000-4000-8000-000000000000", len(f.secrets)+1)
	}
	f.secrets[v.ID] = v
	f.byProject[projectID] = append(f.byProject[projectID], v.ID)
}

func (f *secFakeStore) ListSecrets(ctx context.Context, c Caller, projectID string) ([]SecretView, error) {
	f.loaded = append(f.loaded, "list:"+projectID)
	if f.err != nil {
		return nil, f.err
	}
	var out []SecretView
	for _, id := range f.byProject[projectID] {
		out = append(out, f.secrets[id])
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Slug < out[j].Slug })
	return out, nil
}

func (f *secFakeStore) CreateSecret(ctx context.Context, c Caller, projectID string, in SecretCreateInput) (SecretView, error) {
	f.created = append(f.created, in)
	if f.err != nil {
		return SecretView{}, f.err
	}
	for _, id := range f.byProject[projectID] {
		if f.secrets[id].Slug == in.Slug {
			return SecretView{}, ErrSecretConflict
		}
	}
	v := SecretView{
		ID:   fmt.Sprintf("%08d-0000-4000-8000-000000000000", len(f.secrets)+1),
		Slug: in.Slug, Scope: "project", Purpose: in.Purpose,
		Delivery: in.DeliveryMode, CurrentVS: 1, Profiles: in.Profiles,
		Audit: "materialization", CreatedAt: secTime(),
	}
	if in.Scope == "org" {
		v.Scope = "org"
	}
	f.putSecret(projectID, v)
	return v, nil
}

func (f *secFakeStore) UpdateSecret(ctx context.Context, c Caller, projectID, secretID string, in SecretPolicyInput) (SecretView, error) {
	f.policies = append(f.policies, secPolicyCall{projectID, secretID, in})
	if f.err != nil {
		return SecretView{}, f.err
	}
	v, ok := f.secrets[secretID]
	if !ok || !secInProject(f, projectID, secretID) {
		return SecretView{}, ErrProjectNotFound
	}
	v.Purpose = in.Purpose
	v.Profiles = in.Profiles
	v.Audit = in.Audit
	f.secrets[secretID] = v
	return v, nil
}

func (f *secFakeStore) AddSecretVersion(ctx context.Context, c Caller, projectID, secretID string, value []byte) (SecretVersionView, error) {
	f.versions = append(f.versions, secVersionCall{projectID, secretID, append([]byte(nil), value...)})
	if f.err != nil {
		return SecretVersionView{}, f.err
	}
	v, ok := f.secrets[secretID]
	if !ok || !secInProject(f, projectID, secretID) {
		return SecretVersionView{}, ErrProjectNotFound
	}
	if v.RevokedAt != nil {
		return SecretVersionView{}, ErrSecretConflict
	}
	v.CurrentVS++
	rotated := secTime()
	v.RotatedAt = &rotated
	f.secrets[secretID] = v
	return SecretVersionView{SecretID: secretID, Version: v.CurrentVS, KeyID: "master-key-v1", CreatedAt: secTime()}, nil
}

func (f *secFakeStore) RevokeSecret(ctx context.Context, c Caller, projectID, secretID string) (SecretView, error) {
	if f.err != nil {
		return SecretView{}, f.err
	}
	v, ok := f.secrets[secretID]
	if !ok || !secInProject(f, projectID, secretID) {
		return SecretView{}, ErrProjectNotFound
	}
	if v.RevokedAt != nil {
		return SecretView{}, ErrSecretConflict
	}
	revoked := secTime()
	v.RevokedAt = &revoked
	f.secrets[secretID] = v
	return v, nil
}

func (f *secFakeStore) ListSecretMaterializations(ctx context.Context, c Caller, projectID, secretID string) ([]SecretMaterializationView, error) {
	if f.err != nil {
		return nil, f.err
	}
	if _, ok := f.secrets[secretID]; !ok || !secInProject(f, projectID, secretID) {
		return nil, ErrProjectNotFound
	}
	return f.materializations[secretID], nil
}

func (f *secFakeStore) ListSecretMounts(ctx context.Context, c Caller, projectID string) ([]SecretMountView, error) {
	if f.err != nil {
		return nil, f.err
	}
	var out []SecretMountView
	for _, m := range f.mounts {
		if m.ProjectID == projectID {
			out = append(out, m)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out, nil
}

func (f *secFakeStore) CreateSecretMount(ctx context.Context, c Caller, projectID string, in SecretMountInput) (SecretMountView, error) {
	f.mountCreates = append(f.mountCreates, in)
	if f.err != nil {
		return SecretMountView{}, f.err
	}
	if _, ok := f.secrets[in.SecretID]; !ok || !secInProject(f, projectID, in.SecretID) {
		return SecretMountView{}, ErrProjectNotFound
	}
	if in.DeliveryMode == "integration_broker" {
		return SecretMountView{}, ErrSecretDeliveryUnsupported
	}
	v := SecretMountView{
		ID:        fmt.Sprintf("%08d-0000-4000-8000-000000000000", len(f.mounts)+1),
		ProjectID: projectID, SecretID: in.SecretID, SecretSlug: f.secrets[in.SecretID].Slug,
		Delivery: in.DeliveryMode, Lifecycle: in.Lifecycle, AllowTracked: in.AllowTracked,
		CreatedAt: secTime(),
	}
	if in.RelativePath != "" {
		path := in.RelativePath
		v.RelativePath = &path
	}
	if in.RepositoryID != "" {
		repo := in.RepositoryID
		v.RepositoryID = &repo
	}
	if in.EnvName != "" {
		name := in.EnvName
		v.EnvName = &name
	}
	if in.Key != "" {
		key := in.Key
		v.Key = &key
	}
	f.mounts[v.ID] = v
	return v, nil
}

func (f *secFakeStore) DeleteSecretMount(ctx context.Context, c Caller, projectID, mountID string) error {
	f.deletes = append(f.deletes, secDeleteCall{projectID, mountID})
	if f.err != nil {
		return f.err
	}
	m, ok := f.mounts[mountID]
	if !ok || m.ProjectID != projectID {
		return ErrProjectNotFound
	}
	delete(f.mounts, mountID)
	return nil
}

func secInProject(f *secFakeStore, projectID, secretID string) bool {
	for _, id := range f.byProject[projectID] {
		if id == secretID {
			return true
		}
	}
	return false
}

// --- server fixture -----------------------------------------------------

type secFixture struct {
	server   *Server
	secrets  *secFakeStore
	projects *prjFakeStore
}

// secNewFixture wires RegisterSecrets against the two store seams it needs, with
// two projects so cross-project refusal is a fact of the fixture rather than a
// mock of the caller's imagination.
func secNewFixture(t *testing.T, auth Authenticator) *secFixture {
	t.Helper()
	f := &secFixture{
		secrets:  secNewFakeStore(),
		projects: prjNewFakeStore(),
	}
	f.projects.addProject(ProjectView{ID: secTProject, Slug: "alpha", Name: "Alpha", MyRole: string(authz.RoleMaintainer)})
	f.projects.addProject(ProjectView{ID: secTOther, Slug: "beta", Name: "Beta", MyRole: string(authz.RoleMaintainer)})
	s := newTestServer(t, nil, fakeReadiness{expected: 4}, auth)
	RegisterSecrets(s, f.secrets, f.projects)
	f.server = s
	return f
}

// secRole is the fixture's membership dial. The handler asks the project store
// what the caller's role is, so "she is a viewer" and "he is a stranger" have to
// be facts about the fake project rather than assertions about the fake caller:
// prjFakeStore.GetProject answers ErrProjectNotFound when the role fails
// CanView, which is exactly the shape a non-member sees.
func (f *secFixture) secRole(projectID, role string) {
	p := f.projects.byID[projectID]
	p.MyRole = role
	f.projects.byID[projectID] = p
}

// secStranger makes every project in the fixture invisible to the caller.
func (f *secFixture) secStranger() {
	for id := range f.projects.byID {
		f.secRole(id, "")
	}
}

// secBody serializes a fixture body. Every value passed here is a literal map or
// struct of strings, so a marshal error is a bug in the fixture itself; the panic
// is the loud version of t.Fatalf for a helper that has no *testing.T.
func secBody(v any) *bytes.Buffer {
	raw, err := json.Marshal(v)
	if err != nil {
		panic("secrets_test: fixture body will not marshal: " + err.Error())
	}
	return bytes.NewBuffer(raw)
}

func secMutation(method, target string, body any) *http.Request {
	r := httptest.NewRequest(method, target, secBody(body))
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Origin", secTLBOrigins)
	r.Header.Set("X-CSRF-Token", prjCSRF)
	return r
}

func secGet(target string) *http.Request {
	r := httptest.NewRequest(http.MethodGet, target, nil)
	r.Header.Set("Origin", secTLBOrigins)
	return r
}

func secTCreateBody(slug string) map[string]any {
	return map[string]any{
		"slug": slug, "purpose": "integration test registry", "delivery_mode": "env_file",
		"allowed_agent_profile_ids": []string{secTProfile}, "value": secTSentinel,
	}
}

func secSecretURL(slugProject, secretID string) string {
	return "/api/v1/projects/" + slugProject + "/secrets/" + secretID
}

// --- the negative: no route returns a value -----------------------------

func TestNoSecretRouteReturnsAValue(t *testing.T) {
	f := secNewFixture(t, prjAs("u-1", false))
	ctx := context.Background()
	f.secrets.putSecret(secTProject, SecretView{
		ID: secTSecret, Slug: "docker-hub-token", Scope: "project", Purpose: "registry login",
		Delivery: "env_file", CurrentVS: 3, Profiles: []string{secTProfile}, Audit: "materialization",
	})
	f.secrets.materializations[secTSecret] = []SecretMaterializationView{{
		ID: 7, SecretID: secTSecret, Slug: "docker-hub-token", SecretVersion: 3,
		WorkerID: "88888888-8888-4888-8888-888888888888", Delivery: "env_file",
		Target: ".env.local", FileMode: ptr(384), MaterializedAt: secTime(),
	}}
	if _, err := f.secrets.CreateSecret(ctx, Caller{}, secTProject, SecretCreateInput{
		Slug: "test-database-url", DeliveryMode: "env", Profiles: []string{secTProfile},
		Value: []byte(secTSentinel),
	}); err != nil {
		t.Fatalf("seed create: %v", err)
	}
	if _, err := f.secrets.AddSecretVersion(ctx, Caller{}, secTProject, secTSecret, []byte(secTSentinel)); err != nil {
		t.Fatalf("seed version: %v", err)
	}
	if _, err := f.secrets.CreateSecretMount(ctx, Caller{}, secTProject, SecretMountInput{
		SecretID: secTSecret, DeliveryMode: "env_file", RepositoryID: secTRepo,
		RelativePath: ".env.local", Lifecycle: "turn",
	}); err != nil {
		t.Fatalf("seed mount: %v", err)
	}
	mountID := ""
	for id := range f.secrets.mounts {
		mountID = id
	}

	// The fake was handed the sentinel in a create and a rotation, so if any
	// response could carry a value this is where it shows up.
	type call struct {
		name, method, target string
		body                 any
		want                 int
	}
	routes := []call{
		{"list", http.MethodGet, "/api/v1/projects/" + secTProject + "/secrets", nil, 200},
		{"add version", http.MethodPost, secSecretURL(secTProject, secTSecret) + "/versions", map[string]any{"value": secTSentinel}, 201},
		{"update", http.MethodPut, secSecretURL(secTProject, secTSecret), map[string]any{
			"purpose": "rotated purpose", "allowed_agent_profile_ids": []string{secTProfile},
			"audit_policy": "materialization_and_access",
		}, 200},
		{"materializations", http.MethodGet, secSecretURL(secTProject, secTSecret) + "/materializations", nil, 200},
		{"revoke", http.MethodPost, secSecretURL(secTProject, secTSecret) + ":revoke", nil, 200},
		{"mounts", http.MethodGet, "/api/v1/projects/" + secTProject + "/secret-mounts", nil, 200},
		{"mount delete", http.MethodDelete, "/api/v1/projects/" + secTProject + "/secret-mounts/" + mountID, nil, 204},
	}
	for _, tc := range routes {
		t.Run(tc.name, func(t *testing.T) {
			req := secGet(tc.target)
			if tc.method != http.MethodGet {
				req = secMutation(tc.method, tc.target, tc.body)
			}
			rec := do(t, f.server, req)
			if rec.Code != tc.want {
				t.Fatalf("status = %d, want %d (%s)", rec.Code, tc.want, rec.Body)
			}
			body := rec.Body.String()
			if strings.Contains(body, secTSentinel) {
				t.Fatalf("the value was returned by %s: %s", tc.name, body)
			}
			if strings.Contains(body, `"value"`) {
				t.Fatalf("%s returned a member named value: %s", tc.name, body)
			}
			// The audit detail is the other place a value could hide; it is a
			// store-side string, and the fake records what the store was asked to
			// do rather than what it wrote. Still assert the create body's shape.
			if tc.name == "add version" {
				fields := prjFields(t, rec.Body.Bytes())
				want := []string{"created_at", "key_id", "secret_id", "version"}
				if got := strings.Join(fields, ","); got != strings.Join(want, ",") {
					t.Errorf("SecretVersionInfo fields = %v, want %v", got, want)
				}
			}
		})
	}
	// create is the remaining value-accepting route, and it is the one whose
	// response must be the metadata row rather than an echo.
	t.Run("create", func(t *testing.T) {
		rec := do(t, f.server, secMutation(http.MethodPost, "/api/v1/projects/"+secTProject+"/secrets", secTCreateBody("registry-password")))
		if rec.Code != http.StatusCreated {
			t.Fatalf("status = %d, want 201 (%s)", rec.Code, rec.Body)
		}
		if strings.Contains(rec.Body.String(), secTSentinel) {
			t.Fatalf("create echoed the value: %s", rec.Body)
		}
		if got := rec.Header().Get("Location"); !strings.HasPrefix(got, "/api/v1/projects/"+secTProject+"/secrets/") {
			t.Errorf("Location = %q", got)
		}
		fields := prjFields(t, rec.Body.Bytes())
		want := []string{"allowed_agent_profile_ids", "audit_policy", "created_at", "current_version",
			"delivery_mode", "id", "purpose", "revoked_at", "rotated_at", "scope", "slug"}
		if got := strings.Join(fields, ","); got != strings.Join(want, ",") {
			t.Errorf("Secret fields = %v, want %v", got, want)
		}
	})

	// And what the store was actually *asked* to store still holds the value —
	// proof the refusal is on the read side rather than a lost request body.
	if len(f.secrets.versions) == 0 || string(f.secrets.versions[0].value) != secTSentinel {
		t.Fatalf("the store never received the value: %+v", f.secrets.versions)
	}
	if len(f.secrets.created) == 0 || string(f.secrets.created[0].Value) != secTSentinel {
		t.Fatalf("create did not reach the store with a value: %+v", f.secrets.created)
	}
}

func TestValueFieldIsInvisibleToEverySecretView(t *testing.T) {
	// The structural form of the same claim. A store seam with a method that
	// returns material would be a compile-time green light for a leak, so the
	// interface itself is what is asserted here — plus the view types, which are
	// the only thing that can reach a client.
	const forbidden = "value plaintext ciphertext nonce secret_value contents contents_b64"
	storeType := reflect.TypeOf((*SecretStore)(nil)).Elem()
	for i := 0; i < storeType.NumMethod(); i++ {
		method := storeType.Method(i)
		name := strings.ToLower(method.Name)
		for _, word := range strings.Fields(forbidden) {
			if strings.Contains(name, word) {
				t.Errorf("SecretStore.%s names %q: the seam may carry material in one direction only, and it is not this one",
					method.Name, word)
			}
		}
		takesBytes, returnsBytes := false, false
		for in := 0; in < method.Type.NumIn(); in++ {
			if method.Type.In(in) == reflect.TypeOf([]byte(nil)) {
				takesBytes = true
			}
		}
		for out := 0; out < method.Type.NumOut(); out++ {
			if secContainsBytesLeaf(method.Type.Out(out)) {
				returnsBytes = true
			}
		}
		if returnsBytes {
			t.Errorf("SecretStore.%s returns material", method.Name)
		}
		if takesBytes && method.Name != "AddSecretVersion" {
			t.Errorf("SecretStore.%s accepts a []byte; only rotation may hand material to the store", method.Name)
		}
		if strings.HasPrefix(method.Name, "List") || strings.HasPrefix(method.Name, "Get") {
			if takesBytes {
				t.Errorf("SecretStore.%s is a read that accepts material", method.Name)
			}
		}
	}

	// Every view type, checked at the tag level rather than by eye: a member
	// renamed value later would be caught by the sentinel tests only if a route
	// happened to serialize it, and the point of this file is that the shape
	// closes the set.
	// Inputs are deliberately absent from this list: SecretCreateInput.Value and
	// AddSecretVersion's parameter are the intended one-way door, and a check
	// that failed them would be a check that the request side cannot exist.
	for _, view := range []any{SecretView{}, SecretVersionView{}, SecretMountView{},
		SecretMaterializationView{}, SecretListView{}, SecretMountListView{},
		SecretMaterializationListView{}} {
		secNoForbiddenFields(t, reflect.TypeOf(view), forbidden)
		raw, err := json.Marshal(view)
		if err != nil {
			t.Fatalf("marshal %T: %v", view, err)
		}
		for _, word := range strings.Fields(forbidden) {
			if strings.Contains(strings.ToLower(string(raw)), `"`+word+`"`) {
				t.Errorf("%T serializes a member named %q: %s", view, word, raw)
			}
		}
	}
	// And the two input bodies keep their value member write-only in the one
	// direction that matters: nothing that holds one can be encoded out.
	for _, body := range []any{secCreateBody{}, secUpdateBody{}, secVersionBody{}} {
		secNoForbiddenFields(t, reflect.TypeOf(body), "plaintext ciphertext nonce")
	}
}

// secNoForbiddenFields walks a type one level into structs and slices of
// structs, refusing any exported field whose name or JSON tag could receive a
// secret value.
func secNoForbiddenFields(t *testing.T, typ reflect.Type, forbidden string) {
	t.Helper()
	if typ == nil {
		return
	}
	for typ.Kind() == reflect.Pointer || typ.Kind() == reflect.Slice {
		typ = typ.Elem()
	}
	if typ.Kind() != reflect.Struct {
		return
	}
	for i := 0; i < typ.NumField(); i++ {
		field := typ.Field(i)
		if !field.IsExported() {
			continue
		}
		tag := strings.Split(field.Tag.Get("json"), ",")[0]
		for _, word := range strings.Fields(forbidden) {
			if strings.EqualFold(field.Name, word) || strings.EqualFold(tag, word) {
				t.Errorf("%s.%s (json %q) could hold a value", typ.Name(), field.Name, tag)
			}
		}
	}
}

// secContainsBytesLeaf reports whether a type is, or holds at one level, a
// []byte — the only representation this codebase gives decrypted material.
func secContainsBytesLeaf(typ reflect.Type) bool {
	if typ == reflect.TypeOf([]byte(nil)) {
		return true
	}
	for typ.Kind() == reflect.Pointer || typ.Kind() == reflect.Slice {
		typ = typ.Elem()
	}
	if typ.Kind() != reflect.Struct {
		return false
	}
	for i := 0; i < typ.NumField(); i++ {
		if typ.Field(i).Type == reflect.TypeOf([]byte(nil)) {
			return true
		}
	}
	return false
}

func TestWriteOnlyValueCannotBeSerializedBackOut(t *testing.T) {
	// The one place material crosses this package is a decoded request body, and
	// even that copy refuses to become a response.
	raw := []byte(`{"value":"p@ssw0rd-material"}`)
	var body secVersionBody
	if err := json.Unmarshal(raw, &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body.Value == nil || string(*body.Value) != "p@ssw0rd-material" {
		t.Fatalf("decoded value = %v", body.Value)
	}
	if _, err := json.Marshal(body); err == nil {
		t.Fatal("a request body carrying a value marshalled, so it could be logged")
	} else if !strings.Contains(err.Error(), "cannot be serialized") {
		t.Fatalf("marshal error = %v", err)
	}
	body.Value.Zero()
	if body.Value.Len() != 0 {
		t.Fatalf("Zero left %d bytes", body.Value.Len())
	}
	// A JSON string that is not valid UTF-8-clean material still decodes: the
	// schema bounds length, not charset, and a binary token is legal.
	var binary secVersionBody
	if err := json.Unmarshal([]byte(`{"value":"\u0000\u0001binary"}`), &binary); err != nil {
		t.Fatalf("decode binary-ish value: %v", err)
	}
	if got := string(*binary.Value); got != "\x00\x01binary" {
		t.Fatalf("value = %q", got)
	}
}

// --- verb routing and the :revoke sub-resource --------------------------

func TestRevokeIsASubResourceNotASecondRoute(t *testing.T) {
	f := secNewFixture(t, prjAs("u-1", false))
	f.secrets.putSecret(secTProject, SecretView{
		ID: secTSecret, Slug: "docker-hub-token", Scope: "project", Delivery: "env_file",
		CurrentVS: 1, Profiles: []string{secTProfile}, Audit: "materialization",
	})

	rec := do(t, f.server, secMutation(http.MethodPost, secSecretURL(secTProject, secTSecret)+":revoke", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("revoke status = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	var view SecretView
	if err := json.Unmarshal(rec.Body.Bytes(), &view); err != nil {
		t.Fatalf("decode: %v (%s)", err, rec.Body)
	}
	if view.RevokedAt == nil || view.RevokedAt.Format(time.RFC3339) != secTNow {
		t.Fatalf("revoked_at = %v, want it set", view.RevokedAt)
	}
	if f.secrets.secrets[secTSecret].RevokedAt == nil {
		t.Fatal("the store row was not revoked")
	}

	// The same secret twice is a conflict, not a silent re-revoke.
	rec = do(t, f.server, secMutation(http.MethodPost, secSecretURL(secTProject, secTSecret)+":revoke", nil))
	if rec.Code != http.StatusConflict {
		t.Fatalf("second revoke status = %d, want 409 (%s)", rec.Code, rec.Body)
	}

	// An unknown sub-resource answers "no such endpoint" without confirming that
	// the id it carried is a real secret: `:bogus` on a revoked secret and on a
	// random uuid must be the same bytes, or the route becomes an id oracle.
	known := do(t, f.server, secMutation(http.MethodPost, secSecretURL(secTProject, secTSecret)+":bogus", nil))
	unknown := do(t, f.server, secMutation(http.MethodPost, secSecretURL(secTProject, "99999999-9999-4999-8999-999999999999")+":bogus", nil))
	if known.Code != http.StatusNotFound || unknown.Code != http.StatusNotFound {
		t.Fatalf("statuses = %d/%d, want 404/404", known.Code, unknown.Code)
	}
	if known.Body.String() != unknown.Body.String() {
		t.Fatalf("the two 404 bodies differ: %q vs %q", known.Body.String(), unknown.Body.String())
	}

	// A POST to the bare id is not a verb this surface has.
	rec = do(t, f.server, secMutation(http.MethodPost, secSecretURL(secTProject, secTSecret), nil))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("bare POST status = %d, want 404 (%s)", rec.Code, rec.Body)
	}
}

// --- validation ---------------------------------------------------------

func TestSecretBodiesAreHeldToTheirSchemas(t *testing.T) {
	f := secNewFixture(t, prjAs("u-1", false))
	f.secrets.putSecret(secTProject, SecretView{
		ID: secTSecret, Slug: "docker-hub-token", Scope: "project", Delivery: "env_file",
		CurrentVS: 1, Profiles: []string{secTProfile}, Audit: "materialization",
	})

	type call struct {
		name, method, target string
		body                 any
		want                 int
		detail               string
	}
	for _, tc := range []call{
		{"update with a value", http.MethodPut, secSecretURL(secTProject, secTSecret), map[string]any{
			"purpose": "p", "allowed_agent_profile_ids": []string{}, "audit_policy": "materialization",
			"value": secTSentinel,
		}, 400, "versions"},
		{"update missing a required field", http.MethodPut, secSecretURL(secTProject, secTSecret), map[string]any{
			"purpose": "p", "audit_policy": "materialization",
		}, 422, ""},
		{"update unknown field", http.MethodPut, secSecretURL(secTProject, secTSecret), map[string]any{
			"purpose": "p", "allowed_agent_profile_ids": []string{}, "audit_policy": "materialization",
			"slug": "renamed",
		}, 400, ""},
		{"update bad audit policy", http.MethodPut, secSecretURL(secTProject, secTSecret), map[string]any{
			"purpose": "p", "allowed_agent_profile_ids": []string{}, "audit_policy": "everything",
		}, 422, "audit_policy"},
		{"update bad profile id", http.MethodPut, secSecretURL(secTProject, secTSecret), map[string]any{
			"purpose": "p", "allowed_agent_profile_ids": []string{"not-a-uuid"}, "audit_policy": "materialization",
		}, 422, "uuid"},
		{"create without value", http.MethodPost, "/api/v1/projects/" + secTProject + "/secrets", map[string]any{
			"slug": "no-value", "delivery_mode": "env",
		}, 422, "value is required"},
		{"create with an empty value", http.MethodPost, "/api/v1/projects/" + secTProject + "/secrets", map[string]any{
			"slug": "empty-value", "delivery_mode": "env", "value": "",
		}, 422, "empty"},
		{"create with an oversized value", http.MethodPost, "/api/v1/projects/" + secTProject + "/secrets", map[string]any{
			"slug": "big-value", "delivery_mode": "env", "value": strings.Repeat("v", secMaxValueLen+1),
		}, 422, "65536"},
		{"create with broker delivery", http.MethodPost, "/api/v1/projects/" + secTProject + "/secrets", map[string]any{
			"slug": "broker-secret", "delivery_mode": "integration_broker", "value": secTSentinel,
		}, 422, "integration_broker"},
		{"create with a bad slug", http.MethodPost, "/api/v1/projects/" + secTProject + "/secrets", map[string]any{
			"slug": "Bad Slug", "delivery_mode": "env", "value": secTSentinel,
		}, 422, "slug"},
		{"create with a leading-hyphen slug", http.MethodPost, "/api/v1/projects/" + secTProject + "/secrets", map[string]any{
			"slug": "-lead", "delivery_mode": "env", "value": secTSentinel,
		}, 422, "slug"},
		{"create with a bad scope", http.MethodPost, "/api/v1/projects/" + secTProject + "/secrets", map[string]any{
			"slug": "scoped", "delivery_mode": "env", "scope": "global", "value": secTSentinel,
		}, 422, "scope"},
		{"create with a duplicate slug", http.MethodPost, "/api/v1/projects/" + secTProject + "/secrets", secTCreateBody("docker-hub-token"), 409, "slug"},
		{"version without value", http.MethodPost, secSecretURL(secTProject, secTSecret) + "/versions", map[string]any{}, 422, "value"},
		{"version with an unknown field", http.MethodPost, secSecretURL(secTProject, secTSecret) + "/versions", map[string]any{
			"value": secTSentinel, "purpose": "sneaked in",
		}, 400, ""},
		{"malformed json", http.MethodPost, "/api/v1/projects/" + secTProject + "/secrets", "not json", 400, ""},
		{"empty body", http.MethodPost, "/api/v1/projects/" + secTProject + "/secrets", nil, 400, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var body *bytes.Buffer
			switch {
			case tc.name == "malformed json":
				body = bytes.NewBufferString("not json")
			case tc.body == nil:
				body = &bytes.Buffer{} // truly empty: the 400 path, not a null body
			default:
				body = secBody(tc.body)
			}
			req := httptest.NewRequest(tc.method, tc.target, body)
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("Origin", secTLBOrigins)
			req.Header.Set("X-CSRF-Token", prjCSRF)
			rec := do(t, f.server, req)
			if rec.Code != tc.want {
				t.Fatalf("status = %d, want %d (%s)", rec.Code, tc.want, rec.Body)
			}
			if tc.detail != "" && !strings.Contains(rec.Body.String(), tc.detail) {
				t.Fatalf("detail %q not in %s", tc.detail, rec.Body)
			}
			if strings.Contains(rec.Body.String(), secTSentinel) {
				t.Fatalf("a rejection response quoted the value: %s", rec.Body)
			}
		})
	}
}

func TestMountDeclarationsAreCheckedBeforeTheDatabase(t *testing.T) {
	f := secNewFixture(t, prjAs("u-1", false))
	f.secrets.putSecret(secTProject, SecretView{
		ID: secTSecret, Slug: "docker-hub-token", Scope: "project", Delivery: "env_file",
		CurrentVS: 1, Profiles: []string{secTProfile}, Audit: "materialization",
	})
	base := "/api/v1/projects/" + secTProject + "/secret-mounts"
	envOnly := func(over map[string]any) map[string]any {
		body := map[string]any{"secret_id": secTSecret, "delivery_mode": "env", "env_name": "REGISTRY_TOKEN"}
		for k, v := range over {
			body[k] = v
		}
		return body
	}
	fileOnly := func(over map[string]any) map[string]any {
		body := map[string]any{
			"secret_id": secTSecret, "delivery_mode": "env_file",
			"repository_id": secTRepo, "relative_path": ".env.local",
		}
		for k, v := range over {
			body[k] = v
		}
		return body
	}

	for _, tc := range []struct {
		name string
		body map[string]any
		want int
	}{
		{"env without env_name", map[string]any{"secret_id": secTSecret, "delivery_mode": "env"}, 422},
		{"env with a bad name", envOnly(map[string]any{"env_name": "9BAD-NAME"}), 422},
		{"env with a path", envOnly(map[string]any{"relative_path": ".env.local", "repository_id": secTRepo}), 422},
		{"env_file without a repository", map[string]any{
			"secret_id": secTSecret, "delivery_mode": "env_file", "relative_path": ".env.local",
		}, 422},
		{"env_file without a path", map[string]any{
			"secret_id": secTSecret, "delivery_mode": "env_file", "repository_id": secTRepo,
		}, 422},
		{"env_file with an env_name", fileOnly(map[string]any{"env_name": "NOPE"}), 422},
		{"absolute path", fileOnly(map[string]any{"relative_path": "/etc/passwd"}), 422},
		{"parent traversal", fileOnly(map[string]any{"relative_path": "../../etc/passwd"}), 422},
		{"dot segment", fileOnly(map[string]any{"relative_path": "./.env"}), 422},
		{"empty segment", fileOnly(map[string]any{"relative_path": "app//.env"}), 422},
		{"backslash", fileOnly(map[string]any{"relative_path": `app\.env`}), 422},
		{"empty path", fileOnly(map[string]any{"relative_path": ""}), 422},
		{"path over the column bound", fileOnly(map[string]any{"relative_path": strings.Repeat("a", 1025)}), 422},
		{"broker delivery", fileOnly(map[string]any{"delivery_mode": "integration_broker"}), 422},
		{"bad lifecycle", fileOnly(map[string]any{"lifecycle": "hourly"}), 422},
		{"bad secret id", fileOnly(map[string]any{"secret_id": "nope"}), 422},
		{"bad repository id", fileOnly(map[string]any{"repository_id": "nope"}), 422},
		{"bad key name", fileOnly(map[string]any{"key": "bad key"}), 422},
		{"unknown field", fileOnly(map[string]any{"value": secTSentinel}), 400},
		{"node_attempt is accepted", fileOnly(map[string]any{"lifecycle": "node_attempt"}), 201},
		{"workspace lifecycle", fileOnly(map[string]any{"lifecycle": "workspace"}), 201},
		{"key extraction", fileOnly(map[string]any{"key": "REGISTRY_TOKEN"}), 201},
		{"allow_tracked", fileOnly(map[string]any{"allow_tracked": true}), 201},
	} {
		t.Run(tc.name, func(t *testing.T) {
			before := len(f.secrets.mountCreates)
			rec := do(t, f.server, secMutation(http.MethodPost, base, tc.body))
			if rec.Code != tc.want {
				t.Fatalf("status = %d, want %d (%s)", rec.Code, tc.want, rec.Body)
			}
			if tc.want >= 400 && len(f.secrets.mountCreates) != before {
				t.Fatal("an invalid declaration reached the store")
			}
			if strings.Contains(rec.Body.String(), secTSentinel) {
				t.Fatalf("response quoted the value: %s", rec.Body)
			}
		})
	}

	// A valid env_file declaration returns the SecretMount schema exactly, with
	// the declared relative path and nothing resolved.
	rec := do(t, f.server, secMutation(http.MethodPost, base, map[string]any{
		"secret_id": secTSecret, "delivery_mode": "env_file", "repository_id": secTRepo,
		"relative_path": "config/registry.env", "key": "REGISTRY_TOKEN", "allow_tracked": false,
	}))
	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, want 201 (%s)", rec.Code, rec.Body)
	}
	fields := prjFields(t, rec.Body.Bytes())
	want := []string{"allow_tracked", "created_at", "delivery_mode", "env_name", "id", "key",
		"lifecycle", "project_id", "relative_path", "repository_id", "secret_id", "secret_slug"}
	if got := strings.Join(fields, ","); got != strings.Join(want, ",") {
		t.Errorf("SecretMount fields = %v, want %v", got, want)
	}
	if got := rec.Header().Get("Location"); !strings.HasPrefix(got, "/api/v1/projects/"+secTProject+"/secret-mounts/") {
		t.Errorf("Location = %q", got)
	}
	var view SecretMountView
	if err := json.Unmarshal(rec.Body.Bytes(), &view); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if view.RelativePath == nil || *view.RelativePath != "config/registry.env" {
		t.Fatalf("relative_path = %v", view.RelativePath)
	}
	if view.Key == nil || *view.Key != "REGISTRY_TOKEN" {
		t.Fatalf("key = %v", view.Key)
	}
	if view.Lifecycle != "turn" {
		t.Fatalf("lifecycle = %q, want the documented default turn", view.Lifecycle)
	}
}

// --- authorization ------------------------------------------------------

func TestNonMemberGetsNotFoundAndAnAuditDenial(t *testing.T) {
	// C15b/C15c: carol, member of no project here, must get 404 from every secret
	// route and leave an audit trail behind, and her 404 bodies must be
	// byte-identical to the 404 a random uuid produces (C15d) so the surface
	// cannot be walked to enumerate projects.
	f := secNewFixture(t, prjAs("carol", false))
	f.secStranger()
	targets := []struct{ method, target string }{
		{http.MethodGet, "/api/v1/projects/" + secTProject + "/secrets"},
		{http.MethodGet, secSecretURL(secTProject, secTSecret) + "/materializations"},
		{http.MethodGet, "/api/v1/projects/" + secTProject + "/secret-mounts"},
		{http.MethodPost, "/api/v1/projects/" + secTProject + "/secrets"},
		{http.MethodPut, secSecretURL(secTProject, secTSecret)},
		{http.MethodPost, secSecretURL(secTProject, secTSecret) + "/versions"},
		{http.MethodPost, secSecretURL(secTProject, secTSecret) + ":revoke"},
		{http.MethodPost, "/api/v1/projects/" + secTProject + "/secret-mounts"},
		{http.MethodDelete, "/api/v1/projects/" + secTProject + "/secret-mounts/" + secTMount},
	}
	for _, tc := range targets {
		t.Run(tc.method+" "+tc.target, func(t *testing.T) {
			rec := do(t, f.server, secMutation(tc.method, tc.target, map[string]any{}))
			if rec.Code != http.StatusNotFound {
				t.Fatalf("status = %d, want 404 (%s)", rec.Code, rec.Body)
			}
			// The body is the project-not-found problem, not a secret-shaped
			// one: a stranger must not learn which sub-resources a project has.
			if problem := decodeProblem(t, rec); problem.Status != http.StatusNotFound || problem.Detail != "No such project." {
				t.Fatalf("problem = %+v", problem)
			}
		})
	}

	// Every denial was audited, with the route's own action name and against the
	// project she tried to reach. Asserted here, before the byte-identity loop,
	// because that loop's probes deliberately audit a random project too.
	if len(f.projects.denied) == 0 {
		t.Fatal("no audit denial was recorded")
	}
	seen := map[string]bool{}
	for _, d := range f.projects.denied {
		if d.projectID != secTProject {
			t.Fatalf("denial recorded against %q, want %q", d.projectID, secTProject)
		}
		seen[d.action] = true
	}
	for _, want := range []string{"secret.list", "secret.create", "secret.update", "secret.version.add",
		"secret.revoke", "secret.materialization.list", "secret.mount.list", "secret.mount.create",
		"secret.mount.delete"} {
		if !seen[want] {
			t.Errorf("no audit denial recorded for %s (saw %v)", want, seen)
		}
	}
	// Byte-identical to a random-uuid 404.
	for _, tc := range targets {
		if tc.method == http.MethodDelete {
			continue // handled below with a uuid path segment
		}
		known := do(t, f.server, secMutation(tc.method, tc.target, map[string]any{}))
		random := do(t, f.server, secMutation(tc.method,
			strings.Replace(tc.target, secTProject, "00000000-0000-4000-8000-000000000000", 1), map[string]any{}))
		if known.Code != random.Code || known.Body.String() != random.Body.String() {
			t.Fatalf("%s: known %d/%q differs from random %d/%q", tc.target,
				known.Code, known.Body.String(), random.Code, random.Body.String())
		}
	}

	// And the secret store was never consulted: a denial is answered by the
	// project gate, so a non-member cannot probe what secrets exist by timing the
	// difference between "no project" and "no secrets".
	if len(f.secrets.loaded) != 0 || len(f.secrets.created) != 0 || len(f.secrets.versions) != 0 {
		t.Fatalf("the secret store was used by a non-member: %+v %+v %+v", f.secrets.loaded, f.secrets.created, f.secrets.versions)
	}
}

func TestViewerCanReadPlacementsButNotMutateOrReadTheMaterializationMap(t *testing.T) {
	f := secNewFixture(t, prjAs("bob", false))
	f.secRole(secTProject, string(authz.RoleViewer))
	f.secrets.putSecret(secTProject, SecretView{
		ID: secTSecret, Slug: "docker-hub-token", Scope: "project", Delivery: "env_file",
		CurrentVS: 2, Profiles: []string{secTProfile}, Audit: "materialization",
	})
	f.secrets.materializations[secTSecret] = []SecretMaterializationView{{
		ID: 1, SecretID: secTSecret, SecretVersion: 2, Delivery: "env", Target: "REGISTRY_TOKEN",
		WorkerID: "88888888-8888-4888-8888-888888888888", MaterializedAt: secTime(),
	}}

	// viewer+ on the metadata list and the mounts (placement is not sensitive).
	for _, target := range []string{
		"/api/v1/projects/" + secTProject + "/secrets",
		"/api/v1/projects/" + secTProject + "/secret-mounts",
	} {
		rec := do(t, f.server, secGet(target))
		if rec.Code != http.StatusOK {
			t.Fatalf("%s status = %d, want 200 (%s)", target, rec.Code, rec.Body)
		}
	}
	// maintainer+ on the materialization map: it says which unit held which
	// secret, which is a disclosure surface even when no value is in it.
	rec := do(t, f.server, secGet(secSecretURL(secTProject, secTSecret)+"/materializations"))
	if rec.Code != http.StatusForbidden {
		t.Fatalf("materializations as viewer = %d, want 403 (%s)", rec.Code, rec.Body)
	}
	for _, tc := range []struct {
		method, target string
		body           any
	}{
		{http.MethodPost, "/api/v1/projects/" + secTProject + "/secrets", secTCreateBody("viewer-cannot")},
		{http.MethodPut, secSecretURL(secTProject, secTSecret), map[string]any{
			"purpose": "x", "allowed_agent_profile_ids": []string{}, "audit_policy": "materialization"}},
		{http.MethodPost, secSecretURL(secTProject, secTSecret) + "/versions", map[string]any{"value": secTSentinel}},
		{http.MethodPost, secSecretURL(secTProject, secTSecret) + ":revoke", nil},
		{http.MethodPost, "/api/v1/projects/" + secTProject + "/secret-mounts", map[string]any{
			"secret_id": secTSecret, "delivery_mode": "env", "env_name": "X"}},
		{http.MethodDelete, "/api/v1/projects/" + secTProject + "/secret-mounts/" + secTMount, nil},
	} {
		rec := do(t, f.server, secMutation(tc.method, tc.target, tc.body))
		if rec.Code != http.StatusForbidden {
			t.Errorf("%s %s as viewer = %d, want 403 (%s)", tc.method, tc.target, rec.Code, rec.Body)
		}
	}
	// The denials are audited too — a 403 that leaves no trace is how a
	// permission problem becomes invisible.
	if len(f.projects.denied) < 7 {
		t.Fatalf("recorded %d denials, want at least 7", len(f.projects.denied))
	}
}

func TestOrgScopeCreateNeedsOrganizationAdmin(t *testing.T) {
	f := secNewFixture(t, prjAs("u-1", false))
	rec := do(t, f.server, secMutation(http.MethodPost, "/api/v1/projects/"+secTProject+"/secrets", map[string]any{
		"slug": "org-wide-token", "delivery_mode": "env", "value": secTSentinel, "scope": "org",
	}))
	if rec.Code != http.StatusForbidden {
		t.Fatalf("project maintainer creating an org secret = %d, want 403 (%s)", rec.Code, rec.Body)
	}
	if len(f.secrets.created) != 0 {
		t.Fatal("the store was reached despite the refusal")
	}

	// The same request as org admin succeeds, and the row says what it is.
	admin := secNewFixture(t, prjAs("root", true))
	rec = do(t, admin.server, secMutation(http.MethodPost, "/api/v1/projects/"+secTProject+"/secrets", map[string]any{
		"slug": "org-wide-token", "delivery_mode": "env", "value": secTSentinel, "scope": "org",
	}))
	if rec.Code != http.StatusCreated {
		t.Fatalf("org admin create = %d, want 201 (%s)", rec.Code, rec.Body)
	}
	if got := admin.secrets.created[0].Scope; got != "org" {
		t.Fatalf("store saw scope %q", got)
	}
	var view SecretView
	if err := json.Unmarshal(rec.Body.Bytes(), &view); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if view.Scope != "org" {
		t.Fatalf("response scope = %q", view.Scope)
	}
}

func TestMutationsRequireCSRF(t *testing.T) {
	f := secNewFixture(t, prjAs("u-1", false))
	f.secrets.putSecret(secTProject, SecretView{
		ID: secTSecret, Slug: "docker-hub-token", Scope: "project", Delivery: "env_file",
		CurrentVS: 1, Profiles: []string{secTProfile}, Audit: "materialization",
	})
	for _, tc := range []struct {
		method, target string
		body           any
	}{
		{http.MethodPost, "/api/v1/projects/" + secTProject + "/secrets", secTCreateBody("csrf-probe")},
		{http.MethodPut, secSecretURL(secTProject, secTSecret), map[string]any{
			"purpose": "x", "allowed_agent_profile_ids": []string{}, "audit_policy": "materialization"}},
		{http.MethodPost, secSecretURL(secTProject, secTSecret) + "/versions", map[string]any{"value": secTSentinel}},
		{http.MethodPost, secSecretURL(secTProject, secTSecret) + ":revoke", nil},
		{http.MethodPost, "/api/v1/projects/" + secTProject + "/secret-mounts", map[string]any{
			"secret_id": secTSecret, "delivery_mode": "env", "env_name": "X"}},
		{http.MethodDelete, "/api/v1/projects/" + secTProject + "/secret-mounts/" + secTMount, nil},
	} {
		req := secMutation(tc.method, tc.target, tc.body)
		req.Header.Del("X-CSRF-Token")
		rec := do(t, f.server, req)
		if rec.Code != http.StatusForbidden {
			t.Errorf("%s %s without CSRF = %d, want 403 (%s)", tc.method, tc.target, rec.Code, rec.Body)
		}
		// A cross-origin mutation with a valid token is still refused: the token
		// is half the check, the Origin the other half.
		cross := secMutation(tc.method, tc.target, tc.body)
		cross.Header.Set("Origin", "https://evil.example")
		if rec := do(t, f.server, cross); rec.Code == http.StatusOK || rec.Code == http.StatusCreated || rec.Code == http.StatusNoContent {
			t.Errorf("%s %s cross-origin succeeded (%d)", tc.method, tc.target, rec.Code)
		}
	}
	if len(f.secrets.created) != 0 || len(f.secrets.versions) != 0 || len(f.secrets.deletes) != 0 {
		t.Fatalf("a CSRF-refused mutation reached the store: %+v %+v %+v", f.secrets.created, f.secrets.versions, f.secrets.deletes)
	}
	// The reads need no token, and anonymous reads need a session at all.
	if rec := do(t, f.server, secGet("/api/v1/projects/"+secTProject+"/secrets")); rec.Code != http.StatusOK {
		t.Fatalf("read without CSRF = %d, want 200", rec.Code)
	}
	anonymous := secNewFixture(t, principalAuth(nil, ErrUnauthenticated))
	if rec := do(t, anonymous.server, secGet("/api/v1/projects/"+secTProject+"/secrets")); rec.Code != http.StatusUnauthorized {
		t.Fatalf("anonymous read = %d, want 401", rec.Code)
	}
}

// --- response shapes and store errors -----------------------------------

func TestSecretListViewAndStoreErrorsAreMapped(t *testing.T) {
	f := secNewFixture(t, prjAs("u-1", false))
	f.secrets.putSecret(secTProject, SecretView{
		ID: secTSecret, Slug: "b-second", Scope: "project", Delivery: "env", CurrentVS: 1,
		Profiles: []string{}, Audit: "materialization",
	})
	f.secrets.putSecret(secTProject, SecretView{
		ID: secTSecretB, Slug: "a-first", Scope: "org", Delivery: "env_file", CurrentVS: 2,
		Profiles: []string{secTProfile}, Audit: "materialization_and_access",
	})
	rec := do(t, f.server, secGet("/api/v1/projects/"+secTProject+"/secrets"))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d (%s)", rec.Code, rec.Body)
	}
	var list SecretListView
	if err := json.Unmarshal(rec.Body.Bytes(), &list); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(list.Secrets) != 2 || list.Secrets[0].Slug != "a-first" {
		t.Fatalf("list = %+v, want both rows ordered by slug", list.Secrets)
	}
	// A revoked row still appears: revocation is not deletion, and "who could
	// have had this" is the question an audit asks after the fact.
	f.secrets.putSecret(secTProject, SecretView{ID: secTMount, Slug: "c-revoked", Scope: "project",
		Delivery: "env", CurrentVS: 1, Audit: "materialization"})
	if rec := do(t, f.server, secGet("/api/v1/projects/"+secTProject+"/secrets")); !strings.Contains(rec.Body.String(), "c-revoked") {
		t.Fatalf("a revoked secret vanished from the list: %s", rec.Body)
	}

	// Empty is [], never null, so the UI can always iterate.
	empty := secNewFixture(t, prjAs("u-1", false))
	if rec := do(t, empty.server, secGet("/api/v1/projects/"+secTProject+"/secrets")); strings.TrimSpace(rec.Body.String()) != `{"secrets":[]}` {
		t.Fatalf("empty list = %s", rec.Body)
	}
	if rec := do(t, empty.server, secGet("/api/v1/projects/"+secTProject+"/secret-mounts")); strings.TrimSpace(rec.Body.String()) != `{"secret_mounts":[]}` {
		t.Fatalf("empty mounts = %s", rec.Body)
	}

	// A store failure is a 500 that does not name the driver, for every verb.
	for _, target := range []string{
		"/api/v1/projects/" + secTProject + "/secrets",
		"/api/v1/projects/" + secTProject + "/secret-mounts",
	} {
		failing := secNewFixture(t, prjAs("u-1", false))
		failing.secrets.err = errStoreDown
		rec := do(t, failing.server, secGet(target))
		if rec.Code != http.StatusInternalServerError {
			t.Fatalf("%s status = %d, want 500", target, rec.Code)
		}
		if strings.Contains(rec.Body.String(), errStoreDown.Error()) {
			t.Errorf("%s leaked the store error: %s", target, rec.Body)
		}
	}
	// A malformed path id is 404 without reaching the store: a non-uuid cannot
	// name a row, and the difference is worth nothing to a client.
	before := len(f.secrets.loaded)
	for _, seg := range []string{"nope", "33333333-3333-4333-8333-3333333333", "33333333333333333333333333333333333"} {
		rec := do(t, f.server, secGet(secSecretURL(secTProject, seg)+"/materializations"))
		if rec.Code != http.StatusNotFound {
			t.Errorf("id %q = %d, want 404", seg, rec.Code)
		}
	}
	if len(f.secrets.loaded) != before {
		t.Error("a malformed id reached the store")
	}
}

func TestMaterializationListViewIsAuditShaped(t *testing.T) {
	f := secNewFixture(t, prjAs("u-1", false))
	f.secrets.putSecret(secTProject, SecretView{
		ID: secTSecret, Slug: "docker-hub-token", Scope: "project", Delivery: "env_file",
		CurrentVS: 2, Profiles: []string{secTProfile}, Audit: "materialization",
	})
	workspace := "99999999-9999-4999-8999-999999999999"
	turn := "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	cleaned := secTime().Add(time.Hour)
	by := "worker"
	f.secrets.materializations[secTSecret] = []SecretMaterializationView{
		{ID: 2, SecretID: secTSecret, Slug: "docker-hub-token", SecretVersion: 2,
			WorkspaceID: &workspace, TurnID: &turn, Delivery: "env_file", Target: ".env.local",
			FileMode: ptr(384), MaterializedAt: secTime(), CleanedAt: &cleaned, CleanedBy: &by},
		{ID: 1, SecretID: secTSecret, Slug: "docker-hub-token", SecretVersion: 1,
			WorkspaceID: &workspace, Delivery: "env", Target: "REGISTRY_TOKEN",
			FileMode: nil, MaterializedAt: secTime()},
	}
	rec := do(t, f.server, secGet(secSecretURL(secTProject, secTSecret)+"/materializations"))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d (%s)", rec.Code, rec.Body)
	}
	fields := prjFields(t, rec.Body.Bytes())
	if got, want := strings.Join(fields, ","), "materializations"; got != want {
		t.Fatalf("list fields = %v, want %v", got, want)
	}
	var list SecretMaterializationListView
	if err := json.Unmarshal(rec.Body.Bytes(), &list); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(list.Materializations) != 2 {
		t.Fatalf("rows = %d", len(list.Materializations))
	}
	item := list.Materializations[0]
	fields = prjFields(t, secMarshal(t, item))
	want := []string{"cleaned_at", "cleaned_by", "delivery_mode", "file_mode", "id", "materialized_at",
		"secret_id", "secret_version", "slug", "target", "turn_id", "worker_id", "workspace_id"}
	if got := strings.Join(fields, ","); got != strings.Join(want, ",") {
		t.Errorf("SecretMaterialization fields = %v, want %v", got, want)
	}
	// An uncleaned row is a finding: its nulls must be null, not absent and not
	// zero, because "the sweep looks for rows with cleaned_at null" is a query
	// against this shape.
	if second := list.Materializations[1]; second.CleanedAt != nil || second.CleanedBy != nil || second.FileMode != nil {
		t.Errorf("uncleaned row = %+v, want null cleaned_at/cleaned_by/file_mode", second)
	}
	if raw := secMarshal(t, list.Materializations[1]); !strings.Contains(string(raw), `"cleaned_at":null`) {
		t.Errorf("cleaned_at was not serialized as null: %s", raw)
	}
	if item.TurnID == nil || *item.TurnID != turn {
		t.Errorf("turn_id = %v, want M3's unit named (attempt_id arrives with M4)", item.TurnID)
	}
}

func secMarshal(t *testing.T, v any) []byte {
	t.Helper()
	raw, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return raw
}

func ptr[T any](v T) *T { return &v }

// --- the surface itself -------------------------------------------------

func TestEverySecretRouteIsMountedAndNoneServesAValue(t *testing.T) {
	// The closed-set claim, proven by routing rather than by reading the source:
	// the nine patterns RegisterSecrets installs must each answer with something
	// other than the mux's "no endpoint" problem, and the leak-shaped routes a
	// value-serving endpoint would plausibly have must all still be absent. That
	// includes the `:revoke`-style sub-resource form, because a
	// `POST .../secrets/{id}:value` would slip past a substring check on "/value"
	// unless the verb suffix is probed too.
	f := secNewFixture(t, prjAs("u-1", false))
	f.secrets.putSecret(secTProject, SecretView{
		ID: secTSecret, Slug: "docker-hub-token", Scope: "project", Delivery: "env_file",
		CurrentVS: 1, Profiles: []string{secTProfile}, Audit: "materialization",
	})
	f.secrets.materializations[secTSecret] = []SecretMaterializationView{{
		ID: 1, SecretID: secTSecret, SecretVersion: 1, Delivery: "env", Target: "REGISTRY_TOKEN",
		WorkerID: "88888888-8888-4888-8888-888888888888", MaterializedAt: secTime(),
	}}
	f.secrets.mounts[secTMount] = SecretMountView{
		ID: secTMount, ProjectID: secTProject, SecretID: secTSecret, Delivery: "env",
		EnvName: ptr("REGISTRY_TOKEN"), Lifecycle: "turn", CreatedAt: secTime(),
	}

	routed := []struct{ method, target string }{
		{http.MethodGet, "/api/v1/projects/" + secTProject + "/secrets"},
		{http.MethodPost, "/api/v1/projects/" + secTProject + "/secrets"},
		{http.MethodPut, secSecretURL(secTProject, secTSecret)},
		{http.MethodPost, secSecretURL(secTProject, secTSecret) + ":revoke"},
		{http.MethodPost, secSecretURL(secTProject, secTSecret) + "/versions"},
		{http.MethodGet, secSecretURL(secTProject, secTSecret) + "/materializations"},
		{http.MethodGet, "/api/v1/projects/" + secTProject + "/secret-mounts"},
		{http.MethodPost, "/api/v1/projects/" + secTProject + "/secret-mounts"},
		{http.MethodDelete, "/api/v1/projects/" + secTProject + "/secret-mounts/" + secTMount},
	}
	for _, tc := range routed {
		req := secMutation(tc.method, tc.target, map[string]any{})
		rec := do(t, f.server, req)
		if strings.Contains(rec.Body.String(), "no endpoint") {
			t.Errorf("%s %s is not routed at all: %s", tc.method, tc.target, rec.Body)
		}
	}

	// Absent, in two flavours: whole paths the mux has no pattern for, and verb
	// suffixes inside a segment the mux does route (which the handler must then
	// refuse itself, since it cannot let `:anything` mean revoke).
	for _, tc := range []struct{ method, target, wantDetail string }{
		{http.MethodGet, secSecretURL(secTProject, secTSecret), "no endpoint"},
		{http.MethodGet, secSecretURL(secTProject, secTSecret) + "/value", "no endpoint"},
		{http.MethodGet, secSecretURL(secTProject, secTSecret) + "/values", "no endpoint"},
		{http.MethodGet, "/api/v1/values/" + secTSecret, "no endpoint"},
		{http.MethodGet, "/api/v1/projects/" + secTProject + "/values/" + secTSecret, "no endpoint"},
		{http.MethodGet, secSecretURL(secTProject, secTSecret) + "/ciphertext", "no endpoint"},
		{http.MethodGet, secSecretURL(secTProject, secTSecret) + "/plaintext", "no endpoint"},
		{http.MethodGet, secSecretURL(secTProject, secTSecret) + "/reveal", "no endpoint"},
		{http.MethodGet, secSecretURL(secTProject, secTSecret) + "/versions", "no endpoint"},
		{http.MethodDelete, secSecretURL(secTProject, secTSecret), "no endpoint"},
		{http.MethodGet, "/api/v1/projects/" + secTProject + "/secret-mounts/" + secTMount, "no endpoint"},
		{http.MethodGet, "/api/v1/projects/" + secTProject + "/secret-mounts/" + secTMount + "/value", "no endpoint"},
		{http.MethodPost, secSecretURL(secTProject, secTSecret) + ":value", "No such endpoint."},
		{http.MethodPost, secSecretURL(secTProject, secTSecret) + ":reveal", "No such endpoint."},
		{http.MethodPost, secSecretURL(secTProject, secTSecret) + ":materialize", "No such endpoint."},
		{http.MethodPost, secSecretURL(secTProject, secTSecret) + ":versions", "No such endpoint."},
	} {
		req := secMutation(tc.method, tc.target, map[string]any{})
		rec := do(t, f.server, req)
		if rec.Code != http.StatusNotFound {
			t.Errorf("%s %s = %d, want 404 (%s)", tc.method, tc.target, rec.Code, rec.Body)
			continue
		}
		if !strings.Contains(rec.Body.String(), tc.wantDetail) {
			t.Errorf("%s %s detail = %s, want it to say %q", tc.method, tc.target, rec.Body.String(), tc.wantDetail)
		}
		if strings.Contains(rec.Body.String(), secTSentinel) {
			t.Errorf("%s %s leaked material: %s", tc.method, tc.target, rec.Body)
		}
	}
}

// --- openapi conformance ------------------------------------------------

// TestSecretViewsMatchOpenAPISchemas pins every secret view's member set to
// components/schemas in api/openapi.yaml. A member invented here is a member the
// UI was never told about; a member that disappears is a client break; and a
// member named value is the milestone's headline failure, so it is asserted from
// the document rather than from anybody's memory of it.
func TestSecretViewsMatchOpenAPISchemas(t *testing.T) {
	cases := []struct {
		schema string
		sample any
	}{
		{"Secret", SecretView{}},
		{"SecretVersionInfo", SecretVersionView{}},
		{"SecretMount", SecretMountView{}},
		{"SecretMaterialization", SecretMaterializationView{}},
		{"SecretList", SecretListView{}},
		{"SecretMountList", SecretMountListView{}},
		{"SecretMaterializationList", SecretMaterializationListView{}},
	}
	for _, tc := range cases {
		t.Run(tc.schema, func(t *testing.T) {
			want, err := secOpenAPISchemaFields(tc.schema)
			if err != nil {
				t.Fatalf("openapi: %v", err)
			}
			if len(want) == 0 {
				t.Fatalf("openapi.yaml documents no properties for %s", tc.schema)
			}
			fields := prjFields(t, secMarshal(t, tc.sample))
			sort.Strings(fields)
			if got := strings.Join(fields, ","); got != strings.Join(want, ",") {
				t.Errorf("%s members = %v, openapi says %v", tc.schema, fields, want)
			}
		})
	}
}

func secOpenAPISchemaFields(name string) ([]string, error) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "api", "openapi.yaml"))
	if err != nil {
		return nil, err
	}
	// Components are two-space-indented under `components:`, so a schema is
	// `    <Name>:` and its keys are at indent 6; property names sit at indent 8
	// under `properties:`. Parsed from the document rather than remembered, so
	// the pin holds when someone edits the schema and not before.
	lines := strings.Split(string(raw), "\n")
	start := -1
	for i, line := range lines {
		if line == "    "+name+":" {
			start = i
			break
		}
	}
	if start < 0 {
		return nil, fmt.Errorf("schema %s not found in api/openapi.yaml", name)
	}
	var out []string
	inProperties := false
	for _, line := range lines[start+1:] {
		if strings.TrimSpace(line) == "" || strings.HasPrefix(strings.TrimSpace(line), "#") {
			continue
		}
		indent := len(line) - len(strings.TrimLeft(line, " "))
		switch {
		case indent <= 6 && !inProperties:
			if strings.TrimSpace(line) == "properties:" {
				inProperties = true
			}
		case indent <= 6 && inProperties:
			return sortStrings(out), nil // next schema key: properties ended
		case inProperties && indent == 8 && strings.HasSuffix(strings.TrimSpace(line), ":"):
			out = append(out, strings.TrimSuffix(strings.TrimSpace(line), ":"))
		}
	}
	return sortStrings(out), nil
}

func sortStrings(in []string) []string {
	sort.Strings(in)
	return in
}
