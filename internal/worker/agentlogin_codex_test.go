package worker

// The Codex driver is tested against a fake `codex app-server`: a bash script
// that answers the JSON-lines requests with the shapes observed from
// codex-cli 0.166.0 ({"id":N,"result":…} / {"id":N,"error":{"message":…}} /
// {"method":…,"params":…}, no "jsonrpc" field) and appends everything it was
// asked to a file, so the test can prove the driver sent what the protocol
// says it must send. ADR-0085's verification line for the worker half is
// exactly this: "drivers against fake codex/antigravity executables that speak
// the observed shapes".

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// fakeCodexScript is the fake app-server. Its behaviour is scripted entirely
// through the environment, so one script covers the happy path, the
// success=false completion, the device-code refusal and the status probe.
const fakeCodexScript = `#!/bin/bash
log() { if [ -n "$FAKE_CODEX_LOG" ]; then printf '%s\n' "$1" >> "$FAKE_CODEX_LOG"; fi; }
send() { printf '%s\n' "$1"; }
id_of() { printf '%s' "$1" | sed -n 's/.*"id":\([0-9][0-9]*\).*/\1/p'; }
while IFS= read -r line; do
  log "$line"
  id=$(id_of "$line")
  case "$line" in
    *'"method":"initialize"'*)
      if [ "$FAKE_CODEX_SILENT" != "1" ]; then send "{\"id\":$id,\"result\":{\"userAgent\":\"fake-codex/0.166.0\"}}"; fi
      ;;
    *'"method":"account/read"'*)
      send "{\"id\":$id,\"result\":$FAKE_CODEX_ACCOUNT}"
      ;;
    *'"method":"account/login/start"'*)
      if [ -n "$FAKE_CODEX_LOGIN_ERROR" ]; then
        send "{\"id\":$id,\"error\":{\"code\":-32603,\"message\":\"$FAKE_CODEX_LOGIN_ERROR\"}}"
      else
        send "{\"id\":$id,\"result\":$FAKE_CODEX_LOGIN_START}"
        {
          sleep "${FAKE_CODEX_COMPLETED_DELAY:-0.1}"
          if [ -n "$FAKE_CODEX_COMPLETED" ]; then send "{\"method\":\"account/login/completed\",\"params\":$FAKE_CODEX_COMPLETED}"; fi
        } &
      fi
      ;;
    *'"method":"account/login/cancel"'*)
      send "{\"id\":$id,\"result\":{}}"
      ;;
    *)
      if [ -n "$id" ]; then send "{\"id\":$id,\"error\":{\"code\":-32601,\"message\":\"unknown method\"}}"; fi
      ;;
  esac
done
wait
`

const codexLoginStartResult = `{"type":"chatgptDeviceCode","loginId":"login-1","verificationUrl":"https://auth.openai.com/codex/device","userCode":"ABCD-EFGH"}`

// fakeCodexDriver wires the fake app-server into the driver. The child env is
// explicit and full, CODEX_HOME included, exactly as the worker wiring builds
// it (ADR-0086: the credential directory belongs to the worker volume).
func fakeCodexDriver(t *testing.T, extra map[string]string) (*CodexLoginDriver, string) {
	t.Helper()
	dir := t.TempDir()
	bin := writeFakeBinary(t, dir, "fake-codex", fakeCodexScript)
	env := []string{"PATH=" + os.Getenv("PATH"), "CODEX_HOME=" + filepath.Join(dir, "codex-home")}
	for k, v := range extra {
		env = append(env, k+"="+v)
	}
	return &CodexLoginDriver{Command: []string{bin}, Env: env, Timeout: 5 * time.Second}, dir
}

func readFakeLog(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return ""
		}
		t.Fatalf("read %s: %v", path, err)
	}
	return string(b)
}

