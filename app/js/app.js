// App bootstrap, routing and shared state.
import { el, clear, icon, toast, modal, formatNumber } from './ui/dom.js';
import { loadSettings, saveSettings, applyTheme } from './core/settings.js';
import { openStore } from './core/store.js';
import { History } from './core/history.js';
import { GoogleAuth } from './core/auth.js';
import { DriveClient } from './core/drive.js';
import { scanDrive } from './core/scanner.js';
import { renderWelcome } from './ui/views/welcome.js';
import { renderDashboard } from './ui/views/dashboard.js';
import { renderOrganizer } from './ui/views/organizer.js';
import { renderFiles } from './ui/views/files.js';
import { renderHistory } from './ui/views/history.js';
import { renderDuplicates } from './ui/views/duplicates.js';
import { renderSettings } from './ui/views/settings.js';

const ROUTES = [
  { id: 'dashboard', label: 'Dashboard', icon: 'dashboard', render: renderDashboard },
  { id: 'organizer', label: 'AI Organizer', icon: 'sparkles', render: renderOrganizer },
  { id: 'files', label: 'My Files', icon: 'files', render: renderFiles },
  { id: 'history', label: 'Organization History', icon: 'history', render: renderHistory },
  { id: 'duplicates', label: 'Duplicate Finder', icon: 'duplicate', render: renderDuplicates },
  { id: 'settings', label: 'Settings', icon: 'settings', render: renderSettings },
];

const config = window.DRIVE_ORGANIZER_CONFIG || {};

const state = {
  settings: loadSettings(),
  store: null,
  history: null,
  auth: null,
  client: null,
  index: null,
  about: null,
  connected: false,
  scanning: false,
  scanProgress: null,
  plan: null,          // current organizer plan (draft / executing / done)
  organizerUi: {},     // organizer view state that survives navigation
  route: 'dashboard',
  busy: false,         // true while a run/undo is writing to Drive
  sameOriginBackend: '', // set when this site also hosts the AI backend (e.g. Vercel /api)
};

let mainEl = null;
let leaveHandlers = [];

export const ctx = {
  state,
  get clientId() { return (state.settings.googleClientId || config.googleClientId || '').trim(); },
  get backendUrl() { return (state.settings.aiBackendUrl || config.aiBackendUrl || state.sameOriginBackend || '').trim(); },
  saveSettings(patch) {
    Object.assign(state.settings, patch);
    saveSettings(state.settings);
    if ('theme' in patch) applyTheme(state.settings.theme);
  },
  navigate(route) {
    if (location.hash !== `#/${route}`) location.hash = `#/${route}`;
    else renderRoute();
  },
  refresh() { renderRoute(); },
  onLeave(fn) { leaveHandlers.push(fn); },
  connect, disconnect, rescan, backupHistory, savePlan, ensureFreshToken,
};

// ---------- connection ----------

function makeClient() {
  return new DriveClient({
    getToken: () => state.auth.getToken(),
    refreshToken: () => state.auth.refresh(),
  });
}

async function connect({ prompt } = {}) {
  if (!ctx.clientId) throw new Error('No Google OAuth client ID is configured yet.');
  if (!state.auth || state.auth.clientId !== ctx.clientId) {
    state.auth = new GoogleAuth(ctx.clientId);
    state.auth.onChange(() => updateConnBadge());
  }
  await state.auth.signIn({ prompt: prompt ?? (state.auth.loginHint ? '' : 'consent') });
  state.client = makeClient();
  state.about = await state.client.about();
  state.auth.loginHint = state.about?.user?.emailAddress || '';
  state.connected = true;
  renderShell();
  await rescan();
  restoreHistoryFromDrive();
  restoreDraftPlan();
}

async function disconnect() {
  try { await state.auth?.signOut(); } catch { /* ignore */ }
  Object.assign(state, { client: null, index: null, about: null, connected: false, plan: null, organizerUi: {} });
  render();
}

