import { Trans, useLingui } from "@lingui/react/macro";
import { Icon } from "@iconify/react";

interface SessionExpiredModalProps {
  isOpen: boolean;
  isOwner: boolean;
  canvasMeta: {
    savedPostId?: string;
  } | null;
  isSaving: boolean;
  onClose: () => void;
  onSaveToGallery: () => Promise<void>;
  onDownloadPNG: () => void;
  onReturnToLobby: () => void;
}

export const SessionExpiredModal = ({
  isOpen,
  isOwner,
  canvasMeta,
  isSaving,
  onClose,
  onSaveToGallery,
  onDownloadPNG,
  onReturnToLobby,
}: SessionExpiredModalProps) => {
  const { t } = useLingui();

  if (!isOpen) return null;

  const handleSaveToGallery = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      onClose(); // Close the modal
      await onSaveToGallery();
    } catch (error) {
      // Reopen modal if save fails
      // Show appropriate error message
      if (
        error instanceof Error &&
        error.message.includes("already been saved")
      ) {
        alert(
          t`This session has already been saved. You can only download it as a PNG.`
        );
      } else {
        alert(
          t`Failed to save session. Please try downloading as PNG instead.`
        );
      }
    }
  };

  const handleDownloadPNG = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onDownloadPNG();
  };

  const handleReturnToLobby = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onReturnToLobby();
  };

  return (
    <div className="fixed inset-0 w-screen h-screen bg-black bg-opacity-80 flex items-center justify-center z-[999999] pointer-events-auto">
      <div
        className="bg-main text-main p-8 rounded-xl border-2 border-main text-center max-w-md shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-5xl mb-2">
          <Icon
            icon="material-symbols:warning"
            width={48}
            height={48}
            className="text-yellow-500"
          />
        </div>
        <div className="text-2xl font-bold mb-2 text-highlight">
          <Trans>Session Expired</Trans>
        </div>
        <div className="text-lg mb-4 leading-relaxed">
          {isOwner
            ? canvasMeta?.savedPostId
              ? t`This collaborative session has ended due to inactivity. The session has already been saved to the gallery, but you can download it as a PNG.`
              : t`This collaborative session has ended due to inactivity. As the owner, you can save it to the gallery or download it as a PNG.`
            : t`This collaborative session has ended due to inactivity. You can save your work locally as a PNG before leaving.`}
        </div>
        <div className="flex gap-4 justify-center mt-6 flex-wrap">
          {isOwner ? (
            <>
              {!canvasMeta?.savedPostId && (
                <button
                  onClick={handleSaveToGallery}
                  disabled={isSaving}
                  type="button"
                  className={`py-3 px-6 bg-highlight text-white border border-highlight rounded-md text-base font-sans pointer-events-auto relative z-[9999999] transition-opacity ${
                    isSaving
                      ? "opacity-70 cursor-not-allowed"
                      : "cursor-pointer hover:bg-orange-600"
                  }`}
                >
                  {isSaving ? (
                    <span className="flex items-center gap-2">
                      <Icon
                        icon="material-symbols:refresh"
                        width={16}
                        height={16}
                        className="animate-spin"
                      />
                      <Trans>Saving...</Trans>
                    </span>
                  ) : (
                    <span className="flex items-center gap-2">
                      <Icon
                        icon="material-symbols:save"
                        width={16}
                        height={16}
                      />
                      <Trans>Save to Gallery</Trans>
                    </span>
                  )}
                </button>
              )}
              <button
                onClick={handleDownloadPNG}
                type="button"
                className={`py-3 px-6 rounded-md text-base font-sans pointer-events-auto relative z-[9999999] transition-colors ${
                  canvasMeta?.savedPostId
                    ? "bg-highlight text-white border border-highlight hover:bg-orange-600"
                    : "bg-main text-main border border-main hover:bg-highlight hover:text-white"
                }`}
              >
                <span className="flex items-center gap-2">
                  <Icon
                    icon="material-symbols:download"
                    width={16}
                    height={16}
                  />
                  <Trans>Download PNG</Trans>
                </span>
              </button>
            </>
          ) : (
            <button
              onClick={handleDownloadPNG}
              type="button"
              className="py-3 px-6 bg-highlight text-white border border-highlight rounded-md text-base font-sans pointer-events-auto relative z-[9999999] cursor-pointer hover:bg-orange-600"
            >
              <span className="flex items-center gap-2">
                <Icon icon="material-symbols:save" width={16} height={16} />
                <Trans>Save as PNG</Trans>
              </span>
            </button>
          )}
          <button
            onClick={handleReturnToLobby}
            type="button"
            className="py-3 px-6 bg-main text-main border border-main rounded-md text-base font-sans pointer-events-auto relative z-[9999999] cursor-pointer hover:bg-highlight hover:text-white transition-colors"
          >
            <Trans>Return to Lobby</Trans>
          </button>
        </div>
      </div>
    </div>
  );
};
