import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const core = await readFile(new URL('../src/core.js', import.meta.url), 'utf8');
const platform = await readFile(new URL('../src/platform.js', import.meta.url), 'utf8');
const app = await readFile(new URL('../src/app.js', import.meta.url), 'utf8');
const { pageTargetId } = vm.runInNewContext(`${core}\nTargetListCore;`, { URL });
const NOW = Date.parse('2026-10-11T12:00:00Z');
const player = { id: 123, name: 'Member', faction: { id: 111, name: 'Alliance Faction' },
  battleStats: { strength: 250000, defense: 250000, speed: 250000, dexterity: 250000, total: 1000000 } };
const target = { id: 900, name: 'Listed Player', faction: { id: 222, name: 'Other Faction' },
  estimatedStats: 500000, estimateUpdatedAt: NOW / 1000 - 3600, status: { state: 'Okay' },
  notes: 'Repeatedly attacked alliance members.' };
const all = node => [node, ...node.children.flatMap(child => typeof child === 'object' ? all(child) : [])];

// A page-specific standard DOM fixture: network calls and mutation delivery stay manual.
class Element {
  constructor(tag) {
    this.tagName = tag.toUpperCase(); this.children = []; this.parentNode = null;
    this.style = {}; this.attributes = new Map(); this.listeners = new Map(); this.value = '';
    this._text = ''; this.activeElement = null;
  }
  get textContent() { return this._text + this.children.map(child => typeof child === 'object' ? child.textContent : String(child)).join(''); }
  set textContent(value) { this.replaceChildren(); this._text = String(value); }
  append(...children) {
    for (const child of children) {
      if (typeof child === 'object') { child.remove(); child.parentNode = this; }
      this.children.push(child);
    }
  }
  prepend(...children) { for (const child of [...children].reverse()) this.insertBefore(child, this.firstChild); }
  insertBefore(child, before) {
    if (before == null) { this.append(child); return child; }
    const index = this.children.indexOf(before); assert.notEqual(index, -1, 'reference child belongs to parent');
    if (typeof child === 'object') { child.remove(); child.parentNode = this; }
    this.children.splice(index, 0, child); return child;
  }
  replaceChildren(...children) {
    for (const child of this.children) if (typeof child === 'object') child.parentNode = null;
    this.children = []; this._text = ''; this.append(...children);
  }
  remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this); this.parentNode = null; }
  contains(node) { return all(this).includes(node); }
  get isConnected() { return this.tagName === 'DOCUMENT' || Boolean(this.parentNode?.isConnected); }
  get firstChild() { return this.children[0] ?? null; }
  get lastChild() { return this.children.at(-1) ?? null; }
  get parentElement() { return this.parentNode; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); if (name === 'id') this.id = String(value); if (name === 'class') this.className = String(value); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  addEventListener(name, callback) { if (!this.listeners.has(name)) this.listeners.set(name, []); this.listeners.get(name).push(callback); }
  emit(type, additions = {}) { const event = { preventDefault() {}, ...additions }; for (const listener of this.listeners.get(type) || []) listener(event); }
  attachShadow() { this.shadow = new Element('shadow-root'); this.shadow.parentNode = this; return this.shadow; }
  matches(selector) {
    if (selector.startsWith('#')) return this.id === selector.slice(1);
    if (selector.startsWith('.')) return (this.className || '').split(/\s+/).includes(selector.slice(1));
    const attribute = selector.match(/^\[([^=*]+)(\*?=)["']?([^"'\]]+)["']?\]$/);
    if (attribute) {
      const value = this.getAttribute(attribute[1]) ?? this[attribute[1]] ?? '';
      return attribute[2] === '*=' ? String(value).includes(attribute[3]) : value === attribute[3];
    }
    return this.tagName.toLowerCase() === selector.toLowerCase();
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  querySelectorAll(selector) { return all(this).slice(1).filter(node => selector.split(',').some(part => node.matches(part.trim()))); }
}

