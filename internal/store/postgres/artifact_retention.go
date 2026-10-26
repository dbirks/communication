package postgres

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Retention-side guard for ADR-0020 D2's 2026-10-27 amendment (migration
// 00019): artifact dedupe is OWNER-SCOPED, so several rows may now reference
// the SAME content-addressed storage key on purpose — identical bytes
// published by two runs are two rows over one object. That makes byte
// deletion a reference-counted operation:
//
//	Bytes are deletable exactly when no non-deleted artifacts row still names
//	their storage key.
//
// No reconciler pass deletes artifact bytes today (the reconciler has no
// artifact pass; artifacts.Store.Delete has no production caller), so nothing
// can violate the rule yet. This helper is the guard any retention, expiry or
// orphan sweep MUST consult before calling Store.Delete — deleting bytes
// because "this one row expired" would silently corrupt every other live
// artifact sharing the key, which is content addressing's whole point. A
// backend-wide sweep over objects (the "bytes with no row at all" pass the
// ADR describes) must likewise build its live-key set from
// ArtifactsReferencingBytes rather than from the single row it just deleted.
//
// `exceptIDs` names the rows this sweep has already transitioned to `deleted`
// in its own transaction — they stop being references at that moment, so the
// caller passes them and this read agrees with the caller's own view even
// before the commit. Rows at `uploading` or `orphan` DO count: an orphan row
// is a pending byte deletion over the same key, and two rows sharing a key
// must expire together, not steal each other's bytes.
func BytesStillReferenced(ctx context.Context, pool *pgxpool.Pool, storageKey string, exceptIDs []string) (bool, error) {
	if storageKey == "" {
		return false, fmt.Errorf("postgres: bytes-still-referenced needs a storage key")
	}
	if exceptIDs == nil {
		// A NULL uuid[] would make `NOT (id = ANY(NULL))` NULL and silence every
		// row; an empty array is the honest "nothing is being excepted".
		exceptIDs = []string{}
	}
	var live bool
	if err := pool.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM artifacts
			WHERE storage_key = $1
			  AND state <> 'deleted'
			  AND NOT (id = ANY($2::uuid[]))
		)`, storageKey, exceptIDs).Scan(&live); err != nil {
		return false, fmt.Errorf("postgres: check byte references for %q: %w", storageKey, err)
	}
	return live, nil
}

// ArtifactsReferencingBytes lists the non-deleted rows sharing one storage key
// (excluding exceptIDs, same rules as BytesStillReferenced). The object-level
// orphan sweep uses it to decide what is unreferenced; the listing is also
// what makes "delete the expired row but keep the bytes" observable in a
// test: a row can go to `deleted` while its key survives here.
func ArtifactsReferencingBytes(ctx context.Context, pool *pgxpool.Pool, storageKey string, exceptIDs []string) ([]string, error) {
	if storageKey == "" {
		return nil, fmt.Errorf("postgres: artifacts-referencing-bytes needs a storage key")
	}
	if exceptIDs == nil {
		exceptIDs = []string{}
	}
	rows, err := pool.Query(ctx, `
		SELECT id::text FROM artifacts
		WHERE storage_key = $1
		  AND state <> 'deleted'
		  AND NOT (id = ANY($2::uuid[]))
		ORDER BY created_at, id`, storageKey, exceptIDs)
	if err != nil {
		return nil, fmt.Errorf("postgres: list byte references for %q: %w", storageKey, err)
	}
	defer rows.Close()
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, fmt.Errorf("postgres: scan byte references: %w", err)
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("postgres: read byte references: %w", err)
	}
	return ids, nil
}
