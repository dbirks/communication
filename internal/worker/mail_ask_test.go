package worker_test

// ADR-0072 § 12 at the level the worker actually decides. A mailed turn on a
// launcher with no verified prompting mode (pi — ADR-0069) used to fail closed
// with "permission mode ask needs a prompting mode for launcher pi; none is
// verified", which is what every Actions 3d run hit (ADR-0072 § 10). Now the
// read-only is a mount, so the launch runs — under the never-asks default,
// which is the honest mode for a turn whose boundary is the sandbox — and the
// journal carries the evidence: `workspace_repo` at access `ro`.
//
// The control legs matter as much as the positive one: an ordinary `ask` turn
// on the same launcher is still refused (§ 12 unlocks nothing for a mode that
// makes a review claim), a prompting launcher keeps `ask` *on top of* the
// mount, and a store that cannot answer § 12 keeps today's refusal rather than
// guessing wide.

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/dbirks/communication/internal/agent/acp"
	"github.com/dbirks/communication/internal/domain"
	"github.com/dbirks/communication/internal/events"
	"github.com/dbirks/communication/internal/worker"
	wsgit "github.com/dbirks/communication/internal/workspace/git"
)

// mailSandboxStore is the loop's store for these tests: the shared fake, plus
// the ADR-0072 § 12 read with a fixed answer (or a fixed failure of it).
type mailSandboxStore struct {
	*fakeStore
	access worker.MailRepoAccess
	err    error
}

func (s *mailSandboxStore) MailRepoAccess(context.Context, worker.Claim) (worker.MailRepoAccess, error) {
	if s.err != nil {
		return worker.MailRepoAccess{}, s.err
	}
	return s.access, nil
}

// launcherCredentialDirs mirrors cmd/communication/worker.go's wiring: a
// launcher's credential directories are the directories its auth env vars name,
// MINUS the key/token env vars (a provider key is a value, not a tree). The
// shared fixture resolves every declared name to a directory, which is right
// for claude/codex and wrong for pi — whose only auth env var is
// OPENAI_API_KEY, the key itself (ADR-0069's channel).
func launcherCredentialDirs(launcherID string) ([]string, error) {
	launcher, ok := acp.LookupLauncher(launcherID)
	if !ok {
		return nil, fmt.Errorf("unknown launcher %q", launcherID)
	}
	var out []string
	for _, kv := range acp.AuthEnvFromOS(launcher) {
		_, value, _ := strings.Cut(kv, "=")
		out = append(out, value)
	}
	return out, nil
}

// runMailedTurn wires the fixture's required-enforcement unit service to a
// loop running one `ask` claim, and hands back the terminal outcome, the launch
// request (if any) and the sandbox.verified row the loop journalled.
// `access` nil means the store does not speak § 12's port at all.
func runMailedTurn(t *testing.T, access *worker.MailRepoAccess, accessErr error, launcherID string, answerChunks ...string) (worker.TurnOutcome, domain.SessionRequest, events.SandboxVerifiedPayload, int, []worker.TurnEvent) {
	t.Helper()
	fx := newUnitFixture(t)
	fx.svc.LauncherAuth = launcherCredentialDirs

	var inner *fakeStore = newFakeStore()
	var st worker.TurnStore = inner
	var opts []worker.TurnOption
	if accessErr != nil {
		// The read is wired but broken: the § 12 arm must fail the turn rather
		// than guess a mount, so this shape is wired through the override option
		// (which is what WithMailSandbox exists for).
		opts = append(opts, worker.WithMailSandbox(&mailSandboxStore{err: accessErr}))
	} else if access != nil {
		st = &mailSandboxStore{fakeStore: inner, access: *access}
	}
	c := testClaim2(t, "ask")
	c.LauncherID = launcherID
	// The unit path derives a workspace from the conversation id, and the
	// workspace layout names a canonical uuid: the fixture's own request is the
	// conversation its manager prepares.
	c.ConversationID = fx.request().ConversationID
	c.ProjectID = fx.request().ProjectID
	c.OrganizationID = fx.request().OrganizationID
	inner.claims = []worker.Claim{c}
	inner.repos = []worker.Repo{{ID: uuidFor("repo"), Name: "backend", GitURL: fx.seedRepo(), DefaultBranch: "main"}}

	sess := newFakeSession(domain.SessionInfo{})
	sess.promptFn = func(_ context.Context, s *fakeSession) (domain.StopReason, error) {
		for _, chunk := range answerChunks {
			s.send(domain.ConversationEvent{Kind: "message_chunk", Text: chunk})
		}
		return domain.StopEndTurn, nil
	}
	ff := &fakeFactory{sessions: []*fakeSession{sess}}
	l, err := worker.NewTurnLoop(fastCfg(), st, ff, &fakeWork{dir: t.TempDir()},
		func() string { return "worker-1" }, append([]worker.TurnOption{worker.WithUnits(fx.svc)}, opts...)...)
	if err != nil {
		t.Fatalf("NewTurnLoop: %v", err)
	}
	startLoop(t, l)
	out := recv(t, inner.finishing, "the turn's terminal outcome")
	count := ff.count()
	req := domain.SessionRequest{}
	if count > 0 {
		req = ff.request(0)
	}
	var verified events.SandboxVerifiedPayload
	for _, ev := range inner.snapshotAppends() {
		if p, ok := ev.Payload.(events.SandboxVerifiedPayload); ok {
			verified = p
		}
	}
	return out, req, verified, count, inner.snapshotAppends()
}

