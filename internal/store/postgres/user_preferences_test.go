package postgres

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/dbirks/communication/internal/api"
)

// prefsFixture migrates the scratch database and gives the tests one pool and
// one user; cleanup deletes exactly the rows named by id.
type prefsFixture struct {
	t     *testing.T
	pool  *pgxpool.Pool
	user  string
	store *UserPreferencesStore
}

func prefsTestFixture(t *testing.T) *prefsFixture {
	t.Helper()
	url := testDatabaseURL(t)
	mustMigrate(t)

	ctx := testCtx(t)
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatalf("pgxpool.New: %v", err)
	}
	t.Cleanup(pool.Close)

	var orgID, userID string
	if err := pool.QueryRow(ctx,
		`SELECT id FROM organizations WHERE slug = 'default'`).Scan(&orgID); err != nil {
		t.Fatalf("default organization: %v", err)
	}
	if err := pool.QueryRow(ctx,
		`INSERT INTO users (organization_id, display_name) VALUES ($1::uuid, $2) RETURNING id::text`,
		orgID, "prefs-test-user").Scan(&userID); err != nil {
		t.Fatalf("insert user: %v", err)
	}
	f := &prefsFixture{
		t:     t,
		pool:  pool,
		user:  userID,
		store: &UserPreferencesStore{Pool: pool},
	}
	t.Cleanup(func() {
		bg := context.Background()
		if _, err := pool.Exec(bg, `DELETE FROM user_preferences WHERE user_id = $1::uuid`,
			f.user); err != nil {
			t.Errorf("cleanup user_preferences: %v", err)
		}
		if _, err := pool.Exec(bg, `DELETE FROM users WHERE id = $1::uuid`, f.user); err != nil {
			t.Errorf("cleanup user: %v", err)
		}
	})
	return f
}

func prefsStr(v string) *string { return &v }

func prefsStrBool(v bool) *bool { return &v }

// sameLayout compares two layout documents field by field (a struct holding
// a map cannot use ==).
func sameLayout(a, b api.UserPreferencesLayout) bool {
	if a.ProjectsMode != b.ProjectsMode || a.AskPlacement != b.AskPlacement ||
		a.ShowWorkflowFolders != b.ShowWorkflowFolders ||
		len(a.Expanded) != len(b.Expanded) {
		return false
	}
	for k, v := range a.Expanded {
		if b.Expanded[k] != v {
			return false
		}
	}
	return true
}

func sameAssistant(a, b api.UserPreferencesAssistant) bool { return a.TrustLevel == b.TrustLevel }

func TestUserPrefsGetDefaultsForNeverSaved(t *testing.T) {
	f := prefsTestFixture(t)
	doc, err := f.store.GetUserPreferences(testCtx(t), f.user)
	if err != nil {
		t.Fatalf("GetUserPreferences: %v", err)
	}
	want := api.DefaultUserPreferences()
	if !sameLayout(doc.Layout, want.Layout) {
		t.Fatalf("layout = %+v, want the defaults", doc.Layout)
	}
	if !sameAssistant(doc.Assistant, want.Assistant) {
		t.Fatalf("assistant = %+v, want the defaults", doc.Assistant)
	}
	if doc.UpdatedAt != nil {
		t.Fatalf("updated_at = %v, want nil for a never-saved user", *doc.UpdatedAt)
	}
	if doc.Layout.Expanded == nil {
		t.Fatal("expanded is nil, want the empty map")
	}
}

