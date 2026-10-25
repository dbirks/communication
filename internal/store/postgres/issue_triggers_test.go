package postgres

// The ADR-0056 part-2 issue-trigger tests: the fire's promises against a
// PostgreSQL that actually ran 00012, driven through the REAL github client
// pointed at a local httptest server (the fake lister the task names).

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/dbirks/communication/internal/api"
	"github.com/dbirks/communication/internal/events"
	"github.com/dbirks/communication/internal/integrations/github"
)

type itFixture struct {
	*m4Fixture
	triggers   *IssueTriggerStore
	assignment string
	repository string
	triggerID  string
	caller     Caller
}

// itSetup seeds the m4 fixture plus one assignment, one repository and one
// issue trigger (event "opened", no labels, no inputs).
func itSetup(t *testing.T) *itFixture {
	t.Helper()
	ctx := testCtx(t)
	f := m4Setup(t)
	var assignID, repoID string
	if err := f.pool.QueryRow(ctx, `
		INSERT INTO assignments (project_id, pipeline_id, pinned_revision_id, max_concurrent_runs, created_by)
		VALUES ($1, $2, $3, 4, $4) RETURNING id`,
		f.projectID, f.pipelineID, f.revisionID, f.userID).Scan(&assignID); err != nil {
		t.Fatalf("insert assignment: %v", err)
	}
	if err := f.pool.QueryRow(ctx, `
		INSERT INTO repositories (project_id, name, git_url, created_by)
		VALUES ($1, 'octo/widgets', 'https://github.com/octo/widgets.git', $2) RETURNING id`,
		f.projectID, f.userID).Scan(&repoID); err != nil {
		t.Fatalf("insert repository: %v", err)
	}
	triggers := &IssueTriggerStore{Pool: f.pool, Runs: f.runs}
	enabled := true
	it, err := triggers.Create(ctx, NewIssueTrigger{
		ProjectID: f.projectID, AssignmentID: assignID, RepositoryID: repoID,
		Event: "opened", Labels: []string{}, Inputs: json.RawMessage(`{}`), Enabled: &enabled, CreatedBy: f.userID,
	})
	if err != nil {
		t.Fatalf("create issue trigger: %v", err)
	}
	t.Cleanup(func() {
		bg := context.Background()
		for _, step := range []string{
			`DELETE FROM issue_triggers WHERE project_id = $1`,
			// ADR-0060: a fired run records the trigger's repository; the FK
			// goes away only when the repository does, and the fixture's run
			// cleanup runs after this callback — so the pointer is cleared
			// here, never the run.
			`UPDATE runs SET repository_id = NULL WHERE project_id = $1`,
			`DELETE FROM repositories WHERE project_id = $1`,
		} {
			if _, err := f.pool.Exec(bg, step, f.projectID); err != nil {
				t.Errorf("issue-trigger cleanup %q: %v", step, err)
			}
		}
	})
	return &itFixture{m4Fixture: f, triggers: triggers, assignment: assignID, repository: repoID, triggerID: it.ID, caller: Caller{UserID: f.userID, OrganizationID: f.orgID, IsOrgAdmin: true}}
}

// itDropTriggers removes every issue trigger of the fixture project so a
// test can author exactly one.
func (f *itFixture) itDropTriggers(t *testing.T, ctx context.Context) {
	t.Helper()
	if _, err := f.pool.Exec(ctx, `DELETE FROM issue_triggers WHERE project_id = $1::uuid`, f.projectID); err != nil {
		t.Fatalf("drop issue triggers: %v", err)
	}
}

// itWireIssue is the wire shape the fake server answers with (GitHub's own
// member names), including the `pull_request` marker a real PR listing carries.
type itWireIssue struct {
	Number    int             `json:"number"`
	Title     string          `json:"title"`
	Body      string          `json:"body"`
	State     string          `json:"state"`
	HTMLURL   string          `json:"html_url"`
	CreatedAt string          `json:"created_at"`
	UpdatedAt string          `json:"updated_at"`
	Labels    []itWireLabel   `json:"labels"`
	PR        json.RawMessage `json:"pull_request"`
}
type itWireLabel struct {
	Name string `json:"name"`
}

func itWireToIssue(in itWireIssue) github.Issue {
	out := github.Issue{
		Number:    in.Number,
		Title:     in.Title,
		Body:      in.Body,
		Labels:    []string{},
		HTMLURL:   in.HTMLURL,
		State:     in.State,
		CreatedAt: time.Time{},
		UpdatedAt: time.Time{},
	}
	if len(in.Labels) > 0 {
		for _, l := range in.Labels {
			out.Labels = append(out.Labels, l.Name)
		}
	}
	out.CreatedAt, _ = time.Parse(time.RFC3339, in.CreatedAt)
	out.UpdatedAt, _ = time.Parse(time.RFC3339, in.UpdatedAt)
	return out
}

// itIssueLister is the github.IssueLister the real client answers from a local
// httptest server, honouring the `since` / `labels` query params the poll sends.
type itIssueLister struct {
	client  *github.Client
	server  *httptest.Server
	handler http.HandlerFunc
}

