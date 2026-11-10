import { el, icon, toast, modal, fileIcon, formatNumber, plural, paginate, pager, driveLink, statusBadge, switchInput } from '../dom.js';
import { isFolder } from '../../core/driveIndex.js';
import { extractSnippets } from '../../core/content.js';
import { planWithAI } from '../../core/ai.js';
import { planWithRules } from '../../core/rules.js';
import { buildPlan, planSummary, foldersNeeded, PreviewModel } from '../../core/plan.js';
import { findDuplicates } from '../../core/duplicates.js';
import { executePlan } from '../../core/executor.js';
import { displayPath } from '../../core/paths.js';
import { renderTree } from '../tree.js';

const EXAMPLES = [
  'Organize my Google Drive. Put all my school assignments into folders by subject. Separate English, Math, Science, History, Spanish, and other subjects. Within each subject, organize files by school year. Put PDFs in their appropriate subject folders. Find duplicates and show them to me before doing anything with them. Don\'t delete anything.',
  'Organize everything by school subject.',
  'Create a folder for every class and put the relevant assignments inside.',
  'Organize all my robotics files into folders for FLL seasons, projects, presentations, and research.',
  'Move all PDFs into folders based on what subject they belong to.',
  'Find all files that look like duplicates.',
  'Find files I haven\'t opened in a long time and show me which ones might be unnecessary.',
];

const PER_PAGE = 100;

function ui(ctx) {
  const s = ctx.state.organizerUi;
  if (!s.stage) Object.assign(s, { stage: ctx.state.plan ? 'preview' : 'compose' });
  if (s.instruction === undefined) s.instruction = '';
  if (!s.scope) s.scope = { type: 'all', folderId: '' };
  if (s.useAI === undefined) s.useAI = ctx.state.settings.useAI && !!ctx.backendUrl;
  if (s.readContents === undefined) s.readContents = ctx.state.settings.readContents;
  if (!s.tab) s.tab = 'tree';
  if (!s.filter) s.filter = 'all';
  if (s.page === undefined) s.page = 1;
  if (s.changedOnly === undefined) s.changedOnly = true;
  return s;
}

export function renderOrganizer(view, ctx) {
  const u = ui(ctx);
  if (!ctx.state.index) {
    view.append(el('div', { class: 'glass card empty' }, el('p', { text: 'Your Drive has not been scanned yet.' }),
      el('button', { class: 'btn primary', style: { marginTop: '12px' }, onclick: () => ctx.rescan() }, 'Scan my Drive')));
    return;
  }
  if (ctx.state.plan && u.stage === 'compose') u.stage = 'preview';
  view.append(el('div', { class: 'page-head' },
    el('div', {}, el('h1', { text: 'AI Organizer' }),
      el('p', { class: 'muted', text: 'Describe it. Preview it. Approve it. Nothing changes in your Drive before step 3.' }))));
  view.append(stepper(u.stage));
  const body = el('div');
  view.append(body);
  const draw = () => {
    body.replaceChildren();
    if (u.stage === 'compose') body.append(composeStage(ctx, u, draw));
    else if (u.stage === 'analyzing') body.append(analyzingStage(ctx, u));
    else if (u.stage === 'preview' && ctx.state.plan) body.append(previewStage(ctx, u, draw));
    else if (u.stage === 'running') body.append(runningStage(ctx, u));
    else if (u.stage === 'done') body.append(doneStage(ctx, u, draw));
    else { u.stage = 'compose'; body.append(composeStage(ctx, u, draw)); }
  };
  u.redraw = () => { if (ctx.state.route === 'organizer' && document.body.contains(body)) { view.replaceChildren(); renderOrganizer(view, ctx); } };
  draw();
}

function stepper(stage) {
  const order = ['compose', 'analyzing', 'preview', 'running', 'done'];
  const idx = order.indexOf(stage);
  const steps = [['Describe', 0], ['Analyze', 1], ['Preview & approve', 2], ['Organize', 3]];
  return el('div', { class: 'steps', 'aria-label': 'Progress' }, steps.map(([label, i], n) =>
    el('div', { class: `step ${idx === i || (i === 3 && idx === 4) ? 'active' : ''} ${idx > i && !(i === 3 && idx === 4) ? 'done' : ''} ${i === 3 && idx === 4 ? 'done' : ''}` },
      el('b', { text: String(n + 1) }), label)));
}

// ---------------- Stage 1: describe ----------------

function scopeItems(ctx, scope) {
  const index = ctx.state.index;
  if (scope.type === 'root') return index.childrenOf(index.rootId);
  if (scope.type === 'folder' && scope.folderId && index.get(scope.folderId)) return index.descendantsOf(scope.folderId);
  return index.myDriveItems();
}

