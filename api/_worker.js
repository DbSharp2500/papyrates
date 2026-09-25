// api/_worker.js
// Authentication for the always-on Desktop's launcher. It proves who it is with a long random
// secret (WORKER_TOKEN, set in Vercel's environment variables and kept in a locked-down file
// on the Desktop). It can ONLY call the /api/worker/* routes - it holds no database key, and
// it is not a login for the dashboard.

import crypto from 'crypto';

export function workerAuthorized(req) {
  const expected = process.env.WORKER_TOKEN || '';
  if (expected.length < 32) return false;          // refuse to run with a weak/missing secret
  const given = String(req.headers['x-worker-token'] || '');
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
