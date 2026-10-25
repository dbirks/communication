package worker_test

// ADR-0061: the mirror clone/fetch carries the repository's GitHub credential
// through the unit's prepare. These tests drive the real workspace manager on
// a real git binary (the fixture's), with the Runner's Spawn seam recording
// every command — so the assertion is about the ACTUAL child environment of
// the clone, not about a field someone hopes is read.

import (
	"context"
	"errors"
	"os/exec"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/dbirks/communication/internal/worker"
	wsgit "github.com/dbirks/communication/internal/workspace/git"
)

// mirrorCredStub is the fake ADR-0061 resolve seam.
type mirrorCredStub struct {
	mu        sync.Mutex
	calls     []string // repository ids, in order
	workerIDs []string
	token     string
	err       error
}

func (s *mirrorCredStub) ResolveMirrorCredential(ctx context.Context, repositoryID, workerID string) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.calls = append(s.calls, repositoryID)
	s.workerIDs = append(s.workerIDs, workerID)
	if s.err != nil {
		return "", s.err
	}
	return s.token, nil
}

// recordingGit runs the real command and records what it was asked to run.
type recordingGit struct {
	mu   sync.Mutex
	cmds []wsgit.Command
}

func (r *recordingGit) spawn(ctx context.Context, c wsgit.Command) (wsgit.Result, error) {
	r.mu.Lock()
	r.cmds = append(r.cmds, c)
	r.mu.Unlock()
	cctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	cmd := exec.CommandContext(cctx, c.Path, c.Argv...)
	cmd.Dir = c.Dir
	cmd.Env = c.Env
	var stdout, stderr strings.Builder
	err := cmd.Run()
	out := wsgit.Result{Stdout: stdout.String(), Stderr: stderr.String()}
	if err != nil {
		return out, err
	}
	return out, nil
}

// TestUnitPreparePassesMirrorCredentialToken: the repository names a
// credential, the seam resolves it, and the mirror's `clone --mirror` runs
// with the token in its ENVIRONMENT and nowhere in argv.
func TestUnitPreparePassesMirrorCredentialToken(t *testing.T) {
	fx := newUnitFixture(t)
	rec := &recordingGit{}
	fx.svc.Workspaces.Git.Spawn = rec.spawn

	const token = "ghp_unit_test_credential" // fixture material, not a real token
	creds := &mirrorCredStub{token: token}
	fx.svc.MirrorCredentials = creds

	req := fx.request()
	req.Repos[0].CredentialSecretID = uuidFor("cred") // the row's secret id; the seam ignores its value
	if _, err := fx.svc.Prepare(context.Background(), req); err != nil {
		t.Fatalf("prepare: %v", err)
	}

	repoID := req.Repos[0].ID
	if len(creds.calls) != 1 || creds.calls[0] != repoID {
		t.Fatalf("resolve calls = %v, want exactly one for %s", creds.calls, repoID)
	}
	if len(creds.workerIDs) == 0 || creds.workerIDs[0] != req.WorkerID {
		t.Errorf("resolve worker ids = %v, want the claim's %s", creds.workerIDs, req.WorkerID)
	}

	var clone *wsgit.Command
	rec.mu.Lock()
	for i := range rec.cmds {
		c := &rec.cmds[i]
		for _, a := range c.Argv {
			if a == "clone" {
				clone = c
				break
			}
		}
		if clone != nil {
			break
		}
	}
	rec.mu.Unlock()
	if clone == nil {
		t.Fatal("no clone command was run through the seam")
	}
	hasEnv := func(name string) bool {
		for _, kv := range clone.Env {
			if strings.HasPrefix(kv, name+"=") {
				return true
			}
		}
		return false
	}
	if !hasEnv("COMM_GIT_TOKEN") || !hasEnv("GIT_CONFIG_COUNT") {
		t.Errorf("mirror clone env lacks the credential helper: %v", redactEnv(clone.Env))
	}
	joined := strings.Join(clone.Argv, " ")
	if strings.Contains(joined, token) {
		t.Errorf("the token leaked into the clone argv: %s", joined)
	}
	for _, kv := range clone.Env {
		if kv != "COMM_GIT_TOKEN="+token && strings.Contains(kv, token) {
			t.Errorf("the token rode an unexpected env entry: %s", kv)
		}
	}
}

// TestUnitPrepareWithoutCredentialIsAnonymous: no credential on the row, no
// resolve, no credential env — today's behaviour, unchanged.
func TestUnitPrepareWithoutCredentialIsAnonymous(t *testing.T) {
	fx := newUnitFixture(t)
	rec := &recordingGit{}
	fx.svc.Workspaces.Git.Spawn = rec.spawn
	creds := &mirrorCredStub{token: "unused"}
	fx.svc.MirrorCredentials = creds

	if _, err := fx.svc.Prepare(context.Background(), fx.request()); err != nil {
		t.Fatalf("prepare: %v", err)
	}
	if len(creds.calls) != 0 {
		t.Errorf("resolve calls = %v, want none for an uncredentialed repository", creds.calls)
	}
	rec.mu.Lock()
	defer rec.mu.Unlock()
	for _, c := range rec.cmds {
		for _, kv := range c.Env {
			if strings.HasPrefix(kv, "COMM_GIT_TOKEN=") {
				t.Fatalf("an uncredentialed prepare leaked a token env entry: %s", kv)
			}
		}
	}
}

// TestUnitPrepareFailsClosedOnResolveError: a credential that will not
// resolve fails the prepare with a typed error naming the repository — the
// workspace is never prepared anonymously behind its back.
func TestUnitPrepareFailsClosedOnResolveError(t *testing.T) {
	fx := newUnitFixture(t)
	creds := &mirrorCredStub{err: errors.New("repository \"backend\" secret is revoked")}
	fx.svc.MirrorCredentials = creds

	req := fx.request()
	req.Repos[0].CredentialSecretID = uuidFor("cred")
	_, err := fx.svc.Prepare(context.Background(), req)
	if err == nil {
		t.Fatal("prepare succeeded despite a refused credential resolve")
	}
	if !errors.Is(err, worker.ErrMirrorCredential) {
		t.Errorf("error = %v, want it to join ErrMirrorCredential", err)
	}
	if !strings.Contains(err.Error(), "backend") {
		t.Errorf("error does not name the repository: %v", err)
	}

	// And with no seam wired at all, a credentialed repository still refuses.
	fx2 := newUnitFixture(t)
	req2 := fx2.request()
	req2.Repos[0].CredentialSecretID = uuidFor("cred")
	_, err = fx2.svc.Prepare(context.Background(), req2)
	if !errors.Is(err, worker.ErrMirrorCredential) || !strings.Contains(err.Error(), "backend") {
		t.Errorf("unwired seam: err = %v, want a typed refusal naming the repository", err)
	}
}

// redactEnv keeps a failure listing from echoing values.
func redactEnv(env []string) []string {
	out := make([]string, 0, len(env))
	for _, kv := range env {
		if i := strings.Index(kv, "="); i > 0 {
			out = append(out, kv[:i]+"=…")
		}
	}
	return out
}
