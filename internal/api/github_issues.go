package api

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/dbirks/communication/internal/integrations/github"
)

// Read-only GitHub issue listing (ADR-0031, wishlist W3's read half).
//
// GET /api/v1/projects/{projectId}/repos/{repositoryId}/issues answers "what
// is in the tracker right now" so a run can be started from one of those
// issues. Everything about this route is deliberately narrow:
//
//   - It reads. No trigger, no webhook receiver, no invocation backlog, and
//     no `integration.query` node kind — those need the M6 tables and dedupe
//     (ADR-0031 § Consequences). The node kind stays in
//     `internal/pipelines/compiler`'s deferredKinds.
//   - It is anonymous upstream. The adapter (internal/integrations/github)
//     sends no token, so only public repositories answer, and GitHub's
//     unauthenticated budget is what bounds this route. A token would come
//     from the `SecretRef` path (ADR-0018), not from a new column and not
//     from the environment.
//   - It never stores what it reads. GitHub owns the issue data (`07`: "this
//     does not create a second generic issue tracker"); the rows behind this
//     response are not written anywhere, which is also why no migration is
//     involved.
//   - Authorization is the project's own: any member who can see the project
//     (viewer and up) may list its issues, because they can already see the
//     repository row and its `git_url`. A non-member gets the same 404 every
//     other project route gives, with the audit row ADR-0014 §3 requires.
//
// The repository is resolved from `ProjectStore.ListRepositories` — the same
// visibility-scoped read the `GET .../repos` route uses — so this route adds
// no datastore surface, and a `repositoryId` from another project is
// indistinguishable from one that never existed.

// GitHubIssueList is the openapi GitHubIssueList schema.
type GitHubIssueList struct {
	// Repository is the `owner/repo` the upstream call addressed, echoed so a
	// client can confirm which remote a `git_url` resolved to.
	Repository string `json:"repository"`
	// State and Label echo the effective query: state defaults to "open".
	State string        `json:"state"`
	Label string        `json:"label,omitempty"`
	Items []GitHubIssue `json:"items"`
}

// GitHubIssue is the openapi GitHubIssue schema.
type GitHubIssue struct {
	Number  int      `json:"number"`
	Title   string   `json:"title"`
	Body    string   `json:"body"`
	Labels  []string `json:"labels"`
	HTMLURL string   `json:"html_url"`
	State   string   `json:"state"`
	// UpdatedAt is GitHub's own timestamp. A body the adapter clipped says so
	// rather than silently reading short.
	UpdatedAt     time.Time `json:"updated_at"`
	BodyTruncated bool      `json:"body_truncated"`
}

// Machine-readable codes this route adds to the problem documents
// (ADR-0031). The `type` URI ends in the code and the `code` member repeats
// it, the ADR-0030 convention; clients switch on `code`.
const (
	// GitHubIssueCodeNotGitHub: the repository's `git_url` is not a GitHub
	// remote (GitLab, a self-hosted git, a `file://` path).
	GitHubIssueCodeNotGitHub = "not_a_github_repository"
	// GitHubIssueCodeNotFound: GitHub answered 404. For an anonymous request
	// that also covers "private", which is what the detail says.
	GitHubIssueCodeNotFound = "github_repository_not_found"
	// GitHubIssueCodeRateLimited: the anonymous budget is spent.
	GitHubIssueCodeRateLimited = "github_rate_limited"
	// GitHubIssueCodeUpstream: any other upstream failure, including the
	// 10 s timeout.
	GitHubIssueCodeUpstream = "github_upstream_error"
)

// RegisterGitHubIssues mounts the issue-listing route beside the repository
// routes. lister may be nil, in which case the route answers 503 rather than
// pretending a repository has no issues.
func RegisterGitHubIssues(s *Server, projects ProjectStore, lister github.IssueLister) {
	h := &ghHandlers{projects: projects, lister: lister, srv: s}
	s.HandleAuthed("GET /api/v1/projects/{projectId}/repos/{repositoryId}/issues",
		http.HandlerFunc(h.listIssues))
}

type ghHandlers struct {
	projects ProjectStore
	lister   github.IssueLister
	srv      *Server
}

