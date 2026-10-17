package postgres

// W4 browser-spec bug (docs: POST /drafts/{id}/validate returned
// valid:true with null digests): the definition service's Validate built
// the § 2.2 body without RevisionDigest/PlanDigest even though it had
// computed them on the outcome. api/openapi.yaml ValidateResponse says the
// digests are "null unless valid is true"; internal/api/pipelines.go's
// ValidateResponse doc says "both digests on success".

import (
	"encoding/json"
	"regexp"
	"testing"

	"github.com/dbirks/communication/internal/api"
)

var m4DigestSHA256 = regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)

// TestM4APIValidateEchoesBothDigests drives the real postgres definition
// service (loader → schema → compiler → canonicalization, no fake) on a
// valid document and asserts the answered BODY carries both digests — the
// exact fields the W4 spec saw as null. The invalid path is left
// null (that is correct) and is not asserted here.
func TestM4APIValidateEchoesBothDigests(t *testing.T) {
	f := m4Setup(t)
	c := m4APICaller(f)
	defs, err := NewPipelineDefinitions()
	if err != nil {
		t.Fatalf("NewPipelineDefinitions: %v", err)
	}
	outcome, err := defs.Validate(testCtx(t), c, m4AttemptCountYAML)
	if err != nil {
		t.Fatalf("Validate: %v", err)
	}
	if !outcome.Body.Valid {
		t.Fatalf("the attempt-count document did not validate: %+v", outcome.Body)
	}
	if outcome.Body.RevisionDigest == nil {
		t.Fatalf("valid body has null revision_digest: %+v", outcome.Body)
	}
	if outcome.Body.PlanDigest == nil {
		t.Fatalf("valid body has null plan_digest: %+v", outcome.Body)
	}
	if *outcome.Body.RevisionDigest != outcome.RevisionDigest {
		t.Errorf("body revision_digest %q != outcome %q", *outcome.Body.RevisionDigest, outcome.RevisionDigest)
	}
	if *outcome.Body.PlanDigest != outcome.PlanDigest {
		t.Errorf("body plan_digest %q != outcome %q", *outcome.Body.PlanDigest, outcome.PlanDigest)
	}
	if !m4DigestSHA256.MatchString(*outcome.Body.RevisionDigest) {
		t.Errorf("body revision_digest %q does not match sha256:<64 hex>", *outcome.Body.RevisionDigest)
	}
	if !m4DigestSHA256.MatchString(*outcome.Body.PlanDigest) {
		t.Errorf("body plan_digest %q does not match sha256:<64 hex>", *outcome.Body.PlanDigest)
	}

	// Contract § 2 route 8: the draft row stores the body verbatim — so the
	// stored validation jsonb must carry the digests too, not the old nulls.
	store := APIPipelineStore{S: f.pipelines, ExtractUI: ExtractPipelineUI}
	token := migFixtureToken(t)
	pipe, err := store.CreatePipeline(testCtx(t), c, "m4valid-digests-"+token, "W4 digest probe", "")
	if err != nil {
		t.Fatalf("CreatePipeline: %v", err)
	}
	t.Cleanup(func() { m4APIPipeMop(t, testCtx(t), f, pipe.ID) })
	draft, err := store.CreateDraft(testCtx(t), c, pipe.ID, api.DraftCreateInput{
		DocumentYAML: m4AttemptCountYAML, SourceKind: "manual", SourceSHA256: m4Hex("w4digests/" + token),
	})
	if err != nil {
		t.Fatalf("CreateDraft: %v", err)
	}
	_, err = store.RecordValidation(testCtx(t), c, draft.ID, api.DraftValidationRecord{
		Status:            "valid",
		Body:              outcome.Body,
		CanonicalDocument: outcome.CanonicalDocument,
		RevisionDigest:    outcome.RevisionDigest,
		CompiledPlan:      outcome.CompiledPlan,
		PlanDigest:        outcome.PlanDigest,
		DigestScope:       outcome.DigestScope,
	})
	if err != nil {
		t.Fatalf("RecordValidation: %v", err)
	}
	var validation string
	if err := f.pool.QueryRow(testCtx(t),
		`SELECT validation::text FROM pipeline_drafts WHERE id = $1`, draft.ID).Scan(&validation); err != nil {
		t.Fatalf("read stored validation: %v", err)
	}
	var stored map[string]any
	if err := json.Unmarshal([]byte(validation), &stored); err != nil {
		t.Fatalf("decode stored validation %q: %v", validation, err)
	}
	if got, want := stored["revision_digest"], outcome.RevisionDigest; got != want {
		t.Errorf("stored revision_digest = %v, want %q", got, want)
	}
	if got, want := stored["plan_digest"], outcome.PlanDigest; got != want {
		t.Errorf("stored plan_digest = %v, want %q", got, want)
	}
}