async function flush() { for (let index = 0; index < 12; index++) await Promise.resolve(); }
function fixture(url, { saved = true, mounted = true } = {}) {
  let now = NOW; let nextTimeout = 1;
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
  const document = new Element('document'); const html = new Element('html'); const body = new Element('body');
  document.append(html); html.append(body); document.body = body; document.documentElement = html;
  document.visibilityState = 'visible'; document.readyState = 'complete';
  document.getElementById = id => all(document).find(node => node.id === id) ?? null;
  document.createElement = tag => new Element(tag);
  document.createElementNS = (namespace, tag) => { const node = new Element(tag); node.namespaceURI = namespace; return node; };
  const window = new Element('window'); window.location = { href: url, assign() {} };
  const requests = []; const timers = []; const timeouts = new Map(); const observers = [];
  const storage = new Map();
  if (saved) storage.set('targetlist.session.https://targetlist.grusmedia.no', { token: 'saved-session', expiresAt: new Date(NOW + 3600000).toISOString() });
  class MutationObserver { constructor(callback) { this.callback = callback; observers.push(this); } observe() { this.active = true; } disconnect() { this.active = false; } }
  function mountContent() { const content = new Element('main'); content.id = 'mainContainer'; content.className = 'content-wrapper'; body.prepend(content); return content; }
  let content = mounted ? mountContent() : null;
  const context = vm.createContext({ URL, Intl, Date: Clock, console, window, location: window.location, document, MutationObserver,
    GM_getValue: (key, fallback) => storage.get(key) ?? fallback,
    GM_setValue: (key, value) => storage.set(key, value), GM_deleteValue: key => storage.delete(key),
    GM_xmlhttpRequest: request => requests.push(request),
    setInterval: (callback, delay) => { timers.push({ callback, delay }); return timers.length; },
    clearInterval() {},
    setTimeout: (callback, delay = 0) => { const id = nextTimeout++; timeouts.set(id, { callback, delay }); return id; },
    clearTimeout: id => timeouts.delete(id),
  });
  vm.runInContext(`(() => {\n${core}\n${platform}\n${app}\n})();`, context);
  function shortTimeouts() { for (const [id, entry] of [...timeouts]) if (entry.delay < 1000) { timeouts.delete(id); entry.callback(); } }
  function mutation() { for (const observer of observers) if (observer.active) observer.callback([{ target: content || body }]); shortTimeouts(); }
  function response(request, data, status = 200) { assert.ok(request, 'an expected request exists'); request.onload({ status, responseText: JSON.stringify(data), finalUrl: request.url }); }
  async function feed(targets = [target]) { response(requests.at(-1), { player, targets, warnings: [], generatedAt: new Date(now).toISOString() }); await flush(); shortTimeouts(); }
  function control(label) { const root = document.getElementById('torn-targetlist-host').shadow; const button = all(root).find(node => node.tagName === 'BUTTON' && node.textContent === label); assert.ok(button, `button ${label} exists`); return button; }
  function notice() { return document.getElementById('nwa-target-page-notice'); }
  function noticeText() { return notice()?.shadow?.textContent || notice()?.textContent || ''; }
  return { document, body, window, storage, requests, timers, feed, response, control, mutation, notice, noticeText,
    changeUrl(value, event = 'popstate') { window.location.href = value; window.emit(event); shortTimeouts(); },
    tick(value = now) { now = value; for (const timer of timers) timer.callback(); shortTimeouts(); },
    mountLate() { content = mountContent(); mutation(); return content; },
    replaceContent() { content?.remove(); content = mountContent(); mutation(); return content; },
    content: () => content };
}

test('player-page parsing identifies the current profile or attack and rejects ambiguous unrelated URLs', () => {
  for (const url of ['https://www.torn.com/profiles.php?XID=900', 'https://torn.com/profiles.php?XID=900#profile',
    'https://www.torn.com/page.php?sid=attack&user2ID=900', 'https://www.torn.com/loader.php?sid=attack&user2ID=900']) {
    assert.equal(pageTargetId(url), 900, url);
  }
  for (const url of [undefined, '', 'not a URL', 'https://example.com/profiles.php?XID=900',
    'https://www.torn.com.example.com/profiles.php?XID=900', 'http://www.torn.com/profiles.php?XID=900',
    'https://www.torn.com/index.php?XID=900', 'https://www.torn.com/profiles.php',
    'https://www.torn.com/profiles.php?XID=0', 'https://www.torn.com/profiles.php?XID=-900',
    'https://www.torn.com/profiles.php?XID=900.5', 'https://www.torn.com/profiles.php?XID=9e2',
    'https://www.torn.com/profiles.php?XID=900&XID=901', 'https://www.torn.com/profiles.php?XID=900%20',
    'https://www.torn.com/page.php?sid=other&user2ID=900', 'https://www.torn.com/page.php?user2ID=900',
    'https://www.torn.com/page.php?sid=attack&sid=other&user2ID=900',
    'https://www.torn.com/page.php?sid=attack&user2ID=900&user2ID=901',
    'https://www.torn.com/profiles.php?XID=9007199254740992']) {
    assert.equal(pageTargetId(url), null, String(url));
  }
});

test('profile and attack pages display the listed player reason without opening NWA settings', async () => {
  for (const url of ['https://www.torn.com/profiles.php?XID=900', 'https://www.torn.com/page.php?sid=attack&user2ID=900']) {
    const page = fixture(url); assert.equal(page.notice(), null, 'authorization has not completed');
    await page.feed(); const note = page.notice(); assert.ok(note, 'an inline target note is present');
    assert.match(page.noticeText(), /NWA target list/i); assert.match(page.noticeText(), /Repeatedly attacked alliance members\./);
    assert.equal(note.parentNode, page.content());
    assert.equal(page.requests.length, 1, 'the note reuses the existing authorized target feed');
  }
});

