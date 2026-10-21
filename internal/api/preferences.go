package api

// The per-user display preferences surface (ADR-0046):
// GET/PATCH /api/v1/me/preferences.
//
// The document is the app shell's layout settings plus the assistant trust
// level, one row per principal. The values are display preferences only:
// they authorize nothing and no authorization path reads them, so there is
// no project predicate, no journal event, and no optimistic-concurrency
// version — a save is an upsert and a concurrent save is last-write-wins,
// which is harmless for UI state.
//
// This layer owns the contract shape and the problem answers; the store
// (internal/store/postgres) owns the merge and the semantic validation
// (enum values, the `expanded` map bounds) and reports them as
// *UserPrefsValidationError. Structurally wrong bodies (unknown keys, wrong
// JSON types) never reach the store: DecodeJSON's DisallowUnknownFields
// rejects them here, and the 400 names the stable code.

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"time"
)

// The preference vocabulary, the snake_case contract of api/openapi.yaml's
// UserPreferences (the UI client maps to camelCase).
const (
	PrefProjectsModeTree     = "tree"
	PrefProjectsModeSwitcher = "switcher"

	PrefAskPlacementSidebar  = "sidebar"
	PrefAskPlacementFloating = "floating"

	PrefTrustAskAll   = "ask_all"
	PrefTrustAskRisky = "ask_risky"
	PrefTrustNoAsk    = "no_ask"
)

// The `expanded` map bounds (ADR-0046): at most PrefExpandedMaxKeys keys,
// each at most PrefExpandedMaxKeyChars characters long.
const (
	PrefExpandedMaxKeys     = 500
	PrefExpandedMaxKeyChars = 120
)

// UserPreferences is the document GET and PATCH both answer with: defaults
// merged under the caller's stored values. UpdatedAt is nil until the first
// save.
type UserPreferences struct {
	Layout    UserPreferencesLayout    `json:"layout"`
	Assistant UserPreferencesAssistant `json:"assistant"`
	UpdatedAt *time.Time               `json:"updated_at"`
}

// UserPreferencesLayout is the layout section. Defaults: tree, sidebar,
// true, {}.
type UserPreferencesLayout struct {
	ProjectsMode        string          `json:"projects_mode"`
	AskPlacement        string          `json:"ask_placement"`
	ShowWorkflowFolders bool            `json:"show_workflow_folders"`
	Expanded            map[string]bool `json:"expanded"`
}

// UserPreferencesAssistant is the assistant section. Default trust level:
// ask_risky.
type UserPreferencesAssistant struct {
	TrustLevel string `json:"trust_level"`
}

// DefaultUserPreferences is the document a never-saved user gets.
func DefaultUserPreferences() UserPreferences {
	return UserPreferences{
		Layout: UserPreferencesLayout{
			ProjectsMode:        PrefProjectsModeTree,
			AskPlacement:        PrefAskPlacementSidebar,
			ShowWorkflowFolders: true,
			Expanded:            map[string]bool{},
		},
		Assistant: UserPreferencesAssistant{TrustLevel: PrefTrustAskRisky},
	}
}

// UserPreferencesPatch is the PATCH body: any subset of the document,
// deep-merged per section. A nil pointer is an untouched section, a nil
// member an untouched field; `expanded` merges key-by-key. Unknown keys at
// any level are refused by the decoder before the store is asked.
type UserPreferencesPatch struct {
	Layout    *UserPreferencesLayoutPatch    `json:"layout,omitempty"`
	Assistant *UserPreferencesAssistantPatch `json:"assistant,omitempty"`
}

// UserPreferencesLayoutPatch is the layout section of a patch; every member
// is a pointer so absence means "unchanged".
type UserPreferencesLayoutPatch struct {
	ProjectsMode        *string         `json:"projects_mode,omitempty"`
	AskPlacement        *string         `json:"ask_placement,omitempty"`
	ShowWorkflowFolders *bool           `json:"show_workflow_folders,omitempty"`
	Expanded            map[string]bool `json:"expanded,omitempty"`
}

