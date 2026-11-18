import React from 'react';

type DockPanelControlsProps = {
  backLabel: string;
  closeLabel: string;
  onBack: () => void;
  onClose: () => void;
  /** Sits between back and close (the follow button). */
  center?: React.ReactNode;
};

export const DockPanelControls: React.FC<DockPanelControlsProps> = ({
  backLabel,
  closeLabel,
  onBack,
  onClose,
  center,
}) => (
  <nav className="dock__nav" aria-label={backLabel}>
    <button type="button" className="dock__nav-btn dock__nav-btn--back" onClick={onBack}>
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
        <path
          d="M8.75 2.45 4.2 7l4.55 4.55"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      <span>{backLabel}</span>
    </button>
    <div className="dock__nav-center">{center}</div>
    <button
      type="button"
      className="dock__nav-btn dock__nav-btn--close"
      onClick={onClose}
      aria-label={closeLabel}
    >
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
        <path d="M2.8 2.8l8.4 8.4M11.2 2.8l-8.4 8.4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    </button>
  </nav>
);
