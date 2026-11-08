package domain

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

// ADR-0078: the catch-up vocabulary is model-written, so what Go owns is the
// shape it must have to be stored or shown at all. These tests are the rules
// the write path enforces and the read path re-checks; the store's own tests
// (internal/store/postgres/catch_up_test.go) prove them against real rows.

func cuStop(id string, importance CatchUpImportance) CatchUpStop {
	return CatchUpStop{ID: id, Title: "Fix landed", Narrative: "The retry loop now backs off.",
		Kind: "BUG · FIXED", Importance: importance}
}

func TestCatchUpVocabulariesAreClosed(t *testing.T) {
	for _, s := range []CatchUpShape{CatchUpShapeIssue, CatchUpShapePR, CatchUpShapePush} {
		if err := s.Validate(); err != nil {
			t.Errorf("shape %q refused: %v", s, err)
		}
	}
	if err := CatchUpShape("commit").Validate(); !errors.Is(err, ErrCatchUpValidation) {
		t.Errorf("shape commit = %v, want ErrCatchUpValidation", err)
	}
	for _, r := range []CatchUpResolution{CatchUpResolutionMerged, CatchUpResolutionBranchReady,
		CatchUpResolutionOpen, CatchUpResolutionRunFailed, CatchUpResolutionNoCode} {
		if err := r.Validate(); err != nil {
			t.Errorf("resolution %q refused: %v", r, err)
		}
	}
	if err := CatchUpResolution("shipped").Validate(); !errors.Is(err, ErrCatchUpValidation) {
		t.Errorf("resolution shipped = %v, want ErrCatchUpValidation", err)
	}
	for _, i := range []CatchUpImportance{CatchUpImportanceMustKnow, CatchUpImportanceWorthLook,
		CatchUpImportanceRoutine} {
		if err := i.Validate(); err != nil {
			t.Errorf("importance %q refused: %v", i, err)
		}
	}
	// Importance is the tour's claim about attention, and "important" is not a
	// value the surface knows how to draw.
	if err := CatchUpImportance("important").Validate(); !errors.Is(err, ErrCatchUpValidation) {
		t.Errorf("importance important = %v, want ErrCatchUpValidation", err)
	}
	if err := CatchUpEvidenceType("video").Validate(); !errors.Is(err, ErrCatchUpValidation) {
		t.Errorf("evidence type video = %v, want ErrCatchUpValidation", err)
	}
}

func TestCatchUpWorkItemValidation(t *testing.T) {
	item := CatchUpWorkItem{ProjectID: "p", Shape: CatchUpShapePR, Title: "Rate limiter landed",
		Summary: "429s are now scheduled, not retried.", Resolution: CatchUpResolutionMerged}
	if err := item.Validate(); err != nil {
		t.Fatalf("valid work item refused: %v", err)
	}
	item.ProjectID = "   "
	if err := item.Validate(); !errors.Is(err, ErrCatchUpValidation) {
		t.Errorf("project-less work item = %v, want ErrCatchUpValidation", err)
	}
	item = CatchUpWorkItem{ProjectID: "p", Shape: CatchUpShapePush, Title: "",
		Summary: "s", Resolution: CatchUpResolutionNoCode}
	if err := item.Validate(); !errors.Is(err, ErrCatchUpValidation) {
		t.Errorf("title-less work item = %v, want ErrCatchUpValidation", err)
	}
	item.Title = strings.Repeat("t", CatchUpTitleMaxChars+1)
	if err := item.Validate(); !errors.Is(err, ErrCatchUpValidation) {
		t.Errorf("over-long title = %v, want ErrCatchUpValidation", err)
	}
}

