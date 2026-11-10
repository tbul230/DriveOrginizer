// Duplicate detection. Never deletes anything — it only reports groups.
import { isFolder } from './driveIndex.js';

/** Strip "Copy of", "(1)", " - Copy" etc. so copies share a key. */
export function normalizeName(name) {
  let n = String(name || '').trim();
  let ext = '';
  const m = /(\.[A-Za-z0-9]{1,8})$/.exec(n);
  if (m) { ext = m[1].toLowerCase(); n = n.slice(0, -m[1].length); }
  let prev;
  do {
    prev = n;
    n = n
      .replace(/^copy of\s+/i, '')
      .replace(/\s*-\s*copy(\s*\(\d+\))?$/i, '')
      .replace(/\s*\(\d+\)$/, '')
      .replace(/\s+copy(\s+\d+)?$/i, '')
      .trim();
  } while (n !== prev);
  return (n.toLowerCase().replace(/\s+/g, ' ') + ext);
}

/**
 * Group likely duplicates.
 *  - "exact":    identical md5 content hash (binary files: PDFs, images, ...)
 *  - "likely":   same normalised name + same type + same size
 *  - "possible": same normalised name + same type (Google Docs have no hash/size)
 * Each file appears in at most one group (strongest match wins).
 */
export function findDuplicates(items) {
  const files = items.filter((it) => it && !isFolder(it) && !it.isRoot);
  const assigned = new Set();
  const groups = [];

  const byHash = new Map();
  for (const f of files) {
    if (!f.md5Checksum) continue;
    const key = `${f.md5Checksum}:${f.size || ''}`;
    if (!byHash.has(key)) byHash.set(key, []);
    byHash.get(key).push(f);
  }
  for (const list of byHash.values()) {
    if (list.length < 2) continue;
    groups.push({ confidence: 'exact', reason: 'Identical content (matching MD5 checksum and size)', fileIds: list.map((f) => f.id) });
    list.forEach((f) => assigned.add(f.id));
  }

  const byName = new Map();
  for (const f of files) {
    if (assigned.has(f.id)) continue;
    const key = `${normalizeName(f.name)}|${f.mimeType}`;
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(f);
  }
  for (const list of byName.values()) {
    if (list.length < 2) continue;
    const bySize = new Map();
    for (const f of list) {
      const s = f.size || '';
      if (!bySize.has(s)) bySize.set(s, []);
      bySize.get(s).push(f);
    }
    const leftovers = [];
    for (const [size, sl] of bySize) {
      if (size && sl.length >= 2) {
        groups.push({ confidence: 'likely', reason: 'Same name (ignoring "Copy of"/"(1)"), same type and same size', fileIds: sl.map((f) => f.id) });
      } else leftovers.push(...sl);
    }
    if (leftovers.length >= 2) {
      groups.push({ confidence: 'possible', reason: 'Same name (ignoring "Copy of"/"(1)") and same type; content could not be compared', fileIds: leftovers.map((f) => f.id) });
    }
  }
  const rank = { exact: 0, likely: 1, possible: 2 };
  groups.sort((a, b) => rank[a.confidence] - rank[b.confidence] || b.fileIds.length - a.fileIds.length);
  groups.forEach((g, i) => { g.id = `dup${i + 1}`; });
  return groups;
}
