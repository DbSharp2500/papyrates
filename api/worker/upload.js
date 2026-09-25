// api/worker/upload.js
// Called by the Desktop launcher (worker token required) to copy one finished report from the
// OneDrive folders into the private cloud bucket. The Desktop never holds a Supabase key; it sends the
// file here and this route (which has the key) stores it. Only three file types, a fixed set of
// folders, a sanitized name, and a size cap - nothing else is accepted.

import { workerAuthorized } from '../_worker.js';
import { FOLDERS, KEY_RE, MAX_BYTES, extOf, safeName, putObject } from '../_reports.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!workerAuthorized(req)) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const b = req.body || {};
    const folder = String(b.folder || '');
    if (!FOLDERS.includes(folder)) return res.status(400).json({ error: 'Unknown folder' });

    const ext = extOf(b.name);
    if (!['html', 'log', 'pdf'].includes(ext)) return res.status(400).json({ error: 'File type not allowed' });

    const key = `${folder}/${safeName(b.name)}`;
    if (!KEY_RE.test(key)) return res.status(400).json({ error: 'File name not allowed' });

    const b64 = typeof b.content_b64 === 'string' ? b.content_b64 : '';
    if (!b64 || b64.length > Math.ceil(MAX_BYTES * 4 / 3) + 8) return res.status(400).json({ error: 'File missing or too large' });
    const buf = Buffer.from(b64, 'base64');
    if (buf.length === 0 || buf.length > MAX_BYTES) return res.status(400).json({ error: 'File missing or too large' });

    await putObject(key, buf, ext);
    return res.status(200).json({ ok: true, key, bytes: buf.length });
  } catch (err) {
    console.error('api/worker/upload error:', err && err.message);
    return res.status(500).json({ error: 'Server error' });
  }
}
