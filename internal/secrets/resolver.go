package secrets

import (
	"context"
	"errors"
	"fmt"
	"slices"
)

// Delivery modes, from api/openapi.yaml's SecretDeliveryMode. integration_broker
// is declared and unimplemented (ADR-0018 clause 8): a unit configured for it
// fails with ErrDeliveryUnsupported rather than degrading to env.
const (
	DeliveryEnv           = "env"
	DeliveryEnvFile       = "env_file"
	DeliveryBrokerLiteral = "integration_broker"
)

// Scopes, from migration 00004.
const (
	ScopeProject = "project"
	ScopeOrg     = "org"
)

// StoredVersion is what a resolver needs about one secret_versions row: the
// ciphertext, and the metadata that decides whether to open it. It is the
// boundary between "reading the database" and "having a secret": every field
// except Sealed is a column an operator could see in a dump, and Sealed is
// unreadable without the keyring.
type StoredVersion struct {
	Ref VersionRef

	OrganizationID string
	ProjectID      string // empty for an org-scope secret
	Scope          string
	Slug           string
	DeliveryMode   string

	CurrentVersion int
	SecretRevoked  bool

	Version        int
	VersionRevoked bool

	AllowedAgentProfileIDs []string
	AllowedNodeTemplateIDs []string

	Sealed Sealed
}

// VersionSource reads one pinned version, ciphertext included.
//
// Every implementation of this interface lives in the same process as the
// Resolver: the postgres store for serve, the worker's scoped read of the same
// tables. That placement is the point — internal/api has no path to it, which is
// how "no GET /values/{secretId} exists anywhere in the surface, so the question
// 'did this endpoint leak' cannot arise" (ADR-0018 D3) is a fact about types
// rather than about discipline.
type VersionSource interface {
	LoadVersion(ctx context.Context, secretID string, version int) (StoredVersion, error)
}

// Attempt is the unit asking for a value: one turn (M3) or one node attempt
// (M4+) running one agent profile in one workspace.
type Attempt struct {
	ProjectID      string
	OrganizationID string
	AgentProfileID string

	// NodeTemplateID is empty for M3's turn-shaped attempts and non-empty from
	// M4 on. The node-template axis of the allowlist is only evaluated when the
	// attempt names a template — see Resolve for why.
	NodeTemplateID string

	// WorkspaceID and TurnID travel with the attempt for the materialization
	// record; they authorize nothing.
	WorkspaceID string
	TurnID      string
	WorkerID    string

	// Authorized is the caller's assertion that the *role* question was already
	// answered, by authz/internal against the caller's membership. The Resolver
	// deliberately does not re-derive roles — it enforces the axes a role cannot
	// express (which profiles may hold which secret). A zero Attempt therefore
	// resolves nothing: forgetting to set Authorized is a refusal, not a hole.
	Authorized bool
}

// Resolution is the answer to a successful Resolve. Value is the only field
// holding material; everything else is what the caller records in the
// secret.materialized event and in secret_materializations (00004).
type Resolution struct {
	Value *Value

	// Pin is where to mount: the mount row's relative path and env name, so a
	// caller that resolved from a mount has the mount in hand. Empty when the
	// caller resolved a secret directly.
	RepositoryID string
	RelativePath string
	EnvName      string
	Key          string
	Lifecycle    string

	OrganizationID string
	ProjectID      string
	SecretID       string
	Slug           string
	// Version is the version actually opened, which is the pinned version or
	// the metadata's current_version when the caller pinned none.
	Version       int
	DeliveryMode  string
	ContentSHA256 string
}

// Resolver is the only path from a database row to a plaintext inside a
// process. Construction requires both a VersionSource and a KeyProvider: a
// Resolver that can read the database but not the keyring, or the reverse, is
// useless by construction (ADR-0018 D2.5).
type Resolver struct {
	source VersionSource
	keys   KeyProvider
}

// NewResolver wires the two halves. A nil half is a programming error and is
// returned as one rather than as an empty Resolver that would fail closed on
// every call and hide the bug.
func NewResolver(source VersionSource, keys KeyProvider) (*Resolver, error) {
	switch {
	case source == nil:
		return nil, errors.New("secrets: resolver needs a version source")
	case keys == nil:
		return nil, errors.New("secrets: resolver needs a key provider")
	}
	return &Resolver{source: source, keys: keys}, nil
}

