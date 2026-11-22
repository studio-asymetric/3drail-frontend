import React, { useEffect, useRef } from 'react';
import { REGION_ID, REGIONS, type RegionId } from '../region';
import type { AppLocale } from '../i18n';
import { REGION_SKETCH, REGION_SKETCH_SIZE } from '../data/regionSketch';

export interface MenuCopy {
  menuClose: string;
  menuRegion: string;
  menuLanguage: string;
  menuAppearance: string;
  menuDarkMode: string;
  regionNames: Record<RegionId, string>;
  regionMeta: Record<RegionId, string>;
}

interface Props {
  open: boolean;
  onClose: () => void;
  copy: MenuCopy;
  locale: AppLocale;
  onLocale: (locale: AppLocale) => void;
  theme: 'light' | 'dark';
  onTheme: (theme: 'light' | 'dark') => void;
  logo: string;
}

const REGION_ORDER: RegionId[] = ['sk', 'pid'];
/** Wider than this the menu is a card in the corner; narrower it fills the screen. */
const DESKTOP_QUERY = '(min-width: 801px)';

/**
 * Full-screen menu behind the hamburger. Regions are cards with a sketch of their rail network
 * (each region is a page of its own, "/" and "/pid", so choosing one opens it); language is a
 * two-way switch and the colour mode a toggle.
 */
export const MainMenu: React.FC<Props> = ({ open, onClose, copy, locale, onLocale, theme, onTheme, logo }) => {
  const closeRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) {
      return undefined;
    }
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    // On a computer the menu is a small card in the corner: a click anywhere else closes it
    // (the hamburger toggles it itself).
    const onPointerDown = (event: PointerEvent) => {
      if (!window.matchMedia(DESKTOP_QUERY).matches) {
        return;
      }
      const target = event.target as Element | null;
      if (target?.closest('.menu') || target?.closest('.chrome__tool--menu')) {
        return;
      }
      onClose();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', onPointerDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onPointerDown);
    };
  }, [open, onClose]);

  if (!open) {
    return null;
  }

  const dark = theme === 'dark';

  return (
    <div className="menu" role="dialog" aria-modal="true" aria-label="Menu">
      <div className="menu__head">
        <span className="menu__brand">
          <img src={logo} alt="" width={22} height={22} />
          Môj Vlak
        </span>
      </div>
      <button ref={closeRef} type="button" className="chrome__tool menu__close" aria-label={copy.menuClose} onClick={onClose}>
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M3 3l10 10M13 3L3 13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </button>
      <div className="menu__body">
        <section className="menu__group">
          <h2 className="menu__label">{copy.menuRegion}</h2>
          <div className="menu__regions">
            {REGION_ORDER.map((id) => {
              const current = id === REGION_ID;
              return (
                <a
                  key={id}
                  className={`menu__region${current ? ' is-current' : ''}`}
                  href={REGIONS[id].path}
                  aria-current={current ? 'page' : undefined}
                  onClick={(event) => {
                    if (current) {
                      event.preventDefault();
                      onClose();
                    }
                  }}
                >
                  <svg
                    className="menu__map"
                    viewBox={`0 0 ${REGION_SKETCH_SIZE.width} ${REGION_SKETCH_SIZE.height}`}
                    aria-hidden="true"
                    focusable="false"
                  >
                    <path className="menu__outline" d={REGION_SKETCH[id].outline} />
                    <path className="menu__rails" d={REGION_SKETCH[id].rails} />
                  </svg>
                  <span className="menu__region-text">
                    <span className="menu__region-name">{copy.regionNames[id]}</span>
                    <span className="menu__region-meta">{copy.regionMeta[id]}</span>
                  </span>
                  <span className="menu__tick" aria-hidden="true">
                    <svg viewBox="0 0 16 16" width="14" height="14" fill="none">
                      <path d="M3.5 8.5l3 3 6-7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </span>
                </a>
              );
            })}
          </div>
        </section>

        <section className="menu__group menu__row">
          <h2 className="menu__label">{copy.menuLanguage}</h2>
          <div className="menu__segment" role="radiogroup" aria-label={copy.menuLanguage} data-value={locale}>
            <span className="menu__thumb" aria-hidden="true" />
            <button type="button" role="radio" aria-checked={locale === 'sk'} onClick={() => onLocale('sk')}>
              SK
            </button>
            <button type="button" role="radio" aria-checked={locale === 'en'} onClick={() => onLocale('en')}>
              EN
            </button>
          </div>
        </section>

        <section className="menu__group menu__row">
          <h2 className="menu__label" id="menu-dark-label">
            {copy.menuAppearance}
          </h2>
          <button
            type="button"
            role="switch"
            aria-checked={dark}
            aria-label={copy.menuDarkMode}
            className="menu__switch"
            onClick={() => onTheme(dark ? 'light' : 'dark')}
          >
            <span className="menu__switch-icon menu__switch-icon--sun" aria-hidden="true">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                <circle cx="8" cy="8" r="3.1" stroke="currentColor" strokeWidth="1.4" />
                <path
                  d="M8 1.4v1.6M8 13v1.6M1.4 8h1.6M13 8h1.6M3.1 3.1l1.1 1.1M11.8 11.8l1.1 1.1M3.1 12.9l1.1-1.1M11.8 4.2l1.1-1.1"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  strokeLinecap="round"
                />
              </svg>
            </span>
            <span className="menu__switch-icon menu__switch-icon--moon" aria-hidden="true">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                <path d="M13.2 9.3A5.4 5.4 0 1 1 6.7 2.8 4.3 4.3 0 0 0 13.2 9.3Z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
              </svg>
            </span>
            <span className="menu__switch-knob" aria-hidden="true" />
          </button>
        </section>
      </div>
    </div>
  );
};
