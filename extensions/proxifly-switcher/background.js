const PROXIFLY_JSON_URL =
  "https://cdn.jsdelivr.net/gh/proxifly/free-proxy-list@main/proxies/all/data.json";
const PREFERRED_COUNTRIES = ["US", "GB", "FR"];
const PREFERRED_COUNTRY_SET = new Set([...PREFERRED_COUNTRIES, "UK"]);
const SMART_SWITCH_MAX_ATTEMPTS = 15;

const STORAGE_KEYS = {
  proxyCache: "proxyCache",
  cacheUpdatedAt: "cacheUpdatedAt",
  activeProxy: "activeProxy",
  uiProtocol: "uiProtocol",
  uiLimit: "uiLimit",
  nextIndexByProtocol: "nextIndexByProtocol",
};

const DEFAULTS = {
  [STORAGE_KEYS.uiProtocol]: "all",
  [STORAGE_KEYS.uiLimit]: 50,
  [STORAGE_KEYS.nextIndexByProtocol]: {},
};

function storageGet(keys) {
  return new Promise((resolve) => {
    chrome.storage.local.get(keys, (result) => resolve(result));
  });
}

function storageSet(value) {
  return new Promise((resolve) => {
    chrome.storage.local.set(value, () => resolve());
  });
}

function proxySettingsGet() {
  return new Promise((resolve) => {
    chrome.proxy.settings.get({ incognito: false }, (details) => resolve(details));
  });
}

function proxySettingsSet(value) {
  return new Promise((resolve, reject) => {
    chrome.proxy.settings.set({ value, scope: "regular" }, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve();
    });
  });
}

function proxySettingsClear() {
  return new Promise((resolve, reject) => {
    chrome.proxy.settings.clear({ scope: "regular" }, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve();
    });
  });
}

function actionBadgeSet(enabled) {
  const text = enabled ? "ON" : "";
  const bg = enabled ? "#0b7a36" : "#666666";
  chrome.action.setBadgeBackgroundColor({ color: bg }, () => void chrome.runtime.lastError);
  chrome.action.setBadgeText({ text }, () => void chrome.runtime.lastError);
}

function normalizeScheme(scheme) {
  const raw = String(scheme || "").toLowerCase();
  if (raw === "socks") return "socks5";
  if (raw === "socks4a") return "socks4";
  if (raw === "socks5h") return "socks5";
  if (raw === "socks4h") return "socks4";
  return raw;
}

function anonymityRank(level) {
  const value = String(level || "").toLowerCase();
  if (value === "elite") return 3;
  if (value === "anonymous") return 2;
  if (value === "transparent") return 1;
  return 0;
}

function getDefaultPortForScheme(scheme) {
  if (scheme === "http") return 80;
  if (scheme === "https") return 443;
  return null;
}

function normalizeCountryCode(code) {
  const value = String(code || "").toUpperCase();
  if (value === "UK") return "GB";
  return value;
}

function normalizeProxyEntry(entry) {
  if (!entry || typeof entry.proxy !== "string") return null;

  let parsed;
  try {
    parsed = new URL(entry.proxy);
  } catch {
    return null;
  }

  const scheme = normalizeScheme(parsed.protocol.replace(":", ""));
  if (!["http", "https", "socks4", "socks5"].includes(scheme)) {
    return null;
  }

  const fallbackPort = entry.port ?? getDefaultPortForScheme(scheme);
  const port = Number(parsed.port || fallbackPort);
  if (!parsed.hostname || !Number.isInteger(port) || port < 1 || port > 65535) {
    return null;
  }

  const protocol = String(entry.protocol || scheme).toLowerCase();
  const score = Number(entry.score);

  return {
    id: `${scheme}://${parsed.hostname}:${port}`,
    url: `${scheme}://${parsed.hostname}:${port}`,
    scheme,
    host: parsed.hostname,
    port,
    protocol,
    supportsHttps: Boolean(entry.https),
    anonymity: String(entry.anonymity || "unknown"),
    score: Number.isFinite(score) ? score : 0,
    country: entry.geolocation?.country || "ZZ",
    city: entry.geolocation?.city || "Unknown",
  };
}

