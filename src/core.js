const TargetListCore = (() => {
  const DEFAULT_MIN_RATIO = 0.1;
  const DEFAULT_MAX_RATIO = 0.6;
  const ESTIMATE_MAX_AGE = 7 * 24 * 60 * 60;
  const DEFAULT_ESTIMATE_DAYS = 7;
  const RECENT_TARGET_MS = 10 * 60 * 1000;
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

  function reason(target) {
    return (typeof target.reason === 'string' && target.reason.trim())
      || (typeof target.notes === 'string' && target.notes.trim()) || '';
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

  return { DEFAULT_MIN_RATIO, DEFAULT_MAX_RATIO, DEFAULT_ESTIMATE_DAYS, ESTIMATE_MAX_AGE, RECENT_TARGET_MS, LIVE_STATUS_MAX_AGE, serviceUrl, validKey, pageTargetId, reason, recentTargets, candidates, compact, ageLabel, assess, select };
})();
