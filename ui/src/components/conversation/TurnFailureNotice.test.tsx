/**
 * The failed-turn treatment (error-details-r6): one plain sentence on the
 * reading line, the worker's diagnostic behind a collapsed `Details`, and the
 * raw text never visible without it.
 *
 * The strings under test are the ones the lab actually served at the rcn-2e
 * review — a project uuid, a mirror path and an ADR number quoted at a person
 * who cannot act on any of them. The mapping is by the producer's own error
 * prefixes, so an unrecognised message says "This turn failed." rather than
 * inventing a cause.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  renderSplitAtTurnFailures,
  splitAtTurnFailures,
  turnFailureWords,
  TurnFailureNotice,
  TURN_FAILURE_FALLBACK,
  TURN_FAILURE_SILENT,
} from "./TurnFailureNotice";
import { conversationEvent } from "../../test/fakes";
import type { TranscriptItem } from "../../api/transcript";
import type { EventEnvelope } from "../../api/types";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** The exact line the review caught on screen. */
const MIRROR_NO_BRANCH =
  "worker: prepare workspace for project 01a19c73-99be-72da-b92b-4a74716530b2: " +
  "workspace: mirror /repos/01a19c73-99be-72da-b92b-4a74716530b2/server.git has no " +
  'branch "main" to base server on (ADR-0017 D2 refuses a branch-name guess)';

/** `internal/worker/launchfailure.go` — what a launcher that will not sign in
 * says since ce21ae7. Note the trailing “credential directory”: the phrase the
 * launcher-registry entry also matches, on a message that is NOT about a
 * missing directory. */
const LAUNCHER_NOT_SIGNED_IN =
  'worker: launcher "codex" is not signed in on this worker: the agent refused ' +
  "session/new because it requires a sign-in, JSON-RPC code -32000 \u2014 check this " +
  "launcher's credential directory on the worker that owns the turn";

/** The adapter's own words, for a control plane that quotes them whole. The
 * lab read this as a broken repository address (ADR-0068 round 4). */
const ACP_AUTH_REFUSAL = 'acp: session/new: {"code":-32000,"message":"Authentication required"}';

