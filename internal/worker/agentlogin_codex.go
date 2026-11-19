package worker

// ADR-0085: the Codex sign-in driver. It spawns the bundled Codex CLI's
// `app-server` (the same loop the ACP adapter talks to, minus the ACP layer)
// and speaks the app-server's newline-delimited JSON: requests
// {"id":N,"method":…,"params":…}, responses {"id":N,"result":…} or
// {"id":N,"error":{"message":…}}, notifications {"method":…,"params":…} — no
// "jsonrpc" field at all. Observed against codex-cli 0.166.0.
//
// The device-code flow is the one that works without a browser on the worker:
// account/login/start {type: chatgptDeviceCode} hands back a verification URL
// and a code, the user approves it on their own device, and the harness
// reports account/login/completed. The driver never sees a token — Codex
// writes it into CODEX_HOME itself.

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// DefaultCodexLoginTimeout bounds one app-server round trip and one status probe.
const DefaultCodexLoginTimeout = 60 * time.Second

// agentLoginStopPollInterval is how often a driver that waits on the provider
// asks the session whether the user cancelled or the attempt expired. A var so
// tests drive the cancel path without waiting two seconds.
var agentLoginStopPollInterval = 2 * time.Second

// codexDeviceCodeDisabled is what the operator has to be told when OpenAI
// refuses the flow: the fix is a setting on their ChatGPT account, not a retry.
const codexDeviceCodeDisabled = "Device code sign-in isn't enabled for this ChatGPT account. Turn on “Enable device code sign-in for Codex” in ChatGPT → Settings → Security, then try again."

// CodexLoginDriver signs the worker's Codex credential volume in by driving
// the bundled Codex CLI's app-server.
type CodexLoginDriver struct {
	// Command is the Codex CLI argv without the subcommand, e.g.
	// ["node", "/usr/local/lib/node_modules/@agentclientprotocol/codex-acp/node_modules/@openai/codex/bin/codex.js"].
	Command []string
	// Env is the FULL child environment, and must carry CODEX_HOME — the
	// credential directory this worker owns (ADR-0086).
	Env []string
	// Timeout bounds one app-server round trip and one status probe; zero
	// takes DefaultCodexLoginTimeout.
	Timeout time.Duration
}

// codexClient is one app-server child plus its JSON-lines conversation.
type codexClient struct {
	child *agentLoginChild

	mu      sync.Mutex
	pending map[string]chan codexMsg
	// nextID numbers the requests monotonically — the app-server echoes it
	// back, which is how a response finds the call waiting for it.
	nextID atomic.Int64

	// notify carries every server notification; unknown ones are dropped by
	// the consumer (the app-server also broadcasts remoteControl/status/changed).
	notify chan codexMsg
	// dead closes when the child's output ends or the child is killed.
	dead <-chan struct{}
	// timeout bounds one request/response round trip: a handshake that hangs
	// is a dead helper, not a slow one.
	timeout time.Duration
}

// errCodexSilent is the app-server taking longer than the round-trip timeout
// while the attempt itself is still alive; each caller turns it into the
// sentence its user needs.
var errCodexSilent = errors.New("the Codex sign-in helper didn't answer in time")

type codexMsg struct {
	ID     json.RawMessage `json:"id"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params"`
	Result json.RawMessage `json:"result"`
	Error  *codexErr       `json:"error"`
}

type codexErr struct {
	Code    json.Number `json:"code"`
	Message string      `json:"message"`
}

func (e *codexErr) Error() string {
	if e == nil || e.Message == "" {
		return "the Codex helper reported an error"
	}
	return e.Message
}

func (m codexMsg) idKey() string { return strings.TrimSpace(string(m.ID)) }

