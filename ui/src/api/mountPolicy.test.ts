/**
 * The mount/slug/env-name policy and the failure-reason copy. These rules are
 * the reason a maintainer does not discover a refused path at launch time, so
 * both directions — accept and refuse — are pinned.
 */
import { describe, expect, it } from "vitest";
import {
  ENV_FILE_POLICY_WARNINGS,
  materializationReasonCopy,
  validateEnvName,
  validateMountPath,
  validateSecretSlug,
} from "./mountPolicy";

describe("validateMountPath", () => {
  it("accepts a relative target inside a checkout", () => {
    expect(validateMountPath("backend/.env.test.local").ok).toBe(true);
    expect(validateMountPath(".env").ok).toBe(true);
    expect(validateMountPath("apps/web/config/local.env").ok).toBe(true);
  });

  it("refuses an absolute path, which would land outside the checkout", () => {
    expect(validateMountPath("/etc/passwd").message).toContain("absolute path refused");
    expect(validateMountPath("C:\\secrets\\.env").message).toContain("absolute path refused");
  });

  it("refuses traversal with the words the wireframe uses", () => {
    expect(validateMountPath("backend/../.env").message).toBe(
      "path not in workspace: '..' leaves the checkout",
    );
    expect(validateMountPath("..").message).toContain("path not in workspace");
  });

  it("refuses empty and '.' segments", () => {
    expect(validateMountPath("backend//.env").message).toContain("empty path segment");
    expect(validateMountPath("backend/.env/").message).toContain("empty path segment");
    expect(validateMountPath("./backend/.env").message).toContain("'.'");
    expect(validateMountPath("   ").message).toBe("a target path is required");
  });
});

describe("validateEnvName", () => {
  it("accepts a variable name and refuses anything path-shaped", () => {
    expect(validateEnvName("DATABASE_URL").ok).toBe(true);
    expect(validateEnvName("_PRIVATE").ok).toBe(true);
    expect(validateEnvName("backend/.env").message).toContain("not a path");
    expect(validateEnvName("DATABASE_URL=postgres://x").message).toContain(
      "not a path or an assignment",
    );
    expect(validateEnvName("2FA_TOKEN").message).toContain("not start with a digit");
  });
});

describe("validateSecretSlug", () => {
  it("mirrors the OpenAPI pattern", () => {
    expect(validateSecretSlug("test-database-url").ok).toBe(true);
    expect(validateSecretSlug("Test-Url").message).toContain("lowercase");
    expect(validateSecretSlug("-lead").message).toContain("lowercase");
    expect(validateSecretSlug("a".repeat(129)).message).toContain("128");
  });
});

describe("materializationReasonCopy", () => {
  it("quotes every reason the worker can report", () => {
    for (const reason of [
      "path_escape",
      "absolute_path",
      "bad_shape",
      "tracked_target",
      "exists",
      "keyring_unreadable",
      "revoked_version",
      "broker_unsupported",
      "symlink_parent",
      "mirror_writable",
    ]) {
      const copy = materializationReasonCopy(reason);
      expect(copy).not.toBe(reason);
      expect(copy.length).toBeGreaterThan(10);
    }
  });

  it("keeps an unlisted reason visible instead of inventing one", () => {
    expect(materializationReasonCopy("quantum_flip")).toContain("quantum_flip");
  });

  it("states the four `.env` contract rules a mount form must warn about", () => {
    const joined = ENV_FILE_POLICY_WARNINGS.join(" ");
    for (const requirement of ["0600", "tracked", "artifacts", "Removed"]) {
      expect(joined).toContain(requirement);
    }
  });
});
