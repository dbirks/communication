package assistant

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"
)

// ErrNotFound is what the adapter in internal/api/assistant.go maps the 404
// rule of internal/api/conversations.go onto: "you may not know this exists".
// A refused tool result carries no rows and no name, so the model has nothing
// with which to name a project the caller cannot see.
var ErrNotFound = errors.New("assistant: not found")

// ErrForbidden is a caller who can see the resource but may not do this: a 403
// on the route, and here likewise a result with no rows.
var ErrForbidden = errors.New("assistant: forbidden")

// tool is one entry of the closed registry. There is no write entry and no
// entry that reaches the store without the caller, and the registry is built at
// process start: a client cannot add a tool, and a tool name outside this map
// is refused with zero store calls.
type tool struct {
	name    string
	desc    string
	props   map[string]any
	require []string
	// links turns the rows this tool read into app routes. It sees only rows
	// the caller was authorized to read, which is why a model never gets to
	// invent an href.
	links func(t *turn, args map[string]any, rows []map[string]any) []Link
	// linksRaw is the link hook of a tool whose payload is ONE object rather
	// than a row array — catchup.brief, whose sections hold the rows and whose
	// `link` fields already name app routes. `rows` sees no rows inside an
	// object, so the tool that owns the payload shape reads its own sections.
	// Like links it is only ever handed bytes this caller was authorized to
	// read, and every href still passes the allowlist in exec.
	linksRaw func(t *turn, args map[string]any, raw json.RawMessage) []Link
	// validate bounds an argument beyond the shape parseArgs checks: a closed
	// vocabulary (a window key, a run status) whose wrong value is a refusal
	// (`bad_arguments`, zero store calls) rather than a store round trip.
	validate func(args map[string]any) error
	// read performs the store call.
	read func(t *turn, args map[string]any) (json.RawMessage, error)
	// maxResultBytes bounds this tool's payload to the model. Zero is the
	// registry's MaxResultBytes; the two ADR-0081 chat reads name a larger
	// bound and say why at the constant itself (maxCatchUpChatResultBytes).
	maxResultBytes int
}

// toolOrder is the order tools are announced to the model (stable, so the
// request body is reproducible).
var toolOrder = []string{"project.list", "run.list", "run.nodes", "approval.pending", "pipeline.revisions", "palette.search"}

// optionalToolOrder names, in announcement order, the registry tools that join
// toolOrder only when this deployment's store can answer them. The rule is the
// one the runner's §6 setup reads follow: a read this server cannot serve is
// never announced, so the model is not told to ask for it. Every name here is
// in toolRegistry AND in the closed class table (trust.go) — tools_test.go
// pins all three against each other.
var optionalToolOrder = []string{"catchup.brief"}

// announcedToolOrder is the registry order for ONE broker: the six v1 reads,
// then any optional read this store answers.
func announcedToolOrder(store Store) []string {
	order := append([]string(nil), toolOrder...)
	brief, _ := store.(CatchUpBriefReader)
	for _, name := range optionalToolOrder {
		if name == "catchup.brief" && brief == nil {
			continue // no brief reader wired: the tool is not announced
		}
		order = append(order, name)
	}
	return order
}

// resultCap is one tool's payload budget: the registry's MaxResultBytes unless
// the tool named a larger one at its own definition.
func (tl tool) resultCap() int {
	if tl.maxResultBytes > 0 {
		return tl.maxResultBytes
	}
	return MaxResultBytes
}

