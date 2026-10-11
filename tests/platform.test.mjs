import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../src/platform.js', import.meta.url), 'utf8');
const { create } = vm.runInNewContext(`${source}\nTargetListPlatform;`, { console, URL, setTimeout, clearTimeout });
const SESSION = 'targetlist.session.https://targetlist.grusmedia.no';
const PREFERENCES = 'targetlist.preferences.https://targetlist.grusmedia.no';
const keys = [SESSION, PREFERENCES];
const value = { token: 'opaque-test-session', expiresAt: '2026-10-17T12:00:00Z' };
const plain = item => item === undefined ? item : JSON.parse(JSON.stringify(item));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
async function flush() { for (let index = 0; index < 20; index++) await Promise.resolve(); }

function gmStorage(initial = []) {
  const values = new Map(initial); const reads = []; const writes = []; const deletions = [];
  return {
    values, reads, writes, deletions,
    env: {
      gmGet(key, fallback) { reads.push(key); return values.has(key) ? values.get(key) : fallback; },
      gmSet(key, next) { writes.push([key, plain(next)]); values.set(key, next); },
      gmDelete(key) { deletions.push(key); values.delete(key); },
    },
  };
}

function localStorage(initial = []) {
  const values = new Map(initial);
  return {
    values,
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key),
  };
}

function pdaStorage(initial = []) {
  const values = new Map(initial); const reads = []; const writes = []; const deletions = [];
  return {
    values, reads, writes, deletions,
    env: {
      async getMany(requested) { reads.push([...requested]); return Object.fromEntries(requested.map(key => [key, values.has(key) ? values.get(key) : null])); },
      async loadAll() { reads.push('loadAll'); return Object.fromEntries(values); },
      async set(key, next) { writes.push([key, plain(next)]); values.set(key, plain(next)); },
      async delete(key) { deletions.push(key); return values.delete(key); },
    },
  };
}

test('Tampermonkey retains synchronous storage and sends request options unchanged', () => {
  const gm = gmStorage([[SESSION, value]]); const requests = [];
  const platform = create({ ...gm.env, gmRequest: options => { requests.push(options); return 'request handle'; } });
  assert.equal(platform.prepare(keys), undefined);
  assert.deepEqual(plain(platform.getValue(SESSION, null)), value);
  assert.equal(platform.getValue('missing', 'fallback'), 'fallback');
  const preferences = { minRatio: 10, maxRatio: 60 };
  assert.equal(platform.setValue(PREFERENCES, preferences), undefined);
  assert.deepEqual(gm.writes, [[PREFERENCES, preferences]]);
  platform.deleteValue(SESSION);
  assert.equal(platform.getValue(SESSION, null), null);
  const options = { method: 'POST', url: 'https://example.invalid/api/session', headers: { 'Content-Type': 'application/json' }, data: '{"test":true}', onload() {} };
  assert.equal(platform.xmlHttpRequest(options), 'request handle');
  assert.equal(requests.length, 1);
  assert.equal(requests[0], options, 'the existing GM transport receives original options and callbacks');
});

test('browser storage fallback survives a second platform instance without requiring GM APIs', async () => {
  const local = localStorage();
  const first = create({ localStorage: () => local });
  await first.prepare(keys);
  await first.setValue(SESSION, value);
  await first.setValue(PREFERENCES, { minRatio: 25, maxRatio: 65, estimateDays: 14 });
  const second = create({ localStorage: () => local });
  await second.prepare(keys);
  assert.deepEqual(plain(second.getValue(SESSION, null)), value);
  assert.deepEqual(plain(second.getValue(PREFERENCES, null)), { minRatio: 25, maxRatio: 65, estimateDays: 14 });
  await second.deleteValue(SESSION);
  const third = create({ localStorage: () => local });
  await third.prepare(keys);
  assert.equal(third.getValue(SESSION, null), null);
  assert.equal(third.getValue(PREFERENCES, null).estimateDays, 14);
});

test('malformed legacy browser storage is treated as missing rather than breaking boot', async () => {
  const local = localStorage([[SESSION, '{invalid json']]);
  const platform = create({ localStorage: () => local });
  await platform.prepare(keys);
  assert.equal(platform.getValue(SESSION, null), null);
});

