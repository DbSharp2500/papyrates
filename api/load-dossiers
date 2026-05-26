export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { names = [] } = req.body;

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_KEY;
  const headers = {
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
  };

  try {
    // Fetch matching dossiers for all provided names (deduplicated)
    const dossiers = [];
    const seen = new Set();

    for (const name of names) {
      if (!name?.trim()) continue;
      const encoded = encodeURIComponent(name.trim());
      const r = await fetch(
        `${SUPABASE_URL}/rest/v1/dossiers?canonical_name=ilike.*${encoded}*` +
        `&select=id,entity_type,entity_id,canonical_name,content,researcher_notes&limit=3`,
        { headers }
      );
      const rows = await r.json();
      if (Array.isArray(rows)) {
        rows.forEach(row => {
          if (!seen.has(row.id)) {
            seen.add(row.id);
            dossiers.push(row);
          }
        });
      }
    }

    // Always fetch all researcher_knowledge entries
    const rkResp = await fetch(
      `${SUPABASE_URL}/rest/v1/researcher_knowledge?select=topic,assertion,confidence&order=added_at.desc`,
      { headers }
    );
    const researcherKnowledge = await rkResp.json();

    return res.status(200).json({
      dossiers,
      researcher_knowledge: Array.isArray(researcherKnowledge) ? researcherKnowledge : [],
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
