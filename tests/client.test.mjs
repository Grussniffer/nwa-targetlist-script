import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const coreSource = await readFile(new URL('../src/core.js', import.meta.url), 'utf8');
const platformSource = await readFile(new URL('../src/platform.js', import.meta.url), 'utf8');
const appSource = await readFile(new URL('../src/app.js', import.meta.url), 'utf8');
const source = `${coreSource}\n${platformSource}\n${appSource}`;
// Read the configured address without mounting; all requests below are manual mocks.
const configSource = appSource.match(/^const CONFIG = .*;$/m)[0];
const { serviceBase, version: scriptVersion } = vm.runInNewContext(
  `${coreSource}\n${configSource}\n({ serviceBase: TargetListCore.serviceUrl(CONFIG.serviceUrl), version: CONFIG.version });`, { URL });
const NOW = Date.parse('2026-10-09T12:00:00Z');
const KEY = 'AbCdEfGh12345678';
const SESSION = 'opaque-session-token';
const keyStorage = { mode: 'encrypted', expiresAt: new Date(NOW + 7 * 86400000).toISOString() };
const player = {
  id: 12345, name: 'Allowed Player', faction: { id: 111, name: 'Allowed Faction' },
  battleStats: { strength: 250_000, defense: 250_000, speed: 250_000, dexterity: 250_000, total: 1_000_000 },
};
const target = {
  id: 98765, name: 'Target Player', faction: { id: 222, name: 'Target Faction' },
  estimatedStats: 500_000, estimateUpdatedAt: NOW / 1000 - 3600, estimateSource: 'FFScouter',
  status: { state: 'Okay' }, lastAction: NOW / 1000 - 60,
};

// A small DOM implements just the standard operations this userscript uses.
// Network responses stay manual so tests can deliver revoked or stale requests.
class Element {
  constructor(tag) {
    this.tagName = tag.toUpperCase(); this.children = []; this.listeners = new Map();
    this.attributes = new Map(); this.style = {}; this.value = ''; this.textContent = '';
    this.activeElement = null; this.parentNode = null;
  }
  append(...children) {
    for (const child of children) {
      if (typeof child === 'object') { child.remove(); child.parentNode = this; }
      this.children.push(child);
    }
  }
  replaceChildren(...children) {
    for (const child of this.children) if (typeof child === 'object') child.parentNode = null;
    this.children = []; this.append(...children);
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  remove() {
    if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this);
    this.parentNode = null;
  }
  addEventListener(name, callback) {
    if (!this.listeners.has(name)) this.listeners.set(name, []);
    this.listeners.get(name).push(callback);
  }
  attachShadow() { return this.shadow = new Element('shadow-root'); }
  get lastChild() { return this.children.at(-1); }
  emit(type, additions = {}) {
    const event = { key: '', defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...additions };
    for (const listener of this.listeners.get(type) || []) listener(event);
    return event;
  }
}
function descendants(element) {
  return [element, ...element.children.flatMap(child => typeof child === 'object' ? descendants(child) : [])];
}
function textContent(element) {
  return [element.textContent, ...element.children.map(child => typeof child === 'object' ? textContent(child) : String(child))].join(' ');
}
async function flush() { for (let index = 0; index < 12; index++) await Promise.resolve(); }

function fixture(saved = null, preferences = null, existingHost = null, initialNow = NOW, visibility = 'visible') {
  let clock = initialNow;
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [clock])); } static now() { return clock; } }
  const body = new Element('body'); const requests = []; const navigations = []; const storage = new Map(); const writes = []; const timers = []; const timeouts = new Map(); const timeoutDelays = new Map();
  const document = new Element('document');
  Object.assign(document, { body, visibilityState: visibility,
    getElementById: id => descendants(body).find(element => element.id === id), createElement: tag => new Element(tag),
    createElementNS: (namespace, tag) => { const node = new Element(tag); node.namespaceURI = namespace; return node; } });
  if (existingHost) body.append(existingHost);
  let nextTimer = 1;
  const storageKey = `targetlist.session.${serviceBase}`;
  const preferencesKey = `targetlist.preferences.${serviceBase}`;
  if (saved) storage.set(storageKey, saved);
  if (preferences) storage.set(preferencesKey, preferences);
  const context = vm.createContext({
    URL, Intl, Date: Clock, console,
    window: { location: { assign: url => navigations.push(url) } },
    document,
    GM_xmlhttpRequest: options => { requests.push(options); },
    GM_getValue: (key, fallback) => storage.get(key) ?? fallback,
    GM_setValue: (key, value) => { storage.set(key, value); writes.push(value); },
    GM_deleteValue: key => storage.delete(key),
    setInterval: callback => { timers.push(callback); },
    setTimeout: (callback, delay) => { const id = nextTimer++; timeouts.set(id, callback); timeoutDelays.set(id, delay); return id; },
    clearTimeout: id => { timeouts.delete(id); timeoutDelays.delete(id); },
  });
  // Keep integration fixtures deterministic; core tests separately verify the
  // random shuffle and readiness ordering used for real alliance members.
  vm.runInContext('Math.random = () => 0.999999;', context);
  const runScript = () => vm.runInContext(`(() => {\n${source}\n})();`, context);
  runScript();
  const host = body.children.find(element => element.id === 'torn-targetlist-host');
  const root = host.shadow;
  function find(predicate) { const result = descendants(root).find(predicate); assert.ok(result, 'expected control exists'); return result; }
  function button(label) { return find(element => element.tagName === 'BUTTON' && element.textContent === label); }
  function response(request, data, status = 200) {
    request.onload({ status, responseText: JSON.stringify(data), finalUrl: request.url });
  }
  async function signIn(targets = [target], feed = {}) {
    const input = find(element => element.tagName === 'INPUT' && element.type === 'password'); input.value = KEY;
    find(element => element.tagName === 'FORM').emit('submit');
    const login = requests.at(-1);
    response(login, { token: SESSION, expiresAt: new Date(NOW + 3_600_000).toISOString(), player, keyStorage });
    await flush();
    response(requests.at(-1), { player, targets, warnings: [], generatedAt: new Date(NOW).toISOString(), ...feed });
    await flush();
    return login;
  }
  async function signOut() {
    button('Sign out and remove key').emit('click');
    const deletion = requests.at(-1); response(deletion, null, 204); await flush();
    return deletion;
  }
  return { root, host, body, runScript, requests, navigations, storage, writes, storageKey, preferencesKey, timers, timeouts, timeoutDelays, find, button, response, signIn, signOut,
    settings: () => find(element => element.className === 'settings-toggle'),
    text: () => textContent(root), setNow: value => { clock = value; },
    setVisibility: value => { document.visibilityState = value; document.emit('visibilitychange'); } };
}

test('installing NWA replaces a legacy target-list host and keeps the settings gear usable', () => {
  for (const previousVersion of [null, '0.3.0']) {
    const legacy = new Element('div'); legacy.id = 'torn-targetlist-host';
    if (previousVersion) legacy.setAttribute('data-nwa-version', previousVersion);
    const legacyButton = new Element('button'); legacyButton.textContent = '◎ Target list';
    legacy.attachShadow().append(legacyButton);
    const app = fixture(null, null, legacy);
    assert.equal(legacy.parentNode, null);
    assert.equal(app.body.children.filter(element => element.id === 'torn-targetlist-host').length, 1);
    assert.notEqual(app.host, legacy);
    assert.equal(app.host.getAttribute('data-nwa-version'), scriptVersion);
    assert.equal(app.button('NWA').className, 'launcher');
    assert.equal(descendants(app.settings()).some(element => element.tagName === 'SVG' && element.namespaceURI === 'http://www.w3.org/2000/svg'), true);
    app.settings().emit('click');
    assert.equal(app.find(element => element.className === 'panel').hidden, false);
  }
});

test('running the current NWA version again preserves one launcher and its existing session', async () => {
  const app = fixture(); await app.signIn();
  const host = app.host; const before = app.requests.length;
  app.runScript();
  assert.equal(app.body.children.filter(element => element.id === 'torn-targetlist-host').length, 1);
  assert.equal(app.body.children[0], host);
  assert.equal(app.timers.length, 1, 'the current version does not mount a second session timer');
  assert.equal(app.requests.length, before);
  assert.equal(app.storage.get(app.storageKey).token, SESSION);
  assert.match(app.text(), /Allowed Player \[12345\]/);
});

test('an older script cannot replace an already mounted newer NWA version', () => {
  const [major, minor, patch] = scriptVersion.split('.').map(Number);
  for (const newerVersion of [`${major}.${minor + 1}.0`, `${major}.${minor}.${patch + 10}`]) {
    const newerHost = new Element('div'); newerHost.id = 'torn-targetlist-host';
    newerHost.setAttribute('data-nwa-version', newerVersion);
    const existingUi = new Element('button'); existingUi.textContent = 'Existing newer NWA';
    newerHost.attachShadow().append(existingUi);
    const app = fixture(null, null, newerHost);
    assert.equal(app.host, newerHost);
    assert.equal(app.host.getAttribute('data-nwa-version'), newerVersion);
    assert.equal(app.body.children.length, 1);
    assert.equal(app.root.children[0], existingUi);
    assert.equal(app.timers.length, 0);
    assert.equal(app.requests.length, 0);
  }
});

test('invalid key input stays local and the password field is cleared on submission', async () => {
  const app = fixture(); const input = app.find(element => element.type === 'password'); input.value = 'bad-key';
  const event = app.find(element => element.tagName === 'FORM').emit('submit');
  await flush();
  assert.equal(event.defaultPrevented, true);
  assert.equal(input.value, '');
  assert.equal(app.requests.length, 0);
  assert.match(app.text(), /Enter a 16-character Torn Limited API key/);
  assert.equal(app.storage.size, 0);
});

test('the key-use notice appears before the input and discloses encrypted offline storage and removal', () => {
  const app = fixture();
  const form = app.find(element => element.tagName === 'FORM');
  const notice = app.find(element => element.id === 'nwa-key-use');
  const input = app.find(element => element.type === 'password');
  assert.equal(form.children[0], notice);
  assert.equal(input.attributes.get('aria-describedby'), notice.id);
  assert.match(textContent(notice), /Limited key verifies your name and faction and reads your battle stats/);
  assert.match(textContent(notice), /saved encrypted.*Supabase.*up to 7 days.*while you are offline/s);
  assert.match(textContent(notice), /Sign out and remove key.*delete the saved key/);
});

test('login posts the key once, stores only the session token, and authorizes target requests', async () => {
  const app = fixture(); const login = await app.signIn();
  assert.equal(login.method, 'POST');
  assert.equal(login.url, `${serviceBase}/api/session`);
  assert.deepEqual(JSON.parse(login.data), { apiKey: KEY, storeKey: true });
  assert.equal(login.headers.Authorization, undefined);
  assert.equal(login.anonymous, true);
  assert.equal(login.redirect, 'error', 'the key body must not follow redirects');
  assert.equal(app.requests[1].headers.Authorization, `Bearer ${SESSION}`);
  assert.equal(app.requests[1].data, undefined);
  assert.equal(app.writes.length, 1);
  assert.equal(app.writes[0].token, SESSION);
  assert.deepEqual(Object.keys(app.writes[0]).sort(), ['expiresAt', 'token']);
  assert.equal(JSON.stringify([...app.storage.values()]).includes(KEY), false);
  assert.match(app.text(), /Allowed Player \[12345\]/);
  assert.match(app.text(), /Target Player \[98765\]/);
  assert.equal(descendants(app.root).some(element => element.className === 'attack'), false, 'cached Okay status has no attack link');
});

test('incompatible backend storage confirmation is rejected before saving a token and cleans up its session', async () => {
  for (const metadata of [undefined, { mode: 'memory', expiresAt: keyStorage.expiresAt },
    { mode: 'encrypted', expiresAt: 'invalid' }, { mode: 'encrypted', expiresAt: new Date(NOW - 1).toISOString() },
    { mode: 'encrypted', expiresAt: new Date(NOW + 8 * 86400000).toISOString() }]) {
    const app = fixture();
    app.find(element => element.type === 'password').value = KEY;
    app.find(element => element.tagName === 'FORM').emit('submit');
    app.response(app.requests[0], { token: SESSION, expiresAt: new Date(NOW + 3_600_000).toISOString(), player, keyStorage: metadata });
    await flush();
    assert.equal(app.storage.has(app.storageKey), false, 'unconfirmed encrypted storage must never adopt the token');
    assert.equal(app.requests.length, 2);
    const cleanup = app.requests[1];
    assert.equal(cleanup.method, 'DELETE');
    assert.equal(cleanup.url, `${serviceBase}/api/session`);
    assert.equal(cleanup.headers.Authorization, `Bearer ${SESSION}`);
    assert.equal(cleanup.data, undefined);
    app.response(cleanup, null, 204); await flush();
    assert.match(app.text(), /Update the NWA backend to enable encrypted key storage/);
    assert.equal(app.button('Sign in and save key').disabled, false);
    assert.equal(app.storage.size, 0);
    assert.equal(app.requests.some(request => request.url.endsWith('/api/targets')), false);
    assert.deepEqual(app.navigations, []);
  }
});

