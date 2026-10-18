import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aiKey, aiBase } from '../../netlify/functions/lib/gateway-env.mjs';

const GW = { NETLIFY_AI_GATEWAY_KEY: 'gw-key', NETLIFY_AI_GATEWAY_URL: 'https://site.test/.netlify/ai' };

test('the provider-named variable wins when it is there', () => {
  const env = { ...GW, ANTHROPIC_API_KEY: 'own', ANTHROPIC_BASE_URL: 'https://own.test' };
  assert.equal(aiKey('ANTHROPIC_API_KEY', env), 'own');
  assert.equal(aiBase('ANTHROPIC_BASE_URL', 'https://api.anthropic.com', env), 'https://own.test');
});

test('an instance without it falls back to the gateway pair', () => {
  assert.equal(aiKey('ANTHROPIC_API_KEY', GW), 'gw-key');
  assert.equal(aiBase('ANTHROPIC_BASE_URL', 'https://api.anthropic.com', GW), GW.NETLIFY_AI_GATEWAY_URL);
});

test('outside Netlify, with neither, a personal key setup still works', () => {
  assert.equal(aiKey('ANTHROPIC_API_KEY', {}), undefined);
  assert.equal(aiBase('ANTHROPIC_BASE_URL', 'https://api.anthropic.com', {}), 'https://api.anthropic.com');
  assert.equal(aiBase('GOOGLE_GEMINI_BASE_URL', undefined, {}), undefined);
});
