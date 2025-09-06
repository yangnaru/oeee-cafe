import { Trans } from "@lingui/react/macro";
import { ModalWrapper } from "./ModalWrapper";

interface InitializationErrorModalProps {
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
    <ModalWrapper isOpen={isOpen}>
      <h2 className="text-highlight mt-0 mb-4 text-xl font-bold">
        <Trans>Initialization Failed</Trans>
      </h2>
      <p className="mb-6 leading-relaxed">{errorMessage}</p>
      <button
        onClick={onRetry}
        className="bg-highlight text-white border-0 px-6 py-3 rounded cursor-pointer text-base font-sans transition-colors hover:bg-orange-600"
      >
        <Trans>Retry</Trans>
      </button>
    </ModalWrapper>
  );
};