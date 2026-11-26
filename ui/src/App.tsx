import { lazy, Suspense } from "react";
import { Navigate, Route, Routes, useLocation, useParams } from "react-router";
import Shell from "./components/Shell";
import RequireAuth from "./components/RequireAuth";
import { Spinner } from "./components/Feedback";
import { ApiError } from "./api/client";
import { useMe } from "./api/queries";
import { routes } from "./lib/routes";
import Login from "./pages/Login";
import NotFound from "./pages/NotFound";

// Dev-only, and folded away at build time: `import.meta.env.DEV` is statically
// false in a production build, so the condition below collapses and the dynamic
// import — the fixtures, the blocks, everything — never becomes a chunk. An
// unauthenticated M4 surface must not exist in what ships, not even as bytes.
const M4PreviewPage = import.meta.env.DEV ? lazy(() => import("./pages/M4Preview")) : null;

/* ---------------------------------------------------------------- page chunks
 * Every route page is a separate chunk: the entry carries the shell (sidebar,
 * header, session gate, the sign-in screen) and the routers, and a visit to
 * `/` never downloads the Studio's graph editor, the workbench, the YAML
 * authoring stack or the secrets table. Only `Login` and `NotFound` stay eager
 * — they are the two screens the shell itself may have to answer with before
 * any route chunk has been requested.
 *
 * What a page pulls in follows it into its own chunk: `@xyflow/react` +
 * `@dagrejs/dagre` (the Studio canvas and the workflow graph), `yaml` (the
 * Studio inspector, the import dialog, the step editor) and the workbench's
 * transcript live behind the routes that read them, not in the first paint.
 * `pages/Library` re-exports two pages from two files, so both lazies point at
 * the same specifier and share one chunk per page.
 */
const StudioPage = lazy(() => import("./pages/Studio"));
const ChatsPage = lazy(() => import("./pages/Chats"));
const FactoryPage = lazy(() => import("./pages/Factory"));
const ManagePage = lazy(() => import("./pages/Manage"));
const Home = lazy(() => import("./pages/Home"));
const ArtifactPage = lazy(() => import("./pages/Artifact"));
const Artifacts = lazy(() => import("./pages/Artifacts"));
const ApprovalPage = lazy(() => import("./pages/Approval"));
const CatchUpItemPage = lazy(() => import("./pages/CatchUpItem"));
// The tour player is the one page that renders OUTSIDE `Shell` (below), so it
// is still a route chunk: the shell's chrome never enters the tour's viewport.
const TourPlayerPage = lazy(() => import("./pages/TourPlayer"));
const Project = lazy(() => import("./pages/Project"));
const Repository = lazy(() => import("./pages/Repository"));
// The deep link is its own module because it is what mounts the run header —
// and through it the run's definition graph (dagre). Here, it would be first
// paint.
const RunDeepLink = lazy(() => import("./pages/RunDeepLink"));
const ProfilePage = lazy(() => import("./pages/Profile"));
// The assistant's full page (handoff §1): a real route so the URL is shareable
// and the sidebar stays; the conversation engine is mounted by `Shell` and
// portals its page-mode frame into this route's host element.
const AssistantPage = lazy(() => import("./pages/AssistantPage"));

/**
 * The route chunk's loading state is the line every page already prints while
 * its own reads are pending (`Spinner`, ADR-free and announced), not a
 * skeleton of the page that has not arrived. It sits at the shared page band's
 * inset (`ds/Page`'s `PAGE_BAND_PAD`) so the column does not jump when the
 * page lands — the shell and the sidebar are outside the boundary and never
 * move (finding 07: the shell no longer guesses widths from a regex list;
 * every page declares its layout itself).
 */
function RouteFallback({ label = "Loading the page" }: { label?: string }) {
  return (
    <div className="px-[22px] pt-[20px] md:px-[28px]">
      <Spinner label={label} />
    </div>
  );
}

/**
 * Every legacy URL stays alive as a `replace` redirect that preserves the
 * query string and hash, so an ADR-0043 workbench permalink
 * (`/projects/<p>/runs/<r>?view=timeline&node=…`) lands on `/runs/<r>` with
 * the exact same URL state the workbench reads.
 */
