package postgres

// ADR-0084 (APM collections): the library items, their immutable revisions, and
// the reads that turn a profile's attachment list into the dependency set the
// worker flattens.
//
// Three rules govern this file, all of them this package's existing rules
// restated for a new library table:
//
//   - The permission predicate is part of the SQL. Collections are
//     organization-scoped exactly as agent_profiles and the shared pipeline
//     library are: *visibility* is any member of the organization, *write* is
//     the organization's library role. A collection in another organization
//     answers not-found, never a peek (ADR-0014 §3).
//   - State and its journal row in ONE transaction (ADR-0013): a revision row
//     and the event naming it share a transaction and either can fail.
//   - A PUBLISHED revision is immutable (ADR-0002's rule, which ADR-0084
//     restates for collections). This file issues exactly one UPDATE against a
//     revision row — the draft→published flip, which moves the status column and
//     nothing else — and migration 00033's trigger is the backstop under
//     anything that arrives from elsewhere. Editing content means a new revision.
//
// A collection is not a package: APM deleted its `.collection.yml` kind in
// 0.12.0 (research §1). What is stored here is an ordered list of pinned refs
// that apm.FlattenProfile turns into the ONE generated apm.yml the worker
// installs, so a profile keeps one lock and one digest whatever the size of the
// set attached to it.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/dbirks/communication/internal/agent/apm"
	"github.com/dbirks/communication/internal/api"
	"github.com/dbirks/communication/internal/events"
)

// Collection write errors, in the profile family's shape so the api fail mapping
// stays one switch.
var (
	ErrCollectionNotFound   = errors.New("postgres: apm collection not found")
	ErrCollectionForbidden  = errors.New("postgres: apm collection write requires the organization's library role")
	ErrCollectionConflict   = errors.New("postgres: an apm collection with that slug already exists")
	ErrCollectionValidation = errors.New("postgres: apm collection request failed validation")
	// ErrCollectionPublished answers the two writes a published revision cannot
	// survive: editing it, or publishing it again. Either way the caller's
	// premise is false, and answering 200 would hide a second actor's publish.
	ErrCollectionPublished = errors.New("postgres: that apm collection revision is already published")
)

// Named 422 codes (ADR-0084), the siblings of the ADR-0030 profile codes; the
// api layer mirrors the strings because a client switches on them.
const (
	// CollectionCodeSlugInvalid: slug breaks the registry grammar.
	CollectionCodeSlugInvalid = api.CollectionCodeSlugInvalid
	// CollectionCodeNameInvalid: name empty or over 200, description over 2000.
	CollectionCodeNameInvalid = api.CollectionCodeNameInvalid
	// CollectionCodeEntriesInvalid: an entry ref is not a pinned apm git
	// dependency, a skills subset names nothing, or the list is over the cap.
	CollectionCodeEntriesInvalid = api.CollectionCodeEntriesInvalid
	// CollectionCodeRevisionInvalid: a profile attached a revision that is a
	// draft, does not exist, or belongs to another organization.
	CollectionCodeRevisionInvalid = api.CollectionCodeRevisionInvalid
)

