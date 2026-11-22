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
  trainComposition: string;
  trainCompositionLink: string;
  trainCompositionTitle: string;
  alertsTitle: string;
  alertsAria: string;
  alertsEmpty: string;
  alertsSource: string;
  alertsGroupClosures: string;
  alertsGroupCancelled: string;
  alertsGroupDelays: string;
  alertsGroupNotes: string;
  alertCancelledFull: string;
  alertCancelledSection: (from: string, to: string) => string;
  alertNoReplacement: string;
  alertReplacement: (text: string) => string;
  alertDelay: (minutes: number, station: string, forecast: boolean) => string;
  alertBusReplacement: string;
  alertTimeAgo: (minutes: number) => string;
  aboutRailatlas: string;
  loadingTrains: string;
  trainsCount: (count: number) => string;
  searchPlaceholder: string;
  searchCloseAria: string;
  searchNoResults: string;
  searchMobileHint: string;
  searchRecent: string;
  searchClearRecent: string;
  station: string;
  zoomIn: string;
  zoomOut: string;
  locateAria: string;
  locateDenied: string;
  locateFailed: string;
  themeToLight: string;
  themeToDark: string;
  themeLight: string;
  themeDark: string;
  langSwitchTo: string;
  langSwitchAria: string;
  menuOpen: string;
  menuClose: string;
  menuRegion: string;
  menuLanguage: string;
  menuAppearance: string;
  regionSk: string;
  regionPid: string;
  menuDarkMode: string;
  menuAbout: string;
  menuShow: string;
  modeRail: string;
  modeMetro: string;
  modeTram: string;
  modeTrolley: string;
  modeBus: string;
  menuStudio: string;
  regionSkMeta: string;
  regionPidMeta: string;
  follow: string;
  following: string;
  toastPositionCorrected: (km: string, back: boolean) => string;
  toastTrainEnded: (trainNumber: string) => string;
  toastPositionUpdating: string;
  alertsPill: string;
  trainCompositionButton: string;
  toastFeedLost: string;
  toastFeedBack: string;
  replacementBus: string;
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
  approachingStation: string;
  dockExpandSheet: string;
  loadingAbout: string;
  mapLoading: string;
  mapStepMap: string;
  mapStepRails: string;
  mapStepTrains: string;
  mapStepStations: string;
  mapStepTimetables: string;
  mapReady: string;
  routeWarnings: string;
  gtfsLoaded: (shapes: number, trips: number, stops: number) => string;
  studioBy: string;
};

