package api

// The assistant handoff §6 (CONTRACT §5) setup writes: project.create,
// repo.add, assignment.set, run.cancel and schedule.create. Each executor
// runs the SAME permission-checked store call the matching UI route runs, as
// the caller — the assistant holds no service of its own, so a caller who
// could not make the request in the app cannot make it here either, and every
// role and visibility check stays inside the store (ADR-0050 decision 4).
//
// The rules:
//
//   - A denial is assistant.ErrActionDenied: the runner records the call
//     forbidden and the approval card stays pending (assistant_wiring.go's
//     `denied`), so nothing half-happens.
//   - Each action returns a ChangeRecord with its own kind (project_create |
//     repo_add | assignment_set | run_cancel | schedule_create), the ProjectID
//     it touched, and NO undo payload: none of these has a closed inverse (a
//     created project, an added repository, a re-pinned assignment, a
//     requested cancellation and a fired schedule are all forward-only), so the
//     change list says "can't be undone" (handoff §4).
//   - A credential travels by NAME only. It is resolved here, server-side,
//     against the metadata list the project's own Secrets route serves
//     (internal/api/secrets.go), and only the id is passed on. A value never
//     enters this conversation, and `credential.create` is not a tool at all:
//     the answer to "how do I add a token" is the Secrets form (ADR-0018).
//   - project.create keeps its project when the repository add fails: the ack
//     reports both halves, because the project row is real and deleting it to
//     make a tidy answer would be its own surprise.

import (
	"context"
	"errors"
	"fmt"
	"strings"

	as "github.com/dbirks/communication/internal/assistant"
	"github.com/dbirks/communication/internal/authz"
	"github.com/dbirks/communication/internal/pipelines/schedule"
)

// --- the narrow store faces (each optional, like every assistant seam) ---

// assistantProjectWrites is the project half of the setup writes: the
// POST /projects and POST /projects/{id}/repositories calls.
type assistantProjectWrites interface {
	CreateProject(ctx context.Context, c Caller, name, slug, description string) (ProjectView, error)
	AddRepository(ctx context.Context, c Caller, projectID, name, gitURL, defaultBranch, credentialSecretID string) (RepositoryView, error)
}

// assistantCredentialLister reads the secrets ONE project can see (its own
// plus the organization's), metadata only — SecretView has no field a value
// could occupy.
type assistantCredentialLister interface {
	ListSecrets(ctx context.Context, c Caller, projectID string) ([]SecretView, error)
}

// assistantRevisionLister is the promotion read: the caller's own pipeline
// revisions, and one revision's record behind a digest (RevisionSummaryView
// carries no id, and an assignment pins an id).
type assistantRevisionLister interface {
	ListPipelineRevisions(ctx context.Context, c Caller, pipelineID string) ([]RevisionSummaryView, error)
	GetRevision(ctx context.Context, c Caller, digestOrID string) (RevisionView, error)
}

// assistantAssignmentWrites is the assignment half of the setup writes: the
// project's pins (the read the run-start path already uses) plus
// POST /projects/{id}/assignments and the assignment lookup a schedule needs.
type assistantAssignmentWrites interface {
	ListAssignments(ctx context.Context, c Caller, projectID string, f AssignmentListFilter) ([]AssignmentView, error)
	CreateAssignment(ctx context.Context, c Caller, projectID string, in AssignmentCreateInput) (AssignmentView, error)
}

// assistantScheduleWriter is POST /projects/{id}/schedules.
type assistantScheduleWriter interface {
	CreateSchedule(ctx context.Context, c Caller, projectID string, in ScheduleCreateInput) (ScheduleView, error)
}

// assistantRunStopper is POST /runs/{id}/cancel, behind the caller's own read
// of the run (a run the caller cannot see is refused without being named).
type assistantRunStopper interface {
	GetRun(ctx context.Context, c Caller, runID string) (RunView, error)
	CancelRun(ctx context.Context, c Caller, runID string) (RunView, error)
}

