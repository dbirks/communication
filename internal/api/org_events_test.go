package api

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/dbirks/communication/internal/events"
)

// The org stream is the project stream widened from one project to the
// caller's projects (ADR-0048), so the test pins what only the widening can
// get wrong: rows from a project the caller cannot see never arrive — not on
// connect and not live — while resume across the shared global_seq still
// skips exactly what the browser already drew. The visibility predicate is
// the store's job (house style), so the fake journal models the store: it
// filters by the caller's visible set, and a mid-stream revocation takes
// effect on the very next query.
//
// Gap-safety of the *rows* and the permission predicate itself are proven
// against a real PostgreSQL in internal/store/postgres; the timing and the
// frame contract are pinned once, by the project stream's tests.

// orgJournal is the OrgEventStream fake: journal rows plus the caller's
// visible project set, guarded by a mutex because a live stream reads it from
// the handler goroutine while the test revokes a project.
type orgJournal struct {
	mu      sync.Mutex
	rows    []events.Envelope
	visible map[string]bool
	wakes   []chan struct{}
	err     error
}

func newOrgJournal(visible ...string) *orgJournal {
	f := &orgJournal{visible: map[string]bool{}}
	for _, id := range visible {
		f.visible[id] = true
	}
	return f
}

func (f *orgJournal) add(env ...events.Envelope) {
	f.mu.Lock()
	f.rows = append(f.rows, env...)
	wakes := append([]chan struct{}(nil), f.wakes...)
	f.mu.Unlock()
	for _, w := range wakes {
		select {
		case w <- struct{}{}:
		default:
		}
	}
}

// setVisible models a membership granted or revoked: the next query — not the
// next delivered frame — sees the new state (ADR-0048 §3).
func (f *orgJournal) setVisible(projectID string, v bool) {
	f.mu.Lock()
	if v {
		f.visible[projectID] = true
	} else {
		delete(f.visible, projectID)
	}
	f.mu.Unlock()
}

func (f *orgJournal) OrgEventsAfter(ctx context.Context, _ Caller, afterSeq int64, limit int) ([]events.Envelope, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.err != nil {
		return nil, f.err
	}
	if limit <= 0 {
		limit = 100
	}
	var out []events.Envelope
	for _, e := range f.rows {
		if f.visible[e.ProjectID] && e.GlobalSeq > afterSeq {
			out = append(out, e)
			if len(out) >= limit {
				break
			}
		}
	}
	return out, nil
}

func (f *orgJournal) Watch(ctx context.Context) (<-chan struct{}, func(), error) {
	ch := make(chan struct{}, 4)
	f.mu.Lock()
	f.wakes = append(f.wakes, ch)
	f.mu.Unlock()
	var once sync.Once
	stop := func() {
		once.Do(func() {
			f.mu.Lock()
			for i, w := range f.wakes {
				if w == ch {
					f.wakes = append(f.wakes[:i], f.wakes[i+1:]...)
					break
				}
			}
			f.mu.Unlock()
			close(ch)
		})
	}
	return ch, stop, nil
}

func (f *orgJournal) failWith(err error) {
	f.mu.Lock()
	f.err = err
	f.mu.Unlock()
}

// orgMount builds the server under test with the test timing.
func orgMount(t *testing.T, stream OrgEventStream, auth Authenticator, timing evtTiming) *Server {
	t.Helper()
	s := New(Config{ReplicaName: "replica-a", Version: "dev", PublicURL: "http://localhost:8080",
		Logger: discardLogger()}, fakeReadiness{expected: 1}, auth, nil)
	registerOrgEvents(s, stream, timing)
	return s
}

