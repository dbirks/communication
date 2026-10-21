/**
 * Settings → Assistant (README "Settings → Assistant"): the per-person trust
 * level that gates the assistant's tools (README "Interactions → Trust level").
 * It is stored as a user preference (contract C2) and checked in the
 * assistant's tool loop before each action — it authorizes nothing on its own.
 */
import { Alert } from "../../components/ds/Alert";
import { useAssistantPrefs, type TrustLevel } from "../../lib/prefs";
import { PrefRadioGroup, type PrefOption } from "./Layout";

/** One line per option, from README "Interactions → Trust level". */
const TRUST_OPTIONS: PrefOption<TrustLevel>[] = [
  {
    value: "ask_all",
    label: "Ask before everything",
    note: "Every tool call that changes state, including navigation, shows a confirm card.",
  },
  {
    value: "ask_risky",
    label: "Ask for risky actions",
    isDefault: true,
    note: "It can read, navigate, tour and edit drafts on its own. It asks before starting or retrying runs, approving gates, allowing permission requests, and publishing or promoting.",
  },
  {
    value: "no_ask",
    label: "Don't ask",
    note: "It can do everything, with each action logged and undo offered where possible.",
  },
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
      <p className="px-2 text-[12px] leading-[1.45] text-muted">
        The assistant acts as you, so it can never do more than your role allows.
      </p>
      {saved ? null : (
        <Alert state="info" label="NOT SAVED" testid="settings-assistant-not-saved" role="status">
          Not saved: this server doesn&apos;t store preferences yet. The choice applies for this
          session.
        </Alert>
      )}
    </div>
  );
}