test('target reason takes precedence over legacy notes and all reason content stays plain text', async () => {
  const page = fixture('https://www.torn.com/profiles.php?XID=900');
  const reason = '<img src=x onerror="alert(1)"> Reason & details';
  await page.feed([{ ...target, reason, notes: 'Legacy note should not replace the reason.' }]);
  const note = page.notice(); assert.ok(note); assert.ok(page.noticeText().includes(reason));
  assert.equal(page.noticeText().includes('Legacy note should not replace'), false);
  assert.equal(all(note.shadow || note).some(node => node.tagName === 'IMG' || node.tagName === 'SCRIPT'), false);
});

test('blank and missing reasons use legacy notes or a clear missing-reason fallback', async () => {
  for (const [details, expected] of [[{ reason: '  ', notes: 'Approved legacy reason.' }, 'Approved legacy reason.'],
    [{ reason: null, notes: null }, 'No reason provided.'], [{ reason: {}, notes: '' }, 'No reason provided.']]) {
    const page = fixture('https://www.torn.com/profiles.php?XID=900'); await page.feed([{ ...target, ...details }]);
    assert.ok(page.noticeText().endsWith(`Reason: ${expected}`));
  }
});

test('unlisted players and signed-out users do not display a target note', async () => {
  const unlisted = fixture('https://www.torn.com/profiles.php?XID=901'); await unlisted.feed();
  assert.equal(unlisted.notice(), null);
  const signedOut = fixture('https://www.torn.com/profiles.php?XID=900', { saved: false });
  signedOut.mutation(); signedOut.tick(); assert.equal(signedOut.notice(), null); assert.equal(signedOut.requests.length, 0);
});

test('SPA navigation changes the note for the current player and removes it off player pages', async () => {
  const page = fixture('https://www.torn.com/profiles.php?XID=900');
  await page.feed([target, { ...target, id: 901, reason: 'A second player reason.' }]);
  page.changeUrl('https://www.torn.com/page.php?sid=attack&user2ID=901'); page.mutation(); page.tick();
  assert.match(page.noticeText(), /A second player reason\./);
  assert.equal(page.noticeText().includes(target.notes), false);
  page.changeUrl('https://www.torn.com/profiles.php?XID=902'); page.mutation(); page.tick();
  assert.equal(page.notice(), null);
  page.changeUrl('https://www.torn.com/index.php'); page.mutation(); page.tick(); assert.equal(page.notice(), null);
});

test('late Torn content and replacement mounts produce exactly one inline note', async () => {
  const page = fixture('https://www.torn.com/page.php?sid=attack&user2ID=900', { mounted: false });
  await page.feed(); page.mountLate(); page.tick(); assert.ok(page.notice());
  assert.equal(page.notice().parentNode, page.content());
  page.replaceContent(); page.tick();
  assert.ok(page.notice()); assert.equal(page.notice().parentNode, page.content());
  page.mutation(); page.tick(); assert.equal(all(page.body).filter(node => node.id === 'nwa-target-page-notice').length, 1);
});

test('a refreshed authorized target feed updates its reason and removes delisted players', async () => {
  const page = fixture('https://www.torn.com/profiles.php?XID=900'); await page.feed();
  page.tick(NOW + 10000); await page.feed([{ ...target, reason: 'Updated approved reason.' }]);
  assert.match(page.noticeText(), /Updated approved reason\./);
  page.tick(NOW + 20000); await page.feed([]); assert.equal(page.notice(), null);
});

test('sign-out immediately removes the note and an older feed cannot restore it', async () => {
  const page = fixture('https://www.torn.com/profiles.php?XID=900'); await page.feed(); assert.ok(page.notice());
  page.tick(NOW + 10000); const previousFeed = page.requests.at(-1);
  page.control('Sign out and remove key').emit('click'); assert.equal(page.notice(), null);
  page.response(page.requests.at(-1), null, 204); await flush();
  page.response(previousFeed, { player, targets: [target], warnings: [] }); await flush(); page.mutation();
  assert.equal(page.notice(), null);
});

test('authorization denial and session expiry remove previously displayed target notes', async () => {
  for (const interruption of ['denial', 'expiry']) {
    const page = fixture('https://www.torn.com/profiles.php?XID=900'); await page.feed(); assert.ok(page.notice());
    if (interruption === 'denial') {
      page.tick(NOW + 10000); page.response(page.requests.at(-1), { error: { code: 'FACTION_NOT_ALLOWED', message: 'Access removed.' } }, 403); await flush();
    } else page.tick(NOW + 3600000);
    assert.equal(page.notice(), null);
  }
});

test('a failed authorization refresh and an expired cached feed cannot continue displaying the note', async () => {
  for (const interruption of ['failed refresh', 'stale pending feed']) {
    const page = fixture('https://www.torn.com/profiles.php?XID=900'); await page.feed(); assert.ok(page.notice());
    if (interruption === 'failed refresh') {
      page.tick(NOW + 10000); page.response(page.requests.at(-1), { error: { code: 'UPSTREAM_UNAVAILABLE', message: 'Try later.' } }, 503); await flush();
    } else page.tick(NOW + 30000);
    assert.equal(page.notice(), null, interruption);
  }
});