const sk: Copy = {
  trainComposition: 'Radenie vlaku',
  trainCompositionLink: 'vagonWEB',
  trainCompositionTitle: 'Rad vozňov vlaku na vagonWEB (vagonweb.cz) – otvorí sa v novom okne',
  alertsTitle: 'Mimoriadnosti',
  alertsAria: 'Mimoriadnosti na trati',
  alertsEmpty: 'Teraz žiadne mimoriadnosti.',
  alertsSource: 'Zdroj: ZSSK mimoriadnosti',
  alertsGroupClosures: 'Výluky',
  alertsGroupCancelled: 'Odrieknuté vlaky',
  alertsGroupDelays: 'Meškania',
  alertsGroupNotes: 'Upozornenia',
  alertCancelledFull: 'Odrieknutý v celom úseku',
  alertCancelledSection: (from, to) => `Odrieknutý v úseku ${from} – ${to}`,
  alertNoReplacement: 'bez náhrady',
  alertReplacement: (text) => `náhrada: ${text}`,
  alertDelay: (minutes, station, forecast) =>
    `${forecast ? 'Predpokladané meškanie' : 'Meškanie'} ${minutes} min zo stanice ${station}`,
  alertBusReplacement: 'Náhradná autobusová doprava',
  alertTimeAgo: (minutes) => (minutes < 1 ? 'teraz' : minutes < 60 ? `pred ${minutes} min` : `pred ${Math.round(minutes / 60)} h`),
  aboutRailatlas: 'O aplikácii Môj Vlak',
  loadingTrains: 'Načítavam vlaky',
  trainsCount: (count) => `${count} vlakov`,
  searchPlaceholder: 'Vyhľadať vlak alebo stanicu',
  searchCloseAria: 'Zavrieť vyhľadávanie',
  searchNoResults: 'Nič sa nenašlo',
  searchMobileHint: 'Zadajte číslo vlaku alebo názov stanice',
  searchRecent: 'Nedávne vyhľadávania',
  searchClearRecent: 'Vymazať',
  station: 'Stanica',
  zoomIn: 'Priblížiť mapu',
  zoomOut: 'Oddialiť mapu',
  locateAria: 'Moja poloha',
  locateDenied: 'Poloha nie je povolená. Povoľte ju v nastaveniach prehliadača.',
  locateFailed: 'Polohu sa nepodarilo zistiť.',
  themeToLight: 'Prepnúť na svetlý režim',
  themeToDark: 'Prepnúť na tmavý režim',
  themeLight: 'Svetlý režim',
  themeDark: 'Tmavý režim',
  langSwitchTo: 'EN',
  langSwitchAria: 'Prepnúť jazyk na angličtinu',
  menuOpen: 'Otvoriť menu',
  menuClose: 'Zavrieť menu',
  menuRegion: 'Oblasť',
  menuLanguage: 'Jazyk',
  menuAppearance: 'Vzhľad',
  regionSk: 'Slovensko',
  regionPid: 'Praha a okolie (PID)',
  menuDarkMode: 'Tmavý režim',
  menuAbout: 'O aplikácii',
  menuShow: 'Zobraziť',
  modeRail: 'Vlaky',
  modeMetro: 'Metro',
  modeTram: 'Električky',
  modeTrolley: 'Trolejbusy',
  modeBus: 'Autobusy',
  menuStudio: 'Autor',
  regionSkMeta: 'ZSSK · naživo',
  regionPidMeta: 'PID · naživo',
  follow: 'Sledovať',
  following: 'Sledujem',
  toastPositionCorrected: (km, back) =>
    `Poloha vlaku upravená podľa nového hlásenia ŽSR (${km} km ${back ? 'späť' : 'dopredu'})`,
  toastTrainEnded: (trainNumber) => `Vlak ${trainNumber} dokončil jazdu, sledovanie skončilo`,
  toastPositionUpdating: 'Poloha vlaku sa aktualizuje na najnovšiu',
  alertsPill: 'ZSSK',
  trainCompositionButton: 'Radenie',
  toastFeedLost: 'Živé dáta nie sú dostupné. Zobrazujú sa posledné známe polohy.',
  toastFeedBack: 'Živé dáta sú späť.',
  replacementBus: 'Náhradná autobusová doprava ',
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
  approachingStation: 'Ďalšia zastávka',
  dockExpandSheet: 'Rozbaliť panel',
  loadingAbout: 'Načítavam',
  mapLoading: 'Načítava sa',
  mapStepMap: 'Mapa',
  mapStepRails: 'Koľajnice',
  mapStepTrains: 'Vlaky',
  mapStepStations: 'Stanice',
  mapStepTimetables: 'Cestovné poriadky',
  mapReady: 'Pripravené',
  routeWarnings: 'Upozornenia trasy',
  gtfsLoaded: (shapes, trips, stops) =>
    `✓ GTFS: ${shapes} tratí, ${trips} spojov, ${stops} zastávok`,
  studioBy: 'od Studio Asymetric',
};

