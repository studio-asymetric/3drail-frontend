import React from 'react';

type DockSheetHandleProps = {
  expanded: boolean;
  expandLabel: string;
  /** Keyboard and screen readers; a pointer tap is handled by the sheet's gesture. */
  onToggle?: () => void;
  gesture?: {
    onPointerDown: (event: React.PointerEvent<HTMLElement>) => void;
    onPointerMove: (event: React.PointerEvent<HTMLElement>) => void;
    onPointerUp: (event: React.PointerEvent<HTMLElement>) => void;
    onPointerCancel: (event: React.PointerEvent<HTMLElement>) => void;
  };
};

export const DockSheetHandle: React.FC<DockSheetHandleProps> = ({
  expanded,
  expandLabel,
  onToggle,
  gesture,
}) => (
  <div
    className="dock__sheet-handle"
    role="slider"
    aria-label={expandLabel}
    aria-valuetext={expanded ? 'Expanded' : 'Collapsed'}
    tabIndex={onToggle ? 0 : undefined}
    onKeyDown={(event) => {
      if (onToggle && (event.key === 'Enter' || event.key === ' ')) {
        event.preventDefault();
        onToggle();
      }
    }}
    {...(gesture ?? {})}
  >
    <span className="dock__sheet-grab" aria-hidden="true" />
  </div>
);
