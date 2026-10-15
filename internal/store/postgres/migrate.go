package postgres

import (
	"context"
	"database/sql"
	"embed"
	"errors"
	"fmt"
	"io/fs"
	stdlog "log"
	"os"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"
)

//go:embed migrations/*.sql
var migrationFS embed.FS

// migrationsDir is the path inside migrationFS holding the numbered .sql
// migrations.
const migrationsDir = "migrations"

// gooseTable is the goose migration-version table (its default name).
const gooseTable = "goose_db_version"

func init() {
	// Keep goose quiet by default; verbose callers re-enable via
	// setGooseLogging.
	goose.SetLogger(goose.NopLogger())
}

// setGooseLogging configures goose's global logger: silent (no colour, no
// noise) unless verbose.
func setGooseLogging(verbose bool) {
	if verbose {
		goose.SetLogger(stdGooseLogger{stdlog.New(os.Stderr, "goose ", stdlog.LstdFlags)})
		goose.SetVerbose(true)
		return
	}
	goose.SetLogger(goose.NopLogger())
	goose.SetVerbose(false)
}

// stdGooseLogger adapts the stdlib logger to goose's Logger interface.
type stdGooseLogger struct{ l *stdlog.Logger }

func (s stdGooseLogger) Fatalf(format string, v ...any) { s.l.Fatalf(format, v...) }
func (s stdGooseLogger) Printf(format string, v ...any) { s.l.Printf(format, v...) }

// openSQLDB opens a database/sql handle over the pgx stdlib driver and
// verifies connectivity with a bounded ping.
func openSQLDB(ctx context.Context, databaseURL string) (*sql.DB, error) {
	cfg, err := pgx.ParseConfig(databaseURL)
	if err != nil {
		return nil, errors.New("postgres: invalid database URL")
	}
	db := stdlib.OpenDB(*cfg)
	pingCtx, cancel := context.WithTimeout(ctx, pingTimeout)
	defer cancel()
	if err := db.PingContext(pingCtx); err != nil {
		db.Close()
		return nil, fmt.Errorf("postgres: ping database: %w", scrub(err, databaseURL))
	}
	return db, nil
}

// Migrate applies all pending embedded migrations (goose up). It is safe to
// call repeatedly; already-applied migrations are skipped.
func Migrate(ctx context.Context, databaseURL string) error {
	return migrate(ctx, databaseURL, false)
}

// MigrateVerbose is Migrate with goose logging enabled.
func MigrateVerbose(ctx context.Context, databaseURL string) error {
	return migrate(ctx, databaseURL, true)
}

func migrate(ctx context.Context, databaseURL string, verbose bool) error {
	db, err := openSQLDB(ctx, databaseURL)
	if err != nil {
		return err
	}
	defer db.Close()

	setGooseLogging(verbose)
	if err := goose.SetDialect("postgres"); err != nil {
		return fmt.Errorf("postgres: goose dialect: %w", err)
	}
	goose.SetBaseFS(migrationFS)
	if err := goose.UpContext(ctx, db, migrationsDir); err != nil {
		return scrub(fmt.Errorf("postgres: apply migrations: %w", err), databaseURL)
	}
	return nil
}

// SchemaVersion returns the version currently applied in the database, or 0
// when the goose version table does not exist yet. It does not create the
// version table.
func SchemaVersion(ctx context.Context, databaseURL string) (int64, error) {
	db, err := openSQLDB(ctx, databaseURL)
	if err != nil {
		return 0, err
	}
	defer db.Close()

	setGooseLogging(false)
	var exists bool
	if err := db.QueryRowContext(ctx,
		"SELECT to_regclass($1) IS NOT NULL", "public."+gooseTable).Scan(&exists); err != nil {
		return 0, scrub(fmt.Errorf("postgres: check goose table: %w", err), databaseURL)
	}
	if !exists {
		return 0, nil
	}
	version, err := goose.GetDBVersionContext(ctx, db)
	if err != nil {
		return 0, scrub(fmt.Errorf("postgres: get schema version: %w", err), databaseURL)
	}
	return version, nil
}

// ExpectedSchemaVersion returns the highest migration version present in the
// embedded migrations filesystem, parsed from the filename prefix. It
// returns 0 only if the filesystem holds no migrations.
func ExpectedSchemaVersion() int64 {
	entries, err := fs.ReadDir(migrationFS, migrationsDir)
	if err != nil {
		return 0
	}
	var max int64
	for _, e := range entries {
		name := e.Name()
		if e.IsDir() || !strings.HasSuffix(name, ".sql") {
			continue
		}
		digits := 0
		for digits < len(name) && name[digits] >= '0' && name[digits] <= '9' {
			digits++
		}
		if digits == 0 {
			continue
		}
		if v, err := strconv.ParseInt(name[:digits], 10, 64); err == nil && v > max {
			max = v
		}
	}
	return max
}
