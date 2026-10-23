package acp

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

// repoRoot walks up from the package directory (internal/agent/acp) to the
// module root, so the tests can check the canonical docs/ file and every
// cited evidence path against the repository on disk.
func repoRoot(t *testing.T) string {
	t.Helper()
	wd, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	root := filepath.Join(wd, "..", "..", "..")
	fi, err := os.Stat(filepath.Join(root, "docs", "compatibility"))
	if err != nil || !fi.IsDir() {
		t.Fatalf("cannot resolve repo root from %q: %v", root, err)
	}
	return root
}

// TestEmbeddedEvidenceMatchesCanonical pins the embedded copy to the
// canonical docs file: the two must be byte-identical, so editing
// docs/compatibility/acp-observed.json without `go generate` (or a plain cp)
// fails the suite instead of silently serving stale evidence.
func TestEmbeddedEvidenceMatchesCanonical(t *testing.T) {
	root := repoRoot(t)
	canonical, err := os.ReadFile(filepath.Join(root, "docs", "compatibility", "acp-observed.json"))
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(acpObservedRaw, canonical) {
		t.Fatal("internal/agent/acp/acp-observed.json differs from docs/compatibility/acp-observed.json: re-copy it (go generate ./internal/agent/acp)")
	}
}

// TestEvidenceRowsNameRealFiles is the honesty gate (ADR-0051): every row
// recorded as observed must name an evidence path that exists in the repo.
// A row that cites a file nobody can open is a row that proves nothing.
func TestEvidenceRowsNameRealFiles(t *testing.T) {
	root := repoRoot(t)
	file, err := parseObserved()
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if len(file.Rows) == 0 {
		t.Fatal("evidence file has no rows: the capability matrix would report everything not_tested")
	}
	for i, r := range file.Rows {
		p := filepath.Join(root, filepath.FromSlash(r.Evidence))
		if _, err := os.Stat(p); err != nil {
			t.Errorf("row %d (%s/%s) cites missing evidence path %q", i, r.Launcher, r.Capability, r.Evidence)
		}
	}
}

