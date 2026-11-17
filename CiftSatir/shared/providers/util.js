(function (global) {
  'use strict';

  const DS = (global.DualSub = global.DualSub || {});
  const { PROVIDER_TIMEOUT } = DS.constants;

  function withTimeout(promise, ms, label) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error((label || 'İstek') + ' zaman aşımına uğradı.')), ms || PROVIDER_TIMEOUT);
      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        }
      );
    });
  }

  async function fetchJson(url, options) {
    const response = await fetch(url, Object.assign({ credentials: 'omit' }, options || {}));
    if (!response.ok) {
      throw new Error('HTTP ' + response.status);
    }
    return response.json();
  }

  async function fetchText(url, options) {
    const response = await fetch(url, Object.assign({ credentials: 'omit' }, options || {}));
    if (!response.ok) {
      throw new Error('HTTP ' + response.status);
    }
    return response.text();
  }

  // Circuit breaker for a provider that is down.
  //
  // api.dictionaryapi.dev has been observed hanging without ever responding,
  // and paying its full timeout on every single word is a bad experience for a
  // fault that is entirely upstream. After a few consecutive failures the
  // provider is skipped outright for a cooldown, then tried once more.
  const FAILURE_THRESHOLD = 3;
  const COOLDOWN_MS = 5 * 60 * 1000;

  const breakers = new Map();

  function breakerFor(name) {
    if (!breakers.has(name)) {
      breakers.set(name, { failures: 0, openUntil: 0 });
    }
    return breakers.get(name);
  }

  function isOpen(name) {
    const breaker = breakerFor(name);
    if (!breaker.openUntil) {
      return false;
    }

    if (Date.now() >= breaker.openUntil) {
      // Cooldown elapsed: allow one attempt through to test the water.
      breaker.openUntil = 0;
      breaker.failures = 0;
      return false;
    }

    return true;
  }

  function recordSuccess(name) {
    const breaker = breakerFor(name);
    breaker.failures = 0;
    breaker.openUntil = 0;
  }

  function recordFailure(name) {
    const breaker = breakerFor(name);
    breaker.failures += 1;
    if (breaker.failures >= FAILURE_THRESHOLD) {
      breaker.openUntil = Date.now() + COOLDOWN_MS;
    }
  }

  // Runs `fn` unless the named provider is in cooldown.
  //
  // Only a *thrown* error counts as an outage. A null return means the provider
  // answered normally and simply had nothing for this word, which says nothing
  // about its health - counting those would open the breaker after a few rare
  // words and then skip a perfectly working provider.
  async function guarded(name, fn) {
    if (isOpen(name)) {
      return null;
    }

    try {
      const result = await fn();
      recordSuccess(name);
      return result;
    } catch (error) {
      recordFailure(name);
      return null;
    }
  }

  function resetBreakers() {
    breakers.clear();
  }

  DS.providers = DS.providers || {};
  DS.providers.util = {
    withTimeout: withTimeout,
    fetchJson: fetchJson,
    fetchText: fetchText,
    guarded: guarded,
    isOpen: isOpen,
    resetBreakers: resetBreakers,
    FAILURE_THRESHOLD: FAILURE_THRESHOLD,
    COOLDOWN_MS: COOLDOWN_MS
  };
})(typeof self !== 'undefined' ? self : this);
