import React from 'react';
import { DockScroller } from './DockScroller';
import { DockSheetHandle } from './DockSheetHandle';
import type { useMobileDockSheet } from '../hooks/useMobileDockSheet';

export interface DockInfoSheet {
  isMobile: boolean;
  /** The pull-up sheet's state and gestures (phones). */
  sheet: ReturnType<typeof useMobileDockSheet>;
  open: boolean;
  revealed: boolean;
  onExpandedChange: (expanded: boolean) => void;
  expandLabel: string;
}

interface Props extends DockInfoSheet {
  /** Small label before the title ("O aplikácii", "Mimoriadnosti"). */
  pill: string;
  title: string;
  backLabel: string;
  onBack: () => void;
  contentKey: string;
  loadingLabel: string;
  children: React.ReactNode;
}

/**
 * A text panel in the left dock: on a computer a header with a back button over a scrolling body;
 * on a phone the same pull-up sheet the trains and stations use (handle, peek line, drag).
 */
export const DockInfoPanel: React.FC<Props> = ({
  isMobile,
  sheet,
  open,
  revealed,
  onExpandedChange,
  expandLabel,
  pill,
  title,
  backLabel,
  onBack,
  contentKey,
  loadingLabel,
  children,
}) => (
  <div
    className={`dock__body dock__info${isMobile ? ' dock__body--sheet-touch' : ''}${
      isMobile && !revealed ? ' dock__body--sheet-collapsed' : ''
    }`}
    {...(isMobile ? sheet.gesture : {})}
  >
    {isMobile && (
      <>
        <DockSheetHandle expanded={open} expandLabel={expandLabel} onToggle={() => onExpandedChange(!open)} />
        <button
          type="button"
          className="dock__peek"
          aria-expanded={open}
          onClick={() => {
            if (sheet.consumePeekClick()) {
              return;
            }
            onExpandedChange(true);
          }}
        >
          <span className="dock__peek-identity">
            <span className="dock__pill is-station">{pill}</span>
            <span className="dock__name">{title}</span>
          </span>
        </button>
      </>
    )}
    <div className="dock__sheet-main">
      {!isMobile && (
        <div className="dock__head">
          <div className="dock__meta">
            <p className="dock__identity">
              <span className="dock__pill is-station">{pill}</span>
              <span className="dock__name">{title}</span>
            </p>
            <button type="button" className="dock__follow" onClick={onBack} aria-label={backLabel}>
              {backLabel}
            </button>
          </div>
        </div>
      )}
      <DockScroller
        loading={false}
        label={loadingLabel}
        contentKey={contentKey}
        listPointerHandoff={sheet.listPointerHandoff}
        listAtScrollTop={sheet.listAtScrollTop}
      >
        {children}
      </DockScroller>
    </div>
  </div>
);
