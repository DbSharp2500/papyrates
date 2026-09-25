// api/jobs.js
// The dashboard's side of the Jim job queue. ADMIN tier only (a signed session token, checked
// here on the server - the page-level requireAuth is not what protects this).
//
//   GET     -> the 25 most recent jobs + whether the Desktop's launcher is online
//   POST    -> queue a job:  { model: 'claude'|'gpt'|'gemini'|'judge', question_id?: n }
//                 model + question_id  -> that Jim answers that comparative question
//                 model only           -> just open that Jim on the Desktop (for a chat over remote access)
//                 judge + question_id  -> Judge evaluates that question
//   DELETE  -> ?id=n  cancels a job that is still waiting
//
// Only these fixed shapes are accepted, so a job can never carry free text into a command.

import { tierFromRequest, hasTierAccess } from './_session.js';
import { sb } from './_sb.js';

const MODELS = ['claude', 'gpt', 'gemini', 'judge'];
const ONLINE_WINDOW_MS = 90 * 1000;
const MAX_WAITING = 20;

export default async function handler(req, res) {
  const tier = tierFromRequest(req);
  if (!tier || !hasTierAccess(tier, 'admin')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    if (req.method === 'GET') {
      const jobs = await sb('jim_jobs?select=id,created_at,kind,model,question_id,status,claimed_at,launched_at,error_text&order=id.desc&limit=25');
      const srv = await sb('jim_server?id=eq.1&select=last_seen,info');
      const row = srv && srv[0] ? srv[0] : null;
      const last = row ? new Date(row.last_seen).getTime() : 0;
      return res.status(200).json({
        jobs: jobs || [],
        server: { online: Date.now() - last < ONLINE_WINDOW_MS, last_seen: row ? row.last_seen : null, info: row ? row.info : null },
      });
    }

    if (req.method === 'POST') {
      const body = req.body || {};
      const model = String(body.model || '');
      if (!MODELS.includes(model)) return res.status(400).json({ error: 'Unknown model' });

      let qid = null;
      if (body.question_id !== undefined && body.question_id !== null && body.question_id !== '') {
        qid = Number(body.question_id);
        if (!Number.isInteger(qid) || qid < 1 || qid > 1000000) return res.status(400).json({ error: 'Invalid question id' });
      }
      if (model === 'judge' && qid === null) return res.status(400).json({ error: 'Judge needs a question id' });
      const kind = model === 'judge' ? 'evaluate' : (qid === null ? 'open' : 'answer');

      if (qid !== null) {
        const q = await sb(`comparative_questions?id=eq.${qid}&select=id`);
        if (!q || q.length === 0) return res.status(404).json({ error: 'No such comparative question' });
      }

      // don't queue the same thing twice while one is waiting or being picked up
      const dup = await sb(
        `jim_jobs?model=eq.${model}&kind=eq.${kind}&status=in.(queued,claimed)` +
        (qid === null ? '&question_id=is.null' : `&question_id=eq.${qid}`) + '&select=id&limit=1');
      if (dup && dup.length) return res.status(409).json({ error: 'That job is already queued', id: dup[0].id });

      const waiting = await sb('jim_jobs?status=eq.queued&select=id');
      if (waiting && waiting.length >= MAX_WAITING) return res.status(429).json({ error: 'Too many jobs are waiting' });

      const created = await sb('jim_jobs', {
        method: 'POST',
        body: { kind, model, question_id: qid, requested_by: tier },
        prefer: 'return=representation',
      });
      return res.status(201).json({ job: created && created[0] });
    }

    if (req.method === 'DELETE') {
      const id = Number(req.query && req.query.id);
      if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid job id' });
      const r = await sb(`jim_jobs?id=eq.${id}&status=eq.queued`, {
        method: 'PATCH', body: { status: 'cancelled' }, prefer: 'return=representation',
      });
      return res.status(200).json({ cancelled: r && r.length ? r[0].id : null });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('api/jobs error:', err && err.message);
    return res.status(500).json({ error: 'Server error' });
  }
}
