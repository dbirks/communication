package worker

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"

	"github.com/dbirks/communication/internal/artifacts"
	wsgit "github.com/dbirks/communication/internal/workspace/git"
)

// NodeKindArtifactPublish is the § 4 step 9 node kind this executor runs, the
// catalogue name verbatim (attemptport.go's Kind comment). The M4 exit
// pipeline ends with two of these nodes, so without an executor the gate's
// evidence never lands and the attempt dies on refusalExecutor as infra.
const NodeKindArtifactPublish = "artifact.publish"

// Caps for artifact.publish. The inline figure is § 6's "inline outputs per
// attempt ≤ 32 KiB serialized" — the number procexec.go enforces, with the
// same named failure (`invalid_output` + `outputs_too_large`), because an
// executor that silently truncates is inventing outputs. The published payload
// itself never enters `outputs`: it travels as the artifact, where ADR-0020 D2's
// per-kind cap is the authority and the backend refuses rather than clips.
const (
	artifactPublishInlineOutput = 32 << 10
	// artifactPublishReadSlack is how far a workspace read may overrun the
	// kind's cap before it is declared oversize: enough to tell "just over"
	// from "a monster", cheap enough that a 50 MB file never gets buffered.
	artifactPublishReadSlack = 1 << 10
	// artifactPublishNameMax bounds the artifact name so it cannot push the
	// outputs envelope over the inline cap by itself.
	artifactPublishNameMax = 200
)

// Named failure codes carried in `output_errors` beside the class. The class
// list is ADR-0023 § 7's closed enum and the code is this executor's, exactly
// the split § 6 documents for predicate_cost_exceeded: one event, two names.
const (
	ArtifactPublishCodeSourceConfig = "invalid_source_config"
	ArtifactPublishCodePayloadLarge = "payload_too_large"
	ArtifactPublishCodeOutputsLarge = "outputs_too_large"
)

// AttemptArtifactInput is one artifact row's material for the fenced writer:
// the lease triple, the correlation ids, and bytes already in the byte
// backend. It is a plain struct with no store type in it (AGENTS.md dependency
// rule) and it is the shape postgres.UnitArtifacts already consumes for M3
// capture — Put first, row + artifact.created second, one transaction (unit_artifacts.go:
// Put precedes the row, never the reverse, or a `ready` artifact 404s from its
// own handler).
type AttemptArtifactInput struct {
	OrganizationID  string
	ProjectID       string
	RunID           string
	NodeExecutionID string
	AttemptID       string
	WorkerID        string
	FencingToken    int64

	Name        string
	Kind        string
	MediaType   string
	Sensitivity string
	Ref         artifacts.Ref
	// RedactionCount counts the secret replacements the scan made. ADR-0020 D4:
	// 0 means "the scanner ran and saw nothing", which has to stay
	// distinguishable from "the scanner is broken" — so a nil redactor reports
	// 0 rather than an invented number, and a real one reports its own count.
	RedactionCount int
}

// AttemptArtifactWriter is the seam to the fenced artifact-row transaction for
// an attempt (ADR-0016 § 9.2: an unfenced worker may not publish anything). It
// is the attempt-shaped sibling of ArtifactCapturer — that seam fences on a
// turn's triple and needs turn/conversation ids, which an M4 pipeline attempt
// does not necessarily have. Implementations write the row and its
// artifact.created in one transaction, and write NEITHER when the triple is
// stale, failing with ErrLeaseLost (contract § 4 step 10's "I am dead").
type AttemptArtifactWriter interface {
	PublishAttemptArtifact(ctx context.Context, in AttemptArtifactInput) (string, error)
}

// AttemptWorkspace is the run-workspace identity artifact.publish needs in
// order to read a file: the tree's root, plus the ids the wiring knows.
type AttemptWorkspace struct {
	Root        string
	WorkspaceID string
	VolumeID    string
}

// AttemptWorkspaceResolver is the seam to § 4 step 3's prepared run tree. It is
// injected rather than assumed for procexec.go's RunWorkspaceResolver reason:
// the workspace row belongs to the wave that owns that step, and until a worker
// can name the run's tree the honest answer to a workspace_path publish is a
// failed infra attempt that names the missing seam — never a read from a
// guessed path.
type AttemptWorkspaceResolver interface {
	AttemptWorkspace(ctx context.Context, c AttemptClaim) (AttemptWorkspace, bool, error)
}

