// Keep this service hostname and @connect in metadata.txt in sync when deploying elsewhere.
const CONFIG = Object.freeze({ serviceUrl: 'https://targetlist.grusmedia.no', version: '0.15.3' });

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
  const serviceClock = C.createServiceClock();
  const serviceNow = () => serviceClock.now();
  const monotonicNow = () => typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now();
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
    excludedFactionIds: Array.isArray(preferences?.excludedFactionIds) ? C.parseExcludedFactions(preferences.excludedFactionIds.join(',')) || [] : [],
    excludedFactionNames: {},
    avoidActive: preferences?.avoidActive === true,
    activityMinutes: Number.isSafeInteger(preferences?.activityMinutes) && preferences.activityMinutes >= 1 && preferences.activityMinutes <= 10080 ? preferences.activityMinutes : 15,
    targetExclusionsSupported: false,
    estimateDays: Number.isSafeInteger(preferences?.estimateDays) && preferences.estimateDays >= 1 && preferences.estimateDays <= 365
      ? preferences.estimateDays : C.DEFAULT_ESTIMATE_DAYS,
    recentTargets: C.recentTargets(preferences?.recentTargets), reservationsSupported: false, nextTargetSupported: null,
    backendNotice: '', retryAttempt: null, lastFindAt: 0, feedFailures: 0, nextFeedAt: 0, hardRetryAt: 0,
    lastTargetId: Number.isSafeInteger(preferences?.lastTargetId) ? preferences.lastTargetId : null,
    finding: false, findGeneration: 0, findAfterLogin: false,
    pendingChecks: new Set(), loading: false, targetGeneration: 0, view: 'targets',
    suggestionView: 'pending', suggestions: [], nextSuggestionOffset: null, canReview: false,
    suggestionsLoading: false, suggestionGeneration: 0, suggestionMutation: null, suggestionNotice: '', removalSupported: false, removalOpen: false,
    removalDraft: { type: 'player', targetId: '', reason: '', confirm: false },
    adminDraft: { type: 'player', targetId: '', comment: '' }, adminPending: null,
    pagePermissions: { status: 'unknown', checkedAt: 0 },
    pendingSuggestionDetailsSupported: false, pendingSuggestions: { status: 'unsupported', revision: null, playerIds: [] }, pendingPlayerIds: new Set(), pendingSuggestionEpoch: 0,
    suggestionDraft: { type: 'player', targetId: '', comment: '' }
  };
  for (const id of state.excludedFactionIds) {
    const name = preferences?.excludedFactionNames?.[id];
    if (typeof name === 'string' && name.trim() && name.length <= 100) state.excludedFactionNames[id] = name.trim();
  }
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
    .scroll{overflow-anchor:none;overflow:auto;min-height:0;padding:14px 16px;overscroll-behavior:contain;scrollbar-gutter:stable}.login{display:grid;gap:13px}.login input{width:100%;margin-top:5px}
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
    .personal-preferences{border-top:1px solid var(--line);margin-top:12px;padding-top:4px}.personal-preferences>summary{padding:10px 0;color:var(--accent);font-size:12px}.personal-help{color:var(--muted);font-size:11px;margin:4px 0 8px}
    .preferences{border-top:1px solid var(--line);margin-top:14px;padding-top:4px}.preferences>summary{padding:10px 0;font-size:12px;color:var(--muted)}.preferences-body{padding:4px 0 2px}.preferences h3{font-size:12px;font-weight:650;margin:10px 0 6px}.account{display:flex;align-items:center;justify-content:space-between;gap:10px;border-top:1px solid var(--line);padding-top:12px;margin-top:14px}.account button{font-size:11px}.account .muted{font-size:10px}
    .avoid-settings{display:grid;gap:8px;margin:12px 0}.avoid-settings select{width:100%;max-width:100%}.avoid-settings label{display:grid;gap:5px}.avoid-settings .avoid-active{display:flex;align-items:center;gap:7px}.avoid-settings input[type=number]{width:100%;max-width:130px}.avoided-factions{display:grid;gap:6px}.avoided-faction{display:flex;align-items:center;justify-content:space-between;gap:8px;min-width:0}.avoided-faction span{min-width:0;overflow-wrap:anywhere}.avoided-faction button{flex:0 0 auto;min-height:36px}
    .footnote{margin-top:14px;font-size:11px;color:var(--muted)}.pool-footer{display:flex;justify-content:space-between;gap:8px;margin-top:10px;font-size:10px;color:var(--muted)}.pool-warnings{color:#efd49a;font-size:11px;overflow-wrap:anywhere}.pool-warnings p{margin:8px 0}
    .tabs{display:flex;gap:18px;flex-wrap:wrap;margin:10px 0 0;border-bottom:1px solid var(--line)}.tabs button{border:0;border-bottom:2px solid transparent;border-radius:0;padding:7px 0;background:transparent;color:var(--muted);font-size:12px}.tabs button[aria-pressed=true]{border-bottom-color:var(--accent);color:var(--text)}
    .suggestionform{display:grid;gap:12px;margin:14px 0 20px}.suggestionfields{display:grid;grid-template-columns:140px 1fr;gap:10px}
    .suggestionform input,.suggestionform select,.suggestionform textarea{display:block;width:100%;margin-top:5px}.suggestionform textarea{resize:vertical;min-height:84px}.removal-confirm{display:flex;align-items:flex-start;gap:8px}.removalform input[type="checkbox"]{display:inline-block;flex:0 0 auto;width:auto;min-height:0;margin-top:3px}.removal-confirm span{flex:1}
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

  function message(text) {
    const viewport = captureListViewport();
    state.error = text; errorBox.textContent = text; errorBox.hidden = !text;
    restoreListViewport(viewport);
  }
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
    estimateDays: state.estimateDays, lastTargetId: state.lastTargetId, recentTargets: C.recentTargets(state.recentTargets),
    excludedFactionIds: state.excludedFactionIds, avoidActive: state.avoidActive, activityMinutes: state.activityMinutes,
    ...(Object.keys(state.excludedFactionNames).length ? { excludedFactionNames: state.excludedFactionNames } : {}) })); }
  function assessTarget(target) { return C.assess(target, state.player, state.maxRatio, serviceNow(), state.minRatio, state.estimateDays); }
  function rememberTarget(id) {
    state.lastTargetId = id;
    state.recentTargets = C.recentTargets([...state.recentTargets.filter(value => value.id !== id), { id, at: Date.now() }]);
    savePreferences();
  }
  function saveSession() {
    return platform.setValue(storageKey, { token: state.token, expiresAt: state.expiresAt });
  }
  function clearSession({ preserveClock = false } = {}) {
    const clearedToken = state.token;
    if (!preserveClock) serviceClock.reset();
    pageSuggestedIds.clear(); pageSuggestion = { id: null, comment: '', message: '' }; pagePendingDetails = null; state.pendingSuggestionDetailsSupported = false;
    state.pendingSuggestionEpoch++; state.pendingSuggestions = { status: 'unsupported', revision: null, playerIds: [] }; state.pendingPlayerIds.clear();
    cancelFind(); state.findAfterLogin = false;
    clearExport();
    state.generation++; state.token = null; state.player = null; state.targets = []; state.warnings = []; state.poolLoadedAt = 0;
    state.feedTargets = []; state.feedCursor = null; state.reservationsSupported = false; state.nextTargetSupported = null;
    state.targetExclusionsSupported = false;
    state.retryAttempt = null; state.backendNotice = ''; state.feedFailures = 0; state.nextFeedAt = 0; state.hardRetryAt = 0;
    state.authorizedPool = false; state.backgroundLoading = false; state.targetLoad = null; state.lastPoolAttemptAt = 0;
    state.backgroundRenderPending = false;
    state.pendingChecks.clear(); state.busy = false; state.loading = false; state.targetGeneration++; state.expiresAt = null;
    state.removingKey = false;
    state.view = 'targets'; state.suggestionView = 'pending'; state.suggestions = []; state.nextSuggestionOffset = null;
    state.removalSupported = false; state.removalOpen = false; state.removalDraft = { type: 'player', targetId: '', reason: '', confirm: false };
    state.adminDraft = { type: 'player', targetId: '', comment: '' }; state.adminPending = null;
    state.pagePermissions = { status: 'unknown', checkedAt: 0 };
    pageAdminDraft = { id: null, reason: '', confirm: false, feedback: '' };
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
      || !(Date.parse(saved.expiresAt) > serviceNow())) return false;
    clearSession({ preserveClock: true });
    state.token = saved.token; state.expiresAt = saved.expiresAt;
    // Restore through the backend before showing protected data or allowing a hit.
    void loadTargets();
    return true;
  }
  function handleError(error) {
    if (error.code === 'REVIEW_NOT_ALLOWED') { state.canReview = false; state.pagePermissions = { status: 'ready', checkedAt: Date.now() }; }
    const authStatus = error.status === 401 || error.status === 403;
    const confirmed = ['SESSION_REQUIRED', 'SESSION_EXPIRED', 'FACTION_NOT_ALLOWED', 'FACTION_CHANGED',
      'KEY_REJECTED', 'LIMITED_KEY_REQUIRED', 'KEY_PERMISSIONS_REQUIRED', 'INVALID_KEY', 'KEY_ACCESS',
      'SESSION_REVOKED', 'KEY_REVOKED', 'INVALID_SESSION'].includes(error.code);
    if (authStatus && confirmed) {
      if (restoreNewerSession()) return;
      clearSession(); toggle(true); render();
    } else if (authStatus && !['FRIENDLY_TARGET', 'TARGET_NOT_FOUND', 'TARGET_LEFT_FACTION', 'PLAYER_NOT_FOUND', 'REVIEW_NOT_ALLOWED'].includes(error.code)) {
      // An ambiguous proxy/service denial cannot prove that the saved token
      // expired. Hide protected data but keep the credential for a later retry.
      state.authorizedPool = false; state.targets = []; clearExport(); updatePageNotice(); render();
    }
    message(error.message || 'The request failed. Try again shortly.');
  }
  function request(method, path, body, token = state.token, timeoutMs = 20000) {
    const requestStarted = monotonicNow();
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
          serviceClock.observe(data?.serverTime, monotonicNow() - requestStarted);
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
      if (data?.keyStorage?.mode !== 'encrypted' || !Number.isFinite(storedUntil) || storedUntil <= serviceNow()
          || storedUntil > serviceNow() + 7 * 24 * 60 * 60 * 1000 + 5000) {
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
    return Boolean(state.token && state.player && Date.parse(state.expiresAt) > serviceNow()
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
    const now = serviceNow(), shown = panelUi.exportScope.value === 'shown';
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
  let pageSuggestion = { id: null, comment: '', message: '' }, pagePendingDetails = null;
  let pageNoticePendingInfo = null, pageNoticePendingAuthor = null, pageNoticePendingReason = null, pageNoticePendingMessage = null, pageNoticePendingRetry = null;
  let pageAdminControls = null, pageAdminSignature = null;
  let pageAdminDraft = { id: null, reason: '', confirm: false, feedback: '' };
  const pageSuggestedIds = new Set();
  function pageAdminMessage(text, id) {
    if (id !== pageAdminDraft.id || C.pageTargetId(window.location?.href) !== id) return;
    pageAdminDraft.feedback = text; pageAdminSignature = null; updatePageNotice();
  }
  function loadPageAdminAccess(force = false) {
    if (!state.token || state.removingKey || !pageNoticeDetails?.open || !authorizedPoolFresh()) return;
    const previous = state.pagePermissions;
    if (previous.status === 'loading' || !force && previous.status !== 'unknown' && Date.now() - previous.checkedAt < 300000) return;
    const generation = state.generation, entry = { status: 'loading', checkedAt: Date.now() };
    state.pagePermissions = entry;
    void (async () => {
      try {
        const data = await request('GET', '/api/permissions', undefined, state.token, 5000);
        if (generation !== state.generation || state.pagePermissions !== entry) return;
        if (typeof data?.canManageTargets !== 'boolean') throw new Error('Admin access could not be verified.');
        state.canReview = data.canManageTargets; entry.status = 'ready'; entry.checkedAt = Date.now();
      } catch (error) {
        if (generation !== state.generation || state.pagePermissions !== entry) return;
        state.canReview = false; entry.status = error.status === 404 ? 'unsupported' : 'error'; entry.checkedAt = Date.now();
        if (error.status === 401 || error.status === 403) handleError(error);
      } finally {
        if (generation === state.generation && state.pagePermissions === entry) { render(); updatePageNotice(); }
      }
    })();
  }
  function pageAdminEligible(id, listed) {
    return pageVisible() && pageNoticeDetails?.open && C.pageTargetId(window.location?.href) === id && pageSuggestion.id === id
      && authorizedPoolFresh() && state.canReview && state.pagePermissions.status === 'ready'
      && Date.now() - state.pagePermissions.checkedAt < 300000
      && state.targets.some(target => target.id === id) === listed;
  }
  function renderPageAdminControls(id, target) {
    if (!pageAdminControls) return;
    if (!pageNoticeDetails.open) { pageAdminControls.hidden = true; pageAdminSignature = null; return; }
    if (pageNoticeDetails.open) loadPageAdminAccess();
    const access = state.pagePermissions, pending = state.pendingPlayerIds.has(id) || pageSuggestedIds.has(id) || Boolean(state.adminPending);
    const signature = JSON.stringify([id, Boolean(target), access.status, access.checkedAt, state.canReview, pending,
      state.suggestionMutation, state.removingKey, state.removalSupported, pageAdminDraft.feedback]);
    if (signature === pageAdminSignature) return;
    pageAdminSignature = signature;
    const noticeRoot = pageAdminControls.getRootNode(), active = noticeRoot.activeElement;
    const focused = pageAdminControls.contains(active), focus = focused && active.getAttribute?.('data-focus-key');
    pageAdminControls.replaceChildren(); pageAdminControls.hidden = access.status === 'ready' && !state.canReview;
    const busy = Boolean(state.suggestionMutation || state.removingKey);
    if (access.status === 'error' || access.status === 'unsupported') {
      pageAdminControls.append(element('p', access.status === 'unsupported' ? 'Update the NWA backend to enable page admin actions.' : 'Admin access could not be checked.', 'quick-help'));
      const retry = button('Check admin access', () => { loadPageAdminAccess(true); updatePageNotice(); }); retry.disabled = busy; pageAdminControls.append(retry);
    } else if (access.status !== 'ready') {
      pageAdminControls.append(element('p', access.status === 'loading' ? 'Checking admin access...' : 'Admin access is checked when opened.', 'quick-help'));
    } else if (state.canReview) {
      pageAdminControls.append(element('p', 'Admin · Player [' + id + ']', 'quick-help'));
      if (pageAdminDraft.feedback) { const feedback = element('p', pageAdminDraft.feedback, 'quick-feedback'); feedback.setAttribute('role', 'status'); pageAdminControls.append(feedback); }
      if (!target) {
        if (pending) {
          const review = button('Review in NWA', () => { state.view = 'suggestions'; toggle(true); void loadSuggestions(state.adminPending ? 'mine' : 'pending'); });
          review.disabled = busy; pageAdminControls.append(review);
        } else if (state.pendingSuggestions.status !== 'unavailable') {
          const add = focusKey(button(state.suggestionMutation === 'admin-add' ? 'Adding...' : 'Add and approve', () => {
            if (!pageAdminEligible(id, false)) return;
            void addAdminTarget({ type: 'player', targetId: String(id), comment: pageNoticeComment.value }, true);
          }), 'page-admin:add');
          add.disabled = busy; pageAdminControls.append(add);
        }
      } else if (!state.removalSupported) {
        pageAdminControls.append(element('p', 'Update the NWA backend to enable target removal.', 'quick-help'));
      } else {
        const form = element('form', null, 'quick-form page-admin-removal');
        const label = element('label', 'Removal reason (required)'), reason = focusKey(element('textarea'), 'page-admin:reason');
        reason.required = true; reason.rows = 2; reason.maxLength = 2000; reason.disabled = busy; reason.value = pageAdminDraft.reason;
        reason.setAttribute('aria-label', 'Reason for removing this player');
        reason.addEventListener('input', () => { if (!state.suggestionMutation && pageAdminDraft.id === id) pageAdminDraft.reason = reason.value; }); label.append(reason);
        const confirmation = element('label', null, 'page-admin-confirm'), confirm = focusKey(element('input'), 'page-admin:confirm');
        confirm.type = 'checkbox'; confirm.required = true; confirm.disabled = busy; confirm.checked = pageAdminDraft.confirm;
        confirm.setAttribute('aria-label', 'Confirm removing this player');
        confirm.addEventListener('change', () => { if (!state.suggestionMutation && pageAdminDraft.id === id) pageAdminDraft.confirm = confirm.checked; });
        confirmation.append(confirm, element('span', 'Remove this player from the shared NWA list.'));
        const remove = focusKey(element('button', state.suggestionMutation === 'remove' ? 'Removing...' : 'Remove from NWA'), 'page-admin:remove'); remove.type = 'submit'; remove.disabled = busy;
        form.append(label, confirmation, remove); form.addEventListener('submit', event => {
          event.preventDefault(); if (!pageAdminEligible(id, true)) return;
          void removeTargetsFromList({ type: 'player', targetId: String(id), reason: pageAdminDraft.reason, confirm: pageAdminDraft.confirm }, true);
        }); pageAdminControls.append(form);
      }
    }
    if (focused && pageNoticeDetails.open) {
      const replacement = focus && [...pageAdminControls.querySelectorAll('[data-focus-key]')].find(node => node.getAttribute('data-focus-key') === focus && !node.disabled);
      (replacement || pageNoticeSummary).focus?.({ preventScroll: true });
    }
  }
  function pageSuggestionMessage(text, id) {
    if (id !== pageSuggestion.id || C.pageTargetId(window.location?.href) !== id) return;
    pageSuggestion.message = text; updatePageNotice();
  }
  function loadPagePendingDetails(id, force = false) {
    if (!state.pendingSuggestionDetailsSupported || !state.pendingPlayerIds.has(id) || !pageNoticeDetails?.open) return;
    const previous = pagePendingDetails;
    if (!force && previous?.id === id && previous.epoch === state.pendingSuggestionEpoch
      && (previous.status === 'loading' || Date.now() - previous.loadedAt < 60000)) return;
    const generation = state.generation, entry = { id, epoch: state.pendingSuggestionEpoch, status: 'loading', loadedAt: Date.now() };
    pagePendingDetails = entry;
    const current = () => !disposed && pagePendingDetails === entry && generation === state.generation
      && entry.epoch === state.pendingSuggestionEpoch && C.pageTargetId(window.location?.href) === id && state.pendingPlayerIds.has(id);
    void (async () => {
      try {
        const data = await request('GET', '/api/suggestions/players/' + id + '/pending', undefined, state.token, 5000);
        if (!current()) return;
        if (!data || !Object.hasOwn(data, 'suggestion')) throw new Error('Invalid suggestion details.');
        const row = data.suggestion;
        if (row === null) { entry.status = 'gone'; void loadTargets(true, false, true); return; }
        if (row.type !== 'player' || row.status !== 'pending' || row.targetId !== id || typeof row.comment !== 'string'
          || !row.comment.trim() || row.comment.length > 1000 || !Number.isSafeInteger(row.suggestedBy?.id)
          || row.suggestedBy.id <= 0 || row.suggestedBy.id > 2147483647 || typeof row.suggestedBy.name !== 'string'
          || !row.suggestedBy.name.trim() || row.suggestedBy.name.length > 1000) throw new Error('Invalid suggestion details.');
        entry.status = 'ready'; entry.suggestion = row; entry.loadedAt = Date.now();
      } catch (error) {
        if (!current()) return;
        entry.status = 'error'; entry.loadedAt = Date.now();
        if (error.status === 401 || error.status === 403) handleError(error);
      } finally {
        if (pagePendingDetails === entry) {
          if (!current()) pagePendingDetails = null;
          updatePageNotice();
        }
      }
    })();
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
    pageNoticePendingInfo = null; pageNoticePendingAuthor = null; pageNoticePendingReason = null; pageNoticePendingMessage = null; pageNoticePendingRetry = null;
    pageNoticeMode = null; pageNoticeForm = null; pageNoticeComment = null; pageNoticeSubmit = null; pageNoticeFeedback = null; pageNoticeTitle = null; pageNoticeQuickHeading = null;
    pageNotice = null; pageNoticeReason = null; pageNoticeFullReason = null; pageNoticeSummary = null;
    pageNoticeEstimate = null; pageNoticeEstimateDetail = null; pageNoticeDetail = null; pageNoticeDetails = null;
    pageAdminControls = null; pageAdminSignature = null;
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
    const editable = pageNoticeMode === 'suggest' || state.pagePermissions.status === 'ready' && state.canReview;
    const preferredHeight = Math.min(editable ? 320 : 200, match.viewportHeight * (editable ? 0.6 : 0.4));
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
    const authorized = id && id <= 2147483647 && state.player && state.token && Date.parse(state.expiresAt) > serviceNow() && authorizedPoolFresh();
    const target = authorized ? state.targets.find(target => target.id === id) : null;
    if (!authorized || !target && id === state.player.id) { observeNoticeArea(null); removePageNotice(); return; }
    const mode = target ? 'listed' : 'suggest';
    if (pageNoticeMode !== mode) removePageNotice();
    if (pageSuggestion.id !== id) {
      removePageNotice();
      pageSuggestion = { id, comment: '', message: '' }; pagePendingDetails = null;
      pageAdminDraft = { id, reason: '', confirm: false, feedback: '' };
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
        .pending-info{display:grid;gap:5px;margin-top:7px}.pending-author{color:#c7d6a7}.pending-reason{white-space:pre-wrap}
        .quick-form{display:grid;gap:7px}.quick-form label{display:grid;gap:4px;font-weight:600}
        textarea{display:block;width:100%;min-height:64px;resize:vertical;max-height:130px;border:1px solid #52525b;border-radius:4px;background:#27272a;color:#f4f4f5;padding:6px;font:12px/1.4 Arial,Helvetica,sans-serif}
        textarea:focus-visible,button:focus-visible{outline:2px solid #9fbd57;outline-offset:2px}
        button{min-height:30px;border:1px solid #52525b;border-radius:4px;padding:4px 8px;background:#27272a;color:#f4f4f5;font:12px Arial,Helvetica,sans-serif;cursor:pointer}
        button[type="submit"]{background:#3f4d22;border-color:#9fbd57}button:disabled{opacity:.6;cursor:wait}
        .quick-actions{display:flex;gap:6px}.quick-feedback{margin-top:6px;white-space:pre-wrap}.quick-help{color:#a1a1aa;font-size:10px}
        .page-admin{display:grid;gap:7px;margin-top:8px;padding-top:7px;border-top:1px solid #52525b}.page-admin-confirm{display:flex!important;grid-template-columns:none;align-items:start;gap:6px;font-weight:400!important}.page-admin-confirm input{flex:0 0 auto;margin:2px 0}.page-admin button{min-height:36px}
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
        pageNoticePendingInfo = element('div', null, 'pending-info'); pageNoticePendingInfo.hidden = true;
        pageNoticePendingAuthor = element('a', null, 'pending-author'); pageNoticePendingAuthor.setAttribute('target', '_blank'); pageNoticePendingAuthor.setAttribute('rel', 'noopener noreferrer');
        pageNoticePendingReason = element('p', null, 'pending-reason');
        pageNoticePendingMessage = element('p', null, 'pending-message'); pageNoticePendingMessage.setAttribute('role', 'status'); pageNoticePendingMessage.setAttribute('aria-live', 'polite');
        pageNoticePendingRetry = element('button', 'Retry details'); pageNoticePendingRetry.type = 'button';
        pageNoticePendingRetry.addEventListener('click', () => { loadPagePendingDetails(pageSuggestion.id, true); updatePageNotice(); });
        pageNoticePendingInfo.append(pageNoticePendingAuthor, pageNoticePendingReason, pageNoticePendingMessage, pageNoticePendingRetry);
        pageNoticeDetail.append(pageNoticeForm, pageNoticeFeedback, pageNoticePendingInfo);
      }
      pageAdminControls = element('div', null, 'page-admin'); pageNoticeDetail.append(pageAdminControls);
      pageNoticeDetails.append(pageNoticeSummary, pageNoticeDetail); notice.append(pageNoticeDetails);
      noticeRoot.append(style, notice);
      pageNoticeDetails.addEventListener('toggle', () => {
        if (!pageNoticeDetails?.open) return;
        updatePageNotice();
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
      pageNoticePendingInfo.hidden = !sharedPending;
      if (sharedPending) {
        loadPagePendingDetails(id);
        const details = pagePendingDetails?.id === id ? pagePendingDetails : null, ready = details?.status === 'ready';
        pageNoticePendingAuthor.hidden = !ready; pageNoticePendingReason.hidden = !ready;
        pageNoticePendingRetry.hidden = details?.status !== 'error';
        const text = !state.pendingSuggestionDetailsSupported ? 'Submitter and reason are not available on this server yet.'
          : details?.status === 'error' ? 'Could not load suggestion details. Try again.'
          : details?.status === 'gone' ? 'This suggestion is no longer pending. Updating NWA...'
          : ready ? '' : 'Loading suggestion details...';
        if (pageNoticePendingMessage.textContent !== text) pageNoticePendingMessage.textContent = text;
        pageNoticePendingMessage.hidden = !text;
        if (ready) {
          const row = details.suggestion, author = 'Suggested by: ' + row.suggestedBy.name + ' [' + row.suggestedBy.id + ']';
          if (pageNoticePendingAuthor.textContent !== author) pageNoticePendingAuthor.textContent = author;
          pageNoticePendingAuthor.setAttribute('href', 'https://www.torn.com/profiles.php?XID=' + row.suggestedBy.id);
          if (pageNoticePendingReason.textContent !== 'Reason: ' + row.comment) pageNoticePendingReason.textContent = 'Reason: ' + row.comment;
        }
      }
      renderPageAdminControls(id, null); positionPageNotice(id); observeNoticeArea(id); return;
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
      ? `Estimated battle stats: ${estimate} · ${C.estimateSourceLabel(target) || 'Unknown source'} · ${C.ageLabel(target.estimateUpdatedAt, serviceNow())}${fresh ? '' : ' · Estimate needs refresh'}`
      : 'Estimated battle stats: Unknown · No estimate available';
    if (pageNoticeEstimate.textContent !== estimate) pageNoticeEstimate.textContent = estimate;
    if (pageNoticeEstimate.parentElement.getAttribute('data-known') !== String(known)) pageNoticeEstimate.parentElement.setAttribute('data-known', String(known));
    if (pageNoticeEstimate.parentElement.getAttribute('data-stale') !== String(known && !fresh)) pageNoticeEstimate.parentElement.setAttribute('data-stale', String(known && !fresh));
    if (pageNoticeEstimateDetail.textContent !== estimateDetail) pageNoticeEstimateDetail.textContent = estimateDetail;
    const description = `${estimateDetail}. ${text}`;
    if (pageNoticeSummary.title !== description) { pageNoticeSummary.title = description; pageNoticeSummary.setAttribute('aria-label', `NWA target list. ${description}`); }
    renderPageAdminControls(id, target); positionPageNotice(id); observeNoticeArea(id);
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
            if (pagePendingDetails && !state.pendingPlayerIds.has(pagePendingDetails.id)) pagePendingDetails = null;
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
        state.targetExclusionsSupported = data.capabilities?.targetExclusions === true;
        state.pendingSuggestionDetailsSupported = data.capabilities?.pendingSuggestionDetails === true;
        state.removalSupported = data.capabilities?.targetRemoval === true;
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
    if (!state.token || Date.parse(state.expiresAt) <= serviceNow()) {
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
      && targetGeneration === state.targetGeneration && state.token && Date.parse(state.expiresAt) > serviceNow();
    try {
      if ((state.excludedFactionIds.length || state.avoidActive) && !state.player) {
        await loadTargets(false, true, false, 5000); targetGeneration = state.targetGeneration;
        if (!current()) return;
      }
      if ((state.excludedFactionIds.length || state.avoidActive) && !state.targetExclusionsSupported) {
        findNotice('Update the NWA backend to use faction and activity exclusions in the target finder. Your filters remain saved.'); return;
      }
      if (state.nextTargetSupported !== false) {
        const selection = { minRatio: state.minRatio, maxRatio: state.maxRatio, estimateDays: state.estimateDays,
          recentTargetIds: C.recentTargets(state.recentTargets).slice(-50).map(row => row.id), query: state.query.trim().slice(0, 200), timeoutMs: 8000 };
        if (state.excludedFactionIds.length || state.avoidActive) {
          selection.excludedFactionIds = state.excludedFactionIds;
          selection.minInactiveMinutes = state.avoidActive ? state.activityMinutes : 0;
        }
        const signature = JSON.stringify(selection);
        if (!state.retryAttempt || state.retryAttempt.signature !== signature) {
          state.retryAttempt = { signature, requestId: typeof crypto !== 'undefined' && crypto.randomUUID
            ? crypto.randomUUID() : `nwa_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}_${Math.random().toString(36).slice(2)}` };
        }
        const attempt = state.retryAttempt;
        try {
          const data = await request('POST', '/api/targets/next', { ...selection, requestId: attempt.requestId }, state.token, 10000);
          if (!current()) return;
          const invalid = detail => new Error(`NWA could not verify the reserved target: ${detail}. Try again.`);
          if (!data?.player?.battleStats || !Number.isSafeInteger(data?.target?.id) || data.target.id <= 0 || data.target.id > 2147483647) {
            throw invalid('the response was incomplete');
          }
          const verifiedAt = serviceNow();
          const assessment = C.assess(data.target, data.player, state.maxRatio, verifiedAt, state.minRatio, state.estimateDays);
          if (!(Date.parse(data.target.reservationExpiresAt) > verifiedAt) || data.target.reserved) throw invalid('the reservation is no longer available');
          if (C.avoidReason(data.target, state, verifiedAt) || !assessment.suggested) throw invalid('the target no longer matches your preferences');
          if (!assessment.live) throw invalid('the status check is too old or has an invalid time');
          if (!assessment.ready) throw invalid('the player is no longer available');
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
            if (state.excludedFactionIds.length || state.avoidActive) throw new Error('Update the NWA backend to apply your faction and activity exclusions.');
          } else if (error.code === 'NO_TARGET_AVAILABLE') {
            findNotice('No matching targets are available right now. Adjust your filters or try again shortly.'); return;
          } else throw error;
        }
      }
      if (!state.player || !authorizedPoolFresh()
          || !C.select(state.targets, state.player, { ...state, mode: 'suggested' }, serviceNow()).length) {
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
      const matches = C.select(state.targets, state.player, { ...state, mode: 'suggested' }, serviceNow());
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
        if (!state.reservationsSupported || !(Date.parse(checked.reservationExpiresAt) > serviceNow())) {
          throw new Error('NWA could not reserve this target. Try again.');
        }
        state.targets = state.targets.map(row => row.id === target.id ? { ...row, ...checked } : row);
        const latest = state.targets.find(row => row.id === target.id);
        const assessment = latest && assessTarget(latest);
        if (!assessment?.suggested || !assessment.ready || C.avoidReason(latest, state, serviceNow())) continue;
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
        if (state.token && Date.parse(state.expiresAt) <= serviceNow()) {
          if (!restoreNewerSession()) { clearSession(); message('Session expired. Sign in again.'); findNotice('Session expired. Open NWA settings to sign in again.'); }
        }
        render();
      }
    }
  }
  async function checkStatus(id, openAttack = false) {
    if (state.removingKey || state.pendingChecks.has(id)) return;
    if (openAttack && C.avoidReason(state.targets.find(target => target.id === id) || {}, state, serviceNow())) { message('This player is excluded by your target preferences.'); return; }
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
        if (!state.token || Date.parse(state.expiresAt) <= serviceNow() || !authorizedPoolFresh() || !assessment?.suggested || !assessment.ready
          || C.avoidReason(latest, state, serviceNow())
          || !state.reservationsSupported || !(Date.parse(checked.reservationExpiresAt) > serviceNow())) {
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
    if (state.view === 'admin') state.canReview = false;
    if (!append) { state.suggestions = []; state.nextSuggestionOffset = null; }
    message(''); render();
    try {
      const data = await request('GET', `/api/suggestions?view=${view}&offset=${offset}`);
      if (generation !== state.generation || suggestionGeneration !== state.suggestionGeneration) return;
      state.canReview = data.canReview === true;
      state.pagePermissions = { status: 'ready', checkedAt: Date.now() };
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

  async function addAdminTarget(input = state.adminDraft, fromPage = false) {
    if (!state.token || !state.canReview || state.adminPending || state.suggestionMutation || state.removingKey || state.suggestionsLoading) return;
    const draft = { ...input }, targetId = Number(draft.targetId), comment = draft.comment.trim();
    const report = text => fromPage ? pageAdminMessage(text, targetId) : message(text);
    if (fromPage && (!pageAdminEligible(targetId, false) || draft.type !== 'player' || state.pendingPlayerIds.has(targetId)
      || pageSuggestedIds.has(targetId) || state.pendingSuggestions.status === 'unavailable')) return;
    if (!['player', 'faction'].includes(draft.type) || !/^[1-9]\d*$/.test(draft.targetId.trim()) || !Number.isSafeInteger(targetId) || targetId > 2147483647) {
      report('Enter a valid player or faction ID.'); return;
    }
    if (!comment || [...comment].length > 1000) { report('Add a reason for this target, up to 1,000 characters.'); return; }
    const generation = state.generation;
    const returnFocus = !fromPage && root.activeElement?.getAttribute?.('data-focus-key') === 'admin:add';
    const pageWasFocused = fromPage && Boolean(pageAdminControls?.contains(pageAdminControls.getRootNode?.()?.activeElement));
    cancelFind(); state.suggestionMutation = 'admin-add'; state.suggestionNotice = ''; report(''); message(''); render(); updatePageNotice();
    try {
      const submitted = await request('POST', '/api/suggestions', { type: draft.type, targetId, comment });
      if (generation !== state.generation) return;
      const row = submitted.suggestion;
      if (!row || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(row.id) || row.type !== draft.type
        || row.targetId !== targetId || row.comment !== comment || row.status !== 'pending' || row.suggestedBy?.id !== state.player.id) {
        // An unverified submit response must never select a request for approval.
        throw new Error('The addition request could not be verified. Check My suggestions before submitting again.');
      }
      state.adminPending = { id: row.id, type: row.type, targetId, fromPage };
      if (row.type === 'player') {
        if (pageSuggestedIds.size >= 200) pageSuggestedIds.delete(pageSuggestedIds.values().next().value);
        pageSuggestedIds.add(targetId);
      }
      state.pendingSuggestionEpoch++; state.pendingSuggestions = { ...state.pendingSuggestions, revision: null };
      if (!state.canReview) throw new Error('The request was saved, but current admin permissions could not be confirmed.');
      const result = await request('POST', `/api/suggestions/${row.id}/review`, { decision: 'approved' });
      if (generation !== state.generation) return;
      if (result.suggestion?.id !== row.id || result.suggestion.type !== row.type || result.suggestion.targetId !== targetId
        || result.suggestion.status !== 'approved' || result.suggestion.reviewedBy?.id !== state.player.id
        || !Number.isSafeInteger(result.addedPlayers) || result.addedPlayers < 0 || result.addedPlayers > (row.type === 'player' ? 1 : 1000)) {
        throw new Error('Approval could not be verified. Check the saved request before trying again.');
      }
      state.adminPending = null;
      if (!fromPage) state.adminDraft = { type: 'player', targetId: '', comment: '' };
      if (fromPage && pageSuggestion.id === targetId) pageSuggestion.comment = '';
      state.pendingSuggestionEpoch++; state.pendingSuggestions = { ...state.pendingSuggestions, revision: null };
      if (row.type === 'player') { state.pendingPlayerIds.delete(targetId); pageSuggestedIds.delete(targetId); }
      state.suggestionNotice = 'Added and approved. ' + result.addedPlayers + ' player(s) added to the shared NWA list.'
        + (result.warnings?.length ? ' ' + result.warnings.join(' ') : '');
      if (fromPage) pageAdminMessage(state.suggestionNotice, targetId);
      await Promise.all([...(fromPage ? [] : [loadSuggestions()]), loadTargets(true, false, fromPage)]);
    } catch (error) {
      if (generation !== state.generation) return;
      if (state.adminPending) state.suggestionNotice = 'Addition request saved. Approval is not confirmed. Open My suggestions to check its current status before retrying.';
      if (error.code === 'REVIEW_NOT_ALLOWED') { state.suggestionGeneration++; state.suggestionsLoading = false; }
      handleError(error);
      if (fromPage) pageAdminMessage(state.adminPending ? state.suggestionNotice : error.message || 'The addition could not be confirmed.', targetId);
    } finally {
      if (generation === state.generation) {
        state.suggestionMutation = null; render(); updatePageNotice();
        if (returnFocus && state.open && state.view === 'admin' && (!root.activeElement || root.activeElement === panelHeading)) {
          const key = state.adminPending ? 'admin:inspect' : 'admin:add';
          [...content.querySelectorAll('[data-focus-key]')].find(node => node.getAttribute('data-focus-key') === key)?.focus?.({ preventScroll: true });
        }
        if (pageWasFocused && C.pageTargetId(window.location?.href) === targetId && pageNoticeDetails?.open
          && (!document.activeElement || document.activeElement === document.body || document.activeElement === pageNotice)) pageNoticeSummary.focus?.({ preventScroll: true });
      }
    }
  }

  async function removeTargetsFromList(draft = state.removalDraft, fromPage = false) {
    if (!state.token || !state.canReview || !state.removalSupported || state.suggestionMutation || state.removingKey) return;
    const id = Number(draft.targetId), reason = draft.reason.trim(), report = text => fromPage ? pageAdminMessage(text, id) : message(text);
    if (fromPage && (!pageAdminEligible(id, true) || draft.type !== 'player')) return;
    if (!['player', 'faction'].includes(draft.type) || !/^[1-9]\d*$/.test(draft.targetId.trim()) || !Number.isSafeInteger(id)
      || id > 2147483647 || !reason || [...reason].length > 1000 || !draft.confirm) { report('Choose a player or faction, provide a reason and confirm removal.'); return; }
    const generation = state.generation, pageWasFocused = fromPage && Boolean(pageAdminControls?.contains(pageAdminControls.getRootNode?.()?.activeElement));
    cancelFind(); state.suggestionMutation = 'remove'; report(''); message(''); render(); updatePageNotice();
    try {
      const result = await request('POST', '/api/targets/remove', { type: draft.type, targetId: id, reason, confirm: true });
      if (generation !== state.generation) return;
      if (result.type !== draft.type || result.targetId !== id || !Array.isArray(result.removedIds) || result.removedCount !== result.removedIds.length
        || new Set(result.removedIds).size !== result.removedIds.length || draft.type === 'player' && result.removedIds.some(value => value !== id)
        || result.removedIds.length > 5000 || result.removedIds.some(value => !Number.isSafeInteger(value) || value <= 0 || value > 2147483647)) throw new Error('Removal result could not be verified. Refresh the list before trying again.');
      const removed = new Set(result.removedIds); state.targetGeneration++; state.targets = state.targets.filter(row => !removed.has(row.id));
      if (!fromPage) state.removalDraft = { type: 'player', targetId: '', reason: '', confirm: false };
      if (fromPage && pageAdminDraft.id === id) { pageAdminDraft.reason = ''; pageAdminDraft.confirm = false; }
      state.suggestionNotice = 'Removed ' + result.removedCount + ' player(s) from the shared NWA list.' + (result.warnings?.length ? ' ' + result.warnings.join(' ') : '');
      if (fromPage) pageAdminMessage(state.suggestionNotice, id);
      render(); updatePageNotice(); await loadTargets(true, false, true);
    } catch (error) {
      if (generation !== state.generation) return;
      if (!fromPage) state.removalDraft.confirm = false;
      if (fromPage && pageAdminDraft.id === id) pageAdminDraft.confirm = false;
      handleError(error); if (fromPage) pageAdminMessage(error.message || 'Removal could not be confirmed. Refresh the list before trying again.', id);
      void loadTargets(true, false, true);
    } finally {
      if (generation === state.generation) {
        state.suggestionMutation = null; render(); updatePageNotice();
        if (pageWasFocused && C.pageTargetId(window.location?.href) === id
          && (!document.activeElement || document.activeElement === document.body || document.activeElement === pageNotice)) pageNoticeSummary?.focus?.({ preventScroll: true });
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
      if (state.adminPending?.id === id) {
        if (!state.adminPending.fromPage) state.adminDraft = { type: 'player', targetId: '', comment: '' };
        state.adminPending = null;
      }
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
  let preferencesOpen = false, personalPreferencesOpen = false, diagnosticsOpen = false;
  let renderViewportAnchor = null;
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
  function factionChoices() {
    const factions = new Map();
    for (const target of state.targets) {
      const faction = target.faction;
      if (!Number.isSafeInteger(faction?.id) || faction.id <= 0 || faction.id > 2147483647) continue;
      const name = typeof faction.name === 'string' && faction.name.trim() ? faction.name.trim() : 'Faction ' + faction.id;
      if (!factions.has(faction.id)) factions.set(faction.id, name);
    }
    return [...factions].sort((a, b) => a[1].localeCompare(b[1]) || a[0] - b[0]);
  }
  function updateFactionPreferences() {
    if (!panelUi?.factionSelect) return;
    const choices = factionChoices(), known = new Map(choices);
    for (const id of state.excludedFactionIds) if (known.has(id)) state.excludedFactionNames[id] = known.get(id);
    const signature = JSON.stringify([choices, state.excludedFactionIds, state.excludedFactionNames]);
    if (signature === panelUi.factionSignature) return;
    panelUi.factionSignature = signature;
    const selected = panelUi.factionSelect.value;
    panelUi.factionSelect.replaceChildren();
    const available = choices.filter(([id]) => !state.excludedFactionIds.includes(id));
    const placeholder = element('option', available.length ? 'Choose a faction...' : 'No more factions in the target pool'); placeholder.value = ''; panelUi.factionSelect.append(placeholder);
    for (const [id, name] of available) { const option = element('option', name + ' [' + id + ']'); option.value = String(id); panelUi.factionSelect.append(option); }
    panelUi.factionSelect.value = available.some(([id]) => String(id) === selected) ? selected : '';
    panelUi.factionSelect.disabled = !available.length || state.excludedFactionIds.length >= 100;
    panelUi.factionAdd.disabled = panelUi.factionSelect.disabled || !panelUi.factionSelect.value;
    panelUi.factionList.replaceChildren();
    for (const id of state.excludedFactionIds) {
      const name = known.get(id) || state.excludedFactionNames[id] || 'Faction ' + id;
      const row = element('div', null, 'avoided-faction');
      const label = element('span', name + (known.has(id) ? '' : ' (not in the current pool)'));
      const remove = focusKey(button('Stop avoiding', () => {
        state.excludedFactionIds = state.excludedFactionIds.filter(value => value !== id); delete state.excludedFactionNames[id];
        savePreferences(); cancelFind(); message(''); render(); panelUi?.factionSelect?.focus?.({ preventScroll: true });
      }), 'preferences:unavoid:' + id);
      remove.setAttribute('aria-label', 'Stop avoiding ' + name); row.append(label, remove); panelUi.factionList.append(row);
    }
    if (!state.excludedFactionIds.length) panelUi.factionList.append(element('small', 'No factions avoided.'));
    panelUi.factionClear.hidden = !state.excludedFactionIds.length;
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
    if (panelUi.avoidActive) {
      updateFactionPreferences();
      panelUi.avoidActive.checked = state.avoidActive;
      if (root.activeElement !== panelUi.activityMinutes) panelUi.activityMinutes.value = String(state.activityMinutes);
      setText(panelUi.exclusionSummary, state.excludedFactionIds.length + ' faction(s) avoided' + (state.avoidActive ? ' · Skip activity within ' + state.activityMinutes + ' minutes and unknown activity.' : ''));
    }
    panelUi.ageCaution.hidden = state.estimateDays <= 28;
    setText(panelUi.estimateNote, `Possible matches use estimated total stats, with estimates no older than ${state.estimateDays} days. This is a rough difficulty guide: stat distribution, equipment and bonuses also affect fights.`);
    const metadata = JSON.stringify([state.warnings, state.generatedAt, state.backendNotice]);
    if (metadata !== panelUi.metadata) {
      panelUi.metadata = metadata; panelUi.poolMetadata.replaceChildren();
      for (const warning of state.warnings) panelUi.poolMetadata.append(element('p', warning));
      if (state.backendNotice) panelUi.poolMetadata.append(element('p', state.backendNotice));
    }
    setText(panelUi.poolUpdated, state.generatedAt ? `Pool updated: ${C.ageLabel(Date.parse(state.generatedAt) / 1000, serviceNow())}` : 'Pool update time unknown');
  }
  function render() {
    const focus = captureFocus(content);
    const viewport = captureListViewport(), previous = renderViewportAnchor;
    renderViewportAnchor = viewport;
    try { renderPanel(); restoreFocus(focus); restoreListViewport(viewport); }
    finally { renderViewportAnchor = previous; }
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
    for (const [view, label] of [['targets', 'Targets'], ['suggestions', 'Suggestions'], ['admin', 'Admin']]) {
      const tab = button(label, () => {
        if (state.view === view) return;
        state.view = view; render();
        if (view === 'suggestions' || view === 'admin') void loadSuggestions();
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
    if (state.view === 'suggestions' || state.view === 'admin') {
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
    const personalPreferences = element('details', null, 'personal-preferences'); personalPreferences.open = personalPreferencesOpen;
    personalPreferences.addEventListener('toggle', () => { personalPreferencesOpen = personalPreferences.open; });
    personalPreferences.append(element('summary', 'My target preferences'),
      element('p', 'Personal settings for your own targets. Available to every member; they do not change the shared NWA list.', 'personal-help'), ageControls);
    const ageCaution = element('p', 'Older estimates can be inaccurate. Extra caution is needed beyond 28 days.', 'notice');
    ageCaution.hidden = state.estimateDays <= 28; panelUi.ageCaution = ageCaution; personalPreferences.append(ageCaution);
    const avoidSettings = element('section', null, 'avoid-settings'); avoidSettings.setAttribute('aria-label', 'Personal target exclusions');
    const factionsLabel = element('label', 'Avoid factions'), factions = focusKey(element('select'), 'preferences:excluded-factions');
    factions.setAttribute('aria-label', 'Faction to avoid'); factionsLabel.append(factions);
    const factionAdd = focusKey(button('Avoid faction', () => {
      const id = Number(factions.value), chosen = factionChoices().find(([value]) => value === id);
      if (!chosen || !factions.value || state.excludedFactionIds.includes(id) || state.excludedFactionIds.length >= 100) {
        message('Choose a faction from the dropdown. Your previous exclusions are unchanged.'); return;
      }
      state.excludedFactionIds = [...state.excludedFactionIds, id].sort((a, b) => a - b); state.excludedFactionNames[id] = chosen[1];
      savePreferences(); cancelFind(); message(''); render(); panelUi?.factionSelect?.focus?.({ preventScroll: true });
    }), 'preferences:avoid-faction');
    factions.addEventListener('change', () => { factionAdd.disabled = !factions.value || factions.disabled; });
    const factionList = element('div', null, 'avoided-factions'); factionList.setAttribute('aria-label', 'Avoided factions');
    const factionClear = button('Clear avoided factions', () => {
      state.excludedFactionIds = []; state.excludedFactionNames = {}; savePreferences(); cancelFind(); message(''); render(); panelUi?.factionSelect?.focus?.({ preventScroll: true });
    });
    panelUi.factionSelect = factions; panelUi.factionAdd = factionAdd; panelUi.factionList = factionList; panelUi.factionClear = factionClear;
    updateFactionPreferences();
    const activeLabel = element('label', null, 'avoid-active'), active = focusKey(element('input'), 'preferences:avoid-active');
    active.type = 'checkbox'; active.checked = state.avoidActive; active.setAttribute('aria-label', 'Avoid active players');
    active.addEventListener('change', () => { state.avoidActive = active.checked; savePreferences(); cancelFind(); message(''); render(); });
    activeLabel.append(active, element('span', 'Avoid active players'));
    const minutesLabel = element('label', 'Active within the last (minutes)'), minutes = focusKey(element('input'), 'preferences:activity-minutes');
    minutes.type = 'number'; minutes.min = '1'; minutes.max = '10080'; minutes.step = '1'; minutes.value = String(state.activityMinutes); minutes.setAttribute('aria-label', 'Activity cutoff in minutes');
    minutes.addEventListener('change', () => {
      const next = Number(minutes.value);
      if (!minutes.value.trim() || !Number.isSafeInteger(next) || next < 1 || next > 10080) { minutes.value = String(state.activityMinutes); message('Enter a whole number from 1 to 10080 minutes.'); return; }
      state.activityMinutes = next; savePreferences(); cancelFind(); message(''); render();
    }); minutesLabel.append(minutes);
    const summary = element('p', '', 'notice'); panelUi.avoidActive = active; panelUi.activityMinutes = minutes; panelUi.exclusionSummary = summary;
    setText(summary, state.excludedFactionIds.length + ' faction(s) avoided' + (state.avoidActive ? ' · Skip activity within ' + state.activityMinutes + ' minutes and unknown activity.' : ''));
    avoidSettings.append(factionsLabel, factionAdd, factionList, factionClear, activeLabel, minutesLabel, summary,
      element('small', 'Personal filters only. Choose factions from the full target pool; changes save immediately on this device. Unknown activity is skipped when avoiding active players. Shared NWA membership and profile notices stay visible.'));
    personalPreferences.append(avoidSettings); content.append(personalPreferences);
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
  function removalControls() {
    const details = element('details'); details.open = state.removalOpen;
    details.append(element('summary', 'Remove targets (leaders only)'));
    details.addEventListener('toggle', () => { state.removalOpen = details.open; });
    if (!state.removalSupported) { details.append(element('p', 'Update the NWA backend to enable target removal.', 'notice')); return details; }
    const form = element('form', null, 'suggestionform removalform'), busy = Boolean(state.suggestionMutation || state.removingKey);
    const typeLabel = element('label', 'Remove'), type = focusKey(element('select'), 'removal:type');
    for (const value of ['player', 'faction']) { const option = element('option', value === 'player' ? 'Player' : 'Entire faction'); option.value = value; type.append(option); }
    type.value = state.removalDraft.type; type.disabled = busy;
    type.addEventListener('change', () => { state.removalDraft.type = type.value; }); typeLabel.append(type);
    const idLabel = element('label', 'Player or faction ID'), id = focusKey(element('input'), 'removal:id'); id.type = 'number'; id.min = '1'; id.max = '2147483647'; id.required = true;
    id.setAttribute('aria-label', 'Remove player or faction ID'); id.value = state.removalDraft.targetId; id.disabled = busy;
    id.addEventListener('input', () => { state.removalDraft.targetId = id.value; }); idLabel.append(id);
    const reasonLabel = element('label', 'Removal reason'), reason = focusKey(element('textarea'), 'removal:reason'); reason.required = true; reason.maxLength = 1000; reason.rows = 2;
    reason.setAttribute('aria-label', 'Reason for removing targets'); reason.value = state.removalDraft.reason; reason.disabled = busy;
    reason.addEventListener('input', () => { state.removalDraft.reason = reason.value; }); reasonLabel.append(reason);
    const confirmation = element('label', null, 'removal-confirm'), confirm = focusKey(element('input'), 'removal:confirm'); confirm.type = 'checkbox'; confirm.required = true; confirm.checked = state.removalDraft.confirm; confirm.disabled = busy;
    confirm.setAttribute('aria-label', 'Confirm shared target removal'); confirm.addEventListener('change', () => { state.removalDraft.confirm = confirm.checked; });
    confirmation.append(confirm, element('span', 'I confirm removal from the shared NWA list. Faction removal includes individual additions and all players associated with that faction.'));
    const submit = focusKey(element('button', state.suggestionMutation === 'remove' ? 'Removing...' : 'Remove targets'), 'removal:submit'); submit.type = 'submit'; submit.disabled = busy;
    form.append(typeLabel, idLabel, reasonLabel, confirmation, submit); form.addEventListener('submit', event => { event.preventDefault(); void removeTargetsFromList(); });
    details.append(form); return details;
  }

  function renderAdminContent() {
    suggestionContainer.append(element('h3', 'Manage NWA targets'), element('p',
      'Admin access uses your current Torn faction leader or co-leader role. Changes affect the shared list in the script and Discord.', 'notice'));
    const refresh = focusKey(button(state.suggestionsLoading ? 'Checking permissions...' : 'Refresh admin access', () => void loadSuggestions()), 'admin:refresh');
    refresh.disabled = state.suggestionsLoading || Boolean(state.suggestionMutation); suggestionContainer.append(refresh);
    if (state.suggestionNotice) { const notice = element('div', state.suggestionNotice, 'notice'); notice.setAttribute('role', 'status'); suggestionContainer.append(notice); }
    if (state.suggestionsLoading) { suggestionContainer.append(element('p', 'Checking current admin permissions...', 'notice')); return; }
    if (!state.canReview) { suggestionContainer.append(element('p', 'Only current leaders and co-leaders of allowed factions can add or remove targets. Other members can use Suggestions.', 'notice')); return; }
    suggestionContainer.append(element('h3', 'Add a player or faction'));
    if (state.adminPending) {
      suggestionContainer.append(element('p', 'A saved addition needs checking before another is submitted. Opening the request does not repeat approval.', 'notice'));
      const inspect = focusKey(button('Open My suggestions', () => { state.view = 'suggestions'; render(); void loadSuggestions('mine'); }), 'admin:inspect');
      const another = focusKey(button('Start another addition', () => {
        state.adminPending = null; state.adminDraft = { type: 'player', targetId: '', comment: '' }; state.suggestionNotice = ''; render();
      }), 'admin:another');
      inspect.disabled = another.disabled = Boolean(state.suggestionMutation); suggestionContainer.append(inspect, another);
    } else {
      const busy = Boolean(state.suggestionMutation || state.removingKey);
      const form = element('form', null, 'suggestionform adminaddform'), fields = element('div', null, 'suggestionfields');
      const typeLabel = element('label', 'Add'), type = focusKey(element('select'), 'admin:type'); type.setAttribute('aria-label', 'Admin target type');
      for (const [value, label] of [['player', 'Player'], ['faction', 'Entire faction']]) { const option = element('option', label); option.value = value; type.append(option); }
      type.value = state.adminDraft.type; type.disabled = busy;
      type.addEventListener('change', () => { if (!state.suggestionMutation) state.adminDraft.type = type.value; }); typeLabel.append(type);
      const idLabel = element('label', 'Player or faction ID'), id = focusKey(element('input'), 'admin:id');
      id.type = 'number'; id.min = '1'; id.max = '2147483647'; id.step = '1'; id.required = true;
      id.setAttribute('aria-label', 'Add player or faction ID'); id.value = state.adminDraft.targetId; id.disabled = busy;
      id.addEventListener('input', () => { if (!state.suggestionMutation) state.adminDraft.targetId = id.value; }); idLabel.append(id); fields.append(typeLabel, idLabel);
      const reasonLabel = element('label', 'Reason (required)'), reason = focusKey(element('textarea'), 'admin:reason');
      reason.required = true; reason.maxLength = 2000; reason.rows = 3; reason.setAttribute('aria-label', 'Reason for adding targets');
      reason.value = state.adminDraft.comment; reason.disabled = busy;
      reason.addEventListener('input', () => { if (!state.suggestionMutation) state.adminDraft.comment = reason.value; }); reasonLabel.append(reason);
      const submit = focusKey(element('button', state.suggestionMutation === 'admin-add' ? 'Adding...' : 'Add and approve', 'primary'), 'admin:add'); submit.type = 'submit'; submit.disabled = busy;
      form.append(fields, reasonLabel, element('small', 'Up to 1,000 characters. Saves your reason and records you as submitter and reviewer. Faction additions import current members; previously excluded players stay excluded until individually approved.'), submit);
      form.addEventListener('submit', event => { event.preventDefault(); void addAdminTarget(); }); suggestionContainer.append(form);
    }
    const removal = removalControls(); removal.open = true; suggestionContainer.append(removal);
  }

  function renderSuggestionContent() {
    if (!state.open || !suggestionContainer) return;
    const signature = JSON.stringify([state.suggestions, state.canReview, state.suggestionView, state.suggestionsLoading,
      state.suggestionMutation, state.suggestionNotice, state.nextSuggestionOffset, state.removalSupported, state.view, state.adminPending]);
    if (signature === suggestionSignature) return;
    suggestionSignature = signature; suggestionContainer.replaceChildren();
    if (state.view === 'admin') { renderAdminContent(); return; }
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
    if (state.canReview) suggestionContainer.append(removalControls());
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
    const now = serviceNow();
    for (const target of state.targets) {
      if (C.avoidReason(target, state, now)) continue;
      const assessment = C.assess(target, state.player, state.maxRatio, now, state.minRatio, state.estimateDays);
      if (!assessment.allied && assessment.inRange) range++;
      if (assessment.ratio !== null && !assessment.fresh) old++;
      if (assessment.ratio === null) unknown++;
      if (assessment.suggested && assessment.ready && !target.reserved) ready++;
    }
    return `${range} in stat range · ${old} estimates too old or undated · ${unknown} stats unknown · ${ready} ready now`;
  }
  function targetFilterKey() {
    return JSON.stringify([state.query.trim().toLowerCase(), state.mode, state.minRatio, state.maxRatio, state.estimateDays, state.excludedFactionIds, state.avoidActive, state.activityMinutes]);
  }
  function captureListViewport() {
    if (!state.open || state.view !== 'targets' || !state.player || renderedKind !== `member:${state.player.id}:targets` || !cardContainer || targetFilterKey() !== cardFilterKey || !(scroll.scrollTop > 0)
      || !scroll.getBoundingClientRect) return null;
    const viewport = scroll.getBoundingClientRect(), anchors = [];
    for (const id of mountedIds) {
      const rect = cardNodes.get(id)?.node.getBoundingClientRect?.();
      if (!rect || rect.height <= 0 || rect.bottom <= viewport.top) continue;
      if (!anchors.length && rect.top >= viewport.bottom) break;
      anchors.push({ id, offset: rect.top - viewport.top });
      if (anchors.length >= 5) break;
    }
    return anchors.length ? { anchors, scrollTop: scroll.scrollTop } : null;
  }
  function restoreListViewport(snapshot) {
    if (!snapshot || !state.open || state.view !== 'targets' || !scroll.getBoundingClientRect) return;
    const viewport = scroll.getBoundingClientRect();
    for (const anchor of snapshot.anchors) {
      const node = cardNodes.get(anchor.id)?.node;
      if (!node || node.parentNode !== cardContainer) continue;
      const rect = node.getBoundingClientRect();
      scroll.scrollTop += rect.top - viewport.top - anchor.offset;
      return;
    }
    scroll.scrollTop = snapshot.scrollTop;
  }
  function renderCards() {
    if (disposed || !state.open || state.view !== 'targets' || !state.player || !cardContainer) return;
    const focus = captureFocus(cardContainer);
    let focusedCard = focus?.node;
    while (focusedCard && !focusedCard.getAttribute?.('data-target-id')) focusedCard = focusedCard.parentNode;
    const focusedId = Number(focusedCard?.getAttribute('data-target-id'));
    const viewport = renderViewportAnchor || captureListViewport();
    renderTargetCards(viewport);
    restoreFocus(focus, cardContainer, () => {
      const sameCard = cardNodes.get(focusedId)?.controls;
      if (sameCard) return !sameCard['check-status'].disabled ? sameCard['check-status'] : sameCard.profile;
      return panelUi.query || panelHeading;
    });
    restoreListViewport(viewport);
  }
  function renderTargetCards(viewport) {
    const filterKey = targetFilterKey();
    if (filterKey !== cardFilterKey) { cardFilterKey = filterKey; visibleCardLimit = CARD_BATCH_SIZE; }
    updateExportControls();
    const now = serviceNow(), freshPool = authorizedPoolFresh(), query = state.query.trim().toLowerCase();
    const selected = new Map();
    let range = 0, old = 0, unknown = 0, ready = 0, suggestions = 0, excluded = 0;
    // Assess each target once for filtering, counts, ordering and its card.
    for (const target of state.targets) {
      if (C.avoidReason(target, state, now)) { excluded++; continue; }
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
    const summary = `${range} in stat range · ${old} estimates too old or undated · ${unknown} stats unknown · ${ready} ready now${excluded ? ' · ' + excluded + ' excluded by your settings' : ''}`;
    const shownReady = freshPool && state.reservationsSupported
      ? rows.filter(({ target, assessment }) => assessment.suggested && assessment.ready && !target.reserved).length : 0;
    if (viewport) {
      for (const anchor of viewport.anchors) {
        const index = orderedIds.indexOf(anchor.id);
        if (index < 0) continue;
        if (index >= visibleCardLimit) visibleCardLimit = Math.ceil((index + 1) / CARD_BATCH_SIZE) * CARD_BATCH_SIZE;
        break;
      }
    }
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
        if (!latest || C.avoidReason(latest, state, serviceNow()) || !state.token || Date.parse(state.expiresAt) <= serviceNow() || !authorizedPoolFresh()
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
      for (let index = 0; index < visibleIds.length; index++) {
        const node = cardNodes.get(visibleIds[index]).node, current = cardContainer.children[index];
        if (node !== current) cardContainer.insertBefore(node, current || null);
      }
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
  if (saved?.token && Date.parse(saved.expiresAt) > serviceNow()) {
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
    if (pageVisible() && state.token && Date.parse(state.expiresAt) > serviceNow() && !state.busy) {
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
    if (state.token && Date.parse(state.expiresAt) <= serviceNow()) {
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
