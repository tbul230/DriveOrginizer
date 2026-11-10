// Executes an APPROVED plan against the real Drive API.
// Safety rules enforced here:
//  * only approved operations run; the plan must not already be executing/finished
//  * each file is re-read right before it is touched: if it was moved, renamed or
//    trashed since the preview, the operation is skipped (never forced)
//  * folders are reused if they already exist (no duplicate folders)
//  * folder moves are re-checked against the live Drive for circular structures
//  * name conflicts that appear after the preview are skipped unless allowed
//  * every operation is written to history, including failures and skips
import { foldersNeeded } from './plan.js';
import { splitPath, displayPath } from './paths.js';
import { DriveError } from './drive.js';
import { uid } from './store.js';

const LIVE_FIELDS = 'id,name,parents,trashed,mimeType';

async function liveAncestors(client, folderId, rootId, cache) {
  const chain = [];
  let cur = folderId;
  for (let i = 0; i < 64 && cur && cur !== rootId; i++) {
    chain.push(cur);
    let parents = cache.get(cur);
    if (!parents) {
      const f = await client.getFile(cur, 'id,parents');
      parents = f.parents || [];
      cache.set(cur, parents);
    }
    cur = parents[0];
  }
  return chain;
}

const sameSet = (a = [], b = []) => a.length === b.length && [...a].sort().join() === [...b].sort().join();

