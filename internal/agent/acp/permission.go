package acp

import (
	"github.com/coder/acp-go-sdk"
)

// PermissionPolicy decides how the client answers ACP
// session/request_permission calls. It mirrors the profile-level
// permission modes in communication-spec/04-agent-runtime.md.
type PermissionPolicy string

const (
	// PermissionDeny rejects tool calls: the client selects the first
	// reject_once / reject_always option, and reports the cancelled
	// outcome when the agent offered no reject option at all.
	PermissionDeny PermissionPolicy = "deny"

	// PermissionPreapproved auto-selects allow_once (falling back to
	// allow_always) under the assumption that real isolation comes from the
	// sandbox, not from this policy. Auto-approving ACP prompts is NOT a
	// substitute for sandbox isolation.
	PermissionPreapproved PermissionPolicy = "preapproved_within_sandbox"

	// PermissionAsk would surface the request to a human. Out of scope for
	// M0: treated as PermissionDeny with a logged warning.
	PermissionAsk PermissionPolicy = "ask"
)

// selectPermissionOption picks the permission option mandated by the
// handle's policy. ok=false means no usable option existed and the caller
// must answer with the cancelled outcome.
func (h *handle) selectPermissionOption(params acp.RequestPermissionRequest) (acp.PermissionOptionId, bool) {
	policy := h.policy
	if policy == PermissionAsk {
		if h.logger != nil {
			h.logger.Warn("acp: ask permission policy is out of scope for M0; falling back to deny",
				"tool_call_id", string(params.ToolCall.ToolCallId))
		}
		policy = PermissionDeny
	}

	var primary, secondary acp.PermissionOptionKind
	switch policy {
	case PermissionPreapproved:
		primary, secondary = acp.PermissionOptionKindAllowOnce, acp.PermissionOptionKindAllowAlways
	default: // PermissionDeny and any unknown policy value: deny by default.
		primary, secondary = acp.PermissionOptionKindRejectOnce, acp.PermissionOptionKindRejectAlways
	}

	if id, ok := findOptionKind(params.Options, primary); ok {
		return id, true
	}
	if id, ok := findOptionKind(params.Options, secondary); ok {
		return id, true
	}
	if h.logger != nil {
		h.logger.Warn("acp: permission request offered no option compatible with policy",
			"policy", string(policy), "tool_call_id", string(params.ToolCall.ToolCallId))
	}
	return "", false
}

func findOptionKind(options []acp.PermissionOption, kind acp.PermissionOptionKind) (acp.PermissionOptionId, bool) {
	for _, o := range options {
		if o.Kind == kind {
			return o.OptionId, true
		}
	}
	return "", false
}
