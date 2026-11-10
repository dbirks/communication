package assistant

// ADR-0050 decision 4: the closed tool-class table and the server-side
// trust gate. The trust level comes from
// user_preferences.assistant.trust_level (ADR-0046, C2 contract) and is
// consulted HERE, server-side, before a gated tool executes — a client's
// own setting is never the control. Gating authorizes nothing: every
// execution still goes through the permission-checked service as the
// caller's own Caller.

import "strings"

// ToolClass is one row of the ADR's classification table. Every tool is
// exactly one class; a name outside the closed table is refused by the
// registry before the class question is even asked.
type ToolClass int

const (
	// ClassRead never gates: a read tool is a store method an existing
	// route already serves to this caller.
	ClassRead ToolClass = iota
	// ClassNavigate is client-side presentation of an already-authorized
	// state: the server executes nothing, so it never gates.
	ClassNavigate
	// ClassDraftEdit edits a draft through the version-checked PUT path.
	// ask_all gates it; ask_risky and no_ask do not.
	ClassDraftEdit
	// ClassRisky mutates pipeline state (runs, approvals, permissions,
	// publishes). ask_all and ask_risky gate it; no_ask does not — but
	// every no_ask action still lands in the change log (decision 4).
	ClassRisky
)

// TrustLevel is the stored preference value (ADR-0046).
type TrustLevel string

const (
	TrustAskAll   TrustLevel = "ask_all"
	TrustAskRisky TrustLevel = "ask_risky"
	TrustNoAsk    TrustLevel = "no_ask"
)

// toolClasses is the closed table of decision 4. The v1 read registry's
// six names plus draft.get and the workflow.draft lookup, the navigation
// tool, the draft-edit tool and the five risky actions.
var toolClasses = map[string]ToolClass{
	"project.list":       ClassRead,
	"run.list":           ClassRead,
	"run.nodes":          ClassRead,
	"approval.pending":   ClassRead,
	"pipeline.revisions": ClassRead,
	"palette.search":     ClassRead,
	"draft.get":          ClassRead,
	"workflow.draft":     ClassRead,
	"chat.transcript":    ClassRead,
	"system.status":      ClassRead,
	// Assistant handoff §6 (CONTRACT §5): the setup reads.
	"credential.list":       ClassRead,
	"docs.search":           ClassRead,
	"workflow.list":         ClassRead,
	"workflow.inspect":      ClassRead,
	"repo.check":            ClassRead,
	"issue.list":            ClassRead,
	"profile.list":          ClassRead,
	"schedule.list":         ClassRead,
	"ui.navigate":           ClassNavigate,
	"ui.question":           ClassNavigate,
	"draft.apply":           ClassDraftEdit,
	"workflow.create_draft": ClassDraftEdit,
	// Assistant handoff §6 (CONTRACT §5): the setup writes. Each one runs
	// through the SAME permission-checked store call the matching UI route
	// runs, as the caller — the class only decides when a human is asked.
	"project.create":   ClassRisky,
	"repo.add":         ClassRisky,
	"assignment.set":   ClassRisky,
	"run.cancel":       ClassRisky,
	"schedule.create":  ClassRisky,
	"run.retry":        ClassRisky,
	"run.start":        ClassRisky,
	"approval.decide":  ClassRisky,
	"permission.allow": ClassRisky,
	"pipeline.publish": ClassRisky,
}

// ClassOf reports the class of a registry tool name; the bool is false for
// a name outside the closed table.
func ClassOf(name string) (ToolClass, bool) {
	c, ok := toolClasses[name]
	return c, ok
}

// NormalizeTrustLevel maps a stored preference onto the closed set. The
// ADR-0046 default is ask_risky: an empty, corrupt or unknown stored
// value must fall to the middle posture, never to no_ask.
func NormalizeTrustLevel(l TrustLevel) TrustLevel {
	switch l {
	case TrustAskAll, TrustNoAsk:
		return l
	default:
		return TrustAskRisky
	}
}

