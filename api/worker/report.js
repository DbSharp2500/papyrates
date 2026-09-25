// api/worker/report.js
// The Desktop's launcher reports what happened to a job it claimed:
//   { id, status: 'launched' }                      the Jim window was opened
//   { id, status: 'failed', error: 'short reason' } it could not be
// Worker token required. Only a job currently in the 'claimed' state can be updated.

import { sb } from '../_sb.js';
import { workerAuthorized } from '../_worker.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!workerAuthorized(req)) return res.status(401).json({ error: 'Unauthorized' });

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
