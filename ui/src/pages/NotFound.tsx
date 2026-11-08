import { Mark } from "../components/ds/Mark";
import Page from "../components/ds/Page";

export default function NotFound() {
  // Empty states are still open in the handoff — keep the slot plain.
  return (
    <Page layout="reading" title="Not found">
      <div className="flex items-center gap-4">
        <Mark size={40} />
        <p className="text-body text-muted">That page does not exist.</p>
      </div>
    </Page>
  );
}
