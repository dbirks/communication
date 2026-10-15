// Package postgres is the PostgreSQL-backed store for Communication: the
// authoritative operational state (communication-spec/02-system-architecture
// md "Data / infrastructure plan", communication-spec/09-api-events-data.md
// "Database table families").
//
// It owns the pgx connection pool (Open), the embedded goose migrations
// (migrations/*.sql, applied by Migrate) and, in later milestones, the query
// functions for projects, sessions, events and other entities.
package postgres