test('Torn PDA native storage is authoritative and restores sessions and preferences across page instances', async () => {
  const native = pdaStorage([[SESSION, value], [PREFERENCES, { estimateDays: 21, minRatio: 15, maxRatio: 65 }]]);
  const gm = gmStorage([[SESSION, { token: 'obsolete-legacy-session' }]]);
  const local = localStorage([[SESSION, JSON.stringify({ token: 'obsolete-browser-session' })]]);
  const first = create({ ...gm.env, pdaStorage: native.env, localStorage: () => local });
  const preparing = first.prepare(keys);
  assert.equal(typeof preparing?.then, 'function', 'native preload finishes before app boot');
  await preparing;
  assert.deepEqual(plain(first.getValue(SESSION, null)), value);
  assert.equal(first.getValue(PREFERENCES, null).estimateDays, 21);
  assert.equal(gm.reads.length, 0, 'existing native values never use older GM credentials');

  await first.setValue(PREFERENCES, { estimateDays: 14, minRatio: 20, maxRatio: 50 });
  const second = create({ ...gm.env, pdaStorage: native.env, localStorage: () => local });
  await second.prepare(keys);
  assert.deepEqual(plain(second.getValue(PREFERENCES, null)), { estimateDays: 14, minRatio: 20, maxRatio: 50 });
  assert.deepEqual(plain(second.getValue(SESSION, null)), value);
  assert.equal(gm.writes.length, 0); assert.equal(local.getItem(SESSION), JSON.stringify({ token: 'obsolete-browser-session' }));
});

test('missing native values migrate only the requested legacy session and preferences once', async () => {
  const native = pdaStorage();
  const gm = gmStorage([[SESSION, value], [PREFERENCES, { minRatio: 12, maxRatio: 55 }], ['torn-api-key', 'fixture-only-unused']]);
  const first = create({ ...gm.env, pdaStorage: native.env });
  await first.prepare(keys);
  assert.deepEqual(plain(first.getValue(SESSION, null)), value);
  assert.deepEqual(native.writes, [[SESSION, value], [PREFERENCES, { minRatio: 12, maxRatio: 55 }]]);
  assert.ok(gm.reads.every(key => keys.includes(key)), 'migration never loads arbitrary or Torn key entries');
  assert.equal(native.values.has('torn-api-key'), false);
  const second = create({ ...gm.env, pdaStorage: native.env });
  await second.prepare(keys);
  assert.equal(native.writes.length, 2, 'reloading a migrated page does not rewrite values');
});

test('an existing native null does not resurrect a legacy session', async () => {
  const native = pdaStorage([[SESSION, null], [PREFERENCES, null]]);
  const gm = gmStorage([[SESSION, value]]);
  const platform = create({ ...gm.env, pdaStorage: native.env });
  await platform.prepare(keys);
  assert.equal(platform.getValue(SESSION, null), null);
  assert.equal(native.writes.length, 0);
  assert.equal(gm.reads.length, 0, 'explicit null is a durable no-session value, not a migration invitation');
});

test('native preload exposes only the NWA session and preference keys requested by the app', async () => {
  const native = pdaStorage([[SESSION, value], [PREFERENCES, { estimateDays: 7 }], ['another-script.setting', { ignored: true }], ['torn-api-key', 'fixture-only-unused']]);
  const platform = create({ pdaStorage: native.env }); await platform.prepare(keys);
  assert.equal(platform.getValue('another-script.setting', 'fallback'), 'fallback');
  assert.equal(platform.getValue('torn-api-key', null), null);
  assert.equal(native.writes.length, 0);
});

test('native preload failure rejects boot without restoring a stale legacy token', async () => {
  const native = pdaStorage(); const gm = gmStorage([[SESSION, value]]);
  native.env.getMany = native.env.loadAll = async () => { throw new Error('native database unavailable'); };
  const platform = create({ ...gm.env, pdaStorage: native.env });
  await assert.rejects(platform.prepare(keys), /native database unavailable|storage/i);
  assert.equal(platform.getValue(SESSION, null), null);
  assert.equal(gm.reads.length, 0); assert.equal(gm.writes.length, 0);
});

