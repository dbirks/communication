package assistant

// The handoff §6 setup tools (CONTRACT §5), proved on this side of the seam:
// they are ClassRisky rows, so ask_all and ask_risky stop them into an
// approval card BEFORE anything runs and no_ask still runs-and-logs; they are
// announced only over a wired executor (the honest-degradation rule); their
// card copy is server-written; and the card's args carry exactly the proposal
// rows the UI renders — name, repo_url, credential, default_branch.

import (
	"context"
	"strings"
	"testing"
)

var setupActionTools = []string{"project.create", "repo.add", "assignment.set", "run.cancel", "schedule.create"}

// stubActions wires every §6 name with an executor that records the call.
func stubActions(calls *int) map[string]ActionExecutor {
	out := map[string]ActionExecutor{}
	for _, name := range setupActionTools {
		out[name] = func(_ context.Context, _ Caller, tool string, args map[string]string) (string, *ChangeRecord, error) {
			*calls++
			return "Did " + tool, &ChangeRecord{Kind: "project_create", TargetRef: "project:p-1",
				Summary: "Did " + tool + " " + args["name"]}, nil
		}
	}
	return out
}

func TestSetupActionToolsAreRiskyRows(t *testing.T) {
	for _, name := range setupActionTools {
		class, known := ClassOf(name)
		if !known || class != ClassRisky {
			t.Errorf("%s: class = %v/%v, want ClassRisky in the closed table", name, class, known)
		}
		for _, tc := range []struct {
			level TrustLevel
			gates bool
		}{
			{TrustAskAll, true}, {TrustAskRisky, true}, {TrustNoAsk, false},
		} {
			if got := tc.level.Gates(class); got != tc.gates {
				t.Errorf("%s under %s: gates = %v, want %v", name, tc.level, got, tc.gates)
			}
		}
		if rt := riskText(name); rt == riskText("some.unknown.tool") || rt == "" {
			t.Errorf("%s has no risk line of its own: %q", name, rt)
		}
	}
}

func TestSetupActionCardCopy(t *testing.T) {
	// project.create reads as the proposal, not as an id dump — and the
	// repository half is `owner/repo`, never a URL with a path in it.
	got := actionSummary("project.create", map[string]string{
		"name": "home-lab", "repo_url": "https://github.com/acme/app.git", "credential": "GITHUB_TOKEN",
	}, nil)
	if got != "Create project home-lab with acme/app" {
		t.Errorf("project.create summary = %q", got)
	}
	if got := actionSummary("project.create", map[string]string{"name": "home-lab"}, nil); got != "Create project home-lab" {
		t.Errorf("project.create without a repository summary = %q", got)
	}
	// assignment.set names the revision it will pin (the promotion preview).
	withRev := actionSummary("assignment.set", map[string]string{
		"project_id": "p-1", "pipeline_id": "pl-1", "revision": "v2 (r7)",
	}, nil)
	if !strings.Contains(withRev, "pins v2 (r7)") {
		t.Errorf("assignment.set with a revision read = %q; want the pinned revision named", withRev)
	}
	if plain := actionSummary("assignment.set", map[string]string{"project_id": "p-1", "pipeline_id": "pl-1"}, nil); !strings.Contains(plain, "latest published") {
		t.Errorf("assignment.set without one = %q; want the honest latest-published line", plain)
	}
	for _, tc := range []struct{ tool, want string }{
		{"repo.add", "Add repository"},
		{"run.cancel", "Cancel run"},
		{"schedule.create", "Create schedule"},
	} {
		s := actionSummary(tc.tool, map[string]string{"project_id": "p-1"}, nil)
		if !strings.HasPrefix(s, tc.want) {
			t.Errorf("%s summary = %q; want it to open with %q", tc.tool, s, tc.want)
		}
	}
}

