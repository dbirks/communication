package postgres

// RunSecretValues is contract § 4 step 9's secret scan for `artifact.publish`.
//
// The threat it closes: an `agent.acp`/`process.exec` attempt of a run is handed
// its `node_attempt` mounts (ADR-0018 D4, § 4 step 4), one of them in `env`
// mode, and the process echoes the value into its outputs. A later
// `artifact.publish` node with `from.mode: output_json` copies those outputs
// into a published artifact — evidence, browser-readable, permanently in the
// byte backend. M3's redactor cannot help: `Materialized.Redact`
// (worker/seams.go) knows only the values *its own unit* materialized, and the
// publishing attempt materialized nothing.
//
// So the scan asks the ledger instead of the unit. `secret_materializations`
// records every delivery — `env` included (unit_secrets.go records a row for
// both arms, with `attempt_id` set for the node_attempt lifecycle since
// 431bcb7) — so "which values did anything in this run ever hold" is a join,
// not a guess. Resolving the run's attempts covers env deliveries completely,
// which is why this file deliberately does NOT also resolve every
// `node_attempt` mount the project declares:
//
//   - a declared-but-never-delivered mount means no process ever held that
//     value, so it cannot be in the payload; scanning for it buys nothing;
//   - resolving it would require asserting authorization for a delivery that
//     never happened, and a mount whose profile was later dropped from the
//     allowlist (or whose version was revoked) would then fail every publish in
//     the run over a value the run never had — fail-closed turned into
//     fail-randomly;
//   - and it would widen plaintext exposure past the run's own authorizations,
//     which is the opposite of ADR-0018 D3.
//
// The ledger is the narrower, truer set. A value the ledger does not name was
// not delivered to this run, and a value it does name is scanned for.
//
// Values are never logged and never persisted: they are decrypted into clones
// held by the returned hook, and ArtifactPublishSecretScan zeroes them the
// moment the publish it prepared returns.

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/dbirks/communication/internal/secrets"
	"github.com/dbirks/communication/internal/worker"
)

// RunSecretValues answers "which secret values did this run hold" for the
// artifact.publish scan. It resolves through the same secrets.Resolver +
// keyring path the materializer uses — one path from ciphertext to plaintext in
// this process, so the scan cannot become a second, weaker one.
type RunSecretValues struct {
	Pool *pgxpool.Pool
	// Secrets is the version source plus the keyring (normally the *SecretStore
	// the worker already built for materialization). A nil Keys is refused by
	// secrets.NewResolver, so a keyring-less worker gets a failed attempt rather
	// than a scan that quietly saw nothing.
	Secrets *SecretStore
}

// runSecretRef is one (secret, version) pair the ledger says reached an attempt
// of a run, plus the profile that was authorized to hold it when it did. The
// profile is reconstructed from the attempt's own conversation (the stamped
// turn's, or the attempt's): it is the identity that passed the allowlist axis
// at materialization time, and a delivery whose profile cannot be reconstructed
// resolves to "", which the resolver denies. That denial fails the publish
// attempt rather than skipping the scan — fail closed, never unscanned.
type runSecretRef struct {
	secretID  string
	version   int
	profileID string
}

// runScope is the run's own tenant pair: the resolver's scope axis is checked
// against the run, never against whatever the caller happens to assert.
type runScope struct {
	organizationID string
	projectID      string
}

