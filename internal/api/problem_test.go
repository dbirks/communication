package api

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// errAny asserts only that DecodeJSON failed.
var errAny = errors.New("any error")

func TestWriteProblem(t *testing.T) {
	rec := httptest.NewRecorder()
	WriteProblem(rec, http.StatusConflict, "Slug Already Taken", `a project with slug "demo" exists`)
	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d", rec.Code)
	}
	if got := rec.Header().Get("Content-Type"); got != ProblemJSON {
		t.Fatalf("content-type = %q, want %q", got, ProblemJSON)
	}
	if got := rec.Header().Get("Cache-Control"); got != "no-store" {
		t.Fatalf("cache-control = %q", got)
	}
	body := decodeBody(t, rec)
	for k, want := range map[string]any{"type": "about:blank", "title": "Slug Already Taken", "status": float64(409)} {
		if body[k] != want {
			t.Fatalf("body[%q] = %v, want %v (%v)", k, body[k], want, body)
		}
	}
	if !strings.Contains(body["detail"].(string), "demo") {
		t.Fatalf("detail = %v", body["detail"])
	}
}

func TestWriteProblemDefaultsTitleAndOmitsDetail(t *testing.T) {
	rec := httptest.NewRecorder()
	WriteProblem(rec, http.StatusUnprocessableEntity, "", "")
	body := decodeBody(t, rec)
	if body["title"] != "Unprocessable Entity" {
		t.Fatalf("title = %v, want the status text", body["title"])
	}
	if _, ok := body["detail"]; ok {
		t.Fatalf("empty detail should be omitted: %v", body)
	}
}

func TestWriteJSON(t *testing.T) {
	rec := httptest.NewRecorder()
	WriteJSON(rec, http.StatusCreated, map[string]any{"id": "p-1", "version": 1})
	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d", rec.Code)
	}
	if got := rec.Header().Get("Content-Type"); got != "application/json" {
		t.Fatalf("content-type = %q", got)
	}
	if got := strings.TrimSpace(rec.Body.String()); got != `{"id":"p-1","version":1}` {
		t.Fatalf("body = %q", got)
	}
}

func TestDecodeJSON(t *testing.T) {
	tests := []struct {
		name string
		body string
		err  error
	}{
		{"valid", `{"name":"Demo","slug":"demo"}`, nil},
		{"unknown field", `{"name":"Demo","owner":"eve"}`, errAny},
		{"trailing second document", `{"name":"Demo"}{"name":"Other"}`, ErrBodyTrailingData},
		{"trailing garbage", `{"name":"Demo"} ]`, errAny},
		{"empty", ``, ErrBodyEmpty},
		{"whitespace only", "  \n ", ErrBodyEmpty},
		{"not an object", `"just a string"`, errAny},
		{"malformed", `{"name":`, errAny},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			r := httptest.NewRequest(http.MethodPost, "http://x/api/v1/projects", strings.NewReader(tt.body))
			r.Header.Set("Content-Type", "application/json")
			var dst struct {
				Name string `json:"name"`
				Slug string `json:"slug"`
			}
			err := DecodeJSON(r, &dst)
			switch {
			case tt.err == nil && err != nil:
				t.Fatalf("DecodeJSON(%q) = %v, want nil", tt.body, err)
			case tt.err != nil && err == nil:
				t.Fatalf("DecodeJSON(%q) = nil, want an error", tt.body)
			case tt.err != nil && tt.err != errAny && !errors.Is(err, tt.err) && !strings.Contains(err.Error(), tt.err.Error()):
				t.Fatalf("DecodeJSON(%q) = %v, want %v", tt.body, err, tt.err)
			}
			if tt.name == "valid" && (dst.Name != "Demo" || dst.Slug != "demo") {
				t.Fatalf("decoded = %+v", dst)
			}
		})
	}
}

func TestDecodeJSONRejectsOversizedBody(t *testing.T) {
	big := `{"name":"` + strings.Repeat("x", MaxJSONBodyBytes+1) + `"}`
	r := httptest.NewRequest(http.MethodPost, "http://x/api/v1/projects", strings.NewReader(big))
	var dst struct {
		Name string `json:"name"`
	}
	if err := DecodeJSON(r, &dst); !errors.Is(err, ErrBodyTooLarge) {
		t.Fatalf("DecodeJSON(oversized) = %v, want ErrBodyTooLarge", err)
	}

	// A body exactly at the cap is not rejected for size.
	pad := MaxJSONBodyBytes - len(`{"name":""}`)
	atCap := `{"name":"` + strings.Repeat("x", pad) + `"}`
	if len(atCap) != MaxJSONBodyBytes {
		t.Fatalf("fixture is %d bytes, want exactly %d", len(atCap), MaxJSONBodyBytes)
	}
	r = httptest.NewRequest(http.MethodPost, "http://x/api/v1/projects", strings.NewReader(atCap))
	if err := DecodeJSON(r, &dst); err != nil {
		t.Fatalf("DecodeJSON(at cap) = %v, want nil", err)
	}
	if len(dst.Name) != pad {
		t.Fatalf("decoded %d bytes, want %d", len(dst.Name), pad)
	}
}

func TestDecodeJSONNilBody(t *testing.T) {
	r := httptest.NewRequest(http.MethodGet, "http://x/", nil)
	r.Body = nil
	if err := DecodeJSON(r, &struct{}{}); !errors.Is(err, ErrBodyEmpty) {
		t.Fatalf("DecodeJSON() = %v, want ErrBodyEmpty", err)
	}
}