func newITIssueLister(issues []itWireIssue, handler http.HandlerFunc) *itIssueLister {
	if handler == nil {
		handler = func(w http.ResponseWriter, r *http.Request) {
			q := r.URL.Query()
			var out []itWireIssue
			for _, it := range issues {
				if since := q.Get("since"); since != "" {
					if ts, err := strconv.ParseInt(since, 10, 64); err == nil {
						if t, terr := time.Parse(time.RFC3339, it.UpdatedAt); terr == nil && t.Unix() < ts {
							continue
						}
					}
				}
				if len(q["labels"]) > 0 {
					matched := false
					for _, l := range q["labels"] {
						for _, il := range it.Labels {
							if len(l) > 0 && len(il.Name) > 0 && strings.EqualFold(l, il.Name) {
								matched = true
							}
						}
					}
					if !matched {
						continue
					}
				}
				out = append(out, it)
			}
			_ = json.NewEncoder(w).Encode(out)
		}
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/repos/octo/widgets/issues", handler)
	srv := httptest.NewServer(mux)
	c := github.New()
	c.BaseURL = srv.URL
	c.HTTP = &http.Client{Timeout: 5 * time.Second}
	return &itIssueLister{client: c, server: srv, handler: handler}
}

func (l *itIssueLister) ListIssues(ctx context.Context, repo github.Repository, q github.IssueQuery, token string) ([]github.Issue, error) {
	return l.client.ListIssues(ctx, repo, q, token)
}

func (l *itIssueLister) Close() { l.server.Close() }

// itIssueFires is the store-side helper: create an issue trigger for the
// fixture's assignment/repository with the given intent.
func (f *itFixture) itIssueFires(ctx context.Context, event string, labels []string, inputs json.RawMessage, enabled *bool) (IssueTrigger, error) {
	en := enabled
	if en == nil {
		en = boolPtr(true)
	}
	return f.triggers.Create(ctx, NewIssueTrigger{
		ProjectID: f.projectID, AssignmentID: f.assignment, RepositoryID: f.repository,
		Event: event, Labels: labels, Inputs: inputs, Enabled: en, CreatedBy: f.userID,
	})
}

func boolPtr(b bool) *bool { return &b }

// itOtherOrg is a caller from a second organization: an issue-trigger read or
// edit from there is invisible to the fixture's project.
func (f *itFixture) itOtherOrg(t *testing.T, ctx context.Context) api.Caller {
	t.Helper()
	token := migFixtureToken(t)
	var orgID, userID string
	if err := f.pool.QueryRow(ctx, `
		INSERT INTO organizations (slug, name) VALUES ('it-ap-org-' || $1, 'it api issue triggers other')
		RETURNING id`, token).Scan(&orgID); err != nil {
		t.Fatalf("seed other org: %v", err)
	}
	if err := f.pool.QueryRow(ctx, `
		INSERT INTO users (organization_id, display_name) VALUES ($1, 'it-ap-other-' || $2)
		RETURNING id`, orgID, token).Scan(&userID); err != nil {
		t.Fatalf("seed other user: %v", err)
	}
	t.Cleanup(func() {
		bg := context.Background()
		if _, err := f.pool.Exec(bg, `DELETE FROM users WHERE id = $1`, userID); err != nil {
			t.Errorf("cleanup other user: %v", err)
		}
		if _, err := f.pool.Exec(bg, `DELETE FROM organizations WHERE id = $1`, orgID); err != nil {
			t.Errorf("cleanup other org: %v", err)
		}
	})
	return api.Caller{UserID: userID, OrganizationID: orgID}
}

// itIssueFiredEvent reads the single issue_trigger.fired row for one run.
func itIssueFiredEvent(t *testing.T, ctx context.Context, f *itFixture, runID string) events.IssueTriggerFiredPayload {
	t.Helper()
	rows, err := f.pool.Query(ctx, `
		SELECT payload FROM domain_events WHERE type = $1 AND project_id = $2::uuid AND run_id = $3::uuid
		ORDER BY global_seq`, events.TypeIssueTriggerFired, f.projectID, runID)
	if err != nil {
		t.Fatalf("read issue_trigger.fired rows: %v", err)
	}
	defer rows.Close()
	var out []events.IssueTriggerFiredPayload
	for rows.Next() {
		var raw []byte
		if err := rows.Scan(&raw); err != nil {
			t.Fatalf("scan issue_trigger.fired payload: %v", err)
		}
		var p events.IssueTriggerFiredPayload
		if err := json.Unmarshal(raw, &p); err != nil {
			t.Fatalf("decode issue_trigger.fired payload %s: %v", raw, err)
		}
		out = append(out, p)
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("read issue_trigger.fired rows: %v", err)
	}
	if len(out) != 1 {
		t.Fatalf("issue_trigger.fired rows = %d, want 1", len(out))
	}
	return out[0]
}

func itIssueRunFor(t *testing.T, ctx context.Context, f *itFixture, ref string) (string, string) {
	t.Helper()
	var runID, kind string
	if err := f.pool.QueryRow(ctx,
		`SELECT id::text, trigger_kind FROM runs WHERE trigger_ref = $1`, ref).Scan(&runID, &kind); err != nil {
		t.Fatalf("read the fired issue run for %q: %v", ref, err)
	}
	return runID, kind
}

func itIssuePrompt(t *testing.T, ctx context.Context, f *itFixture, runID string) string {
	t.Helper()
	var raw sql.NullString
	if err := f.pool.QueryRow(ctx, `SELECT value FROM run_inputs WHERE run_id = $1::uuid AND name = 'prompt'`, runID).Scan(&raw); err != nil {
		t.Fatalf("read the fired run's prompt input: %v", err)
	}
	var prompt string
	if err := json.Unmarshal([]byte(raw.String), &prompt); err != nil {
		t.Fatalf("decode the fired run's prompt input %q: %v", raw.String, err)
	}
	return prompt
}

// TestIssueTriggerOpenedFiresPerNewIssue: the `opened` arm fires only for
// issues created after the trigger was authored, once per (trigger, issue).
func TestIssueTriggerOpenedFiresPerNewIssue(t *testing.T) {
	ctx := testCtx(t)
	f := itSetup(t)
	f.itDropTriggers(t, ctx)
	trigger, err := f.itIssueFires(ctx, "opened", []string{}, json.RawMessage(`{"prompt":"Fix {{issue.number}}: {{issue.title}}"}`), nil)
	if err != nil {
		t.Fatalf("itIssueFires: %v", err)
	}
	createdAt := trigger.CreatedAt

	newIssue := itWireIssue{Number: 7, Title: "Crash on boot", Body: "it crashes", State: "open",
		HTMLURL: "https://github.com/octo/widgets/issues/7", CreatedAt: createdAt.Add(time.Hour).Format(time.RFC3339),
		UpdatedAt: createdAt.Add(2 * time.Hour).Format(time.RFC3339), Labels: []itWireLabel{{Name: "bug"}}}
	oldIssue := itWireIssue{Number: 3, Title: "Old thing", Body: "old", State: "open",
		HTMLURL: "https://github.com/octo/widgets/issues/3", CreatedAt: createdAt.Add(-2 * time.Hour).Format(time.RFC3339),
		UpdatedAt: createdAt.Add(-time.Hour).Format(time.RFC3339), Labels: []itWireLabel{{Name: "bug"}}}
	lister := newITIssueLister([]itWireIssue{oldIssue, newIssue}, nil)
	defer lister.Close()

	fired, err := f.triggers.TickIssueTriggers(ctx, time.Now().UTC(), lister)
	if err != nil || fired != 1 {
		t.Fatalf("TickIssueTriggers = (%d, %v), want one fire (old issue never)", fired, err)
	}
	runID, kind := itIssueRunFor(t, ctx, f, "octo/widgets#7")
	if kind != "issue" {
		t.Fatalf("fired run kind = %s, want issue", kind)
	}
	if got := itIssuePrompt(t, ctx, f, runID); got != "Fix 7: Crash on boot" {
		t.Errorf("prompt = %q, want the rendered template value", got)
	}
	p := itIssueFiredEvent(t, ctx, f, runID)
	if p.IssueNumber != 7 || p.IssueURL != newIssue.HTMLURL || p.TriggerID != trigger.ID {
		t.Errorf("issue_trigger.fired payload = %+v", p)
	}
}

// TestIssueTriggerLabeledFiresOnlyOnMatchingLabel: the any-of label rule is
// case-insensitive, and an empty trigger label set means "every issue".
func TestIssueTriggerLabeledFiresOnlyOnMatchingLabel(t *testing.T) {
	ctx := testCtx(t)
	f := itSetup(t)
	f.itDropTriggers(t, ctx)
	if _, err := f.itIssueFires(ctx, "labeled", []string{"Bug"}, json.RawMessage(`{}`), nil); err != nil {
		t.Fatalf("itIssueFires: %v", err)
	}
	issues := []itWireIssue{
		{Number: 5, Title: "A", Body: "", State: "open", HTMLURL: "https://github.com/octo/widgets/issues/5",
			CreatedAt: "2026-03-10T08:00:00Z", UpdatedAt: "2026-03-10T08:30:00Z", Labels: []itWireLabel{{Name: "bug"}}},
		{Number: 6, Title: "B", Body: "", State: "open", HTMLURL: "https://github.com/octo/widgets/issues/6",
			CreatedAt: "2026-03-10T08:00:00Z", UpdatedAt: "2026-03-10T08:30:00Z", Labels: []itWireLabel{{Name: "Feature"}}},
		{Number: 8, Title: "C", Body: "", State: "open", HTMLURL: "https://github.com/octo/widgets/issues/8",
			CreatedAt: "2026-03-10T08:00:00Z", UpdatedAt: "2026-03-10T08:30:00Z", Labels: []itWireLabel{}},
	}
	lister := newITIssueLister(issues, nil)
	defer lister.Close()
	fired, err := f.triggers.TickIssueTriggers(ctx, time.Now().UTC(), lister)
	if err != nil || fired != 1 {
		t.Fatalf("TickIssueTriggers = (%d, %v), want one fire on the matching label", fired, err)
	}
	if _, kind := itIssueRunFor(t, ctx, f, "octo/widgets#5"); kind != "issue" {
		t.Fatalf("fired run kind = %s, want issue", kind)
	}
}

func TestIssueTriggerRepollDoesNotDoubleFire(t *testing.T) {
	ctx := testCtx(t)
	f := itSetup(t)
	f.itDropTriggers(t, ctx)
	trigger, err := f.itIssueFires(ctx, "opened", []string{}, json.RawMessage(`{}`), nil)
	if err != nil {
		t.Fatalf("itIssueFires: %v", err)
	}
	issue := itWireIssue{Number: 7, Title: "Crash on boot", Body: "it crashes", State: "open",
		HTMLURL: "https://github.com/octo/widgets/issues/7", CreatedAt: trigger.CreatedAt.Add(time.Hour).Format(time.RFC3339),
		UpdatedAt: trigger.CreatedAt.Add(2 * time.Hour).Format(time.RFC3339), Labels: []itWireLabel{{Name: "bug"}}}
	lister := newITIssueLister([]itWireIssue{issue}, nil)
	defer lister.Close()
	now := time.Now().UTC()
	if fired, err := f.triggers.TickIssueTriggers(ctx, now, lister); err != nil || fired != 1 {
		t.Fatalf("first tick = (%d, %v), want one fire", fired, err)
	}
	if fired, err := f.triggers.TickIssueTriggers(ctx, now.Add(time.Minute), lister); err != nil || fired != 0 {
		t.Fatalf("second tick = (%d, %v), want no double fire", fired, err)
	}
}

// TestIssueTriggerSkipsPullRequests: a pull request is not an issue, through
// the real client (the `pull_request` marker is dropped before any fire).
func TestIssueTriggerSkipsPullRequests(t *testing.T) {
	ctx := testCtx(t)
	f := itSetup(t)
	f.itDropTriggers(t, ctx)
	if _, err := f.itIssueFires(ctx, "labeled", []string{}, json.RawMessage(`{}`), nil); err != nil {
		t.Fatalf("itIssueFires: %v", err)
	}
	issues := []itWireIssue{
		{Number: 9, Title: "A PR", Body: "", State: "open", HTMLURL: "https://github.com/octo/widgets/pull/9",
			CreatedAt: "2026-03-10T08:00:00Z", UpdatedAt: "2026-03-10T08:30:00Z", Labels: []itWireLabel{{Name: "bug"}},
			PR: json.RawMessage(`{"url":"https://api.github.com/repos/octo/widgets/pulls/9"}`)},
	}
	lister := newITIssueLister(issues, nil)
	defer lister.Close()
	fired, err := f.triggers.TickIssueTriggers(ctx, time.Now().UTC(), lister)
	if err != nil || fired != 0 {
		t.Fatalf("tick over a PR-only list = (%d, %v), want no fire", fired, err)
	}
}

// TestIssueTriggerRateLimitRecordsErrorAndTickContinues: a rate-limited poll
// writes last_error (bounded) plus last_polled_at and leaves the tick green.
func TestIssueTriggerRateLimitRecordsErrorAndTickContinues(t *testing.T) {
	ctx := testCtx(t)
	f := itSetup(t)
	f.itDropTriggers(t, ctx)
	trigger, err := f.itIssueFires(ctx, "opened", []string{}, json.RawMessage(`{}`), nil)
	if err != nil {
		t.Fatalf("itIssueFires: %v", err)
	}
	var lastErr sql.NullString
	var lastPolled sql.NullTime
	if err := f.pool.QueryRow(ctx, `
		SELECT last_error, last_polled_at FROM issue_triggers WHERE id = $1::uuid`, trigger.ID).Scan(&lastErr, &lastPolled); err != nil {
		t.Fatalf("read trigger poll state: %v", err)
	}
	if lastPolled.Valid || lastErr.Valid || lastErr.String != "" {
		t.Fatalf("fresh trigger polled state = (%q, valid=%v), want NULL/empty", lastErr.String, lastPolled.Valid)
	}

	lister := newITIssueLister(nil, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("X-RateLimit-Remaining", "0")
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(`{"message":"API rate limit exceeded"}`))
	})
	defer lister.Close()
	fired, err := f.triggers.TickIssueTriggers(ctx, time.Now().UTC(), lister)
	if err != nil || fired != 0 {
		t.Fatalf("TickIssueTriggers under a rate limit = (%d, %v), want no fire and no tick error", fired, err)
	}
	if err := f.pool.QueryRow(ctx, `
		SELECT last_error, last_polled_at FROM issue_triggers WHERE id = $1::uuid`, trigger.ID).Scan(&lastErr, &lastPolled); err != nil {
		t.Fatalf("read trigger poll state: %v", err)
	}
	if !lastPolled.Valid || !lastErr.Valid || lastErr.String == "" {
		t.Errorf("trigger poll state = (%q, valid=%v), want a bounded last_error and a last_polled_at", lastErr.String, lastPolled.Valid)
	}
}

