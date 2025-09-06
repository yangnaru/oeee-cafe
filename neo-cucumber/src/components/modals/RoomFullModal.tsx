import { Trans } from "@lingui/react/macro";
import { ModalWrapper } from "./ModalWrapper";

interface RoomFullModalProps {
  isOpen: boolean;
  currentUserCount: number;
  maxUsers: number;
  onGoToLobby: () => void;
  onRetry: () => void;
}

export const RoomFullModal = ({
  isOpen,
  currentUserCount,
  maxUsers,
  onGoToLobby,
  onRetry,
}: RoomFullModalProps) => {
  return (
    <ModalWrapper isOpen={isOpen} className="max-w-md">
      <h2 className="text-highlight mt-0 mb-4 text-xl font-bold">
        <Trans>Session Full</Trans>
      </h2>
      <p className="mb-6 leading-relaxed">
        <Trans>
          This session is full ({currentUserCount}/{maxUsers} users). Only the first{" "}
          {maxUsers} users can join a session.
        </Trans>
      </p>
      <div className="flex gap-3 justify-center">
        <button
          onClick={onGoToLobby}
          className="bg-highlight text-white border-0 px-6 py-3 rounded cursor-pointer text-base font-sans transition-colors hover:bg-orange-600"
        >
          <Trans>Go to Lobby</Trans>
        </button>
        <button
          onClick={onRetry}
          className="bg-gray-500 text-white border-0 px-6 py-3 rounded cursor-pointer text-base font-sans transition-colors hover:bg-gray-600"
        >
          <Trans>Retry</Trans>
        </button>
      </div>
    </ModalWrapper>
  );
};