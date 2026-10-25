import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const core = await readFile(new URL('../src/core.js', import.meta.url), 'utf8');
const exportSource = await readFile(new URL('../src/export.js', import.meta.url), 'utf8');
const platform = await readFile(new URL('../src/platform.js', import.meta.url), 'utf8');
const app = await readFile(new URL('../src/app.js', import.meta.url), 'utf8');
const { pageTargetId } = vm.runInNewContext(`${core}\nTargetListCore;`, { URL });
const NOW = Date.parse('2026-10-11T12:00:00Z');
const player = { id: 123, name: 'Member', faction: { id: 111, name: 'Alliance Faction' },
  battleStats: { strength: 250000, defense: 250000, speed: 250000, dexterity: 250000, total: 1000000 } };
const target = { id: 900, name: 'Listed Player', faction: { id: 222, name: 'Other Faction' },
  estimatedStats: 500000, estimateUpdatedAt: NOW / 1000 - 3600, estimateSource: 'FFScouter', status: { state: 'Okay' },
  notes: 'Repeatedly attacked alliance members.' };
const all = node => [node, ...node.children.flatMap(child => typeof child === 'object' ? all(child) : [])];

// A page-specific standard DOM fixture: network calls and mutation delivery stay manual.
class Element {
  constructor(tag) {
    this.tagName = tag.toUpperCase(); this.children = []; this.parentNode = null;
    this.style = {}; this.attributes = new Map(); this.listeners = new Map(); this.value = '';
    this._text = ''; this.activeElement = null; this.nodeType = tag === 'document' ? 9 : 1;
    this.rect = { left: 40, top: 40, width: 240, height: 24 };
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
  get firstElementChild() { return this.children.find(child => typeof child === 'object') ?? null; }
  get parentElement() { return this.parentNode; }
  get childNodes() { return this._text ? [{ nodeType: 3, textContent: this._text, parentNode: this }, ...this.children] : this.children; }
  getBoundingClientRect() {
    const dock = this.className === 'launcher' ? { left: 1160, top: 136, width: 40, height: 30 }
      : this.className === 'settings-toggle' ? { left: 1176, top: 166, width: 24, height: 24 } : null;
    const rect = dock || this.rect;
    const { left, top, width, height } = rect;
    return { ...rect, right: left + width, bottom: top + height, x: left, y: top };
  }
  getClientRects() { return this.rect.width > 0 && this.rect.height > 0 ? [this.getBoundingClientRect()] : []; }
  closest(selector) { for (let node = this; node; node = node.parentElement) if (node.matches(selector)) return node; return null; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); if (name === 'id') this.id = String(value); if (name === 'class') this.className = String(value); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  addEventListener(name, callback) { if (!this.listeners.has(name)) this.listeners.set(name, []); this.listeners.get(name).push(callback); }
  emit(type, additions = {}) { const event = { preventDefault() {}, ...additions }; for (const listener of this.listeners.get(type) || []) listener(event); }
  attachShadow() { this.shadow = new Element('shadow-root'); this.shadow.parentNode = this; return this.shadow; }
  matches(selector) {
    if (selector.includes(',')) return selector.split(',').some(part => this.matches(part.trim()));
    const descendant = selector.match(/^(.*?)\s+([^ ]+)$/);
    if (descendant) return this.matches(descendant[2]) && Boolean(this.parentElement?.closest(descendant[1]));
    if (selector.startsWith('#')) return this.id === selector.slice(1);
    if (selector.startsWith('.')) return (this.className || '').split(/\s+/).includes(selector.slice(1));
    const tagAttribute = selector.match(/^([a-z][a-z0-9-]*)(\[.+\])$/i);
    if (tagAttribute) return this.matches(tagAttribute[1]) && this.matches(tagAttribute[2]);
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
function fixture(url, { saved = true, mounted = true, nativeAnchor = true } = {}) {
  let now = NOW; let nextTimeout = 1;
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
  const document = new Element('document'); const html = new Element('html'); const body = new Element('body');
  document.append(html); html.append(body); document.body = body; document.documentElement = html;
  html.clientWidth = 1200; html.clientHeight = 800;
  body.rect = { left: 0, top: 0, width: 1200, height: 800 };
  document.visibilityState = 'visible'; document.readyState = 'complete';
  document.getElementById = id => all(document).find(node => node.id === id) ?? null;
  document.createElement = tag => new Element(tag);
  document.createElementNS = (namespace, tag) => { const node = new Element(tag); node.namespaceURI = namespace; return node; };
  document.createRange = () => {
    let selected = null;
    return { selectNodeContents(node) { selected = node; }, selectNode(node) { selected = node; },
      getClientRects() { return (selected?.parentNode && selected.nodeType === 3 ? selected.parentNode : selected)?.getClientRects() || []; },
      getBoundingClientRect() { return this.getClientRects()[0] ?? { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }; }, detach() {} };
  };
  const window = new Element('window'); window.location = { href: url, assign() {} }; window.innerWidth = 1200; window.innerHeight = 800;
  window.getComputedStyle = node => ({ display: node.hidden ? 'none' : 'block', visibility: 'visible', position: 'static' });
  const requests = []; const timers = []; const timeouts = new Map(); const observers = [];
  const storage = new Map();
  if (saved) storage.set('targetlist.session.https://targetlist.grusmedia.no', { token: 'saved-session', expiresAt: new Date(NOW + 3600000).toISOString() });
  class MutationObserver {
    constructor(callback) { this.callback = callback; this.areas = []; observers.push(this); }
    observe(node, options) { this.areas.push({ node, options }); this.active = true; }
    disconnect() { this.active = false; this.areas = []; }
  }
  function mountContent() {
    const content = new Element('main'); content.id = 'mainContainer'; content.className = 'content-wrapper';
    content.rect = { left: 40, top: 40, width: 1120, height: 700 };
    if (nativeAnchor) {
      const heading = new Element('h4'); heading.textContent = url.includes('profiles.php') ? 'Listed Player [900]' : 'Attacking';
      content.append(heading);
      if (!url.includes('profiles.php')) {
        const defender = new Element('div'); defender.className = 'defender_test'; defender.rect = { left: 640, top: 120, width: 520, height: 220 };
        const labels = new Element('div'); labels.className = 'labelsContainer_test'; labels.rect = { left: 640, top: 120, width: 190, height: 24 };
        const link = new Element('a'); link.setAttribute('href', 'https://www.torn.com/profiles.php?XID=900'); link.textContent = 'Listed Player';
        labels.append(link); defender.append(labels); content.append(defender);
      }
    }
    body.prepend(content); return content;
  }
  let content = mounted ? mountContent() : null;
  const context = vm.createContext({ URL, Intl, Date: Clock, console, window, location: window.location, document, MutationObserver,
    getComputedStyle: window.getComputedStyle, Node: { ELEMENT_NODE: 1, TEXT_NODE: 3 },
    GM_getValue: (key, fallback) => storage.get(key) ?? fallback,
    GM_setValue: (key, value) => storage.set(key, value), GM_deleteValue: key => storage.delete(key),
    GM_xmlhttpRequest: request => requests.push(request),
    setInterval: (callback, delay) => { timers.push({ callback, delay }); return timers.length; },
    clearInterval() {},
    setTimeout: (callback, delay = 0) => { const id = nextTimeout++; timeouts.set(id, { callback, delay }); return id; },
    clearTimeout: id => timeouts.delete(id),
  });
  vm.runInContext(`(() => {\n${core}\n${exportSource}\n${platform}\n${app}\n})();`, context);
  function shortTimeouts() { for (const [id, entry] of [...timeouts]) if (entry.delay < 1000) { timeouts.delete(id); entry.callback(); } }
  function mutation() { for (const observer of observers) if (observer.active) observer.callback([{ target: content || body }]); shortTimeouts(); }
  function response(request, data, status = 200) { assert.ok(request, 'an expected request exists'); request.onload({ status, responseText: JSON.stringify(data), finalUrl: request.url }); }
  async function feed(targets = [target], pendingSuggestions) { response(requests.at(-1), { player, targets, pendingSuggestions, warnings: [], generatedAt: new Date(now).toISOString() }); await flush(); shortTimeouts(); }
  function control(label) { const root = document.getElementById('torn-targetlist-host').shadow; const button = all(root).find(node => node.tagName === 'BUTTON' && node.textContent === label); assert.ok(button, `button ${label} exists`); return button; }
  function notice() { return document.getElementById('nwa-target-page-notice'); }
  function noticeText() { return notice()?.shadow?.textContent || notice()?.textContent || ''; }
  return { document, body, window, storage, requests, timers, observers, feed, response, control, mutation, notice, noticeText,
    openSettings() {
      const root = document.getElementById('torn-targetlist-host').shadow;
      all(root).find(node => node.className === 'settings-toggle').emit('click');
    },
    changeUrl(value, event = 'popstate') { window.location.href = value; window.emit(event); shortTimeouts(); },
    tick(value = now) { now = value; for (const timer of timers) timer.callback(); shortTimeouts(); },
    mountLate() { content = mountContent(); mutation(); return content; },
    replaceContent() { content?.remove(); content = mountContent(); mutation(); return content; },
    addFairFight() {
      // With no TreeWalker, the fallback rect represents the occupied text span.
      const row = new Element('div'); row.className = 'ffscouter-info-line'; row.rect = { left: 40, top: 82, width: 440, height: 20 };
      const text = new Element('span'); text.textContent = 'FairFight: 2.39 (Moderately difficult) Est. Stats: 724m';
      text.rect = { left: 40, top: 82, width: 440, height: 20 }; row.append(text); content.append(row); mutation(); return row;
    },
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

test('profile and attack pages display a body-mounted badge beside existing text without adding a content row', async () => {
  for (const url of ['https://www.torn.com/profiles.php?XID=900', 'https://www.torn.com/page.php?sid=attack&user2ID=900']) {
    const page = fixture(url); assert.equal(page.notice(), null, 'authorization has not completed');
    await page.feed(); const note = page.notice(); assert.ok(note, 'an inline target note is present');
    assert.match(page.noticeText(), /NWA target list/i); assert.match(page.noticeText(), /Repeatedly attacked alliance members\./);
    assert.equal(note.parentNode, page.body, 'out-of-flow badge does not become a new content row');
    assert.equal(note.getAttribute('data-placement'), url.includes('profiles.php') ? 'profile' : 'attack');
    assert.equal(page.content().contains(note), false, 'the native content structure is unchanged');
    assert.equal(note.shadow.querySelector('.estimate').textContent, 'Est. 500K');
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

test('unlisted players show a suggestion action while signed-out users show no target information', async () => {
  const unlisted = fixture('https://www.torn.com/profiles.php?XID=901'); await unlisted.feed();
  assert.equal(unlisted.notice().getAttribute('data-mode'), 'suggest');
  assert.equal(unlisted.notice().shadow.querySelector('.full-reason'), null);
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
  assert.equal(page.notice().getAttribute('data-mode'), 'suggest');
  page.changeUrl('https://www.torn.com/index.php'); page.mutation(); page.tick(); assert.equal(page.notice(), null);
});

test('late Torn content and replacement mounts produce exactly one out-of-flow note', async () => {
  const page = fixture('https://www.torn.com/page.php?sid=attack&user2ID=900', { mounted: false });
  await page.feed(); page.mountLate(); page.tick(); assert.ok(page.notice());
  assert.equal(page.notice().parentNode, page.body);
  page.replaceContent(); page.tick();
  assert.ok(page.notice()); assert.equal(page.notice().parentNode, page.body);
  page.mutation(); page.tick(); assert.equal(all(page.body).filter(node => node.id === 'nwa-target-page-notice').length, 1);
});

test('a late FairFight row takes priority and its replacement never duplicates or moves third-party content', async () => {
  for (const url of ['https://www.torn.com/profiles.php?XID=900', 'https://www.torn.com/page.php?sid=attack&user2ID=900']) {
    const page = fixture(url); await page.feed(); assert.ok(page.notice());
    const first = page.addFairFight(); const firstText = first.textContent;
    assert.equal(page.notice().getAttribute('data-placement'), 'ffscouter');
    assert.equal(page.notice().parentNode, page.body);
    assert.equal(first.textContent, firstText, 'FairFight text is untouched');
    assert.equal(first.children.length, 1, 'NWA does not enter FFScouter\'s React tree');
    first.remove(); const second = page.addFairFight();
    assert.equal(page.notice().getAttribute('data-placement'), 'ffscouter');
    assert.equal(second.children.length, 1);
    page.mutation(); page.tick();
    assert.equal(all(page.body).filter(node => node.id === 'nwa-target-page-notice').length, 1);
    second.remove(); page.mutation();
    assert.equal(page.notice().getAttribute('data-placement'), url.includes('profiles.php') ? 'profile' : 'attack');
    assert.equal(page.requests.length, 1, 'anchor changes reuse the current NWA feed');
  }
});

test('no usable page anchor leaves no orphan notice or new content row', async () => {
  const page = fixture('https://www.torn.com/profiles.php?XID=900', { nativeAnchor: false });
  await page.feed(); page.mutation(); page.tick();
  assert.equal(page.notice(), null);
  assert.equal(page.content().children.length, 0);
  const row = page.addFairFight(); assert.ok(page.notice());
  row.remove(); page.mutation(); assert.equal(page.notice(), null, 'removing the only anchor removes the badge');
});

test('the notice estimate comes from NWA with source and age details without another API request', async () => {
  const page = fixture('https://www.torn.com/page.php?sid=attack&user2ID=900');
  await page.feed([{ ...target, estimatedStats: 724000000, estimateSource: 'model', estimateProvider: 'FFScouter' }]);
  assert.equal(page.notice().shadow.querySelector('.estimate').textContent, 'Est. 724M');
  const details = page.notice().shadow.querySelector('.estimate-detail').textContent;
  assert.match(details, /FFScouter/i); assert.match(details, /1\s*h|hour/i);
  assert.equal(details.includes('model'), false);
  assert.match(page.notice().shadow.querySelector('summary').title, /FFScouter/);
  assert.equal(page.requests.length, 1);
});

test('a live faction eligibility denial removes the profile notice while preserving the authorized session', async () => {
  const page = fixture('https://www.torn.com/profiles.php?XID=900');
  await page.feed(); assert.ok(page.notice());
  page.openSettings(); page.control('Check status').emit('click');
  page.response(page.requests.at(-1), { error: { code: 'TARGET_LEFT_FACTION', message: 'This target left its nominated faction.' } }, 403);
  await flush(); page.openSettings(); page.mutation();
  assert.equal(page.notice().getAttribute('data-mode'), 'suggest');
  assert.equal(page.notice().shadow.querySelector('.full-reason'), null);
  assert.equal(page.storage.get('targetlist.session.https://targetlist.grusmedia.no').token, 'saved-session');
});

test('unknown and stale estimates remain honest and preserve the approved reason', async () => {
  for (const [stats, updated, expected] of [[null, null, /unknown|unavailable/i],
    [500000, NOW / 1000 - 60 * 86400, /old|outdated|stale|needs refresh/i]]) {
    const page = fixture('https://www.torn.com/profiles.php?XID=900');
    await page.feed([{ ...target, estimatedStats: stats, estimateUpdatedAt: updated, reason: 'Approved reason remains visible.' }]);
    const note = page.notice(); assert.ok(note);
    const text = note.shadow.querySelector('.estimate').textContent + ' ' + note.shadow.querySelector('.estimate-detail').textContent;
    assert.match(text, expected);
    assert.match(note.shadow.querySelector('.full-reason').textContent, /Approved reason remains visible/);
    assert.equal(page.requests.length, 1);
  }
});

test('a refreshed authorized target feed updates its reason and removes delisted players', async () => {
  const page = fixture('https://www.torn.com/profiles.php?XID=900'); await page.feed();
  page.tick(NOW + 10000); await page.feed([{ ...target, reason: 'Updated approved reason.' }]);
  assert.match(page.noticeText(), /Updated approved reason\./);
  page.tick(NOW + 20000); await page.feed([]); assert.equal(page.notice().getAttribute('data-mode'), 'suggest');
});

test('sign-out immediately removes the note and an older feed cannot restore it', async () => {
  const page = fixture('https://www.torn.com/profiles.php?XID=900'); await page.feed(); assert.ok(page.notice());
  page.openSettings();
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

test('ordinary Torn pages do not observe body mutations', async () => {
  for (const url of ['https://www.torn.com/index.php']) {
    const page = fixture(url); await page.feed();
    assert.equal(page.observers.some(observer => observer.active), false);
    page.openSettings(); assert.ok(page.control('Find target'), 'settings still open immediately without an observer');
  }
});

test('a listed player observes its notice area with shallow ancestor remount detection and pauses while hidden', async () => {
  const page = fixture('https://www.torn.com/page.php?sid=attack&user2ID=900'); await page.feed();
  const observer = page.observers.find(value => value.active);
  assert.ok(observer);
  assert.notEqual(observer.areas[0].node, page.body);
  assert.equal(observer.areas[0].options.subtree, true);
  assert.ok(observer.areas.some(area => area.node === page.body && !area.options.subtree), 'body detects only direct child remounts');
  page.replaceContent(); assert.ok(page.notice(), 'dynamic attack content remounts without a full-page observer');
  page.document.visibilityState = 'hidden'; page.document.emit('visibilitychange');
  assert.equal(page.observers.some(value => value.active), false); assert.equal(page.notice(), null);
  page.document.visibilityState = 'visible'; page.document.emit('visibilitychange');
  await page.feed(); assert.ok(page.notice());
  page.changeUrl('https://www.torn.com/index.php');
  assert.equal(page.observers.some(value => value.active), false); assert.equal(page.notice(), null);
});


test('unlisted profile and attack pages offer a compact quick suggestion with a mandatory reason', async () => {
  for (const url of ['https://www.torn.com/profiles.php?XID=900', 'https://www.torn.com/page.php?sid=attack&user2ID=900']) {
    const page = fixture(url); await page.feed([]);
    assert.ok(page.notice()); assert.equal(page.notice().getAttribute('data-mode'), 'suggest');
    assert.match(page.notice().shadow.querySelector('summary').textContent, /Suggest to NWA/);
    assert.equal(page.requests.length, 1, 'viewing an unlisted player does not perform another lookup');
    const form = page.notice().shadow.querySelector('form'); form.emit('submit'); await flush();
    assert.equal(page.requests.length, 1, 'a reason is required');
    const comment = form.querySelector('textarea'); comment.value = 'Repeated attacks on members.'; comment.emit('input');
    form.emit('submit'); form.emit('submit'); await flush();
    assert.equal(page.requests.length, 2, 'only one mutation can be in flight');
    const request = page.requests.at(-1); assert.equal(request.method, 'POST');
    assert.ok(request.url.endsWith('/api/suggestions'));
    assert.deepEqual(JSON.parse(request.data), { type: 'player', targetId: 900, comment: 'Repeated attacks on members.' });
    page.response(request, { suggestion: { id: 'new-suggestion', status: 'pending' } }, 201); await flush();
    assert.match(page.notice().shadow.querySelector('summary').textContent, /Suggested/);
    assert.match(page.noticeText(), /review/);
    assert.equal(page.requests.length, 2, 'a closed settings panel needs no queue lookup');
  }
});


test('quick suggestions are absent for self, listed players, missing authorization and stale feeds', async () => {
  const self = fixture('https://www.torn.com/profiles.php?XID=123'); await self.feed([]); assert.equal(self.notice(), null);
  const listed = fixture('https://www.torn.com/profiles.php?XID=900'); await listed.feed();
  assert.equal(listed.notice().shadow.querySelector('form'), null);
  const stale = fixture('https://www.torn.com/profiles.php?XID=900'); await stale.feed([]);
  assert.equal(stale.notice().getAttribute('data-mode'), 'suggest');
  stale.tick(NOW + 120001); assert.equal(stale.notice(), null);
});

test('quick suggestion failures retain the reason and login, while revocation removes the action', async () => {
  const page = fixture('https://www.torn.com/profiles.php?XID=900'); await page.feed([]);
  let form = page.notice().shadow.querySelector('form');
  const input = form.querySelector('textarea'); input.value = 'My reason'; input.emit('input'); form.emit('submit');
  page.response(page.requests.at(-1), { error: { code: 'FRIENDLY_TARGET', message: 'This player belongs to a protected faction.' } }, 403); await flush();
  assert.equal(page.notice().shadow.querySelector('textarea').value, 'My reason');
  assert.match(page.notice().shadow.querySelector('.quick-feedback').textContent, /protected faction/);
  assert.ok(page.storage.get('targetlist.session.https://targetlist.grusmedia.no'));
  form.emit('submit');
  page.response(page.requests.at(-1), { error: { code: 'SESSION_EXPIRED', message: 'Sign in again.' } }, 401); await flush();
  assert.equal(page.notice(), null);
});

test('SPA navigation cannot submit a stale player form or apply an old response to a new draft', async () => {
  const page = fixture('https://www.torn.com/profiles.php?XID=900'); await page.feed([]);
  const form = page.notice().shadow.querySelector('form'); form.querySelector('textarea').value = 'Reason for 900'; form.emit('submit');
  const mutation = page.requests.at(-1);
  page.changeUrl('https://www.torn.com/profiles.php?XID=902'); page.mutation(); page.tick();
  const next = page.notice().shadow.querySelector('textarea'); next.value = 'Reason for 902'; next.emit('input');
  page.response(mutation, { suggestion: { status: 'pending' } }, 201); await flush();
  assert.equal(page.notice().shadow.querySelector('textarea').value, 'Reason for 902');
  assert.match(page.notice().shadow.querySelector('summary').textContent, /Suggest to NWA/);
  const before = page.requests.length; form.emit('submit'); await flush(); assert.equal(page.requests.length, before);
  page.notice().shadow.querySelector('form').emit('submit');
  assert.equal(JSON.parse(page.requests.at(-1).data).targetId, 902);
});


test('quick suggestions leave an unfinished main-panel draft unchanged', async () => {
  const page = fixture('https://www.torn.com/profiles.php?XID=900'); await page.feed([]);
  page.openSettings(); page.control('Suggestions').emit('click');
  page.response(page.requests.at(-1), { canReview: false, suggestions: [], nextOffset: null }); await flush();
  const root = page.document.getElementById('torn-targetlist-host').shadow;
  let main = root.querySelector('.suggestionform');
  const id = main.querySelector('input'); id.value = '777'; id.emit('input');
  const draft = main.querySelector('textarea'); draft.value = 'Unfinished reason for another player'; draft.emit('input');
  const quick = page.notice().shadow.querySelector('form'); quick.querySelector('textarea').value = 'Profile quick reason'; quick.emit('submit');
  const mutation = page.requests.at(-1); assert.equal(JSON.parse(mutation.data).comment, 'Profile quick reason');
  page.response(mutation, { suggestion: { status: 'pending' } }, 201); await flush();
  page.response(page.requests.at(-1), { canReview: false, suggestions: [], nextOffset: null }); await flush();
  main = root.querySelector('.suggestionform');
  assert.equal(main.querySelector('input').value, '777');
  assert.equal(main.querySelector('textarea').value, 'Unfinished reason for another player');
});


test('another member pending suggestion is visible on profile and attack pages and prevents submission', async () => {
  for (const url of ['https://www.torn.com/profiles.php?XID=900', 'https://www.torn.com/page.php?sid=attack&user2ID=900']) {
    const page = fixture(url); await page.feed([], { revision: 'a'.repeat(64), playerIds: [900] });
    assert.match(page.notice().shadow.querySelector('summary').textContent, /Pending/);
    assert.equal(page.notice().shadow.querySelector('form').hidden, true);
    assert.match(page.noticeText(), /already has a pending suggestion/);
    const form = page.notice().shadow.querySelector('form'); form.querySelector('textarea').value = 'Duplicate attempt'; form.emit('submit');
    await flush(); assert.equal(page.requests.length, 1);
    page.tick(NOW + 10000);
    assert.match(page.requests.at(-1).url, /suggestionsCursor=/);
    await page.feed([], { revision: 'b'.repeat(64), playerIds: [] });
    assert.match(page.notice().shadow.querySelector('summary').textContent, /Suggest to NWA/);
    assert.equal(page.notice().shadow.querySelector('form').hidden, false);
  }
});

test('unknown or malformed shared pending status hides the quick form without hiding listed targets', async () => {
  for (const pendingSuggestions of [{ unavailable: true }, { revision: 'a'.repeat(64), unchanged: true }]) {
    const page = fixture('https://www.torn.com/profiles.php?XID=900'); await page.feed([], pendingSuggestions);
    assert.equal(page.notice().shadow.querySelector('form').hidden, true);
    assert.match(page.noticeText(), /could not be checked/);
    const listed = fixture('https://www.torn.com/profiles.php?XID=900'); await listed.feed([target], pendingSuggestions);
    assert.equal(listed.notice().getAttribute('data-mode'), 'listed');
  }
});


test('an old pending heartbeat cannot erase a just-submitted local suggestion', async () => {
  const page = fixture('https://www.torn.com/profiles.php?XID=900');
  await page.feed([], { revision: 'a'.repeat(64), playerIds: [] });
  page.tick(NOW + 10000); const oldFeed = page.requests.at(-1);
  const form = page.notice().shadow.querySelector('form'); form.querySelector('textarea').value = 'New suggestion'; form.emit('submit');
  page.response(page.requests.at(-1), { suggestion: { status: 'pending' } }, 201); await flush();
  page.response(oldFeed, { player, targets: [], pendingSuggestions: { revision: 'a'.repeat(64), unchanged: true }, warnings: [] }); await flush();
  assert.match(page.notice().shadow.querySelector('summary').textContent, /Suggested/);
  page.tick(NOW + 20000);
  assert.equal(page.requests.at(-1).url.includes('suggestionsCursor='), false, 'the next feed asks for a complete pending snapshot');
  await page.feed([], { revision: 'b'.repeat(64), playerIds: [900] });
  assert.match(page.notice().shadow.querySelector('summary').textContent, /Pending/);
  page.tick(NOW + 30000); await page.feed([], { revision: 'c'.repeat(64), playerIds: [] });
  assert.match(page.notice().shadow.querySelector('summary').textContent, /Suggest to NWA/);
  assert.equal(page.notice().shadow.querySelector('.quick-feedback').textContent, '');
});
