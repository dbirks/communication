package api

// TestCreateRunSourceShapeValidation: ADR-0053's handler half — the source
// clause is shape-validated before the store (bad uuids are 400/422 client
// mistakes), a well-formed source reaches the store with the field filled,
// and the store's sentinels render the promised 404/422 answers.

import (
	"net/http"
	"strings"
	"testing"

	"encoding/json"
)

func TestCreateRunSourceShapeValidation(t *testing.T) {
	fx := m4PopulatedServer(t)
	fx.runs.run.ID = "run-1"
	fx.runs.run.RunSummaryView = RunSummaryView{ID: "run-1", ProjectID: "p-1", PipelineID: m4UUID,
		PipelineRevisionID: m4UUID, RevisionDigest: m4FullDigest, PlanDigest: m4FullDigest,
		Status: "queued"}
	fx.runs.createOut = fx.runs.run
	fx.runs.created = true
	// head opens the object without the closing brace so the source member
	// slots in before it; each body below appends its own `}`.
	const head = `{"pipeline_revision_id":"` + m4UUID + `",`

	// Malformed source uuids are client mistakes, answered 422 before the store.
	for body, member := range map[string]string{
		`"source":{"conversation_id":"not-a-uuid"}}`:                          "conversation_id",
		`"source":{"conversation_id":"` + m4UUID + `","artifact_ids":["x"]}}`: "artifact_ids",
	} {
		rec := fx.call(t, "POST", "http://localhost:8080/api/v1/projects/p-1/runs",
			head+body)
		if rec.Code != http.StatusUnprocessableEntity {
			t.Errorf("body %s = %d, want 422 before the store: %s", body, rec.Code, rec.Body)
			continue
		}
		if !strings.Contains(rec.Body.String(), member) {
			t.Errorf("body %s refusal %s does not name %q — the client cannot fix what the detail does not name", body, rec.Body, member)
		}
	}
	if got := len(fx.runs.calls); got != 0 {
		t.Errorf("store saw %d create call(s), want none (validation is before the store)", got)
	}

	// A well-formed source reaches the store with the fields filled.
	fx.runs.calls = nil
	rec := fx.call(t, "POST", "http://localhost:8080/api/v1/projects/p-1/runs",
		head+`"source":{"conversation_id":"`+m4UUID+
			`","summary":"the plan","artifact_ids":["`+m4UUID+`"]}}`)
	if rec.Code != http.StatusCreated {
		t.Fatalf("source create = %d: %s", rec.Code, rec.Body)
	}
	var resp RunCreateResponse
	if err := json.NewDecoder(rec.Body).Decode(&resp); err != nil {
		t.Fatalf("decode 201: %v", err)
	}
	if resp.RunID != "run-1" || resp.Status != "queued" {
		t.Errorf("201 body = %+v", resp)
	}

	// The store's sentinels render the promised answers: an invisible
	// conversation is the 404 (no existence disclosed), the mismatch is the
	// typed 422.
	for _, arm := range []struct {
		err      error
		code     int
		fragment string
	}{
		{err: ErrConversationNotFound, code: http.StatusNotFound, fragment: "No such conversation."},
		{err: ErrArtifactNotFound, code: http.StatusNotFound, fragment: "No such artifact."},
		{err: ErrRunSourceProjectMismatch, code: http.StatusUnprocessableEntity, fragment: "source-project-mismatch"},
		{err: ErrRunSourceArtifactTaken, code: http.StatusUnprocessableEntity, fragment: "source-artifact-taken"},
	} {
		fx.runs.createErr = arm.err
		rec := fx.call(t, "POST", "http://localhost:8080/api/v1/projects/p-1/runs",
			head+`"source":{"conversation_id":"`+m4UUID+`"}}`)
		if rec.Code != arm.code {
			t.Errorf("%v = %d, want %d: %s", arm.err, rec.Code, arm.code, rec.Body)
		}
		if !strings.Contains(rec.Body.String(), arm.fragment) {
			t.Errorf("%v body %s lacks %q", arm.err, rec.Body, arm.fragment)
		}
	}
	fx.runs.createErr = nil
}
