package acp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os/exec"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/coder/acp-go-sdk"
	"github.com/dbirks/communication/internal/domain"
)

// handle is a live ACP conversation: one agent process, one session, one
// normalized event stream. It implements both domain.AgentHandle and the
// SDK's acp.Client (agent→client side).
type handle struct {
	conn   *acp.ClientSideConnection
	policy PermissionPolicy
	logger *slog.Logger
	stderr *ringBuffer

	cmd   *exec.Cmd
	stdin io.Closer

	sessionID       string
	protocolVersion int
	loadSession     bool

	// decider, when set, answers session/request_permission by callback
	// (the worker's durable human bridge) instead of the static policy.
	decider domain.PermissionDecider
	// info records the observed handshake for the session binding row.
	info domain.SessionInfo

	events chan domain.ConversationEvent
	seq    atomic.Int64

	// ctx is canceled when Close begins; it unblocks emit and pending waits.
	ctx    context.Context
	cancel context.CancelFunc

	// turnCtxMu guards turnCtx: the context of the Prompt currently in
	// flight. Permission deciders hang off it so a turn ending (or being
	// cancelled) unblocks a pending human decision, while the session
	// itself survives across turns.
	turnCtxMu sync.Mutex
	turnCtx   context.Context

	// mu guards event emission against send-on-closed-channel races.
	mu        sync.RWMutex
	evtClosed bool

	// exited is closed when cmd.Wait returns (or immediately for
	// process-less test handles).
	exited chan struct{}
	// exitErr holds cmd.Wait's verdict, written before exited closes.
	exitErrMu sync.Mutex
	exitErr   error

	// discMu guards the mid-turn disconnect record: the transport death that
	// happened *while* a turn was in flight, if any (disconnect.go). It is
	// sticky until the next turn begins so the caller can ask after Prompt
	// returns, and it is cleared at the start of every turn so one death can
	// never be blamed on a later, healthy answer.
	discMu   sync.Mutex
	inTurn   bool
	turnDisc *DisconnectInfo

	closeOnce sync.Once

	// Permission bookkeeping. permWaiters are woken when the current turn
	// is cancelled so in-flight session/request_permission calls resolve
	// with the cancelled outcome.
	permMu        sync.Mutex
	turnCancelled bool
	permWaiters   map[chan struct{}]struct{}
}

var (
	_ domain.AgentHandle = (*handle)(nil)
	_ acp.Client         = (*handle)(nil)
)

// SessionID returns the ACP session identifier from session/new.
func (h *handle) SessionID() string { return h.sessionID }

// deciderBase returns the context a permission decision runs under: the
// in-flight turn's context when one exists, the handle's otherwise.
func (h *handle) deciderBase() context.Context {
	h.turnCtxMu.Lock()
	defer h.turnCtxMu.Unlock()
	if h.turnCtx != nil {
		return h.turnCtx
	}
	return h.ctx
}

// LoadSessionSupported reports whether the agent advertised loadSession.
func (h *handle) LoadSessionSupported() bool { return h.loadSession }

// Info reports the observed session handshake (session id, negotiated
// protocol version, agent capabilities as seen, launcher and mode).
func (h *handle) Info() domain.SessionInfo { return h.info }

// ProtocolVersion reports the negotiated ACP protocol version.
func (h *handle) ProtocolVersion() int { return h.protocolVersion }

// Stderr returns the last bytes the agent wrote to stderr (bounded ring).
func (h *handle) Stderr() string {
	if h.stderr == nil {
		return ""
	}
	return h.stderr.String()
}

// Events returns the normalized event stream (buffered, capacity 1024).
func (h *handle) Events() <-chan domain.ConversationEvent { return h.events }