// TestIssueTriggerDisabledNeverPolls: a disabled trigger is never due.
func TestIssueTriggerDisabledNeverPolls(t *testing.T) {
	ctx := testCtx(t)
	f := itSetup(t)
	disabled := false
	trigger, err := f.itIssueFires(ctx, "opened", []string{}, json.RawMessage(`{}`), &disabled)
	if err != nil {
		t.Fatalf("itIssueFires: %v", err)
	}
	lister := newITIssueLister(nil, nil)
	defer lister.Close()
	fired, err := f.triggers.TickIssueTriggers(ctx, time.Now().UTC(), lister)
	if err != nil || fired != 0 {
		t.Fatalf("tick of a disabled trigger = (%d, %v), want no fire", fired, err)
	}
	var lastPolled sql.NullTime
	if err := f.pool.QueryRow(ctx, `SELECT last_polled_at FROM issue_triggers WHERE id = $1::uuid`, trigger.ID).Scan(&lastPolled); err != nil || lastPolled.Valid {
		t.Errorf("disabled trigger polled: last_polled_at valid=%v (%v), want NULL", lastPolled.Valid, err)
	}
}

// TestIssueTriggerTemplateRendering: the `{{issue.*}}` placeholders fill the
// fired issue's values into the run inputs.
func TestIssueTriggerTemplateRendering(t *testing.T) {
	ctx := testCtx(t)
	f := itSetup(t)
	f.itDropTriggers(t, ctx)
	trigger, err := f.itIssueFires(ctx, "opened", []string{}, json.RawMessage(`{"prompt":"Fix {{issue.number}}: {{issue.title}} {{issue.labels}}"}`), nil)
	if err != nil {
		t.Fatalf("itIssueFires: %v", err)
	}
	issue := itWireIssue{Number: 7, Title: "Crash on boot", Body: "it crashes", State: "open",
		HTMLURL: "https://github.com/octo/widgets/issues/7", CreatedAt: trigger.CreatedAt.Add(time.Hour).Format(time.RFC3339),
		UpdatedAt: trigger.CreatedAt.Add(2 * time.Hour).Format(time.RFC3339), Labels: []itWireLabel{{Name: "bug"}}}
	lister := newITIssueLister([]itWireIssue{issue}, nil)
	defer lister.Close()
	fired, err := f.triggers.TickIssueTriggers(ctx, time.Now().UTC(), lister)
	if err != nil || fired != 1 {
		t.Fatalf("tick = (%d, %v), want one fire", fired, err)
	}
	runID, _ := itIssueRunFor(t, ctx, f, "octo/widgets#7")
	if got := itIssuePrompt(t, ctx, f, runID); got != "Fix 7: Crash on boot bug" {
		t.Errorf("prompt = %q, want the rendered template value", got)
	}
}

