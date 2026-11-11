package api

// The operations page's one read and one action:
//
//	GET  /api/v1/system/overview
//	POST /api/v1/system/models/{kind}/probe      (kind: assistant|speech|decision)
//
// The overview answers "what is this deployment, and what can it reach?" from
// config this replica was handed plus the caller's own authorized reads. Three
// rules shape it:
//
//   - Nothing secret. A key is a `key_set` bool, an endpoint is a bare host, a
//     secret is a number. No member below can hold a value, because every
//     signed-in member may read this route.
//   - One source per fact. The model rows are the assistant §2 checklist's
//     rows relabelled — assistantChatModel / assistantSpeechModel /
//     assistantDecisionModel over the same AssistantConfig and
//     AssistantStatusModels — so a deployment can never show two answers to
//     "is the speech model configured?". And nothing here reads the
//     environment: internal/api never touches os.Getenv, so serve hands every
//     value in (WorkerChatConfig is the one new hand-off, for the kind whose
//     egress belongs to a worker).
//   - Counts are the caller's. The secret picture fans out over the projects
//     ListProjects answers for THIS caller — the same authorized store reads
//     the caller's own secret routes make — so it cannot count a row the
//     caller could not list at those routes (ADR-0050 decision 4's rule).
//
// The probe is the one action: an organization admin asks an endpoint whether
// it answers right now. The answer is the upstream's own message, truncated —
// never a header, never the key, never the request.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"os"
	"runtime/debug"
	"strconv"
	"strings"
	"time"

	"github.com/dbirks/communication/internal/artifacts"
	"github.com/dbirks/communication/internal/assistant"
)

// The four model kinds the overview names. The first three are this replica's
// own egress; `worker_chat` belongs to a worker process, which is why its row
// can read `configured: false` on a deployment whose fleet still runs
// model.chat nodes.
const (
	overviewKindAssistant  = "assistant"
	overviewKindSpeech     = "speech"
	overviewKindDecision   = "decision"
	overviewKindWorkerChat = "worker_chat"
)

// overviewProbeKinds is the closed probe set: this replica can reach these
// three, and `worker_chat` is not one of them — its endpoint and key live in
// a worker's environment, so a probe here would prove nothing about the fleet.
var overviewProbeKinds = map[string]bool{
	overviewKindAssistant: true,
	overviewKindSpeech:    true,
	overviewKindDecision:  true,
}

// overviewModelLabels name a row by what it is FOR, not by the variable that
// sets it: "Workflow model steps" is what a node uses, and the variable names
// belong in the refusal text of a probe that cannot run.
var overviewModelLabels = map[string]string{
	overviewKindAssistant:  "Assistant chat",
	overviewKindSpeech:     "Speech transcription",
	overviewKindDecision:   "Decision judge",
	overviewKindWorkerChat: "Workflow model steps",
}

// WorkerChatConfig is the worker's model.chat endpoint as THIS replica's
// environment states it. The serve pod normally carries none of
// COMMUNICATION_MODEL_CHAT_* — the worker owns that egress — and then every
// field is the zero value and the row reads
// `configured: false, key_set: null`, which the UI says "set on the worker".
type WorkerChatConfig struct {
	// BaseURL is the trailing-slash-trimmed COMMUNICATION_MODEL_CHAT_BASE_URL.
	BaseURL string
	// Model is the FIRST entry of COMMUNICATION_MODEL_CHAT_MODELS (the
	// allowlist a node's `model:` is checked against), or "" when unset.
	Model string
	// KeySet is nil when this replica cannot see the key question at all:
	// unset here means a worker's environment decides, and reporting `false`
	// would be a claim the ops page cannot take back.
	KeySet *bool
}

// SystemOverviewDeps is the world the two ops routes read: the model configs
// serve already resolved, the caller-scoped store faces, and the probe's
// egress. Every face is optional; a nil one reports the honest zero ("0
// workers") rather than a guess.
type SystemOverviewDeps struct {
	// Version and Replica are the same two values api.Config carries, passed
	// in at registration, so the health route, the X-Communication-Replica
	// header and this row can never disagree about which build answered.
	Version string
	Replica string

	// Chat is the assistant's own egress triple (COMMUNICATION_ASSISTANT_*).
	Chat AssistantConfig
	// Models is the speech/decision pair from serveAssistantStatusConfig —
	// the SAME struct the §2 checklist reads, deliberately.
	Models AssistantStatusModels
	// DecisionAPIKey is the judge's key as serveDecisionConfig resolved it.
	// AssistantStatusModels carries no decision key because the checklist
	// never asks "is there one"; here it answers `key_set` and the probe's
	// Authorization header, and goes no further.
	DecisionAPIKey string
	// WorkerChat is the worker-side model.chat config (usually absent).
	WorkerChat WorkerChatConfig

	// IdentityProvider names the login path this replica offers; empty means
	// the only one this build has, "oidc".
	IdentityProvider string
	// IssuerURL is the raw COMMUNICATION_OIDC_ISSUER. It is reduced to a bare
	// host on the way out and never echoed in full. Under ADR-0083's providers
	// file it is "" — the issuers live in the file — which is exactly why
	// SignInProviders exists: with only this field, a multi-provider deployment
	// answered the identity row with an empty host.
	IssuerURL string
	// SignInProviders is the deployment's provider list (id, label, issuer) as
	// `auth.Config.SignInProviders()` answers it, in configuration order — the
	// same rows `GET /auth/providers` prints, each issuer reduced to a host on
	// the way out. Empty means this replica was not wired with the list, and the
	// identity row then falls back to IssuerURL alone.
	SignInProviders []SignInProvider
	// DevLogin is the deployment's answer to "is there a signed-in identity
	// that did not come from the IdP?". No route in this build offers one, so
	// serve passes false; the field exists because the row must not guess.
	DevLogin bool

	// ArtifactBackend is the artifact store's own name for itself
	// ("local"/"s3"); "" when this process has no byte store at all.
	ArtifactBackend string
	// PreviewHost is the host the preview origin serves from; "" means this
	// deployment has no preview host, which is what the page should say.
	PreviewHost string

	// Workers, Projects and Secrets are the caller-scoped read faces the
	// assistant's status service already uses.
	Workers  assistantStatusWorkers
	Projects assistantStatusProjects
	Secrets  systemOverviewSecretStore
	// Heartbeat is the workers' heartbeat interval (0 = the shipped default).
	// The stale window the row reports is Heartbeat × workerLivenessIntervals,
	// the rule the registry's own liveness adjustment applies.
	Heartbeat time.Duration

	// Egress is the probe's HTTP client; nil uses one armed with ProbeTimeout.
	Egress *http.Client
	// ProbeTimeout bounds one probe end to end; zero means defaultProbeTimeout.
	ProbeTimeout time.Duration
	// now is the probe limiter's clock, injected for tests.
	now func() time.Time
}

