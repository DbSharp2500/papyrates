// api/chat-gpt.js — GPT research portal serverless function

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  if (!OPENAI_API_KEY) return res.status(500).json({ error: 'OPENAI_API_KEY not configured' });

  try {
    const { model, max_tokens, system, messages } = req.body;
    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'messages array required' });
    }

    // Build messages array — prepend system message if provided
    const openaiMessages = [];
    if (system) {
      openaiMessages.push({ role: 'system', content: system });
    }

    // Convert messages — handle content that may include image attachments
    for (const msg of messages) {
      const content = msg.content;
      if (typeof content === 'string') {
        openaiMessages.push({ role: msg.role, content });
      } else if (Array.isArray(content)) {
        // Already in OpenAI content-parts format
        openaiMessages.push({ role: msg.role, content });
      } else if (content && typeof content === 'object' && content.attachment) {
        // Attachment format from the portal
        const parts = [];
        if (content.text) parts.push({ type: 'text', text: content.text });
        const att = content.attachment;
        if (att.mimeType && att.mimeType.startsWith('image/')) {
          parts.push({
            type: 'image_url',
            image_url: { url: `data:${att.mimeType};base64,${att.base64}` }
          });
        }
        openaiMessages.push({ role: msg.role, content: parts });
      } else {
        openaiMessages.push({ role: msg.role, content: String(content) });
      }
    }

    const requestBody = {
      model: model || 'gpt-4o',
      max_tokens: max_tokens || 4096,
      messages: openaiMessages,
    };

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const err = await response.json();
      console.error('OpenAI error:', err);
      const code = err.error?.code || '';
      const type = err.error?.type || '';
      if (code === 'insufficient_quota' || code === 'billing_hard_limit_reached' || type === 'insufficient_quota') {
        return res.status(402).json({ error: '💳 BILLING_EXHAUSTED', billingUrl: 'https://platform.openai.com/settings/organization/billing' });
      }
      return res.status(response.status).json({ error: err.error?.message || 'OpenAI API error' });
    }

    const data = await response.json();
    return res.status(200).json(data);

  } catch (err) {
    console.error('chat-gpt error:', err);
    return res.status(500).json({ error: err.message });
  }
}