// TestIssueTriggerOtherOrganizationCannotListOrPatch: another organization's
// caller reads and edits nothing of this project's triggers.
func TestIssueTriggerOtherOrganizationCannotListOrPatch(t *testing.T) {
	ctx := testCtx(t)
	f := itSetup(t)
	adapter := APIIssueTriggerStore{S: f.triggers}
	other := f.itOtherOrg(t, ctx)
	if items, err := adapter.ListProjectIssueTriggers(ctx, other, f.projectID); err != nil || len(items) != 0 {
		t.Errorf("another org lists = (%d, %v), want an empty list", len(items), err)
	}
	if _, err := adapter.UpdateIssueTrigger(ctx, other, f.triggerID, api.IssueTriggerPatchInput{Version: 1}); !errors.Is(err, api.ErrIssueTriggerNotFound) {
		t.Errorf("another org patches = %v, want the not-found sentinel", err)
	}
}

// ------------------------------------------- ADR-0061: credentialed polls

// itRecordingLister wraps the real-client lister and records the token the
// poll passed per call — the assertion the ADR's § 5 rests on.
type itRecordingLister struct {
	inner  *itIssueLister
	tokens []string
}

func (l *itRecordingLister) ListIssues(ctx context.Context, repo github.Repository,
	q github.IssueQuery, token string) ([]github.Issue, error) {
	l.tokens = append(l.tokens, token)
	return l.inner.ListIssues(ctx, repo, q, token)
}