// systemOverviewSecretStore is the secret half of the overview's counts: both
// reads are the routes' own authorized lists, so the counts cannot reach a row
// the caller's own secret page does not show.
type systemOverviewSecretStore interface {
	assistantStatusSecrets
	ListSecretMounts(ctx context.Context, c Caller, projectID string) ([]SecretMountView, error)
}

// WorkerChatConfigFromEnv resolves the worker's model.chat environment as ONE
// process sees it, for the overview's fourth model row. The variable names are
// the worker's (cmd/communication/worker.go reads and validates them); this
// resolver does NOT validate, because on a serve pod a malformed value is not a
// startup refusal — that process never sends this traffic — it is a row that
// reads `configured: false`. Reading the variables at all rather than
// hard-coding "not set" is the honest half: a deployment that shares one
// environment between serve and a worker shows what it actually has. And
// `COMMUNICATION_MODEL_CHAT_API_KEY` is only ever inspected for presence, the
// same one-question rule serveAssistantStatusConfig applies to the speech key.
//
// The getenv parameter is the house seam (api.AllowFileGitURLsFromEnv is the
// precedent): internal/api never reads the process environment itself.
//
// An unset base URL leaves `KeySet` nil — "this replica cannot see the key
// question" — which is a different claim from `false`, and the difference is
// what the page renders as "set on the worker".
func WorkerChatConfigFromEnv(getenv func(string) string) WorkerChatConfig {
	if getenv == nil {
		getenv = os.Getenv
	}
	out := WorkerChatConfig{
		BaseURL: strings.TrimRight(strings.TrimSpace(getenv("COMMUNICATION_MODEL_CHAT_BASE_URL")), "/"),
	}
	if raw := strings.TrimSpace(getenv("COMMUNICATION_MODEL_CHAT_MODELS")); raw != "" {
		for _, m := range strings.Split(raw, ",") {
			if m = strings.TrimSpace(m); m != "" {
				out.Model = m
				break
			}
		}
	}
	if out.BaseURL != "" {
		set := strings.TrimSpace(getenv("COMMUNICATION_MODEL_CHAT_API_KEY")) != ""
		out.KeySet = &set
	}
	return out
}

// --- the view ------------------------------------------------------------

// SystemOverviewServer is what this replica is running. `commit` is "" when
// the binary carries no claim to a revision. `schema_version` is the number
// the readiness route reads; 0 means this replica could not read its own
// datastore, and GET /api/v1/system/readiness is the route that explains that
// rather than a second unknown-shape here.
type SystemOverviewServer struct {
	Version       string    `json:"version"`
	Commit        string    `json:"commit"`
	Replica       string    `json:"replica"`
	SchemaVersion int64     `json:"schema_version"`
	StartedAt     time.Time `json:"started_at"`
}

// SystemOverviewIdentity names the login path. `issuer_host` is a hostname and
// nothing else, so no path, query or userinfo can ride out with it.
// `dev_login` is the honest "no": this build has no identity that bypasses the
// IdP, and the page says so instead of letting an operator infer it.
//
// `providers` is the ADR-0083 truth a single `issuer_host` could not carry: one
// entry per configured provider, in configuration order. `issuer_host` stays —
// the first provider's host — for the consumers that predate the list.
type SystemOverviewIdentity struct {
	Provider   string                           `json:"provider"`
	IssuerHost string                           `json:"issuer_host"`
	Providers  []SystemOverviewIdentityProvider `json:"providers"`
	DevLogin   bool                             `json:"dev_login"`
}

