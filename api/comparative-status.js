import { tierFromRequest, hasTierAccess } from './_session.js';
import { sb } from './_sb.js';
import { modelState } from './_state.js';

const MODELS = ['claude', 'gpt', 'gemini'];

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  // Admin only, matching comparative.html's own requireAuth('admin'). That
  // page-level check only runs in the browser, so on its own it never
  // protected this endpoint - anyone could GET it directly. No CORS headers
  // either: the dashboard is same-origin, so nothing else needs to call this.
  const tier = tierFromRequest(req);
  if (!tier || !hasTierAccess(tier, 'admin')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_KEY;
  const headers = {
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
  };

  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/comparative_question_status?select=id,question_text,topic,answers_so_far,claude_answered,gpt_answered,gemini_answered,still_needs,status&order=id.asc`,
      { headers }
    );
    if (!r.ok) throw new Error(`Supabase query failed: ${await r.text()}`);
    const rows = await r.json();

    const evalRes = await fetch(
      `${SUPABASE_URL}/rest/v1/comparative_evaluations?select=comparative_question_id,output_file_url,evaluated_at&order=evaluated_at.desc`,
      { headers }
    );
    if (!evalRes.ok) throw new Error(`Supabase evaluations query failed: ${await evalRes.text()}`);
    const evalRows = await evalRes.json();

    // Keep only the latest verdict per question (rows are already ordered
    // newest-first, so the first one seen per question id wins).
    const latestVerdict = {};
    for (const row of evalRows) {
      if (!(row.comparative_question_id in latestVerdict)) {
        latestVerdict[row.comparative_question_id] = row;
      }
    }

    // What each Jim is doing right now for each question (waiting / working N min / done / failed), the same view the
    // Ask page shows - so a question that has been launched never looks idle. A failure of this extra lookup must
    // never stop the page from loading.
    let jobs = [], answers = [];
    try {
      jobs = await sb('jim_jobs?kind=in.(answer,evaluate)&question_id=not.is.null&select=id,kind,model,question_id,status,launched_at,claimed_at,error_text&order=id.desc&limit=300') || [];
      jobs.reverse();                                                     // oldest first, as modelState expects
      answers = await sb('comparative_answers?select=comparative_question_id,ai_model,output_file_url&limit=2000') || [];
    } catch (e) { console.error('comparative-status: job lookup failed:', e && e.message); }
    const now = Date.now();

    const questions = (Array.isArray(rows) ? rows : []).map((q) => {
      const models = {};
      for (const m of MODELS) {
        models[m] = modelState(
          answers.find((a) => a.comparative_question_id === q.id && a.ai_model === m),
          jobs.filter((j) => j.kind === 'answer' && j.question_id === q.id && j.model === m), now);
      }
      const v = latestVerdict[q.id];
      const judge = modelState(v ? { output_file_url: v.output_file_url } : null, jobs.filter((j) => j.kind === 'evaluate' && j.question_id === q.id), now);
      return {
        ...q,
        judge_verdict_url: v ? v.output_file_url : null,
        judge_evaluated_at: v ? v.evaluated_at : null,
        models,
        judge,
      };
    });

    return res.status(200).json({ questions });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
