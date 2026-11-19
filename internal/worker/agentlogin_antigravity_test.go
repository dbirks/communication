package worker

// The Antigravity driver is tested against a fake `antigravity` CLI printing
// the prompt text observed from agy 1.5.9 — the link on stdout, the "paste the
// authorization code" line, and (on failure) the OAuth error on stderr. The
// fakes record what they read from stdin, so the tests prove the pasted code
// reaches the child and prove it never leaks back out through an error.

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// fakeAntigravityScript is the fake CLI: login mode prints the Google link and
// reads the code back, status mode answers the ACP handshake.
const fakeAntigravityScript = `#!/bin/bash
if [ -n "$FAKE_AGY_MODE" ]; then
  # ACP status probe: initialize + session/new, verdict scripted by the env.
  while IFS= read -r line; do
    if [ -n "$FAKE_AGY_LOG" ]; then printf '%s\n' "$line" >> "$FAKE_AGY_LOG"; fi
    case "$line" in
      *'"method":"initialize"'*)
        printf '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1,"agentCapabilities":{},"agentInfo":{"name":"fake-agy","version":"1.5.9"}}}\n'
        ;;
      *'"method":"session/new"'*)
        printf '%s\n' "$FAKE_AGY_SESSION_REPLY"
        ;;
      *'"method":"session/close"'*)
        printf '{"jsonrpc":"2.0","id":3,"result":{}}\n'
        ;;
    esac
  done
  exit 0
fi
if [ "$FAKE_AGY_NO_LINK" = "1" ]; then
  echo "antigravity: nothing useful to say"
  exit 3
fi
printf 'Open this link in a browser to log in with Google:\n\n  https://accounts.google.com/o/oauth2/auth?access_type=offline&client_id=fake.apps.googleusercontent.com&code_challenge=CHALLENGEVALUE&redirect_uri=https%%3A%%2Fantigravity.google%%2Foauth-callback\n\nThen paste the authorization code, or the full URL of the page you land on, and press Enter:\n'
if [ "$FAKE_AGY_HANG" = "1" ]; then
  sleep 30
  exit 0
fi
read -r code
printf '%s' "$code" > "$FAKE_AGY_CODE_FILE"
if [ "$FAKE_AGY_FAIL" = "1" ]; then
  echo 'couldn'"'"'t log in: token exchange failed: oauth2: "invalid_grant" "Malformed auth code."' >&2
  echo "retrying with the pasted value failed for grant $code at code=EXCHANGECODEVALUE&state=STATEVALUEVALUE" >&2
  exit 1
fi
echo "Logged in."
exit 0
`

// fakeAntigravityDriver wires the fake CLI in; dir is the scratch HOME.
func fakeAntigravityDriver(t *testing.T, extra map[string]string) (*AntigravityLoginDriver, string) {
	t.Helper()
	dir := t.TempDir()
	bin := writeFakeBinary(t, dir, "antigravity", fakeAntigravityScript)
	env := []string{"PATH=" + os.Getenv("PATH"), "HOME=" + filepath.Join(dir, "agy-home")}
	for k, v := range extra {
		env = append(env, k+"="+v)
	}
	return &AntigravityLoginDriver{Command: []string{bin}, Env: env, ScratchDir: dir}, dir
}

const agySignedOutReply = `{"jsonrpc":"2.0","id":2,"error":{"code":-32000,"message":"Authentication required"}}`

// TestAntigravityLoginDriverHappyPath is the whole exchange: the link the CLI
// printed lands in the prompt with needs_code, the code the admin pasted lands
// on the child's stdin (the fake records it), and exit 0 is a signed-in
// volume.
func TestAntigravityLoginDriverHappyPath(t *testing.T) {
	codeFile := filepath.Join(t.TempDir(), "code.txt")
	d, _ := fakeAntigravityDriver(t, map[string]string{"FAKE_AGY_CODE_FILE": codeFile})
	sess := newFakeAgentLoginSession()
	sess.code = "4/0AbCdEfGhIjKlMnOpQrStUv"
	sess.codeDelay = 20 * time.Millisecond

	res, err := d.Login(context.Background(), sess)
	if err != nil {
		t.Fatalf("Login: %v", err)
	}
	if res.AccountLabel != "Google account" {
		t.Fatalf("account label = %q", res.AccountLabel)
	}
	p := sess.promptCopy()
	if p == nil {
		t.Fatal("no prompt published")
	}
	if !strings.HasPrefix(p.VerificationURL, "https://accounts.google.com/o/oauth2/auth?") {
		t.Fatalf("prompt URL = %q", p.VerificationURL)
	}
	if !p.NeedsCode {
		t.Error("Antigravity always needs the code pasted back")
	}
	if p.UserCode != "" {
		t.Errorf("Antigravity has no device code; prompt carried %q", p.UserCode)
	}
	got, err := os.ReadFile(codeFile)
	if err != nil {
		t.Fatalf("the child never recorded a code: %v", err)
	}
	if string(got) != sess.code {
		t.Fatalf("the child read %q, want the pasted code %q", got, sess.code)
	}
}