// SystemOverviewIdentityProvider is one sign-in row: the id a login URL names,
// the label the chooser prints, and the issuer's bare host. No client id, no
// secret, no discovery path — the operations page is an operator's read of the
// deployment, not a second copy of its configuration.
type SystemOverviewIdentityProvider struct {
	ID         string `json:"id"`
	Label      string `json:"label"`
	IssuerHost string `json:"issuer_host"`
}

// SystemOverviewStorage is where bytes live. Both members are names, never
// paths or credentials.
type SystemOverviewStorage struct {
	ArtifactBackend string `json:"artifact_backend"`
	PreviewHost     string `json:"preview_host"`
}

// SystemOverviewModel is one model row. `key_set` is tri-state on purpose:
// `null` means this replica cannot see the key question (the worker owns it),
// which is a different claim from `false`.
type SystemOverviewModel struct {
	Kind         string `json:"kind"`
	Label        string `json:"label"`
	Model        string `json:"model"`
	EndpointHost string `json:"endpoint_host"`
	KeySet       *bool  `json:"key_set"`
	Configured   bool   `json:"configured"`
}

// SystemOverviewSecrets is the caller's secret picture: how many projects they
// are in, how many distinct secrets those projects can see, how many
// placements are declared. Never a slug, a scope or a value.
type SystemOverviewSecrets struct {
	Projects int `json:"projects"`
	Secrets  int `json:"secrets"`
	Mounts   int `json:"mounts"`
}

// SystemOverviewWorkers is the fleet pair plus the rule behind it. `offline`
// is every row the registry does not call online — a drained or silent worker
// is not capacity — and `stale_after_seconds` is the window that judgement
// used, so the page never shows a count without the rule that produced it.
type SystemOverviewWorkers struct {
	Online            int `json:"online"`
	Offline           int `json:"offline"`
	StaleAfterSeconds int `json:"stale_after_seconds"`
}

// SystemOverview is GET /api/v1/system/overview's 200 body.
type SystemOverview struct {
	Server   SystemOverviewServer   `json:"server"`
	Identity SystemOverviewIdentity `json:"identity"`
	Storage  SystemOverviewStorage  `json:"storage"`
	Models   []SystemOverviewModel  `json:"models"`
	Secrets  SystemOverviewSecrets  `json:"secrets"`
	Workers  SystemOverviewWorkers  `json:"workers"`
}

// ModelProbeResult is one probe's answer. It is a 200 body whether the model
// answered or not — a failed probe is a result, not an HTTP error — and
// `detail` is the upstream's own error MESSAGE (single line, truncated), never
// a header, never the key, never the request.
type ModelProbeResult struct {
	OK        bool   `json:"ok"`
	LatencyMS int64  `json:"latency_ms"`
	Detail    string `json:"detail"`
}

// --- the service ---------------------------------------------------------

// defaultProbeTimeout is the whole-call deadline on one probe: an endpoint
// that has not answered in fifteen seconds has not answered, and the admin
// deserves to see that rather than a spinner.
const defaultProbeTimeout = 15 * time.Second

// probeMaxTokens is the completion's ceiling: the probe asks for the two
// tokens "ok" is, and a reasoning model that spends its budget thinking is a
// probe that never returns.
const probeMaxTokens = 4

// probePrompt is the entire request content. It carries no caller text, no
// project name and no path, so the only thing the call can prove is that the
// endpoint resolves the model id and answers at all.
const probePrompt = "Reply with: ok"

// probeDetailMaxChars bounds the client-facing detail. An upstream message
// longer than this is a stack trace or an HTML page, and neither belongs on
// the ops table.
const probeDetailMaxChars = 200

// workerLivenessIntervals is how many missed heartbeats the registry
// tolerates before it calls a worker offline
// (internal/store/postgres regLivenessIntervals). The overview names the
// window it counted with, so the rule is stated here too: a count whose rule
// the page cannot name is the kind of number an operator learns to distrust.
const workerLivenessIntervals = 3

// defaultWorkerHeartbeat mirrors internal/worker.DefaultHeartbeat and the
// registry's regDefaultHeartbeat — three names for the same 10 s, and the
// overview's window must match what the registry actually applied.
const defaultWorkerHeartbeat = 10 * time.Second

// identityProviderOIDC is the only login path this build offers.
const identityProviderOIDC = "oidc"

// SignInProvider is one entry of the deployment's identity provider list as
// this package needs it: the id, the label and the raw issuer URL. It lives
// here rather than in internal/api/auth because `auth` imports this package (it
// writes its problems with it) and this package may not import `auth` back: the
// overview takes the list as plain data, and `auth.Config.SignInProviders()` is
// the accessor that produces it.
type SignInProvider struct {
	ID     string
	Label  string
	Issuer string
}

// signInProviders reduces the deployment's provider list to the rows the
// identity panel prints, in configuration order — `[]`, never null, so the
// reader has one shape to handle. An entry whose issuer this build cannot parse
// (or names no issuer at all) keeps its id and label with an empty host: the
// operator then sees the provider they configured and the honest gap, rather
// than a row that silently vanished.
func (s *SystemOverviewService) signInProviders() []SystemOverviewIdentityProvider {
	out := make([]SystemOverviewIdentityProvider, 0, len(s.deps.SignInProviders))
	for _, p := range s.deps.SignInProviders {
		id := strings.TrimSpace(p.ID)
		label := strings.TrimSpace(p.Label)
		if id == "" && label == "" {
			continue
		}
		host, _ := assistantEndpointHost(p.Issuer)
		out = append(out, SystemOverviewIdentityProvider{ID: id, Label: label, IssuerHost: host})
	}
	return out
}

