package postgres

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/dbirks/communication/internal/api"
)

// These tests run against a real PostgreSQL because the properties they check
// are database semantics: the project predicate that makes a non-member's query
// return no rows, the sensitivity filter that has to live in SQL (ADR-0020 D3
// says "in SQL not in React", and the same argument applies to Go), the
// state/sensitivity gate on the preview read, and the audit row a denial must
// leave behind (docs/m3-contract.md § 2, `12-test-strategy` cases 15 and 16).

func artFixture(t *testing.T) (*ArtifactStore, *ProjectStore, string, *pgxpool.Pool) {
	t.Helper()
	ctx := testCtx(t)
	url := mustMigrate(t)
	pool, err := Open(ctx, url)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(pool.Close)

	if _, err := pool.Exec(ctx, `
		TRUNCATE outbox, domain_events, audit_events, artifacts, secret_materializations,
			secret_mounts, secret_versions, secret_metadata, workspace_repos, workspaces,
			worker_volumes, repositories, memberships, projects, oidc_identities, sessions, users
		RESTART IDENTITY CASCADE`); err != nil {
		t.Fatalf("truncate: %v", err)
	}
	var orgID string
	if err := pool.QueryRow(ctx, `SELECT id FROM organizations WHERE slug = 'default'`).Scan(&orgID); err != nil {
		t.Fatalf("seed org lookup: %v", err)
	}
	return &ArtifactStore{Pool: pool}, &ProjectStore{Pool: pool}, orgID, pool
}

// artDigest renders a deterministic 64-hex digest for a label, so a test's
// rows are distinguishable without inventing random content.
func artDigest(label string) string {
	return fmt.Sprintf("%x", sha256.Sum256([]byte(label)))
}

func artKey(t *testing.T, projectID, kind, digest, mediaType string) string {
	t.Helper()
	// The stored key is content-addressed and self-consistent (internal/
	// artifacts' BuildKey), so a fixture that violates it would be testing a
	// shape no writer produces.
	sum := digest + ExtensionForTest(mediaType)
	return fmt.Sprintf("%s/%s/%s/%s", projectID, kind, digest[:2], sum)
}

// ExtensionForTest mirrors internal/artifacts' suffix rule without importing
// it (postgres must not depend on the byte backend's helpers for a fixture).
func ExtensionForTest(mediaType string) string {
	switch mediaType {
	case "text/html":
		return ".html"
	case "image/png":
		return ".png"
	default:
		return ".json"
	}
}

func artInsert(t *testing.T, pool *pgxpool.Pool, orgID, projectID, name, kind, mediaType,
	digest, state, sensitivity string) string {
	t.Helper()
	var id string
	err := pool.QueryRow(context.Background(), `
		INSERT INTO artifacts (organization_id, project_id, name, kind, media_type, sha256,
			size_bytes, storage_backend, storage_key, sensitivity, state, created_by, ready_at)
		VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, 12, 'local', $7, $8, $9, 'worker',
			CASE WHEN $9 = 'ready' THEN now() ELSE NULL END)
		RETURNING id::text`,
		orgID, projectID, name, kind, mediaType, digest,
		artKey(t, projectID, kind, digest, mediaType), sensitivity, state).Scan(&id)
	if err != nil {
		t.Fatalf("insert artifact %s/%s: %v", name, sensitivity, err)
	}
	return id
}

