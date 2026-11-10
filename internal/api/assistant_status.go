package api

// The assistant's `system.status` read (assistant handoff §2, CONTRACT §1):
// one object that answers "how is this server set up?" — the models it can
// reach, how many workers are online and under what sandbox enforcement,
// which GitHub credentials exist (names only), and how many projects and
// workflows the caller can see.
//
// Two rules shape everything below:
//
//   - Every read is the CALLER's own. Projects, pipelines, repositories and
//     secrets are the same store methods the user's routes call with this
//     Caller, so the status object can never name a row the caller could not
//     read at that route (ADR-0050 decision 4, spec 08 "one control source").
//   - No value ever leaves. The speech endpoint's key is reduced to a
//     `key_set` bool and its URL to a bare host; a secret is reduced to its
//     slug, its scope and how many repositories name it. Nothing below holds
//     a `[]byte` or a secret value, because the secret store surface the
//     status read uses has no method that returns one (ADR-0018 D1/D3).

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"sort"
	"strings"
)

// AssistantStatusModels is the speech/decision egress resolved from the
// environment by cmd/communication/serve.go and passed in. It is deliberately
// a plain config struct rather than an env read here: internal/api never
// touches os.Getenv, and the keys this carries are only ever inspected for
// presence — the string is never serialized, logged or sent upstream by
// anything in this file.
type AssistantStatusModels struct {
	// Speech is COMMUNICATION_SPEECH_BASE_URL / _MODEL (and _API_KEY or
	// _API_KEY_FILE, whose value reaches this field and no further).
	SpeechBaseURL string
	SpeechModel   string
	SpeechAPIKey  string
	// Decision is COMMUNICATION_DECISION_BASE_URL / _MODEL (ADR-0079's
	// judge). It counts as configured on base URL + model alone, the
	// contract's rule.
	DecisionBaseURL string
	DecisionModel   string
}

// AssistantStatusDeps is the SystemStatus service's world: the assistant's
// own chat egress, the second/third model endpoints, the worker registry and
// the caller-scoped store faces. Each store member is OPTIONAL — a nil face
// reports the honest zero ("0 workers", "no credentials visible") rather
// than being filled in with a guess.
type AssistantStatusDeps struct {
	Chat        AssistantConfig
	Models      AssistantStatusModels
	Workers     assistantStatusWorkers
	Sandbox     assistantStatusSandbox
	Projects    assistantStatusProjects
	Repos       assistantStatusRepos
	Secrets     assistantStatusSecrets
	Pipelines   assistantStatusPipelines
	Assignments assistantStatusAssignments
}

// The narrow read faces the status object is assembled from — every one is a
// method an existing route already serves, and every one takes the Caller.
type (
	assistantStatusWorkers interface {
		ListWorkers(ctx context.Context) ([]WorkerView, error)
	}
	assistantStatusSandbox interface {
		ListWorkerSandbox(ctx context.Context) ([]WorkerSandboxStatusView, error)
	}
	assistantStatusProjects interface {
		ListProjects(ctx context.Context, c Caller) ([]ProjectView, error)
	}
	assistantStatusRepos interface {
		ListRepositories(ctx context.Context, c Caller, projectID string) ([]RepositoryView, error)
	}
	assistantStatusSecrets interface {
		ListSecrets(ctx context.Context, c Caller, projectID string) ([]SecretView, error)
	}
	assistantStatusPipelines interface {
		ListPipelines(ctx context.Context, c Caller) ([]PipelineSummaryView, error)
	}
	assistantStatusAssignments interface {
		ListAssignments(ctx context.Context, c Caller, projectID string, f AssignmentListFilter) ([]AssignmentView, error)
	}
)

// --- the view (api/openapi.yaml AssistantSystemStatus) --------------------

// AssistantModelStatus is one model row of the status object. `model` is the
// configured model id or ""; endpoint_host is the bare hostname (never the
// scheme+path a key could hide in, never userinfo) and key_set is the whole
// truth about a key. Both are absent on a row that is not configured, and
// key_set is absent for the chat row: the assistant's own key is not a
// setup question the checklist asks.
type AssistantModelStatus struct {
	Configured   bool    `json:"configured"`
	Model        string  `json:"model"`
	EndpointHost *string `json:"endpoint_host,omitempty"`
	KeySet       *bool   `json:"key_set,omitempty"`
}

