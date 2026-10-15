package postgres

import (
	"context"
	"errors"
	"fmt"

	"github.com/dbirks/communication/internal/api"
	"github.com/dbirks/communication/internal/secrets"
)

// APISecretStore exposes a *SecretStore as internal/api's SecretStore interface.
// The dependency rule (adapters depend on interfaces, never the reverse) means
// package api must not import this package, so the conversion lives here: api owns
// the view types and the sentinel errors, this adapter turns them into and out of
// the store's own types (the same arrangement APIProjectStore uses).
//
// The direction that matters is the one this adapter cannot reverse: a value goes
// in as a []byte and nothing comes back but metadata. That is not a convention
// upheld by review here — api.SecretStore has no method whose result could carry
// material, so there is nothing for this file to accidentally return.
type APISecretStore struct {
	S *SecretStore
}

var (
	_ api.SecretStore = APISecretStore{}
	_ api.SecretStore = (*APISecretStore)(nil)
)

func (a APISecretStore) store() (*SecretStore, error) {
	if a.S == nil || a.S.Pool == nil {
		return nil, errors.New("postgres: APISecretStore has no pool")
	}
	if a.S.Keys == nil {
		return nil, ErrKeyringUnavailable
	}
	return a.S, nil
}

// apiSecretErr maps store errors onto the sentinels the HTTP layer switches on.
//
// ErrSecretNotFound joins to api.ErrProjectNotFound rather than to a secret-shaped
// 404 on purpose: m3-contract C15d requires a member asking for a secret in a
// project she cannot see to receive a body byte-identical to the one a random uuid
// produces, and two distinct not-found renderings would break that.
func apiSecretErr(err error) error {
	switch {
	case err == nil:
		return nil
	case errors.Is(err, ErrSecretNotFound), errors.Is(err, ErrMountNotFound), errors.Is(err, ErrProjectNotFound):
		return fmt.Errorf("%w: %w", api.ErrProjectNotFound, err)
	case errors.Is(err, ErrConflict), errors.Is(err, ErrSecretRevoked):
		return fmt.Errorf("%w: %w", api.ErrSecretConflict, err)
	case errors.Is(err, ErrSecretForbidden):
		return fmt.Errorf("%w: %w", api.ErrSecretForbidden, err)
	case errors.Is(err, ErrRepositoryNotInProject):
		return fmt.Errorf("%w: %w", api.ErrSecretPlacementInvalid, err)
	case errors.Is(err, ErrDeliveryUnsupported):
		return fmt.Errorf("%w: %w", api.ErrSecretDeliveryUnsupported, err)
	default:
		return err
	}
}

func apiSecretCaller(c api.Caller) Caller {
	return Caller{UserID: c.UserID, OrganizationID: c.OrganizationID, IsOrgAdmin: c.IsOrgAdmin}
}

func apiSecretView(s Secret) api.SecretView {
	return api.SecretView{
		ID: s.ID, Slug: s.Slug, Scope: s.Scope, Purpose: s.Purpose,
		Delivery: s.DeliveryMode, CurrentVS: s.CurrentVersion,
		Profiles:  secNonNil(s.Profiles),
		Audit:     s.AuditPolicy,
		CreatedAt: s.CreatedAt.UTC(), RotatedAt: s.RotatedAt, RevokedAt: s.RevokedAt,
	}
}

func (a APISecretStore) ListSecrets(ctx context.Context, c api.Caller, projectID string) ([]api.SecretView, error) {
	s, err := a.store()
	if err != nil {
		return nil, err
	}
	rows, err := s.ListSecrets(ctx, apiSecretCaller(c), projectID)
	if err != nil {
		return nil, apiSecretErr(err)
	}
	out := make([]api.SecretView, 0, len(rows))
	for _, row := range rows {
		out = append(out, apiSecretView(row))
	}
	return out, nil
}

func (a APISecretStore) CreateSecret(ctx context.Context, c api.Caller, projectID string, in api.SecretCreateInput) (api.SecretView, error) {
	s, err := a.store()
	if err != nil {
		return api.SecretView{}, err
	}
	created, err := s.CreateSecret(ctx, apiSecretCaller(c), projectID, NewSecret{
		Slug: in.Slug, Purpose: in.Purpose, DeliveryMode: in.DeliveryMode,
		Scope: in.Scope, Profiles: in.Profiles, Value: in.Value,
	})
	// The plaintext has been sealed by now, in this transaction; zeroing the
	// handler's buffer is this layer's obligation because the handler cannot know
	// whether the store kept a reference.
	clear(in.Value)
	if err != nil {
		return api.SecretView{}, apiSecretErr(err)
	}
	return apiSecretView(created), nil
}

func (a APISecretStore) UpdateSecret(ctx context.Context, c api.Caller, projectID, secretID string, in api.SecretPolicyInput) (api.SecretView, error) {
	s, err := a.store()
	if err != nil {
		return api.SecretView{}, err
	}
	updated, err := s.UpdateSecretPolicy(ctx, apiSecretCaller(c), projectID, secretID, NewSecretPolicy{
		Purpose: in.Purpose, Profiles: in.Profiles, Audit: in.Audit,
	})
	if err != nil {
		return api.SecretView{}, apiSecretErr(err)
	}
	return apiSecretView(updated), nil
}

