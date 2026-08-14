import { Trans } from "@lingui/react/macro";
import type { SyncProgress } from "../../hooks/useWebSocket";

export interface ConnectionStatusModalProps {
  isCatchingUp: boolean;
  connectionState: "connecting" | "connected" | "disconnected";
  onReconnect: () => void;
  onDownloadPNG: () => void;
  syncProgress: SyncProgress;
  synchronizationError: string | null;
}

export const ConnectionStatusModal = ({
  isCatchingUp,
  connectionState,
  onReconnect,
  onDownloadPNG,
  syncProgress,
  synchronizationError,
}: ConnectionStatusModalProps) => {
  if (connectionState === "connected" && !isCatchingUp) {
    return null;
  }

  if (isCatchingUp && !synchronizationError) {
    const hasTarget = syncProgress.targetSequence !== null && syncProgress.targetSequence > 0;
    const percent = hasTarget
      ? Math.min(100, Math.round(syncProgress.appliedSequence / syncProgress.targetSequence! * 100))
      : null;
    return (
      <div className="absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 z-[1000] bg-black bg-opacity-80 text-white p-5 text-center shadow-lg backdrop-blur-sm">
        <div className="text-5xl mb-3 animate-spin-slow">🥒</div>
        <div className="text-base font-bold animate-pulse-slow">
          {syncProgress.phase === "joining" ? <Trans>Connecting...</Trans> : <Trans>Loading...</Trans>}
        </div>
        {percent !== null && (
          <div className="mt-3 min-w-64" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
            <div className="mb-1 text-xs">{syncProgress.appliedSequence} / {syncProgress.targetSequence} ({percent}%)</div>
            <div className="h-2 border border-white"><div className="h-full bg-white transition-[width]" style={{ width: `${percent}%` }} /></div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 z-[1000] bg-main text-main p-6 border-2 border-main text-center shadow-lg min-w-80 font-sans touch-auto select-auto">
      {(connectionState === "disconnected" || synchronizationError) && (
        <>
          <div className="text-base mb-6 leading-relaxed text-main">
            {synchronizationError
              ? <Trans>The shared drawing could not be synchronized safely. Your current canvas is still available to download.</Trans>
              : <Trans>Connection lost. Your work is saved locally.</Trans>}
          </div>
          <div className="flex gap-4 justify-center">
            <button
              className="px-4 py-2 border border-main bg-main text-main cursor-pointer text-sm font-sans transition-colors hover:bg-highlight hover:text-white"
              onClick={onReconnect}
            >
              <Trans>Reconnect</Trans>
            </button>
            <button
              className="px-4 py-2 border border-main bg-main text-main cursor-pointer text-sm font-sans transition-colors hover:bg-highlight hover:text-white"
              onClick={onDownloadPNG}
            >
              <Trans>Download PNG</Trans>
            </button>
          </div>
        </>
      )}
      {connectionState === "connecting" && (
        <>
          <div className="text-3xl mb-3 animate-spin">🥒</div>
          <div>
            <Trans>Connecting...</Trans>
          </div>
        </>
      )}
    </div>
  );
};
