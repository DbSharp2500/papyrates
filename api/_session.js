// api/_session.js
// Shared session-token helpers. Not a route itself (Vercel excludes files
// starting with "_" from routing) - imported by api/auth.js (issues tokens)
// and api/db-proxy/[...path].js (verifies them).
//
// Why this exists: before this, "auth" was purely client-side - /api/auth
// just told the browser which tier it was, and the browser trusted itself.
// That was fine when the actual Supabase service_role key was also shipped
// to the browser (the key itself was the real access control). Now that the
// key stays server-side, something has to let the server verify a request
// is really coming from someone who passed the password check - hence a
// real signed token instead of a bare tier string.

import crypto from 'crypto';

const TIER_LEVEL = { readonly: 1, research: 2, admin: 3 };
const SESSION_DURATION_MS = 24 * 60 * 60 * 1000; // 24 hours, matches papyrates-auth.js

function sign(payloadB64) {
  const secret = process.env.SESSION_SECRET;
  return crypto.createHmac('sha256', secret).update(payloadB64).digest('base64url');
}

export function issueToken(tier) {
  const payload = { tier, exp: Date.now() + SESSION_DURATION_MS };
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = sign(payloadB64);
  return `${payloadB64}.${sig}`;
}

// Returns the verified tier string, or null if the token is missing,
// malformed, expired, or has a bad signature.
export function verifyToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [payloadB64, sig] = token.split('.');
  const expectedSig = sign(payloadB64);
  const sigBuf = Buffer.from(sig || '', 'base64url');
  const expectedBuf = Buffer.from(expectedSig, 'base64url');
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
    return null;
  }
  let payload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!payload.tier || !payload.exp || Date.now() > payload.exp) return null;
  return payload.tier;
}

// Extracts the bearer token from a request and returns the verified tier,
// or null. Convenience wrapper for route handlers.
export function tierFromRequest(req) {
  const auth = req.headers['authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  return verifyToken(token);
}

export function hasTierAccess(userTier, requiredTier) {
  return (TIER_LEVEL[userTier] || 0) >= (TIER_LEVEL[requiredTier] || 99);
}
