import type { FocusedStation } from './data/stationBoard';

export type AppRoute = {
  about: boolean;
  train: string | null;
  station: FocusedStation | null;
  tab: 'departures' | 'arrivals';
};

export const EMPTY_ROUTE: AppRoute = {
  about: false,
  train: null,
  station: null,
  tab: 'departures',
};

function formatCoord(value: number): string {
  return String(Math.round(value * 1e6) / 1e6);
}

export function parseAppRoute(search: string = window.location.search): AppRoute {
  const params = new URLSearchParams(search);
  const train = params.get('train')?.trim() || null;
  const name = params.get('station')?.trim() || null;
  const lat = Number(params.get('lat'));
  const lng = Number(params.get('lng'));
  const sid = params.get('sid')?.trim() || '';
  const station =
    !train && name
      ? {
          id: sid || `station:${name}`,
          name,
          lat: Number.isFinite(lat) ? lat : 0,
          lng: Number.isFinite(lng) ? lng : 0,
        }
      : null;
  return {
    about: params.get('about') === '1',
    train,
    station,
    tab: params.get('tab') === 'arrivals' ? 'arrivals' : 'departures',
  };
}

export function serializeAppRoute(route: AppRoute): string {
  const params = new URLSearchParams();
  if (route.train) {
    params.set('train', route.train);
  } else if (route.station) {
    params.set('station', route.station.name);
    if (route.station.id) {
      params.set('sid', route.station.id);
    }
    if (Number.isFinite(route.station.lat) && route.station.lat !== 0) {
      params.set('lat', formatCoord(route.station.lat));
    }
    if (Number.isFinite(route.station.lng) && route.station.lng !== 0) {
      params.set('lng', formatCoord(route.station.lng));
    }
    if (route.tab === 'arrivals') {
      params.set('tab', 'arrivals');
    }
  }
  if (route.about) {
    params.set('about', '1');
  }
  const query = params.toString();
  return query ? `?${query}` : '';
}

export function routeFromView(input: {
  aboutOpen: boolean;
  trainNumber: string | null;
  station: FocusedStation | null;
  tab: 'departures' | 'arrivals';
}): AppRoute {
  return {
    about: input.aboutOpen,
    train: input.trainNumber,
    station: input.station,
    tab: input.tab,
  };
}
