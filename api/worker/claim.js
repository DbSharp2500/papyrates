// api/worker/claim.js
// Called every ~20 seconds by the launcher on the always-on Desktop (worker token required).
// One call does three things:
//   1. heartbeat  - records "the Desktop is alive" so the dashboard can show Online/Offline
//   2. cleanup    - a job claimed more than 10 minutes ago that was never reported on is marked failed
//   3. claim      - hands back the oldest waiting job, atomically, or { job: null }
// Nothing here runs a command; it only returns a job (model + kind + question id).

import { sb } from '../_sb.js';
import { workerAuthorized } from '../_worker.js';

function cleanInfo(i) {
  const o = (i && typeof i === 'object') ? i : {};
  return {
    hostname: String(o.hostname || '').slice(0, 64),
    uptime_min: Number.isFinite(Number(o.uptime_min)) ? Math.round(Number(o.uptime_min)) : null,
    agent: String(o.agent || '').slice(0, 32),
  };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!workerAuthorized(req)) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const now = new Date();
    const beat = { id: 1, last_seen: now.toISOString() };
    if (req.body && req.body.info) beat.info = cleanInfo(req.body.info);   // don't blank stored details if none were sent
    await sb('jim_server?on_conflict=id', {
      method: 'POST',
      body: beat,
      prefer: 'resolution=merge-duplicates',
    });

    const stale = encodeURIComponent(new Date(now.getTime() - 10 * 60 * 1000).toISOString());
    await sb(`jim_jobs?status=eq.claimed&claimed_at=lt.${stale}`, {
      method: 'PATCH',
      body: { status: 'failed', error_text: 'The launcher picked this job up but never reported back' },
    });

    const next = await sb('jim_jobs?status=eq.queued&order=id.asc&limit=1&select=id');
    if (!next || next.length === 0) return res.status(200).json({ job: null });

    // atomic claim: only succeeds if the job is STILL queued when this update lands
    const claimed = await sb(`jim_jobs?id=eq.${next[0].id}&status=eq.queued`, {
      method: 'PATCH',
      body: { status: 'claimed', claimed_at: now.toISOString() },
      prefer: 'return=representation',
    });
    if (!claimed || claimed.length === 0) return res.status(200).json({ job: null });

    const j = claimed[0];
    return res.status(200).json({ job: { id: j.id, kind: j.kind, model: j.model, question_id: j.question_id } });
  } catch (err) {
    console.error('api/worker/claim error:', err && err.message);
    return res.status(500).json({ error: 'Server error' });
  }
}
