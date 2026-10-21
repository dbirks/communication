package acp

import (
	"encoding/json"
	"fmt"
	"time"

	_ "embed"
)

// ADR-0051: the structured, machine-readable transcript of the ACP/sandbox
// capability cells that docs/compatibility/ACP.md and SANDBOX.md record as
// OBSERVED. The canonical file is docs/compatibility/acp-observed.json; a
// byte-identical copy is embedded here (go:embed cannot reach outside the
// package directory) and TestEmbeddedEvidenceMatchesCanonical in
// evidence_test.go fails if the two drift. Re-sync with
// `go generate ./internal/agent/acp`.
//
// Evidence honesty (12-test-strategy's compatibility table, ADR-0051): a
// capability's result comes ONLY from a row in this file. A cell with no row
// is not_tested — a launcher being listed in knownLaunchers, or a worker
// being online, is not evidence that it was ever run.
//
//go:embed acp-observed.json
var acpObservedRaw []byte

//go:generate cp -f ../../../docs/compatibility/acp-observed.json acp-observed.json

// Capability is one axis of the launcher capability matrix (ADR-0051):
// the same four cells the 12-test-strategy compatibility table tracks for
// an agent under a required sandbox.
type Capability string

// The four capability axes, in the order the API reports them.
const (
	CapabilityACPSession        Capability = "acp_session"
	CapabilityResume            Capability = "resume"
	CapabilityPermissionPrompts Capability = "permission_prompts"
	CapabilityNonoRequired      Capability = "nono_required"
)

// AllCapabilities lists every capability axis in report order.
func AllCapabilities() []Capability {
	return []Capability{
		CapabilityACPSession,
		CapabilityResume,
		CapabilityPermissionPrompts,
		CapabilityNonoRequired,
	}
}

// CapabilityResult is the evidence-backed verdict for one launcher ×
// capability cell. It is deliberately three-valued: `not_supported` may be
// reported only when a row records it (an adapter advertising a capability
// it refuses, observed), and `not_tested` is the honest default.
type CapabilityResult string

const (
	// ResultObserved: a row in the evidence file records it, with date and
	// evidence path.
	ResultObserved CapabilityResult = "observed"
	// ResultNotSupported: a row records the observed negative.
	ResultNotSupported CapabilityResult = "not_supported"
	// ResultNotTested: no row — the default, and the only value the file's
	// absence of a cell may produce.
	ResultNotTested CapabilityResult = "not_tested"
)

var allCapabilityResults = map[CapabilityResult]bool{
	ResultObserved:     true,
	ResultNotSupported: true,
	ResultNotTested:    true,
}

// ObservedCapability is one row of GET /api/v1/launchers' capabilities
// array: the verdict for a launcher on one capability axis, and — only when
// the verdict is evidence-backed — when and by what.
type ObservedCapability struct {
	// Capability is one of AllCapabilities.
	Capability Capability `json:"capability"`
	// Result is observed, not_supported or not_tested.
	Result CapabilityResult `json:"result"`
	// ObservedAt is the RFC 3339 date the evidence row records; "" when the
	// result is not evidence-backed (not_tested).
	ObservedAt string `json:"-"`
	// Evidence is the repo-relative path the row cites; "" when the result
	// is not evidence-backed.
	Evidence string `json:"-"`
}

// observedRow is one append-only row of the evidence file.
type observedRow struct {
	Launcher   string           `json:"launcher"`
	Capability string           `json:"capability"`
	Result     CapabilityResult `json:"result"`
	ObservedAt string           `json:"observed_at"`
	Evidence   string           `json:"evidence"`
	Note       string           `json:"note"`
}

type observedFile struct {
	Schema        string        `json:"schema"`
	Note          string        `json:"note"`
	TranscribedAt string        `json:"transcribed_at"`
	Rows          []observedRow `json:"rows"`
}

