// api/worker/claim.js
// Called every ~20 seconds by the launcher on the always-on Desktop (worker token required).
// One call does four things:
//   1. heartbeat  - records "the Desktop is alive" so the dashboard can show Online/Offline
//   2. cleanup    - a job claimed more than 10 minutes ago that was never reported on is marked failed
//   3. housekeeping - auto-Judge for finished comparative questions and phone alerts (see _housekeeping.js)
//   4. claim      - hands back the oldest waiting job that is allowed to start, atomically, or { job: null }
// Nothing here runs a command; it only returns a job (model + kind + question id).

import { sb } from '../_sb.js';
import { workerAuthorized } from '../_worker.js';
import { housekeeping } from '../_housekeeping.js';

const BUSY_WINDOW_MS = 2 * 60 * 60 * 1000;

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

    await housekeeping(now);      // auto-Judge and phone alerts; never throws

    // One question at a time per Jim: while a Jim's earlier "answer" job was launched less than 2 hours ago and
    // its answer has not been logged yet, further answer jobs for that same Jim wait. (Stops six GPT windows
    // opening at once and burning the 5-hour usage window; other Jims are not held up. The 2-hour cap means a
    // Jim that died without logging an answer cannot block the line forever.)
    // (Applies to both kinds of answering job: comparative "answer" jobs and everyday "ask" jobs.)
    const busy = new Set();
    const since = encodeURIComponent(new Date(now.getTime() - BUSY_WINDOW_MS).toISOString());
    const running = await sb(`jim_jobs?kind=in.(answer,ask,followup)&status=eq.launched&launched_at=gte.${since}&select=model,kind,question_id,request_id,followup_id`) || [];
    if (running.length) {
      const qids = [...new Set(running.filter((j) => j.kind === 'answer').map((j) => j.question_id))];
      const rids = [...new Set(running.filter((j) => j.kind === 'ask').map((j) => j.request_id))];
      const fids = [...new Set(running.filter((j) => j.kind === 'followup').map((j) => j.followup_id))];
      const cDone = qids.length ? await sb(`comparative_answers?comparative_question_id=in.(${qids.join(',')})&select=comparative_question_id,ai_model`) || [] : [];
      const rDone = rids.length ? await sb(`research_results?request_id=in.(${rids.join(',')})&select=request_id,ai_model`) || [] : [];
      const fDone = fids.length ? await sb(`followups?id=in.(${fids.join(',')})&select=id,finished_at`) || [] : [];
      for (const j of running) {
        const finished = j.kind === 'answer'
          ? cDone.some((a) => a.comparative_question_id === j.question_id && a.ai_model === j.model)
          : j.kind === 'ask'
            ? rDone.some((a) => a.request_id === j.request_id && a.ai_model === j.model)
            : fDone.some((f) => f.id === j.followup_id && f.finished_at);
        if (!finished) busy.add(j.model);
      }
    }

    const waiting = await sb('jim_jobs?status=eq.queued&order=id.asc&limit=50&select=id,kind,model') || [];
    const next = waiting.filter((j) => !((j.kind === 'answer' || j.kind === 'ask' || j.kind === 'followup') && busy.has(j.model)));
    if (next.length === 0) return res.status(200).json({ job: null });

    // atomic claim: only succeeds if the job is STILL queued when this update lands
    const claimed = await sb(`jim_jobs?id=eq.${next[0].id}&status=eq.queued`, {
      method: 'PATCH',
      body: { status: 'claimed', claimed_at: now.toISOString() },
      prefer: 'return=representation',
    });
    if (!claimed || claimed.length === 0) return res.status(200).json({ job: null });

    const j = claimed[0];
    return res.status(200).json({ job: { id: j.id, kind: j.kind, model: j.model, question_id: j.question_id, request_id: j.request_id, followup_id: j.followup_id } });
  } catch (err) {
    console.error('api/worker/claim error:', err && err.message);
    return res.status(500).json({ error: 'Server error' });
  }
}
