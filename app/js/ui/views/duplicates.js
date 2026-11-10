import { el, icon, toast, plural, formatNumber, paginate, pager } from '../dom.js';
import { findDuplicates } from '../../core/duplicates.js';
import { buildPlan } from '../../core/plan.js';
import { dupGroupCard } from './organizer.js';

const PER_PAGE = 25;

export function renderDuplicates(view, ctx) {
  const { state } = ctx;
  const index = state.index;
  if (!index) { view.append(el('div', { class: 'glass card empty', text: 'Your Drive has not been scanned yet.' })); return; }
  const u = state.dupUi || (state.dupUi = { conf: 'all', page: 1, selected: new Set(), scannedAt: null, groups: null });
  if (!u.groups || u.scannedAt !== index.scannedAt) {
    u.groups = findDuplicates(index.myDriveItems());
    u.scannedAt = index.scannedAt;
    u.selected = new Set();
  }
  const draw = () => { view.replaceChildren(); renderDuplicates(view, ctx); };
  const groups = u.groups.filter((g) => u.conf === 'all' || g.confidence === u.conf);
  const { slice, page, pages } = paginate(groups, u.page, PER_PAGE);
  const counts = { exact: 0, likely: 0, possible: 0 };
  for (const g of u.groups) counts[g.confidence]++;

  view.append(el('div', { class: 'page-head' },
    el('div', {}, el('h1', { text: 'Duplicate Finder' }),
      el('p', { class: 'muted', text: 'Compares content checksums, file sizes, types and names. Duplicates are never deleted — you decide what to do.' })),
    el('button', { class: 'btn', onclick: () => ctx.rescan() }, icon('refresh', 16), 'Scan again')));

  view.append(el('div', { class: 'summary-chips' },
    chip(counts.exact, 'exact matches (same content)'), chip(counts.likely, 'likely (same name & size)'), chip(counts.possible, 'possible (same name)')));

  const moveBtn = el('button', { class: 'btn primary', disabled: !u.selected.size, onclick: () => gatherSelected(ctx, u) },
    icon('folder', 16), `Move ${u.selected.size || ''} selected to “Duplicates Review” (preview first)`);
  view.append(el('div', { class: 'toolbar' },
    el('select', { 'aria-label': 'Confidence filter', onchange: (e) => { u.conf = e.target.value; u.page = 1; draw(); } },
      [['all', 'All groups'], ['exact', 'Exact matches'], ['likely', 'Likely'], ['possible', 'Possible']].map(([v, t]) => el('option', { value: v, text: t, selected: u.conf === v }))),
    el('button', { class: 'btn sm', onclick: () => {
      // Select every copy except the oldest file of each exact group (keeps one original in place).
      for (const g of u.groups.filter((x) => x.confidence === 'exact')) {
        const sorted = g.fileIds.map((id) => index.get(id)).filter(Boolean).sort((a, b) => String(a.createdTime).localeCompare(String(b.createdTime)));
        sorted.slice(1).forEach((f) => u.selected.add(f.id));
      }
      draw();
    } }, 'Select extra copies in exact groups'),
    u.selected.size ? el('button', { class: 'btn sm ghost', onclick: () => { u.selected.clear(); draw(); } }, 'Clear selection') : null,
    moveBtn));

  if (!groups.length) {
    view.append(el('div', { class: 'glass card empty' }, icon('check', 34), el('p', { text: 'No duplicates found.' })));
    return;
  }
  view.append(el('div', { class: 'stack' }, slice.map((g) => dupGroupCard(ctx, g, {
    selectable: true, selected: u.selected,
    onSelect: (id, on) => { if (on) u.selected.add(id); else u.selected.delete(id); moveBtn.disabled = !u.selected.size; moveBtn.lastChild.textContent = `Move ${u.selected.size || ''} selected to “Duplicates Review” (preview first)`; },
  }))));
  view.append(pager({ page, pages, total: groups.length, onPage: (p) => { u.page = p; draw(); } }));
}

function chip(n, label) {
  return el('div', { class: 'sum' }, el('b', { text: formatNumber(n) }), el('span', { text: label }));
}

function gatherSelected(ctx, u) {
  const { state } = ctx;
  if (state.plan && ['draft', 'paused'].includes(state.plan.status)) {
    toast('Finish or cancel the plan currently open in AI Organizer first.', 'warn');
    return;
  }
  const ids = [...u.selected];
  const proposals = {
    moves: ids.map((id) => ({ fileId: id, destination: 'Duplicates Review', reason: 'You selected this as a possible duplicate', confidence: 'high' })),
    notes: ['Duplicates are only moved into a review folder so you can compare them. Nothing is deleted.'],
  };
  const plan = buildPlan(state.index, proposals, {
    settings: state.settings, instruction: `Gather ${plural(ids.length, 'selected duplicate')} into “Duplicates Review”`, source: 'duplicates',
    duplicates: u.groups.filter((g) => g.fileIds.some((id) => u.selected.has(id))),
  });
  plan.scopeCount = ids.length;
  plan.scope = { type: 'all' };
  state.plan = plan;
  ctx.savePlan(plan);
  Object.assign(state.organizerUi, { stage: 'preview', tab: 'changes', filter: 'all', page: 1 });
  ctx.navigate('organizer');
}