describe("turnFailureWords", () => {
  it("says 'no default branch' in one sentence, with no uuid, path or ADR number", () => {
    const words = turnFailureWords(MIRROR_NO_BRANCH);
    expect(words).toBe(
      "This thread couldn't start its workspace: the repository has no default branch to start from.",
    );
    expect(words).not.toMatch(/01a19c73|\/repos\/|ADR-0017|worker: prepare|mirror /);
  });

  it("maps the sibling workspace classes to their own sentences", () => {
    expect(
      turnFailureWords(
        "workspace: mirror /repos/x/api.git has neither a default branch nor a HEAD to base api on",
      ),
    ).toContain("no default branch");
    expect(
      turnFailureWords(
        'workspace: mirror /repos/x/api.git does not exist and repository "api" has no clone URL',
      ),
    ).toBe(
      "This thread couldn't start its workspace: the repository has no clone URL to fetch it from.",
    );
    expect(turnFailureWords("workspace: clone /work/x from mirror: fatal: not a git repo")).toBe(
      "This thread couldn't start its workspace: the repository could not be fetched.",
    );
    // Observed in the lab, verbatim apart from the uuid: a thread bound to a
    // repository whose address no worker can read. The generic workspace
    // sentence would have said "on this worker" and pointed nowhere.
    expect(
      turnFailureWords(
        "worker: prepare workspace for project 01a19d0b-262d-78b0-8a1e-62dcd837d01e: workspace: " +
          "create mirror /repos/01a19d0b-262d-78b0-8a1e-62dcd837d01e/server.git from " +
          "file://nonexistent/rcn2e-missing.git: git clone --mirror failed: fatal: " +
          "'nonexistent/rcn2e-missing.git' does not appear to be a git repository\nfatal: " +
          "Could not read from remote repository.",
      ),
    ).toBe(
      "This thread couldn't start its workspace: the repository's git address could not be read " +
        "from this worker — check it under the project's repositories.",
    );
    expect(turnFailureWords("worker: run unit: remote: Repository not found.")).toBe(
      "This thread couldn't start its workspace: the repository's git address could not be read " +
        "from this worker — check it under the project's repositories.",
    );
    expect(
      turnFailureWords(
        "worker: prepare workspace for project 01a19c73: workspace: worktree add: boom",
      ),
    ).toBe("This thread couldn't start its workspace on this worker.");
  });

  it("words a sandbox refusal in the sandbox vocabulary the verdict panel uses", () => {
    expect(
      turnFailureWords(
        "worker: sandbox grant_assert refused the launch (landlock_unavailable): no Landlock",
      ),
    ).toBe(
      "The sandbox refused to start the agent: the grants the policy promised could not be " +
        "asserted: the kernel offers no Landlock.",
    );
  });

  it("maps the permission and launcher refusals", () => {
    expect(
      turnFailureWords(
        "worker: permission mode ask needs a prompting mode for launcher pi; none is verified",
      ),
    ).toContain("no verified prompting mode");
    expect(
      turnFailureWords(
        'worker: permission mode autonomous_within_sandbox is only honest under sandbox enforcement "required" (ADR-0069)',
      ),
    ).toContain("runs without asking");
    expect(
      turnFailureWords(
        'agent.acp: launcher "pi" declares a credential directory at /x that is not usable: stat: no such file',
      ),
    ).toBe("This agent's sign-in is not set up on this worker.");
    expect(turnFailureWords('worker: launcher "pi" is not a known launcher')).toContain(
      "doesn't know the launcher",
    );
    expect(turnFailureWords("acp: session/new: EOF")).toBe(
      "The agent process couldn't be started.",
    );
  });

  it("reads a launcher's sign-in refusal as that, not as a broken repository", () => {
    // The round-4 confusion: a Codex turn whose workspace prepared cleanly on
    // the same worker was printed as “the repository's git address could not
    // be read”. The sentence now names the launcher the worker named.
    expect(turnFailureWords(LAUNCHER_NOT_SIGNED_IN)).toBe(
      "The agent on launcher codex isn't signed in on this worker, so this turn couldn't start.",
    );
    // Nothing about a repository, a workspace, or a directory: the git arm must
    // not fire on it, and neither must the launcher-registry one.
    expect(turnFailureWords(LAUNCHER_NOT_SIGNED_IN)).not.toMatch(/git|repository|workspace|dir/i);
    // …and the launcher-registry sentence is still there for the failure it
    // describes (a profile that points at a directory that is not usable).
    expect(
      turnFailureWords(
        'agent.acp: launcher "pi" declares a credential directory at /x that is not usable: stat: no such file',
      ),
    ).toBe("This agent's sign-in is not set up on this worker.");
  });

  it("maps the harness's raw -32000 refusal to the same sign-in sentence", () => {
    // No `launcher "x"` in this one — the adapter never names itself, so the
    // sentence says “This agent” rather than inventing a name.
    expect(turnFailureWords(ACP_AUTH_REFUSAL)).toBe(
      "This agent isn't signed in on this worker, so this turn couldn't start.",
    );
    // A bare “Authentication required” with no git beside it is still the
    // agent's refusal; an unrelated `acp:` failure keeps its own sentence.
    expect(turnFailureWords("acp: initialize: Authentication failed")).toBe(
      "This agent isn't signed in on this worker, so this turn couldn't start.",
    );
    expect(turnFailureWords("acp: session/new: EOF")).toBe(
      "The agent process couldn't be started.",
    );
  });

  it("names the agent a sign-in refusal came from when the surface can name it", () => {
    expect(
      turnFailureWords(LAUNCHER_NOT_SIGNED_IN, (launcherId) =>
        launcherId === "codex" ? "Codex · gpt-5" : null,
      ),
    ).toBe("Codex · gpt-5 isn't signed in on this worker, so this turn couldn't start.");
    // No read names the launcher → the machine's word, never an invented one.
    expect(turnFailureWords(LAUNCHER_NOT_SIGNED_IN, () => null)).toContain("launcher codex");
  });

  it("keeps the git sentence for git's own authentication failure", () => {
    // Genuine git: the phrase rides with `git`/`remote:` vocabulary beside it,
    // on a workspace path the reader can act on under the project's repos.
    const gitAuth =
      "worker: prepare workspace for project 01a19d0b: git fetch origin main: " +
      "fatal: Authentication required (exit 128)";
    expect(turnFailureWords(gitAuth)).toBe(
      "This thread couldn't start its workspace: the repository's git address could not be read " +
        "from this worker — check it under the project's repositories.",
    );
    expect(
      turnFailureWords(
        "worker: run unit: git clone --mirror https://github.com/acme/server.git: " +
          "remote: Repository not found.",
      ),
    ).toContain("git address could not be read");
  });

  it("says the honest generic sentence for a message this build has no words for", () => {
    expect(turnFailureWords("attemptloop: takeover closed the paired turn")).toBe(
      TURN_FAILURE_FALLBACK,
    );
    expect(turnFailureWords(null)).toBe(TURN_FAILURE_SILENT);
  });
});

