package api

import (
	"context"
	"io"
	"log/slog"
	"net/http"

	"github.com/dbirks/communication/internal/agent/acp"
)

// ADR-0051: GET /api/v1/launchers lists the launcher registry the profiles
// UI, the New-profile dialog and the Operations capability matrix render
// from. Two sources, kept strictly separate:
//
//   - the registry is code: the built-in M0 launchers in
//     internal/agent/acp (launchers.go) union the four product card ids
//     (claude, codex, pi, antigravity). `registered` answers "would the
//     worker have a launcher entry to launch it with" — nothing more;
//     a registered launcher is not a capability claim.
//   - the capability cells are evidence: each result comes only from a
//     recorded probe row in docs/compatibility/acp-observed.json
//     (internal/agent/acp/evidence.go); a cell with no row is not_tested.
//     This route can therefore never report observed without a dated,
//     path-cited row behind it.
//
// `workers_online` is a documented approximation (ADR-0051 §2): workers do
// not report which launchers they can run — registration carries the
// sandbox state only (ADR-0019 D5) — so the count is the number of live
// workers whose registration says required sandbox enforcement with a
// verified launch, for registered launchers, and 0 for unregistered ones
// (no launcher entry, nothing to run).

// LauncherCapabilityView is the LauncherCapability schema of
// api/openapi.yaml: one capability cell with its evidence-backed verdict.
type LauncherCapabilityView struct {
	// Capability is one of acp_session | resume | permission_prompts |
	// nono_required, in that order.
	Capability string `json:"capability"`
	// Result is observed | not_supported | not_tested.
	Result string `json:"result"`
	// ObservedAt (RFC 3339) and Evidence are set exactly when Result is
	// evidence-backed (observed or not_supported); null on not_tested.
	ObservedAt *string `json:"observed_at"`
	Evidence   *string `json:"evidence"`
}

// LauncherView is the Launcher schema of api/openapi.yaml.
type LauncherView struct {
	ID            string                   `json:"id"`
	DisplayName   string                   `json:"display_name"`
	Registered    bool                     `json:"registered"`
	WorkersOnline int                      `json:"workers_online"`
	Capabilities  []LauncherCapabilityView `json:"capabilities"`
}

// LauncherList is the listLaunchers response body: `{"launchers": [...]}`
// per the C5 contract of the app-shell redesign handoff — deliberately not
// the `{items: [...]}` envelope, because the UI's five agent cards map
// positionally to the ids below.
type LauncherList struct {
	// Launchers always contains the four card ids in this order; extra
	// registered launchers beyond the cards follow in registry order.
	Launchers []LauncherView `json:"launchers"`
}

// launcherCardIDs are the ids the product's five agent cards render
// (the fifth card, "Other ACP agent", is the client's catch-all for any
// other registered id this route lists).
var launcherCardIDs = []string{"claude", "codex", "pi", "antigravity"}

// launcherCardNames is the display text for a card id the built-in registry
// does not know — the registry entry is the name of record when it exists.
var launcherCardNames = map[string]string{
	"pi":          "Pi",
	"antigravity": "Antigravity",
}

// LauncherStore backs the worker count. The count is fleet-level on
// purpose: since workers do not declare per-launcher capability, no
// store read can do better than the sandbox-verified live-worker count,
// and inventing a per-launcher split would be a fabricated number.
type LauncherStore interface {
	// CountLaunchWorkers counts live workers whose registration records
	// required sandbox enforcement AND a verified launch.
	CountLaunchWorkers(ctx context.Context) (int, error)
}

// RegisterLaunchers mounts GET /api/v1/launchers: an authenticated read-only
// listing (session, no membership — it is not project-scoped, matching
// GET /api/v1/workers and GET /api/v1/system/sandbox).
func RegisterLaunchers(s *Server, store LauncherStore) {
	h := &lchHandlers{store: store, srv: s}
	s.HandleAuthed("GET /api/v1/launchers", http.HandlerFunc(h.list))
}

type lchHandlers struct {
	store LauncherStore
	srv   *Server
}

func (h *lchHandlers) list(w http.ResponseWriter, r *http.Request) {
	if _, ok := PrincipalFrom(r.Context()); !ok {
		// Reachable only if the route were ever registered without
		// RequireAuth; the contract says 401, so it says 401.
		WriteProblem(w, http.StatusUnauthorized, "Unauthenticated",
			"A valid session is required.")
		return
	}
	count, err := h.store.CountLaunchWorkers(r.Context())
	if err != nil {
		// The store error may name tables or connection details; the client
		// gets the request id to quote instead (ADR-0014 §2).
		h.log(r).ErrorContext(r.Context(), "launcher list failed",
			"request_id", RequestIDFrom(r), "error", err.Error())
		WriteProblem(w, http.StatusInternalServerError, "Internal Server Error",
			"The server could not read the launcher registry. Use the request id when reporting it.")
		return
	}

	// The card ids first, then any registered launcher beyond them (so the
	// client's "Other ACP agent" card always covers a real id).
	ids := append([]string(nil), launcherCardIDs...)
	seen := map[string]bool{}
	for _, id := range ids {
		seen[id] = true
	}
	for _, l := range acp.KnownLaunchers() {
		if !seen[l.ID] {
			ids = append(ids, l.ID)
			seen[l.ID] = true
		}
	}

	out := LauncherList{Launchers: []LauncherView{}}
	for _, id := range ids {
		registry, ok := acp.LookupLauncher(id)
		display, named := launcherCardNames[id]
		if !named {
			display = id
		}
		workersOnline := 0
		if ok {
			display = registry.DisplayName
			// The documented approximation (ADR-0051): the whole
			// sandbox-verified live-worker count, per launcher.
			workersOnline = count
		}
		cells := acp.ObservedCapabilities(id)
		caps := make([]LauncherCapabilityView, 0, len(cells))
		for _, c := range cells {
			v := LauncherCapabilityView{
				Capability: string(c.Capability),
				Result:     string(c.Result),
			}
			if c.ObservedAt != "" {
				v.ObservedAt = &c.ObservedAt
			}
			if c.Evidence != "" {
				v.Evidence = &c.Evidence
			}
			caps = append(caps, v)
		}
		out.Launchers = append(out.Launchers, LauncherView{
			ID:            id,
			DisplayName:   display,
			Registered:    ok,
			WorkersOnline: workersOnline,
			Capabilities:  caps,
		})
	}
	WriteJSON(w, http.StatusOK, out)
}

func (h *lchHandlers) log(r *http.Request) *slog.Logger {
	if h.srv != nil {
		return h.srv.logger
	}
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}
