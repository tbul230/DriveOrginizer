// Unit / integration tests for the core logic against a fake Drive API.
// Run with: npm test   (Node 20+, no dependencies)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeDrive } from './fakeDrive.js';
import { DriveClient, DriveError } from '../app/js/core/drive.js';
import { scanDrive } from '../app/js/core/scanner.js';
import { normalizeDestination, schoolYear, escapeQuery } from '../app/js/core/paths.js';
import { findDuplicates, normalizeName } from '../app/js/core/duplicates.js';
import { planWithRules, parseInstruction } from '../app/js/core/rules.js';
import { buildPlan, foldersNeeded, PreviewModel, planSummary } from '../app/js/core/plan.js';
import { executePlan } from '../app/js/core/executor.js';
import { undoEntries } from '../app/js/core/undo.js';
import { History } from '../app/js/core/history.js';
import { openStore } from '../app/js/core/store.js';
import { extractSnippets } from '../app/js/core/content.js';
import { planWithAI } from '../app/js/core/ai.js';
import { DEFAULT_SETTINGS } from '../app/js/core/settings.js';

const settings = { ...DEFAULT_SETTINGS };
const noSleep = async () => {};

function client(fake, opts = {}) {
  return new DriveClient({ getToken: () => fake.token, fetchImpl: fake.fetch, sleep: noSleep, writeSpacingMs: 0, ...opts });
}

async function setup(build) {
  const fake = new FakeDrive();
  build?.(fake);
  const c = client(fake);
  const index = await scanDrive(c);
  const store = await openStore({ forceMemory: true });
  const history = new History(store);
  return { fake, c, index, store, history };
}

function assertNoDangerousCalls(fake) {
  for (const r of fake.requests) {
    assert.notEqual(r.method, 'DELETE', 'DELETE must never be called');
    assert.ok(!r.path.includes('emptyTrash'), 'emptyTrash must never be called');
    assert.ok(!r.path.includes('permissions'), 'permissions must never be changed');
    if (r.method === 'PATCH' && !r.path.startsWith('/upload/')) {
      const body = r.body ? JSON.parse(r.body) : {};
      assert.ok(Object.keys(body).every((k) => ['name', 'trashed'].includes(k)), `unexpected update body ${r.body}`);
    }
  }
}

// ---------------- paths ----------------

test('normalizeDestination cleans and rejects unsafe paths', () => {
  assert.equal(normalizeDestination(' School / Math '), 'School/Math');
  assert.equal(normalizeDestination('My Drive/School'), 'School');
  assert.equal(normalizeDestination('School//Math/'), 'School/Math');
  assert.equal(normalizeDestination(''), '');
  assert.equal(normalizeDestination('School/../x'), null);
  assert.equal(normalizeDestination('a/b/c/d/e/f/g/h/i'), null);
  assert.equal(normalizeDestination(42), null);
  assert.equal(normalizeDestination('Sch\u0000ool'), 'School');
  assert.equal(schoolYear('2024-09-01'), '2024-2025');
  assert.equal(schoolYear('2025-03-01'), '2024-2025');
  assert.equal(escapeQuery("Bob's \\ file"), "Bob\\'s \\\\ file");
});

// ---------------- scanning & pagination ----------------

test('scan follows every page and builds nested structure', async () => {
  const fake = new FakeDrive({ pageSizeCap: 1000 });
  const school = fake.folder('School');
  const math = fake.folder('Math', school);
  for (let i = 0; i < 2500; i++) fake.add(`File ${i}`, { parent: i % 2 ? math : undefined });
  fake.add('Shared thing', { parent: 'someone-elses-folder', ownedByMe: false }); // not in My Drive
  fake.add('Trashed', { trashed: true });
  let pages = 0;
  const index = await scanDrive(client(fake), { onProgress: (p) => { pages = p.pages; } });
  assert.equal(pages, 3, 'should read 3 pages of 1000');
  const s = index.stats();
  assert.equal(s.files, 2500);
  assert.equal(s.folders, 2);
  assert.equal(s.outside, 1, 'shared-with-me item must be excluded from My Drive');
  assert.equal(index.relPathOf(math), 'School/Math');
  assert.equal(index.childrenOf(math).length, 1250);
  assert.ok(![...index.items.values()].some((f) => f.name === 'Trashed'));
});

