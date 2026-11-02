package api

// Thread → workflow (design 2f) face tests: the two services the assistant
// runner consumes (internal/api/assistant_workflowchat.go) must refuse a
// caller the store refuses (the 404 rule / the library role), and must
// otherwise return exactly what the user's own routes would have shown.

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/dbirks/communication/internal/assistant"
	"github.com/dbirks/communication/internal/events"
)

// --- fakes ----------------------------------------------------------------

// wfchatThreads is the caller-checked conversation read: only the listed
// user ids see the thread; everyone else gets the not-found sentinel, the
// same answer postgres gives a non-member (and a revoked member gets the
// forbidden sentinel when revokedMembers says so).
type wfchatThreads struct {
	view          ConversationView
	members       map[string]bool
	revoked       map[string]bool
	repoName      *string
	summaryListed int
	creates       int
}

func (f *wfchatThreads) GetConversation(_ context.Context, c Caller, id string) (ConversationView, error) {
	if id != f.view.ID || !f.members[c.UserID] {
		return ConversationView{}, ErrConversationNotFound
	}
	if f.revoked[c.UserID] {
		return ConversationView{}, ErrConversationForbidden
	}
	return f.view, nil
}

func (f *wfchatThreads) ListConversations(_ context.Context, c Caller, projectID, _, _, _ string) ([]ConversationSummaryView, error) {
	if projectID != f.view.ProjectID || !f.members[c.UserID] {
		return nil, ErrProjectNotFound
	}
	f.summaryListed++
	return []ConversationSummaryView{{
		ID: f.view.ID, ProjectID: f.view.ProjectID, Title: f.view.Title,
		RepositoryName: f.repoName,
	}}, nil
}

// wfchatJournal is the caller-checked transcript journal: the same rows
// the SSE stream replays, visible only to members.
type wfchatJournal struct {
	members map[string]bool
	rows    []events.Envelope
	calls   int
}

func (f *wfchatJournal) ConversationEventsAfter(_ context.Context, c Caller, _ string, afterSeq int64, limit int) ([]events.Envelope, error) {
	f.calls++
	if !f.members[c.UserID] {
		return nil, ErrConversationNotFound
	}
	var out []events.Envelope
	for _, e := range f.rows {
		if e.GlobalSeq > afterSeq {
			out = append(out, e)
			if len(out) >= limit {
				break
			}
		}
	}
	return out, nil
}

type wfchatMembers struct{ items []MemberView }

func (f *wfchatMembers) ListMembers(context.Context, Caller, string) ([]MemberView, error) {
	return f.items, nil
}

// wfchatPipes is the create face: the two calls workflow.create_draft
// rides, each recording its input.
type wfchatPipes struct {
	gotSlug, gotName, gotDesc string
	pipelineCalls             int
	draft                     DraftCreateInput
	draftFor                  string
	draftCalls                int
}

func (f *wfchatPipes) CreatePipeline(_ context.Context, _ Caller, slug, displayName, description string) (PipelineView, error) {
	f.pipelineCalls++
	f.gotSlug, f.gotName, f.gotDesc = slug, displayName, description
	return PipelineView{ID: "pl-new", Slug: slug, DisplayName: displayName}, nil
}

func (f *wfchatPipes) CreateDraft(_ context.Context, _ Caller, pipelineID string, in DraftCreateInput) (DraftView, error) {
	f.draftCalls++
	f.draftFor, f.draft = pipelineID, in
	return DraftView{ID: "d-new", PipelineID: pipelineID, Status: "draft",
		Version: 1, DocumentYAML: in.DocumentYAML, SourceKind: in.SourceKind}, nil
}

func wfchatUser(seq int64, turnID, by, text string) events.Envelope {
	blob, _ := json.Marshal(map[string]string{
		"conversation_id": "cv-1", "turn_id": turnID, "submitted_by": by, "text": text,
	})
	return events.Envelope{EventID: string(rune('a'+int(seq))) + "-u", GlobalSeq: seq,
		Type: events.TypeConversationMessageUser, OccurredAt: time.Now().UTC(),
		ConversationID: "cv-1", Payload: json.RawMessage(blob)}
}

func wfchatAgent(seq int64, turnID, text string, final bool) events.Envelope {
	blob, _ := json.Marshal(map[string]any{
		"conversation_id": "cv-1", "turn_id": turnID, "text": text, "final": final,
	})
	return events.Envelope{EventID: string(rune('a'+int(seq))) + "-a", GlobalSeq: seq,
		Type: events.TypeConversationMessageAgent, OccurredAt: time.Now().UTC(),
		ConversationID: "cv-1", Payload: json.RawMessage(blob)}
}

func wfchatFixture() (*wfchatThreads, *wfchatJournal, *wfchatMembers) {
	repo := "communication"
	view := ConversationView{
		ID: "cv-1", ProjectID: "prj-1", Title: "Adapter swap spike",
		AgentProfileName: "Codex",
		Agents: []ConversationChatAgentView{{
			AgentProfileID: "ap-codex", AgentProfileName: "Codex",
			FirstTurn: 1, LastTurn: 2, TurnCount: 2,
		}},
	}
	threads := &wfchatThreads{
		view:     view,
		members:  map[string]bool{"u-grace": true, "u-admin": true},
		revoked:  map[string]bool{"u-revoked": false},
		repoName: &repo,
	}
	// A revoked member: the conversation read answers forbidden.
	threads.members["u-revoked"] = true
	threads.revoked["u-revoked"] = true
	journal := &wfchatJournal{members: threads.members, rows: []events.Envelope{
		wfchatUser(1, "t-1", "u-grace", "  Can you swap the adapter and open a PR?  "),
		wfchatAgent(2, "t-1", "I will ", false),
		wfchatAgent(3, "t-1", "check the ACP surface first.", false),
		wfchatUser(4, "t-2", "u-admin", "Also add the approval step."),
		wfchatAgent(5, "t-2", "Done — draft PR exists.", true),
	}}
	members := &wfchatMembers{items: []MemberView{
		{UserID: "u-grace", DisplayName: "Grace Hopper", Role: "maintainer"},
		{UserID: "u-admin", DisplayName: "Ada Lovelace", Role: "owner"},
	}}
	return threads, journal, members
}

