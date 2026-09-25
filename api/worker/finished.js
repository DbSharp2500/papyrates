// api/worker/finished.js
// Called by the Desktop launcher (worker token required). Lists the Jim windows that have been REPLACED and can be
// closed, so windows do not pile up (each holds a few hundred MB of memory).
//
// A Jim's window is never closed just because it finished: it stays open so the researcher can read the report and
// review the suggestions whenever they like. It is replaced only when a FOLLOW-UP on the same question, for the same
// Jim, has actually started working - then the window that produced the earlier version of the report is listed:
// the original answering window and any earlier follow-up windows for that question and Jim.
//
//   POST -> { items: [ { kind: 'ask' | 'followup', id, model } ] }
// Only the last 48 hours are considered.

import { sb } from '../_sb.js';
import { workerAuthorized } from '../_worker.js';

const LOOKBACK_MS = 48 * 60 * 60 * 1000;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!workerAuthorized(req)) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const since = encodeURIComponent(new Date(Date.now() - LOOKBACK_MS).toISOString());
    // follow-ups whose job has been launched (their new window is open and working, or finished)
    const started = await sb(`jim_jobs?kind=eq.followup&status=eq.launched&launched_at=gte.${since}&select=followup_id&order=id.desc&limit=40`) || [];
    const ids = [...new Set(started.map((j) => j.followup_id))];
    if (!ids.length) return res.status(200).json({ items: [] });

    const fs = await sb(`followups?id=in.(${ids.join(',')})&select=id,request_id,ai_model`) || [];
    const items = [];
    const seen = new Set();
    const add = (kind, id, model) => { const k = `${kind}:${id}:${model}`; if (!seen.has(k)) { seen.add(k); items.push({ kind, id, model }); } };
    for (const f of fs) {
      add('ask', f.request_id, f.ai_model);                                            // the original answering window
      const earlier = await sb(`followups?request_id=eq.${f.request_id}&ai_model=eq.${f.ai_model}&id=lt.${f.id}&select=id`) || [];
      for (const e of earlier) add('followup', e.id, f.ai_model);                      // earlier follow-up windows
    }
    return res.status(200).json({ items });
  } catch (err) {
    console.error('api/worker/finished error:', err && err.message);
    return res.status(500).json({ error: 'Server error' });
  }
}
