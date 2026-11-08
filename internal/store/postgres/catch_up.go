package postgres

// The catch-up tables (ADR-0078): what the agents did, the story told about
// it, and who has read that story.
//
// Five arms live here, and the rule that ties them together is the split
// between shared and personal:
//
//   - the WORK ITEM and its TOUR belong to the project. One tour per item,
//     rewritten as versions, read by everybody in that project in the same
//     order — so ranking is never a per-user argument and a beat is written
//     once. AppendTourVersion is the write the assistant makes, and the
//     database is the arbiter of the version number: the insert admits a row
//     only while `version - 1` is still the newest, so two appends that raced
//     produce 4 and 5 rather than 4 and 4 (the loser retries and recomputes).
//   - SEEN state belongs to the reader, and is keyed on (user, work item,
//     stop id) with the version RECORDED, not in the key. A beat that was read
//     in version 3 stays read when version 4 carries it; a beat new in version
//     4 is unseen; the item as a whole badges UPDATED because this reader has a
//     seen row at an older version. That is the whole of "come back, see what
//     moved".
//   - every read is a project read. `visible` below is the same membership rule
//     internal/api's project routes use (ADR-0014 § 3, and the shape
//     assistant_notes.go uses): organization match AND (org admin OR
//     membership). A work item in a project the caller is not in is the same
//     answer as no work item at all — ErrCatchUpNotFound, never "forbidden".
//   - the tour document is MODEL OUTPUT. It is validated on the way in and
//     rendered as text on the way out; nothing here interprets a narrative, and
//     a stop's `decision` is a question stored as text, not a gate that could
//     advance a run (ADR-0078 § Decision 4).
//   - a decision reply is stored verbatim, with the conversation id copied from
//     the work item at write time. Delivery is a later task's HTTP route.
//
// A work item with no tour version is not presentable and so appears in no
// unseen list: there is no story to have read or not read yet (ADR-0078 §
// Decision 2).

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/dbirks/communication/internal/api"
	"github.com/dbirks/communication/internal/domain"
)

// CatchUpStore owns the catchup_* tables and projects.color.
type CatchUpStore struct {
	Pool *pgxpool.Pool
	// Log is where a caller may put the failures it wants recorded; every
	// method returns its errors, so nothing here logs on its own.
	Log *slog.Logger
}

// catchUpAppendAttempts bounds the version race in AppendTourVersion. Five
// would mean five appends to one item landing in the same instant; the loop
// returns the last real error rather than spinning, so an overload surfaces
// instead of hiding (ADR-0063).
const catchUpAppendAttempts = 5

// catchUpRecentVisitsMax bounds the visit read the way every other list read in
// this store is bounded.
const catchUpRecentVisitsMax = 50

func (s *CatchUpStore) pool() (*pgxpool.Pool, error) {
	if s == nil || s.Pool == nil {
		return nil, errors.New("postgres: catch-up store has no pool")
	}
	return s.Pool, nil
}

// --- shared SQL -------------------------------------------------------------

// catchUpVisibleHead is the membership rule's common body: the caller's own
// organization, and org admin or membership. $1 caller, $2 organization,
// $3 org admin. It is left OPEN (no closing parenthesis) because each query
// below adds its own project predicate and closes it.
const catchUpVisibleHead = `
	visible AS (
		SELECT p.id
		FROM projects p
		LEFT JOIN memberships m ON m.project_id = p.id AND m.user_id = $1::uuid
		WHERE p.organization_id = $2::uuid
		  AND ($3::boolean OR m.user_id IS NOT NULL)`

// catchUpVisibleOne is the rule for ONE project named directly ($4 is the
// project id). Used by the writes that carry a project in their input, so the
// project a write names is the project the caller must belong to — not merely
// "some project they belong to".
const catchUpVisibleOne = catchUpVisibleHead + `
		  AND p.id = $4::uuid
	)`

// catchUpVisibleItem is the same rule when the caller named a WORK ITEM instead
// of a project ($4 is the item id): the item's own project is the one the caller
// must belong to. Resolving it in the query rather than in Go means a read never
// sees an item whose project it has to go and check separately.
const catchUpVisibleItem = catchUpVisibleHead + `
		  AND p.id = (SELECT w.project_id FROM catchup_work_items w WHERE w.id = $4::uuid)
	)`

// catchUpVisibleSome is the same rule at list scale: $4 is the requested set,
// NULL meaning "every project I can see" and an empty array meaning "none". The
// distinction is the caller's and is preserved rather than guessed at.
const catchUpVisibleSome = catchUpVisibleHead + `
		  AND ($4::uuid[] IS NULL OR p.id = ANY ($4::uuid[]))
	)`

// catchUpStopsSeen is the unseen half of the list read, factored out so the
// unseen count and the `updated` badge cannot come from different rules. It
// expects an `items` CTE and the caller in $1: for each item, the stops of its
// LATEST version, each with the version that introduced it (a stop that names
// none is treated as new in the latest), and the count of those this reader has
// not viewed — "viewed" being a seen row whose recorded tour_version is at
// least that introduction.
const catchUpStopsSeen = `
	latest AS (
		SELECT DISTINCT ON (tv.work_item_id)
		       tv.work_item_id, tv.version, tv.stops, tv.created_at
		FROM catchup_tour_versions tv
		JOIN items i ON i.id = tv.work_item_id
		ORDER BY tv.work_item_id, tv.version DESC
	),
	stops AS (
		SELECT l.work_item_id,
		       (e.value ->> 'id') AS stop_id,
		       COALESCE(NULLIF (e.value ->> 'added_in_version', '')::integer,
		                l.version) AS added_in
		FROM latest l
		CROSS JOIN jsonb_array_elements (l.stops) AS e
	),
	seen_one AS (
		SELECT s.work_item_id, s.stop_id, s.added_in,
		       (SELECT max (sn.tour_version) FROM catchup_seen_stops sn
		        WHERE sn.user_id = $1::uuid
		                  AND sn.work_item_id = s.work_item_id
		                  AND sn.stop_id = s.stop_id) AS seen_version
		FROM stops s
	),
	unseen AS (
		SELECT work_item_id,
		       count(*) FILTER (WHERE seen_version IS NULL
		                        OR seen_version < added_in)::integer AS unseen_stops
		FROM seen_one
		GROUP BY work_item_id
	)`

// catchUpWorkItemColumns is the read projection shared by every work-item read,
// so all three decode the same thing.
const catchUpWorkItemColumns = `w.id::text, w.project_id::text, w.shape, w.title, w.summary,
	       w.resolution, w.refs, w.source_run_id::text, w.conversation_id::text,
	       w.created_at, w.updated_at`

// --- work items -------------------------------------------------------------

