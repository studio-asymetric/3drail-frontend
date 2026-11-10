import React from 'react';

type DockPanelControlsProps = {
  backLabel: string;
  closeLabel: string;
  onBack: () => void;
  onClose: () => void;
};

export const DockPanelControls: React.FC<DockPanelControlsProps> = ({
  backLabel,
  closeLabel,
  onBack,
  onClose,
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
    <button
      type="button"
      className="dock__nav-btn dock__nav-btn--close"
      onClick={onClose}
      aria-label={closeLabel}
    >
      <span aria-hidden="true">×</span>
    </button>
  </nav>
);