// TestCodexLoginDriverDeviceCodeHappyPath is the whole flow the ADR describes:
// initialize, account/login/start, the link and code published to the user,
// account/login/completed arriving from the provider, and the label taken from
// a follow-up account/read.
func TestCodexLoginDriverDeviceCodeHappyPath(t *testing.T) {
	logPath := filepath.Join(t.TempDir(), "codex.log")
	d, _ := fakeCodexDriver(t, map[string]string{
		"FAKE_CODEX_LOG":             logPath,
		"FAKE_CODEX_LOGIN_START":     codexLoginStartResult,
		"FAKE_CODEX_COMPLETED":       `{"loginId":"login-1","success":true,"error":null}`,
		"FAKE_CODEX_COMPLETED_DELAY": "0.05",
		"FAKE_CODEX_ACCOUNT":         `{"account":{"type":"chatgpt","email":"dev@example.com","planType":"team"},"requiresOpenaiAuth":false}`,
	})
	sess := newFakeAgentLoginSession()

	res, err := d.Login(context.Background(), sess)
	if err != nil {
		t.Fatalf("Login: %v", err)
	}
	if res.AccountLabel != "dev@example.com" {
		t.Fatalf("account label = %q, want the email account/read reported", res.AccountLabel)
	}
	p := sess.promptCopy()
	if p == nil {
		t.Fatal("no prompt published")
	}
	if p.VerificationURL != "https://auth.openai.com/codex/device" || p.UserCode != "ABCD-EFGH" {
		t.Fatalf("prompt = %+v", p)
	}
	if p.NeedsCode {
		t.Error("Codex's device code is shown by the provider flow; NeedsCode must stay false")
	}
	want := readFakeLog(t, logPath)
	for _, method := range []string{`"method":"initialize"`, `"method":"initialized"`, `"method":"account/login/start"`, `"chatgptDeviceCode"`, `"method":"account/read"`} {
		if !strings.Contains(want, method) {
			t.Errorf("the fake app-server never saw %s; it saw:\n%s", method, want)
		}
	}
	// The device code must not be a "paste it back" code.
	if strings.Contains(want, `"needsCode"`) {
		t.Error("the driver invented a field the protocol does not have")
	}
}

// TestCodexLoginDriverCompletionFailed is the provider saying no: the sentence
// the user reads names Codex's failure, not our own.
func TestCodexLoginDriverCompletionFailed(t *testing.T) {
	d, _ := fakeCodexDriver(t, map[string]string{
		"FAKE_CODEX_LOGIN_START":     codexLoginStartResult,
		"FAKE_CODEX_COMPLETED":       `{"loginId":"login-1","success":false,"error":"access denied"}`,
		"FAKE_CODEX_COMPLETED_DELAY": "0.05",
		"FAKE_CODEX_ACCOUNT":         `{"account":null,"requiresOpenaiAuth":true}`,
	})
	sess := newFakeAgentLoginSession()

	_, err := d.Login(context.Background(), sess)
	if err == nil || err.Error() != "Codex sign-in failed: access denied" {
		t.Fatalf("Login error = %v", err)
	}
}

// TestCodexLoginDriverCancelSendsLoginCancel is the user's cancel reaching the
// harness: the pending device-code attempt is cancelled, and the driver answers
// with ErrAgentLoginStopped rather than a failure.
func TestCodexLoginDriverCancelSendsLoginCancel(t *testing.T) {
	logPath := filepath.Join(t.TempDir(), "codex.log")
	d, _ := fakeCodexDriver(t, map[string]string{
		"FAKE_CODEX_LOG":             logPath,
		"FAKE_CODEX_LOGIN_START":     codexLoginStartResult,
		"FAKE_CODEX_COMPLETED":       `{"loginId":"login-1","success":true,"error":null}`,
		"FAKE_CODEX_COMPLETED_DELAY": "30", // never arrives: the user cancels first
		"FAKE_CODEX_ACCOUNT":         `{"account":null,"requiresOpenaiAuth":true}`,
	})
	restore := agentLoginStopPollInterval
	agentLoginStopPollInterval = 10 * time.Millisecond
	t.Cleanup(func() { agentLoginStopPollInterval = restore })

	sess := newFakeAgentLoginSession()
	sess.stopAfter = 50 * time.Millisecond

	_, err := d.Login(context.Background(), sess)
	if !errors.Is(err, ErrAgentLoginStopped) {
		t.Fatalf("Login error = %v, want ErrAgentLoginStopped", err)
	}
	var sent string
	waitFor(t, "the login/cancel request", func() bool {
		sent = readFakeLog(t, logPath)
		return strings.Contains(sent, `"method":"account/login/cancel"`)
	})
	if !strings.Contains(sent, `"loginId":"login-1"`) {
		t.Fatalf("the cancel didn't name the pending login:\n%s", sent)
	}
}