// StartOptions customises one session launch beyond the process spec.
type StartOptions struct {
	// ModeID switches the session into a prompting mode via session/set_mode
	// after the session exists. An empty ModeID keeps the adapter default.
	ModeID string
	// LoadSessionID restores this session id via session/load when the agent
	// advertised loadSession; a failed load falls back to session/new and
	// Info().Origin records which happened (ADR-0016 §6 — never a silent
	// resume).
	LoadSessionID string
	// Decider answers permission prompts for this session's lifetime; nil
	// keeps the Runtime's static PermissionPolicy.
	Decider domain.PermissionDecider
	// LauncherVersion is recorded verbatim into Info for the binding row;
	// the caller resolved it from the launcher registry.
	LauncherVersion string
}

// handshake performs initialize + session/new (or session/load) and records
// the negotiated protocol version, agent capabilities and session
// identifier.
func (h *handle) handshake(ctx context.Context, spec domain.AgentLaunchSpec, opts StartOptions) error {
	initResp, err := h.conn.Initialize(ctx, acp.InitializeRequest{
		ProtocolVersion: acp.ProtocolVersionNumber,
		ClientCapabilities: acp.ClientCapabilities{
			// M0: the client deliberately offers no fs or terminal
			// services; any such agent request is answered with
			// method-not-found.
			Fs:       acp.FileSystemCapabilities{ReadTextFile: false, WriteTextFile: false},
			Terminal: false,
		},
		ClientInfo: &acp.Implementation{Name: "communication", Version: "0.1.0"},
	})
	if err != nil {
		return fmt.Errorf("acp: initialize: %w", err)
	}
	h.protocolVersion = int(initResp.ProtocolVersion)
	h.loadSession = initResp.AgentCapabilities.LoadSession

	newReq := acp.NewSessionRequest{
		Cwd:        spec.WorkDir,
		McpServers: []acp.McpServer{},
	}
	if len(spec.AdditionalDirs) > 0 && initResp.AgentCapabilities.SessionCapabilities.AdditionalDirectories != nil {
		newReq.AdditionalDirectories = append([]string(nil), spec.AdditionalDirs...)
	}

	origin := "new"
	switch {
	case opts.LoadSessionID != "" && h.loadSession:
		_, err := h.conn.LoadSession(ctx, acp.LoadSessionRequest{
			Cwd:        spec.WorkDir,
			McpServers: []acp.McpServer{},
			SessionId:  acp.SessionId(opts.LoadSessionID),
		})
		if err == nil {
			h.sessionID = opts.LoadSessionID
			origin = "resumed"
		} else {
			// A failed resume is a new session, visibly — never a silent
			// claim of restoration (ADR-0016 §6).
			if h.logger != nil {
				h.logger.Warn("acp: session/load failed; starting a new session",
					"session_id", opts.LoadSessionID, "err", err)
			}
			resp, err := h.conn.NewSession(ctx, newReq)
			if err != nil {
				return fmt.Errorf("acp: session/new (after failed session/load): %w", err)
			}
			h.sessionID = string(resp.SessionId)
		}
	default:
		sessionResp, err := h.conn.NewSession(ctx, newReq)
		if err != nil {
			return fmt.Errorf("acp: session/new: %w", err)
		}
		h.sessionID = string(sessionResp.SessionId)
	}

	if opts.ModeID != "" {
		// Prompting is a mode property on both probed adapters
		// (docs/compatibility/ACP.md "Permission modes"): failing to enter
		// the asking mode under an ask policy must fail closed, because the
		// adapter default silently auto-approves every tool call.
		if _, err := h.conn.SetSessionMode(ctx, acp.SetSessionModeRequest{
			SessionId: acp.SessionId(h.sessionID),
			ModeId:    acp.SessionModeId(opts.ModeID),
		}); err != nil {
			return fmt.Errorf("acp: session/set_mode %q: %w", opts.ModeID, err)
		}
	}

	h.info = domain.SessionInfo{
		ACPSessionID:      h.sessionID,
		ProtocolVersion:   h.protocolVersion,
		AgentCapabilities: capabilitiesMap(initResp),
		LauncherID:        spec.LauncherID,
		LauncherVersion:   opts.LauncherVersion,
		Origin:            origin,
		ModeID:            opts.ModeID,
	}
	return nil
}