func (l *itRecordingLister) Close() { l.inner.Close() }

// itSeedCredentialSecret writes an integration_broker secret in the
// fixture's project and references it from the fixture's repository — the
// same rows the store's own write paths produce (the trigger validates
// them). Returns the secret store (with keyring) and the plaintext.
func itSeedCredentialSecret(t *testing.T, f *itFixture) (*SecretStore, string) {
	t.Helper()
	ctx := testCtx(t)
	store := &SecretStore{Pool: f.pool, Keys: secKeyring(t)}
	secret, err := store.CreateSecret(ctx, f.caller, f.projectID, NewSecret{
		Slug: "poller-cred-" + migFixtureToken(t), Purpose: "github_repo",
		DeliveryMode: "integration_broker",
		Profiles:     []string{"11111111-1111-4111-8111-111111111111"},
		Value:        []byte(itCredValue),
	})
	if err != nil {
		t.Fatalf("create broker secret: %v", err)
	}
	if _, err := f.pool.Exec(ctx,
		`UPDATE repositories SET credential_secret_id = $2::uuid WHERE id = $1::uuid`,
		f.repository, secret.ID); err != nil {
		t.Fatalf("reference credential: %v", err)
	}
	t.Cleanup(func() {
		bg := context.Background()
		_, _ = f.pool.Exec(bg, `UPDATE repositories SET credential_secret_id = NULL WHERE id = $1::uuid`, f.repository)
		_, _ = f.pool.Exec(bg, `DELETE FROM secret_versions WHERE secret_id = $1::uuid`, secret.ID)
		_, _ = f.pool.Exec(bg, `DELETE FROM secret_metadata WHERE id = $1::uuid`, secret.ID)
		_, _ = f.pool.Exec(bg, `DELETE FROM audit_events WHERE action = 'secret.resolved' AND project_id = $1::uuid`, f.projectID)
	})
	return store, itCredValue
}

const itCredValue = "ghs_poller_fixture_value"

