package postgres

// The assistant_notes table (ADR-0071): quiet, model-written suggestions,
// each meant for ONE person about ONE repository or ONE thread.
//
// Three arms live here:
//
//   - InsertAssistantNote is the generator's write (step 2), not a route. It
//     is ONE statement that also enforces the two rules the surface rests on:
//     the scope id must resolve to a row of the named kind inside the note's
//     own project (so a cross-project or dangling scope is never written), and
//     at most AssistantNotesActiveCap notes stay ACTIVE for one user and
//     scope, the oldest being deleted to make room.
//   - the two list reads answer "what does this person have right now?" and
//     are the only notes reads the API makes. Both authorize the scope the way
//     every other project route does — membership in the project, or the
//     organization's admin — and both write the ADR-0014 § 3 audit row
//     themselves, because the row that says "not yours" knows the project it
//     was refused in and the HTTP layer does not.
//   - DismissAssistantNote marks the note for its OWNER only. A non-owner's
//     dismiss is the same answer as no note at all (404, never 403: a 403
//     would confirm that somebody else's suggestion exists), and the attempt
//     is audited against the note's own project.
//
// An inactive note is not a deleted one: dismissed and expired rows stay for
// the generator's own evaluation (ADR-0071 § Storage). Only the per-scope
// overflow — the note a fourth suggestion displaced — is deleted, because
// keeping every superseded suggestion would grow the table for content nobody
// ever saw. Nothing here needs a janitor to be correct.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/dbirks/communication/internal/api"
)

// AssistantNotesStore owns the assistant_notes table.
type AssistantNotesStore struct {
	Pool *pgxpool.Pool
	// Log receives audit-write failures. A denial that could not be recorded
	// is still a denial, so this is the only place a note of it appears.
	Log *slog.Logger
}

func (s *AssistantNotesStore) logger() *slog.Logger {
	if s != nil && s.Log != nil {
		return s.Log
	}
	return discardM4Log()
}

// asnInsertSQL writes one note and caps the active set in the same statement.
//
// The scope guard is the insert's own WHERE: a row appears only when scope_id
// names a repository (or conversation) of project_id, so the statement either
// writes a note that is true about the project it belongs to, or writes
// nothing at all. The `drop_stale` arm then deletes the overflow — every
// data-modifying CTE sees the others' effects, so the new note counts toward
// the cap and, being the newest, is never the row deleted. Its
// `EXISTS (SELECT 1 FROM ins)` guard is what stops a refused insert from
// pruning notes it did not add. The stale ranking is NEWEST first, so what
// survives alongside the fresh note is the two most recent older notes — the
// panel's three — and not the three that happened to be written first.
const asnInsertSQL = `
	WITH ins AS (
		INSERT INTO assistant_notes (project_id, user_id, scope_kind, scope_id, "text", action, expires_at)
		SELECT $1::uuid, $2::uuid, $3, $4::uuid, $5, $6::jsonb, $7
		WHERE (
			$3 = 'repository'
			AND EXISTS (SELECT 1 FROM repositories r
			            WHERE r.id = $4::uuid AND r.project_id = $1::uuid)
			OR $3 = 'conversation'
			AND EXISTS (SELECT 1 FROM conversations cv
			            WHERE cv.id = $4::uuid AND cv.project_id = $1::uuid)
		)
		RETURNING id, created_at
	),
	drop_stale AS (
		DELETE FROM assistant_notes AS n
		WHERE EXISTS (SELECT 1 FROM ins)
		  AND n.id IN (
			SELECT stale.id FROM (
				SELECT older.id,
				       row_number() OVER (ORDER BY older.created_at DESC, older.id DESC) AS rn
				FROM assistant_notes AS older
				WHERE older.user_id = $2::uuid
				  AND older.scope_kind = $3
				  AND older.scope_id = $4::uuid
				  AND older.dismissed_at IS NULL
				  AND (older.expires_at IS NULL OR older.expires_at > now())
				  AND older.id NOT IN (SELECT id FROM ins)
			) AS stale
			WHERE stale.rn > $8::int - 1
		  )
		RETURNING n.id
	)
	SELECT ins.id::text, ins.created_at FROM ins`