function composeStage(ctx, u, draw) {
  const { settings } = ctx.state;
  const index = ctx.state.index;
  const ta = el('textarea', { class: 'prompt-box', placeholder: 'e.g. Put all my school assignments into folders by subject, then by school year. Leave my Photos folder alone.',
    'aria-label': 'Organization instructions', maxlength: '4000', oninput: (e) => { u.instruction = e.target.value; } });
  ta.value = u.instruction;

  const folderOptions = index.folderPaths(3000).map((p) => [index.resolvePath(p).folderId, p]).filter(([id]) => id);
  const folderSelect = el('select', { 'aria-label': 'Folder to organize', onchange: (e) => { u.scope.folderId = e.target.value; } },
    el('option', { value: '', text: 'Choose a folder…' }),
    folderOptions.slice(0, 2000).map(([id, p]) => el('option', { value: id, text: `My Drive/${p}`, selected: u.scope.folderId === id })));
  folderSelect.classList.toggle('hidden', u.scope.type !== 'folder');
  const scopeSelect = el('select', { 'aria-label': 'What to organize', onchange: (e) => { u.scope.type = e.target.value; folderSelect.classList.toggle('hidden', u.scope.type !== 'folder'); } },
    [['all', 'Everything in My Drive'], ['root', 'Only items at the top level of My Drive'], ['folder', 'Only inside one folder…']]
      .map(([v, t]) => el('option', { value: v, text: t, selected: u.scope.type === v })));

  const aiAvailable = !!ctx.backendUrl;
  const modeNote = aiAvailable
    ? (u.useAI ? 'AI mode: understands complex instructions and reads document contents.' : 'Basic mode: keyword rules on names, types, dates and contents. No data leaves your browser except to Google.')
    : 'Basic mode (no AI backend configured — add one in Settings to enable AI).';
  const modeText = el('span', { class: 'faint', text: modeNote });

  const analyzeBtn = el('button', { class: 'btn primary', onclick: () => {
    if (!u.instruction.trim()) { toast('Please describe how you want your Drive organized.', 'warn'); ta.focus(); return; }
    if (u.scope.type === 'folder' && !u.scope.folderId) { toast('Choose the folder to organize.', 'warn'); return; }
    analyze(ctx, u, draw);
  } }, icon('sparkles', 18), 'Analyze & build preview');

  return el('div', { class: 'stack' },
    el('section', { class: 'glass card stack' },
      el('label', { class: 'field' }, el('span', { text: 'How would you like your Drive organized?' }), ta),
      el('div', {}, el('div', { class: 'faint', style: { marginBottom: '8px' }, text: 'Try an example:' }),
        el('div', { class: 'examples' }, EXAMPLES.map((ex) => el('button', { class: 'chip', title: ex, onclick: () => { u.instruction = ex; ta.value = ex; ta.focus(); } },
          ex.length > 60 ? `${ex.slice(0, 57)}…` : ex)))),
      el('div', { class: 'grid two' },
        el('label', { class: 'field' }, el('span', { text: 'What to organize' }), scopeSelect, folderSelect),
        el('div', { class: 'stack', style: { gap: '4px' } },
          el('div', { class: 'switch-row' }, el('div', {}, el('b', { text: 'Use AI' }), el('div', {}, modeText)),
            switchInput({ checked: u.useAI && aiAvailable, label: 'Use AI', onchange: (v) => {
              if (v && !aiAvailable) { toast('Add your AI backend URL in Settings first.', 'warn'); draw(); return; }
              u.useAI = v; draw();
            } })),
          el('div', { class: 'switch-row' }, el('div', {}, el('b', { text: 'Read document contents' }),
            el('div', { class: 'faint', text: 'Reads the start of Docs, Sheets, Slides, PDFs and text files (read-only) for better sorting.' })),
          switchInput({ checked: u.readContents, label: 'Read document contents', onchange: (v) => { u.readContents = v; } })))),
      el('div', { class: 'row between' },
        el('div', { class: 'faint', text: `Your Drive: ${formatNumber(index.stats().files)} files, ${formatNumber(index.stats().folders)} folders. Settings → Safety controls renames, folder moves and conflicts (currently: renames ${settings.allowRenames ? 'allowed if you ask' : 'off'}, conflicts ${settings.conflictPolicy === 'keepBoth' ? 'keep both' : 'skipped'}).` }),
        analyzeBtn)));
}

