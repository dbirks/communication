/**
 * The M4 data-source seam: which side of the screen's props is real.
 *
 * `fixture` — values come from `src/test/fixtures/m4/`, shaped like the
 * contract; nothing may touch `/api/v1` (M4Preview's own test asserts zero
 * fetches, because a fixture screenshot that quietly called a live endpoint
 * reads as a run that happened).
 *
 * `live` — values come from the M4 hooks (`api/pipelines.ts`, `api/runs.ts`,
 * `api/approvals.ts`, `api/runEvents.ts`) mapped through `api/m4view.ts`.
 *
 * The seam is a source, not a boolean scattered through the tree: components
 * below it stay presentational (props in, callbacks out). Choosing the source
 * is the *page's* decision, made once at the top, so no component can mix half
 * a fixture with half a run.
 */
import { createContext, useContext } from "react";

export type M4Mode = "fixture" | "live";

const M4SourceContext = createContext<M4Mode>("fixture");

export function M4SourceProvider({ mode, children }: { mode: M4Mode; children: React.ReactNode }) {
  return <M4SourceContext.Provider value={mode}>{children}</M4SourceContext.Provider>;
}

/** Which source the enclosing preview mounted with. Default: `fixture`. */
export function useM4Source(): M4Mode {
  return useContext(M4SourceContext);
}
