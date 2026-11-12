package assistant

import "testing"

func TestIsQuestionMessage(t *testing.T) {
	yes := []string{
		"do you have access to any github tokens?",
		"Are the runs green",
		"what pipelines exist",
		"how do I retry a run",
		"any updates",
		"have you seen the draft",
		"can you open settings",
		"Is it broken？？",
		`"what changed?"`,
	}
	no := []string{
		"open the secrets page",
		"go to settings",
		"run the pipeline",
		"please change the draft",
		"",
		"   ",
		"dozens of runs finished", // "dozens" is not "do"
		"harvest the reports",     // "harvest" is not "has"
	}
	for _, s := range yes {
		if !isQuestionMessage(s) {
			t.Errorf("isQuestionMessage(%q) = false, want true", s)
		}
	}
	for _, s := range no {
		if isQuestionMessage(s) {
			t.Errorf("isQuestionMessage(%q) = true, want false", s)
		}
	}
}

func TestNavigationAckOnly(t *testing.T) {
	ack := []string{
		"I've opened the Secrets page.",
		"Opened it.",
		"I opened the settings page for you.",
		"Taking you to the runs page now.",
		"Go to the settings page.",
		"The page is open.",
		"Done.",
		"I navigated to the runs page", // no terminator: one fragment
		"I've opened the Secrets page. Taking you there.",
	}
	notAck := []string{
		"Yes, I have access to two: github-deploy and staging.",
		"I have access to the project list reads.",
		"The tokens are listed there.",
		"Yes.",
		"Two credentials: alpha and beta. Opened the page.",
		"I've opened the Secrets page. It shows 3 tokens.", // digits + non-ack sentence
		"- Opened the page\n- alpha token",                 // bullet list
		"",
	}
	for _, s := range ack {
		if !navigationAckOnly(s) {
			t.Errorf("navigationAckOnly(%q) = false, want true", s)
		}
	}
	for _, s := range notAck {
		if navigationAckOnly(s) {
			t.Errorf("navigationAckOnly(%q) = true, want false", s)
		}
	}
}

func TestReaskReason(t *testing.T) {
	cases := []struct {
		name    string
		text    string
		nav     bool
		message string
		want    string
	}{
		{"empty ships nothing", "   \n ", false, "what runs exist", reaskEmpty},
		{"empty with navigation", "", true, "do you have tokens?", reaskEmpty},
		{"navigate-only answer to a question", "I've opened the Secrets page.",
			true, "do you have access to any github tokens?", reaskNavigateOnly},
		{"navigation request is not a question", "Opened it.", false, "open the secrets page", ""},
		{"ack without navigation", "The page is open.", false, "do you have tokens?", ""},
		{"real answer never re-asks", "Yes, I have access to two: alpha and beta.",
			true, "do you have access to any github tokens?", ""},
		{"a statement that navigated", "Here is what changed. I opened the page.",
			true, "the pipeline changed", ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := reaskReason(c.text, c.nav, c.message); got != c.want {
				t.Fatalf("reaskReason(%q, %v, %q) = %q, want %q", c.text, c.nav, c.message, got, c.want)
			}
		})
	}
}

func TestTurnNavigated(t *testing.T) {
	if turnNavigated([]ToolCall{{Name: "ui.navigate", OK: false, Reason: "route_not_allowed"},
		{Name: "project.list", OK: true}}) {
		t.Fatal("a refused navigation must not count as navigated")
	}
	if !turnNavigated([]ToolCall{{Name: "project.list", OK: true}, {Name: "ui.navigate", OK: true}}) {
		t.Fatal("a ran ui.navigate must count as navigated")
	}
	if turnNavigated(nil) {
		t.Fatal("no calls is not navigated")
	}
}