// replicaStartedAt is when this process began: package init is the earliest
// timestamp a binary can honestly claim about itself.
var replicaStartedAt = time.Now().UTC()

// SystemOverviewService assembles the two answers. It holds no store handle it
// does not pass a Caller to.
type SystemOverviewService struct {
	deps SystemOverviewDeps
	// ready is the server's own Readiness face — the source of the schema
	// version the readiness route answers with. Read per request, bounded by
	// the same deadline, and omitted on failure: a row that claims a version
	// the datastore did not report is the worse answer.
	ready  Readiness
	logger *slog.Logger
	now    func() time.Time
	limit  *keyedBucket
	client *http.Client
}

// NewSystemOverviewService wires the service over the resolved config.
func NewSystemOverviewService(deps SystemOverviewDeps, logger *slog.Logger) *SystemOverviewService {
	if logger == nil {
		logger = slog.New(slog.NewTextHandler(io.Discard, nil))
	}
	now := deps.now
	if now == nil {
		now = time.Now
	}
	client := deps.Egress
	if client == nil {
		client = &http.Client{Timeout: deps.probeTimeout() + 5*time.Second}
	}
	return &SystemOverviewService{
		deps:   deps,
		logger: logger,
		now:    now,
		// One probe per kind per ten seconds, per replica: burst 1 refilling
		// at six a minute. Deliberately in-memory and not through the
		// database — the effective fleet budget is replicas × one, which the
		// cost of one four-token completion makes safe (ADR-0077's reasoning,
		// and the same reason the probe is admin-only).
		limit:  newKeyedBucket(LimitSpec{PerMinute: 6, Burst: 1}, rateLimitMaxKeys, rateLimitIdleTTL, now),
		client: client,
	}
}

// probeTimeout is the configured probe deadline with the shipped default
// applied; both the limiter's clock window and the egress client read it.
func (d SystemOverviewDeps) probeTimeout() time.Duration {
	if d.ProbeTimeout > 0 {
		return d.ProbeTimeout
	}
	return defaultProbeTimeout
}

// Overview builds the object as the caller. Only the secret picture and the
// worker pair are caller- or store-dependent; everything else is the
// deployment's own answer.
func (s *SystemOverviewService) Overview(ctx context.Context, c Caller) (SystemOverview, error) {
	out := SystemOverview{
		Server: SystemOverviewServer{
			Version:       s.deps.Version,
			Commit:        BuildCommit(),
			Replica:       s.deps.Replica,
			SchemaVersion: s.schemaVersion(ctx),
			StartedAt:     replicaStartedAt,
		},
		Identity: SystemOverviewIdentity{
			Provider:  strings.TrimSpace(s.deps.IdentityProvider),
			Providers: s.signInProviders(),
			DevLogin:  s.deps.DevLogin,
		},
		Storage: SystemOverviewStorage{
			ArtifactBackend: strings.TrimSpace(s.deps.ArtifactBackend),
			PreviewHost:     strings.TrimSpace(s.deps.PreviewHost),
		},
		Models: s.Models(),
	}
	if out.Identity.Provider == "" {
		out.Identity.Provider = identityProviderOIDC
	}
	if host, ok := assistantEndpointHost(s.deps.IssuerURL); ok {
		out.Identity.IssuerHost = host
	}
	// The compatibility member is the first provider's host: under the providers
	// file `IssuerURL` is empty, and a reader that only knows `issuer_host` must
	// still name an issuer rather than nothing.
	if out.Identity.IssuerHost == "" && len(out.Identity.Providers) > 0 {
		out.Identity.IssuerHost = out.Identity.Providers[0].IssuerHost
	}

	counts, err := s.secretCounts(ctx, c)
	if err != nil {
		return out, err
	}
	out.Secrets = counts

	workers, err := s.workerCounts(ctx)
	if err != nil {
		return out, err
	}
	out.Workers = workers
	return out, nil
}

// schemaVersion reads the applied migration version through the server's own
// Readiness face — the same call the readiness route makes, over the same
// deadline — so the two routes cannot name different versions of one
// datastore. A failure answers 0: the overview does not re-explain an
// unreachable database, readiness does.
func (s *SystemOverviewService) schemaVersion(ctx context.Context) int64 {
	if s.ready == nil {
		return 0
	}
	readCtx, cancel := context.WithTimeout(ctx, readinessTimeout)
	defer cancel()
	v, err := s.ready.SchemaVersion(readCtx)
	if err != nil {
		return 0
	}
	return v
}

