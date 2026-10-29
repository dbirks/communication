import { lazy, Suspense } from "react";
import { Navigate, Route, Routes, useLocation, useParams } from "react-router";
import Shell from "./components/Shell";
import RequireAuth from "./components/RequireAuth";
import { Spinner } from "./components/Feedback";
import { ApiError } from "./api/client";
import { useConversation, useMe } from "./api/queries";
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
const AgentsPage = lazy(() => import("./pages/Agents"));
const Board = lazy(() => import("./pages/Board"));
const Home = lazy(() => import("./pages/Home"));
const ArtifactPage = lazy(() => import("./pages/Artifact"));
const Artifacts = lazy(() => import("./pages/Artifacts"));
const ApprovalPage = lazy(() => import("./pages/Approval"));
const ConversationPage = lazy(() => import("./pages/Conversation"));
const ProjectConversations = lazy(() => import("./pages/ProjectConversations"));
const Inbox = lazy(() => import("./pages/Inbox"));
const LibraryPage = lazy(() => import("./pages/Library").then((m) => ({ default: m.LibraryPage })));
const PipelinePage = lazy(() =>
  import("./pages/Library").then((m) => ({ default: m.PipelinePage })),
);
const Project = lazy(() => import("./pages/Project"));
const ProjectMembersPage = lazy(() => import("./components/project/ProjectMembersPage"));
const ProjectPipelines = lazy(() => import("./pages/ProjectRunsPipelines"));
const ProjectRuns = lazy(() => import("./pages/ProjectRuns"));
const Repository = lazy(() => import("./pages/Repository"));
// The deep link is its own module because it is what mounts the run header —
// and through it the run's definition graph (dagre). Here, it would be first
// paint.
const RunDeepLink = lazy(() => import("./pages/RunDeepLink"));
const ProjectSettings = lazy(() => import("./pages/ProjectSettings"));
const Projects = lazy(() => import("./pages/Projects"));
const SettingsPage = lazy(() => import("./pages/Settings"));
const Steps = lazy(() => import("./pages/Steps"));
const Threads = lazy(() => import("./pages/Threads"));

/**
 * The route chunk's loading state is the line every page already prints while
 * its own reads are pending (`Spinner`, ADR-free and announced), not a skeleton
 * of the page that has not arrived. It occupies the first line of the content
 * column — the shell and the sidebar are outside the boundary and never move,
 * and the page lands where its own header begins.
 */
