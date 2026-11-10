import React from 'react';
import type { AppLocale } from '../i18n';

const AboutArticleEn = () => (
  <article className="about__copy">
    <p>
      <strong>railatlas</strong> shows live trains on the Slovak network on a tilted MapLibre map.
      Positions, delays, and stop-by-stop journeys sit on OpenStreetMap railway geometry. The
      background is a custom Railatlas style on OpenFreeMap (OpenMapTiles / OSM) with subdued
      hillshade from public Mapzen / AWS terrain tiles — no SBB or geOps basemap.
    </p>
    <p>
      Made by{' '}
      <a href="https://asymetric.studio" target="_blank" rel="noreferrer">
        Studio Asymetric
      </a>
      . Built with AI assistance in Cursor; a person shaped the product, map, and UI.
    </p>
    <h3>What you are looking at</h3>
    <p>
      Coloured pills are live trains. Open one for the journey list, planned vs actual times, and
      the next stop. Stations open a cp.sk departure or arrival board. The centre search field
      finds trains and stations. Top-right tools: zoom, this about panel (info icon), light / dark
      theme, and SK / EN language. The railatlas mark in the header opens the same about view.
    </p>
    <p>
      Pathfinding uses a simplified rail graph so trains snap to tracks. Detailed track geometry
      appears when you zoom in. Double track is merged on that graph on purpose.
    </p>
    <p>
      Map attribution (OpenStreetMap, OpenFreeMap, terrain) stays in the corner of the map canvas.
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
      <strong>railatlas</strong> zobrazuje živé vlaky na slovenskej sieti na naklonenej mape
      MapLibre. Polohy, meškania a trasa po zastávkach ležia na koľajniciach z OpenStreetMap.
      Podklad je vlastný štýl Railatlas na OpenFreeMap (OpenMapTiles / OSM) s tlmeným reliéfom z
      verejných dlaždíc Mapzen / AWS — bez podkladu SBB ani geOps.
    </p>
    <p>
      Autor:{' '}
      <a href="https://asymetric.studio" target="_blank" rel="noreferrer">
        Studio Asymetric
      </a>
      . Vývoj s pomocou AI v Cursori; produkt, mapu a UI riadil človek.
    </p>
    <h3>Čo vidíte</h3>
    <p>
      Farebné značky sú živé vlaky. Klik otvorí zoznam zastávok, plánované a skutočné časy a ďalšiu
      zastávku. Stanica ukáže odchody alebo príchody z cp.sk. Stredové vyhľadávanie nájde vlaky aj
      stanice. Vpravo hore: priblíženie, tento panel (ikona info), svetlý / tmavý režim a SK / EN.
      Logo railatlas v hlavičke otvorí rovnaký text O aplikácii.
    </p>
    <p>
      Pathfinding ide po zjednodušenej grafe, aby vlak sedel na koľajniciach. Detailná geometria sa
      kreslí až po priblížení. Dvojkoľajný úsek je v grafe zámerne zjednotený.
    </p>
    <p>Atribúcia mapy (OSM, OpenFreeMap, terén) zostáva v rohu mapy.</p>
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
        The basemap is OpenFreeMap (OpenMapTiles / OSM) plus Mapzen / AWS terrain, proxied and
        cached here. Rails for pathfinding and some overlays still use MapTiler vector extracts when{' '}
        <code>MAPTILER_KEY</code> is set. Railway geometry is © OpenStreetMap contributors (ODbL).
        Do not scrape train feeds for redistribution; this app only mirrors what the operators&apos;
        public maps already show.
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
        Site source is MIT (see repository). Geist is SIL OFL. Basemap © OpenStreetMap via
        OpenFreeMap; terrain © Mapzen / AWS. Train and timetable data remain with ŽSR, cp.sk, and
        other operators.
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
        po cookie handshake. Tabule staníc sú z cp.sk. Podklad OpenFreeMap (OSM) a terén cez proxy.
        Koľajnice pre pathfinding cez MapTiler pri <code>MAPTILER_KEY</code>. Geometria koľajníc ©
        OpenStreetMap (ODbL). Vlakové feedy nepretŕľajte ďalej — aplikácia len zobrazuje to, čo už
        ukazujú verejné mapy prevádzkovateľov.
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
        Zdroják MIT (repozitár). Geist SIL OFL. Podklad © OSM cez OpenFreeMap, terén © Mapzen / AWS.
        Vlakové a cestovné údaje zostávajú u ŽSR, cp.sk a ďalších prevádzkovateľov.
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
        <ApiEntry
          path="GET /proxy?mode=style&theme=light|dark"
          text="Vlastný MapLibre štýl Railatlas (OpenFreeMap, tlmený reliéf)."
        />
        <ApiEntry path="GET /proxy/maptiler/{path}" text="Proxy OpenFreeMap dlaždice, fonty a terén." />
        <ApiEntry path="GET /proxy?mode=osm&level=network" text="Zjednodušená sieť pre pathfinding." />
        <ApiEntry path="GET /proxy?mode=osm&level=display" text="Detailné koľajnice v bbox." />
      </dl>
    );
  }
  return (
    <dl className="about__api">
      <ApiEntry
        path="GET /proxy?mode=style&theme=light|dark"
        text="Custom MapLibre Railatlas style (OpenFreeMap, subdued terrain)."
      />
      <ApiEntry path="GET /proxy/maptiler/{path}" text="Proxied OpenFreeMap tiles, fonts, and terrain." />
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
