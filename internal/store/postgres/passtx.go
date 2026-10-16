package postgres

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// pgRunner is the read surface a *pgxpool.Pool and a pgx.Tx share, so one
// helper answers "read this, on whichever transaction owns the moment".
type pgRunner interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
}

// passTxKey carries the advancer pass's transaction to the capabilities the
// advancer calls INSIDE a pass — the runtime.ChildResolver above all.
//
// Why it has to be the pass's own transaction: RuntimeStore.settleTx holds
// pg_advisory_xact_lock plus SELECT ... FOR UPDATE on the parent run row for
// the whole pass, and a child run's parent_run_id foreign key takes KEY SHARE
// on that same row. A child resolver that opened its own transaction on another
// pool connection therefore waits for the parent pass to commit while the
// parent pass waits for the resolver to return — an unbreakable wait, not a
// race. It is also the honest scope: contract § 5.5's "the target revision is
// resolved at run start" and ADR-0023 § 10's child run are ONE fact with the
// parent's node-execution rows, so a pass that aborts leaves neither half
// behind, and a retried pass cannot spawn a second child.
//
// The runtime package must not learn about pgx (dependency rule), so the tx
// rides the context the deployment hands AdvancerDeps.Context rather than a
// ChildResolver parameter. A resolver with no pass (a direct API call, the
// reconciler, a unit script) gets false and keeps using the pool.
type passTxKey struct{}

// withPassTx marks ctx as carrying the transaction that owns this pass.
func withPassTx(ctx context.Context, tx pgx.Tx) context.Context {
	if tx == nil {
		return ctx
	}
	return context.WithValue(ctx, passTxKey{}, tx)
}

// passTx returns the transaction that owns this call, if one does.
func passTx(ctx context.Context) (pgx.Tx, bool) {
	tx, ok := ctx.Value(passTxKey{}).(pgx.Tx)
	return tx, ok && tx != nil
}

// runOn answers "which executor reads this call": the pass's transaction when
// the call is inside a pass, the pool otherwise.
func runOn(ctx context.Context, pool *pgxpool.Pool) pgRunner {
	if tx, ok := passTx(ctx); ok {
		return tx
	}
	if pool == nil {
		return nilPoolGuard{}
	}
	return pool
}

// nilPoolGuard keeps a store built without a pool honest: it fails the read
// with the missing pool named instead of panicking on a nil interface.
type nilPoolGuard struct{}

func (nilPoolGuard) QueryRow(context.Context, string, ...any) pgx.Row {
	return errRow{fmt.Errorf("postgres: this store has no pool and no pass transaction")}
}

func (nilPoolGuard) Query(context.Context, string, ...any) (pgx.Rows, error) {
	return nil, fmt.Errorf("postgres: this store has no pool and no pass transaction")
}

type errRow struct{ err error }

func (r errRow) Scan(...any) error { return r.err }

var (
	_ pgRunner = pgx.Tx(nil)
	_ pgRunner = (*pgxpool.Pool)(nil)
	_ pgRunner = nilPoolGuard{}
)