test('incompatible backend cleanup failure does not adopt the token or hide the required backend update', async () => {
  const app = fixture(); app.find(element => element.type === 'password').value = KEY;
  app.find(element => element.tagName === 'FORM').emit('submit');
  app.response(app.requests[0], { token: SESSION, expiresAt: new Date(NOW + 3_600_000).toISOString(), player }); await flush();
  app.requests[1].onerror(); await flush();
  assert.equal(app.storage.size, 0);
  assert.match(app.text(), /Update the NWA backend to enable encrypted key storage/);
  assert.equal(app.button('Sign in and save key').disabled, false);
});

test('a stored session verifies authorization before displaying any targets', async () => {
  const app = fixture({ token: SESSION, expiresAt: new Date(NOW + 3_600_000).toISOString() });
  assert.equal(app.requests.length, 1, 'a saved session preloads the feed at startup');
  assert.equal(app.find(element => element.className === 'panel').hidden, true);
  app.settings().emit('click');
  assert.equal(app.requests.length, 1);
  assert.equal(app.requests[0].headers.Authorization, `Bearer ${SESSION}`);
  assert.ok(app.requests[0].url.endsWith('/api/targets'));
  app.response(app.requests[0], { error: { code: 'FACTION_NOT_ALLOWED', message: 'Your faction is no longer allowed.' } }, 403);
  await flush();
  assert.equal(app.storage.size, 0);
  assert.match(app.text(), /Your faction is no longer allowed/);
  assert.equal(descendants(app.root).some(element => element.className === 'card'), false);
});

test('a seven-day saved session restores after 30 minutes and on day six without resending the API key', async () => {
  const lifetime = 7 * 24 * 60 * 60 * 1000;
  const expiresAt = new Date(NOW + lifetime).toISOString();
  for (const age of [31 * 60 * 1000, 6 * 24 * 60 * 60 * 1000]) {
    const restoredAt = NOW + age;
    const app = fixture({ token: SESSION, expiresAt }, null, null, restoredAt);
    assert.equal(app.requests.length, 1, 'restoring storage starts one token-authorized feed request');
    assert.equal(app.requests[0].data, undefined, 'restoration never sends an API key');
    assert.equal(app.storage.get(app.storageKey).expiresAt, expiresAt);
    assert.equal(descendants(app.root).some(element => element.className === 'card'), false);
    app.settings().emit('click');
    assert.equal(app.requests.length, 1);
    const authorization = app.requests[0];
    assert.equal(authorization.method, 'GET');
    assert.equal(authorization.url, `${serviceBase}/api/targets`);
    assert.equal(authorization.headers.Authorization, `Bearer ${SESSION}`);
    assert.equal(descendants(app.root).some(element => element.className === 'card'), false,
      'a long-lived session must still authorize the player before showing targets');
    app.response(authorization, { player, targets: [target], warnings: [] }); await flush();
    assert.match(app.text(), /Target Player \[98765\]/);
    app.button('NWA').emit('click');
    const live = app.requests.at(-1);
    assert.equal(live.url, `${serviceBase}/api/targets/${target.id}/status`);
    assert.deepEqual(app.navigations, [], 'restored credentials do not bypass live status checks');
    app.response(live, { id: target.id, status: { state: 'Okay' }, checkedAt: new Date(restoredAt).toISOString() });
    await flush();
    assert.deepEqual(app.navigations, [`https://www.torn.com/page.php?sid=attack&user2ID=${target.id}`]);
    assert.equal(app.requests.some(request => request.method === 'POST' && request.url.endsWith('/api/session')), false);
    assert.equal(JSON.stringify([...app.storage.values()]).includes(KEY), false);

    const beforeExpiry = app.requests.length;
    app.setNow(NOW + lifetime); app.timers[0]();
    assert.equal(app.storage.has(app.storageKey), false, 'the seven-day deadline is not extended by use');
    assert.equal(descendants(app.root).some(element => element.className === 'card'), false);
    assert.match(app.text(), /Session expired/);
    app.button('NWA').emit('click'); await flush();
    assert.equal(app.requests.length, beforeExpiry);
    assert.match(app.text(), /Torn Limited API key/);
  }
});

test('a seven-day token already at its deadline is cleared on reload before any authorization request', () => {
  const deadline = NOW + 7 * 24 * 60 * 60 * 1000;
  const app = fixture({ token: SESSION, expiresAt: new Date(deadline).toISOString() }, null, null, deadline);
  assert.equal(app.storage.has(app.storageKey), false);
  app.settings().emit('click');
  assert.equal(app.requests.length, 0);
  assert.match(app.text(), /Torn Limited API key/);
  assert.equal(descendants(app.root).some(element => element.className === 'card'), false);
});

test('a concurrent login cannot strand a restored session in the loading state', async () => {
  const app = fixture({ token: SESSION, expiresAt: new Date(NOW + 3_600_000).toISOString() });
  app.settings().emit('click'); const restoring = app.requests.at(-1);
  // A form may remain during restoration, but it must not start a competing login.
  const form = descendants(app.root).find(element => element.tagName === 'FORM');
  if (form) {
    app.find(element => element.type === 'password').value = KEY;
    form.emit('submit');
  }
  await flush();
  assert.equal(app.requests.length, 1, 'restoration blocks a concurrent login request');
  app.response(restoring, { player, targets: [target], warnings: [] });
  await flush();
  assert.match(app.text(), /Target Player \[98765\]/);
  assert.equal(app.button('Refresh list').disabled, false);
});

test('expired saved credentials are removed before a request is made', () => {
  const app = fixture({ token: SESSION, expiresAt: new Date(NOW - 1).toISOString() });
  app.settings().emit('click');
  assert.equal(app.requests.length, 0);
  assert.equal(app.storage.size, 0);
});

test('an in-flight status response cannot restore targets after sign out', async () => {
  const app = fixture(); await app.signIn();
  app.button('Check status').emit('click'); const statusRequest = app.requests.at(-1);
  app.button('Sign out and remove key').emit('click'); const logoutRequest = app.requests.at(-1);
  assert.equal(logoutRequest.method, 'DELETE');
  assert.equal(logoutRequest.headers.Authorization, `Bearer ${SESSION}`);
  assert.equal(app.storage.get(app.storageKey).token, SESSION, 'the deletion credential stays available until confirmation');
  app.response(statusRequest, { id: target.id, status: { state: 'Okay' }, checkedAt: new Date(NOW).toISOString() });
  app.response(logoutRequest, { ok: true });
  await flush();
  assert.match(app.text(), /Torn Limited API key/);
  assert.equal(descendants(app.root).some(element => element.className === 'attack' || element.className === 'card'), false);
});

test('failed key deletion retains the token for retry and clears it only after backend confirmation', async () => {
  for (const outcome of ['storage-unavailable', 'network']) {
    const app = fixture(); await app.signIn([{ ...target, checkedAt: new Date(NOW).toISOString() }]);
    app.button('Sign out and remove key').emit('click');
    const deletion = app.requests.at(-1); const before = app.requests.length;
    assert.equal(deletion.method, 'DELETE');
    assert.equal(app.storage.get(app.storageKey).token, SESSION);
    assert.equal(app.button('Removing key…').disabled, true);
    app.button('NWA').emit('click'); app.button('Refresh list').emit('click');
    app.setNow(NOW + 10_000); app.timers[0]();
    assert.equal(app.requests.length, before, 'key removal blocks target requests and selection');
    assert.deepEqual(app.navigations, []);
    if (outcome === 'network') deletion.onerror();
    else app.response(deletion, { error: { code: 'KEY_STORAGE_UNAVAILABLE', message: 'Saved-key storage is temporarily unavailable.' } }, 503);
    await flush();
    assert.equal(app.storage.get(app.storageKey).token, SESSION);
    assert.match(app.text(), /Allowed Player \[12345\]/);
    assert.match(app.text(), /Key removal was not confirmed.*kept so you can retry/s);
    assert.equal(app.button('Sign out and remove key').disabled, false);
    assert.equal(JSON.stringify([...app.storage.values()]).includes(KEY), false, 'the API key is never saved in the browser');
    app.button('Sign out and remove key').emit('click');
    const retry = app.requests.at(-1);
    assert.notEqual(retry, deletion);
    assert.equal(retry.headers.Authorization, `Bearer ${SESSION}`);
    assert.equal(app.storage.get(app.storageKey).token, SESSION);
    app.response(retry, null, 204); await flush();
    assert.equal(app.storage.has(app.storageKey), false);
    assert.equal(descendants(app.root).some(element => element.className === 'card'), false);
    assert.match(app.text(), /Torn Limited API key/);
  }
});

test('a late target selection cannot resume after a failed key-removal attempt', async () => {
  const app = fixture(); await app.signIn(); app.button('NWA').emit('click');
  const oldStatus = app.requests.at(-1);
  app.button('Sign out and remove key').emit('click');
  app.response(app.requests.at(-1), { error: { code: 'KEY_STORAGE_UNAVAILABLE', message: 'Try key removal again shortly.' } }, 503); await flush();
  app.response(oldStatus, { id: target.id, status: { state: 'Okay' }, checkedAt: new Date(NOW).toISOString() }); await flush();
  assert.deepEqual(app.navigations, []);
  assert.equal(app.storage.get(app.storageKey).token, SESSION);
  assert.equal(descendants(app.root).some(element => element.className === 'attack'), false);
});

test('revocation or a faction change during a status check clears the pool and session', async () => {
  for (const code of ['SESSION_REVOKED', 'FACTION_CHANGED']) {
    const app = fixture(); await app.signIn();
    app.button('Check status').emit('click');
    app.response(app.requests.at(-1), { error: { code, message: 'Session no longer authorized.' } }, 403);
    await flush();
    assert.equal(app.storage.size, 0, code);
    assert.match(app.text(), /Session no longer authorized/);
    assert.match(app.text(), /Torn Limited API key/);
    assert.equal(descendants(app.root).some(element => element.className === 'card'), false);
  }
});

test('a friendly-target denial blocks the attack while retaining a valid player session', async () => {
  const app = fixture(); await app.signIn();
  app.button('Check status').emit('click');
  app.response(app.requests.at(-1), { error: { code: 'FRIENDLY_TARGET', message: 'This target is friendly.' } }, 403);
  await flush();
  assert.equal(app.storage.get(app.storageKey).token, SESSION);
  assert.match(app.text(), /Allowed Player \[12345\]/);
  assert.match(app.text(), /This target is friendly/);
  assert.equal(descendants(app.root).some(element => element.className === 'attack'), false);
});

test('attack clicks revalidate live status expiry even before the next display refresh', async () => {
  const app = fixture(); await app.signIn();
  app.button('Check status').emit('click');
  app.response(app.requests.at(-1), { id: target.id, status: { state: 'Okay' }, checkedAt: new Date(NOW).toISOString() });
  await flush();
  const attack = app.find(element => element.className === 'attack');
  assert.equal(attack.emit('click').defaultPrevented, false);
  app.setNow(NOW + 30_000);
  assert.equal(attack.emit('click').defaultPrevented, true);
  assert.match(app.text(), /Check this target’s status and stat range before opening an attack/);
  assert.equal(descendants(app.root).some(element => element.className === 'attack'), false);
});

test('middle clicks also revalidate an expired status check', async () => {
  const app = fixture(); await app.signIn();
  app.button('Check status').emit('click');
  app.response(app.requests.at(-1), { id: target.id, status: { state: 'Okay' }, checkedAt: new Date(NOW).toISOString() });
  await flush();
  const attack = app.find(element => element.className === 'attack');
  app.setNow(NOW + 30_000);
  assert.equal(attack.emit('auxclick', { button: 1 }).defaultPrevented, true);
  assert.equal(descendants(app.root).some(element => element.className === 'attack'), false);
});

test('the status-expiry timer removes attack links even while a control has focus', async () => {
  const app = fixture(); await app.signIn(); app.settings().emit('click');
  app.button('Check status').emit('click');
  app.response(app.requests.at(-1), { id: target.id, status: { state: 'Okay' }, checkedAt: new Date(NOW).toISOString() });
  await flush();
  app.root.activeElement = app.find(element => element.className === 'attack');
  app.setNow(NOW + 30_000); app.timers[0]();
  assert.equal(descendants(app.root).some(element => element.className === 'attack'), false);
  assert.match(app.text(), /Status needs checking/);
});

test('a forced-fetch timeout unblocks login and ignores a late successful response', async () => {
  const app = fixture(); const input = app.find(element => element.type === 'password'); input.value = KEY;
  app.find(element => element.tagName === 'FORM').emit('submit');
  const login = app.requests.at(-1);
  assert.equal(app.timeouts.size, 1);
  [...app.timeouts.values()][0]();
  await flush();
  assert.match(app.text(), /timed out/);
  assert.equal(app.button('Sign in and save key').disabled, false);
  app.response(login, { token: SESSION, expiresAt: new Date(NOW + 3_600_000).toISOString(), player, keyStorage });
  await flush();
  assert.equal(app.storage.size, 0);
  assert.equal(app.requests.length, 1);
  assert.match(app.text(), /Torn Limited API key/);
});

