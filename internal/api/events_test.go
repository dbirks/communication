package api

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/dbirks/communication/internal/events"
)

// The SSE handler is where the durable journal becomes a browser's view of the
// project, so these tests pin what a client can observe: the frame format, the
// resume cursor's precedence, authorization at connect and during the stream,
// the heartbeat that keeps proxies alive, and every path that ends a stream.
//
// Two rules make this file safe to run under -race with -timeout 120s:
//
//   - Nothing waits longer than a bounded read timeout. A stalled stream is
//     reported as a stalled stream (t.Fatal), never as a hanging test.
//   - Every stream is opened with its own cancellable, deadline-bound context,
//     and the httptest server is closed by a *later-registered* cleanup than
//     the one that cancels the request. t.Cleanup runs LIFO, so the request is
//     always gone before Close waits on it — otherwise Close blocks forever on
//     a stream that only ends when its client leaves.
//
// The gap-safety of the *rows* is a database property and is proven against a
// real PostgreSQL in internal/store/postgres/events_test.go; the journal here
// is a fake whose rows the handler must not second-guess.

// evtReadTimeout bounds one blocking wait for a line, and evtRequestTimeout
// bounds one connection's whole life. Both are far below `go test -timeout`,
// so the worst case this file can produce is a failure, not a hang.
const (
	evtReadTimeout   = 5 * time.Second
	evtRequestBudget = 20 * time.Second
)

// evtFast is the test timing: production pins a 15 s heartbeat and a 2 s poll,
// and a test that waited on either would only test patience.
func evtFast() evtTiming {
	return evtTiming{heartbeat: 150 * time.Millisecond, poll: 15 * time.Millisecond, batch: 100}
}

// --- fakes --------------------------------------------------------------

// evtProject is the authorization half of a ProjectStore, guarded by a mutex
// because a live stream reads it from the handler goroutine while the test
// revokes access. It answers "visible" or "not there" — the same two answers
// the real store gives a member and a stranger (ADR-0014 §3).
type evtProject struct {
	mu        sync.Mutex
	id        string
	visible   bool
	gets      int
	denials   []string
	deniedErr error
}

func evtNewProject(id string) *evtProject {
	return &evtProject{id: id, visible: true}
}

func (p *evtProject) setVisible(v bool) {
	p.mu.Lock()
	p.visible = v
	p.mu.Unlock()
}

func (p *evtProject) getCalls() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.gets
}

func (p *evtProject) deniedActions() []string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]string(nil), p.denials...)
}

// GetProject answers like the real store: an id it does not know is the same
// answer as one the caller may not see. A fake that ignored projectID would
// turn "unknown project" tests into an open stream that never ends.
func (p *evtProject) GetProject(ctx context.Context, _ Caller, projectID string) (ProjectView, error) {
	if err := ctx.Err(); err != nil {
		return ProjectView{}, err
	}
	p.mu.Lock()
	p.gets++
	visible, err := p.visible, p.deniedErr
	p.mu.Unlock()
	if err != nil {
		return ProjectView{}, err
	}
	if !visible || projectID != p.id {
		return ProjectView{}, ErrProjectNotFound
	}
	return ProjectView{ID: p.id, Slug: "widgets", Name: "Widgets", MyRole: "maintainer"}, nil
}

func (p *evtProject) RecordDenied(_ context.Context, _ Caller, _, action string) error {
	p.mu.Lock()
	p.denials = append(p.denials, action)
	p.mu.Unlock()
	return nil
}

// The unused ProjectStore methods: this file only mounts the events route, so
// they exist to satisfy the interface and fail loudly if ever called.
func (p *evtProject) ListProjects(context.Context, Caller) ([]ProjectView, error) {
	return nil, errors.New("evtProject: ListProjects not expected")
}
func (p *evtProject) CreateProject(context.Context, Caller, string, string, string) (ProjectView, error) {
	return ProjectView{}, errors.New("evtProject: CreateProject not expected")
}
func (p *evtProject) ListRepositories(context.Context, Caller, string) ([]RepositoryView, error) {
	return nil, errors.New("evtProject: ListRepositories not expected")
}
func (p *evtProject) AddRepository(context.Context, Caller, string, string, string, string, string) (RepositoryView, error) {
	return RepositoryView{}, errors.New("evtProject: AddRepository not expected")
}
func (p *evtProject) PatchRepositoryCredential(context.Context, Caller, string, string, string) (RepositoryView, error) {
	return RepositoryView{}, errors.New("evtProject: PatchRepositoryCredential not expected")
}

