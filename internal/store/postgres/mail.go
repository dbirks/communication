package postgres

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/dbirks/communication/internal/events"
	"github.com/dbirks/communication/internal/worker"
)

// Agent mail (ADR-0072): the store side of one chat's agent asking the agent
// of another repository in the same project. Three arms live here:
//
//   - DispatchMail: the worker's interpretation of a completed turn's mail
//     commands — create the linked target chat, enqueue its read-only answer
//     turn, journal conversation.mail.asked (accepted or rejected). Fenced on
//     the asking turn's lease triple, and it re-reads the project setting
//     inside the transaction: a claim-time `mail_allowed` that the setting
//     flipped off beneath is refused at dispatch, not journalled on faith.
//   - trnResolveMailTx: the FinishTurn arm. When a link's answering turn
//     reaches its terminal state in the same fenced transaction, the link
//     settles (answer from this turn's journaled chunks),
//     conversation.mail.answered is journalled on BOTH chats, and the
//     asking chat gets the follow-up prompt that hands the answer to its own
//     agent.
//   - expireStaleMail: the reconciler arm for an answer that never came —
//     the deadline, not a person, writes `expired`.
//
// Authz lives in the data, not a role check: the target repository is looked
// up BY NAME INSIDE THE PROJECT the asking conversation belongs to, so a
// cross-project ask is unresolvable rather than refused, and the asking
// turn's author must still hold a project membership when the ask lands.
// Depth 1 lives in the claim predicate (a conversation that is any link's
// target is never mail-eligible); the per-chat cap and the answer deadline
// are constants a store field can widen.

const (
	// DefaultMailAnswerTimeout bounds how long a link may wait in `asked`
	// before the reconciler calls it `expired`.
	DefaultMailAnswerTimeout = 10 * time.Minute
	// DefaultMailCap caps the links one conversation may ever open (asked,
	// answered, failed or expired — a spent ask still counts, so "a per-chat
	// cap" bounds fan-out, not just in-flight work).
	DefaultMailCap = 8
	// MailAnswerCap bounds link.answer and the journalled answer text.
	MailAnswerCap = 16384
)

// mailTimeout / mailCap resolve the zero-value defaults.
func (s *TurnStore) mailTimeout() time.Duration {
	if s.MailAnswerTimeout <= 0 {
		return DefaultMailAnswerTimeout
	}
	return s.MailAnswerTimeout
}

func (s *TurnStore) mailCap() int {
	if s.MailCap <= 0 {
		return DefaultMailCap
	}
	return s.MailCap
}

var _ worker.MailPort = (*TurnStore)(nil)