func TestUserPrefsPatchMergesSectionsAndPersists(t *testing.T) {
	f := prefsTestFixture(t)
	ctx := testCtx(t)

	doc, err := f.store.PatchUserPreferences(ctx, f.user, api.UserPreferencesPatch{
		Layout: &api.UserPreferencesLayoutPatch{
			ProjectsMode:        prefsStr(api.PrefProjectsModeSwitcher),
			ShowWorkflowFolders: prefsStrBool(false),
		},
		Assistant: &api.UserPreferencesAssistantPatch{
			TrustLevel: prefsStr(api.PrefTrustNoAsk),
		},
	})
	if err != nil {
		t.Fatalf("PatchUserPreferences: %v", err)
	}
	if doc.Layout.ProjectsMode != api.PrefProjectsModeSwitcher {
		t.Fatalf("projects_mode = %q, want switcher", doc.Layout.ProjectsMode)
	}
	if doc.Layout.AskPlacement != api.PrefAskPlacementSidebar {
		t.Fatalf("ask_placement = %q, want the untouched default sidebar", doc.Layout.AskPlacement)
	}
	if doc.Layout.ShowWorkflowFolders {
		t.Fatal("show_workflow_folders = true, want the patch's false")
	}
	if doc.Assistant.TrustLevel != api.PrefTrustNoAsk {
		t.Fatalf("trust_level = %q, want no_ask", doc.Assistant.TrustLevel)
	}
	if doc.UpdatedAt == nil {
		t.Fatal("updated_at is nil after the first save")
	}

	// The row survived in Postgres: a fresh read sees the saved values and
	// the same updated_at.
	back, err := f.store.GetUserPreferences(ctx, f.user)
	if err != nil {
		t.Fatalf("GetUserPreferences: %v", err)
	}
	if !sameLayout(back.Layout, doc.Layout) || !sameAssistant(back.Assistant, doc.Assistant) ||
		back.UpdatedAt == nil || !back.UpdatedAt.Equal(*doc.UpdatedAt) {
		t.Fatalf("stored doc = %+v, want the patch's answer %+v", back, doc)
	}
	if back.UpdatedAt.Before(time.Now().Add(-time.Hour)) {
		t.Fatalf("updated_at = %v, want a recent timestamp", *back.UpdatedAt)
	}
}

func TestUserPrefsSecondPatchKeepsFirstSection(t *testing.T) {
	f := prefsTestFixture(t)
	ctx := testCtx(t)
	if _, err := f.store.PatchUserPreferences(ctx, f.user, api.UserPreferencesPatch{
		Layout: &api.UserPreferencesLayoutPatch{
			ProjectsMode: prefsStr(api.PrefProjectsModeSwitcher),
		},
	}); err != nil {
		t.Fatalf("first patch: %v", err)
	}
	doc, err := f.store.PatchUserPreferences(ctx, f.user, api.UserPreferencesPatch{
		Assistant: &api.UserPreferencesAssistantPatch{
			TrustLevel: prefsStr(api.PrefTrustAskAll),
		},
	})
	if err != nil {
		t.Fatalf("second patch: %v", err)
	}
	if doc.Layout.ProjectsMode != api.PrefProjectsModeSwitcher {
		t.Fatalf("projects_mode = %q, want the first patch's switcher kept",
			doc.Layout.ProjectsMode)
	}
	if doc.Assistant.TrustLevel != api.PrefTrustAskAll {
		t.Fatalf("trust_level = %q, want ask_all", doc.Assistant.TrustLevel)
	}
}

func TestUserPrefsPatchInvalidValuesAreRefused(t *testing.T) {
	f := prefsTestFixture(t)
	ctx := testCtx(t)
	tests := []struct {
		name  string
		patch api.UserPreferencesPatch
		field string
	}{
		{"bad projects_mode", api.UserPreferencesPatch{
			Layout: &api.UserPreferencesLayoutPatch{ProjectsMode: prefsStr("orbit")},
		}, "layout.projects_mode"},
		{"bad ask_placement", api.UserPreferencesPatch{
			Layout: &api.UserPreferencesLayoutPatch{AskPlacement: prefsStr("ceiling")},
		}, "layout.ask_placement"},
		{"bad trust_level", api.UserPreferencesPatch{
			Assistant: &api.UserPreferencesAssistantPatch{TrustLevel: prefsStr("yolo")},
		}, "assistant.trust_level"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := f.store.PatchUserPreferences(ctx, f.user, tt.patch)
			var ve *api.UserPrefsValidationError
			if !errors.As(err, &ve) {
				t.Fatalf("err = %v, want *api.UserPrefsValidationError", err)
			}
			if ve.Field != tt.field {
				t.Fatalf("field = %q, want %q", ve.Field, tt.field)
			}
			// A refused patch changes nothing.
			back, err := f.store.GetUserPreferences(ctx, f.user)
			if err != nil {
				t.Fatalf("GetUserPreferences: %v", err)
			}
			if back.UpdatedAt != nil {
				t.Fatalf("updated_at = %v, want nil — the refused patch must not write",
					*back.UpdatedAt)
			}
		})
	}
}