// TestIssueTriggerPollPassesRepositoryCredential: the repository's credential
// rides the poll (ADR-0061 § 5), and clearing it returns the poll to
// anonymous — "" on the wire, never a stale token.
func TestIssueTriggerPollPassesRepositoryCredential(t *testing.T) {
	ctx := testCtx(t)
	f := itSetup(t)
	f.itDropTriggers(t, ctx)
	if _, err := f.itIssueFires(ctx, "opened", []string{}, json.RawMessage(`{}`), nil); err != nil {
		t.Fatalf("itIssueFires: %v", err)
	}
	store, want := itSeedCredentialSecret(t, f)
	f.triggers.Credentials = store

	lister := &itRecordingLister{inner: newITIssueLister(nil, nil)}
	defer lister.Close()
	if fired, err := f.triggers.TickIssueTriggers(ctx, time.Now().UTC(), lister); err != nil || fired != 0 {
		t.Fatalf("tick = (%d, %v), want no fire on an empty list", fired, err)
	}
	if len(lister.tokens) != 1 || lister.tokens[0] != want {
		t.Fatalf("recorded tokens = %q, want exactly [%q]", lister.tokens, want)
	}

	// Clear the credential, make the trigger due again, and the same poll is
	// anonymous.
	if _, err := f.pool.Exec(ctx,
		`UPDATE repositories SET credential_secret_id = NULL WHERE id = $1::uuid`, f.repository); err != nil {
		t.Fatalf("clear credential: %v", err)
	}
	if _, err := f.pool.Exec(ctx,
		`UPDATE issue_triggers SET last_polled_at = NULL WHERE project_id = $1::uuid`, f.projectID); err != nil {
		t.Fatalf("reset poll cursor: %v", err)
	}
	if fired, err := f.triggers.TickIssueTriggers(ctx, time.Now().UTC(), lister); err != nil || fired != 0 {
		t.Fatalf("anonymous tick = (%d, %v), want no fire", fired, err)
	}
	if len(lister.tokens) != 2 || lister.tokens[1] != "" {
		t.Fatalf("recorded tokens = %q, want the second one empty (anonymous)", lister.tokens)
	}
}

// TestIssueTriggerCredentialFailureLandsLastError: a credential that will not
// resolve (revoked here) fails the poll onto the row's last_error, names the
// repository, and never reaches GitHub anonymously.
func TestIssueTriggerCredentialFailureLandsLastError(t *testing.T) {
	ctx := testCtx(t)
	f := itSetup(t)
	f.itDropTriggers(t, ctx)
	trigger, err := f.itIssueFires(ctx, "opened", []string{}, json.RawMessage(`{}`), nil)
	if err != nil {
		t.Fatalf("itIssueFires: %v", err)
	}
	store, _ := itSeedCredentialSecret(t, f)
	f.triggers.Credentials = store
	secretID := ""
	if err := f.pool.QueryRow(ctx,
		`SELECT credential_secret_id::text FROM repositories WHERE id = $1::uuid`, f.repository).Scan(&secretID); err != nil {
		t.Fatalf("read credential id: %v", err)
	}
	if _, err := store.RevokeSecret(ctx, f.caller, f.projectID, secretID); err != nil {
		t.Fatalf("revoke: %v", err)
	}

	lister := &itRecordingLister{inner: newITIssueLister(nil, nil)}
	defer lister.Close()
	if fired, err := f.triggers.TickIssueTriggers(ctx, time.Now().UTC(), lister); err != nil || fired != 0 {
		t.Fatalf("tick = (%d, %v), want a green tick with no fire", fired, err)
	}
	if len(lister.tokens) != 0 {
		t.Errorf("GitHub was polled after a failed credential resolve: %q", lister.tokens)
	}
	var lastErr string
	if err := f.pool.QueryRow(ctx,
		`SELECT COALESCE(last_error, '') FROM issue_triggers WHERE id = $1::uuid`, trigger.ID).Scan(&lastErr); err != nil {
		t.Fatalf("read last_error: %v", err)
	}
	if !strings.Contains(lastErr, "credential") || !strings.Contains(lastErr, "octo/widgets") {
		t.Errorf("last_error = %q, want it to name the credential and the repository", lastErr)
	}

	// A replica that wired no secret store answers the same fail-closed way
	// rather than polling a credentialed repository anonymously.
	unwired := &IssueTriggerStore{Pool: f.pool, Runs: f.runs}
	if _, err := f.pool.Exec(ctx,
		`UPDATE issue_triggers SET last_polled_at = NULL, last_error = '' WHERE id = $1::uuid`, trigger.ID); err != nil {
		t.Fatalf("reset trigger: %v", err)
	}
	if _, err := f.pool.Exec(ctx,
		`UPDATE repositories SET credential_secret_id = $2::uuid WHERE id = $1::uuid`, f.repository, secretID); err != nil {
		t.Fatalf("restore credential: %v", err)
	}
	if fired, err := unwired.TickIssueTriggers(ctx, time.Now().UTC(), lister); err != nil || fired != 0 {
		t.Fatalf("unwired tick = (%d, %v), want no fire and no tick error", fired, err)
	}
	if err := f.pool.QueryRow(ctx,
		`SELECT COALESCE(last_error, '') FROM issue_triggers WHERE id = $1::uuid`, trigger.ID).Scan(&lastErr); err != nil {
		t.Fatalf("read last_error: %v", err)
	}
	if !strings.Contains(lastErr, "secret store") {
		t.Errorf("unwired last_error = %q, want it to name the missing secret store", lastErr)
	}
}

