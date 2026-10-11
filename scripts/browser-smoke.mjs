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
      canReview: false, serviceOrigin: 'https://targetlist.grusmedia.no' };
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
        data = { player, targets: structuredClone(targets), generatedAt: new Date(Date.now()).toISOString(), warnings: [] };
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
      request.onload({ status,
        responseText: override?.invalidJson ? '{invalid JSON' : JSON.stringify(data),
        finalUrl: override?.finalUrl || request.url });
    }
    window.GM_xmlhttpRequest = request => {
      const url = new URL(request.url);
      if (url.origin !== window.__mock.serviceOrigin) throw new Error('Test attempted an unexpected provider request.');
      window.__mock.requests.push({ method: request.method, path: url.pathname, search: url.search, headers: request.headers, data: request.data });
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

try {
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
    await wait(stale, () => window.__targetlistShadow.querySelectorAll('.card').length === 4);
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
    assert.equal(geometry.inputs.length, 2);
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

  const profileNotice = await mount(undefined, [source], context, () => {
    const content = document.createElement('main'); content.id = 'content-wrapper';
    content.style.cssText = 'margin:100px 20px 20px;max-width:760px';
    content.innerHTML = '<h1>Willow [101]</h1><p>Mock Torn player profile content.</p>';
    document.body.append(content);
  }, undefined, 'https://www.torn.com/profiles.php?XID=101');
  assert.equal(await profileNotice.evaluate(() => document.getElementById('nwa-target-page-notice')), null);
  await login(profileNotice);
  await wait(profileNotice, () => Boolean(document.getElementById('nwa-target-page-notice')));
  assert.match(await profileNotice.evaluate(() => window.__playerNoticeShadow.textContent), /This player is on the NWA target list\./);
  assert.match(await profileNotice.evaluate(() => window.__playerNoticeShadow.querySelector('.reason').textContent), /Reason: Preferred chain target/);
  assert.equal(await profileNotice.evaluate(() => document.querySelector('#content-wrapper').firstElementChild.id), 'nwa-target-page-notice');
  assert.equal(await profileNotice.evaluate(() => window.__playerNoticeShadow.querySelector('section').getAttribute('aria-label')), 'NWA target list notice');
  await shadow(profileNotice, '.header .icon', 'click');
  await profileNotice.screenshot({ path: path.join(artifacts, 'browser-profile-notice-desktop.png'), fullPage: true });
  await profileNotice.setViewportSize({ width: 390, height: 844 });
  assert.equal(await profileNotice.evaluate(() => {
    const notice = document.getElementById('nwa-target-page-notice').getBoundingClientRect();
    return notice.width > 0 && notice.left >= 0 && notice.right <= innerWidth && document.documentElement.scrollWidth <= innerWidth;
  }), true);
  await profileNotice.screenshot({ path: path.join(artifacts, 'browser-profile-notice-mobile.png'), fullPage: true });
  await profileNotice.evaluate(() => {
    const replacement = document.createElement('main'); replacement.id = 'content-wrapper';
    replacement.innerHTML = '<h1>Replacement profile content</h1>';
    document.getElementById('content-wrapper').replaceWith(replacement);
  });
  await wait(profileNotice, () => document.getElementById('content-wrapper').firstElementChild?.id === 'nwa-target-page-notice');
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
  console.log('PASS listed profile notice, stat-independent attack notice, empty-reason fallback, SPA route cleanup, replaced container and mobile width');

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
  await attackNotice.screenshot({ path: path.join(artifacts, 'browser-attack-notice-desktop.png'), fullPage: true });
  await shadow(attackNotice, '.settings-toggle', 'click');
  await signOut(attackNotice);
  await wait(attackNotice, () => !document.getElementById('nwa-target-page-notice'));
  await attackNotice.close();
  console.log('PASS direct modern attack route, plain-text untrusted reason, and removal after sign out');

  assert.equal(networkRequests, 0, 'Browser attempted external network access');
  assert.deepEqual(pageErrors, [], 'Unhandled browser errors');
  console.log('All mocked browser smoke checks passed. No provider requests or live keys used.');
  console.log(`Mock screenshots: ${path.join(artifacts, 'browser-desktop.png')} and ${path.join(artifacts, 'browser-mobile.png')}`);
  console.log(`Mock NWA launcher screenshots: ${path.join(artifacts, 'browser-nwa-launcher-desktop.png')} and ${path.join(artifacts, 'browser-nwa-launcher-mobile.png')}`);
  console.log(`Mock encrypted-key login screenshot: ${path.join(artifacts, 'browser-login-mobile.png')}`);
  console.log(`Mock stat-range screenshots: ${path.join(artifacts, 'browser-stat-range-desktop.png')}, ${path.join(artifacts, 'browser-stat-range-mobile-390.png')} and ${path.join(artifacts, 'browser-stat-range-mobile-320.png')}`);
  console.log(`Mock suggestion screenshots: ${path.join(artifacts, 'browser-suggestions-desktop.png')} and ${path.join(artifacts, 'browser-suggestions-mobile.png')}`);
  console.log(`Mock target notice screenshots: ${path.join(artifacts, 'browser-profile-notice-desktop.png')}, ${path.join(artifacts, 'browser-profile-notice-mobile.png')} and ${path.join(artifacts, 'browser-attack-notice-desktop.png')}`);
} finally {
  await context.close();
  await browser.close();
}
