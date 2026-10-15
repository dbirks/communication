package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/dbirks/communication/internal/api"
	"github.com/dbirks/communication/internal/events"
)

// prjEventColumns is the single read-back projection used for both journal
// reads and AppendEvent's RETURNING clause. Nullable members are COALESCEd to
// ” so they can be scanned into strings: an absent project_id and an empty
// one mean the same thing to every caller in M1.
const prjEventColumns = `global_seq, event_id, type, schema_version, occurred_at,
	organization_id, COALESCE(project_id::text, ''), COALESCE(conversation_id::text, ''),
	actor_kind, actor_id, COALESCE(trace_id, ''), payload`

// evtAppendLockPrefix namespaces the advisory-lock keys that serialize journal
// appends (ADR-0014 §9). The key is derived from the project (or organization,
// for project-less events) with hashtextextended, so appends to different
// projects do not contend with each other. A hash collision across two
// projects would only cost redundant serialization, never correctness.
const evtAppendLockPrefix = "communication.domain_events.append/"

// evtJournalSQL is the one statement the SSE reader may use: it filters
// through the project (so a forged cursor cannot walk another project's
// journal), resumes above the caller's cursor, and refuses to emit any row
// whose inserting transaction was not already determined when this statement's
// snapshot was taken.
//
// pg_current_snapshot() inside a READ COMMITTED statement is that statement's
// own snapshot, so the filter and the scan cannot disagree.
const evtJournalSQL = `
	SELECT ` + prjEventColumns + `
	FROM domain_events e
	WHERE e.project_id = $1::uuid
	  AND e.global_seq > $2
	  AND e.tx_id < pg_snapshot_xmin(pg_current_snapshot())
	ORDER BY e.global_seq
	LIMIT $3`

// cnvConversationEventsSQL is the conversation-scoped journal read behind
// GET /api/v1/conversations/{conversationId}/events (ADR-0016). It is the
// project read narrowed by conversation_id, with the gap-safety clause kept
// verbatim: the transcript and the project timeline share one journal, one
// global_seq cursor and one commit-order argument (ADR-0014 §9), so the
// conversation stream may not weaken any part of it — dropping the tx_id
// filter would make a late committer invisible to the transcript forever.
//
// The cursor is resolved *through* the conversation scope, so a
// Last-Event-ID copied from another conversation or project replays nothing it
// should not. project_id is repeated in the predicate because the conversation
// route's authorization scope is the owning project: a row that somehow names
// another project is never delivered on this stream.
const cnvConversationEventsSQL = `
	SELECT ` + prjEventColumns + `
	FROM domain_events e
	WHERE e.conversation_id = $1::uuid
	  AND e.project_id = $2::uuid
	  AND e.global_seq > $3
	  AND e.tx_id < pg_snapshot_xmin(pg_current_snapshot())
	ORDER BY e.global_seq
	LIMIT $4`