var toolRegistry = func() map[string]tool {
	stringArg := func(description string) map[string]any {
		return map[string]any{"type": "string", "description": description, "maxLength": 200}
	}
	reg := map[string]tool{}
	add := func(name, desc string, props map[string]any, require []string,
		read func(t *turn, args map[string]any) (json.RawMessage, error),
		links func(t *turn, args map[string]any, rows []map[string]any) []Link,
	) {
		reg[name] = tool{name: name, desc: desc, props: props, require: require, read: read, links: links}
	}
	// addEx is add plus the two optional hooks a widened read needs: an
	// argument vocabulary, and the larger payload bound of a tool whose rows
	// arrive as one assembled object (linksRaw).
	addEx := func(name, desc string, props map[string]any, require []string,
		read func(t *turn, args map[string]any) (json.RawMessage, error),
		links func(t *turn, args map[string]any, rows []map[string]any) []Link,
		linksRaw func(t *turn, args map[string]any, raw json.RawMessage) []Link,
		validate func(args map[string]any) error,
		maxResultBytes int,
	) {
		reg[name] = tool{name: name, desc: desc, props: props, require: require, read: read,
			links: links, linksRaw: linksRaw, validate: validate, maxResultBytes: maxResultBytes}
	}

	add("project.list", "List the projects the caller can see (id, slug, name, my_role).",
		map[string]any{}, nil,
		func(t *turn, _ map[string]any) (json.RawMessage, error) {
			return t.b.store.ListProjects(t.ctx, t.caller)
		},
		func(_ *turn, _ map[string]any, rows []map[string]any) []Link {
			return linksFromRows(rows, func(row map[string]any) (Link, bool) {
				id := field(row, "id")
				if id == "" {
					return Link{}, false
				}
				return Link{Label: "Open " + labelOf(row) + " (" + short(id) + ")", Href: "/p/" + id}, true
			})
		})

	// run.list answers across the caller's projects when project_id is empty
	// (ADR-0081 § Chat tools), so one call can answer "what has been failing
	// this week" without the model first enumerating projects. The rows come
	// from the caller's own project list, which is why a project they are not
	// in contributes nothing to it — see (*turn).listRuns.
	addEx("run.list", "List the caller's recent runs (id, status, title, project, failed_cause, created_at, finished_at): of one project when project_id is given, of EVERY project the caller belongs to when it is not. Optional since (an RFC 3339 timestamp or a window key: 15m|1h|6h|24h|2d|7d|unseen) keeps the runs that started or ended in it, optional status (succeeded|failed|cancelled|running) keeps one outcome. Newest first, at most 50 rows.",
		map[string]any{
			"project_id": stringArg("optional project id from project.list; empty reads across the caller's projects"),
			"since":      stringArg("optional: an RFC 3339 timestamp or one of 15m|1h|6h|24h|2d|7d|unseen"),
			"status":     stringArg("optional: succeeded|failed|cancelled|running"),
		}, nil,
		func(t *turn, args map[string]any) (json.RawMessage, error) {
			return t.listRuns(args)
		},
		func(_ *turn, _ map[string]any, rows []map[string]any) []Link {
			return linksFromRows(rows, func(row map[string]any) (Link, bool) {
				id, prj := field(row, "id"), field(row, "project_id")
				if id == "" || prj == "" {
					return Link{}, false
				}
				return Link{Label: "Run " + short(id) + " · " + fallback(field(row, "status"), "unknown"), Href: "/runs/" + id}, true
			})
		}, nil, validateRunList, maxCatchUpChatResultBytes)

	add("run.nodes", "List the node executions of one run (kind, status, error_class, failed_cause) — the evidence for why a run failed.",
		map[string]any{"run_id": stringArg("run id from run.list")}, []string{"run_id"},
		func(t *turn, args map[string]any) (json.RawMessage, error) {
			return t.b.store.ListRunNodes(t.ctx, t.caller, args["run_id"].(string))
		},
		nil)

	// approval.pending loses its required project_id for the same reason:
	// "what is waiting on me" is a question about the reader, not about one
	// project. The cross-project read is the caller's own project list
	// fanned through the same scoped store call the project route uses.
	add("approval.pending", "List the gates still waiting on an approval (id, run_id, project_id, project, summary, deadline_at): in one project when project_id is given, across EVERY project the caller belongs to when it is not.",
		map[string]any{"project_id": stringArg("optional project id from project.list; empty reads across the caller's projects")}, nil,
		func(t *turn, args map[string]any) (json.RawMessage, error) {
			return t.listPendingApprovals(args)
		},
		func(_ *turn, _ map[string]any, rows []map[string]any) []Link {
			return linksFromRows(rows, func(row map[string]any) (Link, bool) {
				prj := field(row, "project_id")
				if prj == "" {
					return Link{}, false
				}
				// The approval row carries a run_id when the gate sits inside a
				// run; that run page is the real destination. A gate without
				// one has no dedicated page, and `/inbox` is a redirect-only
				// address since redesign finding 03 — Today is the page that
				// lists pending gates, so a link goes there rather than to a
				// URL that only bounces.
				if rid := field(row, "run_id"); rid != "" {
					return Link{Label: "Gate on run " + short(rid), Href: "/runs/" + rid}, true
				}
				return Link{Label: "Open Today", Href: "/"}, true
			})
		})

	// catchup.brief is ADR-0081's chat half: the SAME deterministic brief the
	// Catch up page assembles, so the page and the assistant can never
	// disagree about what happened. It is announced only when the store
	// answers CatchUpBriefReader (announcedToolOrder), and the two sections a
	// model wrote — `headline` and `by_project` — are stripped before the
	// payload goes back: a chat answer that quotes another model's summary is
	// exactly the ungrounded narrative the ADR moved the lists to the server
	// to stop. The rows' own `link` fields survive, because they are app
	// routes the allowlist already admits.
	addEx("catchup.brief", "What happened in the caller's projects during a time window: things waiting on them, running now, shipped, broken or fixed, risky changes, workflow/agent changes and counts. Use this first for 'what did I miss', 'catch me up', 'what happened today/this week'.",
		map[string]any{
			"window": stringArg("optional: 15m|1h|6h|24h|2d|7d|unseen; empty means unseen (since this reader's last Catch up visit)"),
		}, nil,
		func(t *turn, args map[string]any) (json.RawMessage, error) {
			return t.catchUpBrief(args)
		},
		nil,
		func(_ *turn, _ map[string]any, raw json.RawMessage) []Link {
			return catchUpBriefLinks(raw)
		},
		validateCatchUpWindow, maxCatchUpChatResultBytes)

	add("pipeline.revisions", "List the published revisions of one pipeline (revision_number, version_label, status).",
		map[string]any{"pipeline_id": stringArg("pipeline id from palette.search")}, []string{"pipeline_id"},
		func(t *turn, args map[string]any) (json.RawMessage, error) {
			return t.b.store.ListPipelineRevisions(t.ctx, t.caller, args["pipeline_id"].(string))
		},
		func(_ *turn, args map[string]any, _ []map[string]any) []Link {
			id := args["pipeline_id"].(string)
			return []Link{{Label: "Open pipeline " + short(id), Href: "/workflows/" + id}}
		})

	add("palette.search", "Search the app's navigation index — the top-level pages (today, threads, workflows, steps, agents, operations, settings) plus the caller's own projects, pipelines, runs and agent profiles — for a name or fragment.",
		map[string]any{"needle": stringArg("case-insensitive substring to match")}, []string{"needle"},
		func(t *turn, args map[string]any) (json.RawMessage, error) {
			return t.paletteSearch(args["needle"].(string))
		},
		func(t *turn, _ map[string]any, rows []map[string]any) []Link {
			return linksFromRows(rows, func(row map[string]any) (Link, bool) {
				href := field(row, "to")
				if href == "" {
					return Link{}, false
				}
				return Link{Label: fallback(field(row, "label"), short(href)), Href: href}, true
			})
		})
	return reg
}

