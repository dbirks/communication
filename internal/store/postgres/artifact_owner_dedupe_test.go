package postgres

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/dbirks/communication/internal/artifacts"
	"github.com/dbirks/communication/internal/worker"
)

// Integration tests for ADR-0020 D2's 2026-10-27 amendment (migration 00019):
// artifact dedupe is OWNER-SCOPED, and the shared content-addressed object
// survives the deletion of any single one of its rows.
//
// The defect these lock out (observed on the M4 lab, C1f): the old UNIQUE
// (project_id, kind, sha256) gave identical bytes ONE artifacts row, and both
// writers upserted their owner columns onto it — so the replay run's publish
// re-pointed the seed run's artifact away from the seed run, emptied its
// artifacts list, and orphaned its artifact.created evidence. Two rows over
// one object is now the correct shape; a retry of the SAME owner still folds
// into one row.

// aodClaim seeds one running run with a claimed, begun attempt on a worker of
// its own and returns the triple plus the node execution id.
func aodClaim(t *testing.T, ctx context.Context, f *m4Fixture, store *AttemptStore, tag string) (string, string, worker.AttemptClaim) {
	t.Helper()
	runID := f.m4QueuedRun(t, ctx, "", 0)
	nodeID, _ := f.m4WorkerNode(t, ctx, runID, "/evidence")
	workerID := m4Worker(t, ctx, f.pool, tag, 1)
	claims, err := store.ClaimAttempts(ctx, workerID, 1)
	if err != nil || len(claims) != 1 {
		t.Fatalf("claim for %s = (%v, %v), want one attempt", tag, claims, err)
	}
	if err := store.BeginAttempt(ctx, claims[0]); err != nil {
		t.Fatalf("BeginAttempt for %s: %v", tag, err)
	}
	if claims[0].RunID != runID {
		t.Fatalf("worker %s claimed %s, want this seed run %s", tag, claims[0].RunID, runID)
	}
	return runID, nodeID, claims[0]
}

// TestArtifactOwnerDedupeCrossRunKeepsOwnRow is the C1f defect itself: two
// different runs of one project publish byte-identical evidence (the
// deterministic twin does this every replay). Each run must own its row, keep
// its run_id, and see its own artifact when listed.
func TestArtifactOwnerDedupeCrossRunKeepsOwnRow(t *testing.T) {
	ctx := testCtx(t)
	f, store := awSetup(t)
	aa := &AttemptArtifacts{Pool: f.pool}
	t.Cleanup(func() {
		if _, err := f.pool.Exec(context.Background(),
			`DELETE FROM artifacts WHERE project_id = $1::uuid`, f.projectID); err != nil {
			t.Errorf("cleanup artifacts: %v", err)
		}
	})

	_, _, runA := aodClaim(t, ctx, f, store, "owner-a")
	_, _, runB := aodClaim(t, ctx, f, store, "owner-b")
	if runA.RunID == runB.RunID {
		t.Fatalf("both claims are for the same run %s", runA.RunID)
	}

	// The identical bytes of the deterministic twin: same content, same
	// digest, same kind, same project — two different runs.
	body := "# review evidence\n\nverdict: pass\n"
	idA, err := aa.PublishAttemptArtifact(ctx, aaInput(f, runA, body, 1))
	if err != nil {
		t.Fatalf("publish run A: %v", err)
	}
	idB, err := aa.PublishAttemptArtifact(ctx, aaInput(f, runB, body, 2))
	if err != nil {
		t.Fatalf("publish run B: %v", err)
	}
	if idA == idB {
		t.Fatalf("run B's publish returned run A's row id %s (the C1f theft)", idA)
	}

	// Each row keeps its OWN run, node and attempt, and its own scan count
	// (counts fold per owner, never across runs).
	for _, tc := range []struct {
		id       string
		want     worker.AttemptClaim
		redacted int
	}{{idA, runA, 1}, {idB, runB, 2}} {
		var runID, nodeID, attemptID, state string
		var redactions int
		if err := f.pool.QueryRow(ctx, `
			SELECT run_id::text, node_execution_id::text, attempt_id::text, state, redaction_count
			FROM artifacts WHERE id = $1::uuid`, tc.id).
			Scan(&runID, &nodeID, &attemptID, &state, &redactions); err != nil {
			t.Fatalf("read row %s: %v", tc.id, err)
		}
		if runID != tc.want.RunID || nodeID != tc.want.NodeExecutionID || attemptID != tc.want.AttemptID {
			t.Errorf("row %s owner = (%s, %s, %s), want (%s, %s, %s)", tc.id,
				runID, nodeID, attemptID, tc.want.RunID, tc.want.NodeExecutionID, tc.want.AttemptID)
		}
		if state != "ready" {
			t.Errorf("row %s state = %q, want ready", tc.id, state)
		}
		if redactions != tc.redacted {
			t.Errorf("row %s redaction_count = %d, want %d", tc.id, redactions, tc.redacted)
		}
	}

	// The bytes themselves are shared: one object, both rows.
	var keyA, keyB, shaA, shaB string
	if err := f.pool.QueryRow(ctx,
		`SELECT storage_key, sha256 FROM artifacts WHERE id = $1::uuid`, idA).Scan(&keyA, &shaA); err != nil {
		t.Fatal(err)
	}
	if err := f.pool.QueryRow(ctx,
		`SELECT storage_key, sha256 FROM artifacts WHERE id = $1::uuid`, idB).Scan(&keyB, &shaB); err != nil {
		t.Fatal(err)
	}
	if shaA != shaB || keyA != keyB {
		t.Errorf("identical bytes did NOT share storage: (%s,%s) vs (%s,%s)", shaA, keyA, shaB, keyB)
	}

	// The API-side list answers per run with its own row (what the run page
	// renders): run A never comes back empty because run B re-published.
	as := &ArtifactStore{Pool: f.pool}
	caller := Caller{UserID: f.userID, OrganizationID: f.orgID, IsOrgAdmin: true}
	list, err := as.ListArtifacts(ctx, caller, f.projectID, "")
	if err != nil {
		t.Fatalf("ListArtifacts: %v", err)
	}
	seen := map[string]string{}
	for _, a := range list {
		seen[a.ID] = a.RunID
	}
	if seen[idA] != runA.RunID || seen[idB] != runB.RunID {
		t.Errorf("project list = %v, want both rows with their own runs", seen)
	}
}

