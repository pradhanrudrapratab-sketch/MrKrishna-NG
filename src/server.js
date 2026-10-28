import express from 'express';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import { authenticator } from 'otplib';
import { config } from './config.js';
import { createAdminSession, revokeAdminSession, verifyTotp, requireAdmin, adminSessionCookieOptions } from './auth.js';
import { bootstrapWhatsApp, requestPairingCode, getWhatsAppStatus, exportSession, sessionFormatValid, sendWhatsAppMessage, shutdownWhatsApp } from './whatsapp.js';

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS || 1));
app.use(express.json({ limit: '1200kb' }));
app.use(cookieParser());
const events = [];
function logEvent(level, message, extra = {}) {
  const safe = { time: new Date().toISOString(), level, message, ...extra };
  events.unshift(safe);
  if (events.length > 100) events.pop();
  const out = { ...safe };
  console.log(JSON.stringify(out));
}
const notifyLimiter = rateLimit({ windowMs: 60_000, limit: 10, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'Rate limit exceeded. Maximum 10 requests per IP per minute.' } });
const sendLimiter = rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'Rate limit exceeded. Try again later.' } });
const loginLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 8, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'Too many login attempts. Try again in 15 minutes.' } });

const healthHtml = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>MrKrishna NG · Health</title><style>*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#111018;color:#f6f2ff;font:16px system-ui,-apple-system,Segoe UI,sans-serif}.card{width:min(92vw,440px);padding:28px;border:1px solid #30283f;border-radius:20px;background:#171420}.brand{font-weight:750;font-size:20px;letter-spacing:.2px}.row{display:flex;align-items:center;gap:14px;margin-top:28px}.dot{width:44px;height:44px;border-radius:50%;display:grid;place-items:center;background:#153b2a;color:#5ee09b;font-size:24px}.state{color:#5ee09b;font-weight:700;font-size:19px}.sub{color:#b9b1c8;font-size:14px;margin-top:4px}.foot{border-top:1px solid #30283f;margin-top:25px;padding-top:16px;color:#938ba1;font-size:12px}</style></head><body><main class="card"><div class="brand">MrKrishna NG</div><div class="row"><div class="dot">✓</div><div><div class="state">Service Active</div><div class="sub">The server is responding normally.</div></div></div><div class="foot">Lightweight HTML health check · HTTP service only</div></main></body></html>`;
app.get('/health', (_req, res) => res.status(200).set({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate', 'Pragma': 'no-cache', 'Expires': '0' }).send(healthHtml));

function validNumber(value) { return typeof value === 'string' && /^\+?\d[\d\s()-]{6,18}\d$/.test(value.trim()) && value.replace(/\D/g, '').length >= 8 && value.replace(/\D/g, '').length <= 15; }
function buildMessage(body) {
  const title = typeof body?.title === 'string' ? body.title.trim() : '';
  const subject = typeof body?.subject === 'string' ? body.subject.trim() : '';
  const message = typeof body?.message === 'string' ? body.message.trim() : '';
  if (!title || !message) return { error: 'title and message are required.' };
  if (title.length > 120 || subject.length > 180 || message.length > 3500) return { error: 'title max 120, subject max 180, message max 3500 characters.' };
  return { text: ['MrKrishna NG', title, subject ? `Subject: ${subject}` : '', '', message, '', 'Powered by @mrkrishna.in'].filter((line, i, arr) => !(line === '' && arr[i - 1] === '')).join('\n') };
}
async function sendResponse(req, res, to) {
  const formatted = buildMessage(req.body);
  if (formatted.error) return res.status(400).json({ error: formatted.error });
  try {
    const result = await sendWhatsAppMessage(to, formatted.text);
    logEvent('info', 'Message accepted by WhatsApp socket', { recipient: `${to.slice(0, 2)}******${to.slice(-2)}`, messageId: result.messageId });
    return res.status(200).json({ ok: true, recipient: to, messageId: result.messageId, note: 'Accepted by WhatsApp socket; this does not guarantee recipient read/delivery.' });
  } catch (error) {
    logEvent('error', 'Message send failed', { error: String(error.message).slice(0, 180) });
    return res.status(503).json({ error: 'WhatsApp is not ready or message send failed.', detail: String(error.message).slice(0, 180) });
  }
}
app.post('/api/notify', notifyLimiter, async (req, res) => sendResponse(req, res, config.ownerNumber));
app.post('/api/send', sendLimiter, async (req, res, next) => {
  const key = req.get('X-API-Key');
  if (!key || key.length !== config.apiKey.length || !await timingSafeStringEqual(key, config.apiKey)) return res.status(401).json({ error: 'Missing or invalid X-API-Key.' });
  const to = req.body?.to;
  if (to !== undefined && to !== null && to !== '' && !validNumber(to)) return res.status(400).json({ error: 'Invalid recipient number. Use country code and digits, e.g. 919876543210.' });
  const recipient = to ? String(to).replace(/\D/g, '') : config.ownerNumber;
  return sendResponse(req, res, recipient);
});
async function timingSafeStringEqual(a, b) {
  const { timingSafeEqual } = await import('node:crypto');
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

app.get('/api/docs', (_req, res) => res.json({ endpoints: [
  { method: 'GET', path: '/health', auth: 'none', description: 'Lightweight HTML page; HTTP service only.' },
  { method: 'POST', path: '/api/notify', auth: 'none', rateLimit: '10 requests/IP/minute', body: { title: 'string, required', subject: 'string, optional', message: 'string, required' }, description: 'Always sends to OWNER_NUMBER.' },
  { method: 'POST', path: '/api/send', auth: 'X-API-Key', rateLimit: '60 requests/IP/minute', body: { to: 'string, optional; defaults to OWNER_NUMBER', title: 'string, required', subject: 'string, optional', message: 'string, required' }, description: 'Sends to supplied recipient or OWNER_NUMBER.' }
] }));

app.post('/api/admin/login', loginLimiter, (req, res) => {
  if (!verifyTotp(req.body?.code, config.totpSecret)) {
    logEvent('warn', 'Admin login rejected');
    return res.status(401).json({ error: 'Invalid TOTP code.' });
  }
  const token = createAdminSession();
  res.cookie('mk_admin_session', token, adminSessionCookieOptions());
  logEvent('info', 'Admin login successful');
  return res.json({ ok: true });
});
app.post('/api/admin/logout', requireAdmin, (req, res) => {
  revokeAdminSession(req.cookies?.mk_admin_session);
  res.clearCookie('mk_admin_session', adminSessionCookieOptions());
  return res.json({ ok: true });
});
app.get('/api/admin/state', requireAdmin, (_req, res) => res.json({ whatsapp: getWhatsAppStatus(), logs: events }));
app.post('/api/admin/pairing/retry', requireAdmin, async (_req, res) => {
  try {
    await requestPairingCode();
    const state = getWhatsAppStatus();
    return res.json({ ok: true, pairingCode: state.pairingCode, status: state.status, message: 'Pairing code requested. On the WhatsApp account you want to link, open Linked Devices → Link a device → Link with phone number instead, then enter the code.' });
  } catch (error) {
    logEvent('error', 'Pairing code request failed', { error: String(error.message).slice(0, 180) });
    return res.status(400).json({ error: error.message });
  }
});
app.get('/api/admin/session/export', requireAdmin, async (_req, res) => {
  const value = await exportSession();
  if (!value) return res.status(404).json({ error: 'No session snapshot available yet. Pair WhatsApp first.' });
  res.set('Cache-Control', 'no-store');
  return res.json({ format: 'base64-encoded JSON bundle of all Baileys auth-store files (credentials and Signal keys)', session: value, warning: 'Sensitive credential. Do not share, message, commit, or log this value.' });
});
app.post('/api/admin/session/import-check', requireAdmin, (req, res) => {
  const session = req.body?.session;
  if (typeof session !== 'string' || session.length > 1_000_000) return res.status(400).json({ valid: false, error: 'Session must be a base64 string under 1 MB.' });
  return res.json({ valid: sessionFormatValid(session), note: 'Format-only check; live session validity is not guaranteed.' });
});
app.post('/api/admin/test-send', requireAdmin, async (req, res) => {
  const body = { title: 'Admin Test', subject: 'MrKrishna NG', message: typeof req.body?.message === 'string' && req.body.message.trim() ? req.body.message.trim().slice(0, 1000) : 'Your WhatsApp API test message is working.' };
  const result = buildMessage(body);
  try {
    const sent = await sendWhatsAppMessage(config.ownerNumber, result.text);
    logEvent('info', 'Admin test message accepted', { messageId: sent.messageId });
    return res.json({ ok: true, messageId: sent.messageId });
  } catch (error) { return res.status(503).json({ error: error.message }); }
});

const adminHtml = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>MrKrishna NG · Admin</title><style>
:root{color-scheme:dark;--bg:#100d17;--panel:#191421;--line:#33283f;--muted:#a99eb8;--text:#f5efff;--accent:#b69aff;--good:#5ee09b;--bad:#ff8888}*{box-sizing:border-box}body{margin:0;background:radial-gradient(ellipse at 20% 0%,#28183b 0,transparent 42%),var(--bg);color:var(--text);font:15px system-ui,-apple-system,Segoe UI,sans-serif}main{max-width:1100px;margin:auto;padding:24px 16px 60px}.top{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:24px}.brand{font-size:22px;font-weight:800;letter-spacing:.2px}.muted{color:var(--muted)}.grid{display:grid;grid-template-columns:220px minmax(0,1fr);gap:18px}.panel,.nav,.login{border:1px solid var(--line);background:#191421eF;border-radius:18px;padding:18px}.nav{align-self:start;display:flex;flex-direction:column;gap:6px}.nav button{text-align:left;background:transparent;border:0;color:var(--muted);padding:11px 12px;border-radius:10px;cursor:pointer}.nav button.active,.nav button:hover{background:#2a2037;color:var(--text)}.content{display:grid;gap:16px}.hidden{display:none!important}h1{font-size:24px;margin:0 0 8px}h2{font-size:17px;margin:0 0 14px}p{line-height:1.55}.row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.between{justify-content:space-between}.pill{display:inline-flex;align-items:center;gap:7px;padding:6px 10px;border:1px solid var(--line);border-radius:99px;color:var(--muted);font-size:12px}.pill.good{color:var(--good);border-color:#275e43}.pill.bad{color:var(--bad);border-color:#6a3333}label{display:block;color:var(--muted);font-size:13px;margin:12px 0 6px}input,textarea{width:100%;padding:12px 13px;border-radius:10px;border:1px solid var(--line);background:#100d17;color:var(--text);font:inherit}textarea{min-height:110px;resize:vertical}button.primary,button.secondary{border:1px solid var(--line);padding:10px 14px;border-radius:10px;font:inherit;cursor:pointer;color:var(--text);background:#2b2138}button.primary{background:#a88be9;border-color:#a88be9;color:#170f22;font-weight:700}button:disabled{opacity:.5;cursor:not-allowed}.stat{font-size:22px;font-weight:750}.endpoint{border:1px solid var(--line);border-radius:13px;padding:14px;margin:12px 0}.method{font-size:11px;font-weight:800;padding:4px 7px;border-radius:6px;background:#193b2a;color:#7ce4aa}.method.post{background:#3c2c1a;color:#ffce8c}.path{font-family:ui-monospace,monospace;font-weight:700}.code{background:#0e0b13;border:1px solid var(--line);padding:13px;border-radius:10px;white-space:pre-wrap;overflow-wrap:anywhere;font:12px ui-monospace,monospace;color:#d9caee}.status{font-size:13px;white-space:pre-wrap;overflow-wrap:anywhere}.log{padding:10px 0;border-bottom:1px solid #30263a;font-size:13px}.error{color:var(--bad)}.ok{color:var(--good)}.login{max-width:420px;margin:9vh auto}.small{font-size:12px}.danger{color:var(--bad)}@media(max-width:760px){.grid{grid-template-columns:1fr}.nav{display:grid;grid-template-columns:repeat(2,minmax(0,1fr))}.brand{font-size:19px}main{padding:16px 12px 40px}}
</style></head><body><main><div class="top"><div><div class="brand">MrKrishna NG</div><div class="muted small">WhatsApp notification gateway</div></div><span class="pill">Personal API</span></div>
<section id="loginView" class="login"><h1>Admin login</h1><p class="muted">Enter the six-digit code from your authenticator app.</p><form id="loginForm"><label for="totp">Authenticator code</label><input id="totp" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]{6}" required placeholder="000000"><div style="margin-top:14px"><button class="primary" type="submit">Sign in</button></div><p id="loginMessage" class="status"></p></form><p class="muted small">TOTP only · No password. Configure ADMIN_TOTP_SECRET in Render.</p></section>
<section id="appView" class="hidden"><div class="grid"><nav class="nav"><button class="active" data-tab="overview">Overview</button><button data-tab="docs">API documentation</button><button data-tab="try">Try API</button><button data-tab="pairing">Pairing & session</button><button data-tab="logs">Logs</button><button data-tab="guides">Integration guides</button><button id="logoutBtn">Log out</button></nav><div class="content">
<section class="panel tab" id="tab-overview"><div class="row between"><div><h1>Overview</h1><div class="muted">Connection status and API quick reference.</div></div><button class="secondary" id="refreshBtn">Refresh status</button></div><div class="row" style="margin:18px 0"><span class="pill" id="waStatus">Loading status…</span><span class="pill" id="sessionStatus">Session: checking</span></div><div class="row"><div class="panel" style="flex:1"><div class="muted small">Pairing attempts</div><div class="stat" id="attemptCount">— / 3</div></div><div class="panel" style="flex:1"><div class="muted small">Idle disconnect</div><div class="stat">60 sec</div></div></div><p class="muted small">/health checks only whether this HTTP service responds. It intentionally does not check WhatsApp.</p><div id="overviewError" class="status error"></div></section>
<section class="panel tab hidden" id="tab-docs"><h1>API documentation</h1><p class="muted">Use these examples in your projects. API key values are never displayed here.</p><div class="endpoint"><div class="row"><span class="method">GET</span><span class="path">/health</span><button class="secondary" data-copy="/health">Copy path</button></div><p class="muted">Returns a tiny HTML page showing HTTP service status. No auth, no DB or WhatsApp checks.</p></div><div class="endpoint"><div class="row"><span class="method post">POST</span><span class="path">/api/notify</span><button class="secondary" data-copy="/api/notify">Copy path</button></div><p class="muted">No API key. Always sends to OWNER_NUMBER. Limit 10 requests per IP per minute.</p><div class="code">{\n  "title": "Payment Successful",\n  "subject": "Order #1024",\n  "message": "Payment received."\n}</div><button class="secondary" data-copy='{"title":"Payment Successful","subject":"Order #1024","message":"Payment received."}'>Copy JSON</button></div><div class="endpoint"><div class="row"><span class="method post">POST</span><span class="path">/api/send</span><button class="secondary" data-copy="/api/send">Copy path</button></div><p class="muted">Requires <code>X-API-Key</code>. Optional <code>to</code>; missing recipient falls back to OWNER_NUMBER; invalid recipient returns 400.</p><div class="code">{\n  "to": "919876543210",\n  "title": "Tournament Update",\n  "subject": "Crown Arena",\n  "message": "Your match starts soon."\n}</div><button class="secondary" data-copy='{"to":"919876543210","title":"Tournament Update","subject":"Crown Arena","message":"Your match starts soon."}'>Copy JSON</button></div><div class="endpoint"><h2>Message format</h2><div class="code">MrKrishna NG\nPayment Successful\nSubject: Order #1024\n\nPayment received.\n\nPowered by @mrkrishna.in</div><p class="muted small">Title max 120 chars, subject max 180, message max 3500. WhatsApp text messages don't have native header/footer fields; these are formatted into the message body.</p></div></section>
<section class="panel tab hidden" id="tab-try"><h1>Try API</h1><p class="muted">Send a test through your server. The admin test always targets OWNER_NUMBER.</p><form id="testForm"><label for="testMessage">Message</label><textarea id="testMessage" maxlength="1000">Your WhatsApp API test message is working.</textarea><div style="margin-top:12px"><button class="primary">Send test message</button></div></form><p id="testResult" class="status"></p><hr style="border:0;border-top:1px solid var(--line);margin:22px 0"><h2>External API request builder</h2><label>Endpoint</label><select id="endpointSelect" style="width:100%;padding:12px;background:#100d17;color:var(--text);border:1px solid var(--line);border-radius:10px"><option value="/api/notify">/api/notify (no key)</option><option value="/api/send">/api/send (API key required in your own client)</option></select><label>Title</label><input id="tryTitle" value="Payment Successful"><label>Subject (optional)</label><input id="trySubject" value="Order #1024"><label>Message</label><textarea id="tryBody">Payment received.</textarea><button type="button" class="secondary" id="copyCurl" style="margin-top:12px">Generate & copy cURL</button><p class="muted small">For /api/send, add your X-API-Key in your own terminal/client. The dashboard will not reveal or embed your secret.</p><div id="curlPreview" class="code hidden"></div></section>
<section class="panel tab hidden" id="tab-pairing"><h1>Pairing & session</h1><p class="muted">Pair with phone number, not QR. On the WhatsApp account you want to link: Linked Devices → Link a device → Link with phone number instead.</p><div class="row"><span class="pill" id="pairStatus">Status loading</span><span class="pill" id="pairAttempts">0 / 3 attempts</span></div><div id="pairCodeBox" class="hidden" style="margin:18px 0"><label>Pairing code — sensitive</label><div class="code" id="pairCode" style="font-size:22px;letter-spacing:2px"></div><button class="secondary" id="copyPairCode">Copy code</button></div><button class="primary" id="retryPair">Request pairing code / Retry</button><p id="pairResult" class="status"></p><hr style="border:0;border-top:1px solid var(--line);margin:22px 0"><h2>Session export</h2><p class="muted">Export the latest session snapshot, then manually paste it into Render's WHATSAPP_SESSION environment variable and redeploy. This snapshot is a credential.</p><button class="secondary" id="exportSession">Export session string</button><p id="exportMessage" class="status"></p><textarea id="sessionText" class="hidden" readonly placeholder="Session export will appear here"></textarea><button class="secondary hidden" id="copySession">Copy session</button><p class="danger small">Never send this string through WhatsApp, commit it to Git, or show it to anyone. Updating the Render env variable requires a manual copy/redeploy unless you separately configure Render API access.</p><h2>Session format check</h2><textarea id="sessionCheck" placeholder="Paste a session export to check its JSON format"></textarea><button class="secondary" id="checkSession" style="margin-top:10px">Check format</button><p id="sessionCheckResult" class="status"></p></section>
<section class="panel tab hidden" id="tab-logs"><div class="row between"><h1>Recent logs</h1><button class="secondary" id="refreshLogs">Refresh</button></div><p class="muted small">In-memory events; reset on service restart. Credentials and API keys are not logged.</p><div id="logsList" class="muted">Loading…</div></section>
<section class="panel tab hidden" id="tab-guides"><h1>Integration guides</h1><div class="endpoint"><h2>JavaScript fetch</h2><div class="code">await fetch('https://YOUR-SERVICE.onrender.com/api/send', {\n  method: 'POST',\n  headers: {\n    'Content-Type': 'application/json',\n    'X-API-Key': process.env.MRKRISHNA_API_KEY\n  },\n  body: JSON.stringify({\n    to: '919876543210',\n    title: 'Payment Successful',\n    subject: 'Order #1024',\n    message: 'Payment received.'\n  })\n});</div><button class="secondary" data-copy="await fetch('https://YOUR-SERVICE.onrender.com/api/send', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-API-Key': process.env.MRKRISHNA_API_KEY }, body: JSON.stringify({ to: '919876543210', title: 'Payment Successful', subject: 'Order #1024', message: 'Payment received.' }) });">Copy example</button></div><div class="endpoint"><h2>cURL</h2><div class="code">curl -X POST https://YOUR-SERVICE.onrender.com/api/notify \\\n  -H 'Content-Type: application/json' \\\n  -d '{"title":"Payment Successful","subject":"Order #1024","message":"Payment received."}'</div><button class="secondary" data-copy="curl -X POST https://YOUR-SERVICE.onrender.com/api/notify -H 'Content-Type: application/json' -d '{\"title\":\"Payment Successful\",\"subject\":\"Order #1024\",\"message\":\"Payment received.\"}'">Copy example</button></div><div class="endpoint"><h2>Webhook integration</h2><p class="muted">From your backend webhook handler, call /api/send using your secret stored in the sender project's environment variables. Do not call the key-protected endpoint directly from a public browser or mobile app, because the key can be extracted.</p></div><div class="endpoint"><h2>Response meanings</h2><p><code>200</code> means accepted by the WhatsApp socket, not guaranteed delivered/read. <code>400</code> invalid payload/number. <code>401</code> missing/invalid API key. <code>429</code> rate limit. <code>503</code> WhatsApp connection/send failure.</p></div></section>
</div></div></section></main><script>
const $=id=>document.getElementById(id);let refreshTimer=null;
async function api(url,options={}){const r=await fetch(url,{credentials:'same-origin',...options,headers:{'Content-Type':'application/json',...(options.headers||{})}});let data={};try{data=await r.json()}catch{}if(!r.ok)throw new Error(data.error||('Request failed ('+r.status+')'));return data}
function showApp(){ $('loginView').classList.add('hidden');$('appView').classList.remove('hidden');refreshState();if(refreshTimer)clearInterval(refreshTimer);refreshTimer=setInterval(refreshState,15000)}
function showLogin(){ $('appView').classList.add('hidden');$('loginView').classList.remove('hidden');if(refreshTimer)clearInterval(refreshTimer)}
$('loginForm').addEventListener('submit',async e=>{e.preventDefault();$('loginMessage').textContent='Signing in…';try{await api('/api/admin/login',{method:'POST',body:JSON.stringify({code:$('totp').value})});$('loginMessage').textContent='';$('totp').value='';showApp()}catch(err){$('loginMessage').textContent=err.message;$('loginMessage').className='status error'}});
$('logoutBtn').addEventListener('click',async()=>{try{await api('/api/admin/logout',{method:'POST',body:'{}'})}catch{}showLogin()});
document.querySelectorAll('[data-tab]').forEach(b=>b.addEventListener('click',()=>{document.querySelectorAll('[data-tab]').forEach(x=>x.classList.toggle('active',x===b));document.querySelectorAll('.tab').forEach(x=>x.classList.toggle('hidden',x.id!=='tab-'+b.dataset.tab));if(b.dataset.tab==='logs')refreshLogs()}));
async function refreshState(){try{const d=await api('/api/admin/state');const w=d.whatsapp;$('waStatus').textContent='WhatsApp: '+w.status;$('waStatus').className='pill '+(w.status==='connected'?'good':'');$('sessionStatus').textContent='Session: '+(w.sessionAvailable?'available':'not exported');$('attemptCount').textContent=w.pairingAttempts+' / 3';$('pairStatus').textContent='Status: '+w.status;$('pairAttempts').textContent=w.pairingAttempts+' / 3 attempts';$('pairCodeBox').classList.toggle('hidden',!w.pairingCode);if(w.pairingCode)$('pairCode').textContent=w.pairingCode;$('overviewError').textContent=w.lastError||'';renderLogs(d.logs)}catch(err){if(err.message.includes('login'))showLogin();else $('overviewError').textContent=err.message}}
function renderLogs(logs){$('logsList').innerHTML='';if(!logs?.length){$('logsList').textContent='No events yet.';return}for(const l of logs){const d=document.createElement('div');d.className='log';const t=document.createElement('div');t.className='muted small';t.textContent=l.time+' · '+l.level;const m=document.createElement('div');m.textContent=l.message+(l.error?' — '+l.error:'');d.append(t,m);$('logsList').append(d)}}
$('refreshBtn').addEventListener('click',refreshState);$('refreshLogs').addEventListener('click',refreshState);
$('testForm').addEventListener('submit',async e=>{e.preventDefault();$('testResult').textContent='Sending…';try{const d=await api('/api/admin/test-send',{method:'POST',body:JSON.stringify({message:$('testMessage').value})});$('testResult').textContent='Accepted by WhatsApp socket. Message ID: '+(d.messageId||'n/a');$('testResult').className='status ok'}catch(err){$('testResult').textContent=err.message;$('testResult').className='status error'}});
$('retryPair').addEventListener('click',async()=>{ $('pairResult').textContent='Requesting pairing code…';try{const d=await api('/api/admin/pairing/retry',{method:'POST',body:'{}'});$('pairResult').textContent=d.message;$('pairCodeBox').classList.toggle('hidden',!d.pairingCode);if(d.pairingCode)$('pairCode').textContent=d.pairingCode;refreshState()}catch(err){$('pairResult').textContent=err.message;$('pairResult').className='status error'}});
$('copyPairCode').addEventListener('click',()=>navigator.clipboard.writeText($('pairCode').textContent));
$('exportSession').addEventListener('click',async()=>{ $('exportMessage').textContent='Exporting…';try{const d=await api('/api/admin/session/export');$('sessionText').value=d.session;$('sessionText').classList.remove('hidden');$('copySession').classList.remove('hidden');$('exportMessage').textContent=d.warning;$('exportMessage').className='status error'}catch(err){$('exportMessage').textContent=err.message;$('exportMessage').className='status error'}});
$('copySession').addEventListener('click',async()=>{await navigator.clipboard.writeText($('sessionText').value);$('exportMessage').textContent='Copied. Paste it only into Render WHATSAPP_SESSION.'});
$('checkSession').addEventListener('click',async()=>{try{const d=await api('/api/admin/session/import-check',{method:'POST',body:JSON.stringify({session:$('sessionCheck').value.trim()})});$('sessionCheckResult').textContent=d.valid?'Format looks valid. '+d.note:'Invalid session export format.';$('sessionCheckResult').className='status '+(d.valid?'ok':'error')}catch(err){$('sessionCheckResult').textContent=err.message}});
$('copyCurl').addEventListener('click',async()=>{const endpoint=$('endpointSelect').value;const body={title:$('tryTitle').value,subject:$('trySubject').value,message:$('tryBody').value};const lines=['curl -X POST https://YOUR-SERVICE.onrender.com'+endpoint,"  -H 'Content-Type: application/json'"];if(endpoint==='/api/send')lines.push("  -H 'X-API-Key: YOUR_API_KEY'");lines.push("  --data-raw '"+JSON.stringify(body).replace(/'/g,"'\\''")+"'");const curl=lines.join('\\n');$('curlPreview').textContent=curl;$('curlPreview').classList.remove('hidden');await navigator.clipboard.writeText(curl)});
document.querySelectorAll('[data-copy]').forEach(b=>b.addEventListener('click',async()=>{await navigator.clipboard.writeText(b.dataset.copy);const old=b.textContent;b.textContent='Copied';setTimeout(()=>b.textContent=old,1000)}));
api('/api/admin/state').then(showApp).catch(()=>showLogin());
</script></body></html>`;
app.get('/', (_req, res) => res.set('Cache-Control', 'no-store').type('html').send(adminHtml));
app.use((err, _req, res, _next) => {
  logEvent('error', 'Unhandled request error', { error: String(err.message).slice(0, 160) });
  res.status(500).json({ error: 'Internal server error.' });
});
const server = app.listen(config.port, '0.0.0.0', async () => {
  console.log(`MrKrishna NG listening on port ${config.port}`);
  await bootstrapWhatsApp();
});
async function shutdown() { await shutdownWhatsApp(); server.close(() => process.exit(0)); setTimeout(() => process.exit(1), 5000).unref(); }
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