test('the idle timer clears expired sessions while the panel is closed', async () => {
  const app = fixture(); await app.signIn();
  app.setNow(NOW + 3_600_000);
  app.timers[0]();
  assert.equal(app.storage.size, 0);
  assert.match(app.text(), /Session expired/);
  assert.equal(descendants(app.root).some(element => element.className === 'card'), false);
});

test('the NWA launcher opens login without requesting a target when signed out', async () => {
  const app = fixture();
  const settings = app.settings();
  assert.equal(settings.attributes.get('aria-label'), 'NWA settings');
  app.button('NWA').emit('click'); await flush();
  assert.equal(app.find(element => element.className === 'panel').hidden, false);
  assert.match(app.text(), /Torn Limited API key/);
  assert.equal(app.requests.length, 0);
  assert.deepEqual(app.navigations, []);
});

test('signing in from NWA continues straight to a live target check', async () => {
  const app = fixture(); app.button('NWA').emit('click'); await app.signIn();
  assert.equal(app.requests.length, 3);
  assert.equal(app.requests.at(-1).url, `${serviceBase}/api/targets/${target.id}/status`);
  assert.deepEqual(app.navigations, []);
  app.response(app.requests.at(-1), { id: target.id, status: { state: 'Okay' }, checkedAt: new Date(NOW).toISOString() }); await flush();
  assert.equal(app.navigations.length, 1);
});

test('NWA immediately opens a suitable backend-checked target without another request', async () => {
  const app = fixture();
  await app.signIn([
    { ...target, id: 10001, estimatedStats: 100_000, faction: player.faction },
    { ...target, id: 10002, estimatedStats: 100_000, estimateUpdatedAt: NOW / 1000 - 8 * 86400 },
    { ...target, id: 10003, estimatedStats: null },
    { ...target, id: 10004, estimatedStats: 900_000 },
    { ...target, checkedAt: new Date(NOW).toISOString() },
  ]);
  const before = app.requests.length;
  app.button('NWA').emit('click');
  assert.equal(app.requests.length, before, 'the fresh authorized availability cache needs no network round trip');
  assert.deepEqual(app.navigations, [`https://www.torn.com/page.php?sid=attack&user2ID=${target.id}`]);
  assert.equal(app.requests.length, before, 'opening the attack page does not send an attack request');
});

test('NWA skips unavailable, newly friendly, and removed targets before opening the next live match', async () => {
  const app = fixture();
  const candidates = Array.from({ length: 5 }, (_, index) => ({ ...target, id: 20001 + index, estimatedStats: 100_000 + index * 10_000 }));
  await app.signIn(candidates);
  app.button('NWA').emit('click');
  const outcomes = [
    [{ id: candidates[0].id, status: { state: 'Hospital' }, checkedAt: new Date(NOW).toISOString() }, 200],
    [{ id: candidates[1].id, status: { state: 'Traveling' }, checkedAt: new Date(NOW).toISOString() }, 200],
    [{ error: { code: 'FRIENDLY_TARGET', message: 'This target is now friendly.' } }, 403],
    [{ error: { code: 'TARGET_NOT_FOUND', message: 'This target is no longer in the pool.' } }, 404],
  ];
  for (let index = 0; index < outcomes.length; index++) {
    assert.equal(app.requests.at(-1).url, `${serviceBase}/api/targets/${candidates[index].id}/status`);
    app.response(app.requests.at(-1), ...outcomes[index]); await flush();
    assert.deepEqual(app.navigations, []);
  }
  assert.equal(app.requests.at(-1).url, `${serviceBase}/api/targets/${candidates[4].id}/status`);
  app.response(app.requests.at(-1), { id: candidates[4].id, status: { state: 'Okay' }, checkedAt: new Date(NOW).toISOString() });
  await flush();
  assert.deepEqual(app.navigations, [`https://www.torn.com/page.php?sid=attack&user2ID=${candidates[4].id}`]);
  assert.equal(app.storage.get(app.storageKey).token, SESSION);
});

test('repeated NWA clicks coalesce while a target check is pending', async () => {
  const app = fixture(); await app.signIn(); const before = app.requests.length;
  const launcher = app.button('NWA'); launcher.emit('click'); launcher.emit('click'); launcher.emit('click');
  assert.equal(app.requests.length, before + 1);
  app.response(app.requests.at(-1), { id: target.id, status: { state: 'Okay' }, checkedAt: new Date(NOW).toISOString() });
  await flush();
  assert.equal(app.navigations.length, 1);
});

test('NWA stops on rate limits and service failures that are not isolated target lookups', async () => {
  for (const outcome of ['rate-limit', 'upstream']) {
    const app = fixture(); await app.signIn([target, { ...target, id: target.id + 1 }]);
    const before = app.requests.length; app.button('NWA').emit('click'); const live = app.requests.at(-1);
    app.response(live, { error: { code: outcome === 'rate-limit' ? 'RATE_LIMITED' : 'UPSTREAM_UNAVAILABLE', message: 'Try again later.' } }, outcome === 'rate-limit' ? 429 : 503);
    await flush();
    assert.equal(app.requests.length, before + 1, outcome);
    assert.deepEqual(app.navigations, [], outcome);
    assert.equal(app.storage.get(app.storageKey).token, SESSION, outcome);
    assert.equal(app.find(element => element.className === 'quick-notice').hidden, false, 'failure is shown beside NWA');
    assert.equal(app.button('NWA').disabled, false);
  }
});

test('NWA skips isolated lookup and network failures and succeeds with the next target', async () => {
  for (const outcome of ['torn', 'torn503', 'targets', 'network', 'timeout']) {
    const app = fixture(); await app.signIn([target, { ...target, id: target.id + 1 }]);
    const before = app.requests.length; app.button('NWA').emit('click'); const first = app.requests.at(-1);
    assert.equal(first.timeout, 3000);
    if (outcome === 'network') first.onerror();
    else if (outcome === 'timeout') { app.setNow(NOW + 3000); first.ontimeout(); }
    else app.response(first, { error: { code: outcome.startsWith('torn') ? 'TORN_UNAVAILABLE' : 'TARGETS_UNAVAILABLE', message: 'Temporary target lookup failure.' } }, outcome === 'torn' ? 502 : 503);
    await flush();
    assert.equal(app.requests.length, before + 2, outcome);
    const next = app.requests.at(-1);
    assert.equal(next.url, `${serviceBase}/api/targets/${target.id + 1}/status`);
    app.response(next, { id: target.id + 1, status: { state: 'Okay' }, checkedAt: new Date(outcome === 'timeout' ? NOW + 3000 : NOW).toISOString() }); await flush();
    assert.deepEqual(app.navigations, [`https://www.torn.com/page.php?sid=attack&user2ID=${target.id + 1}`]);
    assert.equal(app.storage.get(app.storageKey).token, SESSION);
  }
});

test('NWA limits candidate attempts to the remaining eight-second request budget', async () => {
  const app = fixture(); await app.signIn(Array.from({ length: 5 }, (_, index) => ({ ...target, id: target.id + index })));
  const before = app.requests.length; app.button('NWA').emit('click');
  for (const [elapsed, expectedTimeout] of [[3000, 3000], [6000, 3000], [8000, 2000]]) {
    const request = app.requests.at(-1);
    assert.equal(request.timeout, expectedTimeout);
    assert.equal([...app.timeoutDelays.values()].at(-1), expectedTimeout);
    app.setNow(NOW + elapsed); request.ontimeout(); await flush();
  }
  assert.equal(app.requests.length, before + 3);
  assert.deepEqual(app.navigations, []);
  assert.equal(app.button('NWA').disabled, false);
});

test('a stale feed refresh uses part of the same eight-second finder budget', async () => {
  const app = fixture(); await app.signIn();
  app.setNow(NOW + 30000); app.button('NWA').emit('click');
  const feed = app.requests.at(-1);
  assert.equal(feed.url, `${serviceBase}/api/targets`);
  assert.equal(feed.timeout, 5000);
  app.setNow(NOW + 35000);
  app.response(feed, { player, targets: [target], warnings: [] }); await flush();
  assert.equal(app.requests.at(-1).url, `${serviceBase}/api/targets/${target.id}/status`);
  assert.equal(app.requests.at(-1).timeout, 3000);
  app.setNow(NOW + 38000); app.requests.at(-1).ontimeout(); await flush();
  assert.deepEqual(app.navigations, []);
  assert.equal(app.button('NWA').disabled, false);
});

test('joining a slow startup feed has an eight-second finder deadline and late feed completion cannot navigate', async () => {
  const app = fixture({ token: SESSION, expiresAt: new Date(NOW + 3600000).toISOString() });
  const feed = app.requests[0]; app.button('NWA').emit('click');
  const timer = [...app.timeoutDelays].find(([, delay]) => delay === 8000)?.[0];
  assert.ok(timer, 'shared background feed has a separate bounded finder wait');
  app.setNow(NOW + 8000); app.timeouts.get(timer)(); await flush();
  assert.equal(app.button('NWA').disabled, false);
  assert.deepEqual(app.navigations, []);
  assert.match(app.text(), /within 8 seconds/);
  app.response(feed, { player, targets: [{ ...target, checkedAt: new Date(NOW + 8000).toISOString() }], warnings: [] }); await flush();
  assert.deepEqual(app.navigations, []);
});

test('reservation-aware NWA waits for a successful lease even when the cached target is ready', async () => {
  const app = fixture(); await app.signIn([{ ...target, checkedAt: new Date(NOW).toISOString() }], { reservations: { supported: true, leaseMs: 60000 } });
  const before = app.requests.length; app.button('NWA').emit('click');
  assert.equal(app.requests.length, before + 1);
  const lease = app.requests.at(-1);
  assert.equal(lease.method, 'POST');
  assert.equal(lease.url, `${serviceBase}/api/targets/${target.id}/reservation`);
  assert.equal(lease.headers.Authorization, `Bearer ${SESSION}`);
  assert.deepEqual(app.navigations, []);
  app.response(lease, { id: target.id, status: { state: 'Okay' }, checkedAt: new Date(NOW).toISOString(), reservationExpiresAt: new Date(NOW + 60000).toISOString() }); await flush();
  assert.deepEqual(app.navigations, [`https://www.torn.com/page.php?sid=attack&user2ID=${target.id}`]);
  assert.deepEqual(JSON.parse(JSON.stringify(app.storage.get(app.preferencesKey).recentTargets)), [{ id: target.id, at: NOW }]);
});

test('reservation conflicts and unavailable targets advance without losing the session or revisiting the conflict', async () => {
  const targets = Array.from({ length: 3 }, (_, index) => ({ ...target, id: target.id + index }));
  const app = fixture(); await app.signIn(targets, { reservations: { supported: true, leaseMs: 60000 } });
  app.button('NWA').emit('click');
  for (const [index, code] of ['TARGET_RESERVED', 'TARGET_UNAVAILABLE'].entries()) {
    assert.equal(app.requests.at(-1).url, `${serviceBase}/api/targets/${targets[index].id}/reservation`);
    app.response(app.requests.at(-1), { error: { code, message: 'Try another player.' } }, 409); await flush();
    assert.deepEqual(app.navigations, []);
  }
  app.response(app.requests.at(-1), { id: targets[2].id, status: { state: 'Okay' }, checkedAt: new Date(NOW).toISOString(), reservationExpiresAt: new Date(NOW + 60000).toISOString() }); await flush();
  assert.equal(app.navigations.length, 1);
  assert.equal(app.storage.get(app.storageKey).token, SESSION);
  const before = app.requests.length; app.button('NWA').emit('click'); await flush();
  assert.equal(app.requests.length, before, 'conflicts remain excluded and the successful target is recent');
  assert.match(app.text(), /last 10 minutes/);
});

test('reservation responses must identify the requested target, have a live lease and still show an eligible available player', async () => {
  for (const failure of ['wrong-id', 'missing-lease', 'expired-lease', 'hospital', 'friendly']) {
    const app = fixture(); await app.signIn([target], { reservations: { supported: true, leaseMs: 60000 } });
    app.button('NWA').emit('click');
    const response = { id: target.id, status: { state: 'Okay' }, checkedAt: new Date(NOW).toISOString(), reservationExpiresAt: new Date(NOW + 60000).toISOString() };
    if (failure === 'wrong-id') response.id += 1;
    if (failure === 'missing-lease') delete response.reservationExpiresAt;
    if (failure === 'expired-lease') response.reservationExpiresAt = new Date(NOW).toISOString();
    if (failure === 'hospital') response.status = { state: 'Hospital', until: NOW / 1000 + 60 };
    if (failure === 'friendly') response.faction = player.faction;
    app.response(app.requests.at(-1), response); await flush();
    assert.deepEqual(app.navigations, [], failure);
    assert.equal(app.storage.get(app.preferencesKey)?.recentTargets?.length ?? 0, 0);
    assert.equal(app.button('NWA').disabled, false);
  }
});