// asnListSQL reads one user's active notes in one scope, newest first: the
// partial index's own predicate (user, kind, scope, not dismissed) plus the
// half it cannot state, the deadline. The LIMIT is the cap rather than a page
// size — it keeps the read bounded (ADR-0063) and matches the three rows the
// panel draws, so a scope that somehow holds more (a cap raised after the
// rows were written) serves its newest three instead of surprising a client
// with a fourth.
const asnListSQL = `
	SELECT n.id::text, n.project_id::text, n.scope_kind, n.scope_id::text,
	       n."text", n.action, n.created_at, n.expires_at
	FROM assistant_notes n
	WHERE n.user_id = $1::uuid
	  AND n.scope_kind = $2
	  AND n.scope_id = $3::uuid
	  AND n.project_id = $4::uuid
	  AND n.dismissed_at IS NULL
	  AND (n.expires_at IS NULL OR n.expires_at > now())
	ORDER BY n.created_at DESC, n.id DESC
	LIMIT $5`

// asnRepositoryScope resolves the repository route's pair: does this
// repository belong to that project, and may this caller see the project? One
// read answers both, and "no such repository in this project" and "not your
// project" are deliberately the same false.
const asnRepositoryScope = `
	SELECT p.id::text,
	       (p.organization_id = $2::uuid AND ($3::boolean OR m.user_id IS NOT NULL)) AS visible
	FROM repositories r
	JOIN projects p ON p.id = r.project_id
	LEFT JOIN memberships m ON m.project_id = p.id AND m.user_id = $1::uuid
	WHERE r.id = $4::uuid AND r.project_id = $5::uuid`

// asnConversationScope is the same question for a thread: which project is it
// in, and may the caller see that project? $4 is the thread id.
const asnConversationScope = `
	SELECT p.id::text,
	       (p.organization_id = $2::uuid AND ($3::boolean OR m.user_id IS NOT NULL)) AS visible
	FROM conversations cv
	JOIN projects p ON p.id = cv.project_id
	LEFT JOIN memberships m ON m.project_id = p.id AND m.user_id = $1::uuid
	WHERE cv.id = $4::uuid`

// asnDismissSQL dismisses the caller's own active note and reports whether the
// row existed at all, in one statement. The client's answer is 404 in every
// non-success case — what it may never learn is WHICH one — while the store
// learns the note's project, which is the one case the HTTP layer cannot name
// for itself: an attempt on somebody else's note is exactly the denial
// ADR-0014 § 3 wants in the ledger.
const asnDismissSQL = `
	WITH target AS (
		SELECT id, project_id::text AS project_id FROM assistant_notes WHERE id = $2::uuid
	),
	upd AS (
		UPDATE assistant_notes AS n
		SET dismissed_at = now()
		FROM target t
		WHERE n.id = t.id
		  AND n.user_id = $1::uuid
		  AND n.dismissed_at IS NULL
		  AND (n.expires_at IS NULL OR n.expires_at > now())
		RETURNING n.id
	)
	SELECT (SELECT count(*) FROM target)::int,
	       COALESCE((SELECT project_id FROM target), ''),
	       (SELECT count(*) FROM upd)::int`

// InsertAssistantNote writes one note for one user and scope, enforcing the
// scope-is-in-the-project rule and the cap of AssistantNotesActiveCap active
// notes. The text is stored trimmed (migration 00027 CHECKs that it is), so a
// model that pads its own sentence still gets a note whose length means what
// it says.
func (s *AssistantNotesStore) InsertAssistantNote(ctx context.Context,
	in api.AssistantNoteInput) (api.AssistantNoteView, error) {
	if s == nil || s.Pool == nil {
		return api.AssistantNoteView{}, errors.New("postgres: assistant notes store has no pool")
	}
	in.Text = strings.TrimSpace(in.Text)
	if err := in.Validate(); err != nil {
		return api.AssistantNoteView{}, err
	}
	var action []byte
	if in.Action != nil {
		raw, err := json.Marshal(in.Action)
		if err != nil {
			return api.AssistantNoteView{},
				fmt.Errorf("postgres: encode assistant note action: %w", err)
		}
		action = raw
	}
	var note api.AssistantNoteView
	err := s.Pool.QueryRow(ctx, asnInsertSQL,
		in.ProjectID, in.UserID, in.ScopeKind, in.ScopeID, in.Text, action, in.ExpiresAt,
		api.AssistantNotesActiveCap).Scan(&note.ID, &note.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		// The insert's own guard found no scope row of that kind in that
		// project. Nothing was written, and the error says which half failed.
		return api.AssistantNoteView{}, fmt.Errorf(
			"%w: scope_id: %s is not a %s of project %s",
			api.ErrAssistantNoteValidation, in.ScopeID, in.ScopeKind, in.ProjectID)
	}
	if err != nil {
		return api.AssistantNoteView{}, fmt.Errorf("postgres: insert assistant note: %w", err)
	}
	note.ProjectID, note.ScopeKind, note.ScopeID, note.Text =
		in.ProjectID, in.ScopeKind, in.ScopeID, in.Text
	note.Action, note.ExpiresAt = in.Action, in.ExpiresAt
	return note, nil
}

