import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

// Calling a helper you forgot to import.
//
// These modules are served raw to the browser: no bundler, no linter, so a
// missing import is a ReferenceError at the moment that line runs — which for
// `cueProgress` inside the clip renderer meant a minute of rendering before it
// said "cueProgress is not defined". The unit tests could not see it, because
// the pure module it lives in was fine.
//
// This is a narrow check for exactly that: a module CALLING a function another
// tik module exports, without importing it and without defining its own.

const DIR = new URL('../../public/scripts/tik/', import.meta.url);
const files = readdirSync(DIR).filter((f) => f.endsWith('.js'));

// Comments are prose, and this codebase's prose is thick with the names of the
// functions it is describing — "photo count (the square arrangements)" reads as
// a call to count() otherwise.
const stripComments = (code) => code
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, '$1');

const src = new Map(files.map((f) => [f, stripComments(readFileSync(new URL(f, DIR), 'utf8'))]));

// name -> the module that exports it
const exportedBy = new Map();
for (const [file, code] of src) {
  for (const m of code.matchAll(/^export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm)) {
    exportedBy.set(m[1], file);
  }
}

const importedNames = (code) => {
  const names = new Set();
  for (const m of code.matchAll(/import\s+\{([^}]+)\}\s+from/g)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop().trim();
      if (name) names.add(name);
    }
  }
  return names;
};

const declaresOwn = (code, name) => new RegExp(
  `(?:^|\\n)\\s*(?:export\\s+)?(?:async\\s+)?(?:function|const|let|var|class)\\s+${name}\\b`,
).test(code);

test('no tik module calls another one’s export without importing it', () => {
  assert.ok(exportedBy.size > 20, `expected plenty of exported helpers, found ${exportedBy.size}`);
  const problems = [];
  for (const [file, code] of src) {
    const imported = importedNames(code);
    for (const [name, home] of exportedBy) {
      if (home === file || imported.has(name) || declaresOwn(code, name)) continue;
      // A call, not a mention: `name(` and not `.name(`.
      const called = new RegExp(`(?<![.\\w$])${name}\\s*\\(`).test(code);
      if (called) problems.push(`${file} calls ${name}() from ${home} without importing it`);
    }
  }
  assert.deepEqual(problems, []);
});
