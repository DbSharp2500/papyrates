// api/db-proxy/[...path].js
// Generic authenticated proxy to Supabase's PostgREST API. Exists so
// database.html and add.html (which build arbitrary PostgREST queries -
// filters, joins via junction tables, sorts, counts) don't need every call
// site rewritten as a bespoke endpoint. The client sends the exact same
// path+query it always did (e.g. "letters?select=id,title&author_id=eq.5"),
// this just forwards it to Supabase with the real key, which never reaches
// the browser.
//
// Requires a valid signed session token (see api/_session.js) - GET needs
// at least "readonly", anything else (POST/PATCH/DELETE) needs at least
// "research". This is what actually replaces the old "the service_role key
// IS the access control" model now that the key isn't client-side anymore.

import { tierFromRequest, hasTierAccess } from '../_session.js';

export default async function handler(req, res) {
  const tier = tierFromRequest(req);
  const requiredTier = req.method === 'GET' || req.method === 'HEAD' ? 'readonly' : 'research';

  if (!tier || !hasTierAccess(tier, requiredTier)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_KEY;

  // req.url is e.g. "/api/db-proxy/letters?select=id,title&author_id=eq.5" -
  // strip the prefix and forward the rest exactly as-is, so PostgREST
  // operators like "eq." and comma-separated select lists survive untouched.
  const prefix = '/api/db-proxy/';
  const idx = req.url.indexOf(prefix);
  const suffix = idx === -1 ? '' : req.url.slice(idx + prefix.length);

  const targetUrl = `${SUPABASE_URL}/rest/v1/${suffix}`;

  const headers = {
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
  };
  if (req.headers['prefer']) headers['Prefer'] = req.headers['prefer'];

  const init = { method: req.method, headers };
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.body !== undefined) {
    init.body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
  }

  try {
    const upstream = await fetch(targetUrl, init);
    const text = await upstream.text();

    const contentRange = upstream.headers.get('content-range');
    if (contentRange) res.setHeader('Content-Range', contentRange);
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/json');

    return res.status(upstream.status).send(text);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