// addSetupActions adds the five §6 setup writes to the action map. A nil face
// keeps its tool out of the announced set — the same honest-degradation rule
// as every other assistant service, so an unwired deployment never tells the
// model about a write it cannot serve.
func addSetupActions(out map[string]as.ActionExecutor, d AssistantActionsDeps) {
	if d.ProjectWrites != nil {
		out["project.create"] = assistantProjectCreateExecutor(d)
		out["repo.add"] = assistantRepoAddExecutor(d)
	}
	if d.Revisions != nil && d.AssignmentWrites != nil {
		out["assignment.set"] = assistantAssignmentSetExecutor(d)
	}
	if d.RunStop != nil {
		out["run.cancel"] = assistantRunCancelExecutor(d)
	}
	if d.Schedules != nil && d.AssignmentWrites != nil {
		out["schedule.create"] = assistantScheduleCreateExecutor(d)
	}
}

// --- project.create ------------------------------------------------------

func assistantProjectCreateExecutor(d AssistantActionsDeps) as.ActionExecutor {
	return func(ctx context.Context, c as.Caller, _ string, args map[string]string) (string, *as.ChangeRecord, error) {
		name := strings.TrimSpace(args["name"])
		if name == "" {
			return "", nil, errors.New("name is required")
		}
		if len([]rune(name)) > prjMaxNameLen {
			return "", nil, fmt.Errorf("the project name must be at most %d characters", prjMaxNameLen)
		}
		slug := assistantDeriveSlug(name)
		if slug == "" {
			return "", nil, errors.New("that name has no letters or digits to build a slug from; give a shorter name in the usual words")
		}
		caller := ac(c)
		project, err := d.ProjectWrites.CreateProject(ctx, caller, name, slug, "")
		if err != nil {
			if errors.Is(err, ErrProjectConflict) {
				return "", nil, fmt.Errorf("a project with the slug %s already exists — the project was NOT created", slug)
			}
			return "", nil, denied(err)
		}
		ack := "Created the project " + project.Name + "."
		ref := "project:" + project.ID
		if repoURL := strings.TrimSpace(args["repo_url"]); repoURL != "" {
			// The project is real and it STAYS whatever the repository half
			// says: deleting a created project to make the answer look tidy
			// would be its own surprise, so a failed half is reported in the
			// ack instead of unwound.
			added, err := assistantAddRepoToProject(ctx, d, caller, project.ID, repoURL,
				args["credential"], args["default_branch"])
			if err != nil {
				ack += " The repository was NOT added — " + assistantProblemText(err) + "."
			} else {
				ack += " Connected " + added.Note + "."
				ref += " repo:" + added.RepoID
			}
		}
		return ack, &as.ChangeRecord{
			Kind:      "project_create",
			ProjectID: &project.ID,
			TargetRef: boundedAssistantRef(ref),
			Summary:   boundedAssistantSummary("Created the project " + project.Name),
		}, nil
	}
}

// --- repo.add ------------------------------------------------------------

func assistantRepoAddExecutor(d AssistantActionsDeps) as.ActionExecutor {
	return func(ctx context.Context, c as.Caller, _ string, args map[string]string) (string, *as.ChangeRecord, error) {
		projectID := strings.TrimSpace(args["project_id"])
		if projectID == "" {
			return "", nil, errors.New("project_id is required")
		}
		caller := ac(c)
		added, err := assistantAddRepoToProject(ctx, d, caller, projectID, args["repo_url"],
			args["credential"], args["default_branch"])
		if err != nil {
			return "", nil, denied(err)
		}
		return "Added " + added.Note + " to the project.", &as.ChangeRecord{
			Kind:      "repo_add",
			ProjectID: &projectID,
			TargetRef: boundedAssistantRef("repo:" + added.RepoID),
			Summary:   boundedAssistantSummary("Added the repository " + added.Note),
		}, nil
	}
}

