export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { tool_name, tool_input } = req.body;

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_KEY;
  const headers = {
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
    'Prefer': 'return=representation',
  };

  try {
    if (tool_name === 'save_dossier_correction') {
      const { entity_type, entity_id, canonical_name, correction } = tool_input;
      if (!entity_type || !entity_id || !correction) {
        return res.status(400).json({ error: 'Missing required fields: entity_type, entity_id, correction' });
      }
      const r = await fetch(
        `${SUPABASE_URL}/rest/v1/dossiers` +
        `?entity_type=eq.${encodeURIComponent(entity_type)}&entity_id=eq.${entity_id}`,
        { method: 'PATCH', headers, body: JSON.stringify({ researcher_notes: correction }) }
      );
      if (!r.ok) throw new Error(`Supabase PATCH failed: ${await r.text()}`);
      return res.status(200).json({
        success: true,
        message: `Correction saved to dossier for ${canonical_name || entity_type + ' ' + entity_id}`,
      });
    }

    if (tool_name === 'save_global_correction') {
      const { topic, assertion, confidence } = tool_input;
      if (!topic || !assertion) {
        return res.status(400).json({ error: 'Missing required fields: topic, assertion' });
      }
      const r = await fetch(
        `${SUPABASE_URL}/rest/v1/researcher_knowledge`,
        { method: 'POST', headers, body: JSON.stringify({ topic, assertion, confidence: confidence || 'medium' }) }
      );
      if (!r.ok) throw new Error(`Supabase INSERT failed: ${await r.text()}`);
      return res.status(200).json({
        success: true,
        message: `Global correction saved for topic: ${topic}`,
      });
    }

    return res.status(400).json({ error: `Unknown tool: ${tool_name}` });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
