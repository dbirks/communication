// Package api implements Communication's control-plane HTTP server: the
// router, middleware chain, problem+json error helpers, health/readiness
// endpoints, the embedded SPA handler and the authentication/CSRF hooks that
// other packages plug into.
//
// Design notes (communication-spec/02-system-architecture.md,
// 06-collaboration-identity.md "Identity architecture",
// 09-api-events-data.md "HTTP APIs"):
//
//   - Routing uses the standard library's net/http.ServeMux method+wildcard
//     patterns (no router dependency). A pattern with method GET also matches
//     HEAD. Handlers are registered with Handle (public) or HandleAuthed
//     (session required, CSRF enforced for browser mutations).
//   - Errors are RFC 9457-style problem+json documents:
//     {"type":"about:blank","title":...,"status":...,"detail":...}.
//   - Every response carries X-Communication-Replica so an operator (and the
//     M1 two-replica acceptance test) can tell which replica answered.
//   - /auth/... unknown paths answer problem+json 404 rather than falling
//     through to the SPA, because an unmatched auth route must never render
//     the application shell.
//   - This package depends only on the standard library and on small
//     interfaces (Readiness, Authenticator, fs.FS) so it compiles and is
//     fully unit tested without a database or an identity provider.
package api
