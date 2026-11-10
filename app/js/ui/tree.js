// Lazy, expandable before/after folder tree for the preview.
import { el, icon, fileIcon } from './dom.js';

const PAGE = 200;
const STATUS_BADGE = {
  new: ['ok', 'new'], 'moved-in': ['info', 'moved here'], review: ['warn', 'review'],
  'moving-out': ['neutral', 'moving'], renamed: ['purple', 'renamed'],
};

function kids(model, key, mode, changedOnly) {
  let list = mode === 'before' ? model.childrenBefore(key) : model.childrenAfter(key);
  if (changedOnly) list = list.filter((c) => c.changed || c.status !== 'same');
  return list.sort((a, b) => (b.folder - a.folder) || a.name.localeCompare(b.name, undefined, { numeric: true }));
}

function nodeEl(model, child, mode, opts, depth) {
  const li = el('li');
  const badge = STATUS_BADGE[child.status];
  const row = el('div', { class: `node ${child.folder ? 'folder' : ''} st-${child.status}`, role: 'treeitem' },
    el('span', { class: 'twisty' }, child.folder ? icon('chevron', 14) : null),
    child.folder ? fileIcon('folder', 14) : fileIcon(child.item || 'other', 14),
    el('span', { class: 'nm', text: child.name, title: child.name }),
    badge ? el('span', { class: `badge ${badge[0]}`, text: badge[1] }) : null);
  li.append(row);
  if (child.folder) {
    let sub = null;
    const toggle = () => {
      const open = !row.classList.contains('open');
      row.classList.toggle('open', open);
      row.setAttribute('aria-expanded', String(open));
      if (open && !sub) { sub = listEl(model, child.key, mode, opts, depth + 1); li.append(sub); }
      if (sub) sub.classList.toggle('hidden', !open);
    };
    row.tabIndex = 0;
    row.addEventListener('click', toggle);
    row.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
    const autoOpen = (opts.changedOnly && child.changed && depth < 6) || (child.status === 'new' && depth < 3);
    if (autoOpen) toggle();
  }
  return li;
}

function listEl(model, key, mode, opts, depth) {
  const ul = el('ul', { class: 'tree', role: 'group' });
  const all = kids(model, key, mode, opts.changedOnly);
  let shown = 0;
  const more = () => {
    const next = all.slice(shown, shown + PAGE);
    for (const c of next) ul.insertBefore(nodeEl(model, c, mode, opts, depth), moreLi);
    shown += next.length;
    moreLi.classList.toggle('hidden', shown >= all.length);
    moreBtn.textContent = `Show ${Math.min(PAGE, all.length - shown)} more (${all.length - shown} hidden)`;
  };
  const moreBtn = el('button', { class: 'btn sm more-btn', onclick: (e) => { e.stopPropagation(); more(); } });
  const moreLi = el('li', {}, moreBtn);
  ul.append(moreLi);
  if (!all.length) ul.insertBefore(el('li', { class: 'faint', style: { padding: '4px 8px' }, text: opts.changedOnly ? 'No changes here' : 'Empty' }), moreLi);
  more();
  return ul;
}

export function renderTree(model, mode, opts = {}) {
  const rootKey = model.index.rootId;
  const root = { key: rootKey, name: 'My Drive', folder: true, status: 'same', changed: true };
  const ul = el('ul', { class: 'tree', role: 'tree', 'aria-label': `${mode === 'before' ? 'Before' : 'After'} folder tree` });
  const li = nodeEl(model, root, mode, { ...opts, changedOnly: opts.changedOnly }, 0);
  ul.append(li);
  const row = li.querySelector('.node');
  if (!row.classList.contains('open')) row.click();
  return ul;
}