function sortProxyList(list) {
  return [...list].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (anonymityRank(b.anonymity) !== anonymityRank(a.anonymity)) {
      return anonymityRank(b.anonymity) - anonymityRank(a.anonymity);
    }
    if (Number(b.supportsHttps) !== Number(a.supportsHttps)) {
      return Number(b.supportsHttps) - Number(a.supportsHttps);
    }
    return a.id.localeCompare(b.id);
  });
}

function filterPreferredCountryList(list) {
  return list.filter((item) => PREFERRED_COUNTRY_SET.has(normalizeCountryCode(item.country)));
}

function canLikelyHandleHttps(proxy) {
  if (!proxy) return false;
  if (proxy.scheme === "https") return true;
  if (proxy.scheme === "http") return Boolean(proxy.supportsHttps);
  if (proxy.scheme === "socks4" || proxy.scheme === "socks5") return true;
  return false;
}

function chooseUsableCandidates(list, protocol) {
  const protocolFiltered = filterProxyList(list, protocol);
  const countryFiltered = filterPreferredCountryList(protocolFiltered);
  const httpsCapable = countryFiltered.filter(canLikelyHandleHttps);

  return {
    protocolFiltered,
    countryFiltered,
    candidates: httpsCapable.length ? httpsCapable : countryFiltered,
    excludedNoTls: httpsCapable.length ? countryFiltered.length - httpsCapable.length : 0,
  };
}

async function fetchProxyListFromSource() {
  const response = await fetch(PROXIFLY_JSON_URL, {
    headers: {
      Accept: "application/json",
    },
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`Gagal fetch proxifly (${response.status})`);
  }

  const data = await response.json();
  if (!Array.isArray(data)) {
    throw new Error("Format data proxifly tidak valid");
  }

  const normalized = data.map(normalizeProxyEntry).filter(Boolean);
  if (!normalized.length) {
    throw new Error("Tidak ada proxy valid dari proxifly");
  }

  return sortProxyList(normalized);
}

async function getCachedProxyList({ refresh = false } = {}) {
  const stored = await storageGet([STORAGE_KEYS.proxyCache, STORAGE_KEYS.cacheUpdatedAt]);
  const existingList = Array.isArray(stored[STORAGE_KEYS.proxyCache])
    ? stored[STORAGE_KEYS.proxyCache]
    : [];

  if (!refresh && existingList.length) {
    return {
      list: existingList,
      updatedAt: stored[STORAGE_KEYS.cacheUpdatedAt] || null,
      fromCache: true,
    };
  }

  const freshList = await fetchProxyListFromSource();
  const updatedAt = new Date().toISOString();

  await storageSet({
    [STORAGE_KEYS.proxyCache]: freshList,
    [STORAGE_KEYS.cacheUpdatedAt]: updatedAt,
  });

  return {
    list: freshList,
    updatedAt,
    fromCache: false,
  };
}

function filterProxyList(list, protocol) {
  const value = String(protocol || "all").toLowerCase();
  if (value === "all") return list;
  return list.filter((item) => item.protocol === value || item.scheme === value);
}

async function saveUiPrefs({ protocol, limit }) {
  const patch = {};
  if (protocol) patch[STORAGE_KEYS.uiProtocol] = String(protocol).toLowerCase();
  if (Number.isFinite(Number(limit))) patch[STORAGE_KEYS.uiLimit] = Number(limit);
  if (Object.keys(patch).length) {
    await storageSet(patch);
  }
}

async function getUiPrefs() {
  const stored = await storageGet([
    STORAGE_KEYS.uiProtocol,
    STORAGE_KEYS.uiLimit,
    STORAGE_KEYS.nextIndexByProtocol,
  ]);

  return {
    protocol: stored[STORAGE_KEYS.uiProtocol] || DEFAULTS[STORAGE_KEYS.uiProtocol],
    limit: Number(stored[STORAGE_KEYS.uiLimit] || DEFAULTS[STORAGE_KEYS.uiLimit]),
    nextIndexByProtocol:
      stored[STORAGE_KEYS.nextIndexByProtocol] || DEFAULTS[STORAGE_KEYS.nextIndexByProtocol],
  };
}

function proxyToChromeConfig(proxy) {
  return {
    mode: "fixed_servers",
    rules: {
      singleProxy: {
        scheme: proxy.scheme,
        host: proxy.host,
        port: proxy.port,
      },
      bypassList: ["<local>", "localhost", "127.0.0.1"],
    },
  };
}

