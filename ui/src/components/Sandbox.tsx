/**
 * Sandbox status, in the two shapes the M3 API actually exposes:
 *
 * - `SandboxHealthPanel` — the fleet answer from `GET /api/v1/system/sandbox`:
 *   per worker, its backend, the enforcement mode it registered with, whether a
 *   launch was ever *verified*, and the measured identity of each storage root.
 * - `TurnSandboxPanel` — the verdict for one launched unit from
 *   `GET /api/v1/turns/{turnId}/sandbox`: the stage the ADR-0019 chain reached,
 *   the reason it stopped, the grant roles, and whether a process was ever exec'd.
 *
 * Honesty rules these panels obey (`05`, ADR-0019, `docs/m3-contract.md` §2/§3):
 * `verified: false` is never rendered as a pass; `permissive-dev`/`disabled` are
 * labelled loudly, not neutrally; `network_enforced: false` is an expected value
 * on the `agent-turn` profile and is *reported*, not hidden; and no host path
 * appears anywhere because `grants[]` name roles.
 */
import { useSystemSandbox, useTurnSandbox } from "../api/queries";
import {
  ENFORCEMENT_COPY,
  isolationWarning,
  UNKNOWN_VOLUME_WARNING,
  shortVolume,
  turnSandboxCopy,
  workerSandboxCopy,
  workerSandboxState,
} from "../api/sandbox";
import type { WorkerSandboxStatus } from "../api/types";
import { problemOf } from "../api/client";
import { Alert } from "./ds/Alert";
import { Panel } from "./ds/Panel";
import { StatusChip } from "./ds/Row";
import { stateOf } from "./ds/states";
import { Spinner } from "./Feedback";
import { shortId, testidOf } from "../lib/format";

