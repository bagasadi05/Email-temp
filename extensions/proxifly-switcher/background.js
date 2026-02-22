const PROXIFLY_JSON_URL =
  "https://cdn.jsdelivr.net/gh/proxifly/free-proxy-list@main/proxies/all/data.json";
const PROXYHUB_SUPABASE_URL = "https://vwmhbpgwhfwuwtattset.supabase.co";
const PROXYHUB_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZ3bWhicGd3aGZ3dXd0YXR0c2V0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjczMjc0NjYsImV4cCI6MjA4MjkwMzQ2Nn0.LSMD2P4whDzoIW4UCig0ly0j6UOxd5fHhIkUhywnmrg";
const PROXYHUB_FETCH_PROXIES_URL = `${PROXYHUB_SUPABASE_URL}/functions/v1/fetch-proxies`;
const PROXYHUB_GEOLOCATE_IPS_URL = `${PROXYHUB_SUPABASE_URL}/functions/v1/geolocate-ips`;
const PROXYHUB_FETCH_LIMIT = 500;
const PROXYHUB_GEOLOCATE_LIMIT = 200;
const PREFERRED_COUNTRIES = ["US", "GB", "FR"];
const PREFERRED_COUNTRY_SET = new Set([...PREFERRED_COUNTRIES, "UK"]);
const SMART_SWITCH_MAX_ATTEMPTS = 20;
const SMART_SWITCH_BROWSER_TEST_URL = "https://ip8.com";
const FAILED_PROXY_BLACKLIST_TTL_MS = 15 * 60 * 1000;
const FAILED_PROXY_BLACKLIST_MAX_ENTRIES = 500;

const STORAGE_KEYS = {
  proxyCache: "proxyCache",
  cacheUpdatedAt: "cacheUpdatedAt",
  activeProxy: "activeProxy",
  failedProxyBlacklist: "failedProxyBlacklist",
  uiProtocol: "uiProtocol",
  uiLimit: "uiLimit",
  nextIndexByProtocol: "nextIndexByProtocol",
};

const DEFAULTS = {
  [STORAGE_KEYS.uiProtocol]: "all",
  [STORAGE_KEYS.uiLimit]: 50,
  [STORAGE_KEYS.failedProxyBlacklist]: {},
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

function tabsQuery(queryInfo) {
  return new Promise((resolve, reject) => {
    chrome.tabs.query(queryInfo, (tabs) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(tabs || []);
    });
  });
}

function tabsReload(tabId) {
  return new Promise((resolve, reject) => {
    chrome.tabs.reload(tabId, {}, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve();
    });
  });
}

function pruneFailedProxyBlacklist(raw, now = Date.now()) {
  if (!raw || typeof raw !== "object") {
    return {};
  }

  const rows = Object.entries(raw)
    .filter(([id, item]) => {
      if (!id || !item || typeof item !== "object") return false;
      return Number(item.until || 0) > now;
    })
    .sort((a, b) => Number(b[1].failedAt || 0) - Number(a[1].failedAt || 0))
    .slice(0, FAILED_PROXY_BLACKLIST_MAX_ENTRIES);

  return Object.fromEntries(rows);
}

async function getFailedProxyBlacklist({ persistPruned = true } = {}) {
  const stored = await storageGet([STORAGE_KEYS.failedProxyBlacklist]);
  const raw = stored[STORAGE_KEYS.failedProxyBlacklist] || {};
  const pruned = pruneFailedProxyBlacklist(raw);

  if (persistPruned && JSON.stringify(raw) !== JSON.stringify(pruned)) {
    await storageSet({ [STORAGE_KEYS.failedProxyBlacklist]: pruned });
  }

  return pruned;
}