// capabilitiesMap renders the agent's own initialize answer as plain data
// for the session-binding row. It is stored as observed and is never a
// capability claim (04).
func capabilitiesMap(resp acp.InitializeResponse) map[string]any {
	raw, err := json.Marshal(resp.AgentCapabilities)
	if err != nil {
		return map[string]any{}
	}
	var out map[string]any
	if err := json.Unmarshal(raw, &out); err != nil || out == nil {
		return map[string]any{}
	}
	if resp.AgentInfo != nil {
		out["agentInfo"] = map[string]any{"name": resp.AgentInfo.Name, "version": resp.AgentInfo.Version}
	}
	return out
}

// initLive wires the runtime fields shared by process and in-test handles.
// Called before the first use of the handle.
func (h *handle) initLive() {
	if h.events == nil {
		h.events = make(chan domain.ConversationEvent, eventBuffer)
	}
	if h.exited == nil {
		h.exited = make(chan struct{})
		close(h.exited)
	}
	if h.permWaiters == nil {
		h.permWaiters = make(map[chan struct{}]struct{})
	}
	if h.ctx == nil {
		h.ctx, h.cancel = context.WithCancel(context.Background())
	}
}

// attachProcess arranges process reaping for handle launched via exec.Cmd.
func (h *handle) attachProcess(cmd *exec.Cmd, stdout io.ReadCloser) {
	h.events = make(chan domain.ConversationEvent, eventBuffer)
	h.exited = make(chan struct{})
	h.permWaiters = make(map[chan struct{}]struct{})
	h.ctx, h.cancel = context.WithCancel(context.Background())
	go func() {
		defer close(h.exited)
		// Ensure the reader goroutine in the SDK connection ends: closing
		// the pipe after Wait is documented behaviour, but we must not
		// leak if Wait blocks on a live pipe.
		err := cmd.Wait()
		_ = stdout.Close()
		h.exitErrMu.Lock()
		h.exitErr = err
		h.exitErrMu.Unlock()
		if err != nil && h.logger != nil {
			h.logger.Debug("acp: agent process exited", "err", err)
		}
	}()
}

const eventBuffer = 1024

// disconnectReapWait bounds how long Prompt waits for cmd.Wait to agree that
// the peer it lost was a process that died. Sub-second on purpose: the reap
// of a dead child is immediate, and an attempt deadline is never worth
// microseconds of certainty.
const disconnectReapWait = 500 * time.Millisecond

// emit publishes one normalized event. It never drops the oldest unread
// event: when the buffer is full it blocks until space frees up or the
// handle's context is cancelled. Events lost are only those emitted after
// Close has already closed the stream.
func (h *handle) emit(ev domain.ConversationEvent) {
	ev.Seq = h.seq.Add(1)
	ev.At = time.Now()
	h.mu.RLock()
	defer h.mu.RUnlock()
	if h.evtClosed {
		return
	}
	select {
	case h.events <- ev:
	case <-h.ctx.Done():
	}
}

// exitDetail returns cmd.Wait's verdict as text ("" while the process lives
// or when it exited cleanly).
func (h *handle) exitDetail() string {
	h.exitErrMu.Lock()
	defer h.exitErrMu.Unlock()
	if h.exitErr == nil {
		return ""
	}
	return h.exitErr.Error()
}

// beginTurn opens a turn: any earlier disconnect record is dropped, because
// from here on the only death that matters is one that outruns this answer.
func (h *handle) beginTurn() {
	h.discMu.Lock()
	defer h.discMu.Unlock()
	h.inTurn = true
	h.turnDisc = nil
}

// endTurn closes a turn. The record itself stays readable (Disconnect) until
// the next turn begins; only the in-flight window shuts.
func (h *handle) endTurn() {
	h.discMu.Lock()
	defer h.discMu.Unlock()
	h.inTurn = false
}