func (p *evtProject) ListMembers(context.Context, Caller, string) ([]MemberView, error) {
	return nil, errors.New("evtProject: ListMembers not expected")
}
func (p *evtProject) PutMember(context.Context, Caller, string, string, string) (MemberView, error) {
	return MemberView{}, errors.New("evtProject: PutMember not expected")
}

var _ ProjectStore = (*evtProject)(nil)

// evtJournal is a fake durable journal: rows to hand out, wake-up channels to
// signal, and a query counter so a test can prove a loop stopped.
type evtJournal struct {
	mu      sync.Mutex
	rows    []events.Envelope
	wakes   []chan struct{}
	watchFn func(ctx context.Context) (<-chan struct{}, func(), error)
	// retireWakes makes Watch hand out an already-closed channel: this replica's
	// wake-up source is gone (shutdown).
	retireWakes bool
	queries     int
	err         error
}

func evtNewJournal() *evtJournal { return &evtJournal{} }

func (f *evtJournal) add(env ...events.Envelope) {
	f.signal(false, env...)
}

// signal appends rows and, unless told not to, wakes every subscription the way
// a LISTEN notification would.
func (f *evtJournal) signal(silent bool, env ...events.Envelope) {
	f.mu.Lock()
	f.rows = append(f.rows, env...)
	wakes := append([]chan struct{}(nil), f.wakes...)
	f.mu.Unlock()
	if silent {
		return
	}
	for _, w := range wakes {
		select {
		case w <- struct{}{}:
		default:
		}
	}
}

// EventsAfter honours its context the way a real driver does: a cancelled
// stream must see an error rather than another happy answer, which is what
// lets the handler's loop terminate when the client goes away.
func (f *evtJournal) EventsAfter(ctx context.Context, _ Caller, projectID string, afterSeq int64, limit int) ([]events.Envelope, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	f.queries++
	if f.err != nil {
		return nil, f.err
	}
	if limit <= 0 {
		limit = 100
	}
	var out []events.Envelope
	for _, e := range f.rows {
		if e.ProjectID == projectID && e.GlobalSeq > afterSeq {
			out = append(out, e)
			if len(out) >= limit {
				break
			}
		}
	}
	return out, nil
}

func (f *evtJournal) Watch(ctx context.Context) (<-chan struct{}, func(), error) {
	f.mu.Lock()
	fn, retire := f.watchFn, f.retireWakes
	f.mu.Unlock()
	if fn != nil {
		return fn(ctx)
	}
	if retire {
		ch := make(chan struct{})
		close(ch)
		return ch, func() {}, nil
	}
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

func (f *evtJournal) queryCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.queries
}

func (f *evtJournal) subscriptionCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.wakes)
}

func (f *evtJournal) failWith(err error) {
	f.mu.Lock()
	f.err = err
	f.mu.Unlock()
}

// evtEnvelope builds a journal row whose payload is raw enough to prove the
// handler forwards the stored bytes rather than a re-encoding.
func evtEnvelope(seq int64, projectID, eventType string) events.Envelope {
	return events.Envelope{
		EventID:        fmt.Sprintf("01987a6e-0000-7000-8000-%012d", seq),
		GlobalSeq:      seq,
		Type:           eventType,
		SchemaVersion:  1,
		OccurredAt:     prjFixedTime,
		OrganizationID: "o-1",
		ProjectID:      projectID,
		Actor:          events.Human("u-1"),
		Payload:        json.RawMessage(`{"name":"front-end","note":"<b>&"}`),
	}
}

// evtMount builds the server under test with the test timing.
func evtMount(t *testing.T, store ProjectStore, stream EventStream, auth Authenticator, timing evtTiming) *Server {
	t.Helper()
	s := New(Config{ReplicaName: "replica-a", Version: "dev", PublicURL: "http://localhost:8080",
		Logger: discardLogger()}, fakeReadiness{expected: 1}, auth, nil)
	registerEvents(s, store, stream, timing)
	return s
}

