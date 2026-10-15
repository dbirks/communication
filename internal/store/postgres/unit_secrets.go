package postgres

import (
	"context"
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

// unitMount is one declared placement joined with the metadata the resolver
// and the event need. Deliberately no ciphertext columns: the resolver reads
// those through LoadVersion, and this query could not return them to anybody
// who should see them (ADR-0018 D1).
type unitMount struct {
	MountID      string
	SecretID     string
	Slug         string
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

// MountsForUnit is the worker-side mount read: every placement declared for
// the project, with its secret's revocation state. There is no Caller — the
// authorization for this read is *structural*: the caller is a worker that was
// assigned a turn in this project, the mount rows were written through the
// role-gated API (maintainer-only), and the profile-allowlist question is
// answered per delivery by secrets.Resolver, not here.
func (s *SecretStore) MountsForUnit(ctx context.Context, projectID string) ([]unitMount, error) {
	if s == nil || s.Pool == nil {
		return nil, errors.New("postgres: secret store has no pool")
	}
	rows, err := s.Pool.Query(ctx, `
		SELECT m.id::text, m.secret_id::text, sm.slug, sm.purpose, m.delivery_mode,
		       COALESCE(m.repository_id::text, ''), COALESCE(m.relative_path, ''),
		       COALESCE(m.env_name, ''), COALESCE(m.key, ''), m.lifecycle,
		       m.allow_tracked, sm.revoked_at IS NOT NULL
		FROM secret_mounts m
		JOIN secret_metadata sm ON sm.id = m.secret_id
		WHERE m.project_id = $1::uuid
		ORDER BY sm.slug, m.id`, prjCleanUUID(projectID))
	if err != nil {
		return nil, fmt.Errorf("postgres: list unit mounts: %w", err)
	}
	defer rows.Close()
	var out []unitMount
	for rows.Next() {
		var m unitMount
		if err := rows.Scan(&m.MountID, &m.SecretID, &m.Slug, &m.Purpose, &m.DeliveryMode,
			&m.RepositoryID, &m.RelativePath, &m.EnvName, &m.Key, &m.Lifecycle,
			&m.AllowTracked, &m.Revoked); err != nil {
			return nil, fmt.Errorf("postgres: scan unit mount: %w", err)
		}
		out = append(out, m)
	}
	return out, rows.Err()
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
	mounts, err := u.Secrets.MountsForUnit(ctx, req.ProjectID)
	if err != nil {
		return empty, err
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

// failMaterialization journals the refusal and returns the error the unit
// fails the turn with. The event carries the enum reason and the rejected
// relative target only — never a host path, never the message of the git or
// resolver error behind it.
func (u *UnitSecrets) failMaterialization(ctx context.Context, req worker.MaterializeRequest, reason, secretID, slug, delivery, target string) error {
	err := u.Secrets.inTx(ctx, func(tx pgx.Tx) error {
		return secUnitAppendTx(ctx, tx, req.OrganizationID, req.ProjectID, req.ConversationID, req.WorkerID,
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
		return secUnitAppendTx(ctx, tx, req.OrganizationID, req.ProjectID, req.ConversationID, req.WorkerID,
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
			(type, organization_id, project_id, conversation_id, actor_kind, actor_id, payload)
		VALUES ($1, $2::uuid, NULLIF($3,'')::uuid, NULLIF($4,'')::uuid, 'worker',
		        $5, $6::jsonb)`,
		eventType, organizationID, prjCleanUUID(projectID), prjCleanUUID(conversationID), actor, raw)
	if err != nil {
		return fmt.Errorf("postgres: append %s: %w", eventType, err)
	}
	return nil
}

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
			return secUnitAppendTx(ctx, tx, org, r.ProjectID, "", workerID,
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