// assistantAddRepoToProject is the one repository path both writes share: the
// URL is read with the GitHub adapter (owner/repo, never a name the model
// invented), the remote is the canonical https form the routes store, the
// default branch follows the route's own "main" default, and the credential is
// resolved BY NAME among the secrets that project can see.
func assistantAddRepoToProject(ctx context.Context, d AssistantActionsDeps, caller Caller,
	projectID, repoURL, credential, defaultBranch string) (assistantAddedRepo, error) {
	if d.ProjectWrites == nil {
		return assistantAddedRepo{}, errors.New("no project service is wired into this deployment")
	}
	if strings.TrimSpace(projectID) == "" {
		return assistantAddedRepo{}, errors.New("project_id is required")
	}
	repo, err := assistantParseRepo(strings.TrimSpace(repoURL))
	if err != nil {
		// Honest, and it leaks nothing: the assistant speaks only to GitHub
		// here (assistantParseRepo, the SAME parser `repo.check` answers
		// with), and anything else — a GitLab remote, a file:// path, a web
		// page — is the project's own repository form, not a proposal.
		return assistantAddedRepo{}, fmt.Errorf("%s is not a GitHub repository URL — add it from the project's Repositories form instead", boundedAssistantRef(strings.TrimSpace(repoURL)))
	}
	branch := strings.TrimSpace(defaultBranch)
	if branch == "" {
		branch = "main" // the route's own default (internal/api/projects.go)
	}
	credentialSecretID := ""
	if want := strings.TrimSpace(credential); want != "" {
		id, err := assistantResolveCredentialName(ctx, d, caller, projectID, want)
		if err != nil {
			return assistantAddedRepo{}, err
		}
		credentialSecretID = id
	}
	added, err := d.ProjectWrites.AddRepository(ctx, caller, projectID, repo.Name,
		"https://github.com/"+repo.Owner+"/"+repo.Name+".git", branch, credentialSecretID)
	if err != nil {
		if errors.Is(err, ErrRepositoryCredentialInvalid) {
			return assistantAddedRepo{}, fmt.Errorf("the credential named for it is not one this project may use")
		}
		if errors.Is(err, ErrProjectConflict) {
			return assistantAddedRepo{}, fmt.Errorf("the project already has a repository called %s", repo.Name)
		}
		if errors.Is(err, ErrProjectNotFound) {
			return assistantAddedRepo{}, err
		}
		return assistantAddedRepo{}, fmt.Errorf("the server refused it: %s", assistantProblemText(err))
	}
	note := repo.Owner + "/" + repo.Name + " @ " + assistantOr(added.DefaultBranch, branch)
	if credential != "" {
		note += " (credential " + credential + ")"
	}
	return assistantAddedRepo{Note: note, RepoID: assistantOr(added.ID, repo.Name)}, nil
}

// assistantAddedRepo is one attached repository: the ack line (owner/repo @
// branch, plus the credential's NAME — never a value) and the row id the
// change record points at.
type assistantAddedRepo struct {
	Note   string
	RepoID string
}

// assistantResolveCredentialName turns a credential NAME into the secret id
// AddRepository wants, among the secrets the project can see (its own plus the
// organization's — internal/api/secrets.go's own list, so an out-of-scope or
// revoked secret is simply not in it). A name that matches nothing answers an
// error that names nothing either: the caller learns the credential was not
// found, not which credentials exist.
func assistantResolveCredentialName(ctx context.Context, d AssistantActionsDeps, caller Caller,
	projectID, want string) (string, error) {
	if d.Secrets == nil {
		return "", errors.New("no credential list is wired into this deployment, so a credential cannot be bound here")
	}
	secrets, err := d.Secrets.ListSecrets(ctx, caller, projectID)
	if err != nil {
		return "", fmt.Errorf("the credentials could not be read: %s", assistantProblemText(err))
	}
	want = strings.TrimSpace(want)
	for _, sec := range secrets {
		if !strings.EqualFold(strings.TrimSpace(sec.Slug), want) || sec.RevokedAt != nil {
			continue
		}
		if !assistantGitHubCredential(sec) {
			return "", fmt.Errorf("%s is not a git credential this repository can use", want)
		}
		return sec.ID, nil
	}
	return "", fmt.Errorf("no credential named %s is visible to this project (it may need to be created on the project's Secrets page)", want)
}

// --- assignment.set (the promotion preview) ------------------------------

