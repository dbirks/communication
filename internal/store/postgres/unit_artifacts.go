package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/dbirks/communication/internal/artifacts"
	"github.com/dbirks/communication/internal/events"
	"github.com/dbirks/communication/internal/worker"
)

// UnitArtifacts is the production worker.ArtifactCapturer: bytes go to the
// artifact backend first, and the row plus its artifact.created event land in
// one transaction fenced on the turn's lease triple (docs/m3-contract.md § 4.7,
// ADR-0016 § 9.2, ADR-0020 D2).
//
// The fence is the owner+token pair and *tolerates a terminal turn*: capture
// runs after the terminal write by design (deviation D9 — a capture failure
// must not erase the fact that a turn happened), and a lease stolen by a
// re-claim rotated the token, so the triple check still refuses the one writer
// it exists to refuse: the stale worker.
//
// The exclusion re-filter lives here, not only in git: ADR-0017 D6 says a
// git-level exclusion must never be the only thing standing between a `.env`
// and an artifact, because the exclusion file is editable by anything with
// write access to the mirror. Counting what the filter drops is the
// artifact.redaction_count the exit gate reads: a manifest that lost entries
// has a number, and a scanner that never fired stays distinguishable from one
// that was not needed.
type UnitArtifacts struct {
	Pool *pgxpool.Pool
	// Bytes is the artifact backend the worker writes (local root or S3).
	Bytes artifacts.Store
}

// Compile-time proof of the seam.
var _ worker.ArtifactCapturer = (*UnitArtifacts)(nil)

// PublishArtifactInput is one artifact's row material, assembled by the
// capturer and never by a caller that could name a storage key.
type PublishArtifactInput struct {
	OrganizationID string
	ProjectID      string
	ConversationID string
	TurnID         string
	WorkerID       string
	FencingToken   int64

	Name        string
	Kind        string
	MediaType   string
	Sensitivity string
	Ref         artifacts.Ref
	// RedactionCount counts the manifest entries the exclusion re-filter
	// dropped. It is the observable half of "the scanner ran".
	RedactionCount int
}

// Capture implements worker.ArtifactCapturer.
func (a *UnitArtifacts) Capture(ctx context.Context, req worker.CaptureRequest) (string, error) {
	if a == nil || a.Pool == nil || a.Bytes == nil {
		return "", errors.New("postgres: artifact capturer is not wired")
	}
	if req.WorkerID == "" || !prjValidUUID(req.TurnID) {
		return "", errors.New("postgres: artifact capture needs the worker and the turn")
	}
	redacted := 0
	kept := make([]string, 0, len(req.Manifest))
	for _, path := range req.Manifest {
		if artExcluded(path, req.ExcludedPaths) {
			redacted++
			continue
		}
		kept = append(kept, path)
	}
	content := req.Content
	media := req.MediaType
	name := req.Name
	switch {
	case len(content) > 0:
		// A file artifact. The path it came from is re-checked against the
		// exclusion set here, not only by git: this *is* the second line of
		// defence ADR-0017 D6 asks for, and a hit is a silent skip — the file
		// is not publishable, and saying so loudly would leak the exclusion
		// set's contents into logs.
		if artExcluded(name, req.ExcludedPaths) {
			return "", nil
		}
		if media == "" {
			return "", fmt.Errorf("postgres: file artifact %q carries no media type", name)
		}
	default:
		body, err := json.MarshalIndent(artifactJSON{
			RepositoryID: req.RepositoryID, Summary: req.Summary, ModifiedPaths: kept,
			TurnID: req.TurnID, WorkspaceID: req.WorkspaceID,
		}, "", "  ")
		if err != nil {
			return "", fmt.Errorf("postgres: encode checkpoint artifact: %w", err)
		}
		content, media = body, "application/json"
	}
	if name == "" {
		name = artifacts.KindCheckpoint + "-" + req.RepositoryID
	}
	ref, err := a.Bytes.Put(ctx, artifacts.Input{
		ProjectID: req.ProjectID, Name: artifacts.SanitizeFilename(name),
		Kind: req.Kind, MediaType: media, Sensitivity: artifacts.SensitivityStandard,
		Body: strings.NewReader(string(content)),
	})
	if err != nil {
		return "", fmt.Errorf("postgres: put artifact bytes: %w", err)
	}
	return a.PublishArtifact(ctx, PublishArtifactInput{
		OrganizationID: req.OrganizationID, ProjectID: req.ProjectID,
		ConversationID: req.ConversationID, TurnID: req.TurnID,
		WorkerID: req.WorkerID, FencingToken: req.FencingToken,
		Name: name, Kind: req.Kind, MediaType: media,
		Sensitivity:    artifacts.SensitivityStandard,
		Ref:            ref,
		RedactionCount: redacted,
	})
}

// artifactJSON is a checkpoint's content: the capture, not a diff (ADR-0017
// D8's honesty rule — a manifest of what moved plus the summary, from which
// nothing may claim the tree can be rebuilt elsewhere; D-024 stays Open).
type artifactJSON struct {
	RepositoryID  string   `json:"repository_id"`
	Summary       string   `json:"summary"`
	ModifiedPaths []string `json:"modified_paths"`
	TurnID        string   `json:"turn_id"`
	WorkspaceID   string   `json:"workspace_id"`
}

