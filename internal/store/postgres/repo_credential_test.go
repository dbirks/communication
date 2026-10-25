package postgres

// ADR-0061 store tests: the reference rule (which secret a repository may
// name), the migration-00016 trigger behind it, and the resolve path with
// its secret.resolved audit row. Real PostgreSQL throughout — every claim
// here is a database claim (AGENTS.md).

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"

	"github.com/dbirks/communication/internal/api"
	"github.com/dbirks/communication/internal/secrets"
)

const (
	credValue   = "ghs_lab_credential_fixture_value"
	credSlugPre = "repo-cred"
)

func credBrokerSecret(t *testing.T, f *secFixture, project string, caller Caller, label string) Secret {
	t.Helper()
	secret, err := f.store.CreateSecret(testCtx(t), caller, project, NewSecret{
		Slug:         f.slug(credSlugPre + "-" + label),
		Purpose:      "github_repo",
		DeliveryMode: secrets.DeliveryBrokerLiteral,
		Profiles:     []string{f.profile},
		Value:        []byte(credValue),
	})
	if err != nil {
		t.Fatalf("create broker secret (%s): %v", label, err)
	}
	return secret
}

func TestRepositoryCredentialStoreWriteRules(t *testing.T) {
	f := secSetup(t)
	ctx := testCtx(t)
	projects := &ProjectStore{Pool: f.pool}
	alice := f.caller(f.alice)

	mine := credBrokerSecret(t, f, f.projA, alice, "mine")
	theirs := credBrokerSecret(t, f, f.projB, f.daveCaller(), "theirs")
	envSecret, err := f.store.CreateSecret(ctx, alice, f.projA, NewSecret{
		Slug: f.slug("env-mode"), Purpose: "mountable", DeliveryMode: secrets.DeliveryEnv,
		Profiles: []string{f.profile}, Value: []byte("mount-value"),
	})
	if err != nil {
		t.Fatalf("create env secret: %v", err)
	}

	// Same-project broker secret: accepted, and it round-trips on the row.
	repo, err := projects.AddRepository(ctx, alice, f.projA, "cred-api", "https://github.com/octo/cred.git", "main", mine.ID)
	if err != nil {
		t.Fatalf("AddRepository with same-project broker secret: %v", err)
	}
	if repo.CredentialSecretID != mine.ID {
		t.Errorf("CredentialSecretID = %q, want %s", repo.CredentialSecretID, mine.ID)
	}
	listed, err := projects.ListRepositories(ctx, alice, f.projA)
	if err != nil {
		t.Fatalf("ListRepositories: %v", err)
	}
	var found bool
	for _, r := range listed {
		if r.ID == repo.ID {
			found = true
			if r.CredentialSecretID != mine.ID {
				t.Errorf("listed CredentialSecretID = %q, want %s", r.CredentialSecretID, mine.ID)
			}
		}
	}
	if !found {
		t.Fatal("the credentialed repository is missing from the list")
	}

	// Another project's secret is refused…
	if _, err := projects.AddRepository(ctx, alice, f.projA, "cred-x", "https://github.com/octo/x.git", "main", theirs.ID); !errors.Is(err, ErrRepositoryCredentialInvalid) {
		t.Errorf("other project's secret: err = %v, want ErrRepositoryCredentialInvalid", err)
	}
	// …and so is a mount-deliverable (env) secret of THIS project.
	if _, err := projects.AddRepository(ctx, alice, f.projA, "cred-env", "https://github.com/octo/e.git", "main", envSecret.ID); !errors.Is(err, ErrRepositoryCredentialInvalid) {
		t.Errorf("env-mode secret: err = %v, want ErrRepositoryCredentialInvalid", err)
	}
	// A secret that does not exist at all.
	if _, err := projects.AddRepository(ctx, alice, f.projA, "cred-ghost", "https://github.com/octo/g.git", "main",
		"00000000-0000-4000-8000-0000000000ff"); !errors.Is(err, ErrRepositoryCredentialInvalid) {
		t.Errorf("missing secret: err = %v, want ErrRepositoryCredentialInvalid", err)
	}

	// Patch: set, clear, refuse.
	patched, err := projects.PatchRepositoryCredential(ctx, alice, f.projA, f.repoA, mine.ID)
	if err != nil {
		t.Fatalf("PatchRepositoryCredential set: %v", err)
	}
	if patched.CredentialSecretID != mine.ID {
		t.Errorf("patched CredentialSecretID = %q, want %s", patched.CredentialSecretID, mine.ID)
	}
	cleared, err := projects.PatchRepositoryCredential(ctx, alice, f.projA, f.repoA, "")
	if err != nil {
		t.Fatalf("PatchRepositoryCredential clear: %v", err)
	}
	if cleared.CredentialSecretID != "" {
		t.Errorf("cleared CredentialSecretID = %q, want empty", cleared.CredentialSecretID)
	}
	if _, err := projects.PatchRepositoryCredential(ctx, alice, f.projA, f.repoA, theirs.ID); !errors.Is(err, ErrRepositoryCredentialInvalid) {
		t.Errorf("patch with another project's secret: err = %v, want ErrRepositoryCredentialInvalid", err)
	}
	// A contributor cannot patch (same invisibility answer as every write).
	if _, err := projects.PatchRepositoryCredential(ctx, f.caller(f.carol), f.projA, f.repoA, mine.ID); !errors.Is(err, ErrProjectNotFound) {
		t.Errorf("patch as contributor: err = %v, want ErrProjectNotFound", err)
	}
	// A repository of another project is invisible, not refused-by-name.
	if _, err := projects.PatchRepositoryCredential(ctx, alice, f.projB, f.repoA, ""); !errors.Is(err, ErrProjectNotFound) {
		t.Errorf("cross-project patch: err = %v, want ErrProjectNotFound", err)
	}
}

