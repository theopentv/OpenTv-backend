/**
 * Pure functions: no imports, no bindings, no clock. Everything here is a
 * decision that can be wrong, which is why it is here and unit-tested rather
 * than buried in a handler (docs/IMPLEMENTATION.md, "Testing philosophy").
 *
 * THE SHARED IDENTITY RULE
 * -----------------------
 * `slug` / `movieBaseName` / `movieYearOf` / `targetKey` below are mirrored
 * **character-for-character** in `mobile/src/pure.ts`. Phone and server must
 * compute the same key for the same film or they build two threads for it.
 * Change one side and you have split the conversation for every film whose
 * title is touched by the change.
 *
 * The test vectors that pin the rule live in `test/pure.test.ts` here and must
 * exist identically on the app side (docs/IMPLEMENTATION.md, "The shared
 * identity rule" — the table of eleven vectors).
 *
 * The single most important line in this file is the character class
 * `[^\p{L}\p{N}]+` with the `u` flag. An ASCII-only `[^a-z0-9]` would reduce
 * every Arabic title to the empty string and collapse the entire Arabic
 * catalogue into one thread.
 */

/** slug: lowercase · NFKD-fold diacritics · non-alphanumerics → single hyphen · trim hyphens */
export function slug(title: string): string {
  return title
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '') // drop combining marks: é → e, مُ → م
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-') // Unicode-aware: Arabic and CJK survive
    .replace(/^-+|-+$/g, '');
}

/**
 * The title with a trailing "(YYYY)" removed, lowercased and with runs of
 * whitespace collapsed.
 *
 * TV Time spells the same film two ways — "Dune (2021)" from the watched rows
 * and a bare "Dune" from the watchlist — and the trailing year is the only
 * thing separating them, as it is the only thing separating a genuine remake.
 * So it is stripped here and decided on separately in `movieYearOf`.
 */
