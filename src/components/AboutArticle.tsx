import React from 'react';
import type { AppLocale } from '../i18n';

const AboutArticleEn = () => (
  <article className="about__copy">
    <p>
      Live trains on the Slovak network, drawn on a 3D MapLibre map. Positions, delays, and
      station-by-station journeys sit on OpenStreetMap railway geometry, with a Trafimage-style base
      map underneath.
    </p>
    <p>
      This site was coded with AI, in Cursor, with a person directing the product, the map, and the
      UI. Nothing here is pretending otherwise.
    </p>
    <h3>What you are looking at</h3>
    <p>
      The pills on the map are live trains. Click one for the journey list, planned vs actual times,
      and the next stop. Click a station for a cp.sk departure or arrival board. Search finds trains
      and stations. Light mode is the default; dark mode is available in the map tools.
    </p>
    <p>
      Pathfinding walks a simplified rail graph so a train can sit on the tracks. Fine geometry is
      only drawn when you zoom in. Double track is collapsed on that graph on purpose.
    </p>
    <h3>Stack</h3>
    <ul>
      <li>Vite 7, React 19, MapLibre GL 6</li>
      <li>Node proxy on port 3001 in development, same process as static files in production</li>
      <li>Custom scrollbar in the dock panel</li>
      <li>GTFS stop coordinates from the bundled <code>public/gtfs</code> files</li>
    </ul>
    <AboutApiEn />
  </article>
);

const AboutArticleSk = () => (
  <article className="about__copy">
    <p>
      Živé vlaky na slovenskej sieti v 3D mape MapLibre. Polohy, meškania a priebeh trasy podľa
      zastávok ležia na koľajniciach z OpenStreetMap, podklad je v štýle Trafimage.
    </p>
    <p>
      Stránku programoval AI v Cursori pod vedením človeka — produkt, mapa aj rozhranie. Nič to
      neskrýva.
    </p>
    <h3>Čo vidíte</h3>
    <p>
      Značky na mape sú živé vlaky. Klik otvorí zoznam zastávok, plánované a skutočné časy a ďalšiu
      zastávku. Stanica ukáže odchody alebo príchody z cp.sk. Vyhľadávanie nájde vlaky aj stanice.
      Svetlý režim je predvolený, tmavý je v ovládacích prvkoch mapy.
    </p>
    <p>
      Pathfinding ide po zjednodušenej grafe, aby vlak sedel na koľajniciach. Detailná geometria sa
      kreslí až po priblížení. Dvojkoľajný úsek je v grafe zámerne zjednotený.
    </p>
    <h3>Technológie</h3>
    <ul>
      <li>Vite 7, React 19, MapLibre GL 6</li>
      <li>Node proxy na porte 3001 vo vývoji, v produkcii rovnaký proces ako statické súbory</li>
      <li>Vlastný posuvník v dock paneli</li>
      <li>Súradnice zastávok z balíka <code>public/gtfs</code></li>
    </ul>
    <AboutApiSk />
  </article>
);

function AboutApiEn() {
  return (
    <>
      <h3>Upstream data</h3>
      <p>
        Train positions are not open data. The proxy repeats the same <code>gtall</code> and{' '}
        <code>TrainDetail</code> calls that{' '}
        <a href="https://mapa.zsr.sk" target="_blank" rel="noreferrer">
          mapa.zsr.sk
        </a>{' '}
        already makes in the browser, after a cookie handshake. Station boards come from cp.sk.
        Rails are OSM ways, usually via MapTiler vector tiles when <code>MAPTILER_KEY</code> is set.
        The basemap is geOps Trafimage (SBB Netzkarte), rewritten so tiles go through this proxy.
        Railway geometry stays © OpenStreetMap contributors (ODbL).
      </p>
      <h3>Local proxy</h3>
      <p>
        The browser never talks to those upstreams directly for map or train data. Vite forwards{' '}
        <code>/proxy</code> to <code>http://127.0.0.1:3001</code>. In production the Node server serves
        the built app and handles the same paths. Default JSON mode is the live train list.
      </p>
      <h3>Train API</h3>
      <AboutTrainApiDd locale="en" />
      <h3>Map API</h3>
      <AboutMapApiDd locale="en" />
      <h3>Development extras</h3>
      <p>
        Vite also forwards <code>/api</code>, <code>/action</code>, and <code>/action.html</code> to
        mapa.zsr.sk. Those are handshake and legacy paths, not the public app API.
      </p>
      <h3>License</h3>
      <p>
        Site source is MIT. Geist is SIL OFL. Rails are OSM. Train and timetable feeds stay with their
        operators; this app only mirrors what their public maps already show.
      </p>
    </>
  );
}