function VolumeList({ worker }: { worker: WorkerSandboxStatus }) {
  if (!worker.volumes || worker.volumes.length === 0) {
    // A worker with no measured storage root cannot host an M3 workspace, and
    // saying so is the whole point of ADR-0017 D2.
    return (
      <p className="font-mono text-[11px] text-st-waiting-tag-fg" data-testid="volume-unknown">
        ⚠ {UNKNOWN_VOLUME_WARNING}
      </p>
    );
  }
  return (
    <ul className="space-y-[2px]">
      {worker.volumes.map((volume) => (
        <li
          key={volume.root_kind}
          className="font-mono text-[11px] text-ink-2"
          data-testid={`volume-row-${volume.root_kind}`}
        >
          <span className="text-muted">{volume.root_kind}</span>{" "}
          {volume.volume_id ? (
            shortVolume(volume.volume_id)
          ) : (
            // Per-root, because that is how it is measured: an unmeasured root
            // cannot host a workspace even when its sibling root was measured.
            <span
              className="text-st-waiting-tag-fg"
              data-testid={`volume-unknown-${volume.root_kind}`}
            >
              ⚠ {UNKNOWN_VOLUME_WARNING}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

export interface SandboxHealthPanelProps {
  /** Worker names, for a readable row label (optional — ids always work). */
  nameOf?: (workerId: string) => string;
}

/** Fleet sandbox health for `/ops` (`GET /api/v1/system/sandbox`). */
export function SandboxHealthPanel({ nameOf }: SandboxHealthPanelProps) {
  const sandbox = useSystemSandbox();
  const data = sandbox.data;
  const unverified = data?.workers.filter((worker) => !worker.verified).length ?? 0;
  const permissive =
    data?.workers.filter((worker) => worker.enforcement !== "required").length ?? 0;

  return (
    <Panel
      id="sandbox"
      title="SANDBOX HEALTH"
      headingId="sandbox-heading"
      headingLevel={2}
      // A panel that needs action takes the state's strong bar: workers that
      // never verified, or that run permissively, are exactly that.
      state={data && (unverified > 0 || permissive > 0) ? "waiting" : undefined}
      meta={
        data
          ? `${data.workers.length} worker${data.workers.length === 1 ? "" : "s"} · nono ${data.pinned_backend_version}`
          : undefined
      }
    >
      <div className="space-y-3 p-[10px]">
        {sandbox.isPending ? <Spinner label="Loading sandbox health" /> : null}
        {sandbox.error ? (
          <Alert state="failed" label="UNAVAILABLE" role="alert" testid="sandbox-health-error">
            {problemOf(sandbox.error).detail ||
              "Sandbox health could not be read, so nothing here is known to be enforced."}
          </Alert>
        ) : null}
        {data ? (
          <>
            <dl className="grid gap-x-6 gap-y-1 font-mono text-[11px] text-ink-2 sm:grid-cols-2">
              <div className="flex gap-2">
                <dt className="text-muted">pinned backend</dt>
                <dd data-testid="sandbox-pinned-version">{data.pinned_backend_version}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="text-muted">policy digest</dt>
                <dd className="break-all" data-testid="sandbox-policy-digest">
                  {data.policy_digest}
                </dd>
              </div>
            </dl>
            {data.workers.length === 0 ? (
              <p className="text-[12.5px] text-muted">
                No worker has registered, so no agent here runs under any sandbox at all.
              </p>
            ) : (
              <ul className="space-y-[4px]" data-testid="sandbox-worker-list">
                {data.workers.map((worker) => {
                  const state = stateOf(workerSandboxState(worker));
                  const mode =
                    ENFORCEMENT_COPY[worker.enforcement as keyof typeof ENFORCEMENT_COPY];
                  return (
                    <li
                      key={worker.worker_id}
                      data-testid={`sandbox-worker-row-${testidOf(worker.worker_id)}`}
                    >
                      <div className="flex flex-wrap items-center gap-[9px] rounded-[3px] border border-line bg-surface px-[10px] py-[7px]">
                        <StatusChip
                          state={state}
                          label={worker.verified ? "verified" : "not verified"}
                          labelProps={{
                            "data-testid": `sandbox-verified-${testidOf(worker.worker_id)}`,
                          }}
                        />
                        <span className="text-[12.5px] font-semibold">
                          {nameOf?.(worker.worker_id) ?? shortId(worker.worker_id)}
                        </span>
                        <span className="font-mono text-[10.5px] text-muted">
                          {worker.backend} {worker.backend_version ?? "?"}
                        </span>
                        {/* The mode is spelled out in words that do not imply
                            safety, next to the verdict, never as a bare ✓. */}
                        <span
                          className="font-mono text-[10.5px] font-semibold"
                          data-testid={`sandbox-enforcement-${testidOf(worker.worker_id)}`}
                        >
                          {mode?.word ?? worker.enforcement}
                        </span>
                        <span className="ml-auto text-[11px] text-faint" role="status">
                          {workerSandboxCopy(worker)}
                        </span>
                      </div>
                      <div className="mt-[2px] flex flex-wrap items-baseline gap-x-4 gap-y-1 pl-[10px]">
                        <VolumeList worker={worker} />
                        {mode && worker.enforcement !== "required" ? (
                          <p className="font-mono text-[11px] text-st-waiting-pale-fg">
                            ! {mode.note}
                          </p>
                        ) : null}
                        {worker.notes?.length ? (
                          <p className="font-mono text-[10.5px] text-muted">
                            notes: {worker.notes.join(" · ")}
                          </p>
                        ) : null}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </>
        ) : null}
      </div>
    </Panel>
  );
}

export interface TurnSandboxPanelProps {
  turnId: string;
  /** Words for the unit ("Turn", "Run child 3"), so the panel reads in context. */
  subject?: string;
}

/**
 * One unit's enforcement record (`GET /api/v1/turns/{turnId}/sandbox`).
 *
 * A `404`/absence is *not* shown as a failure: a turn that never reached a
 * launch has no record, and inventing one would be a fake fact. What is shown
 * whenever a record exists is the chain's end — including "no process was ever
 * started", which is the answer case 13 asks for.
 */
export function TurnSandboxPanel({ turnId, subject = "This turn" }: TurnSandboxPanelProps) {
  const sandbox = useTurnSandbox(turnId);
  const record = sandbox.data;

  if (!turnId) return null;
  if (sandbox.isPending) {
    return (
      <p className="font-mono text-[11px] text-muted" role="status" data-testid="sandbox-verdict">
        · checking the enforcement record…
      </p>
    );
  }
  if (sandbox.error || !record) {
    return (
      <p className="font-mono text-[11px] text-muted" data-testid="sandbox-verdict">
        no sandbox record for {subject.toLowerCase()} — it either never launched or the record is
        still being written
      </p>
    );
  }

  const failed = record.stage !== "none";
  const state = failed ? "failed" : record.verified ? "done" : "waiting";

  return (
    <div data-testid="sandbox-verdict-panel">
      {failed ? (
        <Alert
          state="failed"
          label="SANDBOX ENFORCEMENT FAILED"
          barTone="strong"
          role="alert"
          testid="sandbox-verdict-alert"
          meta={`stage: ${record.stage}`}
        >
          {turnSandboxCopy(record)}
          <span className="mt-1 block font-mono text-[10.5px] text-st-failed-pale-fg">
            backend: {record.backend} {record.backend_version ?? "?"} · policy:{" "}
            {record.policy_digest ?? "unknown"}
          </span>
        </Alert>
      ) : null}
      <Panel
        title="SANDBOX VERDICT"
        headingId={`turn-sandbox-heading-${shortId(turnId)}`}
        headingLevel={3}
        state={failed ? undefined : record.verified ? undefined : "waiting"}
        meta={
          <StatusChip
            state={stateOf(state)}
            label={record.verified ? "verified" : "not verified"}
          />
        }
      >
        <div className="space-y-2 p-[10px]">
          <p className="text-[12.5px]" data-testid="sandbox-verdict">
            {turnSandboxCopy(record)}
          </p>
          {isolationWarning(record.enforcement) ? (
            // The mode is a configured choice, so it is stated as loudly as a
            // failure would be: `permissive-dev` is not a sandbox with a gap.
            <Alert
              state="failed"
              label="ISOLATION NONE"
              barTone="strong"
              testid="sandbox-isolation-none"
            >
              {isolationWarning(record.enforcement)}
            </Alert>
          ) : null}
          <dl className="grid gap-x-6 gap-y-1 font-mono text-[11px] text-ink-2 sm:grid-cols-2">
            <div className="flex gap-2">
              <dt className="text-muted">workspace</dt>
              <dd data-testid="sandbox-workspace-id">{shortId(record.workspace_id)}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="text-muted">worker</dt>
              <dd>{shortId(record.worker_id)}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="text-muted">af_unix</dt>
              <dd data-testid="sandbox-af-unix">{record.af_unix_mediation ?? "unknown"}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="text-muted">egress</dt>
              {/* Reported, never hidden: the agent-turn profile runs with egress
                  unenforced in M3 (ADR-0019 D3, D-021 Proposed). */}
              <dd data-testid="sandbox-egress">
                {record.network_enforced ? "enforced" : "NOT enforced"}
              </dd>
            </div>
            <div className="flex gap-2">
              <dt className="text-muted">commit grant</dt>
              <dd>{record.commit_granted ? "own ref only" : "none"}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="text-muted">child started</dt>
              <dd data-testid="sandbox-child-started">{record.child_started ? "yes" : "no"}</dd>
            </div>
          </dl>
          <div>
            <h4 className="font-mono text-[10.5px] font-semibold uppercase tracking-[.04em] text-muted">
              Grants (by role — never a host path)
            </h4>
            <ul className="mt-1 flex flex-wrap gap-[4px]" data-testid="sandbox-grants">
              {record.grants.map((grant, index) => (
                <li
                  key={`${grant.role}-${index}`}
                  className="rounded-[3px] border border-line bg-fill px-[6px] py-[1px] font-mono text-[10.5px] text-ink-2"
                >
                  {grant.role}:{grant.access}
                </li>
              ))}
              {record.grants.length === 0 ? (
                <li className="font-mono text-[11px] text-muted">none recorded</li>
              ) : null}
            </ul>
          </div>
          {record.denied_what.length > 0 ? (
            <div>
              <h4 className="font-mono text-[10.5px] font-semibold uppercase tracking-[.04em] text-muted">
                Denied
              </h4>
              <ul className="mt-1 space-y-[2px]" data-testid="sandbox-denied">
                {record.denied_what.map((denial, index) => (
                  <li key={index} className="font-mono text-[11px] text-st-failed-tag-fg">
                    × {denial}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      </Panel>
    </div>
  );
}
