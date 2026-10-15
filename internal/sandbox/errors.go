package sandbox

import "errors"

// Sentinel errors shared by all sandbox launcher adapters. Callers compare
// with errors.Is; adapters wrap them with backend detail.
var (
	// ErrUnavailable means the sandbox backend itself is not usable here:
	// the binary is missing or could not be executed at all. In
	// EnforceRequired mode this aborts the launch.
	ErrUnavailable = errors.New("sandbox backend unavailable")

	// ErrNotEnforceable means the backend exists but the guarantees the
	// policy demands could not be verified on this host, or the backend
	// refused to establish them (failed capability probe, failed
	// nono run --dry-run, missing kernel feature). In EnforceRequired
	// mode this aborts the launch: the process is never started
	// unsandboxed (communication-spec/05-workspaces-security-secrets.md).
	ErrNotEnforceable = errors.New("sandbox guarantees not enforceable")

	// ErrGrantSource means the sandbox's own resolved policy named a rule
	// source this adapter does not understand. It is a distinct failure from
	// ErrNotEnforceable because the backend *did* enforce something — the
	// question is whether it is the policy we recorded, which is the assertion
	// ADR-0009 D4 requires and the one a green exit code cannot answer.
	ErrGrantSource = errors.New("sandbox policy came from an unrecognized source")
)
