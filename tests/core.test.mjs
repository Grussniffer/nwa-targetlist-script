import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../src/core.js', import.meta.url), 'utf8');
const context = vm.createContext({ URL, Intl });
vm.runInContext(`${source}\nglobalThis.Core = TargetListCore;`, context);
const Core = context.Core;

// Fix the clock so freshness and live-status boundaries are reproducible.
const NOW = Date.parse('2026-10-09T12:00:00Z');

test('service clock corrects browser skew using a conservative response transit bound', () => {
  for (const skew of [-31000, 31000]) {
    let elapsed = 1000;
    const clock = Core.createServiceClock({ wallNow: () => NOW + skew, monotonicNow: () => elapsed });
    assert.equal(clock.now(), NOW + skew, 'legacy responses retain the strict local clock');
    assert.equal(clock.observe(new Date(NOW).toISOString(), 800), true);
    assert.equal(clock.now(), NOW + 800);
    elapsed += 5000;
    assert.equal(clock.now(), NOW + 5800);
  }
});

test('service clock rejects malformed, implausible and unbounded time samples', () => {
  const clock = Core.createServiceClock({ wallNow: () => NOW, monotonicNow: () => 0 });
  for (const value of [null, '', 'invalid', 123, '2026-02-31T00:00:00.000Z', new Date(NOW + 86400001).toISOString()]) {
    assert.equal(clock.observe(value, 0), false);
    assert.equal(clock.now(), NOW);
  }
  for (const duration of [-1, NaN, Infinity, 10001]) assert.equal(clock.observe(new Date(NOW).toISOString(), duration), false);
});

test('older responses cannot rewind service time and local clock jumps do not extend status life', () => {
  let wall = NOW + 31000, elapsed = 0;
  const clock = Core.createServiceClock({ wallNow: () => wall, monotonicNow: () => elapsed });
  clock.observe(new Date(NOW).toISOString(), 0);
  wall -= 3600000; elapsed += 30000;
  assert.equal(clock.now(), NOW + 30000);
  assert.equal(clock.observe(new Date(NOW + 10000).toISOString(), 1000), false);
  assert.equal(clock.now(), NOW + 30000);
  clock.reset();
  assert.equal(clock.now(), wall);
});

test('service time correction never turns a genuinely stale or delayed observation into ready', () => {
  let elapsed = 0;
  const clock = Core.createServiceClock({ wallNow: () => NOW - 31000, monotonicNow: () => elapsed });
  clock.observe(new Date(NOW).toISOString(), 8000);
  assert.equal(Core.assess(target({ checkedAt: new Date(NOW - 22000).toISOString() }), player, 0.6, clock.now()).ready, false);
  assert.equal(Core.assess(target({ checkedAt: new Date(NOW).toISOString() }), player, 0.6, clock.now()).ready, true);
  elapsed += 22000;
  assert.equal(Core.assess(target({ checkedAt: new Date(NOW).toISOString() }), player, 0.6, clock.now()).ready, false);
});
const player = {
  id: 12345,
  name: 'Chain Player',
  faction: { id: 111, name: 'Allowed Faction' },
  battleStats: { total: 1_000_000 },
};
function target(overrides = {}) {
  return {
    id: 98765,
    name: 'Chain Target',
    faction: { id: 222, name: 'Target Faction' },
    estimatedStats: 500_000,
    estimateUpdatedAt: NOW / 1000 - 3600,
    status: { state: 'Okay' },
    checkedAt: new Date(NOW - 1000).toISOString(),
    notes: 'Chain candidate',
    ...overrides,
  };
}

