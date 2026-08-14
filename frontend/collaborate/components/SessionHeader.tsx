import { Trans } from "@lingui/react/macro";
import { Icon } from "@iconify/react";
import { NEO_BUTTON, NEO_PANEL } from "neo-cucumber";

interface CollaborationMeta {
  title: string;
  width: number;
  height: number;
  ownerId: string;
  savedPostId?: string;
  ownerLoginName: string;
  maxUsers: number;
  currentUserCount: number;
}

export interface SessionHeaderProps {
  canvasMeta: CollaborationMeta;
  connectionState: "connecting" | "connected" | "disconnected";
  isCatchingUp: boolean;
}

export const SessionHeader = ({
  canvasMeta,
  connectionState,
  isCatchingUp,
}: SessionHeaderProps) => {
  const handleShare = () => {
    if (navigator.share) {
      navigator
        .share({
          title: canvasMeta.title,
          url: window.location.href,
        })
        .catch(console.error);
    } else {
      navigator.clipboard
        .writeText(window.location.href)
        .then(() => {
          // Could show a toast notification here
          console.log("URL copied to clipboard");
        })
        .catch(console.error);
    }
  };

  return (
    // The bar the painter's windows float over, in the painter's own chrome.
    <div className={`${NEO_PANEL} flex shrink-0 items-center justify-between gap-[8px] px-[6px] py-[4px]`}>
      <div className="flex min-w-0 items-center gap-[8px]">
        <a href="/collaborate" className="text-[18px] hover:opacity-70">
          🥒
        </a>
        <h1 className="m-0 truncate text-[14px] font-bold">{canvasMeta.title}</h1>
        <div className="shrink-0 text-[11px] opacity-70">
          <Trans>by</Trans> @{canvasMeta.ownerLoginName}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-[6px] text-[11px]">
        <button
          onClick={handleShare}
          className={`${NEO_BUTTON} flex items-center gap-[3px]`}
          title="Share this session"
        >
          <Icon icon="material-symbols:upload" width={14} height={14} />
          <Trans>Share</Trans>
        </button>
        {connectionState === "connected" && !isCatchingUp && (
          <div className="flex items-center gap-[3px] opacity-80">
            <div className="h-[6px] w-[6px] bg-green-500 rounded-full"></div>
            <Trans>Connected</Trans>
          </div>
        )}
        {connectionState === "connecting" && (
          <div className="flex items-center gap-[3px] opacity-80">
            <div className="h-[6px] w-[6px] bg-yellow-500 rounded-full animate-pulse"></div>
            <Trans>Connecting</Trans>
          </div>
        )}
        {connectionState === "disconnected" && !isCatchingUp && (
          <div className="flex items-center gap-[3px] opacity-80">
            <div className="h-[6px] w-[6px] bg-red-500 rounded-full"></div>
            <Trans>Disconnected</Trans>
          </div>
        )}
        {isCatchingUp && (
          <div className="flex items-center gap-[3px] opacity-80">
            <div className="h-[6px] w-[6px] bg-blue-500 rounded-full animate-pulse"></div>
            <Trans>Loading</Trans>
          </div>
        )}
      </div>
    </div>
  );
};
