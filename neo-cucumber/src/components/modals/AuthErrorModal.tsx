import { Trans } from "@lingui/react/macro";
import { ModalWrapper } from "./ModalWrapper";

interface AuthErrorModalProps {
  isOpen: boolean;
  onGoToLobby: () => void;
}

export const AuthErrorModal = ({
  isOpen,
  onGoToLobby,
}: AuthErrorModalProps) => {
  return (
    <ModalWrapper isOpen={isOpen}>
      <h2 className="text-highlight mt-0 mb-4 text-xl font-bold">
        <Trans>Authentication Failed</Trans>
      </h2>
      <p className="mb-6 leading-relaxed">
        <Trans>
          Unable to authenticate your session. Either the session
          doesn't exist, or it has expired. Please return to the lobby.
        </Trans>
      </p>
      <button
        onClick={onGoToLobby}
        className="bg-highlight text-white border-0 px-6 py-3 rounded cursor-pointer text-base font-sans transition-colors hover:bg-orange-600"
      >
        <Trans>Go to Lobby</Trans>
      </button>
    </ModalWrapper>
  );
};