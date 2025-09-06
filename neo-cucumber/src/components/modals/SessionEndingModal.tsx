import { Trans } from "@lingui/react/macro";

interface SessionEndingModalProps {
  isOpen: boolean;
}

export const SessionEndingModal = ({ isOpen }: SessionEndingModalProps) => {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 w-screen h-screen bg-black bg-opacity-80 flex items-center justify-center z-[99999] pointer-events-auto">
      <div className="bg-main text-main p-8 rounded-xl border-2 border-main text-center max-w-md shadow-2xl">
        <div className="text-5xl mb-2 animate-spin">🥒</div>
        <div className="text-lg mb-4 leading-relaxed">
          <Trans>
            Session is ending. The drawing is being saved to the gallery...
          </Trans>
        </div>
        <div className="text-sm opacity-80 mt-2">
          <Trans>You'll be redirected to the post page shortly.</Trans>
        </div>
      </div>
    </div>
  );
};