async function applyProxy(proxy) {
  await proxySettingsSet(proxyToChromeConfig(proxy));
  await storageSet({ [STORAGE_KEYS.activeProxy]: proxy });
  actionBadgeSet(true);
  return proxy;
}

async function disableProxy() {
  await proxySettingsClear();
  await storageSet({ [STORAGE_KEYS.activeProxy]: null });
  actionBadgeSet(false);
}

function extractActiveProxyFromSettings(details) {
  const value = details?.value;
  if (!value || value.mode !== "fixed_servers") return null;

  const singleProxy = value.rules?.singleProxy;
  if (!singleProxy?.host || !singleProxy?.port) return null;

  const scheme = normalizeScheme(singleProxy.scheme || "http");
  return {
    scheme,
    host: singleProxy.host,
    port: Number(singleProxy.port),
    id: `${scheme}://${singleProxy.host}:${singleProxy.port}`,
    url: `${scheme}://${singleProxy.host}:${singleProxy.port}`,
  };
}

async function getDashboardData({ protocol, limit, refresh } = {}) {
  const prefs = await getUiPrefs();
  const selectedProtocol = (protocol || prefs.protocol || "all").toLowerCase();
  const selectedLimit = Number(limit || prefs.limit || 50);

  await saveUiPrefs({ protocol: selectedProtocol, limit: selectedLimit });

  const cache = await getCachedProxyList({ refresh: Boolean(refresh) });
  const protocolFiltered = filterProxyList(cache.list, selectedProtocol);
  const countryFiltered = filterPreferredCountryList(protocolFiltered);
  const visible = countryFiltered.slice(0, Math.max(1, Math.min(500, selectedLimit)));

  const stored = await storageGet([STORAGE_KEYS.activeProxy]);
  const proxySettings = await proxySettingsGet();
  const activeFromSettings = extractActiveProxyFromSettings(proxySettings);

  const activeProxy = activeFromSettings || stored[STORAGE_KEYS.activeProxy] || null;

  return {
    proxies: visible,
    totalFiltered: countryFiltered.length,
    totalProtocolFiltered: protocolFiltered.length,
    totalAll: cache.list.length,
    updatedAt: cache.updatedAt,
    fromCache: cache.fromCache,
    selectedProtocol,
    selectedLimit,
    activeProxy,
    proxyLevelOfControl: proxySettings.levelOfControl || null,
    countryPreset: PREFERRED_COUNTRIES,
  };
}

async function chooseRandomProxy(protocol) {
  const { list } = await getCachedProxyList();
  const { candidates } = chooseUsableCandidates(list, protocol);
  if (!candidates.length) {
    throw new Error("Tidak ada proxy US/GB/FR untuk filter ini");
  }

  const stored = await storageGet([STORAGE_KEYS.activeProxy]);
  const currentId = stored[STORAGE_KEYS.activeProxy]?.id;

  let chosen = candidates[Math.floor(Math.random() * candidates.length)];
  if (candidates.length > 1 && chosen.id === currentId) {
    chosen = candidates[(candidates.findIndex((p) => p.id === chosen.id) + 1) % candidates.length];
  }

  await applyProxy(chosen);
  return chosen;
}

async function chooseNextProxy(protocol) {
  const { list } = await getCachedProxyList();
  const { candidates } = chooseUsableCandidates(list, protocol);
  if (!candidates.length) {
    throw new Error("Tidak ada proxy US/GB/FR untuk filter ini");
  }

  const prefs = await getUiPrefs();
  const indexMap = { ...(prefs.nextIndexByProtocol || {}) };
  const key = protocol || "all";
  const start = Number(indexMap[key] || 0);
  const chosen = candidates[start % candidates.length];
  indexMap[key] = (start + 1) % candidates.length;

  await applyProxy(chosen);
  await storageSet({ [STORAGE_KEYS.nextIndexByProtocol]: indexMap });

  return chosen;
}

async function checkPublicIp({ timeoutMs = 8000 } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const endpoints = ["https://api.ipify.org?format=json", "https://api64.ipify.org?format=json"];

    for (const url of endpoints) {
      try {
        const response = await fetch(url, {
          signal: controller.signal,
          cache: "no-store",
          headers: { Accept: "application/json" },
        });
        if (!response.ok) continue;
        const data = await response.json();
        if (data?.ip) {
          return { ip: String(data.ip), source: url };
        }
      } catch {
        // fallback ke endpoint berikutnya
      }
    }

    throw new Error("Tidak bisa mengecek IP publik");
  } finally {
    clearTimeout(timeout);
  }
}