test('an in-flight reservation cannot navigate after logout, expiry or opening settings', async () => {
  for (const action of ['logout', 'expiry', 'settings']) {
    const app = fixture(); await app.signIn([target], { reservations: { supported: true, leaseMs: 60000 } });
    app.button('NWA').emit('click'); const lease = app.requests.at(-1);
    if (action === 'logout') await app.signOut();
    if (action === 'expiry') app.setNow(NOW + 3600000);
    if (action === 'settings') app.settings().emit('click');
    app.response(lease, { id: target.id, status: { state: 'Okay' }, checkedAt: new Date(NOW).toISOString(), reservationExpiresAt: new Date(NOW + 60000).toISOString() }); await flush();
    assert.deepEqual(app.navigations, [], action);
    assert.equal(app.storage.get(app.preferencesKey)?.recentTargets?.length ?? 0, 0);
  }
});

test('authorization and rate-limit failures stop reservation retries immediately', async () => {
  for (const [status, code] of [[401, 'SESSION_EXPIRED'], [403, 'FACTION_NOT_ALLOWED'], [429, 'RATE_LIMITED']]) {
    const app = fixture(); await app.signIn([target, { ...target, id: target.id + 1 }], { reservations: { supported: true, leaseMs: 60000 } });
    const before = app.requests.length; app.button('NWA').emit('click');
    app.response(app.requests.at(-1), { error: { code, message: 'Access temporarily unavailable.' } }, status); await flush();
    assert.equal(app.requests.length, before + 1, code);
    assert.deepEqual(app.navigations, [], code);
    assert.equal(app.storage.has(app.storageKey), status === 429);
  }
});

test('recent target history rotates across reloads and never silently recycles a depleted pool', async () => {
  const ready = { ...target, checkedAt: new Date(NOW).toISOString() };
  const targets = [ready, { ...ready, id: ready.id + 1 }, { ...ready, id: ready.id + 2 }];
  let app = fixture(); await app.signIn(targets);
  for (let index = 0; index < 3; index++) {
    app.button('NWA').emit('click'); await flush();
    assert.deepEqual(app.navigations, [`https://www.torn.com/page.php?sid=attack&user2ID=${targets[index].id}`]);
    const prefs = app.storage.get(app.preferencesKey);
    app = fixture(null, prefs); await app.signIn(targets);
  }
  const before = app.requests.length; app.button('NWA').emit('click'); await flush();
  assert.equal(app.requests.length, before);
  assert.deepEqual(app.navigations, []);
  assert.match(app.text(), /last 10 minutes/);
});

test('clear recent targets explicitly restores a depleted finder pool', async () => {
  const ready = { ...target, checkedAt: new Date(NOW).toISOString() };
  const app = fixture(null, { recentTargets: [{ id: target.id, at: NOW }], lastTargetId: target.id });
  await app.signIn([ready]);
  app.button('NWA').emit('click'); await flush();
  assert.deepEqual(app.navigations, []);
  app.button('Clear recent targets').emit('click');
  assert.deepEqual([...app.storage.get(app.preferencesKey).recentTargets], []);
  assert.equal(app.storage.get(app.preferencesKey).lastTargetId, null);
  app.button('NWA').emit('click'); await flush();
  assert.deepEqual(app.navigations, [`https://www.torn.com/page.php?sid=attack&user2ID=${target.id}`]);
});

test('estimate-age controls validate integer days, persist preferences and allow an older target after reload', async () => {
  const old = { ...target, estimateUpdatedAt: NOW / 1000 - 20 * 86400, checkedAt: new Date(NOW).toISOString() };
  const app = fixture(); await app.signIn([old]);
  const ageInput = () => app.find(element => element.attributes.get('aria-label') === 'Maximum estimate age in days');
  assert.equal(ageInput().value, '7');
  assert.equal(ageInput().min, '1'); assert.equal(ageInput().max, '365'); assert.equal(ageInput().step, '1');
  assert.match(app.text(), /Estimate too old \/ undated/);
  for (const value of ['', '0', '366', '2.5', 'NaN', 'Infinity']) {
    ageInput().value = value; ageInput().emit('change');
    assert.equal(ageInput().value, '7', value);
    assert.equal(app.storage.has(app.preferencesKey), false);
    assert.match(app.text(), /whole number from 1 to 365/);
  }
  ageInput().value = '28'; ageInput().emit('change');
  assert.equal(app.storage.get(app.preferencesKey).estimateDays, 28);
  assert.match(app.text(), /Possible match/);
  assert.equal(app.requests.length, 2, 'changing the estimate window filters in RAM');
  const reloaded = fixture(null, app.storage.get(app.preferencesKey)); await reloaded.signIn([old]);
  assert.equal(reloaded.find(element => element.attributes.get('aria-label') === 'Maximum estimate age in days').value, '28');
  reloaded.button('NWA').emit('click'); await flush();
  assert.deepEqual(reloaded.navigations, [`https://www.torn.com/page.php?sid=attack&user2ID=${target.id}`]);
  ageInput().value = '365'; ageInput().emit('change');
  assert.match(app.text(), /Extra caution is needed beyond 28 days/);
});

test('invalid stored estimate windows return to seven days', async () => {
  for (const estimateDays of [0, 366, -1, 2.5, '28', null]) {
    const app = fixture(null, { estimateDays }); await app.signIn();
    assert.equal(app.find(element => element.attributes.get('aria-label') === 'Maximum estimate age in days').value, '7');
  }
});

test('changing the estimate-age window cancels an in-flight finder before navigation', async () => {
  const app = fixture(); await app.signIn([target], { reservations: { supported: true, leaseMs: 60000 } });
  app.button('NWA').emit('click'); const lease = app.requests.at(-1);
  const age = app.find(element => element.attributes.get('aria-label') === 'Maximum estimate age in days');
  age.value = '28'; age.emit('change');
  app.response(lease, { id: target.id, status: { state: 'Okay' }, checkedAt: new Date(NOW).toISOString(), reservationExpiresAt: new Date(NOW + 60000).toISOString() }); await flush();
  assert.deepEqual(app.navigations, []);
  assert.equal(app.storage.get(app.preferencesKey).estimateDays, 28);
});

test('pool diagnostics distinguish old estimates, unknown stats and ready matches without counting allies in range', async () => {
  const app = fixture(); await app.signIn([
    { ...target, checkedAt: new Date(NOW).toISOString() },
    { ...target, id: 20001, estimateUpdatedAt: NOW / 1000 - 8 * 86400 },
    { ...target, id: 20002, estimatedStats: null, estimateUpdatedAt: null },
    { ...target, id: 20003, estimatedStats: 1000 },
    { ...target, id: 20004, faction: player.faction },
  ]);
  assert.match(app.text(), /2 in stat range · 1 estimates too old or undated · 1 stats unknown · 1 ready now/);
});

test('target cards display and search approved reasons rather than legacy notes', async () => {
  const app = fixture(); await app.signIn([{ ...target, reason: '<img> Alliance attacks', notes: 'Legacy notes only' }]);
  assert.match(app.text(), /Reason: <img> Alliance attacks/);
  assert.doesNotMatch(app.text(), /Legacy notes only/);
  assert.equal(descendants(app.root).some(element => element.tagName === 'IMG'), false);
  const search = app.find(element => element.tagName === 'INPUT' && element.type === 'search');
  search.value = 'ALLIANCE ATTACKS'; search.emit('input');
  assert.equal(descendants(app.root).filter(element => element.className === 'card').length, 1);
  search.value = 'Legacy notes'; search.emit('input');
  assert.equal(descendants(app.root).filter(element => element.className === 'card').length, 0);
});

test('manual attack buttons reserve a fresh target before navigating and remember it', async () => {
  const app = fixture(); await app.signIn([{ ...target, checkedAt: new Date(NOW).toISOString() }], { reservations: { supported: true, leaseMs: 60000 } });
  const attack = app.find(element => element.className === 'attack');
  assert.equal(attack.tagName, 'BUTTON');
  attack.emit('click'); const lease = app.requests.at(-1);
  assert.equal(lease.method, 'POST');
  assert.equal(lease.url, `${serviceBase}/api/targets/${target.id}/reservation`);
  assert.deepEqual(app.navigations, []);
  app.response(lease, { id: target.id, status: { state: 'Okay' }, checkedAt: new Date(NOW).toISOString(), reservationExpiresAt: new Date(NOW + 60000).toISOString() }); await flush();
  assert.deepEqual(app.navigations, [`https://www.torn.com/page.php?sid=attack&user2ID=${target.id}`]);
  assert.equal(app.storage.get(app.preferencesKey).recentTargets[0].id, target.id);
});

test('a manual attack lease cannot navigate after a short-lived session expires between click and response', async () => {
  const app = fixture({ token: SESSION, expiresAt: new Date(NOW + 1000).toISOString() });
  app.response(app.requests[0], { player, targets: [{ ...target, checkedAt: new Date(NOW).toISOString() }], warnings: [], reservations: { supported: true, leaseMs: 60000 } }); await flush();
  app.settings().emit('click');
  app.find(element => element.className === 'attack').emit('click'); const lease = app.requests.at(-1);
  app.setNow(NOW + 1001);
  app.response(lease, { id: target.id, status: { state: 'Okay' }, checkedAt: new Date(NOW + 1001).toISOString(), reservationExpiresAt: new Date(NOW + 60000).toISOString() }); await flush();
  assert.deepEqual(app.navigations, []);
  assert.equal(app.storage.get(app.preferencesKey)?.recentTargets?.length ?? 0, 0);
});

test('NWA bounds unavailable-target checks to five per click', async () => {
  const app = fixture();
  const candidates = Array.from({ length: 6 }, (_, index) => ({ ...target, id: 30001 + index, estimatedStats: 100_000 + index * 10_000 }));
  await app.signIn(candidates); const before = app.requests.length; app.button('NWA').emit('click');
  for (let index = 0; index < 5; index++) {
    assert.equal(app.requests.at(-1).url, `${serviceBase}/api/targets/${candidates[index].id}/status`);
    app.response(app.requests.at(-1), { id: candidates[index].id, status: { state: 'Hospital' }, checkedAt: new Date(NOW).toISOString() });
    await flush();
  }
  assert.equal(app.requests.length, before + 5);
  assert.deepEqual(app.navigations, []);
  assert.equal(app.button('NWA').disabled, false);
  assert.equal(app.find(element => element.className === 'quick-notice').hidden, false);
  app.button('NWA').emit('click');
  assert.equal(app.requests.length, before + 6, 'the next click advances beyond the recently unavailable first five');
  assert.equal(app.requests.at(-1).url, `${serviceBase}/api/targets/${candidates[5].id}/status`);
  app.response(app.requests.at(-1), { id: candidates[5].id, status: { state: 'Okay' }, checkedAt: new Date(NOW).toISOString() }); await flush();
  assert.deepEqual(app.navigations, [`https://www.torn.com/page.php?sid=attack&user2ID=${candidates[5].id}`]);
});

test('a restored session loads an authorized pool before NWA checks a target', async () => {
  const app = fixture({ token: SESSION, expiresAt: new Date(NOW + 3_600_000).toISOString() });
  app.button('NWA').emit('click'); app.button('NWA').emit('click');
  assert.equal(app.requests.length, 1);
  assert.equal(app.requests[0].url, `${serviceBase}/api/targets`);
  assert.deepEqual(app.navigations, []);
  app.response(app.requests[0], { player, targets: [target], warnings: [] }); await flush();
  assert.equal(app.requests.length, 2);
  assert.equal(app.requests[1].url, `${serviceBase}/api/targets/${target.id}/status`);
  app.response(app.requests[1], { id: target.id, status: { state: 'Okay' }, checkedAt: new Date(NOW).toISOString() });
  await flush();
  assert.equal(app.navigations.length, 1);
});

test('clicking NWA during startup preload resumes once using the fresh feed without opening settings', async () => {
  const app = fixture({ token: SESSION, expiresAt: new Date(NOW + 3_600_000).toISOString() });
  assert.equal(app.requests.length, 1);
  assert.equal(app.button('NWA').disabled, false);
  app.button('NWA').emit('click'); app.button('NWA').emit('click');
  assert.equal(app.requests.length, 1, 'clicks share the startup feed request');
  assert.deepEqual(app.navigations, []);
  app.response(app.requests[0], { player, targets: [{ ...target, checkedAt: new Date(NOW).toISOString() }], warnings: [] });
  await flush();
  assert.deepEqual(app.navigations, [`https://www.torn.com/page.php?sid=attack&user2ID=${target.id}`]);
  assert.equal(app.requests.length, 1);
  assert.equal(app.find(element => element.className === 'panel').hidden, true);
  assert.deepEqual(Object.keys(app.storage.get(app.storageKey)).sort(), ['expiresAt', 'token']);
});