func assistantAssignmentSetExecutor(d AssistantActionsDeps) as.ActionExecutor {
	return func(ctx context.Context, c as.Caller, _ string, args map[string]string) (string, *as.ChangeRecord, error) {
		projectID, pipelineID := strings.TrimSpace(args["project_id"]), strings.TrimSpace(args["pipeline_id"])
		if projectID == "" || pipelineID == "" {
			return "", nil, errors.New("project_id and pipeline_id are required")
		}
		caller := ac(c)
		// The route's own gate: assignments are written by a maintainer (the
		// store checks visibility, the maintainership gate is the handler's),
		// so the assistant applies the same one before it pins anything.
		if err := assistantRequireManage(ctx, d, caller, projectID); err != nil {
			return "", nil, err
		}
		rev, err := assistantLatestPublishedRevision(ctx, d, caller, pipelineID)
		if err != nil {
			return "", nil, denied(err)
		}
		// The route's own call: the pin is validated inside (published, of
		// this pipeline, this organization) and the assignment row carries it.
		item, err := d.AssignmentWrites.CreateAssignment(ctx, caller, projectID, AssignmentCreateInput{
			PipelineID:       pipelineID,
			PinnedRevisionID: rev.ID,
		})
		if err != nil {
			return "", nil, denied(err)
		}
		label := assistantRevisionLabel(rev.RevisionNumber, rev.VersionLabel)
		pinned := item.ProjectID
		return "Assigned the workflow at " + label + ".", &as.ChangeRecord{
			Kind:      "assignment_set",
			ProjectID: &pinned,
			TargetRef: boundedAssistantRef("assignment:" + item.ID),
			Summary:   boundedAssistantSummary("Assigned the workflow — pinned " + label),
		}, nil
	}
}

// assistantLatestPublishedRevision is the promotion read: the caller's own
// revision list, newest published first, resolved to its record so the id the
// assignment pins is the store's, not a digest the model held.
func assistantLatestPublishedRevision(ctx context.Context, d AssistantActionsDeps, caller Caller,
	pipelineID string) (RevisionView, error) {
	if d.Revisions == nil {
		return RevisionView{}, errors.New("no revision service is wired into this deployment")
	}
	revs, err := d.Revisions.ListPipelineRevisions(ctx, caller, pipelineID)
	if err != nil {
		return RevisionView{}, err
	}
	var best *RevisionSummaryView
	for i := range revs {
		if revs[i].Status != "published" {
			continue
		}
		if best == nil || revs[i].RevisionNumber > best.RevisionNumber {
			best = &revs[i]
		}
	}
	if best == nil {
		return RevisionView{}, errors.New("that workflow has no published revision to pin — publish it first")
	}
	return d.Revisions.GetRevision(ctx, caller, best.RevisionDigest)
}

// --- run.cancel ----------------------------------------------------------

func assistantRunCancelExecutor(d AssistantActionsDeps) as.ActionExecutor {
	return func(ctx context.Context, c as.Caller, _ string, args map[string]string) (string, *as.ChangeRecord, error) {
		runID := strings.TrimSpace(args["run_id"])
		if runID == "" {
			return "", nil, errors.New("run_id is required")
		}
		caller := ac(c)
		// The caller's own read first, exactly as the route's does: a run the
		// caller cannot see is refused without being named.
		before, err := d.RunStop.GetRun(ctx, caller, runID)
		if err != nil {
			return "", nil, denied(err)
		}
		run, err := d.RunStop.CancelRun(ctx, caller, runID)
		if err != nil {
			return "", nil, denied(err)
		}
		if d.Trigger != nil {
			d.Trigger(ctx, runID)
		}
		projectID := assistantOr(run.ProjectID, before.ProjectID)
		return "Requested the run's cancellation.", &as.ChangeRecord{
			Kind:      "run_cancel",
			ProjectID: &projectID,
			TargetRef: boundedAssistantRef("run:" + runID),
			// The honest sentence: a cancel is a REQUEST — the run reaches
			// `cancelled` when its branches stop (route 30 answers 202).
			Summary: boundedAssistantSummary("Requested that the run stop (it cancels once its work drains)"),
		}, nil
	}
}

// --- schedule.create -----------------------------------------------------

