package postgres

// The assistant v2 tables (ADR-0050 decision 1, migration 00010): the
// per-user assistant conversation, its append-only transcript and the
// change log. The v1 ask path (ADR-0034) still stores nothing; only the
// conversation routes (internal/api/assistant_conversations.go) touch
// these tables.
//
// Scoping is by users.id, like user_preferences: every read and mutation
// is keyed on the caller's own user id in SQL, so a conversation that
// exists but belongs to another user is the api not-found sentinel
// (404, never 403 — the caller must not learn it exists).
//
// The transcript is append-only, ordered by (created_at, id): uuidv7 ids
// are time-ordered, so the tie-break is the insert order and the
// conversation list's (last_message_at DESC NULLS LAST, id DESC) ordering
// matches its index. Undo is the store's only write path onto a row:
// undoOne re-reads the change FOR UPDATE inside the undo transaction,
// calls the Undoer seam (ADR-0050 decision 5; part 1 ships UndoNotWired)
// and sets undone_at in the SAME transaction — a failed inverse op leaves
// the row and the draft untouched and is reported as not-undoable.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/dbirks/communication/internal/api"
	"github.com/dbirks/communication/internal/assistant"
)

// AssistantConversationStore owns the three assistant v2 tables. Undoer is
// the ADR-0050 decision 5 seam: part 1 wires assistant.UndoNotWired, part 2
// the draft-edit inverse.
type AssistantConversationStore struct {
	Pool   *pgxpool.Pool
	Undoer assistant.Undoer
}

const (
	// AssistantConvDefaultLimit / MaxLimit are the list paging bounds
	// (the cross-project list's convention).
	AssistantConvDefaultLimit = 50
	AssistantConvMaxLimit     = 200
)

func assistantLimit(limit int) int {
	if limit < 1 {
		return AssistantConvDefaultLimit
	}
	if limit > AssistantConvMaxLimit {
		return AssistantConvMaxLimit
	}
	return limit
}

// assistantBounded clips an error detail that lands in a problem body.
func assistantBounded(s string) string {
	const limit = 300
	if len(s) <= limit {
		return s
	}
	cut := limit
	for cut > 0 && (s[cut]&0xC0) == 0x80 {
		cut--
	}
	return s[:cut]
}

// CreateConversation starts a new conversation for the caller; the title
// stays NULL until the first user message.
func (s *AssistantConversationStore) CreateConversation(ctx context.Context,
	userID string) (api.AssistantConversation, error) {
	if s == nil || s.Pool == nil {
		return api.AssistantConversation{}, errors.New("postgres: assistant conversation store has no pool")
	}
	var row api.AssistantConversation
	err := s.Pool.QueryRow(ctx,
		`INSERT INTO assistant_conversations (user_id) VALUES ($1::uuid)
		 RETURNING id::text, title, created_at, updated_at, last_message_at`,
		userID).Scan(&row.ID, &row.Title, &row.CreatedAt, &row.UpdatedAt, &row.LastMessageAt)
	if err != nil {
		return api.AssistantConversation{},
			fmt.Errorf("postgres: create assistant conversation for %s: %w", userID, err)
	}
	return row, nil
}

// GetConversation returns the caller's conversation or the not-found
// sentinel for every other id — one user's conversation is invisible to
// the other, never forbidden.
func (s *AssistantConversationStore) GetConversation(ctx context.Context,
	userID, id string) (api.AssistantConversation, error) {
	if s == nil || s.Pool == nil {
		return api.AssistantConversation{}, errors.New("postgres: assistant conversation store has no pool")
	}
	var row api.AssistantConversation
	err := s.Pool.QueryRow(ctx,
		`SELECT id::text, title, created_at, updated_at, last_message_at
		 FROM assistant_conversations WHERE id = $1::uuid AND user_id = $2::uuid`,
		id, userID).Scan(&row.ID, &row.Title, &row.CreatedAt, &row.UpdatedAt, &row.LastMessageAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return api.AssistantConversation{},
			fmt.Errorf("%w: assistant conversation %s", api.ErrAssistantConversationNotFound, id)
	}
	if err != nil {
		return api.AssistantConversation{},
			fmt.Errorf("postgres: get assistant conversation %s: %w", id, err)
	}
	return row, nil
}

