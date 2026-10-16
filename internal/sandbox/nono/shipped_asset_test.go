package nono

import (
	"os"
	"path/filepath"
	"testing"

	wsgit "github.com/dbirks/communication/internal/workspace/git"
)

// TestShippedCommandProfileAssetIsTheAuthoredBytes pins contract § 6.2's
// repository asset (worker/sandbox/profiles/communication-command.json) to
// the bytes this package authors. ProfileJSON is exported precisely because
// "two renderings that disagree would make that number meaningless"
// (profile.go); this is that promise applied to the file the worker image
// ships. The runtime path writes its own copy via WriteProfile — the asset's
// job is to be the reviewed artifact, so a human edit that diverges from the
// kind table is caught here rather than in a policy digest nobody compares.
func TestShippedCommandProfileAssetIsTheAuthoredBytes(t *testing.T) {
	const asset = "../../../worker/sandbox/profiles/communication-command.json"
	onDisk, err := os.ReadFile(asset)
	if err != nil {
		t.Fatalf("read shipped asset %s: %v", asset, err)
	}
	authored, err := ProfileJSON(ProfileCommand)
	if err != nil {
		t.Fatalf("ProfileJSON: %v", err)
	}
	if string(onDisk) != string(authored) {
		t.Errorf("shipped asset digests to %s, the authored bytes to %s: regenerate from ProfileJSON, never hand-edit",
			DigestProfile(onDisk), DigestProfile(authored))
	}
}

// TestCommandProfileCarriesTheEgressClaim is the axis claim itself: the
// command profile's NetworkEnforced is denied by kind, and a Profile hand-built
// without it is refused --block-net pairing in both directions
// (launchplan.go's guard), because an egress claim the recorded digest does
// not describe is the exact lie ADR-0019 D3's named axes exist to prevent.
// ADR-0035 did not change this kind: the command profile stays the --block-net
// policy, with no `network` member in its file.
func TestCommandProfileCarriesTheEgressClaim(t *testing.T) {
	dir := t.TempDir() // the profile FILE may live anywhere; grants may not
	prof, err := WriteProfile(dir, ProfileCommand)
	if err != nil {
		t.Fatalf("WriteProfile(%s): %v", ProfileCommand, err)
	}
	if prof.NetworkEnforced != NetworkDenied {
		t.Fatalf("communication-command must carry NetworkEnforced=%s: its contract (§ 4 step 5) is egress denied, got %q", NetworkDenied, prof.NetworkEnforced)
	}
	if err := prof.AssertOwnBytes(); err != nil {
		t.Fatalf("AssertOwnBytes: %v", err)
	}
	plan, launcherHome := assetPlan(t)
	// A lying Profile of the same kind (enforcement flag dropped) must not
	// reach --block-net silently.
	lying := &Profile{Kind: ProfileCommand, Path: prof.Path, Digest: prof.Digest, NetworkEnforced: NetworkOpen}
	if _, err := (LaunchSpec{
		Profile: lying, Plan: plan, LauncherHome: launcherHome,
		AdapterPath: "/bin/true", AdapterEnv: []string{"PATH=/bin"}, BlockNet: true,
	}).BuildLaunchArgv(); err == nil {
		t.Error("BuildLaunchArgv accepted --block-net while the Profile did not claim NetworkDenied")
	}
	// And the true command profile refuses to launch WITHOUT the flag.
	if _, err := (LaunchSpec{
		Profile: prof, Plan: plan, LauncherHome: launcherHome,
		AdapterPath: "/bin/true", AdapterEnv: []string{"PATH=/bin"}, BlockNet: false,
	}).BuildLaunchArgv(); err == nil {
		t.Error("BuildLaunchArgv launched the egress-denied profile without --block-net")
	}
	// With the flag it renders, and the flag is there exactly once.
	argv, err := (LaunchSpec{
		Profile: prof, Plan: plan, LauncherHome: launcherHome,
		AdapterPath: "/bin/true", AdapterEnv: []string{"PATH=/bin"}, BlockNet: true,
	}).BuildLaunchArgv()
	if err != nil {
		t.Fatalf("BuildLaunchArgv with the true claim: %v", err)
	}
	n := 0
	for _, a := range argv {
		if a == "--block-net" {
			n++
		}
	}
	if n != 1 {
		t.Errorf("--block-net appears %d times, want 1 in %v", n, argv)
	}
}

// assetPlan builds the smallest launchable grant set OUTSIDE the temp tree
// (wsgit.CheckGrantPath refuses /tmp: probe C-TMP1) and a launcher HOME no
// grant covers (probe C-H1). Created under the package directory and removed
// on cleanup — grant paths are existence-checked, not content-checked.
func assetPlan(t *testing.T) (wsgit.LaunchPlan, string) {
	t.Helper()
	base, err := os.MkdirTemp(".", "shipped-asset-plan")
	if err != nil {
		t.Fatalf("grant scratch: %v", err)
	}
	if base, err = filepath.Abs(base); err != nil {
		t.Fatalf("grant scratch abs: %v", err)
	}
	launcher, err := os.MkdirTemp(".", "shipped-asset-launcher")
	if err != nil {
		t.Fatalf("launcher home: %v", err)
	}
	if launcher, err = filepath.Abs(launcher); err != nil {
		t.Fatalf("launcher home abs: %v", err)
	}
	t.Cleanup(func() {
		_ = os.RemoveAll(base)
		_ = os.RemoveAll(launcher)
	})
	home := filepath.Join(base, "home")
	if err := os.MkdirAll(home, 0o700); err != nil {
		t.Fatal(err)
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
	return plan, launcher
}
