// api/_housekeeping.js
// Small jobs that ride along on the Desktop's ~20-second check-in (api/worker/claim.js). Not a route itself.
//   autoJudge - once all three Jims have answered a comparative question that was set to "auto Judge", wait a
//               short delay (so their reports/logs/answers have all saved and synced), then queue the Judge once.
//   alerts    - phone alerts (see _push.js): a Jim finished / failed, all three done, Judge finished.
// Each part is independent and failures are swallowed by the caller, so this can never stop a job being handed out.

import { sb } from './_sb.js';
import { pushOnce, NAMES } from './_push.js';

export const JUDGE_DELAY_MS = 10 * 60 * 1000;
const ALERT_LOOKBACK_MS = 60 * 60 * 1000;
const ALERT_SETTLE_MS = 60 * 1000;       // wait a minute after an answer is logged so its suggestions are in too
const MODELS = ['claude', 'gpt', 'gemini'];
const iso = (ms) => encodeURIComponent(new Date(ms).toISOString());

export async function housekeeping(now) {
  try { await autoJudge(now); } catch (e) { console.error('autoJudge:', e && e.message); }
  try { await alerts(now); } catch (e) { console.error('alerts:', e && e.message); }
}

async function autoJudge(now) {
  const rows = await sb('comparative_auto_judge?judge_queued_at=is.null&select=question_id&limit=20') || [];
  for (const r of rows) {
    const q = r.question_id;
    const answers = await sb(`comparative_answers?comparative_question_id=eq.${q}&select=ai_model,answered_at`) || [];
    const have = new Set(answers.map((a) => a.ai_model));
    if (!MODELS.every((m) => have.has(m))) continue;
    const latest = Math.max(...answers.map((a) => new Date(a.answered_at).getTime()));
    if (now.getTime() - latest < JUDGE_DELAY_MS) continue;

    const done = await sb(`comparative_evaluations?comparative_question_id=eq.${q}&select=id&limit=1`) || [];
    const open = await sb(`jim_jobs?kind=eq.evaluate&question_id=eq.${q}&status=in.(queued,claimed,launched)&select=id&limit=1`) || [];
    if (!done.length && !open.length) {
      await sb('jim_jobs', { method: 'POST', body: { kind: 'evaluate', model: 'judge', question_id: q, requested_by: 'auto' } });
    }
    await sb(`comparative_auto_judge?question_id=eq.${q}`, { method: 'PATCH', body: { judge_queued_at: now.toISOString() } });
  }
}

async function alerts(now) {
  if (!process.env.NTFY_TOPIC) return;
  const t = now.getTime();
  const since = iso(t - ALERT_LOOKBACK_MS), settled = iso(t - ALERT_SETTLE_MS);

  // an everyday question answered by one Jim
  const rr = await sb(`research_results?answered_at=gte.${since}&answered_at=lt.${settled}&select=request_id,ai_model`) || [];
  for (const a of rr) {
    const pend = await sb(`pending_proposals?request_id=eq.${a.request_id}&ai_model=eq.${a.ai_model}&status=eq.pending&select=id`) || [];
    const n = pend.length;
    await pushOnce(`result:${a.request_id}:${a.ai_model}`, `${NAMES[a.ai_model]} finished`,
      `${NAMES[a.ai_model]} finished Question ${a.request_id}.` + (n ? ` ${n} suggestion${n === 1 ? '' : 's'} to review.` : ''));
  }

  // a comparative question answered by one Jim (and, when all three are in, a heads-up about the Judge)
  const ca = await sb(`comparative_answers?answered_at=gte.${since}&answered_at=lt.${settled}&select=comparative_question_id,ai_model`) || [];
  const qs = new Set();
  for (const a of ca) {
    qs.add(a.comparative_question_id);
    const pend = await sb(`pending_proposals?question_id=eq.${a.comparative_question_id}&ai_model=eq.${a.ai_model}&status=eq.pending&select=id`) || [];
    const n = pend.length;
    await pushOnce(`answer:${a.comparative_question_id}:${a.ai_model}`, `${NAMES[a.ai_model]} finished`,
      `${NAMES[a.ai_model]} finished Comparative Question ${a.comparative_question_id}.` + (n ? ` ${n} suggestion${n === 1 ? '' : 's'} to review.` : ''));
  }
  for (const q of qs) {
    const all = await sb(`comparative_answers?comparative_question_id=eq.${q}&select=ai_model`) || [];
    if (!MODELS.every((m) => all.some((a) => a.ai_model === m))) continue;
    const auto = await sb(`comparative_auto_judge?question_id=eq.${q}&judge_queued_at=is.null&select=question_id`) || [];
    await pushOnce(`all3:${q}`, 'All three answered',
      auto.length ? `All three Jims answered Comparative Question ${q}. The Judge will start in about 10 minutes.`
                  : `All three Jims answered Comparative Question ${q}. You can start the Judge from the Comparative page.`);
  }

  // the Judge finishing
  const ev = await sb(`comparative_evaluations?evaluated_at=gte.${since}&select=id,comparative_question_id`) || [];
  for (const e of ev) {
    await pushOnce(`judge:${e.id}`, 'Judge finished', `The Judge finished Comparative Question ${e.comparative_question_id}.`);
  }

  // anything that could not start
  const failed = await sb(`jim_jobs?status=eq.failed&claimed_at=gte.${since}&select=id,model,kind,question_id,request_id`) || [];
  for (const j of failed) {
    const label = j.request_id ? `Question ${j.request_id}` : `Comparative Question ${j.question_id}`;
    await pushOnce(`fail:${j.id}`, 'Something did not start',
      `${NAMES[j.model] || j.model} could not ${j.kind === 'evaluate' ? 'run on' : 'start'} ${label}. Open the Ask page for details.`, { high: true });
  }
}
