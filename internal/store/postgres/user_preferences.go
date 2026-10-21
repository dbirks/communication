package postgres

// The user_preferences table (ADR-0046): one display-preference document per
// principal, two jsonb sections (layout, assistant) and a NULL-until-first-
// save updated_at.
//
// The store owns the merge and the semantic validation. The defaults live in
// the api package (api.DefaultUserPreferences — the contract's shape) and the
// stored documents merge under them: a member missing from a stored row
// (a preference added after the row was written) keeps its default, and a
// stored member always wins. Unknown stored keys are dropped on the way out,
// which normalizes rows written by older versions.
//
// Concurrency is deliberately last-write-wins: the values are UI display
// state with no authorization effect, so there is no version and no lost
// update that a user could act on (ADR-0046). A save is one upsert; there is
// no journal event because nothing in the org or project event streams
// consumes a display change.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/dbirks/communication/internal/api"
)

// UserPreferencesStore owns the user_preferences table.
type UserPreferencesStore struct {
	Pool *pgxpool.Pool
}

// GetUserPreferences returns the caller's document with the defaults merged
// under the stored values. A never-saved user gets the defaults and a nil
// UpdatedAt.
func (s *UserPreferencesStore) GetUserPreferences(ctx context.Context,
	userID string) (api.UserPreferences, error) {
	if s == nil || s.Pool == nil {
		return api.UserPreferences{}, errors.New("postgres: user preferences store has no pool")
	}
	doc := api.DefaultUserPreferences()
	var layout, assistant []byte
	var updatedAt *time.Time
	err := s.Pool.QueryRow(ctx,
		`SELECT layout, assistant, updated_at FROM user_preferences WHERE user_id = $1`,
		userID).Scan(&layout, &assistant, &updatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return doc, nil
	}
	if err != nil {
		return api.UserPreferences{},
			fmt.Errorf("postgres: get user preferences %s: %w", userID, err)
	}
	// Unmarshalling into the defaults IS the merge: json leaves absent
	// members untouched, so stored values land over the defaults and the
	// defaults fill any gap. The table CHECKs guarantee both columns are
	// objects; a member of a wrong type is corrupt data, reported as 500.
	if err := json.Unmarshal(layout, &doc.Layout); err != nil {
		return api.UserPreferences{},
			fmt.Errorf("postgres: user preferences layout of %s: %w", userID, err)
	}
	if err := json.Unmarshal(assistant, &doc.Assistant); err != nil {
		return api.UserPreferences{},
			fmt.Errorf("postgres: user preferences assistant of %s: %w", userID, err)
	}
	doc.UpdatedAt = updatedAt
	return doc, nil
}

// PatchUserPreferences deep-merges the patch into the caller's current
// document, validates it, upserts it (one write) and returns the full
// document with the new updated_at. A validation failure changes nothing.
func (s *UserPreferencesStore) PatchUserPreferences(ctx context.Context,
	userID string, in api.UserPreferencesPatch) (api.UserPreferences, error) {
	if s == nil || s.Pool == nil {
		return api.UserPreferences{}, errors.New("postgres: user preferences store has no pool")
	}
	current, err := s.GetUserPreferences(ctx, userID)
	if err != nil {
		return api.UserPreferences{}, err
	}
	if err := prefsMergePatch(&current, in); err != nil {
		return api.UserPreferences{}, err
	}
	layoutJSON, err := json.Marshal(current.Layout)
	if err != nil {
		return api.UserPreferences{}, fmt.Errorf("postgres: encode layout: %w", err)
	}
	assistantJSON, err := json.Marshal(current.Assistant)
	if err != nil {
		return api.UserPreferences{}, fmt.Errorf("postgres: encode assistant: %w", err)
	}
	now := time.Now().UTC().Truncate(time.Millisecond)
	_, err = s.Pool.Exec(ctx, `
		INSERT INTO user_preferences (user_id, layout, assistant, updated_at)
		VALUES ($1, $2, $3, $4)
		ON CONFLICT (user_id) DO UPDATE
		SET layout = EXCLUDED.layout,
		    assistant = EXCLUDED.assistant,
		    updated_at = EXCLUDED.updated_at`,
		userID, layoutJSON, assistantJSON, now)
	if err != nil {
		return api.UserPreferences{},
			fmt.Errorf("postgres: save user preferences %s: %w", userID, err)
	}
	current.UpdatedAt = &now
	return current, nil
}

