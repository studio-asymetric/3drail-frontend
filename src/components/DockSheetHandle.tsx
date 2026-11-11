import React, { useRef } from 'react';

type DockSheetHandleProps = {
  expanded: boolean;
  onExpand: () => void;
  onCollapse: () => void;
  expandLabel: string;
};

export const DockSheetHandle: React.FC<DockSheetHandleProps> = ({
  expanded,
  onExpand,
  onCollapse,
  expandLabel,
}) => {
  const dragRef = useRef<{ startY: number; dragging: boolean } | null>(null);

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { startY: event.clientY, dragging: true };
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current?.dragging) {
      return;
    }
    const delta = event.clientY - dragRef.current.startY;
    if (!expanded && delta < -48) {
      dragRef.current.dragging = false;
      onExpand();
    } else if (expanded && delta > 56) {
      dragRef.current.dragging = false;
      onCollapse();
    }
  };

  const onPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current?.dragging) {
      return;
    }
    const delta = event.clientY - dragRef.current.startY;
    dragRef.current = null;
    if (!expanded && delta < -28) {
      onExpand();
    } else if (expanded && delta > 36) {
      onCollapse();
    }
  };

  return (
    <div
      className="dock__sheet-handle"
      role="slider"
      aria-label={expandLabel}
      aria-valuetext={expanded ? 'Expanded' : 'Collapsed'}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      <span className="dock__sheet-grab" aria-hidden="true" />
    </div>
  );
};
