package api

// ADR-0054 amendment 1 (server-side APM lock, implementation): the lock
// dispatch and status reads behind POST/GET /api/v1/agent-profiles/{profileId}/apm/lock.
//
// The control plane is the only writer of profile state, and the worker is the
// only process that resolves a package ref (ADR-0054 Option B). The POST is
// therefore a thin trigger: it validates the profile's pin is complete, queues a
// lock request, and answers 202 with the new request's id — the resolve itself
// runs worker-side and reports back through the store, which writes the digest
// + contents summary and journals agent.profile.apm_locked in one transaction.

import (
	"net/http"
)

// apmLockStatusNone is the honest status of GET .../apm/lock when no lock
// request has ever been queued for the profile: the unlocked state, which the
// caller already reads off apm_contents / apm_lock_digest.
const apmLockStatusNone = "none"

// postAgentProfileAPMLock handles POST /api/v1/agent-profiles/{profileId}/apm/lock.
// The body is empty by contract (the pin travels on the profile); the handler
// answers 202 Accepted with the queued request's id, and the resolve's outcome
// arrives later through the worker-reported lock result.
func (h *cnvHandlers) postAgentProfileAPMLock(w http.ResponseWriter, r *http.Request) {
	c, ok := h.caller(w, r)
	if !ok {
		return
	}
	profileID := r.PathValue("profileId")
	if !validUUID(profileID) {
		h.profileDenied(w, r, c, profileID, "profile.apm_lock", "malformed profile id")
		WriteProblem(w, http.StatusNotFound, "Not Found", "No such agent profile.")
		return
	}
	req, err := h.profiles.CreateAPMLockRequest(r.Context(), c, profileID)
	if err != nil {
		h.profileFail(w, r, c, profileID, "profile.apm_lock", err)
		return
	}
	WriteJSON(w, http.StatusAccepted, req)
}

// getAgentProfileAPMLock handles GET /api/v1/agent-profiles/{profileId}/apm/lock:
// the latest lock request status for one profile.
func (h *cnvHandlers) getAgentProfileAPMLock(w http.ResponseWriter, r *http.Request) {
	c, ok := h.caller(w, r)
	if !ok {
		return
	}
	profileID := r.PathValue("profileId")
	if !validUUID(profileID) {
		h.profileDenied(w, r, c, profileID, "profile.apm_lock", "malformed profile id")
		WriteProblem(w, http.StatusNotFound, "Not Found", "No such agent profile.")
		return
	}
	req, err := h.profiles.GetAPMLockRequest(r.Context(), c, profileID)
	if err != nil {
		h.profileFail(w, r, c, profileID, "profile.apm_lock", err)
		return
	}
	status := req.Status
	if status == "" {
		status = apmLockStatusNone
	}
	WriteJSON(w, http.StatusOK, APMLockRequestView{RequestID: req.RequestID, Status: status, Error: req.Error})
}
