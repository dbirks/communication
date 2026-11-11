/**
 * MODELS — what this deployment can ask a model to do, and whether the answer
 * was ever heard.
 *
 * Configuration only: the model id, the endpoint's *host*, and whether a key
 * exists. No value crosses here by construction — the overview read has no
 * field that could hold one (`docs/m3-contract.md` §2's rule, ADR-0018 D1/D3),
 * and this panel never asks for one.
 *
 * `Test` is the difference between "configured" and "works". It is admin-only
 * because it spends the organization's quota and because the answer is a fact
 * about the server, not about the viewer; the API enforces the same rule, so a
 * non-admin who posts the probe reads 403 — the button is hidden here only so
 * the page does not offer a verb the reader cannot use.
 */
import { useState } from "react";
import { problemOf } from "../../api/client";
import {
  probeModel,
  type ModelKind,
  type ModelProbeResult,
  type OverviewModel,
  type SystemOverview,
} from "../../api/overview";
import { Button } from "../ds/Button";
import { OpsError, OpsPanel, OpsSkeleton } from "./OpsPanel";
import { StatusDot, type OpsStatus } from "./StatusDot";

/**
 * The three models the APP asks (not the worker's): the tile counts these, and
 * these are the rows with a `Test` button. `worker_chat` runs on a worker, out
 * of this replica's reach, so it is shown but never probed from here.
 */
export const APP_MODEL_KINDS: readonly ModelKind[] = ["assistant", "speech", "decision"];

/* --------------------------------------------------------------- panel */

/** The probe's answer line, kept to one truncation rule (80 chars, full in title). */
const DETAIL_LIMIT = 80;

function detailLine(detail: string): string {
  const oneLine = detail.replace(/\s+/g, " ").trim();
  return oneLine.length > DETAIL_LIMIT ? `${oneLine.slice(0, DETAIL_LIMIT)}…` : oneLine;
}

type ProbeState =
  | { phase: "idle" }
  | { phase: "testing" }
  | { phase: "done"; result: ModelProbeResult };

export interface ModelsPanelProps {
  /** The overview read; `null` = this server does not serve it (yet). */
  overview: SystemOverview | null;
  pending: boolean;
  error: unknown | null;
  onRetry?: () => void;
  /** Admin only sees `Test` (the API enforces it; the page does not offer it). */
  isAdmin: boolean;
  /** Overridable so the probe's wire call is the thing a test asserts on. */
  probe?: (kind: ModelKind | string) => Promise<ModelProbeResult>;
}

function modelStatus(model: OverviewModel): OpsStatus {
  return model.configured ? "ok" : "bad";
}

export function ModelsPanel({
  overview,
  pending,
  error,
  onRetry,
  isAdmin,
  probe = probeModel,
}: ModelsPanelProps) {
  const [probes, setProbes] = useState<Record<string, ProbeState>>({});

  const runProbe = async (kind: ModelKind | string) => {
    setProbes((current) => ({ ...current, [kind]: { phase: "testing" } }));
    try {
      const result = await probe(kind);
      setProbes((current) => ({ ...current, [kind]: { phase: "done", result } }));
    } catch (caught) {
      const problem = problemOf(caught);
      setProbes((current) => ({
        ...current,
        [kind]: {
          phase: "done",
          result: {
            ok: false,
            latency_ms: 0,
            detail: problem.detail || problem.title || "the probe could not be sent",
          },
        },
      }));
    }
  };

  const models = overview?.models ?? [];
  const hosts = new Set(models.map((model) => model.endpoint_host).filter((host) => host !== ""));
  const meta = hosts.size === 1 ? `via ${[...hosts][0]}` : undefined;

  return (
    <OpsPanel id="ops-models" title="Models" meta={meta}>
      {pending ? <OpsSkeleton testid="models-skeleton" /> : null}
      {error ? (
        <OpsError
          thing="the model configuration"
          detail={problemOf(error).detail}
          onRetry={onRetry}
          testid="models-error"
        />
      ) : null}
      {overview === null && !pending && !error ? (
        <p className="text-[12.5px] text-muted" data-testid="models-not-served">
          This server does not report its model configuration, so nothing here is known about models
          — not that they are missing, only that this page cannot see them.
        </p>
      ) : null}
      {overview ? (
        models.length === 0 ? (
          <p className="text-[12.5px] text-muted" data-testid="models-none">
            No models are configured, so nothing in this app asks a model anything.
          </p>
        ) : (
          <ul className="space-y-[8px]" data-testid="models-list">
            {models.map((model) => {
              const state: ProbeState = probes[model.kind] ?? { phase: "idle" };
              const probeable = APP_MODEL_KINDS.includes(model.kind as ModelKind);
              return (
                <li
                  key={model.kind}
                  className="flex flex-wrap items-center gap-x-[10px] gap-y-[4px]"
                  data-testid={`model-row-${model.kind}`}
                >
                  <span className="text-[13px] text-ink">{model.label}</span>
                  <span className="font-mono text-[11.5px] text-ink-2">
                    {model.model === "" ? "no model id" : model.model}
                  </span>
                  <span
                    className="text-[11.5px] text-muted"
                    data-testid={`model-key-${model.kind}`}
                  >
                    {model.key_set === null
                      ? "key unknown here"
                      : model.key_set
                        ? "key set"
                        : "no key"}
                  </span>
                  <span
                    className="flex items-center gap-[6px] text-[11.5px] text-ink-2"
                    data-testid={`model-status-${model.kind}`}
                  >
                    <StatusDot status={modelStatus(model)} />
                    {model.configured ? "configured" : "not set up"}
                  </span>
                  <span className="flex items-center gap-[8px] min-[640px]:ml-auto">
                    {model.kind === "worker_chat" && !model.configured ? (
                      <span
                        className="text-[11.5px] text-muted"
                        data-testid="model-worker-chat-hint"
                      >
                        set on the worker
                      </span>
                    ) : null}
                    {probeable && isAdmin ? (
                      <Button
                        variant="secondary"
                        compact
                        disabled={state.phase === "testing"}
                        onClick={() => void runProbe(model.kind)}
                        data-testid={`model-test-${model.kind}`}
                      >
                        {state.phase === "testing" ? "testing…" : "Test"}
                      </Button>
                    ) : null}
                    {state.phase === "done" ? (
                      <span
                        className="flex items-center gap-[6px] text-[11.5px]"
                        data-testid={`model-probe-${model.kind}`}
                      >
                        <StatusDot status={state.result.ok ? "ok" : "bad"} />
                        <span
                          className={state.result.ok ? "text-ink-2" : "text-st-failed-tag-fg"}
                          title={state.result.ok ? undefined : state.result.detail}
                        >
                          {state.result.ok
                            ? `ok · ${state.result.latency_ms} ms`
                            : `failed · ${detailLine(state.result.detail)}`}
                        </span>
                      </span>
                    ) : null}
                  </span>
                </li>
              );
            })}
          </ul>
        )
      ) : null}
    </OpsPanel>
  );
}

/** The MODELS tile's verdict: the app's own three models, never the worker's. */
export function appModels(overview: SystemOverview | null | undefined): OverviewModel[] {
  if (!overview) return [];
  return APP_MODEL_KINDS.map(
    (kind) =>
      overview.models.find((model) => model.kind === kind) ?? {
        kind,
        label: kind,
        model: "",
        endpoint_host: "",
        key_set: null,
        configured: false,
      },
  );
}
