package secrets

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

// ADR-0061: the broker resolve path. integration_broker is the one delivery
// mode that ResolveForIntegration opens and Resolve refuses, and the inverse
// is equally load-bearing: an env secret must not be usable as a platform
// credential through this back door. The authorization is the repository
// row's scope axis — never an agent-profile allowlist.

func brokerStored() StoredVersion {
	s := baseStored()
	s.DeliveryMode = DeliveryBrokerLiteral
	s.Slug = "github-repo-token"
	s.Ref.Slug = "github-repo-token"
	// A broker secret granted to no profile by construction: the allowlist
	// axis the mount path lives on is empty here, and it must stay irrelevant.
	s.AllowedAgentProfileIDs = nil
	return s
}

func repoRequest() IntegrationRequest {
	return IntegrationRequest{
		RepositoryID:   "12121212-3434-5656-7878-9a9a9a9a9a9a",
		RepositoryName: "private-stuff",
		ProjectID:      projA,
		OrganizationID: orgA,
		Consumer:       ConsumerRepoMirror,
	}
}

func TestResolveForIntegrationOpensCurrentBrokerVersion(t *testing.T) {
	kr := newKeyring(t, 1)
	stored := row(t, kr, brokerStored(), []byte("ghp_broker_material"))
	resolver, source := newTestResolver(t, kr, stored)

	res, err := resolver.ResolveForIntegration(context.Background(), repoRequest(), secID)
	if err != nil {
		t.Fatalf("ResolveForIntegration: %v", err)
	}
	defer res.Value.Zero()
	if got := string(res.Value.Bytes()); got != "ghp_broker_material" {
		t.Fatalf("value = %q", got)
	}
	if res.Version != stored.CurrentVersion || res.DeliveryMode != DeliveryBrokerLiteral {
		t.Errorf("resolution = v%d/%s, want the current broker version", res.Version, res.DeliveryMode)
	}
	if source.loads != 1 {
		t.Errorf("loads = %d, want one current-version read", source.loads)
	}
	// A Resolution is still unserializable: the audit row names metadata, and
	// nothing that could carry this value can be marshalled by accident.
	if out, err := json.Marshal(res); err == nil ||
		!strings.Contains(err.Error(), "cannot be serialized") {
		t.Fatalf("marshalling a broker Resolution must fail: err=%v out=%s", err, out)
	}
}

func TestResolveForIntegrationRefusesNonBrokerModes(t *testing.T) {
	kr := newKeyring(t, 1)
	env := baseStored() // delivery_mode env, profile-allowlisted
	stored := row(t, kr, env, []byte("mount-deliverable"))
	resolver, _ := newTestResolver(t, kr, stored)

	_, err := resolver.ResolveForIntegration(context.Background(), repoRequest(), secID)
	if !errors.Is(err, ErrDeliveryUnsupported) {
		t.Fatalf("ResolveForIntegration of an env secret = %v, want ErrDeliveryUnsupported", err)
	}
	// And the mount path refuses the broker secret the other way: the two
	// paths are exact complements, no secret is deliverable on both.
	broker := row(t, kr, brokerStored(), []byte("ghp_broker_material"))
	resolver2, _ := newTestResolver(t, kr, broker)
	if _, err := resolver2.Resolve(context.Background(), baseAttempt(), secID, 0); !errors.Is(err, ErrDeliveryUnsupported) {
		t.Fatalf("Resolve of a broker secret = %v, want ErrDeliveryUnsupported (mount path unchanged)", err)
	}
}