// DispatchMail implements worker.MailPort. One fenced transaction interprets
// every ask, so a stale worker creates no links, no turns and no rows — the
// same fail-closed rule every other turn write follows (ADR-0016 §9
// obligation 2).
func (s *TurnStore) DispatchMail(ctx context.Context, c worker.Claim, asks []worker.MailAsk) ([]worker.MailResult, error) {
	if len(asks) == 0 {
		return nil, nil
	}
	out := make([]worker.MailResult, 0, len(asks))
	err := s.trnWithFenceTripleTx(ctx, c, func(ctx context.Context, tx pgx.Tx) error {
		var (
			enabled       bool
			askedBy       string
			fromTitle     string
			askingProfile string
		)
		if err := tx.QueryRow(ctx, `
			SELECT p.agent_mail_enabled, t.submitted_by::text, c.title,
			       COALESCE(t.agent_profile_id, c.agent_profile_id)::text
			FROM conversation_turns t
			JOIN conversations c ON c.id = t.conversation_id
			JOIN projects p ON p.id = c.project_id
			WHERE t.id = $1::uuid`, c.TurnID).
			Scan(&enabled, &askedBy, &fromTitle, &askingProfile); err != nil {
			return fmt.Errorf("postgres: mail dispatch read: %w", err)
		}
		var member bool
		if err := tx.QueryRow(ctx, `
			SELECT EXISTS (SELECT 1 FROM memberships WHERE project_id = $1::uuid AND user_id = $2::uuid)`,
			c.ProjectID, askedBy).Scan(&member); err != nil {
			return fmt.Errorf("postgres: mail dispatch membership: %w", err)
		}
		var have int
		if err := tx.QueryRow(ctx, `
			SELECT count(*) FROM conversation_links WHERE from_conversation_id = $1::uuid`,
			c.ConversationID).Scan(&have); err != nil {
			return fmt.Errorf("postgres: mail dispatch cap: %w", err)
		}
		cap := s.mailCap()

		for _, ask := range asks {
			if reason := mailGate(enabled, member, have, cap, ask); reason != "" {
				if err := trnJournalMailAsked(ctx, tx, c, ask, "", "", events.MailStateRejected, reason); err != nil {
					return err
				}
				out = append(out, worker.MailResult{
					Repo: ask.Repo, Question: ask.Question,
					State: events.MailStateRejected, Reason: reason,
				})
				continue
			}
			var repoID string
			err := tx.QueryRow(ctx, `
				SELECT id::text FROM repositories WHERE project_id = $1::uuid AND name = $2`,
				c.ProjectID, ask.Repo).Scan(&repoID)
			if errors.Is(err, pgx.ErrNoRows) {
				reason := fmt.Sprintf("no repository named %q in this project", ask.Repo)
				if err := trnJournalMailAsked(ctx, tx, c, ask, "", "", events.MailStateRejected, reason); err != nil {
					return err
				}
				out = append(out, worker.MailResult{
					Repo: ask.Repo, Question: ask.Question,
					State: events.MailStateRejected, Reason: reason,
				})
				continue
			}
			if err != nil {
				return fmt.Errorf("postgres: mail dispatch repo: %w", err)
			}

			var toConv string
			if err := tx.QueryRow(ctx, `
				INSERT INTO conversations (project_id, agent_profile_id, title, status, created_by, repository_id)
				VALUES ($1::uuid, $2::uuid, $3, 'idle', $4::uuid, $5::uuid)
				RETURNING id::text`,
				c.ProjectID, askingProfile, mailTitle(fromTitle, ask.Repo), askedBy, repoID).
				Scan(&toConv); err != nil {
				return fmt.Errorf("postgres: mail target conversation: %w", err)
			}
			if _, err := tx.Exec(ctx, `
				INSERT INTO conversation_control (conversation_id, controller_kind)
				VALUES ($1::uuid, 'none')`, toConv); err != nil {
				return fmt.Errorf("postgres: mail target control: %w", err)
			}

			var linkID string
			if err := tx.QueryRow(ctx, `
				INSERT INTO conversation_links
				    (project_id, from_conversation_id, to_conversation_id, from_turn_id,
				     asked_by, repo_name, question, state, answer_deadline)
				VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6, $7, 'asked',
				        now() + make_interval(secs => $8::double precision))
				RETURNING id::text`,
				c.ProjectID, c.ConversationID, toConv, c.TurnID, askedBy,
				ask.Repo, ask.Question, s.mailTimeout().Seconds()).
				Scan(&linkID); err != nil {
				return fmt.Errorf("postgres: mail link: %w", err)
			}

			prompt := mailTargetPromptText(ctx, tx, fromTitle, askedBy, ask.Question)
			if _, err := tx.Exec(ctx, `
				INSERT INTO conversation_turns
				    (conversation_id, prompt, submitted_by, agent_profile_id, mail_link_id, permission_override)
				VALUES ($1::uuid, $2, $3::uuid, $4::uuid, $5::uuid, 'ask')`,
				toConv, prompt, askedBy, askingProfile, linkID); err != nil {
				return fmt.Errorf("postgres: mail answer turn: %w", err)
			}

			if err := trnJournalMailAsked(ctx, tx, c, ask, linkID, toConv, events.MailStateAsked, ""); err != nil {
				return err
			}
			have++
			out = append(out, worker.MailResult{
				Repo: ask.Repo, Question: ask.Question,
				State: events.MailStateAsked, LinkID: linkID,
			})
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

// mailGate answers why an ask cannot become a link right now ("" = it can):
// the setting (re-read inside the transaction), a membership the asker lost,
// or the per-chat cap.
func mailGate(enabled, member bool, have, cap int, ask worker.MailAsk) string {
	switch {
	case !enabled:
		return "agent mail is switched off for this project"
	case !member:
		return "the asking turn's author is no longer a member of the project"
	case have >= cap:
		return fmt.Sprintf("this chat has already used its %d mails for the project", cap)
	case len(ask.Repo) == 0 || len(ask.Question) == 0:
		return "malformed mail command"
	default:
		return ""
	}
}

// mailTitle names the linked chat honestly: who asked, which repo answers.
func mailTitle(fromTitle, repo string) string {
	t := "mail from " + fromTitle + " → " + repo
	if len([]rune(t)) > 200 {
		t = string([]rune(t)[:199]) + "\u2026"
	}
	return t
}

// mailTargetPromptText wraps the question for the target turn. fromTitle is
// re-read is unnecessary (the caller holds it), but askedBy is the durable
// user id the target's transcript names as the authorising human.
func mailTargetPromptText(_ context.Context, _ pgx.Tx, fromTitle, askedBy, question string) string {
	return worker.MailTargetPrompt(fromTitle, askedBy, question)
}

func trnJournalMailAsked(ctx context.Context, tx pgx.Tx, c worker.Claim, ask worker.MailAsk, linkID, toConv, state, reason string) error {
	_, err := trnAppendTx(ctx, tx, c.OrganizationID, c.ProjectID, c.ConversationID, worker.TurnEvent{
		Type:      events.TypeConversationMailAsked,
		ActorKind: events.ActorKindWorker,
		ActorID:   c.WorkerID,
		Payload: events.MailAskedPayload{
			ConversationID:   c.ConversationID,
			TurnID:           c.TurnID,
			LinkID:           linkID,
			ToConversationID: toConv,
			Repo:             ask.Repo,
			Question:         ask.Question,
			State:            state,
			Reason:           reason,
		},
	})
	return err
}

// EnqueueMailNotice implements worker.MailPort: a follow-up prompt authored
// for the asking agent (a rejection notice lands here; the accepted answer
// lands through trnResolveMailTx). Human prompts always win the race: an
// active turn or an archived conversation quietly swallows the notice
// (inserted=false) because the journal row already tells the story.
func (s *TurnStore) EnqueueMailNotice(ctx context.Context, conversationID, prompt, submittedBy string) (bool, error) {
	if !prjValidUUID(conversationID) || !prjValidUUID(submittedBy) {
		return false, errors.New("postgres: EnqueueMailNotice requires conversation and submitter uuids")
	}
	if strings.TrimSpace(prompt) == "" {
		return false, errors.New("postgres: EnqueueMailNotice requires a prompt")
	}
	if len([]rune(prompt)) > 65536 {
		prompt = string([]rune(prompt)[:65536])
	}
	// ADR-0068 § 1: the profile is stamped by EVERY turn writer from the
	// conversation's next-turn pointer, a notice's turn included — an unstamped
	// row would let whoever the chat points at by the time a worker asks for it
	// decide which agent received the answer.
	tag, err := s.Pool.Exec(ctx, `
		INSERT INTO conversation_turns (conversation_id, prompt, submitted_by, agent_profile_id)
		SELECT $1::uuid, $2, $3::uuid, c.agent_profile_id
		FROM conversations c
		WHERE c.id = $1::uuid AND c.status <> 'archived'
		  AND NOT EXISTS (SELECT 1 FROM conversation_turns
		                  WHERE conversation_id = $1::uuid AND status IN ('queued', 'leased', 'running'))`,
		conversationID, prompt, submittedBy)
	if err != nil {
		// The one-active-turn partial index is the backstop of the same rule
		// the NOT EXISTS races; a clash is the honest "a human got here first".
		if isUniqueViolation(err) {
			return false, nil
		}
		return false, fmt.Errorf("postgres: enqueue mail notice: %w", err)
	}
	return tag.RowsAffected() > 0, nil
}

// trnResolveMailTx settles the link this turn answers, if any. It runs
// inside the FinishTurn transaction: the terminal turn row, the link state,
// both conversation.mail.answered rows and the asking chat's follow-up are
// one atomic fact — there is no window where the answer is journaled but the
// link still says `asked`.
func trnResolveMailTx(ctx context.Context, tx pgx.Tx, c worker.Claim, o worker.TurnOutcome) error {
	var (
		linkID, repo, fromConv, askedBy string
	)
	err := tx.QueryRow(ctx, `
		SELECT l.id::text, l.repo_name, l.from_conversation_id::text, l.asked_by::text
		FROM conversation_links l
		JOIN conversation_turns t ON t.mail_link_id = l.id
		WHERE t.id = $1::uuid AND l.state = 'asked'`, c.TurnID).
		Scan(&linkID, &repo, &fromConv, &askedBy)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil // not a mail turn, or the deadline already settled it
	}
	if err != nil {
		return fmt.Errorf("postgres: mail resolve read: %w", err)
	}

	state := events.MailStateAnswered
	var answer, reason *string
	if o.Status == events.TurnStatusCompleted {
		text, err := trnTurnAnswerText(ctx, tx, c.ConversationID, c.TurnID)
		if err != nil {
			return err
		}
		answer = &text
	} else {
		state = events.MailStateFailed
		r := "the answering turn ended " + o.Status
		if o.Message != "" && len(o.Message) <= 300 {
			r += ": " + o.Message
		}
		reason = &r
	}

	tag, err := tx.Exec(ctx, `
		UPDATE conversation_links
		SET state = $2,
		    answer = $3,
		    reason = $4,
		    answered_at = CASE WHEN $2 = 'answered' THEN now() ELSE NULL END
		WHERE id = $1::uuid AND state = 'asked'`,
		linkID, state, answer, reason)
	if err != nil {
		return fmt.Errorf("postgres: mail resolve settle: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return nil // expired between the read and the lock: the deadline won
	}

	payload := func(conversationID string) events.MailAnsweredPayload {
		p := events.MailAnsweredPayload{
			ConversationID:     conversationID,
			LinkID:             linkID,
			FromConversationID: fromConv,
			ToConversationID:   c.ConversationID,
			Repo:               repo,
			State:              state,
			LauncherID:         c.LauncherID,
		}
		if answer != nil {
			p.Answer = *answer
		}
		if reason != nil {
			p.Reason = *reason
		}
		return p
	}
	if _, err := trnAppendTx(ctx, tx, c.OrganizationID, c.ProjectID, c.ConversationID, worker.TurnEvent{
		Type:      events.TypeConversationMailAnswered,
		ActorKind: events.ActorKindWorker,
		ActorID:   c.WorkerID,
		Payload:   payload(c.ConversationID),
	}); err != nil {
		return err
	}
	if _, err := trnAppendTx(ctx, tx, c.OrganizationID, c.ProjectID, fromConv, worker.TurnEvent{
		Type:      events.TypeConversationMailAnswered,
		ActorKind: events.ActorKindWorker,
		ActorID:   c.WorkerID,
		Payload:   payload(fromConv),
	}); err != nil {
		return err
	}

	// The follow-up that hands the answer (or the failure) back to the
	// asking agent — only while the asking chat has nothing else to say.
	notice := worker.MailAnswerPrompt(repo, valueOr(answer, "(the agent said nothing)"))
	if state != events.MailStateAnswered {
		notice = "(Agent mail (ADR-0072): your mail to the repository \u201c" + repo +
			"\u201d did not get an answer: " + valueOr(reason, "the ask failed") + ")"
	}
	if len([]rune(notice)) > 65536 {
		notice = string([]rune(notice)[:65536])
	}
	// Stamped like every other turn row (ADR-0068 § 1): the asking chat's
	// current pointer, read in this same transaction.
	if _, err := tx.Exec(ctx, `
		INSERT INTO conversation_turns (conversation_id, prompt, submitted_by, agent_profile_id)
		SELECT $1::uuid, $2, $3::uuid, c.agent_profile_id
		FROM conversations c
		WHERE c.id = $1::uuid AND c.status <> 'archived'
		  AND NOT EXISTS (SELECT 1 FROM conversation_turns
		                  WHERE conversation_id = $1::uuid AND status IN ('queued', 'leased', 'running'))`,
		fromConv, notice, askedBy); err != nil && !isUniqueViolation(err) {
		return fmt.Errorf("postgres: mail follow-up prompt: %w", err)
	}
	return nil
}

// trnTurnAnswerText reads one turn's whole agent answer from the journal —
// the chunks the human watched, concatenated, capped. It is the answer
// because it is the record: no side channel, no re-parse of the live stream.
func trnTurnAnswerText(ctx context.Context, tx pgx.Tx, conversationID, turnID string) (string, error) {
	rows, err := tx.Query(ctx, `
		SELECT payload->>'text'
		FROM domain_events
		WHERE conversation_id = $1::uuid AND type = $2 AND payload->>'turn_id' = $3
		ORDER BY global_seq`, conversationID, events.TypeConversationMessageAgent, turnID)
	if err != nil {
		return "", fmt.Errorf("postgres: mail answer read: %w", err)
	}
	defer rows.Close()
	var b strings.Builder
	for rows.Next() {
		var chunk string
		if err := rows.Scan(&chunk); err != nil {
			return "", fmt.Errorf("postgres: scan mail answer chunk: %w", err)
		}
		if b.Len() < MailAnswerCap {
			b.WriteString(chunk)
		}
	}
	if err := rows.Err(); err != nil {
		return "", fmt.Errorf("postgres: mail answer scan: %w", err)
	}
	text := strings.TrimSpace(b.String())
	if len(text) > MailAnswerCap {
		text = string([]rune(text)[:MailAnswerCap]) + "\u2026"
	}
	if text == "" {
		text = "(the agent said nothing)"
	}
	return text, nil
}

func valueOr(p *string, fallback string) string {
	if p == nil {
		return fallback
	}
	return *p
}

// ------------------------------------------------- reconciler: expired mail

// expireStaleMail is the reconciler's mail arm: an `asked` link whose answer
// deadline passed becomes `expired` — journalled on both chats and noticed
// on the asking chat, all in one transaction per link. The target turn, if
// it is still alive somewhere, is left to its own honest terminal (lease
// expiry, cancel, or a late completion that now finds a settled link and
// writes nothing for it).
func (r *Reconciler) expireStaleMail(ctx context.Context, conn *pgx.Conn) (int, error) {
	type link struct {
		id, projectID, orgID, fromConv, toConv, askedBy, repo string
	}
	rows, err := conn.Query(ctx, `
		SELECT l.id::text, l.project_id::text, p.organization_id::text,
		       l.from_conversation_id::text, l.to_conversation_id::text,
		       l.asked_by::text, l.repo_name
		FROM conversation_links l
		JOIN projects p ON p.id = l.project_id
		WHERE l.state = 'asked' AND l.answer_deadline < now()
		ORDER BY l.answer_deadline, l.id
		LIMIT $1`, r.cfg.Batch)
	if err != nil {
		return 0, fmt.Errorf("postgres: scan expired mail: %w", err)
	}
	var found []link
	for rows.Next() {
		var l link
		if err := rows.Scan(&l.id, &l.projectID, &l.orgID, &l.fromConv, &l.toConv, &l.askedBy, &l.repo); err != nil {
			rows.Close()
			return 0, fmt.Errorf("postgres: read expired mail link: %w", err)
		}
		found = append(found, l)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return 0, fmt.Errorf("postgres: expired mail scan: %w", err)
	}

	done := 0
	for _, l := range found {
		if ctx.Err() != nil {
			return done, ctx.Err()
		}
		marked, err := r.withTx(ctx, conn, func(tx pgx.Tx) (bool, error) {
			tag, err := tx.Exec(ctx, `
				UPDATE conversation_links
				SET state = 'expired', reason = 'the answer deadline passed'
				WHERE id = $1::uuid AND state = 'asked'`, l.id)
			if err != nil {
				return false, fmt.Errorf("postgres: expire mail link: %w", err)
			}
			if tag.RowsAffected() == 0 {
				return false, nil // an answer won the race after the scan
			}
			payload := func(conversationID string) events.MailAnsweredPayload {
				return events.MailAnsweredPayload{
					ConversationID:     conversationID,
					LinkID:             l.id,
					FromConversationID: l.fromConv,
					ToConversationID:   l.toConv,
					Repo:               l.repo,
					State:              events.MailStateExpired,
					Reason:             "the answer deadline passed",
				}
			}
			for _, conversationID := range []string{l.fromConv, l.toConv} {
				if _, err := AppendEvent(ctx, tx, events.New{
					Type:           events.TypeConversationMailAnswered,
					OrganizationID: l.orgID,
					ProjectID:      l.projectID,
					ConversationID: conversationID,
					// A deadline, not a person, wrote this state.
					Actor:   events.Actor{Kind: events.ActorKindSystem, ID: "system"},
					Payload: payload(conversationID),
				}); err != nil {
					return false, err
				}
			}
			if _, err := tx.Exec(ctx, `
				INSERT INTO conversation_turns (conversation_id, prompt, submitted_by)
				SELECT $1::uuid, $2, $3::uuid
				WHERE EXISTS (SELECT 1 FROM conversations WHERE id = $1::uuid AND status <> 'archived')
				  AND NOT EXISTS (SELECT 1 FROM conversation_turns
				                  WHERE conversation_id = $1::uuid AND status IN ('queued', 'leased', 'running'))`,
				l.fromConv,
				"(Agent mail (ADR-0072): your mail to the repository \u201c"+l.repo+"\u201d timed out; no answer arrived.)",
				l.askedBy); err != nil && !isUniqueViolation(err) {
				return false, fmt.Errorf("postgres: expired mail notice: %w", err)
			}
			return true, nil
		})
		if err != nil {
			return done, err
		}
		if marked {
			done++
		}
	}
	return done, nil
}

// isUniqueViolation reports the 23505 that the one-active-turn partial index
// raises when a human prompt races a mail notice.
func isUniqueViolation(err error) bool {
	var pe *pgconn.PgError
	return errors.As(err, &pe) && pe.Code == "23505"
}

// ------------------------------------------- composer @-ask (ADR-0072 § 9)

// CnvMailAsk is an accepted composer @-ask: the link it created and the
// linked target chat it opened (APIConversationStore maps it onto the
// ConversationMailAsk schema).
type CnvMailAsk struct {
	LinkID           string
	ToConversationID string
	Repo             string
	Question         string
	State            string
}

// AskRepoMail is the person-initiated mail arm (ADR-0072 § 9): the
// conversation's controller asks the agent of another project repository a
// question straight from the composer (`@<repo> <question>`). Everything the
// worker's DispatchMail builds for an accepted ask is built here, for the
// same reasons — a fresh chat bound to the target repository, controller
// `none`, the asking chat's current profile, the answer turn stamped
// `permission_override = 'ask'` (read-only: edits need a person), the same
// per-chat cap and answer deadline, and `conversation.mail.asked` journalled
// on the asking chat. Two differences, both honest ones: the ask carries no
// `from_turn_id` and the event an empty `turn_id` — no agent turn asked, a
// person did (migration 00026 keeps exactly those columns NULL-able for
// this arm) — and the actor is the human, not the worker.
//
// The refusals are the § 6/§ 5 rules wearing their API faces: the setting
// off and a non-controller are 403 (ErrConversationForbidden — identity and
// feature denial, the ADR-0068 switch route's precedent), a repository the
// project does not have is 400 (ErrConversationBadRequest — the ask names a
// thing outside this project, the same answer an out-of-project profile
// gets), and the cap and the depth-1 rule are 422 (ErrConversationValidation).
// Authz rides the conversation path unchanged: visibility + a writer role or
// the read is 404/403 before anything else is looked at.
func (s *CnvStore) AskRepoMail(ctx context.Context, c Caller, conversationID, repoName, question string) (CnvMailAsk, error) {
	if err := prjRequireCaller(c); err != nil {
		return CnvMailAsk{}, err
	}
	repoName = strings.TrimSpace(repoName)
	question = strings.TrimSpace(question)
	if repoName == "" {
		return CnvMailAsk{}, fmt.Errorf("%w: mail_to is required", ErrConversationValidation)
	}
	if len([]rune(repoName)) > 200 || len([]rune(question)) > 4096 {
		// conversation_links' CHECKs (1..200 / 1..4096): too long is
		// unprocessable, not a silent truncation — a person's question is
		// not agent prose.
		return CnvMailAsk{}, fmt.Errorf("%w: mail_to (200) and question (4096) exceed their bounds", ErrConversationValidation)
	}
	if question == "" {
		return CnvMailAsk{}, fmt.Errorf("%w: a mail question is required", ErrConversationValidation)
	}

	var out CnvMailAsk
	err := s.inTx(ctx, func(tx pgx.Tx) error {
		chat, project, org, err := cnvWritableConversation(ctx, tx, c, conversationID)
		if err != nil {
			return err
		}
		if chat.Status == "archived" {
			return &CnvConflict{
				Kind:           ConflictArchived,
				Detail:         "The conversation is archived; it cannot ask another repository's agent.",
				ConversationID: chat.ID,
				Control:        &chat.Control,
			}
		}
		if chat.Control.Kind != events.ControllerKindHuman || chat.Control.UserID != c.UserID {
			// 403 like the ADR-0068 switch route: a caller that never held
			// the wheel is denied on identity, not on state (§ 9).
			who := "nobody"
			if chat.Control.UserID != "" {
				who = chat.Control.DisplayName
				if who == "" {
					who = chat.Control.UserID
				}
			} else if chat.Control.Kind == events.ControllerKindRunAttempt {
				who = "a run attempt"
			}
			return fmt.Errorf("%w: %s holds the controller lock; only the controller may ask another repository's agent", ErrConversationForbidden, who)
		}

		var enabled bool
		if err := tx.QueryRow(ctx, `SELECT agent_mail_enabled FROM projects WHERE id = $1::uuid`, project).Scan(&enabled); err != nil {
			return fmt.Errorf("postgres: mail composer setting: %w", err)
		}
		if !enabled {
			return fmt.Errorf("%w: agent mail is switched off for this project", ErrConversationForbidden)
		}

		// Depth 1 (§ 5), the same rule the claim predicate applies to an
		// agent: a conversation that is the TARGET of a link never asks — a
		// person who took over a mailed chat inherits it.
		var wasAsked bool
		if err := tx.QueryRow(ctx, `
			SELECT EXISTS (SELECT 1 FROM conversation_links WHERE to_conversation_id = $1::uuid)`,
			conversationID).Scan(&wasAsked); err != nil {
			return fmt.Errorf("postgres: mail composer depth read: %w", err)
		}
		if wasAsked {
			return fmt.Errorf("%w: this chat is answering another chat's mail; agent mail does not hop a second time", ErrConversationValidation)
		}

		var have int
		if err := tx.QueryRow(ctx, `
			SELECT count(*) FROM conversation_links WHERE from_conversation_id = $1::uuid`,
			conversationID).Scan(&have); err != nil {
			return fmt.Errorf("postgres: mail composer cap: %w", err)
		}
		if have >= DefaultMailCap {
			return fmt.Errorf("%w: this chat has already used its %d mails for the project", ErrConversationValidation, DefaultMailCap)
		}

		var repoID string
		err = tx.QueryRow(ctx, `
			SELECT id::text FROM repositories WHERE project_id = $1::uuid AND name = $2`,
			project, repoName).Scan(&repoID)
		if errors.Is(err, pgx.ErrNoRows) {
			return fmt.Errorf("%w: mail_to: no repository named %q in this project", ErrConversationBadRequest, repoName)
		}
		if err != nil {
			return fmt.Errorf("postgres: mail composer repo: %w", err)
		}

		if err := LockEventJournal(ctx, tx, project, org); err != nil {
			return err
		}

		// The target chat and its read-only answer turn, built exactly as
		// DispatchMail builds them (§ 2, § 4): born bound to the asked repo,
		// controller none, the asking chat's profile, permission_override
		// 'ask', the same answer deadline. Mail runs on behalf of the caller —
		// asked_by and the target turn's submitted_by name the person.
		var toConv string
		if err := tx.QueryRow(ctx, `
			INSERT INTO conversations (project_id, agent_profile_id, title, status, created_by, repository_id)
			VALUES ($1::uuid, $2::uuid, $3, 'idle', $4::uuid, $5::uuid)
			RETURNING id::text`,
			project, chat.AgentProfileID, mailTitle(chat.Title, repoName), c.UserID, repoID).
			Scan(&toConv); err != nil {
			return fmt.Errorf("postgres: mail composer conversation: %w", err)
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO conversation_control (conversation_id, controller_kind)
			VALUES ($1::uuid, 'none')`, toConv); err != nil {
			return fmt.Errorf("postgres: mail composer control: %w", err)
		}

		var linkID string
		if err := tx.QueryRow(ctx, `
			INSERT INTO conversation_links
			    (project_id, from_conversation_id, to_conversation_id,
			     asked_by, repo_name, question, state, answer_deadline)
			VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, 'asked',
			        now() + make_interval(secs => $7::double precision))
			RETURNING id::text`,
			project, conversationID, toConv, c.UserID,
			repoName, question, DefaultMailAnswerTimeout.Seconds()).
			Scan(&linkID); err != nil {
			return fmt.Errorf("postgres: mail composer link: %w", err)
		}

		prompt := worker.MailTargetPrompt(chat.Title, c.UserID, question)
		if _, err := tx.Exec(ctx, `
			INSERT INTO conversation_turns
			    (conversation_id, prompt, submitted_by, agent_profile_id, mail_link_id, permission_override)
			VALUES ($1::uuid, $2, $3::uuid, $4::uuid, $5::uuid, 'ask')`,
			toConv, prompt, c.UserID, chat.AgentProfileID, linkID); err != nil {
			return fmt.Errorf("postgres: mail composer answer turn: %w", err)
		}

		if _, err := AppendEvent(ctx, tx, events.New{
			Type:           events.TypeConversationMailAsked,
			OrganizationID: org,
			ProjectID:      project,
			ConversationID: conversationID,
			Actor:          events.Human(c.UserID),
			Payload: events.MailAskedPayload{
				ConversationID:   conversationID,
				TurnID:           "",
				LinkID:           linkID,
				ToConversationID: toConv,
				Repo:             repoName,
				Question:         question,
				State:            events.MailStateAsked,
			},
		}); err != nil {
			return err
		}

		out = CnvMailAsk{
			LinkID:           linkID,
			ToConversationID: toConv,
			Repo:             repoName,
			Question:         question,
			State:            events.MailStateAsked,
		}
		return nil
	})
	if err != nil {
		return CnvMailAsk{}, err
	}
	return out, nil
}

// ------------------------------------------------- conversation detail read

// CnvLinkedChat is one agent-mail link on a conversation's detail read
// (ADR-0072), either direction: `outgoing` = this chat asked, `incoming` =
// this chat was asked.
type CnvLinkedChat struct {
	ID          string
	Direction   string // outgoing | incoming
	RepoName    string
	State       string
	Question    string
	Answer      string
	Reason      string
	OtherConvID string
	OtherTitle  string
	OtherStatus string
	LauncherID  string
	CreatedAt   time.Time
	AnsweredAt  *time.Time
}

// cnvLinkedChats reads a conversation's mail links, newest first, bounded so
// one chat's fan-out cannot outrun the response (ADR-0063's bounded work).
func cnvLinkedChats(ctx context.Context, q prjQuerier, conversationID string) ([]CnvLinkedChat, error) {
	rows, err := q.Query(ctx, `
		SELECT l.id::text,
		       CASE WHEN l.from_conversation_id = $1::uuid THEN 'outgoing' ELSE 'incoming' END,
		       l.repo_name, l.state, l.question, COALESCE(l.answer, ''), COALESCE(l.reason, ''),
		       CASE WHEN l.from_conversation_id = $1::uuid THEN l.to_conversation_id::text
		            ELSE l.from_conversation_id::text END,
		       oc.title, oc.status, ap.launcher_id,
		       l.created_at, l.answered_at
		FROM conversation_links l
		JOIN conversations oc ON oc.id = CASE WHEN l.from_conversation_id = $1::uuid
		                                      THEN l.to_conversation_id ELSE l.from_conversation_id END
		JOIN conversations c ON c.id = CASE WHEN l.from_conversation_id = $1::uuid
		                                    THEN l.from_conversation_id ELSE l.to_conversation_id END
		JOIN agent_profiles ap ON ap.id = oc.agent_profile_id
		WHERE l.from_conversation_id = $1::uuid OR l.to_conversation_id = $1::uuid
		ORDER BY l.created_at DESC, l.id DESC
		LIMIT 50`, conversationID)
	if err != nil {
		return nil, fmt.Errorf("postgres: conversation linked chats: %w", err)
	}
	defer rows.Close()
	out := []CnvLinkedChat{}
	for rows.Next() {
		var lc CnvLinkedChat
		var answeredAt *time.Time
		if err := rows.Scan(&lc.ID, &lc.Direction, &lc.RepoName, &lc.State, &lc.Question,
			&lc.Answer, &lc.Reason, &lc.OtherConvID, &lc.OtherTitle, &lc.OtherStatus,
			&lc.LauncherID, &lc.CreatedAt, &answeredAt); err != nil {
			return nil, fmt.Errorf("postgres: scan conversation linked chat: %w", err)
		}
		lc.CreatedAt = lc.CreatedAt.UTC()
		if answeredAt != nil {
			utc := answeredAt.UTC()
			lc.AnsweredAt = &utc
		}
		out = append(out, lc)
	}
	return out, rows.Err()
}