export function movieBaseName(name: string): string {
  return name
    .replace(/\s*\((\d{4})\)\s*$/, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

/**
 * The film's year: the stored column if it starts with four digits, else a
 * "(YYYY)" suffix on the title, else null.
 *
 * The `.slice(0, 4)` is deliberate and is the app's `movieYear()` behaviour:
 * the column often carries a full release date, so "2021-10-22" yields 2021.
 */
export function movieYearOf(name: string, year?: string | null): string | null {
  const col = (year ?? '').trim().slice(0, 4);
  if (/^\d{4}$/.test(col)) return col;
  const m = /\((\d{4})\)\s*$/.exec(name);
  return m ? m[1]! : null;
}

/** The address of a thread. Shows are an id; films without one are slug|year. */
export function targetKey(
  source: 'tvdb' | 'tmdb' | 'title',
  a: { id?: number | string | null; title?: string | null; year?: string | null },
): string {
  if (source === 'tvdb' || source === 'tmdb') return String(a.id);
  const base = movieBaseName(a.title ?? ''); // strips a trailing "(YYYY)"
  const year = movieYearOf(a.title ?? '', a.year); // column first, then suffix
  return `${slug(base)}|${year ?? ''}`;
}

// ── ID-token claims ──────────────────────────────────────────────────────────
//
// The crypto lives in `src/auth.ts`; only the *rules* live here, because the
// rules are what can be quietly wrong. The table below is
// docs/IMPLEMENTATION.md §1b, claim for claim.

export type Provider = 'apple' | 'google';

/** A decoded — NOT yet trusted — ID-token payload. */
export type IdTokenPayload = {
  iss?: unknown;
  aud?: unknown;
  exp?: unknown;
  iat?: unknown;
  sub?: unknown;
  email?: unknown;
  /** Google sends a boolean. Apple has historically sent the STRING "true". */
  email_verified?: unknown;
};

export type ExpectedClaims = {
  provider: Provider;
  /** Apple: the bundle id. Google: every configured client id. */
  audiences: readonly string[];
};

export type ClaimsResult =
  | { ok: true; sub: string; email: string | null; emailVerified: boolean }
  | { ok: false; reason: ClaimFailure };

export type ClaimFailure =
  | 'bad_issuer'
  | 'bad_audience'
  | 'expired'
  | 'issued_in_future'
  | 'missing_sub';

/** Google emits both spellings of its issuer, and has done for years. */
const ISSUERS: Record<Provider, readonly string[]> = {
  apple: ['https://appleid.apple.com'],
  google: ['https://accounts.google.com', 'accounts.google.com'],
};

/** Clock-skew allowance on `iat`, in seconds. */
export const IAT_SKEW_SECONDS = 300;

/**
 * Validate every claim, no exceptions. `nowMs` is a parameter so this stays
 * testable and this file stays clock-free.
 *
 * Not checked, deliberately: `nonce` — the app is not a browser, there is no
 * redirect to replay.
 *
 * `email_verified` IS NOW READ, and that is a reversal worth naming. The
 * address used to be stored for support and trusted for nothing, so the claim
 * did not matter. Linking a provider sign-in to an existing email account
 * makes the address decide WHICH ACCOUNT somebody lands in, and at that point
 * an unverified address is an account takeover: anyone able to put a string in
 * an `email` claim could name yours.
 *
 * It is not grounds for rejection. A token with an unverified address is still
 * a valid sign-in for its own identity; it simply cannot be used to reach an
 * account that already exists. Apple sends the string "true" rather than a
 * boolean, and has for years, so both are accepted.
 */
export function verifyClaims(
  payload: IdTokenPayload,
  expected: ExpectedClaims,
  nowMs: number,
): ClaimsResult {
  const nowSec = Math.floor(nowMs / 1000);

  const iss = typeof payload.iss === 'string' ? payload.iss : '';
  if (!ISSUERS[expected.provider].includes(iss)) return { ok: false, reason: 'bad_issuer' };

  // `aud` is a string for both providers today, but the JWT spec allows an
  // array and accepting one costs a line.
  const auds: string[] = Array.isArray(payload.aud)
    ? payload.aud.filter((a): a is string => typeof a === 'string')
    : typeof payload.aud === 'string'
      ? [payload.aud]
      : [];
  const allowed = expected.audiences.filter((a) => a.length > 0);
  if (allowed.length === 0 || !auds.some((a) => allowed.includes(a))) {
    return { ok: false, reason: 'bad_audience' };
  }

  if (typeof payload.exp !== 'number' || !(payload.exp > nowSec)) {
    return { ok: false, reason: 'expired' };
  }

  if (typeof payload.iat !== 'number' || payload.iat > nowSec + IAT_SKEW_SECONDS) {
    return { ok: false, reason: 'issued_in_future' };
  }

  if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
    return { ok: false, reason: 'missing_sub' };
  }

  const ev = payload.email_verified;
  return {
    ok: true,
    sub: payload.sub,
    email: typeof payload.email === 'string' && payload.email.length > 0 ? payload.email : null,
    emailVerified: ev === true || ev === 'true',
  };
}

// ── handles ──────────────────────────────────────────────────────────────────

/** Reserved for the placeholder handles a fresh profile is born with. */
export const HANDLE_PLACEHOLDER_PREFIX = 'user_';

/** Small and deliberate. Names that would let someone impersonate the service. */
export const RESERVED_HANDLES: readonly string[] = [
  'admin',
  'opentv',
  'support',
  'help',
  'api',
  'moderator',
];

export const HANDLE_MIN = 3;
export const HANDLE_MAX = 20;

/** NFKC, lowercase, trim. Everything downstream sees only this form. */
export function normaliseHandle(input: string): string {
  return input.normalize('NFKC').trim().toLowerCase();
}

export type HandleFailure = 'too_short' | 'too_long' | 'bad_characters' | 'reserved';

/**
 * `[a-z0-9_]` and inner dots only, and that is not an oversight. A handle is an address people
 * type and read aloud; homograph attacks on a follow-someone-by-name flow are
 * not theoretical. A Cyrillic "а" fails here, which is the point.
 *
 * Takes the RAW input and normalises internally, so a caller cannot forget to.
 */
export function isHandleValid(input: string): { ok: true; handle: string } | { ok: false; reason: HandleFailure } {
  const h = normaliseHandle(input);
  if (h.length < HANDLE_MIN) return { ok: false, reason: 'too_short' };
  if (h.length > HANDLE_MAX) return { ok: false, reason: 'too_long' };
  // Dots too (`itsnoddy.dev`, the owner, 2 Oct), as Instagram allows them:
  // never first or last, never two together, so a handle cannot pass for a
  // file name or a domain fragment like `..` or `.com`.
  if (!/^[a-z0-9_]+(\.[a-z0-9_]+)*$/.test(h)) return { ok: false, reason: 'bad_characters' };
  if (h.startsWith(HANDLE_PLACEHOLDER_PREFIX)) return { ok: false, reason: 'reserved' };
  if (RESERVED_HANDLES.includes(h)) return { ok: false, reason: 'reserved' };
  return { ok: true, handle: h };
}

/**
 * The handle a brand-new profile is born with. Never invent a pretty one
 * server-side: the user picks it, and a taken name must be refused
 * (docs/PLAN.md §3, "Handles are a suggestion, not a claim").
 */
export function placeholderHandle(profileId: string): string {
  return `${HANDLE_PLACEHOLDER_PREFIX}${profileId.slice(0, 10)}`;
}

/** True when the app must run the handle flow before anything social. */
export function needsHandle(handle: string): boolean {
  return handle.startsWith(HANDLE_PLACEHOLDER_PREFIX);
}

// ── ratings ──────────────────────────────────────────────────────────────────

/** The three addressable kinds of thing. Mirrors the CHECK constraints in 0001. */
export const TARGET_SOURCES = ['tvdb', 'tmdb', 'title'] as const;
export type TargetSource = (typeof TARGET_SOURCES)[number];

export function isTargetSource(v: unknown): v is TargetSource {
  return typeof v === 'string' && (TARGET_SOURCES as readonly string[]).includes(v);
}

/**
 * The emotion allow-list — TV Time's own twelve, exactly as the app presents
 * them, so an imported reaction has somewhere to land and every tap a user
 * makes actually counts for something.
 *
 * These names and this ORDER are index-locked to `EMOTIONS` in
 * `mobile/src/app/episode/[id].tsx`, which is in turn index-locked to the
 * local database. Reorder one and you must reorder all three.
 *
 * An earlier draft of this list had six invented names and the app folded its
 * twelve onto them, which silently dropped reflective, bored, understood and
 * confused and merged shocked with thrilled. Widening it costs nothing —
 * `emotion_counts` is a JSON object, so new keys need no migration — and it
 * means the community mirrors what TV Time actually had.
 *
 * This list is not decoration. Emotion names are interpolated into a JSON path
 * (`'$."' || :name || '"'`) in the aggregate upsert, so an unvalidated emotion
 * is a JSON-path injection. Nothing reaches that SQL without passing through
 * here.
 *
 * A person may hold ANY SUBSET of this list on one target — see
 * migrations/0005_emotion_votes.sql. The length of the list is therefore also
 * the largest set anybody can send.
 */
export const EMOTIONS = [
  'shocked',
  'frustrated',
  'sad',
  'reflective',
  'touched',
  'amused',
  'scared',
  'bored',
  'understood',
  'thrilled',
  'confused',
  'tense',
] as const;
export type Emotion = (typeof EMOTIONS)[number];

export function isEmotion(v: unknown): v is Emotion {
  return typeof v === 'string' && (EMOTIONS as readonly string[]).includes(v);
}

/** Nobody can select a feeling twice, so the whole list is the ceiling. */
export const MAX_EMOTIONS = EMOTIONS.length;

export const SCORE_MIN = 1;
export const SCORE_MAX = 10;

/**
 * The server's score contract, in one predicate: an integer in 1..10.
 *
 * The app sends 2/4/6/8/10 for its five stars, but that is the CLIENT's mapping
 * of a five-star widget onto a ten-point scale and it is deliberately not
 * encoded here — a half-star build sending odd numbers must need no server
 * change (see migrations/0004_score_distribution.sql).
 *
 * Exported because the score is now interpolated into a JSON path in the
 * aggregate upsert, the same way an emotion is, and nothing may reach that SQL
 * without passing through a check. A bare number is far less dangerous than a
 * free-text name, but "far less dangerous" is not the standard the character
 * vote work set.
 */
export function isScore(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= SCORE_MIN && v <= SCORE_MAX;
}

/**
 * A vote's SCORE half, as it is stored. The feelings half is no longer part of
 * this shape: since 0005 a person's feelings are rows in `emotion_votes` and a
 * set moves by `emotionSetDelta`, not by a from/to pair.
 */
export type Vote = { score: number | null };

/**
 * How a vote's score moves the rollup.
 *
 * `scoreFrom`/`scoreTo` drive `score_counts` and are NOT redundant with
 * `dScore`: `dScore` moves a sum and can only ever yield a mean, while these two
 * move a bucket each and are what makes "82% gave it five stars" renderable at
 * all.
 */
export type AggregateDelta = {
  dVotes: number;
  dScore: number;
  scoreFrom: number | null;
  scoreTo: number | null;
};

/**
 * How a person's SET of feelings moves the rollup: the ones they let go of and
 * the ones they picked up, which the caller turns into one `json_set` decrement
 * per `removed` and one increment per `added`.
 *
 * `next === undefined` means the request did not mention feelings at all, which
 * is not the same request as one that sent `[]`. Absent leaves the set exactly
 * where it is (both lists empty); empty CLEARS it (everything removed, nothing
 * added). A client that only changes a score must never be able to wipe the
 * feelings it did not send.
 *
 * Re-sending an identical set yields two empty lists, so a repeated write moves
 * no counter — the property that keeps `emotion_counts` from drifting upward
 * every time a screen re-submits what it already has.
 */
export type EmotionSetDelta = { added: Emotion[]; removed: Emotion[] };

export function emotionSetDelta(
  prev: readonly string[],
  next: readonly Emotion[] | undefined,
): EmotionSetDelta {
  if (next === undefined) return { added: [], removed: [] };
  const before = new Set(prev);
  const after = new Set<string>(next);
  return {
    added: next.filter((e) => !before.has(e)),
    // Anything stored that is no longer selected goes, including a name that is
    // no longer on the allow-list: `isEmotion` guards what goes IN, and a row
    // that predates a list change must still be removable by its owner.
    removed: prev.filter((e) => !after.has(e)) as Emotion[],
  };
}

/**
 * docs/IMPLEMENTATION.md Step 2, "The delta logic", row for row:
 *
 * | new vote with a score        | +1 | +next.score  |
 * | new vote, feelings only      | +1 |  0           |
 * | changed score 7 → 9          |  0 | +2           |
 * | score added to a feeling     |  0 | +next.score  |
 * | score removed (score → null) |  0 | -prev.score  |
 * | feelings changed only        |  0 |  0           |
 *
 * `vote_count` counts *people*, which is why a feelings-only vote still adds
 * one (the `ratings` row exists with a NULL score for exactly that) and a
 * re-vote adds none.
 *
 * `scoreFrom`/`scoreTo` follow the same rule one column to the right: decrement
 * `scoreFrom`'s bucket, increment `scoreTo`'s, skip either half that is null and
 * skip both when they are equal. A feelings-only vote moves no bucket (both
 * null); an identical re-vote moves none (from === to).
 *
 * Both go through `isScore`, so a row that somehow holds an out-of-range score —
 * only a hand-edited database could — decrements nothing rather than opening a
 * bucket that should not exist. `dScore` is left alone in that case: the sum is
 * the nightly recount's problem, and guessing here would hide the corruption.
 */
export function aggregateDelta(prev: Vote | null, next: Vote): AggregateDelta {
  const prevScore = prev?.score ?? null;
  const nextScore = next.score ?? null;
  return {
    dVotes: prev ? 0 : 1,
    dScore: (nextScore ?? 0) - (prevScore ?? 0),
    scoreFrom: isScore(prevScore) ? prevScore : null,
    scoreTo: isScore(nextScore) ? nextScore : null,
  };
}

export type VoteFailure =
  | 'score_invalid'
  | 'emotion_invalid'
  | 'empty_vote'
  | 'season_invalid'
  | 'episode_invalid'
  | 'episode_without_season';

export type ValidatedVote = {
  score: number | null;
  /**
   * The person's WHOLE set of feelings for this target, or `undefined` when the
   * body did not mention feelings at all. `[]` is a real value — "I have none
   * any more" — and is not the same as absent. See `emotionSetDelta`.
   */
  emotions: Emotion[] | undefined;
  season: number | null;
  episode: number | null;
};

/**
 * Feelings out of a request body, in both spellings the contract accepts.
 *
 * `emotions: string[]` is the real one: 0..12 members, every one on the
 * allow-list, deduped (a client sending `["sad","sad"]` means one sad, and the
 * primary key would refuse the second anyway).
 *
 * `emotion: string | null` is the OLD single-choice field, kept working because
 * a build of the app that only knows it is on people's phones today. It is read
 * as a one-member set, and `emotion: null` is read as ABSENT rather than as a
 * clear — that build sends null to mean "I am not touching feelings", and
 * treating it as a clear would delete a set the app never knew it had.
 * `emotions` wins whenever both are present.
 */
function parseEmotions(input: {
  emotion?: unknown;
  emotions?: unknown;
}): { ok: true; emotions: Emotion[] | undefined } | { ok: false } {
  const raw = input.emotions;
  if (raw !== undefined && raw !== null) {
    if (!Array.isArray(raw) || raw.length > MAX_EMOTIONS) return { ok: false };
    const out: Emotion[] = [];
    for (const e of raw) {
      if (!isEmotion(e)) return { ok: false };
      if (!out.includes(e)) out.push(e);
    }
    return { ok: true, emotions: out };
  }

  const legacy = input.emotion ?? null;
  if (legacy === null) return { ok: true, emotions: undefined };
  if (!isEmotion(legacy)) return { ok: false };
  return { ok: true, emotions: [legacy] };
}

/**
 * Everything a vote body must satisfy before a statement is prepared. Score 0
 * and score 11 die here, not at the CHECK constraint, so the client gets
 * `invalid_body` rather than a 500 wearing a database error's clothes.
 */
export function validateVote(input: {
  score?: unknown;
  emotion?: unknown;
  emotions?: unknown;
  season?: unknown;
  episode?: unknown;
}): { ok: true; vote: ValidatedVote } | { ok: false; reason: VoteFailure } {
  const rawScore = input.score ?? null;
  let score: number | null = null;
  if (rawScore !== null) {
    if (typeof rawScore !== 'number' || !Number.isInteger(rawScore)) {
      return { ok: false, reason: 'score_invalid' };
    }
    if (rawScore < SCORE_MIN || rawScore > SCORE_MAX) return { ok: false, reason: 'score_invalid' };
    score = rawScore;
  }

  const feelings = parseEmotions(input);
  if (!feelings.ok) return { ok: false, reason: 'emotion_invalid' };
  const emotions = feelings.emotions;

  // A body that mentions NOTHING is not a vote; it is a delete, and deleting is
  // not this endpoint's job. `emotions: []` is deliberately NOT nothing — it is
  // "clear my feelings", a real instruction with a real effect — so it passes
  // here even with a null score. The caller is the only layer that can tell
  // whether there is anything to clear, and rejects a clear of nothing itself.
  if (score === null && emotions === undefined) return { ok: false, reason: 'empty_vote' };

  const season = numberOrNull(input.season);
  if (season === undefined) return { ok: false, reason: 'season_invalid' };
  const episode = numberOrNull(input.episode);
  if (episode === undefined) return { ok: false, reason: 'episode_invalid' };
  // Episode 3 of nothing in particular is not addressable.
  if (episode !== null && season === null) return { ok: false, reason: 'episode_without_season' };

  return { ok: true, vote: { score, emotions, season, episode } };
}

/**
 * null for absent, the number for a valid one, `undefined` for invalid.
 * Exported because comments address the same season/episode space as ratings
 * and must reject the same bodies.
 */
export function numberOrNull(v: unknown): number | null | undefined {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) return undefined;
  return v;
}