func TestRepositoryCredentialOrgScopeAndTrigger(t *testing.T) {
	f := secSetup(t)
	ctx := testCtx(t)
	projects := &ProjectStore{Pool: f.pool}
	orgAdmin := Caller{UserID: f.alice, OrganizationID: f.orgID, IsOrgAdmin: true}

	// An org-scope broker secret serves a project of its organization.
	orgSecret, err := f.store.CreateSecret(ctx, orgAdmin, f.projA, NewSecret{
		Slug: f.slug("org-broker"), Purpose: "github_repo", DeliveryMode: secrets.DeliveryBrokerLiteral,
		Scope: secrets.ScopeOrg, Profiles: []string{f.profile}, Value: []byte(credValue),
	})
	if err != nil {
		t.Fatalf("create org-scope broker secret: %v", err)
	}
	if orgSecret.ProjectID != "" {
		t.Fatalf("org-scope secret carries a project id: %+v", orgSecret)
	}
	if _, err := projects.AddRepository(ctx, orgAdmin, f.projA, "cred-org", "https://github.com/octo/org.git", "main", orgSecret.ID); err != nil {
		t.Fatalf("AddRepository with org-scope broker secret: %v", err)
	}
	// And not a repository of another ORGANIZATION's project: projB lives in
	// the second org, so its maintainer cannot reference projA's org secret.
	if _, err := projects.AddRepository(ctx, f.daveCaller(), f.projB, "cred-steal",
		"https://github.com/octo/steal.git", "main", orgSecret.ID); !errors.Is(err, ErrRepositoryCredentialInvalid) {
		t.Errorf("cross-org reference: err = %v, want ErrRepositoryCredentialInvalid", err)
	}

	// The migration-00016 trigger is the backstop under the Go check: a raw
	// write that skips the store must be refused by the database itself.
	theirs := credBrokerSecret(t, f, f.projB, f.daveCaller(), "trig-theirs")
	_, err = f.pool.Exec(ctx, `
		INSERT INTO repositories (project_id, name, git_url, default_branch, created_by, credential_secret_id)
		VALUES ($1::uuid, 'trig-x', 'https://github.com/octo/t.git', 'main', $2::uuid, $3::uuid)`,
		f.projA, f.alice, theirs.ID)
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) || pgErr.Code != "23514" {
		t.Fatalf("trigger cross-project insert: err = %v, want a 23514 check violation", err)
	}
	if !strings.Contains(pgErr.Message, "credential") {
		t.Errorf("trigger message should name the credential: %q", pgErr.Message)
	}
	// The valid arm must insert, or the trigger is just broken.
	if _, err := f.pool.Exec(ctx, `
		INSERT INTO repositories (project_id, name, git_url, default_branch, created_by, credential_secret_id)
		VALUES ($1::uuid, 'trig-ok', 'https://github.com/octo/t.git', 'main', $2::uuid, $3::uuid)`,
		f.projA, f.alice, orgSecret.ID); err != nil {
		t.Errorf("trigger valid org-scope insert: %v", err)
	}
	// An env-mode secret is refused by the trigger too.
	envSecret, err := f.store.CreateSecret(ctx, f.caller(f.alice), f.projA, NewSecret{
		Slug: f.slug("trig-env"), DeliveryMode: secrets.DeliveryEnv,
		Profiles: []string{f.profile}, Value: []byte("v"),
	})
	if err != nil {
		t.Fatalf("create env secret: %v", err)
	}
	if _, err := f.pool.Exec(ctx, `
		INSERT INTO repositories (project_id, name, git_url, default_branch, created_by, credential_secret_id)
		VALUES ($1::uuid, 'trig-env', 'https://github.com/octo/e.git', 'main', $2::uuid, $3::uuid)`,
		f.projA, f.alice, envSecret.ID); err == nil {
		t.Error("trigger accepted an env-mode credential")
	} else {
		var pgErr *pgconn.PgError
		if !errors.As(err, &pgErr) || pgErr.Code != "23514" {
			t.Errorf("trigger env insert: err = %v, want 23514", err)
		}
	}
}

