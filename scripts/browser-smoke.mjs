import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Browser integration checks use mock API data only. No Torn or FFScouter calls occur.
const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { chromium } = createRequire(import.meta.url)('playwright');
const executablePath = process.env.TARGETLIST_BROWSER_PATH || chromium.executablePath();
if (!existsSync(executablePath)) {
  throw new Error('No Chromium browser found. Run npx playwright install chromium, or set TARGETLIST_BROWSER_PATH to an installed compatible browser.');
}
// Exercise the actual installable bundle, including its wrapper and mount guard.
const source = await readFile(path.join(workspace, 'dist/torn-targetlist.user.js'), 'utf8');
const scriptVersion = source.match(/^\/\/ @version\s+(.+)$/m)?.[1]?.trim();
assert(scriptVersion, 'Installable script is missing a version');
const legacySource = `(() => {
  if (document.getElementById('torn-targetlist-host')) return;
  const host = document.createElement('div');
  host.id = 'torn-targetlist-host';
  host.style.cssText = 'position:fixed;bottom:18px;right:18px;z-index:2147483000;';
  document.body.append(host);
  const root = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = '.launcher{padding:8px 12px;background:#76e1c7;color:#102626;border:0;border-radius:9px}';
  const launcher = document.createElement('button');
  launcher.className = 'launcher'; launcher.textContent = '◎ Target list';
  root.append(style, launcher);
})();`;
const artifacts = path.join(workspace, 'artifacts');
await mkdir(artifacts, { recursive: true });
const browser = await chromium.launch({ executablePath, headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 960 } });
let networkRequests = 0;
await context.route('**/*', route => { networkRequests++; return route.abort(); });
const pageErrors = [];

// Model Torn PDA's native bridge and asynchronous script-scoped storage rather
// than quietly providing Tampermonkey APIs in a mobile-sized browser window.
function installPdaRuntime() {
  const sendMockRequest = window.GM_xmlhttpRequest;
  for (const name of ['GM_xmlhttpRequest', 'GM_getValue', 'GM_setValue', 'GM_deleteValue']) delete window[name];
  const native = window.__mock.pda = { calls: [], storageCalls: [], wrapperCalls: 0, ready: false };
  window.__PDA_platformReadyPromise = new Promise(resolve => {
    window.__resolvePdaPlatform = () => { native.ready = true; resolve(); };
  });
  window.flutter_inappwebview = {
    callHandler(name, ...args) {
      if (!native.ready) return Promise.reject(new Error('Native bridge used before Torn PDA readiness'));
      native.calls.push({ name, args: structuredClone(args) });
      const methods = { PDA_httpGet: 'GET', PDA_httpPost: 'POST', PDA_httpDelete: 'DELETE' };
      if (!methods[name]) return Promise.reject(new Error(`Unexpected native handler: ${name}`));
      const [url, headers, data] = args;
      return new Promise((resolve, reject) => sendMockRequest({
        method: methods[name], url, headers, data, timeout: 20000,
        onload: resolve, onerror: () => reject(new Error('Mock native transport failure')),
        onabort: () => reject(new Error('Mock native transport aborted'))
      }));
    }
  };
  for (const name of ['PDA_httpGet', 'PDA_httpPost', 'PDA_httpDelete']) {
    window[name] = (...args) => {
      native.wrapperCalls++;
      return window.flutter_inappwebview.callHandler(name, ...args);
    };
  }
  const tick = () => new Promise(resolve => setTimeout(resolve, 5));
  return {
    async loadAll() {
      if (!native.ready) throw new Error('Native storage read before Torn PDA readiness');
      native.storageCalls.push({ method: 'loadAll' });
      await tick();
      if (window.__mock.pdaLoadAllFailure) throw new Error('Mock transient native storage failure');
      return Object.fromEntries(window.__mock.store);
    },
    async set(key, value) {
      native.storageCalls.push({ method: 'set', key, value: structuredClone(value) });
      await tick(); window.__mock.store.set(key, structuredClone(value));
    },
    async delete(key) {
      native.storageCalls.push({ method: 'delete', key });
      await tick(); window.__mock.store.delete(key);
    }
  };
}
const pdaRuntimeSource = `const PDA_storage = (${installPdaRuntime.toString()})();`;

async function mount(viewport = { width: 1280, height: 960 }, scripts = [source], pageContext = context, beforeMount = null, beforeMountArgument = undefined, mockUrl = null) {
  const page = await pageContext.newPage();
  await page.setViewportSize(viewport);
  page.on('pageerror', error => pageErrors.push(error.message));
  if (mockUrl) {
    // Serve the Torn fixture locally, without sending a request to Torn.
    await page.route('https://www.torn.com/**', route => route.fulfill({
      status: 200, contentType: 'text/html', body: '<!doctype html><html><body></body></html>'
    }));
  }
  await page.goto(mockUrl || 'about:blank');
  await page.setContent(`<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>NWA mock browser check</title>
    <style>body{margin:0;background:#0c141c;color:#c0cdd5;font-family:system-ui,sans-serif}.mock{position:fixed;top:20px;left:20px;max-width:calc(100vw - 40px)}h1{font-size:20px;margin:0 0 8px}p{font-size:13px;max-width:360px;line-height:1.5}</style>
    </head><body><div class="mock"><h1>MOCK API DATA</h1><p>Browser validation preview. Fictional player names, faction, battle stats and statuses. No live Torn or FFScouter requests.</p></div>
    <div style="position:fixed;top:3px;right:18px;z-index:2147483647;font-size:10px;letter-spacing:1px;color:#f6d290">MOCK API DATA</div></body></html>`);
  await page.evaluate(() => {
    // Closed-root capture is installed before mounting, solely inside this test page.
    const originalAttachShadow = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function (options) {
      const shadow = originalAttachShadow.call(this, options);
      if (this.id === 'torn-targetlist-host') window.__targetlistShadow = shadow;
      if (this.id === 'nwa-target-page-notice') window.__playerNoticeShadow = shadow;
      return shadow;
    };
    const originalNow = Date.now;
    window.__mockNow = originalNow();
    Date.now = () => window.__mockNow;
    Math.random = () => 0.999999;
    const now = Math.floor(Date.now() / 1000);
    const player = { id: 90001, name: 'MockChainer', faction: { id: 44001, name: 'Mock Allowed Faction' },
      battleStats: { strength: 400000, defense: 250000, speed: 200000, dexterity: 150000, total: 1000000 } };
    const makeTarget = (id, name, estimatedStats, overrides = {}) => ({ id, name, level: 30,
      faction: { id: 77001, name: 'Mock Target Faction' }, estimatedStats,
      estimateSource: estimatedStats === null ? null : 'FFScouter',
      estimateUpdatedAt: estimatedStats === null ? null : now - 3600,
      status: { state: 'Unknown', description: 'Not checked', until: null },
      lastAction: now - 86400, checkedAt: null, notes: '', ...overrides });
    const targets = [makeTarget(101, 'Willow', 300000, { notes: 'Preferred chain target' }),
      makeTarget(102, 'Granite', 900000), makeTarget(103, 'Mystery', null),
      makeTarget(104, 'OldEstimate', 200000, { estimateUpdatedAt: now - 8 * 86400 })];
    const store = new Map();
    const suggestions = [{ id: '00000000-0000-4000-8000-000000000001', type: 'player', targetId: 21001,
      targetName: 'Mock Suggested Player', comment: 'A mock reason for adding this target.', status: 'pending',
      suggestedBy: { id: player.id, name: player.name, faction: player.faction }, createdAt: new Date(Date.now()).toISOString(),
      reviewedBy: null, reviewedAt: null }];
    window.__mock = { requests: [], pending: [], holds: [], overrides: {}, player, targets, store, suggestions,
      delta: false, feedSnapshots: new Map(), feedSequence: 0, feedResponses: [],
      reservations: null, reservedTargets: new Set(),
      canReview: false, serviceOrigin: 'https://targetlist.grusmedia.no' };
    const originalSetInterval = window.setInterval;
    window.__mock.intervals = [];
    window.setInterval = (callback, delay, ...args) => {
      window.__mock.intervals.push(() => callback(...args));
      return originalSetInterval(callback, delay, ...args);
    };
    window.__mock.runIntervals = () => { for (const callback of window.__mock.intervals) callback(); };
    window.GM_getValue = (key, fallback) => store.has(key) ? store.get(key) : fallback;
    window.GM_setValue = (key, value) => store.set(key, value);
    window.GM_deleteValue = key => store.delete(key);
    function respond(request) {
      const url = new URL(request.url);
      const override = window.__mock.overrides[url.pathname];
      if (override?.networkError) { request.onerror(); return; }
      let data, status = override?.status || 200;
      if (override) data = override.data;
      else if (url.pathname === '/api/session' && request.method === 'POST') {
        data = { token: 'mock-session-token', expiresAt: new Date(Date.now() + 3600000).toISOString(), player,
          keyStorage: { mode: 'encrypted', expiresAt: new Date(Date.now() + 7 * 86400000).toISOString() } };
      } else if (url.pathname === '/api/session' && request.method === 'DELETE') { status = 204; data = null; }
      else if (url.pathname === '/api/targets') {
        const snapshot = structuredClone(targets);
        data = { player, generatedAt: new Date(Date.now()).toISOString(), warnings: [] };
        if (window.__mock.delta) {
          const previous = window.__mock.feedSnapshots.get(url.searchParams.get('cursor'));
          const cursor = (++window.__mock.feedSequence).toString(16).padStart(64, '0');
          data.sync = { version: 1, cursor, reset: !previous };
          if (previous) {
            const prior = new Map(previous.map(target => [target.id, JSON.stringify(target)]));
            const current = new Set(snapshot.map(target => target.id));
            data.updates = snapshot.filter(target => prior.get(target.id) !== JSON.stringify(target));
            data.removed = previous.filter(target => !current.has(target.id)).map(target => target.id);
          } else data.targets = snapshot;
          window.__mock.feedSnapshots.set(cursor, snapshot);
        } else data.targets = snapshot;
        if (window.__mock.reservations) data.reservations = window.__mock.reservations;
      } else if (/^\/api\/targets\/\d+\/reservation$/.test(url.pathname) && request.method === 'POST') {
        const id = Number(url.pathname.split('/')[3]);
        if (window.__mock.reservedTargets.has(id)) {
          status = 409; data = { error: { code: 'TARGET_RESERVED', message: 'Another member is using this target.' } };
        } else {
          window.__mock.reservedTargets.add(id);
          data = { id, faction: { id: 77001, name: 'Mock Target Faction' }, checkedAt: new Date(Date.now()).toISOString(),
            status: { state: 'Okay', description: 'Okay (mock)', until: null },
            reservationExpiresAt: new Date(Date.now() + 60000).toISOString() };
        }
      } else if (/^\/api\/targets\/\d+\/status$/.test(url.pathname)) {
        const id = Number(url.pathname.split('/')[3]);
        data = { id, faction: { id: 77001, name: 'Mock Target Faction' }, checkedAt: new Date(Date.now()).toISOString(),
          status: { state: id === 102 ? 'Hospital' : 'Okay', description: id === 102 ? 'In hospital (mock)' : 'Okay (mock)',
            until: id === 102 ? Math.floor(Date.now() / 1000) + 1200 : null } };
      } else if (url.pathname === '/api/suggestions' && request.method === 'GET') {
        const offset = Number(url.searchParams.get('offset') || 0);
        const view = url.searchParams.get('view');
        const matching = window.__mock.suggestions.filter(row => view === 'mine' ? row.suggestedBy.id === player.id : row.status === 'pending');
        data = { canReview: window.__mock.canReview, suggestions: structuredClone(matching.slice(offset, offset + 50)),
          nextOffset: matching.length > offset + 50 ? offset + 50 : null };
      } else if (url.pathname === '/api/suggestions' && request.method === 'POST') {
        const body = JSON.parse(request.data); status = 201;
        const row = { ...body, id: `00000000-0000-4000-8000-${String(window.__mock.suggestions.length + 1).padStart(12, '0')}`,
          targetName: body.type === 'faction' ? 'Mock Suggested Faction' : 'Mock Suggested Player', status: 'pending',
          suggestedBy: { id: player.id, name: player.name, faction: player.faction }, createdAt: new Date(Date.now()).toISOString(),
          reviewedBy: null, reviewedAt: null };
        window.__mock.suggestions.push(row); data = { suggestion: structuredClone(row) };
      } else if (/^\/api\/suggestions\/[\da-f-]+\/review$/.test(url.pathname) && request.method === 'POST') {
        if (!window.__mock.canReview) {
          status = 403; data = { error: { code: 'REVIEW_NOT_ALLOWED', message: 'Mock leadership permission removed' } };
        } else {
          const row = window.__mock.suggestions.find(row => row.id === url.pathname.split('/')[3]);
          const decision = JSON.parse(request.data).decision;
          row.status = decision; row.reviewedBy = { id: player.id, name: player.name, faction: player.faction }; row.reviewedAt = new Date(Date.now()).toISOString();
          if (decision === 'approved') targets.push(makeTarget(row.targetId, 'Mock Approved Player', 200000));
          data = { suggestion: structuredClone(row), addedPlayers: decision === 'approved' ? 1 : 0 };
        }
      } else throw new Error(`Unexpected mock path: ${request.method} ${url.pathname}`);
      if (url.pathname === '/api/targets') window.__mock.feedResponses.push({ search: url.search, status,
        bytes: new TextEncoder().encode(JSON.stringify(data)).byteLength, data: structuredClone(data) });
      request.onload({ status,
        responseText: override?.invalidJson ? '{invalid JSON' : JSON.stringify(data),
        finalUrl: override?.finalUrl || request.url });
    }
    window.GM_xmlhttpRequest = request => {
      const url = new URL(request.url);
      if (url.origin !== window.__mock.serviceOrigin) throw new Error('Test attempted an unexpected provider request.');
      window.__mock.requests.push({ method: request.method, path: url.pathname, search: url.search, headers: request.headers, data: request.data, timeout: request.timeout });
      if (window.__mock.holds.includes(url.pathname)) window.__mock.pending.push(request);
      else setTimeout(() => respond(request), 1);
      return { abort() { request.onabort?.(); } };
    };
    window.__mock.release = pathname => {
      const pending = window.__mock.pending.filter(request => new URL(request.url).pathname === pathname);
      window.__mock.pending = window.__mock.pending.filter(request => new URL(request.url).pathname !== pathname);
      window.__mock.holds = window.__mock.holds.filter(value => value !== pathname);
      for (const request of pending) respond(request);
    };
  });
  if (beforeMount) await page.evaluate(beforeMount, beforeMountArgument);
  for (const script of scripts) await page.addScriptTag({ content: script });
  // PDA bootstrap deliberately blocks until the explicit readiness signal.
  if (await page.evaluate(() => Boolean(window.__resolvePdaPlatform))) {
    assert.equal(await page.evaluate(() => window.__mock.pda.calls.length), 0, 'no native requests before platform readiness');
    assert.equal(await page.evaluate(() => window.__mock.pda.storageCalls.length), 0, 'no native storage calls before platform readiness');
    await page.evaluate(() => window.__resolvePdaPlatform());
  }
  if (scripts.includes(source)) await wait(page, () => Boolean(window.__targetlistShadow?.querySelector('.launcher')));
  return page;
}