// AssistantWorkersStatus is the worker half: how many are online right now
// and the enforcement the online fleet actually reports.
type AssistantWorkersStatus struct {
	Online      int    `json:"online"`
	SandboxMode string `json:"sandbox_mode"`
}

// AssistantCredentialRow is one GitHub credential's presence: name (the
// secret's slug), scope and how many repositories use it. There is no field
// here that could hold a value, and no field added later should have one.
type AssistantCredentialRow struct {
	Name   string `json:"name"`
	Scope  string `json:"scope"`
	UsedBy int    `json:"used_by"`
}

// AssistantProjectCount is the caller's project count.
type AssistantProjectCount struct {
	Count int `json:"count"`
}

// AssistantWorkflowCounts is the caller's workflow picture: the library they
// can see, how many of those are the shipped samples, and how many are
// actually assigned to a project.
type AssistantWorkflowCounts struct {
	Count    int `json:"count"`
	Samples  int `json:"samples"`
	Assigned int `json:"assigned"`
}

// AssistantSystemStatus is CONTRACT §1's object, verbatim: the route's 200
// body and the system.status tool's payload are this one shape.
type AssistantSystemStatus struct {
	ChatModel         AssistantModelStatus     `json:"chat_model"`
	SpeechModel       AssistantModelStatus     `json:"speech_model"`
	DecisionModel     AssistantModelStatus     `json:"decision_model"`
	Workers           AssistantWorkersStatus   `json:"workers"`
	ExecutionMode     string                   `json:"execution_mode"`
	GitHubCredentials []AssistantCredentialRow `json:"github_credentials"`
	Projects          AssistantProjectCount    `json:"projects"`
	Workflows         AssistantWorkflowCounts  `json:"workflows"`
}

// assistantExecutionMode is the one mode this build runs agents in: the
// worker launches each attempt as its own sandboxed child process. The
// handoff's Mode B (Kubernetes pods) is §7 and out of scope, so the field
// exists as the honest statement of today, not a knob.
const assistantExecutionMode = "inprocess"

// sampleWorkflowSlugs is the closed set of library slugs this app SHIPS as
// samples — docs/samples/home/, the same three the UI's "Start from a
// sample" picker offers (ui/src/lib/pipeline/templates.ts). No pipeline row
// records "installed as a sample" (no migration adds such a column), so the
// slug is the only honest signal available to `workflows.samples`; a
// pipeline the author renamed out of that set counts as authored, which is
// the truthful reading of "installed as a sample and left alone".
var sampleWorkflowSlugs = map[string]bool{
	"issue-to-pr":        true,
	"plan-with-approval": true,
	"security-review":    true,
}

// --- the service ----------------------------------------------------------

// SystemStatus answers the assistant's setup question from the caller's own
// view. It holds no store handle it does not pass a Caller to.
type SystemStatus struct {
	deps AssistantStatusDeps
}

// NewSystemStatus wires the service. A nil *SystemStatus is a valid
// deployment answer only for tests: serve always builds one, because every
// row it reports degrades honestly.
func NewSystemStatus(deps AssistantStatusDeps) *SystemStatus {
	return &SystemStatus{deps: deps}
}

