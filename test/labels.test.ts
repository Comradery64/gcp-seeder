import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseDuration,
  labelDate,
  buildSeedLabels,
  isSeederLabeled,
  isExpired,
  ageInDays,
} from '../src/labels.js';

test('parseDuration handles h/d/w and rejects garbage', () => {
  assert.equal(parseDuration('12h'), 12 * 3_600_000);
  assert.equal(parseDuration('30d'), 30 * 86_400_000);
  assert.equal(parseDuration('2w'), 2 * 604_800_000);
  assert.equal(parseDuration(' 7D '), 7 * 86_400_000); // trims + case-insensitive
  assert.throws(() => parseDuration('30'), /Invalid duration/);
  assert.throws(() => parseDuration('5y'), /Invalid duration/);
  assert.throws(() => parseDuration('abc'), /Invalid duration/);
});

test('labelDate produces a label-safe YYYY-MM-DD', () => {
  assert.equal(labelDate(new Date('2026-07-10T13:45:00Z')), '2026-07-10');
  assert.match(labelDate(new Date('2026-01-01T00:00:00Z')), /^[a-z0-9-]+$/);
});

test('buildSeedLabels stamps ownership + date, and expiry only with a ttl', () => {
  const now = new Date('2026-07-10T00:00:00Z');
  const base = buildSeedLabels({ now });
  assert.equal(base['seeded-by'], 'gcp-seeder');
  assert.equal(base['seeded-at'], '2026-07-10');
  assert.equal(base.expires, undefined);

  const withTtl = buildSeedLabels({ ttl: '30d', now });
  assert.equal(withTtl.expires, '2026-08-09'); // 30 days after 2026-07-10
});

test('isSeederLabeled recognizes our label only', () => {
  assert.equal(isSeederLabeled({ 'seeded-by': 'gcp-seeder' }), true);
  assert.equal(isSeederLabeled({ 'seeded-by': 'someone-else' }), false);
  assert.equal(isSeederLabeled({}), false);
  assert.equal(isSeederLabeled(undefined), false);
});

test('isExpired compares by day; expires at the end of the expires day', () => {
  const now = new Date('2026-07-10T12:00:00Z');
  assert.equal(isExpired({ expires: '2026-07-09' }, now), true); // yesterday → expired
  assert.equal(isExpired({ expires: '2026-07-10' }, now), false); // today → not yet
  assert.equal(isExpired({ expires: '2026-07-11' }, now), false); // future
  assert.equal(isExpired({}, now), false); // no expiry never expires
});

test('ageInDays derives age from seeded-at', () => {
  const now = new Date('2026-07-10T00:00:00Z');
  assert.equal(ageInDays({ 'seeded-at': '2026-07-10' }, now), 0);
  assert.equal(ageInDays({ 'seeded-at': '2026-06-10' }, now), 30);
  assert.equal(ageInDays({}, now), undefined);
  assert.equal(ageInDays({ 'seeded-at': 'not-a-date' }, now), undefined);
});