async function analyze(ctx, u, draw) {
  const { state } = ctx;
  const items = scopeItems(ctx, u.scope);
  if (!items.length) { toast('There is nothing to organize in that scope.', 'warn'); return; }
  const settings = state.settings;
  const useAI = u.useAI && !!ctx.backendUrl;
  if (useAI && items.length > 2500) {
    const go = await modal({ title: 'Large Drive', body: `${formatNumber(items.length)} items will be analyzed in about ${Math.ceil(items.length / settings.aiChunkSize)} AI requests. This can take several minutes. Continue?`,
      actions: [{ label: 'Cancel', value: false }, { label: 'Continue', value: true, kind: 'primary' }] });
    if (!go) return;
  }
  const abort = new AbortController();
  u.abort = abort;
  u.progress = { phase: 'Preparing…', done: 0, total: 0 };
  u.stage = 'analyzing';
  draw();
  const update = (p) => { Object.assign(u.progress, p); u.onProgress?.(); };
  try {
    let snippets = new Map();
    const files = items.filter((it) => !isFolder(it));
    if (u.readContents) {
      update({ phase: 'Reading document contents (read-only)…', done: 0, total: 0 });
      snippets = await extractSnippets(state.client, files, {
        store: state.store, maxChars: settings.snippetChars, maxFiles: settings.maxContentFiles,
        pdfMaxBytes: settings.pdfMaxMB * 1024 * 1024, signal: abort.signal,
        onProgress: ({ done, total }) => update({ done, total }),
      });
    }
    if (abort.signal.aborted) throw new Error('Cancelled');
    let proposals;
    let source = 'rules';
    if (useAI) {
      update({ phase: 'Asking the AI to plan your organization…', done: 0, total: 0 });
      try {
        proposals = await planWithAI({
          backendUrl: ctx.backendUrl, token: await state.auth.getToken(), index: state.index, items, instruction: u.instruction,
          snippets, settings, signal: abort.signal,
          onProgress: ({ chunk, chunks }) => update({ done: chunk - 1, total: chunks, phase: `Asking the AI to plan your organization (batch ${chunk} of ${chunks})…` }),
        });
        source = 'ai';
      } catch (err) {
        if (abort.signal.aborted) throw new Error('Cancelled');
        const fallback = await modal({ title: 'AI is unavailable', body: `${err.message}\n\nYou can continue with basic mode, which uses file names, types, dates and contents with keyword rules.`,
          actions: [{ label: 'Cancel', value: false }, { label: 'Use basic mode', value: true, kind: 'primary' }] });
        if (!fallback) throw new Error('Cancelled');
      }
    }
    if (!proposals) {
      update({ phase: 'Applying basic organization rules…' });
      proposals = planWithRules(state.index, items, u.instruction, snippets);
    }
    update({ phase: 'Validating every proposed change…' });
    const unreadable = [...snippets.values()].filter((s) => s.error).length;
    if (unreadable) proposals.notes = [...(proposals.notes || []), `${unreadable} file(s) could not be read, so only their names and dates were used.`];
    const plan = buildPlan(state.index, proposals, {
      settings, instruction: u.instruction, source,
      scopeIds: new Set(items.map((i) => i.id)),
      duplicates: findDuplicates(items),
    });
    plan.scopeCount = items.filter((i) => !isFolder(i)).length;
    plan.scope = { ...u.scope };
    plan.usage = proposals.usage;
    state.plan = plan;
    await ctx.savePlan(plan);
    Object.assign(u, { stage: 'preview', tab: 'tree', filter: 'all', page: 1 });
  } catch (err) {
    if (err.message !== 'Cancelled') toast(`Analysis failed: ${err.message}`, 'bad', 10000);
    u.stage = 'compose';
  }
  u.abort = null;
  u.onProgress = null;
  u.redraw?.();
}

function analyzingStage(ctx, u) {
  const phase = el('div', { class: 'grow', style: { fontWeight: 600 } });
  const bar = el('i');
  const count = el('div', { class: 'faint' });
  const refresh = () => {
    phase.textContent = u.progress?.phase || 'Working…';
    const { done = 0, total = 0 } = u.progress || {};
    bar.style.width = total ? `${Math.round((done / total) * 100)}%` : '8%';
    count.textContent = total ? `${formatNumber(done)} of ${formatNumber(total)}` : '';
  };
  u.onProgress = refresh;
  refresh();
  return el('section', { class: 'glass progress-box stack' },
    el('div', { class: 'progress-line' }, el('div', { class: 'spinner' }), phase),
    el('div', { class: 'bar' }, bar), count,
    el('p', { class: 'faint', text: 'Analysis only reads your Drive. No files are moved, renamed or created during this step.' }),
    el('div', {}, el('button', { class: 'btn', onclick: () => u.abort?.abort() }, icon('stop', 16), 'Cancel analysis')));
}

// ---------------- Stage 2: preview & approve ----------------

let saveTimer = null;
function savePlanSoon(ctx) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => ctx.savePlan(ctx.state.plan), 400);
}