// RunWorkspacePaths is the ready-made resolver over the standard
// COMMUNICATION_WORKSPACE_ROOT layout (<root>/run/<run-id>, wsgit's M3 D1 tree
// that M4 populates). The wiring wave that owns workspace rows may supply its
// own resolver instead and fill WorkspaceID/VolumeID from those rows.
type RunWorkspacePaths struct {
	WorkspaceRoot string
}

var _ AttemptWorkspaceResolver = RunWorkspacePaths{}

func (r RunWorkspacePaths) AttemptWorkspace(_ context.Context, c AttemptClaim) (AttemptWorkspace, bool, error) {
	if r.WorkspaceRoot == "" || c.RunID == "" {
		return AttemptWorkspace{}, false, nil
	}
	layout, err := wsgit.LayoutOf(r.WorkspaceRoot, "run", c.RunID)
	if err != nil {
		return AttemptWorkspace{}, false, err
	}
	return AttemptWorkspace{Root: layout.Root}, true, nil
}

// ArtifactPublish executes artifact.publish attempts (docs/m4-contract.md § 4
// step 9): take the node's configured source, run the secret scan over the
// finished bytes, count redactions, Put the bytes, then one fenced transaction
// inserting the artifact row and artifact.created.
//
// Its dependencies are the seams the worker already owns — the ADR-0020 byte
// backend, the fenced row writer, and the materialized-secret redactor. The
// redactor is a func rather than a fourth interface because worker/seams.go's
// Materialized.Redact has this exact shape and is a black box by design: it
// knows the secret values, this package only calls it, which is what keeps
// plaintext out of the worker's artifact path (12 case 12's invariant).
//
// An artifact is not a publication (D-018) and this executor owns no git
// operation: it records bytes, it does not push them anywhere.
type ArtifactPublish struct {
	// Bytes is the artifact byte backend (ADR-0020 D1). Put is content
	// addressed and idempotent on digest, so a retried attempt re-puts the same
	// object rather than double-counting storage.
	Bytes artifacts.Store
	// Rows is the fenced row+event writer. Required: publishing bytes with no
	// row leaves an orphan for the sweep, and writing a row unfenced is the
	// exact thing ADR-0016 § 9.2 forbids.
	Rows AttemptArtifactWriter
	// Redact replaces every occurrence of a value this unit materialized with a
	// marker and reports how many. Nil means nothing was materialized for this
	// attempt (§ 4 step 9's scan then legitimately fires zero times).
	Redact func(text string) (string, int)
	// Workspaces resolves the run tree for from.mode=workspace_path. Nil until
	// the § 4 step 3 wiring hands one over; that mode then fails infra,
	// visibly, naming the seam — a claim about the wiring, not about the node.
	Workspaces AttemptWorkspaceResolver
	// Checkpoints resolves the run's boundary identity (workspace row + volume +
	// repo states). Like ProcExec/AgentTurn, a succeeded attempt MUST record a
	// durable boundary — the store's CompleteAttempt refuses a succeeded worker
	// attempt with no checkpoint volume (D-024 is same-volume only). Nil means no
	// boundary can be bound, so the success is refused as infra naming the missing
	// step, never published with an invented volume (contract § 4 step 10).
	Checkpoints RunWorkspaceResolver
	Logger      *slog.Logger
}

var _ AttemptExecutor = (*ArtifactPublish)(nil)

func (p *ArtifactPublish) logger() *slog.Logger {
	if p.Logger != nil {
		return p.Logger
	}
	return slog.Default()
}

// artifactPublishSpec is the parsed node config: the shapes § 4 step 9 and the
// exit pipeline use (`name`, `kind`, `mediaType`, `sensitivity`,
// `from.mode`/`from.value`/`from.path`) plus the defaults the contract implies.
type artifactPublishSpec struct {
	name        string
	kind        string
	media       string
	sensitivity string
	mode        string
	path        string
	value       any
}

