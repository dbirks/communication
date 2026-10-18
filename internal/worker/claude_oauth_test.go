package worker_test

import (
	"bytes"
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/dbirks/communication/internal/domain"
	"github.com/dbirks/communication/internal/sandbox/nono"
)

// The ADR-0040 rule under test: a long-lived `claude setup-token` value, read
// at launch time from the operator-configured file, reaches the claude
// launcher through the process environment — never argv (nono's audit journal
// records argv verbatim), never a log or event field.

const claudeFakeToken = "sk-ant-oat-test-not-real"

// claudeOAuthTokenFile writes one fake token into a 0600 file and points the
// operator variable at it.
func claudeOAuthTokenFile(t *testing.T, value string) string {
	t.Helper()
	dir := labScratch(t, "claude-oauth-token")
	file := filepath.Join(dir, "token")
	if err := os.WriteFile(file, []byte(value+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("COMMUNICATION_CLAUDE_OAUTH_TOKEN_FILE", file)
	return file
}

// TestClaudeOAuthTokenSandboxedLaunchArgvIsClean pins constraint 3 on the
// conversation path: under a sandbox the token rides nono's own process
// environment (nono inherits it into the child) and must not appear anywhere
// in the argv the audit journal records.
func TestClaudeOAuthTokenSandboxedLaunchArgvIsClean(t *testing.T) {
	fx := newUnitFixture(t)
	unit := fx.preparedUnit(t)
	claudeOAuthTokenFile(t, claudeFakeToken)

	plan, err := unit.Verify(context.Background(), testLauncher())
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	argv := strings.Join(append([]string{plan.Path}, plan.Args...), "\x00")
	if strings.Contains(argv, claudeFakeToken) {
		t.Fatal("the token value reached argv; nono's audit journal records argv verbatim (ADR-0040)")
	}
	if strings.Contains(argv, "CLAUDE_CODE_OAUTH_TOKEN") {
		t.Fatalf("the token variable reached argv through the env hop: %q", argv)
	}
	found := false
	for _, kv := range plan.Env {
		if kv == "CLAUDE_CODE_OAUTH_TOKEN="+claudeFakeToken {
			found = true
		}
	}
	if !found {
		t.Fatal("the token is not in the nono launcher's process environment, so the sandboxed agent would never see it")
	}
}

// TestClaudeOAuthTokenUnsandboxedPlanCarriesItInEnv covers the configured
// non-required mode: the adapter runs directly, so the token joins its real
// exec environment and stays out of the adapter's argv.
func TestClaudeOAuthTokenUnsandboxedPlanCarriesItInEnv(t *testing.T) {
	fx := newUnitFixture(t)
	fx.svc.Enforcement = domain.EnforcePermissiveDev
	unit := fx.preparedUnit(t)
	claudeOAuthTokenFile(t, claudeFakeToken)

	plan, err := unit.Verify(context.Background(), testLauncher())
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	if plan.Unsandboxed == "" {
		t.Fatal("an unsandboxed plan must carry its label")
	}
	if strings.Contains(strings.Join(plan.Args, "\x00"), claudeFakeToken) {
		t.Fatal("the token reached the adapter argv")
	}
	found := false
	for _, kv := range plan.Env {
		if kv == "CLAUDE_CODE_OAUTH_TOKEN="+claudeFakeToken {
			found = true
		}
	}
	if !found {
		t.Fatal("the token is not in the adapter's exec environment")
	}
}

// TestClaudeOAuthTokenBadValueFailsClosed pins the fail-closed rule: a file
// whose value does not carry the sk-ant-oat prefix refuses the launch, and
// the error the turn would journal never contains the value.
func TestClaudeOAuthTokenBadValueFailsClosed(t *testing.T) {
	fx := newUnitFixture(t)
	unit := fx.preparedUnit(t)
	const badValue = "totally-not-a-setup-token"
	claudeOAuthTokenFile(t, badValue)

	_, err := unit.Verify(context.Background(), testLauncher())
	if err == nil {
		t.Fatal("a value without the sk-ant-oat prefix must fail the launch closed")
	}
	if strings.Contains(err.Error(), badValue) {
		t.Fatalf("the failure message contains the token value: %q", err)
	}

	// A missing file fails closed the same way.
	claudeOAuthTokenFile(t, claudeFakeToken)
	t.Setenv("COMMUNICATION_CLAUDE_OAUTH_TOKEN_FILE", filepath.Join(unit.Layout.Home, "no-such-file"))
	if _, err := unit.Verify(context.Background(), testLauncher()); err == nil {
		t.Fatal("a missing token file must fail the launch closed")
	}
}

// TestClaudeOAuthTokenUnconfiguredIsUnchanged guards the regression side:
// with the operator variable unset, the launch is exactly what it was before
// ADR-0040 — no token variable anywhere.
func TestClaudeOAuthTokenUnconfiguredIsUnchanged(t *testing.T) {
	fx := newUnitFixture(t)
	unit := fx.preparedUnit(t)

	plan, err := unit.Verify(context.Background(), testLauncher())
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	argv := strings.Join(append([]string{plan.Path}, plan.Args...), "\x00")
	if strings.Contains(argv, "CLAUDE_CODE_OAUTH_TOKEN") {
		t.Fatal("CLAUDE_CODE_OAUTH_TOKEN appears although no token file is configured")
	}
	for _, kv := range plan.Env {
		if strings.HasPrefix(kv, "CLAUDE_CODE_OAUTH_TOKEN=") {
			t.Fatal("CLAUDE_CODE_OAUTH_TOKEN in the launcher environment although no token file is configured")
		}
	}
}

// TestClaudeOAuthTokenReachesRealSandboxedChild is the real-nono proof: a
// sandboxed `sh -c 'test -n "$CLAUDE_CODE_OAUTH_TOKEN" && echo present'`
// prints `present`, and the session's audit record does not contain the token.
func TestClaudeOAuthTokenReachesRealSandboxedChild(t *testing.T) {
	base := labScratch(t, "claude-oauth-real-nono")
	nonoHome := labScratch(t, "claude-oauth-nono-home")
	file := filepath.Join(base, "token")
	if err := os.WriteFile(file, []byte(claudeFakeToken+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	// The worker reads the file itself at launch time; the child never needs a
	// grant on it. Read it the way launcher.OAuthTokenKV does.
	launcher := testLauncher()
	t.Setenv("COMMUNICATION_CLAUDE_OAUTH_TOKEN_FILE", file)
	kv, err := launcher.OAuthTokenKV()
	if err != nil {
		t.Fatalf("token file: %v", err)
	}

	bin := nonoPath(t)
	const marker = "COMMUNICATION_CLAUDE_OAUTH_TEST=claude-oauth-test-session"
	env := []string{
		"PATH=" + os.Getenv("PATH"),
		"HOME=" + nonoHome,
		"XDG_CONFIG_HOME=" + filepath.Join(nonoHome, ".config"),
		"XDG_CACHE_HOME=" + filepath.Join(nonoHome, ".cache"),
		"XDG_STATE_HOME=" + filepath.Join(nonoHome, ".local", "state"),
		kv, // the whole point: the token rides nono's process environment.
	}
	argv := []string{"run", "-s", "--allow-cwd", "--", "env", marker, "sh", "-c",
		`test -n "$CLAUDE_CODE_OAUTH_TOKEN" && echo present`}
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, bin, argv...)
	cmd.Dir, cmd.Env = base, env
	out, runErr := cmd.Output()
	if runErr != nil {
		t.Fatalf("nono run: %v: %s", runErr, out)
	}
	if !strings.Contains(string(out), "present") {
		t.Fatalf("the sandboxed child did not see CLAUDE_CODE_OAUTH_TOKEN; nono output: %s", out)
	}

	// The audit side of constraint 3: the journal records this session's argv
	// verbatim, and the token must not be in it.
	l := &nono.Launcher{Binary: bin, Home: nonoHome}
	sessionID, err := l.FindSessionByMarker(ctx, marker)
	if err != nil {
		t.Fatalf("find the audit session by its argv marker: %v", err)
	}
	auditEnv := []string{"PATH=" + os.Getenv("PATH"), "HOME=" + nonoHome}
	var buf bytes.Buffer
	auditCmd := exec.CommandContext(ctx, bin, "audit", "show", sessionID, "--json")
	auditCmd.Dir, auditCmd.Env = base, auditEnv
	auditCmd.Stdout, auditCmd.Stderr = &buf, &buf
	if err := auditCmd.Run(); err != nil {
		t.Fatalf("nono audit show: %v: %s", err, buf.String())
	}
	if strings.Contains(buf.String(), claudeFakeToken) {
		t.Fatalf("the audit journal contains the token value:\n%s", buf.String())
	}
}