function failedFrame(message: string): EventEnvelope {
  return conversationEvent("conversation.turn.failed", { turn_id: "t-1", message });
}

function systemItem(id: string, text: string): TranscriptItem {
  return { kind: "system", id, text, at: "2026-11-01T12:00:00Z" };
}

function userItem(id: string, turnId: string, text: string): TranscriptItem {
  return {
    kind: "user",
    id,
    turnId,
    authorUserId: "u-1",
    text,
    at: "2026-11-01T12:00:00Z",
  };
}

describe("splitAtTurnFailures", () => {
  it("cuts the raw line out of the run and names the failure in its place", () => {
    const frame = failedFrame(MIRROR_NO_BRANCH);
    const items = [
      userItem("m-1", "t-1", "Do the thing."),
      systemItem(frame.event_id, `Turn failed: ${MIRROR_NO_BRANCH}`),
      userItem("m-2", "t-2", "Try again."),
    ];
    const blocks = splitAtTurnFailures(items, [frame]);
    expect(blocks.map((block) => block.kind)).toEqual(["items", "failure", "items"]);
    if (blocks[0].kind === "items") expect(blocks[0].items).toHaveLength(1);
    if (blocks[1].kind === "failure") expect(blocks[1].failure.message).toBe(MIRROR_NO_BRANCH);
    // The raw line is gone from every run — it is what the notice replaces.
    for (const block of blocks) {
      if (block.kind === "items") {
        expect(block.items.some((item) => "text" in item && item.text.includes("/repos/"))).toBe(
          false,
        );
      }
    }
  });

  it("returns one run, untouched, when no turn failed", () => {
    const items = [userItem("m-1", "t-1", "Do the thing.")];
    expect(splitAtTurnFailures(items, [])).toEqual([{ kind: "items", items }]);
  });

  it("prints nothing for a failure whose line is not on this surface", () => {
    // A turn-filtered pane holds only one turn's items; a frame from another
    // turn must not invent a row this list says nothing about.
    const frame = failedFrame(MIRROR_NO_BRANCH);
    const blocks = splitAtTurnFailures([userItem("m-1", "t-1", "Do the thing.")], [frame]);
    expect(blocks).toEqual([{ kind: "items", items: [expect.objectContaining({ id: "m-1" })] }]);
  });
});

