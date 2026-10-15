import { Route, Routes } from "react-router";
import Shell from "./components/Shell";
import Login from "./pages/Login";
import NotFound from "./pages/NotFound";
import Operations from "./pages/Operations";
import Project from "./pages/Project";
import Projects from "./pages/Projects";

export default function App() {
  return (
    <Shell replica="unknown">
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/" element={<Projects />} />
        <Route path="/projects/:projectId" element={<Project />} />
        <Route path="/ops" element={<Operations />} />
        <Route path="*" element={<NotFound />} />
      </Routes>
    </Shell>
  );
}
