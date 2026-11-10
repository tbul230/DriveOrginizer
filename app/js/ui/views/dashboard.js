import { el, icon, formatBytes, formatNumber, formatDate, statusBadge } from '../dom.js';

export function renderDashboard(view, ctx) {
  const { state } = ctx;
  const index = state.index;
  const stats = index ? index.stats() : null;
  const quota = state.about?.storageQuota;
  const user = state.about?.user;

  view.append(el('div', { class: 'page-head' },
    el('div', {}, el('h1', { text: `Welcome${user?.displayName ? `, ${user.displayName.split(' ')[0]}` : ''}` }),
      el('p', { class: 'muted', text: 'Here is an overview of your Google Drive.' })),
    el('button', { class: 'btn', onclick: () => ctx.rescan(), disabled: state.scanning || state.busy }, icon('refresh', 16), 'Scan again')));

  view.append(el('section', { class: 'glass hero-cta' },
    el('div', { class: 'stack', style: { gap: '6px', maxWidth: '560px' } },
      el('h2', { text: 'Ready when you are' }),
      el('p', { class: 'muted', text: 'Describe how you want things organized. You will see a full preview and approve every change first.' })),
    el('button', { class: 'btn primary xl', onclick: () => ctx.navigate('organizer') }, icon('sparkles', 20), 'Organize My Drive')));

  if (index?.incompleteSearch) {
    view.append(el('div', { class: 'notice', style: { marginBottom: '18px' } }, icon('alert'),
      'Google reported that the last scan may be incomplete, so some files may be missing from these numbers. Try “Scan again” later.'));
  }

  const usage = Number(quota?.usage || 0);
  const limit = Number(quota?.limit || 0);
  const pct = limit ? Math.min(100, (usage / limit) * 100) : 0;
  view.append(el('div', { class: 'grid stats' },
    statCard('Google Drive', icon('drive', 16),
      el('div', { class: 'row', style: { marginTop: '10px' } }, el('span', { class: `dot ${state.auth?.isSignedIn() ? 'ok' : 'bad'}` }),
        el('b', { text: state.auth?.isSignedIn() ? 'Connected' : 'Session expired' })),
      el('div', { class: 'sub ellipsis', text: user?.emailAddress || '' })),
    statCard('Files scanned', icon('file', 16), el('div', { class: 'value', text: stats ? formatNumber(stats.files) : '—' }),
      el('div', { class: 'sub', text: index ? `Last scan ${formatDate(index.scannedAt, true)}` : 'Not scanned yet' })),
    statCard('Folders', icon('folder', 16), el('div', { class: 'value', text: stats ? formatNumber(stats.folders) : '—' }),
      el('div', { class: 'sub', text: stats?.outside ? `${formatNumber(stats.outside)} shared item(s) not in My Drive are left alone` : 'In My Drive' })),
    statCard('Storage used', icon('storage', 16),
      el('div', { class: 'value', text: quota ? formatBytes(usage) : '—' }),
      el('div', { class: 'sub', text: quota ? (limit ? `of ${formatBytes(limit)} (${pct.toFixed(0)}%)` : 'Unlimited plan') : 'Not available for this account' }),
      limit ? el('div', { class: 'meter' }, el('i', { style: { width: `${pct}%` } })) : null),
    statCard('Need organizing', icon('inbox', 16), el('div', { class: 'value', text: stats ? formatNumber(stats.loose) : '—' }),
      el('div', { class: 'sub', text: 'Files sitting loose at the top of My Drive' }))));

  const activity = el('ul', { class: 'activity' }, el('li', { class: 'faint', text: 'Loading…' }));
  view.append(el('div', { class: 'grid two', style: { marginTop: '18px' } },
    el('section', { class: 'glass card' },
      el('div', { class: 'card-title' }, el('h2', { text: 'Recent organization activity' }),
        el('button', { class: 'btn ghost sm', onclick: () => ctx.navigate('history') }, 'View all')),
      activity),
    el('section', { class: 'glass card' },
      el('div', { class: 'card-title' }, el('h2', { text: 'Safety promises' })),
      el('ul', { class: 'activity' },
        ['Files are never deleted and the trash is never emptied',
          'Sharing, ownership and file contents are never changed',
          'Nothing moves or gets renamed without your approval',
          'Existing files are never overwritten',
          'Every operation — including failures — is recorded and can be undone']
          .map((t) => el('li', {}, icon('shield', 18), el('span', { text: t })))))));

  state.history.runs().then((runs) => {
    activity.replaceChildren();
    if (!runs.length) {
      activity.append(el('li', { class: 'faint', text: 'No changes made yet. Your organization runs will show up here.' }));
      return;
    }
    for (const r of runs.slice(0, 6)) {
      const c = r.counts || {};
      activity.append(el('li', {},
        icon(r.kind === 'undo' ? 'undo' : 'sparkles', 18),
        el('div', { class: 'grow' },
          el('div', { class: 'ellipsis', style: { fontWeight: 600 }, text: r.kind === 'undo' ? r.instruction : (r.instruction || 'Organization run') }),
          el('div', { class: 'faint', text: `${formatDate(r.createdAt, true)} · ${c.success || 0} succeeded${c.failed ? ` · ${c.failed} failed` : ''}${c.skipped ? ` · ${c.skipped} skipped` : ''}` })),
        statusBadge(r.status)));
    }
  });
}

function statCard(label, ic, ...body) {
  return el('div', { class: 'glass stat' }, el('div', { class: 'label' }, ic, label), ...body);
}
