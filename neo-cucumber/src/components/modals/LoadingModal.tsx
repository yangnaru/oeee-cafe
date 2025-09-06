import { Trans } from "@lingui/react/macro";
import { ModalWrapper } from "./ModalWrapper";

interface LoadingModalProps {
  isOpen: boolean;
  title?: React.ReactNode;
  message?: React.ReactNode;
}

export const LoadingModal = ({
  isOpen,
  title = <Trans>Loading...</Trans>,
  message = <Trans>Initializing collaboration session...</Trans>,
}: LoadingModalProps) => {
  return (
    <ModalWrapper isOpen={isOpen}>
      <h2 className="text-xl font-bold mb-4">{title}</h2>
      <p>{message}</p>
    </ModalWrapper>
  );
};