// ListConversations pages the caller's own conversations, newest
// last_message_at first (never-messaged conversations last, newest among
// them first), one page per cursor. The cursor is a strict
// (last_message_at DESC NULLS LAST, id DESC) position: a row is included
// only when it sorts strictly after the cursor's row.
func (s *AssistantConversationStore) ListConversations(ctx context.Context,
	userID string, limit int, cursor api.AssistantListCursor) ([]api.AssistantConversation, string, error) {
	if s == nil || s.Pool == nil {
		return nil, "", errors.New("postgres: assistant conversation store has no pool")
	}
	limit = assistantLimit(limit)
	var args []any = []any{userID}
	where := "WHERE user_id = $1::uuid"
	if cursor.Has {
		args = append(args, cursor.AfterID, cursor.After)
		where = "WHERE user_id = $1::uuid AND (" +
			// cursor sits in the NULL zone: only NULLs younger by id
			"($3::timestamptz IS NULL AND last_message_at IS NULL AND id < $2::uuid) OR " +
			// cursor sits in the timed zone: older timestamps, same
			// timestamp with an older id, or any NULL row (they sort last)
			"($3::timestamptz IS NOT NULL AND (last_message_at IS NULL OR " +
			"last_message_at < $3::timestamptz OR (last_message_at = $3::timestamptz AND id < $2::uuid)))" +
			")"
	}
	rows, err := s.Pool.Query(ctx,
		"SELECT id::text, title, created_at, updated_at, last_message_at "+
			"FROM assistant_conversations "+where+
			" ORDER BY last_message_at DESC NULLS LAST, id DESC LIMIT "+fmt.Sprint(limit+1),
		args...)
	if err != nil {
		return nil, "", fmt.Errorf("postgres: list assistant conversations for %s: %w", userID, err)
	}
	defer rows.Close()
	var out []api.AssistantConversation
	for rows.Next() {
		var row api.AssistantConversation
		if err := rows.Scan(&row.ID, &row.Title, &row.CreatedAt, &row.UpdatedAt, &row.LastMessageAt); err != nil {
			return nil, "", fmt.Errorf("postgres: scan assistant conversation: %w", err)
		}
		out = append(out, row)
	}
	if err := rows.Err(); err != nil {
		return nil, "", fmt.Errorf("postgres: list assistant conversations for %s: %w", userID, err)
	}
	next := ""
	if len(out) > limit {
		tail := out[limit-1]
		out = out[:limit]
		next = api.EncodeAssistantConversationCursor(tail.LastMessageAt, tail.ID)
	}
	if out == nil {
		out = []api.AssistantConversation{}
	}
	return out, next, nil
}

// AddTurnMessages appends the turn's rows (always the user row first, then
// the turn's output) and refreshes the conversation's updated_at /
// last_message_at in ONE transaction; the first user message sets the
// title (ADR-0050 decision 2). A conversation the caller does not own is
// the not-found sentinel and changes nothing.
func (s *AssistantConversationStore) AddTurnMessages(ctx context.Context,
	userID, conversationID string, msgs []api.AssistantMessageInput) ([]api.AssistantMessage, error) {
	if s == nil || s.Pool == nil {
		return nil, errors.New("postgres: assistant conversation store has no pool")
	}
	if len(msgs) == 0 {
		return []api.AssistantMessage{}, nil
	}
	tx, err := s.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, fmt.Errorf("postgres: begin assistant turn: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }() // a no-op after commit

	var title *string
	err = tx.QueryRow(ctx,
		`SELECT title FROM assistant_conversations
		 WHERE id = $1::uuid AND user_id = $2::uuid FOR UPDATE`,
		conversationID, userID).Scan(&title)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, fmt.Errorf("%w: assistant conversation %s",
			api.ErrAssistantConversationNotFound, conversationID)
	}
	if err != nil {
		return nil, fmt.Errorf("postgres: lock assistant conversation %s: %w", conversationID, err)
	}
	// The first user message sets the title (≤ 80 chars, clipped).
	if title == nil && msgs[0].Kind == "user" {
		var body struct {
			Text string `json:"text"`
		}
		if json.Unmarshal(msgs[0].Payload, &body) == nil {
			if t := assistant.TruncateTitle(body.Text); t != "" {
				if _, err := tx.Exec(ctx,
					`UPDATE assistant_conversations SET title = $1 WHERE id = $2::uuid`,
					t, conversationID); err != nil {
					return nil, fmt.Errorf("postgres: set assistant conversation title: %w", err)
				}
			}
		}
	}
	out := make([]api.AssistantMessage, 0, len(msgs))
	for _, m := range msgs {
		var row api.AssistantMessage
		err := tx.QueryRow(ctx,
			`INSERT INTO assistant_messages (conversation_id, kind, payload)
			 VALUES ($1::uuid, $2, $3)
			 RETURNING id::text, kind, payload, created_at`,
			conversationID, m.Kind, m.Payload).
			Scan(&row.ID, &row.Kind, &row.Payload, &row.CreatedAt)
		if err != nil {
			return nil, fmt.Errorf("postgres: append assistant message: %w", err)
		}
		out = append(out, row)
	}
	if _, err := tx.Exec(ctx,
		`UPDATE assistant_conversations SET updated_at = now(), last_message_at = now()
		 WHERE id = $1::uuid`, conversationID); err != nil {
		return nil, fmt.Errorf("postgres: refresh assistant conversation %s: %w", conversationID, err)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("postgres: commit assistant turn: %w", err)
	}
	return out, nil
}