// Status builds the CONTRACT §1 object as the caller. The caller's project
// list is the fan-out point (repositories, secrets and assignments are all
// per-project reads the routes already serve), so a caller with no projects
// honestly sees zero of each rather than an org-wide peek.
func (s *SystemStatus) Status(ctx context.Context, c Caller) (AssistantSystemStatus, error) {
	out := AssistantSystemStatus{
		ChatModel:         assistantChatModel(s.deps.Chat),
		SpeechModel:       assistantSpeechModel(s.deps.Models),
		DecisionModel:     assistantDecisionModel(s.deps.Models),
		ExecutionMode:     assistantExecutionMode,
		GitHubCredentials: []AssistantCredentialRow{},
	}

	online, mode, err := s.workerStatus(ctx)
	if err != nil {
		return out, err
	}
	out.Workers = AssistantWorkersStatus{Online: online, SandboxMode: mode}

	projects := 0
	if s.deps.Projects != nil {
		rows, err := s.deps.Projects.ListProjects(ctx, c)
		if err != nil {
			return out, err
		}
		projects = len(rows)
		projectIDs := make([]string, 0, len(rows))
		for _, p := range rows {
			projectIDs = append(projectIDs, p.ID)
		}
		out.GitHubCredentials, err = s.githubCredentials(ctx, c, projectIDs)
		if err != nil {
			return out, err
		}
		assigned, err := s.assignedPipelines(ctx, c, projectIDs)
		if err != nil {
			return out, err
		}
		out.Workflows.Assigned = assigned
	}
	out.Projects.Count = projects

	if s.deps.Pipelines != nil {
		rows, err := s.deps.Pipelines.ListPipelines(ctx, c)
		if err != nil {
			return out, err
		}
		out.Workflows.Count = len(rows)
		for _, p := range rows {
			if sampleWorkflowSlugs[strings.TrimSpace(p.Slug)] {
				out.Workflows.Samples++
			}
		}
	}
	return out, nil
}

// assistantChatModel reports the assistant's own egress: configured means the
// deployment set COMMUNICATION_ASSISTANT_BASE_URL (ADR-0034's rule that an
// unset base URL IS the absence), and the model is whatever it sends.
func assistantChatModel(cfg AssistantConfig) AssistantModelStatus {
	configured := strings.TrimSpace(cfg.BaseURL) != ""
	return AssistantModelStatus{Configured: configured, Model: strings.TrimSpace(cfg.Model)}
}

// assistantSpeechModel reports the transcription endpoint (§5). Configured
// means base URL and model are both set — a URL with no model to send audio
// to transcribes nothing. The key answer is a bool; the host is a hostname
// and nothing else, so a URL that carried credentials in its userinfo could
// not leak one here.
func assistantSpeechModel(m AssistantStatusModels) AssistantModelStatus {
	row := AssistantModelStatus{Model: strings.TrimSpace(m.SpeechModel)}
	host, hostOK := assistantEndpointHost(m.SpeechBaseURL)
	row.Configured = hostOK && row.Model != ""
	if row.Configured {
		h := host
		row.EndpointHost = &h
		ks := strings.TrimSpace(m.SpeechAPIKey) != ""
		row.KeySet = &ks
	}
	return row
}

// assistantDecisionModel reports ADR-0079's judge. The contract's rule:
// configured on base URL and model.
func assistantDecisionModel(m AssistantStatusModels) AssistantModelStatus {
	row := AssistantModelStatus{Model: strings.TrimSpace(m.DecisionModel)}
	host, hostOK := assistantEndpointHost(m.DecisionBaseURL)
	row.Configured = hostOK && row.Model != ""
	if row.Configured {
		h := host
		row.EndpointHost = &h
	}
	return row
}

// assistantEndpointHost reduces an endpoint URL to its hostname. A URL that
// does not parse, has no host, or is not http(s) is "no host" — the status
// object reports the endpoint as unconfigured rather than echoing a string it
// cannot vouch for.
func assistantEndpointHost(raw string) (string, bool) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", false
	}
	u, err := url.Parse(raw)
	if err != nil || u.Hostname() == "" {
		return "", false
	}
	switch u.Scheme {
	case "http", "https":
	default:
		return "", false
	}
	return u.Hostname(), true
}

// workerStatus counts the workers the registry reports online (the
// liveness-adjusted status GET /api/v1/workers already serves) and folds the
// online fleet's reported sandbox enforcement down to the weakest mode, so a
// single unenforced worker can never be hidden by a green one.
func (s *SystemStatus) workerStatus(ctx context.Context) (int, string, error) {
	if s.deps.Workers == nil {
		return 0, assistantSandboxUnknown, nil
	}
	rows, err := s.deps.Workers.ListWorkers(ctx)
	if err != nil {
		return 0, assistantSandboxUnknown, err
	}
	onlineIDs := map[string]bool{}
	for _, w := range rows {
		if strings.EqualFold(strings.TrimSpace(w.Status), "online") {
			onlineIDs[w.ID] = true
		}
	}
	online := len(onlineIDs)
	if s.deps.Sandbox == nil || online == 0 {
		return online, assistantSandboxUnknown, nil
	}
	modes, err := s.deps.Sandbox.ListWorkerSandbox(ctx)
	if err != nil {
		return online, assistantSandboxUnknown, err
	}
	return online, weakestSandboxMode(modes, onlineIDs), nil
}