test('estimate provider labels distinguish FFScouter methods from manual and custom estimates', () => {
  for (const estimateSource of ['bss', ' BSS ', 'premium', 'spies', 'FFScouter', 'ffscouter:model']) {
    assert.equal(Core.estimateSourceLabel({ estimateSource }), 'FFScouter');
  }
  for (const estimateSource of ['Manual', 'spy', 'model', 'Custom model', 'TornStats']) {
    assert.equal(Core.estimateSourceLabel({ estimateSource }), estimateSource);
  }
  assert.equal(Core.estimateSourceLabel({ estimateProvider: ' ffscouter ', estimateSource: 'model' }), 'FFScouter');
  assert.equal(Core.estimateSourceLabel({ estimateProvider: 'Manual', estimateSource: 'bss' }), 'Manual');
  assert.equal(Core.estimateSourceLabel({ estimateProvider: 'Custom tool', estimateSource: 'spies' }), 'Custom tool');
  for (const value of [null, undefined, {}, { estimateSource: null }, { estimateSource: 123 }, { estimateSource: ' ' }]) {
    assert.equal(Core.estimateSourceLabel(value), '');
  }
  const source = { estimateProvider: 'FFScouter', estimateSource: 'bss' };
  Core.estimateSourceLabel(source);
  assert.deepEqual(source, { estimateProvider: 'FFScouter', estimateSource: 'bss' });
});

test('recommendations apply the chosen ratio and include its exact boundary', () => {
  const atLimit = Core.assess(target({ estimatedStats: 600_000 }), player, 0.6, NOW);
  assert.equal(atLimit.ratio, 0.6);
  assert.equal(atLimit.suggested, true);
  assert.equal(atLimit.label, 'Possible match');

  const aboveLimit = Core.assess(target({ estimatedStats: 600_001 }), player, 0.6, NOW);
  assert.equal(aboveLimit.suggested, false);
  assert.equal(aboveLimit.label, 'Above your limit');
  assert.equal(Core.assess(target(), player, 0.4, NOW).suggested, false);
  assert.equal(Core.assess(target(), player, undefined, NOW).suggested, true);
});

test('the default minimum excludes weak targets and includes both range boundaries', () => {
  assert.equal(Core.DEFAULT_MIN_RATIO, 0.1);
  assert.equal(Core.DEFAULT_MAX_RATIO, 0.6);
  for (const estimatedStats of [100_000, 600_000]) {
    const assessment = Core.assess(target({ estimatedStats }), player, undefined, NOW);
    assert.equal(assessment.inRange, true);
    assert.equal(assessment.suggested, true);
    assert.equal(assessment.label, 'Possible match');
  }
  const weak = Core.assess(target({ estimatedStats: 99_999 }), player, undefined, NOW);
  assert.equal(weak.inRange, false);
  assert.equal(weak.suggested, false);
  assert.equal(weak.label, 'Below your minimum');
  assert.equal(weak.ready, true, 'Ready describes live availability independently of stat eligibility');
  assert.equal(weak.tone, 'warn');
});

test('a zero minimum disables the lower bound without accepting unknown stats', () => {
  const weak = Core.assess(target({ estimatedStats: 1 }), player, 0.6, NOW, 0);
  assert.equal(weak.inRange, true);
  assert.equal(weak.suggested, true);
  assert.equal(weak.label, 'Possible match');
  for (const estimatedStats of [0, null, undefined]) {
    const assessment = Core.assess(target({ estimatedStats }), player, 0.6, NOW, 0);
    assert.equal(assessment.inRange, false);
    assert.equal(assessment.suggested, false);
  }
});

test('suggested selection applies custom minimum and maximum inclusively', () => {
  const targets = [
    target({ id: 1, estimatedStats: 299_999 }),
    target({ id: 2, estimatedStats: 300_000 }),
    target({ id: 3, estimatedStats: 500_000 }),
    target({ id: 4, estimatedStats: 500_001 }),
    target({ id: 5, estimatedStats: 400_000, estimateUpdatedAt: 1 }),
    target({ id: player.id, estimatedStats: 400_000 }),
  ];
  const options = { mode: 'suggested', minRatio: 0.3, maxRatio: 0.5 };
  assert.deepEqual([...Core.select(targets, player, options, NOW).map(item => item.target.id)], [2, 3]);
  assert.equal(Core.select(targets, player, { ...options, mode: 'all' }, NOW).length, targets.length);
  assert.equal(Core.select(targets, player, { ...options, minRatio: 0.5 }, NOW)[0].target.id, 3);
});

