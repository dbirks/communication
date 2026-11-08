// The lab launcher knob (docs/compatibility/probes/m4/seed.sh § 7.0):
// COMMUNICATION_LAB_LAUNCHER picks the launcher the lab runs agents on. The
// acceptance workflow sets `pi` (runners have no ~/.claude login — the user
// decision is pi against the LLM collective, ADR-0059); unset keeps the
// historical local behaviour, `claude`.
//
// Launcher `pi` is a NEVER-ASKS launcher (ADR-0069: pi-acp sends no
// session/request_permission), so a pi profile can only honestly run under
// permission_mode `autonomous_within_sandbox` with `sandbox_enforcement`
// `required` — "runs without asking; the sandbox is the boundary". The API
// refuses to write that mode (ADR-0030: create always lands `ask`), so —
// exactly the way seed.sh does it — the only writer is the stack's own
// postgres via this seed upsert. Specs under `pi` create their profile
// through the product dialog (launcher card `pi`), then re-affirm the mode
// here; specs under `claude` never touch this path and stay `ask`.
import { COMPOSE_PROJECT } from "./env.js";
import { execDocker } from "./helpers.js";

/** The launcher the suite runs on; the default keeps local runs unchanged. */
export const LAB_LAUNCHER = process.env.COMMUNICATION_LAB_LAUNCHER ?? "claude";

// The seed.sh guard, in TypeScript: an unknown launcher must fail loudly here
// rather than click a card that does not exist.
if (!["claude", "codex", "pi"].includes(LAB_LAUNCHER)) {
  throw new Error(`COMMUNICATION_LAB_LAUNCHER must be claude, codex or pi, got [${LAB_LAUNCHER}]`);
}

/** True when the lab runs the never-asks pi launcher (ADR-0069). */
export const IS_PI_LAUNCHER = LAB_LAUNCHER === "pi";

/** The New-profile dialog's launcher-card testid for the lab launcher. */
export const newProfileCardTestid = () => `new-profile-card-${LAB_LAUNCHER}`;

/**
 * Single-quote escape for the psql literal (same shape as seed.sh's fixed
 * names; a stray quote must break the statement loudly, not the org's rows).
 */
export function sqlQuote(value: string): string {
  if (/\0/.test(value)) throw new Error(`unsafe SQL literal: ${value}`);
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Seed a lab agent profile the way docs/compatibility/probes/m4/seed.sh's
 * seed_profile does: launcher LAB_LAUNCHER, `autonomous_within_sandbox` +
 * `sandbox_enforcement required` under pi (ADR-0069; under claude the
 * prompting modes stay honest, so this helper is only ever called for the
 * never-asks launcher). The upsert is idempotent and re-affirms the columns
 * on every run; the profile row may already exist (created through the
 * product dialog) or not exist at all — either way it ends as the seeded row.
 * Throws when the statement does not report exactly one row written.
 */
export function seedLabPiProfile(name: string, commitGranted = false): void {
  if (!IS_PI_LAUNCHER) {
    throw new Error("seedLabPiProfile is the launcher-pi seed path only");
  }
  // seed.sh's exact shape: the upsert plus a trailing SELECT that names the
  // row back (psql -q prints no command tag, so the id read IS the proof the
  // write landed). The upsert is idempotent and re-affirms the seeded
  // columns on every run.
  const sql =
    `INSERT INTO agent_profiles (organization_id, name, launcher_id, permission_mode, ` +
    `workspace_mode, sandbox_enforcement, commit_granted) VALUES ((SELECT id FROM organizations ` +
    `WHERE slug = 'default'), ${sqlQuote(name)}, 'pi', 'autonomous_within_sandbox', 'worktree', ` +
    `'required', ${commitGranted ? "true" : "false"}) ` +
    `ON CONFLICT (organization_id, name) DO UPDATE SET launcher_id = EXCLUDED.launcher_id, ` +
    `permission_mode = EXCLUDED.permission_mode, workspace_mode = EXCLUDED.workspace_mode, ` +
    `sandbox_enforcement = EXCLUDED.sandbox_enforcement, commit_granted = EXCLUDED.commit_granted; ` +
    `SELECT id::text FROM agent_profiles WHERE organization_id = (SELECT id FROM organizations ` +
    `WHERE slug = 'default') AND name = ${sqlQuote(name)};`;
  const out = seedSql(sql);
  const profileId = (
    out
      .split(/\r?\n/)
      .filter((line) => line.trim() !== "")
      .pop() ?? ""
  ).trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(profileId)) {
    throw new Error(
      `seed profile ${name}: the upsert did not come back with one uuid, got [${out}]`,
    );
  }
  console.log(
    `seeded agent profile ${name} -> ${profileId} ` +
      `(launcher pi, permission_mode=autonomous_within_sandbox)`,
  );
}

