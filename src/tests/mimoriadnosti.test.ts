import { describe, expect, it } from 'vitest';
// @ts-expect-error plain JS module shared with the proxy
import { keepActive, parsePosts, postText } from '../../proxy/mimoriadnosti.mjs';

const post = (id: string, html: string, at: string) => ({ id, content: `<p>${html}</p>`, created_at: at, url: `https://x/${id}` });
const NOW = new Date('2026-11-18T06:30:00Z'); // 07:30 in Slovakia

describe('mimoriadnosti parser', () => {
  it('reads a delay', () => {
    const [event] = parsePosts(
      [post('1', 'Os 5205 (Nové Zámky 05:55 - Levice 07:13) mešká zo stanice Nové Zámky 35 min.', '2026-11-18T05:33:10Z')],
      new Date('2026-11-18T05:40:00Z')
    );
    expect(event).toMatchObject({
      kind: 'delay',
      train: { type: 'Os', number: '5205' },
      from: { name: 'Nové Zámky', time: '05:55' },
      to: { name: 'Levice', time: '07:13' },
      station: 'Nové Zámky',
      minutes: 35,
      forecast: false,
    });
  });

  it('reads a forecast delay', () => {
    const [event] = parsePosts(
      [post('1', 'REX 1972 (Košice 20:43 - Lipany 21:59) predpokladané meškanie zo stanice Kysak 40 min.', '2026-11-17T20:03:00Z')],
      new Date('2026-11-17T20:30:00Z')
    );
    expect(event).toMatchObject({ kind: 'delay', minutes: 40, forecast: true, station: 'Kysak' });
  });

  it('reads cancellations: whole run, a section, with and without replacement', () => {
    const events = parsePosts(
      [
        post('2', 'Os 3104 (Trenčín 05:44 - Myjava 06:57) odrieknutý v celom úseku. Náhrada: bez náhrady', '2026-11-18T05:38:00Z'),
        post('3', 'Nová informácia k vlaku: <br />Os 3101 (Myjava 04:01- Trenčín 05:15) odrieknutý v úseku Vaďovce - Trenčín. Náhrada: Os 3103', '2026-11-18T04:23:00Z'),
      ],
      new Date('2026-11-18T04:30:00Z')
    );
    expect(events[0]).toMatchObject({ kind: 'cancel', full: true, replacement: { kind: 'none' } });
    expect(events[1]).toMatchObject({
      kind: 'cancel',
      full: false,
      section: { from: 'Vaďovce', to: 'Trenčín' },
      replacement: { kind: 'train', text: 'Os 3103' },
    });
  });

  it('splits a post that names two trains', () => {
    const events = parsePosts(
      [
        post(
          '4',
          'REX 2530 (Wien Hbf 19:14 - Bratislava hl. st. 20:10) odrieknutý v celom úseku. Náhrada: REX 2532REX 2533 (Bratislava hl. st. 20:50 - Wien Hbf 21:46) odrieknutý v celom úseku. Náhrada: REX 2537',
          '2026-11-17T18:38:00Z'
        ),
      ],
      new Date('2026-11-17T18:50:00Z')
    );
    expect(events.map((event: { train: { number: string } }) => event.train.number).sort()).toEqual(['2530', '2533']);
  });

  it('reads a note and a line closure', () => {
    const events = parsePosts(
      [
        post('5', 'Ex 614 (Košice 10:53 - Bratislava hl. st. 16:44) upozorňujeme cestujúcich, že vo vlaku nie je radený reštauračný vozeň', '2026-11-18T05:43:00Z'),
        post('6', 'Zo dňa 17.11.2026 prerušená doprava v úseku Boleráz - Želpice od 9:00 hod. <br />Do odvolania sú všetky vlaky v úseku Trnava - Boleráz a späť nahradené náhradnou autobusovou dopravou', '2026-11-18T02:28:00Z'),
      ],
      NOW
    );
    const note = events.find((event: { kind: string }) => event.kind === 'note');
    const closure = events.find((event: { kind: string }) => event.kind === 'closure');
    expect(note.note).toMatch(/nie je radený reštauračný vozeň/);
    expect(closure).toMatchObject({ section: { from: 'Boleráz', to: 'Želpice' }, bus: true });
  });

  it('drops runs that are over and keeps the newest report per train', () => {
    const old = parsePosts(
      [post('7', 'Os 5205 (Nové Zámky 05:55 - Levice 07:13) mešká zo stanice Nové Zámky 35 min.', '2026-11-18T05:33:00Z')],
      new Date('2026-11-18T07:00:00Z') // 08:00 local: the run ended 07:13
    );
    expect(old).toEqual([]);
    const events = parsePosts(
      [
        post('8', 'REX 1972 (Košice 20:43 - Lipany 21:59) aktuálne meškanie zo stanice Kysak 26 min.', '2026-11-17T20:48:00Z'),
        post('9', 'REX 1972 (Košice 20:43 - Lipany 21:59) predpokladané meškanie zo stanice Kysak 40 min.', '2026-11-17T20:03:00Z'),
      ],
      new Date('2026-11-17T20:55:00Z')
    );
    expect(events).toHaveLength(1);
    expect(events[0].minutes).toBe(26);
  });

  it('forgets a train delay once the train is cancelled', () => {
    const events = parsePosts(
      [
        post('10', 'Os 3104 (Trenčín 05:44 - Myjava 06:57) odrieknutý v celom úseku. Náhrada: bez náhrady', '2026-11-18T05:38:00Z'),
        post('11', 'Os 3104 (Trenčín 05:44 - Myjava 06:57) mešká zo stanice Trenčín 20 min.', '2026-11-18T05:20:00Z'),
      ],
      new Date('2026-11-18T05:40:00Z')
    );
    expect(events.map((event: { kind: string }) => event.kind)).toEqual(['cancel']);
  });

  it('turns post html into plain text', () => {
    expect(postText('<p>Os 1 &amp; Ex 2<br />x</p>')).toBe('Os 1 & Ex 2 x');
  });
});
