// api/judge-followups.js
// Follow-up questions on a finished Judge verdict - ADMIN tier only (Judge is never available to the Research Assistant).
//
//   GET    ?question=Q  -> the conversation so far for that question, whether a new follow-up can be asked, and
//                          where the current one stands (waiting / working / done / failed)
//   POST   { question_id, message } -> stores the follow-up and queues a "judge_followup" job. If Judge's original
//                          evaluation recorded its own Claude Code session id, the launcher RESUMES that exact
//                          session (full verification history intact) instead of starting over; otherwise it starts
//                          a fresh unattended session that rereads the current report and verdict from the database.
//   DELETE ?id=N         -> withdraws a follow-up that has not started yet
//
// A follow-up only makes sense once Judge has actually produced a verdict for the question.

import { tierFromRequest, hasTierAccess } from './_session.js';
import { sb } from './_sb.js';

const MIN_LEN = 5, MAX_LEN = 4000;
const MAX_WAITING = 20;
const posInt = (v) => { const n = Number(v); return Number.isInteger(n) && n >= 1 && n <= 1000000000 ? n : null; };

export default async function handler(req, res) {
  const tier = tierFromRequest(req);
  if (!tier || !hasTierAccess(tier, 'admin')) return res.status(401).json({ error: 'Unauthorized' });
  try {
    if (req.method === 'GET') return await thread(req, res);
    if (req.method === 'POST') return await create(req, res, tier);
    if (req.method === 'DELETE') return await withdraw(req, res);
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('api/judge-followups error:', err && err.message);
    return res.status(500).json({ error: 'Server error' });
  }
}

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

async function canAsk(qid) {
  const ev = await sb(`comparative_evaluations?comparative_question_id=eq.${qid}&select=id`) || [];
  if (!ev.length) return { ok: false, why: 'Judge has not evaluated this question yet.' };
  const fs = await sb(`judge_followups?comparative_question_id=eq.${qid}&finished_at=is.null&select=id`) || [];
  for (const f of fs) {
    const active = await sb(`jim_jobs?judge_followup_id=eq.${f.id}&status=in.(queued,claimed,launched)&select=id&limit=1`) || [];
    if (active.length) return { ok: false, why: 'A follow-up is already in progress.', busy: true };
  }
  return { ok: true };
}

async function thread(req, res) {
  const qid = posInt(req.query && req.query.question);
  if (!qid) return res.status(400).json({ error: 'Give a question number' });
  const rows = await sb(`judge_followups?comparative_question_id=eq.${qid}&select=id,message,reply,created_at,finished_at&order=id.asc&limit=50`) || [];
  const ids = rows.map((f) => f.id);
  const jobs = ids.length ? await sb(`jim_jobs?judge_followup_id=in.(${ids.join(',')})&select=id,judge_followup_id,status,launched_at,error_text&order=id.asc`) || [] : [];
  const now = Date.now();
  const followups = rows.map((f) => ({ ...f, ...stateOf(f, jobs.filter((j) => j.judge_followup_id === f.id), now) }));
  const ask = await canAsk(qid);
  return res.status(200).json({ followups, can_ask: ask.ok, why: ask.ok ? null : ask.why, busy: !!ask.busy });
}

async function create(req, res, tier) {
  const b = req.body || {};
  const qid = posInt(b.question_id);
  const message = String(b.message || '').replace(/\r\n/g, '\n').trim();
  if (!qid) return res.status(400).json({ error: 'Give a question number' });
  if (message.length < MIN_LEN) return res.status(400).json({ error: 'Please write your follow-up out first.' });
  if (message.length > MAX_LEN) return res.status(400).json({ error: 'That follow-up is too long (limit ' + MAX_LEN + ' characters).' });

  const ask = await canAsk(qid);
  if (!ask.ok) return res.status(ask.busy ? 409 : 400).json({ error: ask.why });
  const waiting = await sb('jim_jobs?status=eq.queued&select=id');
  if (waiting && waiting.length >= MAX_WAITING) return res.status(429).json({ error: 'Too many jobs are waiting already. Try again shortly.' });

  const made = await sb('judge_followups', { method: 'POST', body: { comparative_question_id: qid, message }, prefer: 'return=representation' });
  const fid = made && made[0] && made[0].id;
  if (!fid) throw new Error('follow-up was not created');
  try {
    await sb('jim_jobs', { method: 'POST', body: { kind: 'judge_followup', model: 'judge', question_id: qid, judge_followup_id: fid, requested_by: tier } });
  } catch (e) {
    await sb(`judge_followups?id=eq.${fid}`, { method: 'DELETE' });
    throw e;
  }
  return res.status(201).json({ id: fid });
}

async function withdraw(req, res) {
  const id = posInt(req.query && req.query.id);
  if (!id) return res.status(400).json({ error: 'Invalid follow-up' });
  const jobs = await sb(`jim_jobs?judge_followup_id=eq.${id}&select=id,status`) || [];
  if (!jobs.length || jobs.some((j) => j.status !== 'queued')) return res.status(409).json({ error: 'It has already started.' });
  await sb(`judge_followups?id=eq.${id}&finished_at=is.null`, { method: 'DELETE' });
  return res.status(200).json({ withdrawn: id });
}
