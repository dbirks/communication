/**
 * The one place the UI asks "does this caller hold the library role?".
 *
 * The server's rule is `requireLibraryRole` (`internal/api/pipelines.go`),
 * which is `Caller.IsOrgAdmin` and nothing else today — the organization-wide
 * library role has no column of its own yet, so the fail-closed reading is
 * enforced and widening it is an additive change to that one predicate. The
 * wire's answer reaches the browser as `me.is_org_admin` (`GET /api/v1/me`), so
 * this is the same fact, read the same way, in one place: the library list, the
 * pipeline page's sidebar, and the draft editor all ask here rather than each
 * re-typing the comparison and drifting from what the API would allow.
 *
 * It is deliberately stricter than the draft routes, which stop at org
 * membership: any org member's `PUT /api/v1/drafts/{id}` succeeds. Authoring a
 * *shared* definition is the library surface, and the surface's own copy has
 * said "authoring needs the library role" since M5 — so the editor is read-only
 * for a caller without it instead of accepting keystrokes and Save presses that
 * the page's own headline forbids. Publish stays gated on the same predicate the
 * server applies (`pipeline.draft.publish`).
 */
import type { Me } from "../../api/types";

/** `true` only when the served identity holds the library role (`is_org_admin`).
 * An unread `me` is not a permission: loading is not authoring. */
export function hasLibraryRole(me: Pick<Me, "is_org_admin"> | undefined): boolean {
  return me?.is_org_admin === true;
}

/** The library role in the words the library surface already uses. */
export const LIBRARY_ROLE_LABEL = "the library role";

/** Why an authoring control is absent (panel meta: short, no sentence). */
export const LIBRARY_AUTHORING_HINT = `authoring needs ${LIBRARY_ROLE_LABEL}`;

/** Why the draft editor is read-only — the reason, the rule's owner, and what
 * is still possible (reading, validating against the server's copy). */
export const LIBRARY_READ_ONLY_NOTE =
  `read-only — editing a shared draft needs ${LIBRARY_ROLE_LABEL} (organization admins hold it), ` +
  "and publishing refuses a caller without it. Revisions and validation stay readable.";
