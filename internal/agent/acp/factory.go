package acp

import (
	"context"
	"fmt"
	"os/exec"

	"github.com/dbirks/communication/internal/domain"
)

// Factory turns the launcher registry into a domain.AgentSessionFactory:
// the worker asks for a launcher id and a workspace, and the factory
// resolves the pinned executable and launches it. Keeping resolution here
// means the registry (versions, ask-mode ids) stays the only place a
// launcher is described.
type Factory struct {
	// Runtime carries the shared launch configuration (logger etc.).
	Runtime *Runtime
	// Lookup resolves launcher ids; nil uses LookupLauncher.
	Lookup func(id string) (Launcher, bool)
	// LookPath resolves the launcher executable; nil uses exec.LookPath.
	LookPath func(file string) (string, error)
}

var _ domain.AgentSessionFactory = (*Factory)(nil)

// NewSession launches one ACP session per req. The returned session's
// Info() reports what was actually negotiated, including whether
// session/load restored LoadSessionID or a fresh session/new happened.
func (f *Factory) NewSession(ctx context.Context, req domain.SessionRequest) (domain.AgentSession, error) {
	lookup := f.Lookup
	if lookup == nil {
		lookup = LookupLauncher
	}
	l, ok := lookup(req.LauncherID)
	if !ok {
		return nil, fmt.Errorf("acp: unknown launcher %q", req.LauncherID)
	}
	lookPath := f.LookPath
	if lookPath == nil {
		lookPath = exec.LookPath
	}
	exe, err := lookPath(l.Executable)
	if err != nil {
		return nil, fmt.Errorf("acp: launcher %q executable %q: %w", l.ID, l.Executable, err)
	}

	rt := f.Runtime
	if rt == nil {
		rt = &Runtime{}
	}
	return rt.StartWithOptions(ctx, domain.AgentLaunchSpec{
		LauncherID: l.ID,
		Executable: exe,
		Args:       l.Args,
		WorkDir:    req.WorkDir,
	}, StartOptions{
		ModeID:          req.ModeID,
		LoadSessionID:   req.LoadSessionID,
		Decider:         req.Decider,
		LauncherVersion: l.Version,
	})
}
