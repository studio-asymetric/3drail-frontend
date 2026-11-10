import React from 'react';
import { DockScroller } from './DockScroller';
import type { AppLocale, Copy } from '../i18n';
import { AboutArticle } from './AboutArticle';

export const AboutPanel: React.FC<{ onBack: () => void; copy: Copy; locale: AppLocale }> = ({
  onBack,
  copy,
  locale,
}) => (
  <div className="dock__body about">
    <div className="dock__head">
      <div className="dock__meta">
        <p className="dock__identity">
          <span className="dock__pill is-station">{copy.aboutPill}</span>
          <span className="dock__name">railatlas</span>
        </p>
        <button type="button" className="dock__follow" onClick={onBack} aria-label={copy.back}>
          {copy.back}
        </button>
      </div>
    </div>
    <DockScroller loading={false} label={copy.loadingAbout} contentKey={`about-${locale}`}>
      <AboutArticle locale={locale} />
    </DockScroller>
  </div>
);