// evtListen starts a real HTTP server for a test. The cleanup is registered
// here — before any stream cleanup — so it runs LAST: cancelling the client is
// what lets Close return, and the order is the whole difference between a fast
// suite and one that hangs in httptest.Server.Close until the global timeout.
func evtListen(t *testing.T, s *Server) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(s)
	t.Cleanup(srv.Close)
	return srv
}

// evtOpen starts a GET on the stream and hands back a line reader. Each
// request gets its own deadline plus a cancel, both cleaned up before the
// server is closed, so no stream outlives its test.
func evtOpen(t *testing.T, srv *httptest.Server, path string, header map[string]string) (*bufio.Scanner, *http.Response, context.CancelFunc) {
	t.Helper()
	deadline := evtRequestBudget
	if d, ok := t.Deadline(); ok {
		if left := time.Until(d); left < deadline {
			deadline = left / 2
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), deadline)
	// Registered after evtListen's server cleanup, so it runs before it.
	t.Cleanup(cancel)

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, srv.URL+path, nil)
	if err != nil {
		cancel()
		t.Fatalf("new request: %v", err)
	}
	for k, v := range header {
		req.Header.Set(k, v)
	}
	resp, err := srv.Client().Do(req)
	if err != nil {
		cancel()
		t.Fatalf("GET %s: %v", path, err)
	}
	t.Cleanup(func() { resp.Body.Close() })
	return bufio.NewScanner(resp.Body), resp, cancel
}

// evtNextLine returns the next non-empty line, failing (not hanging) when none
// arrives in time. An empty string means the stream reached EOF.
func evtNextLine(t *testing.T, sc *bufio.Scanner) string {
	t.Helper()
	lines := make(chan string, 1)
	go func() {
		for sc.Scan() {
			line := sc.Text()
			if line == "" {
				continue
			}
			lines <- line
			return
		}
		lines <- ""
	}()
	select {
	case got := <-lines:
		return got
	case <-time.After(evtReadTimeout):
		t.Fatal("timed out waiting for an SSE frame")
		return ""
	}
}

// evtReadFrame reads one frame's three lines and returns (id, event, data).
func evtReadFrame(t *testing.T, sc *bufio.Scanner) (string, string, string) {
	t.Helper()
	var id, name, data string
	for i := 0; i < 3; i++ {
		line := evtNextLine(t, sc)
		switch {
		case strings.HasPrefix(line, "id: "):
			id = strings.TrimPrefix(line, "id: ")
		case strings.HasPrefix(line, "event: "):
			name = strings.TrimPrefix(line, "event: ")
		case strings.HasPrefix(line, "data: "):
			data = strings.TrimPrefix(line, "data: ")
		default:
			t.Fatalf("unexpected SSE line %q (want id:/event:/data:)", line)
		}
	}
	return id, name, data
}

// evtFrames reads exactly n frames and returns them in arrival order.
func evtFrames(t *testing.T, sc *bufio.Scanner, n int) [][3]string {
	t.Helper()
	out := make([][3]string, 0, n)
	for i := 0; i < n; i++ {
		id, name, data := evtReadFrame(t, sc)
		out = append(out, [3]string{id, name, data})
	}
	return out
}

// evtSeqs renders frame ids as a compact list for failure messages.
func evtSeqs(frames [][3]string) []string {
	out := make([]string, 0, len(frames))
	for _, f := range frames {
		out = append(out, f[0])
	}
	return out
}

