// Package domain contains Communication's core entities, state machines and
// interfaces.
//
// Types here are SDK-free: this package must never import runtime SDKs (ACP,
// APM, nono) or database drivers. Adapters in other packages depend on these
// interfaces, never the reverse (communication-spec/02-system-architecture.md
// dependency rule). Only the Go standard library is permitted, and only for
// vocabulary types such as context.Context, io.Writer and time.Time.
package domain