// UpsertWorkItem writes (or revises) one work item in a SINGLE statement whose
// own WHERE carries the membership guard — the ADR-0071 pattern: a row is never
// written into a project the caller may not see, rather than cleaned up
// afterwards. Two identity paths:
//
//   - an explicit id updates that work item: the assistant re-describing work it
//     already reported. An id that names nothing is NOT a create — the caller
//     asked to revise a specific thing, and inventing one would be a lie;
//   - with no id, the (project, source_run_id) partial unique index is the
//     conflict target, so re-grouping the same run updates its item instead of
//     writing a duplicate, and an item with no run is simply new.
//
// Provenance never moves once written: source_run_id and conversation_id are
// COALESCEd, because "which run made this, in which thread" is a fact rather
// than a field to revise.
func (s *CatchUpStore) UpsertWorkItem(ctx context.Context, c Caller,
	in domain.CatchUpWorkItem) (domain.CatchUpWorkItem, error) {
	pool, err := s.pool()
	if err != nil {
		return domain.CatchUpWorkItem{}, err
	}
	if err := in.Validate(); err != nil {
		return domain.CatchUpWorkItem{}, err
	}
	in.Title, in.Summary = strings.TrimSpace(in.Title), strings.TrimSpace(in.Summary)
	refs, err := json.Marshal(in.Refs)
	if err != nil {
		return domain.CatchUpWorkItem{}, fmt.Errorf("postgres: encode catchup refs: %w", err)
	}
	const q = `
	WITH ` + catchUpVisibleOne + `,
	upd AS (
		UPDATE catchup_work_items AS w
		SET shape = $5, title = $6, summary = $7, resolution = $8, refs = $9::jsonb,
		    source_run_id = COALESCE (w.source_run_id, $10::uuid),
		    conversation_id = COALESCE (w.conversation_id, $11::uuid),
		    updated_at = now()
		FROM visible v
		WHERE w.id = $12::uuid AND w.project_id = v.id
		RETURNING w.id::text AS id, w.updated_at AS moved_at
	),
	ins AS (
		INSERT INTO catchup_work_items
		    (project_id, shape, title, summary, resolution, refs, source_run_id, conversation_id)
		SELECT $4::uuid, $5, $6, $7, $8, $9::jsonb, $10::uuid, $11::uuid
		WHERE $12::uuid IS NULL
		  AND EXISTS (SELECT 1 FROM visible)
		ON CONFLICT (project_id, source_run_id) WHERE source_run_id IS NOT NULL
		DO UPDATE SET shape = EXCLUDED.shape, title = EXCLUDED.title,
		              summary = EXCLUDED.summary, resolution = EXCLUDED.resolution,
		              refs = EXCLUDED.refs,
		              conversation_id = COALESCE (catchup_work_items.conversation_id,
		                                          EXCLUDED.conversation_id),
		              updated_at = now()
		RETURNING id::text AS id, updated_at AS moved_at
	)
	SELECT id, moved_at FROM upd
	UNION ALL
	SELECT id, moved_at FROM ins`
	var (
		id        string
		updatedAt time.Time
	)
	err = pool.QueryRow(ctx, q, c.UserID, c.OrganizationID, c.IsOrgAdmin, in.ProjectID,
		string(in.Shape), in.Title, in.Summary, string(in.Resolution), refs,
		catchUpOptUUID(in.SourceRunID), catchUpOptUUID(in.ConversationID),
		catchUpOptID(in.ID)).Scan(&id, &updatedAt)
	if err != nil {
		return domain.CatchUpWorkItem{}, catchUpQueryErr(err, "upsert catchup work item")
	}
	// created_at is the row's own, older than this write on the update path, so
	// it is read back rather than echoed: a caller that wants the full item uses
	// GetWorkItem, and one that wanted the write confirmed gets the id and the
	// clock that moved.
	in.ID, in.UpdatedAt, in.CreatedAt = id, updatedAt, time.Time{}
	return in, nil
}

// catchUpGetSQL reads one item plus the headers of every tour version it has
// ever had, newest-last in one jsonb array. The headers are what let the surface
// say "this story was rewritten twice, here is why each time" without shipping
// four copies of the stops.
const catchUpGetSQL = `
	WITH ` + catchUpVisibleItem + `
	SELECT ` + catchUpWorkItemColumns + `,
	       COALESCE (h.history, '[]'::jsonb)
	FROM catchup_work_items w
	JOIN visible v ON v.id = w.project_id
	LEFT JOIN LATERAL (
		SELECT jsonb_agg (jsonb_build_object (
		           'version', tv.version,
		           'reason', tv.reason,
		           'stop_count', jsonb_array_length (tv.stops),
		           'created_at', tv.created_at)
		       ORDER BY tv.version) AS history
		FROM catchup_tour_versions tv
		WHERE tv.work_item_id = w.id
	) AS h ON TRUE
	WHERE w.id = $4::uuid`

// GetWorkItem reads one work item with its latest tour version and the headers
// of all of them. A stranger and a gone item are one answer.
func (s *CatchUpStore) GetWorkItem(ctx context.Context, c Caller,
	workItemID string) (domain.CatchUpWorkItemView, error) {
	pool, err := s.pool()
	if err != nil {
		return domain.CatchUpWorkItemView{}, err
	}
	var (
		view    domain.CatchUpWorkItemView
		refs    []byte
		history []byte
	)
	err = pool.QueryRow(ctx, catchUpGetSQL, c.UserID, c.OrganizationID, c.IsOrgAdmin,
		workItemID).Scan(&view.ID, &view.ProjectID, &view.Shape, &view.Title, &view.Summary,
		&view.Resolution, &refs, &view.SourceRunID, &view.ConversationID,
		&view.CreatedAt, &view.UpdatedAt, &history)
	if err != nil {
		return domain.CatchUpWorkItemView{}, catchUpQueryErr(err, "read catchup work item")
	}
	if err := json.Unmarshal(refs, &view.Refs); err != nil {
		return domain.CatchUpWorkItemView{}, fmt.Errorf("postgres: catchup refs: %w", err)
	}
	if err := json.Unmarshal(history, &view.History); err != nil {
		return domain.CatchUpWorkItemView{}, fmt.Errorf("postgres: catchup tour history: %w", err)
	}
	if len(view.History) > 0 {
		view.LatestVersion = view.History[len(view.History)-1].Version
	}
	latest, err := s.latestTour(ctx, pool, workItemID)
	if errors.Is(err, domain.ErrCatchUpNotFound) {
		// An item whose tour has not been written yet: it exists, and it has no
		// story to read. GetWorkItem says so; the unseen list omits it.
		view.LatestVersion = 0
		return view, nil
	}
	if err != nil {
		return domain.CatchUpWorkItemView{}, err
	}
	view.Latest = latest
	return view, nil
}

// catchUpLatestTourSQL reads one item's newest tour version.
const catchUpLatestTourSQL = `
	SELECT tv.version, tv.reason, tv.stops, tv.created_at
	FROM catchup_tour_versions tv
	WHERE tv.work_item_id = $1::uuid
	ORDER BY tv.version DESC
	LIMIT 1`

func (s *CatchUpStore) latestTour(ctx context.Context, pool *pgxpool.Pool,
	workItemID string) (*domain.CatchUpTourVersion, error) {
	var (
		v     domain.CatchUpTourVersion
		stops []byte
	)
	err := pool.QueryRow(ctx, catchUpLatestTourSQL, workItemID).
		Scan(&v.Version, &v.Reason, &stops, &v.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, domain.ErrCatchUpNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("postgres: read catchup tour: %w", err)
	}
	v.WorkItemID = workItemID
	if v.Stops, err = decodeCatchUpStops(stops); err != nil {
		return nil, err
	}
	return &v, nil
}

// --- tours ------------------------------------------------------------------

// catchUpHeadSQL answers, in one read: may this caller see this work item, and
// what is its newest tour version. "No such item" and "not your project" are
// the same false by design.
const catchUpHeadSQL = `
	WITH ` + catchUpVisibleItem + `
	SELECT (SELECT count(*) FROM visible)::integer > 0 AS visible,
	       COALESCE ((SELECT max (tv.version) FROM catchup_tour_versions tv
	                 WHERE tv.work_item_id = $4::uuid), 0)::integer AS head`

// catchUpAppendSQL inserts one tour version. The `guard` CTE is the whole
// atomicity argument: the insert happens only while `version - 1` is still the
// newest AND the caller sees the item's project, all read in the same statement
// that writes, so a concurrent append costs this writer zero rows rather than a
// wrong version number. `bump` moves the item's updated_at in the same
// statement, because a rewritten story IS the work having moved — and it is what
// the "since T" filter then finds.
const catchUpAppendSQL = `
	WITH ` + catchUpVisibleItem + `,
	guard AS (
		SELECT 1 AS ok
		FROM visible v
		JOIN catchup_work_items w ON w.id = $4::uuid AND w.project_id = v.id
		WHERE COALESCE ((SELECT max (tv.version) FROM catchup_tour_versions tv
		                 WHERE tv.work_item_id = $4::uuid), 0) = $5::int - 1
	),
	bump AS (
		UPDATE catchup_work_items AS w
		SET updated_at = now()
		FROM guard
		WHERE w.id = $4::uuid AND guard.ok IS NOT NULL
		RETURNING 1
	),
	ins AS (
		INSERT INTO catchup_tour_versions (work_item_id, version, reason, stops)
		SELECT $4::uuid, $5::int, $6, $7::jsonb
		WHERE EXISTS (SELECT 1 FROM bump)
		RETURNING created_at
	)
	SELECT ins.created_at FROM ins`

