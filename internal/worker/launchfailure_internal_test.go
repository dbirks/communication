package worker

// Internal (same-package) test of launchfailure.go: what a launcher that will
// not sign in says in `conversation.turn.failed.message`.
//
// The shapes below are the lab's own words, quoted from the journal of the
// design-2e leg where a chat switched its next turn from Claude Code to Codex:
// the turn prepared its workspace on the same worker, the same volume and the
// same conversation branch (ADR-0068's carry-over — workspace.prepared and
// sandbox.verified both landed), and then closed failed with
//
//	acp: session/new: {"code":-32000,"message":"Authentication required"}
//
// The chat rendered that as "This chat couldn't start its workspace: the
// repository's git address could not be read from this worker", because the
// UI's failure-copy table has one arm that matches the bare phrase
// `authentication required` case-insensitively, and git says the same words
// when a remote refuses an unauthenticated fetch. The worker owns the
// sentence, so the worker now writes one that names the component that
// refused — and that no git-shaped pattern can claim.

import (
	"errors"
	"strings"
	"testing"
)

const labAuthFailure = `acp: session/new: {"code":-32000,"message":"Authentication required"}`

func TestDescribeLaunchFailureNamesTheLauncherNotTheRepository(t *testing.T) {
	original := errors.New(labAuthFailure)
	got := describeLaunchFailure("codex", original)
	if got == nil {
		t.Fatal("the harness's sign-in refusal was described as nothing")
	}
	msg := got.Error()
	for _, want := range []string{
		`launcher "codex"`,     // who refused
		"not signed in",        // what happened
		"session/new",          // which step
		"credential directory", // what to go look at
		"JSON-RPC code -32000", // the adapter's stable identifier
	} {
		if !strings.Contains(msg, want) {
			t.Fatalf("the sign-in failure does not name %q: %q", want, msg)
		}
	}
	// The phrases the repository/git arm of the failure copy matches on. A
	// message carrying any of these is rendered as a workspace problem, which
	// is the bug this file closes: an ACP auth refusal is not one.
	for _, forbidden := range []string{
		"authentication required",
		"does not appear to be a git repository",
		"Could not read from remote repository",
		"repository not found",
		"create mirror",
	} {
		if strings.Contains(strings.ToLower(msg), strings.ToLower(forbidden)) {
			t.Fatalf("the sign-in failure reads like a git failure (%q): %q", forbidden, msg)
		}
	}
	// The adapter's error stays underneath: the operator's log line and every
	// errors.Is on the original still reach it.
	if !errors.Is(got, original) {
		t.Fatalf("the original error was not kept under the description: %+v", got)
	}
	if errors.Unwrap(got) != original {
		t.Fatalf("unwrap = %v, want the adapter's own error (%v)", errors.Unwrap(got), original)
	}
}

func TestDescribeLaunchFailureCoversTheSessionLoadShape(t *testing.T) {
	got := describeLaunchFailure("claude",
		errors.New(`acp: session/load (after failed session/new): {"code":-32000,"message":"Authentication required"}`))
	msg, ok := got.(errLauncherNotSignedIn)
	if !ok {
		t.Fatalf("a load-path sign-in refusal was not classified: %v", got)
	}
	if msg.stage != "session/load" {
		t.Fatalf("stage = %q, want session/load", msg.stage)
	}
}

// Everything that is not a sign-in refusal leaves this file exactly as it
// arrived: the workspace preparer, the sandbox and the launcher registry each
// already write a sentence naming what they own, and paraphrasing them here
// would be guessing at a cause this function cannot see.
func TestDescribeLaunchFailureLeavesOtherFailuresAlone(t *testing.T) {
	for _, s := range []string{
		`worker: prepare workspace for project 01a19c73: workspace: mirror /repos/01a19c73/server.git has no branch "main" to base server on (ADR-0017 D2 refuses a branch-name guess)`,
		`workspace: create mirror /repos/web.git from file:///remotes/web.git failed: fatal: 'x' does not appear to be a git repository`,
		`worker: permission mode ask needs a prompting mode for launcher pi; none is verified (docs/compatibility/ACP.md)`,
		`acp: start codex-acp: exec: "codex-acp": executable file not found in $PATH`,
		`acp: initialize: unexpected EOF`,
	} {
		err := errors.New(s)
		if got := describeLaunchFailure("codex", err); got != err {
			t.Fatalf("a non sign-in failure was rewritten as %v", got)
		}
	}
	if got := describeLaunchFailure("codex", nil); got != nil {
		t.Fatalf("nil became %v", got)
	}
}
