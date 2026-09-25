// api/proposals.js
// Reviewing what an unattended Jim suggests saving, and promoting a question to comparative. ADMIN tier only.
//
//   GET  ?request=R and/or ?question=Q -> { proposals: [...], results, promoted_question_id }
//   POST { action: 'accept'|'decline', ids: [n, ...] }
//          accept  -> each still-pending item is saved to the right table (the Jim's own memory table,
//                     open_research_questions, or contradictions) and marked accepted
//          decline -> the items are only marked declined; nothing is written anywhere else
//   POST { action: 'promote', request_id: R }
//          -> logs the question as a comparative research question, copies the answers already given into
//             comparative_answers (same columns, no re-run), and sets the Judge to start automatically once
//             all three Jims have answered.
//
// Nothing is ever written to a memory / question / contradiction table except through an Accept tap here.

import { tierFromRequest, hasTierAccess } from './_session.js';
import { sb } from './_sb.js';

const MEMORY_TABLES = { claude: 'claude_memory', gpt: 'gpt_memory', gemini: 'gemini_memory' };

const s = (v, max = 8000) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

// Turns one pending suggestion into { table, body } for the real table, or null if it is unusable.
function targetFor(row) {
  const f = row.fields && typeof row.fields === 'object' ? row.fields : {};
  const topic = s(row.topic, 300) || null;
  if (row.category === 'memory') {
    const content = s(f.content);
    const table = MEMORY_TABLES[row.ai_model];
    return content && table ? { table, body: { topic, content } } : null;
  }
  if (row.category === 'open_question') {
    const question = s(f.question);
    return question ? { table: 'open_research_questions', body: { question, topic, context: s(f.context) || null, status: 'open' } } : null;
  }
  if (row.category === 'contradiction') {
    const standard_account = s(f.standard_account), database_shows = s(f.database_shows);
    if (!standard_account || !database_shows) return null;
    const conf = s(f.confidence, 40).toLowerCase();
    return { table: 'contradictions', body: { topic, standard_account, database_shows, source_documents: s(f.source_documents) || null, confidence: conf || null } };
  }
  return null;
}

export default async function handler(req, res) {
  const tier = tierFromRequest(req);
  if (!tier || !hasTierAccess(tier, 'admin')) return res.status(401).json({ error: 'Unauthorized' });

  try {
    if (req.method === 'GET') return await list(req, res);
    if (req.method === 'POST') {
      const action = String((req.body || {}).action || '');
      if (action === 'accept' || action === 'decline') return await decide(req, res, action);
      if (action === 'promote') return await promote(req, res);
      return res.status(400).json({ error: 'Unknown action' });
    }
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('api/proposals error:', err && err.message);
    return res.status(500).json({ error: 'Server error' });
  }
}

const posInt = (v) => { const n = Number(v); return Number.isInteger(n) && n >= 1 && n <= 1000000000 ? n : null; };

async function list(req, res) {
  const r = posInt(req.query && req.query.request), q = posInt(req.query && req.query.question);
  if (!r && !q) return res.status(400).json({ error: 'Give a request or question number' });

  let proposals = [];
  const cols = 'id,ai_model,category,topic,fields,status,request_id,question_id';
  if (r) proposals = proposals.concat(await sb(`pending_proposals?request_id=eq.${r}&select=${cols}&order=id.asc&limit=100`) || []);
  if (q) proposals = proposals.concat(await sb(`pending_proposals?question_id=eq.${q}&select=${cols}&order=id.asc&limit=100`) || []);

  let results = 0, promoted = null;
  if (r) {
    const rq = await sb(`research_requests?id=eq.${r}&select=id,comparative_question_id`) || [];
    if (!rq.length) return res.status(404).json({ error: 'No such question' });
    promoted = rq[0].comparative_question_id || null;
    results = ((await sb(`research_results?request_id=eq.${r}&select=id`)) || []).length;
  }
  return res.status(200).json({ proposals, results, promoted_question_id: promoted });
}

async function decide(req, res, action) {
  const ids = [...new Set((Array.isArray(req.body.ids) ? req.body.ids : []).map(posInt))];
  if (!ids.length || ids.length > 50 || ids.includes(null)) return res.status(400).json({ error: 'Choose 1 to 50 items' });

  // claim the still-pending ones first, so a double tap cannot save anything twice
  const claimed = await sb(`pending_proposals?id=in.(${ids.join(',')})&status=eq.pending`, {
    method: 'PATCH',
    body: { status: action === 'accept' ? 'accepted' : 'declined', decided_at: new Date().toISOString() },
    prefer: 'return=representation',
  }) || [];
  if (action === 'decline') return res.status(200).json({ declined: claimed.length });

  const saved = [], problems = [];
  for (const row of claimed) {
    const t = targetFor(row);
    try {
      if (!t) throw new Error('incomplete suggestion');
      await sb(t.table, { method: 'POST', body: t.body });
      saved.push(row.id);
    } catch (e) {
      problems.push({ id: row.id, error: String((e && e.message) || e).slice(0, 200) });
      try { await sb(`pending_proposals?id=eq.${row.id}`, { method: 'PATCH', body: { status: 'pending', decided_at: null } }); } catch { /* left as is */ }
    }
  }
  return res.status(problems.length && !saved.length ? 500 : 200).json({ accepted: saved.length, problems });
}

async function promote(req, res) {
  const rid = posInt(req.body.request_id);
  if (!rid) return res.status(400).json({ error: 'Invalid question number' });
  const rq = await sb(`research_requests?id=eq.${rid}&select=id,question_text,topic,comparative_question_id`) || [];
  if (!rq.length) return res.status(404).json({ error: 'No such question' });
  if (rq[0].comparative_question_id) return res.status(409).json({ error: 'Already a comparative question', question_id: rq[0].comparative_question_id });

  const created = await sb('comparative_questions', {
    method: 'POST', body: { question_text: rq[0].question_text, topic: rq[0].topic }, prefer: 'return=representation',
  });
  const qid = created && created[0] && created[0].id;
  if (!qid) throw new Error('comparative question was not created');

  // claim the promotion (guards against two taps at once)
  const won = await sb(`research_requests?id=eq.${rid}&comparative_question_id=is.null`, {
    method: 'PATCH', body: { comparative_question_id: qid }, prefer: 'return=representation',
  }) || [];
  if (!won.length) {
    await sb(`comparative_questions?id=eq.${qid}`, { method: 'DELETE' });
    return res.status(409).json({ error: 'Already a comparative question' });
  }

  const results = await sb(`research_results?request_id=eq.${rid}&select=ai_model,summary,key_findings,document_ids,output_file_url,criteria_applied,research_log_url,answered_at`) || [];
  if (results.length) {
    await sb('comparative_answers', { method: 'POST', body: results.map((r) => ({ ...r, comparative_question_id: qid })) });
  }
  await sb('comparative_auto_judge', { method: 'POST', body: { question_id: qid } });
  return res.status(200).json({ question_id: qid, copied: results.length });
}