// AppendTourVersion appends the next version of a work item's tour, atomically:
// the version is `previous + 1` with no gap and no tie, `reason` is what the
// assistant says changed ("Fix landed, stop 3 added"), and every stop that does
// not declare its own origin is stamped as new in this version.
//
// The race is resolved by the database rather than by a lock: the insert admits
// its row only while the version it claims is still the next one, so a loser
// writes nothing and retries with a recomputed number. A caller that never wins
// inside catchUpAppendAttempts gets the last real error, not a silent skip.
func (s *CatchUpStore) AppendTourVersion(ctx context.Context, c Caller, workItemID, reason string,
	stops []domain.CatchUpStop) (domain.CatchUpTourVersion, error) {
	pool, err := s.pool()
	if err != nil {
		return domain.CatchUpTourVersion{}, err
	}
	reason = strings.TrimSpace(reason)
	if reason == "" || len(reason) > domain.CatchUpReasonMaxChars {
		return domain.CatchUpTourVersion{}, fmt.Errorf(
			"%w: catchup tour reason must be 1..%d characters",
			domain.ErrCatchUpValidation, domain.CatchUpReasonMaxChars)
	}
	var lastErr error
	for attempt := 0; attempt < catchUpAppendAttempts; attempt++ {
		visible, head, err := s.tourHead(ctx, pool, c, workItemID)
		if err != nil {
			return domain.CatchUpTourVersion{}, err
		}
		if !visible {
			return domain.CatchUpTourVersion{}, domain.ErrCatchUpNotFound
		}
		version := head + 1
		// Stamp a copy: a stop that declares its own origin keeps it, and the
		// caller's slice is not ours to rewrite.
		given := append([]domain.CatchUpStop(nil), stops...)
		domain.StampCatchUpStops(given, version)
		v := domain.CatchUpTourVersion{WorkItemID: workItemID, Version: version,
			Reason: reason, Stops: given}
		if err := v.Validate(); err != nil {
			return domain.CatchUpTourVersion{}, err
		}
		encoded, err := json.Marshal(given)
		if err != nil {
			return domain.CatchUpTourVersion{},
				fmt.Errorf("postgres: encode catchup stops: %w", err)
		}
		var createdAt time.Time
		err = pool.QueryRow(ctx, catchUpAppendSQL, c.UserID, c.OrganizationID, c.IsOrgAdmin,
			workItemID, version, reason, encoded).Scan(&createdAt)
		if err == nil {
			v.CreatedAt = createdAt
			return v, nil
		}
		// Either the head moved under us (no rows) or someone else won the exact
		// version number (23505): both mean "recompute and try again". Anything
		// else is a real failure and is returned wrapped, immediately.
		if !errors.Is(err, pgx.ErrNoRows) && !m4UniqueViolation(err) {
			return domain.CatchUpTourVersion{},
				fmt.Errorf("postgres: append catchup tour version: %w", err)
		}
		lastErr = err
	}
	return domain.CatchUpTourVersion{}, fmt.Errorf(
		"postgres: append catchup tour version lost every race in %d attempts: %w",
		catchUpAppendAttempts, lastErr)
}

// tourHead answers "may this caller see this work item, and what is its newest
// tour version".
func (s *CatchUpStore) tourHead(ctx context.Context, pool *pgxpool.Pool,
	c Caller, workItemID string) (visible bool, head int, err error) {
	err = pool.QueryRow(ctx, catchUpHeadSQL, c.UserID, c.OrganizationID, c.IsOrgAdmin,
		workItemID).Scan(&visible, &head)
	if err != nil {
		return false, 0, catchUpQueryErr(err, "read catchup tour head")
	}
	return visible, head, nil
}

// --- unseen and seen --------------------------------------------------------

// catchUpUnseenSQL is the list read: work items in projects the caller is in,
// whose newest tour version still has stops this caller has not viewed. `since`
// filters on the item's own updated_at (the work having moved), NULL is no
// lower bound, and includeSeen=false is what the page asks for.
//
// The ordering is the tour's own time, newest story first: what the reader
// missed most recently is what they will still remember doing.
const catchUpUnseenSQL = `
	WITH ` + catchUpVisibleSome + `,
	items AS (
		SELECT w.*
		FROM catchup_work_items w
		JOIN visible v ON v.id = w.project_id
		WHERE ($5::timestamptz IS NULL OR w.updated_at >= $5::timestamptz)
	),` + catchUpStopsSeen + `
	SELECT i.id::text, i.project_id::text, i.shape, i.title, i.summary,
	       i.resolution, i.refs, i.source_run_id::text, i.conversation_id::text,
	       i.created_at, i.updated_at,
	       l.version,
	       COALESCE (u.unseen_stops, 0)::integer AS unseen_stops,
	       EXISTS (
		           SELECT 1 FROM catchup_seen_stops sn
		           WHERE sn.user_id = $1::uuid
		                     AND sn.work_item_id = i.id
		                     AND sn.tour_version < l.version
		       ) AS updated
	FROM items i
	JOIN latest l ON l.work_item_id = i.id
	LEFT JOIN unseen u ON u.work_item_id = i.id
	WHERE $6::boolean OR COALESCE (u.unseen_stops, 0) > 0
	ORDER BY l.created_at DESC, i.id DESC`

// ListUnseenWorkItems answers "what has this person not read?". An empty
// projectIDs means every project the caller belongs to; a non-empty one is
// INTERSECTED with that, so a caller cannot widen the set by naming a project it
// is not in. `Updated` is true when the reader saw an older version;
// UnseenStops counts only the stops of the LATEST version that are new to them,
// which is what makes a rewritten tour come back as UPDATED rather than as
// something to read from the top.
func (s *CatchUpStore) ListUnseenWorkItems(ctx context.Context, c Caller, projectIDs []string,
	since *time.Time, includeSeen bool) ([]domain.CatchUpListItem, error) {
	pool, err := s.pool()
	if err != nil {
		return nil, err
	}
	var wanted any
	if len(projectIDs) > 0 {
		wanted = projectIDs
	}
	rows, err := pool.Query(ctx, catchUpUnseenSQL, c.UserID, c.OrganizationID, c.IsOrgAdmin,
		wanted, since, includeSeen)
	if err != nil {
		return nil, catchUpQueryErr(err, "list catchup work items")
	}
	defer rows.Close()
	out := []domain.CatchUpListItem{}
	for rows.Next() {
		var (
			item domain.CatchUpListItem
			refs []byte
		)
		if err := rows.Scan(&item.ID, &item.ProjectID, &item.Shape, &item.Title, &item.Summary,
			&item.Resolution, &refs, &item.SourceRunID, &item.ConversationID,
			&item.CreatedAt, &item.UpdatedAt, &item.LatestVersion,
			&item.UnseenStops, &item.Updated); err != nil {
			return nil, catchUpQueryErr(err, "scan catchup work item")
		}
		if err := json.Unmarshal(refs, &item.Refs); err != nil {
			return nil, fmt.Errorf("postgres: catchup refs: %w", err)
		}
		out = append(out, item)
	}
	if err := rows.Err(); err != nil {
		return nil, catchUpQueryErr(err, "list catchup work items")
	}
	return out, nil
}

// catchUpMarkSeenSQL marks stops seen. Reading the ids out of the NAMED tour
// version, rather than trusting the caller's list, is what makes a stop id that
// does not exist in that version cost nothing instead of corrupting the ledger —
// and the same statement carries the membership check. The recorded version only
// ever moves forward and seen_at follows, so re-marking a seen beat is a refresh
// and never a demotion.
const catchUpMarkSeenSQL = `
	WITH ` + catchUpVisibleItem + `,
	src AS (
		SELECT tv.work_item_id, tv.version, (e.value ->> 'id') AS stop_id
		FROM catchup_tour_versions tv
		JOIN catchup_work_items w ON w.id = tv.work_item_id
		JOIN visible v ON v.id = w.project_id
		CROSS JOIN jsonb_array_elements (tv.stops) AS e
		WHERE tv.work_item_id = $4::uuid
		  AND tv.version = $5::int
		  AND (e.value ->> 'id') = ANY ($6::text[])
	),
	ins AS (
		INSERT INTO catchup_seen_stops (user_id, work_item_id, stop_id, tour_version)
		SELECT $1::uuid, src.work_item_id, src.stop_id, src.version FROM src
		ON CONFLICT (user_id, work_item_id, stop_id) DO UPDATE
			SET tour_version = GREATEST (catchup_seen_stops.tour_version,
			                             EXCLUDED.tour_version),
			    seen_at = now()
		RETURNING 1
	)
	SELECT count(*)::integer FROM ins`

