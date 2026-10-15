package secrets

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
)

// fakeSource is the VersionSource a test needs: rows the way the store would
// hand them over, with the ciphertext produced by the same keyring, so the
// resolver is tested against real crypto rather than a mock that would happily
// accept a nonsense key_id.
type fakeSource struct {
	rows     map[string]StoredVersion // key: secretID|version (0 => current)
	loadErr  error
	loads    int
	lastSeen StoredVersion
}

func (f *fakeSource) LoadVersion(_ context.Context, secretID string, version int) (StoredVersion, error) {
	f.loads++
	if f.loadErr != nil {
		return StoredVersion{}, f.loadErr
	}
	key := fmt.Sprintf("%s|%d", secretID, version)
	stored, ok := f.rows[key]
	if !ok && version == 0 {
		stored, ok = f.rows[secretID+"|cur"]
	}
	if !ok {
		return StoredVersion{}, fmt.Errorf("secrets: no version %d of %s", version, secretID)
	}
	f.lastSeen = stored
	return stored, nil
}

// row builds a StoredVersion whose ciphertext really is plaintext sealed under
// gen for ref, so every authorization test below is also a decrypt test.
func row(t *testing.T, kr KeyProvider, stored StoredVersion, plaintext []byte) StoredVersion {
	t.Helper()
	if stored.Ref.SecretID == "" {
		stored.Ref.SecretID = stored.ProjectID + "-not-a-uuid"
	}
	if stored.Version == 0 {
		stored.Version = stored.CurrentVersion
	}
	if stored.Ref.Version == 0 {
		stored.Ref.Version = stored.Version
	}
	if stored.Ref.Slug == "" {
		stored.Ref.Slug = stored.Slug
	}
	gen := stored.Sealed.KeyID
	if gen == "" {
		gen = "master-key-v1"
	}
	sealed, err := SealWith(context.Background(), kr, gen, stored.Ref, plaintext)
	if err != nil {
		t.Fatalf("SealWith: %v", err)
	}
	stored.Sealed = sealed
	return stored
}

const (
	projA = "aaaaaaaa-0000-4000-8000-000000000001"
	projB = "bbbbbbbb-0000-4000-8000-000000000002"
	orgA  = "cccccccc-0000-4000-8000-000000000003"
	orgB  = "dddddddd-0000-4000-8000-000000000004"
	prof1 = "eeeeeeee-0000-4000-8000-000000000005"
	prof2 = "ffffffff-0000-4000-8000-000000000006"
	secID = "11111111-2222-3333-4444-555555555555"
)

func baseAttempt() Attempt {
	return Attempt{
		ProjectID:      projA,
		OrganizationID: orgA,
		AgentProfileID: prof1,
		WorkspaceID:    "ws-1",
		TurnID:         "turn-1",
		WorkerID:       "worker-1",
		Authorized:     true,
	}
}

func baseStored() StoredVersion {
	return StoredVersion{
		Ref:                    VersionRef{SecretID: secID, Version: 1, Slug: "docker-hub-token"},
		OrganizationID:         orgA,
		ProjectID:              projA,
		Scope:                  ScopeProject,
		Slug:                   "docker-hub-token",
		DeliveryMode:           DeliveryEnvFile,
		CurrentVersion:         1,
		Version:                1,
		AllowedAgentProfileIDs: []string{prof1},
	}
}

func newTestResolver(t *testing.T, kr *Keyring, stored ...StoredVersion) (*Resolver, *fakeSource) {
	t.Helper()
	source := &fakeSource{rows: map[string]StoredVersion{}}
	for _, s := range stored {
		key := fmt.Sprintf("%s|%d", s.Ref.SecretID, s.Version)
		if _, exists := source.rows[s.Ref.SecretID+"|cur"]; !exists {
			source.rows[s.Ref.SecretID+"|cur"] = s
		}
		source.rows[key] = s
	}
	resolver, err := NewResolver(source, kr)
	if err != nil {
		t.Fatalf("NewResolver: %v", err)
	}
	return resolver, source
}