// TestObservedCapabilities pins what the launcher API (ADR-0051) can claim:
// claude is observed on all four cells, codex on the three ACP cells with
// no required-sandbox row, and pi/antigravity (registered or not) on none.
// The UI's readiness line must be able to render exactly this.
func TestObservedCapabilities(t *testing.T) {
	observed := func(t *testing.T, id string) map[Capability]ObservedCapability {
		t.Helper()
		cells := ObservedCapabilities(id)
		if len(cells) != len(AllCapabilities()) {
			t.Fatalf("%s: %d capabilities, want %d", id, len(cells), len(AllCapabilities()))
		}
		want := []string{}
		for _, c := range AllCapabilities() {
			want = append(want, string(c))
		}
		got := []string{}
		for _, c := range cells {
			got = append(got, string(c.Capability))
		}
		if !reflect.DeepEqual(got, want) {
			t.Errorf("%s: capability order %v, want %v", id, got, want)
		}
		m := map[Capability]ObservedCapability{}
		for _, c := range cells {
			m[c.Capability] = c
		}
		return m
	}

	// claude: every cell observed, each with a date and an evidence path.
	ca := observed(t, "claude")
	for cap, cell := range ca {
		if cell.Result != ResultObserved {
			t.Errorf("claude/%s = %s, want observed", cap, cell.Result)
		}
		if cell.ObservedAt == "" || cell.Evidence == "" {
			t.Errorf("claude/%s missing observed_at/evidence: %q/%q", cap, cell.ObservedAt, cell.Evidence)
		}
	}
	// The M2 container re-probe (later row, same date) must win the
	// acp_session tie: its evidence is the ACP.md doc section, not the
	// host-probe baseline JSON.
	if got := ca[CapabilityACPSession].Evidence; got != "docs/compatibility/ACP.md" {
		t.Errorf("claude/acp_session evidence = %q, want the M2 container row's doc path", got)
	}

	// codex: the three ACP cells observed, required sandbox never tested.
	cx := observed(t, "codex")
	for _, cap := range []Capability{CapabilityACPSession, CapabilityResume, CapabilityPermissionPrompts} {
		if cx[cap].Result != ResultObserved {
			t.Errorf("codex/%s = %s, want observed", cap, cx[cap].Result)
		}
	}
	if cx[CapabilityNonoRequired].Result != ResultNotTested {
		t.Errorf("codex/nono_required = %s, want not_tested (SANDBOX.md: Codex was not tested)", cx[CapabilityNonoRequired].Result)
	}
	if cx[CapabilityNonoRequired].ObservedAt != "" || cx[CapabilityNonoRequired].Evidence != "" {
		t.Error("codex/nono_required carries date/evidence without a row")
	}

	// pi: the 2026-10-23 host probe (pi-acp adapter 0.0.34, pi v1.1.0) observed
	// the acp_session cell end to end (initialize + session/new + a real prompt
	// turn streamed tool calls against the LLM collective); the rest stay
	// not_tested (no permission round-trip, no restore, no required sandbox yet).
	// antigravity: not probed at all — all not_tested.
	piCells := observed(t, "pi")
	if piCells[CapabilityACPSession].Result != ResultObserved {
		t.Errorf("pi/acp_session = %s, want observed", piCells[CapabilityACPSession].Result)
	}
	if piCells[CapabilityACPSession].ObservedAt == "" || piCells[CapabilityACPSession].Evidence == "" {
		t.Errorf("pi/acp_session missing observed_at/evidence: %q/%q", piCells[CapabilityACPSession].ObservedAt, piCells[CapabilityACPSession].Evidence)
	}
	for _, cap := range []Capability{CapabilityResume, CapabilityPermissionPrompts, CapabilityNonoRequired} {
		if piCells[cap].Result != ResultNotTested {
			t.Errorf("pi/%s = %s, want not_tested", cap, piCells[cap].Result)
		}
	}
	for _, id := range []string{"antigravity", "definitely-not-a-launcher"} {
		m := observed(t, id)
		for cap, cell := range m {
			if cell.Result != ResultNotTested {
				t.Errorf("%s/%s = %s, want not_tested", id, cap, cell.Result)
			}
		}
	}
}

// TestValidateObservedRejectsDishonestRows pins the parse-time guard rails:
// a hand-appended row must name a real capability, a real result word and an
// evidence path, and may never record not_tested (absence is the only way a
// cell is not_tested).
func TestValidateObservedRejectsDishonestRows(t *testing.T) {
	good := observedRow{
		Launcher: "claude", Capability: "acp_session", Result: ResultObserved,
		ObservedAt: "2026-10-14T00:00:00Z", Evidence: "docs/compatibility/probes/acp/results-claude.json",
	}
	cases := []struct {
		name string
		mut  func(*observedRow)
	}{
		{"unknown capability", func(r *observedRow) { r.Capability = "vibes" }},
		{"unknown result", func(r *observedRow) { r.Result = CapabilityResult("probably") }},
		{"not_tested recorded as a row", func(r *observedRow) { r.Result = ResultNotTested }},
		{"malformed date", func(r *observedRow) { r.ObservedAt = "14 October 2026" }},
		{"missing evidence path", func(r *observedRow) { r.Evidence = "" }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := good
			tc.mut(&r)
			if err := validateObserved(observedFile{Schema: "communication.acp-observed/v1", Rows: []observedRow{r}}); err == nil {
				t.Fatalf("row %+v accepted, want a validation error", r)
			}
		})
	}
	if err := validateObserved(observedFile{Schema: "communication.acp-observed/v1", Rows: []observedRow{good}}); err != nil {
		t.Fatalf("honest row rejected: %v", err)
	}
	if err := validateObserved(observedFile{Schema: "wrong", Rows: []observedRow{good}}); err == nil {
		t.Fatal("unknown schema accepted")
	}
}
