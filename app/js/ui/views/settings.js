import { el, icon, toast, modal, switchInput } from '../dom.js';
import { checkBackend } from '../../core/ai.js';
import { DEFAULT_SETTINGS, clearSettings } from '../../core/settings.js';
import { deleteDatabase } from '../../core/store.js';
import { SCOPES } from '../../core/auth.js';

export function renderSettings(view, ctx) {
  const { state } = ctx;
  const s = state.settings;
  const draw = () => { view.replaceChildren(); renderSettings(view, ctx); };
  const user = state.about?.user;
  const cfg = window.DRIVE_ORGANIZER_CONFIG || {};

  view.append(el('div', { class: 'page-head' },
    el('div', {}, el('h1', { text: 'Settings' }), el('p', { class: 'muted', text: 'Settings are saved in this browser only.' }))));

  // Account
  view.append(section('Google account',
    el('div', { class: 'row' },
      user?.photoLink && /^https:\/\//.test(user.photoLink) ? el('img', { class: 'avatar', src: user.photoLink, alt: '', referrerpolicy: 'no-referrer' }) : el('div', { class: 'avatar' }),
      el('div', { class: 'grow' }, el('b', { text: user?.displayName || 'Connected account' }), el('div', { class: 'faint', text: user?.emailAddress || '' })),
      el('button', { class: 'btn danger', onclick: async () => {
        const ok = await modal({ title: 'Disconnect Google Drive?', body: 'This signs you out and revokes this app’s access token. Your files are not affected. You can reconnect any time.',
          actions: [{ label: 'Cancel', value: false }, { label: 'Disconnect', value: true, kind: 'danger' }] });
        if (ok) { await ctx.disconnect(); toast('Disconnected from Google Drive.', 'info'); }
      } }, icon('logout', 16), 'Disconnect Google Drive')),
    el('details', { class: 'disclosure', style: { marginTop: '12px' } }, el('summary', { text: 'Permissions this app uses' }),
      el('ul', { class: 'small muted' }, SCOPES.map((sc) => el('li', {}, el('code', { text: sc })))),
      el('p', { class: 'faint', text: 'You can also remove access at any time from your Google Account → Security → Third-party apps with account access.' }))));

  // Appearance
  view.append(section('Appearance',
    el('div', { class: 'switch-row' }, el('b', { text: 'Theme' }),
      el('select', { style: { width: 'auto' }, 'aria-label': 'Theme', onchange: (e) => ctx.saveSettings({ theme: e.target.value }) },
        [['system', 'Match system'], ['light', 'Light'], ['dark', 'Dark']].map(([v, t]) => el('option', { value: v, text: t, selected: s.theme === v }))))));

  // AI
  const urlInput = el('input', { class: 'input', type: 'url', placeholder: cfg.aiBackendUrl || 'https://drive-organizer-ai.yourname.workers.dev', value: s.aiBackendUrl, 'aria-label': 'AI backend URL' });
  const testResult = el('span', { class: 'faint' });
  view.append(section('AI provider',
    el('p', { class: 'faint', text: 'The AI runs on your own secure backend (a Cloudflare Worker) that holds the AI API key. The key is never sent to or stored in this website. See docs/DEPLOYMENT.md.' }),
    row('Use AI to plan organization', 'When off, basic mode uses keyword rules on names, types, dates and contents.', switchInput({ checked: s.useAI, label: 'Use AI', onchange: (v) => ctx.saveSettings({ useAI: v }) })),
    el('label', { class: 'field', style: { marginTop: '10px' } }, el('span', {}, 'AI backend URL ', el('span', { class: 'faint', text: cfg.aiBackendUrl ? `(default from config.js: ${cfg.aiBackendUrl})` : '(none in config.js)' })), urlInput),
    el('div', { class: 'row', style: { marginTop: '10px' } },
      el('button', { class: 'btn sm', onclick: () => {
        const v = urlInput.value.trim();
        if (v && !/^https:\/\/[^\s]+$/.test(v)) { toast('The backend URL must start with https://', 'bad'); return; }
        ctx.saveSettings({ aiBackendUrl: v.replace(/\/+$/, '') });
        state.organizerUi.useAI = undefined;
        toast('Saved.', 'ok');
      } }, 'Save URL'),
      el('button', { class: 'btn sm', onclick: async () => {
        testResult.textContent = 'Testing…';
        try {
          const r = await checkBackend(ctx.backendUrl, await state.auth.getToken());
          testResult.textContent = r.configured ? `Connected ✓ (model: ${r.model})` : 'Reached the backend, but it is missing its API key or Google client ID.';
        } catch (e) { testResult.textContent = `Not reachable: ${e.message}`; }
      } }, 'Test connection'), testResult),
    row('AI batch size', 'How many files are sent to the AI per request. Lower it if you see “response was cut off”.',
      numberInput(s.aiChunkSize, 20, 300, (v) => ctx.saveSettings({ aiChunkSize: v }))),
    row('Read document contents', 'Read the beginning of Docs, Sheets, Slides, PDFs and text files (read-only) to classify them.',
      switchInput({ checked: s.readContents, label: 'Read document contents', onchange: (v) => ctx.saveSettings({ readContents: v }) })),
    row('Max files to read per analysis', 'Limits downloads on very large Drives.', numberInput(s.maxContentFiles, 0, 20000, (v) => ctx.saveSettings({ maxContentFiles: v }))),
    row('Characters read per file', 'Longer excerpts can improve accuracy but cost more AI tokens.', numberInput(s.snippetChars, 100, 2500, (v) => ctx.saveSettings({ snippetChars: v }))),
    row('Largest PDF to read (MB)', 'Bigger PDFs are classified by name and dates only.', numberInput(s.pdfMaxMB, 1, 50, (v) => ctx.saveSettings({ pdfMaxMB: v })))));

  // Safety
  const reviewInput = el('input', { class: 'input', style: { maxWidth: '240px' }, value: s.needsReviewFolder, 'aria-label': 'Needs review folder name',
    onchange: (e) => { const v = e.target.value.trim().replace(/\//g, '-'); if (v) ctx.saveSettings({ needsReviewFolder: v }); } });
  view.append(section('Organization safety',
    el('div', { class: 'notice ok', style: { marginBottom: '8px' } }, icon('shield'),
      'Always on, cannot be disabled: never delete files, never empty the trash, never change sharing or ownership, never edit file contents, never overwrite files, never act without your approval, never create circular folders, and record every failure.'),
    row('When a file with the same name exists in the destination', 'Google Drive never overwrites — both copies are kept side by side. Choose whether such moves start unticked in the preview.',
      el('select', { style: { width: 'auto' }, 'aria-label': 'Conflict handling', onchange: (e) => ctx.saveSettings({ conflictPolicy: e.target.value }) },
        [['skip', 'Skip (untick) by default'], ['keepBoth', 'Keep both by default']].map(([v, t]) => el('option', { value: v, text: t, selected: s.conflictPolicy === v })))),
    row('Move uncertain files to a review folder', 'If off, uncertain files are only listed and stay where they are.',
      switchInput({ checked: s.useNeedsReviewFolder, label: 'Use review folder', onchange: (v) => ctx.saveSettings({ useNeedsReviewFolder: v }) })),
    row('Review folder name', 'Created at the top of My Drive when needed.', reviewInput),
    row('Allow renames you explicitly ask for', 'Renames are only proposed when your instructions ask for them, and each one still needs approval.',
      switchInput({ checked: s.allowRenames, label: 'Allow renames', onchange: (v) => ctx.saveSettings({ allowRenames: v }) })),
    row('Allow moving whole folders', 'Lets the organizer keep existing folder structures intact by moving a folder as a unit.',
      switchInput({ checked: s.allowFolderMoves, label: 'Allow folder moves', onchange: (v) => ctx.saveSettings({ allowFolderMoves: v }) })),
    row('Include files owned by other people', 'Files others own that sit in your My Drive. Moving them only changes where they appear for you.',
      switchInput({ checked: s.includeNotOwned, label: 'Include files owned by others', onchange: (v) => ctx.saveSettings({ includeNotOwned: v }) }))));

  // History & data
  view.append(section('Organization history & data',
    row('Back up history to Google Drive', 'Keeps a copy in this app’s hidden app folder in your Drive so Undo works on other computers too.',
      switchInput({ checked: s.backupHistoryToDrive, label: 'Back up history', onchange: (v) => ctx.saveSettings({ backupHistoryToDrive: v }) })),
    el('div', { class: 'row', style: { marginTop: '12px' } },
      el('button', { class: 'btn', onclick: () => ctx.navigate('history') }, icon('history', 16), 'Open Organization History'),
      el('button', { class: 'btn danger', onclick: async () => {
        const ok = await modal({ title: 'Clear history in this browser?', body: 'This removes the local record of past runs, which you need for Undo. Your files are not affected. A Drive backup (if enabled) is kept and will be restored next time you connect.',
          actions: [{ label: 'Cancel', value: false }, { label: 'Clear history', value: true, kind: 'danger' }] });
        if (ok) { await state.history.clear(); toast('Local history cleared.', 'info'); }
      } }, icon('trash', 16), 'Clear local history'),
      el('button', { class: 'btn danger', onclick: async () => {
        const ok = await modal({ title: 'Clear all app data in this browser?', body: 'Removes settings, cached document excerpts, saved plans and local history from this browser, then signs you out. Your Google Drive files are not affected.',
          actions: [{ label: 'Cancel', value: false }, { label: 'Clear everything', value: true, kind: 'danger' }] });
        if (!ok) return;
        for (const store of ['runs', 'ops', 'plans', 'snippets']) { try { await state.store.clear(store); } catch { /* ignore */ } }
        await deleteDatabase();
        clearSettings();
        Object.assign(state.settings, DEFAULT_SETTINGS);
        await ctx.disconnect();
        location.reload();
      } }, icon('trash', 16), 'Clear all local app data')),
    el('p', { class: 'faint', style: { marginTop: '10px' }, text: 'Cached document excerpts are stored only in this browser to avoid downloading files twice.' })));

  // Developer
  const cid = el('input', { class: 'input', value: s.googleClientId, placeholder: cfg.googleClientId || 'xxxx.apps.googleusercontent.com', 'aria-label': 'Google OAuth client ID override' });
  view.append(section('Developer',
    el('label', { class: 'field' }, el('span', {}, 'Google OAuth client ID override ', el('span', { class: 'faint', text: '(leave empty to use config.js)' })), cid),
    el('div', { class: 'row', style: { marginTop: '10px' } }, el('button', { class: 'btn sm', onclick: () => {
      const v = cid.value.trim();
      if (v && !/^[\w.-]+\.apps\.googleusercontent\.com$/.test(v)) { toast('That does not look like a Google OAuth client ID.', 'bad'); return; }
      ctx.saveSettings({ googleClientId: v });
      toast('Saved. Reconnect to use the new client ID.', 'ok');
      draw();
    } }, 'Save'))));
}

function section(title, ...children) {
  return el('section', { class: 'glass card' }, el('h2', { text: title, style: { marginBottom: '10px' } }), ...children);
}

function row(title, desc, control) {
  return el('div', { class: 'switch-row' }, el('div', { class: 'grow' }, el('b', { text: title }), desc ? el('div', { class: 'faint', text: desc }) : null), control);
}

function numberInput(value, min, max, onSave) {
  return el('input', { class: 'input', type: 'number', min: String(min), max: String(max), value: String(value), style: { width: '110px' },
    onchange: (e) => {
      const v = Math.round(Number(e.target.value));
      if (!Number.isFinite(v) || v < min || v > max) { toast(`Enter a number from ${min} to ${max}.`, 'bad'); e.target.value = String(value); return; }
      onSave(v);
      toast('Saved.', 'ok', 1500);
    } });
}
