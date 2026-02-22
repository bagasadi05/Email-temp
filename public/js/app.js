// ==================== APP STATE ====================
const state = {
  currentPage: 'domain',
  selectedDomain: null,    // { domain, provider, providerBase } OR { domain, provider: 'cloudflare', cfSubdomain }
  domains: [],             // [{ domain, provider, providerBase }]
  emails: [],              // { id, address, domain, createdAt, provider }
  messages: [],
  selectedEmailId: null,
  autoRefreshTimer: null,
  isRefreshing: false,
  currentMessageId: null,
  theme: localStorage.getItem('theme') || 'light',
  notificationsEnabled: localStorage.getItem('notifications') === 'true',
  // Cloudflare
  cfConfigured: false,
  cfBaseDomain: '',
  cfSubdomains: [],        // [{ name, fullDomain, verified, catchAllEmail, createdAt }]
  // Proxy
  activeProxy: null,
  autoRotate: false,
  // Account Tracker
  accounts: []
};

// ==================== DOM ELEMENTS ====================
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const pageDomain = $('#page-domain');
const pageEmail = $('#page-email');
const pageMailbox = $('#page-mailbox');

// ==================== THEME ====================
function applyTheme() {
  document.documentElement.setAttribute('data-theme', state.theme);
  const icon = $('#btn-toggle-theme i');
  if (state.theme === 'dark') {
    icon.className = 'fas fa-sun';
  } else {
    icon.className = 'fas fa-moon';
  }
}

function toggleTheme() {
  state.theme = state.theme === 'light' ? 'dark' : 'light';
  localStorage.setItem('theme', state.theme);
  applyTheme();
}

// ==================== NOTIFICATIONS ====================
function applyNotifications() {
  const icon = $('#btn-toggle-notifications i');
  if (state.notificationsEnabled) {
    icon.className = 'fas fa-bell';
  } else {
    icon.className = 'fas fa-bell-slash';
  }
}

async function toggleNotifications() {
  if (!state.notificationsEnabled) {
    if ('Notification' in window) {
      const permission = await Notification.requestPermission();
      if (permission === 'granted') {
        state.notificationsEnabled = true;
        localStorage.setItem('notifications', 'true');
        showToast('Notifikasi diaktifkan', 'success');
      } else {
        showToast('Izin notifikasi ditolak', 'error');
      }
    } else {
      showToast('Browser tidak mendukung notifikasi', 'error');
    }
  } else {
    state.notificationsEnabled = false;
    localStorage.setItem('notifications', 'false');
    showToast('Notifikasi dinonaktifkan', '');
  }
  applyNotifications();
}

function playNotificationSound() {
  if (!state.notificationsEnabled) return;
  try {
    const audio = new Audio('https://assets.mixkit.co/active_storage/sfx/2869/2869-preview.mp3');
    audio.volume = 0.5;
    audio.play().catch(e => console.log('Audio play failed:', e));
  } catch (e) { }
}

function showPushNotification(title, body) {
  if (!state.notificationsEnabled || !('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    new Notification(title, {
      body: body,
      icon: '/favicon.ico' // Fallback if no icon
    });
  } catch (e) { }
}

// ==================== API HELPERS ====================
async function api(method, url, body = null) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' }
  };
  if (body) opts.body = JSON.stringify(body);
  try {
    const res = await fetch(url, opts);
    return await res.json();
  } catch (err) {
    console.error('API Error:', err);
    return { success: false, message: 'Koneksi gagal' };
  }
}

// ==================== TOAST NOTIFICATION ====================
function showToast(message, type = '') {
  const container = $('#toast-container');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  container.appendChild(toast);

  setTimeout(() => {
    toast.style.animation = 'toastOut 0.3s ease forwards';
    setTimeout(() => toast.remove(), 300);
  }, 2500);
}

// ==================== CLIPBOARD ====================
function copyToClipboard(text) {
  navigator.clipboard.writeText(text).then(() => {
    showToast('Disalin ke clipboard!', 'success');
  }).catch(() => {
    const input = document.createElement('input');
    input.value = text;
    document.body.appendChild(input);
    input.select();
    document.execCommand('copy');
    document.body.removeChild(input);
    showToast('Disalin ke clipboard!', 'success');
  });
}

// ==================== NAVIGATION ====================
function navigateTo(page) {
  state.currentPage = page;

  pageDomain.classList.toggle('hidden', page !== 'domain');
  pageEmail.classList.toggle('hidden', page !== 'email');
  pageMailbox.classList.toggle('hidden', page !== 'mailbox');

  const titles = { domain: 'Domain', email: 'Buat Email', mailbox: 'Mailbox' };
  $('#header-title').textContent = titles[page];

  $$('.nav-item').forEach(item => {
    item.classList.toggle('active', item.dataset.page === page);
  });

  const stepMap = { domain: 1, email: 2, mailbox: 3 };
  const currentStep = stepMap[page];

  for (let i = 1; i <= 3; i++) {
    const circle = $(`#step-ind-${i} .step-circle`);
    circle.classList.remove('active', 'completed');
    if (i === currentStep) circle.classList.add('active');
    else if (i < currentStep) circle.classList.add('completed');
  }

  const lines = $$('.step-line');
  lines.forEach((line, idx) => {
    line.classList.toggle('active', idx < currentStep - 1);
  });

  // Page-specific actions
  if (page === 'email') {
    updateEmailPage();
    stopAutoRefresh();
  }
  if (page === 'mailbox') {
    updateMailboxPage();
  }
  if (page === 'domain') {
    stopAutoRefresh();
  }
}

// ==================== PAGE 1: DOMAIN ====================
async function loadDomains() {
  const grid = $('#domain-grid');
  grid.innerHTML = '<div class="loading-spinner"><i class="fas fa-spinner fa-spin"></i><span>Memuat domain...</span></div>';

  const data = await api('GET', '/api/domains');
  if (data.success) {
    state.domains = data.domains;
    renderDomainGrid();
  } else {
    grid.innerHTML = '<div class="loading-spinner"><i class="fas fa-exclamation-triangle"></i><span>Gagal memuat domain</span></div>';
  }
}

