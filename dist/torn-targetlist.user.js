// ==UserScript==
// @name         NWA Target Finder
// @namespace    torn-faction-targetlist
// @version      0.11.0
// @description  North West Alliance chain targets.
// @downloadURL  https://raw.githubusercontent.com/Grussniffer/nwa-targetlist-script/main/dist/torn-targetlist.user.js
// @updateURL    https://raw.githubusercontent.com/Grussniffer/nwa-targetlist-script/main/dist/torn-targetlist.meta.js
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
  const DEFAULT_ESTIMATE_DAYS = 7;
  const RECENT_TARGET_MS = 10 * 60 * 1000;
  const LIVE_STATUS_MAX_AGE = 30 * 1000;
  const compactFormatter = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 2 });

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
    return compactFormatter.format(value);
  }
  function ageLabel(timestamp, now = Date.now()) {
    if (!positive(timestamp)) return 'Date unknown';
    const seconds = Math.max(0, Math.floor(now / 1000 - timestamp));
    if (seconds < 60) return 'Just now';
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    return `${Math.floor(seconds / 86400)}d ago`;
  }

  function reason(target) {
    return (typeof target.reason === 'string' && target.reason.trim())
      || (typeof target.notes === 'string' && target.notes.trim()) || '';
  }
  function estimateSourceLabel(target) {
    const provider = typeof target?.estimateProvider === 'string' ? target.estimateProvider.trim() : '';
    const source = typeof target?.estimateSource === 'string' ? target.estimateSource.trim() : '';
    if (provider) return /^ffscouter$/i.test(provider) ? 'FFScouter' : provider;
    // Older feeds exposed the FFScouter method as their only source field.
    // Generic labels such as model, spy and manual do not establish a provider.
    return /^(?:bss|premium|spies|ffscouter(?::.*)?)$/i.test(source) ? 'FFScouter' : source;
  }
  function assess(target, player, maxRatio = DEFAULT_MAX_RATIO, now = Date.now(), minRatio = DEFAULT_MIN_RATIO, estimateDays = DEFAULT_ESTIMATE_DAYS) {
    const ratio = positive(target.estimatedStats) && positive(player.battleStats.total)
      ? target.estimatedStats / player.battleStats.total : null;
    const validRange = typeof minRatio === 'number' && Number.isFinite(minRatio) && minRatio >= 0 && minRatio <= 5 &&
      typeof maxRatio === 'number' && Number.isFinite(maxRatio) && maxRatio >= 0.01 && maxRatio <= 5 && minRatio <= maxRatio;
    const inRange = validRange && ratio !== null && ratio >= minRatio && ratio <= maxRatio;
    const stamp = target.estimateUpdatedAt;
    const validAge = Number.isSafeInteger(estimateDays) && estimateDays >= 1 && estimateDays <= 365;
    const fresh = validAge && positive(stamp) && stamp <= now / 1000 + 300 && now / 1000 - stamp <= estimateDays * 86400;
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
    else if (!fresh) { label = 'Estimate too old / undated'; tone = 'warn'; }
    else if (!validRange) { label = 'Invalid stat range'; tone = 'warn'; }
    else if (ratio < minRatio) { label = 'Below your minimum'; tone = 'warn'; }
    else if (ratio > maxRatio) { label = 'Above your limit'; tone = 'warn'; }
    const suggested = !allied && fresh && inRange;
    return { ratio, inRange, fresh, live, ready, timedUnavailable, suggested, allied, label, tone };
  }

  function select(targets, player, options, now = Date.now()) {
    const query = (options.query || '').trim().toLowerCase();
    return targets.map(target => ({ target, assessment: assess(target, player, options.maxRatio, now, options.minRatio, options.estimateDays) }))
      .filter(({ target, assessment }) => {
        if (options.mode === 'suggested' && !assessment.suggested) return false;
        return !query || `${target.id} ${target.name} ${target.faction?.name || ''} ${reason(target)}`.toLowerCase().includes(query);
      })
      .sort((a, b) => Number(b.assessment.suggested) - Number(a.assessment.suggested) ||
        (a.assessment.ratio ?? Infinity) - (b.assessment.ratio ?? Infinity) || a.target.id - b.target.id);
  }

  function recentTargets(values, now = Date.now()) {
    return (Array.isArray(values) ? values : []).filter(value => value && Number.isSafeInteger(value.id) && value.id > 0
      && Number.isFinite(value.at) && value.at <= now && now - value.at < RECENT_TARGET_MS).slice(-50);
  }
  function candidates(rows, recent = [], now = Date.now(), random = Math.random) {
    const visited = new Set(recentTargets(recent, now).map(value => value.id));
    const pool = rows.filter(row => !visited.has(row.target.id) && !row.target.reserved
      && (!row.assessment.live || row.assessment.ready) && !row.assessment.timedUnavailable);
    // Shuffle equal-priority targets so alliance members do not share one order.
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    return pool.sort((a, b) => Number(b.assessment.ready) - Number(a.assessment.ready)).map(row => row.target);
  }

  function applyPendingSuggestions(data, previous = null) {
    if (data === undefined) return { status: 'unsupported', revision: null, playerIds: [] };
    if (data?.unavailable === true) return { status: 'unavailable', revision: null, playerIds: [] };
    const invalid = () => { throw new Error('Pending suggestion status could not be checked.'); };
    if (!data || typeof data !== 'object' || !/^[a-f0-9]{64}$/.test(data.revision)) invalid();
    if (data.unchanged === true) {
      if (previous?.status !== 'ready' || previous.revision !== data.revision || data.playerIds !== undefined) invalid();
      return previous;
    }
    if (!Array.isArray(data.playerIds) || data.playerIds.length > 5000) invalid();
    let last = 0;
    for (const id of data.playerIds) {
      if (!Number.isSafeInteger(id) || id <= last || id > 2147483647) invalid();
      last = id;
    }
    return { status: 'ready', revision: data.revision, playerIds: data.playerIds };
  }

  function applyFeed(data, previousTargets = [], cursor = null) {
    const invalid = () => {
      const error = new Error('The target list update was incomplete. Refresh the list to try again.');
      error.code = 'FEED_SYNC_INVALID';
      throw error;
    };
    const validId = id => Number.isSafeInteger(id) && id > 0 && id <= 2147483647;
    const rows = values => {
      if (!Array.isArray(values)) invalid();
      const ids = new Set();
      for (const row of values) {
        if (!row || !validId(row.id) || ids.has(row.id)) invalid();
        ids.add(row.id);
      }
      return ids;
    };
    if (!data || typeof data !== 'object') invalid();
    // Older backends keep serving a complete snapshot until they are updated.
    if (data.sync === undefined) {
      rows(data.targets);
      return { targets: data.targets, cursor: null };
    }
    const sync = data.sync;
    if (!sync || sync.version !== 1 || typeof sync.cursor !== 'string' || !sync.cursor || sync.cursor.length > 256
        || typeof sync.reset !== 'boolean') invalid();
    if (sync.reset) {
      rows(data.targets);
      if (data.updates !== undefined || data.removed !== undefined) invalid();
      return { targets: data.targets, cursor: sync.cursor };
    }
    if (!cursor || data.targets !== undefined || !Array.isArray(data.removed)) invalid();
    const updatedIds = rows(data.updates);
    const removedIds = new Set();
    for (const id of data.removed) {
      if (!validId(id) || removedIds.has(id) || updatedIds.has(id)) invalid();
      removedIds.add(id);
    }
    if (!updatedIds.size && !removedIds.size) return { targets: previousTargets, cursor: sync.cursor };
    const next = new Map(previousTargets.map(target => [target.id, target]));
    for (const id of removedIds) next.delete(id);
    for (const target of data.updates) next.set(target.id, target);
    return { targets: [...next.values()], cursor: sync.cursor };
  }

  return { DEFAULT_MIN_RATIO, DEFAULT_MAX_RATIO, DEFAULT_ESTIMATE_DAYS, ESTIMATE_MAX_AGE, RECENT_TARGET_MS, LIVE_STATUS_MAX_AGE, serviceUrl, validKey, pageTargetId, reason, estimateSourceLabel, recentTargets, candidates, compact, ageLabel, assess, select, applyFeed, applyPendingSuggestions };
})();