function previewStage(ctx, u, draw) {
  const { state } = ctx;
  const plan = state.plan;
  const index = state.index;
  const wrap = el('div', { class: 'stack' });
  const summaryHost = el('div');
  const barHost = el('div');

  const refreshSummary = () => {
    const s = planSummary(index, plan, plan.scopeCount);
    summaryHost.replaceChildren(el('div', { class: 'summary-chips' },
      sum(s.moves, 'files to move', 'info'), sum(s.folders, 'folders to create', 'ok'), sum(s.review, 'need review', 'warn'),
      sum(s.renames, 'renames'), sum(s.unchanged, 'unchanged'), sum(s.duplicates, 'duplicate groups'),
      s.conflicts ? sum(s.conflicts, 'name conflicts', 'warn') : null, s.rejected ? sum(s.rejected, 'rejected by safety checks', 'bad') : null));
    barHost.replaceChildren(stickyBar(ctx, u, s, draw));
  };

  const header = el('section', { class: 'glass card stack', style: { gap: '8px' } },
    el('div', { class: 'row between' },
      el('div', { class: 'stack', style: { gap: '4px' } },
        el('h2', { text: plan.status === 'paused' ? 'Paused organization — review and resume' : 'Your organization plan' }),
        el('div', { class: 'faint' }, `Made by ${plan.source === 'ai' ? 'AI' : 'basic mode'} · `, `“${plan.instruction.length > 140 ? `${plan.instruction.slice(0, 137)}…` : plan.instruction}”`)),
      el('span', { class: 'badge info', text: 'Preview only — nothing changed yet' })),
    plan.status === 'paused' ? el('div', { class: 'notice' }, icon('alert'), 'Part of this plan already ran (see History). Only the remaining approved changes will run when you resume.') : null);

  wrap.append(header, summaryHost);
  const tabs = [
    ['tree', 'Before & after'], ['changes', 'All changes', plan.ops.length], ['review', 'Needs review', plan.ops.filter((o) => o.review).length + plan.flagged.filter((f) => f.review).length],
    ['flagged', 'Flagged', plan.flagged.filter((f) => !f.review).length], ['duplicates', 'Duplicates', plan.duplicates.length],
    ['rejected', 'Rejected', plan.rejected.length], ['unchanged', 'Unchanged'], ['notes', 'Notes', (plan.notes.length + plan.warnings.length) || null],
  ];
  const tabBody = el('div');
  const tabBar = el('div', { class: 'tabs', role: 'tablist' }, tabs.map(([id, label, n]) =>
    el('button', { class: `tab ${u.tab === id ? 'active' : ''}`, role: 'tab', 'aria-selected': String(u.tab === id), onclick: () => { u.tab = id; u.page = 1; draw(); } },
      label, n ? el('span', { class: 'badge neutral', text: formatNumber(n) }) : null)));
  wrap.append(tabBar, tabBody, barHost);

  const onToggle = () => { refreshSummary(); savePlanSoon(ctx); };
  if (u.tab === 'tree') tabBody.append(treeTab(ctx, u, draw));
  else if (u.tab === 'changes') tabBody.append(opsTab(ctx, u, plan.ops, onToggle, draw, true));
  else if (u.tab === 'review') tabBody.append(reviewTab(ctx, u, onToggle, draw));
  else if (u.tab === 'flagged') tabBody.append(flaggedTab(ctx, plan.flagged.filter((f) => !f.review), 'Nothing was flagged. Flags are used for things like files you have not opened in a long time; flagged files are never moved.'));
  else if (u.tab === 'duplicates') tabBody.append(dupTab(ctx, plan.duplicates));
  else if (u.tab === 'rejected') tabBody.append(rejectedTab(ctx, u, draw));
  else if (u.tab === 'unchanged') tabBody.append(unchangedTab(ctx, u, draw));
  else if (u.tab === 'notes') tabBody.append(notesTab(plan));
  refreshSummary();
  return wrap;
}

function sum(n, label, kind = '') {
  return el('div', { class: `sum ${kind}` }, el('b', { text: formatNumber(n) }), el('span', { text: label }));
}

function stickyBar(ctx, u, s, draw) {
  const plan = ctx.state.plan;
  const pending = plan.ops.filter((o) => o.approved && o.status === 'pending').length;
  return el('div', { class: 'glass sticky-actions' },
    el('div', { class: 'stack', style: { gap: '2px' } },
      el('b', { text: `${plural(pending, 'change')} approved` }),
      el('span', { class: 'faint', text: `${s.moves} move(s), ${s.review} to Needs Review, ${s.folders} new folder(s), ${s.renames} rename(s). Untick anything you don't want.` })),
    el('div', { class: 'row' },
      el('button', { class: 'btn', onclick: () => cancelPlan(ctx, u, draw) }, icon('x', 16), 'Cancel'),
      el('button', { class: 'btn primary', disabled: !pending, onclick: () => approveAndRun(ctx, u, draw) }, icon('check', 16),
        plan.status === 'paused' ? 'Resume & Organize' : 'Approve & Organize')));
}

async function cancelPlan(ctx, u, draw) {
  const ok = await modal({ title: 'Cancel this plan?', body: 'The preview will be discarded. Nothing in your Drive has been changed.',
    actions: [{ label: 'Keep reviewing', value: false }, { label: 'Discard plan', value: true, kind: 'danger' }] });
  if (!ok) return;
  const plan = ctx.state.plan;
  if (plan.status === 'draft') plan.status = 'cancelled';
  else if (plan.status === 'paused') plan.status = 'completed';
  await ctx.savePlan(plan);
  ctx.state.plan = null;
  u.stage = 'compose';
  toast('Plan discarded. Nothing was changed.', 'info');
  draw();
  u.redraw?.();
}

