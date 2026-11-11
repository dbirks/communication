package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/coder/acp-go-sdk"
)

// envACPMode gates this subcommand. It is not a feature toggle for operators: it
// is the reason the command refuses to run at all outside an attempt pod built
// for the purpose, so a binary that ships to production cannot be talked into
// being an agent.
const envACPMode = "COMMUNICATION_ACP_ECHO"

// envACPModeProbe is an environment entry the launcher carries for the echo only.
// Whatever lands in it is spoken back in the reply, which is how the Kubernetes
// proof (spike S2) shows that a value delivered as a Secret file — and named
// nowhere in the exec request — arrived in the agent's environment intact.
const envACPModeProbe = "COMMUNICATION_ACP_ECHO_PROBE"

// acpEchoName is the fixed prefix of every reply and the agent's own name, so a
// test can tell "this came from the echo" from "this came from a real harness".
const acpEchoName = "acp-echo"

// runACPEcho serves the Agent Client Protocol (ADR-0020) over the process's
// stdio as the smallest agent that can answer it: the handshake every launcher
// performs (initialize, session/new), and a session/prompt reply that quotes the
// prompt, the cwd and the probe entry back as one streamed message chunk.
//
// It exists for the proof ADR-0082 spike S2 demands — that ACP rides a
// `pods/exec` stdio pipe through the production Transporter against the
// production client — and for nothing else: a real harness needs a model, and a
// test that needs a real harness needs a lab. It is therefore not advertised in
// the usage text, and it refuses to start unless COMMUNICATION_ACP_ECHO=1 says
// otherwise, because the shape of a working ACP agent is exactly the thing worth
// faking and exactly the thing that must not be reachable by accident.
//
// Framing is the SDK's job: one JSON-RPC object per line on stdout, read from
// stdin — the same contract the real adapters (pi-acp, codex-acp) meet, which is
// why faking this end proves something about the pipe rather than about the
// harness.
func runACPEcho(stdin io.Reader, stdout, stderr io.Writer) int {
	if os.Getenv(envACPMode) != "1" {
		fmt.Fprintf(stderr, "acp-echo: refusing to start: %s must be 1 (this is a test harness, not an agent)\n", envACPMode)
		return 2
	}
	agent := &echoAgent{probe: os.Getenv(envACPModeProbe), log: stderr}
	// The SDK starts reading the peer immediately, so the connection is handed to
	// the agent before it can serve a prompt: the reply channel (session/update)
	// is a method on the connection, not on the agent.
	conn := acp.NewAgentSideConnection(agent, stdout, stdin)
	agent.SetAgentConnection(conn)
	<-conn.Done()
	return 0
}

// echoAgent is the acp.Agent the echo serves. It holds no session state: a
// prompt is answered in the one call that carries it, and every other method is
// an honest refusal, because a harness that quietly accepted work it cannot do
// would prove less than one that says it cannot.
type echoAgent struct {
	conn  *acp.AgentSideConnection
	probe string
	log   io.Writer
}

var _ acp.Agent = (*echoAgent)(nil)

// SetAgentConnection installs the peer connection (the SDK's own convention; see
// runACPEcho for why it is set by hand).
func (a *echoAgent) SetAgentConnection(c *acp.AgentSideConnection) { a.conn = c }

func (a *echoAgent) Initialize(_ context.Context, params acp.InitializeRequest) (acp.InitializeResponse, error) {
	version := params.ProtocolVersion
	if version != acp.ProtocolVersionNumber {
		// The client's answer to a version it did not ask for is a handshake
		// failure, which is the protocol's rule rather than this harness's.
		version = acp.ProtocolVersionNumber
	}
	return acp.InitializeResponse{
		ProtocolVersion: version,
		AgentCapabilities: acp.AgentCapabilities{
			// No fs, no terminal services, no resume, no load: the handshake
			// and one prompt turn are all this answers.
			LoadSession: false,
		},
		AgentInfo: &acp.Implementation{
			Name:    acpEchoName,
			Title:   ptrString("Communication ACP echo (test harness)"),
			Version: "0.0.1",
		},
	}, nil
}