export async function executePlan({ client, index, plan, history, savePlan = async () => {}, conflictPolicy = 'skip', onProgress, signal }) {
  if (plan.status === 'executing') throw new Error('This plan is already being executed.');
  if (plan.status === 'completed' || plan.status === 'cancelled') throw new Error(`This plan was already ${plan.status}. Create a new plan to make more changes.`);
  const approved = plan.ops.filter((o) => o.approved && o.status === 'pending');
  if (!approved.length) throw new Error('No approved operations to run.');

  plan.status = 'executing';
  plan.approvedAt = new Date().toISOString();
  await savePlan(plan);

  const run = {
    runId: uid('run_'), planId: plan.id, kind: 'organize', createdAt: new Date().toISOString(),
    instruction: plan.instruction, source: plan.source, status: 'running',
    counts: { success: 0, failed: 0, skipped: 0, cancelled: 0 },
  };
  await history.saveRun(run);
  let seq = 0;
  const record = async (entry) => {
    run.counts[entry.status] = (run.counts[entry.status] || 0) + 1;
    return history.addEntry({ runId: run.runId, planId: plan.id, seq: seq++, ...entry });
  };

  const folderIds = new Map(); // lower path -> id
  const resolveFolder = (path) => {
    if (!path) return index.rootId;
    const known = folderIds.get(path.toLowerCase());
    if (known) return known;
    return index.resolvePath(path).folderId;
  };

  const needed = foldersNeeded(index, plan);
  const total = needed.length + approved.filter((o) => o.type !== 'mkdir').length;
  let done = 0;
  const tick = (label) => onProgress?.({ done: ++done, total, label, counts: run.counts });
  const aborted = () => signal?.aborted;

  let authLost = null;
  const isAuthError = (err) => err instanceof DriveError && (err.status === 401 || err.reason === 'authExpired' || err.reason === 'noToken');

  // 1) Create folders, parents first.
  for (const path of needed) {
    if (aborted()) break;
    const segs = splitPath(path);
    const name = segs[segs.length - 1];
    const parentPath = segs.slice(0, -1).join('/');
    const parentId = resolveFolder(parentPath);
    if (!parentId) {
      await record({ type: 'createFolder', fileName: name, toPath: displayPath(path), status: 'failed', error: 'Parent folder could not be created' });
      tick(`Folder ${path}`);
      continue;
    }
    try {
      const existing = await client.findChildrenByName(parentId, name, { foldersOnly: true, signal });
      if (existing.length) {
        folderIds.set(path.toLowerCase(), existing[0].id);
        await record({ type: 'createFolder', fileId: existing[0].id, fileName: name, toParentId: parentId, toPath: displayPath(path), status: 'skipped', error: 'Folder already existed; reused it' });
      } else {
        const f = await client.createFolder(name, parentId); // no abort signal: writes always finish
        folderIds.set(path.toLowerCase(), f.id);
        await record({ type: 'createFolder', fileId: f.id, fileName: name, toParentId: parentId, toPath: displayPath(path), status: 'success', createdByApp: !f.recoveredAfterError });
      }
    } catch (err) {
      if (aborted()) break;
      if (isAuthError(err)) { authLost = err.message; break; }
      await record({ type: 'createFolder', fileName: name, toParentId: parentId, toPath: displayPath(path), status: 'failed', error: err.message });
    }
    tick(`Folder ${path}`);
  }
  if (!authLost) for (const op of approved) if (op.type === 'mkdir') op.status = resolveFolder(op.destPath) ? 'done' : 'failed';

  // 2) Moves, then 3) renames.
  const ancestorCache = new Map();
  const ordered = [...approved.filter((o) => o.type === 'move'), ...approved.filter((o) => o.type === 'rename')];
  for (const op of ordered) {
    if (aborted() || authLost) break;
    const base = { type: op.type, fileId: op.fileId, fileName: op.name, fromPath: op.fromPath };
    try {
      const live = await client.getFile(op.fileId, LIVE_FIELDS, { signal });
      if (live.trashed) throw Object.assign(new Error('File is in the trash now'), { skip: true });
      if (op.type === 'move') {
        const destId = op.destFolderId || resolveFolder(op.destPath);
        const toPath = displayPath(op.destPath);
        if (!destId) throw new Error('Destination folder could not be created');
        if ((live.parents || []).includes(destId)) throw Object.assign(new Error('Already in the destination folder'), { skip: true });
        if (!sameSet(live.parents, op.fromParentIds)) throw Object.assign(new Error('File was moved after the preview was made; left untouched'), { skip: true });
        if (op.isFolder) {
          const chain = await liveAncestors(client, destId, index.rootId, ancestorCache);
          if (destId === op.fileId || chain.includes(op.fileId)) throw new Error('Refused: this would create a circular folder structure');
        }
        if (!op.conflict) {
          const clash = (await client.findChildrenByName(destId, live.name, { signal })).filter((f) => f.id !== op.fileId);
          if (clash.length && conflictPolicy !== 'keepBoth') {
            throw Object.assign(new Error(`An item named "${live.name}" now exists in the destination; skipped to avoid confusion`), { skip: true });
          }
        }
        await client.moveFile(op.fileId, destId, live.parents || []);
        ancestorCache.set(op.fileId, [destId]);
        op.status = 'done';
        await record({ ...base, fileName: live.name, fromParentIds: live.parents || [], toParentId: destId, toPath, status: 'success' });
      } else {
        if (live.name !== op.name) throw Object.assign(new Error('File was renamed after the preview was made; left untouched'), { skip: true });
        await client.renameFile(op.fileId, op.newName);
        op.status = 'done';
        await record({ ...base, oldName: op.name, newName: op.newName, status: 'success' });
      }
    } catch (err) {
      if (aborted() && !(err instanceof DriveError && err.reason !== 'aborted')) break;
      if (isAuthError(err)) {
        authLost = err.message; // leave this and the remaining operations pending so the run can be resumed
        break;
      }
      op.status = err.skip ? 'skipped' : 'failed';
      op.error = err.message;
      await record({ ...base, toPath: op.destPath ? displayPath(op.destPath) : undefined, oldName: op.type === 'rename' ? op.name : undefined,
        newName: op.newName, status: op.status, error: err.message });
    }
    tick(op.name);
    if (done % 10 === 0) await savePlan(plan);
  }

  // Anything not attempted because the user stopped the run is recorded too.
  if (aborted()) {
    for (const op of ordered) {
      if (op.status !== 'pending') continue;
      op.status = 'cancelled';
      await record({ type: op.type, fileId: op.fileId, fileName: op.name, fromPath: op.fromPath,
        toPath: op.destPath ? displayPath(op.destPath) : undefined, status: 'cancelled', error: 'Stopped by user before this ran' });
    }
  }

  run.finishedAt = new Date().toISOString();
  if (authLost) {
    run.status = 'paused';
    run.error = `Paused: ${authLost}. Reconnect Google Drive and press Resume to finish the remaining changes.`;
    plan.status = 'paused';
  } else {
    run.status = aborted() ? 'stopped' : (run.counts.failed ? 'completed-with-errors' : 'completed');
    plan.status = 'completed';
  }
  await history.saveRun(run);
  plan.runIds = [...(plan.runIds || []), run.runId];
  plan.runId = run.runId;
  await savePlan(plan);
  return run;
}
