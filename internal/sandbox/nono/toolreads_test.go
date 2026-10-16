package nono

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	wsgit "github.com/dbirks/communication/internal/workspace/git"
)

// ADR-0026's two launch-plan promises, pinned at the argv level: every
// ToolReads entry becomes its own `--read <dir>` flag (read is the level
// nono's Landlock ruleset pairs with exec, and no code path here can emit
// `--allow` for a program path), and an unresolvable entry refuses the launch
// BEFORE the child exists, because nono silently drops such a grant and would
// otherwise run a narrower sandbox than the one N-d verified (probe C-FC3).
//
// The behaviour itself was live-evidenced in the M4 lab (exit 126 → success);
// this is the Go pin the ADR's Verification section recorded as missing.

// toolReadsRoot is grant-legitimate scratch: ADR-0019 P9 / probe C-TMP1 refuse
// a /tmp root, so t.TempDir() would be measuring the refusal rather than the
// grant. The user cache dir is where the rest of the lab puts it.
func toolReadsRoot(t *testing.T, name string) string {
	t.Helper()
	base, err := os.UserCacheDir()
	if err != nil {
		base = os.Getenv("HOME")
	}
	dir := filepath.Join(base, "communication-lab", "nono-toolreads", name, t.Name())
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatalf("create tool-read scratch: %v", err)
	}
	if err := wsgit.RefuseTempPath(dir); err != nil {
		t.Fatalf("tool-read scratch location is not grant-legitimate: %v", err)
	}
	t.Cleanup(func() {
		_ = os.RemoveAll(filepath.Join(base, "communication-lab", "nono-toolreads", name))
	})
	return dir
}

// toolReadsSpec builds the smallest command launch that will render: a real
// profile, one rw workspace grant, a launcher HOME no grant covers (probe
// C-H1), and the ToolReads under test.
func toolReadsSpec(t *testing.T, toolReads ...string) LaunchSpec {
	t.Helper()
	root := toolReadsRoot(t, "spec")
	prof, err := WriteProfile(filepath.Join(root, "policy"), ProfileCommand)
	if err != nil {
		t.Fatalf("WriteProfile(%s): %v", ProfileCommand, err)
	}
	home := filepath.Join(root, "home")
	launcher := filepath.Join(root, "launcher-home")
	for _, d := range []string{home, launcher} {
		if err := os.MkdirAll(d, 0o700); err != nil {
			t.Fatalf("create %s: %v", d, err)
		}
	}
	plan := wsgit.LaunchPlan{
		Grants:       []wsgit.Grant{{Role: wsgit.RoleAgentHome, Path: home}},
		LauncherHome: launcher,
		AgentHome:    home,
		Cwd:          home,
	}
	if err := plan.Check(); err != nil {
		t.Fatalf("plan: %v", err)
	}
	return LaunchSpec{
		Profile: prof, Plan: plan, LauncherHome: launcher,
		AdapterPath: "/bin/true", AdapterEnv: []string{"PATH=/bin"},
		BlockNet: true, ToolReads: toolReads,
	}
}

// flagFor returns the flag that granted path, or "" when nothing granted it.
func flagFor(t *testing.T, argv []string, path string) []string {
	t.Helper()
	var flags []string
	for i := 0; i+1 < len(argv); i++ {
		switch argv[i] {
		case "--read", "--allow":
			if argv[i+1] == path {
				flags = append(flags, argv[i])
			}
		case "--":
			return flags
		}
	}
	return flags
}

func TestToolReadsRenderAsReadOnlyGrants(t *testing.T) {
	root := toolReadsRoot(t, "reads")
	toolDir := filepath.Join(root, "opt-m4-bin")
	interpDir := filepath.Join(root, "usr-bin")
	for _, d := range []string{toolDir, interpDir} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatalf("create tool dir: %v", err)
		}
	}
	spec := toolReadsSpec(t, toolDir, interpDir)

	for _, tc := range []struct {
		name  string
		build func(LaunchSpec) ([]string, error)
	}{{
		name:  "launch argv",
		build: func(s LaunchSpec) ([]string, error) { return s.BuildLaunchArgv() },
	}, {
		// N-d asserts the same set it will later see printed, so the verify
		// argv must carry the tool reads too — a verify that omitted them
		// would refuse every out-of-workspace command as grant_mismatch.
		name:  "verify argv",
		build: func(s LaunchSpec) ([]string, error) { return s.BuildVerifyArgv() },
	}} {
		t.Run(tc.name, func(t *testing.T) {
			argv, err := tc.build(spec)
			if err != nil {
				t.Fatalf("%s: %v", tc.name, err)
			}
			for _, want := range spec.ToolReads {
				got := flagFor(t, argv, want)
				if len(got) != 1 || got[0] != "--read" {
					t.Errorf("%s granted %v, want exactly one --read %s (ADR-0026 § Decision 3: read, never write): %v",
						want, got, want, argv)
				}
			}
			// Declared order is preserved, the way GrantFlags preserves it.
			if !strings.Contains(strings.Join(argv, " "), "--read "+toolDir+" --read "+interpDir) {
				t.Errorf("tool reads lost their order: %v", argv)
			}
		})
	}
}

func TestToolReadsRefuseAnUnresolvablePath(t *testing.T) {
	root := toolReadsRoot(t, "unresolvable")
	missing := filepath.Join(root, "opt-m4-bin") // parent exists, the grant does not
	if _, err := (toolReadsSpec(t, missing)).BuildLaunchArgv(); err == nil {
		t.Error("BuildLaunchArgv launched a grant nono would silently drop (probe C-FC3)")
	} else if !strings.Contains(err.Error(), "C-FC3") {
		t.Errorf("error = %v, want the C-FC3 note that says why the launch is refused", err)
	}
	// The verify argv refuses identically: it is the same grant set.
	if _, err := (toolReadsSpec(t, missing)).BuildVerifyArgv(); err == nil {
		t.Error("BuildVerifyArgv verified a grant nono would silently drop (probe C-FC3)")
	}
	// A /tmp tool read is refused too (probe C-TMP1), not silently widened.
	if _, err := (toolReadsSpec(t, "/tmp/m4-tools")).BuildLaunchArgv(); err == nil {
		t.Error("BuildLaunchArgv accepted a /tmp tool read grant")
	}
	// And the same directory, once it exists, is accepted — the refusal above
	// is about resolution, not about the path being a tool path.
	if err := os.MkdirAll(missing, 0o755); err != nil {
		t.Fatalf("create the tool dir: %v", err)
	}
	if _, err := (toolReadsSpec(t, missing)).BuildLaunchArgv(); err != nil {
		t.Errorf("BuildLaunchArgv refused an existing tool dir: %v", err)
	}
}
