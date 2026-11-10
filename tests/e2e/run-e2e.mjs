// End-to-end test: drives the REAL app UI in headless Chromium.
// Only Google's servers are replaced: the Google Identity Services script is
// stubbed (no real sign-in possible in CI) and www.googleapis.com is served by
// tests/fakeDrive.js. The AI backend is either absent (basic mode) or a local
// stub at https://ai.test that behaves like worker/worker.js.
//
// Run: npm run test:e2e   (needs Playwright + Chromium installed)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { FakeDrive } from '../fakeDrive.js';
import { startServer } from './static-server.mjs';

const require = createRequire(import.meta.url);
let playwright;
try { playwright = require('playwright'); } catch { playwright = require(require.resolve('playwright', { paths: [process.cwd(), '/opt/node-tools/node_modules'] })); }

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = process.env.E2E_SHOTS || path.join(HERE, 'screenshots');
fs.mkdirSync(SHOTS, { recursive: true });

const PDF = (text) => `%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 400 144]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj
4 0 obj<</Length ${text.length + 30}>>stream
BT /F1 18 Tf 20 100 Td (${text}) Tj ET
endstream endobj
5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj
trailer<</Root 1 0 R>>
%%EOF`;

const GIS_STUB = `
window.google = { accounts: { oauth2: {
  initTokenClient(cfg) { return { requestAccessToken() { setTimeout(() => cfg.callback({ access_token: 'test-token', expires_in: 3599, scope: '${['https://www.googleapis.com/auth/drive', 'https://www.googleapis.com/auth/drive.appdata', 'https://www.googleapis.com/auth/userinfo.email'].join(' ')}' }), 30); } }; },
  hasGrantedAllScopes() { return true; },
  revoke(t, cb) { cb && cb(); },
} } };`;

function buildDrive() {
  const d = new FakeDrive({ pageSizeCap: 1000 });
  const ids = {};
  ids.doc1 = d.add('Document1.pdf', { mimeType: 'application/pdf', content: PDF('Untitled scan 0042') });
  ids.mathHw = d.add('Math Homework', { content: 'Algebra 1 homework: solve each quadratic equation', created: '2024-10-01T00:00:00Z' });
  ids.sciNotes = d.add('Science Notes.pdf', { mimeType: 'application/pdf', content: PDF('Biology cell notes photosynthesis'), created: '2025-01-15T00:00:00Z' });
  ids.random = d.folder('Random Folder');
  ids.histEssay = d.add('History Essay', { parent: ids.random, content: 'The causes of World War I', created: '2023-11-20T00:00:00Z' });
  ids.spanish = d.add('Vocab list', { content: 'Spanish vocabulario unidad 3 conjugation practice', created: '2024-09-03T00:00:00Z' });
  ids.copy = d.add('Copy of Math Homework', { content: 'Algebra 1 homework: solve each quadratic equation', created: '2024-10-02T00:00:00Z' });
  ids.photo = d.add('beach.jpg', { mimeType: 'image/jpeg', content: 'jpegdata' });
  ids.photo2 = d.add('beach (1).jpg', { mimeType: 'image/jpeg', content: 'jpegdata' });
  ids.quiz = d.add('quiz 4 retake', { content: 'Name: ____ Period 3' });
  // Pagination: enough files to need several pages.
  ids.bulk = d.folder('Archive');
  for (let i = 0; i < 2300; i++) d.add(`archive item ${i}`, { parent: ids.bulk, mimeType: 'image/png', content: `png${i}` });
  return { d, ids };
}