function treeTab(ctx, u, draw) {
  const model = new PreviewModel(ctx.state.index, ctx.state.plan);
  const legend = el('div', { class: 'row faint small' },
    el('span', { class: 'badge ok', text: 'New folder' }), el('span', { class: 'badge info', text: 'Moved here' }),
    el('span', { class: 'badge warn', text: 'Needs review' }), el('span', { class: 'badge purple', text: 'Renamed' }),
    el('span', { class: 'badge neutral', text: 'Moving away (shown crossed out)' }));
  const toggle = el('label', { class: 'check' }, el('input', { type: 'checkbox', checked: u.changedOnly, onchange: (e) => { u.changedOnly = e.target.checked; draw(); } }),
    'Only show folders with changes');
  return el('div', { class: 'stack' },
    el('div', { class: 'row between' }, legend, toggle),
    el('div', { class: 'trees' },
      el('section', { class: 'glass tree-panel' }, el('h3', { text: 'Before', style: { marginBottom: '8px' } }),
        renderTree(model, 'before', { changedOnly: u.changedOnly })),
      el('section', { class: 'glass tree-panel' }, el('h3', { text: 'After', style: { marginBottom: '8px' } }),
        renderTree(model, 'after', { changedOnly: u.changedOnly }))));
}

function opsTab(ctx, u, ops, onToggle, draw, withFilter) {
  const index = ctx.state.index;
  const filters = { all: () => true, move: (o) => o.type === 'move' && !o.review, review: (o) => o.review, rename: (o) => o.type === 'rename',
    mkdir: (o) => o.type === 'mkdir', conflict: (o) => !!o.conflict, unchecked: (o) => !o.approved, folder: (o) => o.isFolder };
  const q = (u.search || '').toLowerCase();
  const filtered = ops.filter((o) => (withFilter ? (filters[u.filter] || filters.all)(o) : true) &&
    (!q || (o.name || '').toLowerCase().includes(q) || (o.destPath || '').toLowerCase().includes(q) || (o.newName || '').toLowerCase().includes(q)));
  const { slice, page, pages } = paginate(filtered, u.page, PER_PAGE);

  const setAll = (val) => { for (const o of filtered) if (o.status === 'pending') o.approved = val; onToggle(); draw(); };
  const search = el('input', { class: 'input', type: 'search', placeholder: 'Search changes…', value: u.search || '', 'aria-label': 'Search changes',
    onchange: (e) => { u.search = e.target.value; u.page = 1; draw(); } });
  const toolbar = el('div', { class: 'toolbar' }, search,
    withFilter ? el('select', { 'aria-label': 'Filter', onchange: (e) => { u.filter = e.target.value; u.page = 1; draw(); } },
      [['all', 'All changes'], ['move', 'Moves'], ['review', 'Needs review'], ['folder', 'Folder moves'], ['rename', 'Renames'], ['mkdir', 'Empty folders to create'], ['conflict', 'Name conflicts'], ['unchecked', 'Not approved']]
        .map(([v, t]) => el('option', { value: v, text: t, selected: u.filter === v }))) : null,
    el('button', { class: 'btn sm', onclick: () => setAll(true) }, `Approve all ${formatNumber(filtered.length)} shown`),
    el('button', { class: 'btn sm', onclick: () => setAll(false) }, 'Untick all shown'));

  const needed = new Set(foldersNeeded(index, ctx.state.plan).map((p) => p.toLowerCase()));
  const rows = slice.map((o) => {
    const cb = el('input', { type: 'checkbox', checked: o.approved, disabled: o.status !== 'pending', 'aria-label': `Approve change for ${o.name}`,
      onchange: (e) => { o.approved = e.target.checked; onToggle(); } });
    const item = index.get(o.fileId);
    let what;
    if (o.type === 'move') {
      const isNew = !o.destFolderId && needed.has(o.destPath.toLowerCase());
      what = el('div', {}, el('div', { class: 'path', text: `From ${o.fromPath}` }),
        el('div', {}, '→ ', el('b', { text: displayPath(o.destPath) }), isNew ? el('span', { class: 'badge ok', style: { marginLeft: '6px' }, text: 'new folder' }) : null));
    } else if (o.type === 'rename') {
      what = el('div', {}, el('div', { class: 'path', text: `In ${o.fromPath}` }), el('div', {}, 'Rename to ', el('b', { text: o.newName })));
    } else {
      what = el('div', {}, 'Create empty folder ', el('b', { text: displayPath(o.destPath) }));
    }
    const kindBadge = o.review ? el('span', { class: 'badge warn', text: 'Needs review' })
      : o.type === 'rename' ? el('span', { class: 'badge purple', text: 'Rename' })
        : o.type === 'mkdir' ? el('span', { class: 'badge ok', text: 'New folder' })
          : o.isFolder ? el('span', { class: 'badge info', text: 'Move folder' }) : el('span', { class: 'badge info', text: 'Move' });
    return el('tr', {},
      el('td', {}, cb),
      el('td', { class: 'name' }, el('div', { class: 'file-row-name' }, fileIcon(o.type === 'mkdir' ? 'folder' : (item || o.kind)), el('span', { class: 'ellipsis', text: o.name }))),
      el('td', {}, what, o.conflict ? el('div', { class: 'badge warn', style: { marginTop: '6px', whiteSpace: 'normal' }, text: o.conflict }) : null),
      el('td', {}, kindBadge, o.confidence && o.type === 'move' ? el('div', { class: 'faint', style: { marginTop: '4px' }, text: `${o.confidence} confidence` }) : null,
        o.status !== 'pending' ? el('div', { style: { marginTop: '4px' } }, statusBadge(o.status)) : null),
      el('td', { class: 'small muted', text: o.reason || '' }),
      el('td', {}, item ? driveLink(item) : null));
  });
  return el('section', { class: 'glass card' }, toolbar,
    filtered.length ? el('div', { class: 'table-wrap' }, el('table', { class: 'tbl' },
      el('thead', {}, el('tr', {}, ['', 'Item', 'Change', 'Type', 'Why', ''].map((h) => el('th', { text: h })))),
      el('tbody', {}, rows))) : el('div', { class: 'empty', text: 'No changes match.' }),
    pager({ page, pages, total: filtered.length, onPage: (p) => { u.page = p; draw(); } }));
}

