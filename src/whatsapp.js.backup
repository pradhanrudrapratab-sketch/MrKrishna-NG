import makeWASocket, { DisconnectReason, useMultiFileAuthState } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import { config } from './config.js';

const logger = pino({ level: 'silent' });
let socket = null;
let connecting = null;
let latestExport = config.sessionExport || '';
let connectionStatus = config.sessionExport ? 'connecting' : 'not-paired';
let pairingCode = null;
let pairingAttempts = 0;
let idleTimer = null;
let lastActivityAt = null;
let lastError = null;
let sendQueue = Promise.resolve();
const authDir = '/tmp/mk-wa-auth';

function b64ToUtf8(str) { return Buffer.from(str, 'base64').toString('utf8'); }
function utf8ToB64(str) { return Buffer.from(str, 'utf8').toString('base64'); }

// Preserve every file created by Baileys' multi-file auth store, including Signal keys.
// The outer base64 encoding keeps the snapshot safe to paste into an environment variable.
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
      const bytes = await fs.readFile(`${authDir}/${entry.name}`);
      files[entry.name] = bytes.toString('base64');
    }
    if (files['creds.json']) latestExport = utf8ToB64(JSON.stringify({ format: 'mk-wa-auth-v1', files }));
  } catch {}
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
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
  const old = socket;
  socket = null;
  connecting = null;
  if (old) {
    try { old.end(undefined); } catch {}
  }
  if (reason === 'idle timeout') connectionStatus = 'idle';
}

async function createSocket({ requestPairing = false } = {}) {
  if (socket && connectionStatus === 'connected') return socket;
  if (connecting) return connecting;
  connecting = (async () => {
    const fs = await import('node:fs/promises');
    await fs.mkdir(authDir, { recursive: true });
    if (latestExport && !(await fs.stat(`${authDir}/creds.json`).catch(() => null))) await applyEnvSession();
    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    const sock = makeWASocket({ auth: state, logger, printQRInTerminal: false, browser: ['MrKrishna NG', 'Chrome', '1.0.0'], markOnlineOnConnect: false, syncFullHistory: false });
    socket = sock;
    connectionStatus = state.creds?.registered ? 'connecting' : 'pairing-required';
    sock.ev.on('creds.update', async () => {
      await saveCreds();
      await readExportFromDisk();
    });
    sock.ev.on('connection.update', async (update) => {
      if (update.connection === 'open') {
        connectionStatus = 'connected';
        pairingCode = null;
        lastError = null;
        console.log('[WhatsApp] Connected.');
        scheduleIdleDisconnect();
      }
      if (update.connection === 'close') {
        // Ignore close events from a socket that was already replaced during a retry.
        if (socket !== sock) return;
        const code = new Boom(update.lastDisconnect?.error)?.output?.statusCode;
        connectionStatus = code === DisconnectReason.loggedOut ? 'logged-out' : 'disconnected';
        lastError = `Connection closed (code ${code ?? 'unknown'}).`;
        socket = null;
        connecting = null;
        if (code === DisconnectReason.loggedOut) {
          pairingCode = null;
          console.warn('[WhatsApp] Logged out; manual pairing retry required.');
        }
      }
    });
    if (requestPairing && !state.creds?.registered) {
      if (pairingAttempts >= 2) throw new Error('Maximum two pairing-code requests reached in this process. Restart service before another attempt.');
      pairingAttempts += 1;
      const code = await sock.requestPairingCode(config.whatsappNumber);
      pairingCode = String(code).match(/.{1,4}/g)?.join('-') || String(code);
      console.log(`[WhatsApp] Pairing code requested (attempt ${pairingAttempts}/2). Open Linked Devices → Link with phone number. Code: ${pairingCode}`);
    }
    return sock;
  })();
  try { return await connecting; }
  catch (error) { connectionStatus = 'error'; lastError = error.message; socket = null; connecting = null; throw error; }
}

export async function requestPairingCode() {
  if (pairingAttempts >= 2) throw new Error('Maximum two pairing-code requests reached in this process.');
  await disconnectSocket('pairing retry');
  connectionStatus = 'pairing-required';
  return createSocket({ requestPairing: true });
}

async function waitUntilConnected(sock, timeoutMs = 25_000) {
  if (connectionStatus === 'connected') return;
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (connectionStatus === 'connected' && socket) return;
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
      await waitUntilConnected(sock);
    }
    const jid = `${to.replace(/\D/g, '')}@s.whatsapp.net`;
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
  return { status: connectionStatus, pairingCode, pairingAttempts, lastActivityAt: lastActivityAt ? new Date(lastActivityAt).toISOString() : null, lastError, sessionAvailable: Boolean(latestExport || config.sessionExport), idleDisconnectSeconds: 60 };
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