// Gates answers decision 4's table for one tool class:
//
//	class        ask_all   ask_risky (default)   no_ask
//	read          no         no                    no
//	navigate      no         no                    no
//	draft_edit    yes        no                    no
//	risky         yes        yes                   no
//
// A gated call does not execute: the turn stops and records an
// approval_request row (decision 4's gate mechanics).
func (l TrustLevel) Gates(c ToolClass) bool {
	switch l {
	case TrustAskAll:
		return c == ClassDraftEdit || c == ClassRisky
	case TrustNoAsk:
		return false
	default: // ask_risky and anything unrecognized
		return c == ClassRisky
	}
}

// riskText is the stable one-sentence risk line the approval_request row
// carries (decision 3): what the action will do to real state. It is a
// server-registered string, never model text.
func riskText(tool string) string {
	switch tool {
	case "run.start":
		return "starts a new pipeline run, which executes its agent nodes and consumes work"
	case "run.retry":
		return "re-runs the failed node of an existing run with its recorded retry context"
	case "approval.decide":
		return "records your approval decision; the pipeline then acts on it"
	case "permission.allow":
		return "grants the permission the agent asked for on this run"
	case "pipeline.publish":
		return "publishes the draft as a new revision of the pipeline"
	case "workflow.create_draft":
		return "creates a NEW workflow library draft (it never publishes — publishing stays a separate action you take yourself)"
	case "project.create":
		return "creates a real project, and with a repository URL attaches that repository and its credential in the same step"
	case "repo.add":
		return "attaches a git repository (and the credential it is cloned with) to an existing project"
	case "assignment.set":
		return "pins a workflow's latest published revision to the project, so every NEW run of it uses that revision"
	case "run.cancel":
		return "requests a run's cancellation: no further nodes start, work already in flight finishes, and a cancelled run never resumes"
	case "schedule.create":
		return "creates a cron schedule that starts new runs of the pinned revision on a timer (UTC)"
	default:
		return "performs a state-changing pipeline action"
	}
}

// actionSummary renders the short server-supplied sentence that names the
// proposed action (the approval row's `summary` and the change row's
// summary for confirmed actions). It names only the args the model
// supplied, bounded like every other tool arg.
func actionSummary(tool string, args map[string]string) string {
	verb := map[string]string{
		"run.start":             "Start a run",
		"run.retry":             "Retry node",
		"approval.decide":       "Record decision",
		"permission.allow":      "Grant permission",
		"pipeline.publish":      "Publish draft",
		"workflow.create_draft": "Save library draft",
		"repo.add":              "Add repository",
		"run.cancel":            "Cancel run",
		"schedule.create":       "Create schedule",
	}[tool]
	if verb == "" {
		verb = "Run"
	}
	// project.create reads as the proposal card, not as an id dump: the
	// project's new name, plus the repository it will attach (owner/repo, not
	// the URL), so the card says what appears where.
	if tool == "project.create" {
		s := "Create project"
		if name := bounded(strings.TrimSpace(args["name"]), 64); name != "" {
			s += " " + name
		}
		if repo := shortRepo(args["repo_url"]); repo != "" {
			s += " with " + repo
		}
		return s
	}
	// assignment.set names the revision it will pin (the promotion preview):
	// the version label the model read from workflow.inspect, or the honest
	// "latest published" when it read none. The pin itself is resolved
	// server-side at execution; this line only shows the preview.
	if tool == "assignment.set" {
		s := "Assign workflow"
		if v := bounded(strings.TrimSpace(args["pipeline_id"]), 64); v != "" {
			s += " " + v
		}
		if rev := bounded(strings.TrimSpace(args["revision"]), 64); rev != "" {
			return s + " · pins " + rev
		}
		return s + " · pins the latest published revision"
	}
	var bits []string
	for _, k := range []string{"project_id", "run_id", "node_id", "pipeline_id", "approval_id", "request_id", "draft_id", "decision", "slug", "name", "repo_url", "credential", "default_branch", "cron"} {
		if v := bounded(strings.TrimSpace(args[k]), 64); v != "" {
			if k == "repo_url" {
				if v = shortRepo(v); v == "" {
					continue
				}
			}
			bits = append(bits, v)
		}
	}
	if len(bits) == 0 {
		return verb
	}
	return verb + " " + strings.Join(bits, " · ")
}
