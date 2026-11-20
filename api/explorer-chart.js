// api/explorer-chart.js
// Data for explorer-chart.html (the Explorer Fragment Chart demo). ADMIN TIER ONLY, checked here on the server
// with the signed session token (see api/_session.js) - the page itself is only a shell with no data in it.
// The data is read live from the explorer_fragments table with the server-side key; it is never stored in the repository
// (the repository is public) and the response is marked private / no-store.

import { tierFromRequest, hasTierAccess } from './_session.js';
import { sb } from './_sb.js';
import { COLUMNS, buildChartData } from './_explorer-chart-build.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const tier = tierFromRequest(req);
  if (!tier || !hasTierAccess(tier, 'admin')) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const rows = await sb(`explorer_fragments?select=${COLUMNS}&order=id.asc&limit=1000`);
    return res.status(200).json(buildChartData(rows || []));
  } catch (e) {
    console.error('explorer-chart failed:', e && e.message);
    return res.status(502).json({ error: 'Could not read the chart data' });
  }
}
