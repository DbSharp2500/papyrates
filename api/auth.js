// api/auth.js
// Password login -> signed session token. Hardened 2026-09-25 because a valid admin session can now
// queue jobs that start programs on the always-on Desktop:
//   * passwords are compared in constant time (no timing leak)
//   * failed attempts are counted per client IP and overall; too many in 15 minutes -> HTTP 429
//   * if the attempts table is unreachable the login still works (fail-open: never lock the owner out
//     because of a database hiccup) - the constant-time compare and strong passwords are the base defense.

import crypto from 'crypto';
import { issueToken } from './_session.js';
import { sb } from './_sb.js';

const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILS_PER_IP = 5;
const MAX_FAILS_ALL = 100;

function matches(given, expected) {
  if (!expected) return false;
  const a = crypto.createHash('sha256').update(String(given)).digest();
  const b = crypto.createHash('sha256').update(String(expected)).digest();
  return crypto.timingSafeEqual(a, b);
}

function clientIp(req) {
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return (fwd || (req.socket && req.socket.remoteAddress) || 'unknown').slice(0, 64);
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { password } = req.body || {};
  if (!password || typeof password !== 'string') {
    return res.status(400).json({ error: "No password provided" });
  }

  const ip = clientIp(req);
  const since = encodeURIComponent(new Date(Date.now() - WINDOW_MS).toISOString());

  // lockout check (fail-open on any error)
  try {
    const [mine, all] = await Promise.all([
      sb(`login_attempts?ip=eq.${encodeURIComponent(ip)}&ok=eq.false&at=gte.${since}&select=id&limit=${MAX_FAILS_PER_IP}`),
      sb(`login_attempts?ok=eq.false&at=gte.${since}&select=id&limit=${MAX_FAILS_ALL}`),
    ]);
    if ((mine && mine.length >= MAX_FAILS_PER_IP) || (all && all.length >= MAX_FAILS_ALL)) {
      res.setHeader('Retry-After', '900');
      return res.status(429).json({ error: "Too many failed attempts. Try again in 15 minutes." });
    }
  } catch (e) {
    console.error('login throttle check skipped:', e && e.message);
  }

  // evaluate all three so timing doesn't reveal which tier matched
  const isAdmin = matches(password, process.env.PASSWORD_ADMIN);
  const isResearch = matches(password, process.env.PASSWORD_RESEARCH);
  const isReadonly = matches(password, process.env.PASSWORD_READONLY);
  const tier = isAdmin ? "admin" : isResearch ? "research" : isReadonly ? "readonly" : null;

  // record the attempt (best effort), and tidy old rows now and then
  try {
    await sb('login_attempts', { method: 'POST', body: { ip, ok: !!tier } });
    if (Math.random() < 0.02) {
      const old = encodeURIComponent(new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());
      await sb(`login_attempts?at=lt.${old}`, { method: 'DELETE' });
    }
  } catch (e) {
    console.error('login attempt not recorded:', e && e.message);
  }

  if (!tier) {
    return res.status(401).json({ error: "Incorrect password" });
  }

  return res.status(200).json({ tier, token: issueToken(tier) });
}
