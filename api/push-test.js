// api/push-test.js
// ADMIN only. POST -> sends a real test alert to the phone through the same code the site uses for real alerts,
// and reports whether the NTFY_TOPIC setting is present/usable and whether ntfy accepted the message.
// (The topic itself is never returned.)

import { tierFromRequest, hasTierAccess } from './_session.js';
import { pushDiagnose } from './_push.js';

export default async function handler(req, res) {
  const tier = tierFromRequest(req);
  if (!tier || !hasTierAccess(tier, 'admin')) return res.status(401).json({ error: 'Unauthorized' });
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    return res.status(200).json(await pushDiagnose());
  } catch (err) {
    console.error('api/push-test error:', err && err.message);
    return res.status(500).json({ error: 'Server error' });
  }
}