// ListMessages pages the caller's transcript oldest first, ordered by
// (created_at, id) — the ADR's append-only ordering. The cursor is a
// strict (created_at, id) position.
func (s *AssistantConversationStore) ListMessages(ctx context.Context,
	userID, conversationID string, limit int, cursor api.AssistantListCursor) ([]api.AssistantMessage, string, error) {
	if s == nil || s.Pool == nil {
		return nil, "", errors.New("postgres: assistant conversation store has no pool")
	}
	limit = assistantLimit(limit)
	var args []any = []any{conversationID, userID}
	where := "WHERE m.conversation_id = $1::uuid " +
		"AND EXISTS (SELECT 1 FROM assistant_conversations c " +
		"WHERE c.id = m.conversation_id AND c.user_id = $2::uuid)"
	if cursor.Has && cursor.After != nil {
		args = append(args, *cursor.After, cursor.AfterID)
		where += " AND (m.created_at > $3::timestamptz OR (m.created_at = $3::timestamptz AND m.id > $4::uuid))"
	}
	rows, err := s.Pool.Query(ctx,
		"SELECT m.id::text, m.kind, m.payload, m.created_at "+
			"FROM assistant_messages m "+where+" "+
			"ORDER BY m.created_at, m.id LIMIT "+fmt.Sprint(limit+1),
		args...)
	if err != nil {
		return nil, "", fmt.Errorf("postgres: list assistant messages of %s: %w", conversationID, err)
	}
	defer rows.Close()
	var out []api.AssistantMessage
	for rows.Next() {
		var row api.AssistantMessage
		if err := rows.Scan(&row.ID, &row.Kind, &row.Payload, &row.CreatedAt); err != nil {
			return nil, "", fmt.Errorf("postgres: scan assistant message: %w", err)
		}
		out = append(out, row)
	}
	if err := rows.Err(); err != nil {
		return nil, "", fmt.Errorf("postgres: list assistant messages of %s: %w", conversationID, err)
	}
	next := ""
	if len(out) > limit {
		tail := out[limit-1]
		out = out[:limit]
		next = api.EncodeAssistantMessageCursor(tail.CreatedAt, tail.ID)
	}
	if out == nil {
		out = []api.AssistantMessage{}
	}
	return out, next, nil
}

// RecentMessages returns the newest transcript rows (newest first) for the
// caller's conversation — the turn runner's history source, bounded to the
// caller's own rows in SQL.
func (s *AssistantConversationStore) RecentMessages(ctx context.Context,
	userID, conversationID string, limit int) ([]api.AssistantMessage, error) {
	if s == nil || s.Pool == nil {
		return nil, errors.New("postgres: assistant conversation store has no pool")
	}
	if limit < 1 {
		limit = AssistantConvDefaultLimit
	}
	rows, err := s.Pool.Query(ctx,
		`SELECT m.id::text, m.kind, m.payload, m.created_at
		 FROM assistant_messages m
		 WHERE m.conversation_id = $1::uuid
		   AND EXISTS (SELECT 1 FROM assistant_conversations c
		               WHERE c.id = m.conversation_id AND c.user_id = $2::uuid)
		 ORDER BY m.created_at DESC, m.id DESC LIMIT `+fmt.Sprint(limit),
		conversationID, userID)
	if err != nil {
		return nil, fmt.Errorf("postgres: recent assistant messages of %s: %w", conversationID, err)
	}
	defer rows.Close()
	var out []api.AssistantMessage
	for rows.Next() {
		var row api.AssistantMessage
		if err := rows.Scan(&row.ID, &row.Kind, &row.Payload, &row.CreatedAt); err != nil {
			return nil, fmt.Errorf("postgres: scan assistant message: %w", err)
		}
		out = append(out, row)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("postgres: recent assistant messages of %s: %w", conversationID, err)
	}
	if out == nil {
		out = []api.AssistantMessage{}
	}
	return out, nil
}

