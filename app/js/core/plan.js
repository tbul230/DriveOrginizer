// Turns raw proposals (from the AI or from basic mode) into a validated plan.
// Every proposed operation is checked here before it can ever be executed:
// unknown ids, items outside My Drive, unsafe paths, circular folder moves,
// permission problems, name conflicts and duplicate operations are rejected or
// flagged. Nothing in this file talks to the Drive API.
import { isFolder, kindOf } from './driveIndex.js';
import { normalizeDestination, prefixes, splitPath, displayPath, fileExtension } from './paths.js';
import { uid } from './store.js';

const GOOGLE_NATIVE = /^application\/vnd\.google-apps\./;

function validateNewName(item, newName) {
  if (typeof newName !== 'string') return { error: 'New name is missing' };
  // eslint-disable-next-line no-control-regex
  let n = newName.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
  if (!n) return { error: 'New name is empty' };
  if (n.length > 250) return { error: 'New name is too long' };
  if (n.includes('/')) return { error: 'New name may not contain "/"' };
  if (!GOOGLE_NATIVE.test(item.mimeType || '') && !isFolder(item)) {
    const ext = fileExtension(item.name);
    if (ext && fileExtension(n) !== ext) n = `${n}.${ext}`; // never silently drop a file extension
  }
  if (n === item.name) return { error: 'New name is the same as the current name' };
  return { name: n };
}

/**
 * @param {DriveIndex} index
 * @param {{moves, renames, needsReview, flagged, foldersToCreate, notes}} proposals  (fileId based)
 * @param {object} opts
 */
