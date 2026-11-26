/**
 * ChatHeader — 54px thread header with title, repo chip, participants,
 * control actions and details/artifacts access behind the "…" menu (redesign R3).
 */
import { useRef, useState } from "react";
import { Link } from "react-router";
import { IconArrowLeft, IconDots } from "@tabler/icons-react";
import { routes } from "../../lib/routes";
import { FormError } from "../Feedback";
import { Menu, type MenuEntry } from "../ds/Menu";
import type { ConversationSession } from "../conversation/useConversationSession";

export interface ChatHeaderProps {
  session: ConversationSession;
  projectId: string;
  scope: string | null;
  repositoryName: string | null;
  wholeProject: boolean;
  participants: readonly string[];
  showBack?: boolean;
  onOpenDetails: () => void;
  onOpenArtifacts: () => void;
}

export function ChatHeader({
  session,
  projectId,
  scope,
  repositoryName,
  wholeProject,
  participants,
  showBack = false,
  onOpenDetails,
  onOpenArtifacts,
}: ChatHeaderProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuTriggerRef = useRef<HTMLButtonElement>(null);

  const {
    data,
    control,
    isController,
    roleKnown,
    canRequestControl,
    status,
    takeControl,
    returnControl,
  } = session;

  if (!data) return null;

  const agentName = data.agent_profile_name ?? "agent";
  const peopleLabel =
    participants.length > 0 ? `${participants.join(", ")} · ${agentName}` : agentName;
  const controlError = takeControl.error ?? returnControl.error ?? null;

  const menuItems: MenuEntry[] = [
    {
      id: "details",
      label: "Details",
      testId: "chat-menu-details",
      onSelect: () => {
        setMenuOpen(false);
        onOpenDetails();
      },
    },
    {
      id: "artifacts",
      label: "Artifacts",
      testId: "chat-menu-artifacts",
      onSelect: () => {
        setMenuOpen(false);
        onOpenArtifacts();
      },
    },
  ];

  if (control) {
    menuItems.push({ separator: true });
    if (isController) {
      menuItems.push({
        id: "return-control",
        label: returnControl.isPending ? "Returning control…" : "Return control",
        testId: "return-control",
        disabled: returnControl.isPending || control.kind !== "human",
        onSelect: () => {
          setMenuOpen(false);
          returnControl.mutate({ version: control.version });
        },
      });
    } else {
      menuItems.push({
        id: "take-control",
        label: takeControl.isPending ? "Taking control…" : "Take control",
        testId: "take-control",
        disabled: takeControl.isPending || !roleKnown || !canRequestControl,
        title: !canRequestControl
          ? "Viewers cannot take control of a chat."
          : "Take control to send prompts",
        onSelect: () => {
          setMenuOpen(false);
          takeControl.mutate({ version: control.version });
        },
      });
    }
  }

  return (
    <>
      <header
        data-testid="chat-header"
        className="flex h-[54px] shrink-0 items-center gap-[10px] border-b border-line-soft bg-surface px-[20px]"
      >
        {showBack ? (
          <Link
            to={routes.chats(scope)}
            data-testid="chat-back"
            aria-label="Back to chats"
            className="inline-flex shrink-0 items-center justify-center rounded-[8px] p-[6px] text-ink-2 hover:bg-rail focus-visible:outline-2 focus-visible:outline-accent max-md:min-h-[44px] max-md:min-w-[44px]"
          >
            <IconArrowLeft size={18} stroke={1.5} aria-hidden="true" />
          </Link>
        ) : null}

        <h1 data-testid="chat-title" className="min-w-0 truncate text-[15px] font-bold text-ink">
          {data.title}
        </h1>

        {repositoryName ? (
          <Link
            to={routes.repository(projectId, repositoryName)}
            data-testid="chat-repo-chip"
            className="shrink-0 rounded-[6px] border border-line px-[7px] py-[2px] font-mono text-[11.5px] text-ink-2 hover:border-line-strong hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
          >
            {repositoryName}
          </Link>
        ) : wholeProject ? (
          <span
            data-testid="chat-repo-chip"
            className="shrink-0 rounded-[6px] border border-line px-[7px] py-[2px] font-mono text-[11.5px] text-muted"
          >
            Whole project
          </span>
        ) : null}

        <div className="min-w-0 flex-1" />

        {status === "live" ? (
          <span data-testid="stream-status" role="status" className="sr-only">
            live
          </span>
        ) : (
          <span
            data-testid="stream-status"
            role="status"
            className="shrink-0 font-mono text-[11px] text-st-retrying-tag-fg"
          >
            ↻ {status}
          </span>
        )}

        <span
          data-testid="chat-people"
          className="hidden min-w-0 max-w-[240px] shrink truncate text-[12.5px] text-muted sm:inline"
        >
          {peopleLabel}
        </span>

        <span className="relative inline-flex shrink-0">
          <button
            ref={menuTriggerRef}
            type="button"
            data-testid="chat-menu"
            aria-label="Chat actions"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((open) => !open)}
            className="inline-flex h-[30px] w-[30px] items-center justify-center rounded-[8px] border border-transparent text-ink-2 hover:border-line hover:bg-rail focus-visible:outline-2 focus-visible:outline-accent max-md:min-h-[44px] max-md:min-w-[44px]"
          >
            <IconDots size={16} stroke={1.5} aria-hidden="true" />
          </button>
          <Menu
            open={menuOpen}
            onClose={() => setMenuOpen(false)}
            triggerRef={menuTriggerRef}
            side="bottom"
            align="end"
            width={190}
            ariaLabel="Chat actions"
            data-testid="chat-menu-popover"
            items={menuItems}
          />
        </span>
      </header>
      {controlError ? (
        <div className="border-b border-line-soft bg-surface px-[20px] py-[6px]">
          <FormError error={controlError} testid="chat-control-error" />
        </div>
      ) : null}
    </>
  );
}