// TestArtifactOwnerDedupeRetriedAttemptFolds is D2 PRESERVED: a retried
// attempt of the same node publishing identical bytes is still ONE row — the
// fold that keeps a retry from double-counting — with the redaction counts of
// both scans added up.
func TestArtifactOwnerDedupeRetriedAttemptFolds(t *testing.T) {
	ctx := testCtx(t)
	f, store := awSetup(t)
	aa := &AttemptArtifacts{Pool: f.pool}
	t.Cleanup(func() {
		if _, err := f.pool.Exec(context.Background(),
			`DELETE FROM artifacts WHERE project_id = $1::uuid`, f.projectID); err != nil {
			t.Errorf("cleanup artifacts: %v", err)
		}
	})

	_, nodeID, first := aodClaim(t, ctx, f, store, "retry-fold")
	body := `{"verdict":"same"}`
	id1, err := aa.PublishAttemptArtifact(ctx, aaInput(f, first, body, 1))
	if err != nil {
		t.Fatalf("publish attempt 1: %v", err)
	}

	// The honest retry path: the worker closes its own attempt, the node gets
	// attempt number 2, the same worker re-claims it (new fencing token).
	if err := store.InterruptAttemptOwn(ctx, first, worker.InterruptReasonWorkerShutdown); err != nil {
		t.Fatalf("InterruptAttemptOwn: %v", err)
	}
	if _, err := f.runs.QueueAttempt(ctx, NewAttempt{NodeExecutionID: nodeID, AttemptNumber: 2}); err != nil {
		t.Fatalf("QueueAttempt 2: %v", err)
	}
	claims, err := store.ClaimAttempts(ctx, first.WorkerID, 1)
	if err != nil || len(claims) != 1 {
		t.Fatalf("re-claim = (%v, %v), want one attempt", claims, err)
	}
	second := claims[0]
	if second.AttemptID == first.AttemptID || second.RunID != first.RunID || second.NodeExecutionID != nodeID {
		t.Fatalf("re-claim = %+v, want a NEW attempt on the same run/node", second)
	}
	if err := store.BeginAttempt(ctx, second); err != nil {
		t.Fatalf("BeginAttempt 2: %v", err)
	}

	id2, err := aa.PublishAttemptArtifact(ctx, aaInput(f, second, body, 2))
	if err != nil {
		t.Fatalf("publish attempt 2: %v", err)
	}
	if id2 != id1 {
		t.Errorf("retried attempt created %s beside %s, want the same row (ADR-0020 D2)", id2, id1)
	}
	var redactions int
	var rows int
	if err := f.pool.QueryRow(ctx,
		`SELECT redaction_count FROM artifacts WHERE id = $1::uuid`, id1).Scan(&redactions); err != nil {
		t.Fatal(err)
	}
	if redactions != 3 {
		t.Errorf("redaction_count = %d after a 1 + a 2, want the counts folded to 3", redactions)
	}
	if err := f.pool.QueryRow(ctx, `
		SELECT count(*) FROM artifacts
		WHERE project_id = $1::uuid AND sha256 = $2`, f.projectID, aaInput(f, second, body, 0).Ref.SHA256).
		Scan(&rows); err != nil {
		t.Fatal(err)
	}
	if rows != 1 {
		t.Errorf("rows for the retried digest = %d, want 1", rows)
	}
}