const en: Copy = {
  trainComposition: 'Train composition',
  trainCompositionLink: 'vagonWEB',
  trainCompositionTitle: 'Coach order of this train on vagonWEB (vagonweb.cz) – opens in a new tab',
  alertsTitle: 'Disruptions',
  alertsAria: 'Disruptions on the network',
  alertsEmpty: 'No disruptions right now.',
  alertsSource: 'Source: ZSSK disruption notices',
  alertsGroupClosures: 'Closures',
  alertsGroupCancelled: 'Cancelled trains',
  alertsGroupDelays: 'Delays',
  alertsGroupNotes: 'Notices',
  alertCancelledFull: 'Cancelled, whole run',
  alertCancelledSection: (from, to) => `Cancelled between ${from} and ${to}`,
  alertNoReplacement: 'no replacement',
  alertReplacement: (text) => `replaced by ${text}`,
  alertDelay: (minutes, station, forecast) =>
    `${forecast ? 'Expected delay' : 'Delay'} ${minutes} min from ${station}`,
  alertBusReplacement: 'Replacement bus service',
  alertTimeAgo: (minutes) => (minutes < 1 ? 'just now' : minutes < 60 ? `${minutes} min ago` : `${Math.round(minutes / 60)} h ago`),
  aboutRailatlas: 'About Môj Vlak',
  loadingTrains: 'Loading trains',
  trainsCount: (count) => `${count} trains`,
  searchPlaceholder: 'Search train or station',
  searchCloseAria: 'Close search',
  searchNoResults: 'No results',
  searchMobileHint: 'Enter a train number or station name',
  searchRecent: 'Recent searches',
  searchClearRecent: 'Clear',
  station: 'Station',
  zoomIn: 'Zoom in',
  zoomOut: 'Zoom out',
  locateAria: 'My location',
  locateDenied: 'Location is blocked. Allow it in your browser settings.',
  locateFailed: 'Could not find your location.',
  themeToLight: 'Switch to light mode',
  themeToDark: 'Switch to dark mode',
  themeLight: 'Light mode',
  themeDark: 'Dark mode',
  langSwitchTo: 'SK',
  langSwitchAria: 'Switch language to Slovak',
  menuOpen: 'Open menu',
  menuClose: 'Close menu',
  menuRegion: 'Region',
  menuLanguage: 'Language',
  menuAppearance: 'Appearance',
  regionSk: 'Slovakia',
  regionPid: 'Prague and surroundings (PID)',
  menuDarkMode: 'Dark mode',
  menuAbout: 'About the app',
  menuShow: 'Show',
  modeRail: 'Trains',
  modeMetro: 'Metro',
  modeTram: 'Trams',
  modeTrolley: 'Trolleybuses',
  modeBus: 'Buses',
  menuStudio: 'Made by',
  regionSkMeta: 'ZSSK · live',
  regionPidMeta: 'PID · live',
  follow: 'Follow',
  following: 'Following',
  toastPositionCorrected: (km, back) =>
    `Train position corrected after a new ŽSR report (${km} km ${back ? 'back' : 'ahead'})`,
  toastTrainEnded: (trainNumber) => `Train ${trainNumber} finished its journey. Following stopped.`,
  toastPositionUpdating: "Updating the train's position to the latest",
  alertsPill: 'ZSSK',
  trainCompositionButton: 'Composition',
  toastFeedLost: 'Live data unavailable. Showing the last known positions.',
  toastFeedBack: 'Live data is back.',
  replacementBus: 'Replacement bus service ',
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
  approachingStation: 'Next stop',
  dockExpandSheet: 'Expand panel',
  loadingAbout: 'Loading',
  mapLoading: 'Loading',
  mapStepMap: 'Map',
  mapStepRails: 'Rails',
  mapStepTrains: 'Trains',
  mapStepStations: 'Stations',
  mapStepTimetables: 'Timetables',
  mapReady: 'Ready',
  routeWarnings: 'Route warnings',
  gtfsLoaded: (shapes, trips, stops) =>
    `✓ GTFS loaded: ${shapes} shapes, ${trips} trips, ${stops} stops`,
  studioBy: 'by Studio Asymetric',
};

export function copyFor(locale: AppLocale): Copy {
  return locale === 'en' ? en : sk;
}
