package worker

import (
	"context"
	"fmt"
	"log/slog"
	"strings"

	"github.com/dbirks/communication/internal/artifacts"
	wsgit "github.com/dbirks/communication/internal/workspace/git"
)

// The patch half of the unit-boundary capture (ADR-0078 § Patch artifacts).
//
// A checkpoint answers "which paths moved" and `Summary.Diff` answers "how big
// was it" — neither is reviewable, so a run's story could not quote a line of
// real code (the gap ADR-0078 records and ADR-0020 D2 already made room for:
// `artifacts.kind` has allowed `patch` since migration 00004). This file adds
// the missing read: ONE `patch` artifact per capture, the unified diff of what
// the tree now says against the base the capture already names —
// `CaptureOutcome.BaseCommit`, the branch point the workspace row recorded.
//
// It is capture-only, like everything else here (ADR-0017 D8; D-024 stays
// Open): the artifact records a diff, it promises nothing about rebuilding a
// tree somewhere else.
//
// The git read is the worker's own unsandboxed plumbing over its own workspace
// — the same read `Status` performs for the checkpoint's summary line. No
// Landlock or nono profile is added to this process (AGENTS.md forbids it); the
// agent's child processes stay exactly as sandboxed as they were.

const (
	// ArtifactKindPatch is the reviewable capture. It is internal/artifacts'
	// own value, not a new taxonomy.
	ArtifactKindPatch = artifacts.KindPatch
	// patchMedia is the media type artifact.publish already defaults kind=patch
	// to, so a pipeline-authored patch and a worker-captured one look identical
	// to a reader.
	patchMedia = "text/x-diff"
	// patchArtifactMaxBytes is the artifact's size bound: roughly a hundred
	// edited files' worth of context. Over the bound the diff is cut at a HUNK
	// boundary with a trailing note naming the whole (wsgit.BoundPatch) — never
	// clipped mid-hunk, which would make the artifact a fabricated patch.
	patchArtifactMaxBytes = 64 << 10
)

// PatchReader is the seam the patch capture reads through. `*wsgit.Manager`
// satisfies it with diff.go's Patch; a test hands in a fixed answer. It is a
// separate interface from BoundaryGit on purpose: the process.exec and
// model.chat boundary captures already build fakes for that pair, and the
// patch is the agent path's addition, not a third thing every capture must
// implement to keep compiling.
type PatchReader interface {
	// Patch renders one checkout's unified diff against baseCommit with the
	// excluded set subtracted twice over (git's pathspecs, then this code's).
	Patch(ctx context.Context, checkout, baseCommit string, excluded []string) (string, error)
}

// PatchCapture publishes one capture's patch artifact. Its fields are the three
// things the job needs and no more: the artifact seam, the secret scanner, the
// logger. The unit owns the repository list and the reads (see
// Unit.capturePatches); PatchCapture owns the one publication.
type PatchCapture struct {
	// Store is the artifact capturer. Nil means no store is wired, which every
	// other capture rule in this package already treats as "no artifact", never
	// as a failed turn (deviation D9: a capture failure loses artifacts, not
	// edits).
	Store ArtifactCapturer
	// Redact is the SAME secret scanner the other artifact paths use —
	// seams.go's Materialized.Redact for a turn, which is the hook
	// artifact.publish and the turn sink scan with. It replaces every value this
	// unit materialized with a marker and counts the replacements; the values
	// themselves never reach this package (12-test-strategy case 12's
	// invariant). Nil means nothing was materialized, and the patch is then
	// protected by the exclusion set alone (ADR-0017 D6) — the count stays 0
	// rather than becoming an invented number.
	Redact func(text string) (string, int)
	Logger *slog.Logger
}

// PatchRequest is one patch artifact's scoping. It is the checkpoint
// artifact's own field set, and deliberately has no sensitivity, role or
// visibility member: the patch can only ever reach the audience the manifest
// next to it already has.
type PatchRequest struct {
	OrganizationID string
	ProjectID      string
	WorkspaceID    string
	ConversationID string
	TurnID         string
	RepositoryID   string
	WorkerID       string
	FencingToken   int64

	// Name is the artifact's name; Summary is the capture's own summary line, so
	// a reader of the artifact list sees one story across the pair.
	Name    string
	Summary string
	// Manifest is the capture's modified-path list. It rides along because the
	// artifact store re-filters it against ExcludedPaths and turns what it drops
	// into the row's redaction_count — the observable half of "the filter ran".
	Manifest      []string
	ExcludedPaths []string
}