test('invalid or inverted stat bounds fail closed for suggestions', () => {
  const ranges = [
    { minRatio: -0.01, maxRatio: 0.6 },
    { minRatio: 5.01, maxRatio: 5 },
    { minRatio: 0.7, maxRatio: 0.6 },
    { minRatio: 0, maxRatio: 0.009 },
    { minRatio: 0, maxRatio: 5.01 },
    ...[null, '0.1', NaN, Infinity, -Infinity].map(minRatio => ({ minRatio, maxRatio: 0.6 })),
    ...[null, '0.6', NaN, Infinity, -Infinity].map(maxRatio => ({ minRatio: 0.1, maxRatio })),
  ];
  for (const { minRatio, maxRatio } of ranges) {
    const assessment = Core.assess(target(), player, maxRatio, NOW, minRatio);
    assert.equal(assessment.inRange, false, `${String(minRatio)} to ${String(maxRatio)}`);
    assert.equal(assessment.suggested, false);
    assert.equal(assessment.label, 'Invalid stat range');
    assert.equal(assessment.ready, true, 'invalid limits do not change availability');
    assert.equal(Core.select([target()], player, { mode: 'suggested', minRatio, maxRatio }, NOW).length, 0);
  }
  assert.equal(Core.assess(target({ estimatedStats: 10_000 }), player, 0.01, NOW, 0).suggested, true);
  assert.equal(Core.assess(target({ estimatedStats: 5_000_000 }), player, 5, NOW, 5).suggested, true);
});

test('missing, zero, negative, nonnumeric, and nonfinite estimates remain unknown', () => {
  for (const value of [undefined, null, 0, -1, '500000', NaN, Infinity, -Infinity]) {
    const assessment = Core.assess(target({ estimatedStats: value }), player, 0.6, NOW);
    assert.equal(assessment.ratio, null, `ratio for ${String(value)}`);
    assert.equal(assessment.suggested, false, `suggestion for ${String(value)}`);
    assert.equal(assessment.label, 'Stats unknown');
  }
});

test('invalid player totals cannot make targets look safe', () => {
  for (const total of [undefined, null, 0, -1, '1000000', NaN, Infinity]) {
    const assessment = Core.assess(target(), { ...player, battleStats: { total } }, 0.6, NOW);
    assert.equal(assessment.ratio, null);
    assert.equal(assessment.suggested, false);
  }
});

test('estimates expire after seven days and reject missing or implausibly future dates', () => {
  const boundary = NOW / 1000 - Core.ESTIMATE_MAX_AGE;
  assert.equal(Core.assess(target({ estimateUpdatedAt: boundary }), player, 0.6, NOW).fresh, true);
  const expired = Core.assess(target({ estimateUpdatedAt: boundary - 1 }), player, 0.6, NOW);
  assert.equal(expired.fresh, false);
  assert.equal(expired.suggested, false);
  assert.equal(expired.label, 'Estimate too old / undated');

  for (const stamp of [undefined, null, 0, -1, '2026-10-09', NaN, Infinity, NOW / 1000 + 301]) {
    const assessment = Core.assess(target({ estimateUpdatedAt: stamp }), player, 0.6, NOW);
    assert.equal(assessment.fresh, false, `freshness for ${String(stamp)}`);
    assert.equal(assessment.suggested, false);
  }
  assert.equal(Core.assess(target({ estimateUpdatedAt: NOW / 1000 + 300 }), player, 0.6, NOW).fresh, true);
});

test('estimate age is configurable from one to 365 days and includes its exact chosen boundary', () => {
  assert.equal(Core.DEFAULT_ESTIMATE_DAYS, 7);
  for (const days of [1, 7, 28, 365]) {
    const stamp = NOW / 1000 - days * 86400;
    assert.equal(Core.assess(target({ estimateUpdatedAt: stamp }), player, 0.6, NOW, 0.1, days).suggested, true);
    assert.equal(Core.assess(target({ estimateUpdatedAt: stamp - 1 }), player, 0.6, NOW, 0.1, days).suggested, false);
  }
  const old = target({ estimateUpdatedAt: NOW / 1000 - 20 * 86400 });
  assert.equal(Core.select([old], player, { mode: 'suggested', estimateDays: 7 }, NOW).length, 0);
  assert.equal(Core.select([old], player, { mode: 'suggested', estimateDays: 28 }, NOW).length, 1);
  for (const days of [0, -1, 366, 1.5, '28', null, NaN, Infinity]) {
    assert.equal(Core.assess(target(), player, 0.6, NOW, 0.1, days).suggested, false, String(days));
  }
});

