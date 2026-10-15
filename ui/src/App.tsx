import { lazy, Suspense } from "react";
import { Route, Routes, useLocation } from "react-router";
import Shell from "./components/Shell";
import RequireAuth from "./components/RequireAuth";
import Login from "./pages/Login";
import ArtifactPage from "./pages/Artifact";
import Artifacts from "./pages/Artifacts";
import ConversationPage from "./pages/Conversation";
import NotFound from "./pages/NotFound";
import Operations from "./pages/Operations";
import Project from "./pages/Project";
import ProjectSettings from "./pages/ProjectSettings";
import Projects from "./pages/Projects";

// Dev-only, and folded away at build time: `import.meta.env.DEV` is statically
// false in a production build, so the condition below collapses and the dynamic
// import — the fixtures, the blocks, everything — never becomes a chunk. An
// unauthenticated M4 surface must not exist in what ships, not even as bytes.
const M4PreviewPage = import.meta.env.DEV ? lazy(() => import("./pages/M4Preview")) : null;

export default function App() {
  const { pathname, search } = useLocation();

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
    <Shell>
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
