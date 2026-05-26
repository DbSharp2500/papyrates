const CORRECTION_TOOLS = [
  {
    name: 'save_dossier_correction',
    description: 'Save a researcher correction to a specific entity dossier, overriding its content for all future sessions. Call this only when the researcher explicitly asks to save, record, or correct something about a specific person or manuscript.',
    input_schema: {
      type: 'object',
      properties: {
        entity_type: { type: 'string', enum: ['person', 'manuscript'] },
        entity_id:   { type: 'integer', description: 'The numeric entity_id shown in the dossier header' },
        canonical_name: { type: 'string', description: 'The canonical name shown in the dossier header' },
        correction: { type: 'string', description: 'The correction text to save, in plain prose' },
      },
      required: ['entity_type', 'entity_id', 'canonical_name', 'correction'],
    },
  },
  {
    name: 'save_global_correction',
    description: 'Save a global fact or correction to researcher_knowledge, applying it to all future research sessions regardless of which entity is being queried. Use for cross-cutting findings, confirmed identifications, or factual corrections that affect many queries.',
    input_schema: {
      type: 'object',
      properties: {
        topic:      { type: 'string', description: 'Short topic label, e.g. "Bey of Papyrus"' },
        assertion:  { type: 'string', description: 'The fact or correction in plain prose' },
        confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
      },
      required: ['topic', 'assertion', 'confidence'],
    },
  },
];

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: { message: 'API key not configured' } });

  const { model, max_tokens, system, messages } = req.body;

  // Derive base URL for internal save-correction calls
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host  = req.headers.host;
  const baseUrl = `${proto}://${host}`;

  try {
    let currentMessages = [...messages];

    // Tool-use loop — max 5 iterations to prevent runaway cycles
    for (let iteration = 0; iteration < 5; iteration++) {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model:      model || 'claude-sonnet-4-6',
          max_tokens: max_tokens || 4096,
          system,
          messages: currentMessages,
          tools: CORRECTION_TOOLS,
        }),
      });

      const data = await response.json();

      // Billing / auth error — surface cleanly to frontend
      if (!response.ok) {
        const msg = data.error?.message || '';
        if (msg.toLowerCase().includes('credit') || msg.toLowerCase().includes('billing') || response.status === 402) {
          return res.status(402).json({ error: '💳 BILLING_EXHAUSTED', billingUrl: 'https://console.anthropic.com/settings/billing' });
        }
        return res.status(response.status).json(data);
      }

      // Normal finish — return as-is (same shape as /api/chat)
      if (data.stop_reason !== 'tool_use') {
        return res.status(200).json(data);
      }

      // Execute each tool call, collect results
      const toolResults = [];
      for (const block of data.content) {
        if (block.type !== 'tool_use') continue;
        let resultText;
        try {
          const corrResp = await fetch(`${baseUrl}/api/save-correction`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tool_name: block.name, tool_input: block.input }),
          });
          const corrData = await corrResp.json();
          resultText = corrData.success ? `✅ ${corrData.message}` : `❌ Error: ${corrData.error}`;
        } catch (err) {
          resultText = `❌ Tool execution error: ${err.message}`;
        }
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: resultText });
      }

      // Append assistant turn + tool results, then loop back
      currentMessages = [
        ...currentMessages,
        { role: 'assistant', content: data.content },
        { role: 'user',      content: toolResults },
      ];
    }

    return res.status(500).json({ error: 'Tool-use loop exceeded maximum iterations' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