// recordDisconnect notes a transport death, but only while a turn is in
// flight: a harness that answers and then exits is the protocol working as
// designed, and its exit is not a mid-turn disconnect.
func (h *handle) recordDisconnect(info DisconnectInfo) {
	h.discMu.Lock()
	defer h.discMu.Unlock()
	if !h.inTurn || h.turnDisc != nil {
		return
	}
	stored := info
	h.turnDisc = &stored
}

// Disconnect reports the transport death observed during the turn that
// Prompt last reported on, if any (DisconnectReporter).
func (h *handle) Disconnect() (DisconnectInfo, bool) {
	h.discMu.Lock()
	defer h.discMu.Unlock()
	if h.turnDisc == nil || h.turnDisc.Reason == "" {
		return DisconnectInfo{}, false
	}
	return *h.turnDisc, true
}

// awaitReap waits a bounded moment for the process behind a closed connection
// to be reaped, so a mid-turn death reports the stronger reason it deserves.
// The bound keeps a wedged reap from ever stalling an attempt.
func (h *handle) awaitReap(wait time.Duration) (DisconnectInfo, bool) {
	if h.cmd == nil || h.exited == nil {
		return DisconnectInfo{}, false
	}
	select {
	case <-h.exited:
		return DisconnectInfo{Reason: DisconnectReasonProcessExited, Detail: h.exitDetail()}, true
	case <-time.After(wait):
		return DisconnectInfo{}, false
	}
}

// watchProcessDeath records the harness dying while the turn is open. done
// closes the moment the SDK returns an answer, which is the ordering that
// keeps a normal end-then-exit from reading as a disconnect.
func (h *handle) watchProcessDeath(done <-chan struct{}) {
	if h.cmd == nil || h.exited == nil {
		return
	}
	go func() {
		select {
		case <-done:
			return
		case <-h.exited:
			select {
			case <-done:
				return
			default:
			}
			h.recordDisconnect(DisconnectInfo{
				Reason: DisconnectReasonProcessExited,
				Detail: h.exitDetail(),
			})
		}
	}()
}

// Prompt sends one user turn and blocks until it completes.
func (h *handle) Prompt(ctx context.Context, text string) (domain.StopReason, error) {
	h.permMu.Lock()
	h.turnCancelled = false
	h.permMu.Unlock()

	h.turnCtxMu.Lock()
	h.turnCtx = ctx
	h.turnCtxMu.Unlock()
	defer func() {
		h.turnCtxMu.Lock()
		h.turnCtx = nil
		h.turnCtxMu.Unlock()
	}()

	h.beginTurn()
	done := make(chan struct{})
	h.watchProcessDeath(done)

	resp, err := h.conn.Prompt(ctx, acp.PromptRequest{
		SessionId: acp.SessionId(h.sessionID),
		Prompt: []acp.ContentBlock{{
			Text: &acp.ContentBlockText{Type: "text", Text: text},
		}},
	})
	close(done)
	if err != nil {
		// The transport dying mid-turn is a transport fact, and the caller
		// must be able to tell it from an agent that answered badly: name it
		// once, here, rather than letting each caller re-parse SDK prose. The
		// turn window stays open while we work out *which* death it was — a
		// peer that vanished mid-request is usually a process that died, and
		// the reap lands a moment after the read error.
		info, dead := h.Disconnect()
		if !dead {
			info, dead = disconnectFromError(err)
			if dead && info.Reason == DisconnectReasonConnectionClosed {
				if reaped, ok := h.awaitReap(disconnectReapWait); ok {
					info = reaped
				}
			}
		}
		if dead {
			h.recordDisconnect(info)
		}
		h.endTurn()
		if dead {
			return "", &DisconnectedError{Info: info, Err: err}
		}
		return "", err
	}
	h.endTurn()
	return mapStopReason(resp.StopReason), nil
}