func TestCatchUpStopListRules(t *testing.T) {
	stops := []CatchUpStop{cuStop("s1", CatchUpImportanceMustKnow),
		cuStop("s2", CatchUpImportanceWorthLook)}
	// An UNSTAMPED stop is refused once a version is named: "when did this beat
	// first appear" is what keeps a rewritten tour from resurrecting a beat its
	// reader already saw, so the store stamps before it validates.
	if err := ValidateCatchUpStops(stops, 1); !errors.Is(err, ErrCatchUpValidation) {
		t.Errorf("unstamped stop in version 1 = %v, want ErrCatchUpValidation", err)
	}
	StampCatchUpStops(stops, 1)
	if err := ValidateCatchUpStops(stops, 1); err != nil {
		t.Fatalf("two stops refused: %v", err)
	}
	// A duplicated id would make one click mark two beats read, and would break
	// the seen ledger's key.
	dup := cuStop("s1", CatchUpImportanceRoutine)
	dup.AddedInVersion = 1
	if err := ValidateCatchUpStops(append(stops, dup), 1); !errors.Is(err, ErrCatchUpValidation) {
		t.Errorf("repeated stop id = %v, want ErrCatchUpValidation", err)
	}
	if err := ValidateCatchUpStops(nil, 1); !errors.Is(err, ErrCatchUpValidation) {
		t.Errorf("empty tour = %v, want ErrCatchUpValidation", err)
	}
	if err := ValidateCatchUpStops(stops[:1], 1); err != nil {
		t.Errorf("the unpolluted list was refused after the duplicate test: %v", err)
	}
	// The narrative is the only long field, and it is still bounded: an
	// unbounded narrative is an unbounded model write into a shared page.
	long := cuStop("s9", CatchUpImportanceMustKnow)
	long.AddedInVersion = 1
	long.Narrative = strings.Repeat("n", CatchUpNarrativeMaxChars+1)
	if err := ValidateCatchUpStops([]CatchUpStop{long}, 1); !errors.Is(err, ErrCatchUpValidation) {
		t.Errorf("over-long narrative = %v, want ErrCatchUpValidation", err)
	}
	// added_in_version is a claim about history, and history cannot be in the
	// future.
	future := cuStop("s8", CatchUpImportanceRoutine)
	future.AddedInVersion = 4
	if err := ValidateCatchUpStops([]CatchUpStop{future}, 3); !errors.Is(err, ErrCatchUpValidation) {
		t.Errorf("added_in_version 4 in version 3 = %v, want ErrCatchUpValidation", err)
	}
	if err := ValidateCatchUpStops([]CatchUpStop{future}, 4); err != nil {
		t.Errorf("added_in_version 4 in version 4 refused: %v", err)
	}
	// A run of 25 stops is a changelog, not a tour.
	many := make([]CatchUpStop, 0, CatchUpStopsMax+1)
	for i := 0; i < CatchUpStopsMax+1; i++ {
		s := cuStop(string(rune('a'+i%26))+string(rune('a'+i/26)), CatchUpImportanceRoutine)
		s.AddedInVersion = 1
		many = append(many, s)
	}
	if err := ValidateCatchUpStops(many, 1); !errors.Is(err, ErrCatchUpValidation) {
		t.Errorf("%d stops = %v, want ErrCatchUpValidation", len(many), err)
	}
}

func TestCatchUpDecisionOptionsAreBounded(t *testing.T) {
	// 1..4 labels: enough to ask, too few to become a form. A decision is plain
	// text sent to an agent, never a gate verb (ADR-0078 § Decision 4).
	d := CatchUpDecision{Prompt: "Which branch should this land on?"}
	if err := d.Validate(); !errors.Is(err, ErrCatchUpValidation) {
		t.Errorf("option-less decision = %v, want ErrCatchUpValidation", err)
	}
	d.Options = []string{"main", "the release branch", "keep it on the feature branch", "your call"}
	if err := d.Validate(); err != nil {
		t.Fatalf("four-option decision refused: %v", err)
	}
	d.Options = append(d.Options, "anything else")
	if err := d.Validate(); !errors.Is(err, ErrCatchUpValidation) {
		t.Errorf("five-option decision = %v, want ErrCatchUpValidation", err)
	}
	d.Options = d.Options[:1]
	d.Prompt = " "
	if err := d.Validate(); !errors.Is(err, ErrCatchUpValidation) {
		t.Errorf("blank prompt = %v, want ErrCatchUpValidation", err)
	}
}

func TestCatchUpEvidenceRoundTripKeepsTheType(t *testing.T) {
	raw := []byte(`[{"type":"diff","path":"internal/rate/limiter.go","lines":12},
	               {"type":"log","turn":3,"excerpt":"retried after 429"}]`)
	var evidence []CatchUpEvidence
	if err := json.Unmarshal(raw, &evidence); err != nil {
		t.Fatalf("decode evidence: %v", err)
	}
	if len(evidence) != 2 || evidence[0].Type != CatchUpEvidenceDiff ||
		evidence[1].Type != CatchUpEvidenceLog {
		t.Fatalf("decoded evidence = %+v, want diff then log", evidence)
	}
	if evidence[0].Fields["path"] != "internal/rate/limiter.go" {
		t.Errorf("opaque member lost: %+v", evidence[0].Fields)
	}
	encoded, err := json.Marshal(evidence)
	if err != nil {
		t.Fatalf("encode evidence: %v", err)
	}
	if !strings.Contains(string(encoded), `"lines":12`) ||
		!strings.Contains(string(encoded), `"excerpt":"retried after 429"`) {
		t.Errorf("re-encoded evidence lost its payload: %s", encoded)
	}
	// `type` is the server's field: a model cannot smuggle a second one into the
	// opaque payload and have it win on the way out.
	smuggled := CatchUpEvidence{Type: CatchUpEvidenceFiles,
		Fields: map[string]any{"type": "http://evil.example", "paths": []string{"a.go"}}}
	out, err := json.Marshal(smuggled)
	if err != nil {
		t.Fatalf("encode smuggled evidence: %v", err)
	}
	var back map[string]any
	if err := json.Unmarshal(out, &back); err != nil {
		t.Fatalf("decode smuggled evidence: %v", err)
	}
	if back["type"] != string(CatchUpEvidenceFiles) {
		t.Errorf("smuggled type won: %s", out)
	}
	if _, ok := back["paths"]; !ok {
		t.Errorf("smuggled evidence lost its own payload: %s", out)
	}
}

