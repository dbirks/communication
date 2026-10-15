package runtimetest

import "testing"

// TestConformance_MemStore runs the suite against the in-memory reference
// Store. The harness's own claims — fresh isolated state per subtest,
// -count=2 stability, the fenced semantics the Postgres adapter must match —
// are what this test exists to keep true.
func TestConformance_MemStore(t *testing.T) {
	ConformanceTests(t, MemStoreFactory{})
}