// startCodex spawns `<Command…> app-server` and runs the initialize
// handshake. The caller owns the returned client and must Close it.
func (d *CodexLoginDriver) start(ctx context.Context) (*codexClient, error) {
	if len(d.Command) == 0 {
		return nil, errors.New("the Codex sign-in driver has no command configured")
	}
	argv := append(append([]string{}, d.Command...), "app-server")
	child, err := startAgentLoginChild(ctx, argv, d.Env, true, true, false)
	if err != nil {
		return nil, fmt.Errorf("couldn't start the Codex sign-in helper: %w", err)
	}
	c := &codexClient{
		child:   child,
		pending: make(map[string]chan codexMsg),
		notify:  make(chan codexMsg, 16),
		dead:    child.Done(),
		timeout: d.timeout(),
	}
	go c.read()
	if err := c.initialize(ctx); err != nil {
		c.Close()
		return nil, err
	}
	return c, nil
}

// read decodes the child's stdout forever, routing responses to their waiting
// request and notifications to the notify channel.
func (c *codexClient) read() {
	defer close(c.notify)
	dec := json.NewDecoder(bufio.NewReaderSize(c.child.stdout, 64*1024))
	for {
		var m codexMsg
		if err := dec.Decode(&m); err != nil {
			// A torn or closed pipe is the child going away; waiters learn that
			// from c.dead, so there is nothing to report here.
			return
		}
		if m.Method != "" && m.idKey() == "" {
			select {
			case c.notify <- m:
			case <-c.child.dead:
				return
			}
			continue
		}
		if key := m.idKey(); key != "" {
			c.mu.Lock()
			ch := c.pending[key]
			delete(c.pending, key)
			c.mu.Unlock()
			if ch != nil {
				select {
				case ch <- m:
				default:
				}
			}
		}
	}
}

// write sends one line to the child.
func (c *codexClient) write(v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	if _, err := c.child.stdin.Write(append(b, '\n')); err != nil {
		return errors.New("the Codex sign-in helper stopped answering")
	}
	return nil
}

// call sends a request and waits for the response that carries its id. Ids
// come from the client's own counter, so two calls can never collide.
func (c *codexClient) call(ctx context.Context, method string, params any) (json.RawMessage, error) {
	id := c.nextID.Add(1)
	key := strconv.FormatInt(id, 10)
	ch := make(chan codexMsg, 1)
	c.mu.Lock()
	c.pending[key] = ch
	c.mu.Unlock()
	if err := c.write(struct {
		ID     int64  `json:"id"`
		Method string `json:"method"`
		Params any    `json:"params"`
	}{ID: id, Method: method, Params: params}); err != nil {
		c.mu.Lock()
		delete(c.pending, key)
		c.mu.Unlock()
		return nil, err
	}
	callCtx, cancelCall := context.WithTimeout(ctx, c.timeout)
	defer cancelCall()
	select {
	case m, ok := <-ch:
		if !ok {
			return nil, errors.New("the Codex sign-in helper stopped answering")
		}
		if m.Error != nil {
			return nil, m.Error
		}
		return m.Result, nil
	case <-callCtx.Done():
		c.mu.Lock()
		delete(c.pending, key)
		c.mu.Unlock()
		if ctx.Err() != nil {
			// The attempt ended (expired, cancelled, drained): say so plainly so
			// the loop can tell expired from cancelled from failed.
			return nil, ctx.Err()
		}
		return nil, errCodexSilent
	case <-c.child.dead:
		c.mu.Lock()
		delete(c.pending, key)
		c.mu.Unlock()
		return nil, errors.New("the Codex sign-in helper stopped answering")
	}
}

// notifySend sends a notification (no id, so no response).
func (c *codexClient) notifySend(method string, params any) error {
	return c.write(struct {
		Method string `json:"method"`
		Params any    `json:"params,omitempty"`
	}{Method: method, Params: params})
}

// initialize performs the app-server handshake: initialize, then the
// initialized notification the server waits for before it will serve anything.
func (c *codexClient) initialize(ctx context.Context) error {
	_, err := c.call(ctx, "initialize", map[string]any{
		"clientInfo": map[string]any{"name": "communication", "version": "1"},
	})
	if err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if errors.Is(err, errCodexSilent) {
			return errors.New("Codex didn't answer the sign-in handshake in time.")
		}
		return fmt.Errorf("Codex didn't answer the sign-in handshake: %s", agentLoginRedactText(err.Error()))
	}
	if err := c.notifySend("initialized", nil); err != nil {
		return err
	}
	return nil
}