// TestOrgEventStreamReceivesOnlyVisibleProjects: the widening itself. Two
// projects share one journal; the caller is a member of one. Its rows — on
// connect and live — are the only ones delivered, and a row the caller may no
// longer see is skipped by the next query, with the cursor still resumable.
func TestOrgEventStreamReceivesOnlyVisibleProjects(t *testing.T) {
	journal := newOrgJournal("p-a")
	journal.add(
		evtEnvelope(1, "p-a", events.TypeProjectCreated),
		evtEnvelope(2, "p-b", events.TypeProjectCreated),
		evtEnvelope(3, "p-a", events.TypeRepositoryAdded),
	)

	srv := evtListen(t, orgMount(t, journal, prjAs("u-1", false), evtFast()))
	sc, resp, _ := evtOpen(t, srv, "/api/v1/events", nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	if got := strings.Join(evtSeqs(evtFrames(t, sc, 2)), ","); got != "1,3" {
		t.Fatalf("replayed %s, want 1,3 (p-a only; p-b's seq 2 is invisible)", got)
	}

	// Live: a new p-b row then a new p-a row. The p-a row arrives, the p-b
	// row is absent — and the stream keeps working afterwards.
	journal.add(evtEnvelope(4, "p-b", events.TypeRepositoryAdded))
	journal.add(evtEnvelope(5, "p-a", events.TypeRepositoryAdded))
	if id, _, _ := evtReadFrame(t, sc); id != "5" {
		t.Fatalf("live id = %s, want 5 (the p-b seq 4 must not arrive)", id)
	}
}

// TestOrgEventStreamResumeAfterLastEventID: the id on the wire is the global
// global_seq, so the browser's automatic reconnect header resumes mid-journal
// across projects and replays exactly the rows above the cursor (ADR-0048 §2).
func TestOrgEventStreamResumeAfterLastEventID(t *testing.T) {
	journal := newOrgJournal("p-a", "p-b")
	journal.add(
		evtEnvelope(1, "p-a", events.TypeProjectCreated),
		evtEnvelope(2, "p-b", events.TypeProjectCreated),
		evtEnvelope(3, "p-a", events.TypeRepositoryAdded),
	)

	srv := evtListen(t, orgMount(t, journal, prjAs("u-1", false),
		evtTiming{heartbeat: time.Hour, poll: 15 * time.Millisecond, batch: 100}))

	// The browser reconnects after having drawn through seq 2.
	sc, resp, _ := evtOpen(t, srv, "/api/v1/events", map[string]string{"Last-Event-ID": "2"})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	if id, _, _ := evtReadFrame(t, sc); id != "3" {
		t.Fatalf("resume id = %s, want 3 (1 and 2 were already drawn)", id)
	}

	// A live row lands above the resume point and is delivered.
	journal.add(evtEnvelope(4, "p-b", events.TypeRepositoryAdded))
	if id, _, _ := evtReadFrame(t, sc); id != "4" {
		t.Fatalf("live id = %s, want 4", id)
	}
}

// TestOrgEventStreamRevokedMidStreamStopsAtNextQuery: the member loses p-a
// after seq 3 is delivered. The next query sees the revocation, so seq 4 is
// absent — but the stream itself stays open and a row from a still-visible
// project still arrives, with no gap for a future resume.
func TestOrgEventStreamRevokedMidStreamStopsAtNextQuery(t *testing.T) {
	journal := newOrgJournal("p-a", "p-b")
	journal.add(evtEnvelope(1, "p-a", events.TypeProjectCreated))

	srv := evtListen(t, orgMount(t, journal, prjAs("u-1", false),
		evtTiming{heartbeat: time.Hour, poll: 10 * time.Millisecond, batch: 100}))
	sc, _, _ := evtOpen(t, srv, "/api/v1/events", nil)
	if id, _, _ := evtReadFrame(t, sc); id != "1" {
		t.Fatalf("id = %s, want 1", id)
	}

	journal.add(evtEnvelope(2, "p-a", events.TypeRepositoryAdded))
	journal.setVisible("p-a", false) // revoked between the write and the next query
	journal.add(evtEnvelope(3, "p-b", events.TypeRepositoryAdded))

	// Only seq 3 arrives: 2 was withheld by the predicate and 3 follows it.
	if id, _, _ := evtReadFrame(t, sc); id != "3" {
		t.Fatalf("id = %s, want 3 (the revoked p-a seq 2 must not arrive)", id)
	}
}

// TestOrgEventStreamWithoutProjectsIsAnEmptyStream: nobody is a member of any
// project — and the honest answer is an open, quiet stream, not a 404: the
// route names no resource (ADR-0048 §4). A heartbeat is the first thing the
// client hears, which also proves the stream header was written.
func TestOrgEventStreamWithoutProjectsIsAnEmptyStream(t *testing.T) {
	journal := newOrgJournal() // no visible projects
	journal.add(evtEnvelope(1, "p-a", events.TypeProjectCreated))

	srv := evtListen(t, orgMount(t, journal, prjAs("u-1", false),
		evtTiming{heartbeat: 100 * time.Millisecond, poll: 10 * time.Millisecond, batch: 100}))
	sc, resp, _ := evtOpen(t, srv, "/api/v1/events", nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200 (an empty stream, not a 404)", resp.StatusCode)
	}
	line := evtNextLine(t, sc)
	if line != ": heartbeat" {
		t.Fatalf("first line = %q, want the : heartbeat comment (no rows may be visible)", line)
	}
}

// TestOrgEventStreamBadCursorIs422: the same client mistake the project
// stream refuses with a 422 problem+json (ADR-0014 §5), before the response
// becomes a stream.
func TestOrgEventStreamBadCursorIs422(t *testing.T) {
	journal := newOrgJournal("p-a")
	journal.add(evtEnvelope(1, "p-a", events.TypeProjectCreated))
	s := orgMount(t, journal, prjAs("u-1", false), evtFast())
	for _, c := range []struct{ target, header string }{
		{"/api/v1/events?after=abc", ""},
		{"/api/v1/events?after=-1", ""},
		{"/api/v1/events", "nope"},
	} {
		req := evtRecordedRequest(t, "http://localhost:8080"+c.target, c.header)
		rec := do(t, s, req)
		if rec.Code != http.StatusUnprocessableEntity {
			t.Errorf("%s (Last-Event-ID %q) status = %d, want 422 (%s)", c.target, c.header, rec.Code, rec.Body)
			continue
		}
		if p := decodeProblem(t, rec); p.Status != http.StatusUnprocessableEntity {
			t.Errorf("problem = %+v, want a 422 problem document", p)
		}
	}
}

// TestOrgEventStreamRequiresSession: the route is authed like every other
// project route; an anonymous request is a 401, not an open stream.
func TestOrgEventStreamRequiresSession(t *testing.T) {
	s := orgMount(t, newOrgJournal("p-a"),
		AuthenticatorFunc(func(*http.Request) (*Principal, error) { return nil, ErrUnauthenticated }),
		evtFast())
	rec := do(t, s, evtRecordedRequest(t, "http://localhost:8080/api/v1/events", ""))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401 (%s)", rec.Code, rec.Body)
	}
}

// TestOrgEventStreamJournalErrorEndsStream: a driver failure ends the stream
// (the client reconnects with its cursor) rather than serving partial truth.
func TestOrgEventStreamJournalErrorEndsStream(t *testing.T) {
	journal := newOrgJournal("p-a")
	srv := evtListen(t, orgMount(t, journal, prjAs("u-1", false), evtFast()))
	sc, _, _ := evtOpen(t, srv, "/api/v1/events", nil)
	journal.failWith(fmt.Errorf("the database went away"))
	if line := evtNextLine(t, sc); line != "" {
		t.Fatalf("stream did not end after a journal error, got %q", line)
	}
}
