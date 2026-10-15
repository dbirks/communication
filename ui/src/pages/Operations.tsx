import { problemOf } from "../api/client";
import { useHealth, useReadiness, useWorkers } from "../api/queries";
import { Spinner } from "../components/Feedback";

const cardClass = "rounded border border-gray-200 p-4";

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? value
    : date.toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

export interface StatusCardProps {
  testid: string;
  title: string;
  status: string;
  ok: boolean;
  rows: Array<[string, string]>;
  detail?: string;
}

/** Health/readiness card: the status is always written out as text. */
function StatusCard({ testid, title, status, ok, rows, detail }: StatusCardProps) {
  return (
    <div className={cardClass} data-testid={testid}>
      <h3 className="text-base font-semibold">{title}</h3>
      <p className={ok ? "text-sm text-green-900" : "text-sm text-red-900"} role="status">
        {ok ? "✓ " : "✗ "}
        {status}
      </p>
      {detail ? <p className="mt-1 text-sm text-red-900">{detail}</p> : null}
      <dl className="mt-2 space-y-1 text-sm text-gray-700">
        {rows.map(([term, value]) => (
          <div key={term} className="flex gap-2">
            <dt className="font-medium">{term}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

export default function Operations() {
  const health = useHealth();
  const readiness = useReadiness();
  const workers = useWorkers();

  const healthProblem = health.error ? problemOf(health.error) : null;
  const readinessProblem = readiness.error ? problemOf(readiness.error) : null;

  return (
    <section aria-labelledby="ops-heading" className="space-y-6">
      <h1 id="ops-heading" className="text-2xl font-semibold">
        Operations
      </h1>
      <p className="text-sm text-gray-600">
        Each request lands on whichever API replica the load balancer chose; the replica badge in
        the footer shows which one answered last.
      </p>

      <div className="grid gap-4 sm:grid-cols-2">
        {health.isPending ? <Spinner label="Checking health" /> : null}
        {health.data ? (
          <StatusCard
            testid="health-card"
            title="Health"
            status={`status: ${health.data.status}`}
            ok={health.data.status === "ok"}
            rows={[
              ["replica", health.data.replica],
              ["version", health.data.version],
            ]}
          />
        ) : healthProblem ? (
          <StatusCard
            testid="health-card"
            title="Health"
            status="status: unreachable"
            ok={false}
            rows={[]}
            detail={`${healthProblem.title}${healthProblem.detail ? `: ${healthProblem.detail}` : ""}`}
          />
        ) : null}

        {readiness.isPending ? <Spinner label="Checking readiness" /> : null}
        {readiness.data ? (
          <StatusCard
            testid="readiness-card"
            title="Readiness"
            status={`status: ${readiness.data.status}`}
            ok={readiness.data.status === "ready"}
            rows={[
              ["schema version", String(readiness.data.schema_version)],
              ["expected", String(readiness.data.expected_schema_version)],
            ]}
          />
        ) : readinessProblem ? (
          <StatusCard
            testid="readiness-card"
            title="Readiness"
            status="status: not ready"
            ok={false}
            rows={[]}
            detail={`${readinessProblem.title}${readinessProblem.detail ? `: ${readinessProblem.detail}` : ""}`}
          />
        ) : null}
      </div>

      <div>
        <h2 className="text-lg font-semibold">Workers</h2>
        {workers.isPending ? <Spinner label="Loading workers" /> : null}
        {workers.error ? (
          <p className="text-sm text-red-900" role="alert">
            {problemOf(workers.error).detail || "Workers could not be loaded."}
          </p>
        ) : null}
        {workers.data ? (
          workers.data.items.length === 0 ? (
            <p className="mt-2 text-sm text-gray-600">No workers registered</p>
          ) : (
            <table className="mt-2 w-full border-collapse text-sm" data-testid="workers-table">
              <caption className="sr-only">Registered execution workers</caption>
              <thead>
                <tr className="border-b border-gray-300 text-left">
                  <th scope="col" className="py-1 pr-4 font-medium">
                    Name
                  </th>
                  <th scope="col" className="py-1 pr-4 font-medium">
                    Hostname
                  </th>
                  <th scope="col" className="py-1 pr-4 font-medium">
                    Version
                  </th>
                  <th scope="col" className="py-1 pr-4 font-medium">
                    Status
                  </th>
                  <th scope="col" className="py-1 pr-4 font-medium">
                    Started
                  </th>
                  <th scope="col" className="py-1 font-medium">
                    Last heartbeat
                  </th>
                </tr>
              </thead>
              <tbody>
                {workers.data.items.map((worker) => (
                  <tr
                    key={worker.id}
                    data-testid={`worker-row-${worker.name}`}
                    className="border-b border-gray-100"
                  >
                    <td className="py-1 pr-4 font-medium">{worker.name}</td>
                    <td className="py-1 pr-4">{worker.hostname}</td>
                    <td className="py-1 pr-4">{worker.version}</td>
                    <td className="py-1 pr-4">status: {worker.status}</td>
                    <td className="py-1 pr-4">{formatTime(worker.started_at)}</td>
                    <td className="py-1">{formatTime(worker.last_heartbeat_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        ) : null}
      </div>
    </section>
  );
}
