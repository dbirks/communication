package api

// The DATA block's issue read, proven against the route it claims to copy.
//
// assistantNotesReader says it reads "the repository's open issues where the
// issues route would". GET …/repos/{r}/issues resolves an ADR-0061 credential
// ONLY when the repository row names one, and otherwise reads the tracker
// anonymously (github_issues.go: "anonymous when it does not"). The generator
// asked its resolver unconditionally — and postgres.SecretStore refuses a row
// with no credential loudly ("This is a wiring bug, not an anonymous fallback",
// repo_credential.go), which the reader turned into `return nil`. Every public
// repository without an attached credential therefore reached the model with no
// issues at all, and a repository with no runs either had nothing honest to be
// about (no notes, no log line) or was summarised as if its tracker were empty.
//
// The journeys hit this on any lab with no GitHub read token configured, which
// is every local one.

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/dbirks/communication/internal/assistant"
	"github.com/dbirks/communication/internal/integrations/github"
)

type anrRepoStore struct {
	repos []RepositoryView
	err   error
	calls int
}

func (s *anrRepoStore) ListRepositories(ctx context.Context, c Caller,
	projectID string) ([]RepositoryView, error) {
	s.calls++
	return s.repos, s.err
}

type anrRunStore struct {
	runs []RunSummaryView
	err  error
}

func (s anrRunStore) ListProjectRunsFiltered(ctx context.Context, c Caller,
	projectID string, f RunListFilter) ([]RunSummaryView, error) {
	return s.runs, s.err
}

func anrReader(repos []RepositoryView, lister github.IssueLister,
	creds RepositoryCredentialResolver) *assistantNotesReader {
	return &assistantNotesReader{
		runs: anrRunStore{}, repos: &anrRepoStore{repos: repos},
		lister: lister, creds: creds, log: discardLogger(),
	}
}

// anrBrokenReader is the deployment whose repository list itself fails — the
// one read failure the generator may not degrade into an empty summary.
func anrBrokenReader(lister github.IssueLister) *assistantNotesReader {
	return &assistantNotesReader{
		runs: anrRunStore{}, repos: &anrRepoStore{err: errors.New("projects is unavailable")},
		lister: lister, log: discardLogger(),
	}
}

func anrRepo(credential *string) RepositoryView {
	return RepositoryView{
		ID: anRepoID, ProjectID: anProjectID, Name: "server",
		GitURL:             "https://github.com/octocat/Hello-World.git",
		CreatedAt:          time.Unix(1700000000, 0).UTC(),
		CredentialSecretID: credential,
	}
}

// anrCreds answers the way postgres.SecretStore does — which is the point of
// the test: a row that names NO credential is refused there, loudly, as the
// wiring fault a credentialed read would be ("This is a wiring bug, not an
// anonymous fallback", repo_credential.go). Whether the generator still reads
// such a tracker is exactly what drifted from the route.
type anrCreds struct {
	token      string
	resolveErr error
	calls      []string
}

func (c *anrCreds) ResolveRepositoryCredential(ctx context.Context, repositoryID, consumer,
	actorID string) (string, error) {
	c.calls = append(c.calls, repositoryID)
	if consumer != ghConsumerIssueRead {
		return "", errors.New("anrCreds: consumer is not issue_read: " + consumer)
	}
	if c.resolveErr != nil {
		return "", c.resolveErr
	}
	return c.token, nil
}

