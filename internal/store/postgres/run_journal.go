package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"

	"github.com/dbirks/communication/internal/events"
	pevents "github.com/dbirks/communication/internal/pipelines/events"
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
			&env.RunID, &env.NodeExecutionID, &env.AttemptID,
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

// ------------------------------------------------------------------ bridge

// RecordEvent bridges one runtime journal record — the pevents.Record the
// advancer, the worker ops and the reconciler append inside a runtime.State
// — into this package's append vocabulary. Record's contract is explicit:
// the adapter "sets the columns AND serialises Payload". The columns half
// happens here and in the INSERTs (run_id, node_execution_id and attempt_id
// travel as events.New members and as domain_events columns, per the § 3
// correlation rule: a worker row that touches a node execution sets all
// three, a control-plane row may carry node_execution_id with attempt_id
// NULL). The serialisation half is prjPayloadJSON inside the appenders, so
// the payload structs stay owned by internal/events and internal/pipelines/events
// — this store never re-declares a vocabulary, it copies shapes.
//
// A reconciler/advancer row carries ActorKind system with no actor id; the
// envelope's actor.id is NOT NULL, and ADR-0016's implementation note names
// the literal "system" for exactly these rows. A worker row may legitimately
// arrive with an empty id (MemStore's actorWorker leaves it blank): the
// run-scoped adapter resolves it from the attempt's fence owner before the
// append, and anything still blank at append time is refused there, naming
// the record.
func RecordEvent(rec pevents.Record) (runID, nodeExecutionID, attemptID string, ev RunEvent, err error) {
	if vErr := rec.Validate(); vErr != nil {
		return "", "", "", RunEvent{}, vErr
	}
	actorID := rec.ActorID
	if actorID == "" && rec.ActorKind == pevents.ActorKindSystem {
		actorID = "system"
	}
	return rec.RunID, rec.NodeExecutionID, rec.AttemptID, RunEvent{
		Type:      rec.Type,
		ActorKind: rec.ActorKind,
		ActorID:   actorID,
		Payload:   rec.Payload,
	}, nil
}

// AppendRecordTx appends one runtime record inside the caller's transaction.
// A run-scoped record goes through runAppendTx, which resolves
// organization_id and project_id FROM the run row (correlation cannot be
// forged); a pipeline.*/assignment.* record has no run and lands through
// generic AppendEvent with the scope the record itself carries. The three
// correlation ids are taken as given — translating runtime row ids to uuids
// (when a store adapter speaks in ledger rows rather than uuids) is the
// caller's transaction-level job.
func AppendRecordTx(ctx context.Context, tx pgx.Tx, rec pevents.Record) error {
	runID, nodeID, attemptID, ev, err := RecordEvent(rec)
	if err != nil {
		return err
	}
	if runID != "" {
		_, err = runAppendTx(ctx, tx, runID, nodeID, attemptID, ev)
		return err
	}
	if rec.OrganizationID == "" || rec.ProjectID == "" {
		return fmt.Errorf("postgres: %s needs organization_id and project_id to be appended uncorrelated", rec.Type)
	}
	// A record without a run cannot carry node/attempt correlation either
	// (§ 3: the run is what scopes them); leaving the three members empty
	// keeps that honest at the column level.
	_, err = AppendEvent(ctx, tx, events.New{
		Type:           ev.Type,
		OrganizationID: rec.OrganizationID,
		ProjectID:      rec.ProjectID,
		ConversationID: rec.ConversationID,
		Actor:          events.Actor{Kind: ev.ActorKind, ID: ev.ActorID},
		Payload:        ev.Payload,
	})
	return err
}
