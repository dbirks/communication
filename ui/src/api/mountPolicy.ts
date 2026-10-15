/**
 * The pure rules behind the secret-mount form, so a `.env` target can be
 * rejected before it is ever posted and so the server's refusal reasons can be
 * said in the words `05-workspaces-security-secrets.md` and
 * `docs/m3-contract.md` §3 use.
 *
 * Why the client checks at all, when the server checks twice (`mounts_shape`
 * CHECK + materializer + `git ls-files` + the real filesystem): the mount form
 * is where a person types a path. Refusing locally is an INPUT-A error line, not
 * a round-trip that ends in `secret.materialization_failed` at launch time —
 * that event is the *last* line of defence (`05`: "only allow relative paths
 * under an authorized workspace checkout; validate after resolving symlinks"),
 * and a UI that lets an obviously escaping path through has already failed the
 * human. Nothing here is a security boundary: the worker's refusal is.
 */

/** A refused mount target, with the reason the UI shows under the field. */
export interface PathVerdict {
  ok: boolean;
  /** Field-level message (INPUT-A error), or null when the value is acceptable. */
  message: string | null;
}

/**
 * `.env` target path policy: relative to a repository checkout, no absolute
 * path, no traversal, no empty or `.` segment, and never the checkout root
 * itself. Mirrors `SecretMount.relative_path` in `api/openapi.yaml`.
 */
export function validateMountPath(value: string): PathVerdict {
  const path = (value ?? "").trim();
  if (!path) return { ok: false, message: "a target path is required" };
  if (path.startsWith("/")) {
    return { ok: false, message: "absolute path refused: a target is relative to its checkout" };
  }
  if (/^[a-zA-Z]:[\\/]/.test(path)) {
    return { ok: false, message: "absolute path refused: a target is relative to its checkout" };
  }
  if (path.includes("\\"))
    return { ok: false, message: "backslashes are not a path separator here" };
  const segments = path.split("/");
  for (const segment of segments) {
    if (segment === "")
      return { ok: false, message: "empty path segment (check for a trailing /)" };
    if (segment === "..")
      return { ok: false, message: "path not in workspace: '..' leaves the checkout" };
    if (segment === ".")
      return { ok: false, message: "'.' is not a path segment a policy can name" };
  }
  return { ok: true, message: null };
}

/** Env-var name policy: it names a variable, never a path (`mounts_shape`). */
export function validateEnvName(value: string): PathVerdict {
  const name = (value ?? "").trim();
  if (!name) return { ok: false, message: "a variable name is required" };
  if (name.includes("/") || name.includes("=")) {
    return { ok: false, message: "an env name is a variable, not a path or an assignment" };
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    return { ok: false, message: "must be LETTERS, DIGITS or _ and not start with a digit" };
  }
  return { ok: true, message: null };
}

/** Secret slug policy, from `SecretCreate.slug`'s pattern in the OpenAPI spec. */
export function validateSecretSlug(value: string): PathVerdict {
  const slug = (value ?? "").trim();
  if (!slug) return { ok: false, message: "a slug is required" };
  if (slug.length > 128) return { ok: false, message: "at most 128 characters" };
  if (!/^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$/.test(slug)) {
    return {
      ok: false,
      message:
        "lowercase letters, digits, '.', '_' or '-', starting and ending with a letter or digit",
    };
  }
  return { ok: true, message: null };
}

/**
 * Copy for every `secret.materialization_failed` reason the worker can report
 * (`docs/m3-contract.md` §3). Quoting the server's enum rather than inventing
 * prose is the point: the reason *is* the diagnosis, and a mount form that says
 * "something went wrong" would leave a maintainer guessing which of ten
 * distinct refusals they just hit.
 */
export const MATERIALIZATION_REASON_COPY: Record<string, string> = {
  path_escape: "the resolved target escaped the authorized checkout",
  absolute_path: "the target was absolute, which materialization refuses outright",
  bad_shape: "the target's shape violated the mount policy (`..`, empty or leading segment)",
  tracked_target:
    "the target is tracked in git: nothing overwrites a tracked file without the explicit policy exception",
  exists: "a file already sits at that target, and overwriting it is not this path's job",
  keyring_unreadable: "the worker could not read the master key, so it wrote nothing",
  revoked_version: "the secret (or the version pinned) is revoked, so no unit may receive it",
  broker_unsupported: "integration_broker delivery is declared but not implemented in M3",
  symlink_parent: "a parent directory is a symlink, and a symlink escape is never followed",
  mirror_writable: "the shared mirror would have been writable, which no launch may grant",
};

/** Words for a materialization-failure reason, degrading to the raw enum. */
export function materializationReasonCopy(reason: string): string {
  return MATERIALIZATION_REASON_COPY[reason] ?? `refused for an unlisted reason (${reason})`;
}

/**
 * The `.env` rules a maintainer is agreeing to when they declare a mount
 * (`05` "Materialized `.env` support" contract, verbatim in substance). Always
 * shown: a form whose warnings appear only after a failure teaches nothing.
 */
export const ENV_FILE_POLICY_WARNINGS: readonly string[] = [
  "Written 0600, owner-only, created atomically — and refused if the target is tracked.",
  "Materialized paths are excluded from git status, diffs, checkpoints and artifacts.",
  "Removed when the unit ends; rotated and re-materialized on retry.",
  "No generated `.env` content ever appears in conversation logs or artifacts.",
];

/**
 * `05`'s own closing caveat. It stays visible on this screen because the file's
 * permissions are not the boundary — the agent's read capability is.
 */
export const ENV_FILE_TRUST_WARNING =
  "An agent that can read this file can copy it: scoping and egress control matter more than file permissions.";

/** How a lifecycle reads to a person (`SecretMount.lifecycle`). */
export const LIFECYCLE_COPY: Record<string, string> = {
  turn: "removed when the turn ends",
  workspace: "removed when the workspace is released",
  node_attempt: "removed when the node attempt ends (needs M4 attempts)",
};
