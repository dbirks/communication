/**
 * The profile sheet on Manage → Agents & models (artboard 3e, as a 560px
 * right-hand sheet over the table): the profile name in the header, an × and
 * Esc back to the agents page keeping the query string, and the existing
 * ProfileDetail body with exactly the props the old page passes — launchers,
 * sandbox, canWrite and the APM pin form's own open state.
 *
 * An unknown id is an honest sentence, not an error banner: the sheet closes
 * and the reader comes back to the table, which is what a 404 would mean.
 * The table stays visible behind the sheet (no backdrop).
 */
import { useEffect } from "react";
import { ProblemBanner, Spinner } from "../../../components/Feedback";
import ProfileDetail from "../../../components/profiles/ProfileDetail";
import type { AgentProfile } from "../../../api/types";
import type { Launcher, SystemSandbox } from "../../../lib/profiles";

export interface ProfileSheetProps {
  /** The profile the sheet shows; null while the list is loading or when the
   * id names nothing. */
  profile: AgentProfile | null;
  /** The list is still being read. */
  loading: boolean;
  /** The list failed to read — the sheet says so, rather than claim the
   * profile is missing. */
  loadError: unknown;
  onRetry?: () => void;
  canWrite: boolean;
  launchers: Launcher[] | null;
  sandbox: SystemSandbox | null | undefined;
  apmOpen: boolean;
  onApmToggle: () => void;
  onClose: () => void;
}

export default function ProfileSheet({
  profile,
  loading,
  loadError,
  onRetry,
  canWrite,
  launchers,
  sandbox,
  apmOpen,
  onApmToggle,
  onClose,
}: ProfileSheetProps) {
  // Esc closes the sheet, not the page — the table and the rest of the
  // agents page stay put.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const close = () => onClose();

  const title = profile?.name ?? "Agent profile";

  return (
    <div
      role="dialog"
      aria-label={title}
      data-testid="profile-sheet"
      className="fixed top-[60px] right-0 bottom-0 z-30 w-full max-w-[560px] overflow-y-auto border-l border-line bg-white px-6 py-5 shadow-[var(--shadow-pop)]"
    >
      <header className="flex items-center justify-between gap-4 border-b border-line pb-3">
        <h2 className="min-w-0 truncate text-[18px] font-bold">{title}</h2>
        <button
          type="button"
          aria-label="Close the profile panel"
          data-testid="profile-sheet-close"
          onClick={close}
          className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[8px] text-[20px] leading-none text-muted hover:bg-fill focus-visible:outline-2 focus-visible:outline-accent"
        >
          ×
        </button>
      </header>
      <div className="pt-4">
        {loading && !profile ? (
          <Spinner label="Loading the profile" />
        ) : loadError && !profile ? (
          <ProblemBanner
            error={loadError}
            fallback="The agent profiles could not be read."
            testid="profile-sheet-error"
            retry={onRetry ? { onClick: onRetry } : undefined}
          />
        ) : profile ? (
          <ProfileDetail
            profile={profile}
            canWrite={canWrite}
            launchers={launchers}
            sandbox={sandbox}
            apmOpen={apmOpen}
            onApmToggle={onApmToggle}
          />
        ) : (
          <p className="text-[12.5px] text-muted" data-testid="profile-sheet-missing">
            That agent profile doesn&apos;t exist.
          </p>
        )}
      </div>
    </div>
  );
}
