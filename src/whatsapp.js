import {
  makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  delay,
  makeCacheableSignalKeyStore,
  Browsers,
  fetchLatestBaileysVersion,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import phoneNumber from 'awesome-phonenumber';
import { config } from './config.js';

const logger = pino({ level: 'silent' });
const authDir = '/tmp/mk-wa-auth';
const MAX_PAIRING_ATTEMPTS = 3;
const MAX_RECONNECT_ATTEMPTS = 5;

let socket = null;
let connecting = null;
let latestExport = config.sessionExport || '';
let connectionStatus = config.sessionExport ? 'connecting' : 'not-paired';
let pairingCode = null;
let pairingAttempts = 0;
let reconnectAttempts = 0;
let reconnectTimer = null;
let idleTimer = null;
let lastActivityAt = null;
let lastError = null;
let sendQueue = Promise.resolve();
let manuallyDisconnecting = false;

function b64ToUtf8(value) { return Buffer.from(value, 'base64').toString('utf8'); }
function utf8ToB64(value) { return Buffer.from(value, 'utf8').toString('base64'); }

async function applyEnvSession() {
  if (!latestExport) return false;
  try {
    const parsed = JSON.parse(b64ToUtf8(latestExport));
    if (parsed?.format !== 'mk-wa-auth-v1' || !parsed.files || typeof parsed.files !== 'object' || Array.isArray(parsed.files)) {
      throw new Error('Unsupported session snapshot format. Export a fresh session from this version.');
    }
    const fs = await import('node:fs/promises');
    await fs.mkdir(authDir, { recursive: true, mode: 0o700 });
    for (const entry of await fs.readdir(authDir, { withFileTypes: true })) {
      if (entry.isFile()) await fs.unlink(`${authDir}/${entry.name}`);
    }
    for (const [name, content] of Object.entries(parsed.files)) {
      if (name !== name.split('/').pop() || name.includes('\\') || !/^[A-Za-z0-9._-]+$/.test(name) || typeof content !== 'string') {
        throw new Error('Session snapshot contains an invalid file entry.');
      }
      await fs.writeFile(`${authDir}/${name}`, Buffer.from(content, 'base64'), { mode: 0o600 });
    }
    return true;
  } catch (error) {
    lastError = `Session import failed: ${error.message}`;
    return false;
  }
}

async function readExportFromDisk() {
  const fs = await import('node:fs/promises');
  try {
    const files = {};
    for (const entry of await fs.readdir(authDir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      files[entry.name] = (await fs.readFile(`${authDir}/${entry.name}`)).toString('base64');
    }
    if (files['creds.json']) latestExport = utf8ToB64(JSON.stringify({ format: 'mk-wa-auth-v1', files }));
  } catch { /* No auth files yet. */ }
}

function scheduleIdleDisconnect() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(async () => {
    if (Date.now() - (lastActivityAt || 0) >= 60_000) await disconnectSocket('idle timeout');
    else scheduleIdleDisconnect();
  }, 60_000);
  idleTimer.unref?.();
}

async function disconnectSocket(reason = 'manual') {
  manuallyDisconnecting = true;
  if (idleTimer) clearTimeout(idleTimer);
  if (reconnectTimer) clearTimeout(reconnectTimer);
  idleTimer = null;
  reconnectTimer = null;
  const old = socket;
  socket = null;
  connecting = null;
  if (old) {
    try { old.end(undefined); } catch {}
  }
  if (reason === 'idle timeout') connectionStatus = 'idle';
  manuallyDisconnecting = false;
}

function scheduleReconnect(code) {
  if (manuallyDisconnecting || reconnectTimer) return;
  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    connectionStatus = 'disconnected';
    lastError = `Reconnect limit reached (code ${code ?? 'unknown'}). Request a fresh pairing code only if the session is no longer valid.`;
    return;
  }
  reconnectAttempts += 1;
  const waitMs = code === DisconnectReason.restartRequired
    ? 1000
    : Math.min(1000 * (2 ** (reconnectAttempts - 1)), 15000);
  connectionStatus = 'reconnecting';
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (socket || connecting) return;
    createSocket().catch(error => {
      lastError = error.message;
      connectionStatus = 'error';
    });
  }, waitMs);
  reconnectTimer.unref?.();
}

async function resetIncompleteAuthForPairing() {
  const fs = await import('node:fs/promises');
  await fs.mkdir(authDir, { recursive: true, mode: 0o700 });
  let registered = false;
  try {
    const creds = JSON.parse(await fs.readFile(`${authDir}/creds.json`, 'utf8'));
    registered = Boolean(creds.registered);
  } catch { /* No complete credentials yet. */ }

  if (registered && connectionStatus !== 'logged-out') {
    throw new Error('An existing registered session was found. Do not request a new pairing code; restore/export the session or log out the linked device first.');
  }

  for (const entry of await fs.readdir(authDir, { withFileTypes: true })) {
    if (entry.isFile()) await fs.unlink(`${authDir}/${entry.name}`);
  }
  latestExport = '';
}