test('approved reasons take precedence over notes and are searchable as plain text', () => {
  const listed = target({ reason: '  Repeated alliance attacks  ', notes: 'Legacy administrator note' });
  assert.equal(Core.reason(listed), 'Repeated alliance attacks');
  assert.equal(Core.select([listed], player, { query: 'ALLIANCE ATTACKS' }, NOW).length, 1);
  assert.equal(Core.select([listed], player, { query: 'Legacy administrator' }, NOW).length, 0);
  assert.equal(Core.reason(target({ reason: '  ', notes: '  Manual reason  ' })), 'Manual reason');
  assert.equal(Core.reason(target({ reason: {}, notes: null })), '');
});

test('recent targets validate entries, expire at ten minutes and retain at most the latest 50', () => {
  assert.equal(Core.RECENT_TARGET_MS, 600000);
  const history = [
    { id: 1, at: NOW - 600000 }, { id: 2, at: NOW - 599999 }, { id: 3, at: NOW + 1 },
    { id: '4', at: NOW }, { id: 0, at: NOW }, { id: 5, at: NaN }, null,
  ];
  assert.deepEqual(JSON.parse(JSON.stringify(Core.recentTargets(history, NOW))), [{ id: 2, at: NOW - 599999 }]);
  assert.deepEqual([...Core.recentTargets(null, NOW)], []);
  const many = Array.from({ length: 60 }, (_, index) => ({ id: index + 1, at: NOW - 60 + index }));
  assert.deepEqual([...Core.recentTargets(many, NOW).map(value => value.id)], many.slice(-50).map(value => value.id));
  assert.equal(many.length, 60, 'normalizing history leaves stored input unchanged');
});

test('finder candidates exclude recent, reserved and unavailable targets while shuffling within readiness priority', () => {
  const targets = [
    target({ id: 1 }), target({ id: 2 }), target({ id: 3, checkedAt: null }),
    target({ id: 4, reserved: true }),
    target({ id: 5, status: { state: 'Hospital' } }),
    target({ id: 6, status: { state: 'Hospital', until: NOW / 1000 + 120 }, checkedAt: null }),
    target({ id: 7 }),
  ];
  const rows = Core.select(targets, player, { mode: 'suggested' }, NOW);
  const history = [{ id: 7, at: NOW }];
  const chosen = Core.candidates(rows, history, NOW, () => 0);
  assert.deepEqual([...chosen.map(value => value.id)], [2, 1, 3]);
  assert.deepEqual(targets.map(value => value.id), [1, 2, 3, 4, 5, 6, 7]);
  assert.equal(Core.candidates(rows, [{ id: 1, at: NOW - 600000 }], NOW, () => 0.999999).some(value => value.id === 1), true);
});

test('Ready requires an Okay status checked less than thirty seconds ago', () => {
  assert.equal(Core.LIVE_STATUS_MAX_AGE, 30_000);
  assert.equal(Core.assess(target(), player, 0.6, NOW).ready, true);
  const nearlyExpired = new Date(NOW - Core.LIVE_STATUS_MAX_AGE + 1).toISOString();
  assert.equal(Core.assess(target({ checkedAt: nearlyExpired }), player, 0.6, NOW).ready, true);

  for (const checkedAt of [undefined, null, '', 'invalid', new Date(NOW - Core.LIVE_STATUS_MAX_AGE).toISOString(), new Date(NOW + 5001).toISOString()]) {
    const assessment = Core.assess(target({ checkedAt }), player, 0.6, NOW);
    assert.equal(assessment.live, false, `live status for ${String(checkedAt)}`);
    assert.equal(assessment.ready, false);
  }
  for (const state of [undefined, 'Hospital', 'Traveling', 'Jail', 'okay']) {
    assert.equal(Core.assess(target({ status: { state } }), player, 0.6, NOW).ready, false);
  }
  assert.equal(Core.assess(target({ status: undefined }), player, 0.6, NOW).ready, false);
});