// parseObserved decodes the embedded evidence file and validates it.
func parseObserved() (*observedFile, error) {
	var f observedFile
	if err := json.Unmarshal(acpObservedRaw, &f); err != nil {
		return nil, fmt.Errorf("acp: parse embedded evidence: %w", err)
	}
	if err := validateObserved(f); err != nil {
		return nil, err
	}
	return &f, nil
}

// validateObserved checks just enough to keep the API from serving a broken
// or dishonest cell: the schema tag, known capability/result words, RFC 3339
// dates and a non-empty evidence path for evidence-backed rows.
func validateObserved(f observedFile) error {
	if f.Schema != "communication.acp-observed/v1" {
		return fmt.Errorf("acp: embedded evidence has unknown schema %q", f.Schema)
	}
	known := map[Capability]bool{}
	for _, c := range AllCapabilities() {
		known[c] = true
	}
	for i, r := range f.Rows {
		if !known[Capability(r.Capability)] {
			return fmt.Errorf("acp: evidence row %d names unknown capability %q", i, r.Capability)
		}
		if !allCapabilityResults[r.Result] {
			return fmt.Errorf("acp: evidence row %d has unknown result %q", i, r.Result)
		}
		if r.Result == ResultNotTested {
			return fmt.Errorf("acp: evidence row %d records not_tested: the file transcribes evidence only, a missing cell is not_tested by absence", i)
		}
		if _, err := time.Parse(time.RFC3339, r.ObservedAt); err != nil {
			return fmt.Errorf("acp: evidence row %d observed_at %q is not RFC 3339: %v", i, r.ObservedAt, err)
		}
		if r.Evidence == "" {
			return fmt.Errorf("acp: evidence row %d (%s/%s) names no evidence path", i, r.Launcher, r.Capability)
		}
	}
	return nil
}

// latestPerCell keeps, per (launcher, capability), the row with the latest
// observed_at; a tie is won by the later row in the file, which is how an
// append-only re-probe updates a cell (ADR-0051 Consequences).
func latestPerCell(rows []observedRow) map[string]observedRow {
	type stamped struct {
		raw observedRow
		at  time.Time
	}
	best := map[string]stamped{}
	for _, r := range rows {
		at, err := time.Parse(time.RFC3339, r.ObservedAt) // validated by parseObserved
		if err != nil {
			panic(err)
		}
		key := r.Launcher + "\x00" + r.Capability
		cur, ok := best[key]
		if !ok || !at.Before(cur.at) {
			// Equal instants: the later row in file order wins.
			best[key] = stamped{raw: r, at: at}
		}
	}
	out := make(map[string]observedRow, len(best))
	for k, s := range best {
		out[k] = s.raw
	}
	return out
}

// ObservedCapabilities reports the four capability cells for one launcher
// id, in AllCapabilities order. Cells with no evidence row are
// ResultNotTested with empty ObservedAt/Evidence. An unknown launcher id
// still gets an honest all-not_tested row set: the API lists the card ids,
// and an unprobed id must read "not tested", never "verified".
func ObservedCapabilities(launcherID string) []ObservedCapability {
	file, err := parseObserved()
	if err != nil {
		// The embedded file is part of the binary; a parse failure is a
		// build-time fact, so it panics rather than silently reporting every
		// cell not_tested — which would read as honesty but is a bug.
		panic(err)
	}
	best := latestPerCell(file.Rows)
	out := make([]ObservedCapability, 0, len(AllCapabilities()))
	for _, cap := range AllCapabilities() {
		cell := ObservedCapability{Capability: cap, Result: ResultNotTested}
		if r, ok := best[launcherID+"\x00"+string(cap)]; ok {
			cell.Result = r.Result
			cell.ObservedAt = r.ObservedAt
			cell.Evidence = r.Evidence
		}
		out = append(out, cell)
	}
	return out
}

// ObservedRowCount is how many evidence rows the embedded file holds; the
// API's 500 path and tests use it to tell "the file is empty" from "the
// launcher was never probed".
func ObservedRowCount() int {
	file, err := parseObserved()
	if err != nil {
		panic(err)
	}
	return len(file.Rows)
}
