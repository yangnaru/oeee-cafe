import { Trans } from "@lingui/react/macro";
import { ModalWrapper } from "./ModalWrapper";

export interface SessionEndingModalProps {
  isOpen: boolean;
}

export const SessionEndingModal = ({ isOpen }: SessionEndingModalProps) => {
  return (
    <ModalWrapper
      isOpen={isOpen}
      title={<Trans>Saving...</Trans>}
      className="max-w-md"
      zIndex="z-[99999]"
    >
      <div className="mb-[8px] animate-spin text-[32px]">🥒</div>
      <div className="mb-[8px]">
        <Trans>
          Session is ending. The drawing is being saved to the gallery...
        </Trans>
      </div>
      <div className="text-[11px] opacity-80">
        <Trans>You'll be redirected to the post page shortly.</Trans>
      </div>
    </ModalWrapper>
  );
};