// ListChanges returns the caller's change log for one conversation in
// creation order (uuidv7 is time-ordered). state is open|undone|all (the
// route validates it); the undo_payload itself is never returned — only
// its presence, as `undoable` (ADR-0050 decision 1: the payload is never
// exposed on any read route).
func (s *AssistantConversationStore) ListChanges(ctx context.Context,
	userID, conversationID, state string) ([]api.AssistantChange, error) {
	if s == nil || s.Pool == nil {
		return nil, errors.New("postgres: assistant conversation store has no pool")
	}
	var stateClause string
	switch state {
	case "":
	case "all":
	case "open":
		stateClause = " AND undone_at IS NULL"
	case "undone":
		stateClause = " AND undone_at IS NOT NULL"
	default:
		return nil, fmt.Errorf("postgres: unknown assistant change state %q", state)
	}
	rows, err := s.Pool.Query(ctx,
		`SELECT id::text, kind, target_ref, summary, undo_payload IS NOT NULL, undone_at, created_at
		 FROM assistant_changes
		 WHERE user_id = $1::uuid AND conversation_id = $2::uuid`+stateClause+
			` ORDER BY id`,
		userID, conversationID)
	if err != nil {
		return nil, fmt.Errorf("postgres: list assistant changes of %s: %w", conversationID, err)
	}
	defer rows.Close()
	var out []api.AssistantChange
	for rows.Next() {
		var row api.AssistantChange
		if err := rows.Scan(&row.ID, &row.Kind, &row.TargetRef, &row.Summary,
			&row.Undoable, &row.UndoneAt, &row.CreatedAt); err != nil {
			return nil, fmt.Errorf("postgres: scan assistant change: %w", err)
		}
		out = append(out, row)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("postgres: list assistant changes of %s: %w", conversationID, err)
	}
	if out == nil {
		out = []api.AssistantChange{}
	}
	return out, nil
}

// InsertChange records one assistant-scoped mutation (ADR-0050 decision 5):
// the part-2 tools call it in the SAME transaction as the underlying
// service mutation. projectID is NULL for org-level actions; undoPayload
// is the server's own closed inverse record (NULL when not undoable).
func (s *AssistantConversationStore) InsertChange(ctx context.Context,
	userID, conversationID string, projectID *string, kind, targetRef, summary string,
	undoPayload []byte) (api.AssistantChange, error) {
	if s == nil || s.Pool == nil {
		return api.AssistantChange{}, errors.New("postgres: assistant conversation store has no pool")
	}
	var row api.AssistantChange
	err := s.Pool.QueryRow(ctx,
		`INSERT INTO assistant_changes (conversation_id, user_id, project_id, kind,
		                                target_ref, summary, undo_payload)
		 VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7)
		 RETURNING id::text, kind, target_ref, summary,
		           undo_payload IS NOT NULL, undone_at, created_at`,
		conversationID, userID, projectID, kind, targetRef, summary, undoPayload).
		Scan(&row.ID, &row.Kind, &row.TargetRef, &row.Summary,
			&row.Undoable, &row.UndoneAt, &row.CreatedAt)
	if err != nil {
		return api.AssistantChange{},
			fmt.Errorf("postgres: insert assistant change in %s: %w", conversationID, err)
	}
	return row, nil
}

// UndoChange applies one change's recorded inverse op and stamps undone_at
// in ONE transaction (ADR-0050 decision 5): a change that is not the
// caller's is not found; an already-undone or payload-less change and a
// failed inverse op are all reported as not-undoable, and the draft is
// left untouched (the Undoer runs before the stamp, inside the
// transaction).
func (s *AssistantConversationStore) UndoChange(ctx context.Context,
	c assistant.Caller, changeID string) (api.AssistantChange, error) {
	return s.undoOne(ctx, c, changeID)
}