func TestCatchUpEvidenceWithoutTypeIsNotEvidence(t *testing.T) {
	var evidence []CatchUpEvidence
	if err := json.Unmarshal([]byte(`[{"path":"a.go"}]`), &evidence); !errors.Is(err, ErrCatchUpValidation) {
		t.Errorf("type-less evidence = %v, want ErrCatchUpValidation", err)
	}
}

func TestCatchUpStopsStampOnlyWhatIsSilent(t *testing.T) {
	// A carried-over beat keeps its origin (that is what keeps it read); a new
	// beat with no claim is new in this version.
	stops := []CatchUpStop{cuStop("s1", CatchUpImportanceMustKnow),
		cuStop("s2", CatchUpImportanceRoutine)}
	stops[0].AddedInVersion = 1
	StampCatchUpStops(stops, 4)
	if stops[0].AddedInVersion != 1 || stops[1].AddedInVersion != 4 {
		t.Errorf("stamped = [%d %d], want [1 4]", stops[0].AddedInVersion, stops[1].AddedInVersion)
	}
}

func TestCatchUpProjectColorIsDeterministicAndInPalette(t *testing.T) {
	if len(CatchUpProjectPalette) != 8 {
		t.Fatalf("palette has %d colours, want the design's 8", len(CatchUpProjectPalette))
	}
	seen := map[string]bool{}
	for _, c := range CatchUpProjectPalette {
		if seen[c] {
			t.Errorf("palette repeats %s", c)
		}
		seen[c] = true
		if !strings.HasPrefix(c, "#") || len(c) != 7 {
			t.Errorf("palette entry %q is not a #rrggbb colour", c)
		}
	}
	const id = "0f1c2b3a-4d5e-6f70-8192-a3b4c5d6e7f8"
	first := CatchUpProjectColor(id)
	for i := 0; i < 5; i++ {
		if got := CatchUpProjectColor(id); got != first {
			t.Fatalf("colour for the same project changed: %s then %s", first, got)
		}
	}
	if !ValidCatchUpProjectColor(first) {
		t.Errorf("fallback %q is outside the palette", first)
	}
	if !strings.EqualFold(first, CatchUpProjectColor(strings.ToUpper(id))) {
		t.Errorf("the same id with different case picked a different colour")
	}
	// Spread: one colour for every project would be the same bug as a random one.
	distinct := map[string]bool{}
	for i := 0; i < 40; i++ {
		distinct[CatchUpProjectColor("proj-"+string(rune('a'+i%26))+string(rune('a'+i/26))+
			string(rune('a'+(i*7)%26)))] = true
	}
	if len(distinct) < 2 {
		t.Errorf("40 projects all picked %v, want a spread across the palette", distinct)
	}
}

func TestCatchUpProjectColorOrNullWinsAndBlankFallsBack(t *testing.T) {
	const id = "0f1c2b3a-4d5e-6f70-8192-a3b4c5d6e7f8"
	if got := CatchUpProjectColorOr(id, "#2f6f9a"); got != "#2f6f9a" {
		t.Errorf("a chosen colour was overridden: %s", got)
	}
	for _, blank := range []string{"", "   "} {
		if got := CatchUpProjectColorOr(id, blank); got != CatchUpProjectColor(id) {
			t.Errorf("unset %q fell back to %q, want the deterministic pick %q",
				blank, got, CatchUpProjectColor(id))
		}
	}
	// Unset is a legal value; anything off the palette is not.
	if !ValidCatchUpProjectColor("") {
		t.Errorf("NULL was refused, want it to mean unset")
	}
	if ValidCatchUpProjectColor("#ff0000") {
		t.Errorf("#ff0000 accepted, want only the palette — it is a state colour here")
	}
}

func TestCatchUpRecapAndReplyBounds(t *testing.T) {
	recap := CatchUpRecap{Text: "Two agents shipped the rate limiter and one pushed docs.",
		Window: "24h"}
	if err := recap.Validate(); err != nil {
		t.Fatalf("valid recap refused: %v", err)
	}
	recap.Window = ""
	if err := recap.Validate(); !errors.Is(err, ErrCatchUpValidation) {
		t.Errorf("window-less recap = %v, want ErrCatchUpValidation", err)
	}
	recap.Window = strings.Repeat("w", CatchUpWindowMaxChars+1)
	if err := recap.Validate(); !errors.Is(err, ErrCatchUpValidation) {
		t.Errorf("over-long window = %v, want ErrCatchUpValidation", err)
	}
	reply := CatchUpDecisionReply{StopID: "s1", Text: "ship it to main"}
	if err := reply.Validate(); err != nil {
		t.Fatalf("valid reply refused: %v", err)
	}
	reply.Text = strings.Repeat("t", CatchUpReplyMaxChars+1)
	if err := reply.Validate(); !errors.Is(err, ErrCatchUpValidation) {
		t.Errorf("over-long reply = %v, want ErrCatchUpValidation", err)
	}
	reply.Text = "fine"
	reply.StopID = ""
	if err := reply.Validate(); !errors.Is(err, ErrCatchUpValidation) {
		t.Errorf("reply without a stop = %v, want ErrCatchUpValidation", err)
	}
}