function reviewTab(ctx, u, onToggle, draw) {
  const plan = ctx.state.plan;
  const ops = plan.ops.filter((o) => o.review);
  const listOnly = plan.flagged.filter((f) => f.review);
  return el('div', { class: 'stack' },
    el('div', { class: 'notice info' }, icon('info'),
      `The organizer was not sure where these belong, so instead of guessing they go to “${plan.reviewFolder}” (if approved). You can untick any of them to leave them where they are.`),
    ops.length ? opsTab(ctx, u, ops, onToggle, draw, false) : null,
    listOnly.length ? flaggedTab(ctx, listOnly, '') : null,
    !ops.length && !listOnly.length ? el('div', { class: 'glass card empty', text: 'Nothing needs review.' }) : null);
}

function flaggedTab(ctx, flagged, emptyText) {
  const index = ctx.state.index;
  if (!flagged.length) return el('div', { class: 'glass card empty', text: emptyText });
  return el('section', { class: 'glass card' },
    el('p', { class: 'faint', style: { marginBottom: '10px' }, text: 'Flagged items are only listed for you to look at. They are not moved, renamed or deleted.' }),
    el('div', { class: 'table-wrap' }, el('table', { class: 'tbl' },
      el('thead', {}, el('tr', {}, ['Item', 'Location', 'Why', ''].map((h) => el('th', { text: h })))),
      el('tbody', {}, flagged.slice(0, 1000).map((f) => {
        const it = index.get(f.fileId);
        return el('tr', {}, el('td', { class: 'name' }, el('div', { class: 'file-row-name' }, fileIcon(it), el('span', { class: 'ellipsis', text: it?.name || f.fileId }))),
          el('td', { class: 'small muted', text: index.locationOf(f.fileId) }), el('td', { class: 'small', text: f.reason }), el('td', {}, driveLink(it)));
      })))),
    flagged.length > 1000 ? el('p', { class: 'faint', text: `Showing the first 1,000 of ${formatNumber(flagged.length)}.` }) : null);
}

function dupTab(ctx, groups) {
  if (!groups.length) return el('div', { class: 'glass card empty', text: 'No likely duplicates were found among the files in scope.' });
  return el('div', { class: 'stack' },
    el('div', { class: 'notice info' }, icon('info'), 'Possible duplicates are shown for your information only. Nothing is deleted. Use the Duplicate Finder page if you want to gather copies into a review folder.'),
    groups.slice(0, 200).map((g) => dupGroupCard(ctx, g)));
}

export function dupGroupCard(ctx, g, { selectable = false, selected, onSelect } = {}) {
  const index = ctx.state.index;
  const conf = { exact: ['ok', 'Exact match'], likely: ['info', 'Likely'], possible: ['warn', 'Possible'] }[g.confidence];
  return el('section', { class: 'glass dup-group' },
    el('div', { class: 'row between', style: { marginBottom: '8px' } },
      el('div', { class: 'row' }, el('span', { class: `badge ${conf[0]}`, text: conf[1] }), el('span', { class: 'faint', text: g.reason })),
      el('span', { class: 'faint', text: plural(g.fileIds.length, 'file') })),
    el('table', { class: 'tbl' }, el('tbody', {}, g.fileIds.map((id) => {
      const it = index.get(id);
      if (!it) return null;
      return el('tr', {},
        selectable ? el('td', { style: { width: '30px' } }, el('input', { type: 'checkbox', checked: selected?.has(id), 'aria-label': `Select ${it.name}`, onchange: (e) => onSelect(id, e.target.checked) })) : null,
        el('td', { class: 'name' }, el('div', { class: 'file-row-name' }, fileIcon(it), el('span', { class: 'ellipsis', text: it.name }))),
        el('td', { class: 'small muted', text: index.locationOf(id) }),
        el('td', { class: 'small muted', text: it.size ? `${Math.round(Number(it.size) / 1024).toLocaleString()} KB` : '' }),
        el('td', { class: 'small muted', text: it.modifiedTime ? `Modified ${new Date(it.modifiedTime).toLocaleDateString()}` : '' }),
        el('td', {}, driveLink(it)));
    }))));
}

