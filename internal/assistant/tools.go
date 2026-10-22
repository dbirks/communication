package assistant

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
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
	// read performs the store call.
	read func(t *turn, args map[string]any) (json.RawMessage, error)
}

// toolOrder is the order tools are announced to the model (stable, so the
// request body is reproducible).
var toolOrder = []string{"project.list", "run.list", "run.nodes", "approval.pending", "pipeline.revisions", "palette.search"}

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

	add("run.list", "List the recent runs of one project the caller can see (id, status, failed_cause).",
		map[string]any{"project_id": stringArg("project id from project.list")}, []string{"project_id"},
		func(t *turn, args map[string]any) (json.RawMessage, error) {
			return t.b.store.ListProjectRuns(t.ctx, t.caller, args["project_id"].(string))
		},
		func(_ *turn, _ map[string]any, rows []map[string]any) []Link {
			return linksFromRows(rows, func(row map[string]any) (Link, bool) {
				id, prj := field(row, "id"), field(row, "project_id")
				if id == "" || prj == "" {
					return Link{}, false
				}
				return Link{Label: "Run " + short(id) + " · " + fallback(field(row, "status"), "unknown"), Href: "/runs/" + id}, true
			})
		})

	add("run.nodes", "List the node executions of one run (kind, status, error_class, failed_cause) — the evidence for why a run failed.",
		map[string]any{"run_id": stringArg("run id from run.list")}, []string{"run_id"},
		func(t *turn, args map[string]any) (json.RawMessage, error) {
			return t.b.store.ListRunNodes(t.ctx, t.caller, args["run_id"].(string))
		},
		nil)

	add("approval.pending", "List a project's gates still waiting on an approval (id, run_id, summary, deadline_at).",
		map[string]any{"project_id": stringArg("project id from project.list")}, []string{"project_id"},
		func(t *turn, args map[string]any) (json.RawMessage, error) {
			raw, err := t.b.store.ListProjectApprovals(t.ctx, t.caller, args["project_id"].(string))
			if err != nil {
				return nil, err
			}
			return filterPending(raw)
		},
		func(_ *turn, _ map[string]any, rows []map[string]any) []Link {
			return linksFromRows(rows, func(row map[string]any) (Link, bool) {
				prj := field(row, "project_id")
				if prj == "" {
					return Link{}, false
				}
				// The approval row carries a run_id when the gate sits inside a
				// run; that run page is the real destination. A gate without
				// one has no dedicated page, so the inbox — which lists pending
				// gates — is the page that actually exists.
				if rid := field(row, "run_id"); rid != "" {
					return Link{Label: "Gate on run " + short(rid), Href: "/runs/" + rid}, true
				}
				return Link{Label: "Open inbox", Href: "/inbox"}, true
			})
		})

	add("pipeline.revisions", "List the published revisions of one pipeline (revision_number, version_label, status).",
		map[string]any{"pipeline_id": stringArg("pipeline id from palette.search")}, []string{"pipeline_id"},
		func(t *turn, args map[string]any) (json.RawMessage, error) {
			return t.b.store.ListPipelineRevisions(t.ctx, t.caller, args["pipeline_id"].(string))
		},
		func(_ *turn, args map[string]any, _ []map[string]any) []Link {
			id := args["pipeline_id"].(string)
			return []Link{{Label: "Open pipeline " + short(id), Href: "/workflows/" + id}}
		})

	add("palette.search", "Search the app's navigation index — the top-level pages (home, inbox, board, threads, workflows, steps, agent profiles, operations, settings) plus the caller's own projects, pipelines, runs and agent profiles — for a name or fragment.",
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
// refusal (ok:false) rather than a store call.
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
	return args, nil
}

// filterPending keeps the rows approval.pending documents (state == "pending").
func filterPending(raw json.RawMessage) (json.RawMessage, error) {
	var rows []map[string]any
	if err := json.Unmarshal(raw, &rows); err != nil {
		return nil, fmt.Errorf("approval list is not a json array of objects")
	}
	kept := make([]map[string]any, 0, len(rows))
	for _, row := range rows {
		if field(row, "state") == "pending" {
			kept = append(kept, row)
		}
	}
	out, err := json.Marshal(kept)
	if err != nil {
		return nil, err
	}
	return out, nil
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
	for _, key := range []string{"name", "display_name", "slug", "label", "version_label"} {
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
