import { describe, expect, it } from 'vitest';
import { guardVerdict, hasLink, isHandleValid, publicCoverFrame, slug, sourceLangOf, targetKey, validateCoverFrame, validCoverUrl } from '@/pure';

/**
 * The allow-list IS the moderation story for covers — it is the only thing
 * standing between "a backdrop of a show you watch" and "any image on the
 * internet, rendered full width behind somebody's name".
 */
describe('validCoverUrl', () => {
  it('takes the two catalogue CDNs over https', () => {
    expect(validCoverUrl('https://image.tmdb.org/t/p/w1280/a.jpg')).toBe('https://image.tmdb.org/t/p/w1280/a.jpg');
    expect(validCoverUrl('https://artworks.thetvdb.com/banners/fanart/original/1-2.jpg')).not.toBeNull();
  });

  it('refuses anything else', () => {
    expect(validCoverUrl('https://example.com/a.jpg')).toBeNull();
    // http, not https
    expect(validCoverUrl('http://image.tmdb.org/a.jpg')).toBeNull();
    // The suffix trick an `endsWith` check would let through.
    expect(validCoverUrl('https://image.tmdb.org.attacker.net/a.jpg')).toBeNull();
    // Not a URL, and the empty/absent cases.
    expect(validCoverUrl('javascript:alert(1)')).toBeNull();
    expect(validCoverUrl('image.tmdb.org/a.jpg')).toBeNull();
    expect(validCoverUrl('')).toBeNull();
    expect(validCoverUrl(null)).toBeNull();
    expect(validCoverUrl(`https://image.tmdb.org/${'x'.repeat(600)}.jpg`)).toBeNull();
  });
});

/**
 * The vector table from docs/IMPLEMENTATION.md, "The shared identity rule".
 * The same eleven rows must exist against `targetKey` in mobile/src/pure.ts:
 * if the two sides ever disagree, the phone and the server address different
 * threads for the same film.
 */
describe('targetKey — the shared identity vectors', () => {
  // The two Amado rows are the whole point: the films that collided in 1.2.1
  // because the app compared names alone. Different years, different keys.
  it('Amado 2011', () => expect(targetKey('title', { title: 'Amado', year: '2011' })).toBe('amado|2011'));
  it('Amado 2022', () => expect(targetKey('title', { title: 'Amado', year: '2022' })).toBe('amado|2022'));

  it('Amélie 2001 — diacritics fold', () =>
    expect(targetKey('title', { title: 'Amélie', year: '2001' })).toBe('amelie|2001'));
  it('Amélie, no year', () => expect(targetKey('title', { title: 'Amélie' })).toBe('amelie|'));

  // Arabic must survive: an ASCII-only class would empty these and collapse
  // the whole Arabic catalogue into a single thread.
  it('Arabic title, no year', () => expect(targetKey('title', { title: 'مسلسل ما' })).toBe('مسلسل-ما|'));
  it('Arabic title with harakat 2019', () =>
    expect(targetKey('title', { title: 'مُسَلْسَل ما', year: '2019' })).toBe('مسلسل-ما|2019'));

  it('Spider-Man: No Way Home 2021', () =>
    expect(targetKey('title', { title: 'Spider-Man: No Way Home', year: '2021' })).toBe(
      'spider-man-no-way-home|2021',
    ));
  it('WALL·E 2008', () => expect(targetKey('title', { title: 'WALL·E', year: '2008' })).toBe('wall-e|2008'));

  // A full release date in the year column keeps movieYear()'s .slice(0, 4).
  it('  Dune   with a full date column', () =>
    expect(targetKey('title', { title: '  Dune  ', year: '2021-10-22' })).toBe('dune|2021'));
  it('Dune (1984) — year read off the title suffix', () =>
    expect(targetKey('title', { title: 'Dune (1984)' })).toBe('dune|1984'));

  it('a show is just its id', () => expect(targetKey('tvdb', { id: 121361 })).toBe('121361'));
});