// evtRecordedRequest builds a request for the ResponseRecorder helpers with a
// context that expires. A recorder cannot report "the client went away" any
// other way, so without a deadline a handler that mistakenly opened a stream
// would keep the test busy instead of failing it.
func evtRecordedRequest(t *testing.T, target, lastEventID string) *http.Request {
	t.Helper()
	req := request(http.MethodGet, target, nil)
	if lastEventID != "" {
		req.Header.Set("Last-Event-ID", lastEventID)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	t.Cleanup(cancel)
	return req.WithContext(ctx)
}

// --- tests --------------------------------------------------------------

// TestEventStreamServesContractedFrames pins the wire format from
// api/openapi.yaml streamProjectEvents. The frames below are a few hundred
// bytes in total, far under the server's write buffer, so reading them back at
// all is also evidence that each event is flushed as it is written.
func TestEventStreamServesContractedFrames(t *testing.T) {
	project := evtNewProject("p-1")
	stream := evtNewJournal()
	stream.add(evtEnvelope(7, "p-1", events.TypeProjectCreated))

	srv := evtListen(t, evtMount(t, project, stream, prjAs("u-1", false), evtFast()))

	sc, resp, _ := evtOpen(t, srv, "/api/v1/projects/p-1/events", nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	if ct := resp.Header.Get("Content-Type"); !strings.HasPrefix(ct, "text/event-stream") {
		t.Errorf("Content-Type = %q, want text/event-stream", ct)
	}
	if cc := resp.Header.Get("Cache-Control"); cc != "no-store" {
		t.Errorf("Cache-Control = %q, want no-store", cc)
	}
	if got := resp.Header.Get("X-Accel-Buffering"); got != "no" {
		t.Errorf("X-Accel-Buffering = %q, want no (Caddy flush_interval -1 is not enough on its own)", got)
	}
	if got := resp.Header.Get("X-Communication-Replica"); got != "replica-a" {
		t.Errorf("replica header = %q, want replica-a", got)
	}

	gotID, gotEvent, data := evtReadFrame(t, sc)
	if gotID != "7" {
		t.Errorf("id = %q, want the durable global_seq 7", gotID)
	}
	if gotEvent != events.TypeProjectCreated {
		t.Errorf("event = %q, want %q", gotEvent, events.TypeProjectCreated)
	}
	var env events.Envelope
	if err := json.Unmarshal([]byte(data), &env); err != nil {
		t.Fatalf("data is not an envelope: %v (%s)", err, data)
	}
	if env.GlobalSeq != 7 || env.Type != events.TypeProjectCreated || env.Actor.Kind != "human" {
		t.Errorf("envelope = %+v, want seq 7 project.created by a human", env)
	}
	if !strings.Contains(data, `"payload":{"name":"front-end"`) {
		t.Errorf("payload was not forwarded verbatim: %s", data)
	}
	if strings.Contains(data, "\n") {
		t.Error("a data frame spanning lines would be reassembled with newlines by the client")
	}
}

// TestEventStreamHeartbeatThenLiveDelivery: an idle stream stays alive by
// commenting, and a wake-up carries the event that follows.
func TestEventStreamHeartbeatThenLiveDelivery(t *testing.T) {
	project := evtNewProject("p-1")
	stream := evtNewJournal()

	srv := evtListen(t, evtMount(t, project, stream, prjAs("u-1", false), evtFast()))
	sc, _, _ := evtOpen(t, srv, "/api/v1/projects/p-1/events", nil)

	// Nothing to replay: the stream must still be open, kept alive by a
	// heartbeat comment rather than by holding the connection silent.
	if line := evtNextLine(t, sc); !strings.HasPrefix(line, ": heartbeat") {
		t.Fatalf("first line = %q, want the heartbeat comment", line)
	}

	stream.add(evtEnvelope(11, "p-1", events.TypeRepositoryAdded))
	gotID, gotEvent, data := evtReadFrame(t, sc)
	if gotID != "11" || gotEvent != events.TypeRepositoryAdded {
		t.Fatalf("live frame = (%s,%s), want (11,%s) — %s", gotID, gotEvent, events.TypeRepositoryAdded, data)
	}
}

// TestEventStreamDeliversWithoutWakeup: the notification is an optimization. A
// wake-up that never arrives (another replica inserted the row, the LISTEN
// connection was down) must cost latency, not an event — so the poll interval
// alone has to deliver it, with no heartbeat in sight to hide behind.
func TestEventStreamDeliversWithoutWakeup(t *testing.T) {
	project := evtNewProject("p-1")
	stream := evtNewJournal()

	srv := evtListen(t, evtMount(t, project, stream, prjAs("u-1", false),
		evtTiming{heartbeat: time.Hour, poll: 15 * time.Millisecond, batch: 100}))
	sc, _, _ := evtOpen(t, srv, "/api/v1/projects/p-1/events", nil)

	// Deliberately silent: rows in the journal, no notification at all.
	stream.signal(true, evtEnvelope(12, "p-1", events.TypeRepositoryAdded))
	if gotID, _, _ := evtReadFrame(t, sc); gotID != "12" {
		t.Fatalf("id = %q, want 12 delivered by the poll with no wake-up", gotID)
	}
}

// TestEventStreamBatchesWithoutGaps exercises the catch-up loop with a batch
// smaller than the backlog: 5 rows read 2 at a time must arrive as 1,2,3,4,5 —
// a cursor that failed to advance, or a loop that stopped at the first short
// read, shows up here as a missing or repeated id.
func TestEventStreamBatchesWithoutGaps(t *testing.T) {
	project := evtNewProject("p-1")
	stream := evtNewJournal()
	var rows []events.Envelope
	for seq := int64(1); seq <= 5; seq++ {
		rows = append(rows, evtEnvelope(seq, "p-1", events.TypeRepositoryAdded))
	}
	stream.signal(true, rows...)

	srv := evtListen(t, evtMount(t, project, stream, prjAs("u-1", false),
		evtTiming{heartbeat: time.Hour, poll: 15 * time.Millisecond, batch: 2}))
	sc, _, _ := evtOpen(t, srv, "/api/v1/projects/p-1/events", nil)

	frames := evtFrames(t, sc, 5)
	if got := strings.Join(evtSeqs(frames), ","); got != "1,2,3,4,5" {
		t.Fatalf("ids = %s, want 1,2,3,4,5 in ascending order with no gap or repeat", got)
	}
}

func TestEventStreamResumeCursor(t *testing.T) {
	project := evtNewProject("p-1")
	stream := evtNewJournal()
	for _, seq := range []int64{1, 2, 3} {
		stream.add(evtEnvelope(seq, "p-1", events.TypeRepositoryAdded))
	}
	mount := func() *httptest.Server {
		return evtListen(t, evtMount(t, project, stream, prjAs("u-1", false), evtTiming{
			heartbeat: time.Hour, poll: 15 * time.Millisecond, batch: 100}))
	}

	sc, _, _ := evtOpen(t, mount(), "/api/v1/projects/p-1/events?after=2", nil)
	if got := strings.Join(evtSeqs(evtFrames(t, sc, 1)), ","); got != "3" {
		t.Errorf("?after=2 replayed %s, want only seq 3", got)
	}

	// The header the browser sets automatically wins over an explicit query.
	sc, _, _ = evtOpen(t, mount(), "/api/v1/projects/p-1/events?after=1",
		map[string]string{"Last-Event-ID": "2"})
	if got := strings.Join(evtSeqs(evtFrames(t, sc, 1)), ","); got != "3" {
		t.Errorf("Last-Event-ID: 2 with ?after=1 replayed %s, want only seq 3 (the header wins)", got)
	}

	// A cursor that is not a sequence number is the client's mistake: answer
	// 422 problem+json rather than silently replaying everything.
	bad := evtMount(t, project, stream, prjAs("u-1", false), evtFast())
	for _, c := range []struct{ target, header string }{
		{"/api/v1/projects/p-1/events?after=abc", ""},
		{"/api/v1/projects/p-1/events?after=-1", ""},
		{"/api/v1/projects/p-1/events?after=1.5", ""},
		{"/api/v1/projects/p-1/events", "nope"},
	} {
		req := evtRecordedRequest(t, "http://localhost:8080"+c.target, c.header)
		rec := do(t, bad, req)
		if rec.Code != http.StatusUnprocessableEntity {
			t.Errorf("%s (Last-Event-ID %q) status = %d, want 422 (%s)", c.target, c.header, rec.Code, rec.Body)
			continue
		}
		if p := decodeProblem(t, rec); p.Status != http.StatusUnprocessableEntity {
			t.Errorf("problem = %+v, want a 422 problem document", p)
		}
	}
}

// TestEventStreamProductionTimingIsPinned: the 15 s heartbeat is a contract
// value (openapi.yaml streamProjectEvents, ADR-0014 §5) — proxies are tuned to
// it. The fast intervals above are test-only, so production has to be asserted
// separately or a test default could ship.
func TestEventStreamProductionTimingIsPinned(t *testing.T) {
	p := evtProductionTiming()
	if p.heartbeat != 15*time.Second {
		t.Errorf("heartbeat = %s, want 15s (documented in openapi.yaml)", p.heartbeat)
	}
	if p.poll <= 0 || p.poll > 2*time.Second {
		t.Errorf("poll = %s, want <= 2s: it bounds the latency of a lost wake-up and the delay of a withheld row", p.poll)
	}
	if p.batch <= 0 {
		t.Errorf("batch = %d, want a positive catch-up batch", p.batch)
	}
}

func TestEventStreamRequiresSession(t *testing.T) {
	s := evtMount(t, evtNewProject("p-1"), evtNewJournal(),
		AuthenticatorFunc(func(*http.Request) (*Principal, error) { return nil, ErrUnauthenticated }), evtFast())
	rec := do(t, s, evtRecordedRequest(t, "http://localhost:8080/api/v1/projects/p-1/events", ""))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401 (%s)", rec.Code, rec.Body)
	}
}

// TestEventStreamNonMemberIs404AndAudits: a stranger gets the same answer as
// for a project that does not exist, the denial is recorded, and — the part a
// stream makes easy to get wrong — not one journal row is read for it, because
// the response never became a stream.
func TestEventStreamNonMemberIs404AndAudits(t *testing.T) {
	project := evtNewProject("p-1")
	project.setVisible(false)
	stream := evtNewJournal()
	stream.add(evtEnvelope(4, "p-1", events.TypeProjectCreated))

	s := evtMount(t, project, stream, AuthenticatorFunc(func(*http.Request) (*Principal, error) {
		return &Principal{UserID: "mallory", OrganizationID: "o-1", CSRFToken: prjCSRF}, nil
	}), evtFast())
	rec := do(t, s, evtRecordedRequest(t, "http://localhost:8080/api/v1/projects/p-1/events", ""))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404 (%s)", rec.Code, rec.Body)
	}
	if got := strings.Join(project.deniedActions(), ","); got != "event.stream" {
		t.Errorf("audit denials = [%s], want one event.stream denial", got)
	}
	if stream.queryCount() != 0 {
		t.Errorf("journal was queried %d times for an unauthorized stream; want 0", stream.queryCount())
	}

	// An organization admin has no membership row and is still allowed
	// (ADR-0014 §3): same route, same store, different caller.
	project.setVisible(true)
	adminSrv := evtListen(t, evtMount(t, project, stream, prjAs("boss", true), evtFast()))
	sc, resp, _ := evtOpen(t, adminSrv, "/api/v1/projects/p-1/events", nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("org admin status = %d, want 200", resp.StatusCode)
	}
	if got := strings.Join(evtSeqs(evtFrames(t, sc, 1)), ","); got != "4" {
		t.Errorf("org admin replayed %s, want seq 4", got)
	}
}