// aodPublishTurn publishes one turn capture through the real writer with the
// fixture's lease, over the digest all turns of this test share.
func aodPublishTurn(t *testing.T, ctx context.Context, f *u3Fixture, ua *UnitArtifacts, conversation, turnID, name string, redactions int) string {
	t.Helper()
	id, err := ua.PublishArtifact(ctx, PublishArtifactInput{
		OrganizationID: f.orgID, ProjectID: f.projA, ConversationID: conversation,
		TurnID: turnID, WorkerID: f.worker, FencingToken: f.tokenLease,
		Name: name, Kind: artifacts.KindMarkdown, MediaType: "text/markdown",
		Sensitivity: artifacts.SensitivityStandard,
		Ref: artifacts.Ref{
			StorageBackend: artifacts.BackendLocal,
			StorageKey:     "projects/" + f.projA + "/markdown/shared",
			SHA256:         artDigest("turn-capture"), SizeBytes: 18,
		},
		RedactionCount: redactions,
	})
	if err != nil {
		t.Fatalf("publish turn capture: %v", err)
	}
	return id
}

// aodNewTurn inserts another live turn for the fixture worker. A retry of the
// SAME capture keeps its turn row (the fence re-reads it); a new turn is a new
// capture event and must NOT fold into the old row.
func aodNewTurn(t *testing.T, ctx context.Context, f *u3Fixture, conversation string) string {
	t.Helper()
	var id string
	if err := f.pool.QueryRow(ctx, `
		INSERT INTO conversation_turns
			(conversation_id, prompt, submitted_by, status, worker_id, lease_expires_at,
			 fencing_token, started_at)
		VALUES ($1::uuid, 'capture again', $2::uuid, 'running', $3::uuid,
		        now() + interval '1 hour', $4, now())
		RETURNING id::text`, conversation, f.alice, f.worker, f.tokenLease).Scan(&id); err != nil {
		t.Fatalf("insert turn: %v", err)
	}
	return id
}