test('ready cached targets rank before unchecked lower-stat targets and rotate away from the previous target', async () => {
  const unchecked = { ...target, id: 11001, estimatedStats: 10_000 };
  const ready = { ...target, id: 11002, checkedAt: new Date(NOW).toISOString() };
  const nextReady = { ...ready, id: 11003 };
  const app = fixture(null, { maxRatio: 0.6, lastTargetId: ready.id });
  await app.signIn([unchecked, ready, nextReady]);
  const before = app.requests.length; app.button('NWA').emit('click');
  assert.deepEqual(app.navigations, [`https://www.torn.com/page.php?sid=attack&user2ID=${nextReady.id}`]);
  assert.equal(app.requests.length, before);
  assert.equal(app.storage.get(app.preferencesKey).lastTargetId, nextReady.id);
});

test('an exactly thirty-second-old target check requires a new status request', async () => {
  const app = fixture();
  await app.signIn([{ ...target, checkedAt: new Date(NOW - 30_000).toISOString() }]);
  const before = app.requests.length; app.button('NWA').emit('click');
  assert.equal(app.requests.length, before + 1);
  assert.equal(app.requests.at(-1).url, `${serviceBase}/api/targets/${target.id}/status`);
  assert.deepEqual(app.navigations, []);
});

test('an exactly thirty-second-old authorized feed is refreshed before using even a newer cached status', async () => {
  const checkedTarget = { ...target, checkedAt: new Date(NOW + 1000).toISOString() };
  const app = fixture(); await app.signIn([checkedTarget]);
  app.setNow(NOW + 30_000); const before = app.requests.length; app.button('NWA').emit('click');
  assert.equal(app.requests.length, before + 1);
  assert.equal(app.requests.at(-1).url, `${serviceBase}/api/targets`);
  assert.deepEqual(app.navigations, []);
  app.response(app.requests.at(-1), { player, targets: [{ ...checkedTarget, checkedAt: new Date(NOW + 30_000).toISOString() }], warnings: [] });
  await flush();
  assert.equal(app.requests.length, before + 1);
  assert.deepEqual(app.navigations, [`https://www.torn.com/page.php?sid=attack&user2ID=${target.id}`]);
});

test('known future hospital timers are skipped even after their check has become stale', async () => {
  const hospitalized = { ...target, id: 12001, estimatedStats: 10_000,
    status: { state: 'Hospital', until: NOW / 1000 + 600 }, checkedAt: new Date(NOW - 60_000).toISOString() };
  const app = fixture(); await app.signIn([hospitalized, target]);
  const before = app.requests.length; app.button('NWA').emit('click');
  assert.equal(app.requests.length, before + 1);
  assert.equal(app.requests.at(-1).url, `${serviceBase}/api/targets/${target.id}/status`);
  app.response(app.requests.at(-1), { id: target.id, status: { state: 'Okay' }, checkedAt: new Date(NOW).toISOString() }); await flush();
  assert.deepEqual(app.navigations, [`https://www.torn.com/page.php?sid=attack&user2ID=${target.id}`]);
});

test('an ended hospital timer still needs a new Okay check before opening an attack', async () => {
  const app = fixture(); await app.signIn([{ ...target, status: { state: 'Hospital', until: NOW / 1000 - 1 },
    checkedAt: new Date(NOW - 30_000).toISOString() }]);
  app.button('NWA').emit('click');
  assert.equal(app.requests.at(-1).url, `${serviceBase}/api/targets/${target.id}/status`);
  assert.deepEqual(app.navigations, []);
  app.response(app.requests.at(-1), { id: target.id, status: { state: 'Hospital', until: NOW / 1000 - 1 }, checkedAt: new Date(NOW).toISOString() }); await flush();
  assert.deepEqual(app.navigations, []);
});

test('visible pages refresh the feed every ten seconds without hiding the target list or automatically navigating', async () => {
  const app = fixture(); await app.signIn([{ ...target, checkedAt: new Date(NOW).toISOString() }]);
  app.settings().emit('click');
  const before = app.requests.length;
  app.setNow(NOW + 9_999); app.timers[0]();
  assert.equal(app.requests.length, before);
  app.setNow(NOW + 10_000); app.timers[0]();
  assert.equal(app.requests.length, before + 1);
  assert.equal(app.requests.at(-1).url, `${serviceBase}/api/targets`);
  assert.match(app.text(), /Target Player \[98765\]/);
  assert.equal(app.button('NWA').disabled, false);
  app.timers[0]();
  assert.equal(app.requests.length, before + 1, 'an in-flight background sync is shared');
  app.response(app.requests.at(-1), { player, targets: [{ ...target, name: 'Refreshed Target', checkedAt: new Date(NOW + 10_000).toISOString() }], warnings: [] }); await flush();
  assert.match(app.text(), /Refreshed Target/);
  assert.deepEqual(app.navigations, []);
  const refreshed = app.requests.length; app.button('NWA').emit('click');
  assert.equal(app.requests.length, refreshed);
  assert.equal(app.navigations.length, 1);
});

test('NWA joins an expired-cache background refresh and resumes with its fresh target', async () => {
  const app = fixture(); await app.signIn([{ ...target, checkedAt: new Date(NOW).toISOString() }]);
  app.setNow(NOW + 30_000); app.timers[0]();
  const background = app.requests.at(-1); const before = app.requests.length;
  app.button('NWA').emit('click'); app.button('NWA').emit('click');
  assert.equal(app.requests.length, before);
  assert.deepEqual(app.navigations, []);
  app.response(background, { player, targets: [{ ...target, checkedAt: new Date(NOW + 30_000).toISOString() }], warnings: [] }); await flush();
  assert.equal(app.requests.length, before);
  assert.equal(app.navigations.length, 1);
});

test('hidden pages do not preload or poll and refresh once when Torn becomes visible', async () => {
  const app = fixture({ token: SESSION, expiresAt: new Date(NOW + 3_600_000).toISOString() }, null, null, NOW, 'hidden');
  assert.equal(app.requests.length, 0);
  app.setNow(NOW + 60_000); app.timers[0]();
  assert.equal(app.requests.length, 0);
  app.setVisibility('visible'); app.setVisibility('visible');
  assert.equal(app.requests.length, 1);
  app.response(app.requests[0], { player, targets: [{ ...target, checkedAt: new Date(NOW + 60_000).toISOString() }], warnings: [] }); await flush();
  app.setVisibility('hidden'); app.setNow(NOW + 120_000); app.timers[0]();
  assert.equal(app.requests.length, 1);
  app.setVisibility('visible');
  assert.equal(app.requests.length, 2);
  assert.match(app.text(), /Target Player/);
  assert.deepEqual(app.navigations, []);
});

test('a failed background authorization attempt keeps browsing data but blocks the instant path until recovery', async () => {
  const cached = { ...target, checkedAt: new Date(NOW).toISOString() };
  const app = fixture(); await app.signIn([cached]);
  app.settings().emit('click');
  app.setVisibility('hidden'); app.setNow(NOW + 1000); app.setVisibility('visible');
  app.response(app.requests.at(-1), { error: { code: 'UPSTREAM_UNAVAILABLE', message: 'Cannot verify access right now.' } }, 503); await flush();
  assert.match(app.text(), /Target Player/);
  assert.equal(app.storage.get(app.storageKey).token, SESSION);
  assert.equal(descendants(app.root).some(element => element.className === 'attack'), false);
  const before = app.requests.length; app.button('NWA').emit('click');
  assert.equal(app.requests.length, before + 1);
  assert.equal(app.requests.at(-1).url, `${serviceBase}/api/targets`);
  assert.deepEqual(app.navigations, []);
  app.response(app.requests.at(-1), { player, targets: [cached], warnings: [] }); await flush();
  assert.equal(app.navigations.length, 1);
});

test('background faction denial revokes access and a background response cannot restore a signed-out session', async () => {
  for (const action of ['denial', 'logout']) {
    const app = fixture(); await app.signIn([{ ...target, checkedAt: new Date(NOW).toISOString() }]);
    app.setNow(NOW + 30_000); app.timers[0](); const background = app.requests.at(-1);
    if (action === 'denial') app.response(background, { error: { code: 'FACTION_NOT_ALLOWED', message: 'Faction access revoked.' } }, 403);
    else { await app.signOut(); app.response(background, { player, targets: [target], warnings: [] }); }
    await flush();
    assert.equal(app.storage.has(app.storageKey), false);
    assert.equal(descendants(app.root).some(element => element.className === 'card'), false);
    assert.deepEqual(app.navigations, []);
  }
});

test('a due background poll does not interrupt a manual target check selection', async () => {
  const app = fixture(); await app.signIn(); app.button('NWA').emit('click'); const live = app.requests.at(-1);
  const before = app.requests.length; app.setNow(NOW + 30_000); app.timers[0]();
  assert.equal(app.requests.length, before);
  app.response(live, { id: target.id, status: { state: 'Okay' }, checkedAt: new Date(NOW + 30_000).toISOString() }); await flush();
  assert.equal(app.navigations.length, 1);
});

test('an older explicit status response cannot overwrite a newly refreshed target pool', async () => {
  const app = fixture(); await app.signIn(); app.button('Check status').emit('click');
  const older = app.requests.at(-1);
  app.button('Refresh list').emit('click');
  app.response(app.requests.at(-1), { player, targets: [{ ...target, status: { state: 'Hospital', until: NOW / 1000 + 600 },
    checkedAt: new Date(NOW).toISOString() }], warnings: [] }); await flush();
  app.response(older, { id: target.id, status: { state: 'Okay' }, checkedAt: new Date(NOW).toISOString() }); await flush();
  assert.match(app.text(), /Hospital/);
  assert.equal(descendants(app.root).some(element => element.className === 'attack'), false);
  assert.equal(app.button('Check status').disabled, false, 'the obsolete status check still releases its pending control');
});

test('a mismatched explicit status response cannot mark another target available', async () => {
  const app = fixture(); await app.signIn(); app.button('Check status').emit('click');
  app.response(app.requests.at(-1), { id: target.id + 1, status: { state: 'Okay' }, checkedAt: new Date(NOW).toISOString() }); await flush();
  assert.match(app.text(), /could not verify/);
  assert.equal(descendants(app.root).some(element => element.className === 'attack'), false);
});

test('background feed refreshes preserve focused search and unfinished stat-limit controls', async () => {
  for (const control of ['search', 'minimum', 'maximum']) {
    const app = fixture(); await app.signIn(); app.settings().emit('click');
    const focused = app.find(element => control === 'search' ? element.type === 'search'
      : element.attributes.get('aria-label') === `${control === 'minimum' ? 'Minimum' : 'Maximum'} target stats as percent of your total`);
    focused.value = control === 'search' ? 'Target' : '4';
    if (control === 'search') focused.emit('input');
    app.root.activeElement = focused;
    app.setNow(NOW + 10_000); app.timers[0]();
    assert.equal(app.find(element => element === focused), focused, 'starting a sync keeps the original control');
    const updatedPlayer = { ...player, name: 'Updated Allowed Player' };
    app.response(app.requests.at(-1), { player: updatedPlayer, targets: [{ ...target, name: 'Refreshed Target',
      checkedAt: new Date(NOW + 10_000).toISOString() }], warnings: [] }); await flush();
    assert.equal(app.root.activeElement, focused);
    assert.equal(app.find(element => element === focused), focused, 'completing a sync keeps the focused control');
    assert.equal(focused.value, control === 'search' ? 'Target' : '4');
    assert.match(app.text(), /Refreshed Target/, 'availability cards still refresh while the control is focused');
    assert.match(app.text(), /Allowed Player \[12345\]/);
    assert.doesNotMatch(app.text(), /Updated Allowed Player/);
    app.root.activeElement = null; app.root.emit('focusout');
    [...app.timeouts.values()].at(-1)();
    assert.match(app.text(), /Updated Allowed Player/, 'deferred profile changes render after editing ends');
  }
});

test('background feed refreshes retain the focused suggestion textarea and its draft', async () => {
  const app = fixture(); await app.signIn(); app.settings().emit('click');
  await openSuggestions(app, { canReview: false, suggestions: [] });
  const textarea = app.find(element => element.tagName === 'TEXTAREA');
  textarea.value = 'An unfinished reason with the cursor still here'; textarea.emit('input');
  app.root.activeElement = textarea;
  app.setNow(NOW + 10_000); app.timers[0]();
  assert.equal(app.find(element => element.tagName === 'TEXTAREA'), textarea);
  app.response(app.requests.at(-1), { player, targets: [target], warnings: [] }); await flush();
  assert.equal(app.find(element => element.tagName === 'TEXTAREA'), textarea);
  assert.equal(app.root.activeElement, textarea);
  assert.equal(textarea.value, 'An unfinished reason with the cursor still here');
  app.root.activeElement = null; app.root.emit('focusout'); [...app.timeouts.values()].at(-1)();
  assert.equal(app.find(element => element.tagName === 'TEXTAREA').value, 'An unfinished reason with the cursor still here');
});