// undoOne is UndoChange's body: one transaction per attempt, so undo-all
// can run it row by row with one failure never blocking the next.
func (s *AssistantConversationStore) undoOne(ctx context.Context,
	c assistant.Caller, changeID string) (api.AssistantChange, error) {
	if s == nil || s.Pool == nil {
		return api.AssistantChange{}, errors.New("postgres: assistant conversation store has no pool")
	}
	tx, err := s.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return api.AssistantChange{}, fmt.Errorf("postgres: begin assistant undo: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }() // a no-op after commit

	var ch api.AssistantChange
	var undoPayload []byte
	err = tx.QueryRow(ctx,
		`SELECT id::text, kind, target_ref, summary, undo_payload, undone_at, created_at
		 FROM assistant_changes WHERE id = $1::uuid AND user_id = $2::uuid FOR UPDATE`,
		changeID, c.UserID).
		Scan(&ch.ID, &ch.Kind, &ch.TargetRef, &ch.Summary, &undoPayload, &ch.UndoneAt, &ch.CreatedAt)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		return api.AssistantChange{}, fmt.Errorf("%w: assistant change %s",
			api.ErrAssistantChangeNotFound, changeID)
	case err != nil:
		return api.AssistantChange{}, fmt.Errorf("postgres: load assistant change %s: %w", changeID, err)
	}
	ch.Undoable = undoPayload != nil
	if ch.UndoneAt != nil {
		return api.AssistantChange{}, fmt.Errorf("%w: assistant change %s",
			api.ErrAssistantChangeAlreadyUndone, changeID)
	}
	if undoPayload == nil {
		return api.AssistantChange{}, fmt.Errorf("%w: assistant change %s has no recorded inverse op",
			api.ErrAssistantChangeNotUndoable, changeID)
	}
	if s.Undoer == nil {
		// Fail closed: a deployment with no Undoer wired must not stamp a
		// change undone without applying its inverse.
		return api.AssistantChange{}, &api.AssistantChangeNotUndoable{
			Detail: "no undoer is wired into this deployment",
		}
	}
	if err := s.Undoer.UndoChange(ctx, c, changeID, json.RawMessage(undoPayload)); err != nil {
		return api.AssistantChange{}, &api.AssistantChangeNotUndoable{
			Detail: assistantBounded(err.Error()),
		}
	}
	now := time.Now().UTC()
	if _, err := tx.Exec(ctx,
		`UPDATE assistant_changes SET undone_at = $1 WHERE id = $2::uuid`,
		now, changeID); err != nil {
		return api.AssistantChange{},
			fmt.Errorf("postgres: stamp assistant change %s undone: %w", changeID, err)
	}
	if err := tx.Commit(ctx); err != nil {
		return api.AssistantChange{}, fmt.Errorf("postgres: commit assistant undo: %w", err)
	}
	ch.UndoneAt = &now
	return ch, nil
}

// UndoAll undoes every still-open change of the caller's conversation,
// newest first (ADR-0050 decision 2): one independent attempt per row,
// collected into results — a failed row never blocks the next, and an
// undone row is reported as already_undone rather than an error.
func (s *AssistantConversationStore) UndoAll(ctx context.Context,
	c assistant.Caller, conversationID string) ([]api.ChangeUndoResult, error) {
	if s == nil || s.Pool == nil {
		return nil, errors.New("postgres: assistant conversation store has no pool")
	}
	var convID string
	err := s.Pool.QueryRow(ctx,
		`SELECT id::text FROM assistant_conversations WHERE id = $1::uuid AND user_id = $2::uuid`,
		conversationID, c.UserID).Scan(&convID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, fmt.Errorf("%w: assistant conversation %s",
			api.ErrAssistantConversationNotFound, conversationID)
	}
	if err != nil {
		return nil, fmt.Errorf("postgres: load assistant conversation %s: %w", conversationID, err)
	}
	rows, err := s.Pool.Query(ctx,
		`SELECT id::text, undo_payload IS NOT NULL
		 FROM assistant_changes
		 WHERE user_id = $1::uuid AND conversation_id = $2::uuid AND undone_at IS NULL
		 ORDER BY id DESC`,
		c.UserID, conversationID)
	if err != nil {
		return nil, fmt.Errorf("postgres: list assistant changes of %s: %w", conversationID, err)
	}
	defer rows.Close()
	type openChange struct {
		id       string
		undoable bool
	}
	var open []openChange
	for rows.Next() {
		var oc openChange
		if err := rows.Scan(&oc.id, &oc.undoable); err != nil {
			return nil, fmt.Errorf("postgres: scan assistant change: %w", err)
		}
		open = append(open, oc)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("postgres: list assistant changes of %s: %w", conversationID, err)
	}
	out := make([]api.ChangeUndoResult, 0, len(open))
	for _, oc := range open {
		if !oc.undoable {
			out = append(out, api.ChangeUndoResult{ChangeID: oc.id, Status: "not_undoable"})
			continue
		}
		ch, err := s.undoOne(ctx, c, oc.id)
		switch {
		case err == nil:
			out = append(out, api.ChangeUndoResult{ChangeID: ch.ID, Status: "undone"})
		case errors.Is(err, api.ErrAssistantChangeAlreadyUndone),
			errors.Is(err, api.ErrAssistantChangeNotFound):
			// The row was undone (or removed) between the list and this
			// attempt: report it, do not fail the sweep.
			out = append(out, api.ChangeUndoResult{ChangeID: oc.id, Status: "already_undone"})
		default:
			var ne *api.AssistantChangeNotUndoable
			if errors.As(err, &ne) && ne.Detail != "" {
				out = append(out, api.ChangeUndoResult{
					ChangeID: oc.id, Status: "failed", Error: ne.Detail,
				})
				continue
			}
			out = append(out, api.ChangeUndoResult{
				ChangeID: oc.id, Status: "failed", Error: assistantBounded(err.Error()),
			})
		}
	}
	return out, nil
}