/**
 * Run one SQL statement through the stack's own postgres (seed.sh's path).
 *
 * Exported because a lab journey that needs a row the PRODUCT has no route for
 * must go through this one door rather than shell out to docker a second time
 * (the m4 seed's own writer, the same sudo fallback). `-tAqc` prints rows only
 * — no headers, no tags — so the return value is the statement's own output,
 * trimmed.
 *
 * The postgres container is found by COMPOSE LABELS, never by
 * `docker compose exec`: compose interpolates EVERY layer on EVERY
 * subcommand, and `compose.real.yml` marks the gateway keys REQUIRED
 * (`${LLMC_API_KEY:?}`) — a verification job that starts the lab but does not
 * export the key to the Playwright process therefore died at config render,
 * before psql ever ran. `docker ps`/`docker exec` against the running
 * container need no render and touch no secret.
 */
export function seedSql(sql: string): string {
  return seedSqlInProject(sql, COMPOSE_PROJECT);
}

/**
 * `seedSql` for a caller whose stack is a DIFFERENT compose project than the
 * CI e2e default (the emulator loop drives the `communication-m4` lab).
 * Same labels, same `psql -tAqc` contract, same one door.
 */
export function seedSqlInProject(sql: string, composeProject: string): string {
  const psOut = execDocker([
    "ps",
    "-q",
    "--filter",
    `label=com.docker.compose.project=${composeProject}`,
    "--filter",
    "label=com.docker.compose.service=postgres",
  ])
    .toString("utf8")
    .split(/\s+/)
    .filter(Boolean);
  if (psOut.length === 0) {
    throw new Error(
      `seed sql: no running postgres container for compose project ` +
        `${composeProject} (label com.docker.compose.project=${composeProject}, ` +
        `com.docker.compose.service=postgres) — is that stack up?`,
    );
  }
  const container = psOut[0]!;
  const args = [
    "exec",
    "-i",
    container,
    "psql",
    "-U",
    "communication",
    "-d",
    "communication",
    "-tAqc",
    sql,
  ];
  try {
    return execDocker(args).toString("utf8").trim();
  } catch (error) {
    // Name the DATABASE's reason first: psql writes its ERROR/WARNING lines to
    // stderr, and the raw execFileSync message buries them under the full
    // command line (which here is the whole seed). Stderr first (600 chars),
    // then a short SQL echo — a future defect names the check that fired.
    const stderr = bufferToString((error as { stderr?: unknown }).stderr).slice(0, 600);
    const stdout = bufferToString((error as { stdout?: unknown }).stdout).slice(0, 300);
    throw new Error(
      `seed sql failed (postgres container ${container}, compose project ` +
        `${composeProject})\npsql stderr: ${stderr || "(empty)"}` +
        (stdout ? `\npsql stdout: ${stdout}` : "") +
        `\nsql: ${sql.slice(0, 200)}${sql.length > 200 ? " …" : ""}`,
    );
  }
}

function bufferToString(value: unknown): string {
  if (Buffer.isBuffer(value)) return value.toString("utf8").trim();
  if (typeof value === "string") return value.trim();
  return value === undefined ? "" : String(value);
}