// toolSpecs is the OpenAI `tools` array for the registry. Names are encoded
// to legal wire names here (wire.go) — the dotted registry names never leave
// the process.
func (b *Broker) toolSpecs() []toolSpec {
	specs := make([]toolSpec, 0, len(b.order))
	for _, name := range b.order {
		tl := b.tools[name]
		spec := toolSpec{Type: "function"}
		spec.Function.Name = wireName(tl.name)
		spec.Function.Description = tl.desc + " Read-only: this tool cannot change anything."
		params := map[string]any{"type": "object", "properties": tl.props, "additionalProperties": false}
		if len(tl.require) > 0 {
			params["required"] = tl.require
		}
		spec.Function.Parameters = params
		specs = append(specs, spec)
	}
	return specs
}

// parseArgs validates the model's arguments string against the registry: an
// unknown key, a non-string value, an over-long or empty required argument is a
// refusal (ok:false) rather than a store call. A tool's own `validate` then
// checks the VALUES it documents (a closed window or status vocabulary), so a
// model that guesses "3d" is refused here with zero store calls rather than
// being answered an empty list it would report as a quiet week.
func parseArgs(tl tool, raw string) (map[string]any, error) {
	args := map[string]any{}
	if strings.TrimSpace(raw) != "" {
		if err := json.Unmarshal([]byte(bounded(raw, 1024)), &args); err != nil {
			return nil, fmt.Errorf("arguments are not a json object")
		}
	}
	for k, v := range args {
		s, ok := v.(string)
		if !ok {
			return nil, fmt.Errorf("argument %q is not a string", k)
		}
		if _, known := tl.props[k]; !known {
			return nil, fmt.Errorf("argument %q is not part of this tool", k)
		}
		args[k] = bounded(s, 200)
	}
	for _, k := range tl.require {
		if s, _ := args[k].(string); strings.TrimSpace(s) == "" {
			return nil, fmt.Errorf("argument %q is required", k)
		}
	}
	if tl.validate != nil {
		if err := tl.validate(args); err != nil {
			return nil, err
		}
	}
	return args, nil
}

// --- ADR-0081: the catch-up reads ---------------------------------------

