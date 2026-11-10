// Client for the AI planning backend (worker/worker.js).
// The backend holds the AI credentials; this file never sees an AI API key.
// The AI only RETURNS a proposal. It never touches Google Drive.
import { isFolder, kindOf } from './driveIndex.js';

export class AIError extends Error {
  constructor(message, { status = 0, code = '' } = {}) { super(message); this.status = status; this.code = code; }
}

function trimUrl(url) { return String(url || '').replace(/\/+$/, ''); }

export async function checkBackend(backendUrl, token, { fetchImpl = fetch } = {}) {
  const res = await fetchImpl(`${trimUrl(backendUrl)}/api/health`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new AIError(data.error || `Backend returned HTTP ${res.status}`, { status: res.status });
  return data;
}

function shortDate(iso) { return iso ? String(iso).slice(0, 10) : undefined; }

/** Compact, token-efficient description of an item for the model. */
export function describeItem(index, item, ref, snippet) {
  const d = {
    ref,
    name: item.name,
    type: kindOf(item),
    location: index.locationOf(item.id),
    created: shortDate(item.createdTime),
    modified: shortDate(item.modifiedTime),
  };
  if (item.viewedByMeTime) d.last_opened = shortDate(item.viewedByMeTime);
  else d.last_opened = 'never';
  if (item.size) d.size_kb = Math.round(Number(item.size) / 1024);
  if (isFolder(item)) d.items_inside = index.childrenOf(item.id).length;
  if (snippet?.text) d.content_excerpt = snippet.text;
  else if (snippet?.error) d.content_excerpt = '(could not be read)';
  return d;
}

async function postJSON(url, body, token, { fetchImpl, signal, attempts = 4 }) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    if (signal?.aborted) throw new AIError('Cancelled', { code: 'aborted' });
    let res;
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
        signal,
      });
    } catch (e) {
      if (signal?.aborted) throw new AIError('Cancelled', { code: 'aborted' });
      lastErr = new AIError(`Could not reach the AI backend: ${e.message}`, { code: 'network' });
      await new Promise((r) => setTimeout(r, 1500 * 2 ** i));
      continue;
    }
    const data = await res.json().catch(() => ({}));
    if (res.ok) return data;
    lastErr = new AIError(data.error || `AI backend error (HTTP ${res.status})`, { status: res.status, code: data.code });
    if (![429, 500, 502, 503, 504, 529].includes(res.status)) throw lastErr;
    const ra = Number(res.headers.get('Retry-After'));
    await new Promise((r) => setTimeout(r, Number.isFinite(ra) && ra > 0 ? ra * 1000 : 2000 * 2 ** i));
  }
  throw lastErr;
}

/**
 * Ask the backend to plan the organisation of `items`, in chunks.
 * Returns proposals keyed by real Drive file ids.
 */
export async function planWithAI({
  backendUrl, token, index, items, instruction, snippets = new Map(), settings = {},
  onProgress, signal, fetchImpl = (...a) => fetch(...a),
}) {
  if (!backendUrl) throw new AIError('No AI backend URL is configured', { code: 'noBackend' });
  const url = `${trimUrl(backendUrl)}/api/plan`;
  const chunkSize = Math.max(20, Math.min(300, Number(settings.aiChunkSize) || 150));
  // Folders first so the model sees structure, then files grouped by location.
  const ordered = [...items].sort((a, b) =>
    (isFolder(b) - isFolder(a)) || index.locationOf(a.id).localeCompare(index.locationOf(b.id)) || a.name.localeCompare(b.name));
  const refToId = new Map();
  ordered.forEach((it, i) => refToId.set(i + 1, it.id));
  const chunks = [];
  for (let i = 0; i < ordered.length; i += chunkSize) chunks.push(ordered.slice(i, i + chunkSize).map((it, j) => [i + j + 1, it]));

  const existingFolders = index.folderPaths(1500);
  const plannedFolders = new Set();
  const out = { moves: [], renames: [], needsReview: [], flagged: [], foldersToCreate: [], notes: [], usage: { input: 0, output: 0 } };
  const resolve = (ref) => refToId.get(Number(ref));

  for (let c = 0; c < chunks.length; c++) {
    onProgress?.({ chunk: c + 1, chunks: chunks.length });
    const body = {
      instruction,
      chunk: { index: c + 1, total: chunks.length, total_items: ordered.length },
      options: {
        allow_renames: settings.allowRenames !== false,
        allow_folder_moves: settings.allowFolderMoves !== false,
        needs_review_folder: settings.needsReviewFolder || 'Needs Review',
        today: new Date().toISOString().slice(0, 10),
      },
      existing_folders: existingFolders,
      planned_folders: [...plannedFolders].slice(0, 500),
      items: chunks[c].map(([ref, it]) => describeItem(index, it, ref, snippets.get(it.id))),
    };
    const data = await postJSON(url, body, token, { fetchImpl, signal });
    const r = data.result || {};
    out.usage.input += data.usage?.input_tokens || 0;
    out.usage.output += data.usage?.output_tokens || 0;
    const chunkRefs = new Set(chunks[c].map(([ref]) => ref));
    const own = (ref) => chunkRefs.has(Number(ref)) ? resolve(ref) : null; // ignore refs outside this chunk
    for (const m of r.moves || []) {
      const id = own(m.file); if (!id) continue;
      out.moves.push({ fileId: id, destination: m.destination, reason: m.reason, confidence: m.confidence });
      if (typeof m.destination === 'string') plannedFolders.add(m.destination);
    }
    for (const m of r.renames || []) { const id = own(m.file); if (id) out.renames.push({ fileId: id, newName: m.new_name, reason: m.reason }); }
    for (const m of r.needs_review || []) { const id = own(m.file); if (id) out.needsReview.push({ fileId: id, reason: m.reason }); }
    for (const m of r.flagged || []) { const id = own(m.file); if (id) out.flagged.push({ fileId: id, reason: m.reason }); }
    for (const f of r.folders_to_create || []) { if (typeof f === 'string') { out.foldersToCreate.push(f); plannedFolders.add(f); } }
    if (r.notes) out.notes.push(String(r.notes).slice(0, 1000));
  }
  return out;
}
