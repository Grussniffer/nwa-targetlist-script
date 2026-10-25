import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../src/core.js', import.meta.url), 'utf8');
const context = vm.createContext({ URL, Intl });
vm.runInContext(`${source}\nglobalThis.Core = TargetListCore;`, context);
const { applyFeed, assess } = context.Core;
const checkedAt = '2026-10-11T12:00:00.000Z';
const target = (id, overrides = {}) => ({ id, name: `Target ${id}`, estimatedStats: 500,
  estimateUpdatedAt: Date.parse(checkedAt) / 1000, status: { state: 'Okay' }, checkedAt,
  faction: { id: 22 }, reason: 'Approved reason', ...overrides });
const sync = (cursor, reset = false) => ({ version: 1, cursor, reset });
const delta = (updates = [], removed = [], cursor = 'next') => ({ sync: sync(cursor), updates, removed });
const ids = rows => Array.from(rows, row => row.id);

test('legacy feeds remain compatible and turn off cursor requests', () => {
  const targets = [target(1)];
  const result = applyFeed({ targets }, [target(2)], 'old');
  assert.equal(result.targets, targets);
  assert.equal(result.cursor, null);
});

test('full reset replaces the complete baseline including an empty authorized pool', () => {
  const targets = [target(3)];
  const reset = applyFeed({ sync: sync('first', true), targets }, [target(1), target(2)], 'old');
  assert.equal(reset.targets, targets);
  assert.equal(reset.cursor, 'first');
  assert.deepEqual(ids(applyFeed({ sync: sync('empty', true), targets: [] }, targets, 'first').targets), []);
});

test('an unchanged heartbeat preserves row and array identity and the real status timestamp', () => {
  const targets = [target(1)];
  const result = applyFeed(delta([], [], 'same'), targets, 'same');
  assert.equal(result.targets, targets);
  assert.equal(result.targets[0].checkedAt, checkedAt);
  const player = { id: 9, faction: { id: 11 }, battleStats: { total: 1000 } };
  const now = Date.parse(checkedAt);
  assert.equal(assess(result.targets[0], player, 0.6, now + 29_999).ready, true);
  assert.equal(assess(result.targets[0], player, 0.6, now + 30_000).ready, false);
});

test('delta adds, removes and replaces full changed rows without changing the baseline', () => {
  const targets = Object.freeze([Object.freeze(target(1)), Object.freeze(target(2)), Object.freeze(target(3))]);
  const update = target(2, { estimatedStats: 600, reason: 'Changed reason',
    status: { state: 'Hospital' }, checkedAt: '2026-10-11T12:00:10.000Z', reserved: true });
  const result = applyFeed(delta([update, target(4)], [1]), targets, 'first');
  assert.deepEqual(ids(result.targets), [2, 3, 4]);
  assert.equal(result.targets[0], update);
  assert.equal(result.targets[1], targets[2]);
  assert.deepEqual(ids(targets), [1, 2, 3]);
  assert.equal(targets[1].reason, 'Approved reason');
  assert.equal(targets[1].reserved, undefined);
});

test('local expiry or a local removal cannot change the retained server baseline', () => {
  const baseline = [target(1), target(2)];
  const visible = baseline.map(row => ({ ...row, checkedAt: null })).filter(row => row.id !== 2);
  const result = applyFeed(delta(), baseline, 'first');
  assert.equal(result.targets, baseline);
  assert.equal(result.targets[0].checkedAt, checkedAt);
  assert.equal(visible[0].checkedAt, null);
  assert.deepEqual(ids(result.targets), [1, 2]);
});

test('invalid updates are rejected atomically rather than producing a partial pool', () => {
  const targets = Object.freeze([Object.freeze(target(1))]);
  const invalid = [
    null, {}, { targets: null }, { targets: [target(1), target(1)] },
    { targets: [target(0)] }, { targets: [target(2147483648)] },
    { sync: { ...sync('next'), version: 2 }, updates: [], removed: [] },
    { sync: { ...sync('next'), reset: 'false' }, updates: [], removed: [] },
    { sync: sync(''), updates: [], removed: [] },
    { sync: sync('x'.repeat(257)), updates: [], removed: [] },
    { sync: sync('next'), targets: [] },
    { sync: sync('next', true), targets: [], updates: [] },
    { sync: sync('next'), updates: [], removed: null },
    delta([target(1), target(1)]), delta([target(1)], [1]), delta([], [1, 1]), delta([], ['1']),
  ];
  for (const data of invalid) {
    assert.throws(() => applyFeed(data, targets, 'first'), { code: 'FEED_SYNC_INVALID' });
    assert.equal(targets[0].reason, 'Approved reason');
  }
});

test('a delta without a matching prior request baseline cannot authorize a pool', () => {
  for (const cursor of [null, '', undefined]) {
    assert.throws(() => applyFeed(delta(), [], cursor), { code: 'FEED_SYNC_INVALID' });
  }
});


test('pending-player snapshots distinguish empty, unchanged, unavailable and older backends', () => {
  const revision = 'a'.repeat(64);
  const first = context.Core.applyPendingSuggestions({ revision, playerIds: [2, 9] });
  assert.deepEqual(Array.from(first.playerIds), [2, 9]); assert.equal(first.status, 'ready');
  assert.equal(context.Core.applyPendingSuggestions({ revision, unchanged: true }, first), first);
  assert.equal(context.Core.applyPendingSuggestions({ revision, playerIds: [] }).status, 'ready');
  assert.equal(context.Core.applyPendingSuggestions({ unavailable: true }).status, 'unavailable');
  assert.equal(context.Core.applyPendingSuggestions(undefined).status, 'unsupported');
  for (const data of [{ revision, unchanged: true }, { revision, playerIds: [9, 2] }, { revision, playerIds: [2, 2] }, { revision, playerIds: [0] }, { revision: 'bad', playerIds: [] }]) {
    assert.throws(() => context.Core.applyPendingSuggestions(data));
  }
});
