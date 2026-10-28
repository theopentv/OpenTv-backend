/**
 * A profile, as a web page.
 *
 * WHY THIS EXISTS. Every OpenTV profile is already public data served over
 * HTTP, and until now the only thing that could read it was the app. So a
 * member sharing "look at my year" had nothing to send — a link to a store
 * page, or a screenshot. This turns `theopentv.com/@amanda` into something a
 * person can open, and something Discord and iMessage can unfurl into a card.
 *
 * READ ONLY, AND SERVER RENDERED. No client JavaScript, no login, no writes.
 * That is not a first version to be replaced later; it is what a profile page
 * should be. Nothing here can change anything, which is the property that makes
 * it safe to leave running.
 *
 * IT REUSES `readProfile` AND `shapeProfile` RATHER THAN QUERYING. Those two
 * carry every visibility rule this server has — soft deletion, blocks in either
 * direction, private accounts, the Plus gate on themes and widgets, and the
 * per-section hiding a member chose in Settings. A second implementation here
 * would be a second place for those rules to be wrong, and the way it would go
 * wrong is by showing a private profile to a stranger. So the page is a
 * rendering of the same answer the app gets, and nothing more.
 *
 * ANONYMOUS, ALWAYS. It passes an empty viewer, so this page sees exactly what
 * a signed-out stranger may see. A private profile therefore renders its name
 * and nothing else — which is the point of it being private, and is also why
 * there is no "log in to see more": that belongs in the app, where the follow
 * request can actually be made.
 */
import { Hono } from 'hono';

import type { Env } from '@/env';
import { sectionHidden } from '@/pure';
import { readProfile, shapeProfile } from '@/routes/profiles';

export const web = new Hono<{ Bindings: Env }>();

/** Everything that reaches the page goes through this. No exceptions. */
function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * The palette is the app's, deliberately — someone arriving from a shared link
 * should recognise the app when they later install it. Dark only, like the app.
 */
const CSS = `
:root{--bg:#000;--card:#1C1C1E;--panel:#141416;--text:#fff;--dim:#A7A7AE;--faint:#6B6B72;--yellow:#FFD400}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
.wrap{max-width:640px;margin:0 auto;padding:0 20px 64px}
.cover{height:180px;background:var(--panel) center/cover no-repeat}
.head{display:flex;gap:16px;align-items:flex-end;margin-top:-44px}
.avatar{width:88px;height:88px;border-radius:44px;border:3px solid var(--bg);background:var(--card);object-fit:cover;flex:none}
.name{font-size:24px;font-weight:800;margin:0}
.handle{color:var(--dim);margin:2px 0 0}
.plus{display:inline-block;margin-inline-start:8px;padding:2px 8px;border-radius:999px;background:var(--yellow);color:#000;font-size:12px;font-weight:800;vertical-align:middle}
.bio{color:var(--dim);margin:18px 0 0;white-space:pre-wrap}
.stats{display:flex;flex-wrap:wrap;gap:10px;margin:24px 0 0;padding:0;list-style:none}
.stat{background:var(--card);border-radius:14px;padding:12px 16px;flex:1 1 120px}
.stat b{display:block;font-size:20px;font-variant-numeric:tabular-nums}
.stat span{color:var(--faint);font-size:13px}
.links{display:flex;flex-wrap:wrap;gap:10px;margin:20px 0 0;padding:0;list-style:none}
.links a{display:inline-block;background:var(--card);color:var(--text);text-decoration:none;padding:8px 14px;border-radius:999px;font-size:14px}
.links a:hover{background:#2a2a2d}
.private{background:var(--card);border-radius:14px;padding:20px;margin-top:24px;color:var(--dim)}
.get{display:block;margin:36px 0 0;padding:14px;border-radius:999px;background:var(--yellow);color:#000;font-weight:800;text-align:center;text-decoration:none}
.foot{color:var(--faint);font-size:13px;margin-top:28px;text-align:center}
.foot a{color:var(--faint)}
h2{font-size:15px;letter-spacing:.04em;text-transform:uppercase;color:var(--faint);margin:36px 0 12px}
.shelf{display:grid;grid-template-columns:repeat(auto-fill,minmax(92px,1fr));gap:10px;padding:0;list-style:none;margin:0}
.shelf li{position:relative}
.shelf img{width:100%;aspect-ratio:2/3;object-fit:cover;border-radius:10px;background:var(--card);display:block}
.shelf .noart{width:100%;aspect-ratio:2/3;border-radius:10px;background:var(--card);display:flex;align-items:center;justify-content:center;padding:8px;font-size:11px;color:var(--dim);text-align:center}
.fav{position:absolute;top:6px;inset-inline-end:6px;font-size:13px;filter:drop-shadow(0 1px 2px #000)}
.more{color:var(--faint);font-size:13px;margin:10px 0 0}
.lists{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px;padding:0;list-style:none;margin:0}
.listcard{display:block;background:var(--card);border-radius:12px;padding:14px;color:var(--text);text-decoration:none}
.listcard:hover{background:#2a2a2d}
.back{display:inline-block;color:var(--dim);text-decoration:none;margin:20px 0 0}
.listcard b{display:block;font-size:15px}
.listcard span{color:var(--faint);font-size:13px}
`;