// Sandbox modes as the checklist names them (CONTRACT §1): required >
// optional > off, with `unknown` when the fleet reports nothing to fold.
const (
	assistantSandboxRequired = "required"
	assistantSandboxOptional = "optional"
	assistantSandboxOff      = "off"
	assistantSandboxUnknown  = "unknown"
)

// weakestSandboxMode maps each online worker's registered enforcement onto
// the checklist's three words and returns the weakest one the fleet reports.
// The store's vocabulary is the worker's own (`required`, `permissive-dev`,
// `disabled` — communication-spec/05), so the translation lives here rather
// than pretending the worker registers "optional". `onlineIDs` is the fold's
// filter: a row the registry no longer calls online cannot weaken (or, worse,
// strengthen) the answer the checklist shows.
func weakestSandboxMode(rows []WorkerSandboxStatusView, onlineIDs map[string]bool) string {
	weakest := -1
	for _, r := range rows {
		if !onlineIDs[r.WorkerID] {
			continue
		}
		// A worker the registry calls online but that registered no enforcement
		// is the weakest answer there is: nothing was proven.
		rank := assistantSandboxRank(r.Enforcement)
		if weakest < 0 || rank < weakest {
			weakest = rank
		}
		if weakest == 0 {
			break
		}
	}
	// An online worker with no sandbox row of its own is not a claim to any
	// mode: the answer folds what WAS registered, and `unknown` when the fleet
	// registered nothing at all (the branch below's `default`).
	switch weakest {
	case 2:
		return assistantSandboxRequired
	case 1:
		return assistantSandboxOptional
	case 0:
		return assistantSandboxOff
	default:
		return assistantSandboxUnknown
	}
}

// assistantSandboxRank orders the enforcement words weakest-first; anything
// unrecognized (a worker that registered before the field existed) is "off",
// because an unproven enforcement is not a claim to a stronger one.
func assistantSandboxRank(enforcement string) int {
	switch strings.ToLower(strings.TrimSpace(enforcement)) {
	case "required":
		return 2
	case "permissive-dev", "optional":
		return 1
	default:
		return 0
	}
}