func TestRepositoryCredentialResolveAndAudit(t *testing.T) {
	f := secSetup(t)
	ctx := testCtx(t)
	projects := &ProjectStore{Pool: f.pool}
	alice := f.caller(f.alice)
	secret := credBrokerSecret(t, f, f.projA, alice, "resolve")
	if _, err := projects.PatchRepositoryCredential(ctx, alice, f.projA, f.repoA, secret.ID); err != nil {
		t.Fatalf("patch credential: %v", err)
	}

	token, err := f.store.ResolveRepositoryCredential(ctx, f.repoA, secrets.ConsumerRepoMirror, f.worker)
	if err != nil {
		t.Fatalf("ResolveRepositoryCredential: %v", err)
	}
	if token != credValue {
		t.Errorf("token = %q, want the sealed value", token)
	}

	// The audit row: action, consumer, and — critically — no value.
	var outcome, detail string
	if err := f.pool.QueryRow(ctx, `
		SELECT outcome, detail::text FROM audit_events
		WHERE project_id = $1::uuid AND action = 'secret.resolved'
		ORDER BY id DESC LIMIT 1`, f.projA).Scan(&outcome, &detail); err != nil {
		t.Fatalf("read secret.resolved audit row: %v", err)
	}
	if outcome != "allowed" {
		t.Errorf("audit outcome = %q, want allowed", outcome)
	}
	var got struct {
		SecretID string `json:"secret_id"`
		Consumer string `json:"consumer"`
		RepoName string `json:"repository_name"`
		Version  int    `json:"version"`
	}
	if err := json.Unmarshal([]byte(detail), &got); err != nil {
		t.Fatalf("audit detail is not the expected shape: %v (%s)", err, detail)
	}
	if got.SecretID != secret.ID || got.Consumer != secrets.ConsumerRepoMirror || got.Version != 1 {
		t.Errorf("audit detail = %+v, want secret %s consumer %s version 1", got, secret.ID, secrets.ConsumerRepoMirror)
	}
	if strings.Contains(detail, credValue) {
		t.Errorf("the audit detail carried the value: %s", detail)
	}

	// A repository WITHOUT a credential is a typed refusal that names the
	// repository — never an empty token that reads as anonymous success.
	if _, err := f.store.ResolveRepositoryCredential(ctx, f.repoA, secrets.ConsumerIssueRead, "system"); err != nil {
		t.Fatalf("sanity: re-resolve credentialed repo as issue_read: %v", err)
	}
	var bareRepo string
	if err := f.pool.QueryRow(ctx, `
		INSERT INTO repositories (project_id, name, git_url, default_branch, created_by)
		VALUES ($1::uuid, 'no-credential', 'https://github.com/octo/bare.git', 'main', $2::uuid)
		RETURNING id`, f.projA, f.alice).Scan(&bareRepo); err != nil {
		t.Fatalf("seed bare repository: %v", err)
	}
	_, err = f.store.ResolveRepositoryCredential(ctx, bareRepo, secrets.ConsumerIssueRead, "system")
	if !errors.Is(err, ErrRepositoryCredential) || !strings.Contains(err.Error(), "no-credential") {
		t.Fatalf("resolve of an uncredentialed repository = %v, want a typed error naming it", err)
	}

	// A revoked credential fails closed and the denial is audited.
	if _, err := f.store.RevokeSecret(ctx, alice, f.projA, secret.ID); err != nil {
		t.Fatalf("revoke: %v", err)
	}
	if _, err := f.store.ResolveRepositoryCredential(ctx, f.repoA, secrets.ConsumerRepoMirror, f.worker); !errors.Is(err, ErrRepositoryCredential) {
		t.Fatalf("resolve of a revoked credential = %v, want ErrRepositoryCredential", err)
	}
	var denied string
	if err := f.pool.QueryRow(ctx, `
		SELECT detail::text FROM audit_events
		WHERE project_id = $1::uuid AND action = 'secret.resolved' AND outcome = 'denied'
		ORDER BY id DESC LIMIT 1`, f.projA).Scan(&denied); err != nil {
		t.Fatalf("read denied secret.resolved audit row: %v", err)
	}
	if !strings.Contains(denied, `"revoked"`) {
		t.Errorf("denied audit detail = %s, want the revoked failure class", denied)
	}

	// Wrong-consumer asks are refused: the consumer axis is the audit
	// contract, not a free-text field.
	secret2 := credBrokerSecret(t, f, f.projA, alice, "consumer")
	if _, err := projects.PatchRepositoryCredential(ctx, alice, f.projA, f.repoA, secret2.ID); err != nil {
		t.Fatalf("patch credential 2: %v", err)
	}
	if _, err := f.store.ResolveRepositoryCredential(ctx, f.repoA, "ci_upload", f.worker); !errors.Is(err, ErrRepositoryCredential) {
		t.Fatalf("unknown consumer resolve = %v, want ErrRepositoryCredential", err)
	}
}