func artMember(t *testing.T, pool *pgxpool.Pool, projectID, userID, role string) {
	t.Helper()
	if _, err := pool.Exec(context.Background(), `
		INSERT INTO memberships (project_id, user_id, role) VALUES ($1::uuid, $2::uuid, $3)
		ON CONFLICT (project_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
		projectID, userID, role); err != nil {
		t.Fatalf("membership: %v", err)
	}
}

// artCallOf builds the Caller that internal/api would build from a session
// principal — including the org-admin shape, which sees every project in the
// organization without holding a membership.
func artCallOf(t *testing.T, pool *pgxpool.Pool, userID, orgID string, admin bool) Caller {
	t.Helper()
	_ = pool
	return Caller{UserID: userID, OrganizationID: orgID, IsOrgAdmin: admin}
}

// artProject creates a project through the real store and returns its id, so a
// fixture's ids are the same shape a handler would receive.
func artProject(t *testing.T, ps *ProjectStore, callerID, orgID, name, slug string) string {
	t.Helper()
	return prjCreateProject(t, ps, callerID, orgID, name, slug).ID
}

func TestArtifactListRequiresProjectVisibility(t *testing.T) {
	store, projects, orgID, pool := artFixture(t)
	ctx := testCtx(t)
	member := prjUser(t, pool, orgID, "member")
	outsider := prjUser(t, pool, orgID, "outsider")
	project := artProject(t, projects, member, orgID, "Artifacts A", "artifacts-a")

	artInsert(t, pool, orgID, project, "report.md", "markdown", "text/markdown",
		artDigest("r1"), "ready", "standard")

	// A member sees the row.
	list, err := store.ListArtifacts(ctx, artCallOf(t, pool, member, orgID, false), project, "")
	if err != nil {
		t.Fatalf("member ListArtifacts: %v", err)
	}
	if len(list) != 1 || list[0].Name != "report.md" {
		t.Fatalf("member sees %+v, want the one artifact", list)
	}

	// A non-member's query returns an error, not an empty page: the handler
	// turns it into 404 + audit (case 15).
	if _, err := store.ListArtifacts(ctx, artCallOf(t, pool, outsider, orgID, false), project, ""); !errors.Is(err, ErrProjectNotFound) {
		t.Errorf("non-member ListArtifacts = %v, want ErrProjectNotFound", err)
	}
	// A garbage id is the same answer, and no cast error.
	if _, err := store.ListArtifacts(ctx, artCallOf(t, pool, member, orgID, false), "not-a-uuid", ""); !errors.Is(err, ErrProjectNotFound) {
		t.Errorf("bad project id = %v, want ErrProjectNotFound", err)
	}
	// An org admin with no membership sees it too (authz.CanView's rule).
	if _, err := store.ListArtifacts(ctx, artCallOf(t, pool, outsider, orgID, true), project, ""); err != nil {
		t.Errorf("org admin ListArtifacts: %v", err)
	}
}

func TestArtifactListSensitivityIsFilteredInSQL(t *testing.T) {
	store, projects, orgID, pool := artFixture(t)
	ctx := testCtx(t)
	viewer := prjUser(t, pool, orgID, "viewer")
	maintainer := prjUser(t, pool, orgID, "maintainer")
	project := artProject(t, projects, maintainer, orgID, "Sensitivity", "sensitivity")
	artMember(t, pool, project, viewer, "viewer")

	for _, s := range []string{"standard", "internal", "restricted", "secret"} {
		artInsert(t, pool, orgID, project, s+".md", "markdown", "text/markdown",
			artDigest(s), "ready", s)
	}

	viewerList, err := store.ListArtifacts(ctx, artCallOf(t, pool, viewer, orgID, false), project, "")
	if err != nil {
		t.Fatalf("viewer list: %v", err)
	}
	if len(viewerList) != 2 {
		t.Fatalf("viewer sees %d rows (%s), want standard+internal only",
			len(viewerList), artNames(viewerList))
	}
	for _, a := range viewerList {
		if a.Sensitivity == "restricted" || a.Sensitivity == "secret" {
			t.Errorf("viewer was handed a %s row", a.Sensitivity)
		}
	}

	maintainerList, err := store.ListArtifacts(ctx, artCallOf(t, pool, maintainer, orgID, false), project, "")
	if err != nil {
		t.Fatalf("maintainer list: %v", err)
	}
	if len(maintainerList) != 3 {
		t.Errorf("maintainer sees %d rows (%s), want standard+internal+restricted",
			len(maintainerList), artNames(maintainerList))
	}
	for _, a := range maintainerList {
		if a.Sensitivity == "secret" {
			t.Errorf("a secret row appeared in a listing at all — 06 keeps it unlisted")
		}
	}

	// Ordering is newest-first by (created_at, id), which a page cursor keys on.
	if maintainerList[0].CreatedAt.Before(maintainerList[len(maintainerList)-1].CreatedAt) {
		t.Errorf("listing is not newest-first: %s then %s",
			maintainerList[0].CreatedAt, maintainerList[len(maintainerList)-1].CreatedAt)
	}
}

func artNames(list []Artifact) string {
	parts := make([]string, 0, len(list))
	for _, a := range list {
		parts = append(parts, a.Name+":"+a.Sensitivity+":"+a.State)
	}
	return strings.Join(parts, ", ")
}

func TestArtifactListHidesRowsThatAreNotReady(t *testing.T) {
	store, projects, orgID, pool := artFixture(t)
	ctx := testCtx(t)
	owner := prjUser(t, pool, orgID, "owner")
	project := artProject(t, projects, owner, orgID, "States", "states")
	for _, state := range []string{"uploading", "ready", "orphan", "deleted"} {
		artInsert(t, pool, orgID, project, state+".md", "markdown", "text/markdown",
			artDigest(state), state, "standard")
	}
	list, err := store.ListArtifacts(ctx, artCallOf(t, pool, owner, orgID, false), project, "")
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(list) != 1 || list[0].State != "ready" {
		t.Errorf("listing = %s, want the one ready row", artNames(list))
	}
}

// artInsertForConversation is artInsert with the conversation correlation
// the thread filter reads: the artifact belongs to that thread's turn.
func artInsertForConversation(t *testing.T, pool *pgxpool.Pool, orgID, projectID, conversationID, name, kind, mediaType, digest, state, sensitivity string) string {
	t.Helper()
	var id string
	err := pool.QueryRow(context.Background(), `
		INSERT INTO artifacts (organization_id, project_id, conversation_id, name, kind, media_type, sha256,
			size_bytes, storage_backend, storage_key, sensitivity, state, created_by, ready_at)
		VALUES ($1::uuid, $2::uuid, NULLIF($3,'')::uuid, $4, $5, $6, $7, 12, 'local', $8, $9, $10, 'worker',
			CASE WHEN $10 = 'ready' THEN now() ELSE NULL END)
		RETURNING id::text`,
		orgID, projectID, conversationID, name, kind, mediaType, digest,
		artKey(t, projectID, kind, digest, mediaType), sensitivity, state).Scan(&id)
	if err != nil {
		t.Fatalf("insert artifact %s/%s: %v", name, sensitivity, err)
	}
	return id
}

// TestArtifactListByConversation is the design handoff's thread-rail ask
// (docs/design/handoff-app-shell/gaps/threads.md, W3) at the database level: the
// `?conversation_id=` filter must answer the thread's own artifacts — the rows
// its turns captured plus the rows its started runs captured — while an unknown
// or invisible conversation must answer not-found rather than an empty list.
func TestArtifactListByConversation(t *testing.T) {
	store, projects, orgID, pool := artFixture(t)
	ctx := testCtx(t)
	owner := prjUser(t, pool, orgID, "owner")
	member := prjUser(t, pool, orgID, "member")
	project := artProject(t, projects, owner, orgID, "Thread artifacts", "thread-artifacts")
	artMember(t, pool, project, member, "contributor")
	cnv := &CnvStore{Pool: pool}
	var profileID string
	if err := pool.QueryRow(ctx, `SELECT id FROM agent_profiles WHERE organization_id = $1 AND name = 'Claude Code'`, orgID).Scan(&profileID); err != nil {
		t.Fatalf("seeded profile lookup (migration 00003): %v", err)
	}
	threadA, err := cnv.CreateConversation(ctx, artCallOf(t, pool, member, orgID, false), project, profileID, "Fix the flaky spec", "please")
	threadB, err := cnv.CreateConversation(ctx, artCallOf(t, pool, member, orgID, false), project, profileID, "Add retry logging", "please")
	// Both prompts above enqueued a live 'please' turn. This test never
	// claims them, and ClaimTurn is a global FIFO — leaving them queued
	// would hand them to whichever turn test claims next. Settle them here.
	settleQueuedTurns(t, pool, threadA.ID, threadB.ID)

	artInsertForConversation(t, pool, orgID, project, threadA.ID, "report.md", "markdown", "text/markdown", artDigest("a"), "ready", "standard")
	artInsertForConversation(t, pool, orgID, project, threadA.ID, "notes.md", "markdown", "text/markdown", artDigest("b"), "ready", "standard")
	artInsertForConversation(t, pool, orgID, project, threadB.ID, "retry.log", "markdown", "text/markdown", artDigest("c"), "ready", "standard")

	list, err := store.ListArtifacts(ctx, artCallOf(t, pool, member, orgID, false), project, threadA.ID)
	if err != nil {
		t.Fatalf("thread A list: %v", err)
	}
	if len(list) != 2 {
		t.Fatalf("thread A sees %d rows (%s), want its two artifacts", len(list), artNames(list))
	}

	bList, err := store.ListArtifacts(ctx, artCallOf(t, pool, member, orgID, false), project, threadB.ID)
	if err != nil {
		t.Fatalf("thread B list: %v", err)
	}
	if len(bList) != 1 || bList[0].Name != "retry.log" {
		t.Fatalf("thread B sees %s, want only its own artifact", artNames(bList))
	}

	// A thread with no artifacts yet is a real (empty) answer, not an error.
	threadEmpty, err := cnv.CreateConversation(ctx, artCallOf(t, pool, member, orgID, false), project, profileID, "Empty thread", "")
	emptyList, err := store.ListArtifacts(ctx, artCallOf(t, pool, member, orgID, false), project, threadEmpty.ID)
	if err != nil {
		t.Fatalf("empty thread list: %v", err)
	}
	if len(emptyList) != 0 {
		t.Fatalf("empty thread sees %d rows, want none", len(emptyList))
	}

	// An unknown conversation is the invisible answer (404 upstream), never an
	// empty list that would confirm the project exists.
	if _, err := store.ListArtifacts(ctx, artCallOf(t, pool, member, orgID, false), project, "00000000-0000-0000-0000-000000000000"); !errors.Is(err, ErrArtifactNotFound) {
		t.Errorf("unknown conversation = %v, want ErrArtifactNotFound", err)
	}
	// A malformed conversation id is refused before any cast, same as a bad
	// artifact id.
	if _, err := store.ListArtifacts(ctx, artCallOf(t, pool, member, orgID, false), project, "not-a-uuid"); !errors.Is(err, ErrArtifactNotFound) {
		t.Errorf("bad conversation id = %v, want ErrArtifactNotFound", err)
	}
	// A conversation in another project is not this project's thread either.
	projectB := artProject(t, projects, owner, orgID, "Other threads", "other-threads")
	threadElsewhere, err := cnv.CreateConversation(ctx, artCallOf(t, pool, owner, orgID, false), projectB, profileID, "Elsewhere", "please")
	settleQueuedTurns(t, pool, threadElsewhere.ID)
	if _, err := store.ListArtifacts(ctx, artCallOf(t, pool, member, orgID, false), project, threadElsewhere.ID); !errors.Is(err, ErrArtifactNotFound) {
		t.Errorf("foreign-project conversation = %v, want ErrArtifactNotFound", err)
	}
}

func TestArtifactGetIsScopedToItsProject(t *testing.T) {
	store, projects, orgID, pool := artFixture(t)
	ctx := testCtx(t)
	aOwner := prjUser(t, pool, orgID, "a-owner")
	bOwner := prjUser(t, pool, orgID, "b-owner")
	projectA := artProject(t, projects, aOwner, orgID, "Project A", "project-a")
	_ = artProject(t, projects, bOwner, orgID, "Project B", "project-b")
	artifactA := artInsert(t, pool, orgID, projectA, "a.md", "markdown", "text/markdown",
		artDigest("a"), "ready", "standard")

	got, err := store.GetArtifact(ctx, artCallOf(t, pool, aOwner, orgID, false), artifactA)
	if err != nil {
		t.Fatalf("owner GetArtifact: %v", err)
	}
	if got.ProjectID != projectA || got.StorageKey == "" || got.SHA256 == "" {
		t.Errorf("row = %+v", got)
	}
	if got.MyRole != "maintainer" {
		t.Errorf("MyRole = %q, want maintainer", got.MyRole)
	}
	// A member of a *different* project cannot resolve the id at all — the same
	// answer as "does not exist", with no metadata to leak.
	if _, err := store.GetArtifact(ctx, artCallOf(t, pool, bOwner, orgID, false), artifactA); !errors.Is(err, ErrArtifactNotFound) {
		t.Errorf("other-project member GetArtifact = %v, want ErrArtifactNotFound", err)
	}
	// Org admins reach any artifact in their organization.
	if _, err := store.GetArtifact(ctx, artCallOf(t, pool, bOwner, orgID, true), artifactA); err != nil {
		t.Errorf("org admin GetArtifact: %v", err)
	}
	// A malformed id is not-found, never a cast error.
	if _, err := store.GetArtifact(ctx, artCallOf(t, pool, aOwner, orgID, false), "../../x"); !errors.Is(err, ErrArtifactNotFound) {
		t.Errorf("bad id = %v, want ErrArtifactNotFound", err)
	}
}

func TestArtifactForPreviewOnlyServesRenderableReadyRows(t *testing.T) {
	store, projects, orgID, pool := artFixture(t)
	ctx := testCtx(t)
	owner := prjUser(t, pool, orgID, "preview-owner")
	project := artProject(t, projects, owner, orgID, "Preview", "preview")

	cases := []struct {
		kind, mediaType, sensitivity, state string
		want                                bool
	}{
		{"html", "text/html", "standard", "ready", true},
		{"html", "text/html", "internal", "ready", true},
		{"image", "image/png", "internal", "ready", true},
		{"html", "text/html", "restricted", "ready", false},
		{"html", "text/html", "secret", "ready", false},
		{"html", "text/html", "standard", "uploading", false},
		{"json", "application/json", "standard", "ready", false},
		{"markdown", "text/markdown", "standard", "ready", false},
	}
	ids := map[string]string{}
	for _, c := range cases {
		key := c.kind + "|" + c.sensitivity + "|" + c.state
		ids[key] = artInsert(t, pool, orgID, project, c.kind+"-"+c.state, c.kind, c.mediaType,
			artDigest(key), c.state, c.sensitivity)
	}
	for _, c := range cases {
		key := c.kind + "|" + c.sensitivity + "|" + c.state
		a, err := store.ArtifactForPreview(ctx, ids[key])
		if c.want {
			if err != nil {
				t.Errorf("previewable %s: %v", key, err)
				continue
			}
			if a.StorageKey == "" || a.SHA256 == "" {
				t.Errorf("preview read of %s lost its backend pointer: %+v", key, a)
			}
			continue
		}
		if !errors.Is(err, ErrArtifactNotFound) {
			t.Errorf("preview read of %s = %v, want ErrArtifactNotFound", key, err)
		}
	}
}

// TestArtifactStoreReadsWhatTheWorkerWrote pins the column contract from the
// other side: a row written with ADR-0017/0020's shape must come back with the
// correlation ids, the digests and the timestamps the API serializes.
func TestArtifactStoreReadsWhatTheWorkerWrote(t *testing.T) {
	store, projects, orgID, pool := artFixture(t)
	ctx := testCtx(t)
	owner := prjUser(t, pool, orgID, "writer")
	project := artProject(t, projects, owner, orgID, "Correlations", "correlations")
	// Correlation ids M3 writes: the worker that published the artifact, and a
	// turn. `workers` exists from 00001; `conversation_turns` from 00003. An
	// artifact with no conversation correlation must scan as NULL/absent
	// rather than as an empty string, which is what `artNull` is for.
	var workerID string
	if err := pool.QueryRow(ctx, `
		INSERT INTO workers (name, hostname, version, status)
		VALUES ('m3-artifact-fixture', 'lab', 'test', 'online')
		ON CONFLICT (name) DO UPDATE SET last_heartbeat_at = now()
		RETURNING id::text`).Scan(&workerID); err != nil {
		t.Fatalf("insert worker: %v", err)
	}

	var id string
	err := pool.QueryRow(ctx, `
		INSERT INTO artifacts (organization_id, project_id, worker_id, name, kind,
			media_type, sha256, size_bytes, storage_backend, storage_key, sensitivity,
			state, redaction_count, created_by, ready_at, expires_at)
		VALUES ($1::uuid, $2::uuid, $3::uuid, 'checkpoint', 'checkpoint',
			'application/json', $4, 4096, 'local', $5, 'internal', 'ready', 2, 'worker',
			now(), now() + interval '7 days')
		RETURNING id::text`,
		orgID, project, workerID, artDigest("ckpt"),
		artKey(t, project, "checkpoint", artDigest("ckpt"), "application/json")).Scan(&id)
	if err != nil {
		t.Fatalf("insert checkpoint artifact: %v", err)
	}

	if err != nil {
		t.Fatalf("insert checkpoint artifact: %v", err)
	}

	a, err := store.GetArtifact(ctx, artCallOf(t, pool, owner, orgID, false), id)
	if err != nil {
		t.Fatalf("GetArtifact: %v", err)
	}
	if a.ConversationID != "" || a.TurnID != "" {
		t.Errorf("an uncorrelated artifact scanned as correlated: %q/%q", a.ConversationID, a.TurnID)
	}
	if a.WorkerID != workerID {
		t.Errorf("WorkerID = %q, want %q", a.WorkerID, workerID)
	}
	if a.RedactionCount != 2 || a.Kind != "checkpoint" || a.ReadyAt == nil || a.ExpiresAt == nil {
		t.Errorf("row = %+v", a)
	}
	if !a.CanDownload(false) {
		t.Error("an internal artifact must be downloadable by its maintainer")
	}
	if a.CanMintPreview(false) {
		t.Error("a checkpoint is not a preview kind, so CanMintPreview must be false")
	}
	if a.CanDownload(false) && a.Sensitivity == "secret" {
		t.Error("a secret artifact must never be downloadable")
	}
}

// TestAPIArtifactStoreConversionDrivesTheHandlers is the seam test: it runs the
// *real* adapter against a real row and asserts the serialized view both
// matches openapi's Artifact schema and cannot contain the storage pointer.
func TestAPIArtifactStoreConversionDrivesTheHandlers(t *testing.T) {
	artStore, projects, orgID, pool := artFixture(t)
	ctx := testCtx(t)
	owner := prjUser(t, pool, orgID, "adapter")
	project := artProject(t, projects, owner, orgID, "Adapter", "adapter")
	artifactID := artInsert(t, pool, orgID, project, "page.html", "html", "text/html",
		artDigest("page"), "ready", "standard")

	apiStore := APIArtifactStore{S: artStore, Denials: projects}
	c := api.Caller{UserID: owner, OrganizationID: orgID}

	view, err := apiStore.GetArtifact(ctx, c, artifactID)
	if err != nil {
		t.Fatalf("adapter GetArtifact: %v", err)
	}
	if view.StorageKey == "" || view.MyRole == "" {
		t.Fatalf("the adapter dropped a backend-only field the handlers need: %+v", view)
	}
	raw, err := json.Marshal(view)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	for _, forbidden := range []string{"storage_key", "storage_backend", "my_role", view.StorageKey} {
		if strings.Contains(string(raw), forbidden) {
			t.Errorf("the serialized artifact contains %q: %s", forbidden, raw)
		}
	}
	var asMap map[string]any
	if err := json.Unmarshal(raw, &asMap); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	for _, k := range []string{"id", "project_id", "name", "kind", "media_type", "sha256",
		"size_bytes", "sensitivity", "state", "redaction_count", "created_by", "created_at",
		"ready_at", "expires_at", "deleted_at"} {
		if _, ok := asMap[k]; !ok {
			t.Errorf("serialized artifact is missing %q (%s)", k, raw)
		}
	}
	// A row that is not previewable keeps the field absent entirely.
	if _, present := asMap["preview_url"]; present {
		t.Errorf("the adapter filled a preview_url the handler is meant to decide: %s", raw)
	}

	list, err := apiStore.ListArtifacts(ctx, c, project, "")
	if err != nil {
		t.Fatalf("adapter ListArtifacts: %v", err)
	}
	if len(list) != 1 || list[0].ID != artifactID {
		t.Fatalf("adapter listing = %+v", list)
	}

	// The preview read carries no caller, and still refuses a non-previewable
	// row.
	if _, err := apiStore.ArtifactForPreview(ctx, artifactID); err != nil {
		t.Errorf("ArtifactForPreview(standard html): %v", err)
	}
	if _, err := apiStore.ArtifactForPreview(ctx, "00000000-0000-0000-0000-000000000000"); !errors.Is(err, api.ErrArtifactNotFound) {
		t.Errorf("missing preview artifact = %v, want api.ErrArtifactNotFound", err)
	}
	// And errors reach the handlers as the api sentinels, not driver strings.
	if _, err := apiStore.GetArtifact(ctx, c, "00000000-0000-0000-0000-000000000000"); !errors.Is(err, api.ErrArtifactNotFound) {
		t.Errorf("missing artifact = %v, want api.ErrArtifactNotFound", err)
	}
	if _, err := apiStore.ListArtifacts(ctx, api.Caller{UserID: owner}, project, ""); err == nil {
		t.Error("a caller with no organization was accepted")
	}
}

// TestArtifactDenialsLandInTheAuditTable proves case 15's other half: every
// refused artifact probe writes outcome='denied', including one whose project
// id is garbage (the row must still be legible, not a cast failure).
func TestArtifactDenialsLandInTheAuditTable(t *testing.T) {
	artStore, projects, orgID, pool := artFixture(t)
	ctx := testCtx(t)
	outsider := prjUser(t, pool, orgID, "outsider")
	owner := prjUser(t, pool, orgID, "denial-owner")
	project := artProject(t, projects, owner, orgID, "Denials", "denials")
	artifactID := artInsert(t, pool, orgID, project, "d.md", "markdown", "text/markdown",
		artDigest("d"), "ready", "restricted")

	apiStore := APIArtifactStore{S: artStore, Denials: projects}
	c := api.Caller{UserID: outsider, OrganizationID: orgID}
	for _, action := range []string{"artifact.list", "artifact.get", "artifact.content", "artifact.preview_token"} {
		if err := apiStore.RecordDenied(ctx, c, project, action); err != nil {
			t.Fatalf("RecordDenied(%s): %v", action, err)
		}
	}
	if err := apiStore.RecordDenied(ctx, c, "garbage-id", "artifact.get"); err != nil {
		t.Fatalf("RecordDenied(garbage project): %v", err)
	}
	// A refused read of the artifact itself answers not-found and yields no
	// metadata to leak.
	if _, err := apiStore.GetArtifact(ctx, c, artifactID); !errors.Is(err, api.ErrArtifactNotFound) {
		t.Errorf("outsider GetArtifact = %v, want api.ErrArtifactNotFound", err)
	}

	rows, err := pool.Query(ctx, `
		SELECT action, outcome, project_id, detail::text FROM audit_events
		WHERE actor_id = $1 ORDER BY id`, outsider)
	if err != nil {
		t.Fatalf("read audit: %v", err)
	}
	defer rows.Close()
	seen := map[string]bool{}
	count := 0
	for rows.Next() {
		var action, outcome, detail string
		var projectID *string
		if err := rows.Scan(&action, &outcome, &projectID, &detail); err != nil {
			t.Fatalf("scan audit: %v", err)
		}
		if outcome != "denied" {
			t.Errorf("audit row %s has outcome %q, want denied", action, outcome)
		}
		seen[action] = true
		count++
		if strings.Contains(detail, artDigest("d")) {
			t.Errorf("the audit detail carried an artifact digest: %s", detail)
		}
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("audit rows: %v", err)
	}
	if count != 5 {
		t.Errorf("wrote 5 denials, found %d audit rows", count)
	}
	for _, action := range []string{"artifact.list", "artifact.get", "artifact.content", "artifact.preview_token"} {
		if !seen[action] {
			t.Errorf("no audit row for %s (found %d rows)", action, count)
		}
	}
}

// TestArtifactDedupeConstraintMatchesTheKeyLayout is the store-side half of
// content addressing under 00019's owner-scoped dedupe (ADR-0020 D2's
// 2026-10-27 amendment): the table refuses a second row for the same
// run-side owner key — a retried publish is one artifact, not two — while a
// DIFFERENT run publishing the same bytes gets its own row over the SAME
// content-addressed key. (migrate_test.go asserts the indexes exist; this
// asserts the code's key shape agrees with them: identical bytes → identical
// key, shared by the rows that now coexist.)
func TestArtifactDedupeConstraintMatchesTheKeyLayout(t *testing.T) {
	_, projects, orgID, pool := artFixture(t)
	ctx := testCtx(t)
	owner := prjUser(t, pool, orgID, "dedupe")
	projectA := artProject(t, projects, owner, orgID, "Dedupe A", "dedupe-a")
	projectB := artProject(t, projects, owner, orgID, "Dedupe B", "dedupe-b")
	digest := artDigest("same-bytes")
	key := artKey(t, projectA, "json", digest, "application/json")

	own := `
		INSERT INTO artifacts (organization_id, project_id, run_id, attempt_id,
			name, kind, media_type, sha256, size_bytes, storage_backend,
			storage_key, sensitivity, state, created_by, ready_at)
		VALUES ($1, $2::uuid, $3::uuid, $4::uuid, 'one.json', 'json', 'application/json', $5,
			12, 'local', $6, 'internal', 'ready', 'worker', now())
		RETURNING id::text`
	var runA, runB, attemptA, attemptB string
	for _, v := range []*string{&runA, &runB, &attemptA, &attemptB} {
		if err := pool.QueryRow(ctx, `SELECT gen_random_uuid()::text`).Scan(v); err != nil {
			t.Fatalf("gen uuid: %v", err)
		}
	}
	var idA string
	if err := pool.QueryRow(ctx, own, orgID, projectA, runA, attemptA, digest, key).Scan(&idA); err != nil {
		t.Fatalf("first owned artifact rejected: %v", err)
	}
	if _, err := pool.Exec(ctx, own, orgID, projectA, runA, attemptB, digest, key); err == nil {
		t.Error("a duplicate (run_id, node_execution_id, kind, sha256) row was accepted")
	} else if !strings.Contains(err.Error(), "duplicate key") {
		t.Errorf("expected a unique violation, got %v", err)
	}
	// Another run, same project, same bytes: its OWN row, over the same
	// content-addressed key. The old UNIQUE (project_id, kind, sha256) refused
	// this at best and (via the writers' upsert) stole run A's row at worst.
	var idB string
	if err := pool.QueryRow(ctx, own, orgID, projectA, runB, attemptB, digest, key).Scan(&idB); err != nil {
		t.Fatalf("cross-run duplicate rejected: %v", err)
	}
	if idB == idA {
		t.Fatal("cross-run publish returned the other run's row id")
	}
	var sharedKey string
	if err := pool.QueryRow(ctx, `SELECT storage_key FROM artifacts WHERE id = $1::uuid`, idB).Scan(&sharedKey); err != nil {
		t.Fatal(err)
	}
	if sharedKey != key {
		t.Errorf("run B's row stores bytes at %q, want the shared key %q", sharedKey, key)
	}
	// Same bytes, different project: always allowed, and the row is what
	// carries the project scope, not the object key.
	artInsert(t, pool, orgID, projectB, "three.json", "json", "application/json", digest, "ready", "internal")
}
