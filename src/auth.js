import crypto from 'node:crypto';
import { authenticator } from 'otplib';

const sessions = new Map();
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
authenticator.options = { step: 30, window: 1 };

export function verifyTotp(code, secret) {
  const normalized = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(normalized)) return false;
  try { return authenticator.check(normalized, secret); } catch { return false; }
}
export function createAdminSession() {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { createdAt: Date.now(), lastSeen: Date.now() });
  return token;
}
export function revokeAdminSession(token) { if (token) sessions.delete(token); }
export function requireAdmin(req, res, next) {
  const token = req.cookies?.mk_admin_session;
  const session = token && sessions.get(token);
  if (!session || Date.now() - session.createdAt > SESSION_TTL_MS) {
    if (token) sessions.delete(token);
    res.clearCookie('mk_admin_session', { httpOnly: true, sameSite: 'strict', secure: process.env.NODE_ENV === 'production', path: '/' });
    return res.status(401).json({ error: 'Admin login required.' });
  }
  session.lastSeen = Date.now();
  next();
}
export function adminSessionCookieOptions() {
  // Deliberately omit maxAge/expires: a browser-session cookie.
  return { httpOnly: true, sameSite: 'strict', secure: process.env.NODE_ENV === 'production', path: '/' };
}