describe('targetKey — edges', () => {
  /**
   * An empty (or entirely punctuation) title. `slug('')` is `''`, so the key
   * is the bare separator — `'|'` with no year, `'|2011'` with one. Decision:
   * leave it as-is rather than special-casing. It is a valid, stable, total
   * key; every empty title lands in one thread, which is correct (they are
   * indistinguishable) and harmless (nothing reaches this path without a
   * title in practice — callers validate first).
   */
  it('empty title → the bare separator', () => {
    expect(targetKey('title', { title: '' })).toBe('|');
    expect(targetKey('title', {})).toBe('|');
    expect(targetKey('title', { title: '', year: '2011' })).toBe('|2011');
    expect(targetKey('title', { title: '!!!' })).toBe('|');
  });

  it('tmdb source stringifies its id', () => expect(targetKey('tmdb', { id: '438631' })).toBe('438631'));
});

describe('slug', () => {
  it('is idempotent on an already-slugged string', () => {
    const once = slug('Spider-Man: No Way Home');
    expect(once).toBe('spider-man-no-way-home');
    expect(slug(once)).toBe(once);
    expect(slug(slug(once))).toBe(once);
  });

  it('collapses runs of non-alphanumerics into one hyphen and trims them', () => {
    expect(slug('  —Hello,   World!!  ')).toBe('hello-world');
  });

  it('is empty for a string with no letters or numbers', () => {
    expect(slug('')).toBe('');
    expect(slug('   ')).toBe('');
  });
});

describe('sourceLangOf — what language a comment is actually in', () => {
  it('a non-latin script beats the stored lang, which is the writer\'s MENUS', () => {
    // The reported case, verbatim: Arabic typed on a phone whose interface is
    // English. Stored 'en', answered `same: true`, Translate did nothing.
    const body = 'Spider-Man: Brand New Day 🔥 فيلم ممتع جدًا 9/10. القتالات كانت رائعة';
    expect(sourceLangOf('en', body)).toBe('ar');
    expect(sourceLangOf('fr', body)).toBe('ar');
    expect(sourceLangOf(null, body)).toBe('ar');
  });

  it('keeps the stored lang for latin languages, which the detector cannot tell apart', () => {
    // Script detection reads Arabic from French; it cannot read French from
    // Spanish. So the stored value is the only thing that separates them.
    expect(sourceLangOf('fr', 'Un film vraiment excellent, 9/10.')).toBe('fr');
    expect(sourceLangOf('es', 'Una película realmente excelente.')).toBe('es');
    expect(sourceLangOf('pt-BR', 'Um filme muito bom.')).toBe('pt');
  });

  it('falls back to English when nothing is known', () => {
    expect(sourceLangOf(null, 'Great film.')).toBe('en');
    expect(sourceLangOf('', '')).toBe('en');
  });

  it('a latin title inside an Arabic sentence does not make it English', () => {
    expect(sourceLangOf('en', 'The Hand و Hulk وكان الأفضل بالنسبة لي دائمًا')).toBe('ar');
  });
});

describe('handles with dots', () => {
  it('takes inner dots, refuses them at the ends or doubled', () => {
    expect(isHandleValid('itsnoddy.dev')).toEqual({ ok: true, handle: 'itsnoddy.dev' });
    for (const bad of ['.noddy', 'noddy.', 'its..noddy']) {
      expect(isHandleValid(bad)).toEqual({ ok: false, reason: 'bad_characters' });
    }
  });
});

describe('banner frame', () => {
  it('normalises a valid frame and refuses anything else', () => {
    expect(validateCoverFrame('0.5,0.25,1.5,0.9,1')).toEqual({ ok: true, value: '0.500,0.250,1.50,0.900,1,0,1.00,0' });
    expect(validateCoverFrame('0.5,0.25,1.5,1')).toEqual({ ok: true, value: '0.500,0.250,1.50,1.000,0,0,1.00,0' });
    expect(validateCoverFrame('0.5,0.5,1,0,0,1')).toEqual({ ok: true, value: '0.500,0.500,1.00,0,0,1,1.00,0' });
    expect(validateCoverFrame('0.5,0.5,1,0,1,0,0.4')).toEqual({ ok: true, value: '0.500,0.500,1.00,0,1,0,0.40,0' });
    expect(validateCoverFrame('0.5,0.5,1,0,1,0,0').ok).toBe(true);
    expect(validateCoverFrame('0.5,0.5,1,0,1,0,-0.1').ok).toBe(false);
    expect(validateCoverFrame('0.5,0.5,1,0,0,0,0.5,FF00AA')).toEqual({ ok: true, value: '0.500,0.500,1.00,0,0,0,0.50,ff00aa' });
    expect(validateCoverFrame('0.5,0.5,1,0,0,0,0.5,red').ok).toBe(false);
    expect(validateCoverFrame('0.5,0.5,1,0,0,2').ok).toBe(false);
    expect(validateCoverFrame(null)).toEqual({ ok: true, value: null });
    for (const bad of ['1.2,0,1,0', '0,0,0.5,0', '0,0,1,2.5', '0,0,1,0.1', '0,0,1,0,2', '0,0,1', 'a,b,c,d', 7]) expect(validateCoverFrame(bad).ok).toBe(false);
  });
  it('drops size and background for visitors once Plus has lapsed', () => {
    expect(publicCoverFrame('0.500,0.250,1.50,0.900,1', false)).toBe('0.500,0.250,1.50,0,0,0,1.00,0');
    expect(publicCoverFrame('0.500,0.250,1.50,0.900,1,1', false)).toBe('0.500,0.250,1.50,0,0,1,1.00,0');
    expect(publicCoverFrame('0.500,0.250,1.50,0.900,1', true)).toBe('0.500,0.250,1.50,0.900,1');
  });
});

