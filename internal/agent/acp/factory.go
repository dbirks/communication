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
	// RequirePlan makes a missing sandbox launch plan a failure instead of a
	// quiet unsandboxed launch. The worker sets it in `required` mode; without
	// it, a turn whose workspace was prepared but whose plan was never attached
	// would exec the adapter directly, which is exactly the fallback ADR-0019
	// forbids. Tests and `doctor` leave it false.
	RequirePlan bool
	// BuildEnv, when set, produces the launch environment for a session that
	// has no plan (the `doctor` shape: no workspace, so no per-run HOME). It
	// receives the launcher so the registry's declared auth variables are the
	// only ones picked up from the process environment.
	BuildEnv func(l Launcher) []string
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

	// The sandbox plan, if the worker attached one for this launch.
	//
	// Consuming it here rather than at the call site is what makes the guarantee
	// structural: any path that builds a session goes through this function, so a
	// new caller cannot forget the sandbox the way M2's single call site
	// effectively did. `RequirePlan` is the enforcement axis — with it set, an
	// absent plan is a failure, because "no plan" in `required` mode means
	// something upstream skipped verification, not that this agent is allowed to
	// run free.
	spec := domain.AgentLaunchSpec{
		LauncherID: l.ID,
		Executable: exe,
		Args:       l.Args,
		WorkDir:    req.WorkDir,
	}
	plan, havePlan := LaunchPlanFromContext(ctx)
	switch {
	case havePlan:
		// The plan wins over the launcher's registry argv, including when it
		// carries no sandbox: `disabled` mode produces a plan that execs the
		// adapter directly, and that shape has to be expressible without the
		// factory having to guess which of its two inputs to trust.
		spec.Executable = plan.Path
		spec.Args = plan.Args
		spec.WorkDir = plan.Dir
		if len(plan.Env) == 0 {
			return nil, fmt.Errorf("acp: launch spec for %s carries no environment: the worker must build it from scratch (acp.LaunchEnv), never inherit os.Environ()", plan.Path)
		}
		spec.Env = plan.Env
	case f.RequirePlan:
		return nil, fmt.Errorf("acp: %w for launcher %q", ErrNoLaunchPlan, l.ID)
	}

	return rt.StartWithOptions(ctx, spec, StartOptions{
		ModeID:          req.ModeID,
		LoadSessionID:   req.LoadSessionID,
		Decider:         req.Decider,
		LauncherVersion: l.Version,
	})
}
