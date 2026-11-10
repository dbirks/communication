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
      {/* Walk-through finding 1: the host OWNS the viewport under the shell and
          clips. It carries no `flex-1` on purpose — a flex item with
          `flex-basis:0%` in an auto-height column ignores its own `h-screen`
          and collapses to the height of its content, which is what stopped the
          three columns at ~470px on the 1280/1440 shots. The height here is
          definite, and the frame inside it runs the chain down
          (`flex-1 min-h-0`) to the columns. */}
      <div
        ref={hostRef}
        data-testid="assistant-page-column"
        className="flex h-[calc(100vh-44px)] min-h-0 w-full shrink-0 flex-col overflow-hidden bg-surface md:h-screen"
      />
    </Page>
  );
}
