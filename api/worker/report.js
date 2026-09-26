// api/worker/report.js
// The Desktop's launcher reports what happened to a job it claimed:
//   { id, status: 'launched' }                      the Jim window was opened
//   { id, status: 'failed', error: 'short reason' } it could not be
//   { action: 'open_jobs' } / { action: 'jim_failed', id, error }   find and report Jims that stopped without an answer
//   { action: 'replaced' }                          lists Jim windows a follow-up has replaced, so the launcher can close them
// Worker token required. Only a job currently in the 'claimed' state can be updated.

import { sb } from '../_sb.js';
import { workerAuthorized } from '../_worker.js';
import { replacedWindows } from '../_replaced.js';
import { openJobs, markJimFailed } from '../_stalled.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!workerAuthorized(req)) return res.status(401).json({ error: 'Unauthorized' });

  // { action: 'replaced' } -> which finished Jim windows a follow-up has replaced (the launcher closes them)
  if (req.body && req.body.action === 'replaced') {
    try { return res.status(200).json({ items: await replacedWindows() }); }
    catch (err) { console.error('api/worker/report (replaced) error:', err && err.message); return res.status(500).json({ error: 'Server error' }); }
  }

  // { action: 'open_jobs' } -> launched jobs that have produced no answer yet (the launcher checks each Jim's session for why)
  if (req.body && req.body.action === 'open_jobs') {
    try { return res.status(200).json({ items: await openJobs() }); }
    catch (err) { console.error('api/worker/report (open_jobs) error:', err && err.message); return res.status(500).json({ error: 'Server error' }); }
  }
  // { action: 'jim_failed', id, error } -> a launched Jim stopped without an answer (e.g. its account hit a spend limit)
  if (req.body && req.body.action === 'jim_failed') {
    const jid = Number(req.body.id);
    if (!Number.isInteger(jid) || jid < 1) return res.status(400).json({ error: 'Invalid job id' });
    try { const out = await markJimFailed(jid, req.body.error); return res.status(200).json({ updated: out.updated, requeued: out.requeued }); }
    catch (err) { console.error('api/worker/report (jim_failed) error:', err && err.message); return res.status(500).json({ error: 'Server error' }); }
  }

  const { id, status, error } = req.body || {};
  const jobId = Number(id);
  if (!Number.isInteger(jobId) || jobId < 1) return res.status(400).json({ error: 'Invalid job id' });
  if (status !== 'launched' && status !== 'failed') return res.status(400).json({ error: 'Invalid status' });

  const patch = status === 'launched'
    ? { status, launched_at: new Date().toISOString() }
    : { status, error_text: String(error || 'unspecified').slice(0, 500) };

  try {
    const r = await sb(`jim_jobs?id=eq.${jobId}&status=eq.claimed`, {
      method: 'PATCH', body: patch, prefer: 'return=representation',
    });
    return res.status(200).json({ updated: !!(r && r.length) });
  } catch (err) {
    console.error('api/worker/report error:', err && err.message);
    return res.status(500).json({ error: 'Server error' });
  }
}
