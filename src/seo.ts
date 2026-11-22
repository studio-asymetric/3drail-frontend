import type { AppLocale } from './i18n';
import { REGION_ID } from './region';

const SITE_NAME = 'Môj Vlak';

const DEFAULTS: Record<AppLocale, { title: string; description: string }> = {
  sk: {
    title: 'Mapa vlakov a poloha vlakov ZSSK naživo | Môj Vlak',
    description:
      'Mapa vlakov Slovenska: poloha vlakov ZSSK naživo, meškanie, zastávky, odchody zo staníc a mimoriadnosti na trati. Kde je váš vlak práve teraz.',
  },
  en: {
    title: 'Live train map of Slovakia – train positions | Môj Vlak',
    description:
      'Môj Vlak shows where Slovak trains are right now: live positions on a map, delays, stop lists, station departures and disruption notices.',
  },
};

export type SeoState =
  | { kind: 'home' }
  | { kind: 'about' }
  | { kind: 'train'; label: string; destination: string }
  | { kind: 'station'; name: string };

export function seoFor(locale: AppLocale, state: SeoState): { title: string; description: string } {
  const base = DEFAULTS[locale];
  const sk = locale === 'sk';
  if (state.kind === 'train') {
    const route = state.destination ? ` → ${state.destination}` : '';
    return {
      title: `${state.label}${route} – ${sk ? 'poloha vlaku a meškanie' : 'train position and delay'} | ${SITE_NAME}`,
      description: sk
        ? `Živá poloha vlaku ${state.label}${route} na mape: meškanie, zastávky a plánované aj skutočné časy. ${SITE_NAME}.`
        : `Live position of train ${state.label}${route}: delay, stops and scheduled and actual times. ${SITE_NAME}.`,
    };
  }
  if (state.kind === 'station') {
    return {
      title: `${state.name} – ${sk ? 'odchody vlakov a poloha vlakov' : 'train departures and arrivals'} | ${SITE_NAME}`,
      description: sk
        ? `Odchody a príchody vlakov zo stanice ${state.name}, s meškaním a polohou vlakov na mape. ${SITE_NAME}.`
        : `Train departures and arrivals at ${state.name}, with delays and live positions on the map. ${SITE_NAME}.`,
    };
  }
  if (state.kind === 'about') {
    return {
      title: `${sk ? 'O aplikácii' : 'About'} | ${SITE_NAME}`,
      description: base.description,
    };
  }
  if (REGION_ID === 'pid') {
    return sk
      ? {
          title: 'Mapa vlakov Prahy a okolia (PID) naživo | Môj Vlak',
          description:
            'Poloha vlakov v Prahe a Stredočeskom kraji naživo: mapa vlakov PID s meškaním, zastávkami a trasou každého vlaku.',
        }
      : {
          title: 'Live train map of Prague and surroundings (PID) | Môj Vlak',
          description:
            'Where the trains of Prague and Central Bohemia are right now: live PID train positions with delays, stops and the route of each train.',
        };
  }
  return base;
}

function setMeta(attribute: 'name' | 'property', key: string, content: string) {
  const element = document.head.querySelector<HTMLMetaElement>(`meta[${attribute}="${key}"]`);
  if (element && element.content !== content) {
    element.content = content;
  }
}

/** Keep the tab title, language and the description / social tags in step with what is open. */
export function applySeo(locale: AppLocale, state: SeoState) {
  if (typeof document === 'undefined') {
    return;
  }
  const { title, description } = seoFor(locale, state);
  if (document.title !== title) {
    document.title = title;
  }
  document.documentElement.lang = locale;
  setMeta('name', 'description', description);
  setMeta('property', 'og:title', title);
  setMeta('property', 'og:description', description);
  setMeta('name', 'twitter:title', title);
  setMeta('name', 'twitter:description', description);
  setMeta('property', 'og:locale', locale === 'sk' ? 'sk_SK' : 'en_US');
}
