package api

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
)

// MaxJSONBodyBytes caps the size of a decoded request body (1 MiB).
const MaxJSONBodyBytes = 1 << 20

// Errors returned by DecodeJSON. Handlers map them to 400 (or 413 for
// ErrBodyTooLarge) problem+json responses.
var (
	// ErrBodyTooLarge is returned when the request body exceeds MaxJSONBodyBytes.
	ErrBodyTooLarge = errors.New("api: request body too large")
	// ErrBodyEmpty is returned when the request has no body to decode.
	ErrBodyEmpty = errors.New("api: request body is empty")
	// ErrBodyTrailingData is returned when JSON is followed by extra data.
	ErrBodyTrailingData = errors.New("api: request body contains trailing data")
)

// Problem is the API's error document (communication-spec/09-api-events-data.md:
// "adopt problem+json-compatible errors").
type Problem struct {
	Type   string `json:"type"`
	Title  string `json:"title"`
	Status int    `json:"status"`
	Detail string `json:"detail,omitempty"`
}

// ProblemJSON is the media type of every API error response.
const ProblemJSON = "application/problem+json"

// WriteProblem writes a problem+json error response. It is safe to call from
// middleware and handlers alike; it sets no caching headers.
func WriteProblem(w http.ResponseWriter, status int, title, detail string) {
	if title == "" {
		title = http.StatusText(status)
	}
	h := w.Header()
	h.Set("Content-Type", ProblemJSON)
	h.Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(Problem{
		Type:   "about:blank",
		Title:  title,
		Status: status,
		Detail: detail,
	})
}

// WriteJSON writes v as a JSON response with the given status.
func WriteJSON(w http.ResponseWriter, status int, v any) {
	h := w.Header()
	h.Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if v == nil {
		return
	}
	// The status is already committed, so an encoding failure (unmarshalable
	// value or broken connection) can only surface as a truncated body.
	_ = json.NewEncoder(w).Encode(v)
}

// DecodeJSON strictly decodes a JSON request body into dst: the body is capped
// at MaxJSONBodyBytes, unknown fields are rejected and trailing data after the
// top-level value is an error.
func DecodeJSON(r *http.Request, dst any) error {
	if r.Body == nil {
		return ErrBodyEmpty
	}
	// Read one byte past the cap so an oversized body is reported as 413
	// instead of a confusing "unexpected end of JSON input".
	data, err := io.ReadAll(io.LimitReader(r.Body, MaxJSONBodyBytes+1))
	if err != nil {
		return fmt.Errorf("api: read request body: %w", err)
	}
	if int64(len(data)) > MaxJSONBodyBytes {
		return ErrBodyTooLarge
	}
	if len(bytes.TrimSpace(data)) == 0 {
		return ErrBodyEmpty
	}
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		return fmt.Errorf("api: decode request body: %w", err)
	}
	if err := dec.Decode(new(json.RawMessage)); !errors.Is(err, io.EOF) {
		return ErrBodyTrailingData
	}
	return nil
}