func (c *codexClient) Close() { c.child.Close() }

// codexAccount is the app-server's account record.
type codexAccount struct {
	Type     string `json:"type"`
	Email    string `json:"email"`
	PlanType string `json:"planType"`
}

type codexAccountRead struct {
	Account            *codexAccount `json:"account"`
	RequiresOpenaiAuth bool          `json:"requiresOpenaiAuth"`
}

type codexLoginStart struct {
	Type            string `json:"type"`
	LoginID         string `json:"loginId"`
	VerificationURL string `json:"verificationUrl"`
	UserCode        string `json:"userCode"`
}

type codexLoginCompleted struct {
	LoginID string `json:"loginId"`
	Success bool   `json:"success"`
	Error   string `json:"error"`
}

func (d *CodexLoginDriver) timeout() time.Duration {
	if d.Timeout > 0 {
		return d.Timeout
	}
	return DefaultCodexLoginTimeout
}

// Status probes the credential volume with account/read. account:null is a
// signed-out volume; a chatgpt account carries the email as its label, an
// apiKey account is labelled plainly.
func (d *CodexLoginDriver) Status(ctx context.Context) (AgentAccountState, error) {
	ctx, cancel := context.WithTimeout(ctx, d.timeout())
	defer cancel()
	c, err := d.start(ctx)
	if err != nil {
		return AgentAccountState{}, codexProbeSentence(err)
	}
	defer c.Close()
	st, err := d.accountState(ctx, c)
	if err != nil {
		return AgentAccountState{}, codexProbeSentence(err)
	}
	return st, nil
}

// codexProbeSentence is the `detail` behind an unknown chip: a probe that
// could not be answered has to explain itself in the operator's language, and
// a raw Go error string never reaches the Settings page.
func codexProbeSentence(err error) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, context.DeadlineExceeded) || errors.Is(err, errCodexSilent) {
		return errors.New("Codex didn't answer the sign-in status check in time.")
	}
	msg := agentLoginRedactText(err.Error())
	if strings.Contains(strings.ToLower(msg), "codex") {
		return errors.New(strings.TrimSuffix(msg, ".") + ".")
	}
	return fmt.Errorf("Codex didn't answer the sign-in status check: %s", msg)
}

// accountState runs one account/read and maps it to a probe answer.
func (d *CodexLoginDriver) accountState(ctx context.Context, c *codexClient) (AgentAccountState, error) {
	raw, err := c.call(ctx, "account/read", struct{}{})
	if err != nil {
		if ctx.Err() != nil {
			return AgentAccountState{}, ctx.Err()
		}
		if errors.Is(err, errCodexSilent) {
			return AgentAccountState{}, errors.New("Codex didn't answer the sign-in status check in time.")
		}
		return AgentAccountState{}, fmt.Errorf("Codex didn't answer the sign-in status check: %s", agentLoginRedactText(err.Error()))
	}
	var res codexAccountRead
	if err := json.Unmarshal(raw, &res); err != nil {
		return AgentAccountState{}, fmt.Errorf("Codex answered the sign-in status check with something unexpected: %s", agentLoginRedactText(err.Error()))
	}
	if res.Account == nil {
		return AgentAccountState{State: AgentAccountSignedOut}, nil
	}
	return AgentAccountState{
		State:        AgentAccountSignedIn,
		AccountLabel: codexAccountLabel(res.Account),
	}, nil
}

// codexAccountLabel is the identity the Settings page shows. A ChatGPT account
// with no email on the record is still that account, labelled by kind.
func codexAccountLabel(a *codexAccount) string {
	if a == nil {
		return ""
	}
	switch a.Type {
	case "apiKey":
		return "API key"
	case "", "chatgpt":
		if a.Email != "" {
			return a.Email
		}
		return "ChatGPT"
	default:
		if a.Email != "" {
			return a.Email
		}
		return a.Type
	}
}