// GetMessage loads one transcript row the caller owns; a row that is not
// the caller's (or the conversation's) is not found.
func (s *AssistantConversationStore) GetMessage(ctx context.Context,
	userID, conversationID, messageID string) (api.AssistantMessage, error) {
	if s == nil || s.Pool == nil {
		return api.AssistantMessage{}, errors.New("postgres: assistant conversation store has no pool")
	}
	var row api.AssistantMessage
	err := s.Pool.QueryRow(ctx,
		`SELECT m.id::text, m.kind, m.payload, m.created_at
		 FROM assistant_messages m
		 JOIN assistant_conversations c ON c.id = m.conversation_id
		 WHERE m.id = $1::uuid AND c.id = $2::uuid AND c.user_id = $3::uuid`,
		messageID, conversationID, userID).
		Scan(&row.ID, &row.Kind, &row.Payload, &row.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return api.AssistantMessage{}, fmt.Errorf("%w: assistant message %s",
			api.ErrAssistantMessageNotFound, messageID)
	}
	if err != nil {
		return api.AssistantMessage{}, fmt.Errorf("postgres: load assistant message %s: %w", messageID, err)
	}
	return row, nil
}

// AppendTurn appends ONE turn's rows in ONE transaction (ADR-0050
// decision 2): the user row first, then the assistant row, one `change`
// message per recorded mutation (the change row's own id fills the
// payload, which is why the message bodies are built here), then the
// question row and the approval_request row — decision 3's order. The
// first user message sets the title, and the caller's plain-text reply
// stamps the newest unanswered question's answered_by in the SAME
// transaction (decision 3's in-place update).
func (s *AssistantConversationStore) AppendTurn(ctx context.Context,
	userID, conversationID string, in api.AppendTurnInput) ([]api.AssistantMessage, error) {
	if s == nil || s.Pool == nil {
		return nil, errors.New("postgres: assistant conversation store has no pool")
	}
	if in.User == nil {
		return nil, errors.New("postgres: an assistant turn needs its user row")
	}
	tx, err := s.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, fmt.Errorf("postgres: begin assistant turn: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }() // a no-op after commit

	var title *string
	err = tx.QueryRow(ctx,
		`SELECT title FROM assistant_conversations
		 WHERE id = $1::uuid AND user_id = $2::uuid FOR UPDATE`,
		conversationID, userID).Scan(&title)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, fmt.Errorf("%w: assistant conversation %s",
			api.ErrAssistantConversationNotFound, conversationID)
	}
	if err != nil {
		return nil, fmt.Errorf("postgres: lock assistant conversation %s: %w", conversationID, err)
	}

	var out []api.AssistantMessage
	appendMsg := func(kind string, payload []byte) error {
		var row api.AssistantMessage
		err := tx.QueryRow(ctx,
			`INSERT INTO assistant_messages (conversation_id, kind, payload)
			 VALUES ($1::uuid, $2, $3)
			 RETURNING id::text, kind, payload, created_at`,
			conversationID, kind, payload).
			Scan(&row.ID, &row.Kind, &row.Payload, &row.CreatedAt)
		if err != nil {
			return fmt.Errorf("postgres: append assistant %s message: %w", kind, err)
		}
		out = append(out, row)
		return nil
	}

	// The user row first: its id is the question's answered_by target.
	if err := appendMsg(in.User.Kind, in.User.Payload); err != nil {
		return nil, err
	}
	userIDRow := out[len(out)-1].ID
	if title == nil {
		var body struct {
			Text string `json:"text"`
		}
		if json.Unmarshal(in.User.Payload, &body) == nil {
			if t := assistant.TruncateTitle(body.Text); t != "" {
				if _, err := tx.Exec(ctx,
					`UPDATE assistant_conversations SET title = $1 WHERE id = $2::uuid`,
					t, conversationID); err != nil {
					return nil, fmt.Errorf("postgres: set assistant conversation title: %w", err)
				}
			}
		}
	}
	// The caller's plain-text reply answers the newest unanswered
	// question (decision 3: replies are always plain-text user messages,
	// so the next turn's user row IS the answer).
	if _, err := tx.Exec(ctx,
		`UPDATE assistant_messages
		 SET payload = jsonb_set(payload, '{answered_by}', to_jsonb($2::text))
		 WHERE id = (SELECT id FROM assistant_messages
		              WHERE conversation_id = $1::uuid AND kind = 'question'
		        AND payload->>'answered_by' IS NULL
		        ORDER BY created_at DESC, id DESC LIMIT 1)`,
		conversationID, userIDRow); err != nil {
		return nil, fmt.Errorf("postgres: stamp assistant question answered: %w", err)
	}
	if in.Assistant != nil {
		if err := appendMsg(in.Assistant.Kind, in.Assistant.Payload); err != nil {
			return nil, err
		}
	}
	// The change rows (decision 5: written in the same transaction as the
	// turn) and their transcript messages.
	for i := range in.Changes {
		var row api.AssistantChange
		err := tx.QueryRow(ctx,
			`INSERT INTO assistant_changes (conversation_id, user_id, project_id, kind,
			                                target_ref, summary, undo_payload)
			 VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7)
			 RETURNING id::text, kind, target_ref, summary,
		           undo_payload IS NOT NULL, undone_at, created_at`,
			conversationID, userID, in.Changes[i].ProjectID, in.Changes[i].Kind,
			in.Changes[i].TargetRef, in.Changes[i].Summary, in.Changes[i].UndoPayload).
			Scan(&row.ID, &row.Kind, &row.TargetRef, &row.Summary,
				&row.Undoable, &row.UndoneAt, &row.CreatedAt)
		if err != nil {
			return nil, fmt.Errorf("postgres: insert assistant change: %w", err)
		}
		payload, err := json.Marshal(map[string]any{
			"kind":        "change",
			"change_id":   row.ID,
			"change_kind": row.Kind,
			"target_ref":  row.TargetRef,
			"summary":     row.Summary,
			"undoable":    row.Undoable,
		})
		if err != nil {
			return nil, fmt.Errorf("postgres: build assistant change message: %w", err)
		}
		if err := appendMsg("change", payload); err != nil {
			return nil, err
		}
	}
	if in.Question != nil {
		if err := appendMsg(in.Question.Kind, in.Question.Payload); err != nil {
			return nil, err
		}
	}
	if in.Approval != nil {
		if err := appendMsg(in.Approval.Kind, in.Approval.Payload); err != nil {
			return nil, err
		}
	}
	if _, err := tx.Exec(ctx,
		`UPDATE assistant_conversations SET updated_at = now(), last_message_at = now()
		 WHERE id = $1::uuid`, conversationID); err != nil {
		return nil, fmt.Errorf("postgres: refresh assistant conversation %s: %w", conversationID, err)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("postgres: commit assistant turn: %w", err)
	}
	return out, nil
}

