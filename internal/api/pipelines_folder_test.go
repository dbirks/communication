package api

import (
	"encoding/json"
	"net/http"
	"testing"
)

// Handler-level tests for issue #26 (ADR-0049 § 8): PATCH
// /api/v1/pipelines/{pipelineId} must distinguish the three wire states of
// `folder` — absent leaves the column untouched, JSON null CLEARS it
// (unfiles the workflow), a string sets it. With `folder` decoded as
// *json.RawMessage, encoding/json sets the pointer to nil for a JSON null,
// so null collapsed into "absent", the minProperties check answered 422 to
// a body of only {"folder":null}, and a filed workflow could never be
// unfiled. The SQL behind these interfaces is proven separately in
// internal/store/postgres; these tests pin the handler contract only.

// filedFolderServer is m4PopulatedServer with the pipeline filed into a
// folder and the update fake applying patches so a re-read reflects them.
func filedFolderServer(t *testing.T) *m4Fixture {
	t.Helper()
	fx := m4PopulatedServer(t)
	folder := "Planning"
	fx.pipes.pipeline.Folder = &folder
	fx.pipes.updateOut = fx.pipes.pipeline
	fx.pipes.applyUpdate = true
	return fx
}

// decodeFields parses a response body into a field map so "folder": null"
// is visible as a present nil, distinct from an absent key.
func decodeFields(t *testing.T, body []byte) map[string]json.RawMessage {
	t.Helper()
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(body, &fields); err != nil {
		t.Fatalf("response body is not a JSON object: %v (%s)", err, body)
	}
	return fields
}

func assertFolderNull(t *testing.T, where string, fields map[string]json.RawMessage) {
	t.Helper()
	raw, ok := fields["folder"]
	if !ok {
		t.Errorf("%s: response has no folder member, want null", where)
		return
	}
	if string(raw) != "null" {
		t.Errorf("%s: response folder = %s, want null", where, raw)
	}
}

func assertFolderValue(t *testing.T, where string, fields map[string]json.RawMessage, want string) {
	t.Helper()
	raw, ok := fields["folder"]
	if !ok {
		t.Errorf("%s: response has no folder member, want %q", where, want)
		return
	}
	var got string
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Errorf("%s: response folder %s is not a string: %v", where, raw, err)
		return
	}
	if got != want {
		t.Errorf("%s: response folder = %q, want %q", where, got, want)
	}
}

// TestPipelineFolderNullUnfiles is the issue-#26 regression: a filed
// workflow accepts PATCH {"folder":null} with 200 (NOT the old 422), the
// response and a re-read both answer folder null.
func TestPipelineFolderNullUnfiles(t *testing.T) {
	fx := filedFolderServer(t)
	target := "http://localhost:8080/api/v1/pipelines/" + m4UUID

	rec := fx.call(t, http.MethodPatch, target, `{"folder":null}`)
	if rec.Code != http.StatusOK {
		t.Fatalf(`PATCH {"folder":null} = %d, want 200 (issue #26: null must unfile, `+
			`not reject); body %s`, rec.Code, rec.Body.String())
	}
	assertFolderNull(t, "PATCH response", decodeFields(t, rec.Body.Bytes()))
	if fx.pipes.lastUpdate == nil || !fx.pipes.lastUpdate.Folder.Clear || fx.pipes.lastUpdate.Folder.Set {
		t.Errorf("store input Folder = %+v, want {Set:false Clear:true}", fx.pipes.lastUpdate)
	}

	rec = fx.get(t, target)
	if rec.Code != http.StatusOK {
		t.Fatalf("re-read GET = %d, want 200", rec.Code)
	}
	assertFolderNull(t, "re-read response", decodeFields(t, rec.Body.Bytes()))
}

// TestPipelineFolderNullOnlyIsNotUnprocessable pins the exact symptom from
// the issue: a body of ONLY {"folder":null} satisfies minProperties 1.
func TestPipelineFolderNullOnlyIsNotUnprocessable(t *testing.T) {
	fx := filedFolderServer(t)
	rec := fx.call(t, http.MethodPatch,
		"http://localhost:8080/api/v1/pipelines/"+m4UUID, `{"folder":null}`)
	if rec.Code == http.StatusUnprocessableEntity {
		t.Fatalf(`PATCH {"folder":null} = 422 (%s); the body names one update `+
			`member and must not trip minProperties`, rec.Body.String())
	}
	if rec.Code != http.StatusOK {
		t.Fatalf(`PATCH {"folder":null} = %d, want 200; body %s`, rec.Code, rec.Body.String())
	}
}

// TestPipelineFolderAbsentUntouched: without a folder member the store is
// told neither set nor clear, and the filed workflow stays filed.
func TestPipelineFolderAbsentUntouched(t *testing.T) {
	fx := filedFolderServer(t)
	target := "http://localhost:8080/api/v1/pipelines/" + m4UUID

	rec := fx.call(t, http.MethodPatch, target, `{"display_name":"Renamed"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("PATCH {\"display_name\":…} = %d, want 200; body %s", rec.Code, rec.Body.String())
	}
	assertFolderValue(t, "PATCH response", decodeFields(t, rec.Body.Bytes()), "Planning")
	if fx.pipes.lastUpdate == nil || fx.pipes.lastUpdate.Folder.Set || fx.pipes.lastUpdate.Folder.Clear {
		t.Errorf("store input Folder = %+v, want the untouched zero state", fx.pipes.lastUpdate)
	}

	rec = fx.get(t, target)
	assertFolderValue(t, "re-read response", decodeFields(t, rec.Body.Bytes()), "Planning")
}

// TestPipelineFolderStringSets: a string still files the workflow, and a
// re-read shows it.
func TestPipelineFolderStringSets(t *testing.T) {
	fx := filedFolderServer(t)
	target := "http://localhost:8080/api/v1/pipelines/" + m4UUID

	rec := fx.call(t, http.MethodPatch, target, `{"folder":"Backlog"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("PATCH {\"folder\":\"Backlog\"} = %d, want 200; body %s", rec.Code, rec.Body.String())
	}
	assertFolderValue(t, "PATCH response", decodeFields(t, rec.Body.Bytes()), "Backlog")
	if fx.pipes.lastUpdate == nil || !fx.pipes.lastUpdate.Folder.Set ||
		fx.pipes.lastUpdate.Folder.Clear || fx.pipes.lastUpdate.Folder.Value != "Backlog" {
		t.Errorf("store input Folder = %+v, want {Set:true Value:Backlog}", fx.pipes.lastUpdate)
	}

	rec = fx.get(t, target)
	assertFolderValue(t, "re-read response", decodeFields(t, rec.Body.Bytes()), "Backlog")
}

// TestPipelineFolderValidationKept: the untouched validations still bite —
// empty bodies are still minProperties 422 and the folder grammar rules
// (string-or-null, 1 to 200 characters) still answer 422.
func TestPipelineFolderValidationKept(t *testing.T) {
	fx := filedFolderServer(t)
	target := "http://localhost:8080/api/v1/pipelines/" + m4UUID
	for _, tc := range []struct{ name, body string }{
		{"empty body trips minProperties", `{}`},
		{"wrong folder type", `{"folder":123}`},
		{"empty folder name", `{"folder":""}`},
		{"folder true is not a string or null", `{"folder":true}`},
	} {
		rec := fx.call(t, http.MethodPatch, target, tc.body)
		if rec.Code != http.StatusUnprocessableEntity {
			t.Errorf("%s: PATCH %s = %d, want 422; body %s", tc.name, tc.body, rec.Code, rec.Body.String())
		}
	}
}
