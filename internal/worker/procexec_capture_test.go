package worker

// process.exec node-boundary capture (ADR-0023 § 6: the checkpoint row is the
// same capture the agent turn produces, attached to every completed node —
// 03 "after success of each step preserve ... repository base + resulting
// refs", 05 "At successful node boundaries save: repo HEAD/base refs, dirty
// diff summary"). Before procexec_capture.go a command boundary recorded
// `committed: null` forever and restore_checkpoint always refused (lab live18).
// These pins run the capture against fakes; the store-side derivation of the
// committed/count pointers from the written rows is postgres
// TestRunWorkspaceBoundaryCapture.

import (
	"context"
	"errors"
	"testing"

	wsgit "github.com/dbirks/communication/internal/workspace/git"
)

// capGitStub is the BoundaryGit seam: fixed answers per checkout.
type capGitStub struct {
	heads     map[string]string
	summaries map[string]wsgit.Summary
	headErr   error
	statusErr error

	headCalls    int
	lastExcluded []string
	statusSeen   []string
}

func (g *capGitStub) HeadCommit(_ context.Context, checkout string) (string, error) {
	g.headCalls++
	if g.headErr != nil {
		return "", g.headErr
	}
	return g.heads[checkout], nil
}

func (g *capGitStub) Status(_ context.Context, checkout string, excluded []string) (wsgit.Summary, error) {
	g.lastExcluded = excluded
	g.statusSeen = append(g.statusSeen, checkout)
	if g.statusErr != nil {
		return wsgit.Summary{}, g.statusErr
	}
	return g.summaries[checkout], nil
}

// capResolver is the § 4 step 3 seam with the write half: it re-derives
// RepoStates from what RecordBoundaryCommit wrote, with the store's own rule
// (head_commit is the capture marker; a manifest with paths is a dirty tree),
// so a test that passes here and fails in postgres cannot hide the drift.
type capResolver struct {
	ref     RunWorkspaceRef
	records []CommitRecord
	noWrite bool
}

func (r *capResolver) RunWorkspace(context.Context, string) (RunWorkspaceRef, bool, error) {
	ref := r.ref
	ref.RepoStates = deriveStates(ref.Repos)
	return ref, true, nil
}

func (r *capResolver) RecordBoundaryCommit(_ context.Context, rec CommitRecord) error {
	if r.noWrite {
		return errors.New("fenced write refused")
	}
	r.records = append(r.records, rec)
	for i := range r.ref.Repos {
		if r.ref.Repos[i].RowID == rec.RowID {
			r.ref.Repos[i].RecordedHead = rec.HeadCommit
			r.ref.Repos[i].RecordedPaths = rec.ModifiedPaths
		}
	}
	r.ref.RepoStates = deriveStates(r.ref.Repos)
	return nil
}

// deriveStates mirrors postgres runWorkspaceRepoStates' derivation exactly.
func deriveStates(repos []BoundaryRepo) []CheckpointRepoState {
	out := make([]CheckpointRepoState, 0, len(repos))
	for _, rp := range repos {
		st := CheckpointRepoState{RepositoryID: rp.RepositoryID, BaseCommit: rp.BaseCommit,
			HeadCommit: rp.BaseCommit}
		captured := rp.RecordedHead != ""
		if captured {
			st.HeadCommit = rp.RecordedHead
		}
		if captured || len(rp.RecordedPaths) > 0 {
			st.ModifiedPathCount, st.Committed = RepoStateCapture(len(rp.RecordedPaths), captured && len(rp.RecordedPaths) == 0)
		}
		out = append(out, st)
	}
	return out
}

func capRepo() BoundaryRepo {
	return BoundaryRepo{
		RowID: "row-1", RepositoryID: "repo-app", CheckoutPath: "/ws/run/1/work/repos/app",
		RunRef: "run-1/app", BaseCommit: "aaaa1111",
	}
}