// Login runs the device-code sign-in to its end: handshake, start, publish the
// link and code, then wait for account/login/completed while watching for the
// user's cancel.
func (d *CodexLoginDriver) Login(ctx context.Context, s AgentLoginSession) (AgentLoginResult, error) {
	var zero AgentLoginResult
	c, err := d.start(ctx)
	if err != nil {
		return zero, err
	}
	defer c.Close()

	raw, err := c.call(ctx, "account/login/start", map[string]any{"type": "chatgptDeviceCode"})
	if err != nil {
		if ctx.Err() != nil {
			return zero, ctx.Err()
		}
		if strings.Contains(strings.ToLower(err.Error()), "device code") {
			return zero, errors.New(codexDeviceCodeDisabled)
		}
		if errors.Is(err, errCodexSilent) {
			return zero, errors.New("Codex didn't answer the sign-in request in time.")
		}
		return zero, fmt.Errorf("Codex couldn't start the sign-in: %s", agentLoginRedactText(err.Error()))
	}
	var start codexLoginStart
	if err := json.Unmarshal(raw, &start); err != nil || start.VerificationURL == "" {
		return zero, errors.New("Codex didn't return a sign-in link.")
	}
	if err := s.Prompt(ctx, AgentLoginPrompt{
		VerificationURL: start.VerificationURL,
		UserCode:        start.UserCode,
		NeedsCode:       false,
	}); err != nil {
		return zero, err
	}

	completed, err := c.waitLoginCompleted(ctx, s, start.LoginID)
	if err != nil {
		if errors.Is(err, ErrAgentLoginStopped) && start.LoginID != "" {
			// Tell the harness to drop the pending device-code attempt so the
			// code the user was shown stops working with this one.
			cancelCtx, cancelCancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
			_, _ = c.call(cancelCtx, "account/login/cancel", map[string]any{"loginId": start.LoginID})
			cancelCancel()
		}
		return zero, err
	}
	if !completed.Success {
		text := completed.Error
		if text == "" {
			text = "the provider didn't say why"
		}
		return zero, fmt.Errorf("Codex sign-in failed: %s", agentLoginRedactText(text))
	}
	state, err := d.accountState(ctx, c)
	if err != nil {
		if ctx.Err() != nil {
			return zero, ctx.Err()
		}
		// The provider said the sign-in completed: the label is decoration, and
		// telling the operator their login failed when it did not would send
		// them back through a flow that already worked.
		return AgentLoginResult{}, nil
	}
	return AgentLoginResult{AccountLabel: state.AccountLabel}, nil
}

// waitLoginCompleted blocks on account/login/completed. The app-server pushes
// the notification whenever the user finishes on their device, however long
// that takes; the only clock on the wait is the row's own expiry (ctx) and the
// periodic cancel check.
func (c *codexClient) waitLoginCompleted(ctx context.Context, s AgentLoginSession, loginID string) (codexLoginCompleted, error) {
	var out codexLoginCompleted
	ticker := time.NewTicker(agentLoginStopPollInterval)
	defer ticker.Stop()
	for {
		select {
		case m, ok := <-c.notify:
			if !ok {
				return out, errors.New("the Codex sign-in helper stopped before the sign-in finished.")
			}
			if m.Method != "account/login/completed" {
				continue // remoteControl/status/changed and anything else new
			}
			var p codexLoginCompleted
			if err := json.Unmarshal(m.Params, &p); err != nil {
				continue
			}
			if loginID != "" && p.LoginID != "" && p.LoginID != loginID {
				continue // a completion for some other attempt
			}
			return p, nil
		case <-c.dead:
			return out, errors.New("the Codex sign-in helper stopped before the sign-in finished.")
		case <-ticker.C:
			stopped, err := s.Stopped(ctx)
			if stopped {
				return out, ErrAgentLoginStopped
			}
			if err != nil && ctx.Err() == nil {
				continue // a store blip must not end a live sign-in
			}
			if ctx.Err() != nil {
				return out, ctx.Err()
			}
		case <-ctx.Done():
			// The row's own deadline outranks a plain cancel: the loop maps
			// ErrAgentLoginStopped through the last status it polled, and an
			// expiry has no poll behind it.
			if errors.Is(ctx.Err(), context.DeadlineExceeded) {
				return out, context.DeadlineExceeded
			}
			return out, ErrAgentLoginStopped
		}
	}
}
