import { describe, expect, it } from 'vitest';
import { call, freshDatabase, insertProfile, makeEnv, tokenFor } from './harness';
import { detectSourceLang, isTranslateTarget } from '@/pure';
import type { Env } from '@/env';

/**
 * The decisions in translation that can be quietly wrong: what happens when the
 * binding is absent, whether a hidden comment can be read through it, and
 * whether the cache is actually consulted before the model is billed.
 */

/** A stand-in for Workers AI that counts how often it was actually called. */
function fakeAi(): Ai & { calls: number } {
  const ai = {
    calls: 0,
    run: async (_model: string, input: { text: string; target_lang: string; source_lang?: string }) => {
      ai.calls++;
      return { translated_text: `[${input.target_lang}] ${input.text}` };
    },
  };
  return ai as unknown as Ai & { calls: number };
}

function seed(): { env: Env; raw: ReturnType<typeof freshDatabase>['raw']; ai: Ai & { calls: number } } {
  const { raw, db } = freshDatabase();
  const ai = fakeAi();
  const env = { ...makeEnv(db), AI: ai } as Env;
  insertProfile(raw, 'p_reader', 'reader');
  insertProfile(raw, 'p_author', 'author');
  raw
    .prepare(
      `INSERT INTO comments (id, author_id, target_source, target_key, body, created_at)
       VALUES (?, ?, 'title', 'dark', ?, ?)`,
    )
    .run('c_one', 'p_author', 'مرحبا بالعالم', new Date().toISOString());
  raw
    .prepare(
      `INSERT INTO comments (id, author_id, target_source, target_key, body, created_at, hidden_at)
       VALUES (?, ?, 'title', 'dark', ?, ?, ?)`,
    )
    .run('c_hidden', 'p_author', 'taken down', new Date().toISOString(), new Date().toISOString());
  return { env, raw, ai };
}

describe('detectSourceLang', () => {
  it('reads the script, not the first character', () => {
    expect(detectSourceLang('مرحبا بالعالم')).toBe('ar');
    expect(detectSourceLang('This is English')).toBe('en');
  });

  it('does not let one quoted name change the language of a sentence', () => {
    expect(detectSourceLang('I watched مسلسل last night and loved every minute of it')).toBe('en');
  });

  it('falls back to English rather than guessing at nothing', () => {
    expect(detectSourceLang('')).toBe('en');
    expect(detectSourceLang('!!! 123 ???')).toBe('en');
  });
});

describe('isTranslateTarget', () => {
  it('accepts only the languages the app ships', () => {
    expect(isTranslateTarget('ar')).toBe(true);
    expect(isTranslateTarget('nl')).toBe(false);
    expect(isTranslateTarget(7)).toBe(false);
  });
});

describe('POST /v1/comments/:id/translate', () => {
  it('translates, and says which language it came from', async () => {
    const { env, ai } = seed();
    const token = await tokenFor(env, 'p_reader');
    const res = await call(env, 'POST', '/v1/comments/c_one/translate', { token, body: { lang: 'en' } });
    expect(res.status).toBe(200);
    expect(res.json.source_lang).toBe('ar');
    expect(res.json.text).toContain('[en]');
    expect(ai.calls).toBe(1);
  });

  it('bills the model once however many readers ask', async () => {
    const { env, ai } = seed();
    const token = await tokenFor(env, 'p_reader');
    await call(env, 'POST', '/v1/comments/c_one/translate', { token, body: { lang: 'en' } });
    const again = await call(env, 'POST', '/v1/comments/c_one/translate', { token, body: { lang: 'en' } });
    expect(again.json.cached).toBe(true);
    expect(ai.calls).toBe(1);
  });

  it('does not spend a call translating something into its own language', async () => {
    const { env, ai } = seed();
    const token = await tokenFor(env, 'p_reader');
    const res = await call(env, 'POST', '/v1/comments/c_one/translate', { token, body: { lang: 'ar' } });
    expect(res.json.same).toBe(true);
    expect(ai.calls).toBe(0);
  });

  it('refuses to become a second way to read a moderated comment', async () => {
    const { env, ai } = seed();
    const token = await tokenFor(env, 'p_reader');
    const res = await call(env, 'POST', '/v1/comments/c_hidden/translate', { token, body: { lang: 'ar' } });
    expect(res.status).toBe(404);
    expect(ai.calls).toBe(0);
  });

  it('refuses a language the app does not ship', async () => {
    const { env } = seed();
    const token = await tokenFor(env, 'p_reader');
    const res = await call(env, 'POST', '/v1/comments/c_one/translate', { token, body: { lang: 'nl' } });
    expect(res.status).toBe(400);
  });

  it('is off, not broken, on a deployment with no AI binding', async () => {
    const { raw, db } = freshDatabase();
    insertProfile(raw, 'p_reader', 'reader');
    const env = makeEnv(db);
    const token = await tokenFor(env, 'p_reader');
    const res = await call(env, 'POST', '/v1/comments/c_one/translate', { token, body: { lang: 'en' } });
    expect(res.status).toBe(404);
    expect(res.json.error.code).toBe('unavailable');
  });

  it('needs a session', async () => {
    const { env } = seed();
    const res = await call(env, 'POST', '/v1/comments/c_one/translate', { body: { lang: 'en' } });
    expect(res.status).toBe(401);
  });
});

describe('POST /v1/commsuni/translate', () => {
  const ask = async (env: Env, body: Record<string, unknown>) =>
    call(env, 'POST', '/v1/commsuni/translate', { token: await tokenFor(env, 'p_reader'), body });

  it('translates the text it is sent, and answers a repeat from the cache', async () => {
    const { env, ai } = seed();
    const first = await ask(env, { text: 'مرحبا', language: 'ar', lang: 'en' });
    expect(first.status).toBe(200);
    expect(first.json.text).toBe('[en] مرحبا');
    expect((await ask(env, { text: 'مرحبا', language: 'ar', lang: 'en' })).json.text).toBe('[en] مرحبا');
    expect(ai.calls).toBe(1);
  });

  it('spends nothing on text already in the reader’s language', async () => {
    const { env, ai } = seed();
    const res = await ask(env, { text: 'This is English', language: 'en', lang: 'en' });
    expect(res.json.same).toBe(true);
    expect(ai.calls).toBe(0);
  });

  it('refuses a missing text or a language the app does not ship', async () => {
    const { env } = seed();
    expect((await ask(env, { text: '', lang: 'en' })).status).toBe(400);
    expect((await ask(env, { text: 'hi', lang: 'xx' })).status).toBe(400);
  });
});