func capProc(git BoundaryGit, res RunWorkspaceResolver) *ProcExec {
	return &ProcExec{WorkspaceRoot: "/ws", Checkpoints: res, BoundaryGit: git,
		AttemptProfile: func(AttemptClaim) string { return "" }}
}

var capClaim = AttemptClaim{AttemptID: "att-1", RunID: "run-1",
	ProjectID: "prj-1", OrganizationID: "org-1", WorkerID: "w-1", Kind: "process.exec"}

func TestProcExecBoundaryCaptureRecordsCleanCommittedTree(t *testing.T) {
	res := &capResolver{ref: RunWorkspaceRef{WorkspaceID: "ws-1", VolumeID: "vol-1", Repos: []BoundaryRepo{capRepo()}}}
	git := &capGitStub{heads: map[string]string{"/ws/run/1/work/repos/app": "aaaa1111"},
		summaries: map[string]wsgit.Summary{"/ws/run/1/work/repos/app": {}}}
	// Un-captured (RecordedHead ""), HEAD == base: nobody ever measured this
	// tree, so the first read-back records it — committed:true, 0 paths — the
	// exact state ADR-0023 § 6 lets restore_checkpoint reset to.
	capProc(git, res).captureBoundary(context.Background(), capClaim, nil)
	if len(res.records) != 1 {
		t.Fatalf("records = %+v, want the first ref read-back recorded", res.records)
	}
	rec := res.records[0]
	if rec.RowID != "row-1" || rec.WorkspaceID != "ws-1" || rec.RepositoryID != "repo-app" ||
		rec.RunRef != "run-1/app" || rec.HeadCommit != "aaaa1111" || len(rec.ModifiedPaths) != 0 {
		t.Fatalf("record = %+v, want the row/workspace/ref identity and the read HEAD", rec)
	}
	st := checkpointForStates(t, res, capClaim)
	if st[0].Committed == nil || !*st[0].Committed {
		t.Fatalf("boundary committed = %v, want a captured true", st[0].Committed)
	}
	if st[0].ModifiedPathCount == nil || *st[0].ModifiedPathCount != 0 {
		t.Fatalf("boundary modified_path_count = %v, want a captured 0", st[0].ModifiedPathCount)
	}
}

func TestProcExecBoundaryCaptureRecordsNewCommit(t *testing.T) {
	res := &capResolver{ref: RunWorkspaceRef{WorkspaceID: "ws-1", VolumeID: "vol-1",
		Repos: []BoundaryRepo{capRepo()}}}
	ck := capRepo().CheckoutPath
	git := &capGitStub{heads: map[string]string{ck: "bbbb2222"},
		summaries: map[string]wsgit.Summary{ck: {}}}
	capProc(git, res).captureBoundary(context.Background(), capClaim, nil)
	if len(res.records) != 1 || res.records[0].HeadCommit != "bbbb2222" {
		t.Fatalf("records = %+v, want the moved ref recorded from the read", res.records)
	}
	st := checkpointForStates(t, res, capClaim)
	if st[0].Committed == nil || !*st[0].Committed || st[0].HeadCommit != "bbbb2222" {
		t.Fatalf("boundary state = %+v, want committed true at bbbb2222", st[0])
	}
}

func TestProcExecBoundaryCaptureDirtyTreeIsNotCommitted(t *testing.T) {
	res := &capResolver{ref: RunWorkspaceRef{WorkspaceID: "ws-1", VolumeID: "vol-1", Repos: []BoundaryRepo{capRepo()}}}
	ck := capRepo().CheckoutPath
	git := &capGitStub{heads: map[string]string{ck: "aaaa1111"}, summaries: map[string]wsgit.Summary{
		ck: {Dirty: true, Paths: []string{"a.txt", "b.txt"}}}}
	capProc(git, res).captureBoundary(context.Background(), capClaim, nil)
	if len(res.records) != 1 || len(res.records[0].ModifiedPaths) != 2 {
		t.Fatalf("records = %+v, want the manifest written with the first read-back", res.records)
	}
	st := checkpointForStates(t, res, capClaim)
	if st[0].Committed == nil || *st[0].Committed {
		t.Fatalf("boundary committed = %v, want a captured false for a dirty tree", st[0].Committed)
	}
	if st[0].ModifiedPathCount == nil || *st[0].ModifiedPathCount != 2 {
		t.Fatalf("modified_path_count = %v, want 2", st[0].ModifiedPathCount)
	}
}