function Redirect({
  to,
}: {
  to: string | ((params: Record<string, string | undefined>) => string);
}) {
  const { search, hash } = useLocation();
  const params = useParams();
  const target = typeof to === "function" ? to(params) : to;
  // A redesign target may carry its own query (`/factory/x?draft=y`,
  // `/manage/agents?tab=steps`): the target's parameters win, the old URL's
  // other parameters ride along, and the hash is kept.
  const [pathname = "/", own = ""] = target.split("?");
  const merged = new URLSearchParams(own);
  for (const [key, value] of new URLSearchParams(search)) {
    if (!merged.has(key)) merged.append(key, value);
  }
  const query = merged.toString();
  return <Navigate to={{ pathname, search: query === "" ? "" : `?${query}`, hash }} replace />;
}

/** The workbench deep link's route chunk is `RunDeepLink`, which prints the
 * run header's own pending line (`px-4 py-6` + `Loading run`); the fallback
 * for the chunk itself is that same markup, so navigation shows one steady
 * line where the header will stand. */
function RunRouteFallback() {
  return (
    <div className="px-4 py-6">
      <Spinner label="Loading run" />
    </div>
  );
}

export default function App() {
  const { pathname, search } = useLocation();
  const me = useMe({ enabled: !(M4PreviewPage && pathname === "/__m4-preview") });

  // Finding 07: the shell's route-regex width list is gone. The shell gives
  // every route the bare content column; each page declares its width through
  // `ds/Page` (`reading` / `wide` / `canvas`).

  // The preview renders *outside* Shell, deliberately: Shell checks the session,
  // and a fixture page that needs a signed-in backend to render cleanly is not
  // a fixture page. It also returns early rather than mounting a second `<Routes>`,
  // because the catch-all below would otherwise render NotFound underneath it.
  // `?source=live&project=<id>&run=<id>` mounts the same blocks against the
  // frozen M4 routes — the seam lives in `pages/M4Preview.tsx`; fixture mode
  // remains the default so nothing screenshots like a run by accident.
  if (M4PreviewPage && pathname === "/__m4-preview") {
    const params = new URLSearchParams(search);
    const source = params.get("source") === "live" ? "live" : "fixture";
    return (
      <Suspense fallback={null}>
        <M4PreviewPage
          source={source}
          projectId={params.get("project") ?? ""}
          runId={params.get("run")}
        />
      </Suspense>
    );
  }

  // The session gate (gh-3): a signed-out visitor sees ONLY the sign-in screen
  // — no sidebar, no app chrome — for `/` and every deep link. The gate runs
  // before the shell mounts, so the chrome never wraps the sign-in prompt;
  // the login screen carries the current path as `return_to`, so a sign-in
  // lands the visitor back on the page they asked for. A signed-out `/login`
  // renders the screen directly; any other path hands off to it with the deep
  // link preserved. A session that fails to load for a reason other than 401
  // falls through to the route-level gate, which renders the session error.
  // The dev-only M4 preview above stays outside this gate: it is a fixture
  // surface and must not need a session to render.
  if (me.isPending) return <Spinner label="Loading your session" />;
  const signedOut = me.error instanceof ApiError && me.error.status === 401;
  if (signedOut) {
    if (pathname === "/login") return <Login />;
    return (
      <Navigate to={`/login?return_to=${encodeURIComponent(`${pathname}${search}`)}`} replace />
    );
  }

  // The tour player (design 7b, ADR-0078) owns the viewport: no sidebar, no
  // floating Ask, no shell chrome — the tour is a reader sitting down to a
  // briefing, and the shell would take its screen. It therefore answers BEFORE
  // the shell mounts (the same placement the sign-in screen has) and it is
  // declared ahead of `/catch-up/:workId` so a tour URL is never read as a
  // piece id.
  if (pathname === "/catch-up/tour") {
    return (
      <Suspense fallback={<RouteFallback label="Loading the tour" />}>
        <Routes>
          <Route
            path="/catch-up/tour"
            element={
              <RequireAuth>
                <TourPlayerPage />
              </RequireAuth>
            }
          />
        </Routes>
      </Suspense>
    );
  }

  return (
    <Shell>
      <Suspense fallback={<RouteFallback />}>
        <Routes>
          <Route path="/login" element={<Login />} />

          {/* The redesign's route table (docs/design/redesign/CONTRACT.md). The
            selected project is the `/p/:projectId` prefix; no prefix = All. */}
          <Route
            path="/"
            element={
              <RequireAuth>
                <Home />
              </RequireAuth>
            }
          />
          <Route
            path="/p/:projectId"
            element={
              <RequireAuth>
                <Project />
              </RequireAuth>
            }
          />
          <Route
            path="/chats/:conversationId?"
            element={
              <RequireAuth>
                <ChatsPage />
              </RequireAuth>
            }
          />
          <Route
            path="/factory"
            element={
              <RequireAuth>
                <FactoryPage />
              </RequireAuth>
            }
          />
          <Route
            path="/factory/:pipelineId"
            element={
              <RequireAuth>
                <Suspense fallback={<RouteFallback label="Loading the editor" />}>
                  <StudioPage />
                </Suspense>
              </RequireAuth>
            }
          />
          <Route
            path="/p/:projectId/chats/:conversationId?"
            element={
              <RequireAuth>
                <ChatsPage />
              </RequireAuth>
            }
          />
          <Route
            path="/p/:projectId/factory"
            element={
              <RequireAuth>
                <FactoryPage />
              </RequireAuth>
            }
          />
          <Route
            path="/p/:projectId/factory/:pipelineId"
            element={
              <RequireAuth>
                <Suspense fallback={<RouteFallback label="Loading the editor" />}>
                  <StudioPage />
                </Suspense>
              </RequireAuth>
            }
          />
          <Route
            path="/manage/:section?/:itemId?"
            element={
              <RequireAuth>
                <ManagePage />
              </RequireAuth>
            }
          />

          {/* Kept pages, reached from the new places. */}
          <Route
            path="/runs/:runId"
            element={
              <RequireAuth>
                <Suspense fallback={<RunRouteFallback />}>
                  <RunDeepLink />
                </Suspense>
              </RequireAuth>
            }
          />
          <Route
            path="/approvals/:approvalId"
            element={
              <RequireAuth>
                <ApprovalPage />
              </RequireAuth>
            }
          />
          <Route
            path="/artifacts/:artifactId"
            element={
              <RequireAuth>
                <ArtifactPage />
              </RequireAuth>
            }
          />
          <Route
            path="/catch-up/:workId"
            element={
              <RequireAuth>
                <CatchUpItemPage />
              </RequireAuth>
            }
          />
          <Route
            path="/assistant"
            element={
              <RequireAuth>
                <Suspense fallback={<RouteFallback label="Loading the assistant" />}>
                  <AssistantPage />
                </Suspense>
              </RequireAuth>
            }
          />
          <Route
            path="/profile"
            element={
              <RequireAuth>
                <ProfilePage />
              </RequireAuth>
            }
          />
          <Route
            path="/p/:projectId/artifacts"
            element={
              <RequireAuth>
                <Artifacts />
              </RequireAuth>
            }
          />
          <Route
            path="/p/:projectId/:repo"
            element={
              <RequireAuth>
                <Repository />
              </RequireAuth>
            }
          />

          {/* Every address the app used before the redesign still answers, as a
            replace redirect that keeps the query string and the hash. */}
          <Route path="/catch-up" element={<Redirect to={routes.home()} />} />
          <Route path="/inbox" element={<Redirect to={routes.home()} />} />
          <Route path="/board" element={<Redirect to={routes.home()} />} />
          <Route path="/threads" element={<Redirect to={routes.chats()} />} />
          <Route
            path="/threads/:conversationId"
            element={<Redirect to={(p) => routes.chat(p.conversationId ?? "")} />}
          />
          <Route
            path="/p/:projectId/threads"
            element={<Redirect to={(p) => routes.chats(p.projectId)} />}
          />
          <Route
            path="/p/:projectId/threads/:conversationId"
            element={<Redirect to={(p) => routes.chat(p.conversationId ?? "", p.projectId)} />}
          />
          <Route
            path="/p/:projectId/conversations"
            element={<Redirect to={(p) => routes.chats(p.projectId)} />}
          />
          <Route
            path="/p/:projectId/conversations/:conversationId"
            element={<Redirect to={(p) => routes.chat(p.conversationId ?? "", p.projectId)} />}
          />
          <Route
            path="/projects/:projectId/conversations"
            element={<Redirect to={(p) => routes.chats(p.projectId)} />}
          />
          <Route
            path="/projects/:projectId/conversations/:conversationId"
            element={<Redirect to={(p) => routes.chat(p.conversationId ?? "", p.projectId)} />}
          />
          <Route path="/workflows" element={<Redirect to={routes.factory()} />} />
          <Route path="/library" element={<Redirect to={routes.factory()} />} />
          <Route path="/workflows/steps" element={<Redirect to={routes.steps()} />} />
          <Route path="/steps" element={<Redirect to={routes.steps()} />} />
          <Route
            path="/workflows/steps/:id"
            element={<Redirect to={(p) => routes.step(p.id ?? "")} />}
          />
          <Route path="/steps/:id" element={<Redirect to={(p) => routes.step(p.id ?? "")} />} />
          <Route path="/workflows/collections" element={<Redirect to={routes.collections()} />} />
          <Route
            path="/workflows/collections/:id"
            element={<Redirect to={(p) => routes.collection(p.id ?? "")} />}
          />
          <Route
            path="/workflows/:pipelineId"
            element={<Redirect to={(p) => routes.factoryWorkflow(p.pipelineId ?? "")} />}
          />
          <Route
            path="/library/:pipelineId"
            element={<Redirect to={(p) => routes.factoryWorkflow(p.pipelineId ?? "")} />}
          />
          <Route
            path="/workflows/:pipelineId/yaml"
            element={
              <Redirect
                to={(p) => routes.factoryWorkflow(p.pipelineId ?? "", null, { panel: "yaml" })}
              />
            }
          />
          <Route
            path="/workflows/:pipelineId/used-in"
            element={
              <Redirect
                to={(p) => routes.factoryWorkflow(p.pipelineId ?? "", null, { panel: "used-in" })}
              />
            }
          />
          <Route
            path="/workflows/:pipelineId/history"
            element={
              <Redirect
                to={(p) => routes.factoryWorkflow(p.pipelineId ?? "", null, { panel: "versions" })}
              />
            }
          />
          <Route
            path="/workflows/:pipelineId/drafts/:draftId"
            element={<Redirect to={(p) => routes.draft(p.pipelineId ?? "", p.draftId ?? "")} />}
          />
          <Route
            path="/library/:pipelineId/drafts/:draftId"
            element={<Redirect to={(p) => routes.draft(p.pipelineId ?? "", p.draftId ?? "")} />}
          />
          <Route path="/profiles" element={<Redirect to={routes.profiles()} />} />
          <Route path="/agents" element={<Redirect to={routes.profiles()} />} />
          <Route
            path="/profiles/:id"
            element={<Redirect to={(p) => routes.profile(p.id ?? "")} />}
          />
          <Route path="/agents/:id" element={<Redirect to={(p) => routes.profile(p.id ?? "")} />} />
          <Route path="/settings" element={<Redirect to={routes.manage("agents")} />} />
          <Route path="/settings/:tab" element={<Redirect to={(p) => routes.settings(p.tab)} />} />
          <Route path="/ops" element={<Redirect to={routes.ops()} />} />
          <Route path="/projects" element={<Redirect to={routes.projects()} />} />
          <Route
            path="/projects/:projectId"
            element={<Redirect to={(p) => routes.project(p.projectId ?? "")} />}
          />
          <Route
            path="/projects/:projectId/artifacts"
            element={<Redirect to={(p) => routes.projectTab(p.projectId ?? "", "artifacts")} />}
          />
          <Route
            path="/projects/:projectId/runs"
            element={<Redirect to={(p) => routes.factory(p.projectId)} />}
          />
          <Route
            path="/projects/:projectId/pipelines"
            element={<Redirect to={(p) => routes.factory(p.projectId)} />}
          />
          <Route
            path="/projects/:projectId/settings"
            element={<Redirect to={(p) => routes.manage("projects", p.projectId)} />}
          />
          <Route
            path="/projects/:projectId/runs/:runId"
            element={<Redirect to={(p) => routes.run(p.runId ?? "")} />}
          />
          <Route
            path="/p/:projectId/runs"
            element={<Redirect to={(p) => routes.factory(p.projectId)} />}
          />
          <Route
            path="/p/:projectId/workflows"
            element={<Redirect to={(p) => routes.factory(p.projectId)} />}
          />
          <Route
            path="/p/:projectId/pipelines"
            element={<Redirect to={(p) => routes.factory(p.projectId)} />}
          />
          <Route
            path="/p/:projectId/settings"
            element={<Redirect to={(p) => routes.manage("projects", p.projectId)} />}
          />
          <Route
            path="/p/:projectId/members"
            element={
              <Redirect
                to={(p) =>
                  `${routes.manage("people")}?project=${encodeURIComponent(p.projectId ?? "")}`
                }
              />
            }
          />

          <Route path="*" element={<NotFound />} />
        </Routes>
      </Suspense>
    </Shell>
  );
}
