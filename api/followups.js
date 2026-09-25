// api/followups.js
// Follow-up questions on a finished report - admin, and the Research Assistant on THEIR OWN questions only.
//
//   GET    ?request=R&model=M  -> the conversation so far for that Jim's report, whether a new follow-up can be asked,
//                                 and where the current one stands (waiting / working / done / failed)
//   POST   { request_id, model, message } -> stores the follow-up and queues a "followup" job for the SAME Jim that
//                                 wrote the report. That Jim reads the message (and the earlier conversation) from
//                                 the database itself - no text ever goes on a command line.
//   DELETE ?id=N               -> withdraws a follow-up that has not started yet
//
// Only ordinary questions (research_requests that have not been made comparative) can have follow-ups: a comparative
// question is meant to be answered cold by each Jim, and a follow-up would change that.

import { tierFromRequest, hasTierAccess } from './_session.js';
import { sb } from './_sb.js';
import { requestIsAssistants } from './_owner.js';

const MODELS = ['claude', 'gpt', 'gemini'];
const MIN_LEN = 5, MAX_LEN = 4000;
const MAX_WAITING = 20;

const posInt = (v) => { const n = Number(v); return Number.isInteger(n) && n >= 1 && n <= 1000000000 ? n : null; };

export default async function handler(req, res) {
  const tier = tierFromRequest(req);
  if (!tier || !hasTierAccess(tier, 'research')) return res.status(401).json({ error: 'Unauthorized' });
  try {
    if (req.method === 'GET') return await thread(req, res, tier);
    if (req.method === 'POST') return await create(req, res, tier);
    if (req.method === 'DELETE') return await withdraw(req, res, tier);
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('api/followups error:', err && err.message);
    return res.status(500).json({ error: 'Server error' });
  }
}

// Where one follow-up stands, from its newest job and its finished_at.
function stateOf(f, jobs, now) {
  if (f.finished_at) return { state: 'done' };
  const job = jobs.length ? jobs[jobs.length - 1] : null;
  if (!job || job.status === 'queued') return { state: 'waiting' };
  if (job.status === 'claimed' || job.status === 'launched') {
    const mins = job.launched_at ? Math.max(0, Math.round((now - new Date(job.launched_at).getTime()) / 60000)) : 0;
    return { state: 'working', minutes: mins };
  }
  if (job.status === 'failed') return { state: 'failed', error: job.error_text || 'unknown problem' };
  return { state: 'cancelled' };
}

// Can a new follow-up be asked on this Jim's report? { ok, why }
async function canAsk(rid, model) {
  const rq = await sb(`research_requests?id=eq.${rid}&select=id,comparative_question_id`) || [];
  if (!rq.length) return { ok: false, why: 'No such question.' };
  if (rq[0].comparative_question_id) return { ok: false, why: 'This is a comparative question, so its answers stay as first given.' };
  const done = await sb(`research_results?request_id=eq.${rid}&ai_model=eq.${model}&select=id`) || [];
  if (!done.length) return { ok: false, why: 'This Jim has not finished its report yet.' };
  const fs = await sb(`followups?request_id=eq.${rid}&ai_model=eq.${model}&finished_at=is.null&select=id`) || [];
  for (const f of fs) {
    const active = await sb(`jim_jobs?followup_id=eq.${f.id}&status=in.(queued,claimed,launched)&select=id&limit=1`) || [];
    if (active.length) return { ok: false, why: 'A follow-up is already in progress.', busy: true };
  }
  return { ok: true };
}

async function thread(req, res, tier) {
  const rid = posInt(req.query && req.query.request), model = String((req.query && req.query.model) || '');
  if (!rid || !MODELS.includes(model)) return res.status(400).json({ error: 'Give a question number and a Jim' });
  if (!hasTierAccess(tier, 'admin') && !(await requestIsAssistants(rid))) return res.status(401).json({ error: 'Unauthorized' });
  const rows = await sb(`followups?request_id=eq.${rid}&ai_model=eq.${model}&select=id,message,reply,created_at,finished_at&order=id.asc&limit=50`) || [];
  const ids = rows.map((f) => f.id);
  const jobs = ids.length ? await sb(`jim_jobs?followup_id=in.(${ids.join(',')})&select=id,followup_id,status,launched_at,error_text&order=id.asc`) || [] : [];
  const now = Date.now();
  const followups = rows.map((f) => ({ ...f, ...stateOf(f, jobs.filter((j) => j.followup_id === f.id), now), job_id: (jobs.filter((j) => j.followup_id === f.id).slice(-1)[0] || {}).id || null }));
  const ask = await canAsk(rid, model);
  return res.status(200).json({ followups, can_ask: ask.ok, why: ask.ok ? null : ask.why, busy: !!ask.busy });
}

async function create(req, res, tier) {
  const b = req.body || {};
  const rid = posInt(b.request_id), model = String(b.model || '');
  const message = String(b.message || '').replace(/\r\n/g, '\n').trim();
  if (!rid || !MODELS.includes(model)) return res.status(400).json({ error: 'Give a question number and a Jim' });
  if (!hasTierAccess(tier, 'admin') && !(await requestIsAssistants(rid))) return res.status(401).json({ error: 'Unauthorized' });
  if (message.length < MIN_LEN) return res.status(400).json({ error: 'Please write your follow-up out first.' });
  if (message.length > MAX_LEN) return res.status(400).json({ error: 'That follow-up is too long (limit ' + MAX_LEN + ' characters).' });

  const ask = await canAsk(rid, model);
  if (!ask.ok) return res.status(ask.busy ? 409 : 400).json({ error: ask.why });
  const waiting = await sb('jim_jobs?status=eq.queued&select=id');
  if (waiting && waiting.length >= MAX_WAITING) return res.status(429).json({ error: 'Too many jobs are waiting already. Try again shortly.' });

  // a new follow-up means a new report to review: forget that this question's review was finished (the new window must not be closed)
  try { await sb(`research_results?request_id=eq.${rid}&ai_model=eq.${model}`, { method: 'PATCH', body: { reviewed_at: null } }); } catch (e) { console.error('api/followups: could not reset the review marker:', e && e.message); }

  const made = await sb('followups', { method: 'POST', body: { request_id: rid, ai_model: model, message }, prefer: 'return=representation' });
  const fid = made && made[0] && made[0].id;
  if (!fid) throw new Error('follow-up was not created');
  try {
    await sb('jim_jobs', { method: 'POST', body: { kind: 'followup', model, followup_id: fid, requested_by: tier } });
  } catch (e) {
    await sb(`followups?id=eq.${fid}`, { method: 'DELETE' });         // do not leave a follow-up nobody will pick up
    throw e;
  }
  return res.status(201).json({ id: fid });
}

async function withdraw(req, res, tier) {
  const id = posInt(req.query && req.query.id);
  if (!id) return res.status(400).json({ error: 'Invalid follow-up' });
  if (!hasTierAccess(tier, 'admin')) {
    const own = await sb(`followups?id=eq.${id}&select=request_id`) || [];
    if (!own.length || !(await requestIsAssistants(own[0].request_id))) return res.status(401).json({ error: 'Unauthorized' });
  }
  const jobs = await sb(`jim_jobs?followup_id=eq.${id}&select=id,status`) || [];
  if (!jobs.length || jobs.some((j) => j.status !== 'queued')) return res.status(409).json({ error: 'It has already started.' });
  await sb(`followups?id=eq.${id}&finished_at=is.null`, { method: 'DELETE' });     // its job goes with it
  return res.status(200).json({ withdrawn: id });
}
