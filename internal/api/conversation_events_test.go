package api

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/dbirks/communication/internal/events"
)

// The conversation transcript stream is the browser's only live view of an
// agent, so these tests pin the observable contract: the frame format, that the
// resume cursor is honoured, that a caller who loses access stops receiving
// frames *without* the stream turning into a lie, and that wake-ups are treated
// as a hint rather than as truth.
//
// Whether the rows themselves can contain a gap is a database property — the
// journal's commit-order argument — and it is proven against a real PostgreSQL
// in internal/store/postgres/events_test.go and conversations_test.go. The fake
// journal here hands out exactly what it is told to and must not be
// second-guessed by the handler.
//
// The lifecycle rules that keep this file from ever hanging are the ones
// internal/api/events_test.go documents: bounded read timeouts, a deadline on
// every stream context, and a server cleanup registered before (so it runs
// after) the cleanup that cancels the request.

// --- fake conversation journal ------------------------------------------

type cnvFakeStream struct {
	mu      sync.Mutex
	conv    string
	rows    []events.Envelope
	wakes   []chan struct{}
	queries int
	err     error
	// retiredWakes hands out an already-closed wake channel: this replica's
	// notification source is gone (shutdown).
	retiredWakes bool
	// silentSignal appends rows without signalling, so a test can prove the poll
	// — not the notification — is what bounds a lost wake-up's cost.
	silentSignal bool
}

func (f *cnvFakeStream) scopedTo(conversationID string) *cnvFakeStream {
	f.mu.Lock()
	f.conv = conversationID
	f.mu.Unlock()
	return f
}

func (f *cnvFakeStream) add(seq int64, typ string, payload string) {
	f.signal(events.Envelope{
		EventID:        fmt.Sprintf("01987a6e-0000-7000-8000-%012d", seq),
		GlobalSeq:      seq,
		Type:           typ,
		SchemaVersion:  1,
		OccurredAt:     prjFixedTime,
		OrganizationID: "o-1",
		ProjectID:      cnvTProject,
		ConversationID: f.conversation(),
		Actor:          events.Human(cnvTUserA),
		Payload:        json.RawMessage(payload),
	})
}

func (f *cnvFakeStream) conversation() string {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.conv == "" {
		return cnvTConv
	}
	return f.conv
}

func (f *cnvFakeStream) signal(env ...events.Envelope) {
	f.mu.Lock()
	f.rows = append(f.rows, env...)
	wakes := append([]chan struct{}(nil), f.wakes...)
	silent := f.silentSignal
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

func (f *cnvFakeStream) failWith(err error) {
	f.mu.Lock()
	f.err = err
	f.mu.Unlock()
}

func (f *cnvFakeStream) ConversationEventsAfter(ctx context.Context, _ Caller, conversationID string, afterSeq int64, limit int) ([]events.Envelope, error) {
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
		// The fake enforces the scoping the real read enforces in SQL: a stream
		// opened for one conversation cannot be handed another's rows, and a
		// cursor copied from elsewhere replays nothing it should not.
		if e.ConversationID != conversationID || e.GlobalSeq <= afterSeq {
			continue
		}
		out = append(out, e)
		if len(out) >= limit {
			break
		}
	}
	return out, nil
}

func (f *cnvFakeStream) Watch(ctx context.Context) (<-chan struct{}, func(), error) {
	f.mu.Lock()
	retire := f.retiredWakes
	f.mu.Unlock()
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
	return ch, func() {
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
	}, nil
}

func (f *cnvFakeStream) queryCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.queries
}

// stopWakes ends every subscription, as a replica shutdown does.
func (f *cnvFakeStream) stopWakes() {
	f.mu.Lock()
	wakes := f.wakes
	f.wakes = nil
	f.mu.Unlock()
	for _, w := range wakes {
		close(w)
	}
}

var _ ConversationEventStream = (*cnvFakeStream)(nil)