// TestRepositoryCredentialStoreMapsToAPI pins the adapter half: the api view
// carries credential_secret_id and the derived credential state, and the
// store's reference refusal surfaces as the api sentinel the handler turns
// into 422 invalid_credential_secret.
func TestRepositoryCredentialStoreMapsToAPI(t *testing.T) {
	f := secSetup(t)
	ctx := testCtx(t)
	adapter := APIProjectStore{S: &ProjectStore{Pool: f.pool}}
	aliceAPI := api.Caller{UserID: f.alice, OrganizationID: f.orgID}
	secret := credBrokerSecret(t, f, f.projA, f.caller(f.alice), "api")

	view, err := adapter.AddRepository(ctx, aliceAPI, f.projA, "api-cred", "https://github.com/octo/a.git", "main", secret.ID)
	if err != nil {
		t.Fatalf("adapter AddRepository: %v", err)
	}
	if view.CredentialSecretID == nil || *view.CredentialSecretID != secret.ID {
		t.Fatalf("view credential_secret_id = %v, want %s", view.CredentialSecretID, secret.ID)
	}
	if view.Credential != "configured" {
		t.Errorf("view credential = %q, want configured", view.Credential)
	}
	_, err = adapter.AddRepository(ctx, aliceAPI, f.projA, "api-x", "https://github.com/octo/x.git", "main",
		credBrokerSecret(t, f, f.projB, f.daveCaller(), "api-x").ID)
	if !errors.Is(err, api.ErrRepositoryCredentialInvalid) {
		t.Fatalf("adapter cross-project err = %v, want the api credential sentinel", err)
	}
	cleared, err := adapter.PatchRepositoryCredential(ctx, aliceAPI, f.projA,
		// the view above carries its id:
		view.ID, "")
	if err != nil {
		t.Fatalf("adapter clear: %v", err)
	}
	if cleared.CredentialSecretID != nil || cleared.Credential != "none" {
		t.Errorf("cleared view = %v/%q, want nil/none", cleared.CredentialSecretID, cleared.Credential)
	}
}