func (a *echoAgent) NewSession(_ context.Context, params acp.NewSessionRequest) (acp.NewSessionResponse, error) {
	if params.Cwd == "" {
		return acp.NewSessionResponse{}, errors.New("acp-echo: session/new carries no cwd")
	}
	// The id is derived from the cwd rather than random: the S2 proof quotes it
	// back, and a fixed id makes a failed run readable.
	return acp.NewSessionResponse{
		SessionId: acp.SessionId(acpEchoName + "/" + params.Cwd),
	}, nil
}

func (a *echoAgent) Prompt(ctx context.Context, params acp.PromptRequest) (acp.PromptResponse, error) {
	reply := fmt.Sprintf("%s: prompt=%q probe=%q session=%q", acpEchoName, promptText(params.Prompt), a.probe, params.SessionId)
	if a.conn == nil {
		return acp.PromptResponse{}, errors.New("acp-echo: no connection to answer on")
	}
	// Streaming a message chunk before answering is what the real harnesses do,
	// and the client's event channel is how a turn's text reaches the journal: an
	// echo that only answered the request would leave the pipe half-proved.
	if err := a.conn.SessionUpdate(ctx, acp.SessionNotification{
		SessionId: params.SessionId,
		Update:    acp.UpdateAgentMessageText(reply),
	}); err != nil {
		fmt.Fprintf(a.log, "acp-echo: session/update: %v\n", err)
		return acp.PromptResponse{}, err
	}
	return acp.PromptResponse{StopReason: acp.StopReasonEndTurn}, nil
}

// promptText flattens a prompt's content blocks to the text the echo quotes back.
func promptText(blocks []acp.ContentBlock) string {
	var parts []string
	for _, block := range blocks {
		if block.Text != nil {
			parts = append(parts, block.Text.Text)
		}
	}
	return strings.Join(parts, " ")
}

func ptrString(s string) *string { return &s }

// The rest of acp.Agent is present so the echo compiles against the interface and
// answers honestly: an unimplemented method is a refusal with a reason, never a
// silent success the client would mistake for capability.

func (a *echoAgent) Authenticate(_ context.Context, _ acp.AuthenticateRequest) (acp.AuthenticateResponse, error) {
	return acp.AuthenticateResponse{}, errors.New("acp-echo: authenticate is not implemented")
}

func (a *echoAgent) Logout(_ context.Context, _ acp.LogoutRequest) (acp.LogoutResponse, error) {
	return acp.LogoutResponse{}, errors.New("acp-echo: logout is not implemented")
}

func (a *echoAgent) Cancel(_ context.Context, _ acp.CancelNotification) error { return nil }

func (a *echoAgent) CloseSession(_ context.Context, _ acp.CloseSessionRequest) (acp.CloseSessionResponse, error) {
	return acp.CloseSessionResponse{}, errors.New("acp-echo: session/close is not implemented")
}

func (a *echoAgent) ListSessions(_ context.Context, _ acp.ListSessionsRequest) (acp.ListSessionsResponse, error) {
	return acp.ListSessionsResponse{}, errors.New("acp-echo: session/list is not implemented")
}

func (a *echoAgent) ResumeSession(_ context.Context, _ acp.ResumeSessionRequest) (acp.ResumeSessionResponse, error) {
	return acp.ResumeSessionResponse{}, errors.New("acp-echo: session/resume is not implemented")
}

func (a *echoAgent) SetSessionMode(_ context.Context, _ acp.SetSessionModeRequest) (acp.SetSessionModeResponse, error) {
	return acp.SetSessionModeResponse{}, errors.New("acp-echo: session/set_mode is not implemented")
}

func (a *echoAgent) SetSessionConfigOption(_ context.Context, _ acp.SetSessionConfigOptionRequest) (acp.SetSessionConfigOptionResponse, error) {
	return acp.SetSessionConfigOptionResponse{}, errors.New("acp-echo: session/set_config_option is not implemented")
}
