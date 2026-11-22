import React, { useEffect, useRef, useState } from 'react';
import { REGION_ID, REGIONS, VEHICLE_MODES, type RegionId, type VehicleMode } from '../region';
import type { AppLocale } from '../i18n';
import { REGION_SKETCH, REGION_SKETCH_SIZE } from '../data/regionSketch';

export interface MenuCopy {
  menuClose: string;
  menuRegion: string;
  menuLanguage: string;
  menuAppearance: string;
  menuDarkMode: string;
  menuAbout: string;
  menuShow: string;
  modeNames: Record<VehicleMode, string>;
  menuStudio: string;
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
  /** Opens the About panel (on a phone the menu is where it lives). */
  onAbout: () => void;
  /** Which kinds of vehicle are drawn (a region with more than trains). */
  modes: VehicleMode[];
  onToggleMode: (mode: VehicleMode) => void;
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
export const MainMenu: React.FC<Props> = ({ open, onClose, copy, locale, onLocale, theme, onTheme, onAbout, modes, onToggleMode, logo }) => {
  const closeRef = useRef<HTMLButtonElement | null>(null);
  // Stays in the page while it fades out (the same exit as the left panel), then goes.
  const [mounted, setMounted] = useState(open);
  const leaving = mounted && !open;

  useEffect(() => {
    if (open) {
      setMounted(true);
      return undefined;
    }
    if (!mounted) {
      return undefined;
    }
    // animationend does it; the timer covers reduced motion, where there is no animation
    const timer = window.setTimeout(() => setMounted(false), 400);
    return () => window.clearTimeout(timer);
  }, [open, mounted]);

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

  if (!mounted) {
    return null;
  }

  const dark = theme === 'dark';

  return (
    <div
      className={`menu${leaving ? ' menu--leave' : ''}`}
      role="dialog"
      aria-modal="true"
      aria-label="Menu"
      onAnimationEnd={(event) => {
        if (leaving && event.target === event.currentTarget) {
          setMounted(false);
        }
      }}
    >
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

        {REGION_ID === 'pid' && (
          <section className="menu__group">
            <h2 className="menu__label">{copy.menuShow}</h2>
            <div className="menu__chips" role="group" aria-label={copy.menuShow}>
              {VEHICLE_MODES.map((mode) => (
                <button
                  key={mode}
                  type="button"
                  className={`menu__chip${modes.includes(mode) ? ' is-on' : ''}`}
                  aria-pressed={modes.includes(mode)}
                  onClick={() => onToggleMode(mode)}
                >
                  {copy.modeNames[mode]}
                </button>
              ))}
            </div>
          </section>
        )}

        <section className="menu__group menu__duo">
          <div className="menu__item">
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
          </div>
          <div className="menu__item">
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
          </div>
        </section>
        <section className="menu__group menu__links">
          <button type="button" className="menu__row-link menu__row-link--about" onClick={onAbout}>
            {copy.menuAbout}
          </button>
          <a className="menu__row-link" href="https://asymetric.studio" target="_blank" rel="noopener">
            <span>
              <small>{copy.menuStudio}</small>
              Studio Asymetric
            </span>
            <svg className="menu__ext" width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                <path d="M3.5 2.5h6v6M9.5 2.5l-7 7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
          </a>
        </section>
      </div>
    </div>
  );
};