/** The `t=` form of GET /v1/aggregates, parsed. */
export type ParsedTarget = {
  source: TargetSource;
  key: string;
  season: number;
  episode: number;
};

export const MAX_TARGETS = 100;

/**
 * The ceiling on one rescued comment photo.
 *
 * These are phone photographs and screenshots from TV Time, most well under a
 * megabyte; 8 MB is generous for the largest of them and small enough that a
 * malformed or hostile upload cannot be used to fill a bucket. A Worker request
 * body is capped at 100 MB regardless, so this is a product limit rather than a
 * platform one, and it is enforced before the file is ever read into memory.
 */
export const MAX_COMMENT_IMAGE_BYTES = 8_000_000;

/**
 * The ceiling on a profile picture.
 *
 * Far below the comment-image limit and deliberately so: a comment photo is an
 * irreplaceable rescued original, an avatar is a face rendered at 44 points. 2 MB
 * is generous for the latter, and every byte of it is served on every screen
 * that draws a person.
 */
export const MAX_AVATAR_BYTES = 2_000_000;

/** A cover is a full-width backdrop rather than a 44-point circle, so it gets more room. */
export const MAX_COVER_BYTES = 5_000_000;

/** An uploaded GIF banner (Plus): frames add up, so a little more room. */
export const MAX_COVER_GIF_BYTES = 8_000_000;

// ── email sign-in ───────────────────────────────────────────────────────────

/**
 * An address, normalised, or null if it is not one.
 *
 * DELIBERATELY NOT A FULL RFC 5322 PARSER. That grammar admits quoted strings,
 * comments and nested pairs that no real signup form produces, and every
 * attempt to match it with one expression has been a famous mistake. What
 * matters here is: something before an @, something after it with a dot, no
 * whitespace, and a sane length. The real verification is that we send mail to
 * it and they click the link.
 *
 * LOWERCASED WHOLE. The local part is technically case-sensitive; treating it
 * that way would let `Me@x.com` and `me@x.com` be two accounts, which no user
 * has ever wanted and every provider that matters already refuses.
 */
export function normaliseEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim().toLowerCase();
  if (s.length < 6 || s.length > 254) return null;
  if (/\s/.test(s)) return null;
  const at = s.indexOf('@');
  if (at < 1 || at !== s.lastIndexOf('@')) return null;
  const domain = s.slice(at + 1);
  if (domain.length < 3 || !domain.includes('.') || domain.startsWith('.') || domain.endsWith('.')) return null;
  if (domain.includes('..')) return null;
  return s;
}

export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 200;

export type PasswordFailure = 'too_short' | 'too_long' | 'too_common';

/**
 * LENGTH, AND A LIST OF THE OBVIOUS ONES. No character-class rules.
 *
 * Requiring a digit and a symbol produces `Password1!` and a sticky note; it
 * measurably lowers real-world strength while making the form hostile. Current
 * NIST guidance says the same: check length, screen against known-bad, and
 * otherwise leave people alone. The upper bound exists only so a megabyte of
 * text cannot be fed to PBKDF2 210,000 times.
 */
export function passwordError(password: unknown): PasswordFailure | null {
  if (typeof password !== 'string') return 'too_short';
  if (password.length < PASSWORD_MIN) return 'too_short';
  if (password.length > PASSWORD_MAX) return 'too_long';
  const flat = password.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (COMMON_PASSWORDS.has(flat)) return 'too_common';
  return null;
}

/** Not a breach corpus — the handful that a screening list this size can pay for. */
const COMMON_PASSWORDS = new Set([
  'password',
  'password1',
  'password123',
  '12345678',
  '123456789',
  '1234567890',
  'qwerty',
  'qwertyuiop',
  'qwerty123',
  'iloveyou',
  'admin',
  'welcome',
  'welcome1',
  'letmein',
  'abc12345',
  'monkey',
  'dragon',
  'sunshine',
  'princess',
  'football',
  'baseball',
  'opentv',
  'opentv123',
  'tvtime',
  'tvtime123',
]);

/** How long a verification link or a reset code stays usable. */
export const VERIFY_TTL_MS = 24 * 60 * 60 * 1000;
export const RESET_TTL_MS = 60 * 60 * 1000;

/** How often "send it again" may actually send. */
export const RESEND_COOLDOWN_MS = 60 * 1000;

/**
 * Guesses allowed against one confirmation code before it is dead.
 *
 * Five is generous for somebody copying six digits off another screen, and
 * nowhere near enough to search a million of them. The code is scoped to one
 * address, so this is the whole search space an attacker gets.
 */
export const MAX_CODE_TRIES = 5;

/** Failed sign-ins before that ONE account is paused, and for how long. */
export const LOGIN_FAIL_LIMIT = 8;
export const LOGIN_LOCK_MS = 15 * 60 * 1000;

/**
 * The only hosts a profile cover may point at.
 *
 * THIS ALLOW-LIST IS THE ENTIRE MODERATION STORY FOR COVERS, and it is why they
 * are a URL rather than an upload. The picker offers the backdrops of shows and
 * films already in the user's library, straight from the two catalogues this app
 * already reads — so a cover is a picture of Iron Man that a million other
 * people can also see, not a photograph of anybody.
 *
 * Take the allow-list away and the column becomes an arbitrary-image field: one
 * user could point another user's app at anything on the internet, and the app
 * would render it full width behind their name. That is the same problem
 * `comment_images` has, without any of the machinery built to contain it.
 *
 * Exact host match, https only. No suffix matching — `notthetvdb.com` ends with
 * neither of these but `evil-artworks.thetvdb.com.attacker.net` would pass a
 * naive `endsWith`.
 */
export const COVER_HOSTS: readonly string[] = ['artworks.thetvdb.com', 'image.tmdb.org'];

/**
 * A cover URL, or null if it may not be stored.
 *
 * Null is also the legitimate "remove my cover" value, so the caller
 * distinguishes the two by whether the input was null to begin with.
 */
export function validCoverUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (s.length === 0 || s.length > 500) return null;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:') return null;
  return COVER_HOSTS.includes(u.hostname) ? s : null;
}

/**
 * The file extension for a content type, for the R2 object key.
 *
 * The extension is COSMETIC — R2 stores the real type in `httpMetadata` and
 * that is what a future signed URL will serve — but an object key you can read
 * is worth having when the only view of a bucket is a listing. The default is
 * `bin` rather than `jpg`, so a type that slipped past the allow-list is
 * visible as an oddity instead of masquerading as a photograph.
 */
export function imageExtension(contentType: string): string {
  switch (contentType) {
    case 'image/jpeg':
      return 'jpg';
    case 'image/png':
      return 'png';
    case 'image/webp':
      return 'webp';
    case 'image/gif':
      return 'gif';
    default:
      return 'bin';
  }
}

