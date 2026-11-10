/**
 * Settings → Assistant (handoff A5/A6, exploration 1n/1o/1p): the per-person
 * trust level that gates the assistant's tools, the table of exactly which
 * actions ask at each level, the decision-model status line, and the Speech
 * section (what the server's env exposes + the two dictation switches).
 * Everything here is stored as a user preference (contract C2) and checked in
 * the assistant's tool loop before each action — it authorizes nothing on its
 * own. The trust labels and blurbs are READ from `TRUST_LEVELS`: the pill menu
 * and this page can never drift apart, and no copy promises that an action
 * can be undone.
 */
import type { ReactNode } from "react";
import { IconAlertCircle, IconCheck } from "@tabler/icons-react";
import { Alert } from "../../components/ds/Alert";
import { useSystemStatus } from "../../api/assistant";
import {
  DEFAULT_TRUST_LEVEL,
  TRUST_LEVELS,
  type TrustLevel,
} from "../../components/assistant/types";
import { useAssistantPrefs, useAssistantSpeechPrefs } from "../../lib/prefs";
import { PrefRadioGroup } from "./Layout";

/** The trust radios, straight from the pill menu's source of truth. */
const TRUST_OPTIONS = TRUST_LEVELS.map((level) => ({
  value: level.value,
  label: level.label,
  note: level.blurb,
  isDefault: level.value === DEFAULT_TRUST_LEVEL,
}));

/** 1p: one short column per level, in the menu's order. */
const TRUST_TABLE_COLUMNS: ReadonlyArray<{ value: TrustLevel; header: string }> = [
  { value: "ask_all", header: "Every change" },
  { value: "ask_risky", header: "When risky" },
  { value: "no_ask", header: "Don't ask" },
];

/** 1p: the fixed table (`internal/assistant/trust.go`), as the person reads it. */
const TRUST_TABLE_ROWS: ReadonlyArray<{ action: string; cells: [string, string, string] }> = [
  { action: "Read, search, navigate", cells: ["—", "—", "—"] },
  { action: "Edit a draft", cells: ["asks", "—", "—"] },
  { action: "Create project / add repo", cells: ["asks", "asks*", "—"] },
  { action: "Start or retry a run", cells: ["asks", "asks*", "—"] },
  { action: "Approve, grant permission", cells: ["asks", "always", "—"] },
  { action: "Publish a workflow", cells: ["asks", "asks*", "—"] },
  { action: "Credentials, members, delete", cells: ["never", "never", "never"] },
];

export default function AssistantSettings() {
  const { trustLevel, setTrustLevel, saved } = useAssistantPrefs();

  return (
    <div className="space-y-4" data-testid="settings-assistant">
      <PrefRadioGroup
        legend="Trust level"
        name="trust-level"
        testid="settings-assistant-trust-level"
        value={trustLevel}
        onChange={setTrustLevel}
        options={TRUST_OPTIONS}
      />
      <TrustActionTable level={trustLevel} />
      <DecisionModelLine />
      <p className="px-2 text-[12px] leading-[1.45] text-muted">
        The assistant acts as you, so it can never do more than your role allows.
      </p>
      {saved ? null : (
        <Alert state="info" label="NOT SAVED" testid="settings-assistant-not-saved" role="status">
          Not saved: this server doesn&apos;t store preferences yet. The choice applies for this
          session.
        </Alert>
      )}
      <SpeechSection />
    </div>
  );
}

/** 1p: "Which actions ask at your level". The current level's column carries
 * the accent wash, so the row answers the question for THIS person. */