/**
 * The owner's theme colour, if they have one — `shapeProfile` has ALREADY
 * nulled it for anybody who is not Plus, and that gate is deliberate: older
 * app builds will render whatever the server sends, for ever, so a lapsed
 * subscription has to stop being paid-for at the source. This page inherits
 * that for free by reading the shaped answer rather than the row.
 */
function page(title: string, description: string, image: string | null, body: string, accent?: string | null): string {
  const safeAccent = typeof accent === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(accent) ? accent : null;
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<meta name="theme-color" content="#000000">
<meta property="og:type" content="profile">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
${image ? `<meta property="og:image" content="${esc(image)}">` : ''}
<meta name="twitter:card" content="${image ? 'summary_large_image' : 'summary'}">
<style>${CSS}${safeAccent ? `:root{--yellow:${safeAccent}}` : ''}</style></head><body>${body}</body></html>`;
}

/**
 * WHERE THE API LIVES, ABSOLUTELY — and it cannot be a relative path.
 *
 * This page is served on two hostnames: the Worker's own, and `theopentv.com`
 * via a route that deliberately matches ONLY `/@*` so the marketing site keeps
 * every other path. A relative `/v1/avatars/…` therefore resolves against
 * theopentv.com, which does not route it here, and every avatar on a shared
 * link renders as a broken image. Found by looking at the live page.
 */
const API_ORIGIN = 'https://opentv-api.mahmoodbashar08.workers.dev';

/** A number a person reads, not a number a database returns. */
function nf(n: unknown): string {
  const v = Number(n ?? 0);
  return Number.isFinite(v) ? v.toLocaleString('en-US') : '0';
}

/*
 * `/@amanda`, and the pattern is regex-constrained rather than the obvious
 * `/@:handle` — Hono does not match a parameter that begins mid-segment, so
 * that form silently fell through to the 404 handler and answered JSON to a
 * browser. The constraint doubles as validation: anything that is not a handle
 * never reaches the database.
 */
web.get('/:handle{@[A-Za-z0-9_.-]{1,40}}', async (c) => {
  // ANONYMOUS. Never the caller's session, even if they send one: this page is
  // a public artefact and must render identically for everybody, or a link
  // would show its author more than it shows the person they sent it to.
  const row = await readProfile(c.env, (c.req.param('handle') ?? '').replace(/^@/, ''), '');

  if (!row || row.blocked === 1) {
    return c.html(
      page('Not found — OpenTV', 'No such profile.', null, `<div class="wrap"><p class="bio" style="margin-top:64px">No such profile.</p><a class="get" href="https://theopentv.com">Get OpenTV</a></div>`),
      404,
    );
  }

  const p = shapeProfile(row, '', new Date().toISOString()) as Record<string, any>;
  const name: string = p.display_name || p.handle;
  /*
   * `avatar_key` IS SOMETIMES ALREADY A URL. The column holds whatever the
   * upload put there, and for anything uploaded through this server that is a
   * full absolute address — so prefixing it produced
   * `…/v1/avatars/https%3A%2F%2F…`, a 404 and a broken image on the live page.
   * Prefix only a bare key.
   */
  const avatar = !p.avatar_key
    ? null
    : /^https?:\/\//.test(p.avatar_key)
      ? p.avatar_key
      : `${API_ORIGIN}/v1/avatars/${encodeURIComponent(p.avatar_key)}`;

  /*
   * A PRIVATE PROFILE GETS A NAME AND A FULL STOP. `shapeProfile` has already
   * emptied the counts and the rest for an anonymous viewer; this only decides
   * what to say instead, and says the true thing rather than dangling a
   * "follow to see more" that no web page can deliver.
   */
  if (p.is_private) {
    return c.html(
      page(
        `${name} on OpenTV`,
        'This profile is private.',
        null,
        `<div class="cover"></div><div class="wrap">
          <div class="head">${avatar ? `<img class="avatar" src="${esc(avatar)}" alt="">` : '<div class="avatar"></div>'}
            <div><h1 class="name">${esc(name)}</h1><p class="handle">@${esc(p.handle)}</p></div></div>
          <div class="private">This profile is private.</div>
          <a class="get" href="https://theopentv.com">Get OpenTV</a>
        </div>`,
      ),
    );
  }

  /*
   * THE SHELVES AND THE REAL NUMBERS, read the way `/profiles/:handle/published`
   * reads them. Visibility was already decided above — a private or blocked
   * profile never reaches here — so what is left is the owner's own per-section
   * switches, and those are honoured with the SAME `sectionHidden` the API
   * uses. A page that showed a shelf its owner had hidden would be the app's
   * privacy settings quietly not applying on the web.
   *
   * `owns` is false by construction: this page has no viewer.
   */
  const hides = (key: 'stats' | 'shows' | 'movies' | 'favourite_shows' | 'favourite_movies') =>
    sectionHidden(row.hidden_sections, key);

  const ps = hides('stats')
    ? null
    : await c.env.DB.prepare(
        // simple_view (0065): the owner chose counts-only, so the web page shows none, like a hidden section.
        'SELECT episodes_watched, minutes_watched, movie_minutes, shows_count, movies_count FROM profile_stats WHERE profile_id = ? AND simple_view = 0',
      )
        .bind(row.id)
        .first<{ episodes_watched: number; minutes_watched: number; movie_minutes: number; shows_count: number; movies_count: number }>();

  const titles = await c.env.DB.prepare(
    `SELECT kind, name, poster, favourite, fav_rank
       FROM profile_titles
      WHERE profile_id = ?
      ORDER BY kind, rank IS NULL, rank, name`,
  )
    .bind(row.id)
    .all<{ kind: string; name: string | null; poster: string | null; favourite: number; fav_rank: number | null }>();

  /** A shelf, capped — a page is a glance, not the whole library. */
  const SHELF_MAX = 18;
  const shelfOf = (kind: 'show' | 'movie') => {
    if (hides(kind === 'show' ? 'shows' : 'movies')) return { html: '', total: 0 };
    const rows = (titles.results ?? []).filter((r) => r.kind === kind);
    const starOk = !hides(kind === 'show' ? 'favourite_shows' : 'favourite_movies');
    const html = rows
      .slice(0, SHELF_MAX)
      .map((r) => {
        const art = r.poster
          ? `<img src="${esc(r.poster)}" alt="${esc(r.name ?? '')}" loading="lazy">`
          : `<div class="noart">${esc(r.name ?? '')}</div>`;
        return `<li>${art}${starOk && r.favourite === 1 ? '<span class="fav">★</span>' : ''}</li>`;
      })
      .join('');
    return { html, total: rows.length };
  };
  const shows = shelfOf('show');
  const films = shelfOf('movie');

  /*
   * FAVOURITES FIRST, and on their OWN order. `fav_rank` is the owner's drag
   * order for the favourites rail, which is not the main shelf's order — the
   * same distinction `/published` documents. A profile leads with what somebody
   * chose to put first; leading with an alphabetical watch list buries it.
   *
   * Hidden separately from the shelves, because hiding "these are my
   * favourites" is a different claim from hiding what you watched.
   */
  const favs = (titles.results ?? [])
    .filter(
      (r) =>
        r.favourite === 1 &&
        !hides(r.kind === 'show' ? 'favourite_shows' : 'favourite_movies') &&
        !hides(r.kind === 'show' ? 'shows' : 'movies'),
    )
    .sort((a, b) => (a.fav_rank ?? 9999) - (b.fav_rank ?? 9999))
    .slice(0, 12);
  const favsHtml = favs
    .map((r) =>
      r.poster
        ? `<li><img src="${esc(r.poster)}" alt="${esc(r.name ?? '')}" loading="lazy"></li>`
        : `<li><div class="noart">${esc(r.name ?? '')}</div></li>`,
    )
    .join('');

  /*
   * LISTS — public ones only, in the owner's own arrangement, and silent when
   * the `lists` section is switched off. Same query the API's lists route runs,
   * minus the columns a page cannot draw.
   */
  const listRows = hides('lists' as never)
    ? { results: [] as { id: string; name: string; item_count: number }[] }
    : await c.env.DB.prepare(
        `SELECT l.id, l.name, (SELECT COUNT(*) FROM list_items i WHERE i.list_id = l.id) AS item_count
           FROM lists l
          WHERE l.owner_id = ? AND l.is_public = 1
          ORDER BY l.position ASC, l.created_at DESC, l.id DESC
          LIMIT 12`,
      )
        .bind(row.id)
        .all<{ id: string; name: string; item_count: number }>();
  const listsHtml = (listRows.results ?? [])
    .map(
      (l) =>
        `<li><a class="listcard" href="/list/${esc(l.id)}"><b>${esc(l.name)}</b><span>${nf(l.item_count)} titles</span></a></li>`,
    )
    .join('');

  const c_ = p.counts ?? {};
  /* The four `shapeProfile` actually carries. Shows and films are published
     stats on another route, and asking for them here would be a second query
     for a page that is meant to be one. */
  const days = ps ? Math.round(((ps.minutes_watched ?? 0) + (ps.movie_minutes ?? 0)) / 1440) : null;
  const stats = [
    ['Episodes', ps?.episodes_watched],
    ['Days watched', days],
    ['Shows', ps?.shows_count],
    ['Films', ps?.movies_count],
    ['Comments', c_.comments],
    ['Followers', c_.followers],
  ]
    .filter(([, v]) => v != null)
    .map(([label, v]) => `<li class="stat"><b>${nf(v)}</b><span>${esc(label)}</span></li>`)
    .join('');

  // Only `https:` reaches here — `parseLinks` has already applied the same rule
  // the app applies twice more before anybody taps one.
  const links = Array.isArray(p.links)
    ? p.links
        .filter((l: any) => typeof l?.url === 'string' && l.url.startsWith('https://'))
        .map((l: any) => `<a href="${esc(l.url)}" rel="noopener nofollow ugc" target="_blank">${esc(l.service)}</a>`)
        .join('')
    : '';

  const description = p.bio || `${name} tracks TV and films on OpenTV.`;

  return c.html(
    page(
      `${name} on OpenTV`,
      description,
      p.cover_url || avatar,
      `${p.cover_url ? `<div class="cover" style="background-image:url('${esc(p.cover_url)}')"></div>` : '<div class="cover"></div>'}
       <div class="wrap">
         <div class="head">${avatar ? `<img class="avatar" src="${esc(avatar)}" alt="">` : '<div class="avatar"></div>'}
           <div><h1 class="name">${esc(name)}${p.is_plus ? '<span class="plus">PLUS</span>' : ''}</h1>
             <p class="handle">@${esc(p.handle)}</p></div></div>
         ${p.bio ? `<p class="bio">${esc(p.bio)}</p>` : ''}
         ${stats ? `<ul class="stats">${stats}</ul>` : ''}
         ${links ? `<ul class="links">${links}</ul>` : ''}
         ${favsHtml ? `<h2>Favourites</h2><ul class="shelf">${favsHtml}</ul>` : ''}
         ${listsHtml ? `<h2>Lists</h2><ul class="lists">${listsHtml}</ul>` : ''}
         ${shows.total ? `<h2>Shows</h2><ul class="shelf">${shows.html}</ul>${shows.total > SHELF_MAX ? `<p class="more">and ${nf(shows.total - SHELF_MAX)} more</p>` : ''}` : ''}
         ${films.total ? `<h2>Films</h2><ul class="shelf">${films.html}</ul>${films.total > SHELF_MAX ? `<p class="more">and ${nf(films.total - SHELF_MAX)} more</p>` : ''}` : ''}
         <a class="get" href="https://theopentv.com">Get OpenTV</a>
         <p class="foot">Your watch history stays on your phone.<br><a href="https://theopentv.com/privacy">Privacy</a></p>
       </div>`,
      p.theme_color,
    ),
  );
});


/**
 * A LIST, AS A PAGE — the other half of a shareable profile. A list is the one
 * thing on a profile somebody makes deliberately and wants to send: "here is
 * what to watch". Until now the card said how many titles were in it and there
 * was nowhere to go.
 *
 * PUBLIC ONLY, and the check is the same pair the API applies: a list belonging
 * to a deleted account is gone, and a private list is a 404 rather than a 403 —
 * refusing by name would confirm it exists.
 */
web.get('/list/:id', async (c) => {
  const id = c.req.param('id') ?? '';
  const row = await c.env.DB.prepare(
    `SELECT l.id, l.name, l.description, l.is_public, p.handle, p.display_name
       FROM lists l JOIN profiles p ON p.id = l.owner_id
      WHERE l.id = ? AND p.deleted_at IS NULL AND p.is_private = 0`,
  )
    .bind(id)
    .first<{ id: string; name: string; description: string | null; is_public: number; handle: string; display_name: string | null }>();

  if (!row || row.is_public !== 1) {
    return c.html(
      page('Not found — OpenTV', 'No such list.', null, `<div class="wrap"><p class="bio" style="margin-top:64px">No such list.</p><a class="get" href="https://theopentv.com">Get OpenTV</a></div>`),
      404,
    );
  }

  const items = await c.env.DB.prepare(
    'SELECT title, poster FROM list_items WHERE list_id = ? ORDER BY position LIMIT 60',
  )
    .bind(id)
    .all<{ title: string | null; poster: string | null }>();

  const owner = row.display_name || row.handle;
  const art = (items.results ?? [])
    .map((i) =>
      i.poster
        ? `<li><img src="${esc(i.poster)}" alt="${esc(i.title ?? '')}" loading="lazy"></li>`
        : `<li><div class="noart">${esc(i.title ?? '')}</div></li>`,
    )
    .join('');

  return c.html(
    page(
      `${row.name} — a list by ${owner} on OpenTV`,
      row.description || `${(items.results ?? []).length} titles, chosen by ${owner}.`,
      (items.results ?? []).find((i) => i.poster)?.poster ?? null,
      `<div class="wrap">
         <a class="back" href="/@${esc(row.handle)}">← ${esc(owner)}</a>
         <h1 class="name" style="margin-top:12px">${esc(row.name)}</h1>
         ${row.description ? `<p class="bio">${esc(row.description)}</p>` : ''}
         ${art ? `<ul class="shelf" style="margin-top:24px">${art}</ul>` : '<p class="bio">This list is empty.</p>'}
         <a class="get" href="https://theopentv.com">Get OpenTV</a>
       </div>`,
    ),
  );
});