// PublishArtifact runs the fenced row+event transaction. The bytes are already
// in the backend (Put precedes the row, never the reverse: a row naming keys
// that do not exist would be a `ready` artifact that 404s from its own
// handler). The transaction locks the turn row FOR UPDATE, verifies the
// triple, inserts the artifact row `ready`, and appends artifact.created —
// "a row exists without its event" is the split ADR-0016 § 9 exists to make
// unrepresentable. Dedupe is the UNIQUE(project_id, kind, sha256) constraint:
// a retried capture updates the correlation columns of the row the first
// writer created and folds its redaction count in, never a second copy
// (ADR-0020 D2).
func (a *UnitArtifacts) PublishArtifact(ctx context.Context, in PublishArtifactInput) (string, error) {
	if a == nil || a.Pool == nil {
		return "", errors.New("postgres: artifact capturer has no pool")
	}
	if !prjValidUUID(in.TurnID) || in.WorkerID == "" || in.Ref.StorageKey == "" {
		return "", errors.New("postgres: artifact publish needs a turn, a worker and bytes already in the backend")
	}
	if !artifacts.ValidKind(in.Kind) || !artifacts.ValidSensitivity(in.Sensitivity) {
		return "", fmt.Errorf("postgres: artifact kind %q / sensitivity %q is not in the table enum", in.Kind, in.Sensitivity)
	}
	tx, err := a.Pool.Begin(ctx)
	if err != nil {
		return "", fmt.Errorf("postgres: begin artifact publish tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var owner string
	var token int64
	err = tx.QueryRow(ctx, `
		SELECT worker_id::text, fencing_token FROM conversation_turns WHERE id = $1::uuid FOR UPDATE`,
		prjCleanUUID(in.TurnID)).Scan(&owner, &token)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", fmt.Errorf("postgres: publish artifact for unknown turn: %w", ErrNotFound)
	}
	if err != nil {
		return "", fmt.Errorf("postgres: fence artifact publish: %w", err)
	}
	if owner != in.WorkerID || token != in.FencingToken {
		// The lease moved on. The bytes stay in the backend — content-addressed
		// and unreferenced, the orphan sweep's problem, exactly as designed —
		// and no row or event is written.
		return "", fmt.Errorf("postgres: publish artifact on a stolen lease: %w", worker.ErrLeaseLost)
	}
	var id string
	err = tx.QueryRow(ctx, `
		INSERT INTO artifacts
			(organization_id, project_id, conversation_id, turn_id, worker_id,
			 name, kind, media_type, sha256, size_bytes,
			 storage_backend, storage_key, sensitivity, state, redaction_count, created_by, ready_at)
		VALUES ($1::uuid, $2::uuid, NULLIF($3,'')::uuid, $4::uuid, $5::uuid,
		        $6, $7, $8, $9, $10,
		        $11, $12, $13, 'ready', $14, $15, now())
		ON CONFLICT (project_id, kind, sha256) DO UPDATE SET
		    name = EXCLUDED.name,
		    conversation_id = EXCLUDED.conversation_id,
		    turn_id = EXCLUDED.turn_id,
		    worker_id = EXCLUDED.worker_id,
		    redaction_count = artifacts.redaction_count + EXCLUDED.redaction_count
		RETURNING id::text`,
		in.OrganizationID, in.ProjectID, prjCleanUUID(in.ConversationID), prjCleanUUID(in.TurnID),
		prjCleanUUID(in.WorkerID), in.Name, in.Kind, in.MediaType,
		in.Ref.SHA256, in.Ref.SizeBytes, in.Ref.StorageBackend, in.Ref.StorageKey,
		in.Sensitivity, in.RedactionCount, in.WorkerID,
	).Scan(&id)
	if err != nil {
		return "", fmt.Errorf("postgres: insert artifact row: %w", err)
	}
	if err := secUnitAppendTx(ctx, tx, in.OrganizationID, in.ProjectID, in.ConversationID, in.WorkerID,
		events.TypeArtifactCreated, events.ArtifactCreatedPayload{
			ArtifactID: id, ProjectID: in.ProjectID, Name: in.Name, Kind: in.Kind,
			MediaType: in.MediaType, SHA256: in.Ref.SHA256, SizeBytes: in.Ref.SizeBytes,
			Sensitivity: in.Sensitivity, RedactionCount: in.RedactionCount,
			TurnID: in.TurnID,
		}); err != nil {
		return "", err
	}
	if err := tx.Commit(ctx); err != nil {
		return "", fmt.Errorf("postgres: commit artifact publish: %w", err)
	}
	return id, nil
}

// artExcluded is the artifact-side re-filter. Match is exact or by directory:
// an exclusion of `.env.test.local` removes that file, and an exclusion of
// `.agents` removes everything under it (APM's generated trees are excluded as
// directories). Comparison is slash-normalized because git reports paths with
// slashes and the exclusion set arrives from more than one side.
func artExcluded(path string, exclusions []string) bool {
	path = strings.TrimPrefix(path, "./")
	for _, e := range exclusions {
		e = strings.TrimPrefix(strings.TrimPrefix(e, "./"), "/")
		if e == "" {
			continue
		}
		if path == e || strings.HasPrefix(path, e+"/") {
			return true
		}
	}
	return false
}