export function buildPlan(index, proposals, {
  settings, instruction = '', source = 'ai', scopeIds = null, duplicates = [],
} = {}) {
  const s = settings || {};
  const plan = {
    id: uid('plan_'),
    createdAt: new Date().toISOString(),
    instruction,
    source,
    status: 'draft',
    ops: [],
    flagged: [],
    duplicates,
    rejected: [],
    notes: [...(proposals.notes || [])],
    warnings: [],
    reviewFolder: s.needsReviewFolder || 'Needs Review',
  };
  const seenFile = new Set();
  const reject = (fileId, reason, extra = {}) => {
    const item = index.get(fileId);
    plan.rejected.push({ fileId, name: item?.name || String(fileId), reason, ...extra });
  };
  const movingFolderIds = new Set();

  const checkItem = (fileId) => {
    const item = index.get(fileId);
    if (!item) return 'Unknown file id (not found in the scan)';
    if (index.isRoot(fileId)) return 'The My Drive root cannot be moved';
    if (!index.inMyDrive.has(fileId)) return 'File is not in My Drive (e.g. only "Shared with me")';
    if (scopeIds && !scopeIds.has(fileId)) return 'File is outside the selected scope';
    if (s.includeNotOwned === false && item.ownedByMe === false) return 'File is owned by someone else (excluded in Settings)';
    return null;
  };

  // Collect move candidates: explicit moves + needs-review items.
  const candidates = [];
  for (const m of proposals.moves || []) candidates.push({ ...m, review: false });
  for (const r of proposals.needsReview || []) {
    if (s.useNeedsReviewFolder === false) {
      const err = checkItem(r.fileId);
      if (!err) plan.flagged.push({ fileId: r.fileId, reason: `Needs review: ${r.reason || 'uncertain'}`, review: true });
      continue;
    }
    candidates.push({ fileId: r.fileId, destination: plan.reviewFolder, reason: r.reason || 'Uncertain where this belongs', confidence: 'low', review: true });
  }

  // First pass: basic validity, so we know which folders are moving.
  const valid = [];
  for (const c of candidates) {
    const err = checkItem(c.fileId);
    if (err) { reject(c.fileId, err); continue; }
    if (seenFile.has(c.fileId)) { plan.warnings.push(`"${index.get(c.fileId).name}" was proposed more than once; only the first proposal is kept.`); continue; }
    const item = index.get(c.fileId);
    if (item.capabilities && item.capabilities.canMoveItemWithinDrive === false) { reject(c.fileId, 'You do not have permission to move this item'); continue; }
    const dest = normalizeDestination(c.destination);
    if (dest === null) { reject(c.fileId, `Invalid or unsafe destination path "${c.destination}"`); continue; }
    if (isFolder(item) && s.allowFolderMoves === false) { reject(c.fileId, 'Moving folders is disabled in Settings'); continue; }
    const res = index.resolvePath(dest);
    if (isFolder(item) && index.isWithin(res.lastExistingId, item.id)) {
      reject(item.id, `Moving folder into "${dest}" would put it inside itself (circular folder structure)`);
      continue;
    }
    seenFile.add(c.fileId);
    if (res.folderId && (item.parents || []).includes(res.folderId)) {
      plan.notes.push(`"${item.name}" is already in ${displayPath(dest)}.`);
      continue; // unchanged
    }
    if (isFolder(item)) movingFolderIds.add(item.id);
    valid.push({ ...c, destination: dest, item, res });
  }

  // Second pass: path resolution, cycles, no-ops and conflicts.
  const incomingNames = new Map(); // destPath -> Set(lowercase names)
  for (const c of valid) {
    const { item, res } = c;
    // A destination may not pass through a folder that is itself being moved.
    const chain = [];
    let cur = res.lastExistingId;
    while (cur && !index.isRoot(cur)) { chain.push(cur); cur = index.parentOf(cur); }
    if (chain.some((id) => movingFolderIds.has(id) && id !== item.id)) {
      reject(item.id, `Destination "${c.destination}" is inside a folder that is also being moved`);
      continue;
    }
    const op = {
      opId: uid('op_'),
      type: 'move',
      fileId: item.id,
      name: item.name,
      kind: kindOf(item),
      isFolder: isFolder(item),
      fromParentIds: [...(item.parents || [])],
      fromPath: index.locationOf(item.id),
      destPath: c.destination,
      destFolderId: res.folderId || null,
      reason: String(c.reason || '').slice(0, 400),
      confidence: ['high', 'medium', 'low'].includes(c.confidence) ? c.confidence : 'medium',
      review: !!c.review,
      conflict: null,
      approved: true,
      status: 'pending',
    };
    const key = c.destination.toLowerCase();
    if (!incomingNames.has(key)) incomingNames.set(key, new Set());
    const lname = item.name.toLowerCase();
    if (res.folderId) {
      const clash = index.childrenOf(res.folderId).find((k) => k.id !== item.id && k.name.toLowerCase() === lname);
      if (clash) op.conflict = `An item named "${clash.name}" already exists in ${displayPath(c.destination)}`;
    }
    if (!op.conflict && incomingNames.get(key).has(lname)) op.conflict = `Another item named "${item.name}" is also being moved to ${displayPath(c.destination)}`;
    incomingNames.get(key).add(lname);
    if (op.conflict) {
      op.conflict += s.conflictPolicy === 'keepBoth'
        ? '. Google Drive will keep both (nothing is overwritten).'
        : '. Skipped by default — tick it to keep both copies side by side (nothing is overwritten).';
      op.approved = s.conflictPolicy === 'keepBoth';
    }
    plan.ops.push(op);
  }

  // Renames (only if allowed; the AI is told to propose them only when asked).
  for (const r of proposals.renames || []) {
    if (s.allowRenames === false) { reject(r.fileId, 'Renaming is disabled in Settings'); continue; }
    const err = checkItem(r.fileId);
    if (err) { reject(r.fileId, err); continue; }
    const item = index.get(r.fileId);
    if (item.capabilities && item.capabilities.canRename === false) { reject(r.fileId, 'You do not have permission to rename this item'); continue; }
    const v = validateNewName(item, r.newName);
    if (v.error) { reject(r.fileId, v.error); continue; }
    if (plan.ops.some((o) => o.type === 'rename' && o.fileId === item.id)) continue;
    plan.ops.push({
      opId: uid('op_'), type: 'rename', fileId: item.id, name: item.name, newName: v.name, kind: kindOf(item),
      isFolder: isFolder(item), fromPath: index.locationOf(item.id), reason: String(r.reason || '').slice(0, 400),
      confidence: 'high', conflict: null, approved: true, status: 'pending',
    });
  }

  // Explicitly requested (possibly empty) folders.
  for (const raw of proposals.foldersToCreate || []) {
    const p = normalizeDestination(raw);
    if (!p) continue;
    if (index.resolvePath(p).folderId) continue;
    if (plan.ops.some((o) => o.type === 'mkdir' && o.destPath.toLowerCase() === p.toLowerCase())) continue;
    plan.ops.push({ opId: uid('op_'), type: 'mkdir', destPath: p, name: splitPath(p).pop(), reason: 'Folder requested by the plan', approved: true, status: 'pending', conflict: null });
  }

  for (const f of proposals.flagged || []) {
    if (checkItem(f.fileId)) continue;
    if (plan.flagged.some((x) => x.fileId === f.fileId)) continue;
    plan.flagged.push({ fileId: f.fileId, reason: String(f.reason || '').slice(0, 300) });
  }
  return plan;
}

/** Folders that must be created for the currently approved operations, parents first. */
export function foldersNeeded(index, plan) {
  const set = new Map();
  for (const op of plan.ops) {
    if (!op.approved || (op.type !== 'move' && op.type !== 'mkdir')) continue;
    if (op.type === 'move' && op.destFolderId) continue;
    for (const p of prefixes(op.destPath)) {
      const key = p.toLowerCase();
      if (set.has(key)) continue;
      if (index.resolvePath(p).folderId) continue;
      set.set(key, p);
    }
  }
  return [...set.values()].sort((a, b) => splitPath(a).length - splitPath(b).length || a.localeCompare(b));
}

