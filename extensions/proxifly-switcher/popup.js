const els = {
  proxyStateBadge: document.getElementById("proxyStateBadge"),
  activeProxy: document.getElementById("activeProxy"),
  publicIp: document.getElementById("publicIp"),
  protocolSelect: document.getElementById("protocolSelect"),
  limitSelect: document.getElementById("limitSelect"),
  refreshBtn: document.getElementById("refreshBtn"),
  smartPreferredBtn: document.getElementById("smartPreferredBtn"),
  randomBtn: document.getElementById("randomBtn"),
  nextBtn: document.getElementById("nextBtn"),
  applyBtn: document.getElementById("applyBtn"),
  disableBtn: document.getElementById("disableBtn"),
  checkIpBtn: document.getElementById("checkIpBtn"),
  proxyList: document.getElementById("proxyList"),
  listMeta: document.getElementById("listMeta"),
  message: document.getElementById("message"),
};

let currentList = [];
let busy = false;

function setBusy(next) {
  busy = next;
  for (const id of [
    "refreshBtn",
    "smartPreferredBtn",
    "randomBtn",
    "nextBtn",
    "applyBtn",
    "disableBtn",
    "checkIpBtn",
    "protocolSelect",
    "limitSelect",
    "proxyList",
  ]) {
    els[id].disabled = next;
  }
}

function setMessage(text, kind = "") {
  els.message.textContent = text || "";
  els.message.className = "message" + (kind ? ` ${kind}` : "");
}

function formatProxyLine(proxy) {
  const httpsTag = proxy.supportsHttps ? "TLS" : "NO-TLS";
  const score = Number.isFinite(proxy.score) ? proxy.score : 0;
  return `${proxy.scheme.padEnd(6)} ${proxy.host}:${String(proxy.port).padEnd(5)} | ${String(
    proxy.country || "ZZ"
  ).padEnd(2)} ${String(proxy.city || "Unknown").slice(0, 12).padEnd(12)} | ${proxy.anonymity
    .slice(0, 10)
    .padEnd(10)} | s:${String(score).padEnd(3)} | ${httpsTag}`;
}

function renderList(proxies) {
  currentList = proxies;
  els.proxyList.innerHTML = "";

  if (!proxies.length) {
    const option = document.createElement("option");
    option.textContent = "Tidak ada proxy untuk filter ini";
    option.disabled = true;
    els.proxyList.appendChild(option);
    return;
  }

  for (const proxy of proxies) {
    const option = document.createElement("option");
    option.value = proxy.id;
    option.textContent = formatProxyLine(proxy);
    els.proxyList.appendChild(option);
  }

  els.proxyList.selectedIndex = 0;
}

function renderProxyState(activeProxy) {
  const enabled = Boolean(activeProxy?.host && activeProxy?.port);
  els.proxyStateBadge.textContent = enabled ? "ON" : "OFF";
  els.proxyStateBadge.className = `badge ${enabled ? "on" : "off"}`;
  els.activeProxy.textContent = enabled
    ? `${activeProxy.scheme || "http"}://${activeProxy.host}:${activeProxy.port}`
    : "-";
}

function getSelectedProxy() {
  const selectedId = els.proxyList.value;
  return currentList.find((item) => item.id === selectedId) || null;
}

function runtimeSend(type, payload = {}) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type, payload }, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!response?.ok) {
        reject(new Error(response?.error || "Request gagal"));
        return;
      }
      resolve(response.data);
    });
  });
}

async function refreshDashboard({ force = false } = {}) {
  const payload = {
    protocol: els.protocolSelect.value,
    limit: Number(els.limitSelect.value),
  };

  const data = force
    ? await runtimeSend("refreshAndGetDashboard", payload)
    : await runtimeSend("getDashboard", payload);

  if (els.protocolSelect.value !== data.selectedProtocol) {
    els.protocolSelect.value = data.selectedProtocol;
  }
  if (String(els.limitSelect.value) !== String(data.selectedLimit)) {
    els.limitSelect.value = String(data.selectedLimit);
  }

  renderList(data.proxies || []);
  renderProxyState(data.activeProxy);

  const updatedAt = data.updatedAt ? new Date(data.updatedAt).toLocaleString() : "-";
  const sourceText = data.fromCache ? "cache" : "fresh";
  const countryPreset = Array.isArray(data.countryPreset) && data.countryPreset.length
    ? ` | negara: ${data.countryPreset.join("/")}`
    : "";
  let controlNote = "";
  if (data.proxyLevelOfControl && data.proxyLevelOfControl !== "controlled_by_this_extension") {
    controlNote = ` | control: ${data.proxyLevelOfControl}`;
  }

  els.listMeta.textContent =
    `Menampilkan ${data.proxies.length}/${data.totalFiltered} (protocol ${data.totalProtocolFiltered ?? data.totalFiltered}, total ${data.totalAll}) | ${sourceText}${countryPreset} | ${updatedAt}${controlNote}`;
}

