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
  await withStubbedFetch(async ({ callModel, budgetFor }, sent) => {
    // Claude gets the request plus thinking headroom; the others get it as-is.
    await callModel('p', 'claude-opus-4-8', undefined, 4096);
    assert.equal(sent[0].body.max_tokens, budgetFor('claude-opus-4-8', 4096));
    await callModel('p', 'gpt-4.1-nano', undefined, 4096);
    assert.equal(sent[1].body.max_completion_tokens, 4096);
    await callModel('p', 'gemini-2.5-flash', undefined, 4096);
    assert.equal(sent[2].body.generationConfig.maxOutputTokens, 4096);
  });
});

test('callModel falls back to the default budget, never to an unbounded or junk one', async () => {
  await withStubbedFetch(async ({ callModel, DEFAULT_MAX_TOKENS, budgetFor }, sent) => {
    await callModel('p', 'claude-opus-4-8');                    // omitted
    await callModel('p', 'claude-opus-4-8', undefined, 'lots'); // junk
    await callModel('p', 'claude-opus-4-8', undefined, 0);      // falsy
    await callModel('p', 'claude-opus-4-8', undefined, 10);     // below the floor
    const dflt = budgetFor('claude-opus-4-8', DEFAULT_MAX_TOKENS);
    assert.equal(sent[0].body.max_tokens, dflt);
    assert.equal(sent[1].body.max_tokens, dflt);
    assert.equal(sent[2].body.max_tokens, dflt);
    assert.equal(sent[3].body.max_tokens, budgetFor('claude-opus-4-8', 10), 'floors at 256, then adds headroom');
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

// ---- multi-image vision calls ----

test('callModelWithImages sends every frame in order, then the prompt', async () => {
  await withStubbedFetch(async ({ callModelWithImages }, sent) => {
    await callModelWithImages('which one?', [
      { base64: 'AAA', mediaType: 'image/jpeg' },
      { base64: 'BBB', mediaType: 'image/png' },
      { base64: 'CCC' },
    ], 'claude-sonnet-5');
    const content = sent[0].body.messages[0].content;
    assert.equal(content.length, 4, 'three images plus the prompt');
    assert.deepEqual(content.map((b) => b.type), ['image', 'image', 'image', 'text']);
    // Order is load-bearing: the prompt refers to "Frame 3".
    assert.deepEqual(content.slice(0, 3).map((b) => b.source.data), ['AAA', 'BBB', 'CCC']);
    assert.equal(content[1].source.media_type, 'image/png');
    assert.equal(content[2].source.media_type, 'image/jpeg', 'defaults to jpeg');
    assert.equal(content[3].text, 'which one?');
  });
});

test('callModelWithImages drops empty frames and refuses an empty sheet', async () => {
  await withStubbedFetch(async ({ callModelWithImages }, sent) => {
    await callModelWithImages('p', [{ base64: '' }, { base64: 'AAA' }, null], 'claude-sonnet-5');
    assert.equal(sent[0].body.messages[0].content.filter((b) => b.type === 'image').length, 1);
    await assert.rejects(
      () => callModelWithImages('p', [{ base64: '' }, null], 'claude-sonnet-5'),
      /No image data/,
    );
  });
});

test('callModelWithImage still works and routes through the multi path', async () => {
  await withStubbedFetch(async ({ callModelWithImage }, sent) => {
    await callModelWithImage('p', { base64: 'AAA', mediaType: 'image/jpeg' }, 'claude-sonnet-5');
    const content = sent[0].body.messages[0].content;
    assert.deepEqual(content.map((b) => b.type), ['image', 'text']);
  });
});

test('a vision call on a non-Claude model is refused, not silently downgraded', async () => {
  await withStubbedFetch(async ({ callModelWithImages }) => {
    await assert.rejects(
      () => callModelWithImages('p', [{ base64: 'AAA' }], 'gemini-2.5-flash'),
      /requires a Claude model/,
    );
  });
});

// ---- thinking shares max_tokens with the answer ----

test('a small explicit budget still leaves a thinking model room to answer', async () => {
  // The regression this guards: batch mode's queue asked for 1536 tokens, which
  // was ample before thinking existed. Once thinking shared that ceiling the
  // model spent it all reasoning and returned no text block at all, which
  // surfaced as "The AI returned no usable picks".
  await withStubbedFetch(async ({ callModel, DEFAULT_MAX_TOKENS }, sent) => {
    await callModel('p', 'claude-sonnet-5', undefined, 1536);
    assert.ok(sent[0].body.max_tokens > 1536, `still ${sent[0].body.max_tokens}`);
    assert.ok(sent[0].body.max_tokens >= 4096, 'not enough room for adaptive thinking');
    assert.deepEqual(sent[0].body.thinking, { type: 'adaptive' });
  });
});

test('headroom is added only where thinking is actually on', async () => {
  await withStubbedFetch(async ({ callModel, budgetFor }, sent) => {
    // Haiku rejects thinking, so its budget must pass through untouched.
    await callModel('p', 'claude-haiku-4-5', undefined, 1536);
    assert.equal(sent[0].body.max_tokens, 1536);
    // Non-Claude providers likewise.
    await callModel('p', 'gpt-4.1-nano', undefined, 1536);
    assert.equal(sent[1].body.max_completion_tokens, 1536);
    assert.equal(budgetFor('claude-haiku-4-5', 1536), 1536);
    assert.ok(budgetFor('claude-opus-5', 1536) > 1536);
  });
});

test('every explicit budget in the codebase survives the headroom rule', async () => {
  await withStubbedFetch(async ({ budgetFor }) => {
    // The four call sites that pass a number, smallest first.
    for (const n of [1024, 1536, 2048, 16384]) {
      assert.ok(budgetFor('claude-sonnet-5', n) >= n + 4096, `${n} got too little headroom`);
      assert.ok(budgetFor('claude-opus-5', n) >= n + 4096);
    }
  });
});

test('the vision path gets the same headroom as the text path', async () => {
  await withStubbedFetch(async ({ callModelWithImages, budgetFor }, sent) => {
    await callModelWithImages('p', [{ base64: 'AAA' }], 'claude-sonnet-5', undefined, 2048);
    assert.equal(sent[0].body.max_tokens, budgetFor('claude-sonnet-5', 2048));
    assert.ok(sent[0].body.max_tokens > 2048);
  });
});

test('a reply truncated before any text throws instead of returning empty', async () => {
  // Returning '' is how this travelled to the UI disguised as "nothing usable".
  const realFetch = globalThis.fetch;
  const env = { ...process.env };
  process.env.ANTHROPIC_API_KEY = 'test';
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ stop_reason: 'max_tokens', content: [{ type: 'thinking', thinking: '' }] }),
  });
  try {
    const mod = await import(`../../netlify/functions/lib/ai-providers.mjs?trunc=${Math.random()}`);
    await assert.rejects(
      () => mod.callModel('p', 'claude-sonnet-5'),
      /max_tokens before writing an answer/,
    );
  } finally {
    globalThis.fetch = realFetch;
    process.env = env;
  }
});
