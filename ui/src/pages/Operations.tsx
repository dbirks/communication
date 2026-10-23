import { OperationsBody } from "../components/ops/OperationsBody";

/**
 * The Operations surface — now a real Settings tab.
 *
 * The body itself lives in `components/ops/OperationsBody` so the
 * `/settings/operations` Settings tab and any future standalone mount render
 * the same implementation. The legacy `/ops` URL stays alive as a redirect to
 * the tab (`lib/routes.ts` → `/settings/operations`, owned by the Settings
 * page); this page component is the Operations mount point for that surface.
 */
export default function Operations() {
  return <OperationsBody />;
}
