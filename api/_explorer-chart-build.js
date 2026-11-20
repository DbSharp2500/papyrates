// api/_explorer-chart-build.js
// Turns the rows of the explorer_fragments table into the data object the Explorer Fragment Chart page draws.
// Not a route (Vercel excludes files starting with "_"); imported by api/explorer-chart.js, which only serves it to the Admin tier.
// This is the same transformation as build-chart-page.mjs in the explorer-2 tooling (table branch), so the live page and the
// offline page agree. What the page shows: narratives not held back, custody steps whose display is "show", the owner's
// stated position, first appearance, published scholarly assessments. No culpability labels, no links to documents.

export const COLUMNS = 'id,label,text_identification,identifiers,current_holder,owner_stated_position,published_scholarly_assessments,first_documented_appearance,custody_chain,provenance_stories';

const strip = (s) => (s == null ? null : String(s));

function narrativesFor(r) {
  const ps = r.provenance_stories;
  if (ps && !Array.isArray(ps) && ps.built) {
    return { narratives: ps.narratives || [], none: ps.no_narrative_found, note: ps.no_narrative_note, searched: ps.documents_searched || [], unreadable: ps.unreadable_sources || [] };
  }
  // A row that has not been through the narrative pass yet: nothing to show.
  return { narratives: [], none: true, note: 'No narrative file for this row.', searched: [], unreadable: [] };
}

export function buildChartData(live) {
  const rows = live.map((r) => {
    const nv = narrativesFor(r);
    const shown = nv.narratives.filter((n) => n.display !== 'hold back');
    const held = nv.narratives.length - shown.length;
    const o = r.owner_stated_position || {};
    const f = r.first_documented_appearance || {};
    const sch = r.published_scholarly_assessments || {};
    const steps = (r.custody_chain || []).filter((s) => s.verification?.display === 'show');
    const omitted = (r.custody_chain || []).length - steps.length;
    return {
      id: Number(r.id), label: r.label, text_id: strip(r.text_identification),
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
  const nNarr = rows.reduce((a, r) => a + r.narratives.length, 0);
  const nHeld = rows.reduce((a, r) => a + r.narratives_held, 0);
  const nCaution = rows.reduce((a, r) => a + r.narratives.filter((n) => n.caution).length, 0);
  const nSteps = rows.reduce((a, r) => a + r.custody.length, 0);
  return {
    built: new Date().toISOString().slice(0, 10),
    counts: { fragments: rows.length, narratives: nNarr, caution: nCaution, held: nHeld, custody_steps: nSteps, narrative_source: 'table' },
    rows,
  };
}
