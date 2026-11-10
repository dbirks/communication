/**
 * The assistant's full page (`/assistant`, handoff §1).
 *
 * The frame — thread list left, conversation ≤720px centre, "Looking at" +
 * "Changes" + trust right — is built by the assistant container
 * (`components/assistant/AssistantPanel`'s `AssistantPageFrame`), because the
 * conversation, its draft and a turn in flight belong to that one mounted
 * engine and must survive switching sizes. What THIS route owns is the HOST:
 * the content-column element the engine portals the page-mode conversation
 * into, registered for as long as the route stands (and released when the
 * lazy chunk unmounts), so the sidebar stays and the URL is shareable.
 *
 * Visiting `/assistant` directly opens the conversation at its largest size;
 * the engine watches the route, so a reload or a Back-button arrival behaves
 * exactly like pressing Full page.
 */
import { useEffect, useRef } from "react";
import Page from "../components/ds/Page";
import { setAssistantPageHost } from "../components/assistant/AssistantPopover";

export default function AssistantPage() {
  const hostRef = useRef<HTMLDivElement | null>(null);
  // React runs the ref callback before effects, and the engine subscribes to
  // the handoff, so the element is published once here and withdrawn on
  // unmount — a page-mode frame never outlives its route.
  useEffect(() => {
    setAssistantPageHost(hostRef.current);
    return () => setAssistantPageHost(null);
  }, []);

  return (
    <Page layout="canvas" testid="assistant-page-host">
      <div
        ref={hostRef}
        data-testid="assistant-page-column"
        className="flex h-[calc(100vh-44px)] min-h-0 flex-1 flex-col md:h-screen"
      />
    </Page>
  );
}
