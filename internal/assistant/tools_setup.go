package assistant

// Assistant handoff §6 (CONTRACT §5): the setup reads. These are the lookups a
// person asks about while setting the app up — which credentials exist, how do
// I do X, what workflows are in the library, does this git URL actually
// resolve, what is open in the tracker, which agents and schedules does this
// project have.
//
// The rules are the ones every other assistant tool keeps:
//
//   - Each tool is exactly one ClassRead row of the closed table (trust.go);
//     a read authorizes nothing, so it runs as the caller through the
//     permission-checked service behind SetupReader, which sees the same rows
//     the user's own routes serve them.
//   - Honest degradation: an unwired SetupReader keeps its seven tools out of
//     the announced set, so the model is never told about a lookup this
//     deployment cannot serve. docs.search is the exception — its corpus is
//     compiled into the binary, so it answers wherever the runner runs.
//   - The payload is bounded like every other tool result (capPayload: 64
//     items, 2 KiB, marked when cut), and no payload here can carry a secret
//     value: internal/api's half of this seam is built over the metadata-only
//     secret view, which has no field a value could occupy (ADR-0018).

import (
	"context"
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"
	"unicode/utf8"
)

// SetupReader answers the handoff §6 setup reads as the caller. It is the
// internal/api seam (assistant_setup_tools.go): every method reads through the
// same caller-scoped store the matching route uses and returns that route's
// own JSON, so this package performs no authorization of its own and never
// sees a value, a token or a key.
//
// A nil SetupReader keeps all seven tools unannounced — the same
// honest-degradation rule as StatusReader, ChatTranscriptReader and the rest.
type SetupReader interface {
	// CredentialList answers credential.list: the git/GitHub credentials the
	// caller can see, as [{name, kind, scope, used_by}] — never values.
	CredentialList(ctx context.Context, c Caller) (json.RawMessage, error)
	// WorkflowList answers workflow.list: [{id, slug, name, latest_revision,
	// sample, assigned_to}] over the caller's pipeline library.
	WorkflowList(ctx context.Context, c Caller) (json.RawMessage, error)
	// WorkflowInspect answers workflow.inspect: the pipeline, its revisions
	// and the projects that pin it.
	WorkflowInspect(ctx context.Context, c Caller, pipelineID string) (json.RawMessage, error)
	// RepoCheck answers repo.check: the server's own call to GitHub for the
	// parsed repository, with the named credential resolved server-side.
	RepoCheck(ctx context.Context, c Caller, url, credential string) (json.RawMessage, error)
	// IssueList answers issue.list: the ADR-0031 listing of one repository's
	// tracker, read as the caller with that repository's own credential.
	IssueList(ctx context.Context, c Caller, projectID, repositoryID string) (json.RawMessage, error)
	// ProfileList answers profile.list: the agent profiles the caller can see.
	ProfileList(ctx context.Context, c Caller) (json.RawMessage, error)
	// ScheduleList answers schedule.list: one project's schedules.
	ScheduleList(ctx context.Context, c Caller, projectID string) (json.RawMessage, error)
}

// setupReadTools is the closed set this file owns. Every name here is a
// ClassRead row in trust.go, and every name except docs.search runs through
// SetupReader.
var setupReadTools = map[string]bool{
	"credential.list":  true,
	"docs.search":      true,
	"workflow.list":    true,
	"workflow.inspect": true,
	"repo.check":       true,
	"issue.list":       true,
	"profile.list":     true,
	"schedule.list":    true,
}

// isSetupRead reports whether one read call is answered here rather than by
// the v1 registry or one of the runner's other read executors.
func (r *ConversationRunner) isSetupRead(name string) bool { return setupReadTools[name] }