func (a APISecretStore) AddSecretVersion(ctx context.Context, c api.Caller, projectID, secretID string, value []byte) (api.SecretVersionView, error) {
	s, err := a.store()
	if err != nil {
		return api.SecretVersionView{}, err
	}
	added, err := s.AddSecretVersion(ctx, apiSecretCaller(c), projectID, secretID, value)
	clear(value)
	if err != nil {
		return api.SecretVersionView{}, apiSecretErr(err)
	}
	return api.SecretVersionView{
		SecretID: added.SecretID, Version: added.Version, KeyID: added.KeyID,
		CreatedAt: added.CreatedAt.UTC(),
	}, nil
}

func (a APISecretStore) RevokeSecret(ctx context.Context, c api.Caller, projectID, secretID string) (api.SecretView, error) {
	s, err := a.store()
	if err != nil {
		return api.SecretView{}, err
	}
	revoked, err := s.RevokeSecret(ctx, apiSecretCaller(c), projectID, secretID)
	if err != nil {
		return api.SecretView{}, apiSecretErr(err)
	}
	return apiSecretView(revoked), nil
}

func (a APISecretStore) ListSecretMaterializations(ctx context.Context, c api.Caller, projectID, secretID string) ([]api.SecretMaterializationView, error) {
	s, err := a.store()
	if err != nil {
		return nil, err
	}
	rows, err := s.ListMaterializations(ctx, apiSecretCaller(c), projectID, secretID)
	if err != nil {
		return nil, apiSecretErr(err)
	}
	out := make([]api.SecretMaterializationView, 0, len(rows))
	for _, row := range rows {
		view := api.SecretMaterializationView{
			ID: row.ID, SecretID: row.SecretID, Slug: row.SecretSlug,
			SecretVersion: row.SecretVersion, WorkerID: row.WorkerID,
			Delivery: row.DeliveryMode, Target: row.Target,
			MaterializedAt: row.MaterializedAt.UTC(), CleanedAt: row.CleanedAt,
		}
		// Nulls are the finding state, so they are pointers rather than zeros: a
		// cleaned_at of 0001-01-01 would read as "cleaned a long time ago" to
		// every client that does not know this row was never cleaned.
		if row.WorkspaceID != "" {
			id := row.WorkspaceID
			view.WorkspaceID = &id
		}
		if row.TurnID != "" {
			id := row.TurnID
			view.TurnID = &id
		}
		if row.FileMode != 0 {
			mode := row.FileMode
			view.FileMode = &mode
		}
		if row.CleanedBy != "" {
			by := row.CleanedBy
			view.CleanedBy = &by
		}
		out = append(out, view)
	}
	return out, nil
}

func (a APISecretStore) ListSecretMounts(ctx context.Context, c api.Caller, projectID string) ([]api.SecretMountView, error) {
	s, err := a.store()
	if err != nil {
		return nil, err
	}
	rows, err := s.ListMounts(ctx, apiSecretCaller(c), projectID)
	if err != nil {
		return nil, apiSecretErr(err)
	}
	out := make([]api.SecretMountView, 0, len(rows))
	for _, row := range rows {
		out = append(out, apiMountView(row))
	}
	return out, nil
}

func (a APISecretStore) CreateSecretMount(ctx context.Context, c api.Caller, projectID string, in api.SecretMountInput) (api.SecretMountView, error) {
	s, err := a.store()
	if err != nil {
		return api.SecretMountView{}, err
	}
	created, err := s.CreateMount(ctx, apiSecretCaller(c), projectID, NewSecretMount{
		SecretID: in.SecretID, DeliveryMode: in.DeliveryMode, RepositoryID: in.RepositoryID,
		RelativePath: in.RelativePath, EnvName: in.EnvName, Key: in.Key,
		Lifecycle: in.Lifecycle, AllowTracked: in.AllowTracked,
	})
	if err != nil {
		return api.SecretMountView{}, apiSecretErr(err)
	}
	return apiMountView(created), nil
}

func (a APISecretStore) DeleteSecretMount(ctx context.Context, c api.Caller, projectID, mountID string) error {
	s, err := a.store()
	if err != nil {
		return err
	}
	return apiSecretErr(s.DeleteMount(ctx, apiSecretCaller(c), projectID, mountID))
}

func apiMountView(m SecretMount) api.SecretMountView {
	view := api.SecretMountView{
		ID: m.ID, ProjectID: m.ProjectID, SecretID: m.SecretID, SecretSlug: m.SecretSlug,
		Delivery: m.DeliveryMode, Lifecycle: m.Lifecycle, AllowTracked: m.AllowTracked,
		CreatedAt: m.CreatedAt.UTC(),
	}
	// A mount's *declared* placement keeps its nulls: relative_path present and
	// env_name present on one row would be a row the CHECK forbids, and a client
	// reading a `{}` for the other half could not tell an env mount from a broken
	// env_file mount.
	for _, pair := range []struct {
		in  string
		out **string
	}{
		{m.RepositoryID, &view.RepositoryID},
		{m.RelativePath, &view.RelativePath},
		{m.EnvName, &view.EnvName},
		{m.Key, &view.Key},
	} {
		if pair.in != "" {
			value := pair.in
			*pair.out = &value
		}
	}
	return view
}

// The same fact from the other side of the door: the type that can reach
// ciphertext is the type an HTTP handler cannot reach, and the resolver is only
// constructible from it in-process.
var _ secrets.VersionSource = (*SecretStore)(nil)
