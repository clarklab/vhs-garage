import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wantsQuoteStamp } from '../../public/scripts/tik/compose.js';
import { fontScaleForQuote } from '../../public/scripts/tik/caption.js';
import { defaultPostFields } from '../../public/scripts/tik/project.js';

test('wantsQuoteStamp only on quotes title slides', () => {
  assert.equal(wantsQuoteStamp({ format: 'quotes', kind: 'title' }), true);
  assert.equal(wantsQuoteStamp({ format: 'quotes', kind: null }), false);
  assert.equal(wantsQuoteStamp({ format: 'quotes', kind: 'outro' }), false);
  assert.equal(wantsQuoteStamp({ format: 'trivia', kind: 'title' }), false);
  assert.equal(wantsQuoteStamp({}), false);
});

test('quotes title is not a trivia title', () => {
  assert.doesNotMatch(defaultPostFields('quotes', 'Jaws').title, /trivia/i);
});
