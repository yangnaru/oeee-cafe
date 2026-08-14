import React from "react";
import { NEO_PANEL, NEO_TITLEBAR } from "neo-cucumber";

export interface ModalWrapperProps {
  isOpen: boolean;
  children: React.ReactNode;
  /** Shown in the panel's title bar, the way NEO names a window. */
  title?: React.ReactNode;
  className?: string;
  zIndex?: string;
  onBackdropClick?: () => void;
}

export const ModalWrapper = ({
  isOpen,
  children,
  title,
  className = "max-w-sm",
  zIndex = "z-[9999]",
  onBackdropClick,
}: ModalWrapperProps) => {
  if (!isOpen) return null;

  return (
    <div
      // `bg-opacity-70` was a Tailwind 3 utility and compiles to nothing in
      // Tailwind 4, which left every dialog behind a solid black screen.
      className={`fixed inset-0 flex items-center justify-center bg-black/70 ${zIndex}`}
      onClick={onBackdropClick}
    >
      <div
        className={`${NEO_PANEL} shadow-lg ${className}`}
        onClick={(e) => e.stopPropagation()}
      >
        {title && (
          <div className={`${NEO_TITLEBAR} px-[4px] text-[11px] leading-[14px]`}>
            {title}
          </div>
        )}
        <div className="p-[12px] text-center">{children}</div>
      </div>
    </div>
  );
};