/**
 * `t=source:key[:season:episode]`, repeated, capped at 100. Any malformed
 * member poisons the whole call and returns null — a silently dropped target
 * would show a film with no votes rather than an error, which is worse.
 *
 * THE PARSING RULE, and it is not obvious.
 *
 * A `title:` key is `slug|year`, so it always contains a literal `|` and may
 * end in digits (`title:1917|2019`). It can never contain a `:` — `slug()`
 * replaces every non-alphanumeric with `-`, and the year is digits. So:
 *
 *   1. split on the FIRST `:` — everything before it is the source;
 *   2. season/episode are taken from the LAST two `:`-separated segments of the
 *      remainder, and only when there are at least two `:` in the remainder AND
 *      both trailing segments are pure digits;
 *   3. otherwise the whole remainder is the key.
 *
 * `title:1917|2019` therefore keeps its year: the remainder holds no `:` at
 * all, so rule 2 never fires. `tvdb:121361:1:3` splits into key 121361,
 * season 1, episode 3. Season and episode are normalised to -1 here, matching
 * `rating_aggregates`' primary key, which cannot hold NULLs.
 */
export function parseTargets(raw: readonly string[]): ParsedTarget[] | null {
  if (raw.length === 0 || raw.length > MAX_TARGETS) return null;

  const out: ParsedTarget[] = [];
  for (const t of raw) {
    const firstColon = t.indexOf(':');
    if (firstColon <= 0) return null;
    const source = t.slice(0, firstColon);
    if (!isTargetSource(source)) return null;

    let rest = t.slice(firstColon + 1);
    let season = -1;
    let episode = -1;

    const parts = rest.split(':');
    if (parts.length >= 3) {
      const ep = parts[parts.length - 1]!;
      const se = parts[parts.length - 2]!;
      if (/^\d+$/.test(ep) && /^\d+$/.test(se)) {
        season = Number(se);
        episode = Number(ep);
        rest = parts.slice(0, -2).join(':');
      } else {
        return null; // a `:` in the remainder that is not a season/episode pair
      }
    } else if (parts.length === 2) {
      return null; // half a pair: unparseable, and guessing would be worse
    }

    if (rest.length === 0) return null;
    out.push({ source, key: rest, season, episode });
  }
  return out;
}

// ── comments ─────────────────────────────────────────────────────────────────

/** 1–2,000 characters after trim. Emoji-only is a legitimate comment. */
export const COMMENT_BODY_MAX = 2000;

/** The thread page. 25 by default, never more than 50 (docs/IMPLEMENTATION.md Step 3). */
export const COMMENT_PAGE_DEFAULT = 25;
export const COMMENT_PAGE_MAX = 50;

/** Per-user write limits, enforced in D1 where the data already lives. */
export const COMMENTS_PER_HOUR = 30;
export const REPORTS_PER_DAY = 20;

/** One call's worth of seeding. The app chunks; the server refuses more. */
export const IMPORT_MAX_ITEMS = 200;

/**
 * The same rule for votes, which are far smaller than comments: no body, no
 * language, four small columns. 500 of them is a smaller payload than 200
 * comments and halves the round trips on an archive with thousands of ratings.
 */
export const VOTE_IMPORT_MAX_ITEMS = 500;

export type BodyFailure = 'empty' | 'too_long';

/**
 * Counted in code points, not UTF-16 units: an emoji-only body is allowed, and
 * a limit that counted surrogate halves would make "2,000 characters" mean
 * something different for Arabic and for emoji than it does for English.
 */
export function validateCommentBody(
  input: unknown,
  opts: { allowEmpty?: boolean } = {},
): { ok: true; body: string } | { ok: false; reason: BodyFailure } {
  if (typeof input !== 'string') return opts.allowEmpty ? { ok: true, body: '' } : { ok: false, reason: 'empty' };
  const body = input.trim();
  if (body.length === 0 && !opts.allowEmpty) return { ok: false, reason: 'empty' };
  if ([...body].length > COMMENT_BODY_MAX) return { ok: false, reason: 'too_long' };
  return { ok: true, body };
}

/**
 * A comment with a PICTURE and no words is a real comment.
 *
 * Two of the four comments in the reference TV Time export are exactly that:
 * `text` is empty and the whole post is a photograph. Refusing an empty body
 * everywhere — the obvious rule, and the right one for something typed into a
 * box — silently discarded precisely the rows whose images the rescue exists
 * to save, because an image is attached to a comment and those comments were
 * never imported.
 *
 * So emptiness is allowed on the IMPORT path only, and only when the caller
 * says an image is coming. Composing a new comment still requires words or a
 * picture chosen in the same act; nothing here lets a blank post be typed.
 */
export function importedCommentBodyOk(input: unknown, hasImage: boolean) {
  return validateCommentBody(input, { allowEmpty: hasImage });
}

/**
 * A TV Time comment id as the app sends it: `e:<number>` from the legacy
 * `episode_comment.csv`, `c:<uuid>` from `comments-prod-comments.csv`. The
 * prefix keeps the two id spaces from ever naming each other's rows. Anything
 * else is dropped to null — a bad link costs the thread shape, never the comment.
 */
export function tvtimeCommentId(v: unknown): string | null {
  return typeof v === 'string' && /^(?:e:\d{1,20}|c:[0-9A-Za-z-]{1,64})$/.test(v) ? v : null;
}

/**
 * Replies are one level deep (docs/PLAN.md §3 — "deeper threading is a
 * moderation problem wearing a feature costume"). A reply to a reply is
 * refused, never silently re-parented: the client that sent it is wrong and
 * needs to hear so.
 *
 * Takes the parent row as loaded (or null when the id resolved to nothing).
 */
export function replyDepthOk(parent: { parent_id: string | null } | null | undefined): boolean {
  return !!parent && parent.parent_id === null;
}

// ── cursors ──────────────────────────────────────────────────────────────────
//
// `base64url(created_at + '|' + id)`. The id is in there because an imported
// seeding batch writes hundreds of rows in the same second, and `created_at`
// alone would then skip or repeat rows across a page boundary. The pair is a
// total order; `created_at` alone is not.

export type Cursor = { createdAt: string; id: string };

function toBase64Url(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(s: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/.test(s)) return null;
  try {
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
    const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

export function makeCursor(createdAt: string, id: string): string {
  return toBase64Url(`${createdAt}|${id}`);
}

/**
 * null for anything that is not a cursor this server made. NEVER throws: a
 * cursor arrives in a URL, and a URL is edited by hand, by proxies and by
 * link previewers. A malformed one is a first page, not a 500.
 */
export function parseCursor(raw: string | null | undefined): Cursor | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  const decoded = fromBase64Url(raw);
  if (decoded === null) return null;
  const bar = decoded.indexOf('|');
  if (bar <= 0) return null;
  const createdAt = decoded.slice(0, bar);
  const id = decoded.slice(bar + 1);
  if (createdAt.length === 0 || id.length === 0) return null;
  return { createdAt, id };
}

/** The page size a `limit` param asks for, clamped. Anything unparseable is the default. */
export function pageSize(raw: string | null | undefined): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return COMMENT_PAGE_DEFAULT;
  return Math.min(n, COMMENT_PAGE_MAX);
}

// ── seeding ──────────────────────────────────────────────────────────────────

/**
 * DEDUPE BY CONSTRUCTION, NOT BY QUERY.
 *
 * The id of an imported comment is derived from its content, so re-importing
 * the same GDPR export is a no-op no matter how many times it runs — with no
 * read-before-write and no unique index to add. `INSERT OR IGNORE` does the
 * rest. This mirrors the app's own merge-safe import rule.
 *
 *   'imp_' + hex(SHA-256(author ‖ ' ' ‖ source ‖ ' ' ‖ key ‖ ' ' ‖ season
 *                        ‖ ' ' ‖ episode ‖ ' ' ‖ created_at ‖ ' ' ‖ body))[0..32]
 *
 * A null season or episode renders as the empty string. Async because WebCrypto
 * is; it hashes and nothing else, so this file stays free of bindings.
 */
export async function stableImportId(input: {
  authorId: string;
  targetSource: string;
  targetKey: string;
  season: number | null;
  episode: number | null;
  createdAt: string;
  body: string;
}): Promise<string> {
  return `imp_${await hash32([
    input.authorId,
    input.targetSource,
    input.targetKey,
    input.season ?? '',
    input.episode ?? '',
    input.createdAt,
    input.body,
  ])}`;
}

/** The first 32 hex characters of SHA-256 over space-joined parts. */
async function hash32(parts: readonly (string | number)[]): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(parts.join(' ')));
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return hex.slice(0, 32);
}

/**
 * The id of an imported RATING — and note what is missing from the material:
 * the score, the emotion and `created_at`.
 *
 * A person holds exactly one vote per title, so the identity of a rating IS its
 * (author, target) address and nothing else. Hashing the score too would make
 * "I re-imported after changing 7 to 9" produce a second row that the unique
 * index would then have to refuse anyway, and the id would stop describing what
 * it identifies.
 *
 * Unlike a comment, the derived id is therefore not the only guard: the row may
 * already exist under a random `r_…` id from a live vote, which
 * `idx_one_vote_per_person` catches. The derived id is what makes the *insert*
 * idempotent; the index is what makes the *person* idempotent.
 */
