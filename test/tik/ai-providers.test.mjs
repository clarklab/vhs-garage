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
async function withStubbedFetch(run, envOverrides = {}) {
  const realFetch = globalThis.fetch;
  const env = { ...process.env };
  delete process.env.TIK_AI_EFFORT; // don't inherit a developer's own setting
  Object.assign(process.env, {
    ANTHROPIC_API_KEY: 'test', OPENAI_API_KEY: 'test',
    GEMINI_API_KEY: 'test', GOOGLE_GEMINI_BASE_URL: 'https://gemini.test',
    ...envOverrides,
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
    // The default has to leave room for thinking: on Claude 5 max_tokens caps
    // thinking plus the answer, and a budget sized for the answer alone
    // truncates the JSON.
    assert.ok(DEFAULT_MAX_TOKENS >= 8192, `default budget is only ${DEFAULT_MAX_TOKENS}`);
  });
});

// ---- thinking + effort, and the models that reject them ----

test('a thinking-capable model gets adaptive thinking and an effort level', async () => {
  await withStubbedFetch(async ({ callModel }, sent) => {
    await callModel('p', 'claude-opus-5');
    assert.deepEqual(sent[0].body.thinking, { type: 'adaptive' });
    assert.equal(sent[0].body.output_config.effort, 'high');
    // The knobs Claude 5 rejects outright must never be sent.
    assert.equal(sent[0].body.temperature, undefined);
    assert.equal(sent[0].body.top_p, undefined);
    assert.equal(sent[0].body.thinking.budget_tokens, undefined);
  });
});

test('Haiku 4.5 gets neither — it 400s on both', async () => {
  // The sync fallback path still runs on Haiku, so sending the tuning block
  // unconditionally would break every fast-path request.
  await withStubbedFetch(async ({ callModel }, sent) => {
    await callModel('p', 'claude-haiku-4-5');
    assert.equal(sent[0].body.thinking, undefined);
    assert.equal(sent[0].body.output_config, undefined);
    assert.equal(sent[0].body.max_tokens > 0, true);
  });
});

test('supportsThinking knows the 4.6-and-later line from the rest', async () => {
  await withStubbedFetch(async ({ supportsThinking }) => {
    for (const m of ['claude-opus-5', 'claude-opus-4-8', 'claude-opus-4-6', 'claude-sonnet-5', 'claude-sonnet-4-6']) {
      assert.equal(supportsThinking(m), true, m);
    }
    for (const m of ['claude-haiku-4-5', 'claude-sonnet-4-5', 'gpt-4.1-nano', 'gemini-2.5-flash', '', null]) {
      assert.equal(supportsThinking(m), false, String(m));
    }
  });
});

test('the effort level is env-tunable and falls back on junk', async () => {
  await withStubbedFetch(async ({ aiEffort }) => {
    assert.equal(aiEffort(), 'high');
  });
  await withStubbedFetch(async ({ aiEffort }) => {
    assert.equal(aiEffort(), 'xhigh');
  }, { TIK_AI_EFFORT: 'xhigh' });
  await withStubbedFetch(async ({ aiEffort }) => {
    assert.equal(aiEffort(), 'high');
  }, { TIK_AI_EFFORT: 'ludicrous' });
});
