package assistant

// The exported face of the ADR-0078 importance floor, for ADR-0081's `heads_up`
// section.
//
// `catchUpImportanceSignals` is the deployment's own answer to "what must a
// returning engineer not miss": an auth path, a data migration, a new
// dependency, a public API spec, skipped or deleted tests, a push straight to
// main. The tour raises a beat to `must_know` when one of them fires. The brief
// lists the same facts for the same reader, and a second table of rules would
// eventually decide "must know" differently in the two places — which is why
// this file exports a reader for the ONE table rather than letting
// internal/api copy its patterns.
//
// The keys are ADR-0081's closed `heads_up.signal` vocabulary. A signal with no
// key in it — "reverted failed run" — contributes no row, because the contract
// it answers has nowhere to put it; dropping it is a stated limit of THIS
// surface, not of the rule.

// catchUpHeadUpSignalKeys maps the floor's signal names onto the ADR-0081 keys.
var catchUpHeadUpSignalKeys = map[string]string{
	"data migration":           "migration",
	"auth/security path":       "auth",
	"new dependency":           "deps",
	"tests skipped or deleted": "skipped_test",
	"public API spec":          "public_api",
	"push straight to main":    "push_to_main",
}

// CatchUpHeadUpSignals names the must-know signals one run's facts carry, in the
// vocabulary the brief serves. It applies exactly the rules the tour floor
// applies — same text scan over the run's own fields and node list, same guards
// (a "push straight to main" needs a main/master branch AND commits named in the
// run's outputs, not the word "main" in a title) — and asks nothing of a model.
// An unknown or unmapped signal is dropped rather than served under a key that
// would make it mean something it does not.
func CatchUpHeadUpSignals(f CatchUpRunFacts) []string {
	hits := catchUpSignalsInFacts(f, CatchUpCandidate{}, nil)
	if len(hits) == 0 {
		return nil
	}
	out := make([]string, 0, len(hits))
	for _, s := range hits {
		key, ok := catchUpHeadUpSignalKeys[s.name]
		if !ok {
			continue
		}
		out = append(out, key)
	}
	return out
}