async function createSocket({ requestPairing = false } = {}) {
  if (socket && connectionStatus === 'connected') return socket;
  if (connecting) return connecting;

  connecting = (async () => {
    const fs = await import('node:fs/promises');
    await fs.mkdir(authDir, { recursive: true, mode: 0o700 });
    if (latestExport && !(await fs.stat(`${authDir}/creds.json`).catch(() => null))) await applyEnvSession();

    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    const { version } = await fetchLatestBaileysVersion();
    const sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger),
      },
      logger,
      printQRInTerminal: false,
      browser: Browsers.windows('Chrome'),
      markOnlineOnConnect: false,
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
      defaultQueryTimeoutMs: 60_000,
      connectTimeoutMs: 60_000,
      keepAliveIntervalMs: 30_000,
      retryRequestDelayMs: 250,
      maxMsgRetryCount: 5,
    });

    socket = sock;
    connectionStatus = state.creds?.registered ? 'connecting' : 'pairing-required';

    sock.ev.on('creds.update', async () => {
      await saveCreds();
      await readExportFromDisk();
    });

    sock.ev.on('connection.update', async update => {
      if (socket !== sock) return;
      if (update.connection === 'open') {
        if (reconnectTimer) clearTimeout(reconnectTimer);
        reconnectTimer = null;
        reconnectAttempts = 0;
        connectionStatus = 'connected';
        pairingCode = null;
        lastError = null;
        await readExportFromDisk();
        console.log('[WhatsApp] Connected successfully.');
        scheduleIdleDisconnect();
      }

      if (update.connection === 'close') {
        const code = new Boom(update.lastDisconnect?.error)?.output?.statusCode;
        lastError = `Connection closed (code ${code ?? 'unknown'}).`;
        try { await saveCreds(); await readExportFromDisk(); } catch {}
        socket = null;
        connecting = null;

        if (code === DisconnectReason.loggedOut) {
          pairingCode = null;
          connectionStatus = 'logged-out';
          lastError = 'WhatsApp logged out this linked device. A fresh pairing is required.';
          return;
        }
        scheduleReconnect(code);
      }
    });

    if (requestPairing && !state.creds?.registered) {
      if (pairingAttempts >= MAX_PAIRING_ATTEMPTS) {
        throw new Error(`Maximum ${MAX_PAIRING_ATTEMPTS} pairing-code requests reached in this process. Wait before trying again or restart the service once.`);
      }
      const parsedPhone = phoneNumber(`+${config.whatsappNumber}`);
      if (!parsedPhone.isValid()) throw new Error('WHATSAPP_NUMBER is not a valid international phone number. Use country code and digits only.');
      await delay(3000);
      pairingAttempts += 1;
      const code = await sock.requestPairingCode(parsedPhone.getNumber('e164').replace('+', ''));
      pairingCode = String(code).match(/.{1,4}/g)?.join('-') || String(code);
      connectionStatus = 'pairing-required';
      console.log(`[WhatsApp] Pairing code requested (attempt ${pairingAttempts}/${MAX_PAIRING_ATTEMPTS}).`);
    }

    return sock;
  })();

  try { return await connecting; }
  catch (error) {
    connectionStatus = 'error';
    lastError = error.message;
    socket = null;
    connecting = null;
    throw error;
  }
}

export async function requestPairingCode() {
  if (pairingAttempts >= MAX_PAIRING_ATTEMPTS) throw new Error(`Maximum ${MAX_PAIRING_ATTEMPTS} pairing-code requests reached in this process. Wait before trying again or restart the service once.`);
  if (connectionStatus === 'connected') throw new Error('WhatsApp is already connected. No new pairing code is needed.');
  await disconnectSocket('pairing retry');
  await resetIncompleteAuthForPairing();
  connectionStatus = 'pairing-required';
  return createSocket({ requestPairing: true });
}

async function waitUntilConnected(timeoutMs = 25_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (connectionStatus === 'connected' && socket) return socket;
    if (connectionStatus === 'logged-out') throw new Error('WhatsApp session is logged out; request a new pairing code.');
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error('WhatsApp connection is not ready yet. Retry shortly; first connection may take time.');
}

export async function sendWhatsAppMessage(to, text) {
  const task = async () => {
    let sock = socket;
    if (!sock || connectionStatus !== 'connected') {
      sock = await createSocket();
      if (connectionStatus !== 'connected') sock = await waitUntilConnected();
    }
    const digits = String(to).replace(/\D/g, '');
    const jid = `${digits}@s.whatsapp.net`;
    const result = await sock.sendMessage(jid, { text });
    lastActivityAt = Date.now();
    scheduleIdleDisconnect();
    return { messageId: result?.key?.id || null };
  };
  const next = sendQueue.then(task, task);
  sendQueue = next.catch(() => {});
  return next;
}

export function getWhatsAppStatus() {
  return {
    status: connectionStatus,
    pairingCode,
    pairingAttempts,
    lastActivityAt: lastActivityAt ? new Date(lastActivityAt).toISOString() : null,
    lastError,
    sessionAvailable: Boolean(latestExport || config.sessionExport),
    idleDisconnectSeconds: 60,
  };
}

export async function exportSession() {
  await readExportFromDisk();
  return latestExport;
}

export function sessionFormatValid(value) {
  try {
    const parsed = JSON.parse(b64ToUtf8(value));
    return parsed?.format === 'mk-wa-auth-v1' && parsed.files && typeof parsed.files === 'object' && !Array.isArray(parsed.files) && typeof parsed.files['creds.json'] === 'string';
  } catch { return false; }
}

export async function bootstrapWhatsApp() {
  if (config.sessionExport) {
    await applyEnvSession();
    try { await createSocket(); } catch (error) { lastError = error.message; }
  }
}

export async function shutdownWhatsApp() { await disconnectSocket('shutdown'); }