// TestCodexLoginDriverDeviceCodeDisabled is the one failure whose fix is a
// setting on the user's account; the sentence has to say so.
func TestCodexLoginDriverDeviceCodeDisabled(t *testing.T) {
	d, _ := fakeCodexDriver(t, map[string]string{
		"FAKE_CODEX_LOGIN_ERROR": "Device code sign-in is disabled for this account.",
		"FAKE_CODEX_ACCOUNT":     `{"account":null,"requiresOpenaiAuth":true}`,
	})
	sess := newFakeAgentLoginSession()

	_, err := d.Login(context.Background(), sess)
	if err == nil || err.Error() != codexDeviceCodeDisabled {
		t.Fatalf("Login error = %v, want the device-code settings sentence", err)
	}
}

// TestCodexLoginDriverStatusProbe covers the three shapes the Settings page
// turns into chips.
func TestCodexLoginDriverStatusProbe(t *testing.T) {
	cases := []struct {
		name      string
		account   string
		wantState string
		wantLabel string
	}{
		{"signed out", `{"account":null,"requiresOpenaiAuth":true}`, AgentAccountSignedOut, ""},
		{"chatgpt email", `{"account":{"type":"chatgpt","email":"dev@example.com","planType":"plus"},"requiresOpenaiAuth":false}`, AgentAccountSignedIn, "dev@example.com"},
		{"chatgpt no email", `{"account":{"type":"chatgpt","email":null,"planType":null},"requiresOpenaiAuth":false}`, AgentAccountSignedIn, "ChatGPT"},
		{"api key", `{"account":{"type":"apiKey"},"requiresOpenaiAuth":false}`, AgentAccountSignedIn, "API key"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			d, _ := fakeCodexDriver(t, map[string]string{"FAKE_CODEX_ACCOUNT": tc.account})
			st, err := d.Status(context.Background())
			if err != nil {
				t.Fatalf("Status: %v", err)
			}
			if st.State != tc.wantState || st.AccountLabel != tc.wantLabel {
				t.Fatalf("Status = %+v, want %s/%s", st, tc.wantState, tc.wantLabel)
			}
		})
	}
}

// TestCodexLoginDriverStatusProbeSilent is the hung-child case: a probe that
// never answers is an error (the loop records it as unknown with the reason),
// not a silently-signed-out account.
func TestCodexLoginDriverStatusProbeSilent(t *testing.T) {
	d, _ := fakeCodexDriver(t, map[string]string{
		"FAKE_CODEX_SILENT":  "1",
		"FAKE_CODEX_ACCOUNT": `{"account":null,"requiresOpenaiAuth":true}`,
	})
	d.Timeout = 200 * time.Millisecond
	st, err := d.Status(context.Background())
	if err == nil {
		t.Fatalf("Status on a silent child = %+v, want an error", st)
	}
	if !strings.Contains(err.Error(), "sign-in status check") {
		t.Fatalf("Status error = %v", err)
	}
}

// TestCodexLoginDriverKeepsASuccessWithoutALabel is the kindness rule: once the
// provider has said the sign-in completed, a label read that fails must not
// turn a working login into a failed one the operator has to repeat.
func TestCodexLoginDriverKeepsASuccessWithoutALabel(t *testing.T) {
	d, _ := fakeCodexDriver(t, map[string]string{
		"FAKE_CODEX_LOGIN_START":     codexLoginStartResult,
		"FAKE_CODEX_COMPLETED":       `{"loginId":"login-1","success":true,"error":null}`,
		"FAKE_CODEX_COMPLETED_DELAY": "0.05",
		"FAKE_CODEX_ACCOUNT":         "", // the account/read answer is unparseable
	})
	d.Timeout = 400 * time.Millisecond
	sess := newFakeAgentLoginSession()

	res, err := d.Login(context.Background(), sess)
	if err != nil {
		t.Fatalf("Login: %v (result %+v)", err, res)
	}
	if res.AccountLabel != "" {
		t.Fatalf("account label = %q, want none", res.AccountLabel)
	}
}