test('large drive: 10,000 files scanned without skipping', async () => {
  const fake = new FakeDrive({ pageSizeCap: 1000 });
  const folders = [];
  for (let i = 0; i < 50; i++) folders.push(fake.folder(`Folder ${i}`, i ? folders[Math.floor(i / 2)] : undefined));
  for (let i = 0; i < 10000; i++) fake.add(`doc ${i}`, { parent: folders[i % 50] });
  const t0 = Date.now();
  const index = await scanDrive(client(fake));
  assert.equal(index.stats().files, 10000);
  assert.equal(index.stats().folders, 50);
  assert.equal(index.pagesScanned, 11);
  assert.ok(Date.now() - t0 < 5000, 'scan + index of 10k items should be fast');
});

// ---------------- retries & errors ----------------

test('client retries rate limits and server errors, not client errors', async () => {
  const fake = new FakeDrive();
  fake.add('a');
  const c = client(fake);
  fake.failNext((m, p) => m === 'GET' && p === '/drive/v3/files', 429, 'rateLimitExceeded', 2);
  fake.failNext((m, p) => m === 'GET' && p === '/drive/v3/files', 403, 'userRateLimitExceeded', 1);
  fake.failNext((m, p) => m === 'GET' && p === '/drive/v3/files', 503, 'backendError', 1);
  const res = await c.listPage({ q: 'trashed = false', pageSize: 10, fields: 'files(id)' });
  assert.equal(res.files.length, 1);
  assert.equal(c.stats.retries, 4);

  fake.failNext((m) => m === 'GET', 400, 'badRequest', 1);
  await assert.rejects(() => c.about(), (e) => e instanceof DriveError && e.status === 400);

  fake.failNext((m) => m === 'GET', 403, 'insufficientFilePermissions', 1);
  await assert.rejects(() => c.about(), (e) => e.status === 403 && e.reason === 'insufficientFilePermissions');

  fake.failNext((m) => m === 'GET', 500, 'backendError', 99);
  await assert.rejects(() => c.about(), (e) => e.status === 500);
  fake.failures = [];
});

test('client refreshes the token once on 401', async () => {
  const fake = new FakeDrive();
  let token = 'expired';
  let refreshed = 0;
  const c = new DriveClient({ getToken: () => token, refreshToken: async () => { refreshed++; token = 'test-token'; }, fetchImpl: fake.fetch, sleep: noSleep });
  const about = await c.about();
  assert.equal(about.user.emailAddress, 'student@example.com');
  assert.equal(refreshed, 1);
});

test('createFolder recovers from a network failure without creating duplicates', async () => {
  const fake = new FakeDrive();
  const c = client(fake);
  // Simulate: server created the folder but the response was lost.
  const origFetch = fake.fetch;
  let first = true;
  c.fetchImpl = async (url, init) => {
    if (first && init.method === 'POST') { first = false; await origFetch(url, init); throw new TypeError('Failed to fetch'); }
    return origFetch(url, init);
  };
  const f = await c.createFolder('School', fake.rootId);
  assert.ok(f.id);
  assert.equal(fake.childrenOf(fake.rootId).filter((x) => x.name === 'School').length, 1);
});

// ---------------- duplicates ----------------

