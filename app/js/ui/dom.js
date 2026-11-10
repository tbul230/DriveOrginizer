// DOM helpers. All user/Drive-provided text is inserted with textContent,
// never innerHTML, so file names cannot inject markup or scripts.
import { kindOf } from '../core/driveIndex.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (v === true) node.setAttribute(k, '');
    else if (k in node && typeof v !== 'string') node[k] = v;
    else node.setAttribute(k, v);
  }
  append(node, children);
  return node;
}

export function append(node, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    node.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

export function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); return node; }

// Minimal stroke icon set (24x24 viewBox).
const ICONS = {
  dashboard: 'M4 13h6V4H4zM14 20h6v-9h-6zM4 20h6v-4H4zM14 4v4h6V4z',
  sparkles: 'M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8zM19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9zM5 15l.6 1.4L7 17l-1.4.6L5 19l-.6-1.4L3 17l1.4-.6z',
  files: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  history: 'M3 12a9 9 0 1 0 3-6.7M3 4v4h4M12 7v5l3 2',
  duplicate: 'M8 8h11v11H8zM5 16V5h11',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 0 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 0 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 0 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 0 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  file: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5',
  doc: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5M9 13h6M9 17h6',
  sheet: 'M5 3h14v18H5zM5 9h14M5 15h14M11 9v12',
  slides: 'M4 5h16v11H4zM12 16v4M8 20h8',
  pdf: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5M8 15h1.5a1.5 1.5 0 0 0 0-3H8v5',
  image: 'M4 5h16v14H4zM4 16l5-5 4 4 3-3 4 4M15 9h.01',
  video: 'M3 6h13v12H3zM16 10l5-3v10l-5-3',
  check: 'M5 12l5 5L20 7',
  x: 'M6 6l12 12M18 6L6 18',
  alert: 'M12 9v4M12 17h.01M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z',
  info: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 16v-4M12 8h.01',
  shield: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z',
  lock: 'M6 11h12v10H6zM8 11V7a4 4 0 0 1 8 0v4',
  undo: 'M9 14L4 9l5-5M4 9h11a5 5 0 0 1 0 10h-3',
  refresh: 'M21 12a9 9 0 1 1-2.6-6.4M21 4v5h-5',
  external: 'M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',
  chevron: 'M9 6l6 6-6 6',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM21 21l-4.3-4.3',
  google: 'M21 12.2c0-.7-.1-1.3-.2-1.9H12v3.6h5a4.3 4.3 0 0 1-1.9 2.8v2.3h3A9 9 0 0 0 21 12.2zM12 21c2.5 0 4.6-.8 6.1-2.3l-3-2.3c-.8.6-1.9.9-3.1.9a5.4 5.4 0 0 1-5-3.7H3.9v2.4A9 9 0 0 0 12 21zM7 13.6a5.4 5.4 0 0 1 0-3.4V7.8H3.9a9 9 0 0 0 0 8.1zM12 6.6c1.3 0 2.5.5 3.5 1.4l2.6-2.6A9 9 0 0 0 3.9 7.8L7 10.2a5.4 5.4 0 0 1 5-3.6z',
  drive: 'M8 3h8l6 10-4 7H6l-4-7zM8 3l6 10h8M2 13l6-10M6 20l4-7h12',
  stop: 'M7 7h10v10H7z',
  download: 'M12 4v11M7 10l5 5 5-5M5 20h14',
  upload: 'M12 20V9M7 14l5-5 5 5M5 4h14',
  logout: 'M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10',
  trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
  storage: 'M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zM4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3',
  inbox: 'M3 13h5l1 3h6l1-3h5M5 5h14l2 8v6H3v-6z',
  play: 'M7 5l12 7-12 7z',
};

export function icon(name, size = 18, extraClass = '') {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.9');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  if (extraClass) svg.setAttribute('class', extraClass);
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', ICONS[name] || ICONS.file);
  svg.appendChild(path);
  return svg;
}

const KIND_ICON = { folder: 'folder', doc: 'doc', word: 'doc', text: 'doc', sheet: 'sheet', excel: 'sheet', slides: 'slides', powerpoint: 'slides', pdf: 'pdf', image: 'image', video: 'video' };
const KIND_CLASS = { folder: 'folder', doc: 'doc', word: 'doc', text: 'doc', sheet: 'sheet', excel: 'sheet', slides: 'slides', powerpoint: 'slides', pdf: 'pdf', image: 'image', video: 'video' };

export function fileIcon(itemOrKind, size = 16) {
  const kind = typeof itemOrKind === 'string' ? itemOrKind : kindOf(itemOrKind);
  return el('span', { class: `ficon ${KIND_CLASS[kind] || 'other'}`, 'aria-hidden': 'true' }, icon(KIND_ICON[kind] || 'file', size));
}