test('a closed settings panel is not rebuilt by background refresh and shows current data when opened', async () => {
  const app = fixture(); await app.signIn();
  const oldProfile = app.find(element => element.className === 'profile');
  app.setNow(NOW + 10_000); app.timers[0]();
  app.response(app.requests.at(-1), { player: { ...player, name: 'Updated Allowed Player' },
    targets: [{ ...target, name: 'Refreshed Target' }], warnings: [] }); await flush();
  assert.equal(app.find(element => element.className === 'profile'), oldProfile);
  assert.equal(app.find(element => element.className === 'panel').hidden, true);
  assert.doesNotMatch(app.text(), /Refreshed Target/);
  app.settings().emit('click');
  assert.match(app.text(), /Updated Allowed Player/);
  assert.match(app.text(), /Refreshed Target/);
});

test('background polling and visibility refresh defer while an explicit status check is pending', async () => {
  const app = fixture(); await app.signIn(); app.settings().emit('click'); app.button('Check status').emit('click');
  const live = app.requests.at(-1); const before = app.requests.length;
  app.setNow(NOW + 10_000); app.timers[0](); app.setVisibility('hidden'); app.setVisibility('visible');
  assert.equal(app.requests.length, before, 'neither a timer nor a visibility event invalidates the pending check');
  app.response(live, { id: target.id, status: { state: 'Okay' }, checkedAt: new Date(NOW + 10_000).toISOString() }); await flush();
  assert.equal(descendants(app.root).some(element => element.className === 'attack'), true);
  app.timers[0]();
  assert.equal(app.requests.length, before + 1);
  assert.equal(app.requests.at(-1).url, `${serviceBase}/api/targets`);
});

test('NWA explains when the pool has no fresh target within the stat limit', async () => {
  const tooStrong = { ...target, estimatedStats: 700_000 };
  const app = fixture(); await app.signIn([tooStrong]);
  const before = app.requests.length; app.button('NWA').emit('click'); await flush();
  assert.equal(app.requests.length, before + 1);
  assert.equal(app.requests.at(-1).url, `${serviceBase}/api/targets`);
  app.response(app.requests.at(-1), { player, targets: [tooStrong], warnings: [] }); await flush();
  assert.equal(app.requests.length, before + 1, 'no-match recovery refreshes the pool only once per click');
  assert.deepEqual(app.navigations, []);
  assert.equal(app.find(element => element.className === 'quick-notice').hidden, false);
  assert.match(app.text(), /no.*match|no.*target.*limit/i);
});

test('NWA recovers an empty or unknown-stat pool after background estimates become available', async () => {
  for (const oldPool of [[], [{ ...target, estimatedStats: null, estimateUpdatedAt: null }]]) {
    const app = fixture(); await app.signIn(oldPool);
    const before = app.requests.length; app.button('NWA').emit('click'); app.button('NWA').emit('click');
    assert.equal(app.requests.length, before + 1);
    assert.equal(app.requests.at(-1).url, `${serviceBase}/api/targets`);
    app.response(app.requests.at(-1), { player, targets: [target], warnings: [] }); await flush();
    assert.equal(app.requests.length, before + 2);
    assert.equal(app.requests.at(-1).url, `${serviceBase}/api/targets/${target.id}/status`);
    assert.deepEqual(app.navigations, []);
    app.response(app.requests.at(-1), { id: target.id, status: { state: 'Okay' }, checkedAt: new Date(NOW).toISOString() }); await flush();
    assert.deepEqual(app.navigations, [`https://www.torn.com/page.php?sid=attack&user2ID=${target.id}`]);
  }
});

test('NWA retries the pool after login succeeded but the initial target feed failed', async () => {
  const app = fixture();
  app.find(element => element.type === 'password').value = KEY;
  app.find(element => element.tagName === 'FORM').emit('submit');
  app.response(app.requests.at(-1), { token: SESSION, expiresAt: new Date(NOW + 3_600_000).toISOString(), player, keyStorage }); await flush();
  assert.equal(app.requests.at(-1).url, `${serviceBase}/api/targets`);
  app.response(app.requests.at(-1), { error: { code: 'UPSTREAM_UNAVAILABLE', message: 'Target feed is temporarily unavailable.' } }, 503); await flush();
  assert.equal(app.storage.get(app.storageKey).token, SESSION);
  app.button('NWA').emit('click');
  assert.equal(app.requests.length, 3);
  assert.equal(app.requests.at(-1).url, `${serviceBase}/api/targets`);
  app.response(app.requests.at(-1), { player, targets: [target], warnings: [] }); await flush();
  assert.equal(app.requests.at(-1).url, `${serviceBase}/api/targets/${target.id}/status`);
  app.response(app.requests.at(-1), { id: target.id, status: { state: 'Okay' }, checkedAt: new Date(NOW).toISOString() }); await flush();
  assert.equal(app.navigations.length, 1);
});

test('NWA refreshes a pool older than 30 seconds before selecting a live target', async () => {
  const app = fixture(); await app.signIn();
  const updated = { ...target, id: target.id + 1, name: 'New Backend Target' };
  app.setNow(NOW + 30_001); const before = app.requests.length; app.button('NWA').emit('click');
  assert.equal(app.requests.length, before + 1);
  assert.equal(app.requests.at(-1).url, `${serviceBase}/api/targets`);
  app.response(app.requests.at(-1), { player, targets: [updated], warnings: [] }); await flush();
  assert.equal(app.requests.length, before + 2);
  assert.equal(app.requests.at(-1).url, `${serviceBase}/api/targets/${updated.id}/status`);
  app.response(app.requests.at(-1), { id: updated.id, status: { state: 'Okay' }, checkedAt: new Date(NOW + 30_001).toISOString() }); await flush();
  assert.deepEqual(app.navigations, [`https://www.torn.com/page.php?sid=attack&user2ID=${updated.id}`]);
});

test('signout, expiry, or a refreshed pool prevents an old NWA status response from navigating', async () => {
  for (const interruption of ['logout', 'expire', 'refresh']) {
    const app = fixture(); await app.signIn(); app.button('NWA').emit('click'); const live = app.requests.at(-1);
    if (interruption === 'logout') await app.signOut();
    else if (interruption === 'expire') { app.setNow(NOW + 3_600_000); app.timers[0](); }
    else app.button('Refresh list').emit('click');
    const after = app.requests.length;
    app.response(live, { id: target.id, status: { state: 'Okay' }, checkedAt: new Date(NOW).toISOString() }); await flush();
    assert.deepEqual(app.navigations, [], interruption);
    assert.equal(app.requests.length, after, 'stale checks cannot continue to another candidate');
    if (interruption !== 'refresh') assert.equal(app.storage.has(app.storageKey), false);
    else {
      app.response(app.requests.at(-1), { player, targets: [{ ...target, id: 40001 }], warnings: [] }); await flush();
      assert.deepEqual(app.navigations, []);
    }
  }
});

test('NWA rechecks session expiry at navigation time even before the idle timer runs', async () => {
  const app = fixture(); await app.signIn(); app.button('NWA').emit('click');
  const live = app.requests.at(-1); app.setNow(NOW + 3_600_000);
  app.response(live, { id: target.id, status: { state: 'Okay' }, checkedAt: new Date(NOW + 3_600_000).toISOString() });
  await flush();
  assert.deepEqual(app.navigations, []);
  assert.equal(app.storage.has(app.storageKey), false);
});

test('revocation during NWA selection stops further checks and clears the session', async () => {
  const app = fixture(); await app.signIn([target, { ...target, id: target.id + 1 }]);
  app.button('NWA').emit('click'); const before = app.requests.length;
  app.response(app.requests.at(-1), { error: { code: 'FACTION_CHANGED', message: 'Faction access revoked.' } }, 403);
  await flush();
  assert.equal(app.requests.length, before);
  assert.deepEqual(app.navigations, []);
  assert.equal(app.storage.has(app.storageKey), false);
  assert.match(app.text(), /Faction access revoked/);
});

test('stat controls start with a ten-to-sixty-percent range and expose their supported bounds', async () => {
  const app = fixture(); await app.signIn();
  const minimum = app.find(element => element.attributes.get('aria-label') === 'Minimum target stats as percent of your total');
  const maximum = app.find(element => element.attributes.get('aria-label') === 'Maximum target stats as percent of your total');
  assert.equal(minimum.value, '10'); assert.equal(maximum.value, '60');
  assert.equal(minimum.min, '0'); assert.equal(minimum.max, '500');
  assert.equal(maximum.min, '1'); assert.equal(maximum.max, '500');
  assert.equal(app.find(element => element.className === 'stat-range-summary').textContent,
    'Target range: 100K–600K estimated stats (10–60% of yours)');
});

test('saved legacy maximums are preserved and invalid minimums migrate to a compatible default', async () => {
  const cases = [
    [{ maxRatio: 0.4 }, 10, 40],
    [{ maxRatio: 0.05 }, 5, 5],
    [{ maxRatio: 0.03, minRatio: 0.1 }, 3, 3],
    [{ maxRatio: 0.6, minRatio: 0 }, 0, 60],
    [{ maxRatio: 0.6, minRatio: 0.6 }, 60, 60],
    [{ maxRatio: 0.6, minRatio: 0.7 }, 10, 60],
    [{ maxRatio: 0.6, minRatio: -0.1 }, 10, 60],
    [{ maxRatio: 0.6, minRatio: '0.2' }, 10, 60],
    [{ maxRatio: 0.6, minRatio: null }, 10, 60],
    [{ maxRatio: 0.6, minRatio: NaN }, 10, 60],
    [{ maxRatio: 0.6, minRatio: Infinity }, 10, 60],
    [{ maxRatio: 0 }, 10, 60],
    [{ maxRatio: 6 }, 10, 60],
    [{ maxRatio: '0.4' }, 10, 60],
  ];
  for (const [preferences, expectedMinimum, expectedMaximum] of cases) {
    const app = fixture(null, preferences); await app.signIn();
    assert.equal(app.find(element => element.attributes.get('aria-label') === 'Minimum target stats as percent of your total').value,
      String(expectedMinimum), JSON.stringify(preferences));
    assert.equal(app.find(element => element.attributes.get('aria-label') === 'Maximum target stats as percent of your total').value,
      String(expectedMaximum), JSON.stringify(preferences));
  }
});

test('both stat limits persist separately from the session and filter instant NWA selection after reloading', async () => {
  const app = fixture(); await app.signIn();
  const minimum = app.find(element => element.attributes.get('aria-label') === 'Minimum target stats as percent of your total');
  const maximum = app.find(element => element.attributes.get('aria-label') === 'Maximum target stats as percent of your total');
  maximum.value = '80'; maximum.emit('change');
  minimum.value = '30'; minimum.emit('change');
  assert.deepEqual(JSON.parse(JSON.stringify(app.storage.get(app.preferencesKey))), { minRatio: 0.3, maxRatio: 0.8, estimateDays: 7, lastTargetId: null, recentTargets: [] });
  await app.signOut();
  assert.equal(app.storage.has(app.storageKey), false);
  assert.equal(app.storage.get(app.preferencesKey).minRatio, 0.3);
  assert.equal(app.storage.get(app.preferencesKey).maxRatio, 0.8);
  assert.equal(JSON.stringify([...app.storage.values()]).includes(KEY), false);
  const reloaded = fixture(null, app.storage.get(app.preferencesKey));
  await reloaded.signIn([
    { ...target, id: 91001, estimatedStats: 200_000, checkedAt: new Date(NOW).toISOString() },
    { ...target, checkedAt: new Date(NOW).toISOString() },
    { ...target, id: 91003, estimatedStats: 900_000, checkedAt: new Date(NOW).toISOString() },
  ]);
  assert.equal(reloaded.find(element => element.attributes.get('aria-label') === 'Minimum target stats as percent of your total').value, '30');
  assert.equal(reloaded.find(element => element.attributes.get('aria-label') === 'Maximum target stats as percent of your total').value, '80');
  const before = reloaded.requests.length; reloaded.button('NWA').emit('click');
  assert.equal(reloaded.requests.length, before, 'saved limits still use the immediate cached path');
  assert.deepEqual(reloaded.navigations, [`https://www.torn.com/page.php?sid=attack&user2ID=${target.id}`]);
  assert.deepEqual(JSON.parse(JSON.stringify(reloaded.storage.get(reloaded.preferencesKey))), { minRatio: 0.3, maxRatio: 0.8, estimateDays: 7, lastTargetId: target.id, recentTargets: [{ id: target.id, at: NOW }] });
});

test('the maximum stat limit is used by NWA after reloading', async () => {
  const app = fixture(); await app.signIn();
  const ratio = app.find(element => element.attributes.get('aria-label') === 'Maximum target stats as percent of your total');
  ratio.value = '40'; ratio.emit('change');
  assert.equal(app.storage.get(app.preferencesKey).maxRatio, 0.4);
  await app.signOut();
  assert.equal(app.storage.has(app.storageKey), false);
  assert.equal(app.storage.get(app.preferencesKey).maxRatio, 0.4);
  assert.equal(JSON.stringify([...app.storage.values()]).includes(KEY), false);
  const reloaded = fixture(null, app.storage.get(app.preferencesKey)); await reloaded.signIn();
  const before = reloaded.requests.length; reloaded.button('NWA').emit('click'); await flush();
  assert.equal(reloaded.requests.length, before + 1);
  assert.equal(reloaded.requests.at(-1).url, `${serviceBase}/api/targets`);
  reloaded.response(reloaded.requests.at(-1), { player, targets: [target], warnings: [] }); await flush();
  assert.equal(reloaded.requests.length, before + 1, 'a 50% target is excluded by the saved 40% limit after refreshing the pool');
  assert.deepEqual(reloaded.navigations, []);
  assert.match(reloaded.find(element => element.className === 'quick-notice').textContent, /No targets match/);
});

