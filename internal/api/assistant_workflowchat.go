package api

// Thread → workflow (design 2f) wiring: the two assistant faces this
// package owes, implemented on the very services the user's own routes
// call, so the loop acts on exactly the same persistence and the same
// authorization as a browser request from the same human.
//
//   - assistantChatTranscriptService is the ChatTranscriptReader behind
//     chat.transcript: the caller-checked conversation read the
//     GET /api/v1/conversations/{id} route uses (GetConversation), the
//     repository the summary route resolves (the ListConversations row),
//     speaker names from the project's own member list, and the
//     transcript rows from the caller-checked journal read behind the SSE
//     stream (ConversationEventsAfter). An invisible chat answers the
//     store's not-found sentinel — the 404 rule, carried unmodified to
//     the runner; a lost read right answers assistant.ErrForbidden.
//   - assistantLibraryDraftService is the LibraryDraftCreator behind
//     workflow.create_draft: the library-role predicate the pipeline
//     routes apply (requireLibraryRole's fail-closed reading: today only
//     an organization admin holds it), then the user's own
//     POST /pipelines + POST /pipelines/{id}/drafts store calls with
//     source_kind "assistant". It creates; nothing here can publish.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/dbirks/communication/internal/assistant"
	"github.com/dbirks/communication/internal/events"
)

// --- chat.transcript ----------------------------------------------------

// assistantChatThreads is the conversation face the GET route uses: every
// read enforces the caller's visibility itself.
type assistantChatThreads interface {
	GetConversation(ctx context.Context, c Caller, conversationID string) (ConversationView, error)
	ListConversations(ctx context.Context, c Caller, projectID, origin, query, repository string) ([]ConversationSummaryView, error)
}

// assistantTranscriptJournal is the caller-checked journal read behind the
// conversation SSE stream (postgres.APIConversationStream): an invisible
// conversation is ErrConversationNotFound, never a peek.
type assistantTranscriptJournal interface {
	ConversationEventsAfter(ctx context.Context, c Caller, conversationID string, afterSeq int64, limit int) ([]events.Envelope, error)
}

// assistantChatMembers resolves speaker display names from the
// conversation's own project members (the same read the app shell's
// name-of-user uses). OPTIONAL: nil labels people by role, not by name.
type assistantChatMembers interface {
	ListMembers(ctx context.Context, c Caller, projectID string) ([]MemberView, error)
}

// Journal-read bounds for one transcript face call: the journal's own
// page max, a page count that caps the scan (a chat longer than this is
// a run node's transcript, not a drafting chat), and the newest folded
// lines kept — the tool folds to 40 itself; this only stops the fold
// from materializing a month of chatter.
const (
	cnvFaceEventPage  = 1000
	cnvFaceEventPages = 6
	cnvFaceKeptLines  = 120
)

type assistantChatTranscriptService struct {
	threads assistantChatThreads
	journal assistantTranscriptJournal
	members assistantChatMembers
}

// NewAssistantChatTranscript wires the chat.transcript face for the
// runner's loop. Every store call is the caller's own.
func NewAssistantChatTranscript(threads assistantChatThreads, journal assistantTranscriptJournal, members assistantChatMembers) assistant.ChatTranscriptReader {
	return &assistantChatTranscriptService{threads: threads, journal: journal, members: members}
}

// ReadChatTranscript reads the chat AS THE CALLER: the identity fields
// from the caller-checked GetConversation, the repository from the
// caller-checked summary row, the lines from the caller-checked journal
// read. A conversation the caller cannot see answers the store's
// not-found sentinel (the 404 rule); a lost read right answers
// assistant.ErrForbidden. The lines are folded to author-labelled text:
// one user row per prompt, the agent's chunks of one turn joined into
// one line, in transcript order.
func (s *assistantChatTranscriptService) ReadChatTranscript(ctx context.Context, c assistant.Caller, conversationID string) (assistant.ChatTranscript, error) {
	caller := ac(c)
	id := strings.TrimSpace(conversationID)
	if id == "" {
		return assistant.ChatTranscript{}, assistant.ErrNotFound
	}
	view, err := s.threads.GetConversation(ctx, caller, id)
	if err != nil {
		if errors.Is(err, ErrConversationForbidden) {
			return assistant.ChatTranscript{}, fmt.Errorf("%w: %v", assistant.ErrForbidden, err)
		}
		return assistant.ChatTranscript{}, err // the store's not-found sentinel stays itself
	}
	out := assistant.ChatTranscript{
		ConversationID: id,
		Title:          view.Title,
		AgentProfile:   view.AgentProfileName,
	}
	out.RepoName = s.chatRepositoryName(ctx, caller, view)
	lines, err := s.chatLines(ctx, caller, view)
	if err != nil {
		return assistant.ChatTranscript{}, err
	}
	out.Lines = lines
	return out, nil
}