// registerSetupTools announces the §6 setup reads. It is the one extra
// registration pass registerTools makes.
func (r *ConversationRunner) registerSetupTools() {
	if r.b == nil {
		return
	}
	stringProp := func(desc string) map[string]any {
		return map[string]any{"type": "string", "description": desc, "maxLength": 200}
	}

	// docs.search needs no service: the corpus is embedded in this binary.
	r.regLocalTool(runnerTool{
		name: "docs.search",
		desc: "Search this app's own how-to set for a \"how do I …\" question (add a project or a repository, add a GitHub token, assign a workflow, start a run, approve a gate, schedules, agent profiles, the decision model, dictation). Returns the title, the doc path and a short excerpt — the answer to a how-to question, read as data. Read-only.",
		props: map[string]any{
			"query": stringProp("the question or the words in it, e.g. \"how do I add a repo\""),
		},
		require: []string{"query"},
	})

	if r.setup == nil {
		return // the honest-degradation rule: no reader, no announcement
	}
	r.regLocalTool(runnerTool{
		name:  "credential.list",
		desc:  "List the git/GitHub credentials the caller can see: name, kind, scope and which projects use each. Names only — a credential's value is never readable here, in a tool result or through any route (ADR-0018). Use it to answer \"which token is set up\"; to add one, point at the project's Secrets settings, never at this assistant. Read-only.",
		props: map[string]any{},
	})
	r.regLocalTool(runnerTool{
		name:  "workflow.list",
		desc:  "List the workflow (pipeline) library the caller can see: id, slug, name, latest revision, whether it is a shipped sample, and which projects it is assigned to. Read-only; use it before workflow.inspect.",
		props: map[string]any{},
	})
	r.regLocalTool(runnerTool{
		name: "workflow.inspect",
		desc: "Read one workflow: the pipeline row, its published revisions, and the projects (with the pinned revision each assignment holds) that use it. Read-only.",
		props: map[string]any{
			"pipeline_id": stringProp("the pipeline id from workflow.list"),
		},
		require: []string{"pipeline_id"},
	})
	r.regLocalTool(runnerTool{
		name: "repo.check",
		desc: "Check a git repository URL before it is added: the SERVER asks GitHub for owner/repo (accepts https, ssh, git@host:path, or a bare owner/repo) and answers {repo, reachable, default_branch, can_push, credential}. The credential is named here and resolved server-side; a token is never typed into this conversation, and an unreachable or private-without-credential repository answers reachable:false rather than erroring. Read-only.",
		props: map[string]any{
			"url":        stringProp("the repository URL, e.g. https://github.com/acme/app.git or acme/app"),
			"credential": stringProp("optional: the credential name from credential.list; empty uses the only visible GitHub credential"),
		},
		require: []string{"url"},
	})
	r.regLocalTool(runnerTool{
		name: "issue.list",
		desc: "List one repository's GitHub issues (the read-only ADR-0031 listing: number, title, state, labels, html_url) as the caller, using that repository's own credential. Read-only; the ids come from project.list and the project's repositories.",
		props: map[string]any{
			"project_id":    stringProp("the project id from project.list"),
			"repository_id": stringProp("the repository id within that project"),
		},
		require: []string{"project_id", "repository_id"},
	})
	r.regLocalTool(runnerTool{
		name:  "profile.list",
		desc:  "List the agent profiles the caller can see (id, name, launcher, permission mode, model, version) — the agents a workflow step can name. Read-only.",
		props: map[string]any{},
	})
	r.regLocalTool(runnerTool{
		name: "schedule.list",
		desc: "List a project's schedules: the cron triggers with their expression, whether they are enabled, and the next and last fire (times are UTC). Read-only; the project id comes from project.list.",
		props: map[string]any{
			"project_id": stringProp("the project id from project.list"),
		},
		require: []string{"project_id"},
	})
}

// execSetupRead runs one §6 read that the trust gate let through. The
// arguments are validated against the tool's own declared props (the same
// parseToolArgs the write tools use), the reader runs with the caller, and the
// payload goes through the shared cap — so an oversized library answers a
// marked sample rather than a wide prompt.
func (r *ConversationRunner) execSetupRead(ctx context.Context, c Caller, name string,
	call toolCallRequest) execOutcome {
	tl, ok := r.localTool(name)
	if !ok {
		return execOutcome{call: ToolCall{Name: name, OK: false, Reason: "unknown_tool"}}
	}
	args, err := parseToolArgs(tl, call.Function.Arguments)
	if err != nil {
		return execOutcome{call: ToolCall{Name: name, OK: false, Reason: "bad_arguments"}}
	}
	if name == "docs.search" {
		blob, serr := json.Marshal(searchHowTo(args["query"]))
		if serr != nil {
			return execOutcome{call: ToolCall{Name: name, Args: stringArgView(args), OK: false, Reason: "unavailable"}}
		}
		payload, _ := capPayload(blob)
		return execOutcome{
			call:    ToolCall{Name: name, Args: stringArgView(args), OK: true, Summary: setupSummary(name, args, payload)},
			payload: payload,
		}
	}
	if r.setup == nil {
		return execOutcome{call: ToolCall{Name: name, Args: stringArgView(args), OK: false, Reason: "unavailable"}}
	}
	var raw json.RawMessage
	switch name {
	case "credential.list":
		raw, err = r.setup.CredentialList(ctx, c)
	case "workflow.list":
		raw, err = r.setup.WorkflowList(ctx, c)
	case "workflow.inspect":
		raw, err = r.setup.WorkflowInspect(ctx, c, args["pipeline_id"])
	case "repo.check":
		raw, err = r.setup.RepoCheck(ctx, c, args["url"], args["credential"])
	case "issue.list":
		raw, err = r.setup.IssueList(ctx, c, args["project_id"], args["repository_id"])
	case "profile.list":
		raw, err = r.setup.ProfileList(ctx, c)
	case "schedule.list":
		raw, err = r.setup.ScheduleList(ctx, c, args["project_id"])
	default:
		return execOutcome{call: ToolCall{Name: name, Args: stringArgView(args), OK: false, Reason: "unknown_tool"}}
	}
	if err != nil {
		reason := "unavailable"
		switch {
		case errors.Is(err, ErrNotFound):
			reason = "not_found"
		case errors.Is(err, ErrForbidden):
			reason = "forbidden"
		}
		return execOutcome{call: ToolCall{Name: name, Args: stringArgView(args), OK: false, Reason: reason}}
	}
	payload, _ := capPayload(raw)
	out := execOutcome{
		call:    ToolCall{Name: name, Args: stringArgView(args), OK: true, Summary: setupSummary(name, args, payload)},
		payload: payload,
	}
	if link, ok := setupLink(r, name, args, payload); ok {
		out.link = &link
	}
	return out
}