// Resolve returns the plaintext for one secret version to this process and to
// nobody else.
//
// The order of checks is the security design, not an optimization: authorization
// before decryption, so a caller who is not allowed to know a version exists is
// refused without touching key material; revocation before delivery mode, so a
// revoked integration secret reports being revoked; and derivation last, because
// ErrUnknownKeyID is the only failure that proves the row outlived its key.
func (r *Resolver) Resolve(ctx context.Context, a Attempt, secretID string, version int) (*Resolution, error) {
	if !a.Authorized {
		return nil, fmt.Errorf("%w: the caller did not assert authorization", ErrNotAuthorized)
	}
	if secretID == "" {
		return nil, ErrNotAuthorized
	}
	stored, err := r.source.LoadVersion(ctx, secretID, version)
	if err != nil {
		return nil, err
	}
	if stored.Ref.SecretID != secretID {
		return nil, fmt.Errorf("secrets: source returned %s for a request about %s", stored.Ref.SecretID, secretID)
	}
	if stored.Version == 0 {
		stored.Version = stored.CurrentVersion
	}
	if version > 0 && stored.Version != version {
		return nil, fmt.Errorf("secrets: source returned v%d for a pin on v%d", stored.Version, version)
	}
	// VersionRef is rebuilt from what the source reported rather than trusted
	// from it: the AAD binding has to come from the row identity the decrypt is
	// actually being attempted under.
	ref := VersionRef{SecretID: stored.Ref.SecretID, Version: stored.Version, Slug: stored.Slug}
	if err := ref.Validate(); err != nil {
		return nil, fmt.Errorf("%w: %v", ErrNotAuthorized, err)
	}

	if stored.SecretRevoked || stored.VersionRevoked {
		return nil, fmt.Errorf("%w: %s v%d", ErrRevoked, ref.SecretID, ref.Version)
	}

	switch stored.DeliveryMode {
	case DeliveryEnv, DeliveryEnvFile:
	case DeliveryBrokerLiteral:
		return nil, fmt.Errorf("%w: %s on %s", ErrDeliveryUnsupported, stored.DeliveryMode, ref.SecretID)
	default:
		return nil, fmt.Errorf("%w: unknown delivery mode %q", ErrDeliveryUnsupported, stored.DeliveryMode)
	}

	if err := authorizeAgainst(a, stored); err != nil {
		return nil, err
	}

	value, err := Open(ctx, r.keys, ref, stored.Sealed)
	if err != nil {
		return nil, err
	}
	return &Resolution{
		Value:          value,
		OrganizationID: stored.OrganizationID,
		ProjectID:      stored.ProjectID,
		SecretID:       ref.SecretID,
		Slug:           ref.Slug,
		Version:        ref.Version,
		DeliveryMode:   stored.DeliveryMode,
		ContentSHA256:  stored.Sealed.ContentSHA256,
	}, nil
}

// authorizeAgainst enforces ADR-0018 D3's axes. Scope decides *whose* project the
// secret belongs to; the allowlists decide *which profile* may hold it; both are
// allowlists, so an empty list denies rather than permits.
func authorizeAgainst(a Attempt, stored StoredVersion) error {
	switch stored.Scope {
	case ScopeProject:
		if stored.ProjectID == "" || a.ProjectID == "" || stored.ProjectID != a.ProjectID {
			return fmt.Errorf("%w: project-scope secret %s does not belong to project %q", ErrNotAuthorized, stored.Ref.SecretID, a.ProjectID)
		}
		if stored.OrganizationID != "" && a.OrganizationID != "" && stored.OrganizationID != a.OrganizationID {
			return fmt.Errorf("%w: project %s is not in the secret's organization", ErrNotAuthorized, a.ProjectID)
		}
	case ScopeOrg:
		if stored.ProjectID != "" {
			return fmt.Errorf("%w: org-scope secret %s carries a project id", ErrNotAuthorized, stored.Ref.SecretID)
		}
		if a.OrganizationID == "" || stored.OrganizationID != a.OrganizationID {
			return fmt.Errorf("%w: org-scope secret %s is not in this organization", ErrNotAuthorized, stored.Ref.SecretID)
		}
	default:
		return fmt.Errorf("%w: unknown scope %q", ErrNotAuthorized, stored.Scope)
	}

	if len(stored.AllowedAgentProfileIDs) == 0 {
		return fmt.Errorf("%w: secret %s grants no agent profile", ErrNotAuthorized, stored.Ref.SecretID)
	}
	if a.AgentProfileID == "" || !slices.Contains(stored.AllowedAgentProfileIDs, a.AgentProfileID) {
		return fmt.Errorf("%w: profile %q is not on secret %s's allowlist", ErrNotAuthorized, a.AgentProfileID, stored.Ref.SecretID)
	}

	// The node-template axis is evaluated only when the attempt names a
	// template. ADR-0018 D3 says empty means denied-to-all, which is what this
	// enforces for M4 — but M3's units are turns with no template at all, and
	// denying them would make every secret unmaterializable in the milestone
	// that introduced materialization. An attempt that names a template and is
	// not on the list is refused outright.
	if a.NodeTemplateID != "" {
		if len(stored.AllowedNodeTemplateIDs) == 0 || !slices.Contains(stored.AllowedNodeTemplateIDs, a.NodeTemplateID) {
			return fmt.Errorf("%w: node template %q is not on secret %s's allowlist", ErrNotAuthorized, a.NodeTemplateID, stored.Ref.SecretID)
		}
	}
	return nil
}

// Mount narrows a Resolution with the mount row that asked for it, so the
// materializer receives one struct carrying pin, path and value rather than
// having to join them itself.
func (res *Resolution) Mount(repositoryID, relativePath, envName, key, lifecycle string) {
	if res == nil {
		return
	}
	res.RepositoryID = repositoryID
	res.RelativePath = relativePath
	res.EnvName = envName
	res.Key = key
	res.Lifecycle = lifecycle
}
