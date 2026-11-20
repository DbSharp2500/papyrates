// api/_explorer-chart-build.js
// Turns the rows of the explorer_fragments table (and the cited documents from the letters table) into the data object the
// Explorer Fragment Chart page draws. Not a route (Vercel excludes files starting with "_"); used by api/db-proxy/[...path].js
// for the Admin-only route /api/db-proxy/explorer-chart.
// What the page shows: narratives not held back, custody steps whose display is "show", the owner's stated position, first appearance,
// published scholarly assessments. Rows come in Lying Pen order (the numbering of the Lying Pen list), then the rows that are not on that list.

import { LP_ROWS, LP_ORDER, LP_PIECES, LP_NOTES } from './_explorer-chart-lp.js';

export const COLUMNS = 'id,label,text_identification,identifiers,current_holder,owner_stated_position,published_scholarly_assessments,first_documented_appearance,custody_chain,provenance_stories';

const strip = (s) => (s == null ? null : String(s));
const DOC_RE = /\bDocs?\.?\s*#?\s*(\d{2,5}(?:\s*(?:,|and|&)\s*\d{2,5})*)/gi;

function narrativesFor(r) {
  const ps = r.provenance_stories;
  if (ps && !Array.isArray(ps) && ps.built) {
    return { narratives: ps.narratives || [], none: ps.no_narrative_found, note: ps.no_narrative_note, searched: ps.documents_searched || [], unreadable: ps.unreadable_sources || [] };
  }
  // A row that has not been through the narrative pass yet: nothing to show.
  return { narratives: [], none: true, note: 'No narrative file for this row.', searched: [], unreadable: [] };
}

function lpRank(lp) {
  if (!lp.length) return 1e6;
  const i = LP_ORDER.indexOf(lp[0]);
  return i < 0 ? 1e6 : i;
}

// The ids of the Papyrates documents ("Doc 3567") cited anywhere in the shown data, so the page can link them.
export function docIdsOf(data) {
  const ids = new Set();
  const scan = (s) => { if (typeof s !== 'string') return; for (const m of s.matchAll(DOC_RE)) for (const n of m[1].matchAll(/\d{2,5}/g)) ids.add(Number(n[0])); };
  for (const r of data.rows) {
    for (const n of r.narratives) for (const s of n.sources || []) { scan(s.doc); scan(s.locator); }
    for (const c of r.custody) for (const s of c.sources || []) scan(typeof s === 'string' ? s : s && s.doc);
    for (const s of r.first.shown || []) scan(s.source);
    scan(r.owner.source);
  }
  return [...ids].sort((a, b) => a - b);
}

export function buildChartData(live, docRows = []) {
  const rows = live.map((r) => {
    const nv = narrativesFor(r);
    const shown = nv.narratives.filter((n) => n.display !== 'hold back');
    const held = nv.narratives.length - shown.length;
    const o = r.owner_stated_position || {};
    const f = r.first_documented_appearance || {};
    const sch = r.published_scholarly_assessments || {};
    const steps = (r.custody_chain || []).filter((s) => s.verification?.display === 'show');
    const omitted = (r.custody_chain || []).length - steps.length;
    const lp = LP_ROWS[String(r.id)] || [];
    return {
      id: Number(r.id), lp, lp_pieces: LP_PIECES[String(r.id)] || null, lp_note: LP_NOTES[String(r.id)] || null, label: r.label, text_id: strip(r.text_identification),
      identifiers: Array.isArray(r.identifiers) ? r.identifiers : (r.identifiers ? [String(r.identifiers)] : []),
      holder: strip(r.current_holder),
      owner: { display: o.display ?? null, position: o.position ?? null, owner: o.owner ?? null, speaker: o.speaker ?? null, quote: o.quote ?? null, source: o.source ?? null, scope: o.scope ?? null, date: o.statement_date ?? null },
      scholars: (sch.assessments || []).map((a) => ({ scholars: a.scholars ?? null, affiliation: a.affiliation ?? null, year: a.year ?? null, work: a.work ?? null, conclusion: a.conclusion ?? null, quote: a.quote ?? null })),
      first: { display: f.display ?? null, shown: (f.shown || []).map((s) => ({ what: s.what, grade: s.grade, date: s.date_iso, source: s.source, quote: s.quote })) },
      narratives: shown.map((n) => ({ id: n.id, told_by: n.told_by, role: n.told_by_role, date: n.date, date_basis: n.date_basis, identity: n.identity, identity_note: n.identity_note, story: n.story, sources: n.sources, differs_from: n.differs_from, status: n.verification?.status, caution: n.display === 'show with caution' })),
      narratives_held: held, no_narrative: !!nv.none && !shown.length, no_narrative_note: nv.note || null, searched: nv.searched, unreadable: nv.unreadable,
      custody: steps.map((s) => ({ holder: s.holder ?? null, from: s.from ?? null, to: s.to ?? null, how: s.how, sources: s.sources || [], level: s.evidence_level ?? null })), custody_omitted: omitted,
    };
  });
  // Lying Pen order first, then the rows that are not on that list (by row number)
  rows.sort((a, b) => (lpRank(a.lp) - lpRank(b.lp)) || (a.id - b.id));
  const nNarr = rows.reduce((a, r) => a + r.narratives.length, 0);
  const nHeld = rows.reduce((a, r) => a + r.narratives_held, 0);
  const nCaution = rows.reduce((a, r) => a + r.narratives.filter((n) => n.caution).length, 0);
  const nSteps = rows.reduce((a, r) => a + r.custody.length, 0);
  const data = {
    built: new Date().toISOString().slice(0, 10),
    counts: { fragments: rows.length, narratives: nNarr, caution: nCaution, held: nHeld, custody_steps: nSteps, narrative_source: 'table', on_lp_list: rows.filter((r) => r.lp.length).length, lp_entries: LP_ORDER.length },
    lp_order: LP_ORDER,
    rows,
    docs: {},
  };
  // Cited documents: id -> {t: title, u: link to the original document (or null)}
  for (const d of docRows || []) data.docs[d.id] = { t: String(d.title || '').slice(0, 160), u: d.sharing_link && String(d.sharing_link).trim() ? String(d.sharing_link).trim() : null };
  return data;
}
