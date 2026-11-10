import { el, icon, fileIcon, formatDate, formatBytes, paginate, pager, driveLink } from '../dom.js';
import { isFolder, KIND_LABELS, kindOf } from '../../core/driveIndex.js';

const PER_PAGE = 100;

export function renderFiles(view, ctx) {
  const { state } = ctx;
  const index = state.index;
  const u = state.filesUi || (state.filesUi = { folderId: null, q: '', page: 1 });
  if (!index) { view.append(el('div', { class: 'glass card empty', text: 'Your Drive has not been scanned yet.' })); return; }
  if (!u.folderId || !index.get(u.folderId) || !index.inMyDrive.has(u.folderId)) u.folderId = index.rootId;

  const draw = () => { view.replaceChildren(); renderFiles(view, ctx); };
  const search = el('input', { class: 'input', type: 'search', placeholder: 'Search all files by name…', value: u.q, 'aria-label': 'Search files',
    onkeydown: (e) => { if (e.key === 'Enter') { u.q = e.target.value.trim(); u.page = 1; draw(); } },
    onsearch: (e) => { u.q = e.target.value.trim(); u.page = 1; draw(); } });

  view.append(el('div', { class: 'page-head' },
    el('div', {}, el('h1', { text: 'My Files' }), el('p', { class: 'muted', text: 'Browse your Drive as it was at the last scan. This page is read-only.' })),
    el('div', { class: 'row' }, search, el('button', { class: 'btn', onclick: () => ctx.rescan() }, icon('refresh', 16), 'Scan again'))));

  let list;
  let searching = false;
  if (u.q) {
    searching = true;
    const q = u.q.toLowerCase();
    list = index.myDriveItems().filter((it) => it.name.toLowerCase().includes(q));
  } else {
    list = index.childrenOf(u.folderId);
  }
  list.sort((a, b) => (isFolder(b) - isFolder(a)) || a.name.localeCompare(b.name, undefined, { numeric: true }));
  const { slice, page, pages } = paginate(list, u.page, PER_PAGE);

  const crumbs = el('div', { class: 'crumbs' });
  if (searching) {
    crumbs.append(el('button', { onclick: () => { u.q = ''; draw(); } }, '← Back to folders'), el('span', { text: `Results for “${u.q}”` }));
  } else {
    const chain = [];
    let cur = u.folderId;
    while (cur) { chain.unshift(cur); if (cur === index.rootId) break; cur = index.parentOf(cur); }
    chain.forEach((id, i) => {
      if (i) crumbs.append(el('span', { text: '/' }));
      crumbs.append(el('button', { onclick: () => { u.folderId = id; u.page = 1; draw(); } }, id === index.rootId ? 'My Drive' : index.get(id)?.name));
    });
  }

  const rows = slice.map((it) => el('tr', {},
    el('td', { class: 'name' }, el('div', { class: 'file-row-name' }, fileIcon(it),
      isFolder(it) ? el('button', { class: 'linklike ellipsis', onclick: () => { u.folderId = it.id; u.q = ''; u.page = 1; draw(); } }, it.name)
        : el('span', { class: 'ellipsis', text: it.name }))),
    el('td', { class: 'small muted', text: KIND_LABELS[kindOf(it)] }),
    searching ? el('td', { class: 'small muted', text: index.locationOf(it.id) }) : null,
    el('td', { class: 'small muted', text: formatDate(it.modifiedTime) }),
    el('td', { class: 'small muted', text: isFolder(it) ? `${index.childrenOf(it.id).length} items` : formatBytes(it.size) }),
    el('td', { class: 'small muted', text: it.ownedByMe === false ? 'Shared with you' : '' }),
    el('td', {}, driveLink(it))));

  view.append(el('section', { class: 'glass card' }, crumbs,
    list.length ? el('div', { class: 'table-wrap' }, el('table', { class: 'tbl' },
      el('thead', {}, el('tr', {}, ['Name', 'Type', searching ? 'Location' : null, 'Modified', 'Size', 'Owner', ''].filter((h) => h !== null).map((h) => el('th', { text: h })))),
      el('tbody', {}, rows)))
      : el('div', { class: 'empty' }, icon('folder', 34), el('p', { text: searching ? 'No files match.' : 'This folder is empty.' })),
    pager({ page, pages, total: list.length, onPage: (p) => { u.page = p; draw(); } })));
}