func TestAssistantNotesReaderIssueCredentialFollowsTheRoute(t *testing.T) {
	t.Parallel()
	secret := "01987a6c-4d5e-7f1a-9b2c-3d4e5f6a7baa"
	noCredentialOnTheRow := func() RepositoryCredentialResolver {
		return &anrCreds{
			resolveErr: errors.New(`repository "server" has no GitHub credential configured`),
		}
	}
	open := []github.Issue{{Number: 12, Title: "Add the order notes field"}}
	for _, tc := range []struct {
		name string
		// credential is what the repository row names (nil: no credential).
		credential *string
		creds      RepositoryCredentialResolver
		// wantToken is the bearer the tracker read is issued with ("" is the
		// route's anonymous arm); wantRead=false means the read must not happen.
		wantToken string
		wantRead  bool
	}{{
		// A public tracker whose row names no credential is READ, anonymously —
		// the resolver's refusal is not this reader's answer. Refusing it is the
		// bug: the DATA block lost every issue on every repository that had not
		// been given an ADR-0061 credential.
		name:      "no credential on the row",
		creds:     noCredentialOnTheRow(),
		wantToken: "",
		wantRead:  true,
	}, {
		name:       "credential configured and resolvable",
		credential: &secret,
		creds:      &anrCreds{token: "gho_observed_token"},
		wantToken:  "gho_observed_token",
		wantRead:   true,
	}, {
		name:       "credential configured and unresolvable",
		credential: &secret,
		creds:      &anrCreds{resolveErr: errors.New("the seal will not open")},
		wantRead:   false,
	}, {
		name:       "credential configured, no resolver wired",
		credential: &secret,
		wantRead:   false,
	}} {
		t.Run(tc.name, func(t *testing.T) {
			lister := &ghiFakeLister{issues: open}
			facts, err := anrReader([]RepositoryView{anrRepo(tc.credential)}, lister, tc.creds).
				ReadRepoFacts(context.Background(), assistant.Caller{UserID: testPrincipal().UserID},
					anProjectID, anRepoID)
			if err != nil {
				t.Fatalf("read repo facts: %v", err)
			}
			if facts.Repository != "server" {
				t.Fatalf("the block names %q, want the repository's own name", facts.Repository)
			}
			if !tc.wantRead {
				if len(lister.calls) != 0 {
					t.Fatalf("the tracker was read %d times on a credential that will not open",
						len(lister.calls))
				}
				if len(facts.Issues) != 0 {
					t.Fatalf("the block carries %d issues from a tracker that was not read",
						len(facts.Issues))
				}
				return
			}
			if len(lister.calls) != 1 {
				t.Fatalf("tracker reads = %d, want 1", len(lister.calls))
			}
			if got := lister.calls[0]; got.token != tc.wantToken {
				t.Fatalf("the tracker read was issued with token %q, want %q", got.token, tc.wantToken)
			} else if got.query.State != github.StateOpen {
				t.Fatalf("the block reads %q issues, want the open ones", got.query.State)
			}
			if len(facts.Issues) != 1 || facts.Issues[0].Number != 12 {
				t.Fatalf("the block carries %+v, want the open issue", facts.Issues)
			}
			if tc.credential == nil {
				// The reader never asks the resolver for a credential the row
				// does not have: that question is the store's wiring fault to
				// raise, not this read's to swallow.
				if got := tc.creds.(*anrCreds).calls; len(got) != 0 {
					t.Fatalf("the reader resolved a credential the row does not name: %v", got)
				}
			}
		})
	}
}

func TestAssistantNotesReaderDegradesEverySectionItCannotRead(t *testing.T) {
	t.Parallel()
	// A failed repository read is the generator's error (it must not summarize
	// half a scope); a failed issue read is one empty section, because a spent
	// GitHub budget is not a reason a repository cannot have notes.
	if _, err := anrBrokenReader(&ghiFakeLister{}).
		ReadRepoFacts(context.Background(), assistant.Caller{UserID: testPrincipal().UserID}, anProjectID, anRepoID); err == nil {
		t.Fatal("a repository list that failed read as an empty scope")
	}
	repos := []RepositoryView{anrRepo(nil)}
	facts, err := anrReader(repos, &ghiFakeLister{err: errors.New("github is rate limited")}, nil).
		ReadRepoFacts(context.Background(), assistant.Caller{UserID: testPrincipal().UserID}, anProjectID, anRepoID)
	if err != nil {
		t.Fatalf("an issue read that failed lost the whole scope: %v", err)
	}
	if len(facts.Issues) != 0 || facts.Repository != "server" {
		t.Fatalf("facts = %+v, want the repository named with no issues", facts)
	}
	// A non-GitHub remote has no tracker to read and asks for none.
	lister := &ghiFakeLister{issues: openIssuesFixture()}
	fileRepo := anrRepo(nil)
	fileRepo.GitURL = "file:///srv/m4/fixtures/app.git"
	facts, err = anrReader([]RepositoryView{fileRepo}, lister, nil).
		ReadRepoFacts(context.Background(), assistant.Caller{UserID: testPrincipal().UserID}, anProjectID, anRepoID)
	if err != nil {
		t.Fatalf("read repo facts for a file:// remote: %v", err)
	}
	if len(lister.calls) != 0 || len(facts.Issues) != 0 {
		t.Fatalf("the file:// repo's tracker was read %d times", len(lister.calls))
	}
}

func openIssuesFixture() []github.Issue {
	return []github.Issue{{Number: 7, Title: "Flaky checkout test"}}
}
