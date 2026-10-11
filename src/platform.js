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