function rejectedTab(ctx, u, draw) {
  const plan = ctx.state.plan;
  if (!plan.rejected.length) return el('div', { class: 'glass card empty', text: 'No proposed changes were rejected by the safety checks.' });
  const { slice, page, pages } = paginate(plan.rejected, u.page, PER_PAGE);
  return el('section', { class: 'glass card' },
    el('p', { class: 'faint', style: { marginBottom: '10px' }, text: 'These proposals failed validation and will NOT be carried out.' }),
    el('div', { class: 'table-wrap' }, el('table', { class: 'tbl' },
      el('thead', {}, el('tr', {}, ['Item', 'Reason'].map((h) => el('th', { text: h })))),
      el('tbody', {}, slice.map((r) => el('tr', {}, el('td', { class: 'name', text: r.name }), el('td', { class: 'small', text: r.reason })))))),
    pager({ page, pages, total: plan.rejected.length, onPage: (p) => { u.page = p; draw(); } }));
}

function unchangedTab(ctx, u, draw) {
  const plan = ctx.state.plan;
  const index = ctx.state.index;
  const moving = new Set(plan.ops.filter((o) => o.type === 'move' && o.approved).map((o) => o.fileId));
  const all = scopeItems(ctx, plan.scope || { type: 'all' }).filter((it) => !isFolder(it) && !moving.has(it.id));
  const { slice, page, pages } = paginate(all, u.page, PER_PAGE);
  return el('section', { class: 'glass card' },
    el('p', { class: 'faint', style: { marginBottom: '10px' }, text: 'These files stay exactly where they are.' }),
    el('div', { class: 'table-wrap' }, el('table', { class: 'tbl' },
      el('tbody', {}, slice.map((it) => el('tr', {},
        el('td', { class: 'name' }, el('div', { class: 'file-row-name' }, fileIcon(it), el('span', { class: 'ellipsis', text: it.name }))),
        el('td', { class: 'small muted', text: index.locationOf(it.id) }), el('td', {}, driveLink(it))))))),
    pager({ page, pages, total: all.length, onPage: (p) => { u.page = p; draw(); } }));
}

function notesTab(plan) {
  const notes = [...new Set(plan.notes)];
  const items = [...plan.warnings.map((w) => ['warn', w]), ...notes.map((n) => ['info', n])];
  if (plan.usage?.input) items.push(['info', `AI usage for this plan: ${formatNumber(plan.usage.input)} input and ${formatNumber(plan.usage.output)} output tokens.`]);
  if (!items.length) return el('div', { class: 'glass card empty', text: 'No notes.' });
  return el('div', { class: 'stack' }, items.slice(0, 300).map(([k, t]) => el('div', { class: `notice ${k === 'warn' ? '' : 'info'}` }, icon(k === 'warn' ? 'alert' : 'info'), el('div', { text: t }))));
}

// ---------------- Stage 3: run ----------------

async function approveAndRun(ctx, u, draw) {
  const { state } = ctx;
  const plan = state.plan;
  const s = planSummary(state.index, plan, plan.scopeCount);
  const body = el('div', { class: 'stack' },
    el('p', { text: 'These changes will now be made in your Google Drive:' }),
    el('ul', {}, [
      s.folders ? el('li', { text: `Create ${plural(s.folders, 'folder')}` }) : null,
      s.moves ? el('li', { text: `Move ${plural(s.moves, 'item')}` }) : null,
      s.review ? el('li', { text: `Move ${plural(s.review, 'uncertain item')} to “${plan.reviewFolder}”` }) : null,
      s.renames ? el('li', { text: `Rename ${plural(s.renames, 'item')}` }) : null,
    ]),
    el('div', { class: 'notice ok' }, icon('shield'), 'Nothing will be deleted, overwritten, shared or edited. Every change is recorded in Organization History and can be undone.'));
  const ok = await modal({ title: plan.status === 'paused' ? 'Resume organizing?' : 'Approve and organize?', body,
    actions: [{ label: 'Go back', value: false }, { label: 'Organize now', value: true, kind: 'primary' }] });
  if (!ok) return;
  if (!(await ctx.ensureFreshToken(25))) return;

  const abort = new AbortController();
  u.runAbort = abort;
  u.runProgress = { done: 0, total: 0, label: 'Starting…', counts: {} };
  u.stage = 'running';
  state.busy = true;
  draw();
  let run;
  try {
    run = await executePlan({
      client: state.client, index: state.index, plan, history: state.history, savePlan: ctx.savePlan,
      conflictPolicy: state.settings.conflictPolicy, signal: abort.signal,
      onProgress: (p) => { u.runProgress = p; u.onRunProgress?.(); },
    });
  } catch (err) {
    toast(`Could not run the plan: ${err.message}`, 'bad', 10000);
    state.busy = false;
    u.stage = 'preview';
    u.redraw?.();
    return;
  }
  state.busy = false;
  u.lastRun = run;
  u.lastPlan = plan;
  if (plan.status === 'completed') state.plan = null;
  u.stage = 'done';
  await ctx.backupHistory();
  toast(run.status === 'completed' ? 'Your Drive has been organized.' : `Finished: ${run.counts.success} succeeded, ${run.counts.failed} failed, ${run.counts.skipped} skipped.`,
    run.status === 'completed' ? 'ok' : 'warn', 8000);
  await ctx.rescan(); // refresh the index so other pages show the new layout
  u.redraw?.();
}