func TestResolveForIntegrationScopeAxes(t *testing.T) {
	kr := newKeyring(t, 1)

	// A project-scope broker secret of another project is refused even when
	// the caller can name it: the repository reference grants nothing across
	// projects (the store write cannot plant one either; migration 00016).
	other := brokerStored()
	other.ProjectID = projB
	resolver, _ := newTestResolver(t, kr, row(t, kr, other, []byte("nope")))
	if _, err := resolver.ResolveForIntegration(context.Background(), repoRequest(), secID); !errors.Is(err, ErrNotAuthorized) {
		t.Fatalf("cross-project broker resolve = %v, want ErrNotAuthorized", err)
	}

	// An org-scope broker secret serves any project of its organization and
	// no other.
	org := brokerStored()
	org.Scope = ScopeOrg
	org.ProjectID = ""
	resolver, _ = newTestResolver(t, kr, row(t, kr, org, []byte("org-broker")))
	if _, err := resolver.ResolveForIntegration(context.Background(), repoRequest(), secID); err != nil {
		t.Fatalf("org-scope broker resolve inside the org: %v", err)
	}
	req := repoRequest()
	req.OrganizationID = orgB
	if _, err := resolver.ResolveForIntegration(context.Background(), req, secID); !errors.Is(err, ErrNotAuthorized) {
		t.Fatalf("org-scope broker resolve across organizations = %v, want ErrNotAuthorized", err)
	}
}

func TestResolveForIntegrationRevocationAndRequestShape(t *testing.T) {
	kr := newKeyring(t, 1)
	revoked := brokerStored()
	revoked.SecretRevoked = true
	resolver, _ := newTestResolver(t, kr, row(t, kr, revoked, []byte("dead")))
	if _, err := resolver.ResolveForIntegration(context.Background(), repoRequest(), secID); !errors.Is(err, ErrRevoked) {
		t.Fatalf("revoked broker resolve = %v, want ErrRevoked", err)
	}

	fresh := row(t, kr, brokerStored(), []byte("ghp_broker_material"))
	resolver, _ = newTestResolver(t, kr, fresh)
	for _, tc := range []struct {
		name   string
		mutate func(*IntegrationRequest)
	}{
		{"unknown consumer", func(a *IntegrationRequest) { a.Consumer = "ci_upload" }},
		{"empty repository id", func(a *IntegrationRequest) { a.RepositoryID = "" }},
		{"non-uuid repository id", func(a *IntegrationRequest) { a.RepositoryID = "private-stuff" }},
		{"no project", func(a *IntegrationRequest) { a.ProjectID = "" }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			req := repoRequest()
			tc.mutate(&req)
			if _, err := resolver.ResolveForIntegration(context.Background(), req, secID); !errors.Is(err, ErrNotAuthorized) {
				t.Errorf("err = %v, want ErrNotAuthorized", err)
			}
		})
	}
	// A secret id that is not a uuid cannot even reach the source.
	if _, err := resolver.ResolveForIntegration(context.Background(), repoRequest(), "not-a-uuid"); !errors.Is(err, ErrNotAuthorized) {
		t.Errorf("non-uuid secret id = %v, want ErrNotAuthorized", err)
	}
}

// TestMountResolveSemanticsUnchanged pins the clause the ADR keeps: a broker
// secret is denied to every AGENT path (the allowlist is empty AND the
// delivery mode refuses), so ADR-0018 clause 8 stays true for agents even
// after ADR-0061 built the integration path.
func TestMountResolveSemanticsUnchanged(t *testing.T) {
	kr := newKeyring(t, 1)
	stored := row(t, kr, brokerStored(), []byte("ghp_broker_material"))
	resolver, _ := newTestResolver(t, kr, stored)
	// An attempt that names the profile the secret WOULD grant if it granted
	// anything: the delivery-mode refusal must come first regardless.
	a := baseAttempt()
	broker := brokerStored()
	broker.AllowedAgentProfileIDs = []string{prof1}
	resolver2, _ := newTestResolver(t, kr, row(t, kr, broker, []byte("ghp_broker_material")))
	if _, err := resolver2.Resolve(context.Background(), a, secID, 0); !errors.Is(err, ErrDeliveryUnsupported) {
		t.Fatalf("agent Resolve of an allowlisted broker secret = %v, want ErrDeliveryUnsupported", err)
	}
	if _, err := resolver.Resolve(context.Background(), baseAttempt(), secID, 0); !errors.Is(err, ErrDeliveryUnsupported) {
		t.Fatalf("agent Resolve = %v, want ErrDeliveryUnsupported", err)
	}
}
