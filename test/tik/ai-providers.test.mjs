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
