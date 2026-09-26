// api/_state.js
// One Jim's state for one question, shared by the Ask page (api/ask.js) and the Comparative Research Questions page
// (api/comparative-status.js) so both show exactly the same thing. Not a route (Vercel excludes files starting with "_").
//
//   ans  - the Jim's answer row (or null)
//   jobs - that Jim's jobs for this question, oldest first
//   -> { state: 'done', report } | { state: 'none' } | { state: 'waiting', job_id }
//      | { state: 'working', minutes } | { state: 'limit', retry_minutes } | { state: 'failed', error } | { state: 'cancelled' }

import { keyFromPath } from './_reports.js';

// A Jim whose account hit a spend / usage limit is put back in the queue and retried every RETRY_MS until it works.
export const RETRY_MS = 30 * 60 * 1000;
// A stopped Codex session's id is kept in the job's error_text as "[session <uuid>]" so the retry can RESUME it.
const SESSION_RE = /\s*\[session ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\]/i;
export const sessionOf = (text) => { const m = SESSION_RE.exec(String(text || '')); return m ? m[1].toLowerCase() : null; };
export const withoutSession = (text) => String(text || '').replace(SESSION_RE, '');
export const LIMIT_RE = /spend cap|usage limit|usage_limit|rate limit|limit reached|quota|out of credits/i;

export function modelState(ans, jobs, now) {
  if (ans) return { state: 'done', report: keyFromPath(ans.output_file_url) };
  const job = jobs.length ? jobs[jobs.length - 1] : null;             // newest attempt wins
  if (!job) return { state: 'none' };
  if (job.status === 'queued') {
    // put back in the queue because the account hit a limit: shown as waiting for the limit to reset, with the next try
    if (job.error_text && LIMIT_RE.test(job.error_text) && job.claimed_at) {
      const left = Math.max(0, Math.ceil((RETRY_MS - (now - new Date(job.claimed_at).getTime())) / 60000));
      return { state: 'limit', job_id: job.id, retry_minutes: left };
    }
    return { state: 'waiting', job_id: job.id };
  }
  if (job.status === 'claimed' || job.status === 'launched') {
    const mins = job.launched_at ? Math.max(0, Math.round((now - new Date(job.launched_at).getTime()) / 60000)) : 0;
    return { state: 'working', minutes: mins };
  }
  if (job.status === 'failed') return { state: 'failed', error: withoutSession(job.error_text) || 'unknown problem' };
  return { state: 'cancelled' };
}