test('native storage preload waits for Torn PDA readiness before opening its database', async () => {
  const ready = deferred(); const native = pdaStorage([[SESSION, value], [PREFERENCES, null]]);
  const platform = create({ pdaStorage: native.env, pdaReady: ready.promise });
  const preparing = platform.prepare(keys); await flush();
  assert.equal(native.reads.length, 0); assert.equal(platform.getValue(SESSION, null), null);
  ready.resolve(); await preparing;
  assert.deepEqual(native.reads, ['loadAll']); assert.deepEqual(plain(platform.getValue(SESSION, null)), value);
});

test('PDA initialization failure blocks native preload and never restores a legacy session', async () => {
  const ready = deferred(); const native = pdaStorage(); const gm = gmStorage([[SESSION, value]]);
  const platform = create({ ...gm.env, pdaStorage: native.env, pdaReady: ready.promise });
  const preparing = platform.prepare(keys);
  const rejected = assert.rejects(preparing, /saved data|storage/i);
  ready.reject(new Error('native platform initialization failed')); await rejected;
  assert.equal(native.reads.length, 0); assert.equal(gm.reads.length, 0); assert.equal(platform.getValue(SESSION, null), null);
});

test('a slow native preload cannot overwrite an intervening session save or logout in current memory', async () => {
  for (const saving of [true, false]) {
    const gate = deferred(); const native = pdaStorage([[SESSION, value], [PREFERENCES, { estimateDays: 7 }]]);
    native.env.loadAll = async () => { await gate.promise; return { [SESSION]: value, [PREFERENCES]: { estimateDays: 7 } }; };
    const platform = create({ pdaStorage: native.env });
    const preparing = platform.prepare(keys); await flush();
    const replacement = { ...value, token: 'replacement-opaque-session' };
    const changing = saving ? platform.setValue(SESSION, replacement) : platform.deleteValue(SESSION);
    gate.resolve(); await Promise.all([preparing, changing]);
    assert.deepEqual(plain(platform.getValue(SESSION, null)), saving ? replacement : null);
    assert.equal(platform.getValue(PREFERENCES, null).estimateDays, 7, 'unchanged preferences still preload normally');
    assert.deepEqual(plain(native.values.get(SESSION) ?? null), saving ? replacement : null);
  }
});

test('native writes serialize so a delayed login cannot overwrite a following logout', async () => {
  const native = pdaStorage([[SESSION, null], [PREFERENCES, null]]); const gate = deferred(); const calls = [];
  native.env.set = async (key, next) => { calls.push(['set', key]); await gate.promise; native.values.set(key, plain(next)); };
  native.env.delete = async key => { calls.push(['delete', key]); native.values.delete(key); };
  const platform = create({ pdaStorage: native.env }); await platform.prepare(keys);
  const writing = platform.setValue(SESSION, value);
  const deleting = platform.deleteValue(SESSION);
  await flush();
  assert.deepEqual(calls, [['set', SESSION]], 'logout waits for the previous durable write');
  assert.equal(platform.getValue(SESSION, null), null, 'the current page signs out immediately');
  gate.resolve(); await Promise.all([writing, deleting]);
  const reloaded = create({ pdaStorage: native.env }); await reloaded.prepare(keys);
  assert.equal(reloaded.getValue(SESSION, null), null, 'the following page cannot restore a logged-out session');
});

test('one rejected native write does not block a following delete or silently write to GM storage', async () => {
  const native = pdaStorage([[SESSION, null], [PREFERENCES, null]]); const gm = gmStorage();
  native.env.set = async () => { throw new Error('disk unavailable'); };
  const platform = create({ ...gm.env, pdaStorage: native.env }); await platform.prepare(keys);
  await assert.rejects(platform.setValue(SESSION, value), /disk unavailable|storage/i);
  await platform.deleteValue(SESSION);
  assert.deepEqual(native.deletions, [SESSION]); assert.equal(gm.writes.length, 0);
});

test('native migration storage failures reject preparation rather than pretending the login persisted', async () => {
  const native = pdaStorage(); const gm = gmStorage([[SESSION, value]]);
  native.env.set = async () => { throw new Error('migration write failed'); };
  const platform = create({ ...gm.env, pdaStorage: native.env });
  await assert.rejects(platform.prepare(keys), /migration write failed|storage/i);
});