// Models builds the four model rows. The first three are the §2 checklist's
// rows flattened — same helpers, same config, same `configured` rule — and
// only `kind` and `label` are this file's.
func (s *SystemOverviewService) Models() []SystemOverviewModel {
	chat := assistantChatModel(s.deps.Chat)
	speech := assistantSpeechModel(s.deps.Models)
	decision := assistantDecisionModel(s.deps.Models)
	workerChat := workerChatStatus(s.deps.WorkerChat)
	// The checklist's chat row deliberately carries no key_set (it is not a
	// setup question there); the ops row is where that question is asked. The
	// worker row's key_set stays nil unless serve was handed the answer, for
	// the same reason: a replica that cannot see a worker's environment
	// cannot claim its key is missing.
	return []SystemOverviewModel{
		overviewModelRow(overviewKindAssistant, chat.Model, assistantHostOrEmpty(s.deps.Chat.BaseURL),
			boolPtr(strings.TrimSpace(s.deps.Chat.APIKey) != ""), chat.Configured),
		overviewModelRow(overviewKindSpeech, speech.Model, hostOrEmpty(speech.EndpointHost),
			speech.KeySet, speech.Configured),
		overviewModelRow(overviewKindDecision, decision.Model, hostOrEmpty(decision.EndpointHost),
			boolPtr(strings.TrimSpace(s.deps.DecisionAPIKey) != ""), decision.Configured),
		overviewModelRow(overviewKindWorkerChat, workerChat.Model, hostOrEmpty(workerChat.EndpointHost),
			s.deps.WorkerChat.KeySet, workerChat.Configured),
	}
}

// overviewModelRow flattens one row. An unconfigured row keeps the model id
// the deployment named: "configured: false, model: qwen3-asr" is the
// difference between a missing base URL and a missing allowlist entry, which
// is exactly what the operator has to fix.
func overviewModelRow(kind, model, host string, keySet *bool, configured bool) SystemOverviewModel {
	return SystemOverviewModel{
		Kind:         kind,
		Label:        overviewModelLabels[kind],
		Model:        model,
		EndpointHost: host,
		KeySet:       keySet,
		Configured:   configured,
	}
}

// workerChatStatus applies the checklist's own configured rule (a host AND a
// model) to the worker's triple: a base URL with no allowlist entry registers
// no model the worker would ever run.
func workerChatStatus(w WorkerChatConfig) AssistantModelStatus {
	row := AssistantModelStatus{Model: strings.TrimSpace(w.Model)}
	host, hostOK := assistantEndpointHost(w.BaseURL)
	row.Configured = hostOK && row.Model != ""
	if hostOK {
		h := host
		row.EndpointHost = &h
	}
	return row
}

// assistantHostOrEmpty reduces a config URL to its host, "" when there is no
// host to name.
func assistantHostOrEmpty(raw string) string {
	host, _ := assistantEndpointHost(raw)
	return host
}

func hostOrEmpty(host *string) string {
	if host == nil {
		return ""
	}
	return *host
}

// secretCounts counts the caller's projects, the DISTINCT secrets those
// projects can list, and the placements declared in them. Distinct matters:
// one org-scope secret is visible from every project the caller is in, and
// counting it per project would inflate the number the operator reads.
func (s *SystemOverviewService) secretCounts(ctx context.Context, c Caller) (SystemOverviewSecrets, error) {
	out := SystemOverviewSecrets{}
	if s.deps.Projects == nil {
		return out, nil
	}
	projects, err := s.deps.Projects.ListProjects(ctx, c)
	if err != nil {
		return out, err
	}
	out.Projects = len(projects)
	if s.deps.Secrets == nil {
		return out, nil
	}
	seenSecrets := map[string]bool{}
	seenMounts := map[string]bool{}
	for _, p := range projects {
		secrets, err := s.deps.Secrets.ListSecrets(ctx, c, p.ID)
		if err != nil {
			return out, err
		}
		for _, sec := range secrets {
			if !seenSecrets[sec.ID] {
				seenSecrets[sec.ID] = true
				out.Secrets++
			}
		}
		mounts, err := s.deps.Secrets.ListSecretMounts(ctx, c, p.ID)
		if err != nil {
			return out, err
		}
		for _, m := range mounts {
			if !seenMounts[m.ID] {
				seenMounts[m.ID] = true
				out.Mounts++
			}
		}
	}
	return out, nil
}

// workerCounts folds the registry's liveness-adjusted list into a pair. The
// store already applied the stale rule; the only thing computed here is the
// sum, and the window behind it is reported beside it.
func (s *SystemOverviewService) workerCounts(ctx context.Context) (SystemOverviewWorkers, error) {
	interval := s.deps.Heartbeat
	if interval <= 0 {
		interval = defaultWorkerHeartbeat
	}
	out := SystemOverviewWorkers{
		StaleAfterSeconds: int(interval * workerLivenessIntervals / time.Second),
	}
	if s.deps.Workers == nil {
		return out, nil
	}
	rows, err := s.deps.Workers.ListWorkers(ctx)
	if err != nil {
		return out, err
	}
	for _, w := range rows {
		if strings.EqualFold(strings.TrimSpace(w.Status), "online") {
			out.Online++
		} else {
			out.Offline++
		}
	}
	return out, nil
}

// --- the probe -----------------------------------------------------------

// probeChatRequest is the fixed completion the chat kinds send. No tools, no
// temperature, no `chat_template_kwargs`: the question is two words and the
// ceiling is four tokens, so nothing but reachability and the model id are in
// the balance.
type probeChatRequest struct {
	Model     string             `json:"model"`
	Messages  []probeChatMessage `json:"messages"`
	MaxTokens int                `json:"max_tokens"`
}

type probeChatMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

// probeReply is the slice of a completion this route reads. `error` is the
// shape gateway-style endpoints answer with even on a 200 — the same reading
// internal/assistant makes of the same endpoints.
type probeReply struct {
	Choices []json.RawMessage `json:"choices"`
	Error   *struct {
		Message string `json:"message"`
	} `json:"error"`
}

