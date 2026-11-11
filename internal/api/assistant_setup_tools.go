package api

// Assistant handoff §6 (CONTRACT §5): the setup reads, answered as the caller.
//
// Every method here is a store read the user's own routes already serve, called
// with this Caller — the assistant sees what the person sees and nothing wider
// (ADR-0050 decision 4, spec 08 "one control source"). Three rules are structural
// rather than disciplined:
//
//   - No value. The credential rows come from `SecretView`, the metadata-only
//     half of ADR-0018's SecretRef, which has no field a value could occupy. The
//     one plaintext this file ever touches is the token `repo.check` resolves to
//     make one GitHub call; it is a local, handed to the adapter and dropped —
//     never a row, never an error string, never in the payload.
//   - A credential is used the ADR-0061 way or not at all. The resolver is
//     keyed by a REPOSITORY ROW, because that row — not a name, not a caller —
//     is what authorizes a broker secret. `repo.check` therefore prefers a
//     repository the caller can see that already references the credential,
//     and falls back to ResolveSecretForCheck (handoff § 6's add-a-repo flow
//     checks BEFORE the repository exists) only for a visible git-credential
//     secret the caller may attach somewhere. Either way a credential that
//     will not open is reported as unreachable rather than retried anonymously
//     (a private tracker answers "not found" to an anonymous request, which
//     teaches everyone the wrong lesson).
//   - A non-GitHub URL is `assistant.ErrNotFound`: the 404 rule, no rows and no
//     name, so the refusal cannot be an existence oracle for anything.

import (
	"context"
	"encoding/json"
	"regexp"
	"sort"
	"strings"
	"time"

	as "github.com/dbirks/communication/internal/assistant"
	"github.com/dbirks/communication/internal/integrations/github"
)

// The narrow read faces the §6 tools are built from. Each is one route's
// method set, named here because api owns its seams.
type (
	assistantSetupProjects interface {
		asProjectsLister
		ListRepositories(ctx context.Context, c Caller, projectID string) ([]RepositoryView, error)
	}
	assistantSetupSecrets interface {
		ListSecrets(ctx context.Context, c Caller, projectID string) ([]SecretView, error)
	}
	// assistantNamedCredentialResolver opens a VISIBLE git-credential secret
	// for a check when no repository row references it yet (handoff § 6: the
	// add-a-repo flow runs repo.check before the repository exists). The store
	// half answers visibility, purpose and the attach-role question and audits
	// the read like every other resolve; postgres.APISecretStore is the
	// implementation, the seam lives here because api owns its seams.
	assistantNamedCredentialResolver interface {
		ResolveSecretForCheck(ctx context.Context, c Caller, secretID, consumer string) (string, error)
	}
	assistantSetupPipelines interface {
		ListPipelines(ctx context.Context, c Caller) ([]PipelineSummaryView, error)
		GetPipeline(ctx context.Context, c Caller, pipelineID string) (PipelineView, error)
		ListPipelineRevisions(ctx context.Context, c Caller, pipelineID string) ([]RevisionSummaryView, error)
	}
	assistantSetupAssignments interface {
		ListAssignments(ctx context.Context, c Caller, projectID string, f AssignmentListFilter) ([]AssignmentView, error)
	}
	assistantSetupProfiles interface {
		ListAgentProfiles(ctx context.Context, c Caller) ([]AgentProfileView, error)
	}
	assistantSetupSchedules interface {
		ListProjectSchedules(ctx context.Context, c Caller, projectID string) ([]ScheduleView, error)
	}
)

// assistantSetupTools is internal/assistant.SetupReader over the real stores.
type assistantSetupTools struct {
	projects    assistantSetupProjects
	repos       assistantSetupProjects
	secrets     assistantSetupSecrets
	pipelines   assistantSetupPipelines
	assignments assistantSetupAssignments
	profiles    assistantSetupProfiles
	schedules   assistantSetupSchedules
	credentials RepositoryCredentialResolver
	// namedCredentials is the § 6 fallback for a credential no repository
	// uses yet; nil keeps that path closed (row-only, the old answer).
	namedCredentials assistantNamedCredentialResolver
	repoGet          github.RepoGetter
	issues           github.IssueLister
}

