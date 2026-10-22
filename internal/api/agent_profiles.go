package api

// The writable half of the agent profile surface (ADR-0030): the POST/PATCH
// routes mounted beside the M2 listing in RegisterConversations.
//
// Two things are deliberately not writable here:
//
//   - permission_mode. 'ask' is the column default and the only mode an
//     unverified launcher may have (04-agent-runtime.md "Permission policy",
//     ADR-0009); preapproved_within_sandbox needs sandbox evidence for that
//     launcher, which lives in docs/compatibility/, not in a request body.
//   - the sandbox / workspace / commit axes. They are separate grant decisions
//     with separate evidence.
//
// What IS writable is the APM pin: all three columns at once (a locked pin —
// the operator recorded a digest), just the ref + target (an UNLOCKED pin,
// ADR-0054 amendment 2 — the digest is the operator's to record through the
// lock flow), or all three cleared (the clear). A package ref with no recorded
// lock digest stages whatever the upstream points at today (probe A5b), so a
// pin that is not locked is not a partial success — it is a launch-time refusal
// for somebody else's conversation. The store refuses the partial shapes and
// the handler does the same, before either touches a database.

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"regexp"
	"strings"
)

// Profile write errors: the api-side sentinels the store adapter maps onto. The
// 404-vs-403 rule is the conversation surface's (ADR-0014 §3): a profile in
// another organization does not exist, a profile you can see but not write is
// 403.
var (
	ErrProfileNotFound  = errors.New("api: agent profile not found")
	ErrProfileForbidden = errors.New("api: agent profile write not allowed")
	ErrProfileConflict  = errors.New("api: agent profile name already exists")
	// ErrProfileValidation covers every named 422 in this file; the code travels
	// inside *AgentProfileProblemError when there is one.
	ErrProfileValidation = errors.New("api: agent profile request failed validation")
)

// AgentProfileProblemError is a 422 that names its ADR-0030 code, so a client
// switches on `apm_pin_incomplete` rather than on a sentence. It unwraps to
// ErrProfileValidation, so a handler that only understands the sentinel still
// maps it correctly.
type AgentProfileProblemError struct {
	Code   string
	Detail string
}

func (e *AgentProfileProblemError) Error() string {
	if e == nil {
		return "api: agent profile request failed validation"
	}
	return "api: agent profile request failed validation (" + e.Code + "): " + e.Detail
}

func (e *AgentProfileProblemError) Unwrap() error { return ErrProfileValidation }

// ADR-0030's named codes, re-declared here because the handler can refuse a
// partial triple without a database round trip. The store enforces the same
// names; adding one is additive, renaming one is not.
const (
	ProfileCodeAPMIncomplete = "apm_pin_incomplete"
	ProfileCodeNameInvalid   = "profile_name_invalid"
	ProfileCodeLauncherBad   = "launcher_id_invalid"
)

// AgentProfileCreateInput is POST /api/v1/agent-profiles' body.
type AgentProfileCreateInput struct {
	Name       string `json:"name"`
	LauncherID string `json:"launcher_id"`
}

// AgentProfileAPMPatch is PATCH /api/v1/agent-profiles/{profileId}'s body. A nil
// pointer means the member was absent; the three members are set together or
// cleared together (nil or empty), and any other shape is 422.
type AgentProfileAPMPatch struct {
	APMPackageRef *string `json:"apm_package_ref"`
	APMTarget     *string `json:"apm_target"`
	APMLockDigest *string `json:"apm_lock_digest"`
}

// apmPinComplete is the all-or-nothing rule as the handler states it. The store
// re-checks it (it must: it is the last thing between a request and the column).
// A pin is either all three set (locked — the operator recorded a digest), just
// the ref + target (unlocked, ADR-0054 amendment 2 — the digest is the
// operator's to record through the lock flow), or all three cleared (the clear).
// Any other shape is a half pin and is 422.
func apmPinComplete(in AgentProfileAPMPatch) bool {
	hasRef := in.APMPackageRef != nil && *in.APMPackageRef != ""
	hasTarget := in.APMTarget != nil && *in.APMTarget != ""
	hasDigest := in.APMLockDigest != nil && *in.APMLockDigest != ""
	switch {
	case !hasRef && !hasTarget && !hasDigest:
		return true // the clear
	case hasRef && hasTarget:
		return true // locked (all three) or unlocked (ref + target, digest optional)
	default:
		return false // partial
	}
}

// --- handlers -----------------------------------------------------------

func (h *cnvHandlers) createProfile(w http.ResponseWriter, r *http.Request) {
	c, ok := h.caller(w, r)
	if !ok {
		return
	}
	var body AgentProfileCreateInput
	if err := DecodeJSON(r, &body); err != nil {
		h.badRequest(w, r, err)
		return
	}
	body.Name = strings.TrimSpace(body.Name)
	if body.Name == "" || len(body.Name) > cnvMaxTitleLen {
		profProblem(w, ProfileCodeNameInvalid, "name is required and must be at most 200 characters.")
		return
	}
	if !cnvLauncherPattern.MatchString(body.LauncherID) {
		profProblem(w, ProfileCodeLauncherBad,
			"launcher_id must match ^[a-z0-9][a-z0-9_-]{0,63}$ — a launcher registry id, never a command line.")
		return
	}
	if !c.IsOrgAdmin {
		h.profileDenied(w, r, c, "", "profile.create", "the library role is required")
		WriteProblem(w, http.StatusForbidden, "Forbidden",
			"Creating an agent profile requires the organization's library role.")
		return
	}
	profile, err := h.profiles.CreateAgentProfile(r.Context(), c, body)
	if err != nil {
		h.profileFail(w, r, c, "", "profile.create", err)
		return
	}
	WriteJSON(w, http.StatusCreated, profile)
}