// TestEventStreamEndsWhenAccessIsLost is the 06 edge case: a member removed
// while watching must stop receiving events. Revoking between two delivery
// attempts has to close the stream rather than carry on with a stale grant.
func TestEventStreamEndsWhenAccessIsLost(t *testing.T) {
	project := evtNewProject("p-1")
	stream := evtNewJournal()
	stream.add(evtEnvelope(1, "p-1", events.TypeRepositoryAdded))

	srv := evtListen(t, evtMount(t, project, stream, prjAs("u-1", false), evtFast()))
	sc, _, _ := evtOpen(t, srv, "/api/v1/projects/p-1/events", nil)
	if got := strings.Join(evtSeqs(evtFrames(t, sc, 1)), ","); got != "1" {
		t.Fatalf("ids = %s, want seq 1 first", got)
	}

	gets := project.getCalls()
	project.setVisible(false)
	// The next heartbeat re-checks authorization and finds the caller gone.
	if line := evtNextLine(t, sc); line != "" {
		t.Fatalf("line after revocation = %q, want the stream to end (EOF)", line)
	}
	if project.getCalls() <= gets {
		t.Errorf("authorization was not re-checked during the stream (%d GetProject calls)", project.getCalls())
	}
}

// TestEventStreamEndsWhenWakeSourceCloses: a replica shutting down retires its
// shared LISTEN connection; open streams must treat that as "finish" so
// graceful shutdown is bounded and browsers hand over to another replica.
func TestEventStreamEndsWhenWakeSourceCloses(t *testing.T) {
	project := evtNewProject("p-1")
	stream := evtNewJournal()
	stream.retireWakes = true

	srv := evtListen(t, evtMount(t, project, stream, prjAs("u-1", false),
		evtTiming{heartbeat: time.Hour, poll: time.Hour, batch: 100}))
	sc, _, _ := evtOpen(t, srv, "/api/v1/projects/p-1/events", nil)
	if line := evtNextLine(t, sc); line != "" {
		t.Fatalf("line = %q, want an immediate end of stream when the wake source is retired", line)
	}
}

