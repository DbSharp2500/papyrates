// api/_sb.js
// Tiny shared helper for calling Supabase's PostgREST API from the site's server-side routes.
// Not a route itself (Vercel excludes files starting with "_"). Uses the service key, which
// stays on the server - it never reaches a browser.

export async function sb(path, { method = 'GET', body, prefer } = {}) {
  const key = process.env.SUPABASE_KEY;
  const headers = {
    apikey: key,
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
  };
  if (prefer) headers.Prefer = prefer;

  const r = await fetch(`${process.env.SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  if (!r.ok) {
    const e = new Error(`Supabase ${r.status}: ${text.slice(0, 300)}`);
    e.status = r.status;
    throw e;
  }
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}