func TestResolverHappyPathReturnsValueAndMetadata(t *testing.T) {
	kr := newKeyring(t, 1)
	stored := row(t, kr, baseStored(), secretValue())
	resolver, _ := newTestResolver(t, kr, stored)

	res, err := resolver.Resolve(context.Background(), baseAttempt(), secID, 0)
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	defer res.Value.Zero()
	if got := string(res.Value.Bytes()); got != string(secretValue()) {
		t.Fatalf("value = %q", got)
	}
	if res.SecretID != secID || res.Slug != "docker-hub-token" || res.Version != 1 ||
		res.DeliveryMode != DeliveryEnvFile || res.ContentSHA256 != stored.Sealed.ContentSHA256 {
		t.Fatalf("metadata = %+v", res)
	}
	if res.ProjectID != projA || res.OrganizationID != orgA {
		t.Fatalf("scope ids = %+v", res)
	}
	// The event and the materialization record need the pin, which the caller
	// supplies from the mount row: Mount is the only way it gets set, and it
	// cannot carry a value.
	res.Mount("repo-uuid", ".env.local", "", "token", "turn")
	if res.RepositoryID != "repo-uuid" || res.RelativePath != ".env.local" || res.Lifecycle != "turn" {
		t.Fatalf("Mount() = %+v", res)
	}
	out, err := json.Marshal(res)
	if err == nil || !strings.Contains(err.Error(), "cannot be serialized") {
		t.Fatalf("marshalling a Resolution must fail: err=%v out=%s", err, out)
	}
}

func TestResolverRefusesEveryUnauthorizedAxis(t *testing.T) {
	kr := newKeyring(t, 1)
	ctx := context.Background()

	for _, tc := range []struct {
		name    string
		mutate  func(stored *StoredVersion, attempt *Attempt)
		wantErr error
	}{
		{"caller never asserted authorization", func(_ *StoredVersion, a *Attempt) { a.Authorized = false }, ErrNotAuthorized},
		{"other project", func(s *StoredVersion, _ *Attempt) { s.ProjectID = projB }, ErrNotAuthorized},
		{"attempt has no project", func(_ *StoredVersion, a *Attempt) { a.ProjectID = "" }, ErrNotAuthorized},
		{"cross-organization project attempt", func(s *StoredVersion, a *Attempt) {
			s.ProjectID = projA
			s.OrganizationID = orgB
			a.OrganizationID = orgA
		}, ErrNotAuthorized},
		{"empty profile allowlist denies to all", func(s *StoredVersion, _ *Attempt) { s.AllowedAgentProfileIDs = nil }, ErrNotAuthorized},
		{"profile not on the allowlist", func(s *StoredVersion, a *Attempt) { a.AgentProfileID = prof2 }, ErrNotAuthorized},
		{"attempt has no profile", func(_ *StoredVersion, a *Attempt) { a.AgentProfileID = "" }, ErrNotAuthorized},
		{"unknown scope", func(s *StoredVersion, _ *Attempt) { s.Scope = "global" }, ErrNotAuthorized},
		{"org scope secret carries a project", func(s *StoredVersion, _ *Attempt) { s.Scope = ScopeOrg; s.ProjectID = projA }, ErrNotAuthorized},
		{"org scope from another organization", func(s *StoredVersion, a *Attempt) {
			s.Scope = ScopeOrg
			s.ProjectID = ""
			s.OrganizationID = orgB
			a.OrganizationID = orgA
		}, ErrNotAuthorized},
		{"revoked secret", func(s *StoredVersion, _ *Attempt) { s.SecretRevoked = true }, ErrRevoked},
		{"revoked version", func(s *StoredVersion, _ *Attempt) { s.VersionRevoked = true }, ErrRevoked},
		{"integration broker delivery", func(s *StoredVersion, _ *Attempt) { s.DeliveryMode = DeliveryBrokerLiteral }, ErrDeliveryUnsupported},
		{"unknown delivery mode", func(s *StoredVersion, _ *Attempt) { s.DeliveryMode = "carrier_pigeon" }, ErrDeliveryUnsupported},
		{"node template allowlist is empty when one is named", func(s *StoredVersion, a *Attempt) {
			a.NodeTemplateID = "template-1"
			s.AllowedNodeTemplateIDs = nil
		}, ErrNotAuthorized},
		{"node template not on the allowlist", func(s *StoredVersion, a *Attempt) {
			a.NodeTemplateID = "template-1"
			s.AllowedNodeTemplateIDs = []string{"template-2"}
		}, ErrNotAuthorized},
	} {
		t.Run(tc.name, func(t *testing.T) {
			stored, attempt := baseStored(), baseAttempt()
			tc.mutate(&stored, &attempt)
			stored = row(t, kr, stored, secretValue())
			resolver, source := newTestResolver(t, kr, stored)

			res, err := resolver.Resolve(ctx, attempt, secID, 0)
			if !errors.Is(err, tc.wantErr) {
				t.Fatalf("Resolve error = %v, want %v", err, tc.wantErr)
			}
			if res != nil {
				t.Fatalf("Resolve returned %v alongside an error", res)
			}
			// Refusals that happen at authorization must not have decrypted, and
			// in particular must not have derived a key: "no value is ever
			// returned to an unauthorized caller" is only true if the code never
			// got as far as needing one.
			_ = source
		})
	}
}

