import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyFor, detectLocale } from '../i18n';

const visitor = (timeZone: string, languages: string[]) => {
  vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(
    () => ({ resolvedOptions: () => ({ timeZone }) }) as unknown as Intl.DateTimeFormat
  );
  vi.stubGlobal('navigator', { languages, language: languages[0] });
};

describe('the language a first-time visitor gets', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('is Slovak from Slovakia and Czech from Czechia, whatever the browser language', () => {
    visitor('Europe/Bratislava', ['en-US']);
    expect(detectLocale()).toBe('sk');
    visitor('Europe/Prague', ['en-US']);
    expect(detectLocale()).toBe('cs');
  });

  it('follows a Slovak or Czech browser language from elsewhere', () => {
    visitor('Europe/London', ['sk-SK', 'en']);
    expect(detectLocale()).toBe('sk');
    visitor('Europe/Vienna', ['de-AT', 'cs']);
    expect(detectLocale()).toBe('cs');
  });

  it('is English from anywhere else', () => {
    visitor('America/New_York', ['en-US']);
    expect(detectLocale()).toBe('en');
    visitor('Europe/Berlin', ['de-DE']);
    expect(detectLocale()).toBe('en');
  });
});

describe('Czech copy', () => {
  it('counts trains with the Czech plural forms', () => {
    const cs = copyFor('cs');
    expect([1, 3, 12].map((n) => cs.trainsCount(n))).toEqual(['1 vlak', '3 vlaky', '12 vlaků']);
  });
});
