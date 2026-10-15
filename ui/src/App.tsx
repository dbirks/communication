import { Route, Routes } from "react-router";
import Shell from "./components/Shell";
import RequireAuth from "./components/RequireAuth";
import Login from "./pages/Login";
import ConversationPage from "./pages/Conversation";
import NotFound from "./pages/NotFound";
import Operations from "./pages/Operations";
import Project from "./pages/Project";
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