// CatchUpBriefReader is the assistant's seam to the catch-up brief. The
// assembler itself is internal/api's (AssembleCatchUpBrief), because the brief
// is that package's response shape and this one must not import it — so the
// adapter in internal/api/assistant.go answers this one method as the caller,
// and the tool reads exactly the bytes GET /catch-up/brief would have put on
// the wire for that reader.
//
// It is deliberately NOT a method of Store: the six v1 reads are mounted with
// the assistant itself, while the brief is the Catch up surface's, and a
// deployment that mounts one without the other keeps compiling — and, per
// announcedToolOrder, keeps the tool off the announced set.
type CatchUpBriefReader interface {
	// CatchUpBrief assembles the caller's brief over one window key
	// (15m|1h|6h|24h|2d|7d|unseen) and returns it as the route's own JSON.
	// An unknown window key is the caller's problem, not the model's: the
	// tool validates the vocabulary before this call.
	CatchUpBrief(ctx context.Context, c Caller, window string) (json.RawMessage, error)
}

// maxCatchUpChatResultBytes is the per-result budget of the two ADR-0081 chat
// reads — catchup.brief and the cross-project run.list. It is larger than the
// registry's MaxResultBytes for the reason draft.get states for its own cap
// (runner.go): both tools answer a bounded SET of rows the ADR counts, and a cap
// that clips the set leaves the model with a string it cannot read instead of
// the lists and counts it was asked for. Neither is unbounded, and both bounds
// are the server's own: the assembler caps every brief section at 5, 8 or 10
// rows by window (capCatchUpBrief then cuts whole lowest-priority rows, never
// needs_you), and run.list projects each row onto runRowFields and caps the list
// at runRowCap. The turn's own ceilings (MaxToolCalls, MaxPromptBytes) are
// unchanged, so one answer cannot buy a wider prompt than the design allows.
const maxCatchUpChatResultBytes = 8192

// catchUpWindowKeys is the closed window vocabulary of ADR-0081 § Windows, in
// the order the ADR names it; catchUpWindows is the same table as spans. This
// is the TOOLS' copy: internal/api owns the assembler's (catchUpRecapWindows),
// because that is where the route's 400 lives, and this package may not import
// it (api imports assistant, never the reverse). Both sides are pinned to
// ADR-0081's seven words: tools_test.go pins this table, and
// internal/api/catch_up_brief_test.go pins the assembler's, so a window added
// on one side and not the other is a failing test rather than a tool that
// refuses a word the page answers.
var (
	catchUpWindowKeys = []string{"15m", "1h", "6h", "24h", "2d", "7d", "unseen"}
	catchUpWindows    = map[string]time.Duration{
		"15m": 15 * time.Minute,
		"1h":  time.Hour,
		"6h":  6 * time.Hour,
		"24h": 24 * time.Hour,
		"2d":  2 * 24 * time.Hour,
		"7d":  7 * 24 * time.Hour,
		// `unseen` is the reader's last visit, which only the store knows; a
		// tool that needs a span (run.list's since) reads it as the widest
		// window that exists, which is the fallback the brief itself uses.
		"unseen": 7 * 24 * time.Hour,
	}
)

// catchUpWindowSince resolves one `since` value — a window key or an RFC 3339
// timestamp — onto the instant it starts at. An empty value is no bound.
func catchUpWindowSince(value string, now time.Time) (time.Time, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return time.Time{}, nil
	}
	if cut, ok := catchUpWindows[strings.ToLower(value)]; ok {
		return now.Add(-cut).UTC(), nil
	}
	at, err := time.Parse(time.RFC3339, value)
	if err != nil {
		return time.Time{}, fmt.Errorf("since must be an RFC 3339 timestamp or one of %s",
			strings.Join(catchUpWindowKeys, "|"))
	}
	return at.UTC(), nil
}

// validateCatchUpWindow refuses a window outside the closed vocabulary before
// any store call. Empty is legal and means `unseen`.
func validateCatchUpWindow(args map[string]any) error {
	window, _ := args["window"].(string)
	window = strings.TrimSpace(window)
	if window == "" {
		return nil
	}
	if _, ok := catchUpWindows[strings.ToLower(window)]; !ok {
		return fmt.Errorf("window must be one of %s", strings.Join(catchUpWindowKeys, "|"))
	}
	return nil
}

// validateRunList bounds run.list's since and status the same way: a value the
// vocabulary does not hold is a bad argument, not an empty list.
func validateRunList(args map[string]any) error {
	if since, _ := args["since"].(string); strings.TrimSpace(since) != "" {
		if _, err := catchUpWindowSince(since, time.Now()); err != nil {
			return err
		}
	}
	status, _ := args["status"].(string)
	status = strings.TrimSpace(status)
	if status == "" {
		return nil
	}
	if _, ok := runStatusAliases[strings.ToLower(status)]; !ok {
		return fmt.Errorf("status must be one of %s", strings.Join(runStatusKeys, "|"))
	}
	return nil
}

