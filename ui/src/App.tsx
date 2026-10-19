import { lazy, Suspense } from "react";
import { Route, Routes, useLocation } from "react-router";
import Shell from "./components/Shell";
import RequireAuth from "./components/RequireAuth";
import AgentsPage from "./pages/Agents";
import Login from "./pages/Login";
import ArtifactPage from "./pages/Artifact";
import Artifacts from "./pages/Artifacts";
import ConversationPage from "./pages/Conversation";
import ProjectConversations from "./pages/ProjectConversations";
import Inbox from "./pages/Inbox";
import LibraryPage, { PipelinePage } from "./pages/Library";
import NotFound from "./pages/NotFound";
import Operations from "./pages/Operations";
import Project from "./pages/Project";
import ProjectPipelines from "./pages/ProjectRunsPipelines";
import ProjectRuns from "./pages/ProjectRuns";
import RunWorkbench from "./pages/RunWorkbench";
import ProjectSettings from "./pages/ProjectSettings";
import Projects from "./pages/Projects";

// Dev-only, and folded away at build time: `import.meta.env.DEV` is statically
// false in a production build, so the condition below collapses and the dynamic
// import — the fixtures, the blocks, everything — never becomes a chunk. An
// unauthenticated M4 surface must not exist in what ships, not even as bytes.
const M4PreviewPage = import.meta.env.DEV ? lazy(() => import("./pages/M4Preview")) : null;
// The Studio pulls in React Flow + the inspector schema — keep it out of the
// initial chunk; the route is lazy like the preview page.
const StudioPage = lazy(() => import("./pages/Studio"));

export default function App() {
  const { pathname, search } = useLocation();

  // The Run Workbench and the Workflow Studio own the whole viewport: no
  // 1000px content column around them — the studio's palette | canvas |
  // inspector runs edge to edge, canvas-sized to the viewport height.
  const workbenchBleed =
    /^\/projects\/[^/]+\/runs\/[^/]+$/.test(pathname) ||
    /^\/library\/[^/]+\/drafts\/[^/]+$/.test(pathname);

  // The preview renders *outside* Shell, deliberately: Shell checks the session,
  // and a fixture page that needs a signed-in backend to render cleanly is not a
  // fixture page. It also returns early rather than mounting a second `<Routes>`,
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

  return (
    <Shell fullBleed={workbenchBleed}>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route
          path="/"
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
          path="/library"
          element={
            <RequireAuth>
              <LibraryPage />
            </RequireAuth>
          }
        />
        <Route
          path="/agents"
          element={
            <RequireAuth>
              <AgentsPage />
            </RequireAuth>
          }
        />
        <Route
          path="/library/:pipelineId"
          element={
            <RequireAuth>
              <PipelinePage />
            </RequireAuth>
          }
        />
        <Route
          path="/library/:pipelineId/drafts/:draftId"
          element={
            <RequireAuth>
              <Suspense fallback={null}>
                <StudioPage />
              </Suspense>
            </RequireAuth>
          }
        />
        <Route
          path="/projects/:projectId"
          element={
            <RequireAuth>
              <Project />
            </RequireAuth>
          }
        />
        <Route
          path="/projects/:projectId/artifacts"
          element={
            <RequireAuth>
              <Artifacts />
            </RequireAuth>
          }
        />
        <Route
          path="/projects/:projectId/runs"
          element={
            <RequireAuth>
              <ProjectRuns />
            </RequireAuth>
          }
        />
        <Route
          path="/projects/:projectId/runs/:runId"
          element={
            <RequireAuth>
              <RunWorkbench />
            </RequireAuth>
          }
        />
        <Route
          path="/projects/:projectId/pipelines"
          element={
            <RequireAuth>
              <ProjectPipelines />
            </RequireAuth>
          }
        />
        <Route
          path="/projects/:projectId/settings"
          element={
            <RequireAuth>
              <ProjectSettings />
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
          path="/projects/:projectId/conversations"
          element={
            <RequireAuth>
              <ProjectConversations />
            </RequireAuth>
          }
        />
        <Route
          path="/projects/:projectId/conversations/:conversationId"
          element={
            <RequireAuth>
              <ConversationPage />
            </RequireAuth>
          }
        />
        <Route
          path="/ops"
          element={
            <RequireAuth>
              <Operations />
            </RequireAuth>
          }
        />
        <Route path="*" element={<NotFound />} />
      </Routes>
    </Shell>
  );
}
