package worker

// What a failed agent launch says in the journal.
//
// `conversation.turn.failed` carries one bounded `message`, and the chat turns
// it into the sentence a person reads. When the harness refuses to start a
// session because it cannot sign in, the adapter's own words are the JSON-RPC
// error `{"code":-32000,"message":"Authentication required"}` — quoted whole,
// that string is indistinguishable, to anything pattern-matching it, from git's
// own "Authentication required" on an unreadable repository. The lab printed
// exactly that confusion after a per-turn agent switch (ADR-0068, design 2e):
// a Codex turn that had prepared its workspace cleanly on the same worker, on
// the same volume, on the same branch — every fact the switch is supposed to
// carry over — and then died at `session/new`, was reported to the reader as
// "the repository's git address could not be read from this worker". The
// workspace was never the problem; the sentence was.
//
// So the worker says which component refused. The launcher is named, the
// refusal is named as the harness's own, and the JSON-RPC code is kept because
// it is the only stable identifier the adapter offers. The adapter's English
// message is not repeated verbatim: it is a phrase two different subsystems
// use for two different failures, and the reader cannot tell them apart from
// the inside. The full unclassified error stays in the worker's log line
// (runner.go's "session unavailable"), where the operator who can act on it
// reads it.

import (
	"regexp"
)

// acpAuthRefusal matches the ACP handshake's own authentication refusal: a
// failure on the session path (session/new, session/load, initialize) whose
// payload names authentication. Both observed shapes carry the JSON-RPC
// internal-error code with a message naming authentication (ACP.md "Observed
// failure honesty", ADR-0040's measured failure).
var acpAuthRefusal = regexp.MustCompile(`(?i)\bacp: (initialize|session/[a-z]+)(:[^()]*)?\b.*\bauthentication (required|failed|denied)\b`)

// acpCode extracts the JSON-RPC code the adapter answered with, so the honest
// identifier survives even though the message text is restated.
var acpCode = regexp.MustCompile(`"code"\s*:\s*(-?\d+)`)

// describeLaunchFailure turns a session-start failure into the worker's own
// words when the failure is the harness refusing to sign in. Every other
// failure is returned untouched: the workspace, sandbox and launcher-registry
// messages are already written by the component that knows what broke, and
// restating them here would be guessing at a cause this function has no view
// of.
func describeLaunchFailure(launcherID string, err error) error {
	if err == nil {
		return nil
	}
	msg := err.Error()
	if !acpAuthRefusal.MatchString(msg) {
		return err
	}
	stage := acpAuthRefusal.FindStringSubmatch(msg)[1]
	code := ""
	if m := acpCode.FindStringSubmatch(msg); m != nil {
		code = ", JSON-RPC code " + m[1]
	}
	return errLauncherNotSignedIn{
		launcher: launcherID,
		stage:    stage,
		code:     code,
		cause:    err,
	}
}

// errLauncherNotSignedIn is the worker's honest sentence for a launcher that
// will not start without a sign-in this process cannot give it. It names the
// launcher's credential directory as the thing to look at — the only host fact
// the reader can act on (compose.harness.yml's CLAUDE_CONFIG_DIR/CODEX_HOME
// pair, ADR-0040) — without claiming the directory is empty, missing or
// unreadable, none of which this process checked.
type errLauncherNotSignedIn struct {
	launcher string
	stage    string
	code     string
	cause    error
}

func (e errLauncherNotSignedIn) Error() string {
	return "worker: launcher \"" + e.launcher + "\" is not signed in on this worker: the agent refused " +
		e.stage + " because it requires a sign-in" + e.code +
		" — check this launcher's credential directory on the worker that owns the turn"
}

// Unwrap keeps the adapter's error underneath: a caller matching on the
// original (the lease/permission branches do) still sees it.
func (e errLauncherNotSignedIn) Unwrap() error { return e.cause }