test('a direct PDA POST waits for readiness and preserves the login body without calling a caching helper', async () => {
  const ready = deferred(); const direct = []; const helpers = []; const loaded = []; const errors = [];
  const platform = create({ pdaReady: ready.promise,
    pdaBridge: () => ({ callHandler: (...args) => { direct.push(args); return Promise.resolve({ status: 200, responseText: '{"token":"opaque-test-session"}' }); } }),
    pdaPost: (...args) => { helpers.push(args); return Promise.resolve({ status: 200, responseText: '{}' }); },
  });
  platform.xmlHttpRequest({ method: 'POST', url: 'https://example.invalid/api/session', headers: { 'Content-Type': 'application/json' },
    data: '{"testCredential":"fixture-only"}', onload: response => loaded.push(response), onerror: error => errors.push(error) });
  await flush();
  assert.equal(direct.length, 0, 'no bridge call occurs before Torn PDA is ready');
  ready.resolve(); await flush();
  assert.equal(direct.length, 1); assert.equal(helpers.length, 0);
  assert.deepEqual(plain(direct[0]), ['PDA_httpPost', 'https://example.invalid/api/session', { 'Content-Type': 'application/json' }, '{"testCredential":"fixture-only"}']);
  assert.equal(loaded.length, 1); assert.equal(errors.length, 0);
  assert.equal(loaded[0].status, 200); assert.equal(loaded[0].responseText, '{"token":"opaque-test-session"}');
});

test('direct PDA GET and DELETE send authorization headers to the matching native handler', async () => {
  const direct = []; const responses = [];
  const platform = create({ pdaBridge: () => ({ callHandler: (...args) => { direct.push(args); return Promise.resolve({ status: 204, responseText: '' }); } }) });
  for (const method of ['GET', 'DELETE']) {
    platform.xmlHttpRequest({ method, url: 'https://example.invalid/api/targets', headers: { Authorization: 'Bearer opaque-test-session' }, onload: response => responses.push(response) });
  }
  await flush();
  assert.deepEqual(plain(direct), [
    ['PDA_httpGet', 'https://example.invalid/api/targets', { Authorization: 'Bearer opaque-test-session' }],
    ['PDA_httpDelete', 'https://example.invalid/api/targets', { Authorization: 'Bearer opaque-test-session' }],
  ]);
  assert.equal(responses.length, 2); assert.equal(responses[0].status, 204);
});

test('PDA helper fallback sends one GET, POST, or DELETE with its original headers and body', async () => {
  const calls = []; const responses = [];
  const helper = method => (...args) => { calls.push([method, ...args]); return Promise.resolve({ status: 200, responseText: '{"ok":true}' }); };
  const platform = create({ pdaGet: helper('GET'), pdaPost: helper('POST'), pdaDelete: helper('DELETE') });
  for (const method of ['GET', 'POST', 'DELETE']) {
    platform.xmlHttpRequest({ method, url: 'https://example.invalid/api/session', headers: { Authorization: 'Bearer opaque-test-session' },
      ...(method === 'POST' ? { data: '{"fixture":true}' } : {}), onload: response => responses.push(response) });
  }
  await flush();
  assert.deepEqual(plain(calls), [
    ['GET', 'https://example.invalid/api/session', { Authorization: 'Bearer opaque-test-session' }],
    ['POST', 'https://example.invalid/api/session', { Authorization: 'Bearer opaque-test-session' }, '{"fixture":true}'],
    ['DELETE', 'https://example.invalid/api/session', { Authorization: 'Bearer opaque-test-session' }],
  ]);
  assert.equal(responses.length, 3); assert.ok(responses.every(response => response.status === 200 && response.responseText === '{"ok":true}'));
});

test('an HTTP error is delivered to onload so normal authentication and rate-limit handling still run', async () => {
  const loads = []; const errors = [];
  const platform = create({ pdaGet: async () => ({ status: 401, responseText: '{"error":"SESSION_EXPIRED"}' }) });
  platform.xmlHttpRequest({ method: 'GET', url: 'https://example.invalid/api/targets', onload: response => loads.push(response), onerror: error => errors.push(error) });
  await flush();
  assert.equal(loads.length, 1); assert.equal(errors.length, 0); assert.equal(loads[0].status, 401);
});

