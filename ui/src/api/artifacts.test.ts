/**
 * The artifact access rules — above all the preview-origin guard, which is the
 * one place a UI bug could hand a session cookie to untrusted agent HTML.
 */
import { describe, expect, it } from "vitest";
import {
  downloadBlockedReason,
  previewBlockReason,
  redactionCopy,
  resolvePreviewUrl,
  sensitivityCopy,
} from "./artifacts";
import { artifactFixture } from "../test/fakes";
import type { Artifact } from "./types";

const APP_ORIGIN = "http://localhost:18080";
const PREVIEW_ORIGIN = "http://preview.localhost:18084";

describe("resolvePreviewUrl", () => {
  it("uses the server's absolute preview URL and fills the token placeholder", () => {
    const url = resolvePreviewUrl(
      {
        artifact_id: artifactFixture.id,
        token: "abc.def",
        preview_url: `${PREVIEW_ORIGIN}/preview/{token}`,
        expires_at: "2026-10-14T18:24:00Z",
      },
      APP_ORIGIN,
    );
    // The token is filled by the *server's* template, never concatenated here.
    expect(url).toBe(`${PREVIEW_ORIGIN}/preview/abc.def`);
    expect(url?.startsWith(APP_ORIGIN)).toBe(false);
  });

  it("refuses a URL on the app's own origin — the cookie would travel with it", () => {
    expect(
      resolvePreviewUrl(
        {
          artifact_id: artifactFixture.id,
          token: "abc",
          preview_url: `${APP_ORIGIN}/preview/abc`,
          expires_at: "2026-10-14T18:24:00Z",
        },
        APP_ORIGIN,
      ),
    ).toBeNull();
  });

  it("refuses a relative URL, which would resolve against this origin", () => {
    for (const previewUrl of ["/preview/abc", "preview/abc", ""]) {
      expect(
        resolvePreviewUrl(
          { artifact_id: artifactFixture.id, preview_url: previewUrl, expires_at: "x" },
          APP_ORIGIN,
        ),
      ).toBeNull();
    }
  });

  it("refuses a non-http scheme", () => {
    expect(
      resolvePreviewUrl(
        { artifact_id: "a", preview_url: "javascript:alert(1)", expires_at: "x" },
        APP_ORIGIN,
      ),
    ).toBeNull();
  });
});

describe("previewBlockReason", () => {
  const base = artifactFixture;
  const blocked = (overrides: Partial<Artifact>) =>
    previewBlockReason({ ...base, ...overrides } as Artifact);

  it("never previews a restricted or secret artifact, whatever its state", () => {
    expect(blocked({ sensitivity: "restricted" })).toContain("restricted");
    expect(blocked({ sensitivity: "secret" })).toContain("no download path");
  });

  it("never previews bytes that are not ready", () => {
    expect(blocked({ state: "uploading" })).toContain("uploading");
    expect(blocked({ state: "orphan" })).toContain("orphan");
    expect(blocked({ state: "deleted" })).toContain("deleted");
  });

  it("requires the server's preview_url before rendering anything", () => {
    expect(blocked({ preview_url: null })).toContain("preview_url");
    expect(blocked({ preview_url: "http://preview.localhost:18084/preview/{token}" })).toBeNull();
  });
});

describe("download + sensitivity copy", () => {
  it("offers no download for a secret and warns for restricted", () => {
    expect(downloadBlockedReason("secret")).toContain("no download path");
    expect(downloadBlockedReason("restricted")).toContain("maintainer");
    expect(downloadBlockedReason("internal")).toBeNull();
    expect(sensitivityCopy("restricted")).toContain("never previewed");
  });

  it("treats a zero redaction count as normal, not as a warning", () => {
    expect(redactionCopy(0)).toBe("scanner changed nothing");
    expect(redactionCopy(2)).toContain("2 spans");
  });
});