// TestEventStreamStopsWhenClientDisconnects is the resource-leak guard: a
// browser that goes away must stop both the polling and the subscription, or a
// replica would keep querying the journal for a client that no longer exists.
func TestEventStreamStopsWhenClientDisconnects(t *testing.T) {
	project := evtNewProject("p-1")
	stream := evtNewJournal()

	srv := evtListen(t, evtMount(t, project, stream, prjAs("u-1", false), evtFast()))
	sc, _, cancel := evtOpen(t, srv, "/api/v1/projects/p-1/events", nil)
	if line := evtNextLine(t, sc); !strings.HasPrefix(line, ": heartbeat") {
		t.Fatalf("line = %q, want a heartbeat proving the stream is live", line)
	}

	cancel()

	// The handler releases its subscription with a deferred stop, so the count
	// dropping to zero proves the handler function returned.
	deadline := time.Now().Add(5 * time.Second)
	for stream.subscriptionCount() != 0 {
		if time.Now().After(deadline) {
			t.Fatalf("handler still holds its subscription 5s after the client hung up (%d queries)",
				stream.queryCount())
		}
		time.Sleep(25 * time.Millisecond)
	}
	// And it stays gone: no polling continues behind the disconnected client.
	before := stream.queryCount()
	if before == 0 {
		t.Fatal("the stream never queried the journal, so the read loop never ran")
	}
	time.Sleep(10 * evtFast().poll)
	if after := stream.queryCount(); after != before {
		t.Fatalf("journal queries grew from %d to %d after the client hung up", before, after)
	}
}