// ListForRun returns the run's materialized (secret, version) pairs with the
// run's own org/project ids. The correlation is the ledger's, not the caller's
// claim: `attempts.run_id` is the authority on membership (00005's composite FK
// makes it agree with node_executions.run_id), and `m.project_id = r.project_id`
// means a row that somehow crossed projects yields nothing rather than another
// project's value.
//
// An unmaterialized run — no mounts in the project, or an exit pipeline whose
// upstreams held nothing — returns an empty slice: a fact about the run, not a
// failure.
func (v *RunSecretValues) ListForRun(ctx context.Context, runID string) ([]runSecretRef, runScope, error) {
	none := runScope{}
	if v == nil || v.Pool == nil {
		return nil, none, errors.New("postgres: run secret scanner has no pool")
	}
	if !prjValidUUID(runID) {
		return nil, none, errors.New("postgres: run secret scanner needs a run id")
	}
	rows, err := v.Pool.Query(ctx, `
		SELECT r.organization_id::text, r.project_id::text,
		       m.secret_id::text, m.secret_version,
		       COALESCE(cv.agent_profile_id::text, '')
		FROM secret_materializations m
		JOIN attempts a             ON a.id = m.attempt_id
		JOIN runs r                 ON r.id = a.run_id AND m.project_id = r.project_id
		LEFT JOIN conversation_turns t ON t.id = COALESCE(m.turn_id, a.turn_id)
		LEFT JOIN conversations cv  ON cv.id = COALESCE(a.conversation_id, t.conversation_id)
		WHERE a.run_id = $1::uuid
		ORDER BY m.secret_id, m.secret_version`, runID)
	if err != nil {
		return nil, none, fmt.Errorf("postgres: list run materializations: %w", err)
	}
	defer rows.Close()

	var (
		refs  []runSecretRef
		orgID string
		prjID string
	)
	seen := map[[2]string]bool{}
	for rows.Next() {
		var ref runSecretRef
		if err := rows.Scan(&orgID, &prjID, &ref.secretID, &ref.version, &ref.profileID); err != nil {
			return nil, none, fmt.Errorf("postgres: scan run materialization: %w", err)
		}
		// Same secret, same version, same profile: one resolve. Retry and
		// fan-out re-materialize the same value over and over.
		key := [2]string{ref.secretID, fmt.Sprint(ref.version) + "\x00" + ref.profileID}
		if seen[key] {
			continue
		}
		seen[key] = true
		refs = append(refs, ref)
	}
	if err := rows.Err(); err != nil {
		return nil, none, fmt.Errorf("postgres: read run materializations: %w", err)
	}
	if len(refs) > 0 && prjID == "" {
		// Unreachable given the join; the guard is here so a scanner can never
		// be talked into an unscoped resolve by a row shape that changed.
		return nil, none, errors.New("postgres: run materialization row names no project")
	}
	return refs, runScope{organizationID: orgID, projectID: prjID}, nil
}

// Values resolves the plaintext of everything the run held, in the ledger's
// order. Every caller is responsible for wiping what it gets: the returned
// slices are the only copies, and ArtifactPublishSecretScan clears them when the
// publish returns.
//
// Any refusal is returned as an error and the partially-resolved set is wiped
// first, so a run with one unreadable secret publishes nothing at all rather
// than publishing a scan over the subset that happened to decrypt (ADR-0020 D4:
// "the scanner is broken" must stay distinguishable from "the scanner saw
// nothing", and here it would be worse — it would be silently absent).
func (v *RunSecretValues) Values(ctx context.Context, runID string) ([][]byte, error) {
	refs, scope, err := v.ListForRun(ctx, runID)
	if err != nil {
		return nil, err
	}
	out := make([][]byte, 0, len(refs))
	wipe := func() {
		for _, clone := range out {
			clear(clone)
		}
	}
	if len(refs) == 0 {
		return nil, nil
	}
	if v.Secrets == nil || v.Secrets.Keys == nil {
		wipe()
		return nil, errors.New("postgres: run secret scanner has no keyring")
	}
	resolver, err := secrets.NewResolver(v.Secrets, v.Secrets.Keys)
	if err != nil {
		wipe()
		return nil, err
	}
	for _, ref := range refs {
		// The authorization assertion means what it means in unit_secrets.go:
		// the role question was answered when the mount was declared through the
		// gated API, and the ledger row proves this exact secret version was
		// already delivered to an attempt of this run under this profile. This
		// call re-opens a value that already exists in the run's own history; it
		// authorizes nothing new. The profile id travels so the allowlist axis is
		// evaluated under the same identity that passed it the first time — and a
		// profile since dropped from the allowlist fails here, which is the
		// attempt failing rather than an unscanned artifact shipping.
		res, err := resolver.Resolve(ctx, secrets.Attempt{
			ProjectID: scope.projectID, OrganizationID: scope.organizationID,
			AgentProfileID: ref.profileID, Authorized: true,
		}, ref.secretID, ref.version)
		if err != nil {
			wipe()
			// resolveFailureReason's sentinel class is the caller's whole
			// vocabulary: a resolver message can name a slug, and the attempt
			// detail is browser-visible.
			return nil, fmt.Errorf("postgres: resolve run secret %s for the artifact scan: %s",
				ref.secretID, resolveFailureReason(err))
		}
		clone := append([]byte(nil), res.Value.Bytes()...)
		// The resolver's own buffer is done with: the clone is the only copy.
		res.Value.Zero()
		out = append(out, clone)
	}
	return out, nil
}

