package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/dbirks/communication/internal/events"
	"github.com/dbirks/communication/internal/secrets"
	"github.com/dbirks/communication/internal/secrets/materialize"
	"github.com/dbirks/communication/internal/worker"
)

// UnitSecrets is the production worker.SecretMaterializer: the glue between
// the execution unit, the declarative mounts, the envelope resolver and the
// filesystem materializer (docs/m3-contract.md § 4.2 step 3, ADR-0018 D4).
//
// It lives here rather than in internal/secrets because the knowledge it needs
// is the *rows* — which mounts this project declared, which checkouts this
// workspace has — and internal/secrets deliberately does not own a database
// handle beyond the VersionSource interface. It lives here rather than in
// internal/worker because a worker must not be able to read ciphertext: this
// package is the only one holding both the pool and the keyring path, and the
// unit consumes the result through an interface that cannot return a value.
//
// The plaintext's whole itinerary is: secret_versions.ciphertext →
// secrets.Resolver → Delivery.Value → materialize.Receipt (file written; the
// receipt's cleanup zeroes what it can) plus a private clone held only by the
// returned redaction hook. It never passes through internal/worker as data —
// the hook the sink calls is a closure over memory this package owns.
type UnitSecrets struct {
	// Secrets is the store the resolver reads through; its Keys field is the
	// keyring, so a UnitSecrets without a keyring refuses exactly like the
	// resolver does (ADR-0018 D2.5).
	Secrets *SecretStore
	// Workspaces is the pool-holding sibling store; the startup sweep reads
	// workspace rows through it. Materialization itself takes its checkouts
	// from the request (see MaterializeRequest.Repos for why).
	Workspaces *WorkspaceStore
}

// Compile-time proof of the seam.
var _ worker.SecretMaterializer = (*UnitSecrets)(nil)

// The attempt-shaped seam: materialization plus the authorized-checkout read
// an agent.acp attempt needs (contract § 4 step 4).
var _ worker.AttemptSecrets = (*UnitSecrets)(nil)

// unitMount is one declared placement joined with the metadata the resolver
// and the event need. Deliberately no ciphertext columns: the resolver reads
// those through LoadVersion, and this query could not return them to anybody
// who should see them (ADR-0018 D1).
type unitMount struct {
	MountID  string
	SecretID string
	Slug     string
	// Scope is secret_metadata.scope ('project' | 'org'): the first half of the
	// `project/<slug>` reference a node declares, so a declared ref can be
	// matched to its mount without guessing which tier the slug lives in.
	Scope        string
	Purpose      string
	DeliveryMode string
	RepositoryID string
	RelativePath string
	EnvName      string
	Key          string
	Lifecycle    string
	AllowTracked bool
	Revoked      bool
}