// TestArtifactOwnerDedupeTurnRetryVsDistinctTurns is the turn-capture half of
// the amendment: a RETRY of the same capture (same turn row — a lease
// re-claim rotates the token on the SAME turn, and a capture retry replays
// PublishArtifact with the turn it fenced) folds into one row, while a second
// turn of the same conversation and a turn of another conversation each get
// their own row over the same bytes and keep their own owner columns.
func TestArtifactOwnerDedupeTurnRetryVsDistinctTurns(t *testing.T) {
	f := u3Setup(t)
	ctx := testCtx(t)
	// PublishArtifact never touches the byte backend (the Put precedes it, by
	// that writer's own rule), so nil Bytes is the honest wiring here.
	ua := &UnitArtifacts{Pool: f.pool}

	first := aodPublishTurn(t, ctx, f, ua, f.convID, f.turnID, "evidence.md", 1)

	// Retry of the SAME capture (same turn row, same fenced token): one row,
	// counts folded.
	retry := aodPublishTurn(t, ctx, f, ua, f.convID, f.turnID, "evidence.md", 2)
	if retry != first {
		t.Errorf("same-turn retry created %s beside %s, want one row", retry, first)
	}
	var folded int
	if err := f.pool.QueryRow(ctx,
		`SELECT redaction_count FROM artifacts WHERE id = $1::uuid`, first).Scan(&folded); err != nil {
		t.Fatal(err)
	}
	if folded != 3 {
		t.Errorf("redaction_count = %d after a 1 + a 2, want the counts folded to 3", folded)
	}

	// A second turn of the SAME conversation capturing the same bytes is a
	// different capture event: its own row, its own turn_id — the old
	// constraint re-pointed the first turn's row here instead. The conversation
	// allows one live turn, so the first capture's turn closes first (exactly
	// the worker's ordering: capture lands after the terminal write).
	if _, err := f.pool.Exec(ctx, `
		UPDATE conversation_turns SET status = 'completed', finished_at = now(),
		    lease_expires_at = NULL WHERE id = $1::uuid`, f.turnID); err != nil {
		t.Fatalf("close turn 1: %v", err)
	}
	turn2 := aodNewTurn(t, ctx, f, f.convID)
	second := aodPublishTurn(t, ctx, f, ua, f.convID, turn2, "evidence.md", 0)
	if second == first {
		t.Fatal("a second turn stole the first turn's row id")
	}

	// A turn of ANOTHER conversation: again its own row.
	var conv2 string
	if err := f.pool.QueryRow(ctx, `
		INSERT INTO conversations (project_id, agent_profile_id, title, created_by)
		VALUES ($1::uuid, $2::uuid, 'dedupe twin', $3::uuid) RETURNING id::text`,
		f.projA, f.profile, f.alice).Scan(&conv2); err != nil {
		t.Fatalf("insert conversation: %v", err)
	}
	t.Cleanup(func() {
		bg := context.Background()
		if _, err := f.pool.Exec(bg, `DELETE FROM conversation_turns WHERE conversation_id = $1::uuid`, conv2); err != nil {
			t.Errorf("cleanup turns of %s: %v", conv2, err)
		}
		if _, err := f.pool.Exec(bg, `DELETE FROM conversations WHERE id = $1::uuid`, conv2); err != nil {
			t.Errorf("cleanup conversation %s: %v", conv2, err)
		}
	})
	turn3 := aodNewTurn(t, ctx, f, conv2)
	third := aodPublishTurn(t, ctx, f, ua, conv2, turn3, "evidence.md", 0)
	if third == first || third == second {
		t.Fatal("a conversation B turn stole a conversation A row")
	}

	// Every row kept its own turn and conversation: the upsert NEVER rewrites
	// the owner columns any more.
	for _, tc := range []struct{ id, turn, conv string }{
		{first, f.turnID, f.convID}, {second, turn2, f.convID}, {third, turn3, conv2},
	} {
		var turnID, convID string
		if err := f.pool.QueryRow(ctx, `
			SELECT turn_id::text, conversation_id::text FROM artifacts WHERE id = $1::uuid`, tc.id).
			Scan(&turnID, &convID); err != nil {
			t.Fatalf("read row %s: %v", tc.id, err)
		}
		if turnID != tc.turn || convID != tc.conv {
			t.Errorf("row %s owner = (turn %s, conv %s), want (turn %s, conv %s)",
				tc.id, turnID, convID, tc.turn, tc.conv)
		}
	}
}