function AboutApiSk() {
  return (
    <>
      <h3>Zdrojové dáta</h3>
      <p>
        Polohy vlakov nie sú otvorené dáta. Proxy opakuje volania <code>gtall</code> a{' '}
        <code>TrainDetail</code> z{' '}
        <a href="https://mapa.zsr.sk" target="_blank" rel="noreferrer">
          mapa.zsr.sk
        </a>{' '}
        po cookie handshake. Tabule staníc sú z cp.sk. Koľajnice sú z OSM, často cez MapTiler pri{' '}
        <code>MAPTILER_KEY</code>. Podkladová mapa je geOps Trafimage, dlaždice idú cez proxy.
        Geometria koľajníc © OpenStreetMap (ODbL).
      </p>
      <h3>Lokálny proxy</h3>
      <p>
        Prehliadač nevolá upstream priamo. Vite posiela <code>/proxy</code> na{' '}
        <code>http://127.0.0.1:3001</code>. V produkcii Node server obslúži build aj tie isté cesty.
      </p>
      <h3>API vlakov</h3>
      <AboutTrainApiDd locale="sk" />
      <h3>API mapy</h3>
      <AboutMapApiDd locale="sk" />
      <h3>Vývoj</h3>
      <p>
        Vite ďalej forwarduje <code>/api</code>, <code>/action</code> a <code>/action.html</code> na
        mapa.zsr.sk — handshake, nie verejné API aplikácie.
      </p>
      <h3>Licencia</h3>
      <p>
        Zdroják MIT. Geist SIL OFL. Koľajnice OSM. Vlakové dáta patria prevádzkovateľom; aplikácia len
        zobrazuje to, čo už ukazujú ich verejné mapy.
      </p>
    </>
  );
}

function AboutTrainApiDd({ locale }: { locale: AppLocale }) {
  if (locale === 'sk') {
    return (
      <dl className="about__api">
        <ApiEntry path="GET /proxy" text="Rovnaké ako mode=gtall. Živý zoznam vlakov z mapa.zsr.sk." />
        <ApiEntry
          path="GET /proxy?mode=gtall"
          text="Explicitný zoznam vlakov. Cache na disku, obnova v intervale."
        />
        <ApiEntry
          path="GET /proxy?mode=detail&train={number}"
          text="HTML detail vlaku. Zastávky s časmi a stavom passed/current/ahead. Cache ~60 s."
        />
        <ApiEntry
          path="GET /proxy?mode=station&station={name}"
          text="Tabuľa cp.sk. byarr=true = príchody. Cache ~45 s."
        />
      </dl>
    );
  }
  return (
    <dl className="about__api">
      <ApiEntry path="GET /proxy" text="Same as mode=gtall. Live roster from mapa.zsr.sk." />
      <ApiEntry path="GET /proxy?mode=gtall" text="Explicit form of the train list. Cached on disk." />
      <ApiEntry
        path="GET /proxy?mode=detail&train={number}"
        text="Parsed TrainDetail HTML with stops, times, and state."
      />
      <ApiEntry
        path="GET /proxy?mode=station&station={name}"
        text="cp.sk board. byarr=true for arrivals. Cached ~45 seconds."
      />
    </dl>
  );
}

function AboutMapApiDd({ locale }: { locale: AppLocale }) {
  if (locale === 'sk') {
    return (
      <dl className="about__api">
        <ApiEntry path="GET /proxy?mode=style&theme=dark" text="MapLibre štýl geOps Trafimage." />
        <ApiEntry path="GET /proxy/geops/{path}" text="Proxy geOps dlaždice a assety štýlu." />
        <ApiEntry path="GET /proxy?mode=basemap" text="PNG podkladová dlaždica." />
        <ApiEntry path="GET /proxy?mode=osm&level=network" text="Zjednodušená sieť pre pathfinding." />
        <ApiEntry path="GET /proxy?mode=osm&level=display" text="Detailné koľajnice v bbox." />
      </dl>
    );
  }
  return (
    <dl className="about__api">
      <ApiEntry path="GET /proxy?mode=style&theme=dark" text="MapLibre style JSON from geOps Trafimage." />
      <ApiEntry path="GET /proxy/geops/{path}" text="Proxied geOps tiles and style assets." />
      <ApiEntry path="GET /proxy?mode=basemap" text="PNG basemap tile via server geOps key." />
      <ApiEntry path="GET /proxy?mode=osm&level=network" text="Simplified rail graph for pathfinding." />
      <ApiEntry path="GET /proxy?mode=osm&level=display" text="Detailed railway ways in a bounding box." />
    </dl>
  );
}

function ApiEntry({ path, text }: { path: string; text: string }) {
  return (
    <div>
      <dt>
        <code>{path}</code>
      </dt>
      <dd>{text}</dd>
    </div>
  );
}

export const AboutArticle: React.FC<{ locale: AppLocale }> = ({ locale }) =>
  locale === 'en' ? <AboutArticleEn /> : <AboutArticleSk />;