// setupSummary is the transparency line of one §6 read: server-written, from
// the tool name, its validated arguments and the row count — never from row
// content, so a project name in a payload cannot ride into the audit surface.
func setupSummary(name string, args map[string]string, payload json.RawMessage) string {
	n := len(rows(payload))
	got := func(k string) string { return bounded(strings.TrimSpace(args[k]), 60) }
	var s string
	switch name {
	case "credential.list":
		s = fmt.Sprintf("Listed %d credentials", n)
	case "docs.search":
		s = fmt.Sprintf("Found %d how-to docs for %q", n, got("query"))
	case "workflow.list":
		s = fmt.Sprintf("Listed %d workflows", n)
	case "workflow.inspect":
		s = "Read workflow " + short(got("pipeline_id"))
	case "repo.check":
		s = "Checked repository " + got("url")
	case "issue.list":
		s = fmt.Sprintf("Listed %d issues for repository %s", n, short(got("repository_id")))
	case "profile.list":
		s = fmt.Sprintf("Listed %d agent profiles", n)
	case "schedule.list":
		s = fmt.Sprintf("Listed %d schedules for project %s", n, short(got("project_id")))
	default:
		s = fmt.Sprintf("Read %d results from %s", n, name)
	}
	return bounded(s, 200)
}

// setupLink turns a §6 read into the page it is about, through the same href
// allowlist every other link passes. It names at most one destination: a broad
// list earns one jump, not a wall of buttons.
func setupLink(r *ConversationRunner, name string, args map[string]string, payload json.RawMessage) (Link, bool) {
	if r.b == nil {
		return Link{}, false
	}
	var link Link
	switch name {
	case "credential.list":
		link = Link{Label: "Open Settings", Href: "/settings/layout"}
	case "profile.list":
		link = Link{Label: "Open Agents", Href: "/profiles"}
	case "workflow.list":
		link = Link{Label: "Open Workflows", Href: "/workflows"}
	case "workflow.inspect":
		if id := strings.TrimSpace(args["pipeline_id"]); id != "" {
			link = Link{Label: "Open workflow " + short(id), Href: "/workflows/" + id}
		}
	case "schedule.list":
		if pid := strings.TrimSpace(args["project_id"]); pid != "" {
			link = Link{Label: "Open project workflows", Href: "/p/" + pid + "/workflows"}
		}
	default:
		return Link{}, false
	}
	href, allowed := r.b.allowedHref(link.Href)
	if !allowed || link.Label == "" {
		return Link{}, false
	}
	link.Href = href
	return link, true
}

// --- docs.search: the curated how-to set --------------------------------

//go:embed howto/*.md
var howtoFS embed.FS

// howtoDoc is one curated page: its title (the first heading), the path the
// payload names, and the body the matcher and the excerpt are built from.
type howtoDoc struct {
	title    string
	path     string
	body     string
	haystack string
}

var (
	howtoOnce sync.Once
	howtoDocs []howtoDoc
	howtoStop = map[string]bool{}
)

// howtoMaxDocs bounds one search's answer; the corpus is small on purpose, so
// this is the cap that keeps the payload inside the tool's byte budget rather
// than a limit anyone can hit.
const (
	howtoMaxDocs    = 3
	howtoMaxExcerpt = 300
	// howtoMinTerm is the shortest query word that counts: below it, "a", "to"
	// and "do" would match half the corpus by accident.
	howtoMinTerm = 3
)

