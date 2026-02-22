const express = require('express');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { HttpsProxyAgent } = require('https-proxy-agent');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ==================== PROXY CONFIG ====================
let activeProxy = null; // e.g., 'http://ip:port'

// ==================== TEMP EMAIL API PROVIDERS ====================
const PROVIDERS = [
  { name: 'mail.tm', base: 'https://api.mail.tm' },
  { name: 'mail.gw', base: 'https://api.mail.gw' }
];

// Maildrop provider (GraphQL API, no auth needed)
const MAILDROP = {
  name: 'maildrop',
  domain: 'maildrop.cc',
  graphql: 'https://api.maildrop.cc/graphql'
};

// ==================== IN-MEMORY DATA STORE ====================
const createdEmails = [];

// Cached domains from all providers
let cachedDomains = null;
let domainsCacheTime = 0;
const DOMAINS_CACHE_TTL = 30 * 60 * 1000; // 30 minutes

// ==================== CLOUDFLARE CONFIG ====================
let cfConfig = {
  apiToken: '',
  zoneId: '',
  accountId: '',
  baseDomain: '',
  configured: false
};

// Cloudflare subdomains: { name, fullDomain, mxRecordIds[], routeRuleId, catchAllEmail{...}, verified }
const cfSubdomains = [];

// Cloudflare subdomain emails: same shape as createdEmails but with cfSubdomain reference
// When email is created on a CF subdomain, we store it linked to the catch-all mail.tm account

// ==================== HELPER: Fetch with timeout ====================
async function fetchWithTimeout(url, opts = {}, timeout = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  
  // Add proxy agent if active
  if (activeProxy) {
    opts.agent = new HttpsProxyAgent(activeProxy);
  }

  try {
    const res = await fetch(url, { ...opts, signal: controller.signal });
    clearTimeout(timer);
    return res;
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

// ==================== HELPER: Fetch domains from a provider ====================
async function fetchDomainsFromProvider(provider) {
  try {
    const res = await fetchWithTimeout(`${provider.base}/domains`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const members = data['hydra:member'] || [];
    return members
      .filter(d => d.isActive)
      .map(d => ({ domain: d.domain, provider: provider.name, providerBase: provider.base }));
  } catch (err) {
    console.error(`❌ Failed to fetch domains from ${provider.name}:`, err.message);
    return [];
  }
}

// ==================== API ROUTES ====================

// Get available real domains from all providers
app.get('/api/domains', async (req, res) => {
  try {
    // Use cache if available
    if (cachedDomains && Date.now() - domainsCacheTime < DOMAINS_CACHE_TTL) {
      return res.json({ success: true, domains: cachedDomains });
    }

    // Fetch from all providers in parallel
    const results = await Promise.all(PROVIDERS.map(p => fetchDomainsFromProvider(p)));
    const allDomains = results.flat();

    // Add Maildrop domain (always available, no API needed)
    allDomains.unshift({
      domain: MAILDROP.domain,
      provider: MAILDROP.name,
      providerBase: MAILDROP.graphql,
      isMaildrop: true
    });

    if (allDomains.length === 0) {
      throw new Error('No domains available');
    }

    cachedDomains = allDomains;
    domainsCacheTime = Date.now();

    console.log(`✅ Loaded ${allDomains.length} real domains from ${PROVIDERS.map(p => p.name).join(', ')}`);
    res.json({ success: true, domains: allDomains });
  } catch (err) {
    console.error('❌ Failed to fetch domains:', err.message);
    res.status(500).json({ success: false, message: 'Gagal mengambil domain' });
  }
});

// Create a real email account on mail.tm / mail.gw / maildrop
app.post('/api/emails', async (req, res) => {
  let { login, domain, provider, providerBase } = req.body;

  if (!domain) {
    return res.status(400).json({ success: false, message: 'Domain harus dipilih' });
  }

  // Generate random login if not provided, or append random to subdomain prefix
  if (!login || login.trim() === '') {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    login = '';
    for (let i = 0; i < 10; i++) login += chars.charAt(Math.floor(Math.random() * chars.length));
  } else if (login.trim().endsWith('-')) {
    // Subdomain prefix provided (e.g. "myshop-") — append random username
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let rand = '';
    for (let i = 0; i < 8; i++) rand += chars.charAt(Math.floor(Math.random() * chars.length));
    login = login.trim() + rand;
  }

  login = login.trim().toLowerCase();

  if (!/^[a-zA-Z0-9._-]+$/.test(login)) {
    return res.status(400).json({ success: false, message: 'Login hanya boleh huruf, angka, titik, underscore, dan tanda hubung' });
  }

  if (login.length < 3) {
    return res.status(400).json({ success: false, message: 'Login minimal 3 karakter' });
  }

  const address = `${login}@${domain}`;

  // Check if already created locally
  const exists = createdEmails.find(e => e.address === address);
  if (exists) {
    return res.json({ success: true, email: { id: exists.id, address: exists.address, createdAt: exists.createdAt }, existing: true });
  }

  // ========== MAILDROP: No registration needed ==========
  if (provider === 'maildrop' || domain === 'maildrop.cc') {
    const email = {
      id: uuidv4(),
      address,
      login,
      domain: 'maildrop.cc',
      password: null,
      provider: 'maildrop',
      providerBase: MAILDROP.graphql,
      accountId: null,
      token: null,
      isMaildrop: true,
      createdAt: new Date().toISOString()
    };

    createdEmails.push(email);
    console.log(`📧 Maildrop email created: ${address} (no signup needed)`);

    return res.json({
      success: true,
      email: { id: email.id, address: email.address, domain: email.domain, createdAt: email.createdAt }
    });
  }

  // ========== MAIL.TM / MAIL.GW: Need account creation ==========
  if (!providerBase) {
    return res.status(400).json({ success: false, message: 'Provider harus dipilih' });
  }

  // Create account on the provider
  const password = 'TempPass' + uuidv4().slice(0, 8) + '!';

  try {
    // Step 1: Create account
    const createRes = await fetchWithTimeout(`${providerBase}/accounts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address, password })
    });

    if (!createRes.ok) {
      const errData = await createRes.json().catch(() => ({}));
      const msg = errData['hydra:description'] || errData.message || `HTTP ${createRes.status}`;
      console.error(`❌ Failed to create account ${address}:`, msg);
      return res.status(400).json({ success: false, message: `Gagal membuat email: ${msg}` });
    }

    const accountData = await createRes.json();

    // Step 2: Get auth token
    const tokenRes = await fetchWithTimeout(`${providerBase}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address, password })
    });

    if (!tokenRes.ok) {
      throw new Error(`Failed to get token: HTTP ${tokenRes.status}`);
    }

    const tokenData = await tokenRes.json();

    const email = {
      id: uuidv4(),
      address,
      login,
      domain,
      password,
      provider,
      providerBase,
      accountId: accountData.id,
      token: tokenData.token,
      createdAt: new Date().toISOString()
    };

    createdEmails.push(email);
    console.log(`📧 Email created: ${address} (via ${provider})`);

    // Return without sensitive data
    res.json({
      success: true,
      email: { id: email.id, address: email.address, domain: email.domain, createdAt: email.createdAt }
    });

  } catch (err) {
    console.error(`❌ Error creating email ${address}:`, err.message);
    res.status(500).json({ success: false, message: 'Gagal membuat email: ' + err.message });
  }
});

