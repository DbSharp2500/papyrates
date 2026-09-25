// api/ask.js
// "Ask a research question" - ADMIN tier only.
//
//   POST { question, topic?, models: ['claude','gpt','gemini'], comparative?: true }
//     - one or two Jims (or three with comparative:false): an everyday question. It is stored in research_requests
//       and one "ask" job per chosen Jim is queued. Nothing touches the comparative tables.
//     - all three Jims with comparative:true: logged as a comparative research question (comparative_questions),
//       one "answer" job per Jim, and the Judge is set to start automatically once all three have answered.
//     Either way the Desktop launcher picks the jobs up and each Jim reads the question text from the database
//     itself - no question text ever goes on a command line.
//
//   GET  -> the most recent questions of both kinds, with each chosen Jim's state (waiting / working / done +
//           report / failed / cancelled), the Judge's state for comparative ones, and whether the Desktop is online.

import { tierFromRequest, hasTierAccess } from './_session.js';
import { sb } from './_sb.js';
import { keyFromPath } from './_reports.js';

const MODELS = ['claude', 'gpt', 'gemini'];
const MAX_WAITING = 20;
const ONLINE_WINDOW_MS = 90 * 1000;
const MIN_Q = 10, MAX_Q = 8000;

export default async function handler(req, res) {
  const tier = tierFromRequest(req);
  if (!tier || !hasTierAccess(tier, 'admin')) return res.status(401).json({ error: 'Unauthorized' });

  try {
    if (req.method === 'GET') return await list(res);
    if (req.method === 'POST') return await create(req, res, tier);
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('api/ask error:', err && err.message);
    return res.status(500).json({ error: 'Server error' });
  }
}

async function create(req, res, tier) {
  const b = req.body || {};
  const question = String(b.question || '').replace(/\r\n/g, '\n').trim();
  if (question.length < MIN_Q) return res.status(400).json({ error: 'Please write the question out (at least a sentence).' });
  if (question.length > MAX_Q) return res.status(400).json({ error: 'That question is too long (limit ' + MAX_Q + ' characters).' });

  const models = [...new Set(Array.isArray(b.models) ? b.models.map(String) : [])];
  if (!models.length || models.some((m) => !MODELS.includes(m))) return res.status(400).json({ error: 'Choose at least one of Claude, GPT or Gemini.' });

  const comparative = b.comparative === true;
  if (comparative && models.length !== MODELS.length) return res.status(400).json({ error: 'A comparative question goes to all three Jims.' });
  if (models.length === MODELS.length && typeof b.comparative !== 'boolean') return res.status(400).json({ error: 'Please say whether to log this as a comparative research question.' });

  const topic = String(b.topic || '').replace(/\s+/g, ' ').trim().slice(0, 120) || null;

  const waiting = await sb('jim_jobs?status=eq.queued&select=id');
  if (waiting && waiting.length + models.length > MAX_WAITING) return res.status(429).json({ error: 'Too many jobs are waiting already. Try again once some have started.' });

  let id, kind, idField;
  if (comparative) {
    const c = await sb('comparative_questions', { method: 'POST', body: { question_text: question, topic }, prefer: 'return=representation' });
    id = c && c[0] && c[0].id;
    kind = 'answer'; idField = 'question_id';
    if (id) await sb('comparative_auto_judge', { method: 'POST', body: { question_id: id } });   // Judge starts by itself once all three have answered
  } else {
    const c = await sb('research_requests', { method: 'POST', body: { question_text: question, topic, requested_by: tier }, prefer: 'return=representation' });
    id = c && c[0] && c[0].id;
    kind = 'ask'; idField = 'request_id';
  }
  if (!id) throw new Error('question was not created');

  const queued = [], failed = [];
  for (const model of models) {
    try {
      const j = await sb('jim_jobs', { method: 'POST', body: { kind, model, [idField]: id, requested_by: tier }, prefer: 'return=representation' });
      queued.push({ model, job_id: j && j[0] && j[0].id });
    } catch (e) {
      console.error('api/ask: could not queue', model, e && e.message);
      failed.push(model);
    }
  }
  return res.status(failed.length === models.length ? 500 : 201).json({ id, comparative, queued, failed });
}

// One Jim's state for one question, given its answer row (if any) and its jobs (oldest first)
function modelState(ans, jobs, now) {
  if (ans) return { state: 'done', report: keyFromPath(ans.output_file_url) };
  const job = jobs.length ? jobs[jobs.length - 1] : null;             // newest attempt wins
  if (!job) return { state: 'none' };
  if (job.status === 'queued') return { state: 'waiting', job_id: job.id };
  if (job.status === 'claimed' || job.status === 'launched') {
    const mins = job.launched_at ? Math.max(0, Math.round((now - new Date(job.launched_at).getTime()) / 60000)) : 0;
    return { state: 'working', minutes: mins };
  }
  if (job.status === 'failed') return { state: 'failed', error: job.error_text || 'unknown problem' };
  return { state: 'cancelled' };
}