async function rescan() {
  if (!state.client || state.scanning) return;
  state.scanning = true;
  state.scanProgress = { count: 0, pages: 0 };
  const overlay = scanOverlay();
  try {
    const index = await scanDrive(state.client, {
      onProgress: (p) => { state.scanProgress = p; overlay.update(p); },
    });
    state.index = index;
    try { state.about = await state.client.about(); } catch { /* storage info is optional */ }
    const s = index.stats();
    toast(`Scanned ${formatNumber(s.files)} files and ${formatNumber(s.folders)} folders in ${index.pagesScanned} page(s).`, 'ok');
    if (index.incompleteSearch) toast('Google reported that the scan may be incomplete. Some files might be missing — try scanning again later.', 'warn', 10000);
  } catch (err) {
    toast(`Scanning failed: ${err.message}`, 'bad', 10000);
  } finally {
    state.scanning = false;
    overlay.close();
    renderRoute();
  }
}

function scanOverlay() {
  const count = el('b', { text: '0' });
  const pages = el('span', { class: 'faint', text: '' });
  const layer = el('div', { class: 'fullscreen-progress' },
    el('div', { class: 'glass stack' },
      el('div', { class: 'progress-line' }, el('div', { class: 'spinner' }), el('h3', { text: 'Scanning your Google Drive…' })),
      el('p', { class: 'muted' }, count, ' items found so far. ', pages),
      el('p', { class: 'faint', text: 'Every page of results is loaded, so large Drives can take a minute. Nothing is changed while scanning.' })));
  document.body.appendChild(layer);
  return {
    update(p) { count.textContent = formatNumber(p.count); pages.textContent = `(${p.pages} page${p.pages === 1 ? '' : 's'} read)`; },
    close() { layer.remove(); },
  };
}

/** Make sure the token will last for a long write operation; asks for a click if needed. */
async function ensureFreshToken(minMinutes = 25) {
  if (state.auth?.isSignedIn() && state.auth.minutesLeft() >= minMinutes) return true;
  const ok = await modal({
    title: 'Refresh Google access',
    body: 'Before making changes, please refresh your Google connection so it does not expire in the middle of organizing.',
    actions: [{ label: 'Cancel', value: false }, { label: 'Refresh connection', value: true, kind: 'primary' }],
  });
  if (!ok) return false;
  try { await state.auth.signIn({ prompt: '' }); return true; } catch (e) { toast(e.message, 'bad'); return false; }
}

async function backupHistory() {
  if (!state.settings.backupHistoryToDrive || !state.client) return;
  try { await state.history.backupToDrive(state.client); } catch (e) {
    console.warn('History backup failed', e);
    toast(`History was saved in this browser, but the backup copy in Google Drive failed: ${e.message}`, 'warn', 8000);
  }
}

async function restoreHistoryFromDrive() {
  if (!state.settings.backupHistoryToDrive || !state.client) return;
  try {
    const n = await state.history.restoreFromDrive(state.client);
    if (n > 0) toast(`Restored ${n} history record(s) from your Drive backup.`, 'info');
  } catch (e) { console.warn('History restore failed', e); }
}

async function savePlan(plan) {
  try { await state.store.put('plans', JSON.parse(JSON.stringify(plan))); } catch (e) { console.warn('Could not save plan', e); }
}

async function restoreDraftPlan() {
  if (state.plan) return;
  try {
    const plans = await state.store.all('plans');
    const open = plans.filter((p) => ['draft', 'paused', 'executing'].includes(p.status))
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0];
    if (!open) return;
    if (open.status === 'executing') open.status = 'paused'; // the page was closed mid-run
    state.plan = open;
    state.organizerUi = { stage: 'preview' };
    toast(open.status === 'paused' ? 'An organization run was interrupted. Open AI Organizer to review and resume it.' : 'Your last unfinished plan was restored in AI Organizer.', 'info', 8000);
    if (state.route === 'organizer') renderRoute();
  } catch (e) { console.warn(e); }
}

// ---------- rendering ----------

function updateConnBadge() {
  const b = document.getElementById('conn-badge');
  if (!b) return;
  clear(b);
  const ok = state.connected && state.auth?.isSignedIn();
  b.append(el('span', { class: `dot ${ok ? 'ok' : (state.connected ? 'bad' : '')}` }),
    el('span', { class: 'ellipsis', text: ok ? (state.about?.user?.emailAddress || 'Connected') : (state.connected ? 'Session expired' : 'Not connected') }));
}