// LockEventJournal acquires the transaction-scoped advisory lock that orders
// journal appends, holding it to COMMIT. ADOPT IT AS THE FIRST statement of any
// transaction that will AppendEvent when the project id is already known.
//
// The lock is re-acquired inside AppendEvent, so callers that forget are still
// ordered; acquiring it early additionally keeps the commit order of a
// project's transactions aligned with the sequence values they consume, which
// is what makes a naive "global_seq > cursor" reader gap-free (§9).
func LockEventJournal(ctx context.Context, tx pgx.Tx, projectID, organizationID string) error {
	if tx == nil {
		return errors.New("postgres: LockEventJournal requires a transaction")
	}
	if _, err := tx.Exec(ctx,
		`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, evtLockKey(projectID, organizationID)); err != nil {
		return fmt.Errorf("postgres: lock event journal: %w", err)
	}
	return nil
}

// evtLockKey is the advisory-lock target for an append: its project, falling
// back to the organization for project-less (later milestone) events.
func evtLockKey(projectID, organizationID string) string {
	if projectID != "" {
		return evtAppendLockPrefix + projectID
	}
	return evtAppendLockPrefix + "org/" + organizationID
}

// AppendEvent inserts one row into the durable journal and one row into the
// outbox that will later drive delivery, and must be called inside the same
// transaction as the state change it describes
// (communication-spec/09-api-events-data.md: "one SQL transaction updates
// authoritative state, appends event and outbox notification"). It returns
// the envelope as the database wrote it, so callers use the real global_seq
// and occurred_at rather than their own clocks.
//
// The journal itself assigns event_id, global_seq, schema_version and
// occurred_at (see migrations/00001_m1_core.sql), which is why events.New
// carries only the parts the caller knows.
//
// AppendEvent first takes the per-project advisory lock described by
// LockEventJournal, guaranteeing that within one project a row cannot consume
// a global_seq until every row with a smaller sequence value has already
// committed or aborted (ADR-0014 §9).
func AppendEvent(ctx context.Context, tx pgx.Tx, e events.New) (events.Envelope, error) {
	if tx == nil {
		return events.Envelope{}, errors.New("postgres: AppendEvent requires a transaction")
	}
	if e.Type == "" {
		return events.Envelope{}, errors.New("postgres: AppendEvent requires an event type")
	}
	if e.OrganizationID == "" {
		return events.Envelope{}, errors.New("postgres: AppendEvent requires an organization id")
	}
	if !events.ValidActorKind(e.Actor.Kind) {
		return events.Envelope{}, fmt.Errorf("postgres: AppendEvent actor kind %q is not allowed", e.Actor.Kind)
	}
	if e.Actor.ID == "" {
		return events.Envelope{}, errors.New("postgres: AppendEvent requires an actor id")
	}
	payload, err := prjPayloadJSON(e.Payload)
	if err != nil {
		return events.Envelope{}, err
	}
	if err := LockEventJournal(ctx, tx, e.ProjectID, e.OrganizationID); err != nil {
		return events.Envelope{}, err
	}

	var env events.Envelope
	var payloadRaw []byte
	conversationID, err := cnvCleanConversationID(e.ConversationID)
	if err != nil {
		return events.Envelope{}, err
	}
	// conversation_id is listed deliberately (ADR-0016 §9 obligation 1): the
	// column has existed since 00001 but no writer populated it, so an append
	// that set events.New.ConversationID without it produced a transcript row
	// that was invisible to the conversation stream while looking correct in
	// every other read.
	err = tx.QueryRow(ctx, `
		INSERT INTO domain_events (type, organization_id, project_id, conversation_id, actor_kind, actor_id, payload)
		VALUES ($1, $2::uuid, NULLIF($3, '')::uuid, NULLIF($4, '')::uuid, $5, $6, $7::jsonb)
		RETURNING `+prjEventColumns,
		e.Type, e.OrganizationID, prjCleanUUID(e.ProjectID), conversationID,
		e.Actor.Kind, e.Actor.ID, payload).
		Scan(&env.GlobalSeq, &env.EventID, &env.Type, &env.SchemaVersion, &env.OccurredAt,
			&env.OrganizationID, &env.ProjectID, &env.ConversationID,
			&env.Actor.Kind, &env.Actor.ID, &env.TraceID, &payloadRaw)
	if err != nil {
		return events.Envelope{}, fmt.Errorf("postgres: append domain event: %w", err)
	}
	// The payload is carried as raw JSON so an SSE data frame reproduces the
	// stored bytes exactly rather than a re-encoded approximation.
	env.Payload = json.RawMessage(payloadRaw)
	env.OccurredAt = env.OccurredAt.UTC()

	if _, err := tx.Exec(ctx, `
		INSERT INTO outbox (global_seq) VALUES ($1)`, env.GlobalSeq); err != nil {
		return events.Envelope{}, fmt.Errorf("postgres: append outbox row: %w", err)
	}
	return env, nil
}

// cnvCleanConversationID validates a conversation scope id the same way
// prjCleanUUID does a project id, so a malformed id lands as a null scope
// (an ordinary project event) rather than a driver syntax error in the middle
// of a committed transaction. It reports an error only for an id that is
// neither empty nor a uuid, which can only be a programming mistake.
func cnvCleanConversationID(s string) (string, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return "", nil
	}
	if !prjValidUUID(s) {
		return "", fmt.Errorf("postgres: conversation id %q is not a uuid", s)
	}
	return strings.ToLower(s), nil
}

// ConversationEventsAfter returns up to limit journal rows of one
// conversation's transcript with global_seq strictly greater than afterSeq,
// oldest first — the replay path behind the conversation SSE stream.
//
// It is a journal read only: visibility is the caller's decision, made by the
// authorized wrapper below and re-made by the handler on every delivery and
// heartbeat, exactly as the project stream does.
func (s *ProjectStore) ConversationEventsAfter(ctx context.Context, conversationID, projectID string, afterSeq int64, limit int) ([]events.Envelope, error) {
	if s == nil || s.Pool == nil {
		return nil, errors.New("postgres: project store has no pool")
	}
	if !prjValidUUID(conversationID) || !prjValidUUID(projectID) {
		return nil, ErrConversationNotFound
	}
	if limit <= 0 {
		limit = prjDefaultEventLimit
	}
	if limit > prjMaxEventLimit {
		limit = prjMaxEventLimit
	}
	rows, err := s.Pool.Query(ctx, cnvConversationEventsSQL, conversationID, projectID, afterSeq, limit)
	if err != nil {
		return nil, fmt.Errorf("postgres: query conversation events: %w", err)
	}
	return evtScanEvents(rows, limit)
}

// VisibleConversationEventsAfter is ConversationEventsAfter behind the
// caller's membership of the conversation's project: an invisible conversation
// (unknown id, or a project the caller is not a member of) is
// ErrConversationNotFound — the same answer the rest of the conversation
// surface gives — so neither the stream nor a forged cursor can probe it.
func (s *ProjectStore) VisibleConversationEventsAfter(ctx context.Context, c Caller, conversationID string, afterSeq int64, limit int) ([]events.Envelope, error) {
	if err := prjRequireCaller(c); err != nil {
		return nil, err
	}
	projectID, _, _, err := cnvResolveProject(ctx, s.Pool, c, conversationID)
	if err != nil {
		return nil, err
	}
	return s.ConversationEventsAfter(ctx, conversationID, projectID, afterSeq, limit)
}

// EventsAfter returns up to limit journal rows for one project with
// global_seq strictly greater than afterSeq, oldest first — the replay path
// behind the SSE stream (ADR-0014). It is a journal read only: project
// visibility is the caller's authorization decision, made before any event is
// handed to a client.
//
// A row is withheld while its inserting transaction might still commit a
// smaller sequence value later, so a caller that commits out of order can
// never make this reader skip a row; the cost is that such a row is delivered
// on a later call once the snapshot has settled
// (migrations/00002_event_order_guarantee.sql, ADR-0014 §9).
func (s *ProjectStore) EventsAfter(ctx context.Context, projectID string, afterSeq int64, limit int) ([]events.Envelope, error) {
	if s == nil || s.Pool == nil {
		return nil, errors.New("postgres: project store has no pool")
	}
	if !prjValidUUID(projectID) {
		return nil, ErrProjectNotFound
	}
	if limit <= 0 {
		limit = prjDefaultEventLimit
	}
	if limit > prjMaxEventLimit {
		limit = prjMaxEventLimit
	}
	rows, err := s.Pool.Query(ctx, evtJournalSQL, projectID, afterSeq, limit)
	if err != nil {
		return nil, fmt.Errorf("postgres: query events: %w", err)
	}
	return evtScanEvents(rows, limit)
}

// VisibleEventsAfter is EventsAfter behind the caller's project visibility: an
// invisible project is ErrProjectNotFound, the same answer the rest of the
// project surface gives, so the SSE route cannot be used to probe existence.
func (s *ProjectStore) VisibleEventsAfter(ctx context.Context, c Caller, projectID string, afterSeq int64, limit int) ([]events.Envelope, error) {
	if err := prjRequireCaller(c); err != nil {
		return nil, err
	}
	if _, err := prjGetProject(ctx, s.Pool, c, projectID); err != nil {
		return nil, err
	}
	return s.EventsAfter(ctx, projectID, afterSeq, limit)
}

// evtScanEvents drains a journal result set into envelopes.
func evtScanEvents(rows pgx.Rows, limit int) ([]events.Envelope, error) {
	defer rows.Close()

	out := make([]events.Envelope, 0, min(limit, 64))
	for rows.Next() {
		var env events.Envelope
		var payloadRaw []byte
		if err := rows.Scan(&env.GlobalSeq, &env.EventID, &env.Type, &env.SchemaVersion,
			&env.OccurredAt, &env.OrganizationID, &env.ProjectID, &env.ConversationID,
			&env.Actor.Kind, &env.Actor.ID, &env.TraceID, &payloadRaw); err != nil {
			return nil, fmt.Errorf("postgres: scan event: %w", err)
		}
		env.Payload = json.RawMessage(payloadRaw)
		env.OccurredAt = env.OccurredAt.UTC()
		out = append(out, env)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("postgres: read events: %w", err)
	}
	return out, nil
}

// Journal read caps: the SSE catch-up loop wants small batches it can re-query
// cheaply, not the whole history.
const (
	prjDefaultEventLimit = 100
	prjMaxEventLimit     = 1000
)

// prjPayloadJSON renders an event payload as jsonb-ready text. A nil payload
// becomes {} because the envelope schema requires the member to be an object.
func prjPayloadJSON(p any) (string, error) {
	switch v := p.(type) {
	case nil:
		return "{}", nil
	case string:
		if strings.TrimSpace(v) == "" {
			return "{}", nil
		}
		return v, nil
	case []byte:
		if len(v) == 0 {
			return "{}", nil
		}
		return string(v), nil
	}
	encoded, err := json.Marshal(p)
	if err != nil {
		return "", fmt.Errorf("postgres: encode event payload: %w", err)
	}
	if string(encoded) == "null" {
		return "{}", nil
	}
	return string(encoded), nil
}

// ---------------------------------------------------------------- wake-ups

// EventWake turns the journal's pg_notify('communication_events') signal into
// wake-ups for every open SSE stream on this replica. It is a hint and
// nothing more: the connection it owns exists only to learn "something was
// inserted", and every consumer re-queries the journal by sequence. If the
// connection dies, wakes simply stop arriving and the consumers' poll interval
// takes over, so a lost or duplicated notification cannot make a stream wrong
// (communication-spec/02: "LISTEN/NOTIFY is only a wake-up optimization").
//
// One connection per replica, not per stream: a replica serving hundreds of
// browsers must not need hundreds of server connections.
type EventWake struct {
	databaseURL string
	log         *slog.Logger

	mu      sync.Mutex
	subs    map[chan struct{}]struct{}
	running bool
	// attached is closed once the current connection has reported LISTEN. Watch
	// waits for it, so an event inserted immediately after subscribing cannot
	// slip through before the LISTEN reached the server.
	attached chan struct{}
	stop     chan struct{}
	once     sync.Once
}

// Wake-up tuning: the listener coalesces notifications into a single pending
// signal per subscriber, reconnects with bounded backoff after a failure, and
// wakes every subscriber once after a reconnect so a notification lost across
// the gap cannot strand a stream.
const (
	evtReconnectMin = 250 * time.Millisecond
	evtReconnectMax = 10 * time.Second
)

// NewEventWake returns an idle wake-up source; it connects on first use.
func NewEventWake(databaseURL string, logger *slog.Logger) *EventWake {
	if logger == nil {
		logger = slog.New(slog.NewTextHandler(io.Discard, nil))
	}
	w := &EventWake{
		databaseURL: databaseURL,
		log:         logger,
		subs:        map[chan struct{}]struct{}{},
		stop:        make(chan struct{}),
	}
	return w
}

// Watch returns a channel signalled (at most once per pending burst) whenever
// the journal may have gained rows, and a function that ends the
// subscription. The channel is closed when the passed context is cancelled or
// Close is called.
func (w *EventWake) Watch(ctx context.Context) (<-chan struct{}, func(), error) {
	if w == nil || w.databaseURL == "" {
		return nil, func() {}, errors.New("postgres: event wake-up source is not configured")
	}
	ch := make(chan struct{}, 1)

	w.mu.Lock()
	w.subs[ch] = struct{}{}
	first := len(w.subs) == 1
	w.mu.Unlock()

	if first {
		w.start(ctx)
	}

	var once sync.Once
	stop := func() {
		once.Do(func() {
			w.mu.Lock()
			delete(w.subs, ch)
			w.mu.Unlock()
			close(ch)
		})
	}

	go func() {
		select {
		case <-ctx.Done():
			stop()
		case <-w.stop:
			stop()
		}
	}()
	return ch, stop, nil
}

// Close ends the listener and every subscription. Open streams see their
// channels close, which the API layer treats as "wake up and finish", so a
// shutdown cannot hang on them.
func (w *EventWake) Close() {
	if w == nil {
		return
	}
	w.once.Do(func() { close(w.stop) })
}

// start launches the listener goroutine once per EventWake and waits (bounded)
// for the LISTEN to be in place. It returns when the listener is attached, when
// the source is closed, when the wait times out, or when the *caller's* context
// ends — a browser that hung up while its stream was being set up must not keep
// the handler waiting for a connection it no longer needs.
func (w *EventWake) start(ctx context.Context) {
	w.mu.Lock()
	att := w.attached
	if !w.running {
		att = make(chan struct{})
		w.attached = att
		w.running = true
		go w.listen(att)
	}
	w.mu.Unlock()

	// A listener that cannot attach (the database is briefly unreachable) must
	// not fail the stream: the caller's poll interval is the fallback, and the
	// wait is bounded so a slow database cannot stall a connect indefinitely.
	select {
	case <-att:
	case <-w.stop:
	case <-ctx.Done():
	case <-time.After(evtAttachTimeout):
		w.log.WarnContext(ctx, "event listener not attached yet",
			slog.String("waited", evtAttachTimeout.String()))
	}
}

// evtAttachTimeout bounds how long Watch waits for the listener to be live.
const evtAttachTimeout = 3 * time.Second

// listen keeps one dedicated connection carrying LISTEN communication_events.
// It never reads the notification payload: the payload is a sequence number,
// and the journal — not the notification — is the source of truth.
func (w *EventWake) listen(attached chan struct{}) {
	var attachOnce sync.Once
	attach := func() { attachOnce.Do(func() { close(attached) }) }
	backoff := evtReconnectMin
	for {
		select {
		case <-w.stop:
			return
		default:
		}

		// Cancelling this context is the only way to interrupt a blocked
		// WaitForNotification, and cancelling it also kills the connection — so it
		// is created per connection and cancelled only when that connection is
		// being torn down (Close, or a failed wait that triggers a reconnect).
		runCtx, cancel := context.WithCancel(context.Background())
		done := make(chan struct{})
		go func() {
			defer cancel()
			select {
			case <-w.stop:
			case <-done:
			}
		}()
		err := w.listenOnce(runCtx, attach)
		close(done)
		cancel()

		select {
		case <-w.stop:
			return
		default:
		}
		w.log.WarnContext(context.Background(), "event listener disconnected",
			slog.String("error", err.Error()), slog.String("retry_in", backoff.String()))
		select {
		case <-w.stop:
			return
		case <-time.After(backoff):
		}
		if backoff *= 2; backoff > evtReconnectMax {
			backoff = evtReconnectMax
		}
		// Wake every stream after a reconnect: notifications that arrived while
		// disconnected were lost, and re-querying by sequence is always safe.
		w.notifyAll()
	}
}

// listenOnce runs one connection's LISTEN loop and returns when it ends.
func (w *EventWake) listenOnce(ctx context.Context, attach func()) error {
	conn, err := pgx.Connect(ctx, w.databaseURL)
	if err != nil {
		return err
	}
	defer func() { _ = conn.Close(context.Background()) }()

	if _, err := conn.Exec(ctx, "LISTEN "+evtNotifyChannel); err != nil {
		return err
	}
	attach()
	w.log.InfoContext(ctx, "event listener attached",
		slog.String("channel", evtNotifyChannel))

	for {
		if _, err := conn.WaitForNotification(ctx); err != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			return err
		}
		w.notifyAll()
	}
}

// notifyAll signals every subscriber without blocking: a subscriber that has
// not consumed the previous wake does not need another one, because its next
// wake re-queries the journal from its own cursor.
func (w *EventWake) notifyAll() {
	w.mu.Lock()
	defer w.mu.Unlock()
	for ch := range w.subs {
		select {
		case ch <- struct{}{}:
		default:
		}
	}
}

// evtNotifyChannel is the channel named by the journal's AFTER INSERT trigger
// (migrations/00001_m1_core.sql).
const evtNotifyChannel = "communication_events"

// -------------------------------------------------------------- api adapter

// APIEventStream exposes the journal and its wake-ups through the interface
// internal/api's SSE handler depends on. Like APIProjectStore it lives here
// because package api must not import this one (AGENTS.md dependency rule).
type APIEventStream struct {
	S     *ProjectStore
	Wakes *EventWake
}

var (
	_ api.EventStream = APIEventStream{}
	_ api.EventStream = (*APIEventStream)(nil)
)

// EventsAfter implements api.EventStream, behind the caller's project
// visibility.
func (a APIEventStream) EventsAfter(ctx context.Context, c api.Caller, projectID string, afterSeq int64, limit int) ([]events.Envelope, error) {
	if a.S == nil || a.S.Pool == nil {
		return nil, errors.New("postgres: event stream has no pool")
	}
	return a.S.VisibleEventsAfter(ctx, prjAPICaller(c), projectID, afterSeq, limit)
}

// Watch implements api.EventStream. Without a wake-up source the handler
// falls back to polling, which is correct but sleepier.
func (a APIEventStream) Watch(ctx context.Context) (<-chan struct{}, func(), error) {
	if a.Wakes == nil {
		return nil, func() {}, nil
	}
	return a.Wakes.Watch(ctx)
}