// TestArtifactSharedBytesSurviveOneRowDeletion is the retention half of the
// amendment: several rows may reference ONE content-addressed object on
// purpose, so expiring or sweeping ONE row must never delete the bytes the
// others still serve. This runs the guard against REAL bytes in the local
// backend, because "the bytes are still there" is the assertion that matters.
func TestArtifactSharedBytesSurviveOneRowDeletion(t *testing.T) {
	ctx := testCtx(t)
	f, store := awSetup(t)
	aa := &AttemptArtifacts{Pool: f.pool}
	t.Cleanup(func() {
		if _, err := f.pool.Exec(context.Background(),
			`DELETE FROM artifacts WHERE project_id = $1::uuid`, f.projectID); err != nil {
			t.Errorf("cleanup artifacts: %v", err)
		}
	})

	root := u3ArtifactRoot(t)
	bytes, err := artifacts.NewLocal(artifacts.LocalConfig{Root: root})
	if err != nil {
		t.Fatalf("NewLocal: %v", err)
	}
	body := "identical evidence for both runs\n"
	ref, err := bytes.Put(ctx, artifacts.Input{
		ProjectID: f.projectID, Name: "twin.md", Kind: artifacts.KindMarkdown,
		MediaType: "text/markdown", Sensitivity: artifacts.SensitivityStandard,
		Body: strings.NewReader(body),
	})
	if err != nil {
		t.Fatalf("Put: %v", err)
	}

	_, _, runA := aodClaim(t, ctx, f, store, "retain-a")
	_, _, runB := aodClaim(t, ctx, f, store, "retain-b")
	in := func(c worker.AttemptClaim) worker.AttemptArtifactInput {
		ci := aaInput(f, c, body, 0)
		ci.Ref = ref // both rows point at the SAME object the backend produced
		return ci
	}
	idA, err := aa.PublishAttemptArtifact(ctx, in(runA))
	if err != nil {
		t.Fatalf("publish run A: %v", err)
	}
	idB, err := aa.PublishAttemptArtifact(ctx, in(runB))
	if err != nil {
		t.Fatalf("publish run B: %v", err)
	}

	// Both rows reference the shared key; neither delete may proceed.
	live, err := BytesStillReferenced(ctx, f.pool, ref.StorageKey, nil)
	if err != nil {
		t.Fatalf("BytesStillReferenced: %v", err)
	}
	if !live {
		t.Fatal("fresh artifact rows report their shared bytes unreferenced")
	}
	sharers, err := ArtifactsReferencingBytes(ctx, f.pool, ref.StorageKey, nil)
	if err != nil {
		t.Fatalf("ArtifactsReferencingBytes: %v", err)
	}
	if len(sharers) != 2 {
		t.Fatalf("reference list = %v, want both rows", sharers)
	}

	// Run A's artifact expires: its row goes to `deleted` — and the sweep's
	// rule is proven: the bytes are NOT deletable yet, so the retention pass
	// that consults the guard leaves the object alone.
	if _, err := f.pool.Exec(ctx, `
		UPDATE artifacts SET state = 'deleted', deleted_at = now() WHERE id = $1::uuid`, idA); err != nil {
		t.Fatalf("expire run A's row: %v", err)
	}
	live, err = BytesStillReferenced(ctx, f.pool, ref.StorageKey, nil)
	if err != nil {
		t.Fatal(err)
	}
	if !live {
		t.Error("deleting ONE row said the shared bytes were free to delete (run B's artifact would 404)")
	}
	if _, err := bytes.Stat(ctx, ref); err != nil {
		t.Errorf("bytes unreadable while run B's row is still live: %v", err)
	}
	sharers, err = ArtifactsReferencingBytes(ctx, f.pool, ref.StorageKey, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(sharers) != 1 || sharers[0] != idB {
		t.Errorf("reference list after one expiry = %v, want just %s", sharers, idB)
	}
	// A sweep that passes the row it just deleted as its exclusion still
	// sees the survivor — the guard agrees with the sweep's own transaction.
	live, err = BytesStillReferenced(ctx, f.pool, ref.StorageKey, []string{idA})
	if err != nil {
		t.Fatal(err)
	}
	if !live {
		t.Error("excepting the already-deleted row hid the surviving row's reference")
	}

	// Run B's row goes too: NOW (and only now) the bytes are free.
	if _, err := f.pool.Exec(ctx, `
		UPDATE artifacts SET state = 'deleted', deleted_at = now() WHERE id = $1::uuid`, idB); err != nil {
		t.Fatalf("expire run B's row: %v", err)
	}
	live, err = BytesStillReferenced(ctx, f.pool, ref.StorageKey, nil)
	if err != nil {
		t.Fatal(err)
	}
	if live {
		t.Error("every row deleted but the bytes are still reported referenced")
	}
	if err := bytes.Delete(ctx, ref); err != nil {
		t.Fatalf("Delete after the last reference went: %v", err)
	}
	if _, err := bytes.Stat(ctx, ref); !errors.Is(err, artifacts.ErrNotFound) {
		t.Errorf("bytes after the sanctioned delete: %v, want ErrNotFound", err)
	}
}
