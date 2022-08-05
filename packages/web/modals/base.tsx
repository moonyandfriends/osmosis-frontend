import Image from "next/image";
import React, { FunctionComponent, ReactElement } from "react";
import ReactModal, { setAppElement } from "react-modal";
import classNames from "classnames";
import { useWindowSize } from "../hooks";

setAppElement("body");

export interface ModalBaseProps {
  isOpen: boolean;
  onRequestClose: () => void;
  onRequestBack?: () => void;
  title?: string | ReactElement;
  className?: string;
  bodyOpenClassName?: string;
  overlayClassName?: string;
  hideCloseButton?: boolean;
}

export const ModalBase: FunctionComponent<ModalBaseProps> = ({
  isOpen,
  onRequestClose,
  onRequestBack,
  title,
  className,
  bodyOpenClassName,
  overlayClassName,
  hideCloseButton,
  children,
}) => {
  const { isMobile } = useWindowSize();

  return (
    <ReactModal
      isOpen={isOpen}
      onRequestClose={(e) => {
        e.preventDefault();
        onRequestClose();
      }}
      bodyOpenClassName={classNames("overflow-hidden", bodyOpenClassName)}
      overlayClassName={classNames(
        "fixed flex items-center inset-0 justify-center bg-modalOverlay z-50",
        overlayClassName
      )}
      className={classNames(
        "absolute text-center outline-none md:w-[90%] w-full md:p-4 p-8 bg-surface rounded-2xl z-50 flex flex-col max-w-modal",
        className
      )}
    >
      <div className="flex items-center place-content-between">
        {onRequestBack && (
          <button
            aria-label="back"
            className="md:top-4 md:left-4 top-5 left-5 cursor-pointer z-50"
            onClick={onRequestBack}
          >
            <Image
              alt="back button"
              src="/icons/chevron-left.svg"
              height={isMobile ? 24 : 32}
              width={isMobile ? 24 : 32}
            />
          </button>
        )}
        {typeof title === "string" ? (
          <div className="relative mx-auto">
            {isMobile ? <h6>{title}</h6> : <h5>{title}</h5>}
          </div>
        ) : (
          <>{title}</>
        )}
        {!hideCloseButton && (
          <button
            aria-label="close"
            className="md:top-4 md:right-4 top-5 right-5 cursor-pointer z-50"
            onClick={onRequestClose}
          >
            <Image
              src={"/icons/close-dark.svg"}
              alt="close icon"
              width={isMobile ? 24 : 32}
              height={isMobile ? 24 : 32}
            />
          </button>
        )}
      </div>
      {children}
    </ReactModal>
  );
};
