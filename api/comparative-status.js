export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

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

    const questions = (Array.isArray(rows) ? rows : []).map((q) => ({
      ...q,
      judge_verdict_url: latestVerdict[q.id] ? latestVerdict[q.id].output_file_url : null,
      judge_evaluated_at: latestVerdict[q.id] ? latestVerdict[q.id].evaluated_at : null,
    }));

    return res.status(200).json({ questions });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
