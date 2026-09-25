// api/_push.js
// Phone alerts through ntfy (https://ntfy.sh). Not a route itself (Vercel excludes files starting with "_").
// The alert text only ever carries a Jim's name and a question NUMBER - never the question or any research content.
// Set the Vercel env var NTFY_TOPIC (a long random word, only you and the ntfy app know it) to switch alerts on;
// without it every call here quietly does nothing.

import { sb } from './_sb.js';

export const NAMES = { claude: 'Claude', gpt: 'GPT', gemini: 'Gemini', judge: 'Judge' };

// The topic from the environment, tolerating stray spaces / line breaks / quotes from a paste; null if unusable.
function topicOf() {
  const t = String(process.env.NTFY_TOPIC || '').trim().replace(/^["']+|["']+$/g, '').trim();
  return /^[A-Za-z0-9_-]{16,64}$/.test(t) ? t : null;
}

async function sendNtfy(topic, title, message, high) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 5000);
  try {
    return await fetch(`https://ntfy.sh/${topic}`, {
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
  } finally {
    clearTimeout(timer);
  }
}

// Sends one alert, at most once per `key` (recorded in push_log). Never throws.
export async function pushOnce(key, title, message, { high = false } = {}) {
  const topic = topicOf();
  if (!topic) return false;
  try {
    try {
      await sb('push_log', { method: 'POST', body: { key } });
    } catch (e) {
      if (e && e.status === 409) return false;        // already sent
      throw e;
    }
    const r = await sendNtfy(topic, title, message, high);
    if (!r.ok) throw new Error('ntfy ' + r.status);
    return true;
  } catch (e) {
    console.error('push failed:', key, e && e.message);
    try { await sb(`push_log?key=eq.${encodeURIComponent(key)}`, { method: 'DELETE' }); } catch { /* retry next time is best effort */ }
    return false;
  }
}

// For the "Send a test alert" link: sends a real test alert and says what happened. Never reveals the topic itself.
export async function pushDiagnose() {
  const raw = process.env.NTFY_TOPIC;
  const info = { setting_present: !!raw, setting_length: raw ? String(raw).length : 0, usable: !!topicOf() };
  if (!info.setting_present) { info.problem = 'NTFY_TOPIC is not set on the site. Add it in Vercel and redeploy.'; return info; }
  if (!info.usable) { info.problem = 'NTFY_TOPIC is set but is not a valid topic (16-64 letters, digits, - or _). Check it for typos.'; return info; }
  try {
    const r = await sendNtfy(topicOf(), 'Test from Papyrates', 'Test alert sent from the website. Alerts are set up correctly.', false);
    info.ntfy_status = r.status;
    info.sent = r.ok;
    if (!r.ok) info.problem = 'ntfy.sh refused the message (HTTP ' + r.status + ').';
  } catch (e) {
    info.sent = false;
    info.problem = 'Could not reach ntfy.sh from the site: ' + String((e && e.message) || e).slice(0, 120);
  }
  return info;
}