func hasGrantAt(p events.SandboxVerifiedPayload, role, access string) bool {
	for _, g := range p.Grants {
		if g.Role == role && g.Access == access {
			return true
		}
	}
	return false
}

func TestMailedTurnRunsOnANeverAsksLauncherUnderTheReadOnlyMount(t *testing.T) {
	asked := worker.MailRepoAccess{Asked: true}
	out, req, verified, count, appended := runMailedTurn(t, &asked, nil, "pi")
	if out.Status == events.TurnStatusFailed && strings.Contains(out.Message, "prompting mode") {
		t.Fatalf("the asked turn was refused for want of a prompt (%v): § 12 enforces read-only with the mount instead", out.Message)
	}
	if out.Status != events.TurnStatusCompleted {
		t.Fatalf("outcome = %+v, want completed", out)
	}
	if count != 1 {
		t.Fatalf("launched %d sessions, want 1", count)
	}
	if req.ModeID != "" {
		t.Errorf("ModeID = %q, want empty: the never-asks default IS what this launch runs (ADR-0069); the § 12 arm invents no prompting mode", req.ModeID)
	}
	// The row an operator quotes: sandbox.verified is written from the plan the
	// launch carried, so the grant the kernel was asked for is the evidence a
	// reviewer checks — and an approved turn would say rw here instead.
	if !hasGrantAt(verified, wsgit.RoleCheckout, wsgit.AccessReadOnly) {
		t.Errorf("sandbox.verified grants = %+v, want %s access %s (verified=%v)",
			verified.Grants, wsgit.RoleCheckout, wsgit.AccessReadOnly, verified.Verified)
	}
	if verified.CommitGranted {
		t.Error("sandbox.verified claims the commit axis on a read-only launch")
	}
	// The transcript says what the launch is, because the stamped `ask` no
	// longer does: no prompt will ever arrive on this launcher. The line is a
	// system notice, not agent text (ADR-0072 § 12).
	if n := noticeCount(appended, "mounted read-only"); n == 0 {
		t.Error("no transcript notice said the repository is mounted read-only: a reader of the chat would see a never-asks launch and no explanation of it")
	} else if noticeCount(appended, "runs without asking") == 0 {
		t.Error("the notice did not say the turn runs without asking (ADR-0069's wording, ADR-0072 § 12's reason)")
	}
}

// noticeCount counts journalled conversation.notice rows containing text: the
// sink writes a worker-authored system line (a workspace note, the § 12
// read-only explanation) as one of these, never as an agent message chunk.
func noticeCount(appended []worker.TurnEvent, text string) int {
	n := 0
	for _, ev := range appended {
		if p, ok := ev.Payload.(events.NoticePayload); ok && strings.Contains(p.Text, text) {
			n++
		}
	}
	return n
}

