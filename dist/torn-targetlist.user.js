// ==UserScript==
// @name         NWA Target Finder
// @namespace    torn-faction-targetlist
// @version      0.4.4
// @description  North West Alliance chain targets.
// @downloadURL  https://raw.githubusercontent.com/Grussniffer/nwa-targetlist-script/codex/initial/dist/torn-targetlist.user.js
// @updateURL    https://raw.githubusercontent.com/Grussniffer/nwa-targetlist-script/codex/initial/dist/torn-targetlist.user.js
// @match        https://www.torn.com/*
// @match        https://torn.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @connect      targetlist.grusmedia.no
// @connect      127.0.0.1
// @connect      localhost
// @run-at       document-idle
// @noframes
// ==/UserScript==

(() => {
'use strict';
const TargetListCore = (() => {
  const DEFAULT_MIN_RATIO = 0.1;
  const DEFAULT_MAX_RATIO = 0.6;
  const ESTIMATE_MAX_AGE = 7 * 24 * 60 * 60;
  const LIVE_STATUS_MAX_AGE = 30 * 1000;

  function serviceUrl(value) {
    const url = new URL(value);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.username || url.password || url.search || url.hash ||
        (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))) {
      throw new Error('Use an HTTPS service address, or HTTP on localhost for development.');
    }
    return url.href.replace(/\/$/, '');
  }

  function validKey(value) { return /^[a-zA-Z0-9]{16}$/.test(value); }
  function pageTargetId(href) {
    let url;
    try { url = new URL(href); } catch { return null; }
    if (url.protocol !== 'https:' || !['torn.com', 'www.torn.com'].includes(url.hostname)) return null;
    let parameter;
    if (url.pathname === '/profiles.php') parameter = 'XID';
    else if (['/page.php', '/loader.php'].includes(url.pathname)
        && url.searchParams.getAll('sid').length === 1 && url.searchParams.get('sid') === 'attack') parameter = 'user2ID';
    else return null;
    if (url.searchParams.getAll(parameter).length !== 1) return null;
    const value = url.searchParams.get(parameter);
    if (!/^[1-9]\d*$/.test(value)) return null;
    const id = Number(value);
    return Number.isSafeInteger(id) && id <= 2147483647 ? id : null;
  }
  function positive(value) { return typeof value === 'number' && Number.isFinite(value) && value > 0; }
  function compact(value) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return 'Unknown';
    return new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 2 }).format(value);
  }
  function ageLabel(timestamp, now = Date.now()) {
    if (!positive(timestamp)) return 'Date unknown';
    const seconds = Math.max(0, Math.floor(now / 1000 - timestamp));
    if (seconds < 60) return 'Just now';
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    return `${Math.floor(seconds / 86400)}d ago`;
  }

  function assess(target, player, maxRatio = DEFAULT_MAX_RATIO, now = Date.now(), minRatio = DEFAULT_MIN_RATIO) {
    const ratio = positive(target.estimatedStats) && positive(player.battleStats.total)
      ? target.estimatedStats / player.battleStats.total : null;
    const validRange = typeof minRatio === 'number' && Number.isFinite(minRatio) && minRatio >= 0 && minRatio <= 5 &&
      typeof maxRatio === 'number' && Number.isFinite(maxRatio) && maxRatio >= 0.01 && maxRatio <= 5 && minRatio <= maxRatio;
    const inRange = validRange && ratio !== null && ratio >= minRatio && ratio <= maxRatio;
    const stamp = target.estimateUpdatedAt;
    const fresh = positive(stamp) && stamp <= now / 1000 + 300 && now / 1000 - stamp <= ESTIMATE_MAX_AGE;
    const allied = target.id === player.id || (target.faction?.id && target.faction.id === player.faction.id);
    const checked = Date.parse(target.checkedAt);
    const live = Number.isFinite(checked) && checked <= now + 5000 && now - checked < LIVE_STATUS_MAX_AGE;
    const until = target.status?.until;
    const validUntil = until == null || (typeof until === 'number' && Number.isSafeInteger(until) && until >= 0);
    const timedUnavailable = validUntil && typeof until === 'number' && until > now / 1000;
    const ready = live && target.status?.state === 'Okay' && validUntil && !timedUnavailable && !allied;
    let label = 'Possible match';
    let tone = 'good';
    if (allied) { label = 'Friendly / self'; tone = 'muted'; }
    else if (ratio === null) { label = 'Stats unknown'; tone = 'muted'; }
    else if (!fresh) { label = 'Estimate needs refresh'; tone = 'warn'; }
    else if (!validRange) { label = 'Invalid stat range'; tone = 'warn'; }
    else if (ratio < minRatio) { label = 'Below your minimum'; tone = 'warn'; }
    else if (ratio > maxRatio) { label = 'Above your limit'; tone = 'warn'; }
    const suggested = !allied && fresh && inRange;
    return { ratio, inRange, fresh, live, ready, timedUnavailable, suggested, label, tone };
  }

  function select(targets, player, options, now = Date.now()) {
    const query = (options.query || '').trim().toLowerCase();
    return targets.map(target => ({ target, assessment: assess(target, player, options.maxRatio, now, options.minRatio) }))
      .filter(({ target, assessment }) => {
        if (options.mode === 'suggested' && !assessment.suggested) return false;
        return !query || `${target.id} ${target.name} ${target.faction?.name || ''} ${target.notes || ''}`.toLowerCase().includes(query);
      })
      .sort((a, b) => Number(b.assessment.suggested) - Number(a.assessment.suggested) ||
        (a.assessment.ratio ?? Infinity) - (b.assessment.ratio ?? Infinity) || a.target.id - b.target.id);
  }

  return { DEFAULT_MIN_RATIO, DEFAULT_MAX_RATIO, ESTIMATE_MAX_AGE, LIVE_STATUS_MAX_AGE, serviceUrl, validKey, pageTargetId, compact, ageLabel, assess, select };
})();

// Keep this service hostname and @connect in metadata.txt in sync when deploying elsewhere.
const CONFIG = Object.freeze({ serviceUrl: 'https://targetlist.grusmedia.no', version: '0.4.4' });

const previousHost = document.getElementById('torn-targetlist-host');
const mountedVersion = previousHost?.getAttribute('data-nwa-version') || '';
if (!previousHost || !/^\d+\.\d+\.\d+$/.test(mountedVersion)
    || mountedVersion.localeCompare(CONFIG.version, undefined, { numeric: true }) < 0) {
  // Earlier Target List editions used the same host ID and could hide NWA entirely.
  previousHost?.remove();
  mountTargetList();
}