// mapStopReason translates an ACP stop reason into the domain enum;
// anything unrecognized maps to StopOther.
func mapStopReason(r acp.StopReason) domain.StopReason {
	switch r {
	case acp.StopReasonEndTurn:
		return domain.StopEndTurn
	case acp.StopReasonCancelled:
		return domain.StopCancelled
	case acp.StopReasonMaxTokens:
		return domain.StopMaxTokens
	case acp.StopReasonRefusal:
		return domain.StopRefusal
	default:
		return domain.StopOther
	}
}

// Cancel requests cancellation of the in-flight turn and resolves any
// pending permission request with the cancelled outcome.
func (h *handle) Cancel(ctx context.Context) error {
	// Mark the turn cancelled *before* notifying the agent. The SDK writes
	// notifications synchronously and dispatches each inbound request on a
	// fresh goroutine, so a prompt-requesting agent can answer
	// session/cancel with session/request_permission before this call
	// returns; its handler must already observe turnCancelled and resolve
	// with the cancelled outcome. Setting the flag after the write races
	// that window and lets the permission be answered "selected".
	h.markTurnCancelled()
	return h.conn.Cancel(ctx, acp.CancelNotification{SessionId: acp.SessionId(h.sessionID)})
}

// markTurnCancelled flips the turn flag and releases every pending
// permission waiter. Cancel does it before writing session/cancel; it is
// split out so in-process tests can drive the cancel race directly.
func (h *handle) markTurnCancelled() {
	h.permMu.Lock()
	h.turnCancelled = true
	waiters := h.permWaiters
	h.permWaiters = make(map[chan struct{}]struct{})
	h.permMu.Unlock()
	for w := range waiters {
		close(w)
	}
}

// Close terminates the agent process and closes the event stream exactly
// once. It is idempotent.
func (h *handle) Close() error {
	var waitErr error
	h.closeOnce.Do(func() {
		// Unblock emitters and permission waits first, then close stdin so
		// well-behaved agents exit on EOF.
		h.cancel()
		if h.stdin != nil {
			_ = h.stdin.Close()
		}
		if h.cmd != nil && h.cmd.Process != nil {
			waitErr = h.waitProcess()
		}
		h.mu.Lock()
		h.evtClosed = true
		h.mu.Unlock()
		close(h.events)
	})
	return waitErr
}

// waitProcess runs the shutdown ladder: EOF wait ≤5s → SIGTERM ≤5s →
// SIGKILL.
func (h *handle) waitProcess() error {
	select {
	case <-h.exited:
		return nil
	case <-time.After(5 * time.Second):
	}
	// Ask the agent to exit; exec.CommandContext's own kill-on-ctx stays as
	// the last resort for the process group if this is ignored.
	if err := h.cmd.Process.Signal(syscall.SIGTERM); err != nil && h.logger != nil {
		h.logger.Debug("acp: SIGTERM failed", "err", err)
	}
	select {
	case <-h.exited:
		return nil
	case <-time.After(5 * time.Second):
	}
	_ = h.cmd.Process.Kill()
	<-h.exited
	return errors.New("acp: agent process required SIGKILL")
}

// ---------------------------------------------------------------------------
// acp.Client implementation (agent → client traffic)
// ---------------------------------------------------------------------------