// listNotes is the shared read behind both scopes.
func (s *AssistantNotesStore) listNotes(ctx context.Context, c Caller,
	scopeKind, projectID, scopeID string) ([]api.AssistantNoteView, error) {
	rows, err := s.Pool.Query(ctx, asnListSQL, c.UserID, scopeKind, scopeID, projectID,
		api.AssistantNotesActiveCap)
	if err != nil {
		return nil, fmt.Errorf("postgres: list assistant notes: %w", err)
	}
	defer rows.Close()
	out := []api.AssistantNoteView{}
	for rows.Next() {
		var (
			note   api.AssistantNoteView
			action []byte
		)
		if err := rows.Scan(&note.ID, &note.ProjectID, &note.ScopeKind, &note.ScopeID,
			&note.Text, &action, &note.CreatedAt, &note.ExpiresAt); err != nil {
			return nil, fmt.Errorf("postgres: scan assistant note: %w", err)
		}
		if note.Action, err = decodeAssistantNoteAction(action); err != nil {
			return nil, err
		}
		out = append(out, note)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("postgres: list assistant notes: %w", err)
	}
	return out, nil
}

// decodeAssistantNoteAction reads a stored action object back into the
// contract's union. An unknown member or a missing kind is corruption rather
// than a client mistake — the only writer is our own generator, and it
// validated what it wrote — so the read fails loudly instead of serving half
// an action a client could act on.
func decodeAssistantNoteAction(raw []byte) (*api.AssistantNoteAction, error) {
	if len(raw) == 0 || string(raw) == "null" {
		return nil, nil
	}
	var action api.AssistantNoteAction
	dec := json.NewDecoder(strings.NewReader(string(raw)))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&action); err != nil {
		return nil, fmt.Errorf("postgres: assistant note action: %w", err)
	}
	if dec.More() {
		return nil, fmt.Errorf("postgres: assistant note action: trailing content after the object")
	}
	if err := action.Validate(); err != nil {
		return nil, fmt.Errorf("postgres: assistant note action: %w", err)
	}
	return &action, nil
}

// APIAssistantNotesStore exposes an *AssistantNotesStore as internal/api's
// AssistantNotesStore, the way the other adapters in this package do. The
// conversion is also where the store's authorization decisions become HTTP
// sentinels, and where every refusal is audited: the adapter knows the project
// the refused row lived in, which is precisely what the handler does not.
type APIAssistantNotesStore struct {
	S *AssistantNotesStore
	// Denials writes the audit row; usually the same *ProjectStore the API
	// already holds, taken as an interface so this file does not assume it.
	Denials interface {
		RecordDenied(ctx context.Context, c Caller, projectID, action string) error
	}
}

var _ api.AssistantNotesStore = APIAssistantNotesStore{}

func (a APIAssistantNotesStore) store() (*AssistantNotesStore, error) {
	if a.S == nil || a.S.Pool == nil {
		return nil, errors.New("postgres: APIAssistantNotesStore has no pool")
	}
	return a.S, nil
}