test('future or malformed availability timers cannot make a cached Okay target ready', () => {
  for (const until of [null, undefined, 0, NOW / 1000, NOW / 1000 - 1]) {
    assert.equal(Core.assess(target({ status: { state: 'Okay', until } }), player, 0.6, NOW).ready, true);
  }
  for (const until of [NOW / 1000 + 1, '0', 'invalid', -1, NaN, Infinity, 0.5]) {
    assert.equal(Core.assess(target({ status: { state: 'Okay', until } }), player, 0.6, NOW).ready, false, String(until));
  }
  for (const state of ['Hospital', 'Jail', 'Traveling']) {
    const future = Core.assess(target({ status: { state, until: NOW / 1000 + 10 } }), player, 0.6, NOW);
    assert.equal(future.timedUnavailable, true);
    assert.equal(future.ready, false);
    const ended = Core.assess(target({ status: { state, until: NOW / 1000 - 1 } }), player, 0.6, NOW);
    assert.equal(ended.timedUnavailable, false);
    assert.equal(ended.ready, false, 'an expired hospital timer never becomes an Okay status');
  }
});

test('a cached Okay label without a fresh live check never means Ready', () => {
  const assessment = Core.assess(target({ checkedAt: undefined }), player, 0.6, NOW);
  assert.equal(assessment.suggested, true);
  assert.equal(assessment.live, false);
  assert.equal(assessment.ready, false);
});

test('self and faction allies cannot be recommended or Ready', () => {
  for (const friendly of [target({ id: player.id }), target({ faction: { id: player.faction.id, name: 'Ally' } })]) {
    const assessment = Core.assess(friendly, player, 0.6, NOW);
    assert.equal(assessment.suggested, false);
    assert.equal(assessment.ready, false);
    assert.equal(assessment.label, 'Friendly / self');
  }
  assert.equal(Core.assess(target({ faction: null }), player, 0.6, NOW).suggested, true);
});

test('the full list keeps unknown, stale, hard, and friendly entries visible', () => {
  const targets = [
    target({ id: 1 }),
    target({ id: 2, estimatedStats: null }),
    target({ id: 3, estimateUpdatedAt: NOW / 1000 - Core.ESTIMATE_MAX_AGE - 1 }),
    target({ id: 4, estimatedStats: 2_000_000 }),
    target({ id: player.id }),
  ];
  const result = Core.select(targets, player, {}, NOW);
  assert.equal(result.length, targets.length);
  assert.deepEqual([...result.map(item => item.target.id)].sort((a, b) => a - b), targets.map(item => item.id).sort((a, b) => a - b));
  assert.equal(result[0].target.id, 1);
  const suggested = Core.select(targets, player, { mode: 'suggested' }, NOW);
  assert.deepEqual([...suggested.map(item => item.target.id)], [1]);
});

test('search covers player id, name, faction, and notes with case-insensitive matching', () => {
  const targets = [target({ id: 999, name: 'Target Name', faction: { id: 222, name: 'Blue Ravens' }, notes: 'Weekend chains' })];
  for (const query of ['999', ' TARGET NAME ', 'ravens', 'WEEKEND']) {
    assert.equal(Core.select(targets, player, { query }, NOW).length, 1);
  }
  assert.equal(Core.select(targets, player, { query: 'unmatched' }, NOW).length, 0);
  assert.equal(Core.select(targets, player, { mode: 'suggested', query: '999', maxRatio: 0.4 }, NOW).length, 0);
});

test('ranking puts suggestions first, then ratio, and deterministically breaks ties by id', () => {
  const targets = [
    target({ id: 5, estimatedStats: null }),
    target({ id: 4, estimatedStats: 700_000 }),
    target({ id: 3, estimatedStats: 100_000, estimateUpdatedAt: 1 }),
    target({ id: 2, estimatedStats: 500_000 }),
    target({ id: 1, estimatedStats: 500_000 }),
    target({ id: 6, estimatedStats: 200_000 }),
  ];
  const result = Core.select(targets, player, {}, NOW);
  assert.deepEqual([...result.map(item => item.target.id)], [6, 1, 2, 3, 4, 5]);
  assert.deepEqual(targets.map(item => item.id), [5, 4, 3, 2, 1, 6], 'selection does not reorder the source list');
});

