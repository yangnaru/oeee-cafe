import { Trans } from "@lingui/react/macro";
import { NEO_BUTTON } from "neo-cucumber";
import { ModalWrapper } from "./ModalWrapper";

export interface RoomFullModalProps {
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
    <ModalWrapper
      isOpen={isOpen}
      title={<Trans>Session Full</Trans>}
      className="max-w-md"
    >
      <p className="mb-[12px]">
        <Trans>
          This session is full ({currentUserCount}/{maxUsers} users). Only the first{" "}
          {maxUsers} users can join a session.
        </Trans>
      </p>
      <div className="flex justify-center gap-[6px]">
        <button onClick={onGoToLobby} className={NEO_BUTTON}>
          <Trans>Go to Lobby</Trans>
        </button>
        <button onClick={onRetry} className={NEO_BUTTON}>
          <Trans>Retry</Trans>
        </button>
      </div>
    </ModalWrapper>
  );
};