// artBad is a refusal with its class and code already decided: infra for a fact
// about this worker's wiring, invalid_output for a fact about the node's config
// or payload. The detail is bounded the way FailAttempt bounds it, so a long
// store error cannot smuggle a host path into the attempt either.
func artBad(class, code, detail string) *AttemptResult {
	res := AttemptResult{Status: AttemptStatusFailed, ErrorClass: class, Detail: bounded(detail, 512)}
	if code != "" {
		res.OutputErrors = []any{map[string]any{
			"code":    code,
			"message": bounded(detail, 400),
		}}
	}
	return &res
}

// Execute implements AttemptExecutor. Every refusal is a returned result, never
// a panic and never a half-write: the byte Put happens at most once, the row
// write happens at most once, and a fence refusal after the Put leaves the
// object unreferenced for the orphan sweep — the designed outcome, not a leak.
func (p *ArtifactPublish) Execute(ctx context.Context, c AttemptClaim, _ AttemptSink) (AttemptResult, error) {
	if p == nil {
		return failedResult(ErrorClassInfra, "artifact.publish: executor is not wired (contract § 4 step 9)"), nil
	}
	spec, bad := parseArtifactPublish(c, p.Workspaces)
	if bad != nil {
		return *bad, nil
	}
	if p.Bytes == nil || p.Rows == nil {
		return failedResult(ErrorClassInfra, "artifact.publish: the artifact byte backend and/or the fenced "+
			"artifact-row writer is not wired on this worker (contract § 4 step 9)"), nil
	}

	content, bad := p.materialize(ctx, spec, c)
	if bad != nil {
		return *bad, nil
	}
	// The boundary identity is resolved BEFORE any byte is put: a succeeded
	// worker attempt must record a durable run_checkpoints boundary, and
	// CompleteAttempt refuses one with no volume. Resolving up front means a
	// missing workspace row is refused without orphaning a published artifact.
	ckpt, bound := p.checkpointFor(ctx, c, spec)
	if !bound {
		return failedResult(ErrorClassInfra, "artifact.publish: the artifact is ready but no run workspace boundary "+
			"is bound (contract § 4 step 3): a checkpoint requires a workspace row and its volume, so nothing was "+
			"published (D-024 is same-volume only)"), nil
	}

	content, redactions := p.redact(content)
	if spec.kind == artifacts.KindJSON && !json.Valid(content) {
		// The scan rewrote a key or a bare number rather than a string value. A
		// kind=json artifact that does not parse would be a broken record
		// presented as evidence, and redaction outranks nothing — so the honest
		// answer is a refusal that says why, with nothing written.
		return *artBad(ErrorClassInvalidOutput, ArtifactPublishCodeSourceConfig, fmt.Sprintf(
			"artifact.publish: the secret scan rewrote the json payload into unparseable bytes (%d bytes); "+
				"a kind=json artifact must parse, so nothing was published", len(content))), nil
	}
	if limit := artifacts.LimitFor(spec.kind); limit > 0 && int64(len(content)) > limit {
		return *artBad(ErrorClassInvalidOutput, ArtifactPublishCodePayloadLarge, fmt.Sprintf(
			"artifact.publish: payload is %d bytes, over the %s kind cap of %d bytes (ADR-0020 D2); "+
				"the store refuses rather than clips it, so nothing was published",
			len(content), spec.kind, limit)), nil
	}

	ref, err := p.Bytes.Put(ctx, artifacts.Input{
		ProjectID:   c.ProjectID,
		Name:        artifacts.SanitizeFilename(spec.name),
		Kind:        spec.kind,
		MediaType:   spec.media,
		Sensitivity: spec.sensitivity,
		MaxBytes:    artifacts.LimitFor(spec.kind),
		Body:        bytes.NewReader(content),
	})
	if err != nil {
		return failedResult(ErrorClassInfra, "artifact.publish: put artifact bytes: "+bounded(err.Error(), 400)), nil
	}

	id, err := p.Rows.PublishAttemptArtifact(ctx, AttemptArtifactInput{
		OrganizationID:  c.OrganizationID,
		ProjectID:       c.ProjectID,
		RunID:           c.RunID,
		NodeExecutionID: c.NodeExecutionID,
		AttemptID:       c.AttemptID,
		WorkerID:        c.WorkerID,
		FencingToken:    c.FencingToken,
		Name:            spec.name,
		Kind:            spec.kind,
		MediaType:       spec.media,
		Sensitivity:     spec.sensitivity,
		Ref:             ref,
		RedactionCount:  redactions,
	})
	if err != nil {
		if errors.Is(err, ErrLeaseLost) {
			// The fence proved us stale. § 4 step 10: stop writing — no retry,
			// no second Put, no event. The object is content-addressed and
			// unreferenced, which is the orphan sweep's designed job.
			return failedResult(ErrorClassInfra, "artifact.publish: the fenced artifact writer refused a stale "+
				"lease (this worker's fencing token is no longer current): bytes are in the backend "+
				"unreferenced, no artifact row and no artifact.created event were written"), nil
		}
		return failedResult(ErrorClassInfra, "artifact.publish: publish artifact row: "+bounded(err.Error(), 400)), nil
	}
	if id == "" {
		return failedResult(ErrorClassInfra, "artifact.publish: the fenced artifact writer reported success with "+
			"no artifact id, which the attempt cannot name in outputs"), nil
	}

	return p.succeeded(c, spec, ref, id, redactions, ckpt)
}

// checkpointFor resolves the boundary record the § 4 step 10 transaction
// requires, mirroring ProcExec/AgentTurn. The volume identity comes only from
// the resolver, never invented (D-024). bound=false when no seam is wired or the
// run workspace row cannot be named — the caller then refuses the success rather
// than publish with a boundary nobody can restore. The digests are filled in
// succeeded once the outputs envelope exists.
func (p *ArtifactPublish) checkpointFor(ctx context.Context, c AttemptClaim, spec artifactPublishSpec) (AttemptCheckpoint, bool) {
	if p.Checkpoints == nil {
		return AttemptCheckpoint{}, false
	}
	ref, ok, err := p.Checkpoints.RunWorkspace(context.WithoutCancel(ctx), c.RunID)
	if err != nil || !ok || ref.WorkspaceID == "" || ref.VolumeID == "" {
		return AttemptCheckpoint{}, false
	}
	// The plan's own words, not the resolved bytes: name/kind/media/source are
	// what the run's snapshot declared and they are host-portable, so two workers
	// publishing one plan agree on the inputs digest (procexec.go's reasoning).
	inputs, err := json.Marshal(map[string]any{
		"name": spec.name, "kind": spec.kind, "media": spec.media,
		"sensitivity": spec.sensitivity, "mode": spec.mode, "path": spec.path,
	})
	if err != nil {
		return AttemptCheckpoint{}, false
	}
	return AttemptCheckpoint{
		InputsDigest: "sha256:" + sha256Hex(inputs),
		RepoStates:   ref.RepoStates,
		WorkspaceID:  ref.WorkspaceID,
		VolumeID:     ref.VolumeID,
		WorkerID:     c.WorkerID,
	}, true
}

// materialize turns the node's configured source into the artifact's bytes.
func (p *ArtifactPublish) materialize(ctx context.Context, spec artifactPublishSpec, c AttemptClaim) ([]byte, *AttemptResult) {
	canonical, err := marshalCanonicalJSON(spec.value)
	if err != nil {
		// Unreachable for a claim hydrated from JSON, so it is reported as the
		// bug it is: infra, naming the input, not an invented artifact.
		return nil, artBad(ErrorClassInfra, "", "artifact.publish: from.value is not serializable json: "+
			bounded(err.Error(), 300))
	}
	switch spec.mode {
	case "output_json":
		if spec.kind == artifacts.KindMarkdown {
			return renderMarkdownDoc(spec, c, canonical), nil
		}
		return canonical, nil
	case "workspace_path":
		return p.readWorkspaceFile(ctx, spec, c)
	default:
		// parseArtifactPublish refuses unknown modes; this arm is the backstop.
		return nil, artBad(ErrorClassInvalidOutput, ArtifactPublishCodeSourceConfig,
			"artifact.publish: unsupported from.mode "+spec.mode)
	}
}

// marshalCanonicalJSON is the kind=json payload: indented, and canonical in the
// sense Go's encoder guarantees — map keys sorted — so the digest of the same
// upstream outputs is stable across attempts and across workers (a retry that
// republishes identical bytes hits the owner-scoped run dedupe index
// (artifacts_run_dedupe_idx, migration 00019; ADR-0020 D2's 2026-10-27
// amendment) instead of a second row, while the same bytes in another run get
// their own row).
func marshalCanonicalJSON(v any) ([]byte, error) {
	body, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return nil, err
	}
	if !bytes.HasSuffix(body, []byte("\n")) {
		body = append(body, '\n')
	}
	return body, nil
}

// renderMarkdownDoc is the markdown rendering of an upstream outputs object: a
// titled document that says what produced it, then the JSON verbatim in a
// fenced block. The block's bytes are the same canonical JSON a kind=json
// artifact would carry, so a reader comparing the two forms sees one payload.
func renderMarkdownDoc(spec artifactPublishSpec, c AttemptClaim, canonical []byte) []byte {
	title := strings.TrimSuffix(strings.TrimSuffix(spec.name, ".md"), ".markdown")
	if title == "" {
		title = c.NodeID
	}
	var doc strings.Builder
	doc.WriteString("# " + title + "\n\n")
	fmt.Fprintf(&doc, "Published by pipeline node `%s` (instance `%s`, attempt %d) via `%s`.\n\n",
		c.NodeID, c.NodeInstanceKey, c.AttemptNumber, NodeKindArtifactPublish)
	doc.WriteString("```json\n")
	doc.Write(canonical)
	if !bytes.HasSuffix(canonical, []byte("\n")) {
		doc.WriteString("\n")
	}
	doc.WriteString("```\n")
	return []byte(doc.String())
}

// redact runs the secret scan over the finished bytes and counts replacements.
func (p *ArtifactPublish) redact(content []byte) ([]byte, int) {
	if p.Redact == nil {
		return content, 0
	}
	out, n := p.Redact(string(content))
	if n < 0 {
		n = 0 // ADR-0020 D4's count is a count; a negative is never one.
	}
	return []byte(out), n
}

// readWorkspaceFile reads from.mode=workspace_path off the run tree prepared by
// § 4 step 3. The path is relative, cleaned into the tree, and bounded by the
// kind's cap: this executor publishes files the run produced, it does not get to
// read the worker's filesystem through a pipeline document.
func (p *ArtifactPublish) readWorkspaceFile(ctx context.Context, spec artifactPublishSpec, c AttemptClaim) ([]byte, *AttemptResult) {
	if p.Workspaces == nil {
		return nil, artBad(ErrorClassInfra, "", "artifact.publish: from.mode=workspace_path needs the run-workspace "+
			"path resolver (ArtifactPublish.Workspaces, contract § 4 step 3's prepared tree) and none is wired on "+
			"this worker")
	}
	if ctx.Err() != nil {
		return nil, artBad(ErrorClassInfra, "", "artifact.publish: "+bounded(ctx.Err().Error(), 300))
	}
	ws, ok, err := p.Workspaces.AttemptWorkspace(ctx, c)
	if err != nil {
		return nil, artBad(ErrorClassInfra, "", "artifact.publish: run-workspace path resolver failed: "+
			bounded(err.Error(), 300))
	}
	if !ok || ws.Root == "" {
		return nil, artBad(ErrorClassInfra, "", "artifact.publish: the run-workspace path resolver reports no "+
			"prepared tree for run "+c.RunID+" (contract § 4 step 3 has not landed for this run)")
	}
	if spec.path == "" {
		return nil, artBad(ErrorClassInvalidOutput, ArtifactPublishCodeSourceConfig,
			"artifact.publish: from.mode=workspace_path needs from.path naming a file in the run workspace")
	}
	if filepath.IsAbs(spec.path) {
		return nil, artBad(ErrorClassInvalidOutput, ArtifactPublishCodeSourceConfig,
			"artifact.publish: from.path must be relative to the run workspace, not absolute")
	}
	full := filepath.Join(ws.Root, filepath.Clean("/"+filepath.FromSlash(spec.path)))
	if !strings.HasPrefix(full, filepath.Clean(ws.Root)+string(os.PathSeparator)) {
		return nil, artBad(ErrorClassInvalidOutput, ArtifactPublishCodeSourceConfig,
			"artifact.publish: from.path escapes the run workspace")
	}
	st, err := os.Stat(full)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, artBad(ErrorClassInvalidOutput, ArtifactPublishCodeSourceConfig,
				fmt.Sprintf("artifact.publish: from.path %q does not exist in the run workspace "+
					"(an upstream node was expected to write it)", spec.path))
		}
		return nil, artBad(ErrorClassInfra, "", "artifact.publish: stat from.path: "+bounded(err.Error(), 300))
	}
	limit := artifacts.LimitFor(spec.kind)
	if limit > 0 && st.Size() > limit+artifactPublishReadSlack {
		return nil, artBad(ErrorClassInvalidOutput, ArtifactPublishCodePayloadLarge,
			fmt.Sprintf("artifact.publish: from.path %q is %d bytes, over the %s kind cap of %d bytes (ADR-0020 D2)",
				spec.path, st.Size(), spec.kind, limit))
	}
	f, err := os.Open(full)
	if err != nil {
		return nil, artBad(ErrorClassInfra, "", "artifact.publish: open from.path: "+bounded(err.Error(), 300))
	}
	defer func() { _ = f.Close() }()
	read := st.Size() + 1
	if limit > 0 && read > limit+artifactPublishReadSlack {
		read = limit + artifactPublishReadSlack + 1
	}
	body, err := io.ReadAll(io.LimitReader(f, read))
	if err != nil {
		return nil, artBad(ErrorClassInfra, "", "artifact.publish: read from.path: "+bounded(err.Error(), 300))
	}
	return body, nil
}

