// api/reports.js
// Read side of the cloud reports (research or admin login required; the readonly tier does not see them).
//   GET /api/reports?list=1      -> { files: [{ key, folder, name, updated_at, size }] }
//   GET /api/reports?f=<key>     -> the file itself (html / log / pdf)
// The browser can't send a login header on a plain link, so report.html fetches the file with the
// Bearer token and shows it in a locked-down sandboxed frame. The extra headers below stop the file
// from being run as part of the site if someone ever opens the URL directly.

import { tierFromRequest, hasTierAccess } from './_session.js';
import { FOLDERS, KEY_RE, CONTENT_TYPES, extOf, getObject, listFolder, deleteObject } from './_reports.js';

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'DELETE') return res.status(405).json({ error: 'Method not allowed' });

  const tier = tierFromRequest(req);
  if (!tier || !hasTierAccess(tier, 'research')) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const q = req.query || {};

    // DELETE ?f=<key> - removes the cloud copy of one report file. ADMIN only. OneDrive is never touched.
    if (req.method === 'DELETE') {
      if (!hasTierAccess(tier, 'admin')) return res.status(401).json({ error: 'Unauthorized' });
      const dkey = String(q.f || '');
      if (!KEY_RE.test(dkey) || dkey.includes('..')) return res.status(400).json({ error: 'Bad file name' });
      await deleteObject(dkey);
      return res.status(200).json({ deleted: dkey });
    }

    if (q.list) {
      const lists = await Promise.all(FOLDERS.map((f) => listFolder(f)));
      return res.status(200).json({ files: lists.flat() });
    }

    const key = String(q.f || '');
    if (!KEY_RE.test(key) || key.includes('..')) return res.status(400).json({ error: 'Bad file name' });

    const buf = await getObject(key);
    if (!buf) return res.status(404).json({ error: 'Not uploaded yet' });

    res.setHeader('Content-Type', CONTENT_TYPES[extOf(key)]);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', 'sandbox');
    return res.status(200).send(buf);
  } catch (err) {
    console.error('api/reports error:', err && err.message);
    return res.status(500).json({ error: 'Server error' });
  }
}
