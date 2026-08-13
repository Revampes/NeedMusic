import React, { useEffect, useRef } from "react";
import { IconAlert } from "@ui/components/Icons";

interface ConfirmDialogProps {
  title: string;
  message: React.ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Small centered confirmation modal. Used for destructive actions like
 * permanently deleting a track's file.
 */
const ConfirmDialog: React.FC<ConfirmDialogProps> = ({
  title,
  message,
  confirmLabel = "Confirm",
  danger = true,
  onConfirm,
  onCancel,
}) => {
  const confirmRef = useRef<HTMLButtonElement>(null);

  // Focus the confirm button and close on Escape.
  useEffect(() => {
    confirmRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div className="confirm-dialog-overlay" onClick={onCancel}>
      <div
        className="confirm-dialog"
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="confirm-dialog-icon">
          <IconAlert size={20} />
        </div>
        <div className="confirm-dialog-body">
          <h3>{title}</h3>
          <div className="confirm-dialog-message">{message}</div>
        </div>
        <div className="confirm-dialog-actions">
          <button className="confirm-dialog-btn" onClick={onCancel}>Cancel</button>
          <button
            ref={confirmRef}
            className={`confirm-dialog-btn ${danger ? "confirm-dialog-btn-danger" : "confirm-dialog-btn-primary"}`}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
};

export default ConfirmDialog;