// succeeded closes the executor's half of the boundary: outputs naming the
// artifact (never carrying it), the outputs digest, and the artifact_refs the
// step 10 transaction persists beside node.attempt.completed.
func (p *ArtifactPublish) succeeded(c AttemptClaim, spec artifactPublishSpec, ref artifacts.Ref, id string, redactions int, ckpt AttemptCheckpoint) (AttemptResult, error) {
	outputs := map[string]any{
		"artifact_id":     id,
		"kind":            spec.kind,
		"name":            spec.name,
		"media_type":      spec.media,
		"sha256":          ref.SHA256,
		"digest":          "sha256:" + ref.SHA256,
		"size_bytes":      ref.SizeBytes,
		"source_mode":     spec.mode,
		"redaction_count": redactions,
	}
	raw, err := json.Marshal(outputs)
	if err != nil || len(raw) > artifactPublishInlineOutput {
		return *artBad(ErrorClassInvalidOutput, ArtifactPublishCodeOutputsLarge, fmt.Sprintf(
			"artifact.publish: outputs envelope is %d bytes over the 32 KiB inline cap (§ 6) — the payload "+
				"belongs in the artifact, not in outputs", len(raw))), nil
	}
	p.logger().Debug("artifact.publish published an artifact",
		slog.String("attempt_id", c.AttemptID), slog.String("artifact_id", id),
		slog.String("kind", spec.kind), slog.Int("redaction_count", redactions))
	ckpt.OutputsDigest = "sha256:" + sha256Hex(raw)
	ckpt.ArtifactRefs = []any{map[string]any{
		"artifact_id":     id,
		"kind":            spec.kind,
		"name":            spec.name,
		"media_type":      spec.media,
		"sha256":          ref.SHA256,
		"size_bytes":      ref.SizeBytes,
		"storage_backend": ref.StorageBackend,
		"storage_key":     ref.StorageKey,
	}}
	return AttemptResult{
		Status:        AttemptStatusSucceeded,
		Outcome:       "passed",
		Outputs:       outputs,
		OutputsDigest: ckpt.OutputsDigest,
		ArtifactRefs:  ckpt.ArtifactRefs,
		Checkpoint:    ckpt,
	}, nil
}