async function main() {
  const server = await startServer(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await playwright.chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: Number(process.env.E2E_DSF || 1) });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });

  let { d, ids } = buildDrive();
  let aiRequests = 0;
  const excerpts = {};
  await context.route('https://accounts.google.com/gsi/client', (r) => r.fulfill({ status: 200, contentType: 'text/javascript', body: GIS_STUB }));
  await context.route(/\/config\.js$/, (r) => r.fulfill({ status: 200, contentType: 'text/javascript',
    body: "window.DRIVE_ORGANIZER_CONFIG = { googleClientId: 'test-client.apps.googleusercontent.com', aiBackendUrl: '' };" }));
  await context.route('https://www.googleapis.com/**', async (route) => {
    const req = route.request();
    const r = d.handle(req.method(), req.url(), await req.allHeaders(), req.postData() || '');
    await route.fulfill({ status: r.status, headers: { ...r.headers, 'access-control-allow-origin': '*' }, body: r.body });
  });
  // Stub AI backend with the same contract as worker/worker.js.
  await context.route('https://ai.test/**', async (route) => {
    const req = route.request();
    const cors = { 'access-control-allow-origin': base, 'access-control-allow-headers': 'Authorization, Content-Type', 'content-type': 'application/json' };
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    if (req.url().endsWith('/api/health')) return route.fulfill({ status: 200, headers: cors, body: JSON.stringify({ ok: true, configured: true, model: 'stub' }) });
    aiRequests++;
    assert.equal(req.headers().authorization, 'Bearer test-token');
    const body = JSON.parse(req.postData());
    for (const it of body.items) excerpts[it.name] = it.content_excerpt;
    const result = { moves: [], renames: [], needs_review: [], flagged: [], folders_to_create: [], notes: 'Stub AI' };
    for (const it of body.items) {
      const text = `${it.name} ${it.content_excerpt || ''}`.toLowerCase();
      if (/archive/.test(text) || it.type === 'folder' || it.type === 'image') continue;
      if (/algebra|math/.test(text)) result.moves.push({ file: it.ref, destination: 'School/Math/2024-2025', reason: 'Excerpt is algebra homework', confidence: 'high' });
      else if (/biology|science/.test(text)) result.moves.push({ file: it.ref, destination: 'School/Science/2024-2025', reason: 'Biology notes', confidence: 'high' });
      else if (/war|history/.test(text)) result.moves.push({ file: it.ref, destination: 'School/History/2023-2024', reason: 'WWI essay', confidence: 'high' });
      else if (/spanish/.test(text)) result.moves.push({ file: it.ref, destination: 'School/Spanish/2024-2025', reason: 'Spanish vocabulary', confidence: 'high' });
      else result.needs_review.push({ file: it.ref, reason: 'Could not tell the subject' });
    }
    return route.fulfill({ status: 200, headers: cors, body: JSON.stringify({ result, usage: { input_tokens: 100, output_tokens: 50 } }) });
  });

  const step = (msg) => console.log(`• ${msg}`);
  const shot = async (name) => { await page.waitForTimeout(700); await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: false }); };
  const writes = () => d.writes().filter((w) => !w.path.startsWith('/upload/'));

  // 1. Welcome + connect
  await page.goto(base);
  await page.getByRole('button', { name: /Connect Google Drive/ }).waitFor();
  assert.ok(await page.getByText('See, edit, create and organize your Google Drive files').isVisible(), 'permissions are explained');
  await shot('01-welcome');
  step('welcome screen explains permissions');
  await page.getByRole('button', { name: /Connect Google Drive/ }).click();
  await page.getByRole('heading', { name: /Welcome, Test/ }).waitFor({ timeout: 20000 });
  await page.waitForSelector('.fullscreen-progress', { state: 'detached' });
  const filesValue = await page.locator('.stat', { hasText: 'Files scanned' }).locator('.value').textContent();
  assert.equal(filesValue.replace(/[^\d]/g, ''), String(2309), 'all files across 3 pages are counted');
  assert.equal(d.requests.filter((r) => r.path === '/drive/v3/files' && r.query.q === 'trashed = false').length, 3, 'three pages fetched');
  await shot('02-dashboard');
  step('connected; scanned 2,309 files over 3 pages');

  // 2. Organizer, basic mode, then cancel => no writes
  await page.getByRole('button', { name: 'Organize My Drive' }).click();
  const prompt = page.getByLabel('Organization instructions');
  await page.getByRole('button', { name: /Organize my Google Drive\. Put all/ }).click();
  assert.match(await prompt.inputValue(), /school year/);
  await page.getByRole('button', { name: /Analyze & build preview/ }).click();
  await page.getByRole('heading', { name: 'Your organization plan' }).waitFor({ timeout: 30000 });
  assert.equal(writes().length, 0, 'analysis must not write anything');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Discard plan' }).click();
  await page.getByLabel('Organization instructions').waitFor();
  assert.equal(writes().length, 0, 'cancel must not write anything');
  step('basic-mode plan built and cancelled with zero writes');

  // 3. Basic mode: analyze, inspect preview, untick one, approve
  await page.getByRole('button', { name: /Analyze & build preview/ }).click();
  await page.getByRole('heading', { name: 'Your organization plan' }).waitFor({ timeout: 30000 });
  const after = page.locator('.tree-panel', { hasText: 'After' });
  await after.getByText('School', { exact: true }).waitFor();
  assert.ok(await after.locator('.node.st-new', { hasText: 'Math' }).count() >= 1, 'new Math folder in after tree');
  assert.ok(await after.locator('.node.st-moved-in', { hasText: 'Math Homework' }).first().isVisible());
  await shot('03-preview-tree');
  await page.getByRole('tab', { name: /All changes/ }).click();
  const rows = page.locator('table.tbl tbody tr');
  const nRows = await rows.count();
  assert.ok(nRows >= 4, `expected several changes, got ${nRows}`);
  const spanishRow = rows.filter({ hasText: 'Vocab list' });
  await spanishRow.locator('input[type=checkbox]').uncheck();
  await shot('04-preview-changes');
  await page.getByRole('tab', { name: /Duplicates/ }).click();
  await page.getByText('Exact match').first().waitFor();
  step(`preview shows ${nRows} changes, before/after trees and duplicates`);
  await page.getByRole('button', { name: /Approve & Organize/ }).click();
  await page.getByRole('button', { name: 'Organize now' }).click();
  await page.getByRole('heading', { name: /Organizing finished/ }).waitFor({ timeout: 30000 });
  await page.waitForSelector('.fullscreen-progress', { state: 'detached' });
  await shot('05-done');
  assert.match(d.pathOf(ids.mathHw), /^School\/Math\/2024-2025\/Math Homework$/);
  assert.match(d.pathOf(ids.sciNotes), /^School\/Science\/2024-2025\//, 'PDF classified by its text content');
  assert.match(d.pathOf(ids.histEssay), /^School\/History\/2023-2024\//);
  assert.equal(d.pathOf(ids.spanish), 'Vocab list', 'unticked change was not applied');
  assert.equal(d.pathOf(ids.photo), 'beach.jpg', 'unrelated file untouched');
  assert.ok(!d.requests.some((r) => r.method === 'DELETE'), 'no DELETE ever');
  step('approved run moved files into School/<Subject>/<Year>; unticked file stayed');

  // 4. History + undo
  await page.getByRole('button', { name: /See details \/ undo in History/ }).click();
  await page.getByRole('heading', { name: 'Organization History' }).waitFor();
  await page.getByText('Math Homework', { exact: true }).first().waitFor();
  await shot('06-history');
  await page.getByRole('button', { name: /Undo run/ }).first().click();
  await page.locator('.modal input[type=checkbox]').check();
  await page.locator('.modal').getByRole('button', { name: 'Undo', exact: true }).click();
  await page.locator('.toast', { hasText: 'Undo finished' }).waitFor({ timeout: 30000 });
  await page.waitForSelector('.fullscreen-progress', { state: 'detached' });
  assert.equal(d.pathOf(ids.mathHw), 'Math Homework', 'undo moved file back');
  assert.equal(d.pathOf(ids.histEssay), 'Random Folder/History Essay', 'undo restored nested original location');
  const schoolFolders = [...d.files.values()].filter((f) => f.name === 'School');
  assert.ok(schoolFolders.every((f) => f.trashed), 'empty created folders went to trash (recoverable), never deleted');
  step('undo restored every file and trashed only the empty folders it created');

  // 5. AI mode with an API error on one file
  await page.getByRole('link', { name: 'Settings' }).click();
  await page.getByLabel('AI backend URL').fill('https://ai.test');
  await page.getByRole('button', { name: 'Save URL' }).click();
  await page.getByRole('button', { name: 'Test connection' }).click();
  await page.getByText(/Connected ✓/).waitFor();
  await page.getByRole('link', { name: 'AI Organizer' }).click();
  await page.getByRole('button', { name: /Organize something else/ }).click().catch(() => {});
  await page.getByLabel('Organization instructions').fill('Put my school files into folders by subject and school year.');
  await page.getByRole('button', { name: /Analyze & build preview/ }).click();
  await page.getByRole('heading', { name: 'Your organization plan' }).waitFor({ timeout: 30000 });
  assert.ok(aiRequests >= 1, 'AI backend was called');
  assert.match(excerpts['Document1.pdf'] || '', /Untitled scan 0042/, 'PDF text was extracted with pdf.js and sent as an excerpt');
  assert.match(excerpts['History Essay'] || '', /World War I/, 'Google Doc text was exported and sent as an excerpt');
  assert.ok(await page.getByText(/Made by AI/).isVisible());
  await page.getByRole('tab', { name: /Needs review/ }).click();
  await page.getByText('Document1.pdf').first().waitFor();
  d.failNext((m, p) => m === 'PATCH' && p.endsWith(ids.spanish), 500, 'backendError', 99);
  await page.getByRole('button', { name: /Approve & Organize/ }).click();
  await page.getByRole('button', { name: 'Organize now' }).click();
  await page.getByRole('heading', { name: /Organizing finished/ }).waitFor({ timeout: 60000 });
  await page.getByText('Items that were skipped or failed').waitFor();
  assert.ok(await page.getByRole('cell', { name: 'Vocab list' }).isVisible(), 'failed operation is reported, not silently skipped');
  assert.match(d.pathOf(ids.doc1), /^Needs Review\//, 'uncertain file went to Needs Review');
  assert.match(d.pathOf(ids.mathHw), /^School\/Math\/2024-2025\//);
  const schoolNow = [...d.files.values()].filter((f) => f.name === 'School' && !f.trashed);
  assert.equal(schoolNow.length, 1, 'exactly one School folder');
  await shot('07-ai-done-with-failure');
  step('AI mode planned, executed, and reported an injected API failure');

  // 6. Other pages render
  await page.getByRole('link', { name: 'Duplicate Finder' }).click();
  await page.getByText('Exact match').first().waitFor();
  await shot('08-duplicates');
  await page.getByRole('link', { name: 'My Files' }).click();
  await page.getByRole('button', { name: 'Archive' }).click();
  await page.getByText(/2,300 total/).waitFor();
  step('Duplicate Finder and My Files (paginated 2,300-item folder) render');
  await page.getByRole('link', { name: 'Settings' }).click();
  await page.getByLabel('Theme').selectOption('dark');
  await page.getByRole('link', { name: 'Dashboard' }).click();
  await page.getByRole('heading', { name: /Welcome, Test/ }).waitFor();
  await shot('09-dashboard-dark');
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark');
  step('dark theme applies');

  // 7. Disconnect
  await page.getByRole('link', { name: 'Settings' }).click();
  await page.getByRole('button', { name: /Disconnect Google Drive/ }).click();
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await page.getByRole('button', { name: /Continue as|Connect Google Drive/ }).waitFor();
  step('disconnect returns to the welcome screen');

  const unexpected = errors.filter((e) => !/favicon/.test(e) && !/status of 500/.test(e));
  assert.deepEqual(unexpected, [], 'no JavaScript errors in the page');
  await browser.close();
  server.close();
  console.log('\nE2E PASSED');
}

main().catch((e) => { console.error(e); process.exit(1); });