// Capture publishes ONE patch artifact from a diff document that has already
// been read and scanned. Keeping the read out of this method is what lets a
// multi-repository capture still produce one artifact, and keeps the store call
// in exactly one place.
//
// "" with no error is the absence of anything to publish: no store, or an empty
// document (a tree identical to its base produces no patch, which is a true
// answer and not a missing artifact).
func (p *PatchCapture) Capture(ctx context.Context, req PatchRequest, document string) (string, error) {
	if p == nil || p.Store == nil || strings.TrimSpace(document) == "" {
		return "", nil
	}
	bound := wsgit.BoundPatch(document, patchArtifactMaxBytes)
	if bound.Truncated {
		p.logger().Warn("the patch artifact is bounded at a hunk boundary",
			slog.String("name", req.Name),
			slog.Int("files", bound.Files), slog.Int("lines", bound.Lines),
			slog.Int("bytes", len(bound.Text)))
	}
	return p.Store.Capture(ctx, CaptureRequest{
		OrganizationID: req.OrganizationID, ProjectID: req.ProjectID,
		WorkspaceID: req.WorkspaceID, ConversationID: req.ConversationID,
		TurnID: req.TurnID, RepositoryID: req.RepositoryID,
		WorkerID: req.WorkerID, FencingToken: req.FencingToken,
		Kind:      ArtifactKindPatch,
		Name:      req.Name,
		Summary:   req.Summary,
		Manifest:  req.Manifest,
		Content:   []byte(bound.Text),
		MediaType: patchMedia,
		// The store filters this set a second time even though git already
		// honored it (ADR-0017 D6): the exclusion file lives in the mirror's
		// admin dir, which anything with write access to that mirror can edit.
		ExcludedPaths: req.ExcludedPaths,
	})
}

func (p *PatchCapture) logger() *slog.Logger {
	if p != nil && p.Logger != nil {
		return p.Logger
	}
	return slog.Default()
}

// unitPatchCapture builds the capture for a unit: its artifact store and its
// materialized-secret scanner. A unit with no artifact store, or with a
// workspace manager that cannot render a diff, returns nil — the honest
// "this deployment records no patches" rather than a half-wired publisher.
func (u *Unit) unitPatchCapture() *PatchCapture {
	if u == nil || u.svc.Artifacts == nil {
		return nil
	}
	git := u.patchReader()
	if git == nil {
		return nil
	}
	p := &PatchCapture{Store: u.svc.Artifacts, Logger: u.logger}
	if u.Materialized != nil {
		p.Redact = u.Materialized.Redact
	}
	return p
}

// patchReader resolves the diff half of the unit's git manager. UnitService
// holds the concrete *wsgit.Manager (the capture needs its mirrors), so the
// seam is asserted rather than widened into the service; a manager built
// without a git runner and a test stub answer nil here.
func (u *Unit) patchReader() PatchReader {
	var reader any
	if u != nil {
		reader = u.svc.Workspaces
	}
	r, ok := reader.(PatchReader)
	if !ok || r == nil {
		return nil
	}
	return r
}

// patchRepoDiff is one repository's already-read diff feeding the shared
// assembler. The READ stays with the caller (the unit knows its prepared
// checkouts and the capture outcome's base; the agent-node boundary knows the
// run workspace rows and the commit its attempt started from); everything
// after the read — scan, assemble, name — is this file's one implementation.
type patchRepoDiff struct {
	RepositoryID string
	RepoName     string
	// Raw is the repository's unified diff against its base. Blank means this
	// repository changed nothing and contributes no section.
	Raw      string
	Manifest []string
	Summary  string
}

// patchAssembly is the shared assembler's output: ONE artifact's content,
// named, scanned and concatenated. The unit capture publishes it through the
// turn-fenced ArtifactCapturer (this file); the agent-node boundary publishes
// it through the attempt-fenced artifact seams (agentturn_patch.go) — one
// document builder, two fences, one redaction rule.
type patchAssembly struct {
	Document string
	Name     string
	// RepositoryID and Summary come from the FIRST contributing repository,
	// the same anchor the turn capture's artifact row has always used.
	RepositoryID string
	Summary      string
	Manifest     []string
	Redactions   int
}