// TestPromptingLauncherKeepsAskOnTopOfTheReadOnlyMount is the two-layer case:
// a launcher with a verified prompting mode still runs `ask`, and the mount is
// still what makes the read-only true.
func TestPromptingLauncherKeepsAskOnTopOfTheReadOnlyMount(t *testing.T) {
	asked := worker.MailRepoAccess{Asked: true}
	out, req, verified, count, appended := runMailedTurn(t, &asked, nil, "claude")
	if out.Status != events.TurnStatusCompleted || count != 1 {
		t.Fatalf("outcome = %+v launched=%d, want completed/1", out, count)
	}
	if req.ModeID != "default" {
		t.Errorf("ModeID = %q, want the launcher's verified prompting mode: § 12 adds a layer, it does not remove the prompt", req.ModeID)
	}
	if !hasGrantAt(verified, wsgit.RoleCheckout, wsgit.AccessReadOnly) {
		t.Errorf("the prompting arm lost the read-only mount (grants %+v): there must be two layers", verified.Grants)
	}
	// And no "it runs without asking" note: on this launcher the prompt really
	// is coming, so the stamped mode is the mode it runs.
	if n := noticeCount(appended, "runs without asking"); n != 0 {
		t.Errorf("the prompting arm wrote %d never-asks notices into the transcript", n)
	}
}

// TestOrdinaryAskTurnStillRefusesANeverAsksLauncher is the control the brief
// insists on: nothing here unlocks `ask` on pi for a chat nobody mailed. The
// § 12 arm applies to the asked side and to no other turn.
func TestOrdinaryAskTurnStillRefusesANeverAsksLauncher(t *testing.T) {
	out, _, _, count, _ := runMailedTurn(t, &worker.MailRepoAccess{}, nil, "pi")
	if out.Status != events.TurnStatusFailed || !strings.Contains(out.Message, "prompting mode for launcher pi") {
		t.Errorf("outcome = %+v, want the unchanged ADR-0069 refusal", out)
	}
	if count != 0 {
		t.Errorf("launched %d sessions on the refusing arm, want 0", count)
	}
}

// TestApprovedMailedTurnStaysFailClosedOnANeverAsksLauncher names the honest
// cost of the design: a person's approval lifts the MOUNT, and on a launcher
// with no prompting mode an `ask` turn that is no longer read-only has nothing
// left to enforce its recorded mode — so it refuses rather than running
// never-asks under a review claim it can no longer back. Lifting a mailed
// chat's stamped mode to an autonomous launch is ADR-0069's business, not § 12's.
func TestApprovedMailedTurnStaysFailClosedOnANeverAsksLauncher(t *testing.T) {
	out, _, _, count, _ := runMailedTurn(t, &worker.MailRepoAccess{Asked: true, EditsApproved: true}, nil, "pi")
	if out.Status != events.TurnStatusFailed || !strings.Contains(out.Message, "prompting mode") {
		t.Errorf("outcome = %+v, want the fail-closed refusal (approval widens the mount, it does not unlock the mode)", out)
	}
	if count != 0 {
		t.Errorf("launched %d sessions on the approved-but-unpromptable arm, want 0", count)
	}
}

// TestMailedTurnWithoutTheSandboxPortKeepsTodayRefusal pins the optional-port
// degradation: a store that cannot answer § 12 mounts nothing read-only, and
// the turn fails closed exactly as it did before the § 12 arm existed. A
// missing read may cost a turn; it cannot widen a sandbox.
func TestMailedTurnWithoutTheSandboxPortKeepsTodayRefusal(t *testing.T) {
	out, _, _, count, _ := runMailedTurn(t, nil, nil, "pi")
	if out.Status != events.TurnStatusFailed || !strings.Contains(out.Message, "prompting mode") {
		t.Errorf("outcome = %+v, want the pre-§ 12 refusal", out)
	}
	if count != 0 {
		t.Errorf("launched %d sessions without the port, want 0", count)
	}
}

// TestMailedTurnWhereTheReadOnlyReadFails is the same rule wearing its other
// face: an unknown asked-side state is not treated as "not asked". The turn
// fails naming the read that failed, and nothing is launched.
func TestMailedTurnWhereTheReadOnlyReadFails(t *testing.T) {
	out, _, _, count, _ := runMailedTurn(t, nil, errors.New("the asked-side read failed"), "pi")
	if out.Status != events.TurnStatusFailed || !strings.Contains(out.Message, "agent-mail state of turn") {
		t.Errorf("outcome = %+v, want the failed § 12 read named (and never a read-write guess)", out)
	}
	if count != 0 {
		t.Errorf("launched %d sessions with an unknown read-only state, want 0", count)
	}
}