// parseArtifactPublish reads the compiled node config out of the claim. The
// `from.value` arrives already interpolated (attemptport.go's Config comment:
// the compiled node config with its bindings resolved), which is what lets this
// executor publish an upstream node's outputs without re-reading mutable state
// between claim and boundary.
func parseArtifactPublish(c AttemptClaim, resolver AttemptWorkspaceResolver) (artifactPublishSpec, *AttemptResult) {
	bad := func(code, detail string) *AttemptResult {
		return artBad(ErrorClassInvalidOutput, code, detail)
	}
	spec := artifactPublishSpec{mode: "output_json", sensitivity: artifacts.SensitivityStandard}
	spec.kind, _ = configString(c.Config, "kind")
	if spec.kind == "" {
		spec.kind = artifacts.KindJSON
	}
	if !artifacts.ValidKind(spec.kind) {
		return spec, bad(ArtifactPublishCodeSourceConfig,
			fmt.Sprintf("artifact.publish: kind %q is not in the artifacts enum (ADR-0020 D2)", spec.kind))
	}
	spec.media, _ = configString(c.Config, "mediaType")
	if spec.media == "" {
		spec.media = defaultArtifactMedia(spec.kind)
	}
	if s, ok := configString(c.Config, "sensitivity"); ok && s != "" {
		if !artifacts.ValidSensitivity(s) {
			return spec, bad(ArtifactPublishCodeSourceConfig,
				fmt.Sprintf("artifact.publish: sensitivity %q is not in the artifacts enum", s))
		}
		spec.sensitivity = s
	}
	name, _ := configString(c.Config, "name")
	if name == "" {
		name = c.NodeID + "." + artifactKindExt(spec.kind)
	}
	if len(name) > artifactPublishNameMax {
		name = name[:artifactPublishNameMax]
	}
	spec.name = name

	from, ok := c.Config["from"].(map[string]any)
	if !ok {
		// A node with no `from` block names no source: a pipeline author error
		// surfacing as an attempt, not a worker error.
		return spec, bad(ArtifactPublishCodeSourceConfig, "artifact.publish: config.from is missing or is not an "+
			"object; the node names no source (contract § 4 step 9: config.from.mode is workspace_path or output_json)")
	}
	mode, _ := from["mode"].(string)
	if mode == "" {
		return spec, bad(ArtifactPublishCodeSourceConfig,
			"artifact.publish: config.from.mode is missing; the node names no source mode (contract § 4 step 9)")
	}
	spec.mode = mode
	switch mode {
	case "output_json":
		val, present := from["value"]
		if !present || val == nil {
			return spec, bad(ArtifactPublishCodeSourceConfig, "artifact.publish: from.mode=output_json needs "+
				"from.value (an upstream node's validated outputs, interpolated into the claim); it is missing "+
				"or interpolated to null")
		}
		spec.value = val
		if spec.kind != artifacts.KindMarkdown && spec.kind != artifacts.KindJSON {
			return spec, bad(ArtifactPublishCodeSourceConfig, fmt.Sprintf(
				"artifact.publish: from.mode=output_json renders markdown or json, not %s "+
					"(an outputs object does not imply a workspace file's kind)", spec.kind))
		}
	case "workspace_path":
		if path, ok := from["path"].(string); ok && path != "" {
			spec.path = path
		} else if s, ok := from["value"].(string); ok && s != "" {
			spec.path = s
		}
		if resolver == nil {
			// Checked here as well as in readWorkspaceFile so the failure names
			// the missing seam before any of the node's other inputs are read.
			return spec, artBad(ErrorClassInfra, "", "artifact.publish: from.mode=workspace_path needs the "+
				"run-workspace path resolver (ArtifactPublish.Workspaces, contract § 4 step 3's prepared tree) "+
				"and none is wired on this worker")
		}
	default:
		return spec, bad(ArtifactPublishCodeSourceConfig, "artifact.publish: unsupported from.mode "+mode+
			" (contract § 4 step 9: workspace_path or output_json)")
	}
	return spec, nil
}

func configString(cfg map[string]any, key string) (string, bool) {
	v, ok := cfg[key].(string)
	return v, ok
}

func defaultArtifactMedia(kind string) string {
	switch kind {
	case artifacts.KindMarkdown:
		return "text/markdown"
	case artifacts.KindJSON:
		return "application/json"
	case artifacts.KindHTML:
		return "text/html"
	case artifacts.KindPatch:
		return "text/x-diff"
	default:
		return "application/octet-stream"
	}
}

func artifactKindExt(kind string) string {
	switch kind {
	case artifacts.KindMarkdown:
		return "md"
	case artifacts.KindJSON:
		return "json"
	case artifacts.KindHTML:
		return "html"
	case artifacts.KindPatch:
		return "patch"
	default:
		return kind
	}
}
