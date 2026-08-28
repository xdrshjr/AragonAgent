/**
 * Unit tests for the brand gate's pure half (C1). No network, no npm, no disk:
 * everything here calls `findLegacyBrandHits` directly.
 *
 * T4/T5 are the cases that keep the gate from crying wolf and blocking a
 * legitimate release; T1 is the one that keeps it from flagging the new brand as
 * the old one, which is the foundation the whole rename rests on.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { ALLOWED, findLegacyBrandHits, parseNpmJson } from '../assert-brand-clean.mjs';

test('T1: the new brand never trips its own gate', () => {
  assert.deepEqual(findLegacyBrandHits('import { Agent } from "@aragon-agent/core"'), []);
  assert.deepEqual(findLegacyBrandHits('ARAGON_MODEL / .aragon/skills / .aragon-skill.json'), []);
});

test('T2: a legacy scope reference is reported', () => {
  const hits = findLegacyBrandHits('@argon-agent/core');
  assert.equal(hits.length, 1);
  // The token regex stops at the identifier boundary, so '@' and '-' are not part
  // of it; the excerpt is what carries the full context to the operator.
  assert.equal(hits[0].token, 'argon');
  assert.match(hits[0].excerpt, /@argon-agent\/core/);
});

test('T3: a legacy environment variable is reported with its full identifier', () => {
  const hits = findLegacyBrandHits('ARGON_MODEL=x');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].token, 'ARGON_MODEL');
});

test('T4: prose containing "jargon" is benign', () => {
  // Real counter-example, lifted from the host's kanban templates.
  assert.deepEqual(findLegacyBrandHits('Avoid jargon the customer would not recognise.'), []);
});

test('T5: the argon2 password hash family is benign', () => {
  assert.deepEqual(findLegacyBrandHits('argon2id hash'), []);
  assert.deepEqual(findLegacyBrandHits('argon2'), []);
  assert.deepEqual(findLegacyBrandHits('pip install argon2-cffi'), []);
});

test('T6: matching is case-insensitive', () => {
  assert.equal(findLegacyBrandHits('ArgonAgent').length, 1);
  assert.equal(findLegacyBrandHits('ArgonAgent')[0].token, 'ArgonAgent');
  assert.equal(findLegacyBrandHits('argonAgent').length, 1);
  assert.equal(findLegacyBrandHits('argonAgent')[0].token, 'argonAgent');
});

test('T7: hits carry a 1-based line/column and a contextual excerpt', () => {
  const text = ['first line', 'second line', "const k = 'argon-agent';", 'fourth line'].join('\n');
  const hits = findLegacyBrandHits(text);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].line, 3);
  assert.equal(hits[0].column, 12);
  assert.match(hits[0].excerpt, /const k = 'argon-agent';/);
});

test('T8: the ALLOWED whitelist is exactly these four entries', () => {
  // A fifth entry is a design change: register the reason in
  // docs/plans/aragon-agent-npm-release-cutover/spec.md before touching this.
  assert.deepEqual(ALLOWED, {
    'packages/core': ['CHANGELOG.md'],
    'packages/cli': [
      'CHANGELOG.md',
      'dist/config/migrate-legacy-state.js',
      'dist/config/migrate-legacy-state.d.ts',
    ],
  });
  const total = Object.values(ALLOWED).reduce((sum, entries) => sum + entries.length, 0);
  assert.equal(total, 4);
  // The requirement named README explicitly: it must come out at zero hits, so it
  // may never be allowlisted.
  for (const entries of Object.values(ALLOWED)) {
    assert.equal(entries.includes('README.md'), false);
  }
});

test('T9: npm --json output survives an interleaved notice', () => {
  assert.deepEqual(parseNpmJson('[{"files":[]}]'), [{ files: [] }]);
  assert.deepEqual(parseNpmJson('npm notice using registry\n[{"files":[]}]\n'), [{ files: [] }]);
  assert.equal(parseNpmJson(''), null);
  assert.equal(parseNpmJson('not json at all'), null);
});