func memberCaller(id string) assistant.Caller {
	return assistant.Caller{UserID: id, OrganizationID: "org-1"}
}

// --- chat.transcript -------------------------------------------------------

func TestChatTranscriptFaceRefusesNonMember(t *testing.T) {
	threads, journal, members := wfchatFixture()
	face := NewAssistantChatTranscript(threads, journal, members)

	_, err := face.ReadChatTranscript(context.Background(), memberCaller("u-stranger"), "cv-1")
	if !errors.Is(err, ErrConversationNotFound) {
		t.Fatalf("non-member: err = %v, want the not-found sentinel (the 404 rule)", err)
	}
	if journal.calls != 0 {
		t.Fatalf("non-member reached the journal: %d reads", journal.calls)
	}

	// A lost read right names itself forbidden, not absent.
	_, err = face.ReadChatTranscript(context.Background(), memberCaller("u-revoked"), "cv-1")
	if !errors.Is(err, assistant.ErrForbidden) {
		t.Fatalf("revoked member: err = %v, want assistant.ErrForbidden", err)
	}
}

func TestChatTranscriptFaceReadsForMember(t *testing.T) {
	threads, journal, members := wfchatFixture()
	face := NewAssistantChatTranscript(threads, journal, members)

	got, err := face.ReadChatTranscript(context.Background(), memberCaller("u-grace"), "cv-1")
	if err != nil {
		t.Fatalf("member read: %v", err)
	}
	if got.ConversationID != "cv-1" || got.Title != "Adapter swap spike" {
		t.Fatalf("identity: %+v", got)
	}
	if got.RepoName != "communication" {
		t.Fatalf("repository: %+v", got)
	}
	if got.AgentProfile != "Codex" {
		t.Fatalf("agent profile: %+v", got)
	}
	want := []assistant.ChatTranscriptLine{
		{Author: "Grace Hopper", Text: "Can you swap the adapter and open a PR?"},
		{Author: "Codex", Text: "I will check the ACP surface first."},
		{Author: "Ada Lovelace", Text: "Also add the approval step."},
		{Author: "Codex", Text: "Done — draft PR exists."},
	}
	if len(got.Lines) != len(want) {
		t.Fatalf("lines = %d (%v), want %d", len(got.Lines), got.Lines, len(want))
	}
	for i := range want {
		if got.Lines[i] != want[i] {
			t.Errorf("line %d = %+v, want %+v", i, got.Lines[i], want[i])
		}
	}
}

// --- workflow.create_draft ---------------------------------------------------

func TestLibraryDraftFaceCreatesUnpublishedDraft(t *testing.T) {
	pipes := &wfchatPipes{}
	face := NewAssistantLibraryDraftCreator(pipes)
	doc := "apiVersion: communication.dev/v1alpha1\nkind: Pipeline\n"

	got, err := face.CreateLibraryDraft(context.Background(),
		assistant.Caller{UserID: "u-admin", OrganizationID: "org-1", IsOrgAdmin: true},
		assistant.LibraryDraftInput{Slug: "adapter-swap", DisplayName: "Adapter swap", DocumentYAML: []byte(doc)})
	if err != nil {
		t.Fatalf("org-admin create: %v", err)
	}
	if got.PipelineID != "pl-new" || got.Slug != "adapter-swap" || got.DraftID != "d-new" || got.Version != 1 {
		t.Fatalf("result: %+v", got)
	}
	if pipes.pipelineCalls != 1 || pipes.draftCalls != 1 || pipes.draftFor != "pl-new" {
		t.Fatalf("calls: %+v", pipes)
	}
	if pipes.draft.SourceKind != "assistant" {
		t.Fatalf("source kind = %q, want assistant", pipes.draft.SourceKind)
	}
	if pipes.draft.DocumentYAML != doc {
		t.Fatalf("document bytes moved altered: %q", pipes.draft.DocumentYAML)
	}
	if pipes.draft.SourceSHA256 != m4SHA256([]byte(doc)) {
		t.Fatalf("source sha256 = %q, want the hash of the stored bytes", pipes.draft.SourceSHA256)
	}
}

func TestLibraryDraftFaceRequiresTheLibraryRole(t *testing.T) {
	pipes := &wfchatPipes{}
	face := NewAssistantLibraryDraftCreator(pipes)

	_, err := face.CreateLibraryDraft(context.Background(), memberCaller("u-grace"),
		assistant.LibraryDraftInput{Slug: "adapter-swap", DisplayName: "Adapter swap",
			DocumentYAML: []byte("x")})
	if !errors.Is(err, assistant.ErrForbidden) {
		t.Fatalf("member without the library role: err = %v, want assistant.ErrForbidden", err)
	}
	if pipes.pipelineCalls != 0 || pipes.draftCalls != 0 {
		t.Fatalf("a role denial still wrote: %+v", pipes)
	}
}
