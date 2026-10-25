package worker

// Internal (same-package) test of the ADR-0061 resolve wiring: mirrorSpec is
// the exact decision point between "credential" and "environment", and the
// sandbox-fixture suite that covers it end to end needs the nono binary.
// These assertions must run everywhere.

import (
	"context"
	"errors"
	"strings"
	"testing"
)

type stubResolver struct {
	calls     []string
	workerIDs []string
	token     string
	err       error
}

func (s *stubResolver) ResolveMirrorCredential(_ context.Context, repositoryID, workerID string) (string, error) {
	s.calls = append(s.calls, repositoryID)
	s.workerIDs = append(s.workerIDs, workerID)
	if s.err != nil {
		return "", s.err
	}
	return s.token, nil
}

func TestMirrorSpecAnonymousWithoutCredential(t *testing.T) {
	res := &stubResolver{token: "never"}
	svc := &UnitService{MirrorCredentials: res}
	spec, err := svc.mirrorSpec(context.Background(),
		ProjectRepo{ID: "repo-1", Name: "backend", GitURL: "https://github.com/octo/b.git", DefaultBranch: "main"},
		"worker-1")
	if err != nil {
		t.Fatalf("mirrorSpec: %v", err)
	}
	if spec.Token != "" || spec.Name != "backend" || spec.RepositoryID != "repo-1" || spec.DefaultBranch != "main" {
		t.Errorf("spec = %+v, want the plain anonymous spec", spec)
	}
	if len(res.calls) != 0 {
		t.Errorf("resolve calls = %v, want none", res.calls)
	}
}

func TestMirrorSpecCarriesTheResolvedToken(t *testing.T) {
	res := &stubResolver{token: "ghp_wired_value"}
	svc := &UnitService{MirrorCredentials: res}
	repo := ProjectRepo{ID: "repo-1", Name: "backend", GitURL: "https://github.com/octo/b.git",
		DefaultBranch: "main", CredentialSecretID: "secret-1"}
	spec, err := svc.mirrorSpec(context.Background(), repo, "worker-9")
	if err != nil {
		t.Fatalf("mirrorSpec: %v", err)
	}
	if spec.Token != "ghp_wired_value" {
		t.Errorf("spec.Token = %q, want the resolved token", spec.Token)
	}
	if len(res.calls) != 1 || res.calls[0] != "repo-1" || res.workerIDs[0] != "worker-9" {
		t.Errorf("resolve calls = %v workers = %v, want repo-1 audited as worker-9", res.calls, res.workerIDs)
	}
}

func TestMirrorSpecFailsClosed(t *testing.T) {
	repo := ProjectRepo{ID: "repo-1", Name: "private-stuff", GitURL: "https://github.com/octo/p.git",
		DefaultBranch: "main", CredentialSecretID: "secret-1"}

	// Refused resolve.
	svc := &UnitService{MirrorCredentials: &stubResolver{err: errors.New("secret is revoked")}}
	_, err := svc.mirrorSpec(context.Background(), repo, "w")
	if !errors.Is(err, ErrMirrorCredential) || !strings.Contains(err.Error(), "private-stuff") {
		t.Fatalf("refused resolve: err = %v, want ErrMirrorCredential naming private-stuff", err)
	}

	// No seam wired at all: an anonymous clone of a credentialed repository
	// is the silent fallback the ADR forbids.
	_, err = (&UnitService{}).mirrorSpec(context.Background(), repo, "w")
	if !errors.Is(err, ErrMirrorCredential) || !strings.Contains(err.Error(), "resolver") {
		t.Fatalf("unwired seam: err = %v, want a typed refusal naming the resolver", err)
	}
}