// loadHowto reads the embedded set once per process. A doc with no leading
// heading is titled by its file name, which is the honest reading of a corpus
// the build shipped rather than an authored page.
func loadHowto() []howtoDoc {
	howtoOnce.Do(func() {
		entries, err := howtoFS.ReadDir("howto")
		if err != nil {
			return
		}
		for _, e := range entries {
			if e.IsDir() || !strings.HasSuffix(e.Name(), ".md") {
				continue
			}
			raw, rerr := howtoFS.ReadFile("howto/" + e.Name())
			if rerr != nil {
				continue
			}
			title, body := splitHowto(string(raw))
			if title == "" {
				title = strings.TrimSuffix(e.Name(), ".md")
			}
			d := howtoDoc{
				title:    title,
				path:     "howto/" + e.Name(),
				body:     body,
				haystack: strings.ToLower(title + " " + body),
			}
			howtoDocs = append(howtoDocs, d)
		}
		sort.Slice(howtoDocs, func(i, j int) bool { return howtoDocs[i].title < howtoDocs[j].title })
		for _, w := range strings.Fields(howtoStopwords) {
			howtoStop[w] = true
		}
	})
	return howtoDocs
}

// splitHowto takes the first "# ..." line as the title and keeps the rest as
// the body.
func splitHowto(text string) (title, body string) {
	lines := strings.Split(text, "\n")
	for i, line := range lines {
		if t := strings.TrimSpace(strings.TrimPrefix(line, "#")); t != line && strings.HasPrefix(strings.TrimSpace(line), "#") {
			return t, strings.TrimSpace(strings.Join(lines[i+1:], "\n"))
		}
	}
	return "", strings.TrimSpace(text)
}

// howtoStopwords are the English function words a "how do I …" question is
// full of and a page title never answers.
const howtoStopwords = "a an and are as at be but by can do does for from had has have how i if in " +
	"is it its me my of on or our please thanks that the their them then there these this to us " +
	"was we were what when where which who will with would you your"

// searchHowTo scores the corpus by case-insensitive term overlap: a word of
// the question that appears in a page counts, twice when it is in the title.
// Terms of one or two letters and the function words above are dropped, so
// "how do I add a repo" asks about ADD and REPO — and REPO matches
// "repository", which is what the test for this tool's name actually proves.
func searchHowTo(query string) []map[string]any {
	docs := loadHowto()
	terms := howtoTerms(query)
	type scored struct {
		d howtoDoc
		s int
	}
	var hits []scored
	for _, d := range docs {
		score := 0
		for _, t := range terms {
			if strings.Contains(strings.ToLower(d.title), t) {
				score += 2
				continue
			}
			if strings.Contains(d.haystack, t) {
				score++
			}
		}
		if score > 0 {
			hits = append(hits, scored{d: d, s: score})
		}
	}
	// Stable by score, then title, so the same corpus answers the same way
	// every turn regardless of the order the embed dir happened to list.
	sort.SliceStable(hits, func(i, j int) bool {
		if hits[i].s != hits[j].s {
			return hits[i].s > hits[j].s
		}
		return hits[i].d.title < hits[j].d.title
	})
	out := make([]map[string]any, 0, howtoMaxDocs)
	for _, h := range hits {
		if len(out) >= howtoMaxDocs {
			break
		}
		out = append(out, map[string]any{
			"title":   bounded(h.d.title, 80),
			"path":    h.d.path,
			"excerpt": bounded(h.d.body, howtoMaxExcerpt),
		})
	}
	return out
}

// howtoTerms is the query reduced to the words that can carry meaning: lower-
// cased, alphanumeric-only, at least howtoMinTerm runes, and not a function
// word. A word that merely contains a stem ("repo" in "repository") stays
// whole — matching is substring, so the shorter form still reaches the longer.
func howtoTerms(query string) []string {
	lower := strings.ToLower(query)
	words := strings.FieldsFunc(lower, func(r rune) bool {
		return !(r >= 'a' && r <= 'z' || r >= '0' && r <= '9')
	})
	seen := map[string]bool{}
	out := make([]string, 0, len(words))
	for _, w := range words {
		if utf8.RuneCountInString(w) < howtoMinTerm || howtoStop[w] {
			continue
		}
		if seen[w] {
			continue
		}
		seen[w] = true
		out = append(out, w)
	}
	return out
}

// --- the registration helper -------------------------------------------

// regLocalTool appends one runner-owned tool to the announced set. It is the
// same body registerTools' own reg closure runs, factored out for the second
// registration pass; the closed table in trust.go stays the source of truth
// for which names may be registered at all.
func (r *ConversationRunner) regLocalTool(t runnerTool) {
	if _, known := ClassOf(t.name); !known {
		return
	}
	w := wireName(t.name)
	r.wireToReg[w] = t.name
	r.locals = append(r.locals, t)
	params := map[string]any{"type": "object", "properties": t.props, "additionalProperties": false}
	if len(t.require) > 0 {
		params["required"] = t.require
	}
	spec := toolSpec{Type: "function"}
	spec.Function.Name = w
	spec.Function.Description = t.desc
	spec.Function.Parameters = params
	r.toolSpecs = append(r.toolSpecs, spec)
}