function mountTargetList() {
  const C = TargetListCore;
  const FEED_REFRESH_MS = 10_000;
  let base;
  try { base = C.serviceUrl(CONFIG.serviceUrl); }
  catch (error) { console.error('[NWA] Invalid service address:', error.message); return; }
  const storageKey = `targetlist.session.${base}`;
  const preferencesKey = `targetlist.preferences.${base}`;
  const preferences = GM_getValue(preferencesKey, null);
  const savedMaxRatio = preferences?.maxRatio;
  const maxRatio = Number.isFinite(savedMaxRatio) && savedMaxRatio >= 0.01 && savedMaxRatio <= 5 ? savedMaxRatio : C.DEFAULT_MAX_RATIO;
  const savedMinRatio = preferences?.minRatio;
  const minRatio = Number.isFinite(savedMinRatio) && savedMinRatio >= 0 && savedMinRatio <= maxRatio ? savedMinRatio : Math.min(C.DEFAULT_MIN_RATIO, maxRatio);
  const host = document.createElement('div');
  host.id = 'torn-targetlist-host';
  host.setAttribute('data-nwa-version', CONFIG.version);
  host.style.cssText = 'position:fixed;inset:0;z-index:2147483000;pointer-events:none;';
  document.body.append(host);
  const root = host.attachShadow({ mode: 'closed' });
  const state = {
    token: null, expiresAt: null, player: null, targets: [], warnings: [], generatedAt: null, poolLoadedAt: 0,
    authorizedPool: false, backgroundLoading: false, targetLoad: null, lastPoolAttemptAt: 0, backgroundRenderPending: false,
    busy: false, removingKey: false, open: false, generation: 0, error: '', query: '', mode: 'all',
    minRatio, maxRatio,
    lastTargetId: Number.isSafeInteger(preferences?.lastTargetId) ? preferences.lastTargetId : null,
    finding: false, findGeneration: 0, findAfterLogin: false,
    pendingChecks: new Set(), loading: false, targetGeneration: 0, view: 'targets',
    suggestionView: 'pending', suggestions: [], nextSuggestionOffset: null, canReview: false,
    suggestionsLoading: false, suggestionGeneration: 0, suggestionMutation: null, suggestionNotice: '',
    suggestionDraft: { type: 'player', targetId: '', comment: '' }
  };
  const css = document.createElement('style');
  css.textContent = `
    :host{all:initial;font-family:system-ui,-apple-system,Segoe UI,sans-serif;color:#edf4f4;font-size:14px;line-height:1.5}
    *{box-sizing:border-box} button,input,select,textarea{font:inherit}button,a,input,select,textarea{outline-offset:3px}
    button{cursor:pointer;border:1px solid #3d505b;border-radius:9px;padding:8px 12px;background:#22343f;color:#eef6f6}
    button:hover:not(:disabled){background:#304954}button:disabled{cursor:wait;opacity:.55}
    a{color:#7fe0ce;text-decoration:none}a:hover{text-decoration:underline}p{margin:0 0 12px}h2,h3{margin:0}
    input,select,textarea{color:#edf4f4;background:#101c24;border:1px solid #3d505b;border-radius:8px;padding:10px;min-width:0}
    input:focus,select:focus,textarea:focus{border-color:#69d7c0}label{display:block}small,.muted{color:#a8b9c2;font-size:12px}
    .dock{position:absolute;right:0;top:17vh;display:flex;flex-direction:column;align-items:flex-end;gap:0;pointer-events:auto}
    .launcher{display:grid;place-items:center;width:40px;height:30px;padding:0;border:0;border-radius:8px 0 0 8px;
      background:#008000;color:#fff;font:400 14px Arial,Helvetica,sans-serif;line-height:1;box-shadow:none}
    .launcher:hover:not(:disabled){background:#009000}
    .launcher[aria-busy=true]{animation:nwa-pulse 1s ease-in-out infinite}
    .settings-toggle{display:grid;place-items:center;width:24px;height:24px;padding:0;border-radius:0 0 0 7px;border:0;
      background:#008000;color:#fff;line-height:1;box-shadow:none}
    .settings-toggle:hover:not(:disabled){background:#009000}
    .settings-toggle svg{display:block;width:16px;height:16px;pointer-events:none}
    .quick-notice{position:absolute;right:60px;top:0;width:max-content;max-width:min(260px,calc(100vw - 76px));padding:9px 12px;
      border:1px solid #3b6046;border-radius:9px;background:#14291c;color:#e5f6e8;font-size:12px;box-shadow:0 4px 18px #0005}
    @keyframes nwa-pulse{50%{background:#13672a}}
    @media(prefers-reduced-motion:reduce){.launcher[aria-busy=true]{animation:none}}
    .panel{position:absolute;top:12px;right:64px;width:min(640px,calc(100vw - 80px));max-height:calc(100dvh - 24px);
      pointer-events:auto;background:#14222d;border:1px solid #354956;
      border-radius:15px;box-shadow:0 18px 70px #0009;display:flex;flex-direction:column;overflow:hidden}
    [hidden]{display:none!important}.header{display:flex;align-items:center;justify-content:space-between;padding:16px 20px;border-bottom:1px solid #30414c}
    .eyebrow{font-size:10px;letter-spacing:1.8px;font-weight:750;color:#76e1c7;text-transform:uppercase}
    h2{font-size:20px;line-height:1.4}.icon{padding:3px 10px;background:transparent;font-size:20px}
    .scroll{overflow:auto;min-height:0;padding:20px}.login{display:grid;gap:13px}.login input{width:100%;margin-top:5px}
    .primary{background:#76e1c7;color:#102626;font-weight:750;border:0}.primary:hover:not(:disabled){background:#95efd9}
    .notice{font-size:12px;line-height:1.6;color:#b4c3ca}.error{background:#492b31;color:#ffd6d8;padding:10px 13px;border-radius:8px;margin-bottom:14px}
    .profile{display:flex;justify-content:space-between;align-items:flex-start;gap:12px}.profile strong{font-size:17px}
    .statgrid{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin:12px 0}.stat{background:#1c303a;padding:9px;border-radius:8px}
    .stat strong{display:block;color:#e4f5f3;font-size:15px}.toolbar{display:grid;grid-template-columns:1fr 160px;gap:10px;margin:14px 0}
    .controls{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.controls label{display:flex;align-items:center;gap:5px}.controls input{width:74px;padding:5px 8px}.controls button{margin-left:auto}
    .stat-range-summary{font-size:12px;color:#a8b9c2;margin-top:8px;overflow-wrap:anywhere}
    .count{margin:15px 0 10px;font-size:12px;color:#a8b9c2}.cards{display:grid;gap:10px}.card{border:1px solid #354956;border-radius:10px;padding:14px;background:#192b36}
    .cardhead{display:flex;justify-content:space-between;gap:12px;align-items:flex-start}.name{font-weight:750;font-size:15px}.badge{font-size:10px;font-weight:750;padding:4px 7px;border-radius:5px;white-space:nowrap;background:#20473e;color:#a4efd9}
    .badge.warn{background:#4e3e26;color:#f6d290}.badge.muted{background:#2c3944;color:#bbcad4}
    .metrics{display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-top:12px}.metrics strong{display:block;font-size:14px}.metrics small{display:block}
    .actions{display:flex;align-items:center;gap:12px;margin-top:12px}.actions a.attack{margin-left:auto;background:#76e1c7;color:#102626;padding:7px 12px;border-radius:8px;font-weight:750}
    .notes{font-size:12px;color:#b7c7ce;margin-top:8px;overflow-wrap:anywhere}.empty{padding:24px;text-align:center;background:#1c303a;border-radius:10px}
    .footnote{border-top:1px solid #30414c;margin-top:18px;padding-top:14px;font-size:11px;color:#9fb2bd}
    .tabs{display:flex;gap:8px;flex-wrap:wrap;margin:14px 0}.tabs button[aria-pressed=true]{border-color:#76e1c7;background:#244a46;color:#baf8e7}
    .suggestionform{display:grid;gap:12px;margin:14px 0 20px}.suggestionfields{display:grid;grid-template-columns:140px 1fr;gap:10px}
    .suggestionform input,.suggestionform select,.suggestionform textarea{display:block;width:100%;margin-top:5px}.suggestionform textarea{resize:vertical;min-height:84px}
    .success{background:#20473e;color:#baf8e7;padding:10px 13px;border-radius:8px;margin:12px 0;font-size:13px}
    .comment{white-space:pre-wrap;overflow-wrap:anywhere;margin:12px 0;font-size:13px;color:#d4e4e9}.queueheader{display:flex;align-items:center;justify-content:space-between;gap:10px}
    .queueheader h3{font-size:16px}.queuefooter{margin-top:12px}.suggestioncard .actions button{padding:6px 10px}.suggestioncard .name{overflow-wrap:anywhere}
    @media(max-width:480px){.panel{top:8px;right:60px;width:calc(100vw - 68px);max-height:calc(100dvh - 16px)}
      .scroll{padding:14px}.toolbar{grid-template-columns:1fr}.statgrid{grid-template-columns:repeat(2,1fr)}
      .metrics{grid-template-columns:1fr 1fr}.cardhead{flex-wrap:wrap}.badge{white-space:normal}.actions{gap:8px}.header{padding:12px 14px}.suggestionfields{grid-template-columns:1fr}}
  `;
  root.append(css);
  function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined && text !== null) node.textContent = String(text);
    if (className) node.className = className;
    return node;
  }
  function button(text, callback, className) {
    const node = element('button', text, className); node.type = 'button';
    node.addEventListener('click', callback); return node;
  }
  function link(text, href, className) {
    const node = element('a', text, className); node.href = href;
    node.target = '_blank'; node.rel = 'noopener noreferrer'; return node;
  }
  const panel = element('section', null, 'panel'); panel.hidden = true;
  panel.id = 'nwa-panel'; panel.setAttribute('aria-label', 'North West Alliance target finder');
  const header = element('div', null, 'header');
  const title = element('div'); title.append(element('div', `NWA Target Finder · v${CONFIG.version}`, 'eyebrow'), element('h2', 'North West Alliance'));
  header.append(title, button('×', () => toggle(false), 'icon'));
  header.lastChild.setAttribute('aria-label', 'Close NWA settings');
  const scroll = element('div', null, 'scroll');
  const errorBox = element('div', null, 'error'); errorBox.setAttribute('role', 'alert'); errorBox.hidden = true;
  const content = element('div'); scroll.append(errorBox, content); panel.append(header, scroll);
  const dock = element('div', null, 'dock');
  const launcher = button('NWA', () => void findTarget(), 'launcher');
  launcher.setAttribute('aria-label', 'NWA — find a target'); launcher.title = 'North West Alliance — find a target';
  const settings = button('', () => { state.findAfterLogin = false; cancelFind(); toggle(!state.open); }, 'settings-toggle');
  const gear = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  gear.setAttribute('viewBox', '0 0 24 24'); gear.setAttribute('aria-hidden', 'true'); gear.setAttribute('focusable', 'false');
  gear.setAttribute('fill', 'none'); gear.setAttribute('stroke', '#fff'); gear.setAttribute('stroke-width', '1.8');
  gear.setAttribute('stroke-linejoin', 'round');
  const teeth = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  teeth.setAttribute('d', 'M10 2h4l.4 2.4 1.8.8 2-1.4 2 2-1.4 2 .8 1.8L22 10v4l-2.4.4-.8 1.8 1.4 2-2 2-2-1.4-1.8.8L14 22h-4l-.4-2.4-1.8-.8-2 1.4-2-2 1.4-2-.8-1.8L2 14v-4l2.4-.4.8-1.8-1.4-2 2-2 2 1.4 1.8-.8Z');
  const center = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  center.setAttribute('cx', '12'); center.setAttribute('cy', '12'); center.setAttribute('r', '3');
  gear.append(teeth, center); settings.append(gear);
  settings.setAttribute('aria-label', 'NWA settings'); settings.setAttribute('aria-controls', panel.id);
  settings.setAttribute('aria-expanded', 'false'); settings.title = 'NWA settings';
  const quickNotice = element('div', null, 'quick-notice'); quickNotice.setAttribute('role', 'status'); quickNotice.hidden = true;
  dock.append(launcher, settings, quickNotice); root.append(panel, dock);

  function message(text) { state.error = text; errorBox.textContent = text; errorBox.hidden = !text; }
  function findNotice(text) { quickNotice.textContent = text; quickNotice.hidden = !text; }
  function updateLauncher() {
    launcher.disabled = state.finding || state.busy;
    launcher.setAttribute('aria-busy', String(state.finding));
  }
  function cancelFind() { state.findGeneration++; state.finding = false; findNotice(''); updateLauncher(); }
  function savePreferences() { GM_setValue(preferencesKey, { minRatio: state.minRatio, maxRatio: state.maxRatio, lastTargetId: state.lastTargetId }); }
  function assessTarget(target) { return C.assess(target, state.player, state.maxRatio, Date.now(), state.minRatio); }
  function saveSession() {
    GM_setValue(storageKey, { token: state.token, expiresAt: state.expiresAt });
  }
  function clearSession() {
    cancelFind(); state.findAfterLogin = false;
    state.generation++; state.token = null; state.player = null; state.targets = []; state.warnings = []; state.poolLoadedAt = 0;
    state.authorizedPool = false; state.backgroundLoading = false; state.targetLoad = null; state.lastPoolAttemptAt = 0;
    state.backgroundRenderPending = false;
    state.pendingChecks.clear(); state.busy = false; state.loading = false; state.targetGeneration++; state.expiresAt = null;
    state.removingKey = false;
    state.view = 'targets'; state.suggestionView = 'pending'; state.suggestions = []; state.nextSuggestionOffset = null;
    state.canReview = false; state.suggestionsLoading = false; state.suggestionGeneration++;
    state.suggestionMutation = null; state.suggestionNotice = ''; state.suggestionDraft = { type: 'player', targetId: '', comment: '' };
    GM_deleteValue(storageKey);
    updatePageNotice();
  }
  function handleError(error) {
    if (error.code === 'REVIEW_NOT_ALLOWED') state.canReview = false;
    if (['SESSION_EXPIRED', 'UNAUTHORIZED', 'FACTION_NOT_ALLOWED', 'FACTION_CHANGED', 'INVALID_KEY', 'KEY_ACCESS', 'SESSION_REVOKED', 'KEY_REVOKED', 'INVALID_SESSION', 'FORBIDDEN'].includes(error.code) || error.status === 401 || (error.status === 403 && !['FRIENDLY_TARGET', 'REVIEW_NOT_ALLOWED'].includes(error.code))) {
      clearSession(); toggle(true); render();
    }
    message(error.message || 'The request failed. Try again shortly.');
  }
  function request(method, path, body, token = state.token) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const succeed = value => { if (!settled) { settled = true; clearTimeout(deadline); resolve(value); } };
      const fail = error => { if (!settled) { settled = true; clearTimeout(deadline); reject(error); } };
      const deadline = setTimeout(() => fail(new Error('The target service timed out. Try again shortly.')), 20000);
      const headers = { Accept: 'application/json' };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      if (token) headers.Authorization = `Bearer ${token}`;
      try { GM_xmlhttpRequest({
        method, url: `${base}${path}`, headers, anonymous: true, redirect: 'error', timeout: 20000,
        data: body === undefined ? undefined : JSON.stringify(body),
        onload(response) {
          if (settled) return;
          if (response.finalUrl && new URL(response.finalUrl).origin !== new URL(base).origin) {
            fail(new Error('The service redirected to another host. Check the configured service address.')); return;
          }
          let data;
          try { data = response.responseText ? JSON.parse(response.responseText) : null; }
          catch { fail(new Error('The target service returned an invalid response.')); return; }
          if (response.status < 200 || response.status >= 300 || data?.error) {
            const delay = data?.error?.retryAfterSeconds;
            const error = new Error(`${data?.error?.message || 'The target service could not complete the request.'}${delay ? ` Retry in ${delay}s.` : ''}`);
            error.status = response.status; error.code = data?.error?.code; fail(error); return;
          }
          succeed(data);
        },
        onerror: () => fail(new Error('Cannot reach the target service. Check its address and the userscript connection permission.')),
        ontimeout: () => fail(new Error('The target service timed out. Try again shortly.')),
        onabort: () => fail(new Error('The request was cancelled.'))
      }); } catch { fail(new Error('The userscript manager could not send this request. Check its permissions.')); }
    });
  }

  async function login(apiKey) {
    if (state.busy || state.loading) return;
    if (!C.validKey(apiKey)) { message('Enter a 16-character Torn Limited API key.'); return; }
    state.busy = true; message('');
    const generation = ++state.generation;
    render();
    try {
      const data = await request('POST', '/api/session', { apiKey, storeKey: true }, null);
      if (generation !== state.generation) return;
      const storedUntil = Date.parse(data?.keyStorage?.expiresAt);
      if (data?.keyStorage?.mode !== 'encrypted' || !Number.isFinite(storedUntil) || storedUntil <= Date.now()
          || storedUntil > Date.now() + 7 * 24 * 60 * 60 * 1000 + 5000) {
        if (typeof data?.token === 'string' && data.token) {
          try { await request('DELETE', '/api/session', undefined, data.token); } catch { /* Best-effort cleanup of an incompatible backend session. */ }
        }
        throw new Error('Update the NWA backend to enable encrypted key storage.');
      }
      state.token = data.token; state.expiresAt = data.expiresAt; state.player = data.player;
      saveSession(); await loadTargets();
    } catch (error) { if (generation === state.generation) handleError(error); }
    finally {
      if (generation === state.generation) {
        state.busy = false; render();
        if (state.findAfterLogin && state.player && !state.error) {
          state.findAfterLogin = false; void findTarget();
        }
      }
    }
  }

  async function logout() {
    if (!state.token || state.removingKey) return;
    const token = state.token;
    const generation = ++state.generation;
    cancelFind(); state.findAfterLogin = false; state.busy = true; state.removingKey = true;
    state.authorizedPool = false; state.loading = false; state.backgroundLoading = false; state.targetLoad = null;
    updatePageNotice();
    state.targetGeneration++; state.pendingChecks.clear(); state.suggestionGeneration++;
    state.suggestionsLoading = false; state.suggestionMutation = null;
    message(''); render();
    try {
      // Keep the deletion credential until the backend confirms that the saved key is removed.
      await request('DELETE', '/api/session', undefined, token);
      if (generation !== state.generation) return;
      clearSession(); message(''); render();
    } catch (error) {
      if (generation !== state.generation) return;
      state.busy = false; state.removingKey = false;
      message(`Key removal was not confirmed. Your sign-in is kept so you can retry. ${error.message || 'Try again shortly.'}`);
      render();
    }
  }
  function authorizedPoolFresh() {
    const age = Date.now() - state.poolLoadedAt;
    return state.authorizedPool && age >= 0 && age < C.LIVE_STATUS_MAX_AGE;
  }
  let pageNotice = null, pageNoticeReason = null, pageNoticeObserver = null, pageNoticeTimer = null;
  function removePageNotice() {
    pageNotice?.remove(); pageNotice = null; pageNoticeReason = null;
  }
  function updatePageNotice() {
    if (host.isConnected === false) {
      pageNoticeObserver?.disconnect(); removePageNotice(); return;
    }
    const id = C.pageTargetId(window.location?.href);
    const target = id && state.player && state.token && Date.parse(state.expiresAt) > Date.now() && authorizedPoolFresh()
      ? state.targets.find(target => target.id === id) : null;
    if (!target) { removePageNotice(); return; }
    if (!pageNotice) {
      pageNotice = element('div'); pageNotice.id = 'nwa-target-page-notice';
      const noticeRoot = pageNotice.attachShadow({ mode: 'closed' });
      const style = element('style');
      style.textContent = `
        :host{all:initial;display:block;min-width:0;margin:10px 0 14px;font:14px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;color:#edf4f4}
        .notice{box-sizing:border-box;max-width:100%;padding:12px 15px;border:1px solid #376850;border-left:4px solid #56c790;border-radius:7px;background:#14291f;overflow-wrap:anywhere}
        .title{display:block;margin:0 0 3px;color:#94e5b8;font-size:13px;font-weight:750;letter-spacing:.4px}
        p{margin:0}.reason{margin-top:5px;white-space:pre-wrap;color:#dbe9e0}
        @media(max-width:480px){.notice{padding:10px 12px}}
      `;
      const notice = element('section', null, 'notice');
      notice.setAttribute('role', 'note'); notice.setAttribute('aria-label', 'NWA target list notice');
      pageNoticeReason = element('p', null, 'reason');
      notice.append(element('strong', 'NWA target list', 'title'), element('p', 'This player is on the NWA target list.'), pageNoticeReason);
      noticeRoot.append(style, notice);
    }
    const reason = (typeof target.reason === 'string' && target.reason.trim())
      || (typeof target.notes === 'string' && target.notes.trim()) || 'No reason provided.';
    const text = `Reason: ${reason}`;
    // Reasons are text, including any markup characters supplied in a suggestion.
    if (pageNoticeReason.textContent !== text) pageNoticeReason.textContent = text;
    const container = document.querySelector?.('#content-wrapper')
      || document.querySelector?.('#mainContainer .content-wrapper')
      || document.querySelector?.('#mainContainer') || document.querySelector?.('main')
      || document.querySelector?.('.content-wrapper') || document.body;
    if (pageNotice.parentNode !== container) container.prepend(pageNotice);
  }
  function schedulePageNotice() {
    if (pageNoticeTimer !== null) return;
    pageNoticeTimer = setTimeout(() => { pageNoticeTimer = null; updatePageNotice(); }, 100);
  }
  function pageVisible() { return document.visibilityState !== 'hidden'; }
  function editingControl() { return ['INPUT', 'TEXTAREA', 'SELECT'].includes(root.activeElement?.tagName); }
  function renderBackgroundUpdate() {
    state.backgroundRenderPending = true;
    if (!state.open) return;
    if (editingControl()) {
      // Keep the focused input and its unfinished text intact while availability changes.
      if (state.view === 'targets') renderCards();
      return;
    }
    render();
  }
  function loadTargets(force = false, forFind = false, background = false) {
    if (!state.token || state.removingKey || (background && (state.finding || state.pendingChecks.size))) return Promise.resolve(false);
    if (!forFind && !background) cancelFind();
    if (state.targetLoad && !force) return state.targetLoad.promise;
    const generation = state.generation;
    const targetGeneration = ++state.targetGeneration;
    state.loading = !background; state.backgroundLoading = background; state.lastPoolAttemptAt = Date.now(); message('');
    // Background sync publishes a complete new pool without hiding usable cached targets.
    if (!background) { state.targets = []; state.authorizedPool = false; updatePageNotice(); }
    if (!background) render();
    const pending = (async () => {
      try {
        const data = await request('GET', '/api/targets');
        if (generation !== state.generation || targetGeneration !== state.targetGeneration) return false;
        state.player = data.player; state.targets = data.targets; state.warnings = data.warnings || []; state.generatedAt = data.generatedAt;
        state.poolLoadedAt = Date.now(); state.authorizedPool = true;
        updatePageNotice();
        return true;
      } catch (error) {
        if (generation === state.generation && targetGeneration === state.targetGeneration) {
          state.authorizedPool = false; updatePageNotice(); handleError(error);
        }
        return false;
      } finally {
        if (generation === state.generation && targetGeneration === state.targetGeneration) {
          state.loading = false; state.backgroundLoading = false; state.targetLoad = null;
          if (background) renderBackgroundUpdate(); else render();
        }
      }
    })();
    state.targetLoad = { promise: pending };
    return pending;
  }
  async function findTarget() {
    if (state.finding || state.busy) return;
    message('');
    if (!state.token || Date.parse(state.expiresAt) <= Date.now()) {
      if (state.token) clearSession();
      state.findAfterLogin = true; toggle(true); render(); return;
    }
    state.finding = true; updateLauncher(); findNotice('Finding a target…');
    const findGeneration = ++state.findGeneration;
    const generation = state.generation;
    let targetGeneration = state.targetGeneration;
    const current = () => state.finding && findGeneration === state.findGeneration && generation === state.generation
      && targetGeneration === state.targetGeneration && state.token && Date.parse(state.expiresAt) > Date.now();
    try {
      if (!state.player || !authorizedPoolFresh()
          || !C.select(state.targets, state.player, { ...state, mode: 'suggested' }).length) {
        const restored = await loadTargets(false, true);
        targetGeneration = state.targetGeneration;
        if (!restored || !current()) {
          if (findGeneration === state.findGeneration && state.error) findNotice(state.error);
          return;
        }
      }
      const matches = C.select(state.targets, state.player, { ...state, mode: 'suggested' });
      const candidates = matches.filter(row => (!row.assessment.live || row.assessment.ready) && !row.assessment.timedUnavailable)
        .sort((a, b) => Number(b.assessment.ready) - Number(a.assessment.ready)
          || Number(a.target.id === state.lastTargetId) - Number(b.target.id === state.lastTargetId))
        .map(row => row.target);
      const limit = Math.min(candidates.length, 5);
      for (let index = 0; index < limit; index++) {
        if (!current()) return;
        const target = candidates[index];
        const cached = assessTarget(target);
        if (authorizedPoolFresh() && cached.suggested && cached.ready) {
          state.lastTargetId = target.id; savePreferences();
          findNotice(`Opening ${target.name || 'target'}…`);
          window.location.assign(`https://www.torn.com/page.php?sid=attack&user2ID=${target.id}`);
          return;
        }
        findNotice(`Checking ${target.name || 'player'}…`);
        let checked;
        try { checked = await request('GET', `/api/targets/${target.id}/status`); }
        catch (error) {
          if (!current()) return;
          state.targets = state.targets.map(row => row.id === target.id ? { ...row, checkedAt: null } : row);
          if (['FRIENDLY_TARGET', 'TARGET_NOT_FOUND'].includes(error.code)) {
            state.targets = state.targets.filter(row => row.id !== target.id); continue;
          }
          throw error;
        }
        if (!current()) return;
        if (checked?.id !== target.id) throw new Error('NWA could not verify this target. Try again.');
        state.targets = state.targets.map(row => row.id === target.id ? { ...row, ...checked } : row);
        const latest = state.targets.find(row => row.id === target.id);
        const assessment = latest && assessTarget(latest);
        if (!assessment?.suggested || !assessment.ready) continue;
        state.lastTargetId = target.id; savePreferences();
        findNotice(`Opening ${latest.name || 'target'}…`);
        window.location.assign(`https://www.torn.com/page.php?sid=attack&user2ID=${target.id}`);
        return;
      }
      const notice = !state.targets.length ? 'The NWA target pool is empty. Suggest targets in settings.'
        : !matches.length ? 'No targets match your filters and stat range. Adjust them in settings.'
        : candidates.length > limit ? 'No available target in the first 5 matches. Try NWA again or browse settings.'
        : 'No matching targets are available right now. Try again shortly.';
      findNotice(notice);
    } catch (error) {
      if (current()) { handleError(error); findNotice(error.message || 'NWA could not find a target. Try again.'); }
    } finally {
      if (findGeneration === state.findGeneration) {
        state.finding = false;
        if (state.token && Date.parse(state.expiresAt) <= Date.now()) {
          clearSession(); message('Session expired. Sign in again.'); findNotice('Session expired. Open NWA settings to sign in again.');
        }
        render();
      }
    }
  }
  async function checkStatus(id) {
    if (state.removingKey || state.pendingChecks.has(id)) return;
    state.pendingChecks.add(id); message(''); renderCards();
    const generation = state.generation;
    const targetGeneration = state.targetGeneration;
    try {
      const checked = await request('GET', `/api/targets/${id}/status`);
      if (generation !== state.generation || targetGeneration !== state.targetGeneration) return;
      if (checked?.id !== id) throw new Error('NWA could not verify this target. Try again.');
      state.targets = state.targets.map(target => target.id === id ? { ...target, ...checked } : target);
    } catch (error) {
      if (generation !== state.generation || targetGeneration !== state.targetGeneration) return;
      state.targets = state.targets.map(target => target.id === id ? { ...target, checkedAt: null } : target);
      handleError(error);
    } finally {
      if (generation === state.generation) { state.pendingChecks.delete(id); renderCards(); }
    }
  }

  async function loadSuggestions(view = state.suggestionView, append = false) {
    if (!state.token || state.removingKey || (append && (state.suggestionsLoading || state.nextSuggestionOffset === null))) return;
    const generation = state.generation;
    const suggestionGeneration = ++state.suggestionGeneration;
    const offset = append ? state.nextSuggestionOffset : 0;
    state.suggestionView = view; state.suggestionsLoading = true;
    if (!append) { state.suggestions = []; state.nextSuggestionOffset = null; }
    message(''); render();
    try {
      const data = await request('GET', `/api/suggestions?view=${view}&offset=${offset}`);
      if (generation !== state.generation || suggestionGeneration !== state.suggestionGeneration) return;
      state.canReview = data.canReview === true;
      // Keep a changing shared queue from displaying a repeated row across pages.
      const rows = append ? [...state.suggestions, ...data.suggestions] : data.suggestions;
      state.suggestions = [...new Map(rows.map(row => [row.id, row])).values()];
      state.nextSuggestionOffset = Number.isSafeInteger(data.nextOffset) && data.nextOffset > offset ? data.nextOffset : null;
    } catch (error) {
      if (generation === state.generation && suggestionGeneration === state.suggestionGeneration) handleError(error);
    } finally {
      if (generation === state.generation && suggestionGeneration === state.suggestionGeneration) { state.suggestionsLoading = false; render(); }
    }
  }

  async function submitSuggestion() {
    if (!state.token || state.removingKey || state.suggestionMutation) return;
    const draft = state.suggestionDraft;
    const targetId = Number(draft.targetId);
    const comment = draft.comment.trim();
    if (!['player', 'faction'].includes(draft.type) || !/^[1-9]\d*$/.test(draft.targetId.trim()) || !Number.isSafeInteger(targetId) || targetId > 2147483647) {
      message('Enter a valid player or faction ID.'); return;
    }
    if (!comment || [...comment].length > 1000) { message('Add a reason for this target, up to 1,000 characters.'); return; }
    const generation = state.generation;
    state.suggestionMutation = 'submit'; state.suggestionNotice = ''; message(''); render();
    try {
      await request('POST', '/api/suggestions', { type: draft.type, targetId, comment });
      if (generation !== state.generation) return;
      state.suggestionDraft = { type: 'player', targetId: '', comment: '' };
      state.suggestionNotice = 'Suggestion submitted. A faction leader or co-leader can review it.';
      await loadSuggestions();
    } catch (error) { if (generation === state.generation) handleError(error); }
    finally { if (generation === state.generation) { state.suggestionMutation = null; render(); } }
  }

  async function reviewSuggestion(id, decision) {
    if (!state.token || state.removingKey || !state.canReview || state.suggestionMutation || !state.suggestions.some(row => row.id === id && row.status === 'pending')) return;
    const generation = state.generation;
    state.suggestionMutation = id; state.suggestionNotice = ''; message(''); render();
    try {
      const data = await request('POST', `/api/suggestions/${id}/review`, { decision });
      if (generation !== state.generation) return;
      const added = data.addedPlayers || 0;
      state.suggestionNotice = decision === 'approved'
        ? `Suggestion approved. ${added} ${added === 1 ? 'player added' : 'players added'} to the target pool.`
        : 'Suggestion rejected.';
      await Promise.all([loadSuggestions(), ...(decision === 'approved' ? [loadTargets(true)] : [])]);
    } catch (error) {
      if (generation !== state.generation) return;
      if (error.code === 'REVIEW_NOT_ALLOWED') {
        // An older queue response must not restore buttons after leadership was revoked.
        state.suggestionGeneration++; state.suggestionsLoading = false; state.canReview = false;
      }
      handleError(error);
    } finally { if (generation === state.generation) { state.suggestionMutation = null; render(); } }
  }

  let cardContainer, countNode;
  function render() {
    state.backgroundRenderPending = false;
    updatePageNotice();
    updateLauncher();
    content.replaceChildren(); cardContainer = null; countNode = null;
    if (!state.player) {
      const intro = element('p', 'Sign in to find your next NWA chain target.');
      const form = element('form', null, 'login');
      const label = element('label', 'Torn Limited API key');
      const input = element('input'); input.type = 'password'; input.maxLength = 16;
      input.autocomplete = 'off'; input.placeholder = '16-character key'; input.required = true;
      input.disabled = state.busy || state.loading; label.append(input);
      const submit = element('button', state.loading ? 'Restoring session…' : state.busy ? 'Verifying faction…' : 'Sign in and save key', 'primary'); submit.type = 'submit'; submit.disabled = state.busy || state.loading;
      form.addEventListener('submit', event => { event.preventDefault(); const key = input.value.trim(); input.value = ''; void login(key); });
      const privacy = element('div', null, 'notice');
      privacy.id = 'nwa-key-use'; input.setAttribute('aria-describedby', privacy.id);
      privacy.append(element('div', 'Your Limited key verifies your name and faction and reads your battle stats.'),
        element('div', 'Your key is saved encrypted in the backend’s Supabase database and expires after up to 7 days, so target hospital and availability checks continue while you are offline.'),
        element('div', 'Use “Sign out and remove key” to delete the saved key.'),
        link('Get a Limited API key ↗', 'https://www.torn.com/preferences.php#tab=api'));
      form.append(privacy, label, submit); content.append(intro, form); return;
    }
    const player = state.player;
    const profile = element('div', null, 'profile'); const identity = element('div');
    identity.append(element('strong', `${player.name} [${player.id}]`), element('div', `${player.faction.name} · Faction ${player.faction.id}`, 'muted'));
    const signOut = button(state.removingKey ? 'Removing key…' : 'Sign out and remove key', () => void logout());
    signOut.disabled = state.removingKey;
    profile.append(identity, signOut); content.append(profile);
    const tabs = element('div', null, 'tabs'); tabs.setAttribute('aria-label', 'NWA sections');
    for (const [view, label] of [['targets', 'Targets'], ['suggestions', 'Suggestions']]) {
      const tab = button(label, () => {
        if (state.view === view) return;
        state.view = view; render();
        if (view === 'suggestions') void loadSuggestions();
      });
      tab.setAttribute('aria-pressed', String(state.view === view)); tabs.append(tab);
    }
    content.append(tabs);
    if (state.view === 'suggestions') { renderSuggestions(); return; }
    content.append(element('p', `Your battle stats: ${C.compact(player.battleStats.total)} total`, 'muted'));
    const grid = element('div', null, 'statgrid');
    for (const key of ['strength', 'defense', 'speed', 'dexterity']) {
      const stat = element('div', null, 'stat'); stat.append(element('small', key[0].toUpperCase() + key.slice(1)), element('strong', C.compact(player.battleStats[key]))); grid.append(stat);
    }
    content.append(grid);
    const toolbar = element('div', null, 'toolbar');
    const query = element('input'); query.type = 'search'; query.placeholder = 'Search player, faction or notes'; query.value = state.query;
    query.setAttribute('aria-label', 'Search targets'); query.addEventListener('input', () => { state.query = query.value; cancelFind(); renderCards(); });
    const mode = element('select'); mode.setAttribute('aria-label', 'Target view');
    for (const [value, label] of [['all', 'All targets'], ['suggested', 'Possible matches']]) {
      const option = element('option', label); option.value = value; mode.append(option);
    }
    mode.value = state.mode; mode.addEventListener('change', () => { state.mode = mode.value; renderCards(); });
    toolbar.append(query, mode); content.append(toolbar);
    content.append(element('div', 'Target stats (% of yours)', 'notice'));
    const controls = element('div', null, 'controls');
    const rangeSummary = element('div', null, 'stat-range-summary');
    const percent = value => String(Number((value * 100).toFixed(6)));
    const updateRangeSummary = () => {
      const total = state.player.battleStats.total;
      rangeSummary.textContent = `Target range: ${C.compact(total * state.minRatio)}–${C.compact(total * state.maxRatio)} estimated stats (${percent(state.minRatio)}–${percent(state.maxRatio)}% of yours)`;
    };
    for (const [property, label, minimum] of [['minRatio', 'Min', 0], ['maxRatio', 'Max', 1]]) {
      const ratioLabel = element('label', `${label}:`);
      const ratio = element('input'); ratio.type = 'number'; ratio.min = String(minimum); ratio.max = '500'; ratio.step = 'any'; ratio.value = percent(state[property]);
      ratio.setAttribute('aria-label', `${property === 'minRatio' ? 'Minimum' : 'Maximum'} target stats as percent of your total`);
      ratio.addEventListener('change', () => {
        const value = Number(ratio.value);
        const next = value / 100;
        if (!ratio.value.trim() || !Number.isFinite(value) || value < minimum || value > 500) {
          ratio.value = percent(state[property]); message(`Enter ${minimum}–500% for the ${property === 'minRatio' ? 'minimum' : 'maximum'}.`); return;
        }
        if ((property === 'minRatio' && next > state.maxRatio) || (property === 'maxRatio' && next < state.minRatio)) {
          ratio.value = percent(state[property]); message('Minimum stats must be at or below maximum stats.'); return;
        }
        state[property] = next; savePreferences(); cancelFind(); message(''); ratio.value = percent(next); updateRangeSummary(); renderCards();
      });
      ratioLabel.append(ratio, element('span', '%')); controls.append(ratioLabel);
    }
    const refresh = button(state.loading ? 'Loading…' : 'Refresh list', () => void loadTargets()); refresh.disabled = state.loading; controls.append(refresh); content.append(controls);
    updateRangeSummary(); content.append(rangeSummary);
    countNode = element('div', null, 'count'); cardContainer = element('div', null, 'cards'); content.append(countNode, cardContainer);
    const note = element('div', null, 'footnote');
    note.append(element('p', 'Possible matches use estimated total stats, with estimates no older than 7 days. This is a rough difficulty guide: stat distribution, equipment and bonuses also affect fights.'),
      element('p', 'NWA uses availability checked within 30 seconds. Check status to update a target now. Status can change at any time; Torn makes the final availability check.'));
    for (const warning of state.warnings) note.append(element('p', warning));
    if (state.generatedAt) note.append(element('div', `Pool updated: ${new Date(state.generatedAt).toLocaleString()}`));
    content.append(note); renderCards();
  }

  function renderSuggestions() {
    content.append(element('p', 'Suggest a player or faction for the shared target pool. Every suggestion needs a reason.', 'notice'));
    const form = element('form', null, 'suggestionform');
    const fields = element('div', null, 'suggestionfields');
    const typeLabel = element('label', 'Target type'); const type = element('select'); type.setAttribute('aria-label', 'Suggestion type');
    for (const [value, label] of [['player', 'Player'], ['faction', 'Faction']]) { const option = element('option', label); option.value = value; type.append(option); }
    type.value = state.suggestionDraft.type; type.disabled = Boolean(state.suggestionMutation);
    type.addEventListener('change', () => { if (!state.suggestionMutation) state.suggestionDraft.type = type.value; }); typeLabel.append(type);
    const idLabel = element('label', 'Player or faction ID'); const id = element('input'); id.type = 'number'; id.min = '1'; id.max = '2147483647'; id.step = '1'; id.required = true;
    id.placeholder = 'Torn ID'; id.setAttribute('aria-label', 'Player or faction ID'); id.value = state.suggestionDraft.targetId; id.disabled = Boolean(state.suggestionMutation);
    id.addEventListener('input', () => { if (!state.suggestionMutation) state.suggestionDraft.targetId = id.value; }); idLabel.append(id); fields.append(typeLabel, idLabel);
    const commentLabel = element('label', 'Reason / comment (required)'); const comment = element('textarea'); comment.required = true; comment.maxLength = 2000; comment.rows = 3;
    comment.placeholder = 'Why should this target be added?'; comment.setAttribute('aria-label', 'Reason for suggesting this target'); comment.value = state.suggestionDraft.comment; comment.disabled = Boolean(state.suggestionMutation);
    comment.addEventListener('input', () => { if (!state.suggestionMutation) state.suggestionDraft.comment = comment.value; }); commentLabel.append(comment, element('small', 'Up to 1,000 characters. Your name and faction are shown with the suggestion.'));
    const submit = element('button', state.suggestionMutation === 'submit' ? 'Submitting…' : 'Submit suggestion', 'primary'); submit.type = 'submit'; submit.disabled = Boolean(state.suggestionMutation);
    form.addEventListener('submit', event => { event.preventDefault(); void submitSuggestion(); });
    form.append(fields, commentLabel, submit); content.append(form);
    if (state.suggestionNotice) { const notice = element('div', state.suggestionNotice, 'success'); notice.setAttribute('role', 'status'); content.append(notice); }
    const queueHeader = element('div', null, 'queueheader'); queueHeader.append(element('h3', 'Target suggestions'));
    const refresh = button(state.suggestionsLoading ? 'Loading…' : 'Refresh suggestions', () => void loadSuggestions()); refresh.disabled = state.suggestionsLoading || Boolean(state.suggestionMutation); queueHeader.append(refresh); content.append(queueHeader);
    const views = element('div', null, 'tabs'); views.setAttribute('aria-label', 'Suggestion views');
    for (const [view, label] of [['pending', 'Pending suggestions'], ['mine', 'My suggestions']]) {
      const tab = button(label, () => { if (state.suggestionView !== view) void loadSuggestions(view); });
      tab.setAttribute('aria-pressed', String(state.suggestionView === view)); tab.disabled = Boolean(state.suggestionMutation); views.append(tab);
    }
    content.append(views);
    content.append(element('p', state.canReview
      ? 'You can approve or reject suggestions as a current faction leader or co-leader. Approving a faction adds its current players to the target pool.'
      : 'Faction leaders and co-leaders can approve or reject suggestions. Approving a faction adds its current players to the target pool.', 'notice'));
    const queue = element('div', null, 'cards suggestionqueue'); content.append(queue);
    if (!state.suggestions.length) queue.append(element('div', state.suggestionsLoading ? 'Loading suggestions…' : state.suggestionView === 'mine' ? 'You have not suggested any targets yet.' : 'There are no pending suggestions.', 'empty'));
    for (const row of state.suggestions) {
      const card = element('article', null, 'card suggestioncard'); const top = element('div', null, 'cardhead'); const identity = element('div');
      const href = row.type === 'faction' ? `https://www.torn.com/factions.php?step=profile&ID=${row.targetId}` : `https://www.torn.com/profiles.php?XID=${row.targetId}`;
      identity.append(link(`${row.targetName || (row.type === 'faction' ? 'Faction' : 'Player')} [${row.targetId}] ↗`, href, 'name'), element('div', row.type === 'faction' ? 'Faction · current players added on approval' : 'Player', 'muted'));
      top.append(identity, element('span', row.status, `badge ${row.status === 'pending' ? 'warn' : row.status === 'rejected' ? 'muted' : ''}`)); card.append(top);
      card.append(element('div', row.comment, 'comment'));
      const actor = row.suggestedBy;
      card.append(element('div', `Suggested by ${actor.name} [${actor.id}] · ${actor.faction.name} [${actor.faction.id}]`, 'muted'), element('div', new Date(row.createdAt).toLocaleString(), 'muted'));
      if (row.reviewedBy) card.append(element('div', `${row.status === 'approved' ? 'Approved' : 'Rejected'} by ${row.reviewedBy.name} [${row.reviewedBy.id}]${row.reviewedAt ? ` · ${new Date(row.reviewedAt).toLocaleString()}` : ''}`, 'muted'));
      if (state.canReview && row.status === 'pending') {
        const actions = element('div', null, 'actions');
        for (const [decision, label] of [['approved', 'Approve'], ['rejected', 'Reject']]) {
          const action = button(label, () => void reviewSuggestion(row.id, decision), decision === 'approved' ? 'primary' : '');
          action.disabled = Boolean(state.suggestionMutation) || state.suggestionsLoading; actions.append(action);
        }
        card.append(actions);
      }
      queue.append(card);
    }
    if (state.nextSuggestionOffset !== null) {
      const more = button(state.suggestionsLoading ? 'Loading…' : 'Load more suggestions', () => void loadSuggestions(state.suggestionView, true));
      more.disabled = state.suggestionsLoading || Boolean(state.suggestionMutation); const footer = element('div', null, 'queuefooter'); footer.append(more); content.append(footer);
    }
  }

  function renderCards() {
    if (!state.player || !cardContainer) return;
    const rows = C.select(state.targets, state.player, state);
    const suggestions = state.targets.filter(t => assessTarget(t).suggested).length;
    countNode.textContent = state.loading ? 'Loading the faction’s target pool…' : `${rows.length} shown · ${state.targets.length} in pool · ${suggestions} possible matches`;
    cardContainer.replaceChildren();
    if (!rows.length && !state.loading) {
      const text = state.targets.length ? 'No targets match these filters. Try All targets or a different stat range.' : 'The target pool is empty. New targets will appear after your faction’s list is updated.';
      cardContainer.append(element('div', text, 'empty')); return;
    }
    for (const { target, assessment } of rows) {
      const card = element('article', null, 'card'); const top = element('div', null, 'cardhead'); const name = element('div');
      name.append(link(`${target.name || 'Player'} [${target.id}] ↗`, `https://www.torn.com/profiles.php?XID=${target.id}`, 'name'),
        element('div', `${target.faction?.name || 'Faction unknown'}${target.level ? ` · Level ${target.level}` : ''}`, 'muted'));
      top.append(name, element('span', assessment.label, `badge ${assessment.tone}`)); card.append(top);
      const metrics = element('div', null, 'metrics');
      const stats = element('div'); stats.append(element('small', 'Estimated battle stats'), element('strong', C.compact(target.estimatedStats)), element('small', `${target.estimateSource || 'No estimate'} · ${C.ageLabel(target.estimateUpdatedAt)}`));
      const comparison = element('div'); comparison.append(element('small', 'Compared with you'), element('strong', assessment.ratio === null ? 'Unknown' : `${(assessment.ratio * 100).toFixed(0)}% of your stats`));
      const status = element('div');
      status.append(element('small', assessment.live ? 'Status checked just now' : 'Status needs checking'), element('strong', target.status?.state || 'Unknown'),
        element('small', target.lastAction ? `Last active ${C.ageLabel(target.lastAction)}` : 'Activity unknown'));
      if (target.status?.until > Date.now() / 1000) status.append(element('small', `Until ${new Date(target.status.until * 1000).toLocaleTimeString()}`));
      metrics.append(stats, comparison, status); card.append(metrics);
      if (target.notes) card.append(element('div', target.notes, 'notes'));
      const actions = element('div', null, 'actions');
      const check = button(state.pendingChecks.has(target.id) ? 'Checking…' : 'Check status', () => void checkStatus(target.id)); check.disabled = state.pendingChecks.has(target.id) || state.loading;
      actions.append(check);
      if (assessment.suggested && assessment.ready && authorizedPoolFresh()) {
        const attack = link('Attack ↗', `https://www.torn.com/page.php?sid=attack&user2ID=${target.id}`, 'attack');
        const guardAttack = event => {
          const latest = state.targets.find(t => t.id === target.id);
          const currentAssessment = latest && assessTarget(latest);
          if (!latest || !state.token || Date.parse(state.expiresAt) <= Date.now() || !authorizedPoolFresh() || !currentAssessment.suggested || !currentAssessment.ready) {
            event.preventDefault(); message('Check this target’s status and stat range before opening an attack.'); renderCards();
          }
        };
        attack.addEventListener('click', guardAttack);
        attack.addEventListener('auxclick', guardAttack);
        actions.append(attack);
      } else actions.append(element('small', !assessment.suggested ? assessment.label : assessment.live ? target.status?.description || 'Unavailable right now' : 'Check availability to open attack'));
      card.append(actions); cardContainer.append(card);
    }
  }

  function toggle(open) {
    state.open = open; panel.hidden = !open; settings.setAttribute('aria-expanded', String(open));
    if (open) { findNotice(''); render(); }
    if (open && state.token && !state.player && !state.finding) void loadTargets();
  }
  const saved = GM_getValue(storageKey, null);
  if (saved?.token && Date.parse(saved.expiresAt) > Date.now()) {
    state.token = saved.token; state.expiresAt = saved.expiresAt;
  } else GM_deleteValue(storageKey);
  root.addEventListener('keydown', event => { if (event.key === 'Escape') toggle(false); });
  root.addEventListener('focusout', () => {
    setTimeout(() => {
      if (state.backgroundRenderPending && state.open && !editingControl()) render();
    }, 0);
  });
  document.addEventListener?.('visibilitychange', () => {
    updatePageNotice();
    if (pageVisible() && state.token && Date.parse(state.expiresAt) > Date.now() && !state.busy) {
      void loadTargets(false, false, Boolean(state.player));
    }
  });
  window.addEventListener?.('popstate', updatePageNotice);
  window.addEventListener?.('hashchange', updatePageNotice);
  if (typeof MutationObserver === 'function') {
    pageNoticeObserver = new MutationObserver(schedulePageNotice);
    pageNoticeObserver.observe(document.body, { childList: true, subtree: true });
  }
  // Expire the session and checked attack links even while the panel is idle.
  setInterval(() => {
    updatePageNotice();
    if (state.token && Date.parse(state.expiresAt) <= Date.now()) { clearSession(); message('Session expired. Sign in again.'); render(); }
    else if (state.open && state.player && !state.pendingChecks.size) {
      let expired = false;
      state.targets = state.targets.map(target => {
        if (target.checkedAt && !assessTarget(target).live) {
          expired = true; return { ...target, checkedAt: null };
        }
        return target;
      });
      if (expired) renderCards();
    }
    if (state.token && pageVisible() && !state.busy && !state.finding && !state.pendingChecks.size && !state.loading && !state.backgroundLoading
        && Date.now() - state.lastPoolAttemptAt >= FEED_REFRESH_MS) {
      void loadTargets(false, false, Boolean(state.player));
    }
  }, 5000);
  render();
  if (state.token && pageVisible()) void loadTargets();
}

})();