func TestUserPrefsExpandedBounds(t *testing.T) {
	f := prefsTestFixture(t)
	ctx := testCtx(t)

	// A key over the bound is named on the request that submits it.
	longKey := fmt.Sprintf("%0121d", 1)
	_, err := f.store.PatchUserPreferences(ctx, f.user, api.UserPreferencesPatch{
		Layout: &api.UserPreferencesLayoutPatch{
			Expanded: map[string]bool{longKey: true},
		},
	})
	var ve *api.UserPrefsValidationError
	if !errors.As(err, &ve) || ve.Field != "layout.expanded" {
		t.Fatalf("err = %v, want the layout.expanded refusal", err)
	}

	// More than the bound in one patch.
	big := make(map[string]bool)
	for i := 0; i < api.PrefExpandedMaxKeys+1; i++ {
		big[fmt.Sprintf("p-%03d", i)] = true
	}
	if _, err := f.store.PatchUserPreferences(ctx, f.user, api.UserPreferencesPatch{
		Layout: &api.UserPreferencesLayoutPatch{Expanded: big},
	}); !errors.As(err, &ve) {
		t.Fatalf("err = %v, want the layout.expanded refusal", err)
	}

	// The bound itself lands, and the merge keeps counting: 499 stored keys
	// plus 2 new ones is over the bound and is refused before any write.
	ok500 := make(map[string]bool)
	for i := 0; i < api.PrefExpandedMaxKeys; i++ {
		ok500[fmt.Sprintf("p-%03d", i)] = true
	}
	if _, err := f.store.PatchUserPreferences(ctx, f.user, api.UserPreferencesPatch{
		Layout: &api.UserPreferencesLayoutPatch{Expanded: ok500},
	}); err != nil {
		t.Fatalf("500-key patch: %v", err)
	}
	// Rebuild a 499-key map and add 2 fresh keys.
	nearly := make(map[string]bool)
	for i := 0; i < api.PrefExpandedMaxKeys-1; i++ {
		nearly[fmt.Sprintf("p-%03d", i)] = true
	}
	over := map[string]bool{"fresh-a": true, "fresh-b": true}
	for k, v := range nearly {
		over[k] = v
	}
	_, err = f.store.PatchUserPreferences(ctx, f.user, api.UserPreferencesPatch{
		Layout: &api.UserPreferencesLayoutPatch{Expanded: over},
	})
	if !errors.As(err, &ve) || ve.Field != "layout.expanded" {
		t.Fatalf("err = %v, want the post-merge bound refusal", err)
	}
	back, err := f.store.GetUserPreferences(ctx, f.user)
	if err != nil {
		t.Fatalf("GetUserPreferences: %v", err)
	}
	if got := len(back.Layout.Expanded); got != api.PrefExpandedMaxKeys {
		t.Fatalf("expanded has %d keys, want the 500 the last accepted patch wrote", got)
	}
}

func TestUserPrefsExpandedMergesKeyByKey(t *testing.T) {
	f := prefsTestFixture(t)
	ctx := testCtx(t)
	if _, err := f.store.PatchUserPreferences(ctx, f.user, api.UserPreferencesPatch{
		Layout: &api.UserPreferencesLayoutPatch{
			Expanded: map[string]bool{"p-1": true, "p-2": true},
		},
	}); err != nil {
		t.Fatalf("first patch: %v", err)
	}
	doc, err := f.store.PatchUserPreferences(ctx, f.user, api.UserPreferencesPatch{
		Layout: &api.UserPreferencesLayoutPatch{
			Expanded: map[string]bool{"p-3": true, "p-1": false},
		},
	})
	if err != nil {
		t.Fatalf("second patch: %v", err)
	}
	want := map[string]bool{"p-1": false, "p-2": true, "p-3": true}
	if len(doc.Layout.Expanded) != len(want) {
		t.Fatalf("expanded = %v, want %v", doc.Layout.Expanded, want)
	}
	for k, v := range want {
		if doc.Layout.Expanded[k] != v {
			t.Fatalf("expanded[%q] = %v, want %v (full map %v)", k,
				doc.Layout.Expanded[k], v, doc.Layout.Expanded)
		}
	}
}