// chatRepositoryName reads the thread's repository off the caller's own
// summary row (ADR-0065's server-side chain). A failure here names no
// repository and stops nothing: the field is decoration on a read that
// already authorized itself.
func (s *assistantChatTranscriptService) chatRepositoryName(ctx context.Context, c Caller, view ConversationView) string {
	rows, err := s.threads.ListConversations(ctx, c, view.ProjectID, "", "", "")
	if err != nil {
		return ""
	}
	for i := range rows {
		if rows[i].ID == view.ID && rows[i].RepositoryName != nil {
			return *rows[i].RepositoryName
		}
	}
	return ""
}

// chatLines folds the caller-checked journal rows into transcript lines:
// conversation.message.user is a person's line, conversation.message.agent
// chunks of one turn join into the agent's line (the same join the UI
// transcript does). Speaker names are server-resolved: member display
// names for people, the agent profile that ran the turn for the agent
// (the derived turn-range list, the conversation's current profile as
// the fallback). The newest cnvFaceKeptLines lines are kept; the tool's
// own fold names what it drops further.
func (s *assistantChatTranscriptService) chatLines(ctx context.Context, c Caller, view ConversationView) ([]assistant.ChatTranscriptLine, error) {
	var (
		envs  []events.Envelope
		after int64
	)
	for page := 0; page < cnvFaceEventPages && s.journal != nil; page++ {
		rows, err := s.journal.ConversationEventsAfter(ctx, c, view.ID, after, cnvFaceEventPage)
		if err != nil {
			return nil, err
		}
		envs = append(envs, rows...)
		if len(rows) < cnvFaceEventPage {
			break
		}
		after = rows[len(rows)-1].GlobalSeq
	}

	names := map[string]string{}
	if s.members != nil {
		if ms, err := s.members.ListMembers(ctx, c, view.ProjectID); err == nil {
			for i := range ms {
				names[ms[i].UserID] = ms[i].DisplayName
			}
		}
	}

	turnOrdinals := map[string]int{}
	ordinal := func(turnID string) int {
		if turnID == "" {
			return 0
		}
		if n, seen := turnOrdinals[turnID]; seen {
			return n
		}
		n := len(turnOrdinals) + 1
		turnOrdinals[turnID] = n
		return n
	}
	agentName := func(turnID string) string {
		if n := ordinal(turnID); n > 0 {
			for _, a := range view.Agents {
				if n >= a.FirstTurn && n <= a.LastTurn && a.AgentProfileName != "" {
					return a.AgentProfileName
				}
			}
		}
		if view.AgentProfileName != "" {
			return view.AgentProfileName
		}
		return "agent"
	}

	type agentLine struct {
		turnID string
		text   *strings.Builder
	}
	var (
		lines  []assistant.ChatTranscriptLine
		opened []agentLine
	)
	flush := func() {
		for _, o := range opened {
			if text := strings.TrimSpace(o.text.String()); text != "" {
				lines = append(lines, assistant.ChatTranscriptLine{Author: agentName(o.turnID), Text: text})
			}
		}
		opened = nil
	}
	for _, env := range envs {
		p := chatEventPayload(env)
		switch env.Type {
		case events.TypeConversationMessageUser:
			// A new prompt closes every open agent line: the next answer
			// belongs to the next turn.
			flush()
			ordinal(p.TurnID)
			author := ""
			if n, ok := names[p.SubmittedBy]; ok {
				author = n
			}
			if text := strings.TrimSpace(p.Text); text != "" {
				lines = append(lines, assistant.ChatTranscriptLine{Author: author, Text: text})
			}
		case events.TypeConversationMessageAgent:
			ordinal(p.TurnID)
			found := -1
			for i := range opened {
				if opened[i].turnID == p.TurnID {
					found = i
					break
				}
			}
			if found < 0 {
				opened = append(opened, agentLine{turnID: p.TurnID, text: &strings.Builder{}})
				found = len(opened) - 1
			}
			opened[found].text.WriteString(p.Text)
		}
	}
	flush()
	if len(lines) > cnvFaceKeptLines {
		lines = lines[len(lines)-cnvFaceKeptLines:]
	}
	return lines, nil
}