// --- store double with revocable access ---------------------------------

// cnvStreamStore is the conversation store as a long-lived stream sees it: the
// caller's visibility can be withdrawn while the stream is open, which is the
// only way to test that authorization is re-asked rather than assumed.
type cnvStreamStore struct {
	*cnvFakeStore
	mu      sync.Mutex
	visible bool
	auths   int
}

func (s *cnvStreamStore) AuthorizeConversation(ctx context.Context, c Caller, conversationID string) (string, error) {
	s.mu.Lock()
	s.auths++
	visible := s.visible
	s.mu.Unlock()
	if err := ctx.Err(); err != nil {
		return "", err
	}
	if !visible || conversationID != cnvTConv {
		return "", ErrConversationNotFound
	}
	return cnvTProject, nil
}

func (s *cnvStreamStore) revoke() {
	s.mu.Lock()
	s.visible = false
	s.mu.Unlock()
}

func (s *cnvStreamStore) authorizeCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.auths
}

func newStreamStore() *cnvStreamStore {
	return &cnvStreamStore{cnvFakeStore: cnvNewFakeStore(), visible: true}
}

// --- helpers ------------------------------------------------------------

// cnvStreamMount builds a server whose stream timing is a fraction of a second.
func cnvStreamMount(t *testing.T, store ConversationStore, stream ConversationEventStream, auth Authenticator) *Server {
	t.Helper()
	s := New(Config{ReplicaName: "replica-a", Version: "dev", PublicURL: "http://localhost:8080",
		Logger: discardLogger()}, fakeReadiness{expected: 3}, auth, nil)
	h := &cnvHandlers{store: store, srv: s}
	registerConversationEvents(s, h, stream, evtFast())
	return s
}

func cnvStreamPath(conversationID string) string {
	return "/api/v1/conversations/" + conversationID + "/events"
}

// cnvEOF drains whatever is still buffered and reports whether the stream ended.
// It must not stop at the next frame: a revoked caller can have a heartbeat
// already in flight, and "did it end?" is only answerable at EOF.
func cnvEOF(t *testing.T, sc *bufio.Scanner) bool {
	t.Helper()
	ended := make(chan bool, 1)
	go func() {
		for sc.Scan() {
		}
		ended <- true
	}()
	select {
	case <-ended:
		return true
	case <-time.After(evtReadTimeout):
		return false
	}
}

// --- tests --------------------------------------------------------------

