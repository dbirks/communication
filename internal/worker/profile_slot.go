package worker

// Per-unit sandbox profile materialization.
//
// Every sandboxed unit this worker launches — an agent.acp attempt, a
// process.exec attempt, an M3 conversation unit, an APM lock resolve — needs a
// policy file on disk, because ADR-0009 D4 requires `nono run -p <path>` and
// forbids flags alone. Until now each kind wrote ONE file at
// `<policy dir>/<kind>.json`, memoized per process. That shape assumed a policy
// file and a unit were the same granularity; they are not. Two agent turns at
// once on one worker resolved the same path, and the second write replaced the
// bytes the first had just handed to AssertOwnBytes, so the first turn died with
//
//	sandbox: profile …/communication-agent.json changed after it was written
//
// (lab: issue2-workbench A6 — concurrent code_review attempts closing
// sandbox_enforcement_failed). The assertion is the only thing that can prove
// the policy shape (C-FC2b measured that no nono surface reveals `external`),
// so the fix is that the file it runs against belongs to exactly one unit: the
// check is unchanged, the path is not shared.
//
// openUnitProfile therefore materializes the policy in a private directory
// (nono.OpenProfileSlot: created exclusively, 0700, worker-owned, named for the
// unit id) that the unit removes at its own boundary. The fixed per-kind FILE
// name is kept — nono takes the path as an argument and identifies the policy by
// `meta.name` inside the file, so a per-attempt directory costs nothing and every
// recorded digest keeps meaning what it meant before.

import (
	"errors"
	"log/slog"

	"github.com/dbirks/communication/internal/sandbox/nono"
)

// unitProfile is one execution unit's policy: the private directory it was
// materialized in, and the file the launch argv names.
type unitProfile struct {
	slot *nono.ProfileSlot
	prof *nono.Profile
}

// Profile is the policy handed to the launch; nil for a unit that never
// materialized one.
func (u *unitProfile) Profile() *nono.Profile {
	if u == nil {
		return nil
	}
	return u.prof
}

// openUnitProfile materializes kind for one execution unit (attempt id, turn
// id, resolve id) under the worker's policy root. The returned unitProfile must
// be closed by the caller at the unit boundary — once the unit's child is gone —
// on every exit path, including the refusal paths.
//
// AssertOwnBytes runs here as well as at argv build: a policy that cannot be
// proven is refused before this unit has launched its verification probe,
// rather than after.
func openUnitProfile(policyDir, unitID, kind string, net nono.NetworkEnforcement, allow []string) (*unitProfile, error) {
	if policyDir == "" {
		return nil, errors.New("worker: no policy directory is configured, so the " + kind + " profile cannot be materialized (ADR-0009 D4 requires -p <path>: with CLI flags alone, nono mixes its built-in default profile in, and that default is what writes /tmp)")
	}
	slot, err := nono.OpenProfileSlot(policyDir, unitID)
	if err != nil {
		return nil, err
	}
	prof, err := slot.WriteNetwork(kind, net, allow)
	if err != nil {
		// Nothing was launched under it, so the slot is already dead.
		_ = slot.Close()
		return nil, err
	}
	if err := prof.AssertOwnBytes(); err != nil {
		_ = slot.Close()
		return nil, err
	}
	return &unitProfile{slot: slot, prof: prof}, nil
}

// closeUnitProfile removes the unit's private policy directory.
//
// A leftover is logged and not fatal, and that asymmetry is deliberate: the
// directory is 0700, worker-owned, holds nothing but public policy bytes (a
// profile file names grants and hosts, never a credential), and is never a
// launch grant — no sandboxed child has a rule naming it. Failing an attempt
// that ran and succeeded because a directory survived would report a security
// failure that did not happen; pretending the removal happened would hide a
// disk that is filling up. So: warn, with the path, and let the unit's real
// result stand.
func closeUnitProfile(log *slog.Logger, what string, unitID string, u *unitProfile) {
	if u == nil || u.slot == nil {
		return
	}
	if err := u.slot.Close(); err != nil {
		log.Warn("the unit's private sandbox profile dir could not be removed",
			slog.String("unit", what),
			slog.String("unit_id", unitID),
			slog.String("path", u.slot.Dir()),
			slog.String("error", err.Error()))
	}
}