// collectionSlugPattern is apm_collections.slug's own CHECK — the launcher-id
// grammar again, so one URL-segment rule covers the library.
var collectionSlugPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,63}$`)

// maxCollectionEntries / maxCollectionPins bound what one flatten can be asked
// to render. Every entry is a separate cached clone of a git coordinate at
// resolve time, so an unbounded list is an unbounded install; 200 is far above
// any real bundle (ADR-0084's pstack seed is 36) and low enough that a mistake
// is refused rather than resolved for an hour.
const (
	maxCollectionEntries = 200
	maxCollectionPins    = 40
)

const (
	collectionStatusDraft     = "draft"
	collectionStatusPublished = "published"
)

// APMCollectionProblem is a refused collection write that knows why in a
// machine-readable way — AgentProfileProblem's twin, and it satisfies the same
// errors.Is targets so one 422 branch maps both.
type APMCollectionProblem struct {
	Code    string
	Detail  string
	Wrapped error
}

func (p *APMCollectionProblem) Error() string {
	if p == nil {
		return "postgres: apm collection write refused"
	}
	return fmt.Sprintf("postgres: apm collection write refused (%s): %s", p.Code, p.Detail)
}

func (p *APMCollectionProblem) Is(target error) bool {
	return target == ErrCollectionValidation
}

func collectionRefused(code, detail string) error {
	return &APMCollectionProblem{Code: code, Detail: detail, Wrapped: ErrCollectionValidation}
}

// --- the stored shapes ------------------------------------------------

// APMCollectionEntry is one stored entry of a revision: a pinned apm git
// dependency, the optional skill subset it cherry-picks, and the note that tells
// a reader why it is in the bundle.
type APMCollectionEntry struct {
	Ref    string   `json:"ref"`
	Skills []string `json:"skills,omitempty"`
	Note   string   `json:"note,omitempty"`
}

// APMCollectionPin is one profile attachment: a collection and the EXACT
// revision frozen on the profile. Freezing the revision rather than "latest" is
// what makes a profile revision replayable (ADR-0058) and lets a collection gain
// a revision without moving a running profile's digest.
type APMCollectionPin struct {
	CollectionID string `json:"collection_id"`
	Revision     int    `json:"revision"`
}

// ValidateAPMCollectionEntries checks an entry list against the grammar the
// WORKER applies (apm.NewDep → apm.parsePackageRef, ADR-0030 §3 per element) and
// returns the canonical JSON for the jsonb column. Three call sites, one grammar:
// a revision that stored is a revision that renders.
//
// Order is preserved and meaningful: APM settles a name two dependencies both
// ship by install order, so an entry's position in this array is its position in
// the generated manifest.
func ValidateAPMCollectionEntries(entries []APMCollectionEntry) ([]byte, error) {
	if len(entries) == 0 {
		return []byte(`[]`), nil
	}
	if len(entries) > maxCollectionEntries {
		return nil, collectionRefused(CollectionCodeEntriesInvalid,
			fmt.Sprintf("a collection revision carries at most %d entries (%d were sent).", maxCollectionEntries, len(entries)))
	}
	out := make([]APMCollectionEntry, 0, len(entries))
	for i, e := range entries {
		dep, err := apm.NewDep(e.Ref, e.Skills)
		if err != nil {
			return nil, collectionRefused(CollectionCodeEntriesInvalid,
				fmt.Sprintf("entry %d: %s", i+1, err))
		}
		note := strings.TrimSpace(e.Note)
		if len(note) > 500 {
			return nil, collectionRefused(CollectionCodeEntriesInvalid,
				fmt.Sprintf("entry %d: a note is at most 500 characters.", i+1))
		}
		stored := APMCollectionEntry{Ref: dep.Ref, Skills: dep.Skills, Note: note}
		out = append(out, stored)
	}
	raw, err := json.Marshal(out)
	if err != nil {
		return nil, fmt.Errorf("postgres: encode collection entries: %w", err)
	}
	return raw, nil
}

// ValidateAPMCollectionPins validates a profile's attachment list: shape, at most
// one entry per collection (attaching one collection twice would make its order
// meaningless), and no revision < 1.
func ValidateAPMCollectionPins(pins []APMCollectionPin) ([]byte, error) {
	if len(pins) == 0 {
		return []byte(`[]`), nil
	}
	if len(pins) > maxCollectionPins {
		return nil, collectionRefused(CollectionCodeRevisionInvalid,
			fmt.Sprintf("a profile attaches at most %d collections (%d were sent).", maxCollectionPins, len(pins)))
	}
	seen := map[string]bool{}
	for i, p := range pins {
		if !prjValidUUID(p.CollectionID) {
			return nil, collectionRefused(CollectionCodeRevisionInvalid,
				fmt.Sprintf("attachment %d: collection_id is not a collection id.", i+1))
		}
		if p.Revision < 1 {
			return nil, collectionRefused(CollectionCodeRevisionInvalid,
				fmt.Sprintf("attachment %d: a revision is 1 or higher.", i+1))
		}
		if seen[p.CollectionID] {
			return nil, collectionRefused(CollectionCodeRevisionInvalid,
				fmt.Sprintf("attachment %d: collection %s is attached twice — attach one revision, in the order you want it installed.", i+1, p.CollectionID))
		}
		seen[p.CollectionID] = true
	}
	raw, err := json.Marshal(pins)
	if err != nil {
		return nil, fmt.Errorf("postgres: encode collection attachments: %w", err)
	}
	return raw, nil
}

// DecodeAPMCollectionEntries reads an entries column.
func DecodeAPMCollectionEntries(raw []byte) ([]APMCollectionEntry, error) {
	if len(raw) == 0 || string(raw) == "null" {
		return []APMCollectionEntry{}, nil
	}
	var out []APMCollectionEntry
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, fmt.Errorf("postgres: decode collection entries: %w", err)
	}
	if out == nil {
		out = []APMCollectionEntry{}
	}
	return out, nil
}

// DecodeAPMCollectionPins reads an agent_profiles.apm_collections column. Exported
// so the profile read and the worker's axes read go through one decoder.
func DecodeAPMCollectionPins(raw []byte) ([]APMCollectionPin, error) {
	if len(raw) == 0 || string(raw) == "null" || string(raw) == "[]" {
		return nil, nil
	}
	var out []APMCollectionPin
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, fmt.Errorf("postgres: decode collection attachments: %w", err)
	}
	return out, nil
}

// apiViews projects stored entries onto the wire shape ([] never null).
func collectionEntryViews(entries []APMCollectionEntry) []api.APMCollectionEntryView {
	out := make([]api.APMCollectionEntryView, 0, len(entries))
	for _, e := range entries {
		view := api.APMCollectionEntryView{Ref: e.Ref, Note: e.Note, Skills: []string{}}
		if len(e.Skills) > 0 {
			view.Skills = append([]string(nil), e.Skills...)
		}
		out = append(out, view)
	}
	return out
}

// --- the store ---------------------------------------------------------

// APMCollectionStore is the library's persistence face. It is its own store so
// the profile surface's ProfileStore stays the profile contract it was; the
// visibility and role rules are the package's existing ones.
type APMCollectionStore struct {
	Pool *pgxpool.Pool
}

func (s *APMCollectionStore) pool() (*pgxpool.Pool, error) {
	if s == nil || s.Pool == nil {
		return nil, errors.New("postgres: APMCollectionStore has no pool")
	}
	return s.Pool, nil
}

const apmCollectionShape = `
	col.id::text, col.slug, col.name, col.description,
	col.created_by, col.created_at, col.updated_at,
	lr.id::text, lr.revision, lr.status, lr.created_at, lr.entries::text,
	(SELECT count(*) FROM apm_collection_revisions p
	   WHERE p.collection_id = col.id AND p.status = 'published')`

// apmCollectionLatest is the newest revision of one collection, draft OR
// published: what a collection currently IS.
const apmCollectionLatest = `
	LEFT JOIN LATERAL (
		SELECT id, revision, status, created_at, entries
		FROM apm_collection_revisions
		WHERE collection_id = col.id
		ORDER BY revision DESC
		LIMIT 1
	) lr ON true`

// ListAPMCollections answers GET /api/v1/apm-collections: the caller's whole
// organization in one page ordered by slug, each row carrying its latest
// revision and the count of revisions a profile may actually attach.
func (s *APMCollectionStore) ListAPMCollections(ctx context.Context, c Caller) ([]api.APMCollectionView, error) {
	pool, err := s.pool()
	if err != nil {
		return nil, err
	}
	if err := prjRequireCaller(c); err != nil {
		return nil, err
	}
	rows, err := pool.Query(ctx, `
		SELECT `+apmCollectionShape+`
		FROM apm_collections col
		`+apmCollectionLatest+`
		WHERE col.organization_id = $1::uuid
		ORDER BY col.slug`, c.OrganizationID)
	if err != nil {
		return nil, fmt.Errorf("postgres: list apm collections: %w", err)
	}
	defer rows.Close()
	out := []api.APMCollectionView{}
	for rows.Next() {
		view, scanErr := scanAPMCollection(rows)
		if scanErr != nil {
			return nil, scanErr
		}
		out = append(out, view)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("postgres: read apm collections: %w", err)
	}
	return out, nil
}

// apmCollectionRow is one row of apmCollectionShape.
type apmCollectionRow struct {
	view        api.APMCollectionView
	latestID    *string
	latestRev   *int
	latestState *string
	latestWhen  *time.Time
	entriesText *string
	published   int
}

func scanAPMCollection(r rowScanner) (api.APMCollectionView, error) {
	var row apmCollectionRow
	if err := r.Scan(&row.view.ID, &row.view.Slug, &row.view.Name, &row.view.Description,
		&row.view.CreatedBy, &row.view.CreatedAt, &row.view.UpdatedAt,
		&row.latestID, &row.latestRev, &row.latestState, &row.latestWhen, &row.entriesText, &row.published); err != nil {
		return api.APMCollectionView{}, fmt.Errorf("postgres: scan apm collection: %w", err)
	}
	row.view.PublishedRevisions = row.published
	row.view.CreatedAt = row.view.CreatedAt.UTC()
	row.view.UpdatedAt = row.view.UpdatedAt.UTC()
	if row.latestID == nil || row.latestRev == nil || row.latestState == nil {
		return row.view, nil
	}
	summary := api.APMCollectionRevisionSummary{
		RevisionID: *row.latestID, Revision: *row.latestRev, Status: *row.latestState,
		Entries: []api.APMCollectionEntryView{},
	}
	if row.latestWhen != nil {
		summary.CreatedAt = row.latestWhen.UTC()
	}
	if row.entriesText != nil {
		if entries, err := DecodeAPMCollectionEntries([]byte(*row.entriesText)); err == nil {
			summary.Entries = collectionEntryViews(entries)
		}
	}
	row.view.LatestRevision = &summary
	return row.view, nil
}

// rowScanner is the slice of pgx the collection reads need (Rows and Row both
// satisfy it through Scan).
type rowScanner interface {
	Scan(dest ...any) error
}

// GetAPMCollection answers GET /api/v1/apm-collections/{id}: the collection plus
// its FULL revision history, newest first — the version panel a collection page
// reads, one query per relation.
func (s *APMCollectionStore) GetAPMCollection(ctx context.Context, c Caller, collectionID string) (api.APMCollectionDetailView, error) {
	pool, err := s.pool()
	if err != nil {
		return api.APMCollectionDetailView{}, err
	}
	if err := prjRequireCaller(c); err != nil {
		return api.APMCollectionDetailView{}, err
	}
	if !prjValidUUID(collectionID) {
		return api.APMCollectionDetailView{}, ErrCollectionNotFound
	}
	var detail api.APMCollectionDetailView
	err = pool.QueryRow(ctx, `
		SELECT `+apmCollectionShape+`
		FROM apm_collections col
		`+apmCollectionLatest+`
		WHERE col.id = $1::uuid AND col.organization_id = $2::uuid`, collectionID, c.OrganizationID).
		Scan(&detail.Collection.ID, &detail.Collection.Slug, &detail.Collection.Name, &detail.Collection.Description,
			&detail.Collection.CreatedBy, &detail.Collection.CreatedAt, &detail.Collection.UpdatedAt,
			new(*string), new(*int), new(*string), new(*time.Time), new(*string), new(int))
	if errors.Is(err, pgx.ErrNoRows) {
		return api.APMCollectionDetailView{}, ErrCollectionNotFound
	}
	if err != nil {
		return api.APMCollectionDetailView{}, fmt.Errorf("postgres: get apm collection: %w", err)
	}
	// The list shape is re-read through one query so the projection lives in
	// exactly one place (scanAPMCollection); the throwaway scan above only
	// proves the row is visible to this caller.
	view, err := s.collectionRow(ctx, pool, collectionID, c.OrganizationID)
	if err != nil {
		return api.APMCollectionDetailView{}, err
	}
	detail.Collection = view

	rows, err := pool.Query(ctx, `
		SELECT id::text, revision, status, entries::text, created_by, created_at, updated_at
		FROM apm_collection_revisions
		WHERE collection_id = $1::uuid AND organization_id = $2::uuid
		ORDER BY revision DESC`, collectionID, c.OrganizationID)
	if err != nil {
		return api.APMCollectionDetailView{}, fmt.Errorf("postgres: list apm collection revisions: %w", err)
	}
	defer rows.Close()
	detail.Revisions = []api.APMCollectionRevisionView{}
	published := 0
	for rows.Next() {
		var (
			rev         api.APMCollectionRevisionView
			entriesText string
		)
		if err := rows.Scan(&rev.RevisionID, &rev.Revision, &rev.Status, &entriesText,
			&rev.CreatedBy, &rev.CreatedAt, &rev.UpdatedAt); err != nil {
			return api.APMCollectionDetailView{}, fmt.Errorf("postgres: scan apm collection revision: %w", err)
		}
		entries, derr := DecodeAPMCollectionEntries([]byte(entriesText))
		if derr != nil {
			return api.APMCollectionDetailView{}, derr
		}
		rev.Entries = collectionEntryViews(entries)
		rev.CreatedAt = rev.CreatedAt.UTC()
		rev.UpdatedAt = rev.UpdatedAt.UTC()
		if rev.Status == collectionStatusPublished {
			published++
		}
		detail.Revisions = append(detail.Revisions, rev)
	}
	if err := rows.Err(); err != nil {
		return api.APMCollectionDetailView{}, fmt.Errorf("postgres: read apm collection revisions: %w", err)
	}
	detail.Collection.PublishedRevisions = published
	if len(detail.Revisions) > 0 {
		summary := detail.Revisions[0].Summary()
		detail.Collection.LatestRevision = &summary
	}
	return detail, nil
}

func (s *APMCollectionStore) collectionRow(ctx context.Context, pool *pgxpool.Pool, collectionID, orgID string) (api.APMCollectionView, error) {
	row := pool.QueryRow(ctx, `
		SELECT `+apmCollectionShape+`
		FROM apm_collections col
		`+apmCollectionLatest+`
		WHERE col.id = $1::uuid AND col.organization_id = $2::uuid`, collectionID, orgID)
	view, err := scanAPMCollection(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return api.APMCollectionView{}, ErrCollectionNotFound
	}
	return view, err
}

// CreateAPMCollection inserts a library item AND its revision 1 as a draft in one
// transaction (ADR-0013). Revision 1 is a draft on purpose: creating a collection
// must not make it attachable — publishing is the separate act that says a human
// read the entries (ADR-0084). The library role is the INSERT's WHERE clause, the
// same shape the profile create uses: a non-admin matches zero rows and gets
// ErrCollectionForbidden out of the zero-row branch, not a row.
func (s *APMCollectionStore) CreateAPMCollection(ctx context.Context, c Caller, slug, name, description string, entries []APMCollectionEntry) (api.APMCollectionView, error) {
	pool, err := s.pool()
	if err != nil {
		return api.APMCollectionView{}, err
	}
	if err := prjRequireCaller(c); err != nil {
		return api.APMCollectionView{}, err
	}
	if !collectionSlugPattern.MatchString(slug) {
		return api.APMCollectionView{}, collectionRefused(CollectionCodeSlugInvalid,
			"slug must match ^[a-z0-9][a-z0-9_-]{0,63}$ — it is a URL segment, never a display name.")
	}
	if strings.TrimSpace(name) == "" || len(name) > 200 {
		return api.APMCollectionView{}, collectionRefused(CollectionCodeNameInvalid,
			"name is required and must be at most 200 characters.")
	}
	if len(description) > 2000 {
		return api.APMCollectionView{}, collectionRefused(CollectionCodeNameInvalid,
			"description must be at most 2000 characters.")
	}
	rawEntries, err := ValidateAPMCollectionEntries(entries)
	if err != nil {
		return api.APMCollectionView{}, err
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		return api.APMCollectionView{}, fmt.Errorf("postgres: begin create apm collection: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var view api.APMCollectionView
	err = tx.QueryRow(ctx, `
		INSERT INTO apm_collections (organization_id, slug, name, description, created_by)
		SELECT $1::uuid, $2, $3, $4, $6
		WHERE $5::boolean
		RETURNING id::text, slug, name, description, created_by, created_at, updated_at`,
		c.OrganizationID, slug, strings.TrimSpace(name), description, c.IsOrgAdmin, c.UserID).
		Scan(&view.ID, &view.Slug, &view.Name, &view.Description, &view.CreatedBy, &view.CreatedAt, &view.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return api.APMCollectionView{}, ErrCollectionForbidden
	}
	if m4UniqueViolation(err) {
		return api.APMCollectionView{}, ErrCollectionConflict
	}
	if pgConflictCode(err, "23514") {
		return api.APMCollectionView{}, collectionRefused(CollectionCodeSlugInvalid,
			"slug, name and description were refused by the collection's own column constraints.")
	}
	if err != nil {
		return api.APMCollectionView{}, fmt.Errorf("postgres: insert apm collection: %w", err)
	}
	if _, err := insertCollectionRevision(ctx, tx, view.ID, c.OrganizationID, 1, collectionStatusDraft, rawEntries, c.UserID); err != nil {
		return api.APMCollectionView{}, err
	}
	if _, err := AppendEvent(ctx, tx, events.New{
		Type:           events.TypeAPMCollectionCreated,
		OrganizationID: c.OrganizationID,
		Actor:          events.Human(c.UserID),
		Payload: events.APMCollectionPayload{
			CollectionID: view.ID, Slug: view.Slug, Name: view.Name, Revision: 1,
			EntryCount: len(entries), Status: collectionStatusDraft,
		},
	}); err != nil {
		return api.APMCollectionView{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return api.APMCollectionView{}, fmt.Errorf("postgres: commit create apm collection: %w", err)
	}
	view.CreatedAt = view.CreatedAt.UTC()
	view.UpdatedAt = view.UpdatedAt.UTC()
	return view, nil
}

// insertCollectionRevision lands one revision row in the caller's transaction.
func insertCollectionRevision(ctx context.Context, q prjQuerier, collectionID, orgID string, revision int, status string, entries []byte, createdBy string) (api.APMCollectionRevisionView, error) {
	var (
		view        api.APMCollectionRevisionView
		entriesText string
	)
	err := q.QueryRow(ctx, `
		INSERT INTO apm_collection_revisions
			(collection_id, organization_id, revision, status, entries, created_by)
		VALUES ($1::uuid, $2::uuid, $3, $4, $5::jsonb, $6)
		RETURNING id::text, revision, status, entries::text, created_by, created_at, updated_at`,
		collectionID, orgID, revision, status, string(entries), createdBy).
		Scan(&view.RevisionID, &view.Revision, &view.Status, &entriesText, &view.CreatedBy, &view.CreatedAt, &view.UpdatedAt)
	if m4UniqueViolation(err) {
		return api.APMCollectionRevisionView{}, ErrCollectionConflict
	}
	if err != nil {
		return api.APMCollectionRevisionView{}, fmt.Errorf("postgres: insert apm collection revision: %w", err)
	}
	decoded, derr := DecodeAPMCollectionEntries([]byte(entriesText))
	if derr != nil {
		return api.APMCollectionRevisionView{}, derr
	}
	view.Entries = collectionEntryViews(decoded)
	view.CreatedAt = view.CreatedAt.UTC()
	view.UpdatedAt = view.UpdatedAt.UTC()
	return view, nil
}

// nextCollectionRevision is the number the next write lands: one past the highest
// row the collection has. Dense numbering is what lets a profile name a revision
// without carrying a revision id around.
func nextCollectionRevision(ctx context.Context, q prjQuerier, collectionID string) (int, error) {
	var next int
	if err := q.QueryRow(ctx,
		`SELECT COALESCE(max(revision), 0) + 1 FROM apm_collection_revisions WHERE collection_id = $1::uuid`,
		collectionID).Scan(&next); err != nil {
		return 0, fmt.Errorf("postgres: next apm collection revision: %w", err)
	}
	return next, nil
}

// CreateAPMCollectionRevision is POST /apm-collections/{id}/revisions: a new
// DRAFT carrying the supplied entries. It never edits a revision that exists —
// "save as a new revision" is a new row (ADR-0002's rule, restated for
// collections) — and it never publishes: publishing is its own call with its own
// audit row, because publishing is the moment the bundle becomes attachable.
func (s *APMCollectionStore) CreateAPMCollectionRevision(ctx context.Context, c Caller, collectionID string, entries []APMCollectionEntry) (api.APMCollectionRevisionView, error) {
	pool, err := s.pool()
	if err != nil {
		return api.APMCollectionRevisionView{}, err
	}
	rawEntries, err := ValidateAPMCollectionEntries(entries)
	if err != nil {
		return api.APMCollectionRevisionView{}, err
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		return api.APMCollectionRevisionView{}, fmt.Errorf("postgres: begin create collection revision: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	slug, name, err := requireCollectionWrite(ctx, tx, c, collectionID)
	if err != nil {
		return api.APMCollectionRevisionView{}, err
	}
	revision, err := nextCollectionRevision(ctx, tx, collectionID)
	if err != nil {
		return api.APMCollectionRevisionView{}, err
	}
	view, err := insertCollectionRevision(ctx, tx, collectionID, c.OrganizationID, revision, collectionStatusDraft, rawEntries, c.UserID)
	if err != nil {
		return api.APMCollectionRevisionView{}, err
	}
	if _, err := tx.Exec(ctx, `UPDATE apm_collections SET updated_at = now() WHERE id = $1::uuid`, collectionID); err != nil {
		return api.APMCollectionRevisionView{}, fmt.Errorf("postgres: touch apm collection %s: %w", collectionID, err)
	}
	if _, err := AppendEvent(ctx, tx, events.New{
		Type:           events.TypeAPMCollectionRevisionDrafted,
		OrganizationID: c.OrganizationID,
		Actor:          events.Human(c.UserID),
		Payload: events.APMCollectionPayload{
			CollectionID: collectionID, Slug: slug, Name: name, Revision: revision,
			EntryCount: len(entries), Status: collectionStatusDraft,
		},
	}); err != nil {
		return api.APMCollectionRevisionView{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return api.APMCollectionRevisionView{}, fmt.Errorf("postgres: commit create collection revision: %w", err)
	}
	return view, nil
}

// PublishAPMCollectionRevision is POST /apm-collections/{id}/revisions/{rev}/publish.
// Publishing is the only write a revision row ever receives after it exists and it
// moves exactly one column: the status. The entries a published revision carries
// are the ones it was drafted with, forever — which is what "a published revision
// is immutable" means on the write side, with migration 00033's trigger as the
// backstop under anything that bypasses this file.
func (s *APMCollectionStore) PublishAPMCollectionRevision(ctx context.Context, c Caller, collectionID string, revision int) (api.APMCollectionRevisionView, error) {
	pool, err := s.pool()
	if err != nil {
		return api.APMCollectionRevisionView{}, err
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		return api.APMCollectionRevisionView{}, fmt.Errorf("postgres: begin publish collection revision: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	slug, name, err := requireCollectionWrite(ctx, tx, c, collectionID)
	if err != nil {
		return api.APMCollectionRevisionView{}, err
	}
	var (
		view        api.APMCollectionRevisionView
		entriesText string
	)
	err = tx.QueryRow(ctx, `
		SELECT id::text, revision, status, entries::text, created_by, created_at, updated_at
		FROM apm_collection_revisions
		WHERE collection_id = $1::uuid AND organization_id = $2::uuid AND revision = $3
		FOR UPDATE`, collectionID, c.OrganizationID, revision).
		Scan(&view.RevisionID, &view.Revision, &view.Status, &entriesText, &view.CreatedBy, &view.CreatedAt, &view.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return api.APMCollectionRevisionView{}, ErrCollectionNotFound
	}
	if err != nil {
		return api.APMCollectionRevisionView{}, fmt.Errorf("postgres: read collection revision %s/%d: %w", collectionID, revision, err)
	}
	if view.Status == collectionStatusPublished {
		return api.APMCollectionRevisionView{}, ErrCollectionPublished
	}
	if _, err := tx.Exec(ctx, `
		UPDATE apm_collection_revisions SET status = 'published', updated_at = now()
		WHERE id = $1::uuid`, view.RevisionID); err != nil {
		return api.APMCollectionRevisionView{}, fmt.Errorf("postgres: publish collection revision %s/%d: %w", collectionID, revision, err)
	}
	if _, err := tx.Exec(ctx, `UPDATE apm_collections SET updated_at = now() WHERE id = $1::uuid`, collectionID); err != nil {
		return api.APMCollectionRevisionView{}, fmt.Errorf("postgres: touch apm collection %s: %w", collectionID, err)
	}
	entries, derr := DecodeAPMCollectionEntries([]byte(entriesText))
	if derr != nil {
		return api.APMCollectionRevisionView{}, derr
	}
	view.Status = collectionStatusPublished
	view.Entries = collectionEntryViews(entries)
	view.CreatedAt = view.CreatedAt.UTC()
	view.UpdatedAt = view.UpdatedAt.UTC()
	if _, err := AppendEvent(ctx, tx, events.New{
		Type:           events.TypeAPMCollectionRevisionPublished,
		OrganizationID: c.OrganizationID,
		Actor:          events.Human(c.UserID),
		Payload: events.APMCollectionPayload{
			CollectionID: collectionID, Slug: slug, Name: name, Revision: revision,
			EntryCount: len(entries), Status: collectionStatusPublished,
		},
	}); err != nil {
		return api.APMCollectionRevisionView{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return api.APMCollectionRevisionView{}, fmt.Errorf("postgres: commit publish collection revision: %w", err)
	}
	return view, nil
}

// requireCollectionWrite is the write gate stated once: the collection exists in
// the caller's organization (a foreign one is not-found, never a peek) and the
// caller holds the library role (a member who can read it gets 403).
func requireCollectionWrite(ctx context.Context, q prjQuerier, c Caller, collectionID string) (slug, name string, err error) {
	if err := prjRequireCaller(c); err != nil {
		return "", "", err
	}
	if !prjValidUUID(collectionID) {
		return "", "", ErrCollectionNotFound
	}
	err = q.QueryRow(ctx, `
		SELECT slug, name FROM apm_collections WHERE id = $1::uuid AND organization_id = $2::uuid`,
		collectionID, c.OrganizationID).Scan(&slug, &name)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", "", ErrCollectionNotFound
	}
	if err != nil {
		return "", "", fmt.Errorf("postgres: read apm collection %s: %w", collectionID, err)
	}
	if !c.IsOrgAdmin {
		return "", "", ErrCollectionForbidden
	}
	return slug, name, nil
}

// --- the attachment reads the profile write, the lock queue and the worker share

// APMCollectionRevisionsFor resolves an attachment list to the contents of the
// exact revisions it names, IN ATTACH ORDER. Order is the property the whole
// feature rests on: APM settles a skill name two dependencies both ship by
// install order, so the flatten must see the order the user chose and not the
// database's.
//
// A pin whose revision row is gone refuses rather than skipping the attachment:
// flattening a smaller set than the profile names would lock a context nobody
// attached.
func APMCollectionRevisionsFor(ctx context.Context, q prjQuerier, orgID string, pins []APMCollectionPin) ([]apm.CollectionRevision, error) {
	if len(pins) == 0 {
		return nil, nil
	}
	out := make([]apm.CollectionRevision, 0, len(pins))
	for _, pin := range pins {
		var slug, entriesText string
		err := q.QueryRow(ctx, `
			SELECT col.slug, r.entries::text
			FROM apm_collection_revisions r
			JOIN apm_collections col ON col.id = r.collection_id
			WHERE r.collection_id = $1::uuid AND r.revision = $2 AND r.organization_id = $3::uuid`,
			pin.CollectionID, pin.Revision, orgID).Scan(&slug, &entriesText)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, collectionRefused(CollectionCodeRevisionInvalid,
				fmt.Sprintf("collection %s has no revision %d in this organization.", pin.CollectionID, pin.Revision))
		}
		if err != nil {
			return nil, fmt.Errorf("postgres: read collection revision %s/%d: %w", pin.CollectionID, pin.Revision, err)
		}
		entries, derr := DecodeAPMCollectionEntries([]byte(entriesText))
		if derr != nil {
			return nil, derr
		}
		rev := apm.CollectionRevision{CollectionID: pin.CollectionID, Slug: slug, Revision: pin.Revision}
		for _, e := range entries {
			rev.Entries = append(rev.Entries, apm.CollectionEntry{Ref: e.Ref, Skills: e.Skills})
		}
		out = append(out, rev)
	}
	return out, nil
}

// checkProfileAPMCollections validates a profile write's attachment list against
// the database, which is the only place the two rules it must satisfy are
// knowable: the collection exists in the CALLER's organization, and the revision
// it names is PUBLISHED.
//
// Published-only is ADR-0084's security statement in one line. A draft is
// somebody's unfinished edit; attaching one would stage unreviewed content in
// front of an agent behind a digest nobody read — which is precisely the failure
// the whole lock flow exists to make impossible. Because a published revision
// never moves, a restore of an old profile version re-runs this check and gets
// the same answer it did when that version was written — or a refusal, which is
// the correct answer for a snapshot that names a revision this organization's
// library no longer publishes.
func checkProfileAPMCollections(ctx context.Context, q prjQuerier, orgID string, pins []APMCollectionPin) error {
	if _, err := ValidateAPMCollectionPins(pins); err != nil {
		return err
	}
	for _, pin := range pins {
		var status string
		err := q.QueryRow(ctx, `
			SELECT r.status
			FROM apm_collection_revisions r
			JOIN apm_collections col ON col.id = r.collection_id
			WHERE r.collection_id = $1::uuid AND r.revision = $2 AND col.organization_id = $3::uuid`,
			pin.CollectionID, pin.Revision, orgID).Scan(&status)
		if errors.Is(err, pgx.ErrNoRows) {
			return collectionRefused(CollectionCodeRevisionInvalid,
				fmt.Sprintf("collection %s has no revision %d in your organization (a collection in another organization is not attachable).",
					pin.CollectionID, pin.Revision))
		}
		if err != nil {
			return fmt.Errorf("postgres: check collection attachment %s/%d: %w", pin.CollectionID, pin.Revision, err)
		}
		if status != collectionStatusPublished {
			return collectionRefused(CollectionCodeRevisionInvalid,
				fmt.Sprintf("collection %s revision %d is a draft: publish it before attaching it to a profile (ADR-0084).",
					pin.CollectionID, pin.Revision))
		}
	}
	return nil
}

// EqualAPMCollectionPins is the comparison the digest-clearing rule needs: the
// attachment LIST including its order, since reordering the same two collections
// changes which package owns a duplicated skill and therefore changes the lock.
func EqualAPMCollectionPins(a, b []APMCollectionPin) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// --- api adapter -------------------------------------------------------

// APIAPMCollectionStore exposes the collection SQL as api.APMCollectionStore. It
// is pool-only (the two migration-00033 tables are new and nothing outside this
// file touches them), with the caller conversion the other adapters share.
type APIAPMCollectionStore struct {
	S *APMCollectionStore
}

var _ api.APMCollectionStore = APIAPMCollectionStore{}

func (a APIAPMCollectionStore) ListAPMCollections(ctx context.Context, c api.Caller) ([]api.APMCollectionView, error) {
	if a.S == nil {
		return nil, errors.New("postgres: APIAPMCollectionStore has no store")
	}
	out, err := a.S.ListAPMCollections(ctx, callerFromAPI(c))
	return out, apmCollectionAPIErr(err)
}

func (a APIAPMCollectionStore) GetAPMCollection(ctx context.Context, c api.Caller, collectionID string) (api.APMCollectionDetailView, error) {
	if a.S == nil {
		return api.APMCollectionDetailView{}, errors.New("postgres: APIAPMCollectionStore has no store")
	}
	out, err := a.S.GetAPMCollection(ctx, callerFromAPI(c), collectionID)
	return out, apmCollectionAPIErr(err)
}

func (a APIAPMCollectionStore) CreateAPMCollection(ctx context.Context, c api.Caller, in api.APMCollectionCreateInput) (api.APMCollectionView, error) {
	if a.S == nil {
		return api.APMCollectionView{}, errors.New("postgres: APIAPMCollectionStore has no store")
	}
	out, err := a.S.CreateAPMCollection(ctx, callerFromAPI(c), in.Slug, in.Name, in.Description, collectionEntriesFromAPI(in.Entries))
	return out, apmCollectionAPIErr(err)
}

func (a APIAPMCollectionStore) CreateAPMCollectionRevision(ctx context.Context, c api.Caller, collectionID string, in api.APMCollectionRevisionInput) (api.APMCollectionRevisionView, error) {
	if a.S == nil {
		return api.APMCollectionRevisionView{}, errors.New("postgres: APIAPMCollectionStore has no store")
	}
	out, err := a.S.CreateAPMCollectionRevision(ctx, callerFromAPI(c), collectionID, collectionEntriesFromAPI(in.Entries))
	return out, apmCollectionAPIErr(err)
}

func (a APIAPMCollectionStore) PublishAPMCollectionRevision(ctx context.Context, c api.Caller, collectionID string, revision int) (api.APMCollectionRevisionView, error) {
	if a.S == nil {
		return api.APMCollectionRevisionView{}, errors.New("postgres: APIAPMCollectionStore has no store")
	}
	out, err := a.S.PublishAPMCollectionRevision(ctx, callerFromAPI(c), collectionID, revision)
	return out, apmCollectionAPIErr(err)
}

func (a APIAPMCollectionStore) RecordDenied(ctx context.Context, c api.Caller, collectionID, action string) error {
	pool, err := m4Pool(a.S.Pool, "APIAPMCollectionStore")
	if err != nil {
		return err
	}
	return m4Denied(ctx, pool, c, collectionID, action)
}

// collectionEntriesFromAPI converts the api's entry list to the stored shape. The
// two are structurally identical on purpose: the store revalidates every ref, so
// a caller that reached the store without passing through the handler is still
// refused.
func collectionEntriesFromAPI(in []api.APMCollectionEntry) []APMCollectionEntry {
	out := make([]APMCollectionEntry, 0, len(in))
	for _, e := range in {
		out = append(out, APMCollectionEntry{Ref: e.Ref, Skills: e.Skills, Note: e.Note})
	}
	return out
}

// CollectionPinsFromAPI converts the profile write body's attachment list.
func CollectionPinsFromAPI(in []api.APMCollectionPin) []APMCollectionPin {
	out := make([]APMCollectionPin, 0, len(in))
	for _, p := range in {
		out = append(out, APMCollectionPin{CollectionID: p.CollectionID, Revision: p.Revision})
	}
	return out
}

// CollectionPinViews converts a stored attachment list for the API view.
func CollectionPinViews(pins []APMCollectionPin) []api.APMCollectionPin {
	out := make([]api.APMCollectionPin, 0, len(pins))
	for _, p := range pins {
		out = append(out, api.APMCollectionPin{CollectionID: p.CollectionID, Revision: p.Revision})
	}
	return out
}

// apmCollectionAPIErr translates the collection store's errors onto the api
// sentinels the handler maps. A coded refusal keeps its code: it is the part of
// the answer a client switches on.
func apmCollectionAPIErr(err error) error {
	if err == nil {
		return nil
	}
	var problem *APMCollectionProblem
	if errors.As(err, &problem) {
		return &api.APMCollectionProblemError{Code: problem.Code, Detail: problem.Detail}
	}
	switch {
	case errors.Is(err, ErrCollectionNotFound):
		return fmt.Errorf("%w: %w", api.ErrAPMCollectionNotFound, err)
	case errors.Is(err, ErrCollectionForbidden):
		return fmt.Errorf("%w: %w", api.ErrAPMCollectionForbidden, err)
	case errors.Is(err, ErrCollectionConflict):
		return fmt.Errorf("%w: %w", api.ErrAPMCollectionConflict, err)
	case errors.Is(err, ErrCollectionPublished):
		return fmt.Errorf("%w: %w", api.ErrAPMCollectionRevisionImmutable, err)
	case errors.Is(err, ErrCollectionValidation):
		return fmt.Errorf("%w: %w", api.ErrAPMCollectionValidation, err)
	default:
		return err
	}
}

// collectionPinPayloads converts an attachment list for a journal payload. The
// events package owns its own shape (internal/domain and the journal carry no
// store types), and the ORDER survives the conversion because the order is the
// half of the record a reader cannot re-derive.
func collectionPinPayloads(pins []APMCollectionPin) []events.APMCollectionPinPayload {
	if len(pins) == 0 {
		return nil
	}
	out := make([]events.APMCollectionPinPayload, 0, len(pins))
	for _, p := range pins {
		out = append(out, events.APMCollectionPinPayload{CollectionID: p.CollectionID, Revision: p.Revision})
	}
	return out
}