async function list(res) {
  const now = Date.now();
  const reqs = await sb('research_requests?select=id,question_text,topic,created_at,comparative_question_id&order=id.desc&limit=12') || [];
  const cqs = await sb('comparative_questions?select=id,question_text,topic,created_at&order=id.desc&limit=8') || [];

  const rids = reqs.map((r) => r.id), qids = cqs.map((q) => q.id);
  const inR = `(${rids.join(',')})`, inQ = `(${qids.join(',')})`;
  const rJobs = rids.length ? await sb(`jim_jobs?kind=eq.ask&request_id=in.${inR}&select=id,model,request_id,status,launched_at,error_text&order=id.asc`) || [] : [];
  const rRes = rids.length ? await sb(`research_results?request_id=in.${inR}&select=request_id,ai_model,output_file_url`) || [] : [];
  // follow-ups still in progress (asked, not yet finished) on these questions
  let fRows = [], fJobs = [];
  try {                                     // never let the follow-up lookup break the whole page
    fRows = rids.length ? await sb(`followups?request_id=in.${inR}&finished_at=is.null&select=id,request_id,ai_model&order=id.asc`) || [] : [];
    fJobs = fRows.length ? await sb(`jim_jobs?followup_id=in.(${fRows.map((f) => f.id).join(',')})&select=id,followup_id,status,launched_at&order=id.asc`) || [] : [];
  } catch (e) { console.error('api/ask: follow-up lookup failed:', e && e.message); }
  const cJobs = qids.length ? await sb(`jim_jobs?kind=in.(answer,evaluate)&question_id=in.${inQ}&select=id,kind,model,question_id,status,launched_at,error_text&order=id.asc`) || [] : [];
  const cAns = qids.length ? await sb(`comparative_answers?comparative_question_id=in.${inQ}&select=comparative_question_id,ai_model,output_file_url`) || [] : [];
  const cEval = qids.length ? await sb(`comparative_evaluations?comparative_question_id=in.${inQ}&select=comparative_question_id,output_file_url,evaluated_at&order=evaluated_at.desc`) || [] : [];
  const auto = qids.length ? await sb(`comparative_auto_judge?question_id=in.${inQ}&select=question_id,judge_queued_at`) || [] : [];
  const promoted = qids.length ? await sb(`research_requests?comparative_question_id=in.${inQ}&select=id,comparative_question_id`) || [] : [];
  const srv = await sb('jim_server?id=eq.1&select=last_seen');
  const last = srv && srv[0] ? new Date(srv[0].last_seen).getTime() : 0;

  const items = [];

  for (const r of reqs) {
    if (r.comparative_question_id) continue;                     // promoted: shown as its comparative question instead
    const models = {};
    for (const m of MODELS) {
      models[m] = modelState(rRes.find((a) => a.request_id === r.id && a.ai_model === m), rJobs.filter((j) => j.request_id === r.id && j.model === m), now);
      // a follow-up that is waiting or working shows on the Jim's chip
      const open = fRows.filter((f) => f.request_id === r.id && f.ai_model === m);
      for (const f of open) {
        const jobs = fJobs.filter((j) => j.followup_id === f.id);
        const job = jobs.length ? jobs[jobs.length - 1] : null;
        if (!job || job.status === 'queued') models[m].followup = { state: 'waiting' };
        else if (job.status === 'claimed' || job.status === 'launched') models[m].followup = { state: 'working', minutes: job.launched_at ? Math.max(0, Math.round((now - new Date(job.launched_at).getTime()) / 60000)) : 0 };
      }
    }
    items.push({ type: 'research', id: r.id, topic: r.topic, question_text: r.question_text, created_at: r.created_at, models });
  }

  for (const q of cqs) {
    const models = {};
    for (const m of MODELS) {
      models[m] = modelState(cAns.find((a) => a.comparative_question_id === q.id && a.ai_model === m), cJobs.filter((j) => j.kind === 'answer' && j.question_id === q.id && j.model === m), now);
    }
    // the Judge
    const ev = cEval.find((e) => e.comparative_question_id === q.id);
    const ejobs = cJobs.filter((j) => j.kind === 'evaluate' && j.question_id === q.id);
    const au = auto.find((a) => a.question_id === q.id);
    let judge = modelState(ev ? { output_file_url: ev.output_file_url } : null, ejobs, now);
    if (judge.state === 'none' && au && !au.judge_queued_at) judge = { state: 'scheduled' };
    const pr = promoted.find((p) => p.comparative_question_id === q.id);
    items.push({ type: 'comparative', id: q.id, request_id: pr ? pr.id : null, topic: q.topic, question_text: q.question_text, created_at: q.created_at, models, judge, auto_judge: !!au });
  }

  items.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  return res.status(200).json({ server: { online: now - last < ONLINE_WINDOW_MS }, items: items.slice(0, 15) });
}