// UserPreferencesAssistantPatch is the assistant section of a patch.
type UserPreferencesAssistantPatch struct {
	TrustLevel *string `json:"trust_level,omitempty"`
}

// UserPrefsValidationError is the store's 400: the patch (or the merged
// result) fails semantic validation. Field is the dotted JSON path the
// problem body names (e.g. "layout.projects_mode").
type UserPrefsValidationError struct {
	Field  string
	Detail string
}

func (e *UserPrefsValidationError) Error() string {
	if e.Field == "" {
		return e.Detail
	}
	return e.Field + ": " + e.Detail
}

// PreferencesStore is the datastore the handlers need. The methods are keyed
// by the caller's own user id — the routes are /me-scoped, so nothing here
// can read another user's row.
type PreferencesStore interface {
	GetUserPreferences(ctx context.Context, userID string) (UserPreferences, error)
	PatchUserPreferences(ctx context.Context, userID string, in UserPreferencesPatch) (UserPreferences, error)
}

// RegisterPreferences mounts the two ADR-0046 routes.
func RegisterPreferences(s *Server, store PreferencesStore) {
	h := &preferencesHandlers{store: store, srv: s}
	s.HandleAuthed("GET /api/v1/me/preferences", http.HandlerFunc(h.getPreferences))
	s.HandleAuthed("PATCH /api/v1/me/preferences", http.HandlerFunc(h.patchPreferences))
}

type preferencesHandlers struct {
	store PreferencesStore
	srv   *Server
}

func (h *preferencesHandlers) principal(w http.ResponseWriter, r *http.Request) (*Principal, bool) {
	p, ok := PrincipalFrom(r.Context())
	if !ok {
		h.srv.logger.Error("preferences: no principal in context")
		WriteProblem(w, http.StatusInternalServerError, "Internal Server Error",
			"No principal in context.")
		return nil, false
	}
	return p, true
}

func (h *preferencesHandlers) getPreferences(w http.ResponseWriter, r *http.Request) {
	p, ok := h.principal(w, r)
	if !ok {
		return
	}
	doc, err := h.store.GetUserPreferences(r.Context(), p.UserID)
	if err != nil {
		h.srv.logger.Error("preferences.get", "user", p.UserID, "err", err)
		WriteProblem(w, http.StatusInternalServerError, "Internal Server Error",
			"Could not read your preferences.")
		return
	}
	WriteJSON(w, http.StatusOK, doc)
}

func (h *preferencesHandlers) patchPreferences(w http.ResponseWriter, r *http.Request) {
	p, ok := h.principal(w, r)
	if !ok {
		return
	}
	var in UserPreferencesPatch
	if err := DecodeJSON(r, &in); err != nil {
		h.srv.logger.Error("preferences.patch decode", "user", p.UserID, "err", err)
		prefsProblem(w, "", err.Error())
		return
	}
	doc, err := h.store.PatchUserPreferences(r.Context(), p.UserID, in)
	if err != nil {
		var ve *UserPrefsValidationError
		if errors.As(err, &ve) {
			prefsProblem(w, ve.Field, ve.Detail)
			return
		}
		h.srv.logger.Error("preferences.patch", "user", p.UserID, "err", err)
		WriteProblem(w, http.StatusInternalServerError, "Internal Server Error",
			"Could not save your preferences.")
		return
	}
	WriteJSON(w, http.StatusOK, doc)
}

// prefsProblem writes the surface's 400: the Problem shape with the stable
// code and (when the store named one) the dotted field path, the same
// detail-embedded-code convention the rest of the API uses.
func prefsProblem(w http.ResponseWriter, field, detail string) {
	h := w.Header()
	h.Set("Content-Type", ProblemJSON)
	h.Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusBadRequest)
	extra := struct {
		Code  string `json:"code"`
		Field string `json:"field,omitempty"`
	}{Code: "invalid_preferences", Field: field}
	_ = json.NewEncoder(w).Encode(m4MergeProblem(
		"https://communication.dev/errors/invalid-preferences",
		"Invalid Preferences", http.StatusBadRequest, detail, extra))
}
