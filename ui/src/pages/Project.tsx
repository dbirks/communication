import { useParams } from "react-router";

export default function Project() {
  const { projectId } = useParams<{ projectId: string }>();
  return (
    <section>
      <h1 className="text-2xl font-semibold">Project</h1>
      <p className="mt-2 text-gray-700">Overview for project {projectId}.</p>
    </section>
  );
}