describe("TurnFailureNotice", () => {
  it("prints one plain sentence and keeps the server's words behind a closed Details", () => {
    render(<TurnFailureNotice failure={{ id: "f-1", message: MIRROR_NO_BRANCH }} />);
    const notice = screen.getByTestId("turn-failed");
    expect(screen.getByTestId("turn-failed-plain").textContent).toBe(
      "This thread couldn't start its workspace: the repository has no default branch to start from.",
    );
    // The leak is the point: the reading line carries no uuid, no path and no
    // ADR number — the raw text lives only inside the closed disclosure.
    expect(screen.getByTestId("turn-failed-plain").textContent).not.toContain("01a19c73");
    expect(screen.getByTestId("turn-failed-plain").textContent).not.toContain("ADR-0017");

    const details = notice.querySelector("details") as HTMLDetailsElement;
    expect(details).toBeTruthy();
    expect(details.open).toBe(false);
    expect(details.querySelector("summary")?.textContent).toBe("Details");
    // …and it is the evidence, quoted whole for whoever can read it.
    expect(screen.getByTestId("turn-failed-server").textContent).toBe(
      `server said: ${MIRROR_NO_BRANCH}`,
    );
    expect(details.contains(screen.getByTestId("turn-failed-server"))).toBe(true);
    fireEvent.click(details.querySelector("summary") as HTMLElement);
    expect((notice.querySelector("details") as HTMLDetailsElement).open).toBe(true);
  });

  it("shows no disclosure at all when the frame carried no message", () => {
    render(<TurnFailureNotice failure={{ id: "f-1", message: null }} />);
    expect(screen.getByTestId("turn-failed-plain").textContent).toBe(TURN_FAILURE_SILENT);
    expect(screen.queryByTestId("turn-failed-details")).toBeNull();
  });

  it("prints a sign-in refusal as the agent's own sentence, server line still disclosed", () => {
    render(
      <TurnFailureNotice
        failure={{ id: "f-1", message: ACP_AUTH_REFUSAL }}
        agentName={(launcherId) => (launcherId ? `the agent (${launcherId})` : null)}
      />,
    );
    // The adapter never names its own launcher, so no read can name it here:
    // the sentence stays the agent's, and the git sentence is nowhere on the
    // line the reader sees.
    expect(screen.getByTestId("turn-failed-plain").textContent).toBe(
      "This agent isn't signed in on this worker, so this turn couldn't start.",
    );
    expect(screen.getByTestId("turn-failed-plain").textContent).not.toMatch(/git|repositor/i);
    expect(screen.getByTestId("turn-failed-server").textContent).toBe(
      `server said: ${ACP_AUTH_REFUSAL}`,
    );
  });

  it("uses the surface's agent name in the sign-in sentence", () => {
    render(
      <TurnFailureNotice
        failure={{ id: "f-1", message: LAUNCHER_NOT_SIGNED_IN }}
        agentName={(launcherId) => (launcherId === "codex" ? "Codex" : null)}
      />,
    );
    expect(screen.getByTestId("turn-failed-plain").textContent).toBe(
      "Codex isn't signed in on this worker, so this turn couldn't start.",
    );
  });
});

describe("renderSplitAtTurnFailures", () => {
  it("hands the whole list to the renderer when nothing failed", () => {
    const items = [userItem("m-1", "t-1", "Do the thing.")];
    const calls: TranscriptItem[][] = [];
    renderSplitAtTurnFailures(items, [], "k", (list) => {
      calls.push(list);
      return null;
    });
    expect(calls).toEqual([items]);
  });

  it("calls the renderer once per surviving run, plus the notice", () => {
    const frame = failedFrame(MIRROR_NO_BRANCH);
    const items = [
      userItem("m-1", "t-1", "Do the thing."),
      systemItem(frame.event_id, `Turn failed: ${MIRROR_NO_BRANCH}`),
    ];
    render(
      <div>
        {renderSplitAtTurnFailures(items, [frame], "k", (list) => (
          <ul data-testid="run">
            {list.map((item) => (
              <li key={item.id}>{item.id}</li>
            ))}
          </ul>
        ))}
      </div>,
    );
    expect(screen.getAllByTestId("run")).toHaveLength(1);
    expect(screen.getByTestId("run").textContent).toBe("m-1");
    expect(screen.getByTestId("turn-failed-plain").textContent).toContain("no default branch");
  });
});
