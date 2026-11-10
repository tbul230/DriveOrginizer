import { el, icon, toast, modal, formatDate, statusBadge, plural } from '../dom.js';
import { undoEntries, canUndo } from '../../core/undo.js';

const OP_LABELS = {
  move: 'Move', rename: 'Rename', createFolder: 'Create folder', 'undo-move': 'Undo move', 'undo-rename': 'Undo rename',
  'undo-createFolder': 'Remove created folder', 'trash-empty-folder': 'Empty folder → Trash',
};

export function renderHistory(view, ctx) {
  const { state } = ctx;
  const u = state.historyUi || (state.historyUi = { q: '', status: 'all', open: new Set() });
  if (state.organizerUi.historyRun) { u.open.add(state.organizerUi.historyRun); state.organizerUi.historyRun = null; }
  const draw = () => { view.replaceChildren(); renderHistory(view, ctx); };

  const fileInput = el('input', { type: 'file', accept: 'application/json,.json', class: 'hidden', onchange: async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    try { const n = await state.history.importJSON(await f.text()); toast(`Imported ${n} record(s).`, 'ok'); draw(); } catch (err) { toast(err.message, 'bad'); }
  } });
  view.append(el('div', { class: 'page-head' },
    el('div', {}, el('h1', { text: 'Organization History' }),
      el('p', { class: 'muted', text: 'Every operation is recorded here — successes, skips and failures. Undo any move or rename.' })),
    el('div', { class: 'row' },
      el('button', { class: 'btn', onclick: async () => {
        const text = await state.history.exportJSON();
        const a = el('a', { href: URL.createObjectURL(new Blob([text], { type: 'application/json' })), download: `drive-organizer-history-${new Date().toISOString().slice(0, 10)}.json` });
        document.body.append(a); a.click(); a.remove();
      } }, icon('download', 16), 'Export'),
      el('button', { class: 'btn', onclick: () => fileInput.click() }, icon('upload', 16), 'Import'), fileInput,
      state.settings.backupHistoryToDrive ? el('button', { class: 'btn', onclick: async () => { await ctx.backupHistory(); toast('History backed up to your Drive’s private app folder.', 'ok'); } }, icon('drive', 16), 'Back up now') : null)));

  const toolbar = el('div', { class: 'toolbar' },
    el('input', { class: 'input', type: 'search', placeholder: 'Search by file name…', value: u.q, 'aria-label': 'Search history',
      onchange: (e) => { u.q = e.target.value.trim().toLowerCase(); draw(); } }),
    el('select', { 'aria-label': 'Status filter', onchange: (e) => { u.status = e.target.value; draw(); } },
      [['all', 'All statuses'], ['success', 'Succeeded'], ['failed', 'Failed'], ['skipped', 'Skipped'], ['cancelled', 'Not run']]
        .map(([v, t]) => el('option', { value: v, text: t, selected: u.status === v }))));
  const host = el('div', { class: 'stack' }, el('div', { class: 'glass card faint', text: 'Loading history…' }));
  view.append(toolbar, host);

  Promise.all([state.history.runs(), state.history.allEntries()]).then(([runs, entries]) => {
    host.replaceChildren();
    if (!runs.length) {
      host.append(el('div', { class: 'glass card empty' }, icon('history', 34), el('p', { text: 'No organization runs yet.' })));
      return;
    }
    const byRun = new Map();
    for (const e of entries) { if (!byRun.has(e.runId)) byRun.set(e.runId, []); byRun.get(e.runId).push(e); }
    for (const run of runs) {
      let list = (byRun.get(run.runId) || []).sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)) || (a.seq || 0) - (b.seq || 0));
      const undoable = list.filter(canUndo);
      if (u.q) list = list.filter((e) => (e.fileName || '').toLowerCase().includes(u.q) || (e.newName || '').toLowerCase().includes(u.q));
      if (u.status !== 'all') list = list.filter((e) => e.status === u.status);
      if ((u.q || u.status !== 'all') && !list.length) continue;
      host.append(runCard(ctx, run, list, undoable, u, draw));
    }
    if (!host.children.length) host.append(el('div', { class: 'glass card empty', text: 'No records match.' }));
  });
}

