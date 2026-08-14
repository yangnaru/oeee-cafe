import { Trans } from "@lingui/react/macro";
import { NEO_BUTTON } from "neo-cucumber";
import { ModalWrapper } from "./ModalWrapper";

export interface InitializationErrorModalProps {
  isOpen: boolean;
  errorMessage: string;
  onRetry: () => void;
}

export const InitializationErrorModal = ({
  isOpen,
  errorMessage,
  onRetry,
}: InitializationErrorModalProps) => {
  return (
    <ModalWrapper isOpen={isOpen} title={<Trans>Initialization Failed</Trans>}>
      <p className="mb-[12px] break-words">{errorMessage}</p>
      <button onClick={onRetry} className={NEO_BUTTON}>
        <Trans>Retry</Trans>
      </button>
    </ModalWrapper>
  );
};
