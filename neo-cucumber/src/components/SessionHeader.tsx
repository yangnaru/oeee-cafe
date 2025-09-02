import { Trans } from "@lingui/react/macro";

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

interface SessionHeaderProps {
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
      navigator.share({
        title: canvasMeta.title,
        url: window.location.href
      }).catch(console.error);
    } else {
      navigator.clipboard.writeText(window.location.href).then(() => {
        // Could show a toast notification here
        console.log('URL copied to clipboard');
      }).catch(console.error);
    }
  };

  return (
    <div className="bg-main border-b border-main px-4 py-3 flex items-center justify-between">
      <div className="flex items-center gap-4">
        <a
          href="/collaborate"
          className="text-2xl hover:opacity-70 transition-opacity"
        >
          🥒
        </a>
        <h1 className="text-xl font-bold text-main m-0">
          {canvasMeta.title}
        </h1>
        <div className="text-sm text-main opacity-70">
          <Trans>by</Trans> @{canvasMeta.ownerLoginName}
        </div>
      </div>
      <div className="flex items-center gap-2 text-sm text-main opacity-70">
        <button
          onClick={handleShare}
          className="flex items-center gap-1 px-2 py-1 rounded hover:bg-main hover:bg-opacity-20 transition-colors text-main opacity-70 hover:opacity-100"
          title="Share this session"
        >
          <span>📤</span>
          <Trans>Share</Trans>
        </button>
        {connectionState === "connected" && !isCatchingUp && (
          <div className="flex items-center gap-1">
            <div className="w-2 h-2 bg-green-500 rounded-full"></div>
            <Trans>Connected</Trans>
          </div>
        )}
        {connectionState === "connecting" && (
          <div className="flex items-center gap-1">
            <div className="w-2 h-2 bg-yellow-500 rounded-full animate-pulse"></div>
            <Trans>Connecting</Trans>
          </div>
        )}
        {connectionState === "disconnected" && (
          <div className="flex items-center gap-1">
            <div className="w-2 h-2 bg-red-500 rounded-full"></div>
            <Trans>Disconnected</Trans>
          </div>
        )}
        {isCatchingUp && (
          <div className="flex items-center gap-1">
            <div className="w-2 h-2 bg-blue-500 rounded-full animate-pulse"></div>
            <Trans>Loading</Trans>
          </div>
        )}
      </div>
    </div>
  );
};