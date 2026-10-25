package postgres

// The pool-level bounds that keep a wedged client from pinning the database
// (see Open's constants): every connection this package opens carries a
// server-side idle-in-transaction timeout and statement timeout, so the
// 2026-10-25 lab's failure shape — a goroutine parked with a transaction
// open, holding a journal advisory lock everyone else queues behind — is
// self-healing at the database no matter what the application forgets.

import (
	"strconv"
	"testing"
)

func TestOpenPoolBoundsWedgedTransactions(t *testing.T) {
	ctx := testCtx(t)
	pool, err := Open(ctx, mustMigrate(t))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer pool.Close()

	for name, want := range map[string]int{
		"idle_in_transaction_session_timeout": 30_000,
		"statement_timeout":                   60_000,
	} {
		var setting string
		var unit *string
		if err := pool.QueryRow(ctx,
			`SELECT setting, unit FROM pg_settings WHERE name = $1`, name).Scan(&setting, &unit); err != nil {
			t.Fatalf("read %s: %v", name, err)
		}
		if unit == nil || *unit != "ms" {
			t.Fatalf("%s: unexpected unit %v", name, unit)
		}
		got, cerr := strconv.Atoi(setting)
		if cerr != nil {
			t.Fatalf("parse %s = %q: %v", name, setting, cerr)
		}
		if got != want {
			t.Errorf("%s = %d ms, want %d ms", name, got, want)
		}
	}
}