// MarkStopsSeen records that this caller viewed these stops of this tour
// version, idempotently. It reports how many it marked, so a caller that named a
// version or a stop id that does not exist learns that nothing happened
// (ErrCatchUpNotFound) rather than believing itself caught up.
func (s *CatchUpStore) MarkStopsSeen(ctx context.Context, c Caller, workItemID string,
	version int, stopIDs []string) (int, error) {
	pool, err := s.pool()
	if err != nil {
		return 0, err
	}
	if version < 1 || len(stopIDs) == 0 {
		return 0, fmt.Errorf("%w: catchup marking needs a tour version and stop ids",
			domain.ErrCatchUpValidation)
	}
	var marked int
	err = pool.QueryRow(ctx, catchUpMarkSeenSQL, c.UserID, c.OrganizationID, c.IsOrgAdmin,
		workItemID, version, stopIDs).Scan(&marked)
	if err != nil {
		return 0, catchUpQueryErr(err, "mark catchup stops seen")
	}
	if marked == 0 {
		return 0, domain.ErrCatchUpNotFound
	}
	return marked, nil
}

// catchUpMarkAllSQL is the same rule at page scale: every stop of the newest
// version of every work item in the caller's projects. It shares the
// GREATEST-merge semantics with catchUpMarkSeenSQL, which is the point: "mark
// all seen" must not resurrect a beat a reader had already seen in an older
// version.
const catchUpMarkAllSQL = `
	WITH ` + catchUpVisibleSome + `,
	items AS (
		SELECT w.id
		FROM catchup_work_items w
		JOIN visible v ON v.id = w.project_id
	),
	latest AS (
		SELECT DISTINCT ON (tv.work_item_id) tv.work_item_id, tv.version, tv.stops
		FROM catchup_tour_versions tv
		JOIN items i ON i.id = tv.work_item_id
		ORDER BY tv.work_item_id, tv.version DESC
	),
	src AS (
		SELECT l.work_item_id, l.version, (e.value ->> 'id') AS stop_id
		FROM latest l
		CROSS JOIN jsonb_array_elements (l.stops) AS e
	),
	ins AS (
		INSERT INTO catchup_seen_stops (user_id, work_item_id, stop_id, tour_version)
		SELECT $1::uuid, src.work_item_id, src.stop_id, src.version FROM src
		ON CONFLICT (user_id, work_item_id, stop_id) DO UPDATE
			SET tour_version = GREATEST (catchup_seen_stops.tour_version,
			                             EXCLUDED.tour_version),
			    seen_at = now()
		RETURNING 1
	)
	SELECT count(*)::integer FROM ins`

// MarkAllSeen catches this caller up on everything in these projects (empty
// means every project they belong to) and reports how many stops it marked.
func (s *CatchUpStore) MarkAllSeen(ctx context.Context, c Caller, projectIDs []string) (int, error) {
	pool, err := s.pool()
	if err != nil {
		return 0, err
	}
	var wanted any
	if len(projectIDs) > 0 {
		wanted = projectIDs
	}
	var marked int
	err = pool.QueryRow(ctx, catchUpMarkAllSQL, c.UserID, c.OrganizationID, c.IsOrgAdmin,
		wanted).Scan(&marked)
	if err != nil {
		return 0, catchUpQueryErr(err, "mark all catchup stops seen")
	}
	return marked, nil
}

// catchUpSeenBySQL is the roster: readers still membered in the item's project
// with no outstanding stop in its newest version. A candidate is anybody who has
// marked something on the item — the roster is "who finished this", not a
// headcount of the project.
const catchUpSeenBySQL = `
	WITH ` + catchUpVisibleItem + `,
	latest AS (
		SELECT DISTINCT ON (tv.work_item_id) tv.work_item_id, tv.version, tv.stops
		FROM catchup_tour_versions tv
		JOIN catchup_work_items w ON w.id = tv.work_item_id
		JOIN visible v ON v.id = w.project_id
		WHERE tv.work_item_id = $4::uuid
		ORDER BY tv.work_item_id, tv.version DESC
	),
	stops AS (
		SELECT l.work_item_id,
		       (e.value ->> 'id') AS stop_id,
		       COALESCE(NULLIF (e.value ->> 'added_in_version', '')::integer,
		                l.version) AS added_in
		FROM latest l
		CROSS JOIN jsonb_array_elements (l.stops) AS e
	),
	cands AS (
		SELECT DISTINCT sn.user_id
		FROM catchup_seen_stops sn
		WHERE sn.work_item_id = $4::uuid
	)
	SELECT c.user_id::text, u.display_name,
	       (SELECT max (sn.seen_at) FROM catchup_seen_stops sn
		        WHERE sn.user_id = c.user_id AND sn.work_item_id = $4::uuid) AS seen_at
	FROM cands c
	JOIN users u ON u.id = c.user_id
	JOIN catchup_work_items w ON w.id = $4::uuid
	JOIN memberships m ON m.project_id = w.project_id AND m.user_id = c.user_id
	WHERE EXISTS (SELECT 1 FROM stops)
	  AND NOT EXISTS (
		      SELECT 1 FROM stops s
		      WHERE NOT EXISTS (
		          SELECT 1 FROM catchup_seen_stops sn
		          WHERE sn.user_id = c.user_id
		                    AND sn.work_item_id = s.work_item_id
		                    AND sn.stop_id = s.stop_id
		                    AND sn.tour_version >= s.added_in
		      )
		  )
	ORDER BY seen_at, c.user_id`

// SeenBy lists the project members who have read the LATEST version of this
// work item's tour — the "2 of 4 have seen this" line. A caller who cannot see
// the item cannot ask who has.
func (s *CatchUpStore) SeenBy(ctx context.Context, c Caller,
	workItemID string) ([]domain.CatchUpSeenBy, error) {
	pool, err := s.pool()
	if err != nil {
		return nil, err
	}
	// The membership check runs first, so a stranger never even learns that the
	// roster is empty: the answer is the same one a gone item gives. The
	// `visible` flag is the whole check — tourHead answers no error for "not
	// your project" precisely because it is a read of two scalars, so ignoring
	// it here would serve an empty roster as a success, and "nobody has read
	// this yet" from a stranger is exactly the sentence this roster exists to
	// keep inside the project (ADR-0078 § Security/privacy).
	visible, _, err := s.tourHead(ctx, pool, c, workItemID)
	if err != nil {
		return nil, err
	}
	if !visible {
		return nil, domain.ErrCatchUpNotFound
	}
	rows, err := pool.Query(ctx, catchUpSeenBySQL, c.UserID, c.OrganizationID, c.IsOrgAdmin,
		workItemID)
	if err != nil {
		return nil, catchUpQueryErr(err, "read catchup seen-by")
	}
	defer rows.Close()
	out := []domain.CatchUpSeenBy{}
	for rows.Next() {
		var (
			row   domain.CatchUpSeenBy
			seenA *time.Time
		)
		if err := rows.Scan(&row.UserID, &row.DisplayName, &seenA); err != nil {
			return nil, catchUpQueryErr(err, "scan catchup seen-by")
		}
		if seenA != nil {
			row.SeenAt = *seenA
		}
		out = append(out, row)
	}
	if err := rows.Err(); err != nil {
		return nil, catchUpQueryErr(err, "read catchup seen-by")
	}
	return out, nil
}

// --- recap and visits -------------------------------------------------------

const catchUpVisitSQL = `INSERT INTO catchup_visits (user_id) VALUES ($1::uuid)`

const catchUpVisitsSQL = `
	SELECT visited_at FROM catchup_visits
	WHERE user_id = $1::uuid
	ORDER BY visited_at DESC, id DESC
	LIMIT $2::int`

// RecordVisit stamps one visit to Catch up, the raw material for the window
// suggestion (a daily reader gets 24h, a weekly one gets 7d). It is the one
// write here that needs no project: a visit is a fact about a reader, not about
// a project.
func (s *CatchUpStore) RecordVisit(ctx context.Context, c Caller) error {
	pool, err := s.pool()
	if err != nil {
		return err
	}
	if _, err := pool.Exec(ctx, catchUpVisitSQL, c.UserID); err != nil {
		return catchUpQueryErr(err, "record catchup visit")
	}
	return nil
}

// RecentVisits returns this caller's visit timestamps, newest first, bounded by
// catchUpRecentVisitsMax — enough to tell a daily reader from a weekly one and
// no more than the page would ever draw.
func (s *CatchUpStore) RecentVisits(ctx context.Context,
	c Caller) ([]time.Time, error) {
	pool, err := s.pool()
	if err != nil {
		return nil, err
	}
	rows, err := pool.Query(ctx, catchUpVisitsSQL, c.UserID, catchUpRecentVisitsMax)
	if err != nil {
		return nil, catchUpQueryErr(err, "read catchup visits")
	}
	defer rows.Close()
	out := []time.Time{}
	for rows.Next() {
		var at time.Time
		if err := rows.Scan(&at); err != nil {
			return nil, catchUpQueryErr(err, "scan catchup visit")
		}
		out = append(out, at)
	}
	if err := rows.Err(); err != nil {
		return nil, catchUpQueryErr(err, "read catchup visits")
	}
	return out, nil
}