const TargetListExport = (() => {
  const csvHeaders = ['ID', 'Name', 'Faction ID', 'Faction', 'Estimated stats', 'Estimate source',
    'Estimate updated at', 'Reason', 'Status', 'Status description', 'Status until', 'Checked at',
    'Last active', 'Reserved by another member', 'Reservation expires at', 'Profile URL', 'Attack URL'];
  const markdownHeaders = ['Player', 'Faction', 'Estimated stats', 'Estimate source', 'Estimate updated',
    'Reason', 'Status', 'Checked at', 'Last active', 'Attack'];

  function text(value) { return typeof value === 'string' ? value : ''; }
  function id(value) { return Number.isSafeInteger(value) && value > 0 && value <= 2147483647 ? value : ''; }
  function stat(value) { return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : ''; }
  function date(value) {
    if (!Number.isFinite(value)) return '';
    const parsed = new Date(value);
    return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : '';
  }
  function unixDate(value) { return typeof value === 'number' && value > 0 ? date(value * 1000) : ''; }
  function stringDate(value) { return typeof value === 'string' && value.trim() ? date(Date.parse(value)) : ''; }
  function record(target) {
    const value = target && typeof target === 'object' ? target : {};
    const playerId = id(value.id);
    const factionId = id(value.faction?.id);
    return [playerId, text(value.name), factionId, text(value.faction?.name), stat(value.estimatedStats),
      TargetListCore.estimateSourceLabel(value), unixDate(value.estimateUpdatedAt), text(value.reason).trim() || text(value.notes).trim(),
      text(value.status?.state), text(value.status?.description), unixDate(value.status?.until), stringDate(value.checkedAt),
      unixDate(value.lastAction), typeof value.reserved === 'boolean' ? String(value.reserved) : '',
      stringDate(value.reservationExpiresAt), playerId ? `https://www.torn.com/profiles.php?XID=${playerId}` : '',
      playerId ? `https://www.torn.com/page.php?sid=attack&user2ID=${playerId}` : ''];
  }
  function csvCell(value) {
    let safe = String(value);
    // Quotes alone do not prevent spreadsheets from evaluating a text cell.
    if (typeof value === 'string' && (/^[\s\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f]*[=+\-@]/u.test(safe)
        || /^[\t\r\n]/u.test(safe))) safe = `'${safe}`;
    return `"${safe.replace(/"/g, '""')}"`;
  }
  function markdown(value) {
    return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/[\\`*_{}\[\]()!#|~]/g, '\\$&').replace(/\r\n?|\n/g, '<br>');
  }
  function markdownRow(row) {
    const [playerId, name, factionId, faction, stats, source, updated, reason, status, description,
      until, checked, active, reserved, reservationExpires, profile, attack] = row;
    const playerLabel = `${markdown(name)}${playerId ? `${name ? ' ' : ''}\\[${playerId}\\]` : ''}`;
    const factionLabel = `${markdown(faction)}${factionId ? `${faction ? ' ' : ''}\\[${factionId}\\]` : ''}`;
    const statusLines = [status, description && description !== status ? description : '',
      until ? `Until: ${until}` : '', reserved ? `Reserved by another member: ${reserved}` : '',
      reservationExpires ? `Reservation expires: ${reservationExpires}` : ''].filter(Boolean).map(markdown);
    return [profile ? `[${playerLabel}](${profile})` : playerLabel,
      factionId ? `[${factionLabel}](https://www.torn.com/factions.php?step=profile&ID=${factionId})` : factionLabel,
      markdown(stats), markdown(source), markdown(updated), markdown(reason), statusLines.join('<br>'),
      markdown(checked), markdown(active), attack ? `[Attack](${attack})` : ''];
  }
  function serialize(format, targets, { now = Date.now() } = {}) {
    if (!['csv', 'markdown'].includes(format)) throw new Error('Choose CSV or Markdown for the target list export.');
    if (!Array.isArray(targets)) throw new TypeError('A target list is required to export.');
    const rows = targets.map(record);
    if (format === 'csv') return {
      text: `\ufeff${[csvHeaders, ...rows].map(row => row.map(csvCell).join(',')).join('\r\n')}\r\n`,
      mime: 'text/csv;charset=utf-8', extension: 'csv',
    };
    const table = [markdownHeaders, markdownHeaders.map(() => '---'), ...rows.map(markdownRow)]
      .map(row => `| ${row.join(' | ')} |`).join('\n');
    return {
      text: `# NWA target list\n\nExported at: ${date(now) || 'Unknown'}\n\nTargets: ${rows.length}\n\n${table}\n`,
      mime: 'text/markdown;charset=utf-8', extension: 'md',
    };
  }
  return { serialize };
})();

// Torn PDA's native bridge and per-script storage, with the existing
// Tampermonkey API kept synchronous. This adapter never stores a Torn API key.
const TargetListPlatform = (() => {
  function create(env = {}) {
    const native = env.pdaStorage;
    const isPda = Boolean(native || env.pdaGet || env.pdaPost || env.pdaDelete);
    const cache = new Map();
    const revisions = new Map();
    let tail = Promise.resolve();
    const missing = Symbol('missing');
    const storageError = () => new Error('NWA could not access saved data on this device. Check Torn PDA storage and try again.');
    function local() { try { return env.localStorage?.(); } catch { return null; } }
    function legacyGet(key, fallback) {
      if (typeof env.gmGet === 'function') return env.gmGet(key, fallback);
      const raw = local()?.getItem(key);
      if (raw == null) return fallback;
      try { return JSON.parse(raw); } catch { return fallback; }
    }
    function legacySet(key, value) {
      if (typeof env.gmSet === 'function') return env.gmSet(key, value);
      const store = local(); if (!store) throw storageError();
      store.setItem(key, JSON.stringify(value));
    }
    function legacyDelete(key) {
      if (typeof env.gmDelete === 'function') return env.gmDelete(key);
      const store = local(); if (!store) throw storageError();
      store.removeItem(key);
    }
    function enqueue(action) {
      const pending = tail.then(action).catch(() => { throw storageError(); });
      tail = pending.catch(() => {});
      return pending;
    }
    return {
      prepare(keys) {
        if (!native) return;
        const started = new Map(keys.map(key => [key, revisions.get(key) || 0]));
        return enqueue(async () => {
          await env.pdaReady;
          // getMany returns null for missing rows; loadAll distinguishes a
          // deliberate null from absence so cleared values are never migrated.
          const values = await native.loadAll();
          if (!values || typeof values !== 'object' || Array.isArray(values)) throw storageError();
          const prepared = new Map();
          for (const key of keys) {
            if (Object.prototype.hasOwnProperty.call(values, key)) prepared.set(key, values[key]);
            else {
              let value = missing;
              try { value = legacyGet(key, missing); } catch { /* Native storage remains usable without legacy storage. */ }
              if (value !== missing) {
                await native.set(key, value);
                prepared.set(key, value);
                try { legacyDelete(key); } catch { /* Migration is already durable. */ }
              }
            }
          }
          for (const key of keys) if ((revisions.get(key) || 0) === started.get(key)) {
            if (prepared.has(key)) cache.set(key, prepared.get(key)); else cache.delete(key);
          }
        });
      },
      getValue(key, fallback) { return native ? cache.has(key) ? cache.get(key) : fallback : legacyGet(key, fallback); },
      setValue(key, value) {
        if (!native) return legacySet(key, value);
        revisions.set(key, (revisions.get(key) || 0) + 1);
        cache.set(key, value);
        return enqueue(() => native.set(key, value));
      },
      deleteValue(key) {
        if (!native) return legacyDelete(key);
        revisions.set(key, (revisions.get(key) || 0) + 1);
        cache.delete(key);
        return enqueue(async () => {
          await native.delete(key);
          try { legacyDelete(key); } catch { /* Never restore a withdrawn legacy session. */ }
        });
      },
      xmlHttpRequest(options) {
        if (!isPda && typeof env.gmRequest === 'function') return env.gmRequest(options);
        const method = options.method.toUpperCase();
        const handler = { GET: 'PDA_httpGet', POST: 'PDA_httpPost', DELETE: 'PDA_httpDelete' }[method];
        const helper = { GET: env.pdaGet, POST: env.pdaPost, DELETE: env.pdaDelete }[method];
        let cancelled = false;
        Promise.resolve(env.pdaReady).then(async () => {
          if (cancelled) return;
          const bridge = env.pdaBridge?.();
          const args = [options.url, options.headers || {}];
          if (method === 'POST') args.push(options.data ?? '');
          // The public PDA helpers deduplicate requests and retain POST bodies
          // in page-level keys. Direct native calls avoid both behaviors.
          if (handler && typeof bridge?.callHandler === 'function') return bridge.callHandler(handler, ...args);
          if (typeof helper === 'function') return helper(...args);
          if (typeof env.gmRequest === 'function') {
            return new Promise((resolve, reject) => env.gmRequest({ ...options,
              onload: resolve, onerror: reject, ontimeout: reject, onabort: reject }));
          }
          throw new Error('Update Torn PDA to enable NWA requests.');
        }).then(response => {
          if (cancelled) return;
          if (!response || !Number.isInteger(Number(response.status)) || Number(response.status) < 100
              || Number(response.status) > 599 || typeof response.responseText !== 'string') throw new Error('Invalid PDA response.');
          // Native PDA does not report finalUrl. Preserve it only if provided.
          options.onload?.({ ...response, status: Number(response.status) });
        }).catch(error => { if (!cancelled) options.onerror?.(error); });
        return { abort() { if (!cancelled) { cancelled = true; options.onabort?.(); } } };
      }
    };
  }
  return { create };
})();

// Keep this service hostname and @connect in metadata.txt in sync when deploying elsewhere.
const CONFIG = Object.freeze({ serviceUrl: 'https://targetlist.grusmedia.no', version: '0.11.0' });

function startTargetList() {
  const platform = TargetListPlatform.create({
    gmGet: typeof GM_getValue === 'function' ? GM_getValue : undefined,
    gmSet: typeof GM_setValue === 'function' ? GM_setValue : undefined,
    gmDelete: typeof GM_deleteValue === 'function' ? GM_deleteValue : undefined,
    gmRequest: typeof GM_xmlhttpRequest === 'function' ? GM_xmlhttpRequest : undefined,
    pdaStorage: typeof PDA_storage !== 'undefined' ? PDA_storage : undefined,
    pdaGet: typeof PDA_httpGet === 'function' ? PDA_httpGet : window.PDA_httpGet,
    pdaPost: typeof PDA_httpPost === 'function' ? PDA_httpPost : window.PDA_httpPost,
    pdaDelete: typeof PDA_httpDelete === 'function' ? PDA_httpDelete : window.PDA_httpDelete,
    pdaReady: window.__PDA_platformReadyPromise, pdaBridge: () => window.flutter_inappwebview,
    localStorage: () => window.localStorage
  });
  function mount(storageWarning = '') {
    const previousHost = document.getElementById('torn-targetlist-host');
    const mountedVersion = previousHost?.getAttribute('data-nwa-version') || '';
    if (previousHost && /^\d+\.\d+\.\d+$/.test(mountedVersion)
        && mountedVersion.localeCompare(CONFIG.version, undefined, { numeric: true }) >= 0) return;
    previousHost?.__nwaDispose?.();
    if (previousHost && typeof Event === 'function') previousHost.dispatchEvent?.(new Event('nwa:dispose'));
    previousHost?.remove(); mountTargetList(platform, storageWarning);
  }
  const base = TargetListCore.serviceUrl(CONFIG.serviceUrl);
  const ready = platform.prepare([`targetlist.session.${base}`, `targetlist.preferences.${base}`]);
  if (ready?.then) ready.then(() => mount()).catch(error => mount(error.message)); else mount();
}
// PDA can inject at page start regardless of @run-at. Mount only in the main
// document, once its body is available, and retain version deduplication.
if (!window.top || window.top === window.self) {
  if (document.body) startTargetList();
  else document.addEventListener('DOMContentLoaded', startTargetList, { once: true });
}

function mountTargetList(platform, storageWarning = '') {
  const C = TargetListCore;
  const FEED_REFRESH_MS = 10_000;
  const IDLE_FEED_REFRESH_MS = 30_000;
  const CARD_BATCH_SIZE = 50;
  const DEFINITE_SELECTION_FAILURES = new Set(['TORN_UNAVAILABLE', 'FACTIONS_UNAVAILABLE', 'TARGETS_UNAVAILABLE',
    'TARGETS_SCHEMA_MISMATCH', 'TARGETS_LIMIT_EXCEEDED', 'FACTIONS_NOT_CONFIGURED', 'SESSION_STORAGE_UNAVAILABLE',
    'KEY_STORAGE_UNAVAILABLE', 'KEY_REMOVAL_PENDING', 'SESSION_CAPACITY', 'CAPACITY_LIMIT', 'SERVICE_CLOSED']);
  let disposed = false;
  const lifecycleListeners = [], taskTimers = new Set(), pendingRequests = new Set();
  const downloadUrls = new Set();
  function listen(node, type, callback, options) {
    node?.addEventListener?.(type, callback, options);
    lifecycleListeners.push(() => node?.removeEventListener?.(type, callback, options));
  }
  function later(callback, delay) {
    const id = setTimeout(() => { taskTimers.delete(id); if (!disposed) callback(); }, delay);
    taskTimers.add(id); return id;
  }
  function cancelLater(id) { clearTimeout(id); taskTimers.delete(id); }
  const COORDINATION_UNAVAILABLE = 'Target coordination is unavailable. Refresh the list or ask an administrator to update the backend.';
  let base;
  try { base = C.serviceUrl(CONFIG.serviceUrl); }
  catch (error) { console.error('[NWA] Invalid service address:', error.message); return; }
  const storageKey = `targetlist.session.${base}`;
  const preferencesKey = `targetlist.preferences.${base}`;
  const preferences = platform.getValue(preferencesKey, null);
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
    token: null, expiresAt: null, player: null, targets: [], feedTargets: [], feedCursor: null, warnings: [], generatedAt: null, poolLoadedAt: 0,
    authorizedPool: false, backgroundLoading: false, targetLoad: null, lastPoolAttemptAt: 0, backgroundRenderPending: false,
    busy: false, removingKey: false, open: false, generation: 0, error: '', query: '', mode: 'all',
    minRatio, maxRatio,
    estimateDays: Number.isSafeInteger(preferences?.estimateDays) && preferences.estimateDays >= 1 && preferences.estimateDays <= 365
      ? preferences.estimateDays : C.DEFAULT_ESTIMATE_DAYS,
    recentTargets: C.recentTargets(preferences?.recentTargets), reservationsSupported: false, nextTargetSupported: null,
    backendNotice: '', retryAttempt: null, lastFindAt: 0, feedFailures: 0, nextFeedAt: 0, hardRetryAt: 0,
    lastTargetId: Number.isSafeInteger(preferences?.lastTargetId) ? preferences.lastTargetId : null,
    finding: false, findGeneration: 0, findAfterLogin: false,
    pendingChecks: new Set(), loading: false, targetGeneration: 0, view: 'targets',
    suggestionView: 'pending', suggestions: [], nextSuggestionOffset: null, canReview: false,
    suggestionsLoading: false, suggestionGeneration: 0, suggestionMutation: null, suggestionNotice: '',
    pendingSuggestions: { status: 'unsupported', revision: null, playerIds: [] }, pendingPlayerIds: new Set(), pendingSuggestionEpoch: 0,
    suggestionDraft: { type: 'player', targetId: '', comment: '' }
  };
  let exportSnapshot = null, exportView = null;
  const css = document.createElement('style');
  css.textContent = `
    :host{all:initial;font-family:system-ui,-apple-system,Segoe UI,sans-serif;color:#e5e9e6;font-size:13px;line-height:1.45;
      --surface:#1b1d20;--raised:#23262a;--field:#17191c;--line:#353b37;--text:#e5e9e6;--muted:#a1aaa5;--accent:#8ad2ab}
    *{box-sizing:border-box} button,input,select,textarea{font:inherit}button,a,input,select,textarea{outline-offset:3px}
    button{cursor:pointer;border:1px solid var(--line);border-radius:7px;padding:7px 10px;background:var(--raised);color:var(--text)}
    button:hover:not(:disabled){background:#303731}button:disabled{cursor:default;opacity:.55}
    :focus-visible{outline:2px solid var(--accent);outline-offset:3px}
    a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}p{margin:0 0 12px}h2,h3{margin:0}
    input,select,textarea{color:var(--text);background:var(--field);border:1px solid var(--line);border-radius:7px;padding:8px 10px;min-width:0}
    input:focus,select:focus,textarea:focus{border-color:var(--accent)}label{display:block}small,.muted{color:var(--muted);font-size:11px}
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
    .panel{position:absolute;top:calc(var(--nwa-viewport-top,0px) + 12px);right:56px;width:min(736px,calc(100vw - 72px));max-height:calc(100vh - 24px);max-height:calc(var(--nwa-viewport-height,100dvh) - 24px);
      pointer-events:auto;background:var(--surface);border:1px solid var(--line);
      border-radius:12px;box-shadow:0 16px 60px #0007;display:flex;flex-direction:column;overflow:hidden}
    [hidden]{display:none!important}.header{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 16px;border-bottom:1px solid var(--line);flex-shrink:0}
    .brand{display:flex;align-items:center;gap:10px}.brand-mark{display:grid;place-items:center;width:40px;height:36px;border-radius:8px;background:#293e31;color:var(--accent);font-size:12px;font-weight:800;letter-spacing:.6px}
    .eyebrow{font-size:11px;color:var(--muted)}
    h2{font-size:16px;line-height:1.4;font-weight:700}.icon{width:32px;height:32px;padding:0;background:transparent;font-size:22px}
    .header-actions{display:flex;gap:6px;align-items:center}.more-options{font-size:18px}
    .scroll{overflow:auto;min-height:0;padding:14px 16px;overscroll-behavior:contain;scrollbar-gutter:stable}.login{display:grid;gap:13px}.login input{width:100%;margin-top:5px}
    .primary,.actions .attack{background:#85cfa6;color:#162b1e;font-weight:700;border-color:transparent}.primary:hover:not(:disabled),.actions .attack:hover:not(:disabled){background:#9cdeb9}
    .notice{font-size:12px;line-height:1.6;color:var(--muted)}.error{background:#402a2e;color:#ffd6d8;padding:10px 12px;border:1px solid #6a3c43;border-radius:7px;margin-bottom:12px;overflow-wrap:anywhere}
    .finder-status{padding:8px 10px;margin-bottom:12px;border-left:2px solid var(--accent);background:#26342b;color:#c4e8d1;font-size:12px;overflow-wrap:anywhere}
    .profile{display:flex;justify-content:space-between;align-items:center;gap:10px;min-width:0}.profile strong{font-size:12px}.profile>div{min-width:0;overflow-wrap:anywhere}.profile .player-total{text-align:right;max-width:45%;font-size:11px;color:var(--muted)}
    .statgrid{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin:12px 0}.stat{background:var(--field);padding:8px;border-radius:6px}
    .stat strong{display:block;color:var(--text);font-size:13px}.toolbar{display:grid;grid-template-columns:minmax(0,1fr) 120px;gap:8px;margin:12px 0 10px}
    .controls{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.controls label{display:flex;align-items:center;gap:5px}.controls input{width:68px;padding:5px 7px}.controls button{margin-left:auto}
    .filters{font-size:12px}.filter-label{color:var(--muted)}.filters select{margin-left:auto;padding:6px;max-width:160px;font-size:12px}
    .stat-range-summary{font-size:11px;color:var(--muted);margin-top:8px;overflow-wrap:anywhere}
    .exports,.export-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:12px}
    .exports label{display:flex;align-items:center;gap:6px}.exports select{padding:6px 8px}
    .export-preview{margin-top:12px;padding:12px;background:var(--field);border:1px solid var(--line);border-radius:7px}
    .export-preview textarea{display:block;width:100%;height:180px;margin-top:8px;resize:vertical;font-family:monospace;font-size:12px;white-space:pre}
    .export-preview .notice{margin-top:8px}.export-preview .export-status{margin-top:8px;color:var(--accent);font-size:12px}
    .count{display:flex;justify-content:space-between;align-items:flex-start;gap:10px;margin:12px 0 4px;font-size:11px;color:var(--muted)}.count>button{padding:4px 7px;font-size:11px;background:transparent}
    summary{cursor:pointer;outline-offset:3px}.pool-details{min-width:0;flex:1}.pool-details summary{padding:5px 0;color:var(--text);font-weight:600}.count-detail{padding:6px 0 10px;line-height:1.7;font-weight:400;color:var(--muted)}
    .cards{display:grid;gap:0}.card{border-bottom:1px solid var(--line);padding:13px 0;min-width:0}
    .cards:not(.suggestionqueue)>.card{display:grid;grid-template-columns:minmax(0,1.4fr) minmax(0,.9fr) minmax(0,1fr) 90px;gap:6px 12px;align-items:start}
    .cardhead{display:flex;justify-content:space-between;gap:10px;align-items:flex-start;min-width:0}.name{font-weight:650;font-size:13px;color:var(--text);overflow-wrap:anywhere}.cardhead .muted{margin-top:3px;overflow-wrap:anywhere}
    .badge{display:inline-block;font-size:10px;font-weight:650;padding:2px 6px;border-radius:4px;white-space:normal;background:#293e31;color:#a6dcbb}
    .badge.warn{background:#433b28;color:#efd49a}.badge.muted{background:#303437;color:#bec6c0}
    .metrics{display:contents}.metrics strong{display:block;font-size:13px;font-weight:650;font-variant-numeric:tabular-nums}.metrics small{display:block;margin-top:2px;font-size:10px;overflow-wrap:anywhere}.availability{min-width:0}.availability strong{font-size:12px;margin-bottom:3px}
    .actions{display:flex;align-items:center;gap:8px;margin-top:10px;min-width:0}.cards:not(.suggestionqueue)>.card>.actions{grid-column:4;grid-row:1/3;flex-direction:column;align-items:stretch;margin:0;gap:5px}
    .actions button{font-size:11px;padding:5px 7px}.actions .attack{border-radius:6px}.actions small{font-size:10px;overflow-wrap:anywhere}.actions .check-status{background:transparent;border-color:transparent;color:var(--muted);order:2;padding:3px 0}
    .notes{grid-column:1/4;font-size:11px;color:var(--muted);overflow-wrap:anywhere;line-height:1.5}.empty{padding:24px 14px;text-align:center;background:var(--field);border:1px dashed var(--line);border-radius:7px;color:var(--muted);font-size:12px;margin:10px 0}
    .preferences{border-top:1px solid var(--line);margin-top:14px;padding-top:4px}.preferences>summary{padding:10px 0;font-size:12px;color:var(--muted)}.preferences-body{padding:4px 0 2px}.preferences h3{font-size:12px;font-weight:650;margin:10px 0 6px}.account{display:flex;align-items:center;justify-content:space-between;gap:10px;border-top:1px solid var(--line);padding-top:12px;margin-top:14px}.account button{font-size:11px}.account .muted{font-size:10px}
    .footnote{margin-top:14px;font-size:11px;color:var(--muted)}.pool-footer{display:flex;justify-content:space-between;gap:8px;margin-top:10px;font-size:10px;color:var(--muted)}.pool-warnings{color:#efd49a;font-size:11px;overflow-wrap:anywhere}.pool-warnings p{margin:8px 0}
    .tabs{display:flex;gap:18px;flex-wrap:wrap;margin:10px 0 0;border-bottom:1px solid var(--line)}.tabs button{border:0;border-bottom:2px solid transparent;border-radius:0;padding:7px 0;background:transparent;color:var(--muted);font-size:12px}.tabs button[aria-pressed=true]{border-bottom-color:var(--accent);color:var(--text)}
    .suggestionform{display:grid;gap:12px;margin:14px 0 20px}.suggestionfields{display:grid;grid-template-columns:140px 1fr;gap:10px}
    .suggestionform input,.suggestionform select,.suggestionform textarea{display:block;width:100%;margin-top:5px}.suggestionform textarea{resize:vertical;min-height:84px}
    .success{background:#293e31;color:#c4e8d1;padding:10px 12px;border-radius:7px;margin:12px 0;font-size:12px}
    .comment{white-space:pre-wrap;overflow-wrap:anywhere;margin:12px 0;font-size:12px;color:var(--text)}.queueheader{display:flex;align-items:center;justify-content:space-between;gap:10px}
    .queueheader h3{font-size:16px}.queuefooter{margin-top:12px}.suggestioncard .actions button{padding:6px 10px}.suggestioncard .name{overflow-wrap:anywhere}
    @media(pointer:coarse){input,select,textarea,.export-preview textarea,.filters select{font-size:16px} .panel button,.panel summary{min-height:44px}.controls input{min-height:44px}}
    @media(max-width:600px){.panel{top:calc(var(--nwa-viewport-top,0px) + 8px);left:8px;right:8px;width:auto;max-height:calc(100vh - 16px);max-height:calc(var(--nwa-viewport-height,100dvh) - 16px)}
      .panel:not([hidden])~.dock{visibility:hidden}.scroll{padding:12px;scrollbar-gutter:auto}.header{padding:10px 12px}.profile .player-total{max-width:40%}.statgrid{grid-template-columns:repeat(2,1fr)}
      .toolbar{grid-template-columns:minmax(0,1fr) 110px}.filters{gap:6px}.filters input{width:58px}.filter-label{display:none}.filters select{max-width:100%;margin-left:0;flex:1;min-width:120px}.stat-range-summary{line-height:1.5}
      .cards:not(.suggestionqueue)>.card{grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:8px 12px;padding:14px 0}.cardhead{grid-column:1}.estimate{text-align:right}.availability{grid-column:1;grid-row:2}.cards:not(.suggestionqueue)>.card>.actions{grid-column:2;grid-row:2;flex-direction:row;flex-wrap:wrap;justify-content:flex-end;align-items:center}.actions .attack{order:2}.actions .check-status{order:1;padding:5px 6px}.notes{grid-column:1/-1;grid-row:3}.actions small{width:100%;text-align:right}.pool-footer{flex-wrap:wrap}.suggestionfields{grid-template-columns:1fr}.account{flex-wrap:wrap}}
    @media(max-width:360px){.filters select{flex-basis:100%}.profile .player-total{max-width:38%}.cards:not(.suggestionqueue)>.card>.actions{gap:2px}.actions button{padding:5px}.name{font-size:12px}}
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
  function focusKey(node, key) { node.setAttribute('data-focus-key', key); return node; }
  function inside(node, container) {
    for (; node; node = node.parentNode) if (node === container) return true;
    return false;
  }
  function captureFocus(container) {
    const node = root.activeElement;
    if (!inside(node, container)) return null;
    return { node, key: node.getAttribute?.('data-focus-key'), scrollTop: scroll.scrollTop,
      start: node.selectionStart, end: node.selectionEnd, direction: node.selectionDirection };
  }
  function restoreFocus(snapshot, container = content, fallback = panelHeading) {
    if (!snapshot || !state.open || disposed) return;
    const active = root.activeElement;
    // A synchronous render can remove the active node, but must never redirect
    // focus that has already moved to another live control.
    if (active && inside(active, root) && active !== snapshot.node) return;
    if (active === snapshot.node && inside(snapshot.node, root) && !snapshot.node.disabled) return;
    const replacement = snapshot.key && [...container.querySelectorAll('[data-focus-key]')]
      .find(node => node.getAttribute('data-focus-key') === snapshot.key && !node.disabled);
    const next = replacement || (typeof fallback === 'function' ? fallback() : fallback) || panelHeading;
    next.focus?.({ preventScroll: true });
    if (replacement && Number.isInteger(snapshot.start)) {
      try { replacement.setSelectionRange?.(snapshot.start, snapshot.end, snapshot.direction); } catch { /* Not all inputs support a caret. */ }
    }
    if (Number.isFinite(snapshot.scrollTop)) scroll.scrollTop = snapshot.scrollTop;
  }
  const panel = element('section', null, 'panel'); panel.hidden = true;
  panel.id = 'nwa-panel'; panel.setAttribute('aria-label', 'North West Alliance target finder');
  const header = element('div', null, 'header');
  const title = element('div', null, 'brand');
  const panelHeading = element('h2', 'Target finder'); panelHeading.tabIndex = -1;
  const brandText = element('div'); brandText.append(panelHeading, element('div', 'North West Alliance', 'eyebrow'));
  title.append(element('span', 'NWA', 'brand-mark'), brandText);
  const headerActions = element('div', null, 'header-actions');
  const moreOptions = button('⋯', () => {
    if (!panelUi?.preferences) return;
    preferencesOpen = true; panelUi.preferences.open = true;
    panelUi.preferences.scrollIntoView?.({ block: 'nearest' });
    panelUi.preferencesSummary.focus?.();
  }, 'icon more-options');
  moreOptions.setAttribute('aria-label', 'Open preferences and account'); moreOptions.title = 'Preferences, exports & account'; moreOptions.hidden = true;
  const closePanel = button('×', () => toggle(false), 'icon'); closePanel.setAttribute('aria-label', 'Close NWA settings');
  headerActions.append(moreOptions, closePanel); header.append(title, headerActions);
  const scroll = element('div', null, 'scroll');
  const errorBox = element('div', null, 'error'); errorBox.setAttribute('role', 'alert'); errorBox.hidden = true;
  const finderStatus = element('div', null, 'finder-status'); finderStatus.setAttribute('role', 'status'); finderStatus.hidden = true;
  const content = element('div'); scroll.append(errorBox, finderStatus, content); panel.append(header, scroll);
  const dock = element('div', null, 'dock');
  const launcher = button('NWA', () => void findTarget(), 'launcher');
  launcher.setAttribute('aria-label', 'NWA — find a target'); launcher.title = 'North West Alliance — find a target';
  const settings = button('', () => { state.findAfterLogin = false; cancelFind(); toggle(!state.open, settings); }, 'settings-toggle');
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
  let panelOpener = settings;

  function message(text) { state.error = text; errorBox.textContent = text; errorBox.hidden = !text; }
  function findNotice(text) {
    quickNotice.textContent = text; quickNotice.hidden = !text || state.open;
    finderStatus.textContent = text; finderStatus.hidden = !text || !state.open;
  }
  function updateLauncher() {
    launcher.disabled = state.finding || state.busy;
    launcher.setAttribute('aria-busy', String(state.finding));
    if (panelUi?.find) {
      panelUi.find.disabled = state.finding || state.busy || state.removingKey;
      panelUi.find.setAttribute('aria-busy', String(state.finding));
      setText(panelUi.find, state.finding ? 'Finding…' : 'Find target');
    }
  }
  function cancelFind() { state.findGeneration++; state.finding = false; findNotice(''); updateLauncher(); }
  function persist(operation) {
    try { operation()?.catch?.(error => { message(error.message); render(); }); }
    catch (error) { message(error.message); }
  }
  function savePreferences() { persist(() => platform.setValue(preferencesKey, { minRatio: state.minRatio, maxRatio: state.maxRatio,
    estimateDays: state.estimateDays, lastTargetId: state.lastTargetId, recentTargets: C.recentTargets(state.recentTargets) })); }
  function assessTarget(target) { return C.assess(target, state.player, state.maxRatio, Date.now(), state.minRatio, state.estimateDays); }
  function rememberTarget(id) {
    state.lastTargetId = id;
    state.recentTargets = C.recentTargets([...state.recentTargets.filter(value => value.id !== id), { id, at: Date.now() }]);
    savePreferences();
  }
  function saveSession() {
    return platform.setValue(storageKey, { token: state.token, expiresAt: state.expiresAt });
  }
  function clearSession() {
    const clearedToken = state.token;
    pageSuggestedIds.clear(); pageSuggestion = { id: null, comment: '', message: '' };
    state.pendingSuggestionEpoch++; state.pendingSuggestions = { status: 'unsupported', revision: null, playerIds: [] }; state.pendingPlayerIds.clear();
    cancelFind(); state.findAfterLogin = false;
    clearExport();
    state.generation++; state.token = null; state.player = null; state.targets = []; state.warnings = []; state.poolLoadedAt = 0;
    state.feedTargets = []; state.feedCursor = null; state.reservationsSupported = false; state.nextTargetSupported = null;
    state.retryAttempt = null; state.backendNotice = ''; state.feedFailures = 0; state.nextFeedAt = 0; state.hardRetryAt = 0;
    state.authorizedPool = false; state.backgroundLoading = false; state.targetLoad = null; state.lastPoolAttemptAt = 0;
    state.backgroundRenderPending = false;
    state.pendingChecks.clear(); state.busy = false; state.loading = false; state.targetGeneration++; state.expiresAt = null;
    state.removingKey = false;
    state.view = 'targets'; state.suggestionView = 'pending'; state.suggestions = []; state.nextSuggestionOffset = null;
    state.canReview = false; state.suggestionsLoading = false; state.suggestionGeneration++;
    state.suggestionMutation = null; state.suggestionNotice = ''; state.suggestionDraft = { type: 'player', targetId: '', comment: '' };
    persist(() => {
      // GM storage is shared between Torn tabs. This tab can clear only its
      // own token, never a newer login written by another tab.
      if (platform.getValue(storageKey, null)?.token === clearedToken) return platform.deleteValue(storageKey);
    });
    updatePageNotice();
  }
  function restoreNewerSession() {
    let saved;
    try { saved = platform.getValue(storageKey, null); } catch { return false; }
    if (!saved || typeof saved.token !== 'string' || !saved.token || saved.token === state.token
      || !(Date.parse(saved.expiresAt) > Date.now())) return false;
    clearSession();
    state.token = saved.token; state.expiresAt = saved.expiresAt;
    // Restore through the backend before showing protected data or allowing a hit.
    void loadTargets();
    return true;
  }
  function handleError(error) {
    if (error.code === 'REVIEW_NOT_ALLOWED') state.canReview = false;
    const authStatus = error.status === 401 || error.status === 403;
    const confirmed = ['SESSION_REQUIRED', 'SESSION_EXPIRED', 'FACTION_NOT_ALLOWED', 'FACTION_CHANGED',
      'KEY_REJECTED', 'LIMITED_KEY_REQUIRED', 'KEY_PERMISSIONS_REQUIRED', 'INVALID_KEY', 'KEY_ACCESS',
      'SESSION_REVOKED', 'KEY_REVOKED', 'INVALID_SESSION'].includes(error.code);
    if (authStatus && confirmed) {
      if (restoreNewerSession()) return;
      clearSession(); toggle(true); render();
    } else if (authStatus && !['FRIENDLY_TARGET', 'TARGET_NOT_FOUND', 'TARGET_LEFT_FACTION', 'REVIEW_NOT_ALLOWED'].includes(error.code)) {
      // An ambiguous proxy/service denial cannot prove that the saved token
      // expired. Hide protected data but keep the credential for a later retry.
      state.authorizedPool = false; state.targets = []; clearExport(); updatePageNotice(); render();
    }
    message(error.message || 'The request failed. Try again shortly.');
  }
  function request(method, path, body, token = state.token, timeoutMs = 20000) {
    return new Promise((resolve, reject) => {
      let settled = false, transport = null;
      const succeed = value => { if (!settled) { settled = true; cancelLater(deadline); pendingRequests.delete(cancel); resolve(value); } };
      const fail = error => {
        if (!settled) {
          settled = true; cancelLater(deadline); pendingRequests.delete(cancel);
          try { transport?.abort?.(); } catch { /* The original failure still settles the request. */ }
          reject(error);
        }
      };
      const cancel = () => fail(new Error('The request was cancelled.'));
      const deadline = later(() => fail(new Error('The target service timed out. Try again shortly.')), timeoutMs);
      pendingRequests.add(cancel);
      if (disposed) { cancel(); return; }
      const headers = { Accept: 'application/json' };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      if (token) headers.Authorization = `Bearer ${token}`;
      try { transport = platform.xmlHttpRequest({
        method, url: `${base}${path}`, headers, anonymous: true, redirect: 'error', timeout: timeoutMs,
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
            error.status = response.status; error.code = data?.error?.code;
            const header = response.responseHeaders?.match(/^retry-after:\s*(.+)$/im)?.[1]?.trim();
            const headerDelay = header && /^\d+$/.test(header) ? Number(header) : Math.max(0, (Date.parse(header) - Date.now()) / 1000);
            error.retryAfterSeconds = Number.isFinite(Number(delay)) && Number(delay) >= 0 ? Number(delay)
              : Number.isFinite(headerDelay) ? headerDelay : 0;
            if (error.retryAfterSeconds > 0) state.hardRetryAt = Math.max(state.hardRetryAt, Date.now() + error.retryAfterSeconds * 1000);
            fail(error); return;
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
      state.feedTargets = []; state.feedCursor = null;
      const saving = saveSession(); if (saving?.then) await saving;
      if (generation !== state.generation) return;
      await loadTargets();
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
  function canExport() {
    return Boolean(state.token && state.player && Date.parse(state.expiresAt) > Date.now()
      && authorizedPoolFresh() && !state.loading && !state.busy && !state.removingKey);
  }
  function updateExportControls() {
    if (panelUi?.exportButtons) for (const control of panelUi.exportButtons) control.disabled = !canExport();
  }
  function clearExport() {
    if (exportView) { exportView.textarea.value = ''; exportView.node.remove(); }
    exportSnapshot = null; exportView = null;
  }
  function exportAccess() {
    if (canExport()) return true;
    clearExport(); message('Refresh the target list before exporting.'); updateExportControls(); return false;
  }
  async function copyExport() {
    if (!exportAccess() || !exportSnapshot || !exportView) return;
    const snapshot = exportSnapshot, view = exportView, generation = state.generation;
    let copied = false;
    try {
      if (typeof navigator !== 'undefined' && typeof navigator.clipboard?.writeText === 'function') {
        await navigator.clipboard.writeText(snapshot.text); copied = true;
      }
    } catch { /* Older WebViews can still copy selected text. */ }
    if (generation !== state.generation || snapshot !== exportSnapshot || view !== exportView) return;
    if (!exportAccess()) return;
    if (!copied) {
      view.textarea.focus?.(); view.textarea.select?.();
      try { copied = document.execCommand?.('copy') === true; } catch { /* Keep the selected text for manual copying. */ }
    }
    view.status.textContent = copied ? 'Export copied.' : 'Select and copy the export text on this device.';
  }
  function downloadExport() {
    if (!exportAccess() || !exportSnapshot || !exportView) return;
    let url = null, anchor = null;
    try {
      url = URL.createObjectURL(new Blob([exportSnapshot.text], { type: exportSnapshot.mime }));
      anchor = element('a'); anchor.href = url; anchor.download = exportSnapshot.filename; anchor.hidden = true;
      root.append(anchor); anchor.click();
      exportView.status.textContent = 'Download requested. If no file appears, use Copy export.';
    } catch {
      exportView.status.textContent = 'File downloads are unavailable here. Use Copy export or select the text.';
    } finally {
      anchor?.remove();
      if (url) {
        downloadUrls.add(url);
        later(() => { downloadUrls.delete(url); try { URL.revokeObjectURL(url); } catch { /* The WebView may already have released it. */ } }, 30000);
      }
    }
  }
  function showExport(format) {
    if (!exportAccess()) return;
    const now = Date.now(), shown = panelUi.exportScope.value === 'shown';
    const targets = shown ? C.select(state.targets, state.player, state, now).map(row => row.target) : state.targets;
    let serialized;
    try { serialized = TargetListExport.serialize(format, targets, { now }); }
    catch { message('The target list could not be exported. Try again.'); return; }
    exportSnapshot = { ...serialized, filename: `nwa-targetlist-${new Date(now).toISOString().slice(0, 10)}.${serialized.extension}` };
    if (!exportView) {
      const node = element('section', null, 'export-preview'); node.setAttribute('aria-label', 'Target list export');
      const label = element('strong');
      const textarea = element('textarea'); textarea.readOnly = true; textarea.spellcheck = false;
      textarea.setAttribute('aria-label', 'Exported target list');
      const actions = element('div', null, 'export-actions');
      actions.append(button('Copy export', () => void copyExport()), button('Download export', downloadExport), button('Close export', clearExport));
      const status = element('div', '', 'export-status'); status.setAttribute('role', 'status');
      node.append(label, element('div', '', 'muted'), textarea, actions,
        element('div', 'This is a snapshot. In Torn PDA, use Copy export if file downloads are unavailable.', 'notice'), status);
      exportView = { node, label, detail: node.children[1], textarea, status };
      panelUi.exportHost.append(node);
    }
    exportView.label.textContent = exportSnapshot.filename;
    exportView.detail.textContent = `${targets.length} ${shown ? 'shown' : 'total'} targets · ${new Date(now).toISOString()}`;
    exportView.textarea.value = exportSnapshot.text; exportView.status.textContent = ''; message('');
  }
  let pageNotice = null, pageNoticeReason = null, pageNoticeFullReason = null, pageNoticeSummary = null;
  let pageNoticeEstimate = null, pageNoticeEstimateDetail = null, pageNoticeDetail = null, pageNoticeDetails = null;
  let pageNoticeObserver = null, pageNoticeTimer = null, pageNoticeAnchor = null, pageNoticeResizeObserver = null;
  let pageNoticeObservedArea = null, pageNoticeMode = null;
  let pageNoticeForm = null, pageNoticeComment = null, pageNoticeSubmit = null, pageNoticeFeedback = null, pageNoticeTitle = null, pageNoticeQuickHeading = null;
  let pageSuggestion = { id: null, comment: '', message: '' };
  const pageSuggestedIds = new Set();
  function pageSuggestionMessage(text, id) {
    if (id !== pageSuggestion.id || C.pageTargetId(window.location?.href) !== id) return;
    pageSuggestion.message = text; updatePageNotice();
  }
  function observeNoticeArea(id) {
    if (typeof MutationObserver !== 'function') return;
    const area = id && pageVisible() ? pageNoticeAnchor?.parentElement
      || document.querySelector?.('#content-wrapper, #mainContainer, main, .content-wrapper, [role="main"]') || document.body : null;
    if (area === pageNoticeObservedArea) return;
    pageNoticeObserver?.disconnect(); pageNoticeObservedArea = area;
    if (!area) return;
    pageNoticeObserver ||= new MutationObserver(schedulePageNotice);
    pageNoticeObserver.observe(area, { childList: true, characterData: true, subtree: true });
    // Direct child changes on ancestors catch React replacing the observed area,
    // without watching unrelated text or subtree mutations across all of Torn.
    for (let ancestor = area.parentElement; ancestor; ancestor = ancestor.parentElement) {
      pageNoticeObserver.observe(ancestor, { childList: true });
    }
  }
  function removePageNotice() {
    pageNotice?.remove(); pageNoticeResizeObserver?.disconnect(); pageNoticeAnchor = null;
    pageNoticeMode = null; pageNoticeForm = null; pageNoticeComment = null; pageNoticeSubmit = null; pageNoticeFeedback = null; pageNoticeTitle = null; pageNoticeQuickHeading = null;
    pageNotice = null; pageNoticeReason = null; pageNoticeFullReason = null; pageNoticeSummary = null;
    pageNoticeEstimate = null; pageNoticeEstimateDetail = null; pageNoticeDetail = null; pageNoticeDetails = null;
  }
  function firstTextLine(anchor) {
    const rect = anchor.getBoundingClientRect?.();
    if (!rect || rect.width <= 0 || rect.height <= 0) return null;
    // Text ranges measure the occupied part of a block, including FFScouter's
    // display:contents React mount, without counting its optional second row.
    if (!document.createTreeWalker || !document.createRange) return rect;
    const walker = document.createTreeWalker(anchor, 4); // NodeFilter.SHOW_TEXT
    const range = document.createRange();
    let line = null, node;
    const inlineBoxes = new Set();
    while ((node = walker.nextNode())) {
      if (!node.textContent.trim()) continue;
      for (let parent = node.parentElement; parent && parent !== anchor; parent = parent.parentElement) {
        if (['inline', 'inline-block', 'inline-flex'].includes(window.getComputedStyle?.(parent).display)) inlineBoxes.add(parent);
      }
      range.selectNodeContents(node);
      for (const part of range.getClientRects()) {
        if (part.width <= 0 || part.height <= 0) continue;
        if (!line || part.top < line.top - part.height / 2) {
          line = { left: part.left, right: part.right, top: part.top, bottom: part.bottom, height: part.height };
        } else if (Math.abs(part.top - line.top) < Math.min(part.height, line.height) / 2) {
          line.right = Math.max(line.right, part.right); line.bottom = Math.max(line.bottom, part.bottom);
          line.height = line.bottom - line.top;
        }
      }
    }
    if (line) {
      // The FF badge's padding and trailing source SVG occupy space too, even
      // when the following stats text has wrapped onto a second line.
      for (const box of [...inlineBoxes, ...(anchor.querySelectorAll?.('svg, img, canvas, video, button, input, select') || [])]) {
        for (const part of box.getClientRects()) {
          if (part.width > 0 && part.height > 0 && part.height <= line.height + 12
              && part.top < line.bottom && part.bottom > line.top) line.right = Math.max(line.right, part.right);
        }
      }
    }
    return line;
  }
  function pageNoticePlacement(id) {
    const viewport = window.visualViewport;
    const left = Math.max(0, viewport?.offsetLeft || 0);
    const top = Math.max(0, viewport?.offsetTop || 0);
    const width = viewport?.width || window.innerWidth || document.documentElement.clientWidth;
    const height = viewport?.height || window.innerHeight || document.documentElement.clientHeight;
    const right = left + width, bottom = top + height;
    const placement = (anchor, type) => {
      const line = firstTextLine(anchor);
      if (!line || line.bottom <= top || line.top >= bottom) return null;
      const badgeTop = Math.max(top, Math.min(bottom - 22, line.top + (line.height - 22) / 2));
      const anchorRect = anchor.getBoundingClientRect();
      const parentRect = anchor.parentElement?.getBoundingClientRect?.();
      let edge = Math.min(right - 8, Math.max(anchorRect.right, parentRect?.right || 0));
      // Respect native controls already sharing the heading's row.
      for (const sibling of anchor.parentElement?.children || []) {
        if (sibling === anchor || sibling === pageNotice) continue;
        const rect = sibling.getBoundingClientRect?.();
        if (rect?.width > 0 && rect.height > 0 && rect.left > line.right
            && rect.top < badgeTop + 22 && rect.bottom > badgeTop) edge = Math.min(edge, rect.left - 6);
      }
      for (const control of root.querySelectorAll?.('.launcher, .settings-toggle') || []) {
        const rect = control.getBoundingClientRect?.();
        if (rect?.width > 0 && rect.top < badgeTop + 22 && rect.bottom > badgeTop) edge = Math.min(edge, rect.left - 6);
      }
      const x = Math.max(left + 8, line.right + 8), available = Math.floor(edge - x);
      if (available < 90) return null;
      return { anchor, type, left: x, top: badgeTop,
        width: Math.min(340, available), viewportLeft: left, viewportRight: right, viewportWidth: width,
        viewportTop: top, viewportBottom: bottom, viewportHeight: height };
    };
    for (const anchor of document.querySelectorAll?.('.ffscouter-info-line') || []) {
      const match = placement(anchor, 'ffscouter');
      if (match) return match;
    }
    const attack = new URL(window.location.href).pathname !== '/profiles.php';
    if (attack) {
      const labels = [...(document.querySelectorAll?.('[class*="labelsContainer"]') || [])];
      const defenders = labels.filter(label => label.closest?.('[class*="defender"]'));
      const matching = defenders.filter(label => [...(label.closest('[class*="defender"]').querySelectorAll('a[href*="profiles.php"]'))]
        .some(link => {
          try { return C.pageTargetId(new URL(link.getAttribute('href') || link.href, window.location.href).href) === id; }
          catch { return false; }
        }));
      for (const anchor of matching.length ? matching : defenders.length === 1 ? defenders : []) {
        const match = placement(anchor, 'attack');
        if (match) return match;
      }
    }
    const headings = [...(document.querySelectorAll?.('h1, h2, h3, h4, [role="heading"]') || [])]
      .filter(heading => !host.contains(heading) && !pageNotice?.contains(heading)
        && heading.closest?.('#content-wrapper, #mainContainer, main, .content-wrapper, [role="main"]'));
    const named = headings.filter(heading => heading.textContent.includes(`[${id}]`));
    for (const anchor of [...named, headings[0]].filter(Boolean)) {
      const match = placement(anchor, attack ? 'attack' : 'profile');
      if (match) return match;
    }
    return null;
  }
  function positionPageNotice(id) {
    const match = pageNoticePlacement(id);
    if (pageNoticeAnchor !== match?.anchor) {
      pageNoticeResizeObserver?.disconnect(); pageNoticeAnchor = match?.anchor || null;
      if (pageNoticeAnchor && typeof ResizeObserver === 'function') {
        pageNoticeResizeObserver ||= new ResizeObserver(schedulePageNotice);
        pageNoticeResizeObserver.observe(pageNoticeAnchor);
        if (pageNoticeAnchor.parentElement) pageNoticeResizeObserver.observe(pageNoticeAnchor.parentElement);
      }
    }
    if (!match) { pageNotice.remove(); return; }
    const style = (node, property, value) => { if (node.style[property] !== value) node.style[property] = value; };
    const attribute = (name, value) => { if (pageNotice.getAttribute(name) !== value) pageNotice.setAttribute(name, value); };
    attribute('data-placement', match.type); attribute('data-compact', String(match.width < 190));
    style(pageNotice, 'left', `${match.left}px`); style(pageNotice, 'top', `${match.top}px`); style(pageNotice, 'width', `${pageNoticeMode === 'suggest' ? Math.min(120, match.width) : match.width}px`);
    const detailWidth = Math.min(300, match.viewportWidth - 16);
    const detailLeft = Math.max(match.viewportLeft + 8, Math.min(match.left, match.viewportRight - detailWidth - 8));
    style(pageNoticeDetail, 'width', `${detailWidth}px`); style(pageNoticeDetail, 'left', `${detailLeft - match.left}px`);
    const below = Math.max(0, match.viewportBottom - match.top - 22 - 12);
    const above = Math.max(0, match.top - match.viewportTop - 12);
    const preferredHeight = Math.min(pageNoticeMode === 'suggest' ? 320 : 200, match.viewportHeight * (pageNoticeMode === 'suggest' ? 0.6 : 0.4));
    const upwards = below < preferredHeight && above > below;
    style(pageNoticeDetail, 'top', upwards ? 'auto' : 'calc(100% + 4px)');
    style(pageNoticeDetail, 'bottom', upwards ? 'calc(100% + 4px)' : 'auto');
    style(pageNoticeDetail, 'maxHeight', `${Math.min(preferredHeight, upwards ? above : below)}px`);
    // A fixed badge shares the existing text line without changing its wrapping
    // or height. Body mounting also keeps the popup out of Torn's clipped panels.
    if (pageNotice.parentNode !== document.body) document.body.append(pageNotice);
  }
  function updatePageNotice() {
    if (disposed || host.isConnected === false) {
      dispose(); return;
    }
    const id = C.pageTargetId(window.location?.href);
    if (!pageVisible()) { observeNoticeArea(null); pageNoticeResizeObserver?.disconnect(); removePageNotice(); return; }
    const authorized = id && id <= 2147483647 && state.player && state.token && Date.parse(state.expiresAt) > Date.now() && authorizedPoolFresh();
    const target = authorized ? state.targets.find(target => target.id === id) : null;
    if (!authorized || !target && id === state.player.id) { observeNoticeArea(null); removePageNotice(); return; }
    const mode = target ? 'listed' : 'suggest';
    if (pageNoticeMode !== mode) removePageNotice();
    if (pageSuggestion.id !== id) {
      removePageNotice();
      pageSuggestion = { id, comment: '', message: '' };
    }
    observeNoticeArea(id);
    if (!pageNotice) {
      pageNotice = element('div'); pageNotice.id = 'nwa-target-page-notice';
      pageNoticeMode = mode; pageNotice.setAttribute('data-mode', mode);
      const noticeRoot = pageNotice.attachShadow({ mode: 'closed' });
      const style = element('style');
      style.textContent = `
        :host{all:initial;position:fixed;z-index:2147483001;display:inline-block;box-sizing:border-box;max-width:340px;min-width:0;margin:0;font:10px/1.2 Arial,Helvetica,sans-serif;color:#d4d4d8}
        *{box-sizing:border-box}[hidden]{display:none!important}
        .notice{position:relative;max-width:100%;border:1px solid rgba(113,113,122,.65);border-radius:4px;background:rgba(24,24,27,.72)}
        summary{display:flex;align-items:center;gap:5px;height:20px;min-width:0;padding:1px 5px;list-style:none;cursor:pointer}
        summary::-webkit-details-marker{display:none}
        summary:focus-visible{outline:2px solid #9fbd57;outline-offset:2px;border-radius:3px}
        .title{flex:0 0 auto;color:#9fbd57;font-size:9px;font-weight:800;white-space:nowrap}
        .estimate{flex:0 0 auto;white-space:nowrap}.estimate[data-stale="true"]{color:#e6bd76}
        .reason{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
        .chevron{flex:0 0 auto;margin-left:auto;color:#a1a1aa;font-size:10px}
        details[open] .chevron{transform:rotate(180deg)}
        :host([data-compact="true"]) summary{gap:3px;padding:1px 3px}
        :host([data-compact="true"]) .reason,:host([data-compact="true"]) .estimate-label{display:none}
        :host([data-compact="true"]) .estimate[data-known="true"] .estimate-value::before{content:'~'}
        .detail{position:absolute;z-index:2147483001;top:calc(100% + 4px);left:0;max-height:min(200px,40vh);overflow:auto;padding:8px;border:1px solid #52525b;border-radius:4px;background:#18181b;color:#e4e4e7;font-size:11px;line-height:1.4;overflow-wrap:anywhere;box-shadow:0 4px 12px #0004}
        p{margin:0}.full-reason,.estimate-detail{margin-top:4px;white-space:pre-wrap}
        :host([data-mode="suggest"]) .title{font-size:10px;flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis}
        .quick-form{display:grid;gap:7px}.quick-form label{display:grid;gap:4px;font-weight:600}
        textarea{display:block;width:100%;min-height:64px;resize:vertical;max-height:130px;border:1px solid #52525b;border-radius:4px;background:#27272a;color:#f4f4f5;padding:6px;font:12px/1.4 Arial,Helvetica,sans-serif}
        textarea:focus-visible,button:focus-visible{outline:2px solid #9fbd57;outline-offset:2px}
        button{min-height:30px;border:1px solid #52525b;border-radius:4px;padding:4px 8px;background:#27272a;color:#f4f4f5;font:12px Arial,Helvetica,sans-serif;cursor:pointer}
        button[type="submit"]{background:#3f4d22;border-color:#9fbd57}button:disabled{opacity:.6;cursor:wait}
        .quick-actions{display:flex;gap:6px}.quick-feedback{margin-top:6px;white-space:pre-wrap}.quick-help{color:#a1a1aa;font-size:10px}
      `;
      const notice = element('section', null, 'notice');
      notice.setAttribute('role', 'note'); notice.setAttribute('aria-label', target ? 'NWA target list notice' : 'Suggest this player to NWA');
      pageNoticeDetails = element('details'); pageNoticeSummary = element('summary');
      pageNoticeDetail = element('div', null, 'detail');
      pageNoticeTitle = element('strong', target ? 'NWA' : 'Suggest to NWA', 'title');
      const chevron = element('span', target ? '⌄' : '+', 'chevron'); chevron.setAttribute('aria-hidden', 'true');
      if (target) {
        pageNoticeReason = element('span', null, 'reason');
        const estimate = element('span', null, 'estimate');
        pageNoticeEstimate = element('span', null, 'estimate-value');
        estimate.append(element('span', 'Est. ', 'estimate-label'), pageNoticeEstimate);
        pageNoticeSummary.append(pageNoticeTitle, estimate, pageNoticeReason, chevron);
        pageNoticeFullReason = element('p', null, 'full-reason');
        pageNoticeEstimateDetail = element('p', null, 'estimate-detail');
        pageNoticeDetail.append(element('p', 'This player is on the NWA target list.'), pageNoticeEstimateDetail, pageNoticeFullReason);
      } else {
        pageNoticeSummary.append(pageNoticeTitle, chevron);
        pageNoticeForm = element('form', null, 'quick-form');
        pageNoticeQuickHeading = element('p', 'Suggest player [' + id + ']');
        const label = element('label', 'Reason (required)');
        pageNoticeComment = element('textarea'); pageNoticeComment.required = true; pageNoticeComment.maxLength = 2000; pageNoticeComment.rows = 3;
        pageNoticeComment.setAttribute('aria-label', 'Reason for suggesting this player'); pageNoticeComment.placeholder = 'Why should this player be added?'; pageNoticeComment.value = pageSuggestion.comment;
        const commentInput = pageNoticeComment, pageId = id;
        pageNoticeComment.addEventListener('input', () => {
          if (!state.suggestionMutation && pageSuggestion.id === pageId) { pageSuggestion.comment = commentInput.value; pageSuggestion.message = ''; updatePageNotice(); }
        });
        label.append(pageNoticeComment);
        pageNoticeSubmit = element('button', 'Send suggestion'); pageNoticeSubmit.type = 'submit';
        const cancel = element('button', 'Cancel'); cancel.type = 'button';
        cancel.addEventListener('click', () => { pageNoticeDetails.open = false; pageNoticeSummary.focus?.(); });
        const actions = element('div', null, 'quick-actions'); actions.append(pageNoticeSubmit, cancel);
        pageNoticeForm.append(pageNoticeQuickHeading, label, element('p', 'Up to 1,000 characters. Your name and faction are shown to reviewers.', 'quick-help'), actions);
        pageNoticeForm.addEventListener('submit', event => {
          event.preventDefault();
          void submitSuggestion({ type: 'player', targetId: String(pageId), comment: commentInput.value }, true);
        });
        pageNoticeFeedback = element('p', null, 'quick-feedback'); pageNoticeFeedback.setAttribute('role', 'status'); pageNoticeFeedback.setAttribute('aria-live', 'polite');
        pageNoticeDetail.append(pageNoticeForm, pageNoticeFeedback);
      }
      pageNoticeDetails.append(pageNoticeSummary, pageNoticeDetail); notice.append(pageNoticeDetails);
      noticeRoot.append(style, notice);
      pageNoticeDetails.addEventListener('toggle', () => {
        if (!pageNoticeDetails?.open) return;
        positionPageNotice(C.pageTargetId(window.location?.href));
        if (pageNoticeMode === 'suggest' && !pageNoticeForm.hidden && !pageNoticeComment.disabled) pageNoticeComment.focus?.({ preventScroll: true });
      });
      noticeRoot.addEventListener('keydown', event => {
        if (event.key === 'Escape') { pageNoticeDetails.open = false; pageNoticeSummary.focus(); }
      });
    }
    if (!target) {
      const sharedPending = state.pendingPlayerIds.has(id), pending = sharedPending || pageSuggestedIds.has(id);
      const unavailable = state.pendingSuggestions.status === 'unavailable';
      const title = sharedPending ? 'NWA · Pending' : pending ? 'NWA · Suggested' : unavailable ? 'NWA · Check pending' : 'Suggest to NWA';
      if (pageNoticeTitle.textContent !== title) pageNoticeTitle.textContent = title;
      pageNoticeSummary.setAttribute('aria-label', (sharedPending ? 'Pending NWA suggestion for player ' : pending ? 'Suggestion submitted for player ' : unavailable ? 'Pending suggestion status unavailable for player ' : 'Suggest player ') + id);
      if (pageNoticeQuickHeading.textContent !== 'Suggest player [' + id + ']') pageNoticeQuickHeading.textContent = 'Suggest player [' + id + ']';
      const losingFocus = !pageNoticeForm.hidden && (pending || unavailable) && pageNoticeForm.contains(pageNoticeForm.getRootNode?.()?.activeElement);
      pageNoticeForm.hidden = pending || unavailable;
      if (losingFocus) pageNoticeSummary.focus?.({ preventScroll: true });
      const busy = Boolean(state.suggestionMutation || state.removingKey);
      pageNoticeComment.disabled = busy; pageNoticeSubmit.disabled = busy;
      if (pageNoticeSubmit.textContent !== (busy ? 'Submitting…' : 'Send suggestion')) pageNoticeSubmit.textContent = busy ? 'Submitting…' : 'Send suggestion';
      const feedback = pending ? (sharedPending ? 'This player already has a pending suggestion. Awaiting review by a faction leader or co-leader.'
        : 'Suggestion submitted. A faction leader or co-leader can review it.')
        : unavailable ? 'Pending suggestions could not be checked. Refresh NWA or wait for the next update before suggesting this player.'
        : pageSuggestion.message || (state.pendingSuggestions.status === 'unsupported' ? 'Check Suggestions in NWA for existing requests before submitting.' : '');
      if (pageNoticeFeedback.textContent !== feedback) pageNoticeFeedback.textContent = feedback;
      pageNoticeFeedback.hidden = !feedback;
      positionPageNotice(id); observeNoticeArea(id); return;
    }
    const reason = (typeof target.reason === 'string' && target.reason.trim())
      || (typeof target.notes === 'string' && target.notes.trim()) || 'No reason provided.';
    const text = `Reason: ${reason}`;
    // Reasons are text, including any markup characters supplied in a suggestion.
    if (pageNoticeReason.textContent !== text) {
      pageNoticeReason.textContent = text; pageNoticeFullReason.textContent = text;
    }
    const known = typeof target.estimatedStats === 'number' && Number.isFinite(target.estimatedStats) && target.estimatedStats > 0;
    const estimate = known ? C.compact(target.estimatedStats) : 'Unknown';
    const fresh = known && assessTarget(target).fresh;
    const estimateDetail = known
      ? `Estimated battle stats: ${estimate} · ${C.estimateSourceLabel(target) || 'Unknown source'} · ${C.ageLabel(target.estimateUpdatedAt)}${fresh ? '' : ' · Estimate needs refresh'}`
      : 'Estimated battle stats: Unknown · No estimate available';
    if (pageNoticeEstimate.textContent !== estimate) pageNoticeEstimate.textContent = estimate;
    if (pageNoticeEstimate.parentElement.getAttribute('data-known') !== String(known)) pageNoticeEstimate.parentElement.setAttribute('data-known', String(known));
    if (pageNoticeEstimate.parentElement.getAttribute('data-stale') !== String(known && !fresh)) pageNoticeEstimate.parentElement.setAttribute('data-stale', String(known && !fresh));
    if (pageNoticeEstimateDetail.textContent !== estimateDetail) pageNoticeEstimateDetail.textContent = estimateDetail;
    const description = `${estimateDetail}. ${text}`;
    if (pageNoticeSummary.title !== description) { pageNoticeSummary.title = description; pageNoticeSummary.setAttribute('aria-label', `NWA target list. ${description}`); }
    positionPageNotice(id); observeNoticeArea(id);
  }
  function schedulePageNotice() {
    if (disposed || !pageVisible() || !C.pageTargetId(window.location?.href) || pageNoticeTimer !== null) return;
    pageNoticeTimer = later(() => { pageNoticeTimer = null; updatePageNotice(); }, 100);
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
  function loadTargets(force = false, forFind = false, background = false, timeoutMs = 20000) {
    if (disposed || !state.token || state.removingKey || (background && (state.finding || state.pendingChecks.size))) return Promise.resolve(false);
    if (Date.now() < state.hardRetryAt) {
      if (!background) message(`The target service asked us to wait. Retry in ${Math.ceil((state.hardRetryAt - Date.now()) / 1000)}s.`);
      return Promise.resolve(false);
    }
    if (!force && !forFind && Date.now() < state.nextFeedAt) return Promise.resolve(false);
    if (!forFind && !background) cancelFind();
    if (state.targetLoad && !force) return state.targetLoad.promise;
    const generation = state.generation;
    const targetGeneration = ++state.targetGeneration;
    // Keep the server baseline separate from local status checks and expiry updates.
    const previousTargets = state.feedTargets, cursor = state.feedCursor;
    const pendingEpoch = state.pendingSuggestionEpoch, suggestionsCursor = state.pendingSuggestions.revision;
    state.loading = !background; state.backgroundLoading = background; state.lastPoolAttemptAt = Date.now(); message('');
    // Background sync publishes a complete new pool without hiding usable cached targets.
    if (!background) { state.targets = []; state.authorizedPool = false; updatePageNotice(); }
    if (!background) render();
    const pending = (async () => {
      try {
        const query = [cursor ? 'cursor=' + encodeURIComponent(cursor) : '', suggestionsCursor ? 'suggestionsCursor=' + encodeURIComponent(suggestionsCursor) : ''].filter(Boolean).join('&');
        const path = '/api/targets' + (query ? '?' + query : '');
        const data = await request('GET', path, undefined, state.token, timeoutMs);
        if (generation !== state.generation || targetGeneration !== state.targetGeneration) return false;
        const feed = C.applyFeed(data, previousTargets, cursor);
        state.feedTargets = feed.targets; state.feedCursor = feed.cursor;
        if (pendingEpoch === state.pendingSuggestionEpoch) {
          const previouslyPending = state.pendingPlayerIds.has(pageSuggestion.id) || pageSuggestedIds.has(pageSuggestion.id);
          try {
            state.pendingSuggestions = C.applyPendingSuggestions(data.pendingSuggestions === undefined && data.capabilities?.pendingSuggestions ? { unavailable: true } : data.pendingSuggestions, state.pendingSuggestions);
            state.pendingPlayerIds = new Set(state.pendingSuggestions.playerIds);
            if (state.pendingSuggestions.status === 'ready') {
              pageSuggestedIds.clear();
              if (previouslyPending && !state.pendingPlayerIds.has(pageSuggestion.id)) pageSuggestion.message = '';
            }
          } catch {
            state.pendingSuggestions = { status: 'unavailable', revision: null, playerIds: [] }; state.pendingPlayerIds.clear();
          }
        }
        state.player = data.player; state.targets = feed.targets; state.warnings = data.warnings || []; state.generatedAt = data.generatedAt;
        state.reservationsSupported = data.reservations?.supported === true;
        state.nextTargetSupported = data.capabilities?.nextTarget === true;
        state.backendNotice = data.capabilities?.schema?.status === 'incompatible' ? 'Backend database update required. Contact the NWA administrator.'
          : !state.nextTargetSupported ? 'Backend update available for faster target selection.' : '';
        state.feedFailures = 0; state.nextFeedAt = 0;
        state.poolLoadedAt = Date.now(); state.authorizedPool = true;
        updatePageNotice();
        return true;
      } catch (error) {
        if (generation === state.generation && targetGeneration === state.targetGeneration) {
          if (error.code === 'FEED_SYNC_INVALID') { state.feedTargets = []; state.feedCursor = null; }
          state.feedFailures = Math.min(6, state.feedFailures + 1);
          const retryMs = Math.max(Number(error.retryAfterSeconds || 0) * 1000,
            Math.min(120_000, 5000 * 2 ** (state.feedFailures - 1)));
          state.nextFeedAt = Date.now() + retryMs + Math.floor(Math.random() * 1000);
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
    if (disposed || state.finding || state.busy) return;
    message('');
    if (!state.token || Date.parse(state.expiresAt) <= Date.now()) {
      if (state.token && restoreNewerSession()) return;
      if (state.token) clearSession();
      state.findAfterLogin = true; toggle(true, launcher); render(); return;
    }
    if (Date.now() < state.hardRetryAt) {
      findNotice(`The target service asked us to wait. Retry in ${Math.ceil((state.hardRetryAt - Date.now()) / 1000)}s.`); return;
    }
    state.finding = true; state.lastFindAt = Date.now(); updateLauncher(); findNotice('Finding a target…');
    const findGeneration = ++state.findGeneration;
    const generation = state.generation;
    const deadline = Date.now() + 12000;
    let targetGeneration = state.targetGeneration;
    const current = () => !disposed && state.finding && findGeneration === state.findGeneration && generation === state.generation
      && targetGeneration === state.targetGeneration && state.token && Date.parse(state.expiresAt) > Date.now();
    try {
      if (state.nextTargetSupported !== false) {
        const selection = { minRatio: state.minRatio, maxRatio: state.maxRatio, estimateDays: state.estimateDays,
          recentTargetIds: C.recentTargets(state.recentTargets).slice(-50).map(row => row.id), query: state.query.trim().slice(0, 200), timeoutMs: 8000 };
        const signature = JSON.stringify(selection);
        if (!state.retryAttempt || state.retryAttempt.signature !== signature) {
          state.retryAttempt = { signature, requestId: typeof crypto !== 'undefined' && crypto.randomUUID
            ? crypto.randomUUID() : `nwa_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}_${Math.random().toString(36).slice(2)}` };
        }
        const attempt = state.retryAttempt;
        try {
          const data = await request('POST', '/api/targets/next', { ...selection, requestId: attempt.requestId }, state.token, 10000);
          if (!current()) return;
          if (!data?.player?.battleStats || !Number.isSafeInteger(data?.target?.id) || data.target.id <= 0 || data.target.id > 2147483647
              || !(Date.parse(data.target.reservationExpiresAt) > Date.now()) || data.target.reserved
              || !C.assess(data.target, data.player, state.maxRatio, Date.now(), state.minRatio, state.estimateDays).suggested
              || !C.assess(data.target, data.player, state.maxRatio, Date.now(), state.minRatio, state.estimateDays).ready) {
            throw new Error('NWA could not verify the reserved target. Try again.');
          }
          state.retryAttempt = null; state.nextTargetSupported = true;
          state.player = data.player; state.reservationsSupported = true;
          state.targets = state.targets.map(row => row.id === data.target.id ? data.target : row);
          rememberTarget(data.target.id); findNotice(`Opening ${data.target.name || 'target'}...`);
          window.location.assign(`https://www.torn.com/page.php?sid=attack&user2ID=${data.target.id}`);
          return;
        } catch (error) {
          if (!current()) return;
          // These structured backend failures confirm that selection did not
          // complete. A deliberate retry must start a new attempt after recovery;
          // transport and unrecognized gateway failures retain their uncertain ID.
          if (error.status && (error.status < 500 || DEFINITE_SELECTION_FAILURES.has(error.code))) state.retryAttempt = null;
          if (error.status === 404 && error.code === 'NOT_FOUND') {
            state.nextTargetSupported = false; state.backendNotice = 'Backend update available for faster target selection.';
          } else if (error.code === 'NO_TARGET_AVAILABLE') {
            findNotice('No matching targets are available right now. Adjust your filters or try again shortly.'); return;
          } else throw error;
        }
      }
      if (!state.player || !authorizedPoolFresh()
          || !C.select(state.targets, state.player, { ...state, mode: 'suggested' }).length) {
        let feedTimer;
        let restored;
        try {
          const feed = loadTargets(false, true, false, 5000);
          targetGeneration = state.targetGeneration;
          restored = await Promise.race([feed, new Promise((_, reject) => {
            feedTimer = later(() => reject(new Error('NWA could not load targets in time. Try again shortly.')), Math.max(1, deadline - Date.now()));
          })]);
        } finally { cancelLater(feedTimer); }
        targetGeneration = state.targetGeneration;
        if (!restored || !current()) {
          if (findGeneration === state.findGeneration && state.error) findNotice(state.error);
          return;
        }
      }
      if (!state.reservationsSupported) { findNotice(COORDINATION_UNAVAILABLE); return; }
      const matches = C.select(state.targets, state.player, { ...state, mode: 'suggested' });
      state.recentTargets = C.recentTargets(state.recentTargets);
      const candidates = C.candidates(matches, state.recentTargets);
      // Preserve the previous version's last-target preference on first update.
      if (!state.recentTargets.length) candidates.sort((a, b) => Number(assessTarget(b).ready) - Number(assessTarget(a).ready)
        || Number(a.id === state.lastTargetId) - Number(b.id === state.lastTargetId));
      const limit = Math.min(candidates.length, 5);
      for (let index = 0; index < limit; index++) {
        if (!current()) return;
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) break;
        const target = candidates[index];
        findNotice(`Reserving ${target.name || 'player'}…`);
        let checked;
        try { checked = await request('POST', `/api/targets/${target.id}/reservation`,
          undefined, state.token, 10000); }
        catch (error) {
          if (!current()) return;
          state.targets = state.targets.map(row => row.id === target.id ? { ...row, checkedAt: null } : row);
          if (['FRIENDLY_TARGET', 'TARGET_NOT_FOUND', 'TARGET_LEFT_FACTION'].includes(error.code)) {
            state.targets = state.targets.filter(row => row.id !== target.id); updatePageNotice(); continue;
          }
          if (['TARGET_RESERVED', 'TARGET_UNAVAILABLE'].includes(error.code)) {
            state.targets = state.targets.map(row => row.id === target.id ? { ...row, reserved: true } : row);
            continue;
          }
          // A transport failure can hide a successful reservation. Do not start
          // another reservation after an ambiguous response from an old backend.
          if (!error.status) throw error;
          if (error.status === 502 || ['TORN_UNAVAILABLE', 'TARGETS_UNAVAILABLE'].includes(error.code)) continue;
          throw error;
        }
        if (!current()) return;
        if (checked?.id !== target.id) throw new Error('NWA could not verify this target. Try again.');
        if (!state.reservationsSupported || !(Date.parse(checked.reservationExpiresAt) > Date.now())) {
          throw new Error('NWA could not reserve this target. Try again.');
        }
        state.targets = state.targets.map(row => row.id === target.id ? { ...row, ...checked } : row);
        const latest = state.targets.find(row => row.id === target.id);
        const assessment = latest && assessTarget(latest);
        if (!assessment?.suggested || !assessment.ready) continue;
        rememberTarget(target.id);
        findNotice(`Opening ${latest.name || 'target'}…`);
        window.location.assign(`https://www.torn.com/page.php?sid=attack&user2ID=${target.id}`);
        return;
      }
      const notice = !state.targets.length ? 'The NWA target pool is empty. Suggest targets in settings.'
        : !matches.length ? `No targets match. ${poolSummary()} Adjust your stats or maximum estimate age in settings.`
        : !candidates.length && state.recentTargets.length ? 'Matching targets are unavailable, reserved, or opened in the last 10 minutes. You can clear recent targets in settings.'
        : candidates.length > limit ? 'No available target in the first 5 matches. Try NWA again or browse settings.'
        : 'No matching targets are available right now. Try again shortly.';
      findNotice(notice);
    } catch (error) {
      if (current()) { handleError(error); findNotice(error.message || 'NWA could not find a target. Try again.'); }
    } finally {
      if (findGeneration === state.findGeneration) {
        state.finding = false;
        if (state.token && Date.parse(state.expiresAt) <= Date.now()) {
          if (!restoreNewerSession()) { clearSession(); message('Session expired. Sign in again.'); findNotice('Session expired. Open NWA settings to sign in again.'); }
        }
        render();
      }
    }
  }
  async function checkStatus(id, openAttack = false) {
    if (state.removingKey || state.pendingChecks.has(id)) return;
    if (openAttack && !state.reservationsSupported) { message(COORDINATION_UNAVAILABLE); renderCards(); return; }
    state.pendingChecks.add(id); message(''); renderCards();
    const generation = state.generation;
    const targetGeneration = state.targetGeneration;
    try {
      const checked = await request(openAttack ? 'POST' : 'GET',
        `/api/targets/${id}/${openAttack ? 'reservation' : 'status'}`);
      if (generation !== state.generation || targetGeneration !== state.targetGeneration) return;
      if (checked?.id !== id) throw new Error('NWA could not verify this target. Try again.');
      state.targets = state.targets.map(target => target.id === id ? { ...target, ...checked } : target);
      if (openAttack) {
        const latest = state.targets.find(target => target.id === id);
        const assessment = latest && assessTarget(latest);
        if (!state.token || Date.parse(state.expiresAt) <= Date.now() || !authorizedPoolFresh() || !assessment?.suggested || !assessment.ready
          || !state.reservationsSupported || !(Date.parse(checked.reservationExpiresAt) > Date.now())) {
          throw new Error('This target is no longer ready. Refresh the list and try another.');
        }
        rememberTarget(id);
        window.location.assign(`https://www.torn.com/page.php?sid=attack&user2ID=${id}`);
      }
    } catch (error) {
      if (generation !== state.generation || targetGeneration !== state.targetGeneration) return;
      state.targets = ['FRIENDLY_TARGET', 'TARGET_NOT_FOUND', 'TARGET_LEFT_FACTION'].includes(error.code)
        ? state.targets.filter(target => target.id !== id)
        : state.targets.map(target => target.id === id ? { ...target, checkedAt: null,
          ...(error.code === 'TARGET_RESERVED' ? { reserved: true } : {}) } : target);
      updatePageNotice();
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

  async function submitSuggestion(draft = state.suggestionDraft, fromPage = false) {
    if (!state.token || state.removingKey || state.suggestionMutation) return;
    const report = text => fromPage ? pageSuggestionMessage(text, Number(draft.targetId)) : message(text);
    if (fromPage && (!pageVisible() || C.pageTargetId(window.location?.href) !== Number(draft.targetId) || !authorizedPoolFresh()
      || Number(draft.targetId) === state.player?.id || state.targets.some(target => target.id === Number(draft.targetId))
      || pageSuggestedIds.has(Number(draft.targetId)) || state.pendingPlayerIds.has(Number(draft.targetId)) || state.pendingSuggestions.status === 'unavailable')) return;
    const targetId = Number(draft.targetId);
    const comment = draft.comment.trim();
    if (!['player', 'faction'].includes(draft.type) || !/^[1-9]\d*$/.test(draft.targetId.trim()) || !Number.isSafeInteger(targetId) || targetId > 2147483647) {
      report('Enter a valid player or faction ID.'); return;
    }
    if (!comment || [...comment].length > 1000) { report('Add a reason for this target, up to 1,000 characters.'); return; }
    const generation = state.generation;
    const quickWasFocused = fromPage && pageNoticeForm?.contains(pageNoticeForm.getRootNode?.()?.activeElement);
    state.suggestionMutation = 'submit'; state.suggestionNotice = ''; message('');
    if (fromPage) pageSuggestionMessage('', targetId);
    render(); updatePageNotice();
    try {
      await request('POST', '/api/suggestions', { type: draft.type, targetId, comment });
      if (generation !== state.generation) return;
      if (!fromPage) state.suggestionDraft = { type: 'player', targetId: '', comment: '' };
      state.pendingSuggestionEpoch++; state.pendingSuggestions = { ...state.pendingSuggestions, revision: null };
      if (draft.type === 'player') {
        if (pageSuggestedIds.size >= 200) pageSuggestedIds.delete(pageSuggestedIds.values().next().value);
        pageSuggestedIds.add(targetId);
      }
      state.suggestionNotice = 'Suggestion submitted. A faction leader or co-leader can review it.';
      if (fromPage && pageSuggestion.id === targetId) { pageSuggestion.comment = ''; pageSuggestionMessage(state.suggestionNotice, targetId); }
      if (!fromPage || state.open && state.view === 'suggestions') await loadSuggestions();
    } catch (error) {
      if (generation === state.generation) {
        handleError(error);
        if (fromPage) {
          pageSuggestionMessage(error.message || 'The suggestion could not be submitted.', targetId);
          if (error.code === 'SUGGESTION_CONFLICT') void loadTargets(true);
        }
      }
    }
    finally {
      if (generation === state.generation) {
        state.suggestionMutation = null; render(); updatePageNotice();
        if (quickWasFocused && pageSuggestion.id === targetId && pageNoticeMode === 'suggest' && pageNoticeDetails?.open
          && (!document.activeElement || document.activeElement === document.body || document.activeElement === pageNotice)) pageNoticeSummary.focus?.({ preventScroll: true });
      }
    }
  }

  async function reviewSuggestion(id, decision) {
    if (!state.token || state.removingKey || !state.canReview || state.suggestionMutation || !state.suggestions.some(row => row.id === id && row.status === 'pending')) return;
    const generation = state.generation;
    state.suggestionMutation = id; state.suggestionNotice = ''; message(''); render();
    try {
      const data = await request('POST', `/api/suggestions/${id}/review`, { decision });
      if (generation !== state.generation) return;
      state.pendingSuggestionEpoch++; state.pendingSuggestions = { ...state.pendingSuggestions, revision: null };
      if (data.suggestion?.type === 'player') {
        state.pendingPlayerIds.delete(data.suggestion.targetId); pageSuggestedIds.delete(data.suggestion.targetId);
        if (pageSuggestion.id === data.suggestion.targetId) pageSuggestion.message = '';
      }
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
    } finally { if (generation === state.generation) { state.suggestionMutation = null; render(); updatePageNotice(); } }
  }

  let cardContainer, countNode, panelUi = null, renderedKind = null, suggestionContainer = null, suggestionSignature = null;
  let preferencesOpen = false, diagnosticsOpen = false;
  const cardNodes = new Map();
  let orderedRowsKey = null, orderedIds = [], mountedIds = [], emptyCard = null;
  let visibleCardLimit = CARD_BATCH_SIZE, cardFilterKey = null, lazyCardsObserver = null;
  const setText = (node, text) => { if (node.textContent !== text) node.textContent = text; };
  function resetPanel() {
    lazyCardsObserver?.disconnect(); lazyCardsObserver = null;
    clearExport();
    content.replaceChildren(); cardContainer = null; countNode = null; panelUi = null; renderedKind = null;
    suggestionContainer = null; suggestionSignature = null; cardNodes.clear();
    orderedRowsKey = null; orderedIds = []; mountedIds = []; emptyCard = null;
  }
  function updatePanelControls() {
    if (!state.player && state.token) {
      panelUi.retry.disabled = state.busy || state.loading || state.removingKey;
      panelUi.signOut.disabled = state.busy || state.loading || state.removingKey;
      setText(panelUi.retry, state.loading ? 'Restoring session…' : 'Retry saved login');
      return;
    }
    if (!state.player) {
      panelUi.input.disabled = state.busy || state.loading;
      panelUi.submit.disabled = state.busy || state.loading;
      setText(panelUi.submit, state.loading ? 'Restoring session…' : state.busy ? 'Verifying faction…' : 'Sign in and save key');
      return;
    }
    const player = state.player;
    setText(panelUi.name, `${player.name} [${player.id}]`);
    setText(panelUi.faction, `${player.faction.name} · Faction ${player.faction.id}`);
    setText(panelUi.signOut, state.removingKey ? 'Removing key…' : 'Sign out and remove key');
    panelUi.signOut.disabled = state.removingKey;
    setText(panelUi.total, `${C.compact(player.battleStats.total)} total stats`);
    panelUi.total.setAttribute('aria-label', `Your battle stats: ${C.compact(player.battleStats.total)} total`);
    for (const [key, node] of panelUi.stats) setText(node, C.compact(player.battleStats[key]));
    if (state.view !== 'targets') return;
    panelUi.updateRangeSummary();
    setText(panelUi.refresh, state.loading ? 'Loading…' : 'Refresh list'); panelUi.refresh.disabled = state.loading;
    updateExportControls();
    // Background changes must not overwrite a number the member is still typing.
    for (const [property, node] of panelUi.ratios) if (root.activeElement !== node) node.value = panelUi.percent(state[property]);
    if (root.activeElement !== panelUi.age) panelUi.age.value = String(state.estimateDays);
    panelUi.ageCaution.hidden = state.estimateDays <= 28;
    setText(panelUi.estimateNote, `Possible matches use estimated total stats, with estimates no older than ${state.estimateDays} days. This is a rough difficulty guide: stat distribution, equipment and bonuses also affect fights.`);
    const metadata = JSON.stringify([state.warnings, state.generatedAt, state.backendNotice]);
    if (metadata !== panelUi.metadata) {
      panelUi.metadata = metadata; panelUi.poolMetadata.replaceChildren();
      for (const warning of state.warnings) panelUi.poolMetadata.append(element('p', warning));
      if (state.backendNotice) panelUi.poolMetadata.append(element('p', state.backendNotice));
    }
    setText(panelUi.poolUpdated, state.generatedAt ? `Pool updated: ${C.ageLabel(Date.parse(state.generatedAt) / 1000)}` : 'Pool update time unknown');
  }
  function render() {
    const focus = captureFocus(content);
    renderPanel();
    restoreFocus(focus);
  }
  function renderPanel() {
    if (disposed) return;
    updatePageNotice();
    updateLauncher();
    moreOptions.hidden = !state.player;
    if (!state.player && renderedKind?.startsWith('member:')) resetPanel();
    if (!state.open) { state.backgroundRenderPending = true; return; }
    state.backgroundRenderPending = false;
    const kind = state.player ? `member:${state.player.id}:${state.view}` : state.token ? 'saved-login' : 'login';
    if (renderedKind === kind) {
      updatePanelControls();
      if (state.player) { if (state.view === 'targets') renderCards(); else renderSuggestions(); }
      return;
    }
    resetPanel(); renderedKind = kind;
    if (!state.player && state.token) {
      const intro = element('p', 'Your login is saved on this device. NWA will reconnect without asking for your key again.');
      const retry = button(state.loading ? 'Restoring session…' : 'Retry saved login', () => void loadTargets(true));
      retry.disabled = state.busy || state.loading || state.removingKey;
      const signOut = button('Sign out and remove key', () => void logout());
      signOut.disabled = state.busy || state.loading || state.removingKey;
      panelUi = { retry, signOut }; content.append(intro, retry, signOut);
      return;
    }
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
        element('div', 'Your key is saved encrypted in the backend Supabase database and expires after up to 7 days, so target hospital and availability checks continue while you are offline.'),
        element('div', 'Use "Sign out and remove key" to delete the saved key.'),
        link('Get a Limited API key ↗', 'https://www.torn.com/preferences.php#tab=api'));
      panelUi = { input, submit };
      form.append(privacy, label, submit); content.append(intro, form); return;
    }
    const player = state.player;
    const profile = element('div', null, 'profile'); const identity = element('div');
    const playerName = element('strong', `${player.name} [${player.id}]`);
    const factionName = element('div', `${player.faction.name} · Faction ${player.faction.id}`, 'muted');
    identity.append(playerName, factionName);
    const signOut = button(state.removingKey ? 'Removing key…' : 'Sign out and remove key', () => void logout());
    signOut.setAttribute('data-action', 'signout');
    signOut.disabled = state.removingKey;
    const total = element('div', `${C.compact(player.battleStats.total)} total stats`, 'player-total');
    total.setAttribute('aria-label', `Your battle stats: ${C.compact(player.battleStats.total)} total`);
    panelUi = { name: playerName, faction: factionName, signOut, total, stats: new Map(), ratios: new Map() };
    profile.append(identity, total); content.append(profile);
    const tabs = element('div', null, 'tabs'); tabs.setAttribute('aria-label', 'NWA sections');
    for (const [view, label] of [['targets', 'Targets'], ['suggestions', 'Suggestions']]) {
      const tab = button(label, () => {
        if (state.view === view) return;
        state.view = view; render();
        if (view === 'suggestions') void loadSuggestions();
      });
      focusKey(tab, `section:${view}`); tab.setAttribute('aria-pressed', String(state.view === view)); tabs.append(tab);
    }
    content.append(tabs);
    const preferencesPanel = element('details', null, 'preferences'); preferencesPanel.open = preferencesOpen;
    preferencesPanel.addEventListener('toggle', () => { preferencesOpen = preferencesPanel.open; });
    const preferencesSummary = element('summary', 'Preferences & account');
    panelUi.preferences = preferencesPanel; panelUi.preferencesSummary = preferencesSummary;
    preferencesPanel.append(preferencesSummary);
    const preferencesBody = element('div', null, 'preferences-body'); preferencesPanel.append(preferencesBody);
    preferencesBody.append(element('h3', 'Your battle stats'));
    const grid = element('div', null, 'statgrid');
    for (const key of ['strength', 'defense', 'speed', 'dexterity']) {
      const stat = element('div', null, 'stat'); const value = element('strong', C.compact(player.battleStats[key]));
      panelUi.stats.set(key, value); stat.append(element('small', key[0].toUpperCase() + key.slice(1)), value); grid.append(stat);
    }
    preferencesBody.append(grid);
    const account = element('div', null, 'account');
    account.append(element('span', 'Removes your saved key and logins.', 'muted'), signOut);
    if (state.view === 'suggestions') {
      suggestionContainer = element('div'); content.append(suggestionContainer); renderSuggestions();
      preferencesBody.append(account); content.append(preferencesPanel); return;
    }
    const toolbar = element('div', null, 'toolbar');
    const query = element('input'); query.type = 'search'; query.placeholder = 'Search targets'; query.value = state.query;
    panelUi.query = query;
    query.title = 'Search player, faction or reason';
    query.setAttribute('aria-label', 'Search targets'); query.addEventListener('input', () => { state.query = query.value; cancelFind(); renderCards(); });
    const mode = element('select'); mode.setAttribute('aria-label', 'Target view');
    for (const [value, label] of [['all', 'All targets'], ['suggested', 'Possible matches']]) {
      const option = element('option', label); option.value = value; mode.append(option);
    }
    mode.value = state.mode; mode.addEventListener('change', () => { state.mode = mode.value; renderCards(); });
    panelUi.find = button('Find target', () => void findTarget(), 'primary find-target');
    panelUi.find.disabled = state.finding || state.busy || state.removingKey;
    toolbar.append(query, panelUi.find); content.append(toolbar);
    const controls = element('div', null, 'controls filters');
    controls.append(element('span', 'Target stats', 'filter-label'));
    const rangeSummary = element('div', null, 'stat-range-summary');
    const percent = value => String(Number((value * 100).toFixed(6)));
    const updateRangeSummary = () => {
      const total = state.player.battleStats.total;
      setText(rangeSummary, `Target range: ${C.compact(total * state.minRatio)}–${C.compact(total * state.maxRatio)} estimated stats (${percent(state.minRatio)}–${percent(state.maxRatio)}% of yours)`);
    };
    for (const [property, label, minimum] of [['minRatio', 'Min', 0], ['maxRatio', 'Max', 1]]) {
      const ratioLabel = element('label', `${label}:`);
      const ratio = element('input'); ratio.type = 'number'; ratio.min = String(minimum); ratio.max = '500'; ratio.step = 'any'; ratio.value = percent(state[property]);
      ratio.setAttribute('aria-label', `${property === 'minRatio' ? 'Minimum' : 'Maximum'} target stats as percent of your total`);
      panelUi.ratios.set(property, ratio);
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
    controls.append(mode); content.append(controls);
    const refresh = button(state.loading ? 'Loading…' : 'Refresh list', () => void loadTargets()); refresh.disabled = state.loading;
    panelUi.refresh = refresh; panelUi.percent = percent; panelUi.updateRangeSummary = updateRangeSummary;
    updateRangeSummary(); content.append(rangeSummary);
    const ageControls = element('div', null, 'controls');
    const ageLabel = element('label', 'Maximum estimate age:');
    const age = element('input'); age.type = 'number'; age.min = '1'; age.max = '365'; age.step = '1'; age.value = String(state.estimateDays);
    age.setAttribute('aria-label', 'Maximum estimate age in days');
    panelUi.age = age;
    age.addEventListener('change', () => {
      const next = Number(age.value);
      if (!age.value.trim() || !Number.isSafeInteger(next) || next < 1 || next > 365) {
        age.value = String(state.estimateDays); message('Enter a whole number from 1 to 365 days.'); return;
      }
      state.estimateDays = next; savePreferences(); cancelFind(); message(''); render();
    });
    ageLabel.append(age, element('span', 'days')); ageControls.append(ageLabel,
      button('Clear recent targets', () => { state.recentTargets = []; state.lastTargetId = null; savePreferences(); cancelFind(); message(''); renderCards(); }));
    preferencesBody.append(element('h3', 'Target preferences'), ageControls);
    const ageCaution = element('p', 'Older estimates can be inaccurate. Extra caution is needed beyond 28 days.', 'notice');
    ageCaution.hidden = state.estimateDays <= 28; panelUi.ageCaution = ageCaution; preferencesBody.append(ageCaution);
    const exports = element('div', null, 'exports'); const scopeLabel = element('label', 'Export:');
    const exportScope = element('select'); exportScope.setAttribute('aria-label', 'Export scope');
    for (const [value, label] of [['all', 'All targets'], ['shown', 'Shown targets']]) {
      const option = element('option', label); option.value = value; exportScope.append(option);
    }
    exportScope.value = 'all'; scopeLabel.append(exportScope); exports.append(scopeLabel);
    panelUi.exportScope = exportScope; panelUi.exportButtons = [];
    for (const [format, label] of [['csv', 'Export CSV'], ['markdown', 'Export Markdown']]) {
      const control = button(label, () => showExport(format)); panelUi.exportButtons.push(control); exports.append(control);
    }
    panelUi.exportHost = element('div'); preferencesBody.append(element('h3', 'Export target list'), exports, panelUi.exportHost);
    countNode = element('div', null, 'count');
    const diagnostics = element('details', null, 'pool-details'); diagnostics.open = diagnosticsOpen;
    diagnostics.addEventListener('toggle', () => { diagnosticsOpen = diagnostics.open; });
    panelUi.countSummary = element('summary'); panelUi.countDetail = element('div', null, 'count-detail');
    diagnostics.append(panelUi.countSummary, panelUi.countDetail); countNode.append(diagnostics, refresh);
    cardContainer = element('div', null, 'cards'); cardContainer.setAttribute('aria-label', 'Targets');
    content.append(countNode, cardContainer);
    panelUi.moreCards = element('div', null, 'queuefooter');
    panelUi.showMore = button('Show more', () => {
      visibleCardLimit += CARD_BATCH_SIZE; renderCards();
    });
    panelUi.moreCards.append(panelUi.showMore); content.append(panelUi.moreCards);
    if (typeof IntersectionObserver === 'function') {
      lazyCardsObserver = new IntersectionObserver(entries => {
        if (!disposed && state.open && pageVisible() && panelUi?.moreCards && !panelUi.moreCards.hidden && entries.some(entry => entry.isIntersecting)) {
          visibleCardLimit += CARD_BATCH_SIZE; renderCards();
        }
      }, { root: scroll, rootMargin: '200px 0px', threshold: 0 });
    }
    const note = element('div', null, 'footnote');
    panelUi.estimateNote = element('p', `Possible matches use estimated total stats, with estimates no older than ${state.estimateDays} days. This is a rough difficulty guide: stat distribution, equipment and bonuses also affect fights.`);
    note.append(panelUi.estimateNote,
      element('p', 'Refreshing the list checks for updates; FFScouter may still have an older estimate. Recently opened targets are skipped for 10 minutes. The finder and list attack buttons require a shared reservation. Assignments last two minutes with the current backend, even when you choose another target.'),
      element('p', 'NWA uses availability checked within 30 seconds. Check status to update a target now. Status can change at any time; Torn makes the final availability check.'));
    panelUi.poolMetadata = element('div', null, 'pool-warnings'); panelUi.metadata = null;
    panelUi.poolUpdated = element('span');
    const footer = element('div', null, 'pool-footer'); footer.append(panelUi.poolUpdated, element('span', `NWA · v${CONFIG.version}`));
    preferencesBody.append(note, account); content.append(panelUi.poolMetadata, preferencesPanel, footer);
    updatePanelControls(); updateLauncher(); renderCards();
  }

  function renderSuggestions() {
    const focus = captureFocus(suggestionContainer);
    renderSuggestionContent();
    restoreFocus(focus, suggestionContainer);
  }
  function renderSuggestionContent() {
    if (!state.open || !suggestionContainer) return;
    const signature = JSON.stringify([state.suggestions, state.canReview, state.suggestionView, state.suggestionsLoading,
      state.suggestionMutation, state.suggestionNotice, state.nextSuggestionOffset]);
    if (signature === suggestionSignature) return;
    suggestionSignature = signature; suggestionContainer.replaceChildren();
    suggestionContainer.append(element('p', 'Suggest a player or faction for the shared target pool. Every suggestion needs a reason.', 'notice'));
    const form = element('form', null, 'suggestionform');
    const fields = element('div', null, 'suggestionfields');
    const typeLabel = element('label', 'Target type'); const type = focusKey(element('select'), 'suggestion:type'); type.setAttribute('aria-label', 'Suggestion type');
    for (const [value, label] of [['player', 'Player'], ['faction', 'Faction']]) { const option = element('option', label); option.value = value; type.append(option); }
    type.value = state.suggestionDraft.type; type.disabled = Boolean(state.suggestionMutation);
    type.addEventListener('change', () => { if (!state.suggestionMutation) state.suggestionDraft.type = type.value; }); typeLabel.append(type);
    const idLabel = element('label', 'Player or faction ID'); const id = focusKey(element('input'), 'suggestion:id'); id.type = 'number'; id.min = '1'; id.max = '2147483647'; id.step = '1'; id.required = true;
    id.placeholder = 'Torn ID'; id.setAttribute('aria-label', 'Player or faction ID'); id.value = state.suggestionDraft.targetId; id.disabled = Boolean(state.suggestionMutation);
    id.addEventListener('input', () => { if (!state.suggestionMutation) state.suggestionDraft.targetId = id.value; }); idLabel.append(id); fields.append(typeLabel, idLabel);
    const commentLabel = element('label', 'Reason / comment (required)'); const comment = focusKey(element('textarea'), 'suggestion:comment'); comment.required = true; comment.maxLength = 2000; comment.rows = 3;
    comment.placeholder = 'Why should this target be added?'; comment.setAttribute('aria-label', 'Reason for suggesting this target'); comment.value = state.suggestionDraft.comment; comment.disabled = Boolean(state.suggestionMutation);
    comment.addEventListener('input', () => { if (!state.suggestionMutation) state.suggestionDraft.comment = comment.value; }); commentLabel.append(comment, element('small', 'Up to 1,000 characters. Your name and faction are shown with the suggestion.'));
    const submit = focusKey(element('button', state.suggestionMutation === 'submit' ? 'Submitting…' : 'Submit suggestion', 'primary'), 'suggestion:submit'); submit.type = 'submit'; submit.disabled = Boolean(state.suggestionMutation);
    form.addEventListener('submit', event => { event.preventDefault(); void submitSuggestion(); });
    form.append(fields, commentLabel, submit); suggestionContainer.append(form);
    if (state.suggestionNotice) { const notice = element('div', state.suggestionNotice, 'success'); notice.setAttribute('role', 'status'); suggestionContainer.append(notice); }
    const queueHeader = element('div', null, 'queueheader'); queueHeader.append(element('h3', 'Target suggestions'));
    const refresh = focusKey(button(state.suggestionsLoading ? 'Loading…' : 'Refresh suggestions', () => void loadSuggestions()), 'suggestion:refresh'); refresh.disabled = state.suggestionsLoading || Boolean(state.suggestionMutation); queueHeader.append(refresh); suggestionContainer.append(queueHeader);
    const views = element('div', null, 'tabs'); views.setAttribute('aria-label', 'Suggestion views');
    for (const [view, label] of [['pending', 'Pending suggestions'], ['mine', 'My suggestions'], ['history', 'History']]) {
      const tab = button(label, () => { if (state.suggestionView !== view) void loadSuggestions(view); });
      focusKey(tab, `suggestion-view:${view}`); tab.setAttribute('aria-pressed', String(state.suggestionView === view)); tab.disabled = Boolean(state.suggestionMutation); views.append(tab);
    }
    suggestionContainer.append(views);
    suggestionContainer.append(element('p', state.suggestionView === 'history'
      ? 'Approved and rejected suggestions keep the original reason, who suggested them, and who reviewed them.'
      : state.canReview
        ? 'You can approve or reject suggestions as a current faction leader or co-leader. Approving a faction adds its current players to the target pool.'
        : 'Faction leaders and co-leaders can approve or reject suggestions. Approving a faction adds its current players to the target pool.', 'notice'));
    const queue = element('div', null, 'cards suggestionqueue'); suggestionContainer.append(queue);
    if (!state.suggestions.length) queue.append(element('div', state.suggestionsLoading ? 'Loading suggestions…'
      : state.suggestionView === 'history' ? 'No reviewed suggestions yet.'
        : state.suggestionView === 'mine' ? 'You have not suggested any targets yet.' : 'There are no pending suggestions.', 'empty'));
    for (const row of state.suggestions) {
      const card = element('article', null, 'card suggestioncard'); const top = element('div', null, 'cardhead'); const identity = element('div');
      const href = row.type === 'faction' ? `https://www.torn.com/factions.php?step=profile&ID=${row.targetId}` : `https://www.torn.com/profiles.php?XID=${row.targetId}`;
      identity.append(focusKey(link(`${row.targetName || (row.type === 'faction' ? 'Faction' : 'Player')} [${row.targetId}] ↗`, href, 'name'), `suggestion:${row.id}:profile`), element('div', row.type === 'faction' ? 'Faction · current players added on approval' : 'Player', 'muted'));
      top.append(identity, element('span', row.status, `badge ${row.status === 'pending' ? 'warn' : row.status === 'rejected' ? 'muted' : ''}`)); card.append(top);
      card.append(element('div', row.comment, 'comment'));
      const actor = row.suggestedBy;
      card.append(element('div', `Suggested by ${actor.name} [${actor.id}] · ${actor.faction.name} [${actor.faction.id}]`, 'muted'));
      const submitted = element('div', 'Submitted ', 'muted'); const submittedAt = element('time', new Date(row.createdAt).toLocaleString());
      submittedAt.setAttribute('datetime', row.createdAt); submitted.append(submittedAt); card.append(submitted);
      if (row.reviewedBy) {
        card.append(element('div', `${row.status === 'approved' ? 'Approved' : 'Rejected'} by ${row.reviewedBy.name} [${row.reviewedBy.id}]`, 'muted'));
        if (row.reviewedAt) {
          const reviewed = element('div', 'Reviewed ', 'muted'); const reviewedAt = element('time', new Date(row.reviewedAt).toLocaleString());
          reviewedAt.setAttribute('datetime', row.reviewedAt); reviewed.append(reviewedAt); card.append(reviewed);
        }
      }
      if (state.suggestionView !== 'history' && state.canReview && row.status === 'pending') {
        const actions = element('div', null, 'actions');
        for (const [decision, label] of [['approved', 'Approve'], ['rejected', 'Reject']]) {
          const action = focusKey(button(label, () => void reviewSuggestion(row.id, decision), decision === 'approved' ? 'primary' : ''), `suggestion:${row.id}:${decision}`);
          action.disabled = Boolean(state.suggestionMutation) || state.suggestionsLoading; actions.append(action);
        }
        card.append(actions);
      }
      queue.append(card);
    }
    if (state.nextSuggestionOffset !== null) {
      const more = focusKey(button(state.suggestionsLoading ? 'Loading…' : 'Load more suggestions', () => void loadSuggestions(state.suggestionView, true)), 'suggestion:more');
      more.disabled = state.suggestionsLoading || Boolean(state.suggestionMutation); const footer = element('div', null, 'queuefooter'); footer.append(more); suggestionContainer.append(footer);
    }
  }

  function poolSummary() {
    let range = 0, old = 0, unknown = 0, ready = 0;
    const now = Date.now();
    for (const target of state.targets) {
      const assessment = C.assess(target, state.player, state.maxRatio, now, state.minRatio, state.estimateDays);
      if (!assessment.allied && assessment.inRange) range++;
      if (assessment.ratio !== null && !assessment.fresh) old++;
      if (assessment.ratio === null) unknown++;
      if (assessment.suggested && assessment.ready && !target.reserved) ready++;
    }
    return `${range} in stat range · ${old} estimates too old or undated · ${unknown} stats unknown · ${ready} ready now`;
  }
  function renderCards() {
    if (disposed || !state.open || state.view !== 'targets' || !state.player || !cardContainer) return;
    const focus = captureFocus(cardContainer);
    let focusedCard = focus?.node;
    while (focusedCard && !focusedCard.getAttribute?.('data-target-id')) focusedCard = focusedCard.parentNode;
    const focusedId = Number(focusedCard?.getAttribute('data-target-id'));
    renderTargetCards();
    restoreFocus(focus, cardContainer, () => {
      const sameCard = cardNodes.get(focusedId)?.controls;
      if (sameCard) return !sameCard['check-status'].disabled ? sameCard['check-status'] : sameCard.profile;
      return panelUi.query || panelHeading;
    });
  }
  function renderTargetCards() {
    const filterKey = JSON.stringify([state.query.trim().toLowerCase(), state.mode, state.minRatio, state.maxRatio, state.estimateDays]);
    if (filterKey !== cardFilterKey) { cardFilterKey = filterKey; visibleCardLimit = CARD_BATCH_SIZE; }
    updateExportControls();
    const now = Date.now(), freshPool = authorizedPoolFresh(), query = state.query.trim().toLowerCase();
    const selected = new Map();
    let range = 0, old = 0, unknown = 0, ready = 0, suggestions = 0;
    // Assess each target once for filtering, counts, ordering and its card.
    for (const target of state.targets) {
      const assessment = C.assess(target, state.player, state.maxRatio, now, state.minRatio, state.estimateDays);
      if (!assessment.allied && assessment.inRange) range++;
      if (assessment.ratio !== null && !assessment.fresh) old++;
      if (assessment.ratio === null) unknown++;
      if (assessment.suggested) suggestions++;
      if (freshPool && state.reservationsSupported && assessment.suggested && assessment.ready && !target.reserved) ready++;
      if (state.mode === 'suggested' && !assessment.suggested) continue;
      if (query && !`${target.id} ${target.name} ${target.faction?.name || ''} ${C.reason(target)}`.toLowerCase().includes(query)) continue;
      selected.set(target.id, { target, assessment });
    }
    const priority = ({ target, assessment }) => assessment.suggested
      ? target.reserved ? 1 : assessment.ready && freshPool && state.reservationsSupported ? 3 : 2 : 0;
    const orderKey = [...selected.values()].map(row => `${row.target.id}:${priority(row)}:${row.assessment.ratio}`).join('|');
    if (orderKey !== orderedRowsKey) {
      orderedRowsKey = orderKey;
      orderedIds = [...selected.values()].sort((a, b) => priority(b) - priority(a)
        || (a.assessment.ratio ?? Infinity) - (b.assessment.ratio ?? Infinity) || a.target.id - b.target.id).map(row => row.target.id);
    }
    const rows = orderedIds.map(id => selected.get(id));
    const summary = `${range} in stat range · ${old} estimates too old or undated · ${unknown} stats unknown · ${ready} ready now`;
    const shownReady = freshPool && state.reservationsSupported
      ? rows.filter(({ target, assessment }) => assessment.suggested && assessment.ready && !target.reserved).length : 0;
    const visibleRows = rows.slice(0, visibleCardLimit), visibleIds = visibleRows.map(row => row.target.id), visibleIdSet = new Set(visibleIds);
    setText(panelUi.countSummary, state.loading ? 'Loading targets…' : `${shownReady} ready · ${rows.length} ${rows.length > visibleRows.length ? 'matches' : 'shown'}`);
    setText(panelUi.countDetail, `${visibleRows.length} displayed · ${rows.length} matching · ${state.targets.length} in pool · ${suggestions} possible matches · ${summary}`);
    panelUi.moreCards.hidden = visibleRows.length >= rows.length;
    setText(panelUi.showMore, `Show more (${rows.length - visibleRows.length} remaining)`);
    lazyCardsObserver?.disconnect();
    if (!panelUi.moreCards.hidden && pageVisible()) lazyCardsObserver?.observe(panelUi.moreCards);
    cardContainer.setAttribute('aria-busy', String(state.loading));
    for (const [id, cached] of cardNodes) if (!visibleIdSet.has(id)) { cached.node.remove(); cardNodes.delete(id); }
    if (!rows.length) {
      const text = state.loading ? 'Loading the target pool for your faction…' : state.targets.length
        ? 'No targets match these filters. Try All targets or a different stat range.'
        : 'The target pool is empty. New targets will appear after the list for your faction is updated.';
      if (!emptyCard) { emptyCard = element('div', text, 'empty'); cardContainer.append(emptyCard); }
      else setText(emptyCard, text);
      mountedIds = []; return;
    }
    emptyCard?.remove(); emptyCard = null;
    for (const { target, assessment } of visibleRows) {
      const signature = JSON.stringify([target, assessment, freshPool, state.pendingChecks.has(target.id), state.loading,
        state.reservationsSupported, C.ageLabel(target.estimateUpdatedAt, now), C.ageLabel(target.lastAction, now),
        Boolean(target.status?.until > now / 1000), Date.parse(target.reservationExpiresAt) > now]);
      let cached = cardNodes.get(target.id);
      if (cached?.signature === signature) continue;
      if (!cached) {
        cached = { node: element('article', null, 'card'), signature: null };
        cached.node.setAttribute('data-target-id', String(target.id)); cardNodes.set(target.id, cached);
      }
      cached.signature = signature;
      const card = cached.node; card.replaceChildren();
      const top = element('div', null, 'cardhead'); const name = element('div');
      const profileLink = focusKey(link(`${target.name || 'Player'} [${target.id}] ↗`, `https://www.torn.com/profiles.php?XID=${target.id}`, 'name'), `target:${target.id}:profile`);
      name.append(profileLink,
        element('div', `${target.faction?.name || 'Faction unknown'}${target.level ? ` · Level ${target.level}` : ''}`, 'muted'));
      top.append(name); card.append(top);
      const metrics = element('div', null, 'metrics');
      const stats = element('div', null, 'estimate'); stats.setAttribute('aria-label', 'Estimated battle stats');
      stats.append(element('strong', C.compact(target.estimatedStats)),
        element('small', assessment.ratio === null ? 'Comparison unknown' : `${(assessment.ratio * 100).toFixed(0)}% of your stats`),
        element('small', `${C.estimateSourceLabel(target) || (target.estimatedStats > 0 ? 'Unknown source' : 'No estimate')} · ${C.ageLabel(target.estimateUpdatedAt, now)}`));
      const status = element('div', null, 'availability');
      const ownLease = !target.reserved && Date.parse(target.reservationExpiresAt) > now;
      const canAttack = assessment.suggested && assessment.ready && freshPool && !target.reserved && state.reservationsSupported;
      const unavailable = assessment.live && (target.status?.state !== 'Okay' || assessment.timedUnavailable);
      const availability = target.reserved ? 'Reserved by another NWA member' : unavailable ? target.status?.state || 'Unavailable' : ownLease ? 'Reserved by you'
        : !assessment.live ? 'Status needs checking' : canAttack ? 'Ready' : target.status?.state || 'Unknown';
      status.append(element('strong', availability), element('span', assessment.label, `badge ${assessment.tone}`));
      if (assessment.suggested && assessment.ready && !target.reserved && !freshPool) status.append(element('small', 'Refresh the list to open an attack'));
      if ((ownLease || target.reserved) && !assessment.live) status.append(element('small', 'Status needs checking'));
      if (!assessment.live && target.status?.state) status.append(element('small', `Last known: ${target.status.state}`));
      if (target.reserved && unavailable) status.append(element('small', target.status?.state || 'Unavailable'));
      if (ownLease && unavailable) status.append(element('small', 'Reserved by you'));
      if (ownLease || target.reserved) {
        const expiry = Date.parse(target.reservationExpiresAt);
        if (Number.isFinite(expiry) && expiry > now) status.append(element('small', `Held until ${new Date(expiry).toLocaleTimeString()}`));
      }
      if (target.status?.until > now / 1000) status.append(element('small', `Until ${new Date(target.status.until * 1000).toLocaleTimeString()}`));
      else if (!ownLease && !target.reserved) status.append(element('small', target.lastAction ? `Last active ${C.ageLabel(target.lastAction, now)}` : 'Activity unknown'));
      metrics.append(stats, status); card.append(metrics);
      if (C.reason(target)) card.append(element('div', `Reason: ${C.reason(target)}`, 'notes'));
      const actions = element('div', null, 'actions');
      const check = button(state.pendingChecks.has(target.id) ? 'Checking…' : 'Check status', () => void checkStatus(target.id), 'check-status'); check.disabled = state.pendingChecks.has(target.id) || state.loading;
      focusKey(check, `target:${target.id}:check-status`);
      cached.controls = { 'check-status': check, profile: profileLink };
      actions.append(check);
      const guardAttack = event => {
        if (!state.reservationsSupported) {
          event.preventDefault(); message(COORDINATION_UNAVAILABLE); renderCards(); return false;
        }
        const latest = state.targets.find(t => t.id === target.id);
        const currentAssessment = latest && assessTarget(latest);
        if (!latest || !state.token || Date.parse(state.expiresAt) <= Date.now() || !authorizedPoolFresh()
            || latest.reserved || !currentAssessment.suggested || !currentAssessment.ready) {
          event.preventDefault(); message('Check the status and stat range for this target before opening an attack.'); renderCards(); return false;
        }
        return true;
      };
      if (canAttack) {
        const attack = button(state.pendingChecks.has(target.id) ? 'Reserving…' : 'Attack ↗', event => {
          if (guardAttack(event)) void checkStatus(target.id, true);
        }, 'attack');
        attack.disabled = state.pendingChecks.has(target.id); actions.append(attack);
        focusKey(attack, `target:${target.id}:attack`);
        cached.controls.attack = attack;
      } else if (assessment.suggested && assessment.ready && freshPool && !target.reserved && !state.reservationsSupported) {
        status.append(element('small', 'Target coordination unavailable. Refresh the list.'));
      }
      card.append(actions);
    }
    if (mountedIds.length !== visibleIds.length || mountedIds.some((id, index) => id !== visibleIds[index])) {
      for (const id of visibleIds) cardContainer.append(cardNodes.get(id).node);
      mountedIds = visibleIds;
    }
  }

  function toggle(open, opener = null) {
    if (disposed) return;
    const wasOpen = state.open;
    if (open && !wasOpen) panelOpener = opener || settings;
    state.open = open; panel.hidden = !open; settings.setAttribute('aria-expanded', String(open));
    if (open) {
      findNotice(''); render();
      // A heading starts keyboard navigation inside the nonmodal panel without
      // opening the phone keyboard. Automatic error displays leave focus alone.
      if (!wasOpen && opener) panelHeading.focus?.({ preventScroll: true });
    } else {
      lazyCardsObserver?.disconnect(); findNotice(finderStatus.textContent || quickNotice.textContent || '');
      if (wasOpen) (panelOpener.disabled ? settings : panelOpener).focus?.({ preventScroll: true });
    }
    if (open && state.token && !state.finding && Date.now() - state.lastPoolAttemptAt >= 1000) {
      void loadTargets(false, false, Boolean(state.player));
    }
  }
  const saved = platform.getValue(storageKey, null);
  if (saved?.token && Date.parse(saved.expiresAt) > Date.now()) {
    state.token = saved.token; state.expiresAt = saved.expiresAt;
  } else if (!storageWarning) persist(() => platform.deleteValue(storageKey));
  function updateViewport() {
    const viewport = window.visualViewport;
    if (viewport && Number.isFinite(viewport.height) && viewport.height > 0 && host.isConnected !== false) {
      host.style.setProperty('--nwa-viewport-height', `${viewport.height}px`);
      host.style.setProperty('--nwa-viewport-top', `${Math.max(0, viewport.offsetTop || 0)}px`);
    }
  }
  updateViewport();
  listen(window.visualViewport, 'resize', updateViewport);
  listen(window.visualViewport, 'scroll', updateViewport);
  listen(root, 'keydown', event => { if (event.key === 'Escape' && state.open) { event.preventDefault(); toggle(false); } });
  listen(root, 'focusout', () => {
    later(() => {
      if (state.backgroundRenderPending && state.open && !editingControl()) render();
    }, 0);
  });
  listen(document, 'visibilitychange', () => {
    updatePageNotice();
    if (!pageVisible()) lazyCardsObserver?.disconnect();
    if (pageVisible() && state.token && Date.parse(state.expiresAt) > Date.now() && !state.busy) {
      void loadTargets(false, false, Boolean(state.player));
    }
  });
  listen(window, 'popstate', updatePageNotice);
  listen(window, 'hashchange', updatePageNotice);
  listen(window, 'resize', schedulePageNotice);
  listen(window, 'scroll', schedulePageNotice, { passive: true, capture: true });
  listen(window.visualViewport, 'resize', schedulePageNotice);
  listen(window.visualViewport, 'scroll', schedulePageNotice);
  function dispose() {
    if (disposed) return;
    disposed = true; state.generation++; state.targetGeneration++; state.findGeneration++; state.suggestionGeneration++;
    state.finding = false; state.token = null;
    if (typeof clearInterval === 'function') clearInterval(maintenanceTimer);
    for (const id of taskTimers) clearTimeout(id);
    taskTimers.clear();
    for (const cancel of [...pendingRequests]) cancel();
    for (const remove of lifecycleListeners) remove();
    lifecycleListeners.length = 0;
    pageNoticeObserver?.disconnect(); pageNoticeResizeObserver?.disconnect(); lazyCardsObserver?.disconnect();
    removePageNotice(); clearExport();
    for (const url of downloadUrls) { try { URL.revokeObjectURL(url); } catch { /* Already released by the WebView. */ } }
    downloadUrls.clear();
  }
  host.__nwaDispose = dispose; listen(host, 'nwa:dispose', dispose);
  // Expire the session and checked attack links even while the panel is idle.
  const maintenanceTimer = setInterval(() => {
    if (disposed) return;
    updatePageNotice();
    if (state.token && Date.parse(state.expiresAt) <= Date.now()) {
      if (!restoreNewerSession()) { clearSession(); message('Session expired. Sign in again.'); render(); }
    }
    else if (pageVisible() && state.open && state.player && !state.pendingChecks.size) {
      let expired = false;
      state.targets = state.targets.map(target => {
        if (target.checkedAt && !assessTarget(target).live) {
          expired = true; return { ...target, checkedAt: null };
        }
        return target;
      });
      if (expired) renderCards();
    }
    const refreshMs = state.open || C.pageTargetId(window.location?.href) || Date.now() - state.lastFindAt < 120_000
      ? FEED_REFRESH_MS : IDLE_FEED_REFRESH_MS;
    if (state.token && pageVisible() && !state.busy && !state.finding && !state.pendingChecks.size && !state.loading && !state.backgroundLoading
        && Date.now() >= state.nextFeedAt && Date.now() - state.lastPoolAttemptAt >= refreshMs) {
      void loadTargets(false, false, Boolean(state.player));
    }
  }, 5000);
  if (storageWarning) message(storageWarning);
  render();
  if (state.token && pageVisible()) void loadTargets();
}

})();