// probeModelsReply is the GET {base}/models envelope the speech kind reads.
type probeModelsReply struct {
	Data []struct {
		ID string `json:"id"`
	} `json:"data"`
	Error *struct {
		Message string `json:"message"`
	} `json:"error"`
}

// ProbeKind reports whether a {kind} path value names an endpoint this replica
// can reach at all. The set is closed and the comparison is case-folded: the
// row names on the overview are the only probe targets, and `worker_chat` is
// deliberately not one of them.
func ProbeKind(kind string) bool {
	return overviewProbeKinds[strings.ToLower(strings.TrimSpace(kind))]
}

// Probe asks one endpoint the fixed question and returns the verdict, the
// latency it took and the client-facing detail ("" on success). An
// unconfigured kind is answered, not refused: "this deployment has no speech
// endpoint" is the operator's real answer, and it belongs in the same body a
// configured probe returns.
func (s *SystemOverviewService) Probe(ctx context.Context, kind string) (bool, int64, string) {
	target, refusal := s.probeTarget(kind)
	if refusal != "" {
		return false, 0, refusal
	}
	ctx, cancel := context.WithTimeout(ctx, s.deps.probeTimeout())
	defer cancel()

	start := s.now()
	var (
		ok     bool
		detail string
	)
	if target.speech {
		ok, detail = s.probeSpeechModel(ctx, target)
	} else {
		ok, detail = s.probeChatModel(ctx, target)
	}
	return ok, s.now().Sub(start).Milliseconds(), detail
}

// probeTarget is one endpoint's egress triple plus the shape of the question.
type probeTarget struct {
	baseURL string
	apiKey  string
	model   string
	speech  bool
}

// probeTarget resolves a kind to its endpoint, or to the sentence that says
// why there is none. The variable names in the refusals are deliberate: an
// admin reading an `ok: false` on the ops page is exactly the person who can
// set them.
func (s *SystemOverviewService) probeTarget(kind string) (probeTarget, string) {
	switch strings.ToLower(strings.TrimSpace(kind)) {
	case overviewKindAssistant:
		root := strings.TrimRight(strings.TrimSpace(s.deps.Chat.BaseURL), "/")
		if root == "" {
			return probeTarget{}, "no assistant endpoint is configured on this deployment (set COMMUNICATION_ASSISTANT_BASE_URL)."
		}
		return probeTarget{baseURL: root, apiKey: s.deps.Chat.APIKey, model: s.deps.Chat.Model}, ""
	case overviewKindDecision:
		root := strings.TrimRight(strings.TrimSpace(s.deps.Models.DecisionBaseURL), "/")
		model := strings.TrimSpace(s.deps.Models.DecisionModel)
		if root == "" || model == "" {
			return probeTarget{}, "no decision model is configured on this deployment (set COMMUNICATION_DECISION_BASE_URL and COMMUNICATION_DECISION_MODEL)."
		}
		return probeTarget{baseURL: root, apiKey: s.deps.DecisionAPIKey, model: model}, ""
	default: // overviewKindSpeech
		root := strings.TrimRight(strings.TrimSpace(s.deps.Models.SpeechBaseURL), "/")
		model := strings.TrimSpace(s.deps.Models.SpeechModel)
		if root == "" || model == "" {
			return probeTarget{}, "no speech endpoint is configured on this deployment (set COMMUNICATION_SPEECH_BASE_URL and COMMUNICATION_SPEECH_MODEL)."
		}
		return probeTarget{baseURL: root, apiKey: s.deps.Models.SpeechAPIKey, model: model, speech: true}, ""
	}
}

// probeChatModel issues ONE completion against {base}/chat/completions. The
// egress rules are the assistant broker's own — a server root plus this path,
// the key in a single Authorization header and nowhere else, the response
// capped at the broker's own body limit, the upstream's error message the only
// text echoed — restated here because the broker's tool loop cannot be asked
// a two-word question under a four-token ceiling.
func (s *SystemOverviewService) probeChatModel(ctx context.Context, t probeTarget) (bool, string) {
	body, err := json.Marshal(probeChatRequest{
		Model:     t.model,
		Messages:  []probeChatMessage{{Role: "user", Content: probePrompt}},
		MaxTokens: probeMaxTokens,
	})
	if err != nil {
		return false, "the probe request could not be built"
	}
	raw, status, err := s.egress(ctx, t, http.MethodPost, t.baseURL+"/chat/completions", body)
	if err != nil {
		return false, s.transportFailure(t, err)
	}
	var reply probeReply
	if len(raw) > 0 {
		_ = json.Unmarshal(raw, &reply)
	}
	if reply.Error != nil && strings.TrimSpace(reply.Error.Message) != "" {
		return false, probeDetail(reply.Error.Message, t.apiKey)
	}
	if status < 200 || status > 299 {
		return false, probeDetail(statusDetail(status), t.apiKey)
	}
	if len(reply.Choices) == 0 {
		return false, probeDetail("the endpoint answered without a completion", t.apiKey)
	}
	return true, ""
}