// ------------------------- ADR-0056 amendment (2026-10-25): typed placeholders

// itPublishPlan publishes another revision of the fixture pipeline whose
// compiled plan DECLARES `spec.inputs` (the real draft → validate → publish
// path, as the schedule tests' m6PublishInputs does) and re-pins the fixture's
// assignment to it. The typed-template tests need a revision that has something
// to say no about: the default fixture plan is `{"nodes":[]}`, which admits
// every trigger input unchecked.
func (f *itFixture) itPublishPlan(t *testing.T, ctx context.Context, versionLabel string, inputs json.RawMessage) string {
	t.Helper()
	digest := m4Digest("rev/typed/" + migFixtureToken(t) + "/" + versionLabel)
	doc := fmt.Sprintf("apiVersion: communication.dev/v1alpha1\nkind: Pipeline\n# %s\n", digest)
	canonical := json.RawMessage(fmt.Sprintf(
		`{"apiVersion":"communication.dev/v1alpha1","kind":"Pipeline","marker":%q}`, digest))
	plan := json.RawMessage(fmt.Sprintf(`{"nodes":[],"inputs":%s}`, inputs))
	draft, err := f.pipelines.CreateDraft(ctx, NewDraft{
		PipelineID: f.pipelineID, DocumentText: doc, SourceKind: "manual",
		SourceSHA256: m4Hex("src/" + digest), EditedBy: f.userID,
	})
	if err != nil {
		t.Fatalf("CreateDraft: %v", err)
	}
	if _, err := f.pipelines.RecordValidation(ctx, draft.ID, "valid", DraftValidation{
		CanonicalDocument: canonical, RevisionDigest: digest,
		CompiledPlan: plan, PlanDigest: m4Digest("plan-of/" + digest),
		Validation: json.RawMessage(`[]`),
	}); err != nil {
		t.Fatalf("RecordValidation: %v", err)
	}
	rev, err := f.pipelines.PublishDraft(ctx, draft.ID, NewRevision{
		VersionLabel: versionLabel, DocumentText: doc,
		SchemaDigest: m4Digest("schema"), CelEnvDigest: m4Digest("celenv"),
		PublishedBy: f.userID, ExpectedDraftVersion: draft.Version,
	})
	if err != nil {
		t.Fatalf("PublishDraft %s: %v", versionLabel, err)
	}
	if _, err := f.pool.Exec(ctx,
		`UPDATE assignments SET pinned_revision_id = $2 WHERE id = $1::uuid`, f.assignment, rev.ID); err != nil {
		t.Fatalf("re-pin the assignment: %v", err)
	}
	return rev.ID
}

// itIssueInputRaw reads one stored run input as its JSON text plus its jsonb
// type — the pair that tells the number 42 from the string "42".
func itIssueInputRaw(t *testing.T, ctx context.Context, f *itFixture, runID, name string) (string, string) {
	t.Helper()
	var value, kind string
	if err := f.pool.QueryRow(ctx,
		`SELECT value::text, jsonb_typeof(value) FROM run_inputs WHERE run_id = $1::uuid AND name = $2`,
		runID, name).Scan(&value, &kind); err != nil {
		t.Fatalf("read the fired run's %q input: %v", name, err)
	}
	return value, kind
}

// itIssueToPRInputs declares the shipped template's shape: an integer
// `issue_number` and a string `goal` (ui/src/lib/pipeline/templates/
// issue-to-pr.yaml.txt).
const itIssueToPRInputs = `{"type":"object","required":["issue_number","goal"],"properties":{` +
	`"issue_number":{"type":"integer","minimum":0},"goal":{"type":"string","minLength":1}}}`

// itRefusedInteger is the shape both write paths answer with: the shared
// validator's per-input `invalid_input` for issue_number (its required arm may
// ride along, exactly as it does for a manual POST /runs carrying the same
// bad value).
func itRefusedInteger(errs []api.ValidateError) bool {
	for _, e := range errs {
		if e.Code == "invalid_input" && strings.Contains(e.Message, `"issue_number"`) &&
			strings.Contains(e.Message, "expected an integer") {
			return true
		}
	}
	return false
}