export async function stableRatingId(input: {
  authorId: string;
  targetSource: string;
  targetKey: string;
  season: number | null;
  episode: number | null;
}): Promise<string> {
  return `imr_${await hash32([
    input.authorId,
    input.targetSource,
    input.targetKey,
    input.season ?? '',
    input.episode ?? '',
  ])}`;
}

/**
 * The id of an imported CHARACTER VOTE. The character is not in the material,
 * for the same reason the score is not in `stableRatingId`: one person, one
 * favourite, per show — changing your mind must update a row, never add one.
 */
export async function stableCharacterVoteId(input: {
  voterId: string;
  targetSource: string;
  targetKey: string;
  /**
   * THE EPISODE IS PART OF THE IDENTITY, and leaving it out is what collapsed
   * an archive. Every episode of one show hashed to the same id, so the second
   * and every later favourite hit the same row and were skipped — reported
   * honestly as `skipped`, and still thrown away. Measured on a real archive:
   * five shows with more than one, eight of seventeen votes lost.
   *
   * Null is folded to -1 rather than to the empty string, exactly as the
   * uniqueness index does, so an unnumbered episode has one identity here and
   * one there.
   */
  season?: number | null;
  episode?: number | null;
}): Promise<string> {
  return `imc_${await hash32([
    input.voterId,
    input.targetSource,
    input.targetKey,
    String(input.season ?? -1),
    String(input.episode ?? -1),
  ])}`;
}

// ── character votes ──────────────────────────────────────────────────────────

/** Long enough for "Daenerys Targaryen, Mother of Dragons"; short enough not to be a payload. */
export const CHARACTER_NAME_MAX = 100;

export type CharacterNameFailure = 'empty' | 'too_long' | 'unsafe';

/**
 * A character name is FREE TEXT — unlike an emotion, there is no allow-list to
 * check it against — and it is interpolated into a JSON path as
 * `'$."' || ? || '"'` so that "Dr. House" lands under one key instead of being
 * read as a nested path. That quoting is what makes the dot safe; it is also
 * what a `"` or a backslash in the name would break out of.
 *
 * So the name is bound as a parameter (no SQL injection is possible) AND
 * refused if it could close the quote (no JSON-path injection is possible).
 * Control characters go too: they would survive a round trip through
 * `json_group_object` in the nightly recount as different bytes and make a
 * clean row look permanently drifted.
 *
 * A rejected name is a skipped item, never a failed batch.
 */
export function validateCharacterName(
  input: unknown,
): { ok: true; name: string } | { ok: false; reason: CharacterNameFailure } {
  if (typeof input !== 'string') return { ok: false, reason: 'empty' };
  const name = input.trim();
  if (name.length === 0) return { ok: false, reason: 'empty' };
  if ([...name].length > CHARACTER_NAME_MAX) return { ok: false, reason: 'too_long' };
  for (const ch of name) {
    const code = ch.codePointAt(0)!;
    if (ch === '"' || ch === '\\' || code < 0x20 || code === 0x7f) {
      return { ok: false, reason: 'unsafe' };
    }
  }
  return { ok: true, name };
}

/** The rollup blob, shaped for a client: biggest first, ties by name so a redraw is stable. */
export function shapeCharacterCounts(raw: string | null): { character: string; votes: number }[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
  return Object.entries(parsed as Record<string, unknown>)
    .filter(([, v]) => typeof v === 'number' && Number.isFinite(v) && v > 0)
    .map(([character, v]) => ({ character, votes: Math.floor(v as number) }))
    .sort((a, b) => b.votes - a.votes || a.character.localeCompare(b.character));
}

// ── user search ──────────────────────────────────────────────────────────────

/** One screenful. A handle search is a jump-to, not a directory to browse. */
export const USER_SEARCH_LIMIT = 20;

/**
 * The `LIKE` argument for a handle prefix search, or null when there is nothing
 * to search for.
 *
 * TWO THINGS THAT LOOK LIKE DETAILS AND ARE NOT.
 *
 *  1. The pattern is anchored — `q%`, never `%q%`. An unanchored LIKE cannot use
 *     the `handle_lower` index and degrades to a full scan of the profiles
 *     table, which is a 10ms CPU budget spent on one request.
 *  2. `_` is a LIKE WILDCARD and a legal handle character — every placeholder
 *     handle this server mints starts `user_`. Unescaped, a search for `user_`
 *     matches `usera`, `userb` and everything else. So `\`, `%` and `_` are
 *     escaped and the caller must emit `ESCAPE '\'`.
 */