const catchUpRecapInsertSQL = `
	INSERT INTO catchup_recaps (user_id, "text", "window", project_ids)
	VALUES ($1::uuid, $2, $3, COALESCE ($4::uuid[], '{}'::uuid[]))
	RETURNING id::text, written_at`

const catchUpRecapLatestSQL = `
	SELECT r.id::text, r."text", r."window", r.project_ids, r.written_at
	FROM catchup_recaps r
	WHERE r.user_id = $1::uuid
	ORDER BY r.written_at DESC, r.id DESC
	LIMIT 1`

// SaveRecap caches one generated summary for its reader. Regenerating writes a
// NEW row rather than overwriting: "what did we tell this person, and when" is
// the generator's evaluation data — the same argument ADR-0071 made for keeping
// dismissed notes.
func (s *CatchUpStore) SaveRecap(ctx context.Context, c Caller,
	in domain.CatchUpRecap) (domain.CatchUpRecap, error) {
	pool, err := s.pool()
	if err != nil {
		return domain.CatchUpRecap{}, err
	}
	in.Text, in.Window = strings.TrimSpace(in.Text), strings.TrimSpace(in.Window)
	out := in
	out.UserID = c.UserID
	if err := out.Validate(); err != nil {
		return domain.CatchUpRecap{}, err
	}
	err = pool.QueryRow(ctx, catchUpRecapInsertSQL, c.UserID, out.Text, out.Window,
		catchUpOptUUIDSlice(out.ProjectIDs)).Scan(&out.ID, &out.WrittenAt)
	if err != nil {
		return domain.CatchUpRecap{}, catchUpQueryErr(err, "save catchup recap")
	}
	return out, nil
}

// LatestRecap returns this caller's newest cached recap, or ErrCatchUpNotFound
// when they have never had one. A recap is never another user's: the reader is
// part of the read, not a filter the caller may leave out.
func (s *CatchUpStore) LatestRecap(ctx context.Context,
	c Caller) (domain.CatchUpRecap, error) {
	pool, err := s.pool()
	if err != nil {
		return domain.CatchUpRecap{}, err
	}
	var (
		out domain.CatchUpRecap
		ids []string
	)
	err = pool.QueryRow(ctx, catchUpRecapLatestSQL, c.UserID).
		Scan(&out.ID, &out.Text, &out.Window, &ids, &out.WrittenAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.CatchUpRecap{}, domain.ErrCatchUpNotFound
	}
	if err != nil {
		return domain.CatchUpRecap{}, catchUpQueryErr(err, "read catchup recap")
	}
	out.UserID, out.ProjectIDs = c.UserID, ids
	return out, nil
}

// --- decision replies -------------------------------------------------------

// catchUpDecisionReplySQL writes one reply with the stop check and the
// provenance copy in the same statement: the stop must exist in the item's
// LATEST tour version and carry a `decision` object, and the conversation id is
// taken from the work item rather than from the caller. That last part is what
// keeps a reply from being posted into a thread its author chose.
const catchUpDecisionReplySQL = `
	WITH ` + catchUpVisibleItem + `,
	src AS (
		SELECT w.id AS work_item_id, w.conversation_id,
		       (e.value ->> 'id') AS stop_id,
		       jsonb_typeof (e.value -> 'decision') AS decision_kind
		FROM catchup_work_items w
		JOIN visible v ON v.id = w.project_id
		JOIN catchup_tour_versions tv ON tv.work_item_id = w.id
		CROSS JOIN jsonb_array_elements (tv.stops) AS e
		WHERE w.id = $4::uuid
		  AND tv.version = (SELECT max (tv2.version) FROM catchup_tour_versions tv2
		                    WHERE tv2.work_item_id = w.id)
		  AND (e.value ->> 'id') = $5
	)
	INSERT INTO catchup_decision_replies
	    (work_item_id, stop_id, user_id, "text", conversation_id)
	SELECT src.work_item_id, src.stop_id, $1::uuid, $6, src.conversation_id
	FROM src
	WHERE src.decision_kind = 'object'
	RETURNING id::text, created_at, conversation_id::text`

// InsertDecisionReply stores the text a user chose on a stop that asked. It does
// NOT post it: the API task that owns the agent conversation reads
// ConversationID off the returned reply and sends the text as a plain message
// (ADR-0078 § Decision 4). A reply to a work item the caller cannot see, to a
// stop that is not in its latest tour, or to a stop that asked nothing is
// ErrCatchUpNotFound — never a partial write that looks like a sent reply.
func (s *CatchUpStore) InsertDecisionReply(ctx context.Context, c Caller, workItemID, stopID,
	text string) (domain.CatchUpDecisionReply, error) {
	pool, err := s.pool()
	if err != nil {
		return domain.CatchUpDecisionReply{}, err
	}
	in := domain.CatchUpDecisionReply{
		WorkItemID: workItemID, StopID: strings.TrimSpace(stopID),
		UserID: c.UserID, Text: strings.TrimSpace(text),
	}
	if err := in.Validate(); err != nil {
		return domain.CatchUpDecisionReply{}, err
	}
	var conversationID *string
	err = pool.QueryRow(ctx, catchUpDecisionReplySQL, c.UserID, c.OrganizationID,
		c.IsOrgAdmin, workItemID, in.StopID, in.Text).
		Scan(&in.ID, &in.CreatedAt, &conversationID)
	if err != nil {
		return domain.CatchUpDecisionReply{},
			catchUpQueryErr(err, "insert catchup decision reply")
	}
	in.ConversationID = conversationID
	return in, nil
}

// --- helpers ----------------------------------------------------------------

// catchUpOptUUID turns an absent id into NULL, so one statement can carry "no
// id given" without a second query shape.
func catchUpOptUUID(s *string) any {
	if s == nil || strings.TrimSpace(*s) == "" {
		return nil
	}
	return *s
}

// catchUpOptID is the same for an id that may be "" rather than nil.
func catchUpOptID(s string) any {
	if strings.TrimSpace(s) == "" {
		return nil
	}
	return s
}

// catchUpOptUUIDSlice turns an empty project list into an empty array rather
// than NULL: a recap that covered no projects is a real thing to record.
func catchUpOptUUIDSlice(ids []string) any {
	if len(ids) == 0 {
		return []string{}
	}
	return ids
}

// catchUpQueryErr turns the two errors a caller can act on into sentinels and
// keeps everything else wrapped for the log: a malformed uuid came from a
// client, a dead pool did not.
func catchUpQueryErr(err error, op string) error {
	switch {
	case err == nil:
		return nil
	case errors.Is(err, pgx.ErrNoRows):
		return domain.ErrCatchUpNotFound
	case strings.Contains(err.Error(), "invalid input syntax for type uuid"):
		return fmt.Errorf("%w: %s: not a uuid", domain.ErrCatchUpValidation, op)
	default:
		return fmt.Errorf("postgres: %s: %w", op, err)
	}
}

// decodeCatchUpStops reads a stored stop array back into the contract and
// refuses to serve one that is not. The only writer validated what it wrote, so
// a stop that no longer parses is corruption rather than a client mistake — and
// half a tour is worse than a failed read, because a reader would trust the
// beats that did parse.
func decodeCatchUpStops(raw []byte) ([]domain.CatchUpStop, error) {
	var stops []domain.CatchUpStop
	if err := json.Unmarshal(raw, &stops); err != nil {
		return nil, fmt.Errorf("postgres: catchup tour stops: %w", err)
	}
	if err := domain.ValidateCatchUpStops(stops, 0); err != nil {
		return nil, fmt.Errorf("postgres: catchup tour stops: %w", err)
	}
	return stops, nil
}

// --- the api surface (ADR-0078 § Migration: "mounting the routes") ------