// runStatusKeys is run.list's documented status vocabulary, and runStatusAliases
// maps each onto the run statuses the rows actually carry. The ADR's word for a
// run that finished green is `succeeded`; the stored status is `completed`.
// `running` is the brief's live set — queued, booting a workspace or executing
// — because numbers.running and the rows a reader calls running must be one
// sentence stated twice (the same rule catchUpBriefLiveStatuses states for the
// page). `cancelled` keeps `interrupted` with it for the reason the brief's
// counts state: both ended without finishing.
var (
	runStatusKeys    = []string{"succeeded", "failed", "cancelled", "running"}
	runStatusAliases = map[string][]string{
		"succeeded": {"completed"},
		"failed":    {"failed"},
		"cancelled": {"cancelled", "interrupted"},
		"running":   {"queued", "preparing", "running"},
	}
)

// catchUpBriefSectionOrder is the payload's read order — the ADR's priority
// order read as a list (owed, broken, running, shipped, risky, changes), with
// the running rows beside the broken ones because "what is happening now" is
// the same present-tense question. catchup.brief's link list follows it, so the
// first jump button is the row the reader owes.
var catchUpBriefSectionOrder = []string{
	"needs_you", "broke", "running_now", "shipped", "heads_up", "changes",
}

// catchUpBriefDropOrder is the byte ladder: the section whose tail rows go
// first, then the next. It IS the headline generator's ladder
// (catchUpHeadlineDropOrder in catchup_brief.go), restated as a name so this
// file's cap and that one's cannot drift into cutting one brief two different
// ways — the two model halves of ADR-0081 must be written about the same rows.
var catchUpBriefDropOrder = catchUpHeadlineDropOrder

// errNoCatchUpBrief is the honest absence behind a call the deployment cannot
// answer. It is not ErrNotFound: the tool is not a resource the caller may not
// know exists, it is a read this replica does not serve, and the model is told
// the second fact (reason `unavailable`) rather than the first.
var errNoCatchUpBrief = errors.New("assistant: this deployment serves no catch-up brief")

// catchUpBrief answers catchup.brief: the caller's brief over one window, with
// the model's own halves removed. The window the tool answers is the one the
// assembler resolved (the brief carries it in `window`), so a caller asking for
// `unseen` sees the same since/until the page saw.
func (t *turn) catchUpBrief(args map[string]any) (json.RawMessage, error) {
	reader, ok := t.b.store.(CatchUpBriefReader)
	if !ok || reader == nil {
		return nil, errNoCatchUpBrief
	}
	window, _ := args["window"].(string)
	window = strings.TrimSpace(window)
	if window == "" {
		window = "unseen"
	}
	raw, err := reader.CatchUpBrief(t.ctx, t.caller, window)
	if err != nil {
		return nil, err
	}
	return catchUpBriefForModel(raw)
}

// catchUpBriefForModel turns the page's brief into the chat tool's payload:
// `headline` and `by_project` are dropped (they are another model's sentences,
// and the tool documents the facts), every row keeps its `link` (an app path
// the allowlist already admits), and the rest ships as the page sees it.
func catchUpBriefForModel(raw json.RawMessage) (json.RawMessage, error) {
	var body map[string]json.RawMessage
	if err := json.Unmarshal(raw, &body); err != nil {
		return nil, fmt.Errorf("assistant: the catch-up brief is not a json object")
	}
	out := make(map[string]json.RawMessage, len(body))
	for key, value := range body {
		if key == "headline" || key == "by_project" {
			continue
		}
		out[key] = value
	}
	return capCatchUpBrief(out)
}

// capCatchUpBrief keeps one brief payload inside maxCatchUpChatResultBytes by
// cutting WHOLE rows from the tail of the lowest-priority section, in the
// reverse of the ADR's order, and counting every cut in `omitted` — the field
// the page already reads "and N more" off, so the chat model can say the same
// sentence about rows it was not shown. needs_you is never cut: the rows the
// reader owes are the rows the answer is obliged to name (the rule the
// headline's own byte ladder follows for exactly that reason).
func capCatchUpBrief(body map[string]json.RawMessage) (json.RawMessage, error) {
	if blob, err := json.Marshal(body); err != nil {
		return nil, err
	} else if len(blob) <= maxCatchUpChatResultBytes {
		return blob, nil
	}
	sections := map[string][]json.RawMessage{}
	for _, key := range append(append([]string{}, catchUpBriefDropOrder...), "needs_you") {
		var sectionRows []json.RawMessage
		if err := json.Unmarshal(body[key], &sectionRows); err != nil {
			continue // absent, or not the array the brief documents: nothing to cut
		}
		sections[key] = sectionRows
	}
	omitted := map[string]int{}
	if raw, ok := body["omitted"]; ok {
		_ = json.Unmarshal(raw, &omitted) // an absent or odd map still means fresh counts
	}
	// One ladder for both halves of ADR-0081: the byte order the headline
	// generator cuts its DATA block by, reused here so the page's sentence and
	// the chat answer are never written from different halves of one brief.
	// needs_you is not IN the ladder — the rows the reader owes are the rows
	// the answer is obliged to name — and the skip below is the net under that.
	for _, key := range catchUpBriefDropOrder {
		if key == "needs_you" {
			continue
		}
		rows := sections[key]
		for len(rows) > 0 {
			rows = rows[:len(rows)-1]
			sections[key] = rows
			omitted[key]++
			blob, err := encodeCatchUpBrief(body, sections, omitted)
			if err != nil {
				return nil, err
			}
			if len(blob) <= maxCatchUpChatResultBytes {
				return blob, nil
			}
		}
	}
	// Every cuttable section is empty and it is STILL too wide: the needs_you
	// rows alone are wider than the budget. Ship them rather than nothing —
	// they are the rows the answer is about — and let the registry's payload
	// cap mark the cut the way it marks every other one.
	return encodeCatchUpBrief(body, sections, omitted)
}