test('duplicate detection by hash, normalized name and size', () => {
  assert.equal(normalizeName('Copy of Essay (1).docx'), 'essay.docx');
  assert.equal(normalizeName('Essay - Copy.docx'), 'essay.docx');
  const items = [
    { id: '1', name: 'a.pdf', mimeType: 'application/pdf', md5Checksum: 'x', size: '10' },
    { id: '2', name: 'other name.pdf', mimeType: 'application/pdf', md5Checksum: 'x', size: '10' },
    { id: '3', name: 'Report.docx', mimeType: 'w', md5Checksum: 'y', size: '50' },
    { id: '4', name: 'Copy of Report.docx', mimeType: 'w', md5Checksum: 'z', size: '50' },
    { id: '5', name: 'Notes', mimeType: 'application/vnd.google-apps.document' },
    { id: '6', name: 'Copy of Notes', mimeType: 'application/vnd.google-apps.document' },
    { id: '7', name: 'Unique', mimeType: 'application/vnd.google-apps.document' },
  ];
  const groups = findDuplicates(items);
  assert.deepEqual(groups.map((g) => [g.confidence, g.fileIds.sort().join(',')]),
    [['exact', '1,2'], ['likely', '3,4'], ['possible', '5,6']]);
});

// ---------------- rules / basic mode ----------------

test('basic mode classifies by subject, school year and sends unknown schoolwork to review', async () => {
  const { index, c, store } = await setup((f) => {
    f.add('Algebra Homework 3', { created: '2023-10-02T00:00:00Z' });
    f.add('Untitled document', { content: 'Lab report: photosynthesis experiment hypothesis', created: '2024-02-01T00:00:00Z' });
    f.add('The Great Gatsby essay.pdf', { mimeType: 'application/pdf', content: 'x', created: '2024-09-10T00:00:00Z' });
    f.add('Homework week 5', {});
    f.add('Vacation photo.jpg', { mimeType: 'image/jpeg', content: 'jpg' });
  });
  const instr = 'Organize my school assignments into folders by subject. Separate English, Math, Science, History, Spanish, and other subjects. Within each subject, organize files by school year.';
  const parsed = parseInstruction(instr);
  assert.ok(parsed.intent.byYear && parsed.intent.school);
  assert.deepEqual(parsed.categories.slice(0, 5), ['English', 'Math', 'Science', 'History', 'Spanish']);
  const snippets = await extractSnippets(c, index.myDriveItems(), { store });
  const p = planWithRules(index, index.myDriveItems(), instr, snippets);
  const dest = Object.fromEntries(p.moves.map((m) => [index.get(m.fileId).name, m.destination]));
  assert.equal(dest['Algebra Homework 3'], 'School/Math/2023-2024');
  assert.equal(dest['Untitled document'], 'School/Science/2023-2024', 'content excerpt should be used, not only the file name');
  assert.equal(dest['The Great Gatsby essay.pdf'], 'School/English/2024-2025');
  assert.deepEqual(p.needsReview.map((r) => index.get(r.fileId).name), ['Homework week 5']);
  assert.ok(!dest['Vacation photo.jpg'], 'unrelated files stay put');
});

test('basic mode flags stale files without moving them', async () => {
  const { index } = await setup((f) => {
    f.add('old', { created: '2019-01-01T00:00:00Z', viewed: '2019-02-01T00:00:00Z' });
    f.add('new', { created: '2026-10-01T00:00:00Z', viewed: '2026-11-01T00:00:00Z' });
  });
  const p = planWithRules(index, index.myDriveItems(), "Find files I haven't opened in a long time", new Map(), { now: Date.parse('2026-11-10') });
  assert.deepEqual(p.flagged.map((x) => index.get(x.fileId).name), ['old']);
  assert.equal(p.moves.length, 0);
});

// ---------------- plan validation ----------------

