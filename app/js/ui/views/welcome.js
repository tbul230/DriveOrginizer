import { el, icon, toast } from '../dom.js';

export function renderWelcome(ctx) {
  const hint = (() => { try { return localStorage.getItem('driveOrganizer.loginHint') || ''; } catch { return ''; } })();
  const status = el('div', { class: 'faint', role: 'status' });
  const connectBtn = el('button', { class: 'btn primary xl', onclick: onConnect }, icon('google', 20), hint ? `Continue as ${hint}` : 'Connect Google Drive');

  async function onConnect() {
    connectBtn.disabled = true;
    status.textContent = 'Opening Google sign-in… (allow the pop-up if your browser asks)';
    try {
      await ctx.connect();
    } catch (err) {
      status.textContent = '';
      toast(err.message, 'bad', 9000);
      connectBtn.disabled = false;
    }
  }

  const setup = !ctx.clientId ? setupCard(ctx) : null;

  return el('div', { class: 'welcome' },
    el('div', { class: 'glass welcome-card fade-in' },
      el('div', { class: 'brand-mark' }, icon('sparkles', 30)),
      el('h1', { text: 'Organize your Google Drive by just describing it.' }),
      el('p', { class: 'muted', style: { marginTop: '10px', fontSize: '16.5px' } },
        'Type how you want your files arranged — by class, by school year, by project — and get a full before-and-after preview. Nothing changes until you approve it, and every change can be undone.'),
      el('ul', { class: 'promise-list' },
        ['Never deletes files', 'Never changes sharing', 'Never edits file contents', 'Preview before any change', 'Undo any move', 'Works in Chrome, nothing to install']
          .map((t) => el('li', {}, icon('check', 16), t))),
      el('h3', { text: 'To get started, connect your Google Drive', style: { marginTop: '22px' } }),
      el('p', { class: 'muted small', style: { marginTop: '6px' } }, 'You will sign in on Google’s own page (this site never sees your password). Google will ask you to allow:'),
      el('ul', { class: 'perm-list' },
        el('li', {}, icon('drive', 20), el('div', {},
          el('b', { text: 'See, edit, create and organize your Google Drive files' }),
          el('div', { class: 'faint', text: 'Needed to list every file and folder and to move files into the folders you approve. Google has no smaller permission that allows reorganizing existing files. This app only creates folders, moves files, and renames files when you explicitly ask and approve.' }))),
        el('li', {}, icon('lock', 20), el('div', {},
          el('b', { text: 'Store its own data in your Drive' }),
          el('div', { class: 'faint', text: 'A hidden app-only folder holds a backup of your organization history so Undo keeps working on any computer. It cannot see your other files through this permission.' }))),
        el('li', {}, icon('shield', 20), el('div', {},
          el('b', { text: 'See your email address' }),
          el('div', { class: 'faint', text: 'Shows which account is connected and proves to the AI service that the request comes from you.' })))),
      setup,
      el('div', { class: 'row', style: { marginTop: '8px' } }, connectBtn),
      status,
      el('p', { class: 'faint', style: { marginTop: '18px' } },
        'Privacy: when AI mode is on, file names, folder names, dates and short text excerpts of the files being organized are sent to the AI service to decide where they belong. You can turn off AI or content reading in Settings. Your Google sign-in stays in this browser tab and is never stored.')));
}

function setupCard(ctx) {
  const input = el('input', { class: 'input', placeholder: '1234567890-abc.apps.googleusercontent.com', 'aria-label': 'Google OAuth client ID' });
  return el('div', { class: 'notice info', style: { margin: '10px 0 16px' } }, icon('info'),
    el('div', { class: 'stack grow' },
      el('div', {}, el('b', { text: 'Setup needed: ' }), 'this copy of the app has no Google OAuth client ID yet. The site owner should add it to ',
        el('code', { text: 'config.js' }), ' (see docs/DEPLOYMENT.md). For testing you can paste one here — it is saved only in this browser.'),
      el('div', { class: 'row' }, input,
        el('button', { class: 'btn sm', onclick: () => {
          const v = input.value.trim();
          if (!/^[\w.-]+\.apps\.googleusercontent\.com$/.test(v)) { toast('That does not look like a Google OAuth client ID.', 'bad'); return; }
          ctx.saveSettings({ googleClientId: v });
          toast('Client ID saved.', 'ok');
          ctx.refresh();
        } }, 'Save'))));
}