// AssistantSetupDeps is the wiring: the caller-scoped reads plus the two
// GitHub seams. A nil face keeps its tool answering `not_found` — but the
// constructor refuses to return a reader at all when the caller-scoped half
// that every tool needs is missing, so an unwired deployment simply never
// announces the tool (the honest-degradation rule).
type AssistantSetupDeps struct {
	Projects    assistantSetupProjects
	Secrets     assistantSetupSecrets
	Pipelines   assistantSetupPipelines
	Assignments assistantSetupAssignments
	Profiles    assistantSetupProfiles
	Schedules   assistantSetupSchedules
	// Credentials and Repos are the ADR-0061 resolve pair `repo.check` uses;
	// RepoGet and IssueLister are the GitHub calls themselves. Without them
	// the two integration tools answer `not_found` and every other read
	// still works.
	Credentials RepositoryCredentialResolver
	// NamedCredentials unlocks `repo.check` with a credential no repository
	// references yet (handoff § 6 step 2, checked before the repository is
	// added). Without it that case keeps the old answer: reachable:false.
	NamedCredentials assistantNamedCredentialResolver
	RepoGet          github.RepoGetter
	IssueLister      github.IssueLister
}

// NewAssistantSetupReader builds the reader, or nil when this deployment has
// no caller-scoped project list (the one face every §6 read fans out from).
func NewAssistantSetupReader(d AssistantSetupDeps) as.SetupReader {
	if d.Projects == nil {
		return nil
	}
	t := &assistantSetupTools{
		projects: d.Projects, repos: d.Projects, secrets: d.Secrets,
		pipelines: d.Pipelines, assignments: d.Assignments, profiles: d.Profiles,
		schedules: d.Schedules, credentials: d.Credentials,
		namedCredentials: d.NamedCredentials,
		repoGet:          d.RepoGet, issues: d.IssueLister,
	}
	return t
}

// --- credential.list ----------------------------------------------------

// assistantCredentialRow is CONTRACT §5's row: name (the secret's slug), kind,
// scope, and the projects that actually use it. There is no field that could
// hold a value and none may be added.
type assistantCredentialRow struct {
	Name   string   `json:"name"`
	Kind   string   `json:"kind"`
	Scope  string   `json:"scope"`
	UsedBy []string `json:"used_by"`
}