func (h *cnvHandlers) patchProfile(w http.ResponseWriter, r *http.Request) {
	c, ok := h.caller(w, r)
	if !ok {
		return
	}
	profileID := r.PathValue("profileId")
	var body AgentProfileAPMPatch
	if err := DecodeJSON(r, &body); err != nil {
		h.badRequest(w, r, err)
		return
	}
	if !apmPinComplete(body) {
		profProblem(w, ProfileCodeAPMIncomplete,
			"an apm pin is either all three set (locked) or just the ref and target (unlocked); a partial pin is refused.")
		return
	}
	if !validUUID(profileID) {
		h.profileDenied(w, r, c, profileID, "profile.update", "malformed profile id")
		WriteProblem(w, http.StatusNotFound, "Not Found", "No such agent profile.")
		return
	}
	profile, err := h.profiles.PatchAgentProfileAPM(r.Context(), c, profileID, body)
	if err != nil {
		h.profileFail(w, r, c, profileID, "profile.update", err)
		return
	}
	WriteJSON(w, http.StatusOK, profile)
}

// --- shared plumbing ----------------------------------------------------

// cnvLauncherPattern is agent_profiles.launcher_id's CHECK, restated so a
// malformed id is a named 422 rather than a database error.
var cnvLauncherPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,63}$`)

// profProblemTitle turns a code into the problem title, so the two stable strings
// a client may switch on (`code`, `type`) are derived from one name rather than
// maintained as parallel lists.
func profProblemTitle(code string) string {
	switch code {
	case ProfileCodeAPMIncomplete:
		return "Incomplete APM Pin"
	case ProfileCodeNameInvalid:
		return "Invalid Profile Name"
	case ProfileCodeLauncherBad:
		return "Invalid Launcher Id"
	default:
		return "Validation Failed"
	}
}

// profProblem writes the 422 every profile refusal shares: a Problem document
// plus the ADR-0030 `code` member and the matching stable `type` URI. The code is
// the contract — the prose beside it may change.
func profProblem(w http.ResponseWriter, code, detail string) {
	profProblemStatus(w, http.StatusUnprocessableEntity, code, profProblemTitle(code), detail)
}

func profProblemStatus(w http.ResponseWriter, status int, code, title, detail string) {
	typ := "about:blank"
	if code != "" {
		typ = "https://communication.dev/errors/" + code
	}
	if title == "" {
		title = http.StatusText(status)
	}
	h := w.Header()
	h.Set("Content-Type", ProblemJSON)
	h.Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(struct {
		Type   string `json:"type"`
		Title  string `json:"title"`
		Status int    `json:"status"`
		Detail string `json:"detail,omitempty"`
		Code   string `json:"code,omitempty"`
	}{typ, title, status, detail, code})
}

// profileFail maps a profile store error onto the HTTP contract: 404 for a
// profile outside the caller's organization (with the audit row ADR-0014 §3 asks
// for), 403 for a member without the library role, 409 for a taken name, and the
// named 422 for every coded refusal.
func (h *cnvHandlers) profileFail(w http.ResponseWriter, r *http.Request, c Caller, profileID, action string, err error) {
	var problem *AgentProfileProblemError
	if errors.As(err, &problem) {
		profProblem(w, problem.Code, problem.Detail)
		return
	}
	switch {
	case errors.Is(err, ErrProfileNotFound):
		h.profileDenied(w, r, c, profileID, action, "no such agent profile, or it is not in your organization")
		WriteProblem(w, http.StatusNotFound, "Not Found", "No such agent profile.")
	case errors.Is(err, ErrProfileForbidden):
		h.profileDenied(w, r, c, profileID, action, "the library role is required")
		WriteProblem(w, http.StatusForbidden, "Forbidden",
			"Editing an agent profile requires the organization's library role.")
	case errors.Is(err, ErrProfileConflict):
		h.profileDenied(w, r, c, profileID, action, "an agent profile with that name already exists")
		WriteProblem(w, http.StatusConflict, "Conflict",
			"Your organization already has an agent profile with that name.")
	default:
		h.serverError(w, r, cnvTarget{action: action}, err)
	}
}

// profileDenied writes the audit row for a refused profile attempt. Profiles are
// organization-scoped, so the row names no project — the org-scoped twin of
// PipelineStore.RecordDenied, which has the same shape (api/pipelines.go).
func (h *cnvHandlers) profileDenied(w http.ResponseWriter, r *http.Request, c Caller, profileID, action, reason string) {
	if h.store != nil {
		if err := h.store.RecordProjectDenied(r.Context(), c, "", action); err != nil {
			h.log(r).ErrorContext(r.Context(), "could not write audit denial",
				slog.String("action", action),
				slog.String("profile_id", profileID),
				slog.String("request_id", RequestIDFrom(r)),
				slog.Any("error", err))
			return
		}
	}
	h.log(r).WarnContext(r.Context(), "agent profile access denied",
		slog.String("action", action),
		slog.String("user_id", c.UserID),
		slog.String("profile_id", profileID),
		slog.String("reason", reason),
		slog.String("request_id", RequestIDFrom(r)))
}