// CompleteApproval resolves one approval_request row (ADR-0050 decision 2)
// in ONE transaction: the row must exist in the caller's conversation and
// be state=pending (else the approval_request_not_pending sentinel — an
// unknown id answers the same 409 so a probe cannot enumerate request
// ids), its state moves pending -> confirmed|dismissed (the in-place
// update decision 1 allows), and the acknowledgement message plus the
// change row the confirmed action logged are appended.
func (s *AssistantConversationStore) CompleteApproval(ctx context.Context,
	userID, conversationID, messageID, state string,
	ack api.AssistantMessageInput, change *api.AssistantChangeInput) ([]api.AssistantMessage, error) {
	if s == nil || s.Pool == nil {
		return nil, errors.New("postgres: assistant conversation store has no pool")
	}
	if state != "confirmed" && state != "dismissed" {
		return nil, errors.New("postgres: unknown assistant approval state " + state)
	}
	notPending := func() error {
		return fmt.Errorf("%w: assistant approval request %s",
			api.ErrAssistantApprovalNotPending, messageID)
	}
	tx, err := s.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, fmt.Errorf("postgres: begin assistant approval: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }() // a no-op after commit

	if err := tx.QueryRow(ctx,
		`SELECT 1 FROM assistant_conversations
		 WHERE id = $1::uuid AND user_id = $2::uuid FOR UPDATE`,
		conversationID, userID).Scan(new(int)); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, fmt.Errorf("%w: assistant conversation %s",
				api.ErrAssistantConversationNotFound, conversationID)
		}
		return nil, fmt.Errorf("postgres: lock assistant conversation %s: %w", conversationID, err)
	}
	var kind, msgState string
	var payload []byte
	err = tx.QueryRow(ctx,
		`SELECT kind, payload->>'state', payload FROM assistant_messages
		 WHERE id = $1::uuid AND conversation_id = $2::uuid FOR UPDATE`,
		messageID, conversationID).Scan(&kind, &msgState, &payload)
	if errors.Is(err, pgx.ErrNoRows) || kind != "approval_request" || msgState != "pending" {
		return nil, notPending()
	}
	if err != nil {
		return nil, fmt.Errorf("postgres: lock assistant approval request %s: %w", messageID, err)
	}
	if _, err := tx.Exec(ctx,
		`UPDATE assistant_messages SET payload = jsonb_set(payload, '{state}', to_jsonb($2::text))
		 WHERE id = $1::uuid`, messageID, state); err != nil {
		return nil, fmt.Errorf("postgres: update assistant approval state: %w", err)
	}
	var out []api.AssistantMessage
	appendMsg := func(m api.AssistantMessageInput) error {
		var row api.AssistantMessage
		err := tx.QueryRow(ctx,
			`INSERT INTO assistant_messages (conversation_id, kind, payload)
			 VALUES ($1::uuid, $2, $3)
			 RETURNING id::text, kind, payload, created_at`,
			conversationID, m.Kind, m.Payload).
			Scan(&row.ID, &row.Kind, &row.Payload, &row.CreatedAt)
		if err != nil {
			return fmt.Errorf("postgres: append assistant %s message: %w", m.Kind, err)
		}
		out = append(out, row)
		return nil
	}
	if err := appendMsg(ack); err != nil {
		return nil, err
	}
	if change != nil {
		var row api.AssistantChange
		err := tx.QueryRow(ctx,
			`INSERT INTO assistant_changes (conversation_id, user_id, project_id, kind,
			                                target_ref, summary, undo_payload)
			 VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7)
			 RETURNING id::text, kind, target_ref, summary,
		           undo_payload IS NOT NULL, undone_at, created_at`,
			conversationID, userID, change.ProjectID, change.Kind,
			change.TargetRef, change.Summary, change.UndoPayload).
			Scan(&row.ID, &row.Kind, &row.TargetRef, &row.Summary,
				&row.Undoable, &row.UndoneAt, &row.CreatedAt)
		if err != nil {
			return nil, fmt.Errorf("postgres: insert assistant change: %w", err)
		}
		payload, err := json.Marshal(map[string]any{
			"kind":        "change",
			"change_id":   row.ID,
			"change_kind": row.Kind,
			"target_ref":  row.TargetRef,
			"summary":     row.Summary,
			"undoable":    row.Undoable,
		})
		if err != nil {
			return nil, fmt.Errorf("postgres: build assistant change message: %w", err)
		}
		if err := appendMsg(api.AssistantMessageInput{Kind: "change", Payload: payload}); err != nil {
			return nil, err
		}
	}
	if _, err := tx.Exec(ctx,
		`UPDATE assistant_conversations SET updated_at = now(), last_message_at = now()
		 WHERE id = $1::uuid`, conversationID); err != nil {
		return nil, fmt.Errorf("postgres: refresh assistant conversation %s: %w", conversationID, err)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("postgres: commit assistant approval: %w", err)
	}
	return out, nil
}
