package acp

import (
	"context"
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

	events chan domain.ConversationEvent
	seq    atomic.Int64

	// ctx is canceled when Close begins; it unblocks emit and pending waits.
	ctx    context.Context
	cancel context.CancelFunc

	// mu guards event emission against send-on-closed-channel races.
	mu        sync.RWMutex
	evtClosed bool

	// exited is closed when cmd.Wait returns (or immediately for
	// process-less test handles).
	exited chan struct{}

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

// LoadSessionSupported reports whether the agent advertised loadSession.
func (h *handle) LoadSessionSupported() bool { return h.loadSession }

// ProtocolVersion reports the negotiated ACP protocol version.
func (h *handle) ProtocolVersion() int { return h.protocolVersion }

// Stderr returns the last bytes the agent wrote to stderr (bounded ring).
func (h *handle) Stderr() string { return h.stderr.String() }

// Events returns the normalized event stream (buffered, capacity 1024).
func (h *handle) Events() <-chan domain.ConversationEvent { return h.events }

// handshake performs initialize + session/new and records the negotiated
// protocol version, agent capabilities and session identifier.
func (h *handle) handshake(ctx context.Context, spec domain.AgentLaunchSpec) error {
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
	sessionResp, err := h.conn.NewSession(ctx, newReq)
	if err != nil {
		return fmt.Errorf("acp: session/new: %w", err)
	}
	h.sessionID = string(sessionResp.SessionId)
	return nil
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
		if err != nil && h.logger != nil {
			h.logger.Debug("acp: agent process exited", "err", err)
		}
	}()
}

const eventBuffer = 1024

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

// Prompt sends one user turn and blocks until it completes.
func (h *handle) Prompt(ctx context.Context, text string) (domain.StopReason, error) {
	h.permMu.Lock()
	h.turnCancelled = false
	h.permMu.Unlock()

	resp, err := h.conn.Prompt(ctx, acp.PromptRequest{
		SessionId: acp.SessionId(h.sessionID),
		Prompt: []acp.ContentBlock{{
			Text: &acp.ContentBlockText{Type: "text", Text: text},
		}},
	})
	if err != nil {
		return "", err
	}
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
	h.permMu.Lock()
	h.turnCancelled = true
	waiters := h.permWaiters
	h.permWaiters = make(map[chan struct{}]struct{})
	h.permMu.Unlock()
	for w := range waiters {
		close(w)
	}
	return h.conn.Cancel(ctx, acp.CancelNotification{SessionId: acp.SessionId(h.sessionID)})
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
		h.emit(domain.ConversationEvent{
			Kind:       "tool_call",
			ToolCallID: string(u.ToolCall.ToolCallId),
			Text:       u.ToolCall.Title,
		})
	case u.ToolCallUpdate != nil:
		text := ""
		if u.ToolCallUpdate.Title != nil {
			text = *u.ToolCallUpdate.Title
		}
		h.emit(domain.ConversationEvent{
			Kind:       "tool_call_update",
			ToolCallID: string(u.ToolCallUpdate.ToolCallId),
			Text:       text,
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

// RequestPermission emits a permission_request event and answers per the
// handle's policy. A cancelled turn always resolves with the cancelled
// outcome.
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
	h.permMu.Unlock()

	selected, ok := h.selectPermissionOption(params)

	select {
	case <-waiter:
		// The turn was cancelled while the policy decision was being made;
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
