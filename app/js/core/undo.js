// Undo of recorded operations. Each undo is itself recorded in history.
// Checks before moving anything back:
//   * the file still exists and is not in the trash
//   * the file is still where this app put it (otherwise the user moved it; leave it)
//   * the original folder still exists (otherwise ask: restore to My Drive root?)
//   * nothing with the same name sits in the original folder (otherwise ask first)
import { uid } from './store.js';

export const UNDOABLE = new Set(['move', 'rename', 'createFolder']);

export function canUndo(entry) {
  if (!entry || entry.status !== 'success' || entry.undoneAt) return false;
  if (entry.type === 'createFolder') return !!entry.createdByApp;
  return entry.type === 'move' || entry.type === 'rename';
}

class UndoProblem extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

async function folderUsable(client, id) {
  try {
    const f = await client.getFile(id, 'id,trashed,mimeType');
    return !f.trashed;
  } catch (e) {
    if (e.status === 404) return false;
    throw e;
  }
}

/**
 * @param {object} p
 * @param {object[]} p.entries        history entries to undo (any order)
 * @param {object} [p.options]
 * @param {boolean} [p.options.allowNameConflict]  move back even if a same-named item exists (Drive keeps both)
 * @param {boolean} [p.options.restoreToRoot]      if the original folder is gone, move to My Drive root instead
 * @param {boolean} [p.options.trashEmptyFolders]  move EMPTY folders this app created to the trash (recoverable)
 * @returns {{ results: {entry, status, code?, message}[], run }}
 */
export async function undoEntries({ client, history, entries, rootId, options = {}, onProgress, label = 'Undo' }) {
  const targets = entries.filter(canUndo).sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)) || (b.seq || 0) - (a.seq || 0));
  // Undo moves/renames first, folders last (deepest first), so folders are empty when checked.
  const folders = targets.filter((e) => e.type === 'createFolder').sort((a, b) => (b.toPath || '').length - (a.toPath || '').length);
  const ordered = [...targets.filter((e) => e.type !== 'createFolder'), ...folders];

  const run = {
    runId: uid('run_'), kind: 'undo', createdAt: new Date().toISOString(), instruction: label, status: 'running',
    counts: { success: 0, failed: 0, skipped: 0 },
  };
  await history.saveRun(run);
  const results = [];
  let seq = 0;
  let i = 0;
  for (const entry of ordered) {
    onProgress?.({ done: i++, total: ordered.length, label: entry.fileName });
    const base = { runId: run.runId, seq: seq++, undoOf: entry.opId, fileId: entry.fileId, fileName: entry.fileName };
    try {
      if (entry.type === 'createFolder') {
        if (!options.trashEmptyFolders) { results.push({ entry, status: 'kept', message: 'Folder kept' }); continue; }
        const f = await client.getFile(entry.fileId, 'id,trashed,name');
        if (f.trashed) throw new UndoProblem('Folder is already in the trash', 'gone');
        if (await client.hasChildren(entry.fileId)) throw new UndoProblem('Folder is not empty; kept it', 'notEmpty');
        await client.trashEmptyFolder(entry.fileId);
        await history.addEntry({ ...base, type: 'trash-empty-folder', fromPath: entry.toPath, status: 'success', note: 'Moved to Trash (can be restored from Google Drive Trash for 30 days)' });
      } else if (entry.type === 'rename') {
        const f = await client.getFile(entry.fileId, 'id,name,trashed');
        if (f.trashed) throw new UndoProblem('File is in the trash', 'gone');
        if (f.name !== entry.newName) throw new UndoProblem(`File was renamed again since ("${f.name}"); left as is`, 'changed');
        await client.renameFile(entry.fileId, entry.oldName);
        await history.addEntry({ ...base, type: 'undo-rename', oldName: entry.newName, newName: entry.oldName, fromPath: entry.fromPath, status: 'success' });
      } else if (entry.type === 'move') {
        let f;
        try { f = await client.getFile(entry.fileId, 'id,name,parents,trashed'); } catch (e) {
          if (e.status === 404) throw new UndoProblem('File no longer exists or you lost access to it', 'gone');
          throw e;
        }
        if (f.trashed) throw new UndoProblem('File is in the trash', 'gone');
        if (!(f.parents || []).includes(entry.toParentId)) throw new UndoProblem('File has been moved somewhere else since; left where it is', 'changed');
        let target = (entry.fromParentIds || [])[0];
        let targetPath = entry.fromPath;
        if (!target || !(await folderUsable(client, target))) {
          if (!options.restoreToRoot) throw new UndoProblem(`The original folder (${entry.fromPath}) no longer exists`, 'missingOriginal');
          target = rootId;
          targetPath = 'My Drive';
        }
        if (!options.allowNameConflict) {
          const clash = (await client.findChildrenByName(target, f.name)).filter((x) => x.id !== f.id);
          if (clash.length) throw new UndoProblem(`An item named "${f.name}" already exists in ${targetPath}`, 'conflict');
        }
        await client.moveFile(entry.fileId, target, f.parents || []);
        await history.addEntry({ ...base, type: 'undo-move', fromParentIds: f.parents, fromPath: entry.toPath, toParentId: target, toPath: targetPath, status: 'success' });
      }
      entry.undoneAt = new Date().toISOString();
      await history.updateEntry(entry);
      run.counts.success++;
      results.push({ entry, status: 'success' });
    } catch (err) {
      const skipped = err instanceof UndoProblem;
      run.counts[skipped ? 'skipped' : 'failed']++;
      await history.addEntry({ ...base, type: `undo-${entry.type}`, fromPath: entry.toPath, toPath: entry.fromPath,
        status: skipped ? 'skipped' : 'failed', error: err.message, code: err.code });
      results.push({ entry, status: skipped ? 'skipped' : 'failed', code: err.code, message: err.message });
    }
  }
  run.finishedAt = new Date().toISOString();
  run.status = run.counts.failed ? 'completed-with-errors' : 'completed';
  await history.saveRun(run);
  onProgress?.({ done: ordered.length, total: ordered.length });
  return { results, run };
}