export function handlePrefixPattern(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const q = normaliseHandle(raw);
  if (q.length === 0) return null;
  return `${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

// ── language ─────────────────────────────────────────────────────────────────

/**
 * Loose on purpose. `lang` is a hint for filtering a thread, not a
 * localisation decision, and a strict registry check would reject valid tags
 * the day IANA adds one. It exists to keep junk — and anything with a quote in
 * it — out of the column.
 *
 * Never guessed from the text: language detection does not fit in a Worker's
 * 10 ms CPU budget, and a wrong stamp is worse than none.
 */
export function isValidBcp47(v: unknown): v is string {
  return typeof v === 'string' && /^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*$/.test(v);
}

/**
 * The first tag of an `Accept-Language` header, quality values and whitespace
 * removed, or null. `*` is not a language.
 */
export function firstAcceptLanguage(header: string | null | undefined): string | null {
  if (typeof header !== 'string') return null;
  for (const part of header.split(',')) {
    const tag = part.split(';')[0]!.trim();
    if (isValidBcp47(tag)) return tag;
  }
  return null;
}

// ── moderation ───────────────────────────────────────────────────────────────

/**
 * Five distinct reporters hide a comment pending human review. A constant, not
 * a literal in SQL, so it can be tuned without hunting through statements.
 *
 * This is the mechanism that makes Apple's 24-hour response requirement
 * survivable for a solo moderator: the bad comment is invisible within minutes,
 * and `reports.first_seen_at` still starts the clock when a human opens the
 * queue.
 */
export const AUTO_HIDE_REPORTS = 5;

export const REPORT_REASONS = [
  'spam',
  'harassment',
  'hate',
  'sexual',
  'violence',
  'spoiler',
  'other',
] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];

export function isReportReason(v: unknown): v is ReportReason {
  return typeof v === 'string' && (REPORT_REASONS as readonly string[]).includes(v);
}

/** Only a comment can be auto-hidden; profiles and lists are recorded for a human. */
export const REPORT_TARGET_TYPES = ['comment', 'profile', 'list'] as const;
export type ReportTargetType = (typeof REPORT_TARGET_TYPES)[number];

export function isReportTargetType(v: unknown): v is ReportTargetType {
  return typeof v === 'string' && (REPORT_TARGET_TYPES as readonly string[]).includes(v);
}

/** Whether `n` reports in the table plus this one is enough to hide. */
export function autoHides(existingReports: number): boolean {
  return existingReports + 1 >= AUTO_HIDE_REPORTS;
}

// ── notifications ────────────────────────────────────────────────────────────

/**
 * Never notify yourself. Every write path checks this first
 * (docs/IMPLEMENTATION.md Step 4, "Notification write paths"). Imported
 * comments never notify anybody at all, which is the caller's business.
 */
export function shouldNotify(actorId: string, recipientId: string): boolean {
  return actorId.length > 0 && recipientId.length > 0 && actorId !== recipientId;
}

/**
 * The inbox is marked read by WATERMARK, not by a list of ids: the badge then
 * clears in one request regardless of how many rows are behind it
 * (docs/IMPLEMENTATION.md Step 4).
 *
 * This mirrors the `created_at <= ?` in that statement, boundary included — a
 * notification stamped exactly at the watermark IS covered. Exclusive would
 * leave the newest row unread every single time, because that is precisely the
 * timestamp a client sends back.
 */
export function coveredByWatermark(createdAt: string, upTo: string): boolean {
  return createdAt <= upTo;
}

// ── follow, profiles, reconnection (Step 4) ─────────────────────────────────

/** Followers and following. Bigger than a thread page: a name list is cheap to render. */
export const FOLLOW_PAGE = 50;

/**
 * `plus_until > now` — a BOOLEAN, never the date. The date is an entitlement
 * detail and belongs to RevenueCat (docs/IMPLEMENTATION.md Step 4); handing it
 * to every reader of a public profile publishes a stranger's billing cycle.
 *
 * Compared as ISO strings, which sort correctly as long as both are UTC — and
 * every timestamp this server writes is `toISOString()`.
 */
export function isPlus(plusUntil: string | null | undefined, nowIso: string): boolean {
  return typeof plusUntil === 'string' && plusUntil.length > 0 && plusUntil > nowIso;
}

/**
 * THE ONE ANSWER to "is this person Plus", used by every shaper.
 *
 * Two sources, deliberately. `is_plus` is the flag the RevenueCat webhook
 * writes and is how every real subscriber gets here. `plus_until` is the hand
 * grant — a date poked into the row to settle a refund, a gift or a support
 * case — and it keeps working because a server that can only be told things by
 * a third party has no way to fix that third party being wrong.
 *
 * Neither is ever writable by a client: `PATCH /v1/me` refuses the whole body
 * if it mentions either.
 */
export function plusOn(
  row: { is_plus?: number | null; plus_until?: string | null },
  nowIso: string,
): boolean {
  return row.is_plus === 1 || isPlus(row.plus_until, nowIso);
}

/** Length-independent, so a wrong answer costs the same as a right one. */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export type ProfileCounts = {
  followers: number;
  following: number;
  comments: number;
  lists: number;
};

// ── per-section hiding ───────────────────────────────────────────────────────

/**
 * The sections an owner may hide, and nothing else.
 *
 * A CLOSED SET, checked at the PATCH. The keys are rendering instructions to
 * every visitor's app and to the reads below; an unrecognised one would be a
 * preference stored for ever that nothing enforces, which is the exact failure
 * "the server must omit the data" exists to prevent.
 *
 * `activity` is RESERVED and enforced nowhere, because there is nothing to
 * enforce it on: this server holds no per-day watch counts and publishing a
 * heatmap is a separate decision nobody has made. It is in the set so the app
 * can offer the switch without a migration the day that decision is taken.
 */
export const HIDEABLE_SECTIONS = [
  'stats',
  'activity',
  'lists',
  // RESERVED like `activity` (2.0.3): "Everything I watch" is an own-profile
  // block that never publishes, so nothing here enforces it. Listed so the
  // app's switch survives the PATCH and the /v1/me echo; without it the 400
  // above refuses the hide and the echo would drop it.
  'everything',
  'favourite_shows',
  'favourite_movies',
  'shows',
  'movies',
  'comments',
  // NOT A SECTION OF THE PROFILE but a switch on the same screen (2.0.0, D6):
  // "Show my reactions to followers". Listed means the owner's ratings,
  // feelings, comments and favourite characters never reach anybody's feed
  // (routes/feed.ts). Absent — the default — means they do. The column is
  // opaque JSON, so a new key needs no migration.
  'feed',
] as const;

export type HideableSection = (typeof HIDEABLE_SECTIONS)[number];

/** The stored column as the array it represents. Anything unparseable reads as "nothing hidden". */
export function parseHiddenSections(raw: string | null | undefined): HideableSection[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((k): k is HideableSection =>
      (HIDEABLE_SECTIONS as readonly string[]).includes(k as string),
    );
  } catch {
    return [];
  }
}

/** Is this section hidden, given the raw column? The one test every filtered read makes. */
export function sectionHidden(raw: string | null | undefined, key: HideableSection): boolean {
  return parseHiddenSections(raw).includes(key);
}

/**
 * What `PATCH /v1/me` may store, or a refusal.
 *
 * An unknown key is a 400 rather than a silent drop: a client that sends
 * `"watchlist"` and gets a 200 believes it is hidden, and the section it meant
 * stays visible for ever with nobody looking for the bug.
 *
 * An empty array normalises to NULL — "nothing hidden" has one representation
 * in the column, so a read never has to tell `[]` from absent.
 */
export function validateHiddenSections(
  v: unknown,
): { ok: true; value: string | null } | { ok: false } {
  if (v === null) return { ok: true, value: null };
  if (!Array.isArray(v)) return { ok: false };
  for (const k of v) {
    if (typeof k !== 'string' || !(HIDEABLE_SECTIONS as readonly string[]).includes(k)) {
      return { ok: false };
    }
  }
  const unique = [...new Set(v as HideableSection[])];
  return { ok: true, value: unique.length === 0 ? null : JSON.stringify(unique) };
}

/** Everything a profile read gathers, before the privacy rule is applied. */
export type FullProfileView = {
  id: string;
  handle: string;
  display_name: string | null;
  avatar_key: string | null;
  cover_url: string | null;
  theme_color?: string | null;
  theme_layout?: string | null;
  cover_frame?: string | null;
  /** The owner's arrangement, as the opaque JSON string it is stored as. Null
   *  when never arranged, or when their Plus has lapsed. */
  widgets?: string | null;
  bio: string | null;
  is_private: boolean;
  links: unknown;
  is_plus: boolean;
  counts: ProfileCounts;
  followed_by_me: boolean;
  /**
   * A follow this viewer has ASKED for and not yet been given. Part of the
   * shell, alongside `followed_by_me`: the button on a private profile has
   * three states, and without this one it falls back to "Follow" after every
   * app restart and the request looks like it was never sent.
   */
  follow_requested_by_me?: boolean;
  /**
   * Which sections the owner has hidden — returned to strangers as well as to
   * the owner, because an unexplained gap reads as a broken screen while a
   * known absence reads as a choice.
   */
  hidden_sections?: HideableSection[];
  created_at: string;
};

/** What a given viewer is allowed to see of it. `null` where a field is withheld. */
export type VisibleProfile = Omit<FullProfileView, 'bio' | 'links' | 'counts'> & {
  bio: string | null;
  links: unknown;
  counts: ProfileCounts | null;
};

/**
 * The `is_private` matrix, in one place because it is the rule most easily got
 * subtly wrong in three handlers.
 *
 * A private profile still returns its SHELL — handle, display name, avatar and
 * `is_private: true`. It has to: you cannot ask to follow someone you cannot
 * find. What it withholds is counts, bio and links, and it withholds them from
 * everyone who is neither the owner nor an accepted follower.
 *
 * The withheld fields come back as explicit `null` rather than as missing keys,
 * so the client renders one shape and the plan's `jq .counts` reads `null`.
 */
export function visibleProfileFields(
  profile: FullProfileView,
  viewerFollows: boolean,
  isSelf: boolean,
): VisibleProfile {
  if (!profile.is_private || isSelf || viewerFollows) return { ...profile };
  return {
    ...profile,
    bio: null,
    links: null,
    counts: null,
  };
}

/** One reconcile call's worth of friend ids. The app loops; the server refuses more. */
export const RECONCILE_MAX_IDS = 500;

export type FriendIdsFailure = 'not_an_array' | 'too_many' | 'not_an_integer';

/**
 * TV Time ids are positive integers and nothing else. A float, a numeric
 * string or a negative is a client bug, and answering it with a 400 is how the
 * client's author finds out — silently coercing would send junk into an `IN`
 * over a partial index and return nothing, forever, for no visible reason.
 */
export function validateFriendIds(
  v: unknown,
): { ok: true; ids: number[] } | { ok: false; reason: FriendIdsFailure } {
  if (!Array.isArray(v)) return { ok: false, reason: 'not_an_array' };
  if (v.length > RECONCILE_MAX_IDS) return { ok: false, reason: 'too_many' };
  const ids: number[] = [];
  for (const raw of v) {
    if (typeof raw !== 'number' || !Number.isInteger(raw) || raw <= 0) {
      return { ok: false, reason: 'not_an_integer' };
    }
    ids.push(raw);
  }
  // Duplicates in an export are real; deduping here keeps the `IN` list honest.
  return { ok: true, ids: [...new Set(ids)] };
}

/** Fixed-size slices. The app chunks `friend_ids` at 500; this is the same rule, server-side. */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (size <= 0) return [items.slice()];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// ── D1's bound-parameter ceiling ─────────────────────────────────────────────

/**
 * **A D1 query may bind at most 100 parameters.**
 * https://developers.cloudflare.com/d1/platform/limits/
 *
 * It is a limit on ONE statement, not on a `db.batch()`, which is why the
 * import routes — fifty small statements a batch, a handful of binds each —
 * have never come near it. The routes that can are the ones that build a
 * variable-length placeholder list out of user input, and there are exactly two
 * of them.
 *
 * This is not a tuning knob. It is a number Cloudflare owns; the derived
 * per-query caps below are what this codebase is allowed to choose.
 */
export const D1_MAX_BOUND_PARAMS = 100;

/**
 * `GET /v1/aggregates?t=…` binds FOUR columns per target — target_source,
 * target_key, season, episode — into a row-value `IN (VALUES …)`.
 *
 * 25 targets is 100 parameters and passes. 26 is 104 and is a 500. `MAX_TARGETS`
 * is 100, so the route advertised four times what a single statement could
 * serve and the client's 100-target prefetch could never once have worked.
 *
 * The public cap stays at 100 — the app batches at exactly that, and quartering
 * it would quadruple its request count (docs/PLAN.md §4). The handler chunks
 * INTERNALLY to this size instead and runs the groups in one `db.batch()`.
 *
 * Derived rather than written as `25` so that adding a column to the target key
 * moves this number with it, instead of leaving a literal that is quietly wrong
 * by one query.
 */
export const AGGREGATE_PARAMS_PER_TARGET = 4;
export const AGGREGATE_TARGETS_PER_QUERY = Math.floor(
  D1_MAX_BOUND_PARAMS / AGGREGATE_PARAMS_PER_TARGET,
);

/**
 * The same arithmetic for `POST /v1/me/friends/reconcile`, which had the same
 * latent bug at a different threshold: one placeholder per friend id in an `IN`,
 * plus three fixed binds for the self-exclusion and the two halves of the block
 * check. `RECONCILE_MAX_IDS` is 500, so it broke at 98 ids — and an export with
 * a hundred friends in it is an ordinary export, not an edge case.
 */
export const RECONCILE_FIXED_BINDS = 3;
export const RECONCILE_IDS_PER_QUERY = D1_MAX_BOUND_PARAMS - RECONCILE_FIXED_BINDS;

// ── maintenance ──────────────────────────────────────────────────────────────

/**
 * Merge two `rating_aggregates.emotion_counts` blobs, JSON string in, JSON
 * string out. The 5c merge case (docs/IMPLEMENTATION.md Step 5c): when a
 * `title` thread's aggregate row moves onto a `tvdb` key that already has one,
 * the counts are summed rather than one side overwriting the other.
 *
 * Anything that is not a positive-integer count is dropped rather than trusted:
 * the write path leaves zeroed keys behind (`json_set(..., MAX(0, n - 1))`), and
 * a merge is the natural place to stop carrying them. Malformed JSON — which
 * only a hand-edited row could produce — is treated as empty, because failing a
 * whole overnight migration over one bad blob would be the worse outcome.
 */
export function mergeEmotionCounts(a: string | null, b: string | null): string {
  const out: Record<string, number> = {};
  for (const raw of [a, b]) {
    if (!raw) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) continue;
      out[key] = (out[key] ?? 0) + Math.floor(value);
    }
  }
  return JSON.stringify(out);
}

/**
 * A published list's id: derived from its owner and its name, never random.
 *
 * Publishing REPLACES the owner's lists, so a random id would hand a reader a
 * new URL every sync — a shared link, or a profile someone had open, would go
 * to a list that no longer exists while the same list sat beside it under a new
 * name. Derived means "the avengers list" is the same row forever.
 *
 * FNV-1a over `owner|lowercased name`: short, stable across platforms, and with
 * no crypto to reach for inside a Worker on the write path.
 */
export function listId(ownerId: string, name: string): string {
  const input = `${ownerId}|${name.trim().toLowerCase()}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  // A second pass over the reversed string: one 32-bit hash across a few
  // thousand lists per owner is more collision than this deserves.
  let g = 0x811c9dc5;
  for (let i = input.length - 1; i >= 0; i--) {
    g ^= input.charCodeAt(i);
    g = Math.imul(g, 0x01000193) >>> 0;
  }
  return `l_${h.toString(36)}${g.toString(36)}`;
}

