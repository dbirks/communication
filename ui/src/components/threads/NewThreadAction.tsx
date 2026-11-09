/**
 * The `New thread` verb of `/threads` (finding 07, review pass on the
 * captures: finding 07's duplicate title).
 *
 * The threads screen is a `canvas` page that mounts the shared `PageBand`
 * ("Threads"), so its H1 sits at the ONE left edge and baseline every other
 * route measures. That leaves no room for the list pane's own `Threads`
 * heading — and the heading is what used to carry the pane's primary verb
 * beside it. The verb does not belong to the list, it belongs to the page, so
 * it rides the band's `actions` slot instead, and the dialog it opens is
 * declared with it (nothing else on the screen triggers it).
 *
 * The stable test id `threads-new-open` travels with the button: the emulator
 * (`journeys`, `thread-control`, `projects` threads-1g) presses it on
 * `/threads`, and `design.ts`'s `threads-new` landmark reads it.
 */
import { useState } from "react";
import NewConversationDialog from "../NewConversationDialog";
import { Button } from "../ds/Button";

export function NewThreadAction() {
  const [open, setOpen] = useState(false);
  return (
    <>
      {/* `compact` (26px) is what keeps the band at `PAGE_BAND_HEIGHT_PX`: the
          title line is 28px under `pt-[20px]`, and `ThreadsView` subtracts that
          48px from the viewport it fills, so a 30px button would push the two
          panes 2px past the fold. */}
      <Button
        variant="primary"
        compact
        data-testid="threads-new-open"
        onClick={() => setOpen(true)}
      >
        New thread
      </Button>
      <NewConversationDialog open={open} onClose={() => setOpen(false)} />
    </>
  );
}

export default NewThreadAction;