function TrustActionTable({ level }: { level: TrustLevel }) {
  return (
    <section className="px-2" data-testid="settings-assistant-trust-table">
      <h2 className="pb-1 font-mono text-[10.5px] font-semibold tracking-[.04em] text-muted uppercase">
        Which actions ask at your level
      </h2>
      <table className="w-full border-collapse">
        <thead>
          <tr className="border-b border-line">
            <th className="py-1 pr-2 text-left font-mono text-[11px] font-semibold tracking-[.04em] text-muted uppercase">
              Action
            </th>
            {TRUST_TABLE_COLUMNS.map((column) => (
              <th
                key={column.value}
                data-testid={`settings-assistant-trust-table-head-${column.value}`}
                aria-current={column.value === level ? "true" : undefined}
                className={`px-2 py-1 text-center font-mono text-[11px] font-semibold tracking-[.04em] uppercase ${
                  column.value === level ? "bg-accent-wash text-ink" : "text-muted"
                }`}
              >
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {TRUST_TABLE_ROWS.map((row, rowIndex) => (
            <tr
              key={row.action}
              data-testid={`settings-assistant-trust-table-row-${rowIndex}`}
              className="border-b border-line"
            >
              <td className="py-1 pr-2 text-left text-[13px] text-ink">{row.action}</td>
              {TRUST_TABLE_COLUMNS.map((column, columnIndex) => (
                <td
                  key={column.value}
                  data-testid={`settings-assistant-trust-table-cell-${rowIndex}-${column.value}`}
                  className={`px-2 py-1 text-center text-[13px] ${
                    column.value === level ? "bg-accent-wash text-ink" : "text-ink-2"
                  }`}
                >
                  {row.cells[columnIndex]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <p
        data-testid="settings-assistant-trust-table-footnote"
        className="pt-1 text-[12px] leading-[1.45] text-faint"
      >
        * With a decision model, it decides these case by case and asks when a call looks risky.
        Without one, they always ask.
      </p>
    </section>
  );
}

/** A5: one honest line about the judge, from the same status read the setup
 * checklist uses. While the read is unavailable nothing is claimed. */
function DecisionModelLine() {
  const status = useSystemStatus();
  if (!status.data) return null;
  const judge = status.data.decision_model;
  return (
    <p
      data-testid="settings-assistant-decision-model"
      className="px-2 font-mono text-[11px] text-muted"
    >
      {judge.configured
        ? `Decision model: ${judge.model} · if it's down, it asks you`
        : "Decision model: none set up · the fixed table decides"}
    </p>
  );
}

/**
 * A6 (exploration 1n): what the server's speech env actually exposes, read
 * from `GET /api/v1/assistant/status` — the key's value is never shown, only
 * whether one is set — plus the two dictation switches, stored in the same
 * preference section as the trust level.
 */
function SpeechSection() {
  const status = useSystemStatus();
  const { speechAutoSend, setSpeechAutoSend, speechBrowserFallback, setSpeechBrowserFallback } =
    useAssistantSpeechPrefs();
  const speech = status.data?.speech_model;
  return (
    <section
      className="rounded-[3px] border border-line-strong bg-surface p-3"
      data-testid="settings-assistant-speech"
    >
      <h2 className="font-mono text-[10px] font-semibold tracking-[.04em] text-muted uppercase">
        Speech
      </h2>
      {speech ? (
        <dl className="mt-1" data-testid="settings-assistant-speech-rows">
          <SpeechRow row="endpoint" label="Endpoint">
            {speech.endpoint_host ? `${speech.endpoint_host} · from env` : "not set"}
          </SpeechRow>
          <SpeechRow row="model" label="Model">
            {speech.model ? speech.model : "not set"}
          </SpeechRow>
          <SpeechRow row="key" label="Key">
            {speech.key_set === true ? "set · never shown" : "not set"}
          </SpeechRow>
          <SpeechRow row="status" label="Status">
            {speech.configured ? (
              <span className="inline-flex items-center gap-1">
                <IconCheck size={12} stroke={2} aria-hidden className="shrink-0" />
                configured
              </span>
            ) : (
              <span className="inline-flex items-center gap-1">
                <IconAlertCircle size={12} stroke={2} aria-hidden className="shrink-0" />
                not configured — dictation uses the browser
              </span>
            )}
          </SpeechRow>
        </dl>
      ) : null}
      <div className="mt-2 space-y-1.5">
        <label
          data-testid="settings-assistant-speech-auto-send"
          className="flex cursor-pointer items-start gap-2 text-[13px] text-ink"
        >
          <input
            type="checkbox"
            checked={speechAutoSend}
            onChange={(event) => setSpeechAutoSend(event.target.checked)}
            className="mt-[3px] size-[13px] cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
          />
          Send after I stop talking (otherwise it waits in the box)
        </label>
        <label
          data-testid="settings-assistant-speech-browser-fallback"
          className="flex cursor-pointer items-start gap-2 text-[13px] text-ink"
        >
          <input
            type="checkbox"
            checked={speechBrowserFallback}
            onChange={(event) => setSpeechBrowserFallback(event.target.checked)}
            className="mt-[3px] size-[13px] cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
          />
          Fall back to the browser&apos;s speech recognition when the endpoint is down
        </label>
      </div>
      <p
        data-testid="settings-assistant-speech-audio-note"
        className="mt-2 text-[12px] leading-[1.45] text-faint"
      >
        Audio is discarded after transcription.
      </p>
    </section>
  );
}

/** One definition row: faint label left, mono value right, line between rows. */
function SpeechRow({ row, label, children }: { row: string; label: string; children: ReactNode }) {
  return (
    <div
      data-testid={`settings-assistant-speech-${row}`}
      className="flex items-baseline justify-between gap-2 border-b border-line py-1 last:border-b-0"
    >
      <dt className="text-[12px] text-faint">{label}</dt>
      <dd className="font-mono text-[11.5px] text-ink-2">{children}</dd>
    </div>
  );
}
