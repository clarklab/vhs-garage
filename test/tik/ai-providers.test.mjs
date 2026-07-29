import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseModelJson, providerFor } from '../../netlify/functions/lib/ai-providers.mjs';

test('parseModelJson parses clean JSON', () => {
  assert.deepEqual(parseModelJson('{"a":1}'), { a: 1 });
});

test('parseModelJson strips markdown fences', () => {
  assert.deepEqual(parseModelJson('```json\n{"a":1}\n```'), { a: 1 });
});

test('parseModelJson recovers the object from surrounding prose', () => {
  assert.deepEqual(parseModelJson('Sure! Here you go:\n{"a":1}\nHope that helps.'), { a: 1 });
});

test('parseModelJson returns null on junk', () => {
  assert.equal(parseModelJson('no json here'), null);
  assert.equal(parseModelJson(''), null);
  assert.equal(parseModelJson(null), null);
});

test('providerFor routes by model prefix', () => {
  assert.equal(providerFor('claude-opus-4-8'), 'anthropic');
  assert.equal(providerFor('gpt-4.1-nano'), 'openai');
  assert.equal(providerFor('gemini-2.5-flash'), 'gemini');
  assert.equal(providerFor('something-else'), 'gemini'); // default
});

// ---- output budget ----
// The module reads its keys into consts at import time, so load a fresh copy
// with the env in place (the query string defeats the ESM module cache).
async function withStubbedFetch(run) {
  const realFetch = globalThis.fetch;
  const env = { ...process.env };
  Object.assign(process.env, {
    ANTHROPIC_API_KEY: 'test', OPENAI_API_KEY: 'test',
    GEMINI_API_KEY: 'test', GOOGLE_GEMINI_BASE_URL: 'https://gemini.test',
  });
  const sent = [];
  globalThis.fetch = async (url, opts) => {
    sent.push({ url: String(url), body: JSON.parse(opts.body) });
    return {
      ok: true,
      json: async () => ({
        content: [{ type: 'text', text: '{}' }],                       // anthropic
        choices: [{ message: { content: '{}' } }],                     // openai
        candidates: [{ content: { parts: [{ text: '{}' }] } }],        // gemini
      }),
    };
  };
  try {
    const mod = await import(`../../netlify/functions/lib/ai-providers.mjs?budget=${Math.random()}`);
    await run(mod, sent);
  } finally {
    globalThis.fetch = realFetch;
    process.env = env;
  }
}

test('callModel sends the requested output budget to every provider', async () => {
  await withStubbedFetch(async ({ callModel }, sent) => {
    await callModel('p', 'claude-opus-4-8', undefined, 4096);
    assert.equal(sent[0].body.max_tokens, 4096);
    await callModel('p', 'gpt-4.1-nano', undefined, 4096);
    assert.equal(sent[1].body.max_completion_tokens, 4096);
    await callModel('p', 'gemini-2.5-flash', undefined, 4096);
    assert.equal(sent[2].body.generationConfig.maxOutputTokens, 4096);
  });
});

test('callModel falls back to the default budget, never to an unbounded or junk one', async () => {
  await withStubbedFetch(async ({ callModel, DEFAULT_MAX_TOKENS }, sent) => {
    await callModel('p', 'claude-opus-4-8');                    // omitted
    await callModel('p', 'claude-opus-4-8', undefined, 'lots'); // junk
    await callModel('p', 'claude-opus-4-8', undefined, 0);      // falsy
    await callModel('p', 'claude-opus-4-8', undefined, 10);     // below the floor
    assert.equal(sent[0].body.max_tokens, DEFAULT_MAX_TOKENS);
    assert.equal(sent[1].body.max_tokens, DEFAULT_MAX_TOKENS);
    assert.equal(sent[2].body.max_tokens, DEFAULT_MAX_TOKENS);
    assert.equal(sent[3].body.max_tokens, 256);
    // The previously hardcoded value stays the default, so trivia and Some Guys
    // keep the exact budget they were tuned against.
    assert.equal(DEFAULT_MAX_TOKENS, 2048);
  });
});
