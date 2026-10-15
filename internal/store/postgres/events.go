package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/dbirks/communication/internal/events"
)

// prjEventColumns is the single read-back projection used for both journal
// reads and AppendEvent's RETURNING clause. Nullable members are COALESCEd to
// ” so they can be scanned into strings: an absent project_id and an empty
// one mean the same thing to every caller in M1.
const prjEventColumns = `global_seq, event_id, type, schema_version, occurred_at,
	organization_id, COALESCE(project_id::text, ''), COALESCE(conversation_id::text, ''),
	actor_kind, actor_id, COALESCE(trace_id, ''), payload`

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

	var env events.Envelope
	var payloadRaw []byte
	err = tx.QueryRow(ctx, `
		INSERT INTO domain_events (type, organization_id, project_id, actor_kind, actor_id, payload)
		VALUES ($1, $2::uuid, NULLIF($3, '')::uuid, $4, $5, $6::jsonb)
		RETURNING `+prjEventColumns,
		e.Type, e.OrganizationID, prjCleanUUID(e.ProjectID), e.Actor.Kind, e.Actor.ID, payload).
		Scan(&env.GlobalSeq, &env.EventID, &env.Type, &env.SchemaVersion, &env.OccurredAt,
			&env.OrganizationID, &env.ProjectID, &env.ConversationID,
			&env.Actor.Kind, &env.Actor.ID, &env.TraceID, &payloadRaw)
	if err != nil {
		return events.Envelope{}, fmt.Errorf("postgres: append domain event: %w", err)
	}
	// The payload is carried as raw JSON so an SSE data frame reproduces the
	// stored bytes exactly rather than a re-encoded approximation.
	env.Payload = json.RawMessage(payloadRaw)

	if _, err := tx.Exec(ctx, `
		INSERT INTO outbox (global_seq) VALUES ($1)`, env.GlobalSeq); err != nil {
		return events.Envelope{}, fmt.Errorf("postgres: append outbox row: %w", err)
	}
	return env, nil
}

// EventsAfter returns up to limit journal rows for one project with
// global_seq strictly greater than afterSeq, oldest first — the replay path
// behind the SSE stream (ADR-0014). It is a journal read only: project
// visibility is the caller's authorization decision, made before any event is
// handed to a client.
func (s *ProjectStore) EventsAfter(ctx context.Context, projectID string, afterSeq int64, limit int) ([]events.Envelope, error) {
	if !prjValidUUID(projectID) {
		return nil, ErrProjectNotFound
	}
	if limit <= 0 {
		limit = prjDefaultEventLimit
	}
	if limit > prjMaxEventLimit {
		limit = prjMaxEventLimit
	}
	rows, err := s.Pool.Query(ctx, `
		SELECT `+prjEventColumns+`
		FROM domain_events
		WHERE project_id = $1::uuid AND global_seq > $2
		ORDER BY global_seq
		LIMIT $3`, projectID, afterSeq, limit)
	if err != nil {
		return nil, fmt.Errorf("postgres: query events: %w", err)
	}
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
