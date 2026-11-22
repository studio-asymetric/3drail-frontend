import React from 'react';
import type { AppLocale, Copy } from '../i18n';
import { AboutArticle } from './AboutArticle';
import { DockInfoPanel, type DockInfoSheet } from './DockInfoPanel';

export const AboutPanel: React.FC<{ onBack: () => void; copy: Copy; locale: AppLocale; sheet: DockInfoSheet }> = ({
  onBack,
  copy,
  locale,
  sheet,
}) => (
  <DockInfoPanel
    {...sheet}
    pill={copy.aboutPill}
    title="Môj Vlak"
    backLabel={copy.back}
    onBack={onBack}
    contentKey={`about-${locale}`}
    loadingLabel={copy.loadingAbout}
  >
    <AboutArticle locale={locale} />
  </DockInfoPanel>
);