// encodeCatchUpBrief rebuilds the payload: the sections the cap touched (or
// that it left alone), the window/numbers/omitted fields the assembler wrote,
// and nothing the model wrote.
func encodeCatchUpBrief(body map[string]json.RawMessage,
	sections map[string][]json.RawMessage, omitted map[string]int) (json.RawMessage, error) {
	out := map[string]json.RawMessage{}
	for key, value := range body {
		if key == "headline" || key == "by_project" || key == "omitted" {
			continue
		}
		if rows, ok := sections[key]; ok {
			blob, err := json.Marshal(rows)
			if err != nil {
				return nil, err
			}
			out[key] = blob
			continue
		}
		out[key] = value
	}
	for key, rows := range sections {
		if _, written := out[key]; written {
			continue
		}
		blob, err := json.Marshal(rows)
		if err != nil {
			return nil, err
		}
		out[key] = blob
	}
	if len(omitted) > 0 {
		blob, err := json.Marshal(omitted)
		if err != nil {
			return nil, err
		}
		out["omitted"] = blob
	}
	return json.Marshal(out)
}

// catchUpBriefLinkMax bounds the buttons one brief earns. Every section is
// allowed a link, so the whole payload would be a wall of buttons on a wide
// window; the answer surface is where the reader owes, is red and is running
// right now, and a row further down the ladder that matters can still be named
// by the model and opened from the page itself.
const catchUpBriefLinkMax = 6

// catchUpBriefLinks turns the brief's own rows into jump buttons: the rows that
// wait on the reader first, then what is broken, then what is running, and
// every href still passes the allowlist in exec. Titles are the labels the
// server assembled, so a link is a citation of a row the model was shown
// rather than something it invented.
func catchUpBriefLinks(raw json.RawMessage) []Link {
	var body map[string]json.RawMessage
	if err := json.Unmarshal(raw, &body); err != nil {
		return nil
	}
	var out []Link
	seen := map[string]bool{}
	for _, key := range catchUpBriefSectionOrder {
		var sectionRows []map[string]any
		if err := json.Unmarshal(body[key], &sectionRows); err != nil {
			continue // not a section of rows (window, numbers, omitted)
		}
		for _, row := range sectionRows {
			href := field(row, "link")
			if i := strings.IndexAny(href, "?#"); i >= 0 {
				href = href[:i] // a beat or a step anchor is a page-local detail
			}
			if href == "" || seen[href] {
				continue
			}
			seen[href] = true
			out = append(out, Link{Label: bounded(fallback(labelOf(row), "Open item"), 80), Href: href})
			if len(out) >= catchUpBriefLinkMax {
				return out
			}
		}
	}
	return out
}

// runRowCap is ADR-0081's bound on run.list's answer: enough rows to name a
// week of a busy team, few enough that the tool is a list and not a dump.
const runRowCap = 50