export function planSummary(index, plan, scopeCount) {
  const approved = plan.ops.filter((o) => o.approved);
  const moves = approved.filter((o) => o.type === 'move');
  return {
    moves: moves.filter((o) => !o.review).length,
    review: moves.filter((o) => o.review).length,
    renames: approved.filter((o) => o.type === 'rename').length,
    folders: foldersNeeded(index, plan).length,
    conflicts: plan.ops.filter((o) => o.conflict).length,
    rejected: plan.rejected.length,
    flagged: plan.flagged.length,
    duplicates: plan.duplicates?.length || 0,
    unchanged: Math.max(0, (scopeCount ?? 0) - moves.length),
    totalOps: plan.ops.length,
    approvedOps: approved.length,
  };
}

/**
 * Lazy before/after tree model for the preview. Keys are real Drive ids or
 * "new:<path>" for folders that will be created.
 */
export class PreviewModel {
  constructor(index, plan) {
    this.index = index;
    this.plan = plan;
    this.rebuild();
  }

  rebuild() {
    const { index, plan } = this;
    this.movedTo = new Map();   // fileId -> destKey
    this.movedIn = new Map();   // destKey -> [fileId]
    this.renamed = new Map();   // fileId -> newName
    this.review = new Set();
    this.newFolders = new Map(); // key -> { key, name, parentKey, path }
    this.newChildren = new Map(); // parentKey -> [key]
    const keyFor = (path) => {
      const res = index.resolvePath(path);
      return res.folderId || `new:${path.toLowerCase()}`;
    };
    for (const p of foldersNeeded(index, plan)) {
      const key = `new:${p.toLowerCase()}`;
      const segs = splitPath(p);
      const parentPath = segs.slice(0, -1).join('/');
      const parentKey = parentPath ? keyFor(parentPath) : index.rootId;
      this.newFolders.set(key, { key, name: segs[segs.length - 1], parentKey, path: p });
      if (!this.newChildren.has(parentKey)) this.newChildren.set(parentKey, []);
      this.newChildren.get(parentKey).push(key);
    }
    for (const op of plan.ops) {
      if (!op.approved) continue;
      if (op.type === 'move') {
        const dk = op.destFolderId || keyFor(op.destPath);
        this.movedTo.set(op.fileId, dk);
        if (!this.movedIn.has(dk)) this.movedIn.set(dk, []);
        this.movedIn.get(dk).push(op.fileId);
        if (op.review) this.review.add(op.fileId);
      } else if (op.type === 'rename') {
        this.renamed.set(op.fileId, op.newName);
      }
    }
    // Folders on the path of any change (for the "changed only" filter).
    this.touched = new Set([index.rootId]);
    const touchUp = (key) => {
      let k = key;
      const guard = new Set();
      while (k && !guard.has(k)) {
        guard.add(k);
        this.touched.add(k);
        if (k.startsWith?.('new:')) k = this.newFolders.get(k)?.parentKey;
        else k = index.parentOf(k);
      }
    };
    for (const [fileId, dk] of this.movedTo) { touchUp(dk); touchUp(index.parentOf(fileId)); }
    for (const fileId of this.renamed.keys()) touchUp(index.parentOf(fileId));
    for (const key of this.newFolders.keys()) touchUp(key);
  }

  nodeName(key) {
    if (key === this.index.rootId) return 'My Drive';
    if (String(key).startsWith('new:')) return this.newFolders.get(key)?.name || '?';
    return this.renamed.get(key) || this.index.get(key)?.name || '?';
  }

  isFolderKey(key) {
    return String(key).startsWith('new:') || isFolder(this.index.get(key));
  }

  /** Children in the current Drive (before). */
  childrenBefore(key) {
    return this.index.childrenOf(key).map((it) => ({
      key: it.id, name: it.name, folder: isFolder(it), item: it,
      status: this.movedTo.has(it.id) ? 'moving-out' : (this.renamed.has(it.id) ? 'renamed' : 'same'),
      changed: this.touched.has(it.id) || this.movedTo.has(it.id) || this.renamed.has(it.id),
    }));
  }

  /** Children after the plan is applied. */
  childrenAfter(key) {
    const out = [];
    const isNew = String(key).startsWith('new:');
    if (!isNew) {
      for (const it of this.index.childrenOf(key)) {
        if (this.movedTo.has(it.id)) continue;
        out.push({ key: it.id, name: this.renamed.get(it.id) || it.name, folder: isFolder(it), item: it,
          status: this.renamed.has(it.id) ? 'renamed' : 'same', changed: this.touched.has(it.id) || this.renamed.has(it.id) });
      }
    }
    for (const nk of this.newChildren.get(key) || []) {
      out.push({ key: nk, name: this.newFolders.get(nk).name, folder: true, status: 'new', changed: true });
    }
    for (const fid of this.movedIn.get(key) || []) {
      const it = this.index.get(fid);
      out.push({ key: fid, name: this.renamed.get(fid) || it.name, folder: isFolder(it), item: it,
        status: this.review.has(fid) ? 'review' : 'moved-in', changed: true });
    }
    return out;
  }
}