// SessionUpdate maps one ACP session/update onto the normalized event
// stream. Unknown update kinds map to Kind "unknown" and never crash.
func (h *handle) SessionUpdate(_ context.Context, n acp.SessionNotification) error {
	u := n.Update
	switch {
	case u.AgentMessageChunk != nil:
		h.emit(domain.ConversationEvent{
			Kind: "message_chunk",
			Text: contentText(u.AgentMessageChunk.Content),
		})
	case u.AgentThoughtChunk != nil:
		h.emit(domain.ConversationEvent{
			Kind: "thought_chunk",
			Text: contentText(u.AgentThoughtChunk.Content),
		})
	case u.ToolCall != nil:
		input, _ := previewValue(u.ToolCall.RawInput, maxToolPreviewBytes)
		h.emit(domain.ConversationEvent{
			Kind:       "tool_call",
			ToolCallID: string(u.ToolCall.ToolCallId),
			Text:       u.ToolCall.Title,
			ToolKind:   string(u.ToolCall.Kind),
			ToolStatus: string(u.ToolCall.Status),
			Input:      input,
		})
	case u.ToolCallUpdate != nil:
		text := ""
		if u.ToolCallUpdate.Title != nil {
			text = *u.ToolCallUpdate.Title
		}
		status := ""
		if u.ToolCallUpdate.Status != nil {
			status = string(*u.ToolCallUpdate.Status)
		}
		kind := ""
		if u.ToolCallUpdate.Kind != nil {
			kind = string(*u.ToolCallUpdate.Kind)
		}
		output := toolContentText(u.ToolCallUpdate.Content, maxToolPreviewBytes)
		if output == "" {
			output, _ = previewValue(u.ToolCallUpdate.RawOutput, maxToolPreviewBytes)
		}
		h.emit(domain.ConversationEvent{
			Kind:       "tool_call_update",
			ToolCallID: string(u.ToolCallUpdate.ToolCallId),
			Text:       text,
			ToolKind:   kind,
			ToolStatus: status,
			Output:     output,
		})
	case u.Plan != nil:
		h.emit(domain.ConversationEvent{Kind: "plan"})
	default:
		// user_message_chunk, current_mode_update, config_option_update,
		// available_commands_update, usage_update, session_info_update,
		// plan_update/plan_removed and anything a future spec adds all map
		// to "unknown": opaque, never fatal (docs/compatibility/ACP.md).
		h.emit(domain.ConversationEvent{Kind: "unknown"})
	}
	return nil
}

func contentText(c acp.ContentBlock) string {
	if c.Text != nil {
		return c.Text.Text
	}
	return ""
}

// RequestPermission answers a session/request_permission either by the
// session's callback decider (the worker's durable human bridge) or by the
// handle's static policy. A cancelled turn always resolves with the
// cancelled outcome, and an answer naming an option the agent never offered
// is discarded rather than echoed back.
func (h *handle) RequestPermission(ctx context.Context, params acp.RequestPermissionRequest) (acp.RequestPermissionResponse, error) {
	permText := ""
	if params.ToolCall.Title != nil {
		permText = *params.ToolCall.Title
	}
	h.emit(domain.ConversationEvent{
		Kind:       "permission_request",
		ToolCallID: string(params.ToolCall.ToolCallId),
		Text:       permText,
	})

	waiter := make(chan struct{})
	h.permMu.Lock()
	if h.turnCancelled {
		h.permMu.Unlock()
		return cancelledPermission(), nil
	}
	h.permWaiters[waiter] = struct{}{}
	decider := h.decider
	h.permMu.Unlock()

	var selected acp.PermissionOptionId
	var ok bool
	if decider != nil {
		// The decider runs under a context that ends with the turn: the
		// in-flight Prompt's context (worker cancel/drain) or the handle
		// itself. A pending human decision must never outlive its turn.
		dctx, dcancel := context.WithCancel(h.deciderBase())
		defer dcancel()
		go func() {
			select {
			case <-waiter:
				dcancel()
			case <-dctx.Done():
			}
		}()
		choice, err := decider(dctx, permissionPrompt(params))
		if err != nil {
			if h.logger != nil {
				h.logger.Warn("acp: permission decider failed; answering cancelled",
					"tool_call_id", string(params.ToolCall.ToolCallId), "err", err)
			}
			return cancelledPermission(), nil
		}
		selected, ok = findOptionID(params.Options, acp.PermissionOptionId(choice.OptionID))
		if !ok && choice.OptionID != "" {
			if h.logger != nil {
				h.logger.Warn("acp: permission decider named an option the agent did not offer; answering cancelled",
					"option_id", choice.OptionID, "tool_call_id", string(params.ToolCall.ToolCallId))
			}
		}
	} else {
		selected, ok = h.selectPermissionOption(params)
	}

	select {
	case <-waiter:
		// The turn was cancelled while the decision was being made;
		// the cancelled outcome wins per protocol.
		return cancelledPermission(), nil
	default:
	}

	if !ok {
		return cancelledPermission(), nil
	}
	var resp *acp.RequestPermissionResponse
	resp = &acp.RequestPermissionResponse{
		Outcome: acp.RequestPermissionOutcome{
			Selected: &acp.RequestPermissionOutcomeSelected{OptionId: selected},
		},
	}
	h.permMu.Lock()
	delete(h.permWaiters, waiter)
	cancelled := h.turnCancelled
	h.permMu.Unlock()
	if cancelled {
		return cancelledPermission(), nil
	}
	return *resp, nil
}