// TestConversationStreamServesContractedFrames pins the SSE wire format for a
// transcript: `id` is global_seq, `event` is the dotted type, `data` is the
// EventEnvelope with its conversation scope attached.
func TestConversationStreamServesContractedFrames(t *testing.T) {
	store := newStreamStore()
	stream := (&cnvFakeStream{}).scopedTo(cnvTConv)
	stream.add(11, events.TypeConversationCreated, `{"conversation_id":"x","title":"Fix the flaky test"}`)
	stream.add(12, events.TypeConversationMessageUser, `{"conversation_id":"x","turn_id":"y","prompt":"start"}`)

	srv := evtListen(t, cnvStreamMount(t, store, stream, cnvCaller(cnvTUserA)))
	sc, resp, _ := evtOpen(t, srv, cnvStreamPath(cnvTConv), nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	if ct := resp.Header.Get("Content-Type"); !strings.HasPrefix(ct, "text/event-stream") {
		t.Errorf("content-type = %q, want text/event-stream (charset suffix aside)", ct)
	}
	if cc := resp.Header.Get("Cache-Control"); cc != "no-store" {
		t.Errorf("cache-control = %q, want no-store", cc)
	}
	if rep := resp.Header.Get(HeaderReplica); rep != "replica-a" {
		t.Errorf("%s = %q, want replica-a", HeaderReplica, rep)
	}

	frames := evtFrames(t, sc, 2)
	if frames[0][0] != "11" || frames[0][1] != events.TypeConversationCreated {
		t.Errorf("frame 1 = %v, want id 11 and the dotted event name", frames[0])
	}
	if frames[1][0] != "12" || frames[1][1] != events.TypeConversationMessageUser {
		t.Errorf("frame 2 = %v, want id 12", frames[1])
	}
	var env events.Envelope
	if err := json.Unmarshal([]byte(frames[0][2]), &env); err != nil {
		t.Fatalf("frame data is not an EventEnvelope: %v (%s)", err, frames[0][2])
	}
	if env.ConversationID == "" || env.GlobalSeq != 11 || env.EventID == "" {
		t.Errorf("envelope = %+v, want the conversation scope and cursor", env)
	}
	// The payload reaches the browser as stored, not re-encoded: a transcript
	// that re-marshalled agent text would silently change what the team reads.
	if !strings.Contains(frames[0][2], `"title":"Fix the flaky test"`) {
		t.Errorf("payload was re-encoded: %s", frames[0][2])
	}
}

// TestConversationStreamResumesFromLastEventID is the reconnect path: EventSource
// sends the header automatically and the stream must continue, not replay.
func TestConversationStreamResumesFromLastEventID(t *testing.T) {
	store := newStreamStore()
	stream := (&cnvFakeStream{}).scopedTo(cnvTConv)
	for seq := int64(1); seq <= 5; seq++ {
		stream.add(seq, events.TypeConversationMessageUser, `{"turn_id":"t"}`)
	}

	srv := evtListen(t, cnvStreamMount(t, store, stream, cnvCaller(cnvTUserA)))
	sc, resp, _ := evtOpen(t, srv, cnvStreamPath(cnvTConv), map[string]string{"Last-Event-ID": "3"})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d", resp.StatusCode)
	}
	frames := evtFrames(t, sc, 2)
	if frames[0][0] != "4" || frames[1][0] != "5" {
		t.Fatalf("replayed %v after Last-Event-ID 3, want only 4 and 5", evtSeqs(frames))
	}
}

func TestConversationStreamRejectsGarbageCursor(t *testing.T) {
	store := newStreamStore()
	stream := (&cnvFakeStream{}).scopedTo(cnvTConv)
	stream.add(1, events.TypeConversationCreated, `{}`)
	srv := evtListen(t, cnvStreamMount(t, store, stream, cnvCaller(cnvTUserA)))

	// A cursor the server cannot interpret is a validation failure, not a
	// silently-ignored one: resuming from 0 would replay a whole transcript into
	// a client that asked to continue.
	for _, bad := range []string{"not-a-number", "-1", "18446744073709551616"} {
		_, resp, _ := evtOpen(t, srv, cnvStreamPath(cnvTConv), map[string]string{"Last-Event-ID": bad})
		if resp.StatusCode != http.StatusUnprocessableEntity {
			t.Errorf("Last-Event-ID %q = %d, want 422", bad, resp.StatusCode)
		}
		body := map[string]any{}
		_ = json.NewDecoder(resp.Body).Decode(&body)
		if title, _ := body["title"].(string); title != "Validation Failed" {
			t.Errorf("Last-Event-ID %q: problem = %v, want a Validation Failed problem", bad, body)
		}
	}
}

// TestConversationStreamNonMemberNeverOpens proves the two things the ADR is
// about: a stranger gets 404 rather than an open stream (existence is not
// disclosed) and an audit row records the attempt.
func TestConversationStreamNonMemberNeverOpens(t *testing.T) {
	store := newStreamStore()
	store.revoke()
	stream := (&cnvFakeStream{}).scopedTo(cnvTConv)
	stream.add(1, events.TypeConversationMessageAgent, `{"text":"a secret"}`)

	s := cnvStreamMount(t, store, stream, cnvCaller("stranger"))
	rec := do(t, s, evtRecordedRequest(t, "http://localhost:8080"+cnvStreamPath(cnvTConv), ""))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404 (%s)", rec.Code, rec.Body)
	}
	if ct := rec.Header().Get("Content-Type"); strings.HasPrefix(ct, "text/event-stream") {
		t.Errorf("content-type = %q: a refused stream must not look like a stream", ct)
	}
	if len(store.denied) != 1 || store.denied[0].action != "conversation.stream" {
		t.Errorf("audit rows = %+v, want one conversation.stream", store.denied)
	}
	if stream.queryCount() != 0 {
		t.Errorf("journal was read %d times although the caller may not see the conversation", stream.queryCount())
	}
}

