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
// six names plus draft.get, the navigation tool, the draft-edit tool and
// the five risky actions.
var toolClasses = map[string]ToolClass{
	"project.list":       ClassRead,
	"run.list":           ClassRead,
	"run.nodes":          ClassRead,
	"approval.pending":   ClassRead,
	"pipeline.revisions": ClassRead,
	"palette.search":     ClassRead,
	"draft.get":          ClassRead,
	"ui.navigate":        ClassNavigate,
	"ui.question":        ClassNavigate,
	"draft.apply":        ClassDraftEdit,
	"run.retry":          ClassRisky,
	"run.start":          ClassRisky,
	"approval.decide":    ClassRisky,
	"permission.allow":   ClassRisky,
	"pipeline.publish":   ClassRisky,
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
		"run.start":        "Start a run",
		"run.retry":        "Retry node",
		"approval.decide":  "Record decision",
		"permission.allow": "Grant permission",
		"pipeline.publish": "Publish draft",
	}[tool]
	if verb == "" {
		verb = "Run"
	}
	var bits []string
	for _, k := range []string{"project_id", "run_id", "node_id", "pipeline_id", "approval_id", "request_id", "draft_id", "decision"} {
		if v := bounded(strings.TrimSpace(args[k]), 64); v != "" {
			bits = append(bits, v)
		}
	}
	if len(bits) == 0 {
		return verb
	}
	return verb + " " + strings.Join(bits, " · ")
}
