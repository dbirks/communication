package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"

	"github.com/dbirks/communication/internal/events"
)

// runAppendTx appends one journal row correlated to the run ledger, inside
// the caller's transaction — state and journal commit or die together
// (ADR-0013/0016). This is the M4 append path: unlike the control-plane
// AppendEvent and the worker's trnAppendTx, it resolves organization_id and
// project_id FROM the run row itself, so correlation cannot be forged
// (contract § 3), and it always stamps the three run-correlation columns
// (00005): run_id always, node_execution_id and attempt_id when the subject
// is narrower.
//
// M4 event payload structs live in internal/events (events_test.go pins the
// member sets); this store takes the payload as `any` precisely so the
// persistence layer never invents a second vocabulary — the dependency rule
// points the other way.
func runAppendTx(ctx context.Context, tx pgx.Tx, runID, nodeExecutionID, attemptID string, ev RunEvent) (events.Envelope, error) {
	if ev.Type == "" {
		return events.Envelope{}, errors.New("postgres: run event requires a type")
	}
	if !events.ValidActorKind(ev.ActorKind) {
		return events.Envelope{}, fmt.Errorf("postgres: run event actor kind %q is not allowed", ev.ActorKind)
	}
	if ev.ActorID == "" {
		return events.Envelope{}, errors.New("postgres: run event requires an actor id")
	}
	var orgID, projectID string
	if err := tx.QueryRow(ctx, `
		SELECT organization_id::text, project_id::text FROM runs WHERE id = $1::uuid`, runID).
		Scan(&orgID, &projectID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return events.Envelope{}, ErrRunNotFound
		}
		return events.Envelope{}, fmt.Errorf("postgres: resolve run %s scope: %w", runID, err)
	}
	payload, err := prjPayloadJSON(ev.Payload)
	if err != nil {
		return events.Envelope{}, err
	}
	if err := LockEventJournal(ctx, tx, projectID, orgID); err != nil {
		return events.Envelope{}, err
	}
	var env events.Envelope
	var payloadRaw []byte
	err = tx.QueryRow(ctx, `
		INSERT INTO domain_events
			(type, organization_id, project_id, actor_kind, actor_id, payload,
			 run_id, node_execution_id, attempt_id)
		VALUES ($1, $2::uuid, $3::uuid, $4, $5, $6::jsonb,
		        $7::uuid, NULLIF($8, '')::uuid, NULLIF($9, '')::uuid)
		RETURNING `+prjEventColumns,
		ev.Type, orgID, projectID, ev.ActorKind, ev.ActorID, payload,
		runID, nodeExecutionID, attemptID).
		Scan(&env.GlobalSeq, &env.EventID, &env.Type, &env.SchemaVersion, &env.OccurredAt,
			&env.OrganizationID, &env.ProjectID, &env.ConversationID,
			&env.Actor.Kind, &env.Actor.ID, &env.TraceID, &payloadRaw)
	if err != nil {
		return events.Envelope{}, fmt.Errorf("postgres: append run event (%s): %w", ev.Type, err)
	}
	env.Payload = json.RawMessage(payloadRaw)
	if _, err := tx.Exec(ctx, `INSERT INTO outbox (global_seq) VALUES ($1)`, env.GlobalSeq); err != nil {
		return events.Envelope{}, fmt.Errorf("postgres: append run event outbox row: %w", err)
	}
	return env, nil
}