func assistantScheduleCreateExecutor(d AssistantActionsDeps) as.ActionExecutor {
	return func(ctx context.Context, c as.Caller, _ string, args map[string]string) (string, *as.ChangeRecord, error) {
		projectID := strings.TrimSpace(args["project_id"])
		pipelineID := strings.TrimSpace(args["pipeline_id"])
		cron := strings.TrimSpace(args["cron"])
		if projectID == "" || pipelineID == "" || cron == "" {
			return "", nil, errors.New("project_id, pipeline_id and cron are required")
		}
		// The route's own validator: a malformed expression is refused before
		// anything is written, and the model hears why.
		if _, err := schedule.Parse(cron); err != nil {
			return "", nil, fmt.Errorf("cron must be a 5-field cron expression in UTC (minute hour day-of-month month day-of-week): %v", err)
		}
		caller := ac(c)
		// Same gate as the route: a schedule starts real work on a timer, so
		// it is a maintainer's call.
		if err := assistantRequireManage(ctx, d, caller, projectID); err != nil {
			return "", nil, err
		}
		items, err := d.AssignmentWrites.ListAssignments(ctx, caller, projectID, AssignmentListFilter{})
		if err != nil {
			return "", nil, denied(err)
		}
		var hit *AssignmentView
		for i := range items {
			if items[i].PipelineID != pipelineID {
				continue
			}
			if hit != nil && hit.RepositoryID != nil && items[i].RepositoryID == nil {
				continue // a project-wide pin wins over a repo-scoped one
			}
			if hit == nil || items[i].RepositoryID == nil {
				hit = &items[i]
			}
		}
		if hit == nil {
			return "", nil, errors.New("that workflow is not assigned to this project — assign it first, then schedule it")
		}
		created, err := d.Schedules.CreateSchedule(ctx, caller, projectID, ScheduleCreateInput{
			AssignmentID: hit.ID,
			CronExpr:     cron,
		})
		if err != nil {
			return "", nil, denied(err)
		}
		owning := assistantOr(created.ProjectID, projectID)
		return "Created the schedule.", &as.ChangeRecord{
			Kind:      "schedule_create",
			ProjectID: &owning,
			TargetRef: boundedAssistantRef("schedule:" + created.ID),
			Summary:   boundedAssistantSummary("Created a schedule on the cron expression " + cron),
		}, nil
	}
}

// --- the small shared forms ---------------------------------------------

// assistantOr answers a with b when a is empty (the store's own blank
// strings are the only reason this exists).
func assistantOr(a, b string) string {
	if strings.TrimSpace(a) != "" {
		return a
	}
	return b
}

// assistantRequireManage is the route's maintainer gate (projects.go
// requireManage / schedules.go requireRole): the caller's CURRENT role, read
// through the caller's own GetProject, never carried in from an earlier turn.
// A project the caller cannot see, and a role under maintainer, both answer
// assistant.ErrActionDenied — the store's own not-found shape, so an
// invisible project stays invisible.
func assistantRequireManage(ctx context.Context, d AssistantActionsDeps, caller Caller, projectID string) error {
	if d.Projects == nil {
		return nil // no role face: the store's own predicate is the only gate
	}
	project, err := d.Projects.GetProject(ctx, caller, projectID)
	if err != nil {
		return denied(err)
	}
	if !authz.CanManage(caller.IsOrgAdmin, authz.Role(project.MyRole)) {
		return denied(ErrProjectNotFound)
	}
	return nil
}

// assistantDeriveSlug is the create route's own derivation
// (internal/api/projects.go prjDeriveSlug): the store requires a slug and the
// assistant never asks the model to invent one.
func assistantDeriveSlug(name string) string { return prjDeriveSlug(name) }

// assistantRevisionLabel names a revision the way the promotion preview and
// the change row do: the version label when it has one, the number always.
func assistantRevisionLabel(number int, versionLabel string) string {
	if label := strings.TrimSpace(versionLabel); label != "" {
		return label + " (r" + fmt.Sprint(number) + ")"
	}
	return "r" + fmt.Sprint(number)
}

// assistantProblemText is the one place a store error becomes model-visible
// text in this file: bounded, single-spaced, and never a bare Go wrapper.
func assistantProblemText(err error) string {
	if err == nil {
		return "unknown"
	}
	text := strings.Join(strings.Fields(err.Error()), " ")
	return boundedAssistantRef(text)
}

// boundedAssistantRef and boundedAssistantSummary keep this file's own bounds
// rather than reaching into another package's unexported helpers.
func boundedAssistantRef(s string) string {
	if len(s) > 200 {
		return s[:200]
	}
	return s
}

func boundedAssistantSummary(s string) string {
	if len(s) > 300 {
		return s[:300]
	}
	return s
}