function renderDomainGrid() {
  const grid = $('#domain-grid');
  grid.innerHTML = '';

  state.domains.forEach(domainObj => {
    const isSelected = state.selectedDomain && state.selectedDomain.domain === domainObj.domain;
    const isMaildrop = domainObj.isMaildrop || domainObj.provider === 'maildrop';
    const card = document.createElement('div');
    card.className = `domain-card ${isSelected ? 'selected' : ''} ${isMaildrop ? 'maildrop' : ''}`;
    card.innerHTML = `
      <div class="domain-name">${domainObj.domain}</div>
      ${isMaildrop ? '<div class="domain-badge-tag"><i class="fas fa-star"></i> Populer</div>' : ''}
      <div class="domain-check"><i class="fas fa-check-circle"></i> Dipilih</div>
    `;
    card.addEventListener('click', () => selectDomain(domainObj));
    grid.appendChild(card);
  });
}

function selectDomain(domainObj) {
  state.selectedDomain = domainObj;
  renderDomainGrid();
  showToast(`Domain ${domainObj.domain} dipilih!`, 'success');

  // Auto navigate to email page after short delay
  setTimeout(() => navigateTo('email'), 400);
}

// ==================== PAGE 2: BUAT EMAIL ====================
function updateEmailPage() {
  const isCF = state.selectedDomain?.provider === 'cloudflare';
  const isMaildrop = state.selectedDomain?.provider === 'maildrop' || state.selectedDomain?.isMaildrop;

  // Hide subdomain input row when using Cloudflare or Maildrop
  const subdomainSection = $('#email-subdomain')?.closest('.card-section');
  if (subdomainSection) {
    subdomainSection.style.display = (isCF || isMaildrop) ? 'none' : '';
  }

  if (!state.selectedDomain) {
    $('#email-domain-badge').textContent = 'Belum dipilih';
    $('#at-domain').textContent = '@...';
    $('#subdomain-domain-text').textContent = '...';
  } else {
    let badgeText = state.selectedDomain.domain;
    if (isCF) badgeText = `☁️ ${badgeText}`;
    if (isMaildrop) badgeText = `⭐ ${badgeText}`;
    $('#email-domain-badge').textContent = badgeText;
    $('#at-domain').textContent = `@${state.selectedDomain.domain}`;
    if (!isCF && !isMaildrop) {
      $('#subdomain-domain-text').textContent = state.selectedDomain.domain;
    }
    updateEmailPreview();
  }
  renderEmailList();
}

function updateEmailPreview() {
  const subdomain = ($('#email-subdomain')?.value || '').trim();
  const login = ($('#email-login')?.value || '').trim();
  const domain = state.selectedDomain ? state.selectedDomain.domain : '...';

  const previewRow = $('#email-preview-row');
  const previewText = $('#email-preview-text');

  const localPart = subdomain ? `${subdomain}-${login || '*'}` : (login || '*');
  const fullAddress = `${localPart}@${domain}`;

  previewText.textContent = fullAddress;
  previewRow.style.display = (subdomain || login) ? 'flex' : 'none';

  // Update @domain display
  if (state.selectedDomain) {
    const atText = subdomain ? `@${subdomain}-...${domain}` : `@${domain}`;
    $('#at-domain').textContent = atText;
  }
}

function renderEmailList() {
  const container = $('#email-list');
  const badge = $('#email-count-badge');

  badge.textContent = state.emails.length;

  if (state.emails.length === 0) {
    container.innerHTML = `
      <div class="empty-state" id="no-email-text">
        <i class="fas fa-envelope-open"></i>
        <p>Belum ada email aktif</p>
        <span>Buat email baru di atas untuk mulai menerima pesan</span>
      </div>
    `;
    return;
  }

  container.innerHTML = state.emails.map(e => `
    <div class="email-item">
      <div class="email-item-left">
        <div class="email-item-icon">
          <i class="fas fa-check"></i>
        </div>
        <div class="email-item-info">
          <span class="email-item-address">${e.address}</span>
          <span class="email-item-status">
            <i class="fas fa-circle" style="font-size:6px"></i> Aktif — siap menerima email
          </span>
        </div>
      </div>
      <div class="email-item-actions">
        <button class="btn-copy" onclick="copyToClipboard('${e.address}')">
          <i class="fas fa-copy"></i>
        </button>
        <button class="btn-delete" onclick="deleteEmail('${e.id}')">
          <i class="fas fa-trash"></i>
        </button>
      </div>
    </div>
  `).join('');
}

function getFullLogin() {
  const subdomain = ($('#email-subdomain')?.value || '').trim().toLowerCase();
  const login = ($('#email-login')?.value || '').trim().toLowerCase();
  if (subdomain && login) return `${subdomain}-${login}`;
  if (subdomain) return subdomain;
  return login;
}

async function createEmail() {
  if (!state.selectedDomain) {
    showToast('Pilih domain terlebih dahulu!', 'error');
    navigateTo('domain');
    return;
  }

  const isCF = state.selectedDomain.provider === 'cloudflare';
  const login = isCF
    ? ($('#email-login')?.value || '').trim().toLowerCase()
    : getFullLogin();

  if (login && login.length < (isCF ? 2 : 3)) {
    showToast(`Nama email minimal ${isCF ? 2 : 3} karakter`, 'error');
    return;
  }

  const btn = $('#btn-create-email');
  btn.disabled = true;
  btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Membuat...';

  try {
    let data;
    if (isCF) {
      data = await api('POST', '/api/cloudflare/emails', {
        login: login || undefined,
        subdomainName: state.selectedDomain.cfSubdomain
      });
    } else {
      data = await api('POST', '/api/emails', {
        login: login || undefined,
        domain: state.selectedDomain.domain,
        provider: state.selectedDomain.provider,
        providerBase: state.selectedDomain.providerBase
      });
    }

    if (data.success) {
      if (data.existing) {
        showToast(`Email ${data.email.address} sudah ada`, 'info');
      } else {
        showToast(`Email ${data.email.address} berhasil dibuat!`, 'success');
      }
      $('#email-login').value = '';
      if ($('#email-subdomain')) $('#email-subdomain').value = '';
      updateEmailPreview();
      await loadEmails();
      updateMailboxEmailSelect();

      // Auto-select the new email and go to mailbox
      state.selectedEmailId = data.email.id;
      $('#mailbox-email-select').value = data.email.id;
      showSelectedEmailInfo();
      checkMailbox();
      startAutoRefresh();
      navigateTo('mailbox');
    } else {
      showToast(data.message || 'Gagal membuat email', 'error');
    }
  } catch (err) {
    showToast('Terjadi kesalahan', 'error');
  }

  btn.disabled = false;
  btn.innerHTML = '<i class="fas fa-plus-circle"></i> Buat Email';
}