// TestAntigravityLoginDriverFailureRedactsCode is the privacy rule: the CLI's
// last line is the diagnosis, and neither the pasted code nor the OAuth
// parameters in that line may ride out in the error sentence.
func TestAntigravityLoginDriverFailureRedactsCode(t *testing.T) {
	codeFile := filepath.Join(t.TempDir(), "code.txt")
	d, _ := fakeAntigravityDriver(t, map[string]string{
		"FAKE_AGY_CODE_FILE": codeFile,
		"FAKE_AGY_FAIL":      "1",
	})
	sess := newFakeAgentLoginSession()
	sess.code = "4/SECRETGRANTVALUE"
	sess.codeDelay = 10 * time.Millisecond

	_, err := d.Login(context.Background(), sess)
	if err == nil {
		t.Fatal("Login succeeded on a child that exited 1")
	}
	msg := err.Error()
	if !strings.HasPrefix(msg, "Antigravity sign-in failed: ") {
		t.Fatalf("error = %q", msg)
	}
	for _, leak := range []string{"SECRETGRANTVALUE", "EXCHANGECODEVALUE", "STATEVALUEVALUE"} {
		if strings.Contains(msg, leak) {
			t.Fatalf("the error leaked %q: %q", leak, msg)
		}
	}
	if !strings.Contains(msg, "token exchange failed") && !strings.Contains(msg, "failed for grant") {
		t.Fatalf("the error lost the CLI's own words: %q", msg)
	}
}

// TestAntigravityLoginDriverNoLink is the shape where the CLI prints something
// else and exits: the admin gets a retryable sentence, not a hang.
func TestAntigravityLoginDriverNoLink(t *testing.T) {
	d, _ := fakeAntigravityDriver(t, map[string]string{"FAKE_AGY_NO_LINK": "1"})
	sess := newFakeAgentLoginSession()

	_, err := d.Login(context.Background(), sess)
	if err == nil || err.Error() != "Antigravity didn't print a sign-in link." {
		t.Fatalf("Login error = %v", err)
	}
	if sess.promptCopy() != nil {
		t.Fatal("a prompt was published without a link")
	}
}

// TestAntigravityLoginDriverCancelStopsChild is the user's cancel: WaitCode
// says stopped, and the driver passes that through.
func TestAntigravityLoginDriverCancelStopsChild(t *testing.T) {
	d, _ := fakeAntigravityDriver(t, map[string]string{"FAKE_AGY_HANG": "1"})
	sess := newFakeAgentLoginSession()
	sess.codeErr = ErrAgentLoginStopped
	sess.codeDelay = 10 * time.Millisecond

	_, err := d.Login(context.Background(), sess)
	if !errors.Is(err, ErrAgentLoginStopped) {
		t.Fatalf("Login error = %v, want ErrAgentLoginStopped", err)
	}
}

// TestAntigravityLoginDriverStatusProbe covers the ACP verdicts: session/new
// refused with "Authentication required" is signed_out, a session that opens
// is signed_in, and a child that answers nothing is an error the loop records
// as unknown.
func TestAntigravityLoginDriverStatusProbe(t *testing.T) {
	t.Run("signed out", func(t *testing.T) {
		d, _ := fakeAntigravityDriver(t, map[string]string{"FAKE_AGY_MODE": "status", "FAKE_AGY_SESSION_REPLY": agySignedOutReply})
		st, err := d.Status(context.Background())
		if err != nil {
			t.Fatalf("Status: %v", err)
		}
		if st.State != AgentAccountSignedOut || st.AccountLabel != "" {
			t.Fatalf("Status = %+v, want signed_out", st)
		}
	})
	t.Run("signed in", func(t *testing.T) {
		logPath := filepath.Join(t.TempDir(), "agy.log")
		d, _ := fakeAntigravityDriver(t, map[string]string{
			"FAKE_AGY_MODE":          "status",
			"FAKE_AGY_SESSION_REPLY": `{"jsonrpc":"2.0","id":2,"result":{"sessionId":"sess-1"}}`,
			"FAKE_AGY_LOG":           logPath,
		})
		st, err := d.Status(context.Background())
		if err != nil {
			t.Fatalf("Status: %v", err)
		}
		if st.State != AgentAccountSignedIn || st.AccountLabel != "Google account" {
			t.Fatalf("Status = %+v", st)
		}
		// The probe opened a session it does not want, so it closes it — in the
		// scratch dir it was handed, never in a repository.
		waitFor(t, "the best-effort session/close", func() bool {
			return strings.Contains(readFakeLog(t, logPath), `"method":"session/close"`)
		})
		if !strings.Contains(readFakeLog(t, logPath), `"cwd":"`+d.ScratchDir) {
			t.Fatalf("the probe didn't open its session in the scratch dir:\n%s", readFakeLog(t, logPath))
		}
	})
	t.Run("no answer", func(t *testing.T) {
		d, _ := fakeAntigravityDriver(t, map[string]string{
			"FAKE_AGY_MODE":          "status",
			"FAKE_AGY_SESSION_REPLY": "", // an empty line is not a response
		})
		restore := antigravityStatusTimeout
		antigravityStatusTimeout = 300 * time.Millisecond
		t.Cleanup(func() { antigravityStatusTimeout = restore })
		if _, err := d.Status(context.Background()); err == nil {
			t.Fatal("Status on a silent child = no error")
		}
	})
	t.Run("no scratch dir", func(t *testing.T) {
		d, _ := fakeAntigravityDriver(t, nil)
		d.ScratchDir = ""
		if _, err := d.Status(context.Background()); err == nil {
			t.Fatal("Status without a scratch dir = no error")
		}
	})
}