function renderShell() {
  const root = document.getElementById('app');
  clear(root);
  const nav = el('nav', { class: 'sidebar glass', 'aria-label': 'Main' },
    el('div', { class: 'brand' },
      el('div', { class: 'brand-mark' }, icon('sparkles', 20)),
      el('div', {}, el('div', { class: 'brand-name', text: 'Drive Organizer' }), el('div', { class: 'brand-sub', text: 'AI-powered, approval-first' }))),
    ROUTES.map((r) => el('a', { class: 'nav-item', href: `#/${r.id}`, dataset: { route: r.id } }, icon(r.icon, 19), r.label)),
    el('div', { class: 'sidebar-foot' },
      el('div', { class: 'conn', id: 'conn-badge' }),
      el('div', { class: 'faint', text: 'Never deletes files · Undo anytime' })));
  mainEl = el('main', { class: 'main', id: 'main', tabindex: '-1' });
  root.append(el('div', { class: 'shell' }, nav, mainEl));
  updateConnBadge();
}

function renderRoute() {
  if (!state.connected) return render();
  if (!mainEl || !document.body.contains(mainEl)) renderShell();
  for (const fn of leaveHandlers) { try { fn(); } catch { /* ignore */ } }
  leaveHandlers = [];
  const id = (location.hash.replace(/^#\/?/, '') || 'dashboard').split('?')[0];
  const route = ROUTES.find((r) => r.id === id) || ROUTES[0];
  state.route = route.id;
  document.querySelectorAll('.nav-item').forEach((n) => n.classList.toggle('active', n.dataset.route === route.id));
  clear(mainEl);
  if (state.connected && state.auth && !state.auth.isSignedIn() && !state.busy) {
    mainEl.append(el('div', { class: 'notice bad', style: { marginBottom: '16px' } }, icon('alert'),
      el('div', { class: 'grow' }, 'Your Google session expired (Google limits sessions to about an hour). '),
      el('button', { class: 'btn sm primary', onclick: async () => { try { await state.auth.signIn({ prompt: '' }); renderRoute(); } catch (e) { toast(e.message, 'bad'); } } }, 'Reconnect')));
  }
  const view = el('div', { class: 'fade-in' });
  mainEl.append(view);
  try {
    route.render(view, ctx);
  } catch (err) {
    console.error(err);
    view.append(el('div', { class: 'notice bad' }, icon('alert'), `Something went wrong showing this page: ${err.message}`));
  }
  updateConnBadge();
  document.title = `${route.label} · AI Drive Organizer`;
}

function render() {
  const root = document.getElementById('app');
  if (!state.connected) {
    mainEl = null;
    clear(root);
    root.append(renderWelcome(ctx));
    document.title = 'AI Drive Organizer';
    return;
  }
  renderShell();
  renderRoute();
}

// ---------- boot ----------

async function boot() {
  applyTheme(state.settings.theme);
  state.store = await openStore();
  state.history = new History(state.store);
  if (!state.store.persistent) toast('This browser blocks local storage, so history will only last until you close the tab. Keep "Back up history to Google Drive" switched on in Settings.', 'warn', 12000);
  window.addEventListener('hashchange', () => renderRoute());
  window.addEventListener('beforeunload', (e) => { if (state.busy) { e.preventDefault(); e.returnValue = ''; } });
  window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', () => applyTheme(state.settings.theme));
  render();
  detectSameOriginBackend();
}

/** When the site is deployed together with the AI backend (Vercel /api functions), use it automatically. */
async function detectSameOriginBackend() {
  if (config.aiBackendUrl || state.settings.aiBackendUrl || location.protocol !== 'https:') return;
  try {
    const res = await fetch(`${location.origin}/api/health`, { cache: 'no-store' });
    const data = res.ok ? await res.json() : null;
    if (data?.service === 'ai-drive-organizer' && data.configured) state.sameOriginBackend = location.origin;
  } catch { /* no backend here (e.g. GitHub Pages) */ }
}

boot().catch((e) => {
  console.error(e);
  document.getElementById('app').textContent = `The app failed to start: ${e.message}`;
});