function runCard(ctx, run, list, undoable, u, draw) {
  const c = run.counts || {};
  const details = el('details', { class: 'glass card', open: u.open.has(run.runId) || undefined, ontoggle: (e) => {
    if (e.target.open) u.open.add(run.runId); else u.open.delete(run.runId);
  } });
  const moveLike = undoable.filter((e) => e.type !== 'createFolder');
  details.append(el('summary', { style: { listStyle: 'none', cursor: 'pointer' } },
    el('div', { class: 'row between' },
      el('div', { class: 'row grow', style: { minWidth: '240px' } }, icon(run.kind === 'undo' ? 'undo' : 'sparkles', 20),
        el('div', { class: 'grow' },
          el('div', { style: { fontWeight: 650 }, class: 'ellipsis', text: run.kind === 'undo' ? run.instruction : `“${run.instruction || 'Organization run'}”` }),
          el('div', { class: 'faint', text: `${formatDate(run.createdAt, true)} · ${c.success || 0} succeeded · ${c.failed || 0} failed · ${c.skipped || 0} skipped${c.cancelled ? ` · ${c.cancelled} not run` : ''}` }))),
      el('div', { class: 'row' }, statusBadge(run.status),
        moveLike.length ? el('button', { class: 'btn sm', onclick: (e) => { e.preventDefault(); startUndo(ctx, undoable, `Undo of run from ${formatDate(run.createdAt, true)}`, draw); } },
          icon('undo', 14), `Undo run (${moveLike.length})`) : null))));
  if (run.error) details.append(el('div', { class: 'notice', style: { marginTop: '12px' } }, icon('alert'), run.error));
  details.append(el('div', { class: 'table-wrap', style: { marginTop: '12px' } }, el('table', { class: 'tbl' },
    el('thead', {}, el('tr', {}, ['Time', 'Operation', 'File', 'From', 'To', 'Result', ''].map((h) => el('th', { text: h })))),
    el('tbody', {}, list.slice(0, 2000).map((e) => el('tr', {},
      el('td', { class: 'small muted', text: formatDate(e.timestamp, true) }),
      el('td', { class: 'small', text: OP_LABELS[e.type] || e.type }),
      el('td', { class: 'name' }, el('span', { text: e.type.includes('rename') ? `${e.oldName || e.fileName} → ${e.newName || ''}` : (e.fileName || '') })),
      el('td', { class: 'small muted', text: e.fromPath || '' }),
      el('td', { class: 'small muted', text: e.toPath || '' }),
      el('td', {}, statusBadge(e.status), e.error ? el('div', { class: 'faint', style: { marginTop: '4px', maxWidth: '280px' }, text: e.error }) : null,
        e.undoneAt ? el('div', { class: 'badge neutral', style: { marginTop: '4px' }, text: `Undone ${formatDate(e.undoneAt, true)}` }) : null),
      el('td', {}, canUndo(e) && e.type !== 'createFolder'
        ? el('button', { class: 'btn sm', onclick: () => startUndo(ctx, [e], `Undo: ${e.fileName}`, draw) }, icon('undo', 14), 'Undo') : null)))))));
  if (list.length > 2000) details.append(el('p', { class: 'faint', text: `Showing the first 2,000 of ${list.length} records. Use search to narrow down, or Export for the full list.` }));
  return details;
}

async function startUndo(ctx, entries, label, draw) {
  const { state } = ctx;
  if (state.busy) { toast('Please wait for the current operation to finish.', 'warn'); return; }
  const moves = entries.filter((e) => e.type !== 'createFolder' && canUndo(e));
  const folders = entries.filter((e) => e.type === 'createFolder' && canUndo(e));
  const trashBox = el('input', { type: 'checkbox' });
  const body = el('div', { class: 'stack' },
    el('p', { text: `${plural(moves.length, 'change')} will be reversed: files go back to their original folders and renamed files get their old names back.` }),
    el('p', { class: 'faint', text: 'Before each file is moved back, the app checks that it is still where this app put it, that its original folder still exists, and that nothing with the same name is already there.' }),
    folders.length ? el('label', { class: 'check' }, trashBox,
      el('span', {}, `Also move the ${plural(folders.length, 'folder')} this run created to the Trash, `, el('b', { text: 'only if they are empty' }), ' afterwards. (Trash can be restored for 30 days. Nothing is permanently deleted.)')) : null);
  const ok = await modal({ title: 'Undo changes?', body, actions: [{ label: 'Cancel', value: false }, { label: 'Undo', value: true, kind: 'primary' }] });
  if (!ok) return;
  if (!(await ctx.ensureFreshToken(10))) return;
  await runUndo(ctx, entries, label, { trashEmptyFolders: trashBox.checked });
  draw();
}

async function runUndo(ctx, entries, label, options) {
  const { state } = ctx;
  state.busy = true;
  const msg = el('span', { text: 'Undoing…' });
  const layer = el('div', { class: 'fullscreen-progress' }, el('div', { class: 'glass stack' }, el('div', { class: 'progress-line' }, el('div', { class: 'spinner' }), msg)));
  document.body.append(layer);
  let out;
  try {
    out = await undoEntries({ client: state.client, history: state.history, entries, rootId: state.index?.rootId || 'root', options, label,
      onProgress: ({ done, total, label: l }) => { msg.textContent = `Undoing ${done + 1 > total ? total : done + 1} of ${total}${l ? `: ${l}` : ''}`; } });
  } catch (err) {
    toast(`Undo failed: ${err.message}`, 'bad', 10000);
  } finally {
    layer.remove();
    state.busy = false;
  }
  if (!out) return;
  const { results, run } = out;
  toast(`Undo finished: ${run.counts.success} reversed, ${run.counts.skipped} skipped, ${run.counts.failed} failed.`, run.counts.failed || run.counts.skipped ? 'warn' : 'ok', 8000);

  // Offer safe follow-ups for problems that need the user's decision.
  const missing = results.filter((r) => r.code === 'missingOriginal').map((r) => r.entry);
  const conflicts = results.filter((r) => r.code === 'conflict').map((r) => r.entry);
  if (missing.length) {
    const go = await modal({ title: 'Original folder no longer exists',
      body: `${plural(missing.length, 'file')} could not go back because the original folder was deleted or moved to the trash. Move them to the top level of My Drive instead?`,
      actions: [{ label: 'Leave them where they are', value: false }, { label: 'Move to My Drive', value: true, kind: 'primary' }] });
    if (go) await runUndo(ctx, missing, `${label} (to My Drive)`, { ...options, restoreToRoot: true, trashEmptyFolders: false });
  }
  if (conflicts.length) {
    const go = await modal({ title: 'Same name already exists',
      body: `${plural(conflicts.length, 'file')} could not go back because an item with the same name is now in the original folder. Move them back anyway? Google Drive keeps both items side by side — nothing is overwritten.`,
      actions: [{ label: 'Leave them where they are', value: false }, { label: 'Move back anyway', value: true, kind: 'primary' }] });
    if (go) await runUndo(ctx, conflicts, `${label} (keeping both)`, { ...options, allowNameConflict: true, trashEmptyFolders: false });
  }
  await ctx.backupHistory();
  await ctx.rescan();
}