// prefsMergePatch validates the patch and applies it into current, per
// section. It reports every semantic miss as *api.UserPrefsValidationError
// naming the dotted field, so the handler's 400 says which member was wrong
// without the client re-reading the document.
func prefsMergePatch(current *api.UserPreferences, patch api.UserPreferencesPatch) error {
	if patch.Layout != nil {
		l := patch.Layout
		if l.ProjectsMode != nil {
			if *l.ProjectsMode != api.PrefProjectsModeTree &&
				*l.ProjectsMode != api.PrefProjectsModeSwitcher {
				return &api.UserPrefsValidationError{
					Field: "layout.projects_mode",
					Detail: fmt.Sprintf("must be %q or %q",
						api.PrefProjectsModeTree, api.PrefProjectsModeSwitcher),
				}
			}
			current.Layout.ProjectsMode = *l.ProjectsMode
		}
		if l.AskPlacement != nil {
			if *l.AskPlacement != api.PrefAskPlacementSidebar &&
				*l.AskPlacement != api.PrefAskPlacementFloating {
				return &api.UserPrefsValidationError{
					Field: "layout.ask_placement",
					Detail: fmt.Sprintf("must be %q or %q",
						api.PrefAskPlacementSidebar, api.PrefAskPlacementFloating),
				}
			}
			current.Layout.AskPlacement = *l.AskPlacement
		}
		if l.ShowWorkflowFolders != nil {
			current.Layout.ShowWorkflowFolders = *l.ShowWorkflowFolders
		}
		if l.Expanded != nil {
			if len(l.Expanded) > api.PrefExpandedMaxKeys {
				return &api.UserPrefsValidationError{
					Field:  "layout.expanded",
					Detail: fmt.Sprintf("has at most %d keys", api.PrefExpandedMaxKeys),
				}
			}
			for key := range l.Expanded {
				if len(key) > api.PrefExpandedMaxKeyChars {
					return &api.UserPrefsValidationError{
						Field: "layout.expanded",
						Detail: fmt.Sprintf("keys are at most %d characters",
							api.PrefExpandedMaxKeyChars),
					}
				}
			}
			if current.Layout.Expanded == nil {
				current.Layout.Expanded = map[string]bool{}
			}
			for key, v := range l.Expanded {
				current.Layout.Expanded[key] = v
			}
			if len(current.Layout.Expanded) > api.PrefExpandedMaxKeys {
				return &api.UserPrefsValidationError{
					Field: "layout.expanded",
					Detail: fmt.Sprintf("has at most %d keys after the merge",
						api.PrefExpandedMaxKeys),
				}
			}
		}
	}
	if patch.Assistant != nil && patch.Assistant.TrustLevel != nil {
		t := *patch.Assistant.TrustLevel
		if t != api.PrefTrustAskAll && t != api.PrefTrustAskRisky && t != api.PrefTrustNoAsk {
			return &api.UserPrefsValidationError{
				Field: "assistant.trust_level",
				Detail: fmt.Sprintf("must be one of %q, %q or %q",
					api.PrefTrustAskAll, api.PrefTrustAskRisky, api.PrefTrustNoAsk),
			}
		}
		current.Assistant.TrustLevel = t
	}
	return nil
}

// APIUserPreferencesStore adapts UserPreferencesStore to the api.PreferencesStore
// interface, the way the other store adapters in this package do.
type APIUserPreferencesStore struct {
	S *UserPreferencesStore
}

// GetUserPreferences implements api.PreferencesStore.
func (a APIUserPreferencesStore) GetUserPreferences(ctx context.Context,
	userID string) (api.UserPreferences, error) {
	return a.S.GetUserPreferences(ctx, userID)
}

// PatchUserPreferences implements api.PreferencesStore.
func (a APIUserPreferencesStore) PatchUserPreferences(ctx context.Context,
	userID string, in api.UserPreferencesPatch) (api.UserPreferences, error) {
	return a.S.PatchUserPreferences(ctx, userID, in)
}