// Redactor returns § 4 step 9's scan for one run: the hook plus its count. A nil
// hook means the run holds no secret values at all, which the executor reports
// honestly as redaction_count 0 (ADR-0020 D4). The values live in the closure
// until wipe runs, so callers hold it only as long as the publish.
func (v *RunSecretValues) Redactor(ctx context.Context, runID string) (redact func(string) (string, int), wipe func(), err error) {
	values, err := v.Values(ctx, runID)
	if err != nil {
		return nil, nil, err
	}
	if len(values) == 0 {
		return nil, func() {}, nil
	}
	hook := redactionHook(values)
	return hook, func() {
		for _, value := range values {
			clear(value)
		}
	}, nil
}

// ArtifactPublishSecretScan is the artifact.publish executor with its run-scoped
// secret scan attached (contract § 4 step 9: the scan runs *before* Put).
//
// It wraps rather than configures, because the executor's Redact seam —
// `func(text string) (string, int)` — has no context, no claim and no error
// channel, and a scan that cannot be built must fail the attempt rather than
// report zero. The resolution therefore happens here, where the claim (and the
// run) is known and a refusal can be named with a class, and the inner executor
// is invoked on a per-attempt copy carrying the hook. The value set is wiped
// when that call returns: it outlives neither the scan nor the publish, and the
// only thing the publish produces afterwards is bytes that have been through it.
//
// internal/worker stays free of postgres imports: this file depends on the
// worker's interfaces, never the reverse (AGENTS.md's dependency rule).
type ArtifactPublishSecretScan struct {
	// Publish is the § 4 step 9 executor, wired with its byte backend, fenced
	// row writer and workspace resolver. Its own Redact field is ignored — the
	// hook here is the scan.
	Publish *worker.ArtifactPublish
	// Values is the ledger-backed scanner. Required: an unwired scan is the
	// bug 17ffa32 left behind, and it has to be visible as one.
	Values *RunSecretValues
}

var _ worker.AttemptExecutor = (*ArtifactPublishSecretScan)(nil)

func (s *ArtifactPublishSecretScan) Execute(ctx context.Context, c worker.AttemptClaim, sink worker.AttemptSink) (worker.AttemptResult, error) {
	if s == nil || s.Publish == nil {
		return worker.AttemptResult{Status: worker.AttemptStatusFailed, ErrorClass: worker.ErrorClassInfra,
			Detail: boundedDetail("artifact.publish: the executor is not wired (contract § 4 step 9)")}, nil
	}
	if s.Values == nil {
		return worker.AttemptResult{Status: worker.AttemptStatusFailed, ErrorClass: worker.ErrorClassInfra,
			Detail: boundedDetail("artifact.publish: no run secret scanner is wired on this worker, so the " +
				"§ 4 step 9 scan would be skipped; refusing to publish unscanned output")}, nil
	}
	redact, wipe, err := s.Values.Redactor(ctx, c.RunID)
	if err != nil {
		// The sandbox/secret arm of ADR-0023 § 7: the scan is part of what makes
		// this artifact safe to hold, and it did not run. No Put, no row, no
		// event — and the detail says the scan failed, never what it failed on
		// (a slug or a path is not browser-visible material).
		return worker.AttemptResult{Status: worker.AttemptStatusFailed,
			ErrorClass: worker.ErrorClassSandboxEnforcementFail,
			Detail: boundedDetail("artifact.publish: the run's secret scan could not be built from the " +
				"materialization ledger, so no bytes were put and no artifact row was written " +
				"(contract § 4 step 9): " + err.Error())}, nil
	}
	defer wipe()

	publish := *s.Publish
	publish.Redact = redact
	return publish.Execute(ctx, c, sink)
}

// boundedDetail keeps an attempt detail inside attempts.detail's 512-character
// CHECK (00005) without importing worker's unexported helper.
func boundedDetail(s string) string {
	const max = 512
	if len(s) <= max {
		return s
	}
	return s[:max-1] + "…"
}