describe('the seasonal calendar', () => {
  it('puts each season on its days and nothing in between', async () => {
    const { scheduledEvent } = await import('@/pure');
    expect(scheduledEvent('2026-10-12')).toBe('halloween');
    expect(scheduledEvent('2026-10-31')).toBe('halloween');
    expect(scheduledEvent('2026-11-01')).toBe('muertos');
    expect(scheduledEvent('2026-11-03')).toBeNull();
    expect(scheduledEvent('2026-12-25')).toBe('christmas');
    expect(scheduledEvent('2026-12-31')).toBe('newyear');
    expect(scheduledEvent('2027-01-02')).toBe('newyear');
    expect(scheduledEvent('2027-01-03')).toBeNull();
    expect(scheduledEvent('2026-06-15')).toBeNull();
  });
  it('lets Ramadan win where it meets Valentine’s', async () => {
    const { scheduledEvent } = await import('@/pure');
    expect(scheduledEvent('2027-02-14')).toBe('ramadan');
    expect(scheduledEvent('2026-02-14')).toBe('valentine');
  });
  it('stores nothing as off, auto as the calendar, anything else as itself', async () => {
    const { resolveEvent } = await import('@/pure');
    expect(resolveEvent(null, '2026-10-12')).toBeNull();
    expect(resolveEvent('auto', '2026-10-12')).toBe('halloween');
    expect(resolveEvent('auto', '2026-06-15')).toBeNull();
    expect(resolveEvent('christmas', '2026-10-12')).toBe('christmas');
  });
  it('names the next change', async () => {
    const { nextScheduledChange } = await import('@/pure');
    expect(nextScheduledChange('2026-10-12')).toEqual({ day: '2026-11-01', event: 'muertos' });
    expect(nextScheduledChange('2026-11-02')).toEqual({ day: '2026-11-03', event: null });
    expect(nextScheduledChange('2026-11-03')).toEqual({ day: '2026-12-01', event: 'christmas' });
  });
});

describe('the check before words go to CommsUni (§A11.1)', () => {
  it('reads both shapes of a Llama Guard verdict', () => {
    expect(guardVerdict({ response: { safe: true, categories: [] } })).toEqual({ safe: true, categories: [] });
    expect(guardVerdict({ response: { safe: false, categories: ['S10'] } })).toEqual({ safe: false, categories: ['S10'] });
    expect(guardVerdict({ response: 'safe' })).toEqual({ safe: true, categories: [] });
    expect(guardVerdict({ response: '\n\nunsafe\nS1,S10' })).toEqual({ safe: false, categories: ['S1', 'S10'] });
  });
  it('never reads an unknown answer as safe', () => {
    expect(guardVerdict(null)).toBeNull();
    expect(guardVerdict({ response: 'I think it is fine' })).toBeNull();
    expect(guardVerdict({ response: { categories: [] } })).toBeNull();
  });
  it('spots a link', () => {
    expect(hasLink('watch free at https://spam.example')).toBe(true);
    expect(hasLink('www.example.com')).toBe(true);
    expect(hasLink('That ending, wow. 10/10')).toBe(false);
  });
});