test('a pending PDA request does not duplicate while waiting and resolves to one callback', async () => {
  const pending = deferred(); const calls = []; const loads = []; const errors = [];
  const platform = create({ pdaPost: (...args) => { calls.push(args); return pending.promise; } });
  platform.xmlHttpRequest({ method: 'POST', url: 'https://example.invalid/api/targets/900/reservation', headers: {}, data: '{}',
    onload: response => loads.push(response), onerror: error => errors.push(error) });
  await flush(); await flush();
  assert.equal(calls.length, 1); assert.equal(loads.length, 0); assert.equal(errors.length, 0);
  pending.resolve({ status: 200, responseText: '{}' }); await flush();
  assert.equal(calls.length, 1); assert.equal(loads.length, 1); assert.equal(errors.length, 0);
});

test('aborting before PDA readiness suppresses the credential request entirely', async () => {
  const ready = deferred(); const calls = []; const aborted = []; const loaded = []; const errors = [];
  const platform = create({ pdaReady: ready.promise, pdaPost: (...args) => { calls.push(args); return Promise.resolve({ status: 200, responseText: '{}' }); } });
  const handle = platform.xmlHttpRequest({ method: 'POST', url: 'https://example.invalid/api/session', data: '{"fixture":true}',
    onload: response => loaded.push(response), onerror: error => errors.push(error), onabort: () => aborted.push(true) });
  handle.abort(); handle.abort();
  ready.resolve(); await flush();
  assert.equal(aborted.length, 1); assert.equal(calls.length, 0);
  assert.equal(loaded.length, 0); assert.equal(errors.length, 0);
});

test('aborting an in-flight native request ignores a late success or failure', async () => {
  for (const success of [true, false]) {
    const pending = deferred(); const callbacks = [];
    const platform = create({ pdaGet: () => pending.promise });
    const handle = platform.xmlHttpRequest({ method: 'GET', url: 'https://example.invalid/api/targets',
      onload: () => callbacks.push('load'), onerror: () => callbacks.push('error'), onabort: () => callbacks.push('abort') });
    await flush(); handle.abort();
    if (success) pending.resolve({ status: 200, responseText: '{}' });
    else pending.reject(new Error('late native failure'));
    await flush();
    assert.deepEqual(callbacks, ['abort']);
  }
});

test('an undefined PDA helper response reports one failure and never retries a POST', async () => {
  const calls = []; const errors = []; const loads = [];
  const platform = create({ pdaPost: (...args) => { calls.push(args); return Promise.resolve(undefined); } });
  platform.xmlHttpRequest({ method: 'POST', url: 'https://example.invalid/api/session', data: '{}', headers: {},
    onload: response => loads.push(response), onerror: error => errors.push(error) });
  await flush();
  assert.equal(calls.length, 1); assert.equal(loads.length, 0); assert.equal(errors.length, 1);
});

test('native transport failures and readiness failures report errors without a second credential request', async () => {
  const direct = []; const errors = [];
  const platform = create({ pdaBridge: () => ({ callHandler: (...args) => { direct.push(args); return Promise.reject(new Error('bridge unavailable')); } }),
    pdaPost: () => { assert.fail('must not fall back and repeat a native POST'); } });
  platform.xmlHttpRequest({ method: 'POST', url: 'https://example.invalid/api/session', data: '{}', onerror: error => errors.push(error), onload() { assert.fail('failed requests do not succeed'); } });
  await flush();
  assert.equal(direct.length, 1); assert.equal(errors.length, 1);

  const ready = deferred(); const noCall = [];
  const waiting = create({ pdaReady: ready.promise, pdaGet: (...args) => noCall.push(args) });
  waiting.xmlHttpRequest({ method: 'GET', url: 'https://example.invalid/api/targets', onerror: error => errors.push(error) });
  ready.reject(new Error('PDA initialization failed')); await flush();
  assert.equal(noCall.length, 0); assert.equal(errors.length, 2);
});

test('synchronous native bridge exceptions and a missing transport fail through onerror', async () => {
  const errors = [];
  const native = create({ pdaBridge: () => ({ callHandler() { throw new Error('bridge disposed'); } }) });
  native.xmlHttpRequest({ method: 'GET', url: 'https://example.invalid/api/targets', onerror: error => errors.push(error) });
  const missing = create({});
  missing.xmlHttpRequest({ method: 'GET', url: 'https://example.invalid/api/targets', onerror: error => errors.push(error) });
  await flush();
  assert.equal(errors.length, 2);
});
