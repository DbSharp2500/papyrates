export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: { message: 'API key not configured in environment' } });
  }

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    },
    body: JSON.stringify(req.body)
  });

  const data = await response.json();

  // Detect billing/credit exhaustion and return a clean signal to the frontend
  if (!response.ok) {
    const errorType = data.error?.type || '';
    const errorMsg = data.error?.message || '';
    if (
      errorType === 'authentication_error' && errorMsg.includes('credit') ||
      errorType === 'credit_balance_too_low' ||
      response.status === 529 ||
      errorMsg.toLowerCase().includes('credit balance') ||
      errorMsg.toLowerCase().includes('billing')
    ) {
      return res.status(402).json({
        error: '💳 BILLING_EXHAUSTED',
        billingUrl: 'https://console.anthropic.com/settings/billing'
      });
    }
  }

  return res.status(response.ok ? 200 : response.status).json(data);
}
