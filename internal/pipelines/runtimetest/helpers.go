package runtimetest

import (
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