// chatEventPayload reads the fields the fold needs from one envelope.
// The journal stores payloads as jsonb (the scan hands back
// json.RawMessage); re-marshaling covers any other in-memory shape.
func chatEventPayload(env events.Envelope) struct {
	TurnID      string `json:"turn_id"`
	Text        string `json:"text"`
	SubmittedBy string `json:"submitted_by"`
} {
	var out struct {
		TurnID      string `json:"turn_id"`
		Text        string `json:"text"`
		SubmittedBy string `json:"submitted_by"`
	}
	blob, err := json.Marshal(env.Payload)
	if err != nil {
		return out
	}
	_ = json.Unmarshal(blob, &out)
	return out
}

// --- workflow.create_draft ------------------------------------------------

// assistantLibraryCreate is the create slice of the pipeline store: the
// two calls the user's own POST /pipelines and POST
// /pipelines/{id}/drafts routes make. Both re-enforce the caller's
// organization inside the store.
type assistantLibraryCreate interface {
	CreatePipeline(ctx context.Context, c Caller, slug, displayName, description string) (PipelineView, error)
	CreateDraft(ctx context.Context, c Caller, pipelineID string, in DraftCreateInput) (DraftView, error)
}

type assistantLibraryDraftService struct {
	store assistantLibraryCreate
}

// NewAssistantLibraryDraftCreator wires the workflow.create_draft face.
// The runner has already run loader → schema → compiler over the
// document before this face sees it; what it cannot run is the library
// role, and that is checked here, exactly where the routes check it.
func NewAssistantLibraryDraftCreator(store assistantLibraryCreate) assistant.LibraryDraftCreator {
	return &assistantLibraryDraftService{store: store}
}

// CreateLibraryDraft saves a NEW unpublished library draft: the
// library-role predicate the pipeline routes apply (the fail-closed
// reading — today only an organization admin holds the role), then the
// user's own create calls as the caller, source_kind "assistant".
// A denial answers assistant.ErrForbidden (recorded forbidden, naming no
// org facts). The honest edge: if the pipeline row is created but the
// draft write fails, the empty pipeline stays — the store offers no
// delete, and inventing one is not this face's to do; the model's retry
// then answers the slug clash as "unavailable", which is the truth.
func (s *assistantLibraryDraftService) CreateLibraryDraft(ctx context.Context, c assistant.Caller, in assistant.LibraryDraftInput) (assistant.LibraryDraftResult, error) {
	caller := ac(c)
	if !caller.IsOrgAdmin {
		// The same predicate plHandlers.requireLibraryRole enforces on the
		// user's own POST /pipelines; the assistant flow is not looser.
		return assistant.LibraryDraftResult{}, fmt.Errorf(
			"%w: the shared pipeline library needs the organization's library role", assistant.ErrForbidden)
	}
	pipe, err := s.store.CreatePipeline(ctx, caller, in.Slug, in.DisplayName,
		"Drafted from a thread by the assistant.")
	if err != nil {
		return assistant.LibraryDraftResult{}, fmt.Errorf("assistant library draft: %w", err)
	}
	draft, err := s.store.CreateDraft(ctx, caller, pipe.ID, DraftCreateInput{
		DocumentYAML: string(in.DocumentYAML),
		SourceKind:   "assistant",
		SourceSHA256: m4SHA256(in.DocumentYAML),
	})
	if err != nil {
		return assistant.LibraryDraftResult{}, fmt.Errorf("assistant library draft: %w", err)
	}
	slug := pipe.Slug
	if slug == "" {
		slug = in.Slug
	}
	return assistant.LibraryDraftResult{
		PipelineID: pipe.ID,
		Slug:       slug,
		DraftID:    draft.ID,
		Version:    draft.Version,
	}, nil
}