async function withBusy(task, loadingText) {
  if (busy) return;
  setBusy(true);
  if (loadingText) setMessage(loadingText);

  try {
    await task();
  } catch (error) {
    setMessage(error.message || String(error), "error");
  } finally {
    setBusy(false);
  }
}

async function onApplySelected() {
  const proxy = getSelectedProxy();
  if (!proxy) {
    setMessage("Pilih proxy dulu.", "error");
    return;
  }

  await withBusy(async () => {
    const result = await runtimeSend("applyProxy", { proxy });
    renderProxyState(result.applied);
    setMessage(`Proxy aktif: ${result.applied.url}`, "ok");
  }, "Menerapkan proxy...");
}

async function onDisableProxy() {
  await withBusy(async () => {
    await runtimeSend("disableProxy");
    renderProxyState(null);
    setMessage("Proxy dimatikan.", "ok");
  }, "Mematikan proxy...");
}

async function onRandomSwitch() {
  await withBusy(async () => {
    const protocol = els.protocolSelect.value;
    const result = await runtimeSend("switchRandom", { protocol });
    renderProxyState(result.applied);
    setMessage(`Random switch: ${result.applied.url}`, "ok");
    await refreshDashboard();
  }, "Memilih proxy random...");
}

async function onNextSwitch() {
  await withBusy(async () => {
    const protocol = els.protocolSelect.value;
    const result = await runtimeSend("switchNext", { protocol });
    renderProxyState(result.applied);
    setMessage(`Next proxy: ${result.applied.url}`, "ok");
    await refreshDashboard();
  }, "Memilih proxy berikutnya...");
}

async function onSmartPreferredSwitch() {
  await withBusy(async () => {
    const protocol = els.protocolSelect.value;
    const result = await runtimeSend("smartSwitchPreferred", { protocol });
    renderProxyState(result.applied);

    if (result.ipCheck?.ip) {
      els.publicIp.textContent = result.ipCheck.ip;
    }

    const info = [
      `Proxy OK (${result.applied.country || "??"})`,
      result.applied.url,
      result.ipCheck?.ip ? `IP: ${result.ipCheck.ip}` : "",
      result.browserCheck?.status ? `ip8:${result.browserCheck.status}` : "",
      Number.isFinite(result.attempts) ? `coba ${result.attempts}x` : "",
      Number.isFinite(result.skippedBlacklisted) && result.skippedBlacklisted > 0
        ? `skipBL:${result.skippedBlacklisted}`
        : "",
      result.autoReload?.ok ? "tab:auto-reload" : "",
    ]
      .filter(Boolean)
      .join(" | ");

    setMessage(info, "ok");
    await refreshDashboard();
  }, "Mencari proxy US/UK/FR yang benar-benar bisa dipakai...");
}

async function onRefreshList(force) {
  await withBusy(async () => {
    await refreshDashboard({ force });
    setMessage(force ? "Daftar proxy diperbarui." : "Daftar proxy dimuat.", "ok");
  }, force ? "Refresh daftar proxy..." : "Memuat daftar proxy...");
}

async function onFilterChange() {
  await withBusy(async () => {
    await runtimeSend("saveUiPrefs", {
      protocol: els.protocolSelect.value,
      limit: Number(els.limitSelect.value),
    });
    await refreshDashboard();
    setMessage("Filter diperbarui.");
  }, "Menerapkan filter...");
}

async function onCheckIp() {
  await withBusy(async () => {
    const data = await runtimeSend("checkIp");
    els.publicIp.textContent = data.ip;
    setMessage(`IP publik: ${data.ip}`, "ok");
  }, "Mengecek IP publik...");
}

els.applyBtn.addEventListener("click", onApplySelected);
els.disableBtn.addEventListener("click", onDisableProxy);
els.smartPreferredBtn.addEventListener("click", onSmartPreferredSwitch);
els.randomBtn.addEventListener("click", onRandomSwitch);
els.nextBtn.addEventListener("click", onNextSwitch);
els.refreshBtn.addEventListener("click", () => onRefreshList(true));
els.checkIpBtn.addEventListener("click", onCheckIp);
els.protocolSelect.addEventListener("change", onFilterChange);
els.limitSelect.addEventListener("change", onFilterChange);
els.proxyList.addEventListener("dblclick", onApplySelected);

onRefreshList(false);