func TestConversationStreamUnknownConversationIsNotFound(t *testing.T) {
	store := newStreamStore()
	stream := (&cnvFakeStream{}).scopedTo(cnvTConv)
	s := cnvStreamMount(t, store, stream, cnvCaller(cnvTUserA))
	rec := do(t, s, request(http.MethodGet, "http://localhost:8080"+cnvStreamPath("not-a-uuid"), nil))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("malformed conversation id on the stream = %d, want 404 (%s)", rec.Code, rec.Body)
	}
}

// TestConversationStreamHeartbeatReauthorizes is ADR-0016's answer to a removed
// member: the heartbeat is not decoration, it is the periodic re-check, and
// when access is gone the stream ends instead of idling forever.
func TestConversationStreamHeartbeatReauthorizes(t *testing.T) {
	store := newStreamStore()
	stream := (&cnvFakeStream{}).scopedTo(cnvTConv)
	srv := evtListen(t, cnvStreamMount(t, store, stream, cnvCaller(cnvTUserA)))

	sc, resp, cancel := evtOpen(t, srv, cnvStreamPath(cnvTConv), nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d", resp.StatusCode)
	}
	line := evtNextLine(t, sc)
	if !strings.HasPrefix(line, ":") {
		t.Fatalf("first line on an idle stream = %q, want a comment", line)
	}
	before := store.authorizeCount()
	if before == 0 {
		t.Fatal("stream opened without authorizing at connect")
	}

	store.revoke()
	if !cnvEOF(t, sc) {
		t.Errorf("stream stayed open after access was revoked")
	}
	if after := store.authorizeCount(); after <= before {
		t.Errorf("authorization checks = %d at open, %d after: the heartbeat never re-asked", before, after)
	}
	cancel()
}

// TestConversationStreamReauthorizesBeforeDelivery covers the case the heartbeat
// alone would miss: rows are waiting, so the loop would deliver them without
// ever reaching the heartbeat branch.
func TestConversationStreamReauthorizesBeforeDelivery(t *testing.T) {
	store := newStreamStore()
	stream := (&cnvFakeStream{}).scopedTo(cnvTConv)
	// Rows appear, and the very moment the stream looks at them the caller is
	// out of the project.
	store.revoke()
	stream.add(3, events.TypeConversationMessageAgent, `{"text":"after the fact"}`)

	s := cnvStreamMount(t, store, stream, cnvCaller(cnvTUserA))
	rec := do(t, s, evtRecordedRequest(t, "http://localhost:8080"+cnvStreamPath(cnvTConv), ""))
	// Connect-time authorization answers the 404; nothing is streamed and no row
	// is delivered.
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404 (%s)", rec.Code, rec.Body)
	}
	if strings.Contains(rec.Body.String(), "after the fact") {
		t.Errorf("transcript text reached a caller who may not see it: %s", rec.Body)
	}
}