// APICatchUpStore exposes a *CatchUpStore as internal/api's CatchUpStore. The
// conversion is where three things the six store methods do not carry get
// attached, and none of them is a re-implementation of a rule:
//
//   - the project chip. The store answers a project id, because that is the
//     authorization scope; the page draws a name and a colour, so the adapter
//     joins `projects` (name, `color`) in one bounded statement and renders a
//     NULL colour through domain.CatchUpProjectColorOr — the deterministic
//     pick by project id, which is why nothing here has to be backfilled;
//   - the shape of the story. `total_stops` and the item's top `importance` are
//     read off the SAME newest tour version the unseen count came from, in one
//     statement keyed on the ids the authorized list read returned;
//   - the per-reader view of one item: a seen flag on each beat (the store's
//     rule, `recorded tour_version >= added_in_version`, applied to this
//     caller's own rows) and `you_saw_version`, which is what lets the surface
//     badge an item UPDATED rather than NEW.
//
// Every refusal is audited here rather than in the handler: the adapter can ask
// which project a refused work item lived in, which is precisely what a 404
// that must not explain itself (ADR-0014 § 3) refuses to put on the wire.
type APICatchUpStore struct {
	S *CatchUpStore
	// Denials writes the audit row; usually the same *ProjectStore the API
	// already holds, taken as an interface so this file does not assume it.
	Denials interface {
		RecordDenied(ctx context.Context, c Caller, projectID, action string) error
	}
}

var _ api.CatchUpStore = APICatchUpStore{}

// logger is the store's own sink, so a denial this layer writes lands in the
// deployment's log rather than a discard one; a store built without one is
// normal in tests, which is why the fallback is quiet.
func (s *CatchUpStore) logger() *slog.Logger {
	if s != nil && s.Log != nil {
		return s.Log
	}
	return discardM4Log()
}

func (a APICatchUpStore) store() (*CatchUpStore, error) {
	if a.S == nil || a.S.Pool == nil {
		return nil, errors.New("postgres: APICatchUpStore has no pool")
	}
	return a.S, nil
}

// catchUpAPIErr maps a store error onto the sentinels the HTTP layer switches
// on. Anything else passes through and becomes a 500 with the request id.
func catchUpAPIErr(err error) error {
	switch {
	case err == nil:
		return nil
	case errors.Is(err, domain.ErrCatchUpNotFound):
		return fmt.Errorf("%w: %w", api.ErrCatchUpNotFound, err)
	case errors.Is(err, domain.ErrCatchUpValidation):
		return fmt.Errorf("%w: %s", api.ErrCatchUpValidation,
			strings.TrimPrefix(err.Error(), domain.ErrCatchUpValidation.Error()+": "))
	default:
		return err
	}
}

// --- list ---------------------------------------------------------------

// catchUpAPIProjectsSQL is the chip read: the names and stored colours of the
// projects a page came from, re-checked against the caller's own membership. The
// ids came from a membership-scoped list read, so this is defense in depth
// rather than the gate; it is also the only place the eight-hue palette's NULL
// is turned into the fallback, so a replica never picks a different chip.
const catchUpAPIProjectsSQL = `
	WITH ` + catchUpVisibleSome + `
	SELECT p.id::text, p.name, COALESCE (p.color, '')
	FROM projects p
	JOIN visible v ON v.id = p.id`

// catchUpAPITourShapeSQL is `total_stops` and the top `importance` of each
// listed item, read off its newest version — the same version the unseen count
// counted, so a rewrite between the two statements cannot make a row say "2 of
// 5 unseen" out of two different tours. It is keyed on ids an authorized read
// returned, never on ids a caller named, and it is bounded by the page.
const catchUpAPITourShapeSQL = `
	WITH ids AS (SELECT unnest ($1::uuid[]) AS id),
	latest AS (
		SELECT DISTINCT ON (tv.work_item_id) tv.work_item_id, tv.stops
		FROM catchup_tour_versions tv
		JOIN ids i ON i.id = tv.work_item_id
		ORDER BY tv.work_item_id, tv.version DESC
	)
	SELECT l.work_item_id::text,
	       count(*)::integer AS total_stops,
	       max(CASE e.value ->> 'importance'
		           WHEN 'must_know' THEN 3
		           WHEN 'worth_a_look' THEN 2
		           WHEN 'routine' THEN 1
		           ELSE 0 END)::integer AS top_rank
	FROM latest l
	CROSS JOIN jsonb_array_elements (l.stops) AS e
	GROUP BY l.work_item_id`

// catchUpImportanceByRank maps the aggregate's rank back onto the closed
// vocabulary. Rank 0 means a stop whose importance is outside it — which the
// write path refused, so it is corruption, and the read fails on it rather than
// serving a row that ranked nothing (ADR-0078 § Decision 7).
var catchUpImportanceByRank = map[int]string{
	3: string(domain.CatchUpImportanceMustKnow),
	2: string(domain.CatchUpImportanceWorthLook),
	1: string(domain.CatchUpImportanceRoutine),
}

func (a APICatchUpStore) ListCatchUpItems(ctx context.Context, c api.Caller,
	f api.CatchUpListFilter) (api.CatchUpItemList, error) {
	s, err := a.store()
	if err != nil {
		return api.CatchUpItemList{}, err
	}
	sc := prjAPICaller(c)
	items, err := s.ListUnseenWorkItems(ctx, sc, f.ProjectIDs, f.Since, f.IncludeSeen)
	if err != nil {
		return api.CatchUpItemList{}, catchUpAPIErr(err)
	}
	out := api.CatchUpItemList{Items: make([]api.CatchUpListItemView, 0, len(items))}
	if len(items) == 0 {
		return out, nil
	}
	chips, err := catchUpAPIChips(ctx, s, sc, items)
	if err != nil {
		return api.CatchUpItemList{}, err
	}
	shapes, err := catchUpAPITourShapes(ctx, s, items)
	if err != nil {
		return api.CatchUpItemList{}, err
	}
	for _, it := range items {
		chip, ok := chips[it.ProjectID]
		if !ok {
			// The two statements are not one transaction, so the one honest
			// reason a project answers the list and not the chip is that the
			// caller's membership (or the project) went away between them. The
			// chip read carries the same visibility predicate, and it said no —
			// so the row goes, rather than a 500 that leaks a project id into
			// the log or a work item drawn with no project on it.
			s.logger().WarnContext(ctx, "catch up: dropping a listed work item whose project is no longer visible",
				slog.String("work_item_id", it.ID), slog.String("project_id", it.ProjectID))
			continue
		}
		shape, ok := shapes[it.ID]
		if !ok {
			return api.CatchUpItemList{}, fmt.Errorf(
				"postgres: catchup work item %s has no tour shape to count", it.ID)
		}
		out.Items = append(out.Items, api.CatchUpListItemView{
			ID: it.ID, Project: chip,
			Shape: string(it.Shape), Title: it.Title, Summary: it.Summary,
			Resolution: string(it.Resolution), Refs: catchUpAPIRefs(it.Refs),
			Updated: it.Updated, UnseenStops: it.UnseenStops,
			TotalStops: shape.totalStops, Importance: shape.topImportance,
			UpdatedAt: it.UpdatedAt.UTC(), CreatedAt: it.CreatedAt.UTC(),
		})
		// Both totals are facts about this reader's backlog as this same
		// statement returned it: the badge counts what is still owed, and
		// `oldest_unseen_at` is how far back that reaches.
		if it.UnseenStops > 0 {
			out.TotalUnseen++
			at := it.UpdatedAt.UTC()
			if out.OldestUnseenAt == nil || at.Before(*out.OldestUnseenAt) {
				out.OldestUnseenAt = &at
			}
		}
	}
	return out, nil
}

func catchUpAPIChips(ctx context.Context, s *CatchUpStore, sc Caller,
	items []domain.CatchUpListItem) (map[string]api.CatchUpProjectChip, error) {
	seen := map[string]bool{}
	ids := make([]string, 0, len(items))
	for _, it := range items {
		if !seen[it.ProjectID] {
			seen[it.ProjectID] = true
			ids = append(ids, it.ProjectID)
		}
	}
	rows, err := s.Pool.Query(ctx, catchUpAPIProjectsSQL, sc.UserID, sc.OrganizationID,
		sc.IsOrgAdmin, ids)
	if err != nil {
		return nil, catchUpQueryErr(err, "read catchup project chips")
	}
	defer rows.Close()
	out := map[string]api.CatchUpProjectChip{}
	for rows.Next() {
		var chip api.CatchUpProjectChip
		if err := rows.Scan(&chip.ID, &chip.Name, &chip.Color); err != nil {
			return nil, catchUpQueryErr(err, "scan catchup project chip")
		}
		// NULL colour is "nobody chose", and the fallback is by project id, so
		// the answer is the same on every replica and after a rename.
		chip.Color = domain.CatchUpProjectColorOr(chip.ID, chip.Color)
		out[chip.ID] = chip
	}
	if err := rows.Err(); err != nil {
		return nil, catchUpQueryErr(err, "read catchup project chips")
	}
	return out, nil
}

