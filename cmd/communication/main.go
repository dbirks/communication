// Command communication is the single Communication binary. It runs in one of
// several modes selected by the first argument: serve, worker, dev, migrate
// or doctor. See communication-spec/02-system-architecture.md (D-002,
// ADR-0001).
package main

import (
	"context"
	"fmt"
	"io"
	"os"
)

// version is overridden at release build time via
// -ldflags "-X main.version=...".
var version = "dev"

const usage = `communication - operating environment for AI-assisted software engineering teams

usage: communication <mode> [flags]

modes:
  serve     run the control plane API server
  worker    run the execution worker (register, heartbeat, drain on SIGTERM)
  dev       run serve and one worker in one process (dev only, not HA)
  migrate   apply database migrations
  doctor    report on the local environment and supported agent tools
  version   print the binary version
  help      show this help
`

func main() {
	os.Exit(run(os.Args[1:], os.Stdout, os.Stderr))
}

func run(args []string, stdout, stderr io.Writer) int {
	if len(args) == 0 {
		fmt.Fprint(stderr, usage)
		return 2
	}

	switch args[0] {
	case "-h", "--help", "help":
		fmt.Fprint(stdout, usage)
		return 0
	case "version":
		fmt.Fprintf(stdout, "communication %s\n", version)
		return 0
	case "doctor":
		ctx := context.Background()
		return runDoctor(ctx, args[1:], stdout, stderr)
	case "migrate":
		ctx := context.Background()
		return runMigrate(ctx, args[1:], stdout, stderr)
	case "serve":
		ctx := context.Background()
		return runServe(ctx, args[1:], stdout, stderr)
	case "worker":
		ctx := context.Background()
		return runWorker(ctx, args[1:], stdout, stderr)
	case "dev":
		ctx := context.Background()
		return runDev(ctx, args[1:], stdout, stderr)
	}

	fmt.Fprintf(stderr, "unknown mode %q\n", args[0])
	fmt.Fprint(stderr, usage)
	return 2
}