// listRuns answers run.list for both shapes of the question. With a
// project_id it is the project route's own read, unchanged — including its
// 404, which is how a project outside the caller's memberships stays unnamed.
// Without one it fans the SAME scoped store call over the caller's own
// project.list, which is what makes "all member projects" mean exactly that:
// a project the caller is not in is never even asked about. The rows are then
// filtered by the window and the status, ordered newest first, and cut to
// runRowCap, and each carries the name of the project it happened under.
func (t *turn) listRuns(args map[string]any) (json.RawMessage, error) {
	projectID := strArg(args, "project_id")
	since, err := catchUpWindowSince(strArg(args, "since"), time.Now())
	if err != nil {
		return nil, err
	}
	status := strings.ToLower(strArg(args, "status"))

	var (
		runRows []map[string]any
		names   projectIndex
	)
	if projectID != "" {
		// Read first, label second: the project route's 404 is this tool's
		// refusal too (the 404 rule of ADR-0034), and a refusal must not buy
		// itself an extra store call. A project.list that then fails costs the
		// rows their name, not the answer — every row below already passed the
		// same scoped read the browser's project run list issues.
		raw, rerr := t.b.store.ListProjectRuns(t.ctx, t.caller, projectID)
		if rerr != nil {
			return nil, rerr
		}
		runRows = rows(raw)
		if idx, nerr := t.projectNames(); nerr == nil {
			names = idx
		}
	} else {
		var nerr error
		if names, nerr = t.projectNames(); nerr != nil {
			return nil, nerr
		}
		// The fan is over the caller's visible projects only, so a project they
		// are not a member of is never even asked about. A read that fails
		// mid-way (a project that vanished between the two calls) narrows the
		// answer rather than voiding the rows already collected, which is
		// palette.search's rule for the very same fan.
		for _, project := range names.list {
			raw, rerr := t.b.store.ListProjectRuns(t.ctx, t.caller, project.id)
			if rerr != nil {
				continue
			}
			runRows = append(runRows, rows(raw)...)
		}
	}

	kept := make([]map[string]any, 0, len(runRows))
	for _, row := range runRows {
		if !runMatchesStatus(row, status) || !runInWindow(row, since) {
			continue
		}
		kept = append(kept, compactRunRow(row, names.byID[field(row, "project_id")]))
	}
	sort.SliceStable(kept, func(i, j int) bool {
		ci, cj := runClock(kept[i]), runClock(kept[j])
		if !ci.Equal(cj) {
			return ci.After(cj)
		}
		return field(kept[i], "id") < field(kept[j], "id")
	})
	if len(kept) > runRowCap {
		kept = kept[:runRowCap]
	}
	return json.Marshal(kept)
}

// listPendingApprovals answers approval.pending for both shapes. The pending
// filter stays the tool's (the store call is the route's own, and the route
// lists every gate), so one read serves the UI route and the assistant.
func (t *turn) listPendingApprovals(args map[string]any) (json.RawMessage, error) {
	projectID := strArg(args, "project_id")
	var (
		gates = make([]map[string]any, 0) // never null: "none pending" is an empty list
		names projectIndex
	)
	if projectID != "" {
		raw, err := t.b.store.ListProjectApprovals(t.ctx, t.caller, projectID)
		if err != nil {
			return nil, err // the project route's 404 rule, before any other read
		}
		if idx, nerr := t.projectNames(); nerr == nil {
			names = idx
		}
		gates = pendingGates(rows(raw), names)
	} else {
		var err error
		if names, err = t.projectNames(); err != nil {
			return nil, err
		}
		for _, project := range names.list {
			// Same fan and same mid-way rule as run.list above.
			raw, rerr := t.b.store.ListProjectApprovals(t.ctx, t.caller, project.id)
			if rerr != nil {
				continue
			}
			gates = append(gates, pendingGates(rows(raw), names)...)
		}
	}
	out, err := json.Marshal(gates)
	if err != nil {
		return nil, err
	}
	return out, nil
}

// pendingGates is the rows approval.pending DOCUMENTS (state == "pending") —
// the store call is the route's own, which lists every gate, so the pending
// filter stays the tool's and one read serves the UI route and the assistant —
// plus the project name the reader needs in order to say WHICH project waits on
// them. One implementation for both shapes, so the single-project answer and the
// cross-project one cannot drift apart.
func pendingGates(raw []map[string]any, names projectIndex) []map[string]any {
	kept := make([]map[string]any, 0, len(raw))
	for _, row := range raw {
		if field(row, "state") != "pending" {
			continue
		}
		if name := names.byID[field(row, "project_id")]; name != "" {
			row["project"] = bounded(name, 80)
		}
		kept = append(kept, row)
	}
	return kept
}

// projectNames is the caller's own project list in both shapes: the map the
// rows are labelled from, and the fan the cross-project reads walk. It is the
// membership predicate of every scoped list read reused rather than
// re-derived, which is why an unfamiliar project contributes nothing.
type projectRef struct {
	id   string
	name string
}

type projectIndex struct {
	byID map[string]string
	list []projectRef
}

func (t *turn) projectNames() (projectIndex, error) {
	raw, err := t.b.store.ListProjects(t.ctx, t.caller)
	if err != nil {
		return projectIndex{}, err
	}
	idx := projectIndex{byID: map[string]string{}}
	for _, project := range rows(raw) {
		id := field(project, "id")
		if id == "" {
			continue
		}
		name := field(project, "name")
		if name == "" {
			name = field(project, "slug")
		}
		name = bounded(name, 80)
		idx.byID[id] = name
		idx.list = append(idx.list, projectRef{id: id, name: name})
	}
	return idx, nil
}