test('NWA skips targets below the minimum and above the maximum on cached and live-check paths', async () => {
  for (const cached of [true, false]) {
    const app = fixture();
    const checkedAt = cached ? new Date(NOW).toISOString() : undefined;
    const match = { ...target, id: 92002, estimatedStats: 300_000, checkedAt };
    await app.signIn([
      { ...target, id: 92001, estimatedStats: 50_000, checkedAt },
      { ...target, id: 92003, estimatedStats: 700_000, checkedAt },
      match,
    ]);
    const before = app.requests.length; app.button('NWA').emit('click');
    if (cached) assert.equal(app.requests.length, before, 'an in-range cached match is immediate');
    else {
      assert.equal(app.requests.length, before + 1, 'out-of-range candidates never consume a live lookup');
      assert.equal(app.requests.at(-1).url, `${serviceBase}/api/targets/${match.id}/status`);
      app.response(app.requests.at(-1), { id: match.id, status: { state: 'Okay' }, checkedAt: new Date(NOW).toISOString() }); await flush();
    }
    assert.deepEqual(app.navigations, [`https://www.torn.com/page.php?sid=attack&user2ID=${match.id}`]);
  }
});

test('NWA accepts targets exactly on either stat-range boundary', async () => {
  for (const estimatedStats of [100_000, 600_000]) {
    for (const cached of [true, false]) {
      const app = fixture(); await app.signIn([{ ...target, estimatedStats, checkedAt: cached ? new Date(NOW).toISOString() : undefined }]);
      const before = app.requests.length; app.button('NWA').emit('click');
      if (!cached) {
        assert.equal(app.requests.at(-1).url, `${serviceBase}/api/targets/${target.id}/status`);
        app.response(app.requests.at(-1), { id: target.id, status: { state: 'Okay' }, checkedAt: new Date(NOW).toISOString() }); await flush();
      }
      assert.equal(app.requests.length, before + Number(!cached));
      assert.deepEqual(app.navigations, [`https://www.torn.com/page.php?sid=attack&user2ID=${target.id}`]);
    }
  }
});

test('a pool containing only too-weak targets refreshes once and never checks or opens them', async () => {
  const app = fixture(); const weak = { ...target, estimatedStats: 50_000, checkedAt: new Date(NOW).toISOString() };
  await app.signIn([weak]);
  const before = app.requests.length; app.button('NWA').emit('click'); await flush();
  assert.equal(app.requests.length, before + 1);
  assert.equal(app.requests.at(-1).url, `${serviceBase}/api/targets`);
  app.response(app.requests.at(-1), { player, targets: [weak], warnings: [] }); await flush();
  assert.equal(app.requests.length, before + 1);
  assert.deepEqual(app.navigations, []);
  assert.match(app.find(element => element.className === 'quick-notice').textContent, /No targets match/);
});

test('All targets labels weak players and reserves attack links for ready in-range matches', async () => {
  const app = fixture(); const checkedAt = new Date(NOW).toISOString();
  await app.signIn([
    { ...target, id: 93001, estimatedStats: 50_000, checkedAt },
    { ...target, id: 93002, estimatedStats: 700_000, checkedAt },
    { ...target, id: 93003, estimatedStats: 400_000, checkedAt },
  ]);
  const cards = descendants(app.root).filter(element => element.className === 'card');
  assert.equal(cards.length, 3);
  const weakCard = cards.find(card => textContent(card).includes('[93001]'));
  const strongCard = cards.find(card => textContent(card).includes('[93002]'));
  const matchedCard = cards.find(card => textContent(card).includes('[93003]'));
  assert.match(textContent(weakCard), /Below your minimum/);
  assert.match(textContent(strongCard), /Above your limit/);
  assert.equal(descendants(weakCard).some(element => element.className === 'attack'), false);
  assert.equal(descendants(strongCard).some(element => element.className === 'attack'), false);
  assert.equal(descendants(matchedCard).some(element => element.className === 'attack'), true);
  const mode = app.find(element => element.tagName === 'SELECT'); mode.value = 'suggested'; mode.emit('change');
  const suggestions = descendants(app.root).filter(element => element.className === 'card');
  assert.equal(suggestions.length, 1);
  assert.match(textContent(suggestions[0]), /\[93003\]/);
});

test('invalid, blank, and inverted stat edits restore the previous value without saving preferences', async () => {
  const cases = [
    ['Minimum', ['', ' ', '-1', '61', '501', 'invalid', 'Infinity']],
    ['Maximum', ['', ' ', '0', '-1', '9', '501', 'invalid', 'Infinity']],
  ];
  for (const [name, values] of cases) {
    for (const value of values) {
      const app = fixture(); await app.signIn();
      const control = app.find(element => element.attributes.get('aria-label') === `${name} target stats as percent of your total`);
      const before = app.writes.length;
      control.value = value; control.emit('change'); await flush();
      assert.equal(control.value, name === 'Minimum' ? '10' : '60', `${name}: ${JSON.stringify(value)}`);
      assert.equal(app.writes.length, before, `${name}: ${JSON.stringify(value)} must not persist an invalid range`);
      assert.equal(app.storage.has(app.preferencesKey), false);
      const error = app.find(element => element.className === 'error');
      assert.equal(error.hidden, false);
      assert.match(error.textContent, /minimum|maximum/i);
    }
  }
});

test('valid stat edits commit on change and allow equal limits and the zero-to-five-hundred bounds', async () => {
  for (const [minimumValue, maximumValue, estimatedStats] of [[0, 1, 1], [60, 60, 600_000], [500, 500, 5_000_000]]) {
    const app = fixture(); await app.signIn([{ ...target, estimatedStats, checkedAt: new Date(NOW).toISOString() }]);
    const minimum = app.find(element => element.attributes.get('aria-label') === 'Minimum target stats as percent of your total');
    const maximum = app.find(element => element.attributes.get('aria-label') === 'Maximum target stats as percent of your total');
    if (maximumValue < 10) { minimum.value = String(minimumValue); minimum.emit('change'); }
    maximum.value = String(maximumValue); maximum.emit('change');
    const beforeInput = app.writes.length;
    minimum.value = String(minimumValue); minimum.emit('input');
    assert.equal(app.writes.length, beforeInput, 'typing does not commit an unfinished number');
    minimum.emit('change');
    assert.equal(app.storage.get(app.preferencesKey).minRatio, minimumValue / 100);
    assert.equal(app.storage.get(app.preferencesKey).maxRatio, maximumValue / 100);
    const before = app.requests.length; app.button('NWA').emit('click');
    assert.equal(app.requests.length, before);
    assert.deepEqual(app.navigations, [`https://www.torn.com/page.php?sid=attack&user2ID=${target.id}`]);
  }
});

test('changing either stat limit cancels a pending NWA selection before it can navigate', async () => {
  for (const [name, value] of [['Minimum', '60'], ['Maximum', '40']]) {
    const app = fixture(); await app.signIn(); app.button('NWA').emit('click'); const live = app.requests.at(-1);
    const ratio = app.find(element => element.attributes.get('aria-label') === `${name} target stats as percent of your total`);
    ratio.value = value; ratio.emit('change');
    const before = app.requests.length;
    app.response(live, { id: target.id, status: { state: 'Okay' }, checkedAt: new Date(NOW).toISOString() }); await flush();
    assert.deepEqual(app.navigations, [], name);
    assert.equal(app.requests.length, before, 'a canceled lookup does not continue selecting');
    assert.equal(app.button('NWA').disabled, false);
  }
});

test('decimal stat limits are retained exactly in the controls, saved preferences, and target range', async () => {
  const app = fixture(); await app.signIn([{ ...target, estimatedStats: 202_500, checkedAt: new Date(NOW).toISOString() }]);
  const minimum = app.find(element => element.attributes.get('aria-label') === 'Minimum target stats as percent of your total');
  const maximum = app.find(element => element.attributes.get('aria-label') === 'Maximum target stats as percent of your total');
  minimum.value = '20.25'; minimum.emit('change');
  maximum.value = '60.75'; maximum.emit('change');
  assert.equal(minimum.value, '20.25'); assert.equal(maximum.value, '60.75');
  assert.equal(app.storage.get(app.preferencesKey).minRatio, 0.2025);
  assert.equal(app.storage.get(app.preferencesKey).maxRatio, 0.6075);
  assert.match(app.find(element => element.className === 'stat-range-summary').textContent, /20\.25–60\.75% of yours/);
  const before = app.requests.length; app.button('NWA').emit('click');
  assert.equal(app.requests.length, before);
  assert.deepEqual(app.navigations, [`https://www.torn.com/page.php?sid=attack&user2ID=${target.id}`]);
});

test('changing either stat limit during a pending pool refresh cancels automatic selection', async () => {
  for (const [name, value] of [['Minimum', '60'], ['Maximum', '40']]) {
    const app = fixture(); await app.signIn(); app.setNow(NOW + 30_000);
    app.button('NWA').emit('click'); const feed = app.requests.at(-1);
    assert.equal(feed.url, `${serviceBase}/api/targets`);
    const ratio = app.find(element => element.attributes.get('aria-label') === `${name} target stats as percent of your total`);
    ratio.value = value; ratio.emit('change');
    const before = app.requests.length;
    app.response(feed, { player, targets: [{ ...target, checkedAt: new Date(NOW + 30_000).toISOString() }], warnings: [] }); await flush();
    assert.deepEqual(app.navigations, [], name);
    assert.equal(app.requests.length, before);
    assert.equal(app.button('NWA').disabled, false);
  }
});

test('a rejected stat edit leaves the valid saved range and pending target selection intact', async () => {
  const app = fixture(); await app.signIn(); app.button('NWA').emit('click');
  const live = app.requests.at(-1);
  const minimum = app.find(element => element.attributes.get('aria-label') === 'Minimum target stats as percent of your total');
  const before = app.writes.length;
  minimum.value = '70'; minimum.emit('change');
  assert.equal(minimum.value, '10'); assert.equal(app.writes.length, before);
  app.response(live, { id: target.id, status: { state: 'Okay' }, checkedAt: new Date(NOW).toISOString() }); await flush();
  assert.deepEqual(app.navigations, [`https://www.torn.com/page.php?sid=attack&user2ID=${target.id}`]);
  assert.equal(app.storage.get(app.preferencesKey).minRatio, 0.1);
  assert.equal(app.storage.get(app.preferencesKey).maxRatio, 0.6);
});

test('an existing attack link checks the current minimum again after settings exclude its target', async () => {
  const app = fixture(); await app.signIn([{ ...target, checkedAt: new Date(NOW).toISOString() }]);
  const attack = app.find(element => element.className === 'attack');
  const minimum = app.find(element => element.attributes.get('aria-label') === 'Minimum target stats as percent of your total');
  minimum.value = '60'; minimum.emit('change');
  for (const type of ['click', 'auxclick']) assert.equal(attack.emit(type).defaultPrevented, true, type);
  assert.equal(descendants(app.root).some(element => element.className === 'attack'), false);
  assert.deepEqual(app.navigations, []);
});

function suggestion(overrides = {}) {
  return { id: '00000000-0000-4000-8000-000000000001', type: 'player', targetId: 45678,
    targetName: 'Suggested Player', comment: 'Inactive player for chains.', status: 'pending',
    suggestedBy: { id: player.id, name: player.name, faction: player.faction }, createdAt: new Date(NOW).toISOString(),
    reviewedBy: null, reviewedAt: null, ...overrides };
}
async function openSuggestions(app, data = { canReview: false, suggestions: [], nextOffset: null }) {
  app.button('Suggestions').emit('click'); const request = app.requests.at(-1);
  assert.equal(request.url, `${serviceBase}/api/suggestions?view=pending&offset=0`);
  app.response(request, data); await flush(); return request;
}
function fillSuggestion(app, { type = 'player', targetId = '45678', comment = 'Useful chain target.' } = {}) {
  const typeInput = app.find(element => element.attributes.get('aria-label') === 'Suggestion type');
  typeInput.value = type; typeInput.emit('change');
  const idInput = app.find(element => element.attributes.get('aria-label') === 'Player or faction ID');
  idInput.value = targetId; idInput.emit('input');
  const commentInput = app.find(element => element.tagName === 'TEXTAREA');
  commentInput.value = comment; commentInput.emit('input');
}
function submitSuggestion(app) { app.find(element => element.tagName === 'FORM' && element.className === 'suggestionform').emit('submit'); }