// MountsForUnit is the worker-side mount read: the placements declared for the
// project that belong to the requesting unit's lifecycle, with each secret's
// revocation state. There is no Caller — the authorization for this read is
// *structural*: the caller is a worker that was assigned a turn or an attempt in
// this project, the mount rows were written through the role-gated API
// (maintainer-only), and the profile-allowlist question is answered per delivery
// by secrets.Resolver, not here.
//
// The lifecycle predicate is the ownership rule ADR-0018 D1 states: a
// `node_attempt` mount is materialized for an attempt and never for a turn
// (contract § 4 step 4), and everything else is a turn/workspace mount that an
// attempt must not silently inherit. scope is worker.LifecycleTurn (the
// default) or worker.LifecycleNodeAttempt; any other value is refused rather
// than quietly widened.
//
// refs narrows the read to the secrets one node declared (contract § 4 step 4,
// ADR-0018 D4): when it is non-empty a mount is returned only if its
// `scope/slug` (or, for the compiler's `secrets.<name>` references, its bare
// slug) appears in the list. Omitting refs is the pre-M4 unfiltered read and is
// what a turn-scope unit asks for — M2/M3 selection is unchanged. The caller
// that has a node_attempt in front of it passes the plan's references, or calls
// MountsForAttempt, which does it from the attempt id.
func (s *SecretStore) MountsForUnit(ctx context.Context, projectID, scope string, refs ...string) ([]unitMount, error) {
	if s == nil || s.Pool == nil {
		return nil, errors.New("postgres: secret store has no pool")
	}
	var lifecycleSQL string
	switch scope {
	case "", worker.LifecycleTurn:
		lifecycleSQL = "m.lifecycle <> 'node_attempt'"
	case worker.LifecycleNodeAttempt:
		lifecycleSQL = "m.lifecycle = 'node_attempt'"
	default:
		return nil, fmt.Errorf("postgres: mount lifecycle %q is not turn or node_attempt", scope)
	}
	// The declared-reference predicate sits beside the lifecycle predicate for
	// the same reason: the question "is this mount in play for this unit" is
	// answered by the row set, not by a caller who might forget to filter.
	refSQL := ""
	var refArgs []any
	if len(refs) > 0 {
		qualified, names := splitSecretRefs(refs)
		if len(qualified) == 0 {
			qualified = []string{}
		}
		if len(names) == 0 {
			names = []string{}
		}
		refSQL = ` AND ((sm.scope || '/' || sm.slug) = ANY($2::text[]) OR sm.slug = ANY($3::text[]))`
		refArgs = []any{qualified, names}
	}
	rows, err := s.Pool.Query(ctx, `
		SELECT m.id::text, m.secret_id::text, sm.slug, sm.scope, sm.purpose, m.delivery_mode,
		       COALESCE(m.repository_id::text, ''), COALESCE(m.relative_path, ''),
		       COALESCE(m.env_name, ''), COALESCE(m.key, ''), m.lifecycle,
		       m.allow_tracked, sm.revoked_at IS NOT NULL
		FROM secret_mounts m
		JOIN secret_metadata sm ON sm.id = m.secret_id
		WHERE m.project_id = $1::uuid AND (`+lifecycleSQL+`)`+refSQL+`
		ORDER BY sm.slug, m.id`, append([]any{prjCleanUUID(projectID)}, refArgs...)...)
	if err != nil {
		return nil, fmt.Errorf("postgres: list unit mounts: %w", err)
	}
	defer rows.Close()
	var out []unitMount
	for rows.Next() {
		var m unitMount
		if err := rows.Scan(&m.MountID, &m.SecretID, &m.Slug, &m.Scope, &m.Purpose, &m.DeliveryMode,
			&m.RepositoryID, &m.RelativePath, &m.EnvName, &m.Key, &m.Lifecycle,
			&m.AllowTracked, &m.Revoked); err != nil {
			return nil, fmt.Errorf("postgres: scan unit mount: %w", err)
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// MountsForAttempt is the contract § 4 step 4 read: the node_attempt-lifetime
// mounts that ONE attempt has in play — the placements its node declared, in the
// run's pinned plan, intersected with the lifecycle arm.
//
// A node that declares no secret references gets no mounts, even in a project
// that mounts secrets for someone else: the pre-M4 read ("every node_attempt
// mount of the project") handed a mount to an attempt whose node never asked for
// it, and the resolver's honest "this profile was never granted that secret" then
// looked like a materialization failure. Whether a mount in play may actually be
// delivered to this attempt's profile stays the resolver's per-delivery question
// (ADR-0018 D3) — this read narrows *which* mounts are asked about, not who is
// allowed to receive them.
func (s *SecretStore) MountsForAttempt(ctx context.Context, projectID, attemptID string) ([]unitMount, error) {
	refs, err := s.attemptDeclaredSecretRefs(ctx, attemptID)
	if err != nil {
		return nil, err
	}
	if len(refs) == 0 {
		// Declared nothing: the empty set is the answer, not the project's set.
		return nil, nil
	}
	return s.MountsForUnit(ctx, projectID, worker.LifecycleNodeAttempt, refs...)
}

// attemptDeclaredSecretRefs reads the secret references one node declared out of
// its run's PINNED runs.plan_snapshot (ADR-0023 § 2: the run executes the plan it
// pinned, so this read sees no mutable state — the same source attempt_worker.go
// hydrates a claim's Config from, and the same node/scope match it uses).
//
// Two shapes are collected, because a node can name a secret two ways:
// the compiled node's `secretRefs` (ADR-0021/22's audit of every `secrets.<name>`
// expression read) and the literal `config.secretRefs` list the schema defines as
// `project/<slug>`|`org/<slug>` (the M4 lab's `project/test-database-url`).
// A plan with no entry for the node is an error, not an empty answer: an empty
// list means "this node asked for nothing", and this package must not let a
// missing row be misread as one.
func (s *SecretStore) attemptDeclaredSecretRefs(ctx context.Context, attemptID string) ([]string, error) {
	if s == nil || s.Pool == nil {
		return nil, errors.New("postgres: secret store has no pool")
	}
	var (
		nodeID, scopeKey string
		snapshot         string
	)
	err := s.Pool.QueryRow(ctx, `
		SELECT ne.node_id, ne.scope_key, COALESCE(r.plan_snapshot, '{}'::jsonb)::text
		FROM attempts a
		JOIN node_executions ne ON ne.id = a.node_execution_id
		JOIN runs r ON r.id = ne.run_id
		WHERE a.id = $1::uuid`, prjCleanUUID(attemptID)).Scan(&nodeID, &scopeKey, &snapshot)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, fmt.Errorf("postgres: attempt %s is not in the execution ledger", attemptID)
	}
	if err != nil {
		return nil, fmt.Errorf("postgres: read the plan entry of attempt %s: %w", attemptID, err)
	}
	var plan unitPlanShape
	if err := json.Unmarshal([]byte(snapshot), &plan); err != nil {
		return nil, fmt.Errorf("postgres: decode the pinned plan of attempt %s: %w", attemptID, err)
	}
	refs, found := plan.secretRefs(scopePathNoIndexes(scopeKey), nodeID)
	if !found {
		return nil, fmt.Errorf(
			"postgres: attempt %s names node %q of scope %q, which its run's pinned plan does not carry",
			attemptID, nodeID, scopeKey)
	}
	return refs, nil
}

// unitPlanShape is the slice of the compiled plan this read needs. Deliberately
// not compiler.Plan: internal/store/postgres reaches the plan through JSON
// already stored (attempt_worker.go's planShape does the same), and a decoder
// here must not make the compiler a dependency of the secret path.
type unitPlanShape struct {
	Nodes []unitPlanNode `json:"nodes"`
}

type unitPlanNode struct {
	ID    string `json:"id"`
	Scope string `json:"scope"`
	// SecretRefs is the compiler's audit of the node's secret reads, in
	// `secrets.<name>` form.
	SecretRefs []string `json:"secretRefs,omitempty"`
	// ConfigBindings carries the literal `config.secretRefs` list: a value with
	// no expression is a Literal at a /config/secretRefs pointer.
	ConfigBindings []struct {
		Pointer string `json:"pointer"`
		Literal any    `json:"literal,omitempty"`
	} `json:"configBindings,omitempty"`
}

// secretRefs returns every reference the plan entry for (scope, id) declares.
// The scope-less fallback is deliberate: a plan whose scope spelling this read
// cannot reproduce still says which secrets a node named, and the alternative —
// refusing — would starve a node of a secret its own config declared because of
// a path-format difference. An id present in no node at all is `found=false`.
func (p *unitPlanShape) secretRefs(scope, id string) ([]string, bool) {
	if p == nil {
		return nil, false
	}
	var refs []string
	found := false
	collect := func(n *unitPlanNode) {
		found = true
		refs = append(refs, n.SecretRefs...)
		for _, b := range n.ConfigBindings {
			if !declaredSecretRefPointer(b.Pointer) {
				continue
			}
			switch v := b.Literal.(type) {
			case string:
				refs = append(refs, v)
			case []any:
				for _, e := range v {
					if s, ok := e.(string); ok {
						refs = append(refs, s)
					}
				}
			}
		}
	}
	for i := range p.Nodes {
		if n := &p.Nodes[i]; n.ID == id && n.Scope == scope {
			collect(n)
		}
	}
	if found {
		return refs, true
	}
	for i := range p.Nodes {
		if n := &p.Nodes[i]; n.ID == id {
			collect(n)
		}
	}
	return refs, found
}

// declaredSecretRefPointer reports whether a plan pointer names the node's
// declared reference list (the array itself or one of its elements).
func declaredSecretRefPointer(pointer string) bool {
	const key = "/config/secretRefs"
	i := strings.Index(pointer, key)
	if i < 0 {
		return false
	}
	rest := pointer[i+len(key):]
	return rest == "" || strings.HasPrefix(rest, "/")
}

// splitSecretRefs sorts compiled references into the two forms a mount can be
// named by: a scoped `project/<slug>`|`org/<slug>` reference matches
// `scope/slug` exactly, and a bare name (the `secrets.<name>` shape the compiler
// records, or a name an author wrote without a tier) matches the slug alone.
// The resolver still decides the scope axis for a name-only match — a slug that
// turns out to belong to the wrong tier is refused there, and an attempt-scope
// refusal is a skip, not a delivery.
func splitSecretRefs(refs []string) (qualified, names []string) {
	for _, r := range refs {
		r = strings.TrimSpace(r)
		r = strings.TrimPrefix(r, "secrets.")
		if r == "" {
			continue
		}
		if strings.Contains(r, "/") {
			qualified = append(qualified, r)
			continue
		}
		names = append(names, r)
	}
	return qualified, names
}

// Materialize implements worker.SecretMaterializer for one execution unit.
//
// The failure rule is ADR-0018 D4's: any mount that cannot be delivered fails
// the unit before launch — no child, no partial set — and the reason lands in
// the journal as secret.materialization_failed with the enum reason and the
// rejected *relative* target. Free text never reaches the journal: materialize
// refusals carry a path-shaped reason already, and resolver failures are
// reported as their sentinel class, never as their message.
func (u *UnitSecrets) Materialize(ctx context.Context, req worker.MaterializeRequest) (worker.Materialized, error) {
	empty := worker.Materialized{}
	if u == nil || u.Secrets == nil || u.Workspaces == nil {
		return empty, errors.New("postgres: unit secrets materializer is not wired")
	}
	// The lifecycle scope is validated before anything is read: it filters the
	// mounts below and stamps the ledger row's attempt_id, so a request whose
	// scope and owner disagree must be refused even in a project that declares
	// no mounts at all — the shape of the request is wrong, not its result.
	scope := req.Lifecycle
	if scope == "" {
		scope = worker.LifecycleTurn
	}
	attemptID := ""
	switch scope {
	case worker.LifecycleNodeAttempt:
		if req.AttemptID == "" {
			return empty, errors.New("postgres: node_attempt materialization requires an attempt id")
		}
		attemptID = req.AttemptID
	default:
		if req.AttemptID != "" {
			// A turn-scope unit that names an attempt would write a row whose
			// lifecycle says 'turn' and whose attempt_id says otherwise.
			return empty, errors.New("postgres: turn-scope materialization must not name an attempt id")
		}
	}
	// Selection, before anything is read: M2/M3's unit is the turn and sees the
	// project's non-attempt mounts exactly as before; M4's unit is the attempt.
	var mounts []unitMount
	if scope == worker.LifecycleNodeAttempt {
		// Contract § 4 step 4 / ADR-0018 D4: for an ATTEMPT the mounts in play
		// are the ones its node declared, not every node_attempt-lifetime mount
		// the project happens to hold. Handing the planner a mount its node never
		// named produced a resolver denial that this function then journalled as
		// a materialization failure for a secret the node never asked for.
		refs, err := u.Secrets.attemptDeclaredSecretRefs(ctx, attemptID)
		if err != nil {
			return empty, err
		}
		if len(refs) == 0 {
			// The node declared no references: nothing is in play, which is a
			// normal node, not a failed one.
			return empty, nil
		}
		mounts, err = u.Secrets.MountsForUnit(ctx, req.ProjectID, scope, refs...)
		if err != nil {
			return empty, err
		}
	} else {
		var err error
		mounts, err = u.Secrets.MountsForUnit(ctx, req.ProjectID, req.Lifecycle)
		if err != nil {
			return empty, err
		}
	}
	if len(mounts) == 0 {
		// No declarations is a normal project, not a failed one.
		return empty, nil
	}
	byID := map[string]worker.MaterializeRepo{}
	for _, r := range req.Repos {
		byID[r.ID] = r
	}
	materializer, err := materialize.New(materialize.Options{Repositories: mapToRepos(req.Repos)})
	if err != nil {
		return empty, fmt.Errorf("postgres: unit materializer: %w", err)
	}
	resolver, err := secrets.NewResolver(u.Secrets, u.Secrets.Keys)
	if err != nil {
		return empty, err
	}

	out := worker.Materialized{}
	// values is the private clone set the redaction hook replaces. The hook is
	// what lets the *sink* honour case 12 without internal/worker ever holding
	// a plaintext; the clones are released with the unit.
	var values [][]byte
	// receipts tracks what this call delivered, so a later mount's refusal
	// unwinds them: the unit discards a failed Materialized, which would turn
	// "fail closed" into "fail and leave the value in the tree". Receipt.Cleanup
	// removes the file it created and zeroes the value buffer it aliases.
	var receipts []*materialize.Receipt
	type recorded struct {
		id       int64
		secretID string
		target   string
	}
	var rows []recorded
	// denied counts the in-play mounts the resolver refused to deliver because
	// this profile is not on their allowlist. They are skipped, never journalled:
	// a secret an attempt was never granted is not a materialization that failed.
	var denied int

	fail := func(reason, secretID, slug, delivery, target string) error {
		for _, r := range receipts {
			_ = r.Cleanup(ctx)
		}
		// What an earlier mount recorded stays open until the startup sweep
		// closes it — the row is the finding, and a sweep is the honest closer
		// for a file this call removed without a unit boundary to journal from.
		return u.failMaterialization(ctx, req, reason, secretID, slug, delivery, target)
	}

	// Deliver authorizes a delivery against the unit's repositories by name —
	// a structural check even for env delivery, which writes no file. An env
	// mount names no repository, so it rides on the first checkout of the
	// unit; the event deliberately reports no repository for env delivery,
	// because "which repo was the env var scoped to" has no true answer.
	firstRepo := ""
	if len(req.Repos) > 0 {
		firstRepo = req.Repos[0].Name
	}
	for _, m := range mounts {
		mount := materialize.Mount{
			SecretID: m.SecretID, SecretSlug: m.Slug, DeliveryMode: m.DeliveryMode,
			RelativePath: m.RelativePath, EnvName: m.EnvName, Key: m.Key,
			Lifecycle: m.Lifecycle, AllowTracked: m.AllowTracked,
			RepositoryName: firstRepo,
			// The unit's own previous materialization is the only thing this may
			// land on besides an absent file (contract § 4.2 step 3: a second
			// turn in one conversation re-materializes its own mount).
			AllowOverwrite: true,
		}
		if m.Revoked {
			// ADR-0018's "the next launch refuses": the mount stays, the value
			// never lands, and the reason names revocation rather than shape.
			return out, fail(events.MaterializationRevokedVersion, m.SecretID, m.Slug, m.DeliveryMode,
				orRelative(m.RelativePath, m.EnvName))
		}
		if m.RepositoryID != "" {
			r, ok := byID[m.RepositoryID]
			if !ok {
				return out, fail(events.MaterializationBadShape, m.SecretID, m.Slug, m.DeliveryMode,
					orRelative(m.RelativePath, m.EnvName))
			}
			mount.RepositoryName = r.Name
		}
		// The role axis was answered at declaration time (a maintainer wrote
		// the mount through the gated API); the profile axis is the resolver's.
		// This assertion is exactly what the seam's `Authorized` field means.
		res, err := resolver.Resolve(ctx, secrets.Attempt{
			ProjectID: req.ProjectID, OrganizationID: req.OrganizationID,
			AgentProfileID: req.AgentProfileID, WorkspaceID: req.WorkspaceID,
			TurnID: req.TurnID, WorkerID: req.WorkerID, Authorized: true,
		}, m.SecretID, 0)
		if err != nil {
			if scope == worker.LifecycleNodeAttempt && errors.Is(err, secrets.ErrNotAuthorized) {
				// The node asked for it, the profile was not granted it. The mount
				// is not this attempt's to have, so it is delivered to nobody and
				// the attempt is not failed for it (ADR-0018 D3's allowlist is a
				// grant, and `secret.materialization_failed` is a finding about a
				// delivery that was supposed to happen). procexec.go already skips
				// this sentinel; agentturn.go does the same.
				denied++
				continue
			}
			return out, fail(resolveFailureReason(err), m.SecretID, m.Slug, m.DeliveryMode,
				orRelative(m.RelativePath, m.EnvName))
		}
		// The receipt's Version comes from the mount, and only the resolver
		// knows which version it actually opened (a mount pins none).
		mount.Version = res.Version
		// One clone, held only by the redaction hook below.
		clone := append([]byte(nil), res.Value.Bytes()...)
		receipt, err := materializer.Deliver(ctx, &materialize.Delivery{
			Mount: mount, Value: clone,
		})
		if err != nil {
			clear(clone)
			return out, fail(deliveryFailureReason(err), m.SecretID, m.Slug, m.DeliveryMode,
				orRelative(m.RelativePath, m.EnvName))
		}
		receipts = append(receipts, receipt)
		// The resolver's own buffer is no longer needed by anything: the file
		// is written, the clone is held.
		res.Value.Zero()
		meta := receipt.Meta()
		file := receipt.Target // the absolute path the materializer just wrote
		switch receipt.DeliveryMode {
		case "env":
			out.Env = append(out.Env, receipt.EnvName+"="+strings.TrimSuffix(string(receipt.EnvValue), "\n"))
			// env delivery reports no repository: it was never scoped to one.
			meta.RepositoryName = ""
		default:
			out.Files = append(out.Files, file)
		}
		if req.ExtraExclusions != nil && receipt.RelativePath != "" {
			*req.ExtraExclusions = append(*req.ExtraExclusions, receipt.RelativePath)
		}
		values = append(values, clone)
		// Target is repo-qualified ("<name>/<rel>"), not the bare relative path
		// the contract prose names: secret_materializations.target has to be
		// resolvable by the startup sweep, which knows the workspace root but
		// not which checkout a path-less `secrets/token` sat in. The audit view
		// reads identically either way; recorded in the contract sync.
		target := receipt.EnvName
		if receipt.DeliveryMode != "env" {
			target = receipt.RepositoryName + "/" + receipt.RelativePath
		}
		id, err := u.Secrets.RecordMaterialization(ctx, NewSecretMaterialization{
			SecretID: receipt.SecretID, SecretVersion: receipt.Version,
			OrganizationID: req.OrganizationID, ProjectID: req.ProjectID,
			WorkspaceID: req.WorkspaceID, TurnID: req.TurnID, WorkerID: req.WorkerID,
			AttemptID:    attemptID,
			DeliveryMode: receipt.DeliveryMode, Target: target, FileMode: receipt.FileMode,
		}, events.SecretMaterializedPayload{
			SecretID: receipt.SecretID, ProjectID: req.ProjectID, Slug: receipt.SecretSlug,
			Version: receipt.Version, DeliveryMode: receipt.DeliveryMode,
			RepositoryName: meta.RepositoryName, RelativePath: meta.RelativePath,
			EnvName: meta.EnvName, Lifecycle: meta.Lifecycle, Mode: meta.Mode,
			WorkspaceID: req.WorkspaceID, TurnID: req.TurnID,
			PolicyDigest: req.PolicyDigest,
		})
		if err != nil {
			// The file exists and the row did not: the unit must not launch on
			// an unrecorded value, because nothing would then promise its
			// removal. Remove everything this call delivered, then refuse.
			for _, r := range receipts {
				_ = r.Cleanup(ctx)
			}
			return out, fmt.Errorf("postgres: record materialization of %s: %w", receipt.SecretSlug, err)
		}
		rows = append(rows, recorded{id: id, secretID: receipt.SecretID, target: target})
	}

	captured := rows
	if len(receipts) == 0 && denied > 0 && scope == worker.LifecycleNodeAttempt {
		// Every mount in play was refused for authorization: the honest answer to
		// the unit is the resolver's own refusal (wrapped, so errors.Is finds it),
		// not a Materialized that would promise cleanup for nothing. Nothing was
		// written and no row was recorded, so there is nothing to unwind here.
		return empty, fmt.Errorf(
			"postgres: no node_attempt mount in play is authorized for this attempt: %w", secrets.ErrNotAuthorized)
	}
	out.Redact = redactionHook(values)
	out.Done = func(doneCtx context.Context) error {
		for _, r := range captured {
			if err := u.Secrets.CloseMaterialization(doneCtx, r.id, req, r.secretID, r.target); err != nil {
				return err
			}
		}
		return nil
	}
	return out, nil
}

// ReposForWorkspace implements worker.AttemptSecrets: the checkouts an
// attempt's mounts may target, read from the run workspace § 4 step 3 prepared.
//
// The turn unit does not need this (it prepared the tree itself and has the rows
// in hand); an agent.acp attempt consumes someone else's preparation, and a
// materializer that guessed the checkout paths from the layout would be writing
// secrets into directories the database never authorized. The repository *name*
// comes from `repositories`, not the path basename: a mount's repository_name is
// matched against it, and a renamed repository must not silently move a secret.
func (u *UnitSecrets) ReposForWorkspace(ctx context.Context, workspaceID string) ([]worker.MaterializeRepo, error) {
	if u == nil || u.Secrets == nil || u.Secrets.Pool == nil {
		return nil, errors.New("postgres: unit secrets materializer is not wired")
	}
	if workspaceID == "" {
		return nil, nil // no run workspace, nothing authorized
	}
	rows, err := u.Secrets.Pool.Query(ctx, `
		SELECT wr.repository_id::text, r.name, wr.checkout_path, wr.mirror_path
		FROM workspace_repos wr
		JOIN repositories r ON r.id = wr.repository_id
		WHERE wr.workspace_id = $1::uuid
		ORDER BY r.name, wr.repository_id`, prjCleanUUID(workspaceID))
	if err != nil {
		return nil, fmt.Errorf("postgres: attempt repos for workspace %s: %w", workspaceID, err)
	}
	defer rows.Close()
	var out []worker.MaterializeRepo
	for rows.Next() {
		var r worker.MaterializeRepo
		if err := rows.Scan(&r.ID, &r.Name, &r.CheckoutPath, &r.MirrorPath); err != nil {
			return nil, fmt.Errorf("postgres: scan attempt repo: %w", err)
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// failMaterialization journals the refusal and returns the error the unit
// fails the turn with. The event carries the enum reason and the rejected
// relative target only — never a host path, never the message of the git or
// resolver error behind it.
func (u *UnitSecrets) failMaterialization(ctx context.Context, req worker.MaterializeRequest, reason, secretID, slug, delivery, target string) error {
	err := u.Secrets.inTx(ctx, func(tx pgx.Tx) error {
		return secUnitAppendScopeTx(ctx, tx, req.OrganizationID, req.ProjectID, req.ConversationID, req.WorkerID, req.AttemptID,
			events.TypeSecretMaterializationFailed, events.SecretMaterializationFailedPayload{
				SecretID: secretID, ProjectID: req.ProjectID, Slug: slug,
				DeliveryMode: delivery, Target: target, Reason: reason,
				WorkspaceID: req.WorkspaceID, TurnID: req.TurnID, ChildStarted: false,
			})
	})
	if err != nil {
		return fmt.Errorf("postgres: journal secret.materialization_failed: %w", err)
	}
	return fmt.Errorf("postgres: secret materialization refused (%s): %w", reason, errUnitSecretRefused)
}

// errUnitSecretRefused marks the class "a mount was refused" on the unit's
// error path; the detail lives in the journal, not in the message, because the
// message ends up in turn-failure text that operators paste into issues.
var errUnitSecretRefused = errors.New("secret materialization refused")

// CloseMaterialization closes one materialization row and journals
// secret.removed in the same transaction: "cleanup happened" and "the journal
// says cleanup happened" must not be two states a crash can split.
func (s *SecretStore) CloseMaterialization(ctx context.Context, id int64, req worker.MaterializeRequest, secretID, target string) error {
	return s.inTx(ctx, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `
			UPDATE secret_materializations SET cleaned_at = now(), cleaned_by = 'worker'
			 WHERE id = $1 AND cleaned_at IS NULL`, id); err != nil {
			return fmt.Errorf("postgres: close materialization %d: %w", id, err)
		}
		return secUnitAppendScopeTx(ctx, tx, req.OrganizationID, req.ProjectID, req.ConversationID, req.WorkerID, req.AttemptID,
			events.TypeSecretRemoved, events.SecretRemovedPayload{
				SecretID: secretID, ProjectID: req.ProjectID, Target: target,
				WorkspaceID: req.WorkspaceID, TurnID: req.TurnID, CleanedBy: "worker",
			})
	})
}

// secUnitAppendTx is wspAppendTx with an explicit actor. The workspace-scoped
// helper reads the actor from a transaction-local GUC which nothing on the
// worker's connections sets; a secret event naming "system" as its actor would
// be a half-truth, and these are the audit events 12-test-strategy case 12
// reads.
func secUnitAppendTx(ctx context.Context, tx pgx.Tx, organizationID, projectID, conversationID, workerID, eventType string, payload any) error {
	return secUnitAppendScopeTx(ctx, tx, organizationID, projectID, conversationID, workerID, "", eventType, payload)
}

// secUnitAppendScopeTx is secUnitAppendTx with the M4 attempt correlation
// filled in (contract § 3: a worker row that touches an attempt names it on the
// journal row, not only in the payload). An empty attempt id — every M2/M3 turn
// delivery — writes exactly the row the old helper wrote.
func secUnitAppendScopeTx(ctx context.Context, tx pgx.Tx, organizationID, projectID, conversationID, workerID, attemptID, eventType string, payload any) error {
	if eventType == "" {
		return errors.New("postgres: unit event requires a type")
	}
	raw, err := prjPayloadJSON(payload)
	if err != nil {
		return err
	}
	if err := LockEventJournal(ctx, tx, projectID, organizationID); err != nil {
		return err
	}
	actor := workerID
	if actor == "" {
		actor = "system"
	}
	_, err = tx.Exec(ctx, `
		INSERT INTO domain_events
			(type, organization_id, project_id, conversation_id, actor_kind, actor_id, attempt_id, payload)
		VALUES ($1, $2::uuid, NULLIF($3,'')::uuid, NULLIF($4,'')::uuid, 'worker',
		        $5, NULLIF($6,'')::uuid, $7::jsonb)`,
		eventType, organizationID, prjCleanUUID(projectID), prjCleanUUID(conversationID), actor, attemptID, raw)
	if err != nil {
		return fmt.Errorf("postgres: append %s: %w", eventType, err)
	}
	return nil
}

// secUnitAppendScopeTx is secUnitAppendTx with the M4 attempt correlation
// filled in (contract § 3: a worker row that touches an attempt names it on the
// journal row, not only in the payload). An empty attempt id — every M2/M3 turn
// delivery — writes exactly the row the old helper wrote.
// deliveryFailureReason maps a materialize error onto the event enum. A
// Refusal carries its own value; an I/O or git failure has no enum to claim,
// and bad_shape is the honest "the write did not happen for a reason this
// schema cannot name" rather than a wrong precise one.
func deliveryFailureReason(err error) string {
	if r := materialize.RefusalReason(err); r != "" {
		return r
	}
	return events.MaterializationBadShape
}

// resolveFailureReason maps a resolver refusal: revocation is its own case
// (the "next launch refuses" clause), an unreadable keyring is its own, and
// everything else is reported as bad_shape — a shape the mount should never
// have reached — rather than inventing a fifth kind of failure.
func resolveFailureReason(err error) string {
	switch {
	case errors.Is(err, secrets.ErrRevoked):
		return events.MaterializationRevokedVersion
	case errors.Is(err, secrets.ErrUnknownKeyID), errors.Is(err, secrets.ErrKeyringUnreadable),
		errors.Is(err, secrets.ErrDecrypt):
		return events.MaterializationKeyringUnreadable
	case errors.Is(err, secrets.ErrDeliveryUnsupported):
		return events.MaterializationBrokerUnsupported
	default:
		return events.MaterializationBadShape
	}
}

// redactionHook replaces every occurrence of any of these values — the whole
// value, each line of it, and each `KEY=value` right-hand side inside it, so a
// transcript that echoes one entry of a dotenv-shaped secret is still caught —
// with the marker, counting replacements. It never reveals which value hit.
func redactionHook(values [][]byte) func(string) (string, int) {
	if len(values) == 0 {
		return nil
	}
	needles := make([]string, 0, len(values)*4)
	seen := map[string]bool{}
	add := func(s string) {
		if len(s) >= 8 && !seen[s] {
			seen[s] = true
			needles = append(needles, s)
		}
	}
	for _, v := range values {
		full := strings.TrimRight(string(v), "\r\n")
		add(full)
		for _, line := range strings.Split(full, "\n") {
			line = strings.TrimSpace(strings.TrimSuffix(line, "\r"))
			add(line)
			if _, value, ok := strings.Cut(line, "="); ok {
				add(strings.Trim(value, `"'`))
			}
		}
	}
	return func(text string) (string, int) {
		count := 0
		for _, needle := range needles {
			if !strings.Contains(text, needle) {
				continue
			}
			parts := strings.Split(text, needle)
			text = strings.Join(parts, "[REDACTED]")
			count += len(parts) - 1
		}
		return text, count
	}
}

func mapToRepos(rows []worker.MaterializeRepo) []materialize.Repository {
	out := make([]materialize.Repository, 0, len(rows))
	for _, r := range rows {
		out = append(out, materialize.Repository{Name: r.Name, Path: r.CheckoutPath, MirrorPath: r.MirrorPath})
	}
	return out
}

func orRelative(rel, env string) string {
	if rel != "" {
		return rel
	}
	return env
}

// SweepUncleaned closes the secret_materializations rows this worker left
// uncleaned by an ungraceful death: the file is removed (resolved under the
// recorded workspace root) and the row closes with cleaned_by='startup_sweep'
// plus a secret.removed event naming the sweep — ADR-0018 D1's "cleanup works
// when nothing crashes" clause, made observable.
//
// It runs *before* the worker claims any turn: a value a dead worker left
// behind must not outlive the restart by however long the claim loop takes to
// notice it. Rows whose workspace row is already gone are closed too — the
// file path cannot be reconstructed after a release, and leaving the row open
// forever teaches nobody anything.
func (u *UnitSecrets) SweepUncleaned(ctx context.Context, workerID string) (int, error) {
	if u == nil || u.Secrets == nil {
		return 0, errors.New("postgres: unit secrets materializer is not wired")
	}
	rows, err := u.Secrets.UncleanedMaterializations(ctx, "")
	if err != nil {
		return 0, err
	}
	swept := 0
	for _, r := range rows {
		if r.WorkerID != workerID || r.DeliveryMode == "env" {
			continue // another worker's row, or nothing on disk to remove
		}
		root, found, err := u.workspaceRootFor(ctx, r.WorkspaceID)
		if err != nil {
			return swept, err
		}
		if found && root != "" {
			// target is "<repo>/<rel>"; the file sits under <root>/repos/.
			path := filepath.Join(root, "repos", filepath.FromSlash(r.Target))
			if err := removeUnderRoot(path, root); err != nil {
				// The finding stands: an unremovable secret is exactly what the
				// row must keep saying.
				return swept, fmt.Errorf("postgres: sweep could not remove a materialized secret: %w", err)
			}
		}
		org, err := u.organizationOf(ctx, r.ProjectID)
		if err != nil {
			return swept, err
		}
		if err := u.Secrets.inTx(ctx, func(tx pgx.Tx) error {
			if _, err := tx.Exec(ctx, `
				UPDATE secret_materializations SET cleaned_at = now(), cleaned_by = 'startup_sweep'
				 WHERE id = $1 AND cleaned_at IS NULL`, r.ID); err != nil {
				return fmt.Errorf("postgres: sweep close materialization %d: %w", r.ID, err)
			}
			return secUnitAppendScopeTx(ctx, tx, org, r.ProjectID, "", workerID, r.AttemptID,
				events.TypeSecretRemoved, events.SecretRemovedPayload{
					SecretID: r.SecretID, ProjectID: r.ProjectID, Target: r.Target,
					WorkspaceID: r.WorkspaceID, TurnID: r.TurnID, CleanedBy: "startup_sweep",
				})
		}); err != nil {
			return swept, err
		}
		swept++
	}
	return swept, nil
}

// workspaceRootFor reads the *agent* root of a live workspace row: the only
// path prefix a file recorded against this workspace could live under.
func (u *UnitSecrets) workspaceRootFor(ctx context.Context, workspaceID string) (string, bool, error) {
	if workspaceID == "" {
		return "", false, nil
	}
	var root string
	err := u.Secrets.Pool.QueryRow(ctx, `
		SELECT agent_root FROM workspaces WHERE id = $1::uuid`,
		prjCleanUUID(workspaceID)).Scan(&root)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", false, nil
	}
	if err != nil {
		return "", false, fmt.Errorf("postgres: workspace root for sweep: %w", err)
	}
	return root, true, nil
}

// organizationOf resolves the event scope for a project: domain_events wants
// the organization, and a sweep row carries only the project.
func (u *UnitSecrets) organizationOf(ctx context.Context, projectID string) (string, error) {
	var org string
	err := u.Secrets.Pool.QueryRow(ctx,
		`SELECT organization_id::text FROM projects WHERE id = $1::uuid`, prjCleanUUID(projectID)).Scan(&org)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", nil // the project is gone; the event has no scope to claim
	}
	if err != nil {
		return "", fmt.Errorf("postgres: organization for sweep: %w", err)
	}
	return org, nil
}

// removeUnderRoot removes one file and refuses anything that escaped its
// workspace root — the sweep deletes paths out of the database, and "out of
// the database" is exactly where a planted row would put an os.Remove. The
// check is literal: the target was written by this same code as a regular
// file, and a symlink standing where it was written is a finding, not a path
// to follow.
func removeUnderRoot(path, root string) error {
	clean := filepath.Clean(path)
	if !strings.HasPrefix(clean, filepath.Clean(root)+string(filepath.Separator)) {
		return fmt.Errorf("postgres: sweep target %q escapes %q", path, root)
	}
	info, err := os.Lstat(clean)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() {
		return fmt.Errorf("postgres: sweep target %q is not a regular file", path)
	}
	return os.Remove(clean)
}