async function createRandomEmail() {
  if (!state.selectedDomain) {
    showToast('Pilih domain terlebih dahulu!', 'error');
    navigateTo('domain');
    return;
  }

  const btn = $('#btn-random-email');
  btn.disabled = true;
  btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';

  const isCF = state.selectedDomain.provider === 'cloudflare';

  try {
    let data;
    if (isCF) {
      data = await api('POST', '/api/cloudflare/emails', {
        subdomainName: state.selectedDomain.cfSubdomain
      });
    } else {
      const subdomain = ($('#email-subdomain')?.value || '').trim().toLowerCase();
      const loginPayload = subdomain ? `${subdomain}-` : undefined;
      data = await api('POST', '/api/emails', {
        login: loginPayload,
        domain: state.selectedDomain.domain,
        provider: state.selectedDomain.provider,
        providerBase: state.selectedDomain.providerBase
      });
    }

    if (data.success) {
      showToast(`Email ${data.email.address} berhasil dibuat!`, 'success');
      await loadEmails();
      updateMailboxEmailSelect();

      // Auto-select the new email and go to mailbox
      state.selectedEmailId = data.email.id;
      $('#mailbox-email-select').value = data.email.id;
      showSelectedEmailInfo();
      checkMailbox();
      startAutoRefresh();
      navigateTo('mailbox');
    } else {
      showToast(data.message || 'Gagal membuat email', 'error');
    }
  } catch (err) {
    showToast('Terjadi kesalahan', 'error');
  }

  btn.disabled = false;
  btn.innerHTML = '<i class="fas fa-random"></i> Random';
}

async function deleteEmail(id) {
  if (!confirm('Yakin ingin menghapus email ini?')) return;

  const data = await api('DELETE', `/api/emails/${id}`);
  if (data.success) {
    showToast('Email dihapus', 'success');
    if (state.selectedEmailId === id) {
      state.selectedEmailId = null;
      state.messages = [];
      renderMessages([]);
      hideSelectedEmailInfo();
    }
    await loadEmails();
    updateMailboxEmailSelect();
  } else {
    showToast(data.message || 'Gagal menghapus', 'error');
  }
}

async function loadEmails() {
  const data = await api('GET', '/api/emails');
  if (data.success) {
    // Mark each email with its provider type for mailbox routing
    state.emails = data.emails.map(e => {
      // Check if this email belongs to a CF subdomain
      const isCF = state.cfSubdomains.some(s => e.domain === s.fullDomain);
      return { ...e, provider: isCF ? 'cloudflare' : 'mail' };
    });
    renderEmailList();
  }
}

// ==================== PAGE 3: MAILBOX ====================
function updateMailboxPage() {
  updateMailboxEmailSelect();

  if (state.emails.length > 0 && !state.selectedEmailId) {
    // Auto-select first email
    state.selectedEmailId = state.emails[0].id;
    $('#mailbox-email-select').value = state.selectedEmailId;
  }

  if (state.selectedEmailId) {
    showSelectedEmailInfo();
    checkMailbox();
    startAutoRefresh();
  } else {
    hideSelectedEmailInfo();
    renderMessages([]);
    stopAutoRefresh();
  }
}

function updateMailboxEmailSelect() {
  const select = $('#mailbox-email-select');
  const currentVal = state.selectedEmailId;

  select.innerHTML = '<option value="">-- Pilih email untuk cek inbox --</option>' +
    state.emails.map(e => `<option value="${e.id}">${e.address}</option>`).join('');

  if (currentVal && state.emails.find(e => e.id === currentVal)) {
    select.value = currentVal;
  }
}

function showSelectedEmailInfo() {
  const email = state.emails.find(e => e.id === state.selectedEmailId);
  if (!email) return;

  const info = $('#selected-email-info');
  info.style.display = 'block';
  $('#mailbox-address-text').textContent = email.address;

  // Show quick signup section
  const quickSignup = $('#quick-signup-section');
  if (quickSignup) quickSignup.style.display = 'block';
}

function hideSelectedEmailInfo() {
  $('#selected-email-info').style.display = 'none';

  // Hide quick signup section
  const quickSignup = $('#quick-signup-section');
  if (quickSignup) quickSignup.style.display = 'none';
}

async function checkMailbox() {
  if (!state.selectedEmailId) return;

  const loadingBar = $('#loading-bar');
  loadingBar.classList.remove('hidden');
  state.isRefreshing = true;

  try {
    const selectedEmail = state.emails.find(e => e.id === state.selectedEmailId);
    const isCF = selectedEmail?.provider === 'cloudflare';
    const endpoint = isCF
      ? `/api/cloudflare/mailbox/${state.selectedEmailId}`
      : `/api/mailbox/${state.selectedEmailId}`;

    const data = await api('GET', endpoint);
    if (data.success) {
      const oldMessageCount = state.messages.length;
      state.messages = data.messages;
      renderMessages(data.messages);
      updateMailboxBadge(data.messages.length);

      // Check for new messages
      if (data.messages.length > oldMessageCount && oldMessageCount > 0) {
        playNotificationSound();
        const newMsg = data.messages[0];
        showPushNotification('Email Baru Masuk', `${newMsg.from}: ${newMsg.subject || '(Tanpa Subjek)'}`);
      }
    }
  } catch (err) {
    console.error('Mailbox check failed:', err);
  }

  loadingBar.classList.add('hidden');
  state.isRefreshing = false;
}

