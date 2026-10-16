package runtimetest

import (
	"encoding/json"
	"fmt"

	"github.com/dbirks/communication/internal/pipelines/runtime"
)

// attemptByID finds one attempt row in a State (the assertion-side twin of
// runtime's unexported lookup).
func attemptByID(st *runtime.State, id string) *runtime.Attempt {
	for _, a := range st.Attempts {
		if a.ID == id {
			return a
		}
	}
	return nil
}

// encodeJSON renders a value for substring assertions. Failure messages quote
// it so a reader sees the stored evidence verbatim instead of a Go dump.
func encodeJSON(v any) string {
	raw, err := json.Marshal(v)
	if err != nil {
		return fmt.Sprintf("%#v", v)
	}
	return string(raw)
}