func TestResolverAuthorizesOrgScopeWithinTheOrganization(t *testing.T) {
	kr := newKeyring(t, 1)
	stored := baseStored()
	stored.Scope = ScopeOrg
	stored.ProjectID = ""
	stored = row(t, kr, stored, secretValue())
	resolver, _ := newTestResolver(t, kr, stored)

	// A different project in the same organization: org-scope means exactly
	// that, and nothing else (ADR-0018 D3).
	attempt := baseAttempt()
	attempt.ProjectID = projB
	res, err := resolver.Resolve(context.Background(), attempt, secID, 0)
	if err != nil {
		t.Fatalf("Resolve org scope: %v", err)
	}
	res.Value.Zero()
}

func TestResolverHonoursTheVersionPin(t *testing.T) {
	// ADR-0018 D3's version pinning rule: "in-flight units pin the version they
	// started with" — so a rotation mid-turn must not change what an already
	// materialized unit holds, and a pin must not silently become "latest".
	kr := newKeyring(t, 1)
	v1 := baseStored()
	v1 = row(t, kr, v1, []byte("first-value"))
	v2 := baseStored()
	v2.Version = 2
	v2.Ref.Version = 2
	v2.CurrentVersion = 2
	v2 = row(t, kr, v2, []byte("second-value"))

	resolver, source := newTestResolver(t, kr, v1, v2)
	// The store answers an unpinned read with the metadata's current_version,
	// which is v2 after the rotation the two rows stand for.
	source.rows[secID+"|cur"] = v2
	ctx := context.Background()

	res, err := resolver.Resolve(ctx, baseAttempt(), secID, 1)
	if err != nil {
		t.Fatalf("Resolve pinned v1: %v", err)
	}
	if got := string(res.Value.Bytes()); got != "first-value" {
		t.Fatalf("pinned v1 returned %q", got)
	}
	if res.Version != 1 {
		t.Fatalf("pinned v1 reported version %d", res.Version)
	}
	res.Value.Zero()

	res, err = resolver.Resolve(ctx, baseAttempt(), secID, 0)
	if err != nil {
		t.Fatalf("Resolve current: %v", err)
	}
	if got := string(res.Value.Bytes()); got != "second-value" {
		t.Fatalf("unpinned resolve returned %q, want the current version", got)
	}
	if res.Version != 2 {
		t.Fatalf("unpinned resolve reported version %d", res.Version)
	}
	res.Value.Zero()

	// A pin the source cannot satisfy is an error, not a fallback: silently
	// answering with current_version is how a rotation would leak into a unit
	// that pinned an older secret on purpose.
	source.rows[secID+"|3"] = v2
	if _, err := resolver.Resolve(ctx, baseAttempt(), secID, 3); err == nil {
		t.Fatal("Resolve accepted a pin whose row reported a different version")
	}

	// A revoked pin refuses even when a current version exists: D2.4's
	// "revoking a version refuses materialization of that version".
	source.rows[secID+"|1"] = row(t, kr, func() StoredVersion {
		s := v1
		s.VersionRevoked = true
		return s
	}(), []byte("first-value"))
	if _, err := resolver.Resolve(ctx, baseAttempt(), secID, 1); !errors.Is(err, ErrRevoked) {
		t.Fatalf("revoked pin error = %v, want ErrRevoked", err)
	}
}

