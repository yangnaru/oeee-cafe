import { Trans } from "@lingui/react/macro";
import { NEO_BUTTON } from "neo-cucumber";
import { ModalWrapper } from "./ModalWrapper";

export interface AuthErrorModalProps {
  isOpen: boolean;
  onGoToLobby: () => void;
}

export const AuthErrorModal = ({
  isOpen,
  onGoToLobby,
}: AuthErrorModalProps) => {
  return (
    <ModalWrapper isOpen={isOpen} title={<Trans>Authentication Failed</Trans>}>
      <p className="mb-[12px]">
        <Trans>
          Unable to authenticate your session. Either the session
          doesn't exist, or it has expired. Please return to the lobby.
        </Trans>
      </p>
      <button onClick={onGoToLobby} className={NEO_BUTTON}>
        <Trans>Go to Lobby</Trans>
      </button>
    </ModalWrapper>
  );
};
