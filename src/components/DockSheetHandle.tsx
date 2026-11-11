import React from 'react';

type DockSheetHandleProps = {
  expanded: boolean;
  expandLabel: string;
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
  gesture,
}) => (
  <div
    className="dock__sheet-handle"
    role="slider"
    aria-label={expandLabel}
    aria-valuetext={expanded ? 'Expanded' : 'Collapsed'}
    {...(gesture ?? {})}
  >
    <span className="dock__sheet-grab" aria-hidden="true" />
  </div>
);
