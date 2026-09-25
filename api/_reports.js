// api/_reports.js
// Shared helpers for the cloud copy of the Jims' reports. Not a route itself (Vercel excludes files
// starting with "_"). Reports live in a PRIVATE Supabase Storage bucket called "reports"; only the
// server-side routes (service key) can read or write it - a browser never talks to Storage directly.
//
// Object keys look like  claude/2026-09-07-1530-crq3-schoyen-dss-consolidated.html
// (folder = which Jim, then the file name with anything outside A-Z a-z 0-9 . _ - replaced by "_").
// The same rule is applied in comparative.html / report.html so a path stored in the database
// (e.g. C:\Users\dbs\OneDrive - BYU-Hawaii\Papyrates AI summaries\Claude Discussions\x.html)
// can be turned into the key without changing the database.

export const BUCKET = 'reports';
export const FOLDERS = ['claude', 'gpt', 'gemini', 'judge'];
export const CONTENT_TYPES = {
  html: 'text/html; charset=utf-8',
  log: 'text/plain; charset=utf-8',
  pdf: 'application/pdf',
};
export const MAX_BYTES = 3 * 1024 * 1024;   // keeps base64 uploads under Vercel's 4.5 MB request cap
export const KEY_RE = /^(claude|gpt|gemini|judge)\/[A-Za-z0-9._-]{1,180}\.(html|log|pdf)$/;

export function safeName(name) {
  return String(name || '').replace(/[^A-Za-z0-9._-]/g, '_').replace(/\.{2,}/g, '.').replace(/^\.+/, '_').slice(0, 180);
}

// The database stores a report's original local path; this gives the cloud key for it, or null.
export function keyFromPath(p) {
  const m = /Papyrates AI summaries[\\/]+([^\\/]+)[\\/]+([^\\/]+)$/i.exec(String(p || ''));
  if (!m) return null;
  const folder = m[1].split(' ')[0].toLowerCase();
  if (!FOLDERS.includes(folder)) return null;
  const key = `${folder}/${safeName(m[2])}`;
  return KEY_RE.test(key) ? key : null;
}

export function extOf(name) {
  const m = /\.([A-Za-z0-9]+)$/.exec(String(name || ''));
  return m ? m[1].toLowerCase() : '';
}

function storageFetch(path, init = {}) {
  const key = process.env.SUPABASE_KEY;
  return fetch(`${process.env.SUPABASE_URL}/storage/v1/${path}`, {
    ...init,
    headers: { apikey: key, Authorization: `Bearer ${key}`, ...(init.headers || {}) },
  });
}

async function ensureBucket() {
  const r = await storageFetch('bucket', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: BUCKET, name: BUCKET, public: false, file_size_limit: 5 * 1024 * 1024 }),
  });
  // already existing is fine
  if (!r.ok && r.status !== 409) {
    const t = await r.text();
    if (!/already exists/i.test(t)) throw new Error(`could not create bucket (${r.status}): ${t.slice(0, 200)}`);
  }
}

export async function putObject(key, buffer, ext) {
  const send = () => storageFetch(`object/${BUCKET}/${key}`, {
    method: 'POST',
    headers: { 'Content-Type': CONTENT_TYPES[ext], 'x-upsert': 'true' },
    body: buffer,
  });
  let r = await send();
  if (!r.ok) {
    const t = await r.text();
    if (/bucket not found/i.test(t)) {
      await ensureBucket();
      r = await send();
      if (r.ok) return;
      throw new Error(`storage upload failed (${r.status}): ${(await r.text()).slice(0, 200)}`);
    }
    throw new Error(`storage upload failed (${r.status}): ${t.slice(0, 200)}`);
  }
}

// Returns a Buffer, or null if the object (or the whole bucket) does not exist yet.
export async function getObject(key) {
  const r = await storageFetch(`object/${BUCKET}/${key}`);
  if (r.status === 404 || r.status === 400) return null;
  if (!r.ok) throw new Error(`storage read failed (${r.status})`);
  return Buffer.from(await r.arrayBuffer());
}

// Lists one Jim's folder. A missing bucket just means "nothing uploaded yet".
export async function listFolder(folder) {
  const r = await storageFetch(`object/list/${BUCKET}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prefix: folder, limit: 1000, offset: 0, sortBy: { column: 'name', order: 'desc' } }),
  });
  if (r.status === 404 || r.status === 400) return [];
  if (!r.ok) throw new Error(`storage list failed (${r.status})`);
  const rows = await r.json();
  return (Array.isArray(rows) ? rows : [])
    .map((o) => ({
      key: `${folder}/${o.name}`,
      folder,
      name: o.name,
      updated_at: o.updated_at || o.created_at || null,
      size: o.metadata && Number.isFinite(Number(o.metadata.size)) ? Number(o.metadata.size) : null,
    }))
    .filter((o) => KEY_RE.test(o.key));
}
