import { lazy, Suspense } from "react";
import { Navigate, Route, Routes, useLocation, useParams } from "react-router";
import Shell from "./components/Shell";
import RequireAuth from "./components/RequireAuth";
import { Spinner } from "./components/Feedback";
import { RunHeaderLoading } from "./components/workbench/RunHeader";
import { ApiError } from "./api/client";
import { useConversation, useMe } from "./api/queries";
import { useRun } from "./api/runs";
import { routes } from "./lib/routes";
import AgentsPage from "./pages/Agents";
import Board from "./pages/Board";
import Home from "./pages/Home";
import Login from "./pages/Login";
import ArtifactPage from "./pages/Artifact";
import Artifacts from "./pages/Artifacts";
import ApprovalPage from "./pages/Approval";
import ConversationPage from "./pages/Conversation";
import ProjectConversations from "./pages/ProjectConversations";
import Inbox from "./pages/Inbox";
import LibraryPage, { PipelinePage } from "./pages/Library";
import NotFound from "./pages/NotFound";
import Project from "./pages/Project";
import ProjectPipelines from "./pages/ProjectRunsPipelines";
import ProjectRuns from "./pages/ProjectRuns";
import Repository from "./pages/Repository";
import RunWorkbench from "./pages/RunWorkbench";
import ProjectSettings from "./pages/ProjectSettings";
import Projects from "./pages/Projects";
import SettingsPage from "./pages/Settings";
import Steps from "./pages/Steps";
import Threads from "./pages/Threads";

// Dev-only, and folded away at build time: `import.meta.env.DEV` is statically
// false in a production build, so the condition below collapses and the dynamic
// import — the fixtures, the blocks, everything — never becomes a chunk. An
// unauthenticated M4 surface must not exist in what ships, not even as bytes.
const M4PreviewPage = import.meta.env.DEV ? lazy(() => import("./pages/M4Preview")) : null;
// The Studio pulls in React Flow + the inspector schema — keep it out of the
// initial chunk; the route is lazy like the preview page.
const StudioPage = lazy(() => import("./pages/Studio"));

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
 * The project-less workbench deep link (`/runs/:runId`). The workbench was
 * built for `/projects/:projectId/runs/:runId` and reads the project from the
 * URL; this wrapper resolves it from the unscoped `GET /api/v1/runs/{runId}`
 * and mounts the workbench with the prop, showing the workbench's own loading
 * state until the project is known.
 */
function RunDeepLink() {
  const { runId = "" } = useParams();
  const run = useRun(runId);
  if (run.isPending || !run.data) {
    return (
      <RunHeaderLoading
        runError={run.error}
        nodesError={null}
        pending={run.isPending}
        runId={runId}
      />
    );
  }
  return <RunWorkbench projectId={run.data.project_id} />;
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
  return <ConversationPage projectId={conversation.data?.project_id ?? ""} />;
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
    /^\/(workflows|library)$/.test(pathname);

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
        <Route
          path="/p/:projectId/conversations/:conversationId"
          element={
            <RequireAuth>
              <ConversationPage />
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
        <Route
          path="/workflows/:pipelineId/drafts/:draftId"
          element={
            <RequireAuth>
              <Suspense fallback={null}>
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
              <RunDeepLink />
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
    </Shell>
  );
}