// githubCredentials lists the git/GitHub secrets visible through the
// caller's own projects (the store's per-project list is the caller's own
// project rows plus the organization's, so an org secret appears once),
// each with the number of repositories that name it as its credential. The
// secret VALUE is not reachable from SecretView — that is the store
// interface's shape, not this function's discipline.
func (s *SystemStatus) githubCredentials(ctx context.Context, c Caller, projectIDs []string) ([]AssistantCredentialRow, error) {
	out := []AssistantCredentialRow{}
	if s.deps.Secrets == nil {
		return out, nil
	}
	byID := map[string]*AssistantCredentialRow{}
	order := []string{}
	for _, projectID := range projectIDs {
		secrets, err := s.deps.Secrets.ListSecrets(ctx, c, projectID)
		if err != nil {
			return nil, err
		}
		for _, sec := range secrets {
			if !assistantGitHubCredential(sec) {
				continue
			}
			row, ok := byID[sec.ID]
			if !ok {
				row = &AssistantCredentialRow{
					Name:  sec.Slug,
					Scope: sec.Scope,
				}
				byID[sec.ID] = row
				order = append(order, sec.ID)
			}
		}
	}
	if s.deps.Repos != nil {
		for _, projectID := range projectIDs {
			repos, err := s.deps.Repos.ListRepositories(ctx, c, projectID)
			if err != nil {
				return nil, err
			}
			for _, repo := range repos {
				if repo.CredentialSecretID == nil {
					continue
				}
				if row, ok := byID[*repo.CredentialSecretID]; ok {
					row.UsedBy++
				}
			}
		}
	}
	for _, id := range order {
		out = append(out, *byID[id])
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}

// assistantGitHubCredential answers "is this secret a git/GitHub credential?"
// The machine-readable half is ADR-0061's delivery mode — integration_broker
// exists precisely so a repository can name a secret as its GitHub credential
// — and the human-readable half is the free-text purpose, where the app's
// own seed and the UI's wording put the word "github" or "git". Either is
// enough; the two together are what an operator actually types.
func assistantGitHubCredential(sec SecretView) bool {
	if strings.EqualFold(strings.TrimSpace(sec.Delivery), "integration_broker") {
		return true
	}
	purpose := strings.ToLower(sec.Purpose)
	return strings.Contains(purpose, "github") || strings.Contains(purpose, "git ") ||
		strings.Contains(purpose, "git_") || strings.Contains(purpose, "git/")
}

// assignedPipelines counts DISTINCT pipelines that hold at least one project
// assignment in the caller's projects — CONTRACT §1's `assigned`. An
// assignment is the pin, and a pipeline pinned in three projects is one
// assigned workflow, not three.
func (s *SystemStatus) assignedPipelines(ctx context.Context, c Caller, projectIDs []string) (int, error) {
	if s.deps.Assignments == nil {
		return 0, nil
	}
	seen := map[string]bool{}
	for _, projectID := range projectIDs {
		items, err := s.deps.Assignments.ListAssignments(ctx, c, projectID, AssignmentListFilter{})
		if err != nil {
			return 0, err
		}
		for _, a := range items {
			seen[a.PipelineID] = true
		}
	}
	return len(seen), nil
}

// --- the route ------------------------------------------------------------

// RegisterAssistantStatus mounts GET /api/v1/assistant/status: the same
// object the system.status tool answers with, for the UI's setup checklist.
// Session-authed like every assistant route, and behind the assistant's
// per-principal throttle — it is a request the assistant's own turn makes on
// the user's behalf, and a checklist that re-reads the whole fleet belongs
// behind the same budget (ADR-0077).
func RegisterAssistantStatus(s *Server, svc *SystemStatus) {
	h := &asstStatusHandlers{svc: svc, srv: s}
	s.HandleAuthed("GET /api/v1/assistant/status", s.ThrottleAssistant(http.HandlerFunc(h.status)))
}

type asstStatusHandlers struct {
	svc *SystemStatus
	srv *Server
}

func (h *asstStatusHandlers) status(w http.ResponseWriter, r *http.Request) {
	p, ok := PrincipalFrom(r.Context())
	if !ok {
		// Only reachable if the route were mounted without RequireAuth; the
		// contract says 401, so it says 401 rather than reading as the whole
		// organization.
		WriteProblem(w, http.StatusUnauthorized, "Unauthenticated",
			"A valid session is required.")
		return
	}
	if h.svc == nil {
		h.fail(w, r, errors.New("assistant status: no status service wired"))
		return
	}
	c := Caller{UserID: p.UserID, OrganizationID: p.OrganizationID, IsOrgAdmin: p.IsOrgAdmin}
	view, err := h.svc.Status(r.Context(), c)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	WriteJSON(w, http.StatusOK, view)
}

func (h *asstStatusHandlers) fail(w http.ResponseWriter, r *http.Request, err error) {
	h.log(r).ErrorContext(r.Context(), "assistant status failed",
		"request_id", RequestIDFrom(r), "error", err.Error())
	// A store error may name tables or connection details; the client gets the
	// request id to quote instead (ADR-0014 § 2).
	WriteProblem(w, http.StatusInternalServerError, "Internal Server Error",
		"The server could not read its own setup. Use the request id when reporting it.")
}

func (h *asstStatusHandlers) log(r *http.Request) *slog.Logger {
	if h.srv != nil {
		return h.srv.logger
	}
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

// assistantStatusPayload is the tool-facing encoding of the object; it lives
// here so the route's 200 body and the tool's payload cannot drift.
func assistantStatusPayload(view AssistantSystemStatus) (json.RawMessage, error) {
	return json.Marshal(view)
}
