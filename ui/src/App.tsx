import { Route, Routes } from "react-router";
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

export default function App() {
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
