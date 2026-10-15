// Package events defines the durable event envelope shared by the
// `domain_events` journal, the `outbox` and the project SSE stream
// (communication-spec/09-api-events-data.md "Durable event envelope",
// ADR-0014).
//
// The envelope shape is fixed by api/schemas/event-envelope.schema.json and
// the JSON field names here must match it exactly; events_test.go checks them
// against the schema file rather than against a hand-copied list. Payload
// shapes are per event type and are not modelled here — a payload is written
// as JSON and read back unmodified.
package events

import "time"

// Actor is the "who" of an event. Kind is one of ActorKind* and ID is the
// internal id for humans/agents/workers, an integration key for integrations,
// or the literal "system".
type Actor struct {
	Kind string `json:"kind"`
	ID   string `json:"id"`
}

// Actor kinds allowed by the journal's check constraint and the envelope
// schema's enum.
const (
	ActorKindHuman       = "human"
	ActorKindSystem      = "system"
	ActorKindAgent       = "agent"
	ActorKindIntegration = "integration"
	ActorKindWorker      = "worker"
)

// Human returns the actor for a signed-in user.
func Human(userID string) Actor {
	return Actor{Kind: ActorKindHuman, ID: userID}
}

// ValidActorKind reports whether kind is one of the five journal-legal actor
// kinds.
func ValidActorKind(kind string) bool {
	switch kind {
	case ActorKindHuman, ActorKindSystem, ActorKindAgent, ActorKindIntegration, ActorKindWorker:
		return true
	default:
		return false
	}
}

// Envelope is one journal row (and one SSE `data:` frame).
//
// Optional members are omitted from JSON when empty rather than emitted as
// null, which the schema allows because none of them is required. `payload`
// is required by the schema, so it must never be nil: AppendEvent substitutes
// an empty object.
type Envelope struct {
	EventID        string    `json:"event_id"`
	GlobalSeq      int64     `json:"global_seq"`
	Type           string    `json:"type"`
	SchemaVersion  int       `json:"schema_version"`
	OccurredAt     time.Time `json:"occurred_at"`
	OrganizationID string    `json:"organization_id"`
	ProjectID      string    `json:"project_id,omitempty"`
	ConversationID string    `json:"conversation_id,omitempty"`
	Actor          Actor     `json:"actor"`
	TraceID        string    `json:"trace_id,omitempty"`
	Payload        any       `json:"payload"`
}

// New is the input to AppendEvent: everything the database does not generate
// for itself. event_id, global_seq, schema_version and occurred_at are
// assigned by Postgres defaults and returned in the Envelope.
type New struct {
	Type           string
	OrganizationID string
	ProjectID      string
	Actor          Actor
	Payload        any
}

// M1 event types (communication-spec/09-api-events-data.md, M1 design
// contract). Later milestones add run/conversation/agent types here.
const (
	TypeProjectCreated       = "project.created"
	TypeProjectMemberUpdated = "project.member.updated"
	TypeRepositoryAdded      = "repository.added"
)