type catchUpTourShape struct {
	totalStops    int
	topImportance string
}

func catchUpAPITourShapes(ctx context.Context, s *CatchUpStore,
	items []domain.CatchUpListItem) (map[string]catchUpTourShape, error) {
	seen := map[string]bool{}
	ids := make([]string, 0, len(items))
	for _, it := range items {
		if !seen[it.ID] {
			seen[it.ID] = true
			ids = append(ids, it.ID)
		}
	}
	rows, err := s.Pool.Query(ctx, catchUpAPITourShapeSQL, ids)
	if err != nil {
		return nil, catchUpQueryErr(err, "read catchup tour shape")
	}
	defer rows.Close()
	out := map[string]catchUpTourShape{}
	for rows.Next() {
		var (
			id    string
			total int
			rank  int
		)
		if err := rows.Scan(&id, &total, &rank); err != nil {
			return nil, catchUpQueryErr(err, "scan catchup tour shape")
		}
		name, ok := catchUpImportanceByRank[rank]
		if !ok {
			return nil, fmt.Errorf(
				"postgres: catchup work item %s has a stop outside the importance vocabulary", id)
		}
		out[id] = catchUpTourShape{totalStops: total, topImportance: name}
	}
	if err := rows.Err(); err != nil {
		return nil, catchUpQueryErr(err, "read catchup tour shape")
	}
	return out, nil
}

// --- one item -----------------------------------------------------------

// catchUpItemVisibleSQL answers, for one work item: which project is it in, and
// may this caller see it. It exists so a refusal can be audited against the
// project it was refused in — the row the 404 must not name. An item that is
// not there at all answers no row, which is why a guessed uuid writes nothing:
// naming a project from a path parameter would put a caller's invention in the
// ledger.
const catchUpItemVisibleSQL = `
	WITH ` + catchUpVisibleItem + `
	SELECT w.project_id::text, (SELECT count(*) FROM visible)::integer > 0 AS visible
	FROM catchup_work_items w
	WHERE w.id = $4::uuid`

// catchUpSeenRowsSQL is one reader's own seen rows on one item. The item's
// visibility was established by the read in front of it, and the rows are keyed
// on the caller's own id, so this statement cannot answer another reader's
// reading state even by accident.
const catchUpSeenRowsSQL = `
	SELECT stop_id, tour_version
	FROM catchup_seen_stops
	WHERE user_id = $1::uuid AND work_item_id = $2::uuid`

func (a APICatchUpStore) GetCatchUpItem(ctx context.Context, c api.Caller,
	itemID string) (api.CatchUpItemView, error) {
	s, err := a.store()
	if err != nil {
		return api.CatchUpItemView{}, err
	}
	sc := prjAPICaller(c)
	view, err := s.GetWorkItem(ctx, sc, itemID)
	if err != nil {
		if errors.Is(err, domain.ErrCatchUpNotFound) {
			a.deniedItem(ctx, sc, itemID, "catchup.item.read")
		}
		return api.CatchUpItemView{}, catchUpAPIErr(err)
	}
	chip, err := catchUpAPIChip(ctx, s, view.ProjectID)
	if err != nil {
		return api.CatchUpItemView{}, err
	}
	seen, youSaw, err := catchUpAPISeenRows(ctx, s, sc, itemID)
	if err != nil {
		return api.CatchUpItemView{}, err
	}
	readers, err := s.SeenBy(ctx, sc, itemID)
	if err != nil {
		return api.CatchUpItemView{}, catchUpAPIErr(err)
	}
	out := api.CatchUpItemView{
		ID: view.ID, Project: chip,
		Shape: string(view.Shape), Title: view.Title, Summary: view.Summary,
		Resolution: string(view.Resolution), Refs: catchUpAPIRefs(view.Refs),
		SourceRunID: view.SourceRunID, ConversationID: view.ConversationID,
		History:       catchUpAPIHistory(view.History),
		SeenBy:        catchUpAPISeenBy(readers),
		YouSawVersion: youSaw,
		CreatedAt:     view.CreatedAt.UTC(), UpdatedAt: view.UpdatedAt.UTC(),
	}
	if view.Latest == nil {
		// No story yet: the item exists and every per-stop flag is therefore
		// unread, which the view says by carrying no tour at all.
		return out, nil
	}
	stops := make([]api.CatchUpStopView, 0, len(view.Latest.Stops))
	unseen := 0
	for _, st := range view.Latest.Stops {
		added := st.AddedInVersion
		if added < 1 {
			added = view.Latest.Version
		}
		isSeen := seen[st.ID] >= added
		if !isSeen {
			unseen++
		}
		stops = append(stops, api.CatchUpStopView{
			ID: st.ID, Title: st.Title, Narrative: st.Narrative, Kind: st.Kind,
			Importance:     string(st.Importance),
			AddedInVersion: added,
			Seen:           isSeen,
			Evidence:       catchUpAPIEvidence(st.Evidence),
			Decision:       catchUpAPIDecision(st.Decision),
		})
	}
	out.Latest = &api.CatchUpTourView{
		Version: view.Latest.Version, Reason: view.Latest.Reason,
		CreatedAt: view.Latest.CreatedAt.UTC(), Stops: stops,
	}
	out.UnseenStops, out.TotalStops = unseen, len(stops)
	return out, nil
}

// CatchUpStopQuestion is the reply route's read: the newest tour's question on
// one beat. Everything the rule needs — the item's visibility, the newest
// version, the stop's existence, whether it asked at all — comes back as
// api.ErrCatchUpNotFound, because "that beat asked nothing" would be a hint
// about a story the caller may not be reading.
func (a APICatchUpStore) CatchUpStopQuestion(ctx context.Context, c api.Caller,
	itemID, stopID string) (*api.CatchUpDecisionView, error) {
	s, err := a.store()
	if err != nil {
		return nil, err
	}
	sc := prjAPICaller(c)
	view, err := s.GetWorkItem(ctx, sc, itemID)
	if err != nil {
		if errors.Is(err, domain.ErrCatchUpNotFound) {
			a.deniedItem(ctx, sc, itemID, "catchup.stop.reply")
		}
		return nil, catchUpAPIErr(err)
	}
	if view.Latest == nil {
		return nil, api.ErrCatchUpNotFound
	}
	for _, st := range view.Latest.Stops {
		if st.ID != stopID {
			continue
		}
		d := catchUpAPIDecision(st.Decision)
		if d == nil {
			return nil, api.ErrCatchUpNotFound
		}
		return d, nil
	}
	return nil, api.ErrCatchUpNotFound
}

func catchUpAPIChip(ctx context.Context, s *CatchUpStore, projectID string) (api.CatchUpProjectChip, error) {
	var chip api.CatchUpProjectChip
	err := s.Pool.QueryRow(ctx, `
		SELECT p.id::text, p.name, COALESCE (p.color, '')
		FROM projects p WHERE p.id = $1::uuid`, projectID).
		Scan(&chip.ID, &chip.Name, &chip.Color)
	if errors.Is(err, pgx.ErrNoRows) {
		return api.CatchUpProjectChip{}, api.ErrCatchUpNotFound
	}
	if err != nil {
		return api.CatchUpProjectChip{}, catchUpQueryErr(err, "read catchup project chip")
	}
	chip.Color = domain.CatchUpProjectColorOr(chip.ID, chip.Color)
	return chip, nil
}

// catchUpAPISeenRows reads this caller's seen rows and returns the recorded
// version per beat plus the newest version they have recorded anything at —
// `you_saw_version`, null for a reader who has never marked a beat.
func catchUpAPISeenRows(ctx context.Context, s *CatchUpStore, sc Caller,
	itemID string) (map[string]int, *int, error) {
	rows, err := s.Pool.Query(ctx, catchUpSeenRowsSQL, sc.UserID, itemID)
	if err != nil {
		return nil, nil, catchUpQueryErr(err, "read catchup seen rows")
	}
	defer rows.Close()
	seen := map[string]int{}
	var youSaw *int
	for rows.Next() {
		var (
			stopID string
			ver    int
		)
		if err := rows.Scan(&stopID, &ver); err != nil {
			return nil, nil, catchUpQueryErr(err, "scan catchup seen row")
		}
		if ver > seen[stopID] {
			seen[stopID] = ver
		}
		if youSaw == nil || ver > *youSaw {
			at := ver
			youSaw = &at
		}
	}
	if err := rows.Err(); err != nil {
		return nil, nil, catchUpQueryErr(err, "read catchup seen rows")
	}
	return seen, youSaw, nil
}