test('service addresses require HTTPS except for local development and reject credentials or URL parameters', () => {
  assert.equal(Core.serviceUrl('https://targets.example/api/'), 'https://targets.example/api');
  assert.equal(Core.serviceUrl('http://localhost:8787/'), 'http://localhost:8787');
  assert.equal(Core.serviceUrl('http://127.0.0.1:8787/'), 'http://127.0.0.1:8787');
  assert.equal(Core.serviceUrl('http://[::1]:8787/'), 'http://[::1]:8787');
  for (const url of [
    'http://targets.example',
    'http://localhost.targets.example',
    'http://192.168.1.10',
    'https://name:password@targets.example',
    'https://name@targets.example',
    'https://targets.example?key=abcdefghijklmnop',
    'https://targets.example#fragment',
    'javascript:alert(1)',
    'file:///tmp/targets',
    '/relative/path',
    '',
  ]) assert.throws(() => Core.serviceUrl(url), undefined, url);
});

test('API key format accepts exactly sixteen alphanumeric characters', () => {
  assert.equal(Core.validKey('AbCdEfGh12345678'), true);
  for (const value of ['', 'short', 'AbCdEfGh123456789', 'AbCdEfGh1234567!', ' AbCdEfGh12345678', 'AbCdEfGh12345678 ', null, undefined]) {
    assert.equal(Core.validKey(value), false, String(value));
  }
});

test('display helpers keep unknown values explicit', () => {
  assert.equal(Core.compact(undefined), 'Unknown');
  assert.equal(Core.compact(null), 'Unknown');
  assert.equal(Core.compact(Infinity), 'Unknown');
  assert.equal(Core.compact(1_000_000), '1M');
  assert.equal(Core.ageLabel(undefined, NOW), 'Date unknown');
  assert.equal(Core.ageLabel(NOW / 1000, NOW), 'Just now');
  assert.equal(Core.ageLabel(NOW / 1000 - 120, NOW), '2m ago');
  assert.equal(Core.ageLabel(NOW / 1000 - 7200, NOW), '2h ago');
  assert.equal(Core.ageLabel(NOW / 1000 - 172800, NOW), '2d ago');
});


test('personal faction IDs parse strictly, deduplicate and bound saved input',()=>{
  assert.equal(JSON.stringify(Core.parseExcludedFactions(' 33, 22\n33; 11, ')),JSON.stringify([11,22,33]));
  assert.equal(JSON.stringify(Core.parseExcludedFactions('')), '[]');
  for(const value of ['1e3','0','-2','1.5','2147483648','22,bad',Array.from({length:101},(_,i)=>i+1).join(',')])assert.equal(Core.parseExcludedFactions(value),null);
});

test('personal exclusions filter factions and recent, unknown or future activity with inclusive cutoff',()=>{
  const options={minRatio:0.1,maxRatio:0.6,estimateDays:7,excludedFactionIds:[222],avoidActive:true,activityMinutes:15};
  const safe=target({id:1,faction:{id:333},lastAction:NOW/1000-900});
  const rows=[safe,target({id:2,lastAction:NOW/1000-3600}),{...safe,id:3,lastAction:NOW/1000-899},
    {...safe,id:4,lastAction:null},{...safe,id:5,lastAction:NOW/1000+1},{...safe,id:6,lastAction:0}];
  assert.equal(JSON.stringify(Core.select(rows,player,options,NOW).map(row=>row.target.id)), '[1]');
  assert.equal(Core.avoidReason(rows[1],options,NOW),'Faction excluded');
  assert.equal(Core.avoidReason(rows[2],options,NOW),'Recently active');
  assert.equal(Core.avoidReason(rows[3],options,NOW),'Activity unknown');
  assert.equal(Core.avoidReason(safe,{...options,activityMinutes:0},NOW),'Invalid activity cutoff');
  assert.equal(Core.select(rows,player,{...options,excludedFactionIds:[],avoidActive:false},NOW).length,6);
});
