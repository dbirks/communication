package api

// The ref urls (ADR-0078 § Decision 6, the design's "Open the fix"): refs are
// the assistant's claims, so the only thing that may turn a number into a link
// is this layer, reading the repository remote the work's run was attached to.
// A remote that is not a github.com owner/repo answers no url at all — a link
// the server could not derive is one the reader would trust for nothing.

import (
	"strings"
	"testing"
)

func cuRefsFixture() CatchUpRefsView {
	return CatchUpRefsView{
		Issues:       []CatchUpNumberedRef{{Number: 215}, {Number: 216}},
		PullRequests: []CatchUpNumberedRef{{Number: 417}},
		Commits:      []CatchUpCommitRef{{SHA: "a1f9c2e0deadbeef"}},
		RunIDs:       []string{"01987a6c-4d5e-7f1a-9b2c-3d4e5f6a7b80"},
	}
}

func TestCatchUpRefURLsComeFromTheGitHubRemote(t *testing.T) {
	t.Parallel()
	for _, gitURL := range []string{
		"https://github.com/octo/widgets",
		"https://github.com/octo/widgets.git",
		"https://github.com/octo/widgets/",
		"ssh://git@github.com/octo/widgets.git",
		"git@github.com:octo/widgets.git",
	} {
		refs := cuRefsFixture().WithRepository(gitURL)
		wantIssue := "https://github.com/octo/widgets/issues/215"
		if got := refs.Issues[0].URL; got != wantIssue {
			t.Errorf("%s: issue url = %q, want %q", gitURL, got, wantIssue)
		}
		if got := refs.Issues[1].URL; got != "https://github.com/octo/widgets/issues/216" {
			t.Errorf("%s: second issue url = %q", gitURL, refs.Issues[1].URL)
		}
		if got := refs.PullRequests[0].URL; got != "https://github.com/octo/widgets/pull/417" {
			t.Errorf("%s: pull url = %q", gitURL, got)
		}
		if got := refs.Commits[0].URL; got != "https://github.com/octo/widgets/commit/a1f9c2e0deadbeef" {
			t.Errorf("%s: commit url = %q", gitURL, got)
		}
		if len(refs.RunIDs) != 1 || refs.RunIDs[0] == "" {
			t.Errorf("%s: run ids = %v, want the run ids preserved", gitURL, refs.RunIDs)
		}
	}
}

func TestCatchUpRefURLsAreAbsentOffGitHub(t *testing.T) {
	t.Parallel()
	for _, gitURL := range []string{
		"",                                      // no run, or a run with no repository
		"https://gitlab.example/o/r.git",        // another host is not GitHub
		"https://github.example.com/o/r.git",    // GitHub Enterprise is a different deployment
		"file:///srv/repos/widgets.git",         // a local remote has no web ui to link
		"https://github.com/octo/widgets/x.git", // not an owner/repo remote
		"https://evil.example/octo/widgets",     // never a link the model named
		"ssh://git@github.com/o/r/issues",
	} {
		refs := cuRefsFixture().WithRepository(gitURL)
		for _, ref := range refs.Issues {
			if ref.URL != "" {
				t.Errorf("%s: issue %d got url %q, want none", gitURL, ref.Number, ref.URL)
			}
		}
		for _, ref := range refs.PullRequests {
			if ref.URL != "" {
				t.Errorf("%s: pull %d got url %q, want none", gitURL, ref.Number, ref.URL)
			}
		}
		for _, ref := range refs.Commits {
			if ref.URL != "" {
				t.Errorf("%s: commit %s got url %q, want none", gitURL, ref.SHA, ref.URL)
			}
			if strings.Contains(ref.SHA, "evil") {
				t.Errorf("%s: commit sha rewritten: %q", gitURL, ref.SHA)
			}
		}
		// The numbers and SHAs themselves are untouched either way: refusing to
		// link is not the same as refusing to say what the work touched.
		if len(refs.Issues) != 2 || refs.Issues[0].Number != 215 {
			t.Errorf("%s: issues = %+v, want the two numbers preserved", gitURL, refs.Issues)
		}
	}
}

// The input refs must not be mutated: the same view can be rendered for two
// readers, and a shared slice quietly gaining urls on one request is a link
// appearing where the code never decided to add one.
func TestCatchUpRefURLsDoNotMutateTheInput(t *testing.T) {
	t.Parallel()
	in := cuRefsFixture()
	out := in.WithRepository("https://github.com/octo/widgets.git")
	if out.Issues[0].URL == "" {
		t.Fatal("the copy kept no url")
	}
	for _, ref := range in.Issues {
		if ref.URL != "" {
			t.Errorf("input issue %d gained url %q", ref.Number, ref.URL)
		}
	}
	for _, ref := range in.PullRequests {
		if ref.URL != "" {
			t.Errorf("input pull %d gained url %q", ref.Number, ref.URL)
		}
	}
	for _, ref := range in.Commits {
		if ref.URL != "" {
			t.Errorf("input commit %s gained url %q", ref.SHA, ref.URL)
		}
	}
}