test('plan validation rejects unsafe, circular, unknown and duplicate proposals', async () => {
  const ids = {};
  const { index } = await setup((f) => {
    ids.school = f.folder('School');
    ids.math = f.folder('Math', ids.school);
    ids.algebra = f.folder('Algebra', ids.math);
    ids.hw = f.add('hw.docx', { mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', content: 'x' });
    ids.existing = f.add('notes', { parent: ids.math });
    ids.notes2 = f.add('notes', {});
    ids.locked = f.add('locked', { canMove: false });
    ids.already = f.add('already', { parent: ids.math });
    ids.other = f.add('theirs', { ownedByMe: false });
  });
  const proposals = {
    moves: [
      { fileId: ids.hw, destination: 'School/Math', reason: 'math', confidence: 'high' },
      { fileId: ids.hw, destination: 'School/English', reason: 'dup proposal' },
      { fileId: 'nope', destination: 'X' },
      { fileId: index.rootId, destination: 'X' },
      { fileId: ids.school, destination: 'School/Math/Algebra/Sub' }, // circular
      { fileId: ids.math, destination: 'School/Math' }, // into itself
      { fileId: ids.notes2, destination: 'school/math' }, // conflict with existing "notes" (case-insensitive folder match)
      { fileId: ids.locked, destination: 'X' },
      { fileId: ids.already, destination: 'School/Math' }, // no-op
      { fileId: ids.other, destination: '../../etc' },
    ],
    renames: [{ fileId: ids.hw, newName: 'Math HW 1', reason: 'asked' }],
    needsReview: [],
  };
  const plan = buildPlan(index, proposals, { settings });
  const moves = plan.ops.filter((o) => o.type === 'move');
  assert.deepEqual(moves.map((o) => index.get(o.fileId).name).sort(), ['hw.docx', 'notes']);
  const conflict = moves.find((o) => o.fileId === ids.notes2);
  assert.ok(conflict.conflict && !conflict.approved, 'conflicts start unapproved with the skip policy');
  assert.equal(conflict.destFolderId, ids.math, 'existing folder matched case-insensitively');
  const reasons = plan.rejected.map((r) => r.reason).join('\n');
  assert.match(reasons, /Unknown file id/);
  assert.match(reasons, /root cannot be moved/);
  assert.match(reasons, /circular/);
  assert.match(reasons, /permission/);
  assert.match(reasons, /unsafe destination/);
  assert.ok(plan.warnings.some((w) => w.includes('more than once')));
  const rename = plan.ops.find((o) => o.type === 'rename');
  assert.equal(rename.newName, 'Math HW 1.docx', 'file extension is preserved');

  const p2 = buildPlan(index, { moves: [{ fileId: ids.other, destination: 'Shared' }] }, { settings: { ...settings, includeNotOwned: false } });
  assert.match(p2.rejected[0].reason, /owned by someone else/);
  const p3 = buildPlan(index, { renames: [{ fileId: ids.hw, newName: 'x' }] }, { settings: { ...settings, allowRenames: false } });
  assert.equal(p3.ops.length, 0);
});

test('preview model shows before/after trees lazily', async () => {
  const ids = {};
  const { index } = await setup((f) => {
    ids.rand = f.folder('Random Folder');
    ids.doc1 = f.add('Document1.pdf', { mimeType: 'application/pdf', content: '?' });
    ids.mh = f.add('Math Homework.docx', { mimeType: 'application/msword', content: 'm' });
    ids.sn = f.add('Science Notes.pdf', { mimeType: 'application/pdf', content: 's' });
    ids.he = f.add('History Essay.docx', { mimeType: 'application/msword', content: 'h', parent: ids.rand });
  });
  const plan = buildPlan(index, {
    moves: [
      { fileId: ids.mh, destination: 'School/Math' }, { fileId: ids.sn, destination: 'School/Science' },
      { fileId: ids.he, destination: 'School/History' },
    ],
    needsReview: [{ fileId: ids.doc1, reason: 'unclear' }],
  }, { settings });
  assert.deepEqual(foldersNeeded(index, plan), ['Needs Review', 'School', 'School/History', 'School/Math', 'School/Science']);
  const m = new PreviewModel(index, plan);
  const rootAfter = m.childrenAfter(index.rootId).map((c) => `${c.name}:${c.status}`).sort();
  assert.deepEqual(rootAfter, ['Needs Review:new', 'Random Folder:same', 'School:new']);
  const school = m.childrenAfter('new:school').map((c) => c.name).sort();
  assert.deepEqual(school, ['History', 'Math', 'Science']);
  assert.deepEqual(m.childrenAfter('new:school/math').map((c) => `${c.name}:${c.status}`), ['Math Homework.docx:moved-in']);
  assert.deepEqual(m.childrenAfter('new:needs review').map((c) => `${c.name}:${c.status}`), ['Document1.pdf:review']);
  assert.deepEqual(m.childrenAfter(ids.rand), []);
  assert.ok(m.childrenBefore(index.rootId).find((c) => c.name === 'Math Homework.docx').status === 'moving-out');
  // Un-approving an op updates the model.
  plan.ops.find((o) => o.fileId === ids.he).approved = false;
  m.rebuild();
  assert.deepEqual(m.childrenAfter(ids.rand).map((c) => c.name), ['History Essay.docx']);
  assert.equal(planSummary(index, plan, 4).moves, 2);
});

// ---------------- execution ----------------

test('executes approved plan: creates nested folders once, moves files, records history', async () => {
  const ids = {};
  const { fake, c, index, history } = await setup((f) => {
    ids.school = f.folder('School');
    ids.a = f.add('Algebra 1', {});
    ids.b = f.add('Geometry 2', {});
    ids.c = f.add('Bio lab', {});
    ids.skip = f.add('Not approved', {});
  });
  const plan = buildPlan(index, { moves: [
    { fileId: ids.a, destination: 'School/Math/2024-2025' },
    { fileId: ids.b, destination: 'School/Math/2024-2025' },
    { fileId: ids.c, destination: 'School/Science' },
    { fileId: ids.skip, destination: 'School/Other' },
  ] }, { settings });
  plan.ops.find((o) => o.fileId === ids.skip).approved = false;
  const saved = [];
  const run = await executePlan({ client: c, index, plan, history, savePlan: async (p) => saved.push(p.status) });
  assert.equal(run.status, 'completed');
  assert.equal(run.counts.success, 6, '3 folders + 3 moves');
  assert.equal(fake.pathOf(ids.a), 'School/Math/2024-2025/Algebra 1');
  assert.equal(fake.pathOf(ids.c), 'School/Science/Bio lab');
  assert.equal(fake.pathOf(ids.skip), 'Not approved', 'unapproved op must not run');
  assert.equal(fake.childrenOf(ids.school).filter((x) => x.name === 'Math').length, 1);
  assert.ok(!fake.childrenOf(ids.school).some((x) => x.name === 'Other'), 'folders for unapproved ops are not created');
  const entries = await history.entriesForRun(run.runId);
  assert.equal(entries.filter((e) => e.type === 'move').length, 3);
  assert.ok(entries.every((e) => e.status === 'success'));
  assert.equal(plan.status, 'completed');
  await assert.rejects(() => executePlan({ client: c, index, plan, history }), /already completed/);
  assertNoDangerousCalls(fake);
});

test('execution re-checks live state: skips files changed since preview, records failures, never forces', async () => {
  const ids = {};
  const { fake, c, index, history } = await setup((f) => {
    ids.dest = f.folder('Dest');
    ids.moved = f.add('moved meanwhile', {});
    ids.trashed = f.add('trashed meanwhile', {});
    ids.clash = f.add('clash', {});
    ids.ok = f.add('fine', {});
    ids.err = f.add('server error', {});
  });
  const plan = buildPlan(index, { moves: [ids.moved, ids.trashed, ids.clash, ids.ok, ids.err].map((id) => ({ fileId: id, destination: 'Dest' })) }, { settings });
  // Changes made in Drive after the preview:
  const elsewhere = fake.folder('Elsewhere');
  fake.files.get(ids.moved).parents = [elsewhere];
  fake.files.get(ids.trashed).trashed = true;
  fake.add('clash', { parent: ids.dest });
  fake.failNext((m, p) => m === 'PATCH' && p.endsWith(ids.err), 400, 'badRequest', 1);
  const run = await executePlan({ client: c, index, plan, history });
  const byName = Object.fromEntries((await history.entriesForRun(run.runId)).map((e) => [e.fileName, e]));
  assert.equal(byName['moved meanwhile'].status, 'skipped');
  assert.equal(byName['trashed meanwhile'].status, 'skipped');
  assert.equal(byName.clash.status, 'skipped');
  assert.equal(byName.fine.status, 'success');
  assert.equal(byName['server error'].status, 'failed');
  assert.equal(run.status, 'completed-with-errors');
  assert.equal(fake.pathOf(ids.moved), 'Elsewhere/moved meanwhile');
  assertNoDangerousCalls(fake);
});

test('folder moves are cycle-checked against the live Drive', async () => {
  const ids = {};
  const { fake, c, index, history } = await setup((f) => {
    ids.a = f.folder('A');
    ids.b = f.folder('B');
  });
  const plan = buildPlan(index, { moves: [{ fileId: ids.a, destination: 'B' }] }, { settings });
  assert.equal(plan.ops.length, 1);
  fake.files.get(ids.b).parents = [ids.a]; // someone moved B inside A after the preview
  const run = await executePlan({ client: c, index, plan, history });
  const [entry] = (await history.entriesForRun(run.runId)).filter((e) => e.type === 'move');
  assert.equal(entry.status, 'failed');
  assert.match(entry.error, /circular/);
  assert.equal(fake.files.get(ids.a).parents[0], fake.rootId);
});

test('stopping a run records the remaining operations as not run', async () => {
  const { fake, c, index, history } = await setup((f) => { for (let i = 0; i < 10; i++) f.add(`f${i}`); });
  const plan = buildPlan(index, { moves: index.myDriveItems().map((it) => ({ fileId: it.id, destination: 'Box' })) }, { settings });
  const ac = new AbortController();
  const run = await executePlan({ client: c, index, plan, history, signal: ac.signal, onProgress: (p) => { if (p.done === 4) ac.abort(); } });
  assert.equal(run.status, 'stopped');
  const entries = await history.entriesForRun(run.runId);
  assert.equal(entries.filter((e) => e.status === 'cancelled').length + entries.filter((e) => e.type === 'move' && e.status === 'success').length, 10);
  assert.ok(entries.some((e) => e.status === 'cancelled'));
  assert.equal(fake.childrenOf(fake.rootId).filter((x) => x.name.startsWith('f')).length + fake.childrenOf(fake.childrenOf(fake.rootId).find((x) => x.name === 'Box').id).length, 10);
});

test('expired Google session pauses the run and it can be resumed', async () => {
  const { fake, c, index, history } = await setup((f) => { for (let i = 0; i < 6; i++) f.add(`f${i}`); });
  const plan = buildPlan(index, { moves: index.myDriveItems().map((it) => ({ fileId: it.id, destination: 'Box' })) }, { settings });
  let calls = 0;
  const realToken = fake.token;
  const flaky = new DriveClient({ getToken: () => (++calls > 8 ? 'expired' : realToken), refreshToken: async () => { throw new Error('popup blocked'); }, fetchImpl: fake.fetch, sleep: noSleep, writeSpacingMs: 0 });
  const run1 = await executePlan({ client: flaky, index, plan, history });
  assert.equal(run1.status, 'paused');
  assert.equal(plan.status, 'paused');
  const remaining = plan.ops.filter((o) => o.status === 'pending').length;
  assert.ok(remaining > 0 && remaining < 6);
  const index2 = await scanDrive(c);
  const run2 = await executePlan({ client: c, index: index2, plan, history });
  assert.equal(run2.status, 'completed');
  const box = fake.childrenOf(fake.rootId).filter((x) => x.name === 'Box');
  assert.equal(box.length, 1, 'resume must reuse the folder, not create a second one');
  assert.equal(fake.childrenOf(box[0].id).length, 6);
});

// ---------------- undo ----------------

test('undo moves files back, restores names, and handles conflicts and missing folders safely', async () => {
  const ids = {};
  const { fake, c, index, history } = await setup((f) => {
    ids.orig = f.folder('Original');
    ids.a = f.add('a', { parent: ids.orig });
    ids.b = f.add('b', { parent: ids.orig });
    ids.c = f.add('c', {});
    ids.gone = f.folder('Will be trashed');
    ids.d = f.add('d', { parent: ids.gone });
    ids.e = f.add('e', {});
  });
  const plan = buildPlan(index, {
    moves: [ids.a, ids.b, ids.c, ids.d].map((id) => ({ fileId: id, destination: 'New/Place' })),
    renames: [{ fileId: ids.e, newName: 'e renamed' }],
  }, { settings });
  const run = await executePlan({ client: c, index, plan, history });
  assert.equal(run.counts.success, 7);
  assert.equal(fake.files.get(ids.e).name, 'e renamed');
  // Changes after the run:
  fake.add('b', { parent: ids.orig });                       // name conflict at original location
  fake.files.get(ids.gone).trashed = true;                    // original folder gone
  const entries = await history.entriesForRun(run.runId);
  const res = await undoEntries({ client: c, history, entries, rootId: fake.rootId, options: {} });
  const by = Object.fromEntries(res.results.map((r) => [r.entry.fileName, r]));
  assert.equal(by.a.status, 'success');
  assert.equal(fake.files.get(ids.a).parents[0], ids.orig);
  assert.equal(by.b.code, 'conflict');
  assert.equal(by.d.code, 'missingOriginal');
  assert.equal(by.c.status, 'success');
  assert.equal(fake.files.get(ids.c).parents[0], fake.rootId);
  assert.equal(by['e'].status, 'success');
  assert.equal(fake.files.get(ids.e).name, 'e');
  assert.equal(by.Place.status, 'kept', 'created folders are kept unless asked');

  // Follow-ups chosen by the user:
  const r2 = await undoEntries({ client: c, history, entries: [by.d.entry], rootId: fake.rootId, options: { restoreToRoot: true } });
  assert.equal(r2.results[0].status, 'success');
  assert.equal(fake.files.get(ids.d).parents[0], fake.rootId);
  const r3 = await undoEntries({ client: c, history, entries: [by.b.entry], rootId: fake.rootId, options: { allowNameConflict: true } });
  assert.equal(r3.results[0].status, 'success');
  assert.equal(fake.childrenOf(ids.orig).filter((x) => x.name === 'b').length, 2, 'both kept, nothing overwritten');

  // Now the created folders are empty; trash them only when asked.
  const r4 = await undoEntries({ client: c, history, entries: await history.entriesForRun(run.runId), rootId: fake.rootId, options: { trashEmptyFolders: true } });
  assert.ok(r4.results.every((r) => r.status === 'success'));
  assert.ok([...fake.files.values()].filter((x) => x.name === 'New' || x.name === 'Place').every((x) => x.trashed));

  // A second undo is a no-op (already undone).
  const r5 = await undoEntries({ client: c, history, entries: await history.entriesForRun(run.runId), rootId: fake.rootId });
  assert.equal(r5.results.length, 0);
  assertNoDangerousCalls(fake);
});

test('undo leaves files that the user moved elsewhere afterwards', async () => {
  const ids = {};
  const { fake, c, index, history } = await setup((f) => { ids.a = f.add('a'); });
  const plan = buildPlan(index, { moves: [{ fileId: ids.a, destination: 'X' }] }, { settings });
  const run = await executePlan({ client: c, index, plan, history });
  const y = fake.folder('Y');
  fake.files.get(ids.a).parents = [y];
  const res = await undoEntries({ client: c, history, entries: await history.entriesForRun(run.runId), rootId: fake.rootId });
  assert.equal(res.results.find((r) => r.entry.type === 'move').code, 'changed');
  assert.equal(fake.files.get(ids.a).parents[0], y);
});

test('undo refuses to trash a created folder that is not empty', async () => {
  const ids = {};
  const { fake, c, index, history } = await setup((f) => { ids.a = f.add('a'); });
  const plan = buildPlan(index, { moves: [{ fileId: ids.a, destination: 'Keep' }] }, { settings });
  const run = await executePlan({ client: c, index, plan, history });
  const keep = fake.childrenOf(fake.rootId).find((x) => x.name === 'Keep');
  fake.add('user added later', { parent: keep.id });
  const res = await undoEntries({ client: c, history, entries: await history.entriesForRun(run.runId), rootId: fake.rootId, options: { trashEmptyFolders: true } });
  assert.equal(res.results.find((r) => r.entry.type === 'createFolder').code, 'notEmpty');
  assert.equal(fake.files.get(keep.id).trashed, false);
});

// ---------------- history persistence ----------------

test('history export/import and Drive appData backup round-trip', async () => {
  const ids = {};
  const { fake, c, index, history } = await setup((f) => { ids.a = f.add('a'); });
  const plan = buildPlan(index, { moves: [{ fileId: ids.a, destination: 'X' }] }, { settings });
  await executePlan({ client: c, index, plan, history });
  const json = await history.exportJSON();
  const fresh = new History(await openStore({ forceMemory: true }));
  assert.ok(await fresh.importJSON(json) >= 2);
  assert.equal((await fresh.runs()).length, 1);
  await assert.rejects(() => fresh.importJSON('{"hello":1}'), /not an AI Drive Organizer/);

  await history.backupToDrive(c);
  await history.backupToDrive(c); // second time updates the same file
  assert.equal(fake.appData.size, 1);
  const restored = new History(await openStore({ forceMemory: true }));
  assert.ok(await restored.restoreFromDrive(c) >= 2);
  assert.equal((await restored.allEntries()).length, (await history.allEntries()).length);
});

// ---------------- content reading ----------------

test('content extraction reads Docs and text files, caches, and reports unreadable files', async () => {
  const { fake, c, index, store } = await setup((f) => {
    f.add('doc', { content: 'Chapter 4 quadratic equations worksheet' });
    f.add('sheet', { mimeType: 'application/vnd.google-apps.spreadsheet', content: 'a,b\n1,2' });
    f.add('notes.txt', { mimeType: 'text/plain', content: 'plain text notes '.repeat(500) });
    f.add('pic.jpg', { mimeType: 'image/jpeg', content: 'binary' });
  });
  const snippets = await extractSnippets(c, index.myDriveItems(), { store, maxChars: 100 });
  const byName = Object.fromEntries([...snippets].map(([id, v]) => [index.get(id).name, v]));
  assert.match(byName.doc.text, /quadratic/);
  assert.match(byName.sheet.text, /a,b/);
  assert.equal(byName['notes.txt'].text.length, 100);
  assert.ok(!byName['pic.jpg'], 'images are not downloaded');
  const before = fake.requests.length;
  await extractSnippets(c, index.myDriveItems(), { store, maxChars: 100 });
  assert.equal(fake.requests.length, before, 'second pass is served from cache');
});

// ---------------- AI client ----------------

test('AI client chunks requests, maps refs to ids and ignores refs outside the batch', async () => {
  const { index } = await setup((f) => { for (let i = 0; i < 45; i++) f.add(`Math worksheet ${i}`); });
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    assert.equal(init.headers.Authorization, 'Bearer tok');
    const refs = body.items.map((i) => i.ref);
    return new Response(JSON.stringify({
      result: {
        moves: [{ file: refs[0], destination: 'School/Math', reason: 'math', confidence: 'high' }, { file: 99999, destination: 'Evil', reason: 'x', confidence: 'high' }],
        renames: [], needs_review: [{ file: refs[1], reason: 'unsure' }], flagged: [], folders_to_create: [], notes: 'ok',
      },
      usage: { input_tokens: 10, output_tokens: 5 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const out = await planWithAI({ backendUrl: 'https://ai.example.com/', token: 'tok', index, items: index.myDriveItems(), instruction: 'by subject',
    settings: { ...settings, aiChunkSize: 20 }, fetchImpl });
  assert.equal(calls.length, 3);
  assert.equal(out.moves.length, 3);
  assert.ok(out.moves.every((m) => index.get(m.fileId)));
  assert.equal(out.needsReview.length, 3);
  assert.equal(out.usage.input, 30);
  assert.deepEqual(calls[1].planned_folders, ['School/Math'], 'later batches see folders chosen earlier');
});
