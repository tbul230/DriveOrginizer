// In-memory index of the user's My Drive, built from a paginated scan.
import { splitPath } from './paths.js';

export const FOLDER_MIME = 'application/vnd.google-apps.folder';
export const SHORTCUT_MIME = 'application/vnd.google-apps.shortcut';

export function isFolder(item) {
  return !!item && item.mimeType === FOLDER_MIME;
}

export function kindOf(item) {
  const m = item?.mimeType || '';
  if (m === FOLDER_MIME) return 'folder';
  if (m === 'application/vnd.google-apps.document') return 'doc';
  if (m === 'application/vnd.google-apps.spreadsheet') return 'sheet';
  if (m === 'application/vnd.google-apps.presentation') return 'slides';
  if (m === 'application/vnd.google-apps.form') return 'form';
  if (m === 'application/vnd.google-apps.drawing') return 'drawing';
  if (m === SHORTCUT_MIME) return 'shortcut';
  if (m === 'application/pdf') return 'pdf';
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('audio/')) return 'audio';
  if (m.startsWith('text/')) return 'text';
  if (/word|opendocument\.text|rtf/.test(m)) return 'word';
  if (/sheet|excel|csv/.test(m)) return 'excel';
  if (/presentation|powerpoint/.test(m)) return 'powerpoint';
  if (/zip|compressed|tar|rar|7z/.test(m)) return 'archive';
  return 'other';
}

export const KIND_LABELS = {
  folder: 'Folder', doc: 'Google Doc', sheet: 'Google Sheet', slides: 'Google Slides',
  form: 'Google Form', drawing: 'Google Drawing', shortcut: 'Shortcut', pdf: 'PDF',
  image: 'Image', video: 'Video', audio: 'Audio', text: 'Text', word: 'Word document',
  excel: 'Spreadsheet', powerpoint: 'Presentation', archive: 'Archive', other: 'File',
};

export class DriveIndex {
  constructor(rootId, rootName = 'My Drive') {
    this.rootId = rootId;
    this.rootName = rootName;
    this.items = new Map();
    this.children = new Map();
    this.inMyDrive = new Set();
    this._pathCache = new Map();
    this.scannedAt = null;
    this.incompleteSearch = false;
    this.items.set(rootId, { id: rootId, name: rootName, mimeType: FOLDER_MIME, parents: [], isRoot: true,
      capabilities: { canAddChildren: true, canMoveItemWithinDrive: false } });
  }

  add(file) {
    if (!file || !file.id || file.id === this.rootId) return;
    this.items.set(file.id, file);
  }

  /** Build parent→children map and reachability from the My Drive root. */
  finalize() {
    this.children = new Map();
    this._pathCache.clear();
    for (const item of this.items.values()) {
      for (const p of item.parents || []) {
        if (!this.children.has(p)) this.children.set(p, []);
        this.children.get(p).push(item.id);
      }
    }
    this.inMyDrive = new Set([this.rootId]);
    const queue = [this.rootId];
    while (queue.length) {
      const id = queue.shift();
      for (const c of this.children.get(id) || []) {
        if (!this.inMyDrive.has(c)) {
          this.inMyDrive.add(c);
          if (isFolder(this.items.get(c))) queue.push(c);
        }
      }
    }
    this.scannedAt = new Date().toISOString();
    return this;
  }

  get(id) { return this.items.get(id); }
  has(id) { return this.items.has(id); }
  isRoot(id) { return id === this.rootId; }

  childrenOf(id) {
    return (this.children.get(id) || []).map((c) => this.items.get(c)).filter(Boolean);
  }

  /** The parent used for display / tree purposes (first parent that is in My Drive). */
  parentOf(id) {
    const item = this.items.get(id);
    if (!item) return null;
    return (item.parents || []).find((p) => this.inMyDrive.has(p)) || null;
  }

  /** Relative folder path of a folder ("" for root). */
  relPathOf(folderId) {
    if (folderId === this.rootId) return '';
    if (this._pathCache.has(folderId)) return this._pathCache.get(folderId);
    const names = [];
    let cur = folderId;
    const seen = new Set();
    while (cur && cur !== this.rootId) {
      if (seen.has(cur)) break; // defensive: corrupted cycles
      seen.add(cur);
      const item = this.items.get(cur);
      if (!item) break;
      names.unshift(item.name);
      cur = this.parentOf(cur);
    }
    const path = names.join('/');
    this._pathCache.set(folderId, path);
    return path;
  }

  /** Display path of the folder that contains an item, e.g. "My Drive/School". */
  locationOf(id) {
    const parent = this.parentOf(id);
    if (!parent) return '(outside My Drive)';
    const rel = this.relPathOf(parent);
    return rel ? `My Drive/${rel}` : 'My Drive';
  }

  fullPathOf(id) {
    const item = this.items.get(id);
    if (!item) return '';
    if (id === this.rootId) return 'My Drive';
    return `${this.locationOf(id)}/${item.name}`;
  }

  /** True when `id` is `ancestorId` or lives somewhere beneath it. */
  isWithin(id, ancestorId) {
    let cur = id;
    const seen = new Set();
    while (cur) {
      if (cur === ancestorId) return true;
      if (seen.has(cur)) return false;
      seen.add(cur);
      cur = this.parentOf(cur);
    }
    return false;
  }

  /** Find a child folder by name: exact match first, then case-insensitive. */
  findChildFolder(parentId, name) {
    const kids = this.childrenOf(parentId).filter(isFolder);
    return kids.find((k) => k.name === name) ||
      kids.find((k) => k.name.toLowerCase() === name.toLowerCase()) || null;
  }

  findChildrenByName(parentId, name) {
    return this.childrenOf(parentId).filter((k) => k.name === name);
  }

  /**
   * Resolve a relative path against existing folders.
   * Returns { folderId, lastExistingId, existingDepth, segments }.
   * folderId is null if part of the path does not exist yet.
   */
  resolvePath(rel) {
    const segments = splitPath(rel);
    let cur = this.rootId;
    let depth = 0;
    for (const seg of segments) {
      const next = this.findChildFolder(cur, seg);
      if (!next) break;
      cur = next.id;
      depth++;
    }
    return {
      folderId: depth === segments.length ? cur : null,
      lastExistingId: cur,
      existingDepth: depth,
      segments,
    };
  }

  /** Everything under My Drive (excluding the root itself). */
  myDriveItems() {
    const out = [];
    for (const id of this.inMyDrive) if (id !== this.rootId) out.push(this.items.get(id));
    return out;
  }

  descendantsOf(folderId) {
    const out = [];
    const stack = [folderId];
    while (stack.length) {
      const id = stack.pop();
      for (const c of this.childrenOf(id)) {
        out.push(c);
        if (isFolder(c)) stack.push(c.id);
      }
    }
    return out;
  }

  folderPaths(limit = Infinity) {
    const out = [];
    for (const id of this.inMyDrive) {
      if (id === this.rootId) continue;
      const it = this.items.get(id);
      if (isFolder(it)) out.push(this.relPathOf(id));
      if (out.length >= limit) break;
    }
    return out.sort();
  }

  stats() {
    let files = 0, folders = 0, loose = 0, outside = 0, bytes = 0;
    for (const item of this.items.values()) {
      if (item.isRoot) continue;
      if (!this.inMyDrive.has(item.id)) { outside++; continue; }
      if (isFolder(item)) folders++;
      else {
        files++;
        bytes += Number(item.size || 0);
        if (this.parentOf(item.id) === this.rootId) loose++;
      }
    }
    return { files, folders, loose, outside, bytes };
  }
}