// TestEventStreamJournalErrorEndsStream: a broken read must not spin. Without
// this the loop would re-query a failing database as fast as it can answer.
func TestEventStreamJournalErrorEndsStream(t *testing.T) {
	project := evtNewProject("p-1")
	stream := evtNewJournal()
	stream.failWith(errors.New("connection reset by peer"))

	srv := evtListen(t, evtMount(t, project, stream, prjAs("u-1", false), evtFast()))
	sc, _, _ := evtOpen(t, srv, "/api/v1/projects/p-1/events", nil)
	if line := evtNextLine(t, sc); line != "" {
		t.Fatalf("line = %q, want the stream to end on a journal failure", line)
	}
}

// TestEventStreamStoreErrorIsServerError separates "you may not know this
// project" (404) from "the database is unhappy" (500) at connect time, so a
// transient failure never teaches an attacker that the project exists.
func TestEventStreamStoreErrorIsServerError(t *testing.T) {
	project := evtNewProject("p-1")
	project.mu.Lock()
	project.deniedErr = errStoreDown
	project.mu.Unlock()

	s := evtMount(t, project, evtNewJournal(), prjAs("u-1", false), evtFast())
	rec := do(t, s, evtRecordedRequest(t, "http://localhost:8080/api/v1/projects/p-1/events", ""))
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500 (%s)", rec.Code, rec.Body)
	}
	if strings.Contains(rec.Body.String(), errStoreDown.Error()) {
		t.Error("the store error leaked into the response body")
	}
}

// TestEventStreamUnknownProjectIsProblemJSON: a malformed project id is a 404
// problem document, not a stream that opens and then fails.
func TestEventStreamUnknownProjectIsProblemJSON(t *testing.T) {
	s := evtMount(t, evtNewProject("p-1"), evtNewJournal(), prjAs("u-1", false), evtFast())
	rec := do(t, s, evtRecordedRequest(t, "http://localhost:8080/api/v1/projects/nope/events", ""))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404 (%s)", rec.Code, rec.Body)
	}
	if p := decodeProblem(t, rec); p.Status != http.StatusNotFound {
		t.Errorf("problem = %+v, want a 404 problem document", p)
	}
}