test('suggestions require a trimmed nonblank comment and a valid Torn ID before making a request', async () => {
  const app = fixture(); await app.signIn(); await openSuggestions(app);
  const requestCount = app.requests.length;
  for (const comment of ['', '  \n\t ', 'x'.repeat(1001), '🙂'.repeat(1001)]) {
    fillSuggestion(app, { comment }); submitSuggestion(app); await flush();
    assert.equal(app.requests.length, requestCount);
    assert.match(app.text(), /Add a reason/);
  }
  for (const targetId of ['0', '-4', '1.5', '1e3', '2147483648', 'NaN']) {
    fillSuggestion(app, { targetId }); submitSuggestion(app); await flush();
    assert.equal(app.requests.length, requestCount);
    assert.match(app.text(), /valid player or faction ID/);
  }
  assert.equal(app.find(element => element.tagName === 'TEXTAREA').required, true);
  assert.equal(app.find(element => element.tagName === 'TEXTAREA').maxLength, 2000);
});

test('a thousand Unicode characters reach the backend without splitting emoji or truncating the reason', async () => {
  const app = fixture(); await app.signIn(); await openSuggestions(app);
  const comment = '🙂'.repeat(1000);
  fillSuggestion(app, { comment }); submitSuggestion(app);
  const post = app.requests.at(-1);
  assert.equal(post.method, 'POST');
  assert.equal(post.url, `${serviceBase}/api/suggestions`);
  assert.equal(JSON.parse(post.data).comment, comment);
});

test('members can submit both players and factions with a required reason, then see the pending queue', async () => {
  for (const type of ['player', 'faction']) {
    const app = fixture(); await app.signIn(); await openSuggestions(app);
    fillSuggestion(app, { type, comment: '  Useful for chains.\n  ' });
    const form = app.find(element => element.className === 'suggestionform'); form.emit('submit');
    const post = app.requests.at(-1); form.emit('submit');
    assert.equal(app.requests.at(-1), post, 'an in-flight submit cannot be doubled');
    assert.equal(post.method, 'POST'); assert.equal(post.url, `${serviceBase}/api/suggestions`);
    assert.deepEqual(JSON.parse(post.data), { type, targetId: 45678, comment: 'Useful for chains.' });
    assert.equal(post.headers.Authorization, `Bearer ${SESSION}`);
    app.response(post, { suggestion: suggestion({ type }) }, 201); await flush();
    const queue = app.requests.at(-1); assert.equal(queue.method, 'GET');
    app.response(queue, { canReview: false, suggestions: [suggestion({ type })], nextOffset: null }); await flush();
    assert.match(app.text(), /Suggestion submitted/);
    assert.equal(app.find(element => element.tagName === 'TEXTAREA').value, '');
    assert.equal(app.find(element => element.attributes.get('aria-label') === 'Player or faction ID').value, '');
    assert.match(app.text(), /Suggested Player \[45678\].*Inactive player for chains/s);
    assert.equal(descendants(app.root).some(element => element.tagName === 'BUTTON' && ['Approve', 'Reject'].includes(element.textContent)), false);
    if (type === 'faction') assert.match(app.text(), /Faction · current players added on approval/);
  }
});

test('suggestion drafts survive navigation, queue re-renders, and transient or duplicate submission failures', async () => {
  const app = fixture(); await app.signIn(); await openSuggestions(app);
  fillSuggestion(app, { type: 'faction', targetId: '55555', comment: '  Draft reason\nwith details.  ' });
  app.button('Targets').emit('click'); await openSuggestions(app);
  assert.equal(app.find(element => element.tagName === 'TEXTAREA').value, '  Draft reason\nwith details.  ');
  assert.equal(app.find(element => element.attributes.get('aria-label') === 'Suggestion type').value, 'faction');
  assert.equal(app.find(element => element.attributes.get('aria-label') === 'Player or faction ID').value, '55555');
  for (const [status, code] of [[503, 'UPSTREAM_UNAVAILABLE'], [409, 'SUGGESTION_CONFLICT'], [403, 'FRIENDLY_TARGET']]) {
    submitSuggestion(app); app.response(app.requests.at(-1), { error: { code, message: 'Try another target or later.' } }, status); await flush();
    assert.equal(app.storage.get(app.storageKey).token, SESSION);
    assert.equal(app.find(element => element.tagName === 'TEXTAREA').value, '  Draft reason\nwith details.  ');
    assert.equal(app.button('Submit suggestion').disabled, false);
  }
});

test('pending and own-history queues offer pagination and ignore stale results from the previous view', async () => {
  const app = fixture(); await app.signIn();
  await openSuggestions(app, { canReview: false, suggestions: [suggestion()], nextOffset: 50 });
  app.button('Load more suggestions').emit('click'); const more = app.requests.at(-1);
  assert.ok(more.url.endsWith('/api/suggestions?view=pending&offset=50'));
  const other = suggestion({ id: '00000000-0000-4000-8000-000000000002', targetId: 67890, targetName: 'Second Target' });
  app.response(more, { canReview: false, suggestions: [suggestion(), other], nextOffset: null }); await flush();
  assert.equal(descendants(app.root).filter(element => element.className === 'card suggestioncard').length, 2, 'duplicate page rows display once');
  app.button('Refresh suggestions').emit('click'); const stale = app.requests.at(-1);
  app.button('My suggestions').emit('click'); const own = app.requests.at(-1);
  assert.ok(own.url.endsWith('/api/suggestions?view=mine&offset=0'));
  app.response(own, { canReview: false, suggestions: [suggestion({ status: 'approved', reviewedBy: player, reviewedAt: new Date(NOW).toISOString() })], nextOffset: 50 });
  app.response(stale, { canReview: true, suggestions: [other], nextOffset: null }); await flush();
  assert.match(app.text(), /Approved by Allowed Player/);
  assert.equal(app.text().includes('Second Target'), false, 'late pending response must not overwrite history');
  assert.equal(descendants(app.root).some(element => element.textContent === 'Approve'), false);
  app.button('Load more suggestions').emit('click');
  assert.ok(app.requests.at(-1).url.endsWith('/api/suggestions?view=mine&offset=50'));
});

test('leader approvals refresh the pool and queue, while rejection updates only the queue', async () => {
  for (const decision of ['approved', 'rejected']) {
    const app = fixture(); await app.signIn();
    await openSuggestions(app, { canReview: true, suggestions: [suggestion({ type: 'faction' })], nextOffset: null });
    const action = app.button(decision === 'approved' ? 'Approve' : 'Reject'); action.emit('click'); const review = app.requests.at(-1);
    action.emit('click'); assert.equal(app.requests.at(-1), review, 'busy review cannot be sent twice');
    assert.equal(review.url, `${serviceBase}/api/suggestions/00000000-0000-4000-8000-000000000001/review`);
    assert.deepEqual(JSON.parse(review.data), { decision });
    const beforeRefresh = app.requests.length;
    app.response(review, { suggestion: suggestion({ status: decision }), addedPlayers: decision === 'approved' ? 12 : 0 }); await flush();
    const refreshes = app.requests.slice(beforeRefresh);
    const queue = refreshes.find(request => request.url.includes('/api/suggestions?')); assert.ok(queue);
    app.response(queue, { canReview: true, suggestions: [], nextOffset: null });
    const pool = refreshes.find(request => request.url.endsWith('/api/targets'));
    if (decision === 'approved') {
      assert.ok(pool); app.response(pool, { player, targets: [target, { ...target, id: 67890, name: 'Newly Approved Player' }], warnings: [] });
    } else assert.equal(pool, undefined);
    await flush();
    assert.match(app.text(), decision === 'approved' ? /12 players added to the target pool/ : /Suggestion rejected/);
    if (decision === 'approved') { app.button('Targets').emit('click'); assert.match(app.text(), /Newly Approved Player/); }
  }
});

test('a review role denial removes leader actions while preserving the ordinary session and draft', async () => {
  const app = fixture(); await app.signIn();
  await openSuggestions(app, { canReview: true, suggestions: [suggestion()], nextOffset: null });
  fillSuggestion(app, { comment: 'Keep this unfinished draft.' }); app.button('Approve').emit('click');
  app.response(app.requests.at(-1), { error: { code: 'REVIEW_NOT_ALLOWED', message: 'Leadership permission is no longer available.' } }, 403); await flush();
  assert.equal(app.storage.get(app.storageKey).token, SESSION);
  assert.match(app.text(), /Leadership permission is no longer available/);
  assert.equal(descendants(app.root).some(element => element.textContent === 'Approve' || element.textContent === 'Reject'), false);
  assert.equal(app.find(element => element.tagName === 'TEXTAREA').value, 'Keep this unfinished draft.');
  assert.equal(app.button('Submit suggestion').disabled, false);
  app.button('Targets').emit('click'); assert.match(app.text(), /Target Player/);
});

test('an already-reviewed conflict keeps the session and allows the queue to be refreshed', async () => {
  const app = fixture(); await app.signIn();
  await openSuggestions(app, { canReview: true, suggestions: [suggestion()], nextOffset: null });
  app.button('Reject').emit('click');
  app.response(app.requests.at(-1), { error: { code: 'ALREADY_REVIEWED', message: 'Another leader already reviewed this suggestion.' } }, 409); await flush();
  assert.equal(app.storage.get(app.storageKey).token, SESSION);
  assert.match(app.text(), /Another leader already reviewed/);
  assert.equal(app.button('Refresh suggestions').disabled, false);
});

test('queue content is rendered as plain text, including comments, target names, and submitter names', async () => {
  const app = fixture(); await app.signIn();
  const injected = '<img src=x onerror="throw Error(1)">';
  await openSuggestions(app, { canReview: false, suggestions: [suggestion({ targetName: injected, comment: `<script>alert(1)</script>\n${injected}`,
    suggestedBy: { ...player, name: injected, faction: { ...player.faction, name: injected } } })], nextOffset: null });
  assert.match(app.text(), /<script>alert\(1\)<\/script>/);
  assert.ok(app.text().includes(injected));
  assert.equal(descendants(app.root).some(element => element.tagName === 'IMG' || element.tagName === 'SCRIPT'), false);
});

test('sign out during queue loading or mutations ignores late results and clears the suggestion draft', async () => {
  for (const action of ['queue', 'submit', 'review']) {
    const app = fixture(); await app.signIn();
    if (action === 'queue') app.button('Suggestions').emit('click');
    else {
      await openSuggestions(app, { canReview: true, suggestions: [suggestion()], nextOffset: null });
      fillSuggestion(app, { comment: 'Must be removed on sign out.' });
      if (action === 'submit') submitSuggestion(app); else app.button('Approve').emit('click');
    }
    const held = app.requests.at(-1); await app.signOut(); const count = app.requests.length;
    app.response(held, action === 'queue' ? { canReview: true, suggestions: [suggestion()], nextOffset: null } : { suggestion: suggestion(), addedPlayers: 1 }); await flush();
    assert.equal(app.requests.length, count, 'a stale mutation must not start new refreshes');
    assert.equal(app.storage.size, 0);
    assert.match(app.text(), /Torn Limited API key/);
    assert.equal(app.text().includes('Must be removed on sign out.'), false);
    assert.equal(descendants(app.root).some(element => element.className === 'card suggestioncard'), false);
  }
});

test('session expiry and revocation during a suggestion request cannot restore review access', async () => {
  for (const outcome of ['expire', 'revoke']) {
    const app = fixture(); await app.signIn(); await openSuggestions(app);
    fillSuggestion(app); submitSuggestion(app); const post = app.requests.at(-1);
    if (outcome === 'expire') {
      app.setNow(NOW + 3_600_000); app.timers[0]();
      app.response(post, { suggestion: suggestion() }, 201);
    } else app.response(post, { error: { code: 'FACTION_NOT_ALLOWED', message: 'Faction access revoked.' } }, 403);
    await flush(); assert.equal(app.storage.size, 0); assert.match(app.text(), /Torn Limited API key/);
    assert.equal(descendants(app.root).some(element => element.textContent === 'Approve'), false);
  }
});

test('approval starts a fresh target request and ignores an older target refresh result', async () => {
  const app = fixture(); await app.signIn(); app.button('Refresh list').emit('click'); const oldPool = app.requests.at(-1);
  await openSuggestions(app, { canReview: true, suggestions: [suggestion()], nextOffset: null });
  app.button('Approve').emit('click'); app.response(app.requests.at(-1), { suggestion: suggestion({ status: 'approved' }), addedPlayers: 1 }); await flush();
  const newPool = app.requests.at(-1); assert.ok(newPool.url.endsWith('/api/targets')); assert.notEqual(newPool, oldPool);
  const queue = app.requests.at(-2); app.response(queue, { canReview: true, suggestions: [], nextOffset: null });
  app.response(newPool, { player, targets: [{ ...target, name: 'Approved Pool' }], warnings: [] });
  app.response(oldPool, { player, targets: [{ ...target, name: 'Old Pool' }], warnings: [] }); await flush();
  app.button('Targets').emit('click'); assert.match(app.text(), /Approved Pool/); assert.equal(app.text().includes('Old Pool'), false);
});