/**
 * The languages a comment may be translated INTO.
 *
 * Exactly the languages the app ships (nine since 2.0.0: de, tr, pl added), and deliberately not "whatever the model
 * supports". A translation is stored for ever under this key, so an open list
 * would let one client fill the table with languages no reader has.
 */
export const TRANSLATE_TARGETS = ['en', 'ar', 'fr', 'it', 'es', 'pt', 'de', 'tr', 'pl'] as const;
export type TranslateTarget = (typeof TRANSLATE_TARGETS)[number];

export function isTranslateTarget(v: unknown): v is TranslateTarget {
  return typeof v === 'string' && (TRANSLATE_TARGETS as readonly string[]).includes(v);
}

/**
 * A guess at what language a comment is already in, from its script alone.
 *
 * WHY GUESS AT ALL. `m2m100` takes an optional `source_lang` that defaults to
 * English, and an Arabic comment translated "from English" comes back mangled.
 * A wrong guess costs quality; no guess costs it too, for every non-English
 * comment in the archive.
 *
 * SCRIPT, NOT LANGUAGE, and the limit is honest: this separates Arabic from
 * French, and cannot separate French from Spanish. That is the split that
 * matters — the latin languages all degrade gracefully because the model reads
 * them anyway, while the wrong SCRIPT is what produces nonsense.
 *
 * Ratio rather than first-match: one Arabic name quoted inside an English
 * sentence must not make the sentence Arabic.
 */
/**
 * What language a comment is ACTUALLY in, from the two things we know about it.
 *
 * THE STORED `lang` IS NOT EVIDENCE ABOUT THE TEXT. It is `currentLocale()` on
 * the phone that wrote the comment -- the writer's INTERFACE language. People
 * type in their own language with the app in English constantly, and Arabic
 * speakers do it more than anyone: a comment reading "Spider-Man: Brand New Day
 * 🔥 فيلم ممتع جدًا" is stored `lang: 'en'` and was answered `same: true`,
 * so the Translate button did nothing at all for the comments that needed it
 * most.
 *
 * So each source is used where it is reliable:
 *
 *   - a NON-LATIN script is decisive. Arabic letters are Arabic, whatever the
 *     writer's menus were in, and no stored value may override that.
 *   - otherwise the detector cannot help -- it reads script, not language, and
 *     answers 'en' for every latin one alike -- so the stored `lang` is the
 *     only thing that separates French from Spanish, and it is used.
 *
 * The result is that a wrong `lang` can still mislabel French as Spanish, which
 * costs a little quality, while it can no longer claim Arabic is English, which
 * cost the feature entirely.
 */
export function sourceLangOf(storedLang: string | null | undefined, body: string): string {
  const detected = detectSourceLang(body);
  if (detected !== 'en') return detected;
  return storedLang?.slice(0, 2) || 'en';
}

export function detectSourceLang(text: string): string {
  const letters = text.replace(/[\s\d\p{P}\p{S}]/gu, '');
  if (letters.length === 0) return 'en';
  const share = (re: RegExp) => (letters.match(re) ?? []).length / letters.length;
  if (share(/\p{Script=Arabic}/gu) > 0.3) return 'ar';
  if (share(/\p{Script=Hebrew}/gu) > 0.3) return 'he';
  if (share(/\p{Script=Cyrillic}/gu) > 0.3) return 'ru';
  if (share(/\p{Script=Hangul}/gu) > 0.3) return 'ko';
  if (share(/\p{Script=Hiragana}|\p{Script=Katakana}/gu) > 0.3) return 'ja';
  if (share(/\p{Script=Han}/gu) > 0.3) return 'zh';
  return 'en';
}

/**
 * Whether a URL is safe to hand to the app, which opens it with no further
 * questions.
 *
 * HTTPS ONLY. `Linking.openURL` will open whatever it is given -- a
 * `javascript:` URL, a custom scheme belonging to another app, an `intent://`
 * on Android. These rows are ours and should never contain one, but a table is
 * a thing that can be edited by hand at three in the morning, and this is the
 * last place that can still say no.
 *
 * Rejected rather than repaired: a link that has to be rewritten to be safe is
 * a link nobody checked, and silently turning it into something else would ship
 * a destination the author never wrote.
 *
 * Whitespace anywhere is a refusal, not something to strip. It is how a scheme
 * is smuggled past a naive prefix check, and a URL with a space in it was
 * mistyped in any case.
 */
export function isSafeLinkUrl(url: unknown): boolean {
  if (typeof url !== 'string') return false;
  if (url.length === 0 || url.length > 300) return false;
  if (/\s/.test(url)) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001F\u007F]/.test(url)) return false;
  return /^https:\/\/[^/]+\./i.test(url);
}

// ── banner frame ────────────────────────────────────────────────────────────

/**
 * How the banner is drawn: "x,y,zoom,size[,bg[,fade[,strength]]]". fade 1 = the
 * banner melts into the page across its edge; strength (0–1) is how much of the
 * banner's dark veil and theme tint lies over the picture (0 = the picture as
 * it is); the 8th field is that overlay's colour, "rrggbb" or "0" (automatic). x and y are the focal point
 * (0–1), zoom 1–3. size is the banner's height as a fraction of its width, set
 * by dragging its edge (Plus): 0 = the normal height, else 0.3–2 (the old
 * "tall" flag, 1, reads as a square banner). bg 1 = the picture fills the whole
 * profile behind everything (Plus). Every visitor's app draws from it, so a
 * malformed value is refused, and it is normalised on the way in.
 */
export function validateCoverFrame(v: unknown): { ok: true; value: string | null } | { ok: false } {
  if (v === null) return { ok: true, value: null };
  if (typeof v !== 'string' || v.length > 48) return { ok: false };
  const parts = v.split(',');
  if (parts.length < 4 || parts.length > 8) return { ok: false };
  // The overlay's colour: "rrggbb", or "0" for the automatic veil and tint.
  const tint = parts.length > 7 ? parts[7]!.toLowerCase() : '0';
  if (tint !== '0' && !/^[0-9a-f]{6}$/.test(tint)) return { ok: false };
  const [x, y, zoom, size, bg = 0, fade = 0, strength = 1] = parts.slice(0, 7).map(Number) as [number, number, number, number, number?, number?, number?];
  if (![x, y, zoom, size].every(Number.isFinite) || x < 0 || x > 1 || y < 0 || y > 1 || zoom < 1 || zoom > 3) return { ok: false };
  if (size !== 0 && (size < 0.3 || size > 2)) return { ok: false };
  if ((bg !== 0 && bg !== 1) || (fade !== 0 && fade !== 1)) return { ok: false };
  if (!Number.isFinite(strength) || strength < 0 || strength > 1) return { ok: false };
  return {
    ok: true,
    value: `${x.toFixed(3)},${y.toFixed(3)},${zoom.toFixed(2)},${size === 0 ? 0 : size.toFixed(3)},${bg},${fade},${strength.toFixed(2)},${tint}`,
  };
}