func TestProcExecBoundaryCaptureSkipsAnAlreadyRecordedCleanTree(t *testing.T) {
	// The agent path's condition, kept: a clean tree whose recorded head equals
	// the read ref was already captured — re-writing it would journal
	// workspace.committed on every command node with nothing to say.
	repo := capRepo()
	repo.RecordedHead = "aaaa1111"
	res := &capResolver{ref: RunWorkspaceRef{WorkspaceID: "ws-1", VolumeID: "vol-1", Repos: []BoundaryRepo{repo}}}
	git := &capGitStub{heads: map[string]string{repo.CheckoutPath: "aaaa1111"},
		summaries: map[string]wsgit.Summary{repo.CheckoutPath: {}}}
	capProc(git, res).captureBoundary(context.Background(), capClaim, nil)
	if len(res.records) != 0 {
		t.Fatalf("records = %+v, want none", res.records)
	}
	if st := checkpointForStates(t, res, capClaim); st[0].Committed == nil || !*st[0].Committed {
		t.Fatalf("state = %+v, want the previously captured committed:true to stand", st[0])
	}
}

func TestProcExecBoundaryCaptureRecordsAHeadStillButNewlyDirtyTree(t *testing.T) {
	// The live19 C6c case: the previous boundary captured this checkout clean
	// (RecordedHead == HEAD, manifest empty), and THIS command node's edit
	// dirtied the tree without moving HEAD. A guard that only watches the ref
	// keeps the row's stale clean manifest — and runWorkspaceRepoStates then
	// derives committed:true for a dirty tree, which is the record
	// restore_checkpoint trusts before it resets uncommitted work away.
	repo := capRepo()
	repo.RecordedHead = "aaaa1111"
	res := &capResolver{ref: RunWorkspaceRef{WorkspaceID: "ws-1", VolumeID: "vol-1", Repos: []BoundaryRepo{repo}}}
	ck := capRepo().CheckoutPath
	git := &capGitStub{heads: map[string]string{ck: "aaaa1111"}, summaries: map[string]wsgit.Summary{
		ck: {Dirty: true, Paths: []string{"hello.py"}}}}
	capProc(git, res).captureBoundary(context.Background(), capClaim, nil)
	if len(res.records) != 1 || len(res.records[0].ModifiedPaths) != 1 ||
		res.records[0].ModifiedPaths[0] != "hello.py" || res.records[0].HeadCommit != "aaaa1111" {
		t.Fatalf("records = %+v, want the still-HEAD read written with the new dirty manifest", res.records)
	}
	st := checkpointForStates(t, res, capClaim)
	if st[0].Committed == nil || *st[0].Committed {
		t.Fatalf("boundary committed = %v, want the captured false that makes restore_checkpoint refuse", st[0].Committed)
	}
	if st[0].ModifiedPathCount == nil || *st[0].ModifiedPathCount != 1 {
		t.Fatalf("modified_path_count = %v, want 1", st[0].ModifiedPathCount)
	}
	// The same capture again (nothing moved since): the manifest is already
	// what the row says, so no second workspace.committed is journalled.
	capProc(git, res).captureBoundary(context.Background(), capClaim, nil)
	if len(res.records) != 1 {
		t.Fatalf("records = %+v, want the unchanged dirty manifest recorded once", res.records)
	}
}