func catchUpAPIHistory(h []domain.CatchUpTourVersionHeader) []api.CatchUpTourHeaderView {
	out := make([]api.CatchUpTourHeaderView, 0, len(h))
	for _, v := range h {
		out = append(out, api.CatchUpTourHeaderView{
			Version: v.Version, Reason: v.Reason, StopCount: v.StopCount,
			CreatedAt: v.CreatedAt.UTC(),
		})
	}
	return out
}

func catchUpAPISeenBy(r []domain.CatchUpSeenBy) []api.CatchUpSeenByView {
	out := make([]api.CatchUpSeenByView, 0, len(r))
	for _, s := range r {
		out = append(out, api.CatchUpSeenByView{
			ID: s.UserID, Name: s.DisplayName, SeenAt: s.SeenAt.UTC(),
		})
	}
	return out
}

func catchUpAPIRefs(r domain.CatchUpRefs) api.CatchUpRefsView {
	return api.CatchUpRefsView{
		IssueNumbers: r.IssueNumbers, PRNumbers: r.PRNumbers,
		CommitSHAs: r.CommitSHAs, RunIDs: r.RunIDs,
	}
}

// catchUpAPIEvidence flattens each piece of proof through its own marshal,
// which is the one place that decides the shape (domain.CatchUpEvidence): the
// server's `type` wins over a `type` smuggled into the opaque payload, and the
// model's other members ride through untouched for the client that owns the
// kind. Doing it by round trip rather than by hand is what keeps this adapter
// from inventing a second opinion about the shape.
func catchUpAPIEvidence(evs []domain.CatchUpEvidence) []map[string]any {
	if len(evs) == 0 {
		return nil
	}
	out := make([]map[string]any, 0, len(evs))
	for _, ev := range evs {
		raw, err := json.Marshal(ev)
		if err != nil {
			// A payload the model wrote that will not encode is not this
			// reader's problem to see half of: drop the piece of proof rather
			// than serve a stop whose evidence is a lie.
			continue
		}
		var m map[string]any
		if err := json.Unmarshal(raw, &m); err != nil {
			continue
		}
		out = append(out, m)
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

func catchUpAPIDecision(d *domain.CatchUpDecision) *api.CatchUpDecisionView {
	if d == nil {
		return nil
	}
	return &api.CatchUpDecisionView{Prompt: d.Prompt, Options: d.Options, AllowText: d.AllowText}
}

// --- the writes ---------------------------------------------------------

func (a APICatchUpStore) MarkCatchUpStopsSeen(ctx context.Context, c api.Caller,
	itemID string, version int, stopIDs []string) error {
	s, err := a.store()
	if err != nil {
		return err
	}
	sc := prjAPICaller(c)
	if _, err := s.MarkStopsSeen(ctx, sc, itemID, version, stopIDs); err != nil {
		if errors.Is(err, domain.ErrCatchUpNotFound) {
			a.deniedItem(ctx, sc, itemID, "catchup.item.seen")
		}
		return catchUpAPIErr(err)
	}
	return nil
}

func (a APICatchUpStore) MarkAllCatchUpSeen(ctx context.Context, c api.Caller,
	projectIDs []string) error {
	s, err := a.store()
	if err != nil {
		return err
	}
	if _, err := s.MarkAllSeen(ctx, prjAPICaller(c), projectIDs); err != nil {
		return catchUpAPIErr(err)
	}
	return nil
}

func (a APICatchUpStore) RecordCatchUpVisit(ctx context.Context, c api.Caller) error {
	s, err := a.store()
	if err != nil {
		return err
	}
	return catchUpAPIErr(s.RecordVisit(ctx, prjAPICaller(c)))
}

func (a APICatchUpStore) RecentCatchUpVisits(ctx context.Context,
	c api.Caller) ([]time.Time, error) {
	s, err := a.store()
	if err != nil {
		return nil, err
	}
	return s.RecentVisits(ctx, prjAPICaller(c))
}

// catchUpAPIRecapSQL is the personal read with the projects the caller named
// applied as an OVERLAP: a recap is one row per reader (ADR-0078 § Decision 1),
// so "give me the recap for the projects on my screen" is answered by the newest
// row whose coverage touches them. A row that covered no project at all is not
// coverage of these, so an overlap with a non-empty stored list is required.
// The reader's id is in the WHERE, never a filter the caller may leave out.
const catchUpAPIRecapSQL = `
	SELECT r."text", r."window", r.project_ids, r.written_at
	FROM catchup_recaps r
	WHERE r.user_id = $1::uuid
	  AND ($2::uuid[] IS NULL OR r.project_ids && $2::uuid[])
	ORDER BY r.written_at DESC, r.id DESC
	LIMIT 1`

func (a APICatchUpStore) LatestCatchUpRecap(ctx context.Context, c api.Caller,
	projectIDs []string) (api.CatchUpRecapView, error) {
	s, err := a.store()
	if err != nil {
		return api.CatchUpRecapView{}, err
	}
	var (
		out api.CatchUpRecapView
		ids []string
	)
	// NULL and the empty array are different questions here, so the empty list
	// stays NULL ("no filter") rather than becoming catchUpOptUUIDSlice's
	// "{}" ("cover nothing"), which would answer 404 on the page's own default
	// read.
	var named any
	if len(projectIDs) > 0 {
		named = projectIDs
	}
	err = s.Pool.QueryRow(ctx, catchUpAPIRecapSQL, c.UserID, named).
		Scan(&out.Text, &out.Window, &ids, &out.WrittenAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return api.CatchUpRecapView{}, api.ErrCatchUpNotFound
	}
	if err != nil {
		return api.CatchUpRecapView{}, catchUpQueryErr(err, "read catchup recap")
	}
	out.ProjectIDs, out.WrittenAt = ids, out.WrittenAt.UTC()
	return out, nil
}

func (a APICatchUpStore) InsertCatchUpDecisionReply(ctx context.Context, c api.Caller,
	itemID, stopID, text string) (api.CatchUpReplyRecord, error) {
	s, err := a.store()
	if err != nil {
		return api.CatchUpReplyRecord{}, err
	}
	sc := prjAPICaller(c)
	// The store copies the conversation id off the work item in its own
	// statement, so what comes back is the destination this reply has, not the
	// one the caller could have named.
	reply, err := s.InsertDecisionReply(ctx, sc, itemID, stopID, text)
	if err != nil {
		if errors.Is(err, domain.ErrCatchUpNotFound) {
			a.deniedItem(ctx, sc, itemID, "catchup.stop.reply")
		}
		return api.CatchUpReplyRecord{}, catchUpAPIErr(err)
	}
	return api.CatchUpReplyRecord{
		ID: reply.ID, StopID: reply.StopID, Text: reply.Text,
		ConversationID: reply.ConversationID,
	}, nil
}

// deniedItem records one refusal against the project the refused work item
// lived in. It runs only after the store answered "not yours to see", and it
// writes nothing at all for an id that was never a work item: there is no
// project to audit against, and a caller-chosen uuid does not belong in the
// ledger (the same rule APIAssistantNotesStore follows, and for the same
// reason).
func (a APICatchUpStore) deniedItem(ctx context.Context, c Caller, itemID, action string) {
	log := discardM4Log()
	if a.S != nil {
		log = a.S.logger()
	}
	if a.Denials == nil {
		log.Error("catch up: denial not audited",
			slog.String("action", action),
			slog.String("reason", "no denial recorder configured"))
		return
	}
	var (
		projectID string
		visible   bool
	)
	err := a.S.Pool.QueryRow(ctx, catchUpItemVisibleSQL, c.UserID, c.OrganizationID,
		c.IsOrgAdmin, itemID).Scan(&projectID, &visible)
	if errors.Is(err, pgx.ErrNoRows) {
		return
	}
	if err != nil || visible {
		if err != nil {
			log.Error("catch up: could not resolve the refused work item",
				slog.String("action", action), slog.String("error", err.Error()))
		}
		return
	}
	if err := a.Denials.RecordDenied(ctx, c, projectID, action); err != nil {
		log.Error("catch up: could not write audit denial",
			slog.String("action", action),
			slog.String("project_id", projectID),
			slog.String("error", err.Error())) // names tables, never values
		return
	}
	log.WarnContext(ctx, "catch up: access denied",
		slog.String("action", action),
		slog.String("user_id", c.UserID),
		slog.String("project_id", projectID))
}
