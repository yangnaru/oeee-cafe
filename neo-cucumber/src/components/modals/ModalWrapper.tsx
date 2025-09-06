import React from "react";

interface ModalWrapperProps {
  isOpen: boolean;
  children: React.ReactNode;
  className?: string;
  zIndex?: string;
  onBackdropClick?: () => void;
}

export const ModalWrapper = ({
  isOpen,
  children,
  className = "max-w-sm",
  zIndex = "z-[9999]",
  onBackdropClick,
}: ModalWrapperProps) => {
  if (!isOpen) return null;

  return (
    <div
      className={`fixed inset-0 bg-black bg-opacity-70 flex justify-center items-center ${zIndex}`}
      onClick={onBackdropClick}
    >
      <div
        className={`bg-main text-main p-8 rounded-lg border-2 border-main text-center shadow-lg ${className}`}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
};