/** The frame a visitor is sent: size and background are Plus, so both drop once Plus lapses. */
export function publicCoverFrame(frame: string | null, plus: boolean): string | null {
  if (!frame || plus) return frame;
  const [x, y, zoom, , , fade = '0', strength = '1.00', tint = '0'] = frame.split(',');
  // The fade and the overlay are looks, not Plus shapes: they stay.
  return `${x},${y},${zoom},0,0,${fade},${strength},${tint}`;
}

// ── profile templates from the server ───────────────────────────────────────

/**
 * What a dashboard-made template may say about itself (0053). The lists are
 * the app's: a layout `profile-template.tsx` can draw, a persona
 * `profile-templates.ts` can name in six languages, and a block the arranger
 * knows. The phone checks all three again before showing a template, so a
 * mistake here costs a template on every phone rather than a crash — which is
 * exactly why the dashboard is told at save time instead of finding out never.
 */
export const TEMPLATE_LAYOUTS = ['classic', 'cards', 'poster'] as const;

export const TEMPLATE_PERSONAS = [
  'binger', 'filmBuff', 'explorer', 'nostalgic', 'completionist', 'critic',
  'curator', 'devotee', 'feeler', 'newcomer', 'spooky', 'festive',
] as const;

/**
 * The blocks a template may place, and the sizes each allows — the app's
 * WIDGETS table (`mobile/src/profile-layout.ts`) minus the private ones
 * (prime time, first ever, watchlist) and the ones that need content of their
 * own (artwork, GIF, links): a template cannot supply a picture or a link, so
 * placing one would put an empty block on the page.
 */
export const TEMPLATE_BLOCKS: Readonly<Record<string, readonly string[]>> = {
  banners: ['2x1'],
  intro: ['2x1'],
  counts: ['2x1'],
  stats: ['2x2'],
  activity: ['1x1', '2x1', '2x2'],
  timeline: ['2x1'],
  lists: ['2x2'],
  extra: ['2x1'],
  since: ['1x1'],
  character: ['1x1', '2x1'],
  streak: ['1x1'],
  genre: ['1x1', '2x1'],
  thisYear: ['1x1'],
  binge: ['1x1', '2x1'],
  finished: ['1x1'],
  rated: ['1x1', '2x1'],
  emotions: ['1x1', '2x1'],
  emotionCalendar: ['2x1', '2x2'],
  topRated: ['2x1', '2x2'],
  nowWatching: ['2x1', '2x2'],
  'shelf:shows': ['2x2'],
  'shelf:fav-shows': ['2x2'],
  'shelf:movies': ['2x2'],
  'shelf:fav-movies': ['2x2'],
};

export const isHexColour = (v: unknown): v is string => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v);

/** A block as the app stores it: `id`, `id:span`, or a pair of squares. */
export type TemplateBlock = string | [string, string];

/**
 * The dashboard's blocks box, one block a line, into the app's block list.
 * `a + b` is a pair of squares side by side; `id:2x1` is a block at another
 * size. The first line is `banners` because the identity row is the one block
 * a profile cannot be without (LOCKED in profile-layout.ts). Refuses with the
 * line that is wrong, so a typo is fixed on the dashboard rather than silently
 * dropping the template on every phone.
 */
export function parseTemplateBlocks(text: unknown): { ok: true; blocks: TemplateBlock[] } | { ok: false; reason: string } {
  if (typeof text !== 'string') return { ok: false, reason: 'blocks must be text' };
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return { ok: false, reason: 'no blocks' };
  if (lines.length > 40) return { ok: false, reason: 'at most 40 lines' };
  // `id:span` only when what follows the colon IS a size — a shelf's own id
  // (`shelf:shows`) has a colon in it too. Same split the phone makes.
  const one = (ref: string): { ok: true; id: string; span: string } | { ok: false; reason: string } => {
    const m = /^(.*):(1x1|2x1|2x2)$/.exec(ref);
    const id = m ? m[1]! : ref;
    const spans = TEMPLATE_BLOCKS[id];
    if (!spans) return { ok: false, reason: `unknown block "${ref}"` };
    const span = m?.[2] ?? spans[0]!;
    if (!spans.includes(span)) return { ok: false, reason: `"${id}" cannot be ${span}` };
    return { ok: true, id, span };
  };
  const blocks: TemplateBlock[] = [];
  for (const line of lines) {
    const parts = line.split('+').map((p) => p.trim());
    if (parts.length > 2 || parts.some((p) => !p)) return { ok: false, reason: `"${line}" is not a block or a pair` };
    const parsed = parts.map(one);
    for (const p of parsed) if (!p.ok) return p;
    if (parts.length === 2) {
      // A pair is two squares on one row; anything wider breaks the row.
      if (parsed.some((p) => p.ok && p.span !== '1x1')) return { ok: false, reason: `"${line}": a pair is two small blocks` };
      blocks.push([parts[0]!, parts[1]!]);
    } else {
      blocks.push(parts[0]!);
    }
  }
  if (blocks[0] !== 'banners') return { ok: false, reason: 'the first line must be banners' };
  return { ok: true, blocks };
}

/**
 * A device id is a path segment and is treated like one. It names an R2 key in
 * `routes/backup.ts` and a URL segment in `DELETE /v1/me/devices/:device`, so
 * it is pattern-checked before it goes near either: a client that could put
 * `../` in it could write outside the prefix.
 */
const DEVICE_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const readDevice = (raw: string | undefined): string | null =>
  raw && DEVICE_RE.test(raw) ? raw : null;

/**
 * What a phone may say about itself when it syncs — see 0054. A name is kept
 * to tell two iPhones apart on the list, and nothing else is read from it:
 * control characters are dropped, the rest is cut to a label's length.
 */
export const DEVICE_NAME_MAX = 64;
export function readDeviceName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const name = raw.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, DEVICE_NAME_MAX);
  return name || null;
}

/** 'ios' or 'android' today; a short lowercase word so a future platform fits. */
export function readPlatform(raw: unknown): string | null {
  return typeof raw === 'string' && /^[a-z]{1,16}$/.test(raw) ? raw : null;
}

// ── the seasonal calendar ────────────────────────────────────────────────────

/**
 * WHEN EACH SEASON RUNS, for the dashboard's "Automatic" mode. Inclusive UTC
 * dates. Ramadan moves with the moon, so it is a list of years rather than a
 * rule — approximate to a day, and it wins over Valentine's where they meet.
 * Awards season is never automatic: the ceremony date moves, so it stays a
 * hand-picked event.
 */
const ANNUAL: { event: string; from: string; to: string }[] = [
  { event: 'halloween', from: '10-01', to: '10-31' },
  { event: 'muertos', from: '11-01', to: '11-02' },
  { event: 'christmas', from: '12-01', to: '12-26' },
  { event: 'newyear', from: '12-27', to: '12-31' },
  { event: 'newyear', from: '01-01', to: '01-02' },
  { event: 'valentine', from: '02-07', to: '02-14' },
];
const RAMADAN: { from: string; to: string }[] = [
  { from: '2027-02-08', to: '2027-03-10' },
  { from: '2028-01-28', to: '2028-02-27' },
  { from: '2029-01-16', to: '2029-02-15' },
  { from: '2030-01-05', to: '2030-02-05' },
];

/** The season the calendar puts on `day` (YYYY-MM-DD, UTC), or null. */
export function scheduledEvent(day: string): string | null {
  for (const r of RAMADAN) if (day >= r.from && day <= r.to) return 'ramadan';
  const md = day.slice(5);
  for (const a of ANNUAL) if (md >= a.from && md <= a.to) return a.event;
  return null;
}

/**
 * What the app is told, from what the dashboard stored. Nothing stored is OFF,
 * as it always was — so a self-hosted server never grows decorations it was
 * not asked for. 'auto' follows the calendar; anything else is a hand-picked
 * event that stays until somebody changes it.
 */
export function resolveEvent(stored: string | null | undefined, day: string): string | null {
  if (!stored) return null;
  if (stored === 'auto') return scheduledEvent(day);
  return stored;
}

/** The next day the calendar changes what it shows, within a year, or null. */
export function nextScheduledChange(day: string): { day: string; event: string | null } | null {
  const now = scheduledEvent(day);
  let t = Date.parse(`${day}T00:00:00Z`);
  for (let i = 0; i < 366; i++) {
    t += 864e5;
    const d = new Date(t).toISOString().slice(0, 10);
    const e = scheduledEvent(d);
    if (e !== now) return { day: d, event: e };
  }
  return null;
}
