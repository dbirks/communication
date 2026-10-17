package domain

// Numeric config reads shared by the pipeline compiler (validate/publish)
// and the worker's model.chat executor (run). Both sides read the same
// canonical values, so both sides must accept exactly the same Go shapes:
// the canon loader emits int64 for an integer literal (canon.go: "the
// loader emits int64"), a JSON decoder emits float64 or json.Number, and a
// hand-built claim may carry any of the fixed-width integers. A check that
// only accepts float64 rejects temperature: 0 — a value the schema admits —
// the bug this file exists to keep from recurring.

import (
	"encoding/json"
	"math"
)

// NumberAsFloat accepts any Go representation of a JSON number and reports
// its float64 value. It refuses strings (a number quoted as "1" is not a
// number), booleans, and everything else.
func NumberAsFloat(v any) (float64, bool) {
	switch n := v.(type) {
	case float64:
		return n, true
	case float32:
		return float64(n), true
	case int:
		return float64(n), true
	case int8:
		return float64(n), true
	case int16:
		return float64(n), true
	case int32:
		return float64(n), true
	case int64:
		return float64(n), true
	case uint:
		return float64(n), true
	case uint8:
		return float64(n), true
	case uint16:
		return float64(n), true
	case uint32:
		return float64(n), true
	case uint64:
		return float64(n), true
	case json.Number:
		f, err := n.Float64()
		return f, err == nil
	}
	return 0, false
}

// FloatIn reports whether f is finite and inside [min, max] (inclusive).
func FloatIn(f, min, max float64) bool {
	return !math.IsInf(f, 0) && !math.IsNaN(f) && f >= min && f <= max
}

// IntegerIn reports whether v is a whole JSON number inside [min, max]
// (inclusive). 0.5 is not an integer; neither is "1".
func IntegerIn(v any, min, max int) (int, bool) {
	f, ok := NumberAsFloat(v)
	if !ok || !FloatIn(f, float64(min), float64(max)) || f != math.Trunc(f) {
		return 0, false
	}
	return int(f), true
}