function renderMessages(messages) {
  const container = $('#mailbox-list');

  if (!messages || messages.length === 0) {
    container.innerHTML = `
      <div class="empty-mailbox" id="empty-mailbox">
        <i class="fas fa-inbox"></i>
        <p>Tidak ada pesan</p>
        <span>Kirim email ke alamat temp Anda — pesan akan otomatis muncul di sini</span>
      </div>
    `;
    return;
  }

  container.innerHTML = messages.map(m => {
    const date = m.date ? new Date(m.date) : new Date();
    const timeStr = date.toLocaleString('id-ID', {
      hour: '2-digit', minute: '2-digit', day: '2-digit', month: 'short'
    });
    const fromName = m.from.split('@')[0] || m.from;

    return `
      <div class="mail-item" onclick="openMessage('${m.id}')">
        <div class="mail-item-header">
          <span class="mail-item-from">${escapeHtml(fromName)}</span>
          <span class="mail-item-date">${timeStr}</span>
        </div>
        <div class="mail-item-subject">${escapeHtml(m.subject || '(Tanpa Subjek)')}</div>
        <div class="mail-item-to">Dari: ${escapeHtml(m.from)}</div>
      </div>
    `;
  }).join('');
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

async function openMessage(messageId) {
  if (!state.selectedEmailId) return;

  state.currentMessageId = messageId;

  // Show modal with loading state
  $('#modal-subject').textContent = 'Memuat...';
  $('#modal-from').textContent = '';
  $('#modal-to').textContent = '';
  $('#modal-date').textContent = '';
  $('#modal-body').innerHTML = '<div class="loading-spinner"><i class="fas fa-spinner fa-spin"></i><span>Memuat pesan...</span></div>';
  $('#modal-attachments').classList.add('hidden');
  $('#mail-modal').classList.remove('hidden');

  try {
    const selectedEmail = state.emails.find(e => e.id === state.selectedEmailId);
    const isCF = selectedEmail?.provider === 'cloudflare';
    const endpoint = isCF
      ? `/api/cloudflare/mailbox/${state.selectedEmailId}/message/${messageId}`
      : `/api/mailbox/${state.selectedEmailId}/message/${messageId}`;

    const data = await api('GET', endpoint);
    if (data.success) {
      const msg = data.message;
      const date = msg.date ? new Date(msg.date) : new Date();
      const dateStr = date.toLocaleDateString('id-ID', {
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
        hour: '2-digit', minute: '2-digit'
      });

      $('#modal-subject').textContent = msg.subject || '(Tanpa Subjek)';
      $('#modal-from').textContent = msg.from || '-';
      $('#modal-to').textContent = msg.to || '-';
      $('#modal-date').textContent = dateStr;

      // Show HTML body if available, otherwise text
      if (msg.htmlBody) {
        $('#modal-body').innerHTML = msg.htmlBody;
      } else if (msg.textBody) {
        $('#modal-body').textContent = msg.textBody;
      } else if (msg.body) {
        $('#modal-body').innerHTML = msg.body;
      } else {
        $('#modal-body').textContent = '(Tidak ada konten)';
      }

      // Show attachments if any
      if (msg.attachments && msg.attachments.length > 0) {
        const attContainer = $('#modal-attachments');
        const attList = $('#attachment-list');
        attContainer.classList.remove('hidden');
        attList.innerHTML = msg.attachments.map(att => `
          <div class="attachment-item">
            <i class="fas fa-file"></i>
            <span>${escapeHtml(att.filename)}</span>
            <span class="att-size">${formatBytes(att.size)}</span>
          </div>
        `).join('');
      }
    } else {
      $('#modal-body').textContent = 'Gagal memuat pesan';
    }
  } catch (err) {
    $('#modal-body').textContent = 'Gagal memuat pesan';
  }
}

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function closeMailModal() {
  $('#mail-modal').classList.add('hidden');
  state.currentMessageId = null;
}

function updateMailboxBadge(count) {
  const badge = $('#nav-badge-mailbox');
  if (count > 0) {
    badge.textContent = count;
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
  }
}

// ==================== AUTO REFRESH ====================
function startAutoRefresh() {
  stopAutoRefresh();
  const badge = $('#auto-refresh-badge');
  badge.classList.remove('paused');

  state.autoRefreshTimer = setInterval(() => {
    if (!state.isRefreshing && state.currentPage === 'mailbox' && state.selectedEmailId) {
      checkMailbox();
    }
  }, 5000); // Poll every 5 seconds
}

function stopAutoRefresh() {
  if (state.autoRefreshTimer) {
    clearInterval(state.autoRefreshTimer);
    state.autoRefreshTimer = null;
  }
  const badge = $('#auto-refresh-badge');
  if (badge) badge.classList.add('paused');
}

async function manualRefresh() {
  const btn = $('#btn-refresh-mailbox');
  btn.classList.add('spinning');

  await checkMailbox();
  showToast('Mailbox diperbarui', 'success');

  setTimeout(() => btn.classList.remove('spinning'), 500);
}

// ==================== CLOUDFLARE SETTINGS ====================
function openCfSettings() {
  $('#cf-settings-modal').classList.remove('hidden');
  loadCfConfig();
}

function closeCfSettings() {
  $('#cf-settings-modal').classList.add('hidden');
  // Also hide guide when closing
  $('#cf-guide').classList.remove('visible');
  $('#btn-toggle-guide').classList.remove('active');
}

function toggleGuide() {
  const guide = $('#cf-guide');
  const btn = $('#btn-toggle-guide');
  guide.classList.toggle('visible');
  btn.classList.toggle('active');
  if (guide.classList.contains('visible')) {
    guide.scrollTop = 0;
  }
}

async function loadCfConfig() {
  const data = await api('GET', '/api/cloudflare/config');
  if (data.success) {
    const cfg = data.config;
    state.cfConfigured = cfg.configured;
    state.cfBaseDomain = cfg.baseDomain;

    const status = $('#cf-status');
    const settingsBtn = $('#btn-open-settings');

    if (cfg.configured) {
      status.className = 'cf-status connected';
      status.innerHTML = `<i class="fas fa-check-circle"></i> Terhubung ke <strong>${cfg.baseDomain}</strong>`;
      settingsBtn.classList.add('configured');
      $('#cf-base-domain-input').value = cfg.baseDomain;
    } else {
      status.className = 'cf-status';
      status.innerHTML = '<i class="fas fa-times-circle"></i> Belum dikonfigurasi';
      settingsBtn.classList.remove('configured');
    }

    updateCfSection();
  }
}

async function saveCfConfig() {
  const apiToken = $('#cf-api-token').value.trim();
  const zoneId = $('#cf-zone-id').value.trim();
  const accountId = $('#cf-account-id').value.trim();
  const baseDomain = $('#cf-base-domain-input').value.trim();

  if (!apiToken || !zoneId || !baseDomain) {
    showToast('Isi semua field yang wajib (*)', 'error');
    return;
  }

  const btn = $('#btn-cf-save');
  btn.disabled = true;
  btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Menghubungkan...';

  const data = await api('POST', '/api/cloudflare/config', { apiToken, zoneId, accountId, baseDomain });

  if (data.success) {
    showToast(data.message, 'success');
    await loadCfConfig();
    await loadCfSubdomains();
    closeCfSettings();
  } else {
    showToast(data.message || 'Gagal menghubungkan', 'error');
  }

  btn.disabled = false;
  btn.innerHTML = '<i class="fas fa-save"></i> Simpan & Hubungkan';
}

// ==================== CLOUDFLARE SUBDOMAINS ====================
function updateCfSection() {
  const section = $('#cf-section');
  if (state.cfConfigured) {
    section.style.display = 'block';
    $('#cf-base-domain').textContent = state.cfBaseDomain;
  } else {
    section.style.display = 'none';
  }
}

async function loadCfSubdomains() {
  const data = await api('GET', '/api/cloudflare/subdomains');
  if (data.success) {
    state.cfSubdomains = data.subdomains;
    state.cfBaseDomain = data.baseDomain;
    renderCfSubdomains();
  }
}

function renderCfSubdomains() {
  const container = $('#cf-subdomain-list');

  if (state.cfSubdomains.length === 0) {
    container.innerHTML = '<p class="hint-text" style="text-align:center;padding:16px;">Belum ada subdomain. Buat subdomain pertama di atas.</p>';
    return;
  }

  container.innerHTML = state.cfSubdomains.map(sub => {
    let statusText = '';
    let statusClass = '';
    if (sub.verified) {
      statusText = 'Aktif';
      statusClass = 'active';
    } else if (sub.needsManualDestination) {
      statusText = 'Perlu setup manual';
      statusClass = 'pending';
    } else {
      statusText = 'Perlu verifikasi';
      statusClass = 'pending';
    }

    return `
    <div class="cf-subdomain-item">
      <div class="cf-subdomain-item-left">
        <div class="cf-subdomain-icon">
          <i class="fas fa-cloud"></i>
        </div>
        <div class="cf-subdomain-info">
          <span class="cf-subdomain-domain">${sub.fullDomain}</span>
          <span class="cf-subdomain-status ${statusClass}">
            <i class="fas fa-circle" style="font-size:6px"></i>
            ${statusText}
          </span>
          ${sub.needsManualDestination && !sub.verified ? `
          <span class="cf-subdomain-help">
            Tambahkan <strong>${sub.catchAllEmail}</strong> di <a href="https://dash.cloudflare.com" target="_blank">CF Dashboard</a> → Email → Destination addresses
          </span>` : ''}
        </div>
      </div>
      <div class="cf-subdomain-actions">
        ${!sub.verified ? `<button class="btn-use" onclick="verifyCfSubdomain('${sub.name}')"><i class="fas fa-check"></i></button>` : ''}
        <button class="btn-use" onclick="selectCfSubdomain('${sub.name}')"><i class="fas fa-arrow-right"></i> Pakai</button>
        <button class="btn-del" onclick="deleteCfSubdomain('${sub.name}')"><i class="fas fa-trash"></i></button>
      </div>
    </div>`;
  }).join('');
}

async function createCfSubdomain() {
  const nameInput = $('#cf-subdomain-name');
  const name = nameInput.value.trim();

  if (!name) {
    showToast('Masukkan nama subdomain', 'error');
    return;
  }

  const btn = $('#btn-cf-create-subdomain');
  btn.disabled = true;
  btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';

  const data = await api('POST', '/api/cloudflare/subdomains', { name });

  if (data.success) {
    showToast(data.message, 'success');
    nameInput.value = '';
    await loadCfSubdomains();
  } else {
    showToast(data.message || 'Gagal membuat subdomain', 'error');
  }

  btn.disabled = false;
  btn.innerHTML = '<i class="fas fa-plus"></i>';
}

async function verifyCfSubdomain(name) {
  showToast('Memeriksa verifikasi...', 'info');
  const data = await api('POST', `/api/cloudflare/subdomains/${name}/verify`);

  if (data.success) {
    showToast(data.message || 'Verifikasi berhasil!', 'success');
    await loadCfSubdomains();
  } else if (data.verifyUrl) {
    // Show manual verification link
    showToast('Buka link verifikasi di browser...', 'info');
    window.open(data.verifyUrl, '_blank');
    // After user clicks, re-check in a few seconds
    setTimeout(async () => {
      const recheck = await api('POST', `/api/cloudflare/subdomains/${name}/verify`);
      if (recheck.success) {
        showToast('Verifikasi berhasil!', 'success');
        await loadCfSubdomains();
      }
    }, 5000);
  } else {
    showToast(data.message || 'Verifikasi belum berhasil. Coba lagi.', 'error');
  }
}

async function deleteCfSubdomain(name) {
  const data = await api('DELETE', `/api/cloudflare/subdomains/${name}`);
  if (data.success) {
    showToast('Subdomain dihapus', 'success');
    await loadCfSubdomains();
    // If was selected, deselect
    if (state.selectedDomain?.cfSubdomain === name) {
      state.selectedDomain = null;
    }
  } else {
    showToast(data.message || 'Gagal menghapus', 'error');
  }
}

function selectCfSubdomain(name) {
  const sub = state.cfSubdomains.find(s => s.name === name);
  if (!sub) return;

  state.selectedDomain = {
    domain: sub.fullDomain,
    provider: 'cloudflare',
    cfSubdomain: name
  };

  renderDomainGrid();
  renderCfSubdomains();
  showToast(`Subdomain ${sub.fullDomain} dipilih!`, 'success');
  setTimeout(() => navigateTo('email'), 400);
}

// ==================== PROXY SETTINGS ====================
async function loadProxyStatus() {
  try {
    const data = await api('GET', '/api/proxy/status');
    if (data.success) {
      state.activeProxy = data.activeProxy;
      updateProxyUI();
    }
  } catch (err) {
    console.error('Failed to load proxy status:', err);
  }
}

function updateProxyUI() {
  const statusBox = $('#proxy-status-box');
  const statusText = $('#proxy-status-text');
  const input = $('#proxy-url-input');
  const copySection = $('#copy-proxy-section');

  // Only update if elements exist (modal is open or has been opened)
  if (!statusBox || !input) return;

  if (state.activeProxy) {
    statusBox.className = 'proxy-status-box active';
    statusBox.innerHTML = `<i class="fas fa-shield-alt"></i> <span id="proxy-status-text">Aktif: ${state.activeProxy}</span>`;
    input.value = state.activeProxy;
    if (copySection) copySection.classList.remove('hidden');
  } else {
    statusBox.className = 'proxy-status-box inactive';
    statusBox.innerHTML = `<i class="fas fa-exclamation-triangle"></i> <span id="proxy-status-text">Tidak Aktif (Menggunakan IP Asli)</span>`;
    input.value = '';
    if (copySection) copySection.classList.add('hidden');
  }
}

async function saveProxy() {
  const url = $('#proxy-url-input').value.trim();
  if (url && !url.startsWith('http://') && !url.startsWith('https://')) {
    showToast('Format proxy harus http:// atau https://', 'error');
    return;
  }

  const btn = $('#btn-save-proxy');
  btn.disabled = true;
  btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';

  const data = await api('POST', '/api/proxy/set', { proxyUrl: url || null });
  if (data.success) {
    showToast(data.message, 'success');
    await loadProxyStatus();
  } else {
    showToast(data.message || 'Gagal mengatur proxy', 'error');
  }

  btn.disabled = false;
  btn.innerHTML = 'Set';
}

async function clearProxy() {
  const data = await api('POST', '/api/proxy/set', { proxyUrl: null });
  if (data.success) {
    showToast('Proxy dinonaktifkan', 'success');
    await loadProxyStatus();
  }
}

async function fetchFreeProxies() {
  const btn = $('#btn-fetch-proxies');
  const container = $('#proxy-list-container');
  const tbody = $('#proxy-list-body');

  btn.disabled = true;
  btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Mengambil...';

  try {
    // Fetch from proxifly raw list
    const res = await fetch('https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/protocols/http/data.txt');
    if (!res.ok) throw new Error('Gagal mengambil proxy');

    const text = await res.text();
    const lines = text.split('\n').filter(l => l.trim().length > 0).slice(0, 50); // Ambil 50 teratas

    if (lines.length === 0) throw new Error('Daftar proxy kosong');

    tbody.innerHTML = lines.map(line => {
      // Format: ip:port or http://ip:port
      const trimmed = line.trim();
      const proxyUrl = trimmed.startsWith('http://') || trimmed.startsWith('https://')
        ? trimmed
        : `http://${trimmed}`;
      const displayText = trimmed.replace(/^https?:\/\//, ''); // Remove protocol for display
      return `
        <tr>
          <td style="padding: 8px; border-bottom: 1px solid var(--border);">${displayText}</td>
          <td style="padding: 8px; border-bottom: 1px solid var(--border);">Unknown</td>
          <td style="padding: 8px; border-bottom: 1px solid var(--border); text-align: center;">
            <button class="btn-primary" style="padding: 4px 8px; font-size: 11px; width: auto;" onclick="useProxy('${proxyUrl}')">Gunakan</button>
          </td>
        </tr>
      `;
    }).join('');

    container.classList.remove('hidden');
  } catch (err) {
    showToast(err.message, 'error');
  }

  btn.disabled = false;
  btn.innerHTML = '<i class="fas fa-download"></i> Fetch Free Proxies';
}

window.useProxy = function (url) {
  $('#proxy-url-input').value = url;
  saveProxy();
};

function copyProxyUrl() {
  if (!state.activeProxy) {
    showToast('Tidak ada proxy aktif', 'error');
    return;
  }

  // Parse proxy URL to extract IP and port
  try {
    const proxyUrl = state.activeProxy;
    const match = proxyUrl.match(/^(https?:\/\/)(.+):(\d+)$/);

    if (match) {
      const [, protocol, ip, port] = match;
      const copyText = `Protocol: ${protocol.replace('://', '').toUpperCase()}\nServer: ${ip}\nPort: ${port}\n\nFull URL: ${proxyUrl}`;

      navigator.clipboard.writeText(copyText).then(() => {
        showToast('✓ Proxy URL berhasil di-copy!', 'success');
      }).catch(() => {
        // Fallback: show alert with proxy URL
        prompt('Copy Proxy URL ini:', proxyUrl);
      });
    } else {
      // If parsing fails, just copy the full URL
      navigator.clipboard.writeText(state.activeProxy).then(() => {
        showToast('✓ Proxy URL berhasil di-copy!', 'success');
      }).catch(() => {
        prompt('Copy Proxy URL ini:', state.activeProxy);
      });
    }
  } catch (err) {
    showToast('Gagal copy proxy URL', 'error');
  }
}

let stealthSkipResolve = null;

function quickSignup(platform, url) {
  const selectedEmail = $('#mailbox-email-select').value;

  if (!selectedEmail) {
    showToast('Pilih email terlebih dahulu', 'error');
    return;
  }

  const emailData = state.emails.find(e => e.id === selectedEmail);
  if (!emailData) {
    showToast('Email tidak ditemukan', 'error');
    return;
  }

  const emailAddress = emailData.address;

  // Handle custom URL
  if (url === 'custom') {
    const customUrl = prompt('Masukkan URL signup page:', 'https://');
    if (!customUrl || !customUrl.startsWith('http')) {
      showToast('URL tidak valid', 'error');
      return;
    }
    url = customUrl;
  }

  const stealthEnabled = $('#toggle-stealth')?.checked;

  const doSignup = async () => {
    // Auto-rotate IP if enabled
    if (state.autoRotate) {
      try {
        const rotateData = await api('POST', '/api/proxy/rotate');
        if (rotateData.success) {
          showToast(`🔄 IP rotated: ${rotateData.proxy} (${rotateData.index}/${rotateData.total})`, 'info');
          await loadProxyStatus();
        }
      } catch (e) {
        showToast('⚠️ Auto-rotate gagal, lanjut tanpa rotate', 'warning');
      }
    }

    // Stealth delay with countdown
    if (stealthEnabled) {
      const baseDelay = parseInt($('#stealth-delay')?.value || '0');
      if (baseDelay > 0) {
        // Add random ±30% variation
        const variation = Math.floor(baseDelay * 0.3 * (Math.random() * 2 - 1));
        const totalDelay = Math.max(5, baseDelay + variation);

        const countdownEl = $('#stealth-countdown');
        const numEl = $('#countdown-num');
        const ringEl = $('#countdown-ring');
        const circumference = 226;

        countdownEl.classList.remove('hidden');

        let remaining = totalDelay;
        let skipped = false;

        const skipPromise = new Promise(resolve => {
          stealthSkipResolve = () => { skipped = true; resolve(); };
        });

        const countdownPromise = new Promise(resolve => {
          const interval = setInterval(() => {
            if (skipped) {
              clearInterval(interval);
              resolve();
              return;
            }
            remaining--;
            numEl.textContent = remaining;
            const progress = 1 - (remaining / totalDelay);
            ringEl.setAttribute('stroke-dashoffset', circumference * (1 - progress));

            if (remaining <= 0) {
              clearInterval(interval);
              resolve();
            }
          }, 1000);

          // Initialise
          numEl.textContent = totalDelay;
          ringEl.setAttribute('stroke-dashoffset', String(circumference));
        });

        await Promise.race([countdownPromise, skipPromise]);
        countdownEl.classList.add('hidden');
        stealthSkipResolve = null;
      }
    }

    // Copy email to clipboard and open URL in new tab
    try {
      await navigator.clipboard.writeText(emailAddress);
      showToast(`✓ Email ${emailAddress} ter-copy! Paste di form ${platform}`, 'success');
    } catch {
      showToast(`Email: ${emailAddress} (Copy manual)`, 'info');
    }
    window.open(url, '_blank');

    // Auto-fill tracker
    if ($('#tracker-email')) {
      $('#tracker-email').value = emailAddress;
    }
  };
  doSignup();
}

async function checkIpViaProxy() {
  const btn = $('#btn-check-ip');
  const resultBox = $('#ip-check-result');
  const resultText = $('#ip-check-text');

  btn.disabled = true;
  btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Checking...';
  resultBox.classList.remove('hidden');
  resultText.textContent = 'Checking...';

  try {
    const data = await api('GET', '/api/proxy/check-ip');
    if (data.success) {
      const proxyStatus = data.usingProxy ? `via ${data.proxyUrl}` : 'Tanpa Proxy (IP Asli)';
      resultText.innerHTML = `IP: <strong>${data.ip}</strong><br><small>${proxyStatus}</small>`;
    } else {
      throw new Error(data.message || 'Gagal mengecek IP');
    }
  } catch (err) {
    resultText.textContent = `Error: ${err.message}`;
    resultBox.style.background = 'var(--danger-light)';
    resultBox.style.borderColor = 'var(--danger)';
    resultBox.style.color = 'var(--danger)';
  }

  btn.disabled = false;
  btn.innerHTML = '<i class="fas fa-map-marker-alt"></i> Check IP via Proxy';
}



// ==================== BATCH EMAIL GENERATOR ====================
async function batchCreateEmails() {
  if (!state.selectedDomain) {
    showToast('Pilih domain terlebih dahulu!', 'error');
    navigateTo('domain');
    return;
  }

  const count = parseInt($('#batch-count').value) || 3;
  const btn = $('#btn-batch-create');
  const progress = $('#batch-progress');
  const fill = $('#batch-progress-fill');
  const text = $('#batch-progress-text');

  btn.disabled = true;
  btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Creating...';
  progress.classList.remove('hidden');
  fill.style.width = '0%';
  text.textContent = `0/${count}`;

  try {
    const data = await api('POST', '/api/emails/batch', {
      count,
      domain: state.selectedDomain.domain,
      provider: state.selectedDomain.provider,
      providerBase: state.selectedDomain.providerBase
    });

    if (data.success) {
      // Animate progress
      fill.style.width = '100%';
      text.textContent = `${data.created}/${data.total}`;

      showToast(`✅ ${data.created}/${data.total} email berhasil dibuat!`, 'success');
      await loadEmails();
      updateMailboxEmailSelect();

      // Show results
      const failed = data.results.filter(r => !r.success);
      if (failed.length > 0) {
        showToast(`⚠️ ${failed.length} gagal: ${failed[0].message}`, 'warning');
      }
    } else {
      showToast(data.message || 'Batch creation gagal', 'error');
    }
  } catch (err) {
    showToast('Terjadi kesalahan saat batch create', 'error');
  }

  btn.disabled = false;
  btn.innerHTML = '<i class="fas fa-bolt"></i> Batch Create';
  setTimeout(() => progress.classList.add('hidden'), 3000);
}

// ==================== PROXY ROTATION ====================
async function rotateProxy() {
  try {
    const data = await api('POST', '/api/proxy/rotate');
    if (data.success) {
      showToast(`🔄 Proxy rotated: ${data.proxy}`, 'success');
      await loadProxyStatus();
      return true;
    } else {
      showToast(data.message, 'error');
      return false;
    }
  } catch {
    showToast('Gagal rotate proxy', 'error');
    return false;
  }
}

async function fetchProxyListServer() {
  try {
    const data = await api('GET', '/api/proxy/list');
    if (data.success) {
      showToast(`✅ ${data.count} proxy loaded! Auto-rotate siap.`, 'success');
    } else {
      showToast(data.message, 'error');
    }
  } catch {
    showToast('Gagal fetch proxy list', 'error');
  }
}

// ==================== ACCOUNT TRACKER ====================
async function loadAccounts() {
  try {
    const data = await api('GET', '/api/accounts');
    if (data.success) {
      state.accounts = data.accounts;
      renderAccounts();
    }
  } catch (err) {
    console.error('Failed to load accounts:', err);
  }
}

function renderAccounts() {
  const list = $('#account-list');
  const badge = $('#account-count-badge');
  badge.textContent = state.accounts.length;

  if (state.accounts.length === 0) {
    list.innerHTML = `
      <div class="empty-state" id="no-accounts-text">
        <i class="fas fa-clipboard"></i>
        <p>Belum ada akun tersimpan</p>
        <span>Simpan akun yang sudah didaftarkan di atas</span>
      </div>`;
    return;
  }

  const platformIcons = {
    klingai: 'fa-video', midjourney: 'fa-palette', openai: 'fa-brain',
    github: 'fa-code-branch', discord: 'fa-gamepad', other: 'fa-globe'
  };

  list.innerHTML = state.accounts.map(acc => `
    <div class="account-item">
      <div class="account-item-icon">
        <i class="fas ${platformIcons[acc.platform] || 'fa-user'}"></i>
      </div>
      <div class="account-item-info">
        <div class="account-item-email">${escapeHtml(acc.email)}</div>
        <div class="account-item-meta">
          <span class="account-item-platform">${acc.platform}</span>
          <span>${acc.password ? '🔑 saved' : ''}</span>
        </div>
      </div>
      <div class="account-item-actions">
        <button class="btn-copy-acc" onclick="copyToClipboard('${acc.email}\\n${acc.password || ''}')" title="Copy credentials">
          <i class="fas fa-copy"></i>
        </button>
        <button class="btn-del-acc" onclick="deleteAccount('${acc.id}')" title="Hapus">
          <i class="fas fa-trash"></i>
        </button>
      </div>
    </div>
  `).join('');
}

async function saveAccount() {
  const email = $('#tracker-email').value.trim();
  const password = $('#tracker-password').value.trim();
  const platform = $('#tracker-platform').value;

  if (!email) {
    showToast('Email wajib diisi', 'error');
    return;
  }

  try {
    const data = await api('POST', '/api/accounts', { email, password, platform });
    if (data.success) {
      showToast(`📋 Akun ${email} tersimpan!`, 'success');
      $('#tracker-email').value = '';
      $('#tracker-password').value = '';
      await loadAccounts();
    } else {
      showToast(data.message, 'error');
    }
  } catch {
    showToast('Gagal menyimpan akun', 'error');
  }
}

async function deleteAccount(id) {
  if (!confirm('Hapus akun ini?')) return;
  try {
    const data = await api('DELETE', `/api/accounts/${id}`);
    if (data.success) {
      showToast('Akun dihapus', 'success');
      await loadAccounts();
    }
  } catch {
    showToast('Gagal menghapus akun', 'error');
  }
}

function exportAccounts() {
  if (state.accounts.length === 0) {
    showToast('Tidak ada akun untuk di-export', 'error');
    return;
  }
  const blob = new Blob([JSON.stringify(state.accounts, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `accounts_${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
  showToast(`📥 ${state.accounts.length} akun di-export!`, 'success');
}

// ==================== EVENT LISTENERS ==
document.addEventListener('DOMContentLoaded', async () => {
  applyTheme();
  applyNotifications();
  $('#btn-toggle-theme').addEventListener('click', toggleTheme);
  $('#btn-toggle-notifications').addEventListener('click', toggleNotifications);

  // Load domains
  await loadDomains();

  // Load Cloudflare config & subdomains
  await loadCfConfig();
  await loadCfSubdomains();

  // Load Proxy status (non-blocking)
  loadProxyStatus().catch(err => console.error('Proxy status load failed:', err));

  // Load any existing emails
  await loadEmails();

  // Bottom navigation
  $$('.nav-item').forEach(item => {
    item.addEventListener('click', () => navigateTo(item.dataset.page));
  });

  // Step indicators
  $('#step-ind-1').addEventListener('click', () => navigateTo('domain'));
  $('#step-ind-2').addEventListener('click', () => navigateTo('email'));
  $('#step-ind-3').addEventListener('click', () => navigateTo('mailbox'));

  // Domain page
  $('#btn-change-domain').addEventListener('click', () => navigateTo('domain'));

  // Email page
  $('#btn-create-email').addEventListener('click', createEmail);
  $('#btn-random-email').addEventListener('click', createRandomEmail);
  $('#btn-batch-create').addEventListener('click', batchCreateEmails);

  // Live preview on input
  $('#email-subdomain').addEventListener('input', updateEmailPreview);
  $('#email-login').addEventListener('input', updateEmailPreview);

  // Enter key on email input
  $('#email-login').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') createEmail();
  });
  $('#email-subdomain').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') $('#email-login').focus();
  });

  // Cloudflare settings
  $('#btn-open-settings').addEventListener('click', openCfSettings);
  $('#btn-close-cf-settings').addEventListener('click', closeCfSettings);
  $('#btn-cf-save').addEventListener('click', saveCfConfig);
  $('#cf-settings-modal').addEventListener('click', (e) => {
    if (e.target === $('#cf-settings-modal')) closeCfSettings();
  });

  // Proxy settings
  $('#btn-open-proxy').addEventListener('click', () => {
    $('#proxy-settings-modal').classList.remove('hidden');
    document.body.style.overflow = 'hidden';
    loadProxyStatus();
  });
  $('#btn-close-proxy-settings').addEventListener('click', () => {
    $('#proxy-settings-modal').classList.add('hidden');
    document.body.style.overflow = '';
  });
  $('#btn-save-proxy').addEventListener('click', saveProxy);
  $('#btn-clear-proxy').addEventListener('click', clearProxy);
  $('#btn-copy-proxy').addEventListener('click', copyProxyUrl);
  $('#btn-check-ip').addEventListener('click', checkIpViaProxy);
  $('#btn-fetch-proxies').addEventListener('click', fetchFreeProxies);
  $('#toggle-auto-rotate').addEventListener('change', (e) => {
    state.autoRotate = e.target.checked;
    if (state.autoRotate) {
      fetchProxyListServer();
      showToast('🔄 Auto-rotate aktif! IP akan berganti tiap Quick Signup', 'success');
    } else {
      showToast('Auto-rotate dinonaktifkan', 'info');
    }
  });
  $('#proxy-settings-modal').addEventListener('click', (e) => {
    if (e.target === $('#proxy-settings-modal')) {
      $('#proxy-settings-modal').classList.add('hidden');
      document.body.style.overflow = '';
    }
  });

  // Account Tracker
  $('#btn-save-account').addEventListener('click', saveAccount);
  $('#btn-export-accounts').addEventListener('click', exportAccounts);
  loadAccounts();


  // Guide toggle
  $('#btn-toggle-guide').addEventListener('click', toggleGuide);

  // Cloudflare subdomain creation
  $('#btn-cf-create-subdomain').addEventListener('click', createCfSubdomain);
  $('#cf-subdomain-name').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') createCfSubdomain();
  });

  // Mailbox page
  $('#btn-refresh-mailbox').addEventListener('click', manualRefresh);
  $('#mailbox-email-select').addEventListener('change', (e) => {
    state.selectedEmailId = e.target.value || null;
    if (state.selectedEmailId) {
      showSelectedEmailInfo();
      checkMailbox();
      startAutoRefresh();
    } else {
      hideSelectedEmailInfo();
      renderMessages([]);
      stopAutoRefresh();
    }
  });

  // Copy address button
  $('#btn-copy-address').addEventListener('click', () => {
    const email = state.emails.find(e => e.id === state.selectedEmailId);
    if (email) copyToClipboard(email.address);
  });

  // Delete address button
  $('#btn-delete-address').addEventListener('click', () => {
    if (state.selectedEmailId) {
      deleteEmail(state.selectedEmailId);
    }
  });

  // Quick Signup buttons
  $$('.btn-quick-signup').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const platform = e.currentTarget.dataset.platform;
      const url = e.currentTarget.dataset.url;
      quickSignup(platform, url);
    });
  });

  // Stealth Mode
  $('#toggle-stealth').addEventListener('change', (e) => {
    const checklist = $('#stealth-checklist');
    if (e.target.checked) {
      checklist.style.display = 'block';
    } else {
      checklist.style.display = 'none';
    }
  });
  $('#btn-skip-countdown').addEventListener('click', () => {
    if (stealthSkipResolve) stealthSkipResolve();
  });

  // Modal
  $('#btn-close-modal').addEventListener('click', closeMailModal);
  $('#mail-modal').addEventListener('click', (e) => {
    if (e.target === $('#mail-modal')) closeMailModal();
  });

  // Set initial page
  navigateTo('domain');
});
// Auto-fill tracker email from selected mailbox email
function autoFillTrackerEmail() {
  const email = state.emails.find(e => e.id === state.selectedEmailId);
  if (email && $('#tracker-email')) {
    $('#tracker-email').value = email.address;
  }
}