// Get all created emails (public info only)
app.get('/api/emails', (req, res) => {
  const emails = createdEmails.map(e => ({
    id: e.id,
    address: e.address,
    domain: e.domain,
    provider: e.provider,
    isMaildrop: e.isMaildrop || false,
    createdAt: e.createdAt
  }));
  res.json({ success: true, emails });
});

// Delete a tracked email
app.delete('/api/emails/:id', async (req, res) => {
  const idx = createdEmails.findIndex(e => e.id === req.params.id);
  if (idx === -1) {
    return res.status(404).json({ success: false, message: 'Email tidak ditemukan' });
  }

  const email = createdEmails[idx];

  // Try to delete from provider (skip for Maildrop - no account to delete)
  if (!email.isMaildrop) {
    try {
      await fetchWithTimeout(`${email.providerBase}/accounts/${email.accountId}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${email.token}` }
      });
    } catch (err) {
      // Ignore deletion errors
    }
  }

  createdEmails.splice(idx, 1);
  console.log(`🗑️ Email deleted: ${email.address}`);
  res.json({ success: true });
});

// Refresh token if expired
async function ensureToken(email) {
  try {
    // Try to use existing token
    const testRes = await fetchWithTimeout(`${email.providerBase}/me`, {
      headers: { 'Authorization': `Bearer ${email.token}` }
    });

    if (testRes.ok) return true;

    // Token expired, get new one
    const tokenRes = await fetchWithTimeout(`${email.providerBase}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address: email.address, password: email.password })
    });

    if (tokenRes.ok) {
      const data = await tokenRes.json();
      email.token = data.token;
      return true;
    }

    return false;
  } catch (err) {
    return false;
  }
}

// ==================== MAILDROP GraphQL HELPER ====================
async function maildropQuery(query) {
  const res = await fetchWithTimeout(MAILDROP.graphql, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query })
  });
  if (!res.ok) throw new Error(`Maildrop API error: HTTP ${res.status}`);
  const data = await res.json();
  if (data.errors) throw new Error(data.errors[0].message);
  return data.data;
}

// Check mailbox - REAL incoming emails
app.get('/api/mailbox/:emailId', async (req, res) => {
  const email = createdEmails.find(e => e.id === req.params.emailId);
  if (!email) {
    return res.status(404).json({ success: false, message: 'Email tidak ditemukan' });
  }

  try {
    // ========== MAILDROP MAILBOX ==========
    if (email.isMaildrop) {
      const mailbox = email.login; // just the username part
      const data = await maildropQuery(`{ inbox(mailbox: "${mailbox}") { id headerfrom subject date } }`);
      const messages = (data.inbox || []).map(m => ({
        id: m.id,
        from: m.headerfrom || 'unknown',
        fromName: '',
        subject: m.subject || '(Tanpa Subjek)',
        intro: '',
        date: m.date,
        hasAttachments: false,
        seen: false
      }));
      return res.json({ success: true, messages, email: email.address });
    }

    // ========== MAIL.TM / MAIL.GW MAILBOX ==========
    await ensureToken(email);

    const url = `${email.providerBase}/messages?page=1`;
    const response = await fetchWithTimeout(url, {
      headers: { 'Authorization': `Bearer ${email.token}` }
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    const messages = (data['hydra:member'] || []).map(m => ({
      id: m.id,
      from: m.from?.address || 'unknown',
      fromName: m.from?.name || '',
      subject: m.subject || '(Tanpa Subjek)',
      intro: m.intro || '',
      date: m.createdAt,
      hasAttachments: m.hasAttachments || false,
      seen: m.seen || false
    }));

    res.json({ success: true, messages, email: email.address });
  } catch (err) {
    console.error(`❌ Failed to fetch mailbox for ${email.address}:`, err.message);
    res.status(500).json({ success: false, message: 'Gagal mengambil pesan' });
  }
});

// Read specific message - REAL message content
app.get('/api/mailbox/:emailId/message/:messageId', async (req, res) => {
  const email = createdEmails.find(e => e.id === req.params.emailId);
  if (!email) {
    return res.status(404).json({ success: false, message: 'Email tidak ditemukan' });
  }

  try {
    // ========== MAILDROP MESSAGE ==========
    if (email.isMaildrop) {
      const mailbox = email.login;
      const msgId = req.params.messageId;
      const data = await maildropQuery(`{ message(mailbox: "${mailbox}", id: "${msgId}") { id headerfrom mailfrom rcptto subject date data html } }`);
      const msg = data.message;
      if (!msg) throw new Error('Message not found');

      const message = {
        id: msg.id,
        from: msg.headerfrom || msg.mailfrom || 'unknown',
        fromName: '',
        to: msg.rcptto || email.address,
        subject: msg.subject || '(Tanpa Subjek)',
        textBody: msg.data || '',
        htmlBody: msg.html || '',
        date: msg.date,
        attachments: []
      };
      return res.json({ success: true, message });
    }

    // ========== MAIL.TM / MAIL.GW MESSAGE ==========
    await ensureToken(email);

    const url = `${email.providerBase}/messages/${req.params.messageId}`;
    const response = await fetchWithTimeout(url, {
      headers: { 'Authorization': `Bearer ${email.token}` }
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const msg = await response.json();

    const message = {
      id: msg.id,
      from: msg.from?.address || 'unknown',
      fromName: msg.from?.name || '',
      to: (msg.to || []).map(t => t.address).join(', '),
      subject: msg.subject || '(Tanpa Subjek)',
      textBody: msg.text || '',
      htmlBody: msg.html ? msg.html.join('') : '',
      date: msg.createdAt,
      attachments: (msg.attachments || []).map(a => ({
        filename: a.filename,
        contentType: a.contentType,
        size: a.size
      }))
    };

    res.json({ success: true, message });
  } catch (err) {
    console.error(`❌ Failed to read message:`, err.message);
    res.status(500).json({ success: false, message: 'Gagal membaca pesan' });
  }
});

// ==================== CLOUDFLARE API HELPERS ====================
async function cfAPI(method, endpoint, body = null) {
  const url = endpoint.startsWith('http') ? endpoint : `https://api.cloudflare.com/client/v4${endpoint}`;
  const opts = {
    method,
    headers: {
      'Authorization': `Bearer ${cfConfig.apiToken}`,
      'Content-Type': 'application/json'
    }
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetchWithTimeout(url, opts, 15000);
  return res.json();
}

// Create MX records for subdomain
async function cfCreateMXRecords(subdomain) {
  const fullDomain = `${subdomain}.${cfConfig.baseDomain}`;
  const mxServers = [
    { name: fullDomain, content: 'route1.mx.cloudflare.net', priority: 24 },
    { name: fullDomain, content: 'route2.mx.cloudflare.net', priority: 36 },
    { name: fullDomain, content: 'route3.mx.cloudflare.net', priority: 98 }
  ];

  const recordIds = [];
  for (const mx of mxServers) {
    const data = await cfAPI('POST', `/zones/${cfConfig.zoneId}/dns_records`, {
      type: 'MX',
      name: mx.name,
      content: mx.content,
      priority: mx.priority,
      ttl: 1
    });
    if (data.success && data.result?.id) {
      recordIds.push(data.result.id);
      console.log(`  ✅ MX record: ${mx.content} (priority ${mx.priority})`);
    } else {
      console.error(`  ❌ MX record failed:`, data.errors);
    }
  }

  // SPF record
  await cfAPI('POST', `/zones/${cfConfig.zoneId}/dns_records`, {
    type: 'TXT',
    name: fullDomain,
    content: 'v=spf1 include:_spf.mx.cloudflare.net ~all',
    ttl: 1
  });

  return recordIds;
}

// Create catch-all routing rule for subdomain
// Cloudflare only supports literal matchers (exact email) or catch-all (type: all)
// For subdomain catch-all, we use the zone catch-all endpoint
async function cfCreateRoutingRule(subdomain, destinationEmail) {
  const fullDomain = `${subdomain}.${cfConfig.baseDomain}`;

  // Try method 1: Use catch-all endpoint (PUT) - this catches ALL unmatched emails in the zone
  console.log('    Trying catch-all rule...');
  const catchAllData = await cfAPI('PUT', `/zones/${cfConfig.zoneId}/email/routing/rules/catch_all`, {
    actions: [{ type: 'forward', value: [destinationEmail] }],
    matchers: [{ type: 'all' }],
    enabled: true,
    name: `Catch-all for ${fullDomain}`
  });

  if (catchAllData.success) {
    console.log('    ✅ Catch-all rule set');
    return catchAllData;
  }

  // Try method 2: Create a regular rule with literal matcher (no wildcard)
  // This won't work as catch-all but is a fallback
  console.log('    ⚠️ Catch-all failed, trying individual rule...');
  console.log('    Error:', catchAllData.errors?.[0]?.message);

  const regularData = await cfAPI('POST', `/zones/${cfConfig.zoneId}/email/routing/rules`, {
    actions: [{ type: 'forward', value: [destinationEmail] }],
    matchers: [{ type: 'all' }],
    enabled: true,
    name: `Forward for ${fullDomain}`
  });

  return regularData;
}

// Add destination address for verification
async function cfAddDestination(email) {
  // Try account-level endpoint first
  if (cfConfig.accountId) {
    const data = await cfAPI('POST', `/accounts/${cfConfig.accountId}/email/routing/addresses`, { email });
    if (data.success) return data;

    // If auth error, log detailed info
    const errMsg = data.errors?.[0]?.message || '';
    console.log(`    ⚠️ Account-level destination failed: ${errMsg}`);

    // If already exists, that's OK
    if (errMsg.includes('already') || errMsg.includes('exist') || data.errors?.[0]?.code === 1032) {
      return { success: true, alreadyExists: true };
    }
  }

  // Return failure with helpful message
  return {
    success: false,
    needsManualSetup: true,
    errors: [{ message: 'Token perlu permission Account-level: Email Routing Addresses (Edit). Atau tambahkan destination address manual di Cloudflare Dashboard.' }]
  };
}

// Check if destination address is already verified via Cloudflare API
async function cfCheckDestinationVerified(email) {
  try {
    if (!cfConfig.accountId) return false;
    const data = await cfAPI('GET', `/accounts/${cfConfig.accountId}/email/routing/addresses`);
    if (data.success && data.result) {
      const dest = data.result.find(d => d.email === email);
      if (dest) {
        console.log(`  📧 Destination ${email}: verified=${dest.verified}`);
        return dest.verified === true;
      }
    }
    return false;
  } catch (e) {
    console.error('  ❌ Check destination failed:', e.message);
    return false;
  }
}

// ==================== CLOUDFLARE API ROUTES ====================

// Get/Set Cloudflare config
app.get('/api/cloudflare/config', (req, res) => {
  res.json({
    success: true,
    config: {
      baseDomain: cfConfig.baseDomain,
      configured: cfConfig.configured,
      hasToken: !!cfConfig.apiToken,
      hasZoneId: !!cfConfig.zoneId,
      hasAccountId: !!cfConfig.accountId
    }
  });
});

app.post('/api/cloudflare/config', async (req, res) => {
  const { apiToken, zoneId, accountId, baseDomain } = req.body;

  if (!apiToken || !zoneId || !baseDomain) {
    return res.status(400).json({ success: false, message: 'API Token, Zone ID, dan Base Domain wajib diisi' });
  }

  try {
    const oldToken = cfConfig.apiToken;
    cfConfig.apiToken = apiToken;

    const data = await cfAPI('GET', `/zones/${zoneId}`);
    if (!data.success) {
      cfConfig.apiToken = oldToken;
      return res.status(400).json({ success: false, message: 'API Token atau Zone ID tidak valid: ' + (data.errors?.[0]?.message || 'unknown error') });
    }

    cfConfig = {
      apiToken,
      zoneId,
      accountId: accountId || data.result?.account?.id || '',
      baseDomain: baseDomain.toLowerCase().trim(),
      configured: true
    };

    console.log(`☁️ Cloudflare configured: ${cfConfig.baseDomain} (Zone: ${cfConfig.zoneId})`);
    res.json({ success: true, message: 'Cloudflare berhasil dikonfigurasi!' });
  } catch (err) {
    console.error('❌ Cloudflare config test failed:', err.message);
    res.status(500).json({ success: false, message: 'Gagal menghubungi Cloudflare: ' + err.message });
  }
});

// List subdomains
app.get('/api/cloudflare/subdomains', (req, res) => {
  res.json({
    success: true,
    subdomains: cfSubdomains.map(s => ({
      name: s.name,
      fullDomain: s.fullDomain,
      verified: s.verified,
      needsManualDestination: s.needsManualDestination || false,
      catchAllEmail: s.catchAllEmail.address,
      createdAt: s.createdAt
    })),
    baseDomain: cfConfig.baseDomain,
    configured: cfConfig.configured
  });
});

// Create a new subdomain
app.post('/api/cloudflare/subdomains', async (req, res) => {
  if (!cfConfig.configured) {
    return res.status(400).json({ success: false, message: 'Cloudflare belum dikonfigurasi. Buka Settings terlebih dahulu.' });
  }

  let { name } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ success: false, message: 'Nama subdomain harus diisi' });
  }

  name = name.trim().toLowerCase();
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(name)) {
    return res.status(400).json({ success: false, message: 'Subdomain hanya boleh huruf kecil, angka, dan tanda hubung' });
  }

  if (name.length < 2 || name.length > 30) {
    return res.status(400).json({ success: false, message: 'Subdomain harus 2-30 karakter' });
  }

  const fullDomain = `${name}.${cfConfig.baseDomain}`;
  if (cfSubdomains.find(s => s.name === name)) {
    return res.status(400).json({ success: false, message: `Subdomain ${fullDomain} sudah ada` });
  }

  try {
    console.log(`\n☁️ Creating subdomain: ${fullDomain}`);

    // Step 1: Create catch-all email on mail.tm/mail.gw
    console.log('  📧 Step 1: Creating catch-all email...');
    const catchLogin = `cf-${name}-${uuidv4().slice(0, 6)}`;
    let catchAllEmail = null;

    for (const provider of PROVIDERS) {
      try {
        const domainsRes = await fetchWithTimeout(`${provider.base}/domains`);
        if (!domainsRes.ok) continue;
        const domainsData = await domainsRes.json();
        const activeDomain = (domainsData['hydra:member'] || []).find(d => d.isActive);
        if (!activeDomain) continue;

        const catchAddress = `${catchLogin}@${activeDomain.domain}`;
        const catchPassword = 'CfCatch' + uuidv4().slice(0, 8) + '!';

        const createRes = await fetchWithTimeout(`${provider.base}/accounts`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ address: catchAddress, password: catchPassword })
        });
        if (!createRes.ok) continue;
        const accountData = await createRes.json();

        const tokenRes = await fetchWithTimeout(`${provider.base}/token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ address: catchAddress, password: catchPassword })
        });
        if (!tokenRes.ok) continue;
        const tokenData = await tokenRes.json();

        catchAllEmail = {
          address: catchAddress,
          password: catchPassword,
          provider: provider.name,
          providerBase: provider.base,
          accountId: accountData.id,
          token: tokenData.token,
          domain: activeDomain.domain
        };
        console.log(`  ✅ Catch-all: ${catchAddress} (via ${provider.name})`);
        break;
      } catch (e) { continue; }
    }

    if (!catchAllEmail) {
      return res.status(500).json({ success: false, message: 'Gagal membuat catch-all email. Coba lagi.' });
    }

    // Step 2: Add destination address on Cloudflare
    console.log('  📧 Step 2: Registering destination on Cloudflare...');
    const destResult = await cfAddDestination(catchAllEmail.address);
    const destOk = destResult.success;
    if (destResult.needsManualSetup) {
      console.log('  ⚠️ Destination needs manual setup in Cloudflare Dashboard');
      console.log('  ℹ️ Go to: Cloudflare Dashboard → Email → Email Routing → Destination addresses');
      console.log(`  ℹ️ Add & verify: ${catchAllEmail.address}`);
    } else {
      console.log('  Destination:', destOk ? '✅ OK' : `⚠️ ${destResult.errors?.[0]?.message || 'may need verification'}`);
    }

    // Step 3: Create MX records
    console.log('  🌐 Step 3: Creating MX records...');
    const mxRecordIds = await cfCreateMXRecords(name);

    // Step 4: Create routing rule
    console.log('  📨 Step 4: Creating routing rule...');
    const routeResult = await cfCreateRoutingRule(name, catchAllEmail.address);
    const routeRuleId = routeResult.result?.tag || routeResult.result?.id || null;
    console.log('  Routing:', routeResult.success ? '✅ OK' : `⚠️ ${routeResult.errors?.[0]?.message || 'check manually'}`);

    const subdomain = {
      id: uuidv4(),
      name,
      fullDomain,
      mxRecordIds,
      routeRuleId,
      catchAllEmail,
      verified: destOk && !destResult.needsManualSetup,
      needsManualDestination: !!destResult.needsManualSetup,
      createdAt: new Date().toISOString()
    };

    cfSubdomains.push(subdomain);
    console.log(`\n✅ Subdomain ${fullDomain} created!`);

    res.json({
      success: true,
      subdomain: {
        name: subdomain.name,
        fullDomain: subdomain.fullDomain,
        catchAllEmail: catchAllEmail.address,
        needsVerification: !subdomain.verified,
        createdAt: subdomain.createdAt
      },
      message: `Subdomain ${fullDomain} berhasil dibuat!`
    });

  } catch (err) {
    console.error(`❌ Failed to create subdomain:`, err.message);
    res.status(500).json({ success: false, message: 'Gagal membuat subdomain: ' + err.message });
  }
});

// Verify destination
app.post('/api/cloudflare/subdomains/:name/verify', async (req, res) => {
  const sub = cfSubdomains.find(s => s.name === req.params.name);
  if (!sub) return res.status(404).json({ success: false, message: 'Subdomain tidak ditemukan' });
  if (sub.verified) return res.json({ success: true, message: 'Sudah terverifikasi!' });

  try {
    console.log(`\n🔍 Verifying subdomain: ${sub.fullDomain}`);
    console.log(`  📧 Catch-all: ${sub.catchAllEmail.address}`);

    // Method 1: Check Cloudflare API directly if destination is already verified
    const alreadyVerified = await cfCheckDestinationVerified(sub.catchAllEmail.address);
    if (alreadyVerified) {
      sub.verified = true;
      console.log('  ✅ Already verified via Cloudflare API!');
      return res.json({ success: true, message: 'Verifikasi berhasil! Destination sudah terverifikasi.' });
    }

    // Method 2: Check catch-all inbox for verification email
    const catchEmail = sub.catchAllEmail;
    await ensureToken(catchEmail);

    const msgRes = await fetchWithTimeout(`${catchEmail.providerBase}/messages?page=1`, {
      headers: { 'Authorization': `Bearer ${catchEmail.token}` }
    });
    if (!msgRes.ok) {
      console.log('  ⚠️ Inbox check failed, status:', msgRes.status);
      throw new Error('Failed to check inbox');
    }
    const msgData = await msgRes.json();
    const messages = msgData['hydra:member'] || [];
    console.log(`  📬 Messages in inbox: ${messages.length}`);

    // Look for any email from Cloudflare
    const cfMessage = messages.find(m => {
      const from = (m.from?.address || '').toLowerCase();
      const subject = (m.subject || '').toLowerCase();
      return from.includes('cloudflare') || from.includes('noreply') ||
             subject.includes('verif') || subject.includes('confirm') ||
             subject.includes('email routing') || subject.includes('destination');
    });

    if (cfMessage) {
      console.log(`  📧 Found CF email: "${cfMessage.subject}" from ${cfMessage.from?.address}`);
      const fullMsg = await fetchWithTimeout(`${catchEmail.providerBase}/messages/${cfMessage.id}`, {
        headers: { 'Authorization': `Bearer ${catchEmail.token}` }
      });
      const fullMsgData = await fullMsg.json();
      const body = fullMsgData.text || (Array.isArray(fullMsgData.html) ? fullMsgData.html.join('') : fullMsgData.html || '');

      // Look for ANY https URL that looks like a verification link
      const allUrls = body.match(/https:\/\/[^\s"'<>\]\)]+/gi) || [];
      console.log(`  🔗 URLs found: ${allUrls.length}`);

      // Try Cloudflare-specific verification URLs first
      const verifyUrl = allUrls.find(u =>
        u.includes('cloudflare') && (u.includes('verif') || u.includes('confirm') || u.includes('email'))
      ) || allUrls.find(u =>
        u.includes('verif') || u.includes('confirm')
      ) || allUrls.find(u =>
        u.includes('cloudflare')
      );

      if (verifyUrl) {
        console.log(`  🔗 Trying verification URL: ${verifyUrl}`);
        try {
          const verRes = await fetchWithTimeout(verifyUrl, { redirect: 'follow' }, 15000);
          console.log(`  ✅ Verification URL status: ${verRes.status}`);
          sub.verified = true;
          return res.json({ success: true, message: 'Verifikasi berhasil!' });
        } catch (verErr) {
          console.log(`  ⚠️ Auto-verify failed: ${verErr.message}`);
          // Return the URL for manual verification
          return res.json({
            success: false,
            verifyUrl: verifyUrl,
            message: 'Auto-verifikasi gagal. Buka link ini di browser untuk verifikasi manual:'
          });
        }
      } else {
        console.log('  ⚠️ No verification URL found in email body');
        // Log first 500 chars of body for debugging
        console.log('  Body preview:', body.substring(0, 500));
      }
    } else {
      console.log('  ⚠️ No Cloudflare email found in inbox');
      if (messages.length > 0) {
        messages.forEach((m, i) => {
          console.log(`  [${i}] From: ${m.from?.address} Subject: ${m.subject}`);
        });
      }
    }

    // Method 3: Try to re-send destination verification
    console.log('  🔄 Re-requesting destination verification...');
    const reDest = await cfAddDestination(catchEmail.address);
    if (reDest.success) {
      console.log('  📧 Verification email re-sent');
      return res.json({ success: false, message: 'Email verifikasi dikirim ulang. Tunggu 10-30 detik, lalu klik Verifikasi lagi.' });
    } else {
      const errMsg = reDest.errors?.[0]?.message || '';
      // If error says "already exists", destination might already be verified
      if (errMsg.includes('already') || errMsg.includes('exist')) {
        // Check one more time
        const recheck = await cfCheckDestinationVerified(catchEmail.address);
        if (recheck) {
          sub.verified = true;
          return res.json({ success: true, message: 'Verifikasi berhasil!' });
        }
        return res.json({ success: false, message: 'Destination sudah terdaftar tapi belum terverifikasi. Cek email ' + catchEmail.address + ' atau coba lagi.' });
      }
      console.log('  ⚠️ Re-send result:', errMsg);
    }

    res.json({ success: false, message: 'Email verifikasi belum diterima. Tunggu 10-30 detik lalu coba lagi. Cloudflare mengirim ke: ' + catchEmail.address });
  } catch (err) {
    console.error('  ❌ Verify error:', err.message);
    res.status(500).json({ success: false, message: 'Gagal memeriksa: ' + err.message });
  }
});

// Delete subdomain
app.delete('/api/cloudflare/subdomains/:name', async (req, res) => {
  const idx = cfSubdomains.findIndex(s => s.name === req.params.name);
  if (idx === -1) return res.status(404).json({ success: false, message: 'Subdomain tidak ditemukan' });

  const sub = cfSubdomains[idx];
  try {
    for (const rid of (sub.mxRecordIds || [])) {
      await cfAPI('DELETE', `/zones/${cfConfig.zoneId}/dns_records/${rid}`).catch(() => {});
    }
    if (sub.routeRuleId) {
      await cfAPI('DELETE', `/zones/${cfConfig.zoneId}/email/routing/rules/${sub.routeRuleId}`).catch(() => {});
    }
    if (sub.catchAllEmail) {
      try {
        await fetchWithTimeout(`${sub.catchAllEmail.providerBase}/accounts/${sub.catchAllEmail.accountId}`, {
          method: 'DELETE', headers: { 'Authorization': `Bearer ${sub.catchAllEmail.token}` }
        });
      } catch {}
    }
  } catch {}

  // Also remove any emails on this subdomain
  for (let i = createdEmails.length - 1; i >= 0; i--) {
    if (createdEmails[i].cfSubdomain === sub.name) createdEmails.splice(i, 1);
  }

  cfSubdomains.splice(idx, 1);
  console.log(`🗑️ Subdomain deleted: ${sub.fullDomain}`);
  res.json({ success: true });
});

// Create email on a Cloudflare subdomain
app.post('/api/cloudflare/emails', async (req, res) => {
  let { login, subdomainName } = req.body;
  const sub = cfSubdomains.find(s => s.name === subdomainName);
  if (!sub) return res.status(404).json({ success: false, message: 'Subdomain tidak ditemukan' });

  if (!login || login.trim() === '') {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    login = '';
    for (let i = 0; i < 8; i++) login += chars.charAt(Math.floor(Math.random() * chars.length));
  }

  login = login.trim().toLowerCase();
  if (!/^[a-z0-9._-]+$/.test(login) || login.length < 2) {
    return res.status(400).json({ success: false, message: 'Login minimal 2 karakter, huruf/angka saja' });
  }

  const address = `${login}@${sub.fullDomain}`;
  const exists = createdEmails.find(e => e.address === address);
  if (exists) {
    return res.json({ success: true, email: { id: exists.id, address: exists.address, domain: sub.fullDomain, createdAt: exists.createdAt }, existing: true });
  }

  const email = {
    id: uuidv4(),
    address,
    login,
    domain: sub.fullDomain,
    password: sub.catchAllEmail.password,
    provider: 'cloudflare',
    providerBase: sub.catchAllEmail.providerBase,
    accountId: sub.catchAllEmail.accountId,
    token: sub.catchAllEmail.token,
    catchAllAddress: sub.catchAllEmail.address,
    cfSubdomain: sub.name,
    createdAt: new Date().toISOString()
  };

  createdEmails.push(email);
  console.log(`📧 CF Email: ${address} (→ ${sub.catchAllEmail.address})`);

  res.json({
    success: true,
    email: { id: email.id, address: email.address, domain: email.domain, createdAt: email.createdAt }
  });
});

// Check mailbox for CF email (reads catch-all and filters by recipient)
app.get('/api/cloudflare/mailbox/:emailId', async (req, res) => {
  const email = createdEmails.find(e => e.id === req.params.emailId && e.provider === 'cloudflare');
  if (!email) return res.status(404).json({ success: false, message: 'Email tidak ditemukan' });

  const sub = cfSubdomains.find(s => s.name === email.cfSubdomain);
  if (!sub) return res.status(404).json({ success: false, message: 'Subdomain tidak ditemukan' });

  try {
    const catchEmail = sub.catchAllEmail;
    await ensureToken(catchEmail);

    const msgRes = await fetchWithTimeout(`${catchEmail.providerBase}/messages?page=1`, {
      headers: { 'Authorization': `Bearer ${catchEmail.token}` }
    });
    if (!msgRes.ok) throw new Error(`HTTP ${msgRes.status}`);
    const msgData = await msgRes.json();
    const allMessages = msgData['hydra:member'] || [];

    // For catch-all, all messages go to the same inbox — show all of them
    // (Cloudflare forwards preserving original To: header)
    const messages = allMessages.map(m => ({
      id: m.id,
      from: m.from?.address || 'unknown',
      fromName: m.from?.name || '',
      subject: m.subject || '(Tanpa Subjek)',
      intro: m.intro || '',
      date: m.createdAt,
      hasAttachments: m.hasAttachments || false,
      seen: m.seen || false,
      to: (m.to || []).map(t => t.address).join(', ')
    }));

    res.json({ success: true, messages, email: email.address });
  } catch (err) {
    console.error(`❌ CF mailbox error:`, err.message);
    res.status(500).json({ success: false, message: 'Gagal mengambil pesan' });
  }
});

// Read specific message from CF mailbox
app.get('/api/cloudflare/mailbox/:emailId/message/:messageId', async (req, res) => {
  const email = createdEmails.find(e => e.id === req.params.emailId && e.provider === 'cloudflare');
  if (!email) return res.status(404).json({ success: false, message: 'Email tidak ditemukan' });

  const sub = cfSubdomains.find(s => s.name === email.cfSubdomain);
  if (!sub) return res.status(404).json({ success: false, message: 'Subdomain tidak ditemukan' });

  try {
    const catchEmail = sub.catchAllEmail;
    await ensureToken(catchEmail);

    const msgRes = await fetchWithTimeout(`${catchEmail.providerBase}/messages/${req.params.messageId}`, {
      headers: { 'Authorization': `Bearer ${catchEmail.token}` }
    });
    if (!msgRes.ok) throw new Error(`HTTP ${msgRes.status}`);
    const msg = await msgRes.json();

    res.json({
      success: true,
      message: {
        id: msg.id,
        from: msg.from?.address || 'unknown',
        fromName: msg.from?.name || '',
        to: (msg.to || []).map(t => t.address).join(', '),
        subject: msg.subject || '(Tanpa Subjek)',
        textBody: msg.text || '',
        htmlBody: msg.html ? msg.html.join('') : '',
        date: msg.createdAt,
        attachments: (msg.attachments || []).map(a => ({
          filename: a.filename, contentType: a.contentType, size: a.size
        }))
      }
    });
  } catch (err) {
    console.error(`❌ CF read message failed:`, err.message);
    res.status(500).json({ success: false, message: 'Gagal membaca pesan' });
  }
});

// ==================== PROXY ROUTES ====================
app.get('/api/proxy/status', (req, res) => {
  res.json({ success: true, activeProxy });
});

app.post('/api/proxy/set', (req, res) => {
  const { proxyUrl } = req.body;
  if (proxyUrl === null || proxyUrl === '') {
    activeProxy = null;
    return res.json({ success: true, message: 'Proxy dinonaktifkan' });
  }
  
  // Basic validation
  if (!proxyUrl.startsWith('http://') && !proxyUrl.startsWith('https://')) {
    return res.status(400).json({ success: false, message: 'Format proxy tidak valid (harus http:// atau https://)' });
  }
  
  activeProxy = proxyUrl;
  res.json({ success: true, message: `Proxy diatur ke ${proxyUrl}` });
});

// Fallback to index.html for SPA
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

if (process.env.NODE_ENV !== 'production') {
  app.listen(PORT, () => {
    console.log(`✅ Email Temp Server running at http://localhost:${PORT}`);
    console.log(`📧 Using mail.tm & mail.gw APIs for REAL temporary emails`);
    console.log(`☁️ Cloudflare Email Routing available for custom subdomains`);
  });
}

module.exports = app;
