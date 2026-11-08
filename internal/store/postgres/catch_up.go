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
	// roster is empty: the answer is the same one a gone item gives.
	if _, _, err := s.tourHead(ctx, pool, c, workItemID); err != nil {
		return nil, err
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