func TestShortRepoNamesOnlyGitHubRemotes(t *testing.T) {
	for _, tc := range []struct{ in, want string }{
		{"https://github.com/acme/app.git", "acme/app"},
		{"https://github.com/acme/app/", "acme/app"},
		{"git@github.com:acme/app.git", "acme/app"},
		{"ssh://git@github.com/acme/app", "acme/app"},
		{"acme/app", "acme/app"},
		{"https://gitlab.com/acme/app", ""}, // a host this app does not speak to
		{"file:///srv/repos/app", ""},       // never a path into the worker
		{"https://github.com/acme/app/issues", ""},
		{"", ""},
	} {
		if got := shortRepo(tc.in); got != tc.want {
			t.Errorf("shortRepo(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

// announcedNames is the wire set a runner tells the model about.
func announcedNames(r *ConversationRunner) []string {
	out := make([]string, 0, len(r.toolSpecs))
	for _, spec := range r.toolSpecs {
		out = append(out, spec.Function.Name)
	}
	return out
}

func wireHas(names []string, want string) bool {
	for _, n := range names {
		if n == wireName(want) {
			return true
		}
	}
	return false
}

func TestSetupActionToolsAnnouncedOnlyWhenWired(t *testing.T) {
	calls := 0
	model := newFakeModel(t, step{text: "ok"})
	r := NewConversationRunner(ConversationRunnerDeps{
		Broker: newTestBroker(t, model, newFakeStore()), Actions: stubActions(&calls),
	})
	names := announcedNames(r)
	for _, name := range setupActionTools {
		if !wireHas(names, name) {
			t.Errorf("%s was never announced over a wired executor", name)
		}
	}
	// The same runner with no executors must not mention them: an unwired
	// deployment never tells the model about a write it cannot perform.
	model2 := newFakeModel(t, step{text: "ok"})
	bare := NewConversationRunner(ConversationRunnerDeps{Broker: newTestBroker(t, model2, newFakeStore())})
	bareNames := announcedNames(bare)
	for _, name := range setupActionTools {
		if wireHas(bareNames, name) {
			t.Errorf("%s was announced without an executor", name)
		}
	}
}

// The gated path the handoff's proposal card is built on: under ask_risky
// with no judge, project.create stops at an approval whose args carry the
// proposal rows.
func TestSetupProjectCreateGatesWithTheProposalArgs(t *testing.T) {
	calls := 0
	model := newFakeModel(t,
		step{toolCalls: []toolCallRequest{toolCall("project.create", map[string]any{
			"name": "home-lab", "repo_url": "https://github.com/acme/app.git",
			"credential": "GITHUB_TOKEN", "default_branch": "trunk",
		})}},
		step{text: "One card is waiting for you."},
	)
	r := NewConversationRunner(ConversationRunnerDeps{
		Broker: newTestBroker(t, model, newFakeStore()), Actions: stubActions(&calls),
	})
	res := runOne(t, r, TrustAskRisky)
	if calls != 0 {
		t.Fatalf("a gated setup write executed %d times", calls)
	}
	ap := res.Approval
	if ap == nil || ap.Tool != "project.create" {
		t.Fatalf("approval = %+v, want the project.create card", ap)
	}
	for k, want := range map[string]string{
		"name": "home-lab", "repo_url": "https://github.com/acme/app.git",
		"credential": "GITHUB_TOKEN", "default_branch": "trunk",
	} {
		if ap.Args[k] != want {
			t.Errorf("approval arg %s = %q, want %q (the card renders its rows from these)", k, ap.Args[k], want)
		}
	}
	if ap.Summary != "Create project home-lab with acme/app" {
		t.Errorf("card summary = %q", ap.Summary)
	}
	if !strings.Contains(ap.Risk, "project") {
		t.Errorf("card risk = %q", ap.Risk)
	}
	if ap.Reason != GateReasonFixedTable {
		t.Errorf("card reason = %q, want the fixed-table line", ap.Reason)
	}
	// The confirm path re-runs EXACTLY the card's args, once.
	ack, change, err := r.ExecuteAction(context.Background(), testCaller, ap.Tool, ap.Args)
	if err != nil {
		t.Fatalf("confirm: %v", err)
	}
	if calls != 1 {
		t.Fatalf("the confirmed action ran %d times", calls)
	}
	if !strings.Contains(ack, "project.create") || change == nil {
		t.Fatalf("confirm ack/change = %q %+v", ack, change)
	}
}

// no_ask runs the write and still logs it (decision 4: every action lands in
// the change log).
func TestSetupActionRunsAndLogsUnderNoAsk(t *testing.T) {
	calls := 0
	model := newFakeModel(t,
		step{toolCalls: []toolCallRequest{toolCall("run.cancel", map[string]any{"run_id": "r-1"})}},
		step{text: "Canceled."},
	)
	r := NewConversationRunner(ConversationRunnerDeps{
		Broker: newTestBroker(t, model, newFakeStore()), Actions: stubActions(&calls),
	})
	res := runOne(t, r, TrustNoAsk)
	if calls != 1 || res.Approval != nil {
		t.Fatalf("no_ask: calls=%d approval=%+v", calls, res.Approval)
	}
	if len(res.Changes) != 1 || res.Changes[0].Kind != "project_create" {
		t.Fatalf("changes = %+v, want the logged row", res.Changes)
	}
	if res.Changes[0].UndoPayload != nil {
		t.Error("a setup write has no closed inverse: the row must not claim one")
	}
}
