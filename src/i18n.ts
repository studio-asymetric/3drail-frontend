export type AppLocale = 'sk' | 'en';

export const LOCALE_STORAGE_KEY = 'railatlas-locale';

export function readStoredLocale(): AppLocale {
  try {
    return window.localStorage.getItem(LOCALE_STORAGE_KEY) === 'en' ? 'en' : 'sk';
  } catch {
    return 'sk';
  }
}

export type Copy = {
  aboutRailatlas: string;
  loadingTrains: string;
  trainsCount: (count: number) => string;
  searchPlaceholder: string;
  searchCloseAria: string;
  searchNoResults: string;
  searchMobileHint: string;
  station: string;
  zoomIn: string;
  zoomOut: string;
  themeToLight: string;
  themeToDark: string;
  themeLight: string;
  themeDark: string;
  langSwitchTo: string;
  langSwitchAria: string;
  follow: string;
  following: string;
  operator: string;
  lastPosition: string;
  train: string;
  onTime: string;
  delayMinutes: (minutes: number) => string;
  delayMinutesShort: (minutes: number) => string;
  loadingGtfs: string;
  loadingGtfsFrom: string;
  stationDataUnavailable: string;
  trainListUnavailable: string;
  loadingStations: string;
  stationListUnavailable: string;
  departures: string;
  arrivals: string;
  stationBoard: string;
  loadingDepartures: string;
  loadingArrivals: string;
  boardErrorDepartures: string;
  boardErrorArrivals: string;
  openOnCpSk: string;
  aboutPill: string;
  back: string;
  dockCloseAria: string;
  loadingAbout: string;
  mapLoading: string;
  mapStepMap: string;
  mapStepRails: string;
  mapStepTrains: string;
  mapReady: string;
  routeWarnings: string;
  gtfsLoaded: (shapes: number, trips: number, stops: number) => string;
  studioBy: string;
};

const sk: Copy = {
  aboutRailatlas: 'O aplikácii railatlas',
  loadingTrains: 'Načítavam vlaky',
  trainsCount: (count) => `${count} vlakov`,
  searchPlaceholder: 'Vyhľadať vlak alebo stanicu',
  searchCloseAria: 'Zavrieť vyhľadávanie',
  searchNoResults: 'Nič sa nenašlo',
  searchMobileHint: 'Zadajte číslo vlaku alebo názov stanice',
  station: 'Stanica',
  zoomIn: 'Priblížiť mapu',
  zoomOut: 'Oddialiť mapu',
  themeToLight: 'Prepnúť na svetlý režim',
  themeToDark: 'Prepnúť na tmavý režim',
  themeLight: 'Svetlý režim',
  themeDark: 'Tmavý režim',
  langSwitchTo: 'EN',
  langSwitchAria: 'Prepnúť jazyk na angličtinu',
  follow: 'Sledovať',
  following: 'Sledujem',
  operator: 'Dopravca',
  lastPosition: 'Posledná poloha',
  train: 'Vlak',
  onTime: 'Načas',
  delayMinutes: (minutes) => `${minutes} min meškanie`,
  delayMinutesShort: (minutes) => `${minutes} min`,
  loadingGtfs: 'Načítavam údaje GTFS…',
  loadingGtfsFrom: 'Načítavam GTFS z public/gtfs…',
  stationDataUnavailable: 'Údaje o staniciach nie sú dostupné',
  trainListUnavailable: 'Zoznam vlakov nie je dostupný',
  loadingStations: 'Načítavam zastávky',
  stationListUnavailable: 'Zoznam zastávok nie je dostupný',
  departures: 'Odchody',
  arrivals: 'Príchody',
  stationBoard: 'Tabuľa stanice',
  loadingDepartures: 'Načítavam odchody',
  loadingArrivals: 'Načítavam príchody',
  boardErrorDepartures: 'Pre túto stanicu nie sú odchody na cp.sk',
  boardErrorArrivals: 'Pre túto stanicu nie sú príchody na cp.sk',
  openOnCpSk: 'Otvoriť na cp.sk',
  aboutPill: 'O aplikácii',
  back: 'Späť',
  dockCloseAria: 'Zavrieť a zrušiť výber',
  loadingAbout: 'Načítavam',
  mapLoading: 'Načítava sa',
  mapStepMap: 'Mapa',
  mapStepRails: 'Koľajnice',
  mapStepTrains: 'Vlaky',
  mapReady: 'Pripravené',
  routeWarnings: 'Upozornenia trasy',
  gtfsLoaded: (shapes, trips, stops) =>
    `✓ GTFS: ${shapes} tratí, ${trips} spojov, ${stops} zastávok`,
  studioBy: 'od Studio Asymetric',
};

const en: Copy = {
  aboutRailatlas: 'About railatlas',
  loadingTrains: 'Loading trains',
  trainsCount: (count) => `${count} trains`,
  searchPlaceholder: 'Search train or station',
  searchCloseAria: 'Close search',
  searchNoResults: 'No results',
  searchMobileHint: 'Enter a train number or station name',
  station: 'Station',
  zoomIn: 'Zoom in',
  zoomOut: 'Zoom out',
  themeToLight: 'Switch to light mode',
  themeToDark: 'Switch to dark mode',
  themeLight: 'Light mode',
  themeDark: 'Dark mode',
  langSwitchTo: 'SK',
  langSwitchAria: 'Switch language to Slovak',
  follow: 'Follow',
  following: 'Following',
  operator: 'Operator',
  lastPosition: 'Last reported position',
  train: 'Train',
  onTime: 'On time',
  delayMinutes: (minutes) => `${minutes} min delay`,
  delayMinutesShort: (minutes) => `${minutes} min`,
  loadingGtfs: 'Loading GTFS data…',
  loadingGtfsFrom: 'Loading GTFS data from public/gtfs…',
  stationDataUnavailable: 'Station data unavailable',
  trainListUnavailable: 'Train list unavailable',
  loadingStations: 'Loading stations',
  stationListUnavailable: 'Station list unavailable',
  departures: 'Departures',
  arrivals: 'Arrivals',
  stationBoard: 'Station board',
  loadingDepartures: 'Loading departures',
  loadingArrivals: 'Loading arrivals',
  boardErrorDepartures: 'No departures from cp.sk for this station',
  boardErrorArrivals: 'No arrivals from cp.sk for this station',
  openOnCpSk: 'Open on cp.sk',
  aboutPill: 'About',
  back: 'Back',
  dockCloseAria: 'Close and clear selection',
  loadingAbout: 'Loading',
  mapLoading: 'Loading',
  mapStepMap: 'Map',
  mapStepRails: 'Rails',
  mapStepTrains: 'Trains',
  mapReady: 'Ready',
  routeWarnings: 'Route warnings',
  gtfsLoaded: (shapes, trips, stops) =>
    `✓ GTFS loaded: ${shapes} shapes, ${trips} trips, ${stops} stops`,
  studioBy: 'by Studio Asymetric',
};

export function copyFor(locale: AppLocale): Copy {
  return locale === 'en' ? en : sk;
}