// probeSpeechModel asks the transcription endpoint which models it serves and
// looks for the configured id. GET /models, never an audio upload: proving the
// key and the model id are good needs no bytes on the wire, and a probe that
// transcribed something would bill audio for a question that needs none.
func (s *SystemOverviewService) probeSpeechModel(ctx context.Context, t probeTarget) (bool, string) {
	raw, status, err := s.egress(ctx, t, http.MethodGet, t.baseURL+"/models", nil)
	if err != nil {
		return false, s.transportFailure(t, err)
	}
	var reply probeModelsReply
	if len(raw) > 0 {
		_ = json.Unmarshal(raw, &reply)
	}
	if reply.Error != nil && strings.TrimSpace(reply.Error.Message) != "" {
		return false, probeDetail(reply.Error.Message, t.apiKey)
	}
	if status < 200 || status > 299 {
		return false, probeDetail(statusDetail(status), t.apiKey)
	}
	for _, m := range reply.Data {
		if strings.TrimSpace(m.ID) == t.model {
			return true, ""
		}
	}
	// A list that came back without the configured id is the honest failure,
	// and naming the id is safe: it is already on the row this caller can read.
	return false, probeDetail("model \""+t.model+"\" is not currently available", t.apiKey)
}

// egress sends one request with the key in a header only, and returns the
// response body capped to the assistant broker's own limit. The error is the
// transport's — this file never shows it to a caller, because it can carry the
// full URL.
func (s *SystemOverviewService) egress(ctx context.Context, t probeTarget, method, url string, body []byte) ([]byte, int, error) {
	var rdr io.Reader
	if body != nil {
		rdr = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, url, rdr)
	if err != nil {
		return nil, 0, err
	}
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if strings.TrimSpace(t.apiKey) != "" {
		req.Header.Set("Authorization", "Bearer "+t.apiKey)
	}
	resp, err := s.client.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer resp.Body.Close()
	raw, readErr := io.ReadAll(io.LimitReader(resp.Body, assistant.BodyLimit+1))
	if readErr != nil {
		return nil, resp.StatusCode, readErr
	}
	if len(raw) > assistant.BodyLimit {
		return nil, resp.StatusCode, errProbeResponseTooLarge
	}
	return raw, resp.StatusCode, nil
}

// errProbeResponseTooLarge refuses a runaway gateway rather than draining it.
var errProbeResponseTooLarge = errors.New("api: model probe response exceeds the egress body limit")

// transportFailure is the client-facing line for a request that never got an
// answer. It names the host the row already shows and the deadline it hit.
func (s *SystemOverviewService) transportFailure(t probeTarget, err error) string {
	host, _ := assistantEndpointHost(t.baseURL)
	if host == "" {
		host = "the endpoint"
	}
	switch {
	case errors.Is(err, errProbeResponseTooLarge):
		return probeDetail(host+" sent more than the probe's response limit", t.apiKey)
	case errors.Is(err, context.DeadlineExceeded), errors.Is(err, io.ErrUnexpectedEOF):
		return probeDetail(host+" did not answer the probe in "+secondsWords(s.deps.probeTimeout()), t.apiKey)
	default:
		return probeDetail(host+" could not be reached", t.apiKey)
	}
}

// probeDetail is the one gate a client-facing detail passes through: collapse
// to a single line, redact the key (an endpoint that echoes its own
// Authorization header must not teach the browser its value), truncate to
// probeDetailMaxChars characters. Only the upstream MESSAGE reaches it — never
// headers, never the request.
func probeDetail(s, key string) string {
	out := strings.Join(strings.Fields(s), " ")
	if k := strings.TrimSpace(key); len(k) >= 8 {
		out = strings.ReplaceAll(out, k, "[redacted]")
	}
	if r := []rune(out); len(r) > probeDetailMaxChars {
		return string(r[:probeDetailMaxChars-1]) + "…"
	}
	return out
}

// statusDetail names a status without repeating a body.
func statusDetail(status int) string {
	switch status {
	case http.StatusUnauthorized, http.StatusForbidden:
		return "the endpoint refused the configured key"
	case http.StatusNotFound:
		return "the endpoint has no route for that path"
	default:
		return "the endpoint answered " + http.StatusText(status)
	}
}

// secondsWords renders a deadline the way a sentence wants it.
func secondsWords(d time.Duration) string {
	if s := int(d.Seconds()); s > 0 {
		return strconv.Itoa(s) + " seconds"
	}
	return d.String()
}

func boolPtr(v bool) *bool { return &v }

// --- the routes ----------------------------------------------------------

// RegisterSystemOverview mounts the two ops routes. Both are session-authed;
// the read is for any signed-in member (nothing in it is secret), and the
// probe is the organization's admin's alone. CSRF rides every POST here the
// way it rides every other mutation: HandleAuthed installs it from the pattern.
func RegisterSystemOverview(s *Server, svc *SystemOverviewService) {
	// The schema version is the readiness route's own read, taken through the
	// server's Readiness face so the two answers come from one source.
	if s != nil && svc != nil {
		svc.ready = s.ready
	}
	h := &opsHandlers{svc: svc, srv: s}
	s.HandleAuthed("GET /api/v1/system/overview", http.HandlerFunc(h.overview))
	s.HandleAuthed("POST /api/v1/system/models/{kind}/probe", http.HandlerFunc(h.probe))
}

type opsHandlers struct {
	svc *SystemOverviewService
	srv *Server
}

