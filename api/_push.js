// api/_push.js
// Phone alerts through ntfy (https://ntfy.sh). Not a route itself (Vercel excludes files starting with "_").
// The alert text only ever carries a Jim's name and a question NUMBER - never the question or any research content.
// Set the Vercel env var NTFY_TOPIC (a long random word, only you and the ntfy app know it) to switch alerts on;
// without it every call here quietly does nothing.

import { sb } from './_sb.js';

export const NAMES = { claude: 'Claude', gpt: 'GPT', gemini: 'Gemini', judge: 'Judge' };

// Sends one alert, at most once per `key` (recorded in push_log). Never throws.
export async function pushOnce(key, title, message, { high = false } = {}) {
  const topic = process.env.NTFY_TOPIC;
  if (!topic || !/^[A-Za-z0-9_-]{16,64}$/.test(topic)) return false;
  try {
    try {
      await sb('push_log', { method: 'POST', body: { key } });
    } catch (e) {
      if (e && e.status === 409) return false;        // already sent
      throw e;
    }
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 5000);
    try {
      const r = await fetch(`https://ntfy.sh/${topic}`, {
        method: 'POST',
        body: message,
        headers: {
          Title: title,
          Click: `${process.env.SITE_URL || 'https://papyrates.vercel.app'}/ask.html`,
          Tags: high ? 'warning' : 'scroll',
          Priority: high ? '4' : '3',
        },
        signal: ctl.signal,
      });
      if (!r.ok) throw new Error('ntfy ' + r.status);
    } finally {
      clearTimeout(timer);
    }
    return true;
  } catch (e) {
    console.error('push failed:', key, e && e.message);
    try { await sb(`push_log?key=eq.${encodeURIComponent(key)}`, { method: 'DELETE' }); } catch { /* retry next time is best effort */ }
    return false;
  }
}