// runRowFields is the row shape run.list DOCUMENTS. The route's own row is much
// wider (the revision and plan digests, the step-progress projection, the
// trigger, the parent run) and none of that is what a catch-up answer is
// written from; at the registry's default byte cap those fields would buy the
// model two of the fifty runs ADR-0081 asks it to see. Every field the route
// names that the tool keeps is here, so the payload says what it means and the
// links still have their id and project_id.
var runRowFields = []string{
	"id", "project_id", "status", "title", "failed_cause",
	"created_at", "started_at", "finished_at",
}

// compactRunRow projects one route row onto runRowFields and attaches the
// project's name — the field the ADR adds, and the only way a cross-project
// list can be answered in words the reader recognizes.
func compactRunRow(row map[string]any, project string) map[string]any {
	out := make(map[string]any, len(runRowFields)+1)
	for _, key := range runRowFields {
		value, ok := row[key]
		if !ok || value == nil {
			continue
		}
		if s, isString := value.(string); isString && strings.TrimSpace(s) == "" {
			continue // an absent field stays absent: the model invents nothing
		}
		out[key] = value
	}
	if name := strings.TrimSpace(bounded(project, 80)); name != "" {
		out["project"] = name
	}
	return out
}

// runClock is a run's event clock: when it ended if it ended, else when it
// began — the same clock (catchUpBriefRunClock) the brief's own window reads
// against, so a run listed by run.list since=24h is a run the brief would
// have counted in 24h.
func runClock(row map[string]any) time.Time {
	for _, key := range []string{"finished_at", "started_at", "created_at"} {
		if at, ok := parseRowTime(field(row, key)); ok {
			return at
		}
	}
	return time.Time{}
}

// runInWindow keeps a row whose event clock is at or after the bound. A row
// with no clock at all is kept: the tool refuses to invent an absence, and a
// run whose times the route did not serialize is not evidence that it is old.
func runInWindow(row map[string]any, since time.Time) bool {
	if since.IsZero() {
		return true
	}
	at, ok := parseRowTime(field(row, "finished_at"))
	if !ok {
		at, ok = parseRowTime(field(row, "created_at"))
	}
	if !ok {
		return true
	}
	return !at.Before(since)
}

// runMatchesStatus is run.list's status filter through the alias table.
func runMatchesStatus(row map[string]any, status string) bool {
	if status == "" {
		return true
	}
	accepted, ok := runStatusAliases[status]
	if !ok {
		return false
	}
	rowStatus := strings.ToLower(field(row, "status"))
	for _, want := range accepted {
		if rowStatus == want {
			return true
		}
	}
	return false
}

// parseRowTime reads one timestamp of a route payload. Both the RFC 3339 form
// the routes write and the truncated form a bounded field may have left are
// read; anything else is "no clock".
func parseRowTime(value string) (time.Time, bool) {
	value = strings.TrimSpace(value)
	if value == "" {
		return time.Time{}, false
	}
	for _, layout := range []string{time.RFC3339Nano, time.RFC3339} {
		if at, err := time.Parse(layout, value); err == nil {
			return at.UTC(), true
		}
	}
	return time.Time{}, false
}

// rows decodes a tool payload into row objects for link derivation. A payload
// that is not an array yields no rows, hence no links.
func rows(raw json.RawMessage) []map[string]any {
	var out []map[string]any
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil
	}
	return out
}

func field(row map[string]any, key string) string {
	v, ok := row[key]
	if !ok {
		return ""
	}
	s, ok := v.(string)
	if !ok {
		return ""
	}
	return bounded(strings.TrimSpace(s), 200)
}

func labelOf(row map[string]any) string {
	for _, key := range []string{"name", "display_name", "slug", "label", "version_label", "title"} {
		if v := field(row, key); v != "" {
			return bounded(v, 80)
		}
	}
	return "item"
}

func fallback(s, alt string) string {
	if s == "" {
		return alt
	}
	return s
}

// short renders an id readably in a label: an 8-char head of a uuidv7 beats a
// 36-char string in a button.
func short(id string) string {
	id = strings.TrimSpace(id)
	if len(id) <= 12 {
		return id
	}
	return id[:8] + "…"
}

func linksFromRows(rows []map[string]any, make func(map[string]any) (Link, bool)) []Link {
	var out []Link
	seen := map[string]bool{}
	for _, row := range rows {
		link, ok := make(row)
		if !ok || link.Href == "" || seen[link.Href] {
			continue
		}
		seen[link.Href] = true
		out = append(out, link)
	}
	return out
}