func TestProcExecBoundaryCaptureFailureKeepsTheAttempt(t *testing.T) {
	// A capture that cannot read git is a warning, never a reclass of the
	// succeeded command: no error escapes, and the boundary record still
	// closes over the rows' truthful (un-captured) states.
	res := &capResolver{ref: RunWorkspaceRef{WorkspaceID: "ws-1", VolumeID: "vol-1", Repos: []BoundaryRepo{capRepo()}}}
	git := &capGitStub{headErr: errors.New("rev-parse died")}
	capProc(git, res).captureBoundary(context.Background(), capClaim, nil)
	if len(res.records) != 0 {
		t.Fatalf("records = %+v, want nothing written after a failed read", res.records)
	}
	ck := capProc(git, res).checkpointFor(context.Background(), capClaim, procExecSpec{executable: "true"}, "sha256:x")
	if ck.VolumeID != "vol-1" {
		t.Fatalf("checkpoint = %+v, want the boundary to still be recordable", ck)
	}
	if len(ck.RepoStates) != 1 || ck.RepoStates[0].Committed != nil {
		t.Fatalf("repo_states = %+v, want an un-captured state, not an invented one", ck.RepoStates)
	}
}

func TestProcExecBoundaryCaptureWithoutRecorderStaysUncaptured(t *testing.T) {
	// A resolver without the write half (any older wiring): zero git work,
	// zero writes, the pre-existing honest un-captured boundary.
	res := &stubCapNoRecorder{}
	git := &capGitStub{}
	capProc(git, res).captureBoundary(context.Background(), capClaim, nil)
	if git.headCalls != 0 || len(res.states()) != 0 {
		t.Fatalf("git calls = %d, want no capture work at all", git.headCalls)
	}
}

type stubCapNoRecorder struct{}

func (stubCapNoRecorder) RunWorkspace(context.Context, string) (RunWorkspaceRef, bool, error) {
	return RunWorkspaceRef{WorkspaceID: "ws-1", VolumeID: "vol-1"}, true, nil
}
func (stubCapNoRecorder) states() []CheckpointRepoState { return nil }

func TestProcExecBoundaryCaptureExcludesMaterializedSecrets(t *testing.T) {
	// ADR-0018: materialized paths are excluded from checkpoints — and for
	// process.exec the deferred cleanup runs AFTER this capture, so the .env
	// the command just received must not be able to hold restore_checkpoint's
	// licence hostage as a "dirty" path.
	repo := capRepo()
	res := &capResolver{ref: RunWorkspaceRef{WorkspaceID: "ws-1", VolumeID: "vol-1", Repos: []BoundaryRepo{repo}}}
	git := &capGitStub{heads: map[string]string{repo.CheckoutPath: "aaaa1111"},
		summaries: map[string]wsgit.Summary{repo.CheckoutPath: {}}}
	m := &Materialized{Files: []string{repo.CheckoutPath + "/.env", "/ws/run/1/work/scratch/other"}}
	capProc(git, res).captureBoundary(context.Background(), capClaim, m)
	want := map[string]bool{".env": true}
	for _, e := range git.lastExcluded {
		delete(want, e)
	}
	if len(want) != 0 {
		t.Fatalf("excluded = %v, want the checkout-relative .env (plus whatever else)", git.lastExcluded)
	}
	for _, e := range git.lastExcluded {
		if e == repo.CheckoutPath+"/.env" {
			t.Fatalf("excluded = %v, want the checkout-relative spelling, not the absolute one", git.lastExcluded)
		}
	}
}

// checkpointForStates runs the boundary record the completion actually writes.
func checkpointForStates(t *testing.T, res *capResolver, c AttemptClaim) []CheckpointRepoState {
	t.Helper()
	ck := (&ProcExec{Checkpoints: res}).checkpointFor(context.Background(), c, procExecSpec{executable: "true"}, "sha256:out")
	if ck.VolumeID == "" {
		t.Fatal("checkpoint unwired")
	}
	return ck.RepoStates
}
