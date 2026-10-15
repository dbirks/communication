import { Mark } from "../components/ds/Mark";

export default function NotFound() {
  // Empty states are still open in the handoff — keep the slot plain.
  return (
    <section className="flex items-center gap-4">
      <Mark size={40} />
      <div>
        <h1 className="text-title-l font-bold">Not found</h1>
        <p className="mt-1 text-body text-muted">That page does not exist.</p>
      </div>
    </section>
  );
}
