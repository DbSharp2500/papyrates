// api/proposals.js
// Reviewing what an unattended Jim suggests saving, and promoting a question to comparative. ADMIN tier only.
//
//   GET  ?request=R and/or ?question=Q -> { proposals: [...], results, promoted_question_id }
//        or ?report=<report key>  (a report opened from the Reports list: works out which question it answered)
//   POST { action: 'decide', accept: [ids], decline: [ids] }   <- what the review sheet uses
//          the ticked items are saved to the right table (the Jim's own memory table, open_research_questions,
//          or contradictions) and marked accepted; every listed item that was NOT ticked is deleted outright
//          (no record kept, never written to any memory table)
//   POST { action: 'accept'|'decline', ids: [n, ...] }   (the same two halves, separately; 'decline' also deletes)
//   POST { action: 'promote', request_id: R }
//          -> logs the question as a comparative research question, copies the answers already given into
//             comparative_answers (same columns, no re-run), and sets the Judge to start automatically once
//             all three Jims have answered.
//
// Nothing is ever written to a memory / question / contradiction table except through an Accept tap here.

import { tierFromRequest, hasTierAccess } from './_session.js';
import { sb } from './_sb.js';
import { KEY_RE, keyFromPath } from './_reports.js';

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
      if (action === 'decide') return await decideBatch(req, res);
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
  let r = posInt(req.query && req.query.request), q = posInt(req.query && req.query.question);

  // Opened from the Reports list (no question number in the link)? Work out which question this report answered.
  const rep = String((req.query && req.query.report) || '');
  if (!r && !q && KEY_RE.test(rep) && !rep.includes('..')) {
    const name = rep.split('/')[1];
    const [rr, ca] = [
      await sb(`research_results?output_file_url=ilike.*${name}&select=request_id,output_file_url&limit=20`) || [],
      await sb(`comparative_answers?output_file_url=ilike.*${name}&select=comparative_question_id,output_file_url&limit=20`) || [],
    ];
    const hitR = rr.find((x) => keyFromPath(x.output_file_url) === rep);
    const hitC = ca.find((x) => keyFromPath(x.output_file_url) === rep);
    if (hitR) r = hitR.request_id;
    if (hitC) {
      q = hitC.comparative_question_id;
      const pr = await sb(`research_requests?comparative_question_id=eq.${q}&select=id&limit=1`) || [];   // a promoted question's suggestions belong to its request
      if (pr.length && !r) r = pr[0].id;
    }
    if (!r && !q) return res.status(200).json({ proposals: [], results: 0, promoted_question_id: null, request_id: null, question_id: null });
  }
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
  return res.status(200).json({ proposals, results, promoted_question_id: promoted, request_id: r || null, question_id: q || null });
}

// Saves the given suggestions (only those still pending) and marks them accepted. Returns { saved, problems }.
async function acceptIds(ids) {
  if (!ids.length) return { saved: [], problems: [] };
  // claim the still-pending ones first, so a double tap cannot save anything twice
  const claimed = await sb(`pending_proposals?id=in.(${ids.join(',')})&status=eq.pending`, {
    method: 'PATCH', body: { status: 'accepted', decided_at: new Date().toISOString() }, prefer: 'return=representation',
  }) || [];
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
  return { saved, problems };
}

// Wipes the given still-pending suggestions completely - the row is deleted, no record is kept, and nothing is
// written to any memory table. (Only rows still 'pending' can be deleted here, so an already-saved one is never touched.)
// Returns the count.
async function declineIds(ids) {
  if (!ids.length) return 0;
  const gone = await sb(`pending_proposals?id=in.(${ids.join(',')})&status=eq.pending`, {
    method: 'DELETE', prefer: 'return=representation',
  }) || [];
  return gone.length;
}

// Which (question, Jim) pairs the given suggestions belong to - read BEFORE they are decided (deleted rows are gone after).
async function pairsOf(ids) {
  const rows = await sb(`pending_proposals?id=in.(${ids.join(',')})&select=id,request_id,question_id,ai_model`) || [];
  const seen = new Map();
  for (const r of rows) {
    const kind = r.request_id ? 'ask' : 'answer', ref = r.request_id || r.question_id;
    seen.set(`${kind}:${ref}:${r.ai_model}`, { kind, ref, model: r.ai_model });
  }
  return [...seen.values()];
}

// After a decision: for every (question, Jim) that now has NO suggestion left waiting, set reviewed_at on that Jim's
// answer row so the Desktop can close its idle window. Never allowed to fail the decision itself (e.g. before the
// column exists).
async function markReviewed(pairs) {
  for (const p of pairs) {
    try {
      const col = p.kind === 'ask' ? 'request_id' : 'question_id';
      const left = await sb(`pending_proposals?${col}=eq.${p.ref}&ai_model=eq.${p.model}&status=eq.pending&select=id&limit=1`) || [];
      if (left.length) continue;                                       // something is still waiting: not finished
      const where = p.kind === 'ask' ? `research_results?request_id=eq.${p.ref}` : `comparative_answers?comparative_question_id=eq.${p.ref}`;
      await sb(`${where}&ai_model=eq.${p.model}`, { method: 'PATCH', body: { reviewed_at: new Date().toISOString() } });
    } catch (e) {
      console.error('api/proposals: could not record review finished:', e && e.message);
    }
  }
}
const idList = (v, max) => {
  const a = [...new Set((Array.isArray(v) ? v : []).map(posInt))];
  return a.includes(null) || a.length > max ? null : a;
};

async function decide(req, res, action) {
  const ids = idList(req.body.ids, 50);
  if (!ids || !ids.length) return res.status(400).json({ error: 'Choose 1 to 50 items' });
  const pairs = await pairsOf(ids).catch(() => []);
  if (action === 'decline') { const declined = await declineIds(ids); await markReviewed(pairs); return res.status(200).json({ declined }); }
  const { saved, problems } = await acceptIds(ids);
  await markReviewed(pairs);
  return res.status(problems.length && !saved.length ? 500 : 200).json({ accepted: saved.length, problems });
}

// One tap from the review sheet: the ticked ones are saved, and every listed one that was NOT ticked is discarded.
async function decideBatch(req, res) {
  const accept = idList(req.body.accept, 100), decline = idList(req.body.decline, 100);
  if (accept === null || decline === null) return res.status(400).json({ error: 'Invalid list of items' });
  if (!accept.length && !decline.length) return res.status(400).json({ error: 'Nothing to decide' });
  if (accept.some((i) => decline.includes(i))) return res.status(400).json({ error: 'An item cannot be both saved and discarded' });
  const pairs = await pairsOf([...accept, ...decline]).catch(() => []);
  const { saved, problems } = await acceptIds(accept);
  // an item that could not be saved stays pending (and is NOT discarded); the rest of the unticked ones are discarded
  const declined = await declineIds(decline);
  await markReviewed(pairs);                       // nothing left waiting -> the Jim's idle window may be closed
  return res.status(problems.length && !saved.length && !declined ? 500 : 200).json({ accepted: saved.length, declined, problems });
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