function RouteFallback({
  fullBleed,
  label = "Loading the page",
}: {
  fullBleed: boolean;
  label?: string;
}) {
  if (!fullBleed) return <Spinner label={label} />;
  // Full-bleed routes pad themselves (the shared page band's `20px 28px`);
  // the fallback holds the same inset so the column does not jump.
  return (
    <div className="px-7 py-5">
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
  return <Navigate to={{ pathname: target, search, hash }} replace />;
}

/**
 * The project-less thread deep link (`/threads/:id`). The conversation detail
 * API is unscoped; the page reads its project from the same response and gets
 * it here as a prop.
 */
function ThreadDeepLink() {
  const { conversationId = "" } = useParams();
  const conversation = useConversation(conversationId);
  if (conversation.isPending) return <Spinner label="Loading conversation" />;
  return (
    <Suspense fallback={<Spinner label="Loading conversation" />}>
      <ConversationPage projectId={conversation.data?.project_id ?? ""} />
    </Suspense>
  );
}

/** The thread page behind a project-scoped route: same pending line as the
 *  project-less deep link, so the chunk arriving does not change the copy. */
function ConversationRoute() {
  return (
    <Suspense fallback={<Spinner label="Loading conversation" />}>
      <ConversationPage />
    </Suspense>
  );
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

  // The Run Workbench and the Workflow Studio own the whole viewport: no
  // 1000px content column around them — the studio's palette | canvas |
  // inspector runs edge to edge, canvas-sized to the viewport height.
  const workbenchBleed =
    /^\/runs\/[^/]+$/.test(pathname) ||
    /^\/projects\/[^/]+\/runs\/[^/]+$/.test(pathname) ||
    /^\/(workflows|library)\/[^/]+\/drafts\/[^/]+$/.test(pathname) ||
    // The Workflows index (design 1b) uses the full content column, not the
    // capped page column the other library screens keep.
    /^\/(workflows|library)$/.test(pathname) ||
    // The workflow page and its tabs own the viewport too (design 1e): the
    // shell's `py-6` would band the header with 24px of empty paper.
    /^\/(workflows|library)\/[^/]+(\/(yaml|used-in|history))?$/.test(pathname) ||
    // The project overview (Projects Review design 1b) is the shared page
    // pattern: a header band across the whole content column, `20px 28px` of
    // padding and tabs sitting on the band's bottom border — none of which
    // survives inside a centred 64rem reading column. Only the overview page
    // and the members/activity page that left with it: every other project tab
    // keeps the shell's column until it is rebuilt to the same pattern.
    /^\/p\/[^/]+$/.test(pathname) ||
    /^\/p\/[^/]+\/members$/.test(pathname) ||
    // Threads (Projects Review design 1g) is the same shared page pattern:
    // the 320px list pane plus the open thread own the whole content column
    // at full height — a centred 64rem column would squeeze the pane header
    // and float the composer mid-page.
    pathname === "/threads" ||
    /^\/threads\/[^/]+$/.test(pathname);

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

  return (
    <Shell fullBleed={workbenchBleed}>
      <Suspense fallback={<RouteFallback fullBleed={workbenchBleed} />}>
        <Routes>
          <Route path="/login" element={<Login />} />

          {/* ------------------------------------------------ new canonical table */}
          <Route
            path="/"
            element={
              <RequireAuth>
                <Home />
              </RequireAuth>
            }
          />
          <Route
            path="/projects"
            element={
              <RequireAuth>
                <Projects />
              </RequireAuth>
            }
          />
          <Route
            path="/inbox"
            element={
              <RequireAuth>
                <Inbox />
              </RequireAuth>
            }
          />
          <Route
            path="/board"
            element={
              <RequireAuth>
                <Board />
              </RequireAuth>
            }
          />
          <Route
            path="/threads"
            element={
              <RequireAuth>
                <Threads />
              </RequireAuth>
            }
          />
          <Route
            path="/threads/:conversationId"
            element={
              <RequireAuth>
                <ThreadDeepLink />
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
            path="/p/:projectId/artifacts"
            element={
              <RequireAuth>
                <Artifacts />
              </RequireAuth>
            }
          />
          <Route
            path="/p/:projectId/runs"
            element={
              <RequireAuth>
                <ProjectRuns />
              </RequireAuth>
            }
          />
          <Route
            path="/p/:projectId/pipelines"
            element={
              <RequireAuth>
                <ProjectPipelines />
              </RequireAuth>
            }
          />
          <Route
            path="/p/:projectId/settings"
            element={
              <RequireAuth>
                <ProjectSettings />
              </RequireAuth>
            }
          />
          <Route
            path="/p/:projectId/conversations"
            element={
              <RequireAuth>
                <ProjectConversations />
              </RequireAuth>
            }
          />
          {/* Where the overview's Members panel and event feed went (Projects
            Review design 1b). The handoff names Settings as their home, and
            `pages/ProjectSettings.tsx` is outside that brief, so the two panels
            sit on their own project route — a static segment, so it wins over
            the `/p/:projectId/:repo` repository catch-all the same way `runs`
            and `settings` already do. */}
          <Route
            path="/p/:projectId/members"
            element={
              <RequireAuth>
                <ProjectMembersPage />
              </RequireAuth>
            }
          />
          <Route
            path="/p/:projectId/conversations/:conversationId"
            element={
              <RequireAuth>
                <ConversationRoute />
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

          <Route
            path="/workflows"
            element={
              <RequireAuth>
                <LibraryPage />
              </RequireAuth>
            }
          />
          <Route
            path="/workflows/:pipelineId"
            element={
              <RequireAuth>
                <PipelinePage />
              </RequireAuth>
            }
          />
          {/* The workflow page's tabs are routes (design 1e): Overview is the
            page itself; YAML, Used in and History are these. */}
          <Route
            path="/workflows/:pipelineId/yaml"
            element={
              <RequireAuth>
                <PipelinePage />
              </RequireAuth>
            }
          />
          <Route
            path="/workflows/:pipelineId/used-in"
            element={
              <RequireAuth>
                <PipelinePage />
              </RequireAuth>
            }
          />
          <Route
            path="/workflows/:pipelineId/history"
            element={
              <RequireAuth>
                <PipelinePage />
              </RequireAuth>
            }
          />
          <Route
            path="/workflows/:pipelineId/drafts/:draftId"
            element={
              <RequireAuth>
                <Suspense fallback={<RouteFallback fullBleed label="Loading the studio" />}>
                  <StudioPage />
                </Suspense>
              </RequireAuth>
            }
          />
          <Route
            path="/steps"
            element={
              <RequireAuth>
                <Steps />
              </RequireAuth>
            }
          />
          <Route
            path="/steps/:id"
            element={
              <RequireAuth>
                <Steps />
              </RequireAuth>
            }
          />
          <Route
            path="/profiles"
            element={
              <RequireAuth>
                <AgentsPage />
              </RequireAuth>
            }
          />
          <Route
            path="/profiles/:id"
            element={
              <RequireAuth>
                <AgentsPage />
              </RequireAuth>
            }
          />
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
          {/* User settings (contract C1): `/settings/:tab` (`layout`, `assistant`,
            `operations`) with `/settings` landing on the default tab. */}
          <Route
            path="/settings/:tab"
            element={
              <RequireAuth>
                <SettingsPage />
              </RequireAuth>
            }
          />
          <Route path="/settings" element={<Redirect to={routes.settings()} />} />
          {/* Operations is a real Settings tab (`/settings/:tab` → `operations`);
            the old `/ops` URL stays alive as a replace redirect to the tab. */}
          <Route path="/ops" element={<Navigate to={routes.ops()} replace />} />
          <Route
            path="/artifacts/:artifactId"
            element={
              <RequireAuth>
                <ArtifactPage />
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

          {/* ------------------------------------------------ legacy routes */}
          <Route path="/library" element={<Redirect to={routes.workflows()} />} />
          <Route
            path="/library/:pipelineId"
            element={<Redirect to={(p) => routes.workflow(p.pipelineId ?? "")} />}
          />
          <Route
            path="/library/:pipelineId/drafts/:draftId"
            element={<Redirect to={(p) => routes.draft(p.pipelineId ?? "", p.draftId ?? "")} />}
          />
          <Route path="/agents" element={<Redirect to={routes.profiles()} />} />
          <Route path="/agents/:id" element={<Redirect to={(p) => routes.profile(p.id ?? "")} />} />
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
            element={<Redirect to={(p) => routes.projectTab(p.projectId ?? "", "runs")} />}
          />
          <Route
            path="/projects/:projectId/pipelines"
            element={<Redirect to={(p) => routes.projectTab(p.projectId ?? "", "pipelines")} />}
          />
          <Route
            path="/projects/:projectId/settings"
            element={<Redirect to={(p) => routes.projectTab(p.projectId ?? "", "settings")} />}
          />
          <Route
            path="/projects/:projectId/runs/:runId"
            element={<Redirect to={(p) => routes.run(p.runId ?? "")} />}
          />
          <Route
            path="/projects/:projectId/conversations"
            element={<Redirect to={(p) => routes.projectTab(p.projectId ?? "", "conversations")} />}
          />
          <Route
            path="/projects/:projectId/conversations/:conversationId"
            element={<Redirect to={(p) => routes.thread(p.conversationId ?? "")} />}
          />

          <Route path="*" element={<NotFound />} />
        </Routes>
      </Suspense>
    </Shell>
  );
}
