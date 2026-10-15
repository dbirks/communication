package api

import (
	"context"
	"net/http"
	"time"
)

// healthResponse is the body of GET /api/v1/system/health.
type healthResponse struct {
	Status  string `json:"status"`
	Replica string `json:"replica"`
	Version string `json:"version"`
}

// readinessResponse is the body of GET /api/v1/system/readiness. The optional
// versions are omitted when they could not be determined.
type readinessResponse struct {
	Status                string `json:"status"`
	Reason                string `json:"reason,omitempty"`
	SchemaVersion         *int64 `json:"schema_version,omitempty"`
	ExpectedSchemaVersion *int64 `json:"expected_schema_version,omitempty"`
}

// handleHealth reports liveness plus replica identity. It performs no
// dependency checks: an unreachable database must not make a replica look
// dead to the load balancer's health probes.
func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	WriteJSON(w, http.StatusOK, healthResponse{
		Status:  "ok",
		Replica: s.cfg.ReplicaName,
		Version: s.cfg.Version,
	})
}

// handleReadiness reports whether this replica can serve traffic: the
// datastore must be reachable and its schema must be at least the version
// this binary expects (a replica still mid-migration drains instead of
// serving stale writes).
func (s *Server) handleReadiness(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if s.ready == nil {
		WriteJSON(w, http.StatusServiceUnavailable, readinessResponse{
			Status: "not_ready",
			Reason: "no datastore configured",
		})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), readinessTimeout)
	defer cancel()

	expected := s.ready.ExpectedSchemaVersion()
	exp := &expected

	if err := s.ready.Ping(ctx); err != nil {
		WriteJSON(w, http.StatusServiceUnavailable, readinessResponse{
			Status:                "not_ready",
			Reason:                "datastore unreachable",
			ExpectedSchemaVersion: exp,
		})
		return
	}
	version, err := s.ready.SchemaVersion(ctx)
	if err != nil {
		WriteJSON(w, http.StatusServiceUnavailable, readinessResponse{
			Status:                "not_ready",
			Reason:                "schema version unavailable",
			ExpectedSchemaVersion: exp,
		})
		return
	}
	if version < expected {
		WriteJSON(w, http.StatusServiceUnavailable, readinessResponse{
			Status:                "not_ready",
			Reason:                "schema migration required",
			SchemaVersion:         &version,
			ExpectedSchemaVersion: exp,
		})
		return
	}
	WriteJSON(w, http.StatusOK, readinessResponse{
		Status:                "ready",
		SchemaVersion:         &version,
		ExpectedSchemaVersion: exp,
	})
}

// readinessTimeout bounds the probe so a wedged connection pool cannot hang
// the load balancer's checks.
const readinessTimeout = 2 * time.Second