function runningStage(ctx, u) {
  const label = el('div', { class: 'grow ellipsis', style: { fontWeight: 600 } });
  const bar = el('i');
  const counts = el('div', { class: 'faint' });
  const refresh = () => {
    const p = u.runProgress || {};
    label.textContent = p.label ? `Working on: ${p.label}` : 'Starting…';
    bar.style.width = p.total ? `${Math.round((p.done / p.total) * 100)}%` : '4%';
    const c = p.counts || {};
    counts.textContent = `${formatNumber(p.done || 0)} of ${formatNumber(p.total || 0)} · ${c.success || 0} succeeded · ${c.failed || 0} failed · ${c.skipped || 0} skipped`;
  };
  u.onRunProgress = refresh;
  refresh();
  const stopBtn = el('button', { class: 'btn', onclick: () => { u.runAbort?.abort(); stopBtn.disabled = true; stopBtn.textContent = 'Stopping after the current item…'; } }, icon('stop', 16), 'Stop');
  return el('section', { class: 'glass progress-box stack' },
    el('div', { class: 'progress-line' }, el('div', { class: 'spinner' }), label),
    el('div', { class: 'bar' }, bar), counts,
    el('p', { class: 'faint', text: 'Please keep this tab open. Each file is checked again right before it is moved; anything that changed since the preview is skipped, not forced.' }),
    el('div', {}, stopBtn));
}

function doneStage(ctx, u, draw) {
  const run = u.lastRun;
  const wrap = el('div', { class: 'stack' });
  if (!run) { u.stage = 'compose'; draw(); return wrap; }
  const c = run.counts || {};
  const paused = run.status === 'paused';
  wrap.append(el('section', { class: 'glass card stack' },
    el('div', { class: 'row between' },
      el('h2', { text: paused ? 'Organizing paused' : run.status === 'stopped' ? 'Organizing stopped' : 'Organizing finished' }), statusBadge(run.status)),
    run.error ? el('div', { class: 'notice' }, icon('alert'), run.error) : null,
    el('div', { class: 'summary-chips' }, sum(c.success || 0, 'succeeded', 'ok'), sum(c.failed || 0, 'failed', 'bad'), sum(c.skipped || 0, 'skipped', 'warn'), sum(c.cancelled || 0, 'not run')),
    el('div', { class: 'row' },
      paused && ctx.state.plan ? el('button', { class: 'btn primary', onclick: () => { u.stage = 'preview'; draw(); } }, icon('play', 16), 'Review & resume') : null,
      el('button', { class: 'btn', onclick: () => { ctx.state.organizerUi.historyRun = run.runId; ctx.navigate('history'); } }, icon('history', 16), 'See details / undo in History'),
      el('button', { class: 'btn', onclick: () => { u.stage = 'compose'; u.lastRun = null; if (!paused) ctx.state.plan = null; draw(); } }, icon('sparkles', 16), 'Organize something else'))));
  const issues = el('div');
  wrap.append(issues);
  ctx.state.history.entriesForRun(run.runId).then((entries) => {
    const bad = entries.filter((e) => e.status === 'failed' || e.status === 'skipped');
    if (!bad.length) return;
    issues.append(el('section', { class: 'glass card' }, el('h3', { text: 'Items that were skipped or failed', style: { marginBottom: '10px' } }),
      el('div', { class: 'table-wrap' }, el('table', { class: 'tbl' }, el('tbody', {}, bad.slice(0, 500).map((e) => el('tr', {},
        el('td', { class: 'name', text: e.fileName || '' }), el('td', {}, statusBadge(e.status)), el('td', { class: 'small', text: e.error || '' }))))))));
  });
  return wrap;
}