async function shadow(page, selector, operation, argument) {
  return page.evaluate(({ selector, operation, argument }) => {
    const node = window.__targetlistShadow.querySelector(selector);
    if (!node) throw new Error(`Missing UI element: ${selector}`);
    if (operation === 'click') node.click();
    if (operation === 'fill') { node.value = argument; node.dispatchEvent(new Event('input', { bubbles: true })); }
    if (operation === 'select') { node.value = argument; node.dispatchEvent(new Event('change', { bubbles: true })); }
    if (operation === 'submit') node.requestSubmit();
    if (operation === 'text') return node.textContent;
  }, { selector, operation, argument });
}
async function wait(page, expression) {
  await page.waitForFunction(expression, undefined, { timeout: 5000 });
}
async function refreshMockFeed(page) {
  const before = await page.evaluate(() => window.__mock.feedResponses.length);
  await page.evaluate(() => {
    window.__mockNow += 1000;
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForFunction(before => window.__mock.feedResponses.length === before + 1, before, { timeout: 5000 });
}

function makePerformanceFeed({ size = 1000, reservation = false } = {}) {
  const mock = window.__mock, template = structuredClone(mock.targets[0]);
  mock.delta = true; mock.reservations = reservation ? { supported: true, leaseMs: 60000 } : null;
  mock.targets.splice(0, mock.targets.length, ...Array.from({ length: size }, (_, index) => ({
    ...structuredClone(template), id: index < 3 ? 101 + index : 10000 + index,
    name: `Performance target ${String(index + 1).padStart(4, '0')}`, notes: `Approved performance reason ${index + 1}.`,
    status: { state: 'Okay', description: 'Okay (mock)', until: null }, checkedAt: new Date(Date.now()).toISOString()
  })));
  mock.store.set(`targetlist.session.${mock.serviceOrigin}`, {
    token: 'mock-session-token', expiresAt: new Date(Date.now() + 3600000).toISOString()
  });
  const content = document.createElement('main'); content.id = 'content-wrapper';
  content.style.cssText = 'margin:100px 20px 20px;max-width:760px';
  content.innerHTML = '<h1>Peer [101]</h1><p>Mock native profile content.</p>';
  document.body.append(content);
  if (reservation) mock.holds.push('/api/targets/101/reservation');
}

async function checkDeltaRendering(pageContext, scripts, mode) {
  const viewport = mode === 'PDA' ? { width: 390, height: 844 } : { width: 1280, height: 960 };
  const page = await mount(viewport, scripts, pageContext, makePerformanceFeed, {}, 'https://www.torn.com/profiles.php?XID=101');
  await wait(page, () => window.__mock.feedResponses.length === 1 && Boolean(document.getElementById('nwa-target-page-notice')));
  const closed = await page.evaluate(() => ({ cards: window.__targetlistShadow.querySelectorAll('.card').length,
    nodes: window.__targetlistShadow.querySelectorAll('*').length, panelClosed: window.__targetlistShadow.querySelector('.panel').hidden }));
  assert.equal(closed.cards, 0, `${mode}: restoring a large pool does not create hidden cards`);
  assert.equal(closed.panelClosed, true);
  await shadow(page, '.settings-toggle', 'click');
  await wait(page, () => window.__targetlistShadow.querySelectorAll('.card').length === 1000);
  const openedNodes = await page.evaluate(() => window.__targetlistShadow.querySelectorAll('*').length);
  await page.evaluate(() => {
    const root = window.__targetlistShadow;
    const card = id => [...root.querySelectorAll('.card')].find(node => node.querySelector('.name').textContent.includes(`[${id}]`));
    const search = root.querySelector('input[type=search]'); search.focus();
    root.querySelector('.scroll').scrollTop = 650;
    window.__performanceNodes = { card101: card(101), card102: card(102), card103: card(103),
      children101: [...card(101).querySelectorAll('*')], children102: [...card(102).querySelectorAll('*')],
      search, minimum: root.querySelector('[aria-label="Minimum target stats as percent of your total"]'),
      maximum: root.querySelector('[aria-label="Maximum target stats as percent of your total"]'),
      age: root.querySelector('[aria-label="Maximum estimate age in days"]'),
      scroll: root.querySelector('.scroll').scrollTop };
  });
  await refreshMockFeed(page);
  assert.deepEqual(await page.evaluate(() => {
    const root = window.__targetlistShadow, nodes = window.__performanceNodes;
    return { cards: [nodes.card101, nodes.card102, nodes.card103].every(node => node.isConnected),
      children: nodes.children101.every((node, index) => nodes.card101.querySelectorAll('*')[index] === node),
      search: root.querySelector('input[type=search]') === nodes.search,
      minimum: root.querySelector('[aria-label="Minimum target stats as percent of your total"]') === nodes.minimum,
      maximum: root.querySelector('[aria-label="Maximum target stats as percent of your total"]') === nodes.maximum,
      age: root.querySelector('[aria-label="Maximum estimate age in days"]') === nodes.age,
      focus: root.activeElement === nodes.search, scroll: root.querySelector('.scroll').scrollTop === nodes.scroll };
  }), { cards: true, children: true, search: true, minimum: true, maximum: true, age: true, focus: true, scroll: true },
  `${mode}: an unchanged delta preserves exact cards, descendants, settings, scroll and focus`);
  await page.evaluate(() => Object.assign(window.__mock.targets[0], {
    status: { state: 'Hospital', description: 'In hospital (delta)', until: Math.floor(Date.now() / 1000) + 600 },
    checkedAt: new Date(Date.now()).toISOString()
  }));
  await refreshMockFeed(page);
  assert.deepEqual(await page.evaluate(() => {
    const nodes = window.__performanceNodes;
    return { article: nodes.card101.isConnected, changed: nodes.card101.textContent.includes('Hospital'),
      changedChildren: nodes.children101.some((node, index) => nodes.card101.querySelectorAll('*')[index] !== node),
      unchangedArticle: nodes.card102.isConnected,
      unchangedChildren: nodes.children102.every((node, index) => nodes.card102.querySelectorAll('*')[index] === node) };
  }), { article: true, changed: true, changedChildren: true, unchangedArticle: true, unchangedChildren: true },
  `${mode}: a changed status patches only that target while preserving its keyed article`);
  assert.equal(await page.evaluate(() => window.__mock.feedResponses.at(-1).data.updates.length), 1);
  await page.evaluate(() => {
    const mock = window.__mock;
    Object.assign(mock.targets[0], { estimatedStats: 360000, reason: 'Updated approved delta reason.' });
    mock.targets.splice(mock.targets.findIndex(target => target.id === 102), 1);
    mock.targets.push({ ...structuredClone(mock.targets[1]), id: 99001, name: 'New delta target' });
  });
  await refreshMockFeed(page);
  assert.equal(await cardSnapshot(page, 102), null, `${mode}: removed targets disappear`);
  assert.ok(await cardSnapshot(page, 99001), `${mode}: delta additions appear`);
  assert.match((await cardSnapshot(page, 101)).text, /360K.*Updated approved delta reason/s);
  assert.match(await page.evaluate(() => window.__playerNoticeShadow.querySelector('.estimate').textContent), /360K/);
  assert.match(await page.evaluate(() => window.__playerNoticeShadow.querySelector('.full-reason').textContent), /Updated approved delta reason/);
  await page.evaluate(() => window.__mock.feedSnapshots.clear());
  await refreshMockFeed(page);
  const metrics = await page.evaluate(() => {
    const responses = window.__mock.feedResponses;
    return { full: responses[0].bytes, unchanged: responses[1].bytes, oneStatus: responses[2].bytes,
      reset: responses.at(-1).data.sync.reset, resetCount: responses.at(-1).data.targets.length,
      initialRequests: responses.filter(response => response.search === '').length,
      cursorRequests: responses.slice(1).every(response => new URLSearchParams(response.search).has('cursor')) };
  });
  assert.equal(metrics.reset, true, `${mode}: an unknown server cursor returns a full reset`);
  assert.equal(metrics.resetCount, 1000);
  assert.equal(metrics.initialRequests, 1, `${mode}: subsequent synchronization does not request unconditional full feeds`);
  assert.equal(metrics.cursorRequests, true);
  assert(metrics.unchanged < metrics.full / 100 && metrics.oneStatus < metrics.full / 100,
    `${mode}: unchanged and single-target deltas are under one percent of the full fixture payload`);
  assert.equal(await cardSnapshot(page, 102), null);
  assert.match((await cardSnapshot(page, 101)).text, /Updated approved delta reason/);
  await shadow(page, '.header .icon', 'click');
  await shadow(page, '.settings-toggle', 'click');
  assert.equal(await page.evaluate(() => window.__targetlistShadow.querySelector('input[type=search]') === window.__performanceNodes.search), true,
    `${mode}: closing and reopening the same view preserves controls`);
  await page.evaluate(() => {
    const minimum = window.__targetlistShadow.querySelector('[aria-label="Minimum target stats as percent of your total"]');
    minimum.focus(); minimum.value = ''; minimum.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await refreshMockFeed(page);
  assert.equal(await page.evaluate(() => {
    const minimum = window.__targetlistShadow.querySelector('[aria-label="Minimum target stats as percent of your total"]');
    return minimum === window.__performanceNodes.minimum && minimum.value === '' && window.__targetlistShadow.activeElement === minimum;
  }), true, `${mode}: synchronization preserves an unfinished minimum-stats edit`);
  await page.evaluate(() => { window.__performanceNodes.minimum.value = '10'; });
  await openSuggestions(page);
  await fillSuggestion(page, { type: 'faction', targetId: '45001', comment: 'Keep this unfinished faction reason while target data updates.' });
  await page.evaluate(() => {
    const root = window.__targetlistShadow, comment = root.querySelector('textarea'); comment.focus();
    window.__draftNodes = { comment, type: root.querySelector('[aria-label="Suggestion type"]'), id: root.querySelector('[aria-label="Player or faction ID"]') };
  });
  await refreshMockFeed(page);
  await shadow(page, '.header .icon', 'click');
  await shadow(page, '.settings-toggle', 'click');
  assert.deepEqual(await page.evaluate(() => {
    const root = window.__targetlistShadow, nodes = window.__draftNodes;
    return { comment: root.querySelector('textarea') === nodes.comment, type: root.querySelector('[aria-label="Suggestion type"]') === nodes.type,
      id: root.querySelector('[aria-label="Player or faction ID"]') === nodes.id, commentValue: nodes.comment.value, typeValue: nodes.type.value, idValue: nodes.id.value };
  }), { comment: true, type: true, id: true, commentValue: 'Keep this unfinished faction reason while target data updates.', typeValue: 'faction', idValue: '45001' },
  `${mode}: target deltas and closing/reopening preserve the unsent suggestion and its exact controls`);
  await clickButton(page, 'Targets');
  await page.evaluate(() => { window.__mockNow += 31000; });
  await refreshMockFeed(page);
  assert.equal(await page.evaluate(() => window.__mock.feedResponses.at(-1).data.updates.length), 0,
    `${mode}: elapsed time alone does not invent a changed target or a new checkedAt`);
  assert.equal((await cardSnapshot(page, 103)).attack, null,
    `${mode}: a newly authorized unchanged delta cannot renew the old target status`);
  assert.match((await cardSnapshot(page, 103)).text, /Status needs checking/);
  await page.evaluate(() => {
    window.__mock.holds.push('/api/targets');
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await wait(page, () => window.__mock.pending.length === 1);
  await page.evaluate(() => { window.__mockNow += 3600001; window.__mock.runIntervals(); });
  await wait(page, () => Boolean(window.__targetlistShadow.querySelector('form.login')));
  await page.evaluate(() => window.__mock.release('/api/targets'));
  await page.waitForTimeout(30);
  assert.equal(await page.evaluate(() => window.__targetlistShadow.querySelectorAll('.card').length), 0,
    `${mode}: a late delta cannot restore expired access`);
  assert.equal(await page.evaluate(() => Boolean(document.getElementById('nwa-target-page-notice'))), false);
  await page.close();
  console.log(`PASS ${mode} delta synchronization, lazy 1,000-target settings, keyed status patches, preserved controls/scroll/focus, delisting, unknown-cursor reset and expiry races`);
  console.log(`PERF ${mode}: closed ${closed.cards} cards/${closed.nodes} nodes; opened 1,000 cards/${openedNodes} nodes; full ${metrics.full} bytes; unchanged delta ${metrics.unchanged} bytes; one-status delta ${metrics.oneStatus} bytes`);

  const finder = await mount(viewport, scripts, pageContext, makePerformanceFeed, { reservation: true });
  await wait(finder, () => window.__mock.feedResponses.length === 1);
  await shadow(finder, '.launcher', 'click');
  await wait(finder, () => window.__mock.pending.length === 1);
  assert.equal(await finder.evaluate(() => window.__mock.pending[0].url.endsWith('/api/targets/101/reservation')), true);
  assert.equal(await finder.evaluate(() => window.__targetlistShadow.querySelectorAll('.card').length), 0);
  assert.equal(await finder.evaluate(() => window.__mock.requests.filter(request => request.path === '/api/targets').length), 1);
  await finder.close();
  console.log(`PASS ${mode} finder selects from the preloaded 1,000-target pool without building settings cards or fetching another full feed`);

  const denied = await mount(viewport, scripts, pageContext, makePerformanceFeed, {}, 'https://www.torn.com/profiles.php?XID=101');
  await wait(denied, () => window.__mock.feedResponses.length === 1 && Boolean(document.getElementById('nwa-target-page-notice')));
  await denied.evaluate(() => { window.__mock.overrides['/api/targets'] = { status: 403,
    data: { error: { code: 'FACTION_NOT_ALLOWED', message: 'Mock faction authorization revoked.' } } }; });
  await refreshMockFeed(denied);
  await wait(denied, () => Boolean(window.__targetlistShadow.querySelector('form.login')));
  assert.equal(await denied.evaluate(() => new URLSearchParams(window.__mock.feedResponses.at(-1).search).has('cursor')), true,
    `${mode}: revocation is tested on a cursor request`);
  assert.equal(await denied.evaluate(() => window.__targetlistShadow.querySelectorAll('.card').length), 0);
  assert.equal(await denied.evaluate(() => Boolean(document.getElementById('nwa-target-page-notice'))), false);
  assert.equal(await denied.evaluate(() => window.__mock.store.has(`targetlist.session.${window.__mock.serviceOrigin}`)), false);
  await denied.close();
  console.log(`PASS ${mode} deltas preserve unfinished stat edits and suggestion drafts; unchanged feeds retain status age, and cursor requests cannot bypass revoked faction authorization`);
}
async function login(page) {
  await shadow(page, '.settings-toggle', 'click');
  await shadow(page, 'input[type=password]', 'fill', 'MockLimitedKey01');
  await shadow(page, 'form', 'submit');
  await wait(page, () => window.__targetlistShadow.querySelectorAll('.card').length === 4);
}
async function cardAction(page, id) {
  await page.evaluate(id => {
    const card = [...window.__targetlistShadow.querySelectorAll('.card')]
      .find(node => node.querySelector('.name').textContent.includes(`[${id}]`));
    if (!card) throw new Error(`Missing card for ${id}`);
    card.querySelector('button').click();
  }, id);
}
async function cardSnapshot(page, id) {
  return page.evaluate(id => {
    const card = [...window.__targetlistShadow.querySelectorAll('.card')]
      .find(node => node.querySelector('.name').textContent.includes(`[${id}]`));
    return card ? { text: card.textContent, attack: card.querySelector('a.attack')?.getAttribute('href') || null } : null;
  }, id);
}
async function signOut(page) {
  await shadow(page, '.profile button', 'click');
  await wait(page, () => Boolean(window.__targetlistShadow.querySelector('form.login')));
}
async function clickButton(page, text) {
  await page.evaluate(text => {
    const node = [...window.__targetlistShadow.querySelectorAll('button')].find(button => button.textContent === text);
    if (!node) throw new Error(`Missing button: ${text}`);
    node.click();
  }, text);
}
async function openSuggestions(page) {
  await clickButton(page, 'Suggestions');
  await wait(page, () => Boolean(window.__targetlistShadow.querySelector('.suggestionform')) && !window.__targetlistShadow.querySelector('.queueheader button').disabled);
}
async function fillSuggestion(page, { type = 'player', targetId = '22001', comment = 'Mock useful chain target.' } = {}) {
  await shadow(page, '[aria-label="Suggestion type"]', 'select', type);
  await shadow(page, '[aria-label="Player or faction ID"]', 'fill', targetId);
  await shadow(page, 'textarea', 'fill', comment);
}
async function submitSuggestion(page) {
  await shadow(page, '.suggestionform', 'submit');
}

async function assertDock(page) {
  const geometry = await page.evaluate(() => {
    const root = window.__targetlistShadow;
    const launcher = root.querySelector('.launcher');
    const gear = root.querySelector('.settings-toggle');
    const svg = gear.querySelector('svg');
    const rect = node => {
      const { left, right, top, bottom, width, height } = node.getBoundingClientRect();
      return { left, right, top, bottom, width, height };
    };
    const launcherStyle = getComputedStyle(launcher);
    return { launcher: rect(launcher), gear: rect(gear), label: launcher.textContent,
      color: launcherStyle.backgroundColor, textColor: launcherStyle.color,
      fontSize: launcherStyle.fontSize, fontWeight: launcherStyle.fontWeight, fontFamily: launcherStyle.fontFamily,
      gearColor: getComputedStyle(gear).backgroundColor, gearLabel: gear.getAttribute('aria-label'),
      svg: svg ? { ...rect(svg), namespace: svg.namespaceURI,
        visible: getComputedStyle(svg).visibility === 'visible' && getComputedStyle(svg).display !== 'none',
        whitePaint: [...svg.querySelectorAll('path')].some(path => ['fill', 'stroke']
          .some(property => getComputedStyle(path)[property] === 'rgb(255, 255, 255)')) } : null,
      version: document.getElementById('torn-targetlist-host').getAttribute('data-nwa-version'),
      width: innerWidth, height: innerHeight, documentWidth: document.documentElement.scrollWidth };
  });
  assert.equal(geometry.label, 'NWA');
  assert.equal(geometry.version, scriptVersion);
  assert.equal(geometry.color, 'rgb(0, 128, 0)');
  assert.equal(geometry.textColor, 'rgb(255, 255, 255)');
  assert.equal(geometry.fontSize, '14px');
  assert.equal(geometry.fontWeight, '400');
  assert.match(geometry.fontFamily, /Arial/);
  assert.equal(geometry.launcher.width, 40);
  assert.equal(geometry.launcher.height, 30);
  assert(Math.abs(geometry.launcher.right - geometry.width) <= 1, JSON.stringify(geometry));
  assert(Math.abs(geometry.launcher.top - geometry.height * 0.17) <= 1, JSON.stringify(geometry));
  assert.equal(geometry.gear.top, geometry.launcher.bottom);
  assert.equal(geometry.gear.width, 24);
  assert.equal(geometry.gear.height, 24);
  assert.equal(geometry.gearColor, 'rgb(0, 128, 0)');
  assert(Math.abs(geometry.gear.right - geometry.width) <= 1, JSON.stringify(geometry));
  assert(geometry.gear.left >= geometry.launcher.left && geometry.gear.right <= geometry.width + 1,
    JSON.stringify(geometry));
  assert(geometry.launcher.top >= 0 && geometry.gear.bottom <= geometry.height, JSON.stringify(geometry));
  assert(geometry.svg, 'Settings button has no SVG gear');
  assert.equal(geometry.svg.namespace, 'http://www.w3.org/2000/svg');
  assert.equal(geometry.svg.width, 16);
  assert.equal(geometry.svg.height, 16);
  assert.equal(geometry.svg.visible, true);
  assert.equal(geometry.svg.whitePaint, true);
  assert.match(geometry.gearLabel, /settings/i);
  assert(geometry.documentWidth <= geometry.width, JSON.stringify(geometry));
}

async function noticeGeometry(page) {
  return page.evaluate(() => {
    const root = window.__playerNoticeShadow;
    const host = document.getElementById('nwa-target-page-notice');
    const rect = node => {
      const { left, right, top, bottom, width, height } = node.getBoundingClientRect();
      return { left, right, top, bottom, width, height };
    };
    const reason = root.querySelector('.reason');
    const content = document.querySelector('#content-wrapper');
    return {
      host: rect(host), summary: rect(root.querySelector('summary')),
      open: root.querySelector('details').open, headingTop: content.querySelector('h1').getBoundingClientRect().top,
      nextContentTop: content.querySelector('p')?.getBoundingClientRect().top,
      contentHeight: content.getBoundingClientRect().height,
      parent: host.parentElement.tagName, position: getComputedStyle(host).position,
      placement: host.getAttribute('data-placement'),
      estimate: root.querySelector('.estimate')?.textContent,
      estimateDetail: root.querySelector('.estimate-detail')?.textContent,
      reason: { text: reason.textContent, width: reason.clientWidth, scrollWidth: reason.scrollWidth,
        overflow: getComputedStyle(reason).overflow, ellipsis: getComputedStyle(reason).textOverflow,
        whiteSpace: getComputedStyle(reason).whiteSpace, display: getComputedStyle(reason).display },
      fullReason: root.querySelector('.full-reason').textContent, detail: rect(root.querySelector('.detail')),
      viewportWidth: innerWidth, documentWidth: document.documentElement.scrollWidth,
    };
  });
}

function assertCompactNotice(geometry, longReason = false) {
  assert.equal(geometry.open, false, 'the reason chip starts collapsed');
  assert.equal(geometry.parent, 'BODY', 'the badge escapes clipped Torn and FFScouter containers');
  assert.equal(geometry.position, 'fixed', 'the badge contributes no row to page flow');
  assert.match(geometry.estimate, /^Est\. /, 'NWA shows its own stored estimate');
  assert(geometry.host.height > 0 && geometry.host.height <= 22.1, JSON.stringify(geometry));
  assert(geometry.host.width > 0 && geometry.host.width <= 340.1, JSON.stringify(geometry));
  assert(geometry.host.left >= 0 && geometry.host.right <= geometry.viewportWidth && geometry.documentWidth <= geometry.viewportWidth, JSON.stringify(geometry));
  if (longReason) {
    assert.equal(geometry.fullReason, geometry.reason.text, 'the complete reason remains available in the popup');
    if (geometry.reason.display !== 'none') {
      assert(geometry.reason.scrollWidth > geometry.reason.width, 'a long reason is visually truncated in the collapsed row');
      assert.equal(geometry.reason.whiteSpace, 'nowrap');
      assert.equal(geometry.reason.overflow, 'hidden');
      assert.equal(geometry.reason.ellipsis, 'ellipsis');
    }
  }
}

async function clickNotice(page, touch = false) {
  const { summary } = await noticeGeometry(page);
  const x = summary.left + summary.width / 2;
  const y = summary.top + summary.height / 2;
  if (touch) await page.touchscreen.tap(x, y);
  else await page.mouse.click(x, y);
}

async function tapShadow(page, selector) {
  const point = await page.evaluate(selector => {
    const node = window.__targetlistShadow.querySelector(selector);
    if (!node) throw new Error(`Missing touch control: ${selector}`);
    const rect = node.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  }, selector);
  await page.touchscreen.tap(point.x, point.y);
}

function makeFfscouterFixture(input) {
  const { reason, longLine = false, marginTop = 140 } = typeof input === 'object' ? input : { reason: input };
  const content = document.createElement('main'); content.id = 'content-wrapper';
  content.style.cssText = `margin:${marginTop}px 20px 20px;max-width:760px;overflow:hidden`;
  content.innerHTML = '<h1>Attacking</h1>'
    + '<div class="ffscouter-info-line" style="font:12px/22px Arial,sans-serif;white-space:nowrap">'
    + '<div class="ffscouter-react-child" style="display:contents">'
    + '<span class="ffscouter-first-line" style="display:inline-block;padding:0 4px;border-radius:3px;background:#253b32">FairFight: 2.85</span>'
    + '<svg class="ffscouter-source-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" style="width:16px;height:16px;margin-left:4px;vertical-align:middle" aria-label="Estimate source">'
    + '<circle cx="8" cy="8" r="6" fill="#79ad8e"/></svg><br>'
    + '<span class="ffscouter-battle-estimate">Estimated Battle Stats: 5.2M</span></div></div>'
    + '<p id="next-attack-content">Mock Torn attack controls and defender details.</p>'
    + '<div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:18px;padding:16px;border:1px solid #354956;border-radius:5px;background:#19232d">'
    + '<div><strong>MockChainer [90001]</strong><div style="height:8px;margin:12px 0;background:#69b24a"></div>'
    + '<div style="height:110px;background:#14222d;padding:12px;font-size:12px">Attacker · mock browser fixture</div></div>'
    + '<div class="defender-wrapper"><div class="labelsContainer_mock"><a href="https://www.torn.com/profiles.php?XID=101" style="color:inherit">Willow [101]</a></div>'
    + '<div style="height:8px;margin:12px 0;background:#b78b4c"></div>'
    + '<div style="height:110px;background:#14222d;padding:12px;font-size:12px">Defender · mock browser fixture</div></div></div>';
  if (longLine) {
    const line = content.querySelector('.ffscouter-info-line');
    line.style.font = '14px/22px Arial,sans-serif'; line.style.whiteSpace = 'normal';
    line.querySelector('.ffscouter-first-line').textContent = 'FairFight: 2.39 (Moderately difficult) Est. Stats: 724M';
    line.querySelector('br').remove(); line.querySelector('.ffscouter-battle-estimate').remove();
  }
  document.body.append(content); window.__mock.targets[0].reason = reason;
  window.__noticeFlowBefore = {
    headingTop: content.querySelector('h1').getBoundingClientRect().top,
    nextContentTop: content.querySelector('p').getBoundingClientRect().top,
    height: content.getBoundingClientRect().height,
    fairFightText: content.querySelector('.ffscouter-info-line').textContent
  };
}

async function assertAlongsideFfscouter(page) {
  const geometry = await noticeGeometry(page);
  const row = await page.evaluate(() => {
    const line = document.querySelector('.ffscouter-first-line').getBoundingClientRect();
    const sourceIcon = document.querySelector('.ffscouter-source-icon').getBoundingClientRect();
    return { left: line.left, right: line.right, top: line.top, bottom: line.bottom,
      sourceRight: sourceIcon.right,
      text: document.querySelector('.ffscouter-info-line').textContent,
      bodyChild: document.getElementById('nwa-target-page-notice').parentNode === document.body,
      reactRect: document.querySelector('.ffscouter-react-child').getBoundingClientRect().height };
  });
  assertCompactNotice(geometry, true);
  assert.equal(geometry.placement, 'ffscouter');
  assert.equal(row.reactRect, 0, 'the fixture exercises FFScouter display:contents React children');
  assert(geometry.host.left >= row.sourceRight + 2, 'NWA does not overlap FairFight badge padding or its trailing source icon');
  assert(Math.abs((geometry.host.top + geometry.host.bottom) / 2 - (row.top + row.bottom) / 2) <= 3,
    `NWA must share the first FairFight line: ${JSON.stringify({ geometry, row })}`);
  assert.equal(row.bodyChild, true, 'the badge avoids clipping by the FFScouter container');
  assert.match(geometry.estimate, /300K/, 'NWA uses its own estimate rather than FFScouter rendered text');
  assert.doesNotMatch(geometry.estimate, /5\.2M/);
  return geometry;
}

try {
  const early = await mount(undefined, [], context);
  await early.evaluate(() => {
    window.__earlyBody = document.body;
    document.body.remove();
  });
  await early.addScriptTag({ content: source });
  assert.equal(await early.evaluate(() => document.getElementById('torn-targetlist-host')), null);
  await early.evaluate(() => {
    document.documentElement.append(window.__earlyBody);
    document.dispatchEvent(new Event('DOMContentLoaded'));
  });
  await wait(early, () => Boolean(window.__targetlistShadow?.querySelector('.launcher')));
  await early.addScriptTag({ content: source });
  assert.equal(await early.evaluate(() => document.querySelectorAll('#torn-targetlist-host').length), 1);
  await early.close();
  console.log('PASS early injection waits for the Torn document body and repeated execution mounts once');

  const legacyFirst = await mount(undefined, [legacySource]);
  assert.equal(await shadow(legacyFirst, '.launcher', 'text'), '◎ Target list');
  await legacyFirst.addScriptTag({ content: source });
  await assertDock(legacyFirst);
  assert.equal(await legacyFirst.evaluate(() => document.querySelectorAll('#torn-targetlist-host').length), 1);
  assert.equal(await legacyFirst.evaluate(() => window.__targetlistShadow.querySelectorAll('.launcher').length), 1);
  await legacyFirst.close();

  const latestFirst = await mount();
  await latestFirst.evaluate(() => { window.__firstNwaHost = document.getElementById('torn-targetlist-host'); });
  await latestFirst.addScriptTag({ content: legacySource });
  await assertDock(latestFirst);
  await latestFirst.addScriptTag({ content: source });
  await assertDock(latestFirst);
  assert.equal(await latestFirst.evaluate(() => document.querySelectorAll('#torn-targetlist-host').length), 1);
  assert.equal(await latestFirst.evaluate(() => document.getElementById('torn-targetlist-host') === window.__firstNwaHost), true);
  assert.equal(await latestFirst.evaluate(() => window.__targetlistShadow.querySelectorAll('.launcher,.settings-toggle').length), 2);
  await latestFirst.close();
  console.log('PASS actual installable bundle replaces the old Target list host, survives reverse load order, and mounts once per version');

  const touchContext = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  try {
    await touchContext.route('**/*', route => { networkRequests++; return route.abort(); });
    const touch = await mount({ width: 390, height: 844 }, [source], touchContext);
    assert.equal(await touch.evaluate(() => matchMedia('(pointer:coarse)').matches), true);
    await assertDock(touch);
    await touch.close();
  } finally { await touchContext.close(); }
  console.log('PASS compact NWA button and visible SVG gear retain the same dimensions on touch devices');

  const dock = await mount();
  await assertDock(dock);
  await dock.screenshot({ path: path.join(artifacts, 'browser-nwa-launcher-desktop.png'), fullPage: true });
  await dock.setViewportSize({ width: 390, height: 844 });
  await assertDock(dock);
  await dock.screenshot({ path: path.join(artifacts, 'browser-nwa-launcher-mobile.png'), fullPage: true });
  await shadow(dock, '.launcher', 'click');
  await wait(dock, () => Boolean(window.__targetlistShadow.querySelector('form.login')));
  assert.match(await shadow(dock, '.header', 'text'), /NWA/);
  assert.match(await shadow(dock, '.header', 'text'), /North West Alliance/);
  const disclosure = await dock.evaluate(() => {
    const root = window.__targetlistShadow;
    const form = root.querySelector('form.login');
    const input = form.querySelector('input');
    const notice = root.getElementById(input.getAttribute('aria-describedby'));
    return { text: notice.textContent, first: form.firstElementChild === notice, submit: form.querySelector('button').textContent };
  });
  assert.equal(disclosure.first, true);
  assert.match(disclosure.text, /saved encrypted.*Supabase.*up to 7 days.*while you are offline/s);
  assert.match(disclosure.text, /Sign out and remove key/);
  assert.equal(disclosure.submit, 'Sign in and save key');
  assert.equal(await dock.evaluate(() => window.__mock.requests.length), 0);
  await shadow(dock, '.settings-toggle', 'click');
  await wait(dock, () => window.__targetlistShadow.querySelector('.panel').hidden);
  await shadow(dock, '.settings-toggle', 'click');
  await wait(dock, () => !window.__targetlistShadow.querySelector('.panel').hidden);
  assert.equal(await dock.evaluate(() => {
    const scroll = window.__targetlistShadow.querySelector('.scroll');
    return scroll.scrollWidth <= scroll.clientWidth + 1;
  }), true, 'the encrypted-key notice fits the mobile login panel without horizontal overflow');
  await dock.screenshot({ path: path.join(artifacts, 'browser-login-mobile.png'), fullPage: true });
  await dock.close();
  console.log('PASS green NWA edge button, attached settings gear, desktop/mobile launcher screenshots, login without a session');

  const loginGuide = await mount();
  await shadow(loginGuide, '.settings-toggle', 'click');
  const loginClip = await loginGuide.evaluate(() => {
    // Remove only test-page labels outside the actual userscript before clipping its controls.
    document.querySelector('.mock').remove();
    for (const label of [...document.body.children]) if (label.textContent === 'MOCK API DATA') label.remove();
    const root = window.__targetlistShadow;
    const panel = root.querySelector('.panel').getBoundingClientRect();
    const dock = root.querySelector('.dock').getBoundingClientRect();
    const left = Math.max(0, Math.floor(Math.min(panel.left, dock.left)) - 8);
    const top = Math.max(0, Math.floor(Math.min(panel.top, dock.top)) - 8);
    const right = Math.min(innerWidth, Math.ceil(Math.max(panel.right, dock.right)) + 8);
    const bottom = Math.min(innerHeight, Math.ceil(Math.max(panel.bottom, dock.bottom)) + 8);
    const input = root.querySelector('input[type=password]');
    if (input.value) throw new Error('Documentation screenshot must contain a blank API key field');
    return { x: left, y: top, width: right - left, height: bottom - top };
  });
  assert(loginClip.width >= 680 && loginClip.width <= 720, JSON.stringify(loginClip));
  assert.match(await shadow(loginGuide, '#nwa-key-use', 'text'), /saved encrypted.*Supabase.*expires after up to 7 days.*while you are offline/s);
  assert.equal(await shadow(loginGuide, '.login button', 'text'), 'Sign in and save key');
  assert.equal(await loginGuide.evaluate(() => window.__mock.requests.length), 0);
  await loginGuide.screenshot({ path: path.join(artifacts, 'browser-login-guide.png'), clip: loginClip });
  if (process.env.TARGETLIST_UPDATE_DOC_IMAGES === '1') {
    await loginGuide.screenshot({ path: path.join(workspace, 'docs/images/nwa-login.png'), clip: loginClip });
  }
  await loginGuide.close();
  console.log('PASS blank-key login preview uses the actual panel and NWA controls; tracked documentation image changes only when explicitly requested');

  const legacyBackend = await mount();
  await legacyBackend.evaluate(() => {
    window.__mock.overrides['/api/session'] = { status: 200, data: {
      token: 'legacy-backend-session', expiresAt: new Date(Date.now() + 3600000).toISOString(), player: window.__mock.player
    } };
  });
  await shadow(legacyBackend, '.settings-toggle', 'click');
  await shadow(legacyBackend, 'input[type=password]', 'fill', 'MockLimitedKey01');
  await shadow(legacyBackend, 'form', 'submit');
  await wait(legacyBackend, () => window.__targetlistShadow.querySelector('.error').textContent.includes('Update the NWA backend to enable encrypted key storage'));
  const legacyRequests = await legacyBackend.evaluate(() => structuredClone(window.__mock.requests));
  assert.equal(legacyRequests.length, 2);
  assert.equal(legacyRequests[0].method, 'POST');
  assert.equal(JSON.parse(legacyRequests[0].data).storeKey, true);
  assert.equal(legacyRequests[1].method, 'DELETE');
  assert.equal(legacyRequests[1].headers.Authorization, 'Bearer legacy-backend-session');
  assert.equal(await legacyBackend.evaluate(() => window.__mock.store.size), 0);
  assert.equal(await legacyBackend.evaluate(() => window.__targetlistShadow.querySelectorAll('.card').length), 0);
  assert.equal(legacyBackend.url(), 'about:blank');
  await legacyBackend.close();
  console.log('PASS incompatible backend storage confirmation triggers session cleanup and never adopts a token or loads targets');

  const quick = await mount();
  await login(quick);
  await shadow(quick, '.settings-toggle', 'click');
  const attackUrl = 'https://www.torn.com/page.php?sid=attack&user2ID=101';
  let destination, statusRequests;
  await quick.route(attackUrl, async route => {
    // Fulfill this one destination locally; no Torn page or attack request is sent.
    destination = { url: route.request().url(), navigation: route.request().isNavigationRequest(),
      requests: statusRequests };
    await route.fulfill({ status: 200, contentType: 'text/html',
      body: '<!doctype html><title>Mock attack destination</title><h1>Mock destination only: no attack executed</h1>' });
  });
  await quick.evaluate(() => { window.__mock.holds.push('/api/targets/101/status'); });
  const pagesBeforeFind = context.pages().length;
  await shadow(quick, '.launcher', 'click');
  await wait(quick, () => window.__mock.pending.length === 1);
  assert.equal(quick.url(), 'about:blank');
  assert.equal(destination, undefined);
  assert.equal(await quick.evaluate(() => window.__targetlistShadow.querySelector('.launcher').disabled), true);
  statusRequests = await quick.evaluate(() => structuredClone(window.__mock.requests));
  const navigated = quick.waitForURL(attackUrl, { timeout: 5000 });
  await quick.evaluate(() => window.__mock.release('/api/targets/101/status'));
  await navigated;
  assert.equal(context.pages().length, pagesBeforeFind);
  assert.equal(destination.url, attackUrl);
  assert.equal(destination.navigation, true);
  assert.equal(destination.requests.at(-1).method, 'GET');
  assert.equal(destination.requests.at(-1).path, '/api/targets/101/status');
  assert.equal(await quick.locator('h1').textContent(), 'Mock destination only: no attack executed');
  await quick.close();
  console.log('PASS NWA waits for a live status check then opens the same-tab attack page, fulfilled entirely by a local mock');

  const estimateSettings = await mount(undefined, [source], context, () => {
    const mock = window.__mock;
    mock.reservations = { supported: true, leaseMs: 60000 };
    mock.store.set(`targetlist.preferences.${mock.serviceOrigin}`, { recentTargets: [{ id: 101, at: Date.now() }] });
    mock.targets[0].reason = '<strong>Alliance attack history</strong>';
    mock.targets[0].notes = 'Legacy notes should not be shown';
  });
  await login(estimateSettings);
  const estimateSelector = '[aria-label="Maximum estimate age in days"]';
  assert.equal(await estimateSettings.evaluate(selector => window.__targetlistShadow.querySelector(selector).value, estimateSelector), '7');
  assert.match((await cardSnapshot(estimateSettings, 104)).text, /Estimate too old \/ undated/);
  await shadow(estimateSettings, estimateSelector, 'select', '28');
  assert.match((await cardSnapshot(estimateSettings, 104)).text, /Possible match/);
  await shadow(estimateSettings, estimateSelector, 'select', '0');
  assert.equal(await estimateSettings.evaluate(selector => window.__targetlistShadow.querySelector(selector).value, estimateSelector), '28');
  await shadow(estimateSettings, estimateSelector, 'select', '365');
  assert.match(await shadow(estimateSettings, '.scroll', 'text'), /Extra caution is needed beyond 28 days/);
  await shadow(estimateSettings, estimateSelector, 'select', '28');
  await shadow(estimateSettings, 'input[type=search]', 'fill', 'ALLIANCE ATTACK HISTORY');
  assert.equal(await estimateSettings.evaluate(() => window.__targetlistShadow.querySelectorAll('.card').length), 1);
  assert.match((await cardSnapshot(estimateSettings, 101)).text, /Reason: <strong>Alliance attack history<\/strong>/);
  assert.doesNotMatch((await cardSnapshot(estimateSettings, 101)).text, /Legacy notes/);
  assert.equal(await estimateSettings.evaluate(() => window.__targetlistShadow.querySelector('.notes strong')), null);
  await shadow(estimateSettings, 'input[type=search]', 'fill', '');
  assert.equal(await estimateSettings.evaluate(() => window.__mock.store.get(`targetlist.preferences.${window.__mock.serviceOrigin}`).recentTargets.length), 1);
  await clickButton(estimateSettings, 'Clear recent targets');
  assert.equal(await estimateSettings.evaluate(() => window.__mock.store.get(`targetlist.preferences.${window.__mock.serviceOrigin}`).recentTargets.length), 0);
  assert.match(await shadow(estimateSettings, '.count', 'text'), /estimates too old or undated.*stats unknown.*ready now/);
  await estimateSettings.screenshot({ path: path.join(artifacts, 'browser-estimate-settings-desktop.png'), fullPage: true });
  for (const width of [390, 320]) {
    await estimateSettings.setViewportSize({ width, height: 844 });
    assert.equal(await estimateSettings.evaluate(() => {
      const scroll = window.__targetlistShadow.querySelector('.scroll');
      return scroll.scrollWidth <= scroll.clientWidth + 1 && document.documentElement.scrollWidth <= innerWidth;
    }), true, `estimate settings must fit ${width}px mobile width`);
    await estimateSettings.screenshot({ path: path.join(artifacts, `browser-estimate-settings-mobile-${width}.png`), fullPage: true });
  }
  await estimateSettings.close();
  console.log('PASS configurable estimate age, diagnostics, explicit recent-history clearing, searchable plain-text reasons, desktop and 390/320px mobile settings');

  const reservation = await mount(undefined, [source], context, () => {
    const mock = window.__mock;
    mock.reservations = { supported: true, leaseMs: 60000 };
    mock.targets[0].status = { state: 'Okay', description: 'Okay (cached mock)', until: null };
    mock.targets[0].checkedAt = new Date(Date.now()).toISOString();
    mock.targets[3].estimateUpdatedAt = Math.floor(Date.now() / 1000) - 3600;
    mock.reservedTargets.add(101);
    mock.holds.push('/api/targets/104/reservation');
  });
  await login(reservation); await shadow(reservation, '.settings-toggle', 'click');
  const leasedAttackUrl = 'https://www.torn.com/page.php?sid=attack&user2ID=104';
  await reservation.route(leasedAttackUrl, route => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><h1>Reserved mock target only</h1>' }));
  await shadow(reservation, '.launcher', 'click');
  await wait(reservation, () => window.__mock.pending.length === 1);
  assert.equal(reservation.url(), 'about:blank');
  const reservationRequests = await reservation.evaluate(() => structuredClone(window.__mock.requests));
  assert.deepEqual(reservationRequests.slice(-2).map(request => [request.method, request.path]), [
    ['POST', '/api/targets/101/reservation'], ['POST', '/api/targets/104/reservation']
  ]);
  assert.equal(reservationRequests.some(request => request.path.endsWith('/status')), false);
  assert(reservationRequests.slice(-2).every(request => request.timeout <= 3000));
  const reservedNavigation = reservation.waitForURL(leasedAttackUrl, { timeout: 5000 });
  await reservation.evaluate(() => window.__mock.release('/api/targets/104/reservation'));
  await reservedNavigation;
  assert.equal(await reservation.locator('h1').textContent(), 'Reserved mock target only');
  await reservation.close();
  console.log('PASS reservation conflict retries the next candidate and never navigates before a successful shared lease');

  const manualReservation = await mount(undefined, [source], context, () => {
    const mock = window.__mock;
    mock.reservations = { supported: true, leaseMs: 60000 };
    mock.targets[0].status = { state: 'Okay', description: 'Okay (cached mock)', until: null };
    mock.targets[0].checkedAt = new Date(Date.now()).toISOString();
    mock.holds.push('/api/targets/101/reservation');
  });
  await login(manualReservation);
  await manualReservation.route(attackUrl, route => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><h1>Manual reserved mock target only</h1>' }));
  assert.equal(await manualReservation.evaluate(() => window.__targetlistShadow.querySelector('.attack').tagName), 'BUTTON');
  await shadow(manualReservation, 'button.attack', 'click');
  await wait(manualReservation, () => window.__mock.pending.length === 1);
  assert.equal(manualReservation.url(), 'about:blank');
  assert.equal(await manualReservation.evaluate(() => window.__mock.requests.at(-1).method), 'POST');
  const manualNavigation = manualReservation.waitForURL(attackUrl, { timeout: 5000 });
  await manualReservation.evaluate(() => window.__mock.release('/api/targets/101/reservation'));
  await manualNavigation;
  await manualReservation.close();
  console.log('PASS manual Attack button acquires the same reservation before opening its target');

  const warm = await mount(undefined, [source], context, () => {
    const mock = window.__mock;
    mock.store.set(`targetlist.session.${mock.serviceOrigin}`, {
      token: 'mock-session-token', expiresAt: new Date(Date.now() + 7 * 86400000).toISOString()
    });
    mock.targets[0].status = { state: 'Okay', description: 'Okay (cached mock)', until: null };
    mock.targets[0].checkedAt = new Date(Date.now()).toISOString();
    mock.targets[1].estimatedStats = 10000;
    mock.targets[1].status = { state: 'Hospital', description: 'In hospital (cached mock)', until: Math.floor(Date.now() / 1000) + 600 };
    mock.targets[1].checkedAt = new Date(Date.now()).toISOString();
    mock.targets[2].estimatedStats = 200000;
    mock.targets[2].estimateUpdatedAt = Math.floor(Date.now() / 1000) - 3600;
    mock.targets.unshift({ ...structuredClone(mock.targets[0]), id: 105, name: 'TooWeak', estimatedStats: 25000,
      notes: 'Freshly checked but below the configured minimum' });
    mock.holds.push('/api/targets');
  });
  assert.equal(await warm.evaluate(() => window.__mock.requests.length), 1, 'a saved token preloads the feed at mount');
  assert.equal(await warm.evaluate(() => window.__targetlistShadow.querySelector('.panel').hidden), true);
  assert.equal(await warm.evaluate(() => window.__mock.requests[0].data), undefined, 'restoration sends no API key');
  assert.equal(await warm.evaluate(() => window.__mock.requests[0].headers.Authorization), 'Bearer mock-session-token');
  await warm.evaluate(() => window.__mock.release('/api/targets'));
  await wait(warm, () => window.__mock.feedResponses.length === 1);
  assert.equal(await warm.evaluate(() => window.__targetlistShadow.querySelectorAll('.card').length), 0,
    'saved-token preloading keeps the closed settings panel free of cards');
  await shadow(warm, '.settings-toggle', 'click');
  await wait(warm, () => window.__targetlistShadow.querySelectorAll('.card').length === 5);
  assert.equal(warm.url(), 'about:blank', 'preloading never opens an attack by itself');
  assert.equal((await cardSnapshot(warm, 102)).attack, null, 'cached Hospital does not expose an attack link');
  assert.match((await cardSnapshot(warm, 105)).text, /Below your minimum/);
  assert.equal((await cardSnapshot(warm, 105)).attack, null, 'fresh checked targets below the minimum do not expose an attack link');
  let warmDestination;
  await warm.route(attackUrl, async route => {
    warmDestination = { url: route.request().url(), navigation: route.request().isNavigationRequest() };
    await route.fulfill({ status: 200, contentType: 'text/html',
      body: '<!doctype html><title>Cached mock destination</title><h1>Cached destination only: no attack executed</h1>' });
  });
  const warmNavigation = warm.waitForURL(attackUrl, { timeout: 5000 });
  const warmRequests = await warm.evaluate(() => {
    window.__targetlistShadow.querySelector('.launcher').click();
    return structuredClone(window.__mock.requests);
  });
  await warmNavigation;
  assert.equal(warmRequests.length, 1, 'the warm click adds no feed or individual status request');
  assert.equal(warmRequests[0].path, '/api/targets');
  assert.equal(warmRequests.some(request => request.path.endsWith('/status')), false);
  assert.equal(warmDestination.url, attackUrl);
  assert.equal(warmDestination.navigation, true);
  assert.equal(await warm.locator('h1').textContent(), 'Cached destination only: no attack executed');
  await warm.close();
  console.log('PASS saved-token startup preload, fresh below-minimum and cached Hospital exclusion, ready-before-unknown selection, and warm NWA click with zero extra requests');

  for (const expired of ['status', 'authorization']) {
    const stale = await mount(undefined, [source], context, expired => {
      const mock = window.__mock;
      mock.store.set(`targetlist.session.${mock.serviceOrigin}`, {
        token: 'mock-session-token', expiresAt: new Date(Date.now() + 7 * 86400000).toISOString()
      });
      mock.targets[0].status = { state: 'Okay', description: 'Okay (cached mock)', until: null };
      mock.targets[0].checkedAt = new Date(Date.now() + (expired === 'authorization' ? 1000 : -30000)).toISOString();
    }, expired);
    await wait(stale, () => window.__mock.feedResponses.length === 1);
    assert.equal(await stale.evaluate(() => window.__targetlistShadow.querySelectorAll('.card').length), 0,
      'restoring a session does not eagerly build hidden cards');
    await stale.evaluate(expired => {
      if (expired === 'authorization') {
        window.__mockNow += 30000;
        // Status remains fresh while its authorized feed snapshot has reached the deadline.
        window.__mock.targets[0].checkedAt = new Date(Date.now()).toISOString();
      }
      window.__mock.holds.push(expired === 'status' ? '/api/targets/101/status' : '/api/targets');
    }, expired);
    let staleDestination;
    await stale.route(attackUrl, async route => {
      staleDestination = route.request().url();
      await route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><h1>Rechecked mock destination only</h1>' });
    });
    await shadow(stale, '.launcher', 'click');
    await wait(stale, () => window.__mock.pending.length === 1);
    assert.equal(stale.url(), 'about:blank');
    assert.equal(staleDestination, undefined);
    const pendingPath = expired === 'status' ? '/api/targets/101/status' : '/api/targets';
    const requests = await stale.evaluate(() => structuredClone(window.__mock.requests));
    assert.equal(requests.length, 2);
    assert.equal(requests.at(-1).path, pendingPath);
    if (expired === 'authorization') assert.equal(requests.some(request => request.path.endsWith('/status')), false);
    const staleNavigation = stale.waitForURL(attackUrl, { timeout: 5000 });
    await stale.evaluate(path => window.__mock.release(path), pendingPath);
    await staleNavigation;
    assert.equal(staleDestination, attackUrl);
    await stale.close();
  }
  console.log('PASS exact 30-second status and authorized-feed deadlines force verification before navigation');

  const minimumSelector = '[aria-label="Minimum target stats as percent of your total"]';
  const maximumSelector = '[aria-label="Maximum target stats as percent of your total"]';
  async function rangeValues(page) {
    return page.evaluate(({ minimumSelector, maximumSelector }) => ({
      minimum: window.__targetlistShadow.querySelector(minimumSelector).value,
      maximum: window.__targetlistShadow.querySelector(maximumSelector).value
    }), { minimumSelector, maximumSelector });
  }
  const ranges = await mount(undefined, [source], context, () => {
    const mock = window.__mock;
    mock.targets[3].estimatedStats = 50000;
    mock.targets[3].estimateUpdatedAt = Math.floor(Date.now() / 1000) - 3600;
    for (const target of mock.targets) {
      target.status = { state: 'Okay', description: 'Okay (cached mock)', until: null };
      target.checkedAt = new Date(Date.now()).toISOString();
    }
  });
  await login(ranges);
  assert.deepEqual(await rangeValues(ranges), { minimum: '10', maximum: '60' });
  assert.equal(await shadow(ranges, '.stat-range-summary', 'text'), 'Target range: 100K–600K estimated stats (10–60% of yours)');
  assert.match((await cardSnapshot(ranges, 104)).text, /Below your minimum/);
  assert.equal((await cardSnapshot(ranges, 104)).attack, null);
  assert.equal((await cardSnapshot(ranges, 102)).attack, null, 'checked targets above the maximum do not expose attack links');
  await shadow(ranges, 'select', 'select', 'suggested');
  assert.equal(await ranges.evaluate(() => window.__targetlistShadow.querySelectorAll('.card').length), 1);
  assert.match(await shadow(ranges, '.cards', 'text'), /Willow/);
  await shadow(ranges, 'select', 'select', 'all');
  assert.equal(await ranges.evaluate(() => window.__targetlistShadow.querySelectorAll('.card').length), 4, 'all targets retains out-of-range entries');
  const rangeRequests = await ranges.evaluate(() => window.__mock.requests.length);
  await shadow(ranges, maximumSelector, 'select', '80');
  await shadow(ranges, minimumSelector, 'select', '20');
  assert.deepEqual(await rangeValues(ranges), { minimum: '20', maximum: '80' });
  assert.equal(await shadow(ranges, '.stat-range-summary', 'text'), 'Target range: 200K–800K estimated stats (20–80% of yours)');
  await shadow(ranges, minimumSelector, 'select', '40');
  assert.match((await cardSnapshot(ranges, 101)).text, /Below your minimum/);
  assert.equal((await cardSnapshot(ranges, 101)).attack, null, 'raising the minimum removes a previously valid attack link');
  for (const [selector, value] of [
    [minimumSelector, '90'], [maximumSelector, '30'],
    [minimumSelector, '-1'], [maximumSelector, '0'],
    [minimumSelector, ''], [maximumSelector, '']
  ]) {
    await shadow(ranges, selector, 'select', value);
    assert.deepEqual(await rangeValues(ranges), { minimum: '40', maximum: '80' }, `invalid range edit ${value} must restore both controls`);
    assert.equal(await ranges.evaluate(() => window.__targetlistShadow.querySelector('.error').hidden), false);
  }
  await shadow(ranges, minimumSelector, 'select', '20');
  assert.equal(await ranges.evaluate(() => window.__targetlistShadow.querySelector('.error').hidden), true);
  assert.equal(await ranges.evaluate(() => window.__mock.requests.length), rangeRequests, 'stat controls filter the loaded feed without extra requests');
  const savedRange = await ranges.evaluate(() => structuredClone(window.__mock.store.get(`targetlist.preferences.${window.__mock.serviceOrigin}`)));
  assert.equal(savedRange.minRatio, 0.2);
  assert.equal(savedRange.maxRatio, 0.8);
  await ranges.screenshot({ path: path.join(artifacts, 'browser-stat-range-desktop.png'), fullPage: true });
  for (const width of [390, 320]) {
    await ranges.setViewportSize({ width, height: 844 });
    const geometry = await ranges.evaluate(() => {
      const root = window.__targetlistShadow;
      const panel = root.querySelector('.panel').getBoundingClientRect();
      const scroll = root.querySelector('.scroll');
      const inputs = [...root.querySelectorAll('.controls input')].map(input => {
        const rect = input.getBoundingClientRect();
        return { left: rect.left, right: rect.right, width: rect.width };
      });
      return { left: panel.left, right: panel.right, width: innerWidth,
        documentWidth: document.documentElement.scrollWidth, scrollWidth: scroll.scrollWidth,
        clientWidth: scroll.clientWidth, inputs };
    });
    assert(geometry.left >= 0 && geometry.right <= geometry.width, JSON.stringify(geometry));
    assert(geometry.documentWidth <= geometry.width && geometry.scrollWidth <= geometry.clientWidth + 1, JSON.stringify(geometry));
    assert.equal(geometry.inputs.length, 3, 'minimum, maximum and estimate-age inputs remain within the mobile panel');
    for (const input of geometry.inputs) assert(input.left >= geometry.left && input.right <= geometry.right && input.width >= 40, JSON.stringify(geometry));
    await ranges.screenshot({ path: path.join(artifacts, `browser-stat-range-mobile-${width}.png`), fullPage: true });
  }
  await ranges.close();
  const restoredRange = await mount(undefined, [source], context, preferences => {
    window.__mock.store.set(`targetlist.preferences.${window.__mock.serviceOrigin}`, preferences);
  }, savedRange);
  await login(restoredRange);
  assert.deepEqual(await rangeValues(restoredRange), { minimum: '20', maximum: '80' });
  assert.equal(await shadow(restoredRange, '.stat-range-summary', 'text'), 'Target range: 200K–800K estimated stats (20–80% of yours)');
  await restoredRange.close();
  console.log('PASS 10–60% default range, weak-target labels and attack exclusion, immediate filter updates, invalid/inverted edit rejection, saved settings, and 390/320px layout');

  const main = await mount();
  await login(main);
  await refreshMockFeed(main);
  assert.equal(await main.evaluate(() => window.__mock.requests.filter(request => request.path === '/api/targets').at(-1).search), '',
    'a legacy backend without sync metadata retains full-feed requests without a cursor');
  await assertDock(main);
  assert.match(await shadow(main, '.header', 'text'), /NWA/);
  assert.match(await shadow(main, '.header', 'text'), /North West Alliance/);
  assert.match(await shadow(main, '.profile', 'text'), /MockChainer \[90001\].*Mock Allowed Faction/s);
  assert.match(await shadow(main, '.statgrid', 'text'), /Strength400K.*Defense250K.*Speed200K.*Dexterity150K/s);
  assert.match((await cardSnapshot(main, 103)).text, /Stats unknown.*Unknown/s);
  assert.equal((await main.evaluate(() => [...window.__targetlistShadow.querySelectorAll('a.attack')].length)), 0);
  assert.equal(await main.evaluate(() => [...window.__mock.store.values()][0]?.token), 'mock-session-token');
  assert.equal(await main.evaluate(() => JSON.stringify([...window.__mock.store.values()]).includes('MockLimitedKey01')), false);
  assert.equal(await main.evaluate(() => JSON.parse(window.__mock.requests.find(row => row.method === 'POST' && row.path === '/api/session').data).storeKey), true);
  console.log('PASS login, identity, faction, battle stats, local token only, unknown estimates retained');

  await shadow(main, 'select', 'select', 'suggested');
  assert.equal(await main.evaluate(() => window.__targetlistShadow.querySelectorAll('.card').length), 1);
  assert.match(await shadow(main, '.cards', 'text'), /Willow/);
  await shadow(main, 'select', 'select', 'all');
  await shadow(main, 'input[type=search]', 'fill', 'preferred chain');
  assert.equal(await main.evaluate(() => window.__targetlistShadow.querySelectorAll('.card').length), 1);
  await shadow(main, 'input[type=search]', 'fill', 'mystery');
  assert.match(await shadow(main, '.cards', 'text'), /Mystery.*Stats unknown/s);
  await shadow(main, 'input[type=search]', 'fill', '');
  console.log('PASS possible matches, stale/unknown/above-limit exclusion, search across notes and names');

  await cardAction(main, 101);
  await wait(main, () => Boolean(window.__targetlistShadow.querySelector('a.attack')));
  assert.equal((await cardSnapshot(main, 101)).attack, 'https://www.torn.com/page.php?sid=attack&user2ID=101');
  await cardAction(main, 102);
  await wait(main, () => !window.__targetlistShadow.textContent.includes('Checking…'));
  assert.match((await cardSnapshot(main, 102)).text, /Hospital/);
  assert.equal((await cardSnapshot(main, 102)).attack, null);
  await main.screenshot({ path: path.join(artifacts, 'browser-desktop.png'), fullPage: true });
  await main.setViewportSize({ width: 390, height: 844 });
  const mobileGeometry = await main.evaluate(() => {
    const panel = window.__targetlistShadow.querySelector('.panel');
    const scroll = window.__targetlistShadow.querySelector('.scroll');
    const rect = panel.getBoundingClientRect();
    const launcher = window.__targetlistShadow.querySelector('.launcher').getBoundingClientRect();
    return { left: rect.left, right: rect.right, dockLeft: launcher.left, width: innerWidth,
      documentWidth: document.documentElement.scrollWidth, scrollWidth: scroll.scrollWidth, clientWidth: scroll.clientWidth };
  });
  assert(mobileGeometry.left >= 0 && mobileGeometry.right <= mobileGeometry.width, JSON.stringify(mobileGeometry));
  assert(mobileGeometry.right < mobileGeometry.dockLeft, JSON.stringify(mobileGeometry));
  assert(mobileGeometry.documentWidth <= mobileGeometry.width && mobileGeometry.scrollWidth <= mobileGeometry.clientWidth + 1,
    JSON.stringify(mobileGeometry));
  await main.screenshot({ path: path.join(artifacts, 'browser-mobile.png'), fullPage: true });
  console.log('PASS Okay-only attack link, Hospital blocked, desktop and 390px mobile screenshots, no horizontal overflow');

  await main.evaluate(() => { window.__mockNow += 30000; window.__targetlistShadow.querySelector('a.attack').click(); });
  assert.equal(await main.evaluate(() => window.__targetlistShadow.querySelectorAll('a.attack').length), 0);
  assert.match(await shadow(main, '.error', 'text'), /Check this target.*status and stat range before opening an attack/);
  await main.close();
  console.log('PASS stale status cannot open an attack');

  const deletion = await mount(); await login(deletion);
  assert.equal(await shadow(deletion, '.profile button', 'text'), 'Sign out and remove key');
  await deletion.evaluate(() => {
    window.__mock.holds.push('/api/session');
    window.__mock.overrides['/api/session'] = { status: 503,
      data: { error: { code: 'KEY_STORAGE_UNAVAILABLE', message: 'Mock saved-key storage is unavailable' } } };
  });
  await shadow(deletion, '.profile button', 'click');
  await wait(deletion, () => window.__mock.pending.length === 1);
  assert.equal(await shadow(deletion, '.profile button', 'text'), 'Removing key…');
  const deleting = await deletion.evaluate(() => ({ requests: window.__mock.requests.length,
    token: [...window.__mock.store.values()][0]?.token,
    disabled: window.__targetlistShadow.querySelector('.launcher').disabled }));
  assert.equal(deleting.token, 'mock-session-token', 'deletion credentials remain until backend confirmation');
  assert.equal(deleting.disabled, true);
  await shadow(deletion, '.launcher', 'click');
  assert.equal(await deletion.evaluate(() => window.__mock.requests.length), deleting.requests);
  await deletion.evaluate(() => window.__mock.release('/api/session'));
  await wait(deletion, () => window.__targetlistShadow.querySelector('.error').textContent.includes('Key removal was not confirmed'));
  assert.match(await shadow(deletion, '.error', 'text'), /kept so you can retry/);
  assert.equal(await shadow(deletion, '.profile button', 'text'), 'Sign out and remove key');
  assert.equal(await deletion.evaluate(() => [...window.__mock.store.values()][0]?.token), 'mock-session-token');
  assert.equal(await deletion.evaluate(() => JSON.stringify([...window.__mock.store.values()]).includes('MockLimitedKey01')), false);
  await deletion.evaluate(() => { delete window.__mock.overrides['/api/session']; });
  await signOut(deletion);
  assert.equal(await deletion.evaluate(() => window.__mock.store.size), 0);
  await deletion.close();
  console.log('PASS encrypted-key disclosure and confirmed removal; failed deletion retains the token for retry and blocks selection while pending');

  for (const heldPath of ['/api/targets/101/status', '/api/targets']) {
    const race = await mount();
    await login(race);
    await race.evaluate(heldPath => { window.__mock.holds.push(heldPath); }, heldPath);
    if (heldPath.endsWith('/status')) await cardAction(race, 101);
    else await shadow(race, '.controls button', 'click');
    await wait(race, () => window.__mock.pending.length === 1);
    await signOut(race);
    await race.evaluate(heldPath => window.__mock.release(heldPath), heldPath);
    await race.evaluate(() => new Promise(resolve => setTimeout(resolve, 20)));
    assert.equal(await race.evaluate(() => Boolean(window.__targetlistShadow.querySelector('form.login'))), true);
    assert.equal(await race.evaluate(() => window.__targetlistShadow.querySelectorAll('.card,a.attack').length), 0);
    assert.equal(await race.evaluate(() => window.__mock.store.size), 0);
    await race.close();
  }
  console.log('PASS sign out during pending target/status requests cannot resurrect session or cards');

  for (const failure of [
    { status: 503, data: { error: { code: 'UPSTREAM_UNAVAILABLE', message: 'Mock provider unavailable' } } },
    { networkError: true },
    { invalidJson: true },
    { data: {}, finalUrl: 'https://example.invalid/redirect' }
  ]) {
    const errors = await mount();
    await login(errors);
    await cardAction(errors, 101);
    await wait(errors, () => Boolean(window.__targetlistShadow.querySelector('a.attack')));
    await errors.evaluate(failure => { window.__mock.overrides['/api/targets/101/status'] = failure; }, failure);
    await cardAction(errors, 101);
    await wait(errors, () => !window.__targetlistShadow.querySelector('.error').hidden);
    assert.equal((await cardSnapshot(errors, 101)).attack, null);
    await errors.close();
  }
  console.log('PASS service, network, malformed JSON and redirected responses remove attack availability');

  const revoked = await mount();
  await login(revoked);
  await revoked.evaluate(() => { window.__mock.overrides['/api/targets/101/status'] =
    { status: 403, data: { error: { code: 'FACTION_NOT_ALLOWED', message: 'Mock faction authorization revoked' } } }; });
  await cardAction(revoked, 101);
  await wait(revoked, () => Boolean(window.__targetlistShadow.querySelector('form.login')));
  assert.equal(await revoked.evaluate(() => window.__mock.store.size), 0);
  assert.equal(await revoked.evaluate(() => window.__targetlistShadow.querySelectorAll('a.attack').length), 0);
  await revoked.close();
  console.log('PASS revoked faction authorization clears local session and target access');

  const member = await mount();
  await login(member); await openSuggestions(member);
  assert.equal(await member.evaluate(() => [...window.__targetlistShadow.querySelectorAll('button')].some(node => ['Approve', 'Reject'].includes(node.textContent))), false);
  await fillSuggestion(member, { comment: '   \n  ' });
  const beforeBlank = await member.evaluate(() => window.__mock.requests.length);
  await submitSuggestion(member);
  assert.equal(await member.evaluate(() => window.__mock.requests.length), beforeBlank);
  assert.match(await shadow(member, '.error', 'text'), /Add a reason/);
  for (const type of ['player', 'faction']) {
    await fillSuggestion(member, { type, targetId: type === 'player' ? '22001' : '33001', comment: '  A detailed mock reason.\n  ' });
    await submitSuggestion(member);
    await wait(member, () => Boolean(window.__targetlistShadow.querySelector('.success')) && !window.__targetlistShadow.querySelector('.suggestionform button').disabled);
    const post = await member.evaluate(() => window.__mock.requests.filter(row => row.method === 'POST' && row.path === '/api/suggestions').at(-1));
    assert.deepEqual(JSON.parse(post.data), { type, targetId: type === 'player' ? 22001 : 33001, comment: 'A detailed mock reason.' });
    assert.equal(await member.evaluate(() => window.__targetlistShadow.querySelector('textarea').value), '');
  }
  assert.match(await shadow(member, '.suggestionqueue', 'text'), /Mock Suggested Faction.*current players added on approval/s);
  console.log('PASS member player/faction suggestions, required trimmed comments, and leader-only controls');

  await fillSuggestion(member, { type: 'faction', targetId: '44004', comment: 'Retain this draft after a provider failure.' });
  await member.evaluate(() => { window.__mock.overrides['/api/suggestions'] = { status: 503, data: { error: { code: 'UPSTREAM_UNAVAILABLE', message: 'Mock suggestion provider unavailable' } } }; });
  await submitSuggestion(member);
  await wait(member, () => window.__targetlistShadow.querySelector('.error').textContent.includes('Mock suggestion provider unavailable'));
  assert.equal(await member.evaluate(() => window.__targetlistShadow.querySelector('textarea').value), 'Retain this draft after a provider failure.');
  assert.equal(await member.evaluate(() => window.__targetlistShadow.querySelector('[aria-label="Suggestion type"]').value), 'faction');
  assert.equal(await member.evaluate(() => window.__mock.store.size), 1);
  await member.evaluate(() => {
    delete window.__mock.overrides['/api/suggestions'];
    const row = window.__mock.suggestions[0];
    row.targetName = '<img src=x onerror="window.__injected=true">';
    row.comment = '<script>window.__injected=true</script>\n<img src=x onerror="window.__injected=true">';
    row.suggestedBy.name = '<svg onload="window.__injected=true">';
  });
  await clickButton(member, 'Refresh suggestions');
  await wait(member, () => !window.__targetlistShadow.querySelector('.queueheader button').disabled);
  assert.match(await shadow(member, '.suggestionqueue', 'text'), /<script>window.__injected=true<\/script>/);
  assert.equal(await member.evaluate(() => window.__targetlistShadow.querySelectorAll('.suggestionqueue img,.suggestionqueue script,.suggestionqueue svg').length), 0);
  assert.equal(await member.evaluate(() => window.__injected), undefined);
  assert.equal(await member.evaluate(() => window.__targetlistShadow.querySelector('textarea').value), 'Retain this draft after a provider failure.');
  console.log('PASS draft retention on provider failure and plain-text rendering of untrusted queue content');

  await member.evaluate(() => {
    const template = window.__mock.suggestions[1];
    window.__mock.suggestions = Array.from({ length: 60 }, (_, index) => ({ ...structuredClone(template),
      id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`, targetId: 50000 + index, targetName: `Mock Queue Player ${index + 1}` }));
  });
  await clickButton(member, 'Refresh suggestions');
  await wait(member, () => window.__targetlistShadow.querySelectorAll('.suggestioncard').length === 50);
  await clickButton(member, 'Load more suggestions');
  await wait(member, () => window.__targetlistShadow.querySelectorAll('.suggestioncard').length === 60);
  assert.equal(await member.evaluate(() => window.__mock.requests.at(-1).search), '?view=pending&offset=50');
  await clickButton(member, 'My suggestions');
  await wait(member, () => window.__targetlistShadow.querySelectorAll('.suggestioncard').length === 50);
  await clickButton(member, 'Load more suggestions');
  await wait(member, () => window.__targetlistShadow.querySelectorAll('.suggestioncard').length === 60);
  assert.equal(await member.evaluate(() => window.__mock.requests.at(-1).search), '?view=mine&offset=50');
  await member.setViewportSize({ width: 390, height: 844 });
  assert.equal(await member.evaluate(() => {
    const panel = window.__targetlistShadow.querySelector('.panel').getBoundingClientRect();
    const scroll = window.__targetlistShadow.querySelector('.scroll');
    return panel.left >= 0 && panel.right <= innerWidth && scroll.scrollWidth <= scroll.clientWidth + 1;
  }), true);
  await member.close();
  console.log('PASS pending/history pagination beyond 50 suggestions and desktop/mobile form layout');

  const leader = await mount(); await login(leader);
  await leader.evaluate(() => { window.__mock.canReview = true; });
  await openSuggestions(leader);
  await fillSuggestion(leader, { type: 'faction', targetId: '44004', comment: 'Mock required comment: inactive roster suitable for chains.' });
  await leader.evaluate(() => { window.__targetlistShadow.querySelector('.scroll').scrollTop = 180; });
  await leader.screenshot({ path: path.join(artifacts, 'browser-suggestions-desktop.png'), fullPage: true });
  await leader.setViewportSize({ width: 390, height: 844 });
  await leader.evaluate(() => { window.__targetlistShadow.querySelector('.scroll').scrollTop = 320; });
  await leader.screenshot({ path: path.join(artifacts, 'browser-suggestions-mobile.png'), fullPage: true });
  await leader.setViewportSize({ width: 1280, height: 960 });
  await clickButton(leader, 'Approve');
  await wait(leader, () => window.__targetlistShadow.querySelector('.success')?.textContent.includes('1 player added') && !window.__targetlistShadow.querySelector('.suggestionform button').disabled);
  assert.equal(await leader.evaluate(() => window.__mock.suggestions[0].status), 'approved');
  await clickButton(leader, 'Targets');
  assert.equal(await leader.evaluate(() => window.__targetlistShadow.querySelectorAll('.card').length), 5);
  assert.match(await shadow(leader, '.cards', 'text'), /Mock Approved Player/);
  await leader.evaluate(() => {
    const first = window.__mock.suggestions[0];
    window.__mock.suggestions.push({ ...structuredClone(first), id: '00000000-0000-4000-8000-000000000002',
      type: 'faction', targetId: 33004, targetName: 'Mock Rejected Faction', status: 'pending', reviewedBy: null, reviewedAt: null });
  });
  await openSuggestions(leader); await clickButton(leader, 'Reject');
  await wait(leader, () => window.__targetlistShadow.querySelector('.success')?.textContent.includes('Suggestion rejected') && !window.__targetlistShadow.querySelector('.suggestionform button').disabled);
  await clickButton(leader, 'My suggestions');
  await wait(leader, () => window.__targetlistShadow.querySelectorAll('.suggestioncard').length === 2);
  assert.match(await shadow(leader, '.suggestionqueue', 'text'), /approved.*Approved by MockChainer.*rejected.*Rejected by MockChainer/s);
  await leader.close();
  console.log('PASS leadership approval refreshes targets, rejection, and reviewed history');

  const demoted = await mount(); await login(demoted);
  await demoted.evaluate(() => { window.__mock.canReview = true; });
  await openSuggestions(demoted); await fillSuggestion(demoted, { comment: 'Draft survives leadership removal.' });
  await demoted.evaluate(() => { window.__mock.canReview = false; });
  await clickButton(demoted, 'Approve');
  await wait(demoted, () => window.__targetlistShadow.querySelector('.error').textContent.includes('Mock leadership permission removed'));
  assert.equal(await demoted.evaluate(() => window.__mock.store.size), 1);
  assert.equal(await demoted.evaluate(() => [...window.__targetlistShadow.querySelectorAll('button')].some(node => ['Approve', 'Reject'].includes(node.textContent))), false);
  assert.equal(await demoted.evaluate(() => window.__targetlistShadow.querySelector('textarea').value), 'Draft survives leadership removal.');
  await clickButton(demoted, 'Targets');
  assert.equal(await demoted.evaluate(() => window.__targetlistShadow.querySelectorAll('.card').length), 4);
  await demoted.close();
  console.log('PASS leadership removal hides review controls while preserving valid session and draft');

  for (const action of ['queue', 'submit', 'review']) {
    const race = await mount(); await login(race);
    await race.evaluate(() => { window.__mock.canReview = true; });
    let heldPath = '/api/suggestions';
    if (action === 'queue') {
      await race.evaluate(() => { window.__mock.holds.push('/api/suggestions'); });
      await clickButton(race, 'Suggestions');
    } else {
      await openSuggestions(race);
      if (action === 'submit') {
        await fillSuggestion(race);
        await race.evaluate(() => { window.__mock.holds.push('/api/suggestions'); });
        await submitSuggestion(race);
      } else {
        heldPath = '/api/suggestions/00000000-0000-4000-8000-000000000001/review';
        await race.evaluate(path => { window.__mock.holds.push(path); }, heldPath);
        await clickButton(race, 'Approve');
      }
    }
    await wait(race, () => window.__mock.pending.length === 1);
    await signOut(race); const count = await race.evaluate(() => window.__mock.requests.length);
    await race.evaluate(path => window.__mock.release(path), heldPath);
    await race.evaluate(() => new Promise(resolve => setTimeout(resolve, 20)));
    assert.equal(await race.evaluate(() => window.__mock.requests.length), count);
    assert.equal(await race.evaluate(() => Boolean(window.__targetlistShadow.querySelector('form.login'))), true);
    assert.equal(await race.evaluate(() => window.__targetlistShadow.querySelectorAll('.suggestioncard,textarea').length), 0);
    assert.equal(await race.evaluate(() => window.__mock.store.size), 0);
    await race.close();
  }
  console.log('PASS sign out during suggestion queue/submission/review cannot restore content or trigger refreshes');

  const longNoticeReason = ('Preferred chain target. Repeated attacks against alliance members; inactive for several weeks. '
    + 'Review the saved faction note and check availability before attacking. '.repeat(10)).trim();
  const profileNotice = await mount(undefined, [source], context, reason => {
    const content = document.createElement('main'); content.id = 'content-wrapper';
    content.style.cssText = 'margin:100px 20px 20px;max-width:760px';
    content.innerHTML = '<h1>Willow [101]</h1><p>Mock Torn player profile content.</p>';
    document.body.append(content);
    window.__noticeFlowBefore = { headingTop: content.querySelector('h1').getBoundingClientRect().top,
      nextContentTop: content.querySelector('p').getBoundingClientRect().top, height: content.getBoundingClientRect().height };
    window.__mock.targets[0].notes = reason;
  }, longNoticeReason, 'https://www.torn.com/profiles.php?XID=101');
  assert.equal(await profileNotice.evaluate(() => document.getElementById('nwa-target-page-notice')), null);
  await login(profileNotice);
  await wait(profileNotice, () => Boolean(document.getElementById('nwa-target-page-notice')));
  assert.match(await profileNotice.evaluate(() => window.__playerNoticeShadow.textContent), /This player is on the NWA target list\./);
  assert.match(await profileNotice.evaluate(() => window.__playerNoticeShadow.querySelector('.reason').textContent), /Reason: Preferred chain target/);
  assert.equal(await profileNotice.evaluate(() => document.querySelector('#content-wrapper').firstElementChild.tagName), 'H1');
  assert.equal(await profileNotice.evaluate(() => document.getElementById('nwa-target-page-notice').parentElement === document.body), true);
  assert.equal(await profileNotice.evaluate(() => window.__playerNoticeShadow.querySelector('section').getAttribute('aria-label')), 'NWA target list notice');
  await shadow(profileNotice, '.header .icon', 'click');
  const collapsedNotice = await noticeGeometry(profileNotice);
  assertCompactNotice(collapsedNotice, true);
  const profileFlowBefore = await profileNotice.evaluate(() => window.__noticeFlowBefore);
  assert.equal(collapsedNotice.headingTop, profileFlowBefore.headingTop);
  assert.equal(collapsedNotice.nextContentTop, profileFlowBefore.nextContentTop);
  assert.equal(collapsedNotice.contentHeight, profileFlowBefore.height, 'the NWA badge adds no row to the profile');
  assert.equal(collapsedNotice.placement, 'profile');
  assert.equal(collapsedNotice.estimate, 'Est. 300K');
  assert.match(collapsedNotice.estimateDetail, /FFScouter/i);
  await profileNotice.screenshot({ path: path.join(artifacts, 'browser-profile-notice-desktop.png'), fullPage: true });
  await clickNotice(profileNotice);
  await wait(profileNotice, () => window.__playerNoticeShadow.querySelector('details').open);
  const expandedNotice = await noticeGeometry(profileNotice);
  assert.equal(expandedNotice.headingTop, collapsedNotice.headingTop, 'the popup does not push player content down');
  assert.equal(expandedNotice.host.height, collapsedNotice.host.height, 'opening full text keeps the compact row height');
  assert.equal(expandedNotice.fullReason, `Reason: ${longNoticeReason}`);
  assert(expandedNotice.detail.height > 0 && expandedNotice.detail.height <= 200.1);
  await profileNotice.screenshot({ path: path.join(artifacts, 'browser-profile-notice-expanded-desktop.png'), fullPage: true });
  await clickNotice(profileNotice);
  await wait(profileNotice, () => !window.__playerNoticeShadow.querySelector('details').open);
  for (const width of [390, 320]) {
    await profileNotice.setViewportSize({ width, height: 844 });
    await profileNotice.waitForTimeout(150);
    const collapsed = await noticeGeometry(profileNotice);
    assertCompactNotice(collapsed, true);
    await profileNotice.evaluate(() => window.__playerNoticeShadow.querySelector('summary').focus());
    await profileNotice.keyboard.press('Enter');
    await wait(profileNotice, () => window.__playerNoticeShadow.querySelector('details').open);
    const expanded = await noticeGeometry(profileNotice);
    assert.equal(expanded.headingTop, collapsed.headingTop, 'keyboard opening does not move player content');
    assert.equal(expanded.fullReason, `Reason: ${longNoticeReason}`);
    assert(expanded.detail.left >= 0 && expanded.detail.right <= width, JSON.stringify(expanded));
    await profileNotice.keyboard.press('Space');
    await wait(profileNotice, () => !window.__playerNoticeShadow.querySelector('details').open);
    await profileNotice.screenshot({ path: path.join(artifacts, width === 390 ? 'browser-profile-notice-mobile.png' : 'browser-profile-notice-mobile-320.png'), fullPage: true });
  }
  await profileNotice.evaluate(() => {
    window.__noticeBeforeReplacement = document.getElementById('nwa-target-page-notice');
    const replacement = document.createElement('main'); replacement.id = 'content-wrapper';
    replacement.innerHTML = '<h1>Replacement profile content</h1>';
    document.getElementById('content-wrapper').replaceWith(replacement);
  });
  await wait(profileNotice, () => Boolean(document.getElementById('nwa-target-page-notice'))
    && document.getElementById('nwa-target-page-notice').getAttribute('data-placement') === 'profile');
  assert.equal(await profileNotice.evaluate(() => document.getElementById('nwa-target-page-notice') === window.__noticeBeforeReplacement), true);
  assert.equal(await profileNotice.evaluate(() => document.querySelector('#content-wrapper').firstElementChild.tagName), 'H1');
  assert.equal(await profileNotice.evaluate(() => document.querySelectorAll('#nwa-target-page-notice').length), 1);
  await profileNotice.evaluate(() => {
    history.pushState({}, '', '/profiles.php?XID=999');
    document.getElementById('content-wrapper').querySelector('h1').textContent = 'An unlisted player';
  });
  await wait(profileNotice, () => !document.getElementById('nwa-target-page-notice'));
  await profileNotice.evaluate(() => {
    history.pushState({}, '', '/page.php?sid=attack&user2ID=102');
    document.getElementById('content-wrapper').querySelector('h1').textContent = 'Attack Granite [102]';
  });
  await wait(profileNotice, () => Boolean(document.getElementById('nwa-target-page-notice')));
  assert.match(await profileNotice.evaluate(() => window.__playerNoticeShadow.querySelector('.reason').textContent), /No reason provided\./);
  // A listed target is identified independently of the viewer's stat filters.
  assert.equal(await profileNotice.evaluate(() => document.querySelectorAll('#nwa-target-page-notice').length), 1);
  await profileNotice.evaluate(() => {
    history.pushState({}, '', '/factions.php?XID=101');
    document.getElementById('content-wrapper').querySelector('h1').textContent = 'Faction page';
  });
  await wait(profileNotice, () => !document.getElementById('nwa-target-page-notice'));
  await profileNotice.close();
  console.log('PASS independent profile badge shows NWA estimate without adding a row; mouse/keyboard popup, desktop/390/320px width, stat-independent attack fallback and SPA cleanup');

  const ffNotice = await mount(undefined, [source], context, makeFfscouterFixture, longNoticeReason,
    'https://www.torn.com/page.php?sid=attack&user2ID=101');
  await login(ffNotice); await shadow(ffNotice, '.header .icon', 'click');
  await wait(ffNotice, () => document.getElementById('nwa-target-page-notice')?.getAttribute('data-placement') === 'ffscouter');
  const ffCollapsed = await assertAlongsideFfscouter(ffNotice);
  const ffBefore = await ffNotice.evaluate(() => window.__noticeFlowBefore);
  assert.equal(ffCollapsed.headingTop, ffBefore.headingTop);
  assert.equal(ffCollapsed.nextContentTop, ffBefore.nextContentTop);
  assert.equal(ffCollapsed.contentHeight, ffBefore.height, 'NWA adds no height to the existing FFScouter lines');
  assert.equal(await ffNotice.evaluate(() => document.querySelector('.ffscouter-info-line').textContent), ffBefore.fairFightText,
    'FFScouter text is not rewritten');
  await ffNotice.screenshot({ path: path.join(artifacts, 'browser-ffscouter-nwa-desktop.png'), fullPage: true });
  await clickNotice(ffNotice);
  await wait(ffNotice, () => window.__playerNoticeShadow.querySelector('details').open);
  const ffExpanded = await noticeGeometry(ffNotice);
  assert.equal(ffExpanded.headingTop, ffBefore.headingTop);
  assert.equal(ffExpanded.nextContentTop, ffBefore.nextContentTop);
  assert.equal(ffExpanded.contentHeight, ffBefore.height);
  assert.equal(ffExpanded.fullReason, `Reason: ${longNoticeReason}`);
  assert.match(ffExpanded.estimateDetail, /300K/);
  assert.match(ffExpanded.estimateDetail, /FFScouter/);
  await clickNotice(ffNotice);
  await ffNotice.evaluate(() => {
    window.__sameNoticeHost = document.getElementById('nwa-target-page-notice');
    window.__ffscouterMarkup = document.querySelector('.ffscouter-info-line').outerHTML;
    document.querySelector('.ffscouter-info-line').remove();
  });
  await wait(ffNotice, () => document.getElementById('nwa-target-page-notice')?.getAttribute('data-placement') === 'attack');
  assert.match((await noticeGeometry(ffNotice)).estimate, /300K/, 'NWA still works after FFScouter disappears');
  await ffNotice.evaluate(() => {
    document.querySelector('#next-attack-content').insertAdjacentHTML('beforebegin', window.__ffscouterMarkup);
  });
  await wait(ffNotice, () => document.getElementById('nwa-target-page-notice')?.getAttribute('data-placement') === 'ffscouter');
  await assertAlongsideFfscouter(ffNotice);
  await ffNotice.evaluate(() => {
    const replacement = document.createElement('div'); replacement.innerHTML = window.__ffscouterMarkup;
    replacement.firstElementChild.querySelector('.ffscouter-first-line').textContent = 'FairFight: 3.10';
    document.querySelector('.ffscouter-info-line').replaceWith(replacement.firstElementChild);
  });
  await ffNotice.waitForTimeout(150);
  await assertAlongsideFfscouter(ffNotice);
  assert.equal(await ffNotice.evaluate(() => document.getElementById('nwa-target-page-notice') === window.__sameNoticeHost), true,
    'late or replaced FFScouter markup moves the existing badge');
  assert.equal(await ffNotice.evaluate(() => document.querySelectorAll('#nwa-target-page-notice').length), 1);
  await ffNotice.close();
  console.log('PASS NWA shares FFScouter FairFight first line with its own estimate, no added row or rewritten text; absent, late and replaced FFScouter preserve one badge');

  const ffTouchContext = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  await ffTouchContext.route('**/*', route => { networkRequests++; return route.abort(); });
  try {
    const ffTouch = await mount({ width: 390, height: 844 }, [source], ffTouchContext, makeFfscouterFixture, longNoticeReason,
      'https://www.torn.com/page.php?sid=attack&user2ID=101');
    await login(ffTouch); await shadow(ffTouch, '.header .icon', 'click');
    for (const width of [390, 320]) {
      await ffTouch.setViewportSize({ width, height: 844 });
      await ffTouch.waitForTimeout(150);
      const collapsed = await assertAlongsideFfscouter(ffTouch);
      await clickNotice(ffTouch, true);
      await wait(ffTouch, () => window.__playerNoticeShadow.querySelector('details').open);
      const expanded = await noticeGeometry(ffTouch);
      assert.equal(expanded.headingTop, collapsed.headingTop);
      assert.equal(expanded.nextContentTop, collapsed.nextContentTop);
      assert.equal(expanded.contentHeight, collapsed.contentHeight);
      assert.equal(expanded.fullReason, `Reason: ${longNoticeReason}`);
      assert(expanded.detail.left >= 0 && expanded.detail.right <= width, JSON.stringify(expanded));
      assert.equal(await ffTouch.evaluate(() => {
        const detail = window.__playerNoticeShadow.querySelector('.detail').getBoundingClientRect();
        return document.elementFromPoint(detail.left + detail.width / 2, detail.top + Math.min(15, detail.height / 2))?.id;
      }), 'nwa-target-page-notice');
      await ffTouch.screenshot({ path: path.join(artifacts, `browser-ffscouter-nwa-touch-${width}.png`), fullPage: true });
      await clickNotice(ffTouch, true);
      await wait(ffTouch, () => !window.__playerNoticeShadow.querySelector('details').open);
    }
    await ffTouch.close();

    const longFfDesktop = await mount(undefined, [source], context, makeFfscouterFixture,
      { reason: longNoticeReason, longLine: true }, 'https://www.torn.com/page.php?sid=attack&user2ID=101');
    await login(longFfDesktop); await shadow(longFfDesktop, '.header .icon', 'click');
    const longDesktopGeometry = await assertAlongsideFfscouter(longFfDesktop);
    const longDesktopBefore = await longFfDesktop.evaluate(() => window.__noticeFlowBefore);
    assert.equal(longDesktopGeometry.headingTop, longDesktopBefore.headingTop);
    assert.equal(longDesktopGeometry.nextContentTop, longDesktopBefore.nextContentTop);
    assert.equal(longDesktopGeometry.contentHeight, longDesktopBefore.height);
    await longFfDesktop.screenshot({ path: path.join(artifacts, 'browser-ffscouter-long-nwa-desktop.png'), fullPage: true });
    await longFfDesktop.close();
    for (const width of [390, 320]) {
      const longFfTouch = await mount({ width, height: 844 }, [source], ffTouchContext, makeFfscouterFixture,
        { reason: longNoticeReason, longLine: true }, 'https://www.torn.com/page.php?sid=attack&user2ID=101');
      await login(longFfTouch); await shadow(longFfTouch, '.header .icon', 'click');
      const geometry = await noticeGeometry(longFfTouch); assertCompactNotice(geometry, true);
      assert.equal(geometry.placement, 'attack', 'a full FFScouter line uses an existing native attack line');
      const before = await longFfTouch.evaluate(() => window.__noticeFlowBefore);
      assert.equal(geometry.headingTop, before.headingTop);
      assert.equal(geometry.nextContentTop, before.nextContentTop);
      assert.equal(geometry.contentHeight, before.height);
      assert.equal(await longFfTouch.evaluate(() => {
        const badge = document.getElementById('nwa-target-page-notice').getBoundingClientRect();
        const ff = document.querySelector('.ffscouter-first-line').getBoundingClientRect();
        return Math.max(0, Math.min(badge.right, ff.right) - Math.max(badge.left, ff.left))
          * Math.max(0, Math.min(badge.bottom, ff.bottom) - Math.max(badge.top, ff.top));
      }), 0, 'native fallback never covers the long FairFight/estimate text');
      assert.equal(await longFfTouch.evaluate(() => {
        const badge = document.getElementById('nwa-target-page-notice').getBoundingClientRect();
        const launcher = window.__targetlistShadow.querySelector('.launcher').getBoundingClientRect();
        return Math.max(0, Math.min(badge.right, launcher.right) - Math.max(badge.left, launcher.left))
          * Math.max(0, Math.min(badge.bottom, launcher.bottom) - Math.max(badge.top, launcher.top));
      }), 0, 'the inline badge does not obscure NWA’s floating finder button');
      await clickNotice(longFfTouch, true);
      await wait(longFfTouch, () => window.__playerNoticeShadow.querySelector('details').open);
      const expanded = await noticeGeometry(longFfTouch);
      assert.match(expanded.estimateDetail, /300K/);
      assert.doesNotMatch(expanded.estimateDetail, /724M/);
      assert.equal(expanded.fullReason, `Reason: ${longNoticeReason}`);
      assert(expanded.detail.left >= 0 && expanded.detail.right <= width, JSON.stringify(expanded));
      await longFfTouch.screenshot({ path: path.join(artifacts, `browser-ffscouter-long-nwa-mobile-${width}.png`), fullPage: true });
      await longFfTouch.close();
    }
    console.log('PASS screenshot-shaped long FairFight/difficulty/estimate row shares NWA on desktop; 390/320px native fallback avoids overlap and adds no height');

    const bottomFfTouch = await mount({ width: 320, height: 300 }, [source], ffTouchContext, makeFfscouterFixture,
      { reason: longNoticeReason, marginTop: 220 }, 'https://www.torn.com/page.php?sid=attack&user2ID=101');
    await login(bottomFfTouch); await shadow(bottomFfTouch, '.header .icon', 'click');
    const bottomCollapsed = await assertAlongsideFfscouter(bottomFfTouch);
    await clickNotice(bottomFfTouch, true);
    await wait(bottomFfTouch, () => window.__playerNoticeShadow.querySelector('details').open);
    const bottomExpanded = await noticeGeometry(bottomFfTouch);
    assert(bottomExpanded.detail.top >= 0 && bottomExpanded.detail.bottom <= 300, JSON.stringify(bottomExpanded));
    assert(bottomExpanded.detail.bottom <= bottomExpanded.host.top, 'a low anchor opens the popup above its badge');
    assert.equal(bottomExpanded.headingTop, bottomCollapsed.headingTop);
    assert.equal(bottomExpanded.nextContentTop, bottomCollapsed.nextContentTop);
    assert.equal(bottomExpanded.contentHeight, bottomCollapsed.contentHeight);
    assert.equal(bottomExpanded.fullReason, `Reason: ${longNoticeReason}`);
    await bottomFfTouch.screenshot({ path: path.join(artifacts, 'browser-ffscouter-nwa-popup-small-height.png'), fullPage: true });
    assert.equal(await bottomFfTouch.evaluate(() => {
      const detail = window.__playerNoticeShadow.querySelector('.detail');
      const scrollable = detail.scrollHeight > detail.clientHeight;
      detail.scrollTop = detail.scrollHeight;
      return scrollable && detail.scrollTop > 0;
    }), true, 'the complete long reason remains scrollable inside the small visible viewport');
    await bottomFfTouch.close();
    console.log('PASS low FFScouter anchor in a 320x300 viewport opens the scrollable full-reason popup above the badge with no page movement');

    const unknownNarrow = await mount({ width: 320, height: 844 }, [source], ffTouchContext, makeFfscouterFixture,
      longNoticeReason, 'https://www.torn.com/page.php?sid=attack&user2ID=101');
    await unknownNarrow.evaluate(() => {
      const content = document.getElementById('content-wrapper');
      const icon = document.querySelector('.ffscouter-source-icon').getBoundingClientRect();
      content.style.width = `${Math.ceil(icon.right - content.getBoundingClientRect().left + 8 + 90)}px`;
      Object.assign(window.__mock.targets[0], { estimatedStats: null, estimateUpdatedAt: null, estimateSource: null });
    });
    await login(unknownNarrow); await shadow(unknownNarrow, '.header .icon', 'click');
    const unknownGeometry = await noticeGeometry(unknownNarrow); assertCompactNotice(unknownGeometry, true);
    assert.equal(unknownGeometry.placement, 'ffscouter');
    assert(unknownGeometry.host.width >= 90 && unknownGeometry.host.width <= 92, JSON.stringify(unknownGeometry));
    assert.match(unknownGeometry.estimate, /Unknown/);
    assert.equal(await unknownNarrow.evaluate(() => {
      const host = document.getElementById('nwa-target-page-notice').getBoundingClientRect();
      const root = window.__playerNoticeShadow;
      return [...root.querySelectorAll('summary > *')].filter(node => getComputedStyle(node).display !== 'none')
        .every(node => { const rect = node.getBoundingClientRect(); return rect.left >= host.left && rect.right <= host.right; });
    }), true, 'NWA, Unknown estimate and chevron fit the minimum inline width');
    await unknownNarrow.close();
    console.log('PASS Unknown estimate stays within the minimum 90px NWA badge without covering adjacent content');
  } finally { await ffTouchContext.close(); }
  console.log('PASS 390/320px touch FFScouter first-line badge stays clear of FairFight text and exposes its complete NWA estimate/reason without overflow or layout changes');

  const noticeTouchContext = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  await noticeTouchContext.route('**/*', route => { networkRequests++; return route.abort(); });
  try {
    const touchNotice = await mount({ width: 390, height: 844 }, [source], noticeTouchContext, reason => {
      const content = document.createElement('main'); content.id = 'content-wrapper';
      content.style.cssText = 'margin:100px 20px 20px;max-width:760px';
      content.innerHTML = '<h1>Attacking</h1><div class="defender-wrapper"><div class="labelsContainer_mock">'
        + '<a href="https://www.torn.com/profiles.php?XID=101" style="color:inherit">Willow [101]</a></div></div>'
        + '<p>Mock touch attack page content.</p>';
      document.body.append(content); window.__mock.targets[0].reason = reason;
    }, longNoticeReason, 'https://www.torn.com/page.php?sid=attack&user2ID=101');
    await login(touchNotice); await shadow(touchNotice, '.header .icon', 'click');
    for (const width of [390, 320]) {
      await touchNotice.setViewportSize({ width, height: 844 });
      await touchNotice.waitForTimeout(150);
      const collapsed = await noticeGeometry(touchNotice); assertCompactNotice(collapsed, true);
      await clickNotice(touchNotice, true);
      await wait(touchNotice, () => window.__playerNoticeShadow.querySelector('details').open);
      const expanded = await noticeGeometry(touchNotice);
      assert.equal(expanded.headingTop, collapsed.headingTop, 'native touch expansion does not move attack content');
      assert.equal(expanded.fullReason, `Reason: ${longNoticeReason}`);
      assert(expanded.detail.left >= 0 && expanded.detail.right <= width, JSON.stringify(expanded));
      assert.equal(await touchNotice.evaluate(() => {
        const popup = window.__playerNoticeShadow.querySelector('.detail').getBoundingClientRect();
        return document.elementFromPoint(popup.left + popup.width / 2, popup.top + Math.min(15, popup.height / 2))?.id;
      }), 'nwa-target-page-notice', 'expanded reason text remains touch accessible above page overlays');
      await touchNotice.screenshot({ path: path.join(artifacts, `browser-attack-notice-expanded-mobile-${width}.png`), fullPage: true });
      await clickNotice(touchNotice, true);
      await wait(touchNotice, () => !window.__playerNoticeShadow.querySelector('details').open);
      assertCompactNotice(await noticeGeometry(touchNotice), true);
    }
    await touchNotice.close();
  } finally { await noticeTouchContext.close(); }
  console.log('PASS native touch opens and closes complete attack reasons on 390/320px screens while retaining compact geometry and content position');

  const attackNotice = await mount(undefined, [source], context, () => {
    const content = document.createElement('main'); content.id = 'content-wrapper';
    content.style.cssText = 'margin:100px 20px 20px;max-width:760px';
    content.innerHTML = '<h1>Attack Willow [101]</h1><p>Mock Torn attack page content.</p>';
    document.body.append(content);
    window.__mock.targets[0].notes = '<img src=x onerror="window.__injected=true">\n<script>window.__injected=true</script>';
  }, undefined, 'https://www.torn.com/page.php?sid=attack&user2ID=101');
  await login(attackNotice);
  await wait(attackNotice, () => Boolean(document.getElementById('nwa-target-page-notice')));
  assert.match(await attackNotice.evaluate(() => window.__playerNoticeShadow.querySelector('.reason').textContent), /<img src=x onerror=/);
  assert.equal(await attackNotice.evaluate(() => window.__playerNoticeShadow.querySelectorAll('img,script').length), 0);
  assert.equal(await attackNotice.evaluate(() => window.__injected), undefined);
  await attackNotice.evaluate(() => { window.__mock.targets[0].reason = 'Inactive player suitable for chaining.'; });
  await shadow(attackNotice, '.controls button', 'click');
  await wait(attackNotice, () => window.__playerNoticeShadow.querySelector('.reason').textContent.includes('Inactive player suitable for chaining.'));
  await shadow(attackNotice, '.header .icon', 'click');
  assertCompactNotice(await noticeGeometry(attackNotice));
  await attackNotice.screenshot({ path: path.join(artifacts, 'browser-attack-notice-desktop.png'), fullPage: true });
  await shadow(attackNotice, '.settings-toggle', 'click');
  await signOut(attackNotice);
  await wait(attackNotice, () => !document.getElementById('nwa-target-page-notice'));
  await attackNotice.close();
  console.log('PASS direct modern attack route, plain-text untrusted reason, and removal after sign out');

  const pdaContext = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  await pdaContext.route('**/*', route => { networkRequests++; return route.abort(); });
  try {
    const pda = await mount({ width: 390, height: 844 }, [pdaRuntimeSource, source], pdaContext, () => {
      const content = document.createElement('main'); content.id = 'content-wrapper';
      content.style.cssText = 'margin:100px 20px 20px;max-width:760px';
      content.innerHTML = '<h1>Willow [101]</h1><p>Mock Torn PDA player profile.</p>';
      document.body.append(content);
      window.__mock.reservations = { supported: true, leaseMs: 60000 };
    }, undefined, 'https://www.torn.com/profiles.php?XID=101');
    assert.equal(await pda.evaluate(() => typeof window.GM_xmlhttpRequest), 'undefined');
    assert.equal(await pda.evaluate(() => typeof window.GM_getValue), 'undefined');
    assert.equal(await pda.evaluate(() => typeof window.PDA_storage), 'undefined', 'native storage is a lexical binding, not a window property');
    assert.equal(await pda.evaluate(() => matchMedia('(pointer:coarse)').matches), true);
    await tapShadow(pda, '.settings-toggle');
    for (const width of [390, 320]) {
      await pda.setViewportSize({ width, height: 844 });
      const geometry = await pda.evaluate(() => {
        const root = window.__targetlistShadow;
        const panel = root.querySelector('.panel').getBoundingClientRect();
        const input = root.querySelector('input[type=password]');
        return { left: panel.left, right: panel.right, bottom: panel.bottom, top: panel.top,
          fontSize: getComputedStyle(input).fontSize, width: innerWidth,
          overflow: root.querySelector('.scroll').scrollWidth > root.querySelector('.scroll').clientWidth + 1 };
      });
      assert(geometry.left >= 0 && geometry.right <= width && geometry.bottom <= 844, JSON.stringify(geometry));
      assert.equal(geometry.fontSize, '16px', 'mobile form controls avoid iOS input zoom');
      assert.equal(geometry.overflow, false);
      await pda.screenshot({ path: path.join(artifacts, `browser-pda-login-${width}.png`), fullPage: true });
    }
    await pda.evaluate(() => {
      Object.defineProperties(window.visualViewport, {
        height: { configurable: true, writable: true, value: 360 },
        offsetTop: { configurable: true, writable: true, value: 24 }
      });
      window.visualViewport.dispatchEvent(new Event('resize'));
    });
    await pda.waitForTimeout(30);
    const keyboardGeometry = await pda.evaluate(() => {
      const root = window.__targetlistShadow, panel = root.querySelector('.panel');
      const rect = panel.getBoundingClientRect();
      root.querySelector('button[type=submit]').scrollIntoView({ block: 'nearest' });
      const submit = root.querySelector('button[type=submit]').getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom, height: rect.height, submitTop: submit.top, submitBottom: submit.bottom };
    });
    assert(keyboardGeometry.top >= 24 && keyboardGeometry.bottom <= 384 && keyboardGeometry.height <= 360, JSON.stringify(keyboardGeometry));
    assert(keyboardGeometry.submitTop >= keyboardGeometry.top && keyboardGeometry.submitBottom <= keyboardGeometry.bottom, JSON.stringify(keyboardGeometry));
    await pda.screenshot({ path: path.join(artifacts, 'browser-pda-keyboard-320.png'), fullPage: true });
    await pda.evaluate(() => {
      window.visualViewport.height = 844; window.visualViewport.offsetTop = 0;
      window.visualViewport.dispatchEvent(new Event('resize'));
    });
    await shadow(pda, 'input[type=password]', 'fill', 'MockLimitedKey01');
    await shadow(pda, 'form.login', 'submit');
    await wait(pda, () => window.__targetlistShadow.querySelectorAll('.card').length === 4);
    await wait(pda, () => window.__mock.store.has(`targetlist.session.${window.__mock.serviceOrigin}`));
    await shadow(pda, '[aria-label="Minimum target stats as percent of your total"]', 'select', '15');
    await shadow(pda, '[aria-label="Maximum target stats as percent of your total"]', 'select', '55');
    await wait(pda, () => {
      const stored = window.__mock.store.get(`targetlist.preferences.${window.__mock.serviceOrigin}`);
      return stored?.minRatio === 0.15 && stored?.maxRatio === 0.55;
    });
    await openSuggestions(pda);
    await fillSuggestion(pda, { comment: '  \n ' });
    const beforeBlankPda = await pda.evaluate(() => window.__mock.requests.length);
    await submitSuggestion(pda);
    assert.equal(await pda.evaluate(() => window.__mock.requests.length), beforeBlankPda);
    assert.match(await shadow(pda, '.error', 'text'), /Add a reason/);
    for (const type of ['player', 'faction']) {
      await fillSuggestion(pda, { type, targetId: type === 'player' ? '22001' : '33001', comment: '  Mock PDA target reason.  ' });
      await submitSuggestion(pda);
      await wait(pda, () => Boolean(window.__targetlistShadow.querySelector('.success')) && !window.__targetlistShadow.querySelector('.suggestionform button').disabled);
      const post = await pda.evaluate(() => window.__mock.requests.filter(row => row.method === 'POST' && row.path === '/api/suggestions').at(-1));
      assert.deepEqual(JSON.parse(post.data), { type, targetId: type === 'player' ? 22001 : 33001, comment: 'Mock PDA target reason.' });
    }
    await clickButton(pda, 'Targets');
    await cardAction(pda, 101);
    await wait(pda, () => window.__targetlistShadow.querySelector('.attack')?.tagName === 'BUTTON');
    await shadow(pda, '.header .icon', 'click');
    await wait(pda, () => Boolean(document.getElementById('nwa-target-page-notice')));
    assertCompactNotice(await noticeGeometry(pda));
    await clickNotice(pda, true);
    assert.equal(await pda.evaluate(() => window.__playerNoticeShadow.querySelector('details').open), true);
    await clickNotice(pda, true);
    const persistedPda = await pda.evaluate(() => [...window.__mock.store]);
    const pdaAttackUrl = 'https://www.torn.com/page.php?sid=attack&user2ID=101';
    let pdaNavigation;
    await pda.route(pdaAttackUrl, async route => {
      pdaNavigation = route.request().url();
      await route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><h1>Mock PDA attack destination</h1>' });
    });
    await pda.evaluate(() => { window.__mock.holds.push('/api/targets/101/reservation'); });
    await tapShadow(pda, '.launcher');
    await wait(pda, () => window.__mock.pending.length === 1);
    assert.equal(pdaNavigation, undefined, 'PDA waits for its shared reservation before navigating');
    const nativeCalls = await pda.evaluate(() => structuredClone(window.__mock.pda.calls));
    assert.equal(nativeCalls.at(-1).name, 'PDA_httpPost');
    assert.equal(new URL(nativeCalls.at(-1).args[0]).pathname, '/api/targets/101/reservation');
    assert(nativeCalls.some(call => call.name === 'PDA_httpGet' && new URL(call.args[0]).pathname === '/api/targets/101/status'));
    assert.equal(await pda.evaluate(() => window.__mock.pda.wrapperCalls), 0, 'native bridge is used instead of the standard PDA wrapper');
    const pdaNavigated = pda.waitForURL(pdaAttackUrl, { timeout: 5000 });
    await pda.evaluate(() => window.__mock.release('/api/targets/101/reservation'));
    await pdaNavigated;
    assert.equal(pdaNavigation, pdaAttackUrl);
    await pda.close();
    console.log('PASS PDA-only native GET/POST, async lexical storage, readiness, 390/320px touch login, keyboard height, stat settings, player/faction reasons, status, reservation and attack navigation');

    const restoredPda = await mount({ width: 320, height: 844 }, [pdaRuntimeSource, source], pdaContext, entries => {
      for (const [key, value] of entries) window.__mock.store.set(key, value);
    }, persistedPda);
    await wait(restoredPda, () => window.__mock.requests.some(request => request.path === '/api/targets'));
    await tapShadow(restoredPda, '.settings-toggle');
    await wait(restoredPda, () => window.__targetlistShadow.querySelectorAll('.card').length === 4);
    assert.equal(await restoredPda.evaluate(() => window.__mock.requests.some(request => request.path === '/api/session' && request.method === 'POST')), false, 'a new PDA document restores its saved token without resubmitting the key');
    const restoredFeed = await restoredPda.evaluate(() => window.__mock.requests.find(request => request.path === '/api/targets'));
    assert.equal(restoredFeed.headers.Authorization, 'Bearer mock-session-token');
    assert.equal(restoredFeed.data, undefined);
    assert.equal(await restoredPda.evaluate(() => window.__targetlistShadow.querySelector('[aria-label="Minimum target stats as percent of your total"]').value), '15');
    assert.equal(await restoredPda.evaluate(() => window.__targetlistShadow.querySelector('[aria-label="Maximum target stats as percent of your total"]').value), '55');
    assert.equal(JSON.stringify(persistedPda).includes('MockLimitedKey01'), false, 'native PDA storage contains no Torn API key');
    await signOut(restoredPda);
    await wait(restoredPda, () => !window.__mock.store.has(`targetlist.session.${window.__mock.serviceOrigin}`));
    const logoutCall = await restoredPda.evaluate(() => window.__mock.pda.calls.find(call => call.name === 'PDA_httpDelete'));
    assert(logoutCall, 'PDA native DELETE withdraws the saved backend key');
    assert.equal(new URL(logoutCall.args[0]).pathname, '/api/session');
    assert.equal(logoutCall.args[1].Authorization, 'Bearer mock-session-token');
    assert.equal(await restoredPda.evaluate(() => window.__mock.pda.wrapperCalls), 0);
    assert.equal(await restoredPda.evaluate(() => window.__mock.pda.storageCalls.some(call => call.method === 'delete' && call.key.startsWith('targetlist.session.'))), true);
    await restoredPda.close();
    console.log('PASS a fresh PDA document restores its durable token and min/max settings without an API key; native DELETE and async storage deletion complete sign out');

    const unavailablePdaStore = await mount({ width: 320, height: 844 }, [pdaRuntimeSource, source], pdaContext, entries => {
      for (const [key, value] of entries) window.__mock.store.set(key, value);
      window.__mock.pdaLoadAllFailure = true;
    }, persistedPda);
    await tapShadow(unavailablePdaStore, '.settings-toggle');
    assert.match(await shadow(unavailablePdaStore, '.error', 'text'), /could not access saved data/);
    assert.equal(await unavailablePdaStore.evaluate(() => {
      const root = window.__targetlistShadow;
      return Boolean(root.querySelector('form.login')) && !root.querySelector('input[type=password]').disabled
        && !root.querySelector('.settings-toggle').disabled && !root.querySelector('.error').hidden;
    }), true, 'a transient storage read failure leaves the NWA controls usable with a clear error');
    await unavailablePdaStore.waitForTimeout(30);
    assert.equal(await unavailablePdaStore.evaluate(() => window.__mock.pda.storageCalls.some(call => call.method === 'delete')), false, 'unread native data must never be treated as an expired token');
    assert.equal(await unavailablePdaStore.evaluate(() => window.__mock.pda.calls.some(call => call.name === 'PDA_httpDelete')), false);
    const retainedPda = await unavailablePdaStore.evaluate(() => [...window.__mock.store]);
    assert.deepEqual(retainedPda, persistedPda, 'token and preferences survive transient native storage failure');
    await unavailablePdaStore.close();
    const recoveredPdaStore = await mount({ width: 320, height: 844 }, [pdaRuntimeSource, source], pdaContext, entries => {
      for (const [key, value] of entries) window.__mock.store.set(key, value);
    }, retainedPda);
    await wait(recoveredPdaStore, () => window.__mock.requests.some(request => request.path === '/api/targets'));
    await tapShadow(recoveredPdaStore, '.settings-toggle');
    await wait(recoveredPdaStore, () => window.__targetlistShadow.querySelectorAll('.card').length === 4);
    assert.equal(await recoveredPdaStore.evaluate(() => window.__mock.requests.some(request => request.path === '/api/session' && request.method === 'POST')), false);
    assert.equal(await recoveredPdaStore.evaluate(() => window.__mock.requests.find(request => request.path === '/api/targets').headers.Authorization), 'Bearer mock-session-token');
    assert.equal(await recoveredPdaStore.evaluate(() => window.__targetlistShadow.querySelector('[aria-label="Minimum target stats as percent of your total"]').value), '15');
    await recoveredPdaStore.close();
    console.log('PASS transient PDA storage failure keeps the saved token and preferences; a fresh successful document restores without entering the key again');
  } finally { await pdaContext.close(); }

  await checkDeltaRendering(context, [source], 'GM');
  const deltaPdaContext = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  await deltaPdaContext.route('**/*', route => { networkRequests++; return route.abort(); });
  try { await checkDeltaRendering(deltaPdaContext, [pdaRuntimeSource, source], 'PDA'); }
  finally { await deltaPdaContext.close(); }

  assert.equal(networkRequests, 0, 'Browser attempted external network access');
  assert.deepEqual(pageErrors, [], 'Unhandled browser errors');
  console.log('All mocked browser smoke checks passed. No provider requests or live keys used.');
  console.log(`Mock screenshots: ${path.join(artifacts, 'browser-desktop.png')} and ${path.join(artifacts, 'browser-mobile.png')}`);
  console.log(`Mock NWA launcher screenshots: ${path.join(artifacts, 'browser-nwa-launcher-desktop.png')} and ${path.join(artifacts, 'browser-nwa-launcher-mobile.png')}`);
  console.log(`Mock encrypted-key login screenshot: ${path.join(artifacts, 'browser-login-mobile.png')}`);
  console.log(`Mock stat-range screenshots: ${path.join(artifacts, 'browser-stat-range-desktop.png')}, ${path.join(artifacts, 'browser-stat-range-mobile-390.png')} and ${path.join(artifacts, 'browser-stat-range-mobile-320.png')}`);
  console.log(`Mock suggestion screenshots: ${path.join(artifacts, 'browser-suggestions-desktop.png')} and ${path.join(artifacts, 'browser-suggestions-mobile.png')}`);
  console.log(`Mock target notice screenshots: ${path.join(artifacts, 'browser-profile-notice-desktop.png')}, ${path.join(artifacts, 'browser-profile-notice-mobile.png')} and ${path.join(artifacts, 'browser-attack-notice-desktop.png')}`);
  console.log(`Mock FFScouter/NWA screenshots: ${path.join(artifacts, 'browser-ffscouter-nwa-desktop.png')}, ${path.join(artifacts, 'browser-ffscouter-nwa-touch-390.png')} and ${path.join(artifacts, 'browser-ffscouter-nwa-touch-320.png')}`);
} finally {
  await context.close();
  await browser.close();
}