export function toast(message, type = 'info', ms = 5000) {
  const host = document.getElementById('toasts');
  if (!host) return;
  const ic = { ok: 'check', bad: 'alert', warn: 'alert', info: 'info' }[type] || 'info';
  const t = el('div', { class: `toast glass ${type}` }, icon(ic), el('div', { class: 'grow' }, message));
  host.appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .3s'; setTimeout(() => t.remove(), 320); }, ms);
}

/**
 * Show a modal. `actions` = [{ label, value, kind }]. Resolves with the chosen
 * value (or null when dismissed). `body` may be a Node or string.
 */
export function modal({ title, body, actions = [{ label: 'OK', value: true, kind: 'primary' }], dismissable = true }) {
  return new Promise((resolve) => {
    const prevFocus = document.activeElement;
    const close = (v) => { layer.remove(); document.removeEventListener('keydown', onKey); prevFocus?.focus?.(); resolve(v); };
    const onKey = (e) => { if (e.key === 'Escape' && dismissable) close(null); };
    const buttons = actions.map((a) => el('button', { class: `btn ${a.kind || ''}`, onclick: () => close(typeof a.value === 'function' ? a.value() : a.value) }, a.label));
    const box = el('div', { class: 'modal glass', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      el('h2', { text: title }),
      typeof body === 'string' ? el('p', { class: 'muted', text: body }) : body,
      el('div', { class: 'actions' }, buttons));
    const layer = el('div', { class: 'modal-layer', onclick: (e) => { if (e.target === layer && dismissable) close(null); } }, box);
    document.body.appendChild(layer);
    document.addEventListener('keydown', onKey);
    (buttons[buttons.length - 1] || box).focus();
  });
}

export function formatBytes(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(v) / Math.log(1024)));
  return `${(v / 1024 ** i).toFixed(i ? 1 : 0)} ${units[i]}`;
}

export function formatDate(iso, withTime = false) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return withTime ? d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : d.toLocaleDateString(undefined, { dateStyle: 'medium' });
}

export function formatNumber(n) { return Number(n || 0).toLocaleString(); }

export function plural(n, one, many = `${one}s`) { return `${formatNumber(n)} ${n === 1 ? one : many}`; }

export function driveLink(item) {
  if (!item) return null;
  const href = item.webViewLink || (item.mimeType === 'application/vnd.google-apps.folder'
    ? `https://drive.google.com/drive/folders/${encodeURIComponent(item.id)}`
    : `https://drive.google.com/file/d/${encodeURIComponent(item.id)}/view`);
  if (!/^https:\/\/(drive|docs)\.google\.com\//.test(href)) return null;
  return el('a', { href, target: '_blank', rel: 'noopener noreferrer', title: 'Open in Google Drive', class: 'btn ghost sm' }, icon('external', 14));
}

export function switchInput({ checked, onchange, label }) {
  const input = el('input', { type: 'checkbox', checked: !!checked, 'aria-label': label, onchange: (e) => onchange(e.target.checked) });
  return el('label', { class: 'switch' }, input, el('span'));
}

export function statusBadge(status) {
  const map = { success: ['ok', 'Succeeded'], failed: ['bad', 'Failed'], skipped: ['warn', 'Skipped'], cancelled: ['neutral', 'Not run'],
    pending: ['neutral', 'Pending'], done: ['ok', 'Done'], running: ['info', 'Running'], completed: ['ok', 'Completed'],
    'completed-with-errors': ['warn', 'Completed with errors'], stopped: ['neutral', 'Stopped'], paused: ['warn', 'Paused'] };
  const [cls, label] = map[status] || ['neutral', status];
  return el('span', { class: `badge ${cls}`, text: label });
}

/** Simple paginated list helper. */
export function paginate(list, page, perPage) {
  const pages = Math.max(1, Math.ceil(list.length / perPage));
  const p = Math.min(Math.max(1, page), pages);
  return { slice: list.slice((p - 1) * perPage, p * perPage), page: p, pages };
}

export function pager({ page, pages, total, onPage }) {
  if (pages <= 1) return el('div', { class: 'pager' }, `${formatNumber(total)} total`);
  return el('div', { class: 'pager' },
    `${formatNumber(total)} total · page ${page} of ${pages}`,
    el('button', { class: 'btn sm', disabled: page <= 1, onclick: () => onPage(page - 1) }, 'Previous'),
    el('button', { class: 'btn sm', disabled: page >= pages, onclick: () => onPage(page + 1) }, 'Next'));
}