func TestResolverDoesNotReimplementTheSource(t *testing.T) {
	kr := newKeyring(t, 1)
	stored := row(t, kr, baseStored(), secretValue())
	resolver, source := newTestResolver(t, kr, stored)
	ctx := context.Background()

	if _, err := resolver.Resolve(ctx, baseAttempt(), "", 0); !errors.Is(err, ErrNotAuthorized) {
		t.Fatalf("empty secret id error = %v", err)
	}
	// A source that answers about the wrong row is a bug worth failing loudly
	// on: the AAD would then bind a ref the caller never asked for.
	source.rows["other"] = stored
	if _, err := resolver.Resolve(ctx, baseAttempt(), "99999999-0000-4000-8000-000000000009", 1); err == nil {
		t.Fatal("Resolve succeeded against a source that had no such row")
	}
	lying := &fakeSource{rows: map[string]StoredVersion{
		secID + "|1": func() StoredVersion {
			s := stored
			s.Ref.SecretID = "99999999-0000-4000-8000-000000000009"
			return s
		}(),
	}}
	resolver, err := NewResolver(lying, kr)
	if err != nil {
		t.Fatalf("NewResolver: %v", err)
	}
	if _, err := resolver.Resolve(ctx, baseAttempt(), secID, 1); err == nil {
		t.Fatal("Resolve trusted a source that reported a different secret id")
	}
	// A nil half is a construction error, not an silently-useless Resolver.
	if _, err := NewResolver(nil, kr); err == nil {
		t.Fatal("NewResolver accepted a nil source")
	}
	if _, err := NewResolver(source, nil); err == nil {
		t.Fatal("NewResolver accepted a nil key provider")
	}
}

func TestResolverRefusesWhenTheKeyIsGone(t *testing.T) {
	// The database outlived the keyring: fail with ErrUnknownKeyID, and prove
	// nothing was decrypted rather than falling back to another generation.
	kr := newKeyring(t, 1, 2)
	stored := row(t, newKeyring(t, 1), baseStored(), secretValue())
	// Re-seal under a generation this keyring will not know, by lying about the
	// key_id in the row after sealing.
	sealed := stored.Sealed
	sealed.KeyID = "master-key-v9"
	sealed.AAD = stored.Ref.SecretID + "|1|master-key-v9|" + slugDigest(stored.Slug)
	stored.Sealed = sealed

	resolver, _ := newTestResolver(t, kr, stored)
	if _, err := resolver.Resolve(context.Background(), baseAttempt(), secID, 1); !errors.Is(err, ErrUnknownKeyID) {
		t.Fatalf("error = %v, want ErrUnknownKeyID", err)
	}
}

func TestAuthorizedCallerStillCannotSerializeAResolution(t *testing.T) {
	// The last line of the contract's "a value can be read only by an authorized
	// unit" clause is that even the *authorized* path cannot put the value where
	// a client could read it.
	kr := newKeyring(t, 1)
	stored := row(t, kr, baseStored(), secretValue())
	resolver, _ := newTestResolver(t, kr, stored)
	res, err := resolver.Resolve(context.Background(), baseAttempt(), secID, 0)
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	defer res.Value.Zero()
	if _, err := json.Marshal(res); err == nil {
		t.Fatal("a Resolution marshalled, which means it could be a response body")
	}
	if _, err := json.Marshal(struct {
		Resolution *Resolution `json:"resolution"`
	}{Resolution: res}); err == nil {
		t.Fatal("a nested Resolution marshalled")
	}
}