// TestIssueTriggerTypedPlaceholderFiresAsNumber: the amendment's promise, end
// to end against real Postgres. A trigger whose `issue_number` input is exactly
// `{{issue.number}}` is ACCEPTED against a revision declaring it integer
// (create validates what a fire would produce), the row keeps the raw template
// text, and the fire writes the JSON number 42 — not `"42"`. Mixed text next to
// it is still prose, so `goal` stays a string with its hole filled.
func TestIssueTriggerTypedPlaceholderFiresAsNumber(t *testing.T) {
	ctx := testCtx(t)
	f := itSetup(t)
	f.itDropTriggers(t, ctx)
	f.itPublishPlan(t, ctx, "2.0.0", json.RawMessage(itIssueToPRInputs))

	trigger, err := f.itIssueFires(ctx, "opened", []string{},
		json.RawMessage(`{"issue_number":"{{issue.number}}","goal":"Fix #{{issue.number}}: {{issue.title}}"}`), nil)
	if err != nil {
		t.Fatalf("create the integer-input trigger: %v", err)
	}
	var stored string
	if err := f.pool.QueryRow(ctx,
		`SELECT inputs::text FROM issue_triggers WHERE id = $1::uuid`, trigger.ID).Scan(&stored); err != nil {
		t.Fatalf("read the stored inputs: %v", err)
	}
	if !strings.Contains(stored, "{{issue.number}}") {
		t.Errorf("stored inputs = %s, want the raw template text, not a rendered value", stored)
	}

	issue := itWireIssue{Number: 42, Title: "Crash on boot", Body: "it crashes", State: "open",
		HTMLURL:   "https://github.com/octo/widgets/issues/42",
		CreatedAt: trigger.CreatedAt.Add(time.Hour).Format(time.RFC3339),
		UpdatedAt: trigger.CreatedAt.Add(2 * time.Hour).Format(time.RFC3339),
		Labels:    []itWireLabel{{Name: "bug"}}}
	lister := newITIssueLister([]itWireIssue{issue}, nil)
	defer lister.Close()
	fired, err := f.triggers.TickIssueTriggers(ctx, time.Now().UTC(), lister)
	if err != nil || fired != 1 {
		t.Fatalf("tick = (%d, %v), want one fire", fired, err)
	}

	runID, kind := itIssueRunFor(t, ctx, f, "octo/widgets#42")
	if kind != "issue" {
		t.Fatalf("fired run kind = %s, want issue", kind)
	}
	value, jsonKind := itIssueInputRaw(t, ctx, f, runID, "issue_number")
	if jsonKind != "number" || value != "42" {
		t.Errorf("run input issue_number = %s of jsonb type %s, want the JSON number 42", value, jsonKind)
	}
	value, jsonKind = itIssueInputRaw(t, ctx, f, runID, "goal")
	if jsonKind != "string" {
		t.Fatalf("run input goal = %s of jsonb type %s, want a JSON string", value, jsonKind)
	}
	var goal string
	if err := json.Unmarshal([]byte(value), &goal); err != nil {
		t.Fatalf("decode goal %q: %v", value, err)
	}
	if goal != "Fix #42: Crash on boot" {
		t.Errorf("goal = %q, want the mixed template rendered as text", goal)
	}
}

// TestIssueTriggerTypedPlaceholderRefusals: the other side of the same rule.
// A MIXED value (`#{{issue.number}}`) is text with a hole in it, so against an
// integer input it is the 422 it always was — at create AND at patch — and so
// is a whole placeholder that renders a string (`{{issue.title}}`) or plain
// prose: only the exact `{{issue.number}}` becomes a number.
func TestIssueTriggerTypedPlaceholderRefusals(t *testing.T) {
	ctx := testCtx(t)
	f := itSetup(t)
	f.itDropTriggers(t, ctx)
	f.itPublishPlan(t, ctx, "2.1.0", json.RawMessage(itIssueToPRInputs))

	for _, tc := range []struct {
		name   string
		inputs string
	}{
		{"mixed text", `{"issue_number":"#{{issue.number}}","goal":"go"}`},
		{"string placeholder", `{"issue_number":"{{issue.title}}","goal":"go"}`},
		{"not a number at all", `{"issue_number":"seven","goal":"go"}`},
	} {
		_, err := f.itIssueFires(ctx, "opened", []string{}, json.RawMessage(tc.inputs), nil)
		if err == nil {
			t.Fatalf("%s: create accepted %s against an integer input", tc.name, tc.inputs)
		}
		var invalid *api.RunInputsInvalid
		if !errors.As(err, &invalid) {
			t.Fatalf("%s: create error = %v, want the run-inputs 422", tc.name, err)
		}
		// The 422's Detail only counts the refusals; its per-input messages are
		// the ones that name issue_number, so that is what the assertion reads.
		if !itRefusedInteger(invalid.Errors) {
			t.Errorf("%s: create refusals = %+v, want issue_number refused with an integer mismatch", tc.name, invalid.Errors)
		}
	}

	// The typed binding is accepted; the same rule then refuses an edit AWAY
	// from it, so Update validates the rendered value and not the raw text too.
	good := json.RawMessage(`{"issue_number":"{{issue.number}}","goal":"go"}`)
	trigger, err := f.itIssueFires(ctx, "opened", []string{}, good, nil)
	if err != nil {
		t.Fatalf("create the typed trigger: %v", err)
	}
	bad := json.RawMessage(`{"issue_number":"#{{issue.number}}","goal":"go"}`)
	if _, err := f.triggers.UpdateIssueTrigger(ctx, UpdateIssueTriggerInput{
		ID: trigger.ID, ExpectedVersion: trigger.Version, Inputs: &bad,
	}); err == nil {
		t.Fatalf("update accepted a mixed template into an integer input")
	} else if invalid := (*api.RunInputsInvalid)(nil); !errors.As(err, &invalid) {
		t.Fatalf("update error = %v, want the run-inputs 422", err)
	} else if !itRefusedInteger(invalid.Errors) {
		t.Errorf("update refusals = %+v, want the integer refusal restated", invalid.Errors)
	}
	if _, err := f.triggers.UpdateIssueTrigger(ctx, UpdateIssueTriggerInput{
		ID: trigger.ID, ExpectedVersion: trigger.Version, Inputs: &good,
	}); err != nil {
		t.Errorf("update with the typed binding = %v, want it accepted", err)
	}
}
