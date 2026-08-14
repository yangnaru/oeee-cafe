import { Trans } from "@lingui/react/macro";
import { ModalWrapper } from "./ModalWrapper";

export interface LoadingModalProps {
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
    <ModalWrapper isOpen={isOpen} title={title}>
      <div className="mb-[8px] animate-spin-slow text-[32px]">🥒</div>
      <p>{message}</p>
    </ModalWrapper>
  );
};
