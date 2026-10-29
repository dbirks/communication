/**
 * Artifact access rules the UI must mirror — decided here so no component can
 * improvise one.
 *
 * The load-bearing rule (ADR-0020 D6, gap **G22**): artifact HTML is untrusted
 * agent output, and executing it is *only* ever the preview origin's job. The
 * app's origin serves `…/content` for `text/html` as `text/plain` + attachment,
 * precisely so a navigation cannot run it, and the preview lives on a different
 * **hostname** because cookies are host-scoped (a port would not remove one).
 * The SPA therefore never constructs a preview URL — it uses the server's
 * absolute `preview_url` or it renders no frame.
 */
import type { Artifact, ArtifactSensitivity, PreviewToken } from "./types";

/** Why an artifact may not be previewed, in words, or null when it may. */
export function previewBlockReason(artifact: Artifact): string | null {
  if (artifact.sensitivity === "restricted") {
    return "restricted artifacts can't be previewed — only their details are shown, and downloading one needs a project maintainer";
  }
  if (artifact.sensitivity === "secret") {
    return "a `secret` artifact can't be previewed and has no download path";
  }
  if (artifact.state !== "ready") {
    return `this artifact is ${artifact.state}, and only a ready one is served`;
  }
  if (!isHtml(artifact)) {
    return null;
  }
  if (!artifact.preview_url) {
    return "the API offered no preview_url for this artifact, so no frame is rendered";
  }
  return null;
}

/** Whether an artifact is HTML, by kind or media type (both are authoritative). */
export function isHtml(artifact: Artifact): boolean {
  return artifact.kind === "html" || artifact.media_type.toLowerCase().startsWith("text/html");
}

/** Whether bytes may be fetched at all (`secret` has no path for anyone). */
export function downloadBlockedReason(sensitivity: ArtifactSensitivity): string | null {
  if (sensitivity === "secret") {
    return "a `secret` artifact has no download path for anyone";
  }
  if (sensitivity === "restricted") {
    return "restricted content needs a project maintainer";
  }
  return null;
}

/**
 * The absolute URL to put in the preview frame, or null when there is no safe
 * one. A relative URL would resolve against *this* origin (the very thing
 * ADR-0020 forbids), and a same-origin absolute URL carries the session cookie.
 * The `{token}` placeholder is filled from the minted token because the
 * contract's `preview_url` is a template until a token exists; nothing here ever
 * assembles an origin or a path of its own.
 */
export function resolvePreviewUrl(preview: PreviewToken, currentOrigin?: string): string | null {
  const template = (preview.preview_url ?? "").trim();
  if (!template) return null;
  // Filled on the raw string: `new URL()` would percent-encode the braces, so a
  // post-parse replace would silently never match and the frame would point at a
  // literal `{token}`.
  const raw =
    preview.token && template.includes("{token}")
      ? template.split("{token}").join(encodeURIComponent(preview.token))
      : template;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    // Relative or malformed: the server broke the contract; render nothing.
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (currentOrigin && url.origin === currentOrigin) return null;
  return url.href;
}

/** The frame's `sandbox` value: empty string = no allowances at all. */
export const PREVIEW_SANDBOX = "";

/**
 * Sensitivity in words. `redaction_count` 0 is normal and never rendered as a
 * warning (ADR-0020 D4): only a non-zero count means the scanner changed bytes.
 */
export function sensitivityCopy(sensitivity: ArtifactSensitivity): string {
  switch (sensitivity) {
    case "standard":
      return "standard · any project member may download";
    case "internal":
      return "internal · any project member may download and preview";
    case "restricted":
      return "restricted · maintainer only, never previewed";
    case "secret":
      return "secret · no download path and no preview";
  }
}

/** Whether the redaction scanner changed anything (0 is the normal case). */
export function redactionCopy(count: number): string {
  return count === 0
    ? "scanner changed nothing"
    : `scanner redacted ${count} span${count === 1 ? "" : "s"}`;
}
