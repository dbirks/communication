package main

import (
	"context"
	"fmt"
	"io"
	"os"

	"github.com/dbirks/communication/internal/store/postgres"
)

const migrateUsage = `usage: communication migrate <up|status>

applies or reports embedded database migrations (COMMUNICATION_DATABASE_URL)
`

// runMigrate implements the "migrate" mode: apply pending migrations (up) or
// report the current versus expected schema version (status). Exit codes:
// 0 success, 2 usage/config error, 1 database error.
func runMigrate(ctx context.Context, args []string, stdout, stderr io.Writer) int {
	if len(args) == 0 {
		fmt.Fprint(stderr, migrateUsage)
		return 2
	}
	sub := args[0]
	if sub != "up" && sub != "status" {
		fmt.Fprintf(stderr, "unknown migrate subcommand %q\n", sub)
		fmt.Fprint(stderr, migrateUsage)
		return 2
	}

	databaseURL := os.Getenv("COMMUNICATION_DATABASE_URL")
	if databaseURL == "" {
		fmt.Fprintln(stderr, "COMMUNICATION_DATABASE_URL is not set")
		return 2
	}

	switch sub {
	case "up":
		verbose := false
		for _, a := range args[1:] {
			if a == "--verbose" {
				verbose = true
			}
		}
		var err error
		if verbose {
			err = postgres.MigrateVerbose(ctx, databaseURL)
		} else {
			err = postgres.Migrate(ctx, databaseURL)
		}
		if err != nil {
			fmt.Fprintf(stderr, "migrate up: %v\n", err)
			return 1
		}
		version, err := postgres.SchemaVersion(ctx, databaseURL)
		if err != nil {
			fmt.Fprintf(stderr, "migrate up: %v\n", err)
			return 1
		}
		fmt.Fprintf(stdout, "schema version %d\n", version)
		return 0
	case "status":
		version, err := postgres.SchemaVersion(ctx, databaseURL)
		if err != nil {
			fmt.Fprintf(stderr, "migrate status: %v\n", err)
			return 1
		}
		fmt.Fprintf(stdout, "schema version %d (expected %d)\n", version, postgres.ExpectedSchemaVersion())
		return 0
	}
	return 1 // unreachable
}