func (h *ghHandlers) listIssues(w http.ResponseWriter, r *http.Request) {
	prj := &prjHandlers{store: h.projects, srv: h.srv}
	c, ok := prj.caller(w, r)
	if !ok {
		return
	}
	projectID := r.PathValue("projectId")
	repoID := r.PathValue("repositoryId")
	const action = "repository.issues.list"

	// Query validation runs before any lookup: a bad `state` is the client's
	// mistake and says nothing about whether the project exists.
	state := strings.TrimSpace(r.URL.Query().Get("state"))
	if state == "" {
		state = github.StateOpen
	}
	switch state {
	case github.StateOpen, github.StateClosed, github.StateAll:
	default:
		prjInvalid(w, "state must be open, closed or all.")
		return
	}
	label := strings.TrimSpace(r.URL.Query().Get("label"))

	repo, ok := h.repository(w, r, prj, c, projectID, repoID, action)
	if !ok {
		return
	}

	ghRepo, err := github.ParseRepository(repo.GitURL)
	if err != nil {
		// A 422 rather than a 404: the caller can see the repository row and
		// its git_url, so nothing is leaked by naming it.
		ghiProblem(w, http.StatusUnprocessableEntity, GitHubIssueCodeNotGitHub,
			"Not A GitHub Repository",
			"Repository \""+repo.Name+"\" is not a GitHub remote, so it has no GitHub issues to list.")
		return
	}
	if h.lister == nil {
		WriteProblem(w, http.StatusServiceUnavailable, "Not Configured",
			"Issue listing is not configured on this deployment.")
		return
	}

	issues, err := h.lister.ListIssues(r.Context(), ghRepo, github.IssueQuery{
		State: state,
		Label: label,
	})
	if err != nil {
		h.upstreamFailure(w, r, prj, c, projectID, action, ghRepo, err)
		return
	}

	view := GitHubIssueList{
		Repository: ghRepo.String(),
		State:      state,
		Label:      label,
		Items:      make([]GitHubIssue, 0, len(issues)),
	}
	for _, is := range issues {
		view.Items = append(view.Items, GitHubIssue{
			Number:        is.Number,
			Title:         is.Title,
			Body:          is.Body,
			Labels:        is.Labels,
			HTMLURL:       is.HTMLURL,
			State:         is.State,
			UpdatedAt:     is.UpdatedAt,
			BodyTruncated: is.BodyTruncated,
		})
	}
	w.Header().Set("Cache-Control", "no-store")
	WriteJSON(w, http.StatusOK, view)
}

// repository resolves the path's repositoryId through the caller-visible
// repository list, so both "no such repository" and "not your project" are
// the same 404 with an audit row.
func (h *ghHandlers) repository(w http.ResponseWriter, r *http.Request, prj *prjHandlers,
	c Caller, projectID, repoID, action string) (RepositoryView, bool) {
	repos, err := h.projects.ListRepositories(r.Context(), c, projectID)
	if err != nil {
		prj.fail(w, r, c, projectID, action, prjNoConflict, err)
		return RepositoryView{}, false
	}
	for _, repo := range repos {
		if repo.ID == repoID {
			return repo, true
		}
	}
	prj.denied(w, r, c, projectID, action, "no such repository in this project")
	WriteProblem(w, http.StatusNotFound, "Not Found", "No such repository in this project.")
	return RepositoryView{}, false
}

// upstreamFailure turns an adapter error into the 5xx contract. Everything
// upstream is 502 — the request was well-formed and authorized, and the
// failure belongs to github.com — but the code says which failure, because
// "spend your rate budget again in an hour" and "that repo is private" need
// different answers from a retry.
func (h *ghHandlers) upstreamFailure(w http.ResponseWriter, r *http.Request, prj *prjHandlers,
	c Caller, projectID, action string, repo github.Repository, err error) {
	log := prj.log(r)
	switch {
	case errors.Is(err, github.ErrRepositoryNotFound):
		log.WarnContext(r.Context(), "github reported the repository missing",
			slog.String("repository", repo.String()),
			slog.String("project_id", projectID),
			slog.String("request_id", RequestIDFrom(r)))
		ghiProblem(w, http.StatusBadGateway, GitHubIssueCodeNotFound, "GitHub Repository Not Found",
			"GitHub has no readable repository at \""+repo.String()+"\". An anonymous request cannot read a private repository.")
		return
	case errors.Is(err, github.ErrRateLimited):
		var rl *github.RateLimitError
		detail := "GitHub's anonymous API budget is exhausted for this replica. Token-backed requests are not yet supported (ADR-0031)."
		if errors.As(err, &rl) && !rl.Reset.IsZero() {
			detail += " Budget resets at " + rl.Reset.Format(time.RFC3339) + "."
		}
		log.WarnContext(r.Context(), "github rate limited the anonymous issue query",
			slog.String("repository", repo.String()),
			slog.String("project_id", projectID),
			slog.String("request_id", RequestIDFrom(r)))
		ghiProblem(w, http.StatusBadGateway, GitHubIssueCodeRateLimited, "GitHub Rate Limited", detail)
		return
	default:
		log.ErrorContext(r.Context(), "github issue query failed",
			slog.String("repository", repo.String()),
			slog.String("project_id", projectID),
			slog.String("request_id", RequestIDFrom(r)),
			slog.Any("error", err))
		ghiProblem(w, http.StatusBadGateway, GitHubIssueCodeUpstream, "Bad Gateway",
			"The server could not read issues from GitHub. Use the request id when reporting it.")
	}
}

// ghiProblem writes the problem+json every refusal on this route shares: the
// four Problem fields, the stable code, and a `type` URI ending in that code.
func ghiProblem(w http.ResponseWriter, status int, code, title, detail string) {
	h := w.Header()
	h.Set("Content-Type", ProblemJSON)
	h.Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(struct {
		Type   string `json:"type"`
		Title  string `json:"title"`
		Status int    `json:"status"`
		Detail string `json:"detail,omitempty"`
		Code   string `json:"code"`
	}{
		Type:   "https://communication.dev/errors/" + code,
		Title:  title,
		Status: status,
		Detail: detail,
		Code:   code,
	})
}