function splitBlacklistedProxies(list, blacklistMap) {
  const map = blacklistMap && typeof blacklistMap === "object" ? blacklistMap : {};
  const allowed = [];
  const blocked = [];

  for (const proxy of list) {
    if (!proxy?.id) continue;
    if (map[proxy.id]) {
      blocked.push(proxy);
      continue;
    }
    allowed.push(proxy);
  }

  return { allowed, blocked };
}

async function markProxyAsFailed(proxy, reason) {
  if (!proxy?.id) return;

  const now = Date.now();
  const blacklist = await getFailedProxyBlacklist({ persistPruned: true });
  const existing = blacklist[proxy.id] || {};

  blacklist[proxy.id] = {
    id: proxy.id,
    url: proxy.url || proxy.id,
    host: proxy.host || "",
    port: Number(proxy.port || 0),
    scheme: proxy.scheme || "",
    country: proxy.country || "",
    source: proxy.source || "",
    reason: String(reason || "failed"),
    failedAt: now,
    until: now + FAILED_PROXY_BLACKLIST_TTL_MS,
    count: Number(existing.count || 0) + 1,
  };

  const pruned = pruneFailedProxyBlacklist(blacklist, now);
  await storageSet({ [STORAGE_KEYS.failedProxyBlacklist]: pruned });
}

async function clearProxyFailureMark(proxyId) {
  if (!proxyId) return;

  const blacklist = await getFailedProxyBlacklist({ persistPruned: true });
  if (!blacklist[proxyId]) return;

  delete blacklist[proxyId];
  await storageSet({ [STORAGE_KEYS.failedProxyBlacklist]: blacklist });
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
    source: String(entry.source || "unknown"),
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

function dedupeProxyList(list) {
  const map = new Map();

  for (const proxy of list) {
    if (!proxy?.id) continue;
    const existing = map.get(proxy.id);
    if (!existing) {
      map.set(proxy.id, proxy);
      continue;
    }

    const existingCountryKnown = !["ZZ", "XX", ""].includes(normalizeCountryCode(existing.country));
    const nextCountryKnown = !["ZZ", "XX", ""].includes(normalizeCountryCode(proxy.country));

    if (nextCountryKnown && !existingCountryKnown) {
      map.set(proxy.id, proxy);
      continue;
    }

    if (
      proxy.score > existing.score ||
      (proxy.score === existing.score &&
        Number(proxy.supportsHttps) > Number(existing.supportsHttps))
    ) {
      map.set(proxy.id, proxy);
    }
  }

  return [...map.values()];
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
  const sources = await Promise.allSettled([
    fetchProxiflyProxyList(),
    fetchProxyhubProxyList(),
  ]);

  const merged = [];
  const errors = [];

  for (const result of sources) {
    if (result.status === "fulfilled") {
      merged.push(...result.value);
      continue;
    }

    errors.push(result.reason?.message || String(result.reason));
  }

  const deduped = dedupeProxyList(merged);
  if (!deduped.length) {
    throw new Error(`Semua sumber proxy gagal: ${errors.join(" | ") || "unknown error"}`);
  }

  return sortProxyList(deduped);
}

async function fetchProxiflyProxyList() {
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

  const normalized = data
    .map((entry) => normalizeProxyEntry({ ...entry, source: "proxifly" }))
    .filter(Boolean);
  if (!normalized.length) {
    throw new Error("Tidak ada proxy valid dari proxifly");
  }

  return sortProxyList(normalized);
}

function proxyhubTypeToScheme(type) {
  const value = String(type || "").toUpperCase();
  if (value === "HTTP" || value === "HTTPS") return "http";
  if (value === "SOCKS4") return "socks4";
  if (value === "SOCKS5") return "socks5";
  return "";
}

function normalizeProxyhubEntry(entry) {
  if (!entry?.ip || !entry?.port) return null;
  if (String(entry.status || "").toLowerCase() !== "online") return null;

  const scheme = proxyhubTypeToScheme(entry.type || entry.protocol);
  if (!scheme) return null;

  const supportsHttps =
    /https/i.test(String(entry.protocol || "")) || String(entry.type || "").toUpperCase() === "HTTPS";
  const countryCode = normalizeCountryCode(entry.countryCode || "XX");
  const countryName = String(entry.country || "Unknown");
  const qualityScore = Number(entry.qualityScore);
  const responseTime = Number(entry.responseTime);
  const scoreBase = Number.isFinite(qualityScore)
    ? qualityScore
    : Number.isFinite(responseTime)
      ? Math.max(1, 10000 - responseTime)
      : 0;

  return normalizeProxyEntry({
    source: "proxyhub",
    proxy: `${scheme}://${entry.ip}:${entry.port}`,
    port: entry.port,
    protocol: scheme,
    https: supportsHttps,
    anonymity: String(entry.anonymity || "unknown").toLowerCase(),
    score: scoreBase,
    geolocation: {
      country: countryCode || "XX",
      city: countryName || "Unknown",
    },
  });
}

async function callProxyhubFunction(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      apikey: PROXYHUB_ANON_KEY,
      Authorization: `Bearer ${PROXYHUB_ANON_KEY}`,
    },
    cache: "no-store",
    body: JSON.stringify(body || {}),
  });

  if (!response.ok) {
    throw new Error(`ProxyHub request gagal (${response.status})`);
  }

  return await response.json();
}

