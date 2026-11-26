/**
 * TopBarSlot — the page's way into the top bar's left region (CONTRACT
 * "Shell": "A page replaces it by rendering `<TopBarLeft>…</TopBarLeft>`").
 *
 * The mechanism is a portal into the node `TopBar` owns
 * (`#top-bar-left-slot`), looked up after mount and re-looked-up whenever the
 * DOM changes, so a page that renders before the bar does (or survives the
 * wide ⇄ phone swap, which replaces the node) still lands in the right place.
 *
 * A page never has to tell the bar it is there: `TopBar` watches the node's
 * children and drops the default scope name while it holds anything.
 */
import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

/** The id `TopBar` prints on its left region and the id this portal targets.
 * Kept here so both sides read one constant. */
export const TOP_BAR_LEFT_SLOT_ID = "top-bar-left-slot";

export interface TopBarLeftProps {
  children: ReactNode;
}

/**
 * Render `children` inside the top bar's left region. Nothing is drawn until
 * the region exists, and nothing is drawn twice: the children leave the
 * page's own layout as soon as the bar mounts.
 */
export function TopBarLeft({ children }: TopBarLeftProps) {
  const [slot, setSlot] = useState<HTMLElement | null>(() =>
    typeof document === "undefined" ? null : document.getElementById(TOP_BAR_LEFT_SLOT_ID),
  );

  useEffect(() => {
    const sync = () => {
      const node = document.getElementById(TOP_BAR_LEFT_SLOT_ID);
      setSlot((current) => (node === current ? current : node));
    };
    sync();
    // The bar mounts, unmounts and swaps its phone variant independently of
    // this component; a subtree observer on `body` is how the lookup notices,
    // and it is only installed while a page is actually asking for the slot.
    const observer = new MutationObserver(sync);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);

  // A node that has left the document (the wide ⇄ phone swap) is not a target.
  if (!slot || !slot.isConnected) return null;
  return createPortal(children, slot);
}