func (t *assistantSetupTools) CredentialList(ctx context.Context, c as.Caller) (json.RawMessage, error) {
	if t.secrets == nil {
		return nil, as.ErrNotFound
	}
	caller := ac(c)
	projects, err := t.listProjects(ctx, caller)
	if err != nil {
		return nil, asstStoreErr(err)
	}
	byID := map[string]*assistantCredentialRow{}
	order := []string{}
	for _, p := range projects {
		seen, err := t.secrets.ListSecrets(ctx, caller, p.ID)
		if err != nil {
			return nil, asstStoreErr(err)
		}
		for _, sec := range seen {
			if !assistantGitHubCredential(sec) {
				continue
			}
			row, ok := byID[sec.ID]
			if !ok {
				row = &assistantCredentialRow{
					Name: sec.Slug, Kind: assistantCredentialKind(sec), Scope: sec.Scope,
					UsedBy: []string{},
				}
				byID[sec.ID] = row
				order = append(order, sec.ID)
			}
		}
	}
	// `used_by` is the repository rows, not a claim about a secret: a
	// credential no repository names is set up but unused, which is the
	// answer the setup checklist is looking for.
	if t.repos != nil {
		for _, p := range projects {
			repos, err := t.repos.ListRepositories(ctx, caller, p.ID)
			if err != nil {
				return nil, asstStoreErr(err)
			}
			for _, repo := range repos {
				if repo.CredentialSecretID == nil {
					continue
				}
				row, ok := byID[*repo.CredentialSecretID]
				if !ok {
					continue
				}
				row.UsedBy = appendUnique(row.UsedBy, setupFallback(p.Slug, p.ID))
			}
		}
	}
	out := make([]assistantCredentialRow, 0, len(order))
	for _, id := range order {
		out = append(out, *byID[id])
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return asstJSON(out)
}

// assistantCredentialKind says what a visible GitHub credential is, in the two
// words a reader wants: a broker secret is the platform's own GitHub
// credential; anything else matched on the purpose text is a git credential.
func assistantCredentialKind(sec SecretView) string {
	if strings.EqualFold(strings.TrimSpace(sec.Delivery), "integration_broker") {
		return "github"
	}
	return "git"
}

// --- workflow.list / workflow.inspect -----------------------------------

// assistantWorkflowRow is CONTRACT §5's row. `sample` is the same signal the
// status read uses (this build ships a closed set of sample slugs, and no row
// records "installed as a sample"), and `assigned_to` names project SLUGS —
// the reader's vocabulary, not a uuid.
type assistantWorkflowRow struct {
	ID             string   `json:"id"`
	Slug           string   `json:"slug"`
	Name           string   `json:"name"`
	LatestRevision int      `json:"latest_revision"`
	Sample         bool     `json:"sample"`
	AssignedTo     []string `json:"assigned_to"`
	// CreatedAt/UpdatedAt answer "when did this workflow last move?" — the
	// exercise's prompt 18 could only say "nothing published, nothing
	// assigned" because the row carried no date (F-6 remainder). UpdatedAt
	// is the pipeline store's own clock (migration 00034): create, draft
	// save, publish, deprecation, assignment change all stamp it.
	CreatedAt string `json:"created_at,omitempty"`
	UpdatedAt string `json:"updated_at,omitempty"`
}

// assistantWorkflowDetail is workflow.inspect: the row above plus the
// revisions and the pins. `revisions_total` is the honest count when the list
// is capped.
type assistantWorkflowDetail struct {
	Pipeline       assistantWorkflowRow     `json:"pipeline"`
	Revisions      []assistantRevisionRow   `json:"revisions"`
	RevisionsTotal int                      `json:"revisions_total"`
	Assignments    []assistantAssignmentRow `json:"assignments"`
}

// maxInspectRevisions bounds how many revisions one inspect payload carries:
// a long history is read on the workflow's own page, and the tool result has a
// byte cap to respect.
const maxInspectRevisions = 10

type assistantRevisionRow struct {
	Revision     int    `json:"revision"`
	VersionLabel string `json:"version_label,omitempty"`
	Status       string `json:"status,omitempty"`
	PublishedAt  string `json:"published_at,omitempty"`
}

type assistantAssignmentRow struct {
	Project      string `json:"project"`
	Repository   string `json:"repository,omitempty"`
	PinnedLabel  string `json:"pinned_version_label,omitempty"`
	PinnedDigest string `json:"pinned_revision_digest,omitempty"`
	Enabled      bool   `json:"enabled"`
}

func (t *assistantSetupTools) WorkflowList(ctx context.Context, c as.Caller) (json.RawMessage, error) {
	if t.pipelines == nil {
		return nil, as.ErrNotFound
	}
	caller := ac(c)
	pipelines, err := t.pipelines.ListPipelines(ctx, caller)
	if err != nil {
		return nil, asstStoreErr(err)
	}
	assigned, err := t.assignmentsByPipeline(ctx, caller)
	if err != nil {
		return nil, err
	}
	out := make([]assistantWorkflowRow, 0, len(pipelines))
	for _, p := range pipelines {
		// assigned_to is always an array: "no project pins it" is an answer,
		// and a null is an absence the model would have to invent a meaning for.
		slugs := assigned[p.ID]
		if slugs == nil {
			slugs = []string{}
		}
		out = append(out, assistantWorkflowRow{
			ID: p.ID, Slug: p.Slug, Name: p.DisplayName,
			LatestRevision: p.LatestRevisionNumber,
			Sample:         sampleWorkflowSlugs[strings.TrimSpace(p.Slug)],
			AssignedTo:     slugs,
			CreatedAt:      assistantFormatTime(p.CreatedAt),
			UpdatedAt:      assistantFormatTime(p.UpdatedAt),
		})
	}
	return asstJSON(out)
}

func (t *assistantSetupTools) WorkflowInspect(ctx context.Context, c as.Caller,
	pipelineID string) (json.RawMessage, error) {
	if t.pipelines == nil || strings.TrimSpace(pipelineID) == "" {
		return nil, as.ErrNotFound
	}
	caller := ac(c)
	view, err := t.pipelines.GetPipeline(ctx, caller, pipelineID)
	if err != nil {
		return nil, asstStoreErr(err)
	}
	revs, err := t.pipelines.ListPipelineRevisions(ctx, caller, view.ID)
	if err != nil {
		return nil, asstStoreErr(err)
	}
	assigned, err := t.assignmentsByPipeline(ctx, caller)
	if err != nil {
		return nil, err
	}
	detail := assistantWorkflowDetail{
		Pipeline: assistantWorkflowRow{
			ID: view.ID, Slug: view.Slug, Name: view.DisplayName,
			LatestRevision: view.LatestRevisionNumber,
			Sample:         sampleWorkflowSlugs[strings.TrimSpace(view.Slug)],
			AssignedTo:     assigned[view.ID],
			CreatedAt:      assistantFormatTime(view.CreatedAt),
			UpdatedAt:      assistantFormatTime(view.UpdatedAt),
		},
		Revisions:      make([]assistantRevisionRow, 0, maxInspectRevisions),
		RevisionsTotal: len(revs),
	}
	if detail.Pipeline.AssignedTo == nil {
		detail.Pipeline.AssignedTo = []string{}
	}
	for i, r := range revs {
		if i >= maxInspectRevisions {
			break
		}
		detail.Revisions = append(detail.Revisions, assistantRevisionRow{
			Revision:     r.RevisionNumber,
			VersionLabel: r.VersionLabel,
			Status:       r.Status,
			PublishedAt:  assistantFormatTime(r.PublishedAt),
		})
	}
	// The pins come from the same per-project read workflow.list uses, so the
	// two tools cannot disagree about who uses a workflow.
	pins, err := t.pinsForPipeline(ctx, caller, view.ID)
	if err != nil {
		return nil, err
	}
	detail.Assignments = pins
	return asstJSON(detail)
}

// assignmentsByPipeline is the caller's whole assignment view grouped by
// pipeline, with the project SLUG as the value: the fan is one read per
// visible project, which is the fan every project-scoped assistant read uses.
func (t *assistantSetupTools) assignmentsByPipeline(ctx context.Context, c Caller) (map[string][]string, error) {
	out := map[string][]string{}
	if t.assignments == nil {
		return out, nil
	}
	projects, err := t.listProjects(ctx, c)
	if err != nil {
		return nil, asstStoreErr(err)
	}
	for _, p := range projects {
		items, err := t.assignments.ListAssignments(ctx, c, p.ID, AssignmentListFilter{})
		if err != nil {
			return nil, asstStoreErr(err)
		}
		slug := setupFallback(p.Slug, p.ID)
		for _, a := range items {
			list := out[a.PipelineID]
			if containsSlug(list, slug) {
				continue
			}
			out[a.PipelineID] = append(list, slug)
		}
	}
	return out, nil
}

func (t *assistantSetupTools) pinsForPipeline(ctx context.Context, c Caller,
	pipelineID string) ([]assistantAssignmentRow, error) {
	out := []assistantAssignmentRow{}
	if t.assignments == nil {
		return out, nil
	}
	projects, err := t.listProjects(ctx, c)
	if err != nil {
		return nil, asstStoreErr(err)
	}
	for _, p := range projects {
		items, err := t.assignments.ListAssignments(ctx, c, p.ID, AssignmentListFilter{})
		if err != nil {
			return nil, asstStoreErr(err)
		}
		for _, a := range items {
			if a.PipelineID != pipelineID {
				continue
			}
			row := assistantAssignmentRow{
				Project: setupFallback(p.Slug, p.ID),
				Enabled: a.Enabled,
			}
			if a.RepositoryName != nil {
				row.Repository = *a.RepositoryName
			}
			if a.PinnedVersionLabel != nil {
				row.PinnedLabel = *a.PinnedVersionLabel
			}
			row.PinnedDigest = shortDigest(a.PinnedRevisionDigest)
			out = append(out, row)
		}
	}
	return out, nil
}

// --- repo.check ---------------------------------------------------------

// assistantRepoCheck is CONTRACT §5's payload, exactly: five fields, and no
// room for a token in any of them.
type assistantRepoCheck struct {
	Repo          string `json:"repo"`
	Reachable     bool   `json:"reachable"`
	DefaultBranch string `json:"default_branch"`
	CanPush       bool   `json:"can_push"`
	Credential    string `json:"credential"`
}

// bareRepo is the `owner/repo` form the assistant accepts: two segments, no
// scheme, no host, no `.git` need. It is a convenience for a pasted slug, and
// the ONLY form here that github.ParseRepository (a remote parser) refuses.
var bareRepo = regexp.MustCompile(`^[A-Za-z0-9._-]{1,100}/[A-Za-z0-9._-]{1,100}$`)

func (t *assistantSetupTools) RepoCheck(ctx context.Context, c as.Caller, url, credential string) (json.RawMessage, error) {
	caller := ac(c)
	repo, err := assistantParseRepo(url)
	if err != nil {
		return nil, err // already the 404 rule
	}
	if t.repoGet == nil {
		return nil, as.ErrNotFound
	}
	// The credential this call may use, and the repository row that authorizes
	// it. Empty means the check runs anonymously, which is the honest answer
	// for a public repository and a reachable:false for a private one.
	token, used, err := t.assistantCredentialToken(ctx, caller, repo.String(), credential)
	if err != nil {
		return nil, err
	}
	out := assistantRepoCheck{
		Repo:       repo.String(),
		Credential: used,
		// A named credential that exists but could not be opened is NOT a
		// reachable repository: the alternative is an anonymous retry that
		// answers "not found" about a tracker the caller can see.
	}
	if used != "" && token == "" {
		return asstJSON(out)
	}
	info, gerr := t.repoGet.GetRepo(ctx, repo, token)
	if gerr != nil {
		// Any upstream failure is the same honest answer: unreachable. The
		// error's own text may name a rate budget or a token class the caller
		// has no use for, so it stops here.
		return asstJSON(out)
	}
	out.Reachable = true
	if info.FullName != "" {
		out.Repo = info.FullName
	}
	out.DefaultBranch = info.DefaultBranch
	out.CanPush = info.CanPush
	return asstJSON(out)
}

// assistantParseRepo accepts what the tool's own description promises: a git
// remote (https, ssh, scp-style) or a bare `owner/repo`, in every case only on
// github.com — an Enterprise or GitLab host is refused, because this adapter
// speaks to api.github.com and nothing else.
func assistantParseRepo(url string) (github.Repository, error) {
	s := strings.TrimSpace(url)
	if s == "" {
		return github.Repository{}, as.ErrNotFound
	}
	if !strings.Contains(s, "://") && !strings.Contains(s, "@") && !strings.Contains(s, ":") {
		if !bareRepo.MatchString(s) {
			return github.Repository{}, as.ErrNotFound
		}
		s = "https://github.com/" + strings.TrimSuffix(s, ".git")
	}
	repo, err := github.ParseRepository(s)
	if err != nil {
		return github.Repository{}, as.ErrNotFound
	}
	return repo, nil
}

// ghConsumerRepoCheck names `repo.check`'s ADR-0061 integration consumer. It
// repeats the internal/secrets constant rather than importing it (the same
// arrangement ghConsumerIssueRead uses): the HTTP layer does not depend on
// the crypto package.
const ghConsumerRepoCheck = "assistant_repo_check"

// assistantCredentialToken resolves the credential for a repository check the
// ADR-0061 way: the name (or the only visible GitHub credential) selects a
// secret, and a repository row the caller can see that references THAT secret
// authorizes the resolve. When NO visible repository references it — the
// handoff § 6 add-a-repo case, where the check runs before the row exists —
// NamedCredentials answers under its own audited authorization (visibility +
// purpose + attach role), still server-side. token is empty and used names
// the credential when it was found but cannot be opened — the caller's answer
// is then `reachable: false`, never an anonymous retry.
func (t *assistantSetupTools) assistantCredentialToken(ctx context.Context, c Caller,
	wantRepo, credential string) (token string, used string, err error) {
	if t.secrets == nil {
		return "", "", nil
	}
	projects, err := t.listProjects(ctx, c)
	if err != nil {
		return "", "", asstStoreErr(err)
	}
	type candidate struct {
		id, slug string
	}
	var found []candidate
	// repoCredential names the repository row that authorizes a resolve for a
	// given secret id (ADR-0061: the row is the authority, never the name).
	repoCredential := map[string]string{}
	if t.repos != nil {
		for _, p := range projects {
			repos, rerr := t.repos.ListRepositories(ctx, c, p.ID)
			if rerr != nil {
				return "", "", asstStoreErr(rerr)
			}
			for _, repo := range repos {
				if repo.CredentialSecretID != nil && *repo.CredentialSecretID != "" {
					if _, ok := repoCredential[*repo.CredentialSecretID]; !ok {
						repoCredential[*repo.CredentialSecretID] = repo.ID
					}
				}
			}
		}
	}
	needle := strings.ToLower(strings.TrimSpace(credential))
	for _, p := range projects {
		secrets, serr := t.secrets.ListSecrets(ctx, c, p.ID)
		if serr != nil {
			return "", "", asstStoreErr(serr)
		}
		for _, sec := range secrets {
			if !assistantGitHubCredential(sec) || sec.RevokedAt != nil {
				continue
			}
			if needle != "" && strings.ToLower(sec.Slug) != needle {
				continue
			}
			found = append(found, candidate{id: sec.ID, slug: sec.Slug})
		}
	}
	// A named credential that is not visible (or is not a GitHub credential)
	// is the 404 rule: the caller may not know it exists.
	if needle != "" && len(found) == 0 {
		return "", "", as.ErrNotFound
	}
	// Nothing named and several to choose from is a decision the model does
	// not get to make by accident: the check runs anonymously, and the answer
	// names no credential.
	if needle == "" && len(found) != 1 {
		return "", "", nil
	}
	pick := found[0]
	repoID, ok := repoCredential[pick.id]
	if !ok {
		// No visible repository references it. A resolver wired for it (§ 6)
		// may still open it — audited, under visibility + purpose + attach
		// role; without one, reachable:false with the name is the whole
		// truthful answer, unchanged.
		if t.namedCredentials == nil {
			return "", pick.slug, nil
		}
		tok, nerr := t.namedCredentials.ResolveSecretForCheck(ctx, c, pick.id, ghConsumerRepoCheck)
		if nerr != nil {
			return "", pick.slug, nil
		}
		return tok, pick.slug, nil
	}
	if t.credentials == nil {
		return "", pick.slug, nil
	}
	tok, rerr := t.credentials.ResolveRepositoryCredential(ctx, repoID, ghConsumerIssueRead, c.UserID)
	if rerr != nil {
		return "", pick.slug, nil
	}
	return tok, pick.slug, nil
}

// --- issue.list ---------------------------------------------------------

// assistantIssueRow is the ADR-0031 listing reduced to what a conversation
// needs; the body stays on the route (it is the run-input half of that
// payload, and it is what would blow the tool result's byte cap).
type assistantIssueRow struct {
	Number  int      `json:"number"`
	Title   string   `json:"title"`
	State   string   `json:"state"`
	Labels  []string `json:"labels,omitempty"`
	HTMLURL string   `json:"html_url,omitempty"`
}

func (t *assistantSetupTools) IssueList(ctx context.Context, c as.Caller,
	projectID, repositoryID string) (json.RawMessage, error) {
	if t.issues == nil || strings.TrimSpace(projectID) == "" || strings.TrimSpace(repositoryID) == "" {
		return nil, as.ErrNotFound
	}
	caller := ac(c)
	// The repository is resolved through the caller's own repository list, so
	// another project's repository is indistinguishable from one that never
	// existed — the same rule the issue route applies.
	repos, err := t.listRepositories(ctx, caller, projectID)
	if err != nil {
		return nil, asstStoreErr(err)
	}
	var repo RepositoryView
	found := false
	for _, r := range repos {
		if r.ID == repositoryID {
			repo, found = r, true
			break
		}
	}
	if !found {
		return nil, as.ErrNotFound
	}
	ghRepo, perr := github.ParseRepository(repo.GitURL)
	if perr != nil {
		return nil, as.ErrNotFound
	}
	// The route's credential rule, restated: anonymous when the row names no
	// credential, and nothing at all rather than an anonymous pretence when it
	// names one that will not open.
	token := ""
	if repo.CredentialSecretID != nil && *repo.CredentialSecretID != "" {
		if t.credentials == nil {
			return nil, as.ErrNotFound
		}
		got, cerr := t.credentials.ResolveRepositoryCredential(ctx, repo.ID, ghConsumerIssueRead, c.UserID)
		if cerr != nil {
			return nil, as.ErrNotFound
		}
		token = got
	}
	items, gerr := t.issues.ListIssues(ctx, ghRepo, github.IssueQuery{State: github.StateOpen}, token)
	if gerr != nil {
		return nil, as.ErrNotFound
	}
	out := make([]assistantIssueRow, 0, len(items))
	for _, is := range items {
		out = append(out, assistantIssueRow{
			Number: is.Number, Title: is.Title, State: is.State,
			Labels: is.Labels, HTMLURL: is.HTMLURL,
		})
	}
	return asstJSON(out)
}

// --- profile.list / schedule.list ---------------------------------------

// assistantProfileRow is the launch descriptor the tool needs; the APM
// contents and the version history stay on the profile page.
type assistantProfileRow struct {
	ID             string `json:"id"`
	Name           string `json:"name"`
	Launcher       string `json:"launcher"`
	PermissionMode string `json:"permission_mode,omitempty"`
	Model          string `json:"model,omitempty"`
	Version        int    `json:"version"`
}

func (t *assistantSetupTools) ProfileList(ctx context.Context, c as.Caller) (json.RawMessage, error) {
	if t.profiles == nil {
		return nil, as.ErrNotFound
	}
	items, err := t.profiles.ListAgentProfiles(ctx, ac(c))
	if err != nil {
		return nil, asstStoreErr(err)
	}
	out := make([]assistantProfileRow, 0, len(items))
	for _, p := range items {
		row := assistantProfileRow{
			ID: p.ID, Name: p.Name, Launcher: p.LauncherID,
			PermissionMode: p.PermissionMode, Version: p.Version,
		}
		if p.Model != nil {
			row.Model = *p.Model
		}
		out = append(out, row)
	}
	return asstJSON(out)
}

// assistantScheduleRow is one schedules row in the reader's words.
type assistantScheduleRow struct {
	ID           string `json:"id"`
	ProjectID    string `json:"project_id"`
	AssignmentID string `json:"assignment_id"`
	Cron         string `json:"cron"`
	Enabled      bool   `json:"enabled"`
	NextRunAt    string `json:"next_run_at,omitempty"`
	LastRunAt    string `json:"last_run_at,omitempty"`
}

func (t *assistantSetupTools) ScheduleList(ctx context.Context, c as.Caller,
	projectID string) (json.RawMessage, error) {
	if t.schedules == nil || strings.TrimSpace(projectID) == "" {
		return nil, as.ErrNotFound
	}
	items, err := t.schedules.ListProjectSchedules(ctx, ac(c), projectID)
	if err != nil {
		return nil, asstStoreErr(err)
	}
	out := make([]assistantScheduleRow, 0, len(items))
	for _, s := range items {
		row := assistantScheduleRow{
			ID: s.ID, ProjectID: s.ProjectID, AssignmentID: s.AssignmentID,
			Cron: s.CronExpr, Enabled: s.Enabled, NextRunAt: assistantFormatTime(s.NextRunAt),
		}
		if s.LastRunAt != nil {
			row.LastRunAt = assistantFormatTime(*s.LastRunAt)
		}
		out = append(out, row)
	}
	return asstJSON(out)
}

// --- the shared helpers -------------------------------------------------

func (t *assistantSetupTools) listProjects(ctx context.Context, c Caller) ([]ProjectView, error) {
	if t.projects == nil {
		return nil, as.ErrNotFound
	}
	return t.projects.ListProjects(ctx, c)
}

func (t *assistantSetupTools) listRepositories(ctx context.Context, c Caller,
	projectID string) ([]RepositoryView, error) {
	if t.repos == nil {
		return nil, ErrProjectNotFound
	}
	return t.repos.ListRepositories(ctx, c, projectID)
}

// assistantFormatTime is the RFC3339 form a model reads back accurately; a zero
// time is the absence, and says so as an empty string.
func assistantFormatTime(t time.Time) string {
	if t.IsZero() {
		return ""
	}
	return t.UTC().Format(time.RFC3339)
}

// setupFallback is "the slug if there is one, the id if there is not": rows
// are named by their readable handle and an id is always present.
func setupFallback(s, alt string) string {
	if strings.TrimSpace(s) == "" {
		return alt
	}
	return s
}

func appendUnique(list []string, want string) []string {
	for _, have := range list {
		if have == want {
			return list
		}
	}
	return append(list, want)
}

func containsSlug(list []string, want string) bool {
	for _, have := range list {
		if have == want {
			return true
		}
	}
	return false
}

// shortDigest keeps a revision digest readable in a tool row without spending
// the whole payload budget on it; the workflow page names the full value.
func shortDigest(d string) string {
	d = strings.TrimSpace(d)
	if len(d) <= 16 {
		return d
	}
	return d[:16]
}

// asProjectsLister is the project-list half of assistantSetupProjects, split
// out so the interface below reads as one route's surface.
type asProjectsLister interface {
	ListProjects(ctx context.Context, c Caller) ([]ProjectView, error)
}