async function enrichProxyhubGeolocation(list) {
  const unknownIps = [...new Set(
    list
      .filter((item) => ["ZZ", "XX", ""].includes(normalizeCountryCode(item.country)))
      .map((item) => item.host)
      .filter(Boolean)
  )].slice(0, PROXYHUB_GEOLOCATE_LIMIT);

  if (!unknownIps.length) {
    return list;
  }

  try {
    const data = await callProxyhubFunction(PROXYHUB_GEOLOCATE_IPS_URL, { ips: unknownIps });
    if (!data?.success || !Array.isArray(data.results)) {
      return list;
    }

    const geoMap = new Map(
      data.results
        .filter((row) => row?.ip)
        .map((row) => [
          String(row.ip),
          {
            country: normalizeCountryCode(row.countryCode || "XX"),
            city: String(row.country || "Unknown"),
          },
        ])
    );

    return list.map((item) => {
      const geo = geoMap.get(item.host);
      if (!geo) return item;
      return {
        ...item,
        country: geo.country || item.country,
        city: geo.city || item.city,
      };
    });
  } catch {
    return list;
  }
}

async function fetchProxyhubProxyList() {
  const data = await callProxyhubFunction(PROXYHUB_FETCH_PROXIES_URL, {
    limit: PROXYHUB_FETCH_LIMIT,
  });

  if (!data?.success || !Array.isArray(data.proxies)) {
    throw new Error(`Format data ProxyHub tidak valid`);
  }

  let normalized = data.proxies.map(normalizeProxyhubEntry).filter(Boolean);
  if (!normalized.length) {
    throw new Error("Tidak ada proxy valid dari ProxyHub");
  }

  normalized = await enrichProxyhubGeolocation(normalized);
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

  const blacklist = await getFailedProxyBlacklist();
  const { allowed, blocked } = splitBlacklistedProxies(candidates, blacklist);
  if (!allowed.length) {
    throw new Error(
      `Semua kandidat sedang masuk blacklist sementara (${blocked.length}). Tunggu 15 menit atau refresh daftar.`
    );
  }

  const stored = await storageGet([STORAGE_KEYS.activeProxy]);
  const currentId = stored[STORAGE_KEYS.activeProxy]?.id;

  let chosen = allowed[Math.floor(Math.random() * allowed.length)];
  if (allowed.length > 1 && chosen.id === currentId) {
    chosen = allowed[(allowed.findIndex((p) => p.id === chosen.id) + 1) % allowed.length];
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

  const blacklist = await getFailedProxyBlacklist();
  const { allowed, blocked } = splitBlacklistedProxies(candidates, blacklist);
  if (!allowed.length) {
    throw new Error(
      `Semua kandidat sedang masuk blacklist sementara (${blocked.length}). Tunggu 15 menit atau refresh daftar.`
    );
  }

  const prefs = await getUiPrefs();
  const indexMap = { ...(prefs.nextIndexByProtocol || {}) };
  const key = protocol || "all";
  const start = Number(indexMap[key] || 0);
  const chosen = allowed[start % allowed.length];
  indexMap[key] = (start + 1) % allowed.length;

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

async function checkHttpsPage(
  url,
  { timeoutMs = 6000, expectedHost = null, expectedStatus = [200] } = {}
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      cache: "no-store",
      headers: {
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
      redirect: "follow",
    });

    if (!response.ok || !expectedStatus.includes(response.status)) {
      throw new Error(`HTTPS test gagal (${response.status})`);
    }

    const finalUrl = response.url || url;
    const finalHost = (() => {
      try {
        return new URL(finalUrl).hostname.toLowerCase();
      } catch {
        return null;
      }
    })();

    if (expectedHost && finalHost !== String(expectedHost).toLowerCase()) {
      throw new Error(`HTTPS test redirect ke host lain (${finalHost || "unknown"})`);
    }

    return {
      ok: true,
      url,
      finalUrl,
      status: response.status,
    };
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

async function reloadActiveBrowserTab() {
  try {
    const tabs = await tabsQuery({ active: true, lastFocusedWindow: true });
    const targetTab = tabs.find((tab) => Number.isInteger(tab?.id));
    if (!targetTab || !Number.isInteger(targetTab.id)) {
      return { ok: false, reason: "no_active_tab" };
    }

    const url = String(targetTab.url || "");
    if (
      url.startsWith("chrome://") ||
      url.startsWith("edge://") ||
      url.startsWith("brave://") ||
      url.startsWith("about:") ||
      url.startsWith("chrome-extension://")
    ) {
      return { ok: false, reason: "unsupported_tab" };
    }

    await tabsReload(targetTab.id);
    return { ok: true, tabId: targetTab.id };
  } catch (error) {
    return { ok: false, reason: error?.message || String(error) };
  }
}

async function smartSwitchPreferredProxy(protocol) {
  const currentSettings = await proxySettingsGet();
  const snapshot = proxySnapshotFromSettings(currentSettings);

  const { list } = await getCachedProxyList();
  const usable = chooseUsableCandidates(list, protocol);
  const blacklist = await getFailedProxyBlacklist();
  const split = splitBlacklistedProxies(usable.candidates, blacklist);
  const candidates = split.allowed.slice(0, SMART_SWITCH_MAX_ATTEMPTS);

  if (!usable.candidates.length) {
    throw new Error("Tidak ada kandidat proxy US/GB/FR yang cocok");
  }

  if (!candidates.length) {
    throw new Error(
      `Semua kandidat US/GB/FR sedang diblacklist sementara (${split.blocked.length}). Tunggu 15 menit atau Refresh Daftar.`
    );
  }

  const failures = [];

  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    try {
      await applyProxy(candidate);
      const ipCheck = await checkPublicIp({ timeoutMs: 6000 });
      const browserCheck = await checkHttpsPage(SMART_SWITCH_BROWSER_TEST_URL, {
        timeoutMs: 6000,
        expectedHost: "ip8.com",
        expectedStatus: [200],
      });
      await clearProxyFailureMark(candidate.id);
      const autoReload = await reloadActiveBrowserTab();

      return {
        applied: candidate,
        ipCheck,
        browserCheck,
        autoReload,
        attempts: index + 1,
        attemptedCandidates: candidates.length,
        excludedNoTls: usable.excludedNoTls,
        skippedBlacklisted: split.blocked.length,
      };
    } catch (error) {
      await markProxyAsFailed(candidate, error?.message || String(error));
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