func (h *opsHandlers) overview(w http.ResponseWriter, r *http.Request) {
	if h.svc == nil {
		h.fail(w, r, errors.New("api: no system overview service wired"))
		return
	}
	c, ok := opsCaller(w, r)
	if !ok {
		return
	}
	view, err := h.svc.Overview(r.Context(), c)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	// no-store: every field is a live fact about a fleet that changes while
	// the page is open, and a stale "1 online" is worse than none.
	w.Header().Set("Cache-Control", "no-store")
	WriteJSON(w, http.StatusOK, view)
}

func (h *opsHandlers) probe(w http.ResponseWriter, r *http.Request) {
	if h.svc == nil {
		h.fail(w, r, errors.New("api: no system overview service wired"))
		return
	}
	c, ok := opsCaller(w, r)
	if !ok {
		return
	}
	if !c.IsOrgAdmin {
		// A probe spends the deployment's model budget and reaches a third
		// party with its key: that is the library role's call, not any
		// member's. The answer is the same for a kind that does not exist —
		// the role is decided before the path value is read.
		WriteProblem(w, http.StatusForbidden, "Forbidden",
			"Probing a model endpoint requires the organization's library role.")
		return
	}
	kind := r.PathValue("kind")
	if !ProbeKind(kind) {
		// A kind outside the closed set is a client error, not a probe result:
		// answering 200 here would let a typo in the UI read as "the model is
		// down", which is the one thing this route exists to distinguish.
		WriteProblem(w, http.StatusBadRequest, "Bad Request",
			"kind must be assistant, speech or decision.")
		return
	}
	// The limiter is keyed on the canonical kind, so `ASSISTANT` cannot dodge
	// `assistant`'s spent bucket.
	if allowed, retry := h.svc.limit.allow(strings.ToLower(strings.TrimSpace(kind))); !allowed {
		writeRateLimited(w, retry, "One model probe per kind every 10 seconds; try again shortly.")
		return
	}
	probed, latency, detail := h.svc.Probe(r.Context(), kind)
	// The outcome is an operator fact: kind, verdict, latency, detail. The
	// key, the request body and the raw upstream response stay out of the
	// line (ADR-0018 D1's discipline, applied on the response side).
	h.svc.logger.Info("model probe",
		slog.String("kind", kind),
		slog.Bool("ok", probed),
		slog.Int64("latency_ms", latency),
		slog.String("detail", detail),
	)
	w.Header().Set("Cache-Control", "no-store")
	WriteJSON(w, http.StatusOK, ModelProbeResult{OK: probed, LatencyMS: latency, Detail: detail})
}

// opsCaller is the caller both routes read. RequireAuth already answered a
// missing session with 401, so reaching this without one is a wiring bug —
// answered 401 anyway rather than as a 500 that hides it.
func opsCaller(w http.ResponseWriter, r *http.Request) (Caller, bool) {
	p, ok := PrincipalFrom(r.Context())
	if !ok {
		WriteProblem(w, http.StatusUnauthorized, "Unauthenticated", "A valid session is required.")
		return Caller{}, false
	}
	return Caller{UserID: p.UserID, OrganizationID: p.OrganizationID, IsOrgAdmin: p.IsOrgAdmin}, true
}

func (h *opsHandlers) fail(w http.ResponseWriter, r *http.Request, err error) {
	h.srv.logger.ErrorContext(r.Context(), "system overview failed",
		slog.String("error", err.Error()), slog.String("request_id", RequestIDFrom(r)))
	// A store error may name tables or connection details; the client gets the
	// request id to quote instead (ADR-0014 § 2).
	WriteProblem(w, http.StatusInternalServerError, "Internal Server Error",
		"The server could not read its own state. Use the request id when reporting it.")
}

// BuildCommit names the revision this binary was built from, or "" when it
// carries no claim to one: `go build` records the VCS revision in the binary,
// and an ADR-0004 release build stamps main.version through -ldflags from the
// same commit, so the two sources agree by construction and neither is
// guessed. Exported because the ops row shows it and a test must be able to
// ask for it.
func BuildCommit() string {
	bi, ok := debug.ReadBuildInfo()
	if !ok {
		return ""
	}
	for _, kv := range bi.Settings {
		if kv.Key == "vcs.revision" && isHexRev(kv.Value) {
			return shortRev(kv.Value)
		}
	}
	return ""
}

// isHexRev accepts an abbreviated or full commit hash and nothing else, so a
// pseudo-version tail can never be mistaken for a revision.
func isHexRev(s string) bool {
	if len(s) < 7 || len(s) > 40 {
		return false
	}
	for _, c := range s {
		switch {
		case c >= '0' && c <= '9':
		case c >= 'a' && c <= 'f':
		case c >= 'A' && c <= 'F':
		default:
			return false
		}
	}
	return true
}

// shortRev is git's own default abbreviation length.
func shortRev(s string) string {
	if len(s) > 7 {
		return s[:7]
	}
	return s
}

// ArtifactBackendName names the artifact backend a process talks to, in the
// store's own vocabulary (`local`/`s3`). A backend that does not name itself
// answers "" — the row shows the absence rather than assuming local.
func ArtifactBackendName(store artifacts.Store) string {
	if store == nil {
		return ""
	}
	if n, ok := store.(interface{ Backend() string }); ok {
		return n.Backend()
	}
	return ""
}