function proxySnapshotFromSettings(details) {
  return {
    value: details?.value || null,
    activeProxy: extractActiveProxyFromSettings(details),
  };
}

async function restoreProxySnapshot(snapshot) {
  if (snapshot?.value && snapshot.value.mode) {
    await proxySettingsSet(snapshot.value);
    await storageSet({ [STORAGE_KEYS.activeProxy]: snapshot.activeProxy || null });
    actionBadgeSet(Boolean(snapshot.activeProxy));
    return;
  }

  await disableProxy();
}

async function smartSwitchPreferredProxy(protocol) {
  const currentSettings = await proxySettingsGet();
  const snapshot = proxySnapshotFromSettings(currentSettings);

  const { list } = await getCachedProxyList();
  const usable = chooseUsableCandidates(list, protocol);
  const candidates = usable.candidates.slice(0, SMART_SWITCH_MAX_ATTEMPTS);

  if (!candidates.length) {
    throw new Error("Tidak ada kandidat proxy US/GB/FR yang cocok");
  }

  const failures = [];

  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    try {
      await applyProxy(candidate);
      const ipCheck = await checkPublicIp({ timeoutMs: 6000 });

      return {
        applied: candidate,
        ipCheck,
        attempts: index + 1,
        attemptedCandidates: candidates.length,
        excludedNoTls: usable.excludedNoTls,
      };
    } catch (error) {
      failures.push({
        proxy: candidate.url,
        reason: error?.message || String(error),
      });
    }
  }

  await restoreProxySnapshot(snapshot);

  throw new Error(
    `Tidak menemukan proxy US/GB/FR yang bisa dipakai (dicoba ${candidates.length}). ` +
      "Coba Refresh Daftar lalu ulangi."
  );
}

chrome.runtime.onInstalled.addListener(async () => {
  await storageSet(DEFAULTS);
  actionBadgeSet(false);
});

chrome.runtime.onStartup.addListener(async () => {
  const settings = await proxySettingsGet();
  actionBadgeSet(Boolean(extractActiveProxyFromSettings(settings)));
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    const type = message?.type;

    switch (type) {
      case "getDashboard": {
        return await getDashboardData(message.payload || {});
      }

      case "refreshAndGetDashboard": {
        return await getDashboardData({ ...(message.payload || {}), refresh: true });
      }

      case "applyProxy": {
        const proxy = message?.payload?.proxy;
        if (!proxy?.host || !proxy?.port || !proxy?.scheme) {
          throw new Error("Data proxy tidak valid");
        }
        const normalized = normalizeProxyEntry({
          proxy: `${proxy.scheme}://${proxy.host}:${proxy.port}`,
          port: proxy.port,
          protocol: proxy.protocol || proxy.scheme,
          score: proxy.score || 0,
          https: proxy.supportsHttps || false,
          anonymity: proxy.anonymity || "unknown",
          geolocation: {
            country: proxy.country || "ZZ",
            city: proxy.city || "Unknown",
          },
        });
        if (!normalized) {
          throw new Error("Proxy tidak didukung oleh Chrome");
        }
        const applied = await applyProxy(normalized);
        return { applied };
      }

      case "disableProxy": {
        await disableProxy();
        return { ok: true };
      }

      case "switchRandom": {
        const protocol = message?.payload?.protocol || "all";
        const applied = await chooseRandomProxy(protocol);
        return { applied };
      }

      case "switchNext": {
        const protocol = message?.payload?.protocol || "all";
        const applied = await chooseNextProxy(protocol);
        return { applied };
      }

      case "saveUiPrefs": {
        await saveUiPrefs(message.payload || {});
        return { ok: true };
      }

      case "checkIp": {
        return await checkPublicIp();
      }

      case "smartSwitchPreferred": {
        const protocol = message?.payload?.protocol || "all";
        return await smartSwitchPreferredProxy(protocol);
      }

      default:
        throw new Error(`Unknown message type: ${String(type)}`);
    }
  })()
    .then((data) => sendResponse({ ok: true, data }))
    .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));

  return true;
});