// ListRepositoryNotes implements api.AssistantNotesStore.
func (a APIAssistantNotesStore) ListRepositoryNotes(ctx context.Context, c api.Caller,
	projectID, repositoryID string) ([]api.AssistantNoteView, error) {
	s, err := a.store()
	if err != nil {
		return nil, err
	}
	sc := prjAPICaller(c)
	var (
		resolved string
		visible  bool
	)
	err = s.Pool.QueryRow(ctx, asnRepositoryScope, sc.UserID, sc.OrganizationID,
		sc.IsOrgAdmin, repositoryID, projectID).Scan(&resolved, &visible)
	if errors.Is(err, pgx.ErrNoRows) {
		// No repository of that id in that project — the same answer whether
		// the id is wrong or the project is somebody else's.
		a.denied(ctx, sc, projectID, "assistant_note.repository.list")
		return nil, api.ErrProjectNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("postgres: assistant note repository scope: %w", err)
	}
	if !visible {
		a.denied(ctx, sc, resolved, "assistant_note.repository.list")
		return nil, api.ErrProjectNotFound
	}
	return s.listNotes(ctx, sc, api.AssistantNoteScopeRepository, projectID, repositoryID)
}

// ListConversationNotes implements api.AssistantNotesStore.
func (a APIAssistantNotesStore) ListConversationNotes(ctx context.Context, c api.Caller,
	conversationID string) ([]api.AssistantNoteView, error) {
	s, err := a.store()
	if err != nil {
		return nil, err
	}
	sc := prjAPICaller(c)
	projectID, visible, err := a.conversationScope(ctx, s, sc, conversationID)
	if err != nil {
		return nil, err
	}
	if !visible {
		a.denied(ctx, sc, projectID, "assistant_note.conversation.list")
		return nil, api.ErrProjectNotFound
	}
	return s.listNotes(ctx, sc, api.AssistantNoteScopeConversation, projectID, conversationID)
}

// DismissAssistantNote implements api.AssistantNotesStore.
func (a APIAssistantNotesStore) DismissAssistantNote(ctx context.Context, c api.Caller,
	noteID string) error {
	s, err := a.store()
	if err != nil {
		return err
	}
	sc := prjAPICaller(c)
	var (
		exists  int
		project string
		updated int
	)
	err = s.Pool.QueryRow(ctx, asnDismissSQL, sc.UserID, noteID).Scan(&exists, &project, &updated)
	if err != nil {
		return fmt.Errorf("postgres: dismiss assistant note: %w", err)
	}
	if updated == 1 {
		return nil
	}
	if exists == 1 {
		// The note is real and not the caller's to dismiss (or is already
		// inactive). The answer is still "no such note"; the audit row is the
		// half only an operator ever sees.
		a.denied(ctx, sc, project, "assistant_note.dismiss")
	}
	return api.ErrAssistantNoteNotFound
}

// conversationScope resolves a thread to its project and asks whether the
// caller may see it. A thread that does not exist is ErrProjectNotFound with
// no audit row at all: there is no project to audit against, and naming one
// from a path parameter would put a caller-controlled uuid in the ledger.
func (a APIAssistantNotesStore) conversationScope(ctx context.Context, s *AssistantNotesStore,
	sc Caller, conversationID string) (projectID string, visible bool, err error) {
	err = s.Pool.QueryRow(ctx, asnConversationScope, sc.UserID, sc.OrganizationID,
		sc.IsOrgAdmin, conversationID).Scan(&projectID, &visible)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", false, api.ErrProjectNotFound
	}
	if err != nil {
		return "", false, fmt.Errorf("postgres: assistant note conversation scope: %w", err)
	}
	return projectID, visible, nil
}

// denied records one refusal. Failing to record it is logged and changes
// nothing else: the request is denied either way.
func (a APIAssistantNotesStore) denied(ctx context.Context, c Caller, projectID, action string) {
	log := discardM4Log()
	if a.S != nil {
		log = a.S.logger()
	}
	if a.Denials == nil || projectID == "" {
		log.Error("assistant notes: denial not audited",
			slog.String("action", action),
			slog.String("project_id", projectID),
			slog.String("reason", "no denial recorder configured"))
		return
	}
	if err := a.Denials.RecordDenied(ctx, c, projectID, action); err != nil {
		log.Error("assistant notes: could not write audit denial",
			slog.String("action", action),
			slog.String("project_id", projectID),
			slog.String("error", err.Error())) // the error names tables, never values
		return
	}
	log.WarnContext(ctx, "assistant notes: access denied",
		slog.String("action", action),
		slog.String("user_id", c.UserID),
		slog.String("project_id", projectID))
}