// TestConversationStreamDeliversLiveRows proves the wake-up path end to end:
// the browser sees a row the moment a worker appends it, without a reconnect.
func TestConversationStreamDeliversLiveRows(t *testing.T) {
	store := newStreamStore()
	stream := (&cnvFakeStream{}).scopedTo(cnvTConv)
	// One row is already durable before the browser connects: it must arrive
	// first, and it must not be confused with the live one.
	stream.add(21, events.TypeConversationMessageUser, `{"turn_id":"seed"}`)

	srv := evtListen(t, cnvStreamMount(t, store, stream, cnvCaller(cnvTUserA)))
	sc, _, _ := evtOpen(t, srv, cnvStreamPath(cnvTConv), nil)

	frames := evtFrames(t, sc, 1)
	if frames[0][0] != "21" {
		t.Fatalf("seed frame = %v, want the row that was already journaled", frames[0])
	}

	// The worker appends while the connection is open. The stream must pick it up
	// without the client reconnecting or polling by hand.
	stream.add(22, events.TypeConversationTurnCompleted, `{"turn_id":"t","stop_reason":"end_turn"}`)
	frames = evtFrames(t, sc, 1)
	if frames[0][0] != "22" || frames[0][1] != events.TypeConversationTurnCompleted {
		t.Fatalf("live frame = %v", frames[0])
	}
}

// TestConversationStreamPollCoversLostWakeUps is the ADR-0014 §6 claim made
// testable: a notification that never arrives costs latency, never correctness.
func TestConversationStreamPollCoversLostWakeUps(t *testing.T) {
	store := newStreamStore()
	stream := (&cnvFakeStream{}).scopedTo(cnvTConv)
	stream.silentSignal = true
	srv := evtListen(t, cnvStreamMount(t, store, stream, cnvCaller(cnvTUserA)))
	sc, _, _ := evtOpen(t, srv, cnvStreamPath(cnvTConv), nil)

	go func() {
		time.Sleep(20 * time.Millisecond)
		stream.add(31, events.TypeConversationMessageUser, `{"turn_id":"t"}`)
	}()
	frames := evtFrames(t, sc, 1)
	if frames[0][0] != "31" {
		t.Fatalf("frame = %v, want the row the poll found without a wake-up", frames[0])
	}
}

func TestConversationStreamReadFailureEndsStream(t *testing.T) {
	store := newStreamStore()
	stream := (&cnvFakeStream{}).scopedTo(cnvTConv)
	srv := evtListen(t, cnvStreamMount(t, store, stream, cnvCaller(cnvTUserA)))
	sc, resp, _ := evtOpen(t, srv, cnvStreamPath(cnvTConv), nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d", resp.StatusCode)
	}
	stream.failWith(errors.New("journal: read timed out"))
	if !cnvEOF(t, sc) {
		t.Errorf("stream stayed open after the journal began failing")
	}
}

// TestConversationStreamEndsWhenWakeSourceIsGone lets a rolling restart drain:
// a stream that outlived its replica's notification source would hold the
// process open until its clients gave up.
func TestConversationStreamEndsWhenWakeSourceIsGone(t *testing.T) {
	store := newStreamStore()
	stream := (&cnvFakeStream{}).scopedTo(cnvTConv)
	srv := evtListen(t, cnvStreamMount(t, store, stream, cnvCaller(cnvTUserA)))
	sc, _, _ := evtOpen(t, srv, cnvStreamPath(cnvTConv), nil)

	stream.stopWakes()
	if !cnvEOF(t, sc) {
		t.Errorf("stream stayed open after its wake-up source was retired")
	}
}

// TestConversationStreamAnonymousIsUnauthorized keeps the stream from becoming
// an unauthenticated channel: SSE is a GET, so the session cookie must be what
// gates it, and no frame is written on failure.
func TestConversationStreamAnonymousIsUnauthorized(t *testing.T) {
	store := newStreamStore()
	stream := (&cnvFakeStream{}).scopedTo(cnvTConv)
	s := cnvStreamMount(t, store, stream, principalAuth(nil, ErrUnauthenticated))
	rec := do(t, s, request(http.MethodGet, "http://localhost:8080"+cnvStreamPath(cnvTConv), nil))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401 (%s)", rec.Code, rec.Body)
	}
	if stream.queryCount() != 0 {
		t.Errorf("journal read %d times for an anonymous request", stream.queryCount())
	}
}