// permissionPrompt normalises an ACP permission request into the domain
// shape the worker bridges to a human.
func permissionPrompt(params acp.RequestPermissionRequest) domain.PermissionPrompt {
	title := ""
	if params.ToolCall.Title != nil {
		title = *params.ToolCall.Title
	}
	p := domain.PermissionPrompt{
		ToolCallID: string(params.ToolCall.ToolCallId),
		Title:      title,
	}
	if params.ToolCall.Kind != nil {
		p.Kind = string(*params.ToolCall.Kind)
	}
	for _, o := range params.Options {
		p.Options = append(p.Options, domain.PermissionOption{
			OptionID: string(o.OptionId),
			Label:    o.Name,
			Kind:     string(o.Kind),
		})
	}
	return p
}

func findOptionID(options []acp.PermissionOption, id acp.PermissionOptionId) (acp.PermissionOptionId, bool) {
	for _, o := range options {
		if o.OptionId == id {
			return o.OptionId, true
		}
	}
	return "", false
}

func cancelledPermission() acp.RequestPermissionResponse {
	return acp.RequestPermissionResponse{
		Outcome: acp.RequestPermissionOutcome{
			Cancelled: &acp.RequestPermissionOutcomeCancelled{},
		},
	}
}

// The remaining acp.Client methods are unsupported by design in M0: we
// advertise fs read/write = false and terminal = false, so a compliant
// agent must not call them. If one does, answer method-not-found rather
// than hanging.

func (h *handle) ReadTextFile(_ context.Context, _ acp.ReadTextFileRequest) (acp.ReadTextFileResponse, error) {
	return acp.ReadTextFileResponse{}, acp.NewMethodNotFound("fs/read_text_file")
}

func (h *handle) WriteTextFile(_ context.Context, _ acp.WriteTextFileRequest) (acp.WriteTextFileResponse, error) {
	return acp.WriteTextFileResponse{}, acp.NewMethodNotFound("fs/write_text_file")
}

func (h *handle) CreateTerminal(_ context.Context, _ acp.CreateTerminalRequest) (acp.CreateTerminalResponse, error) {
	return acp.CreateTerminalResponse{}, acp.NewMethodNotFound("terminal/create")
}

func (h *handle) KillTerminal(_ context.Context, _ acp.KillTerminalRequest) (acp.KillTerminalResponse, error) {
	return acp.KillTerminalResponse{}, acp.NewMethodNotFound("terminal/kill")
}

func (h *handle) TerminalOutput(_ context.Context, _ acp.TerminalOutputRequest) (acp.TerminalOutputResponse, error) {
	return acp.TerminalOutputResponse{}, acp.NewMethodNotFound("terminal/output")
}

func (h *handle) ReleaseTerminal(_ context.Context, _ acp.ReleaseTerminalRequest) (acp.ReleaseTerminalResponse, error) {
	return acp.ReleaseTerminalResponse{}, acp.NewMethodNotFound("terminal/release")
}

func (h *handle) WaitForTerminalExit(_ context.Context, _ acp.WaitForTerminalExitRequest) (acp.WaitForTerminalExitResponse, error) {
	return acp.WaitForTerminalExitResponse{}, acp.NewMethodNotFound("terminal/wait_for_exit")
}