// assemblePatch is the shared half of every patch artifact: it drops the
// repositories that changed nothing, runs the secret scan on EACH repository's
// hunks BEFORE the document is assembled and before the size bound (bytes that
// survive into the artifact are bytes that were scanned — truncation can never
// be the reason a value went out whole), joins the survivors into one document
// with the multi-repository headers, and names the artifact. The single-
// repository case — every run this platform has shown a human — is named
// `patch-<repo>`; more than one says how many it holds. ok=false is the
// absence of anything to publish: no repository said anything new.
func assemblePatch(redact func(string) (string, int), diffs []patchRepoDiff) (patchAssembly, bool) {
	var (
		a       patchAssembly
		doc     strings.Builder
		first   string
		counted int
	)
	for _, d := range diffs {
		raw := d.Raw
		if strings.TrimSpace(raw) == "" {
			continue // this repository's tree says nothing the base did not
		}
		if redact != nil {
			n := 0
			if raw, n = redact(raw); n < 0 {
				n = 0
			}
			a.Redactions += n
		}
		if counted > 0 {
			doc.WriteString(fmt.Sprintf("# repository %s\n", d.RepoName))
		} else {
			first = d.RepoName
			a.RepositoryID = d.RepositoryID
			a.Summary = d.Summary
		}
		doc.WriteString(raw)
		if !strings.HasSuffix(raw, "\n") {
			doc.WriteString("\n")
		}
		a.Manifest = append(a.Manifest, d.Manifest...)
		counted++
	}
	if counted == 0 {
		return patchAssembly{}, false
	}
	a.Name = "patch-" + first
	if counted > 1 {
		a.Name = fmt.Sprintf("patch-%d-repositories", counted)
	}
	a.Document = doc.String()
	return a, true
}

// capturePatches publishes the unit's ONE patch artifact for a finished
// capture: every repository the unit moved in one document, because a reader of
// a tour wants "what this attempt changed", not one artifact per repository.
// The reading of each repository is the unit's own (checkouts and bases come
// from its capture); the assembling is the shared one every patch artifact
// gets. Best-effort by the checkpoint's own rule: the caller warns on an error
// and the turn still ends. The edits live in git either way.
func (u *Unit) capturePatches(ctx context.Context, outcomes []CaptureOutcome) (string, error) {
	p := u.unitPatchCapture()
	if p == nil {
		return "", nil
	}
	git := u.patchReader()
	var diffs []patchRepoDiff
	for _, res := range outcomes {
		repo := repoFor(u.Repos, res.RepositoryID)
		if repo.CheckoutPath == "" {
			continue
		}
		raw, err := git.Patch(ctx, repo.CheckoutPath, res.BaseCommit, u.ExcludedPaths)
		if err != nil {
			return "", err
		}
		diffs = append(diffs, patchRepoDiff{
			RepositoryID: res.RepositoryID, RepoName: res.RepoName, Raw: raw,
			Manifest: res.Manifest, Summary: res.Summary,
		})
	}
	assembled, ok := assemblePatch(p.Redact, diffs)
	if !ok {
		return "", nil
	}
	if assembled.Redactions > 0 {
		// Out loud, because the store's redaction_count counts the exclusion
		// filter and cannot see this one: a materialized value the agent echoed
		// into a tracked file. "The scanner ran and fired" stays
		// distinguishable from "there was nothing to find" (ADR-0020 D4).
		p.logger().Warn("the patch artifact was redacted before storage",
			slog.String("name", assembled.Name), slog.Int("redactions", assembled.Redactions))
	}
	return p.Capture(ctx, PatchRequest{
		OrganizationID: u.OrganizationID, ProjectID: u.ProjectID,
		WorkspaceID: u.WorkspaceID, ConversationID: u.ConversationID,
		TurnID: u.TurnID, RepositoryID: assembled.RepositoryID,
		WorkerID: u.WorkerID, FencingToken: u.FencingToken,
		Name:          assembled.Name,
		Summary:       assembled.Summary,
		Manifest:      assembled.Manifest,
		ExcludedPaths: u.ExcludedPaths,
	}, assembled.Document)
}
