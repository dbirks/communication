package postgres

import (
	"context"
	"errors"
	"fmt"

	"github.com/dbirks/communication/internal/api"
)

// APIArtifactStore exposes an *ArtifactStore as internal/api's ArtifactStore
// and PreviewStore. The dependency rule (adapters depend on interfaces, never
// the reverse) means package api must not import this package, so the
// conversion lives here: api owns the view types and the sentinel errors, this
// adapter turns rows into views and postgres errors into api errors.
//
// The conversion is also the only place `storage_key` can leak into a response,
// which is why it is assigned to a `json:"-"` field on the way through and a
// test asserts the serialized view never names it (docs/m3-contract.md § 2).
type APIArtifactStore struct {
	S *ArtifactStore
	// Denials records audit rows; usually the same *ProjectStore the API
	// already holds, taken as an interface so this file does not assume it.
	Denials interface {
		RecordDenied(ctx context.Context, c Caller, projectID, action string) error
	}
}

var (
	_ api.ArtifactStore = APIArtifactStore{}
	_ api.PreviewStore  = APIArtifactStore{}
)

func (a APIArtifactStore) store() (*ArtifactStore, error) {
	if a.S == nil || a.S.Pool == nil {
		return nil, errors.New("postgres: APIArtifactStore has no pool")
	}
	return a.S, nil
}

// artAPIErr maps a store error onto the sentinel set the handlers switch on.
func artAPIErr(err error) error {
	switch {
	case err == nil:
		return nil
	case errors.Is(err, ErrArtifactNotFound), errors.Is(err, ErrProjectNotFound):
		return api.ErrArtifactNotFound
	case errors.Is(err, ErrArtifactForbidden):
		return api.ErrArtifactForbidden
	case errors.Is(err, ErrArtifactNotReady):
		return api.ErrArtifactNotReady
	default:
		return err
	}
}

// ListArtifacts implements api.ArtifactStore.
func (a APIArtifactStore) ListArtifacts(ctx context.Context, c api.Caller, projectID string) ([]api.ArtifactView, error) {
	s, err := a.store()
	if err != nil {
		return nil, err
	}
	rows, err := s.ListArtifacts(ctx, artCaller(c), projectID)
	if err != nil {
		return nil, artAPIErr(err)
	}
	out := make([]api.ArtifactView, 0, len(rows))
	for _, r := range rows {
		out = append(out, artAPIView(r))
	}
	return out, nil
}

// GetArtifact implements api.ArtifactStore.
func (a APIArtifactStore) GetArtifact(ctx context.Context, c api.Caller, artifactID string) (api.ArtifactView, error) {
	s, err := a.store()
	if err != nil {
		return api.ArtifactView{}, err
	}
	row, err := s.GetArtifact(ctx, artCaller(c), artifactID)
	if err != nil {
		return api.ArtifactView{}, artAPIErr(err)
	}
	return artAPIView(row), nil
}

// ArtifactForPreview implements api.PreviewStore. There is no caller to pass:
// the bearer of a checked HMAC token is authorized by that token and by
// nothing else, which is what the separate store method makes visible at the
// type level.
func (a APIArtifactStore) ArtifactForPreview(ctx context.Context, artifactID string) (api.ArtifactView, error) {
	s, err := a.store()
	if err != nil {
		return api.ArtifactView{}, err
	}
	row, err := s.ArtifactForPreview(ctx, artifactID)
	if err != nil {
		return api.ArtifactView{}, artAPIErr(err)
	}
	return artAPIView(row), nil
}

// RecordDenied implements api.ArtifactStore. It refuses to invent a project id
// out of thin air: an action against an artifact the caller cannot see is
// audited against the project when one is known and against the organization
// otherwise (the same shape projects.go uses).
func (a APIArtifactStore) RecordDenied(ctx context.Context, c api.Caller, projectID, action string) error {
	if a.Denials == nil {
		return errors.New("postgres: APIArtifactStore has no denial recorder")
	}
	if action == "" {
		action = "artifact access denied"
	}
	if err := a.Denials.RecordDenied(ctx, artCaller(c), projectID, action); err != nil {
		return fmt.Errorf("postgres: record artifact denial: %w", err)
	}
	return nil
}

// artCaller is api.Caller as the store sees it.
func artCaller(c api.Caller) Caller {
	return Caller{UserID: c.UserID, OrganizationID: c.OrganizationID, IsOrgAdmin: c.IsOrgAdmin}
}

// artAPIView turns a row into the Artifact schema of api/openapi.yaml. The
// nullable ids are "" in the row shape and null in the schema, which is what
// artNull is for; an empty string there would be a value, not an absence.
func artAPIView(a Artifact) api.ArtifactView {
	return api.ArtifactView{
		ID: a.ID, ProjectID: a.ProjectID,
		RunID:           artNull(a.RunID),
		NodeExecutionID: artNull(a.NodeExecutionID),
		AttemptID:       artNull(a.AttemptID),
		ConversationID:  artNull(a.ConversationID),
		TurnID:          artNull(a.TurnID),
		WorkerID:        artNull(a.WorkerID),
		Name:            a.Name, Kind: a.Kind, MediaType: a.MediaType,
		SHA256: a.SHA256, SizeBytes: a.SizeBytes,
		Sensitivity: a.Sensitivity, State: a.State,
		RedactionCount: a.RedactionCount, CreatedBy: a.CreatedBy,
		CreatedAt: a.CreatedAt, ReadyAt: a.ReadyAt,
		ExpiresAt: a.ExpiresAt, DeletedAt: a.DeletedAt,
		// Backend-only fields, invisible in JSON:
		StorageBackend: a.StorageBackend, StorageKey: a.StorageKey,
		MyRole: a.MyRole,
	}
}

func artNull(s string) *string {
	if s == "" {
		return nil
	}
	v := s
	return &v
}
