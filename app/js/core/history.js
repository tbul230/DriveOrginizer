// Organization history: every operation (successful or not) is recorded.
// Stored in IndexedDB, and optionally backed up to the app's hidden
// appDataFolder in the user's own Google Drive so it survives browser resets.
import { uid } from './store.js';

const BACKUP_NAME = 'drive-organizer-history.json';

export class History {
  constructor(store) { this.store = store; this.listeners = new Set(); }

  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  _emit() { for (const fn of this.listeners) { try { fn(); } catch { /* ignore */ } } }

  async saveRun(run) { await this.store.put('runs', run); this._emit(); return run; }
  async getRun(runId) { return this.store.get('runs', runId); }
  async runs() {
    const all = await this.store.all('runs');
    return all.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }

  async addEntry(entry) {
    const e = { opId: uid('h_'), timestamp: new Date().toISOString(), ...entry };
    await this.store.put('ops', e);
    this._emit();
    return e;
  }
  async updateEntry(entry) { await this.store.put('ops', entry); this._emit(); return entry; }
  async entriesForRun(runId) {
    const list = await this.store.byIndex('ops', 'runId', runId);
    return list.sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)) || (a.seq || 0) - (b.seq || 0));
  }
  async allEntries() {
    const list = await this.store.all('ops');
    return list.sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)) || (b.seq || 0) - (a.seq || 0));
  }

  async exportJSON() {
    return JSON.stringify({
      app: 'ai-drive-organizer', version: 1, exportedAt: new Date().toISOString(),
      runs: await this.store.all('runs'), ops: await this.store.all('ops'),
    });
  }

  /** Merge an exported history file. Existing records win on id collisions only if newer. */
  async importJSON(text) {
    const data = JSON.parse(text);
    if (data?.app !== 'ai-drive-organizer' || !Array.isArray(data.runs) || !Array.isArray(data.ops)) {
      throw new Error('This file is not an AI Drive Organizer history export');
    }
    let added = 0;
    for (const run of data.runs) {
      if (!run?.runId) continue;
      const cur = await this.store.get('runs', run.runId);
      if (!cur || String(run.finishedAt || '') > String(cur.finishedAt || '')) { await this.store.put('runs', run); added++; }
    }
    for (const op of data.ops) {
      if (!op?.opId || !op.runId) continue;
      const cur = await this.store.get('ops', op.opId);
      if (!cur || (op.undoneAt && !cur.undoneAt)) { await this.store.put('ops', op); added++; }
    }
    this._emit();
    return added;
  }

  async clear() { await this.store.clear('runs'); await this.store.clear('ops'); this._emit(); }

  async backupToDrive(client) {
    const text = await this.exportJSON();
    const existing = await client.findAppDataFile(BACKUP_NAME);
    await client.writeAppDataFile(BACKUP_NAME, text, existing?.id);
    return true;
  }

  async restoreFromDrive(client) {
    const existing = await client.findAppDataFile(BACKUP_NAME);
    if (!existing) return 0;
    const text = await client.readAppDataFile(existing.id);
    return this.importJSON(text);
  }
}
