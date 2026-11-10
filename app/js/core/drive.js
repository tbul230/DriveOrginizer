// Thin, safe wrapper around the Google Drive REST API v3.
//
// Safety notes:
//  * This client intentionally has NO method that permanently deletes a file,
//    empties the trash, changes permissions/ownership, or uploads content into
//    an existing user file. The only write operations are: create a folder,
//    move (add/remove parents), rename, move an EMPTY app-created folder to the
//    trash during undo, and read/write the app's own hidden appDataFolder file.
//  * Every request is retried with exponential backoff on rate limits and
//    temporary server errors. Writes that are not idempotent (folder creation)
//    are handled by the caller with a check-before-retry.
import { escapeQuery } from './paths.js';
import { FOLDER_MIME } from './driveIndex.js';

const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';

export const FILE_FIELDS =
  'id,name,mimeType,parents,size,md5Checksum,modifiedTime,createdTime,viewedByMeTime,' +
  'ownedByMe,webViewLink,trashed,shortcutDetails(targetId,targetMimeType),' +
  'capabilities(canMoveItemWithinDrive,canRename,canAddChildren,canEdit,canTrash,canListChildren)';

const RATE_LIMIT_REASONS = new Set(['rateLimitExceeded', 'userRateLimitExceeded', 'backendError', 'internalError']);

export class DriveError extends Error {
  constructor(message, { status = 0, reason = '', retryable = false } = {}) {
    super(message);
    this.name = 'DriveError';
    this.status = status;
    this.reason = reason;
    this.retryable = retryable;
  }
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class DriveClient {
  /**
   * @param {object} opts
   * @param {() => Promise<string>|string} opts.getToken  returns a current access token
   * @param {() => Promise<string>} [opts.refreshToken]     obtains a fresh token after a 401
   * @param {typeof fetch} [opts.fetchImpl]
   */
  constructor({ getToken, refreshToken, fetchImpl, sleep = defaultSleep, maxRetries = 6, baseDelay = 800, writeSpacingMs = 250 } = {}) {
    this.getToken = getToken;
    this.refreshToken = refreshToken;
    this.fetchImpl = fetchImpl || ((...a) => fetch(...a));
    this.sleep = sleep;
    this.maxRetries = maxRetries;
    this.baseDelay = baseDelay;
    this.writeSpacingMs = writeSpacingMs;
    this._lastWrite = 0;
    this.stats = { requests: 0, retries: 0 };
  }

  async _throttleWrite() {
    const wait = this._lastWrite + this.writeSpacingMs - Date.now();
    if (wait > 0) await this.sleep(wait);
    this._lastWrite = Date.now();
  }

  /**
   * Low-level request with retries.
   * @returns parsed JSON, text (responseType 'text'), ArrayBuffer ('arraybuffer') or null for 204.
   */
  async request(method, url, { query, body, headers = {}, responseType = 'json', signal, retry = true, base = API } = {}) {
    const full = new URL(url.startsWith('http') ? url : base + url);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null && v !== '') full.searchParams.set(k, String(v));
      }
    }
    const isWrite = method !== 'GET';
    let attempt = 0;
    let refreshed = false;
    for (;;) {
      if (signal?.aborted) throw new DriveError('Cancelled', { reason: 'aborted' });
      if (isWrite) await this._throttleWrite();
      const token = await this.getToken();
      if (!token) throw new DriveError('Not signed in to Google Drive', { status: 401, reason: 'noToken' });
      const init = {
        method,
        headers: { Authorization: `Bearer ${token}`, ...headers },
        signal,
      };
      if (body !== undefined) {
        if (typeof body === 'string' || body instanceof Blob || body instanceof ArrayBuffer) init.body = body;
        else {
          init.body = JSON.stringify(body);
          init.headers['Content-Type'] = 'application/json';
        }
      }
      this.stats.requests++;
      let res;
      try {
        res = await this.fetchImpl(full.toString(), init);
      } catch (err) {
        if (signal?.aborted || err?.name === 'AbortError') throw new DriveError('Cancelled', { reason: 'aborted' });
        // Network failure. Reads are always safe to retry. Writes are retried only when
        // the caller says the operation is idempotent (retry !== false).
        if (retry && attempt < this.maxRetries) {
          attempt++;
          this.stats.retries++;
          await this.sleep(this._backoff(attempt));
          continue;
        }
        throw new DriveError(`Network error: ${err?.message || err}`, { reason: 'network', retryable: true });
      }

      if (res.ok) {
        if (res.status === 204) return null;
        if (responseType === 'text') return res.text();
        if (responseType === 'arraybuffer') return res.arrayBuffer();
        return res.json();
      }

      let payload = null;
      try { payload = await res.json(); } catch { /* not json */ }
      const reason = payload?.error?.errors?.[0]?.reason || payload?.error?.status || '';
      const message = payload?.error?.message || `HTTP ${res.status}`;

      if (res.status === 401 && !refreshed && this.refreshToken) {
        refreshed = true;
        try { await this.refreshToken(); } catch (e) {
          throw new DriveError(`Google sign-in expired: ${e?.message || e}`, { status: 401, reason: 'authExpired' });
        }
        continue;
      }
      const retryable = [408, 429, 500, 502, 503, 504].includes(res.status) ||
        (res.status === 403 && RATE_LIMIT_REASONS.has(reason));
      if (retryable && retry && attempt < this.maxRetries) {
        attempt++;
        this.stats.retries++;
        const ra = Number(res.headers?.get?.('Retry-After'));
        await this.sleep(Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 60000) : this._backoff(attempt));
        continue;
      }
      throw new DriveError(message, { status: res.status, reason, retryable });
    }
  }

  _backoff(attempt) {
    const exp = this.baseDelay * 2 ** (attempt - 1);
    return Math.min(exp, 32000) + Math.floor(Math.random() * 400);
  }

  // ---------- reads ----------

  about() {
    return this.request('GET', '/about', {
      query: { fields: 'user(displayName,emailAddress,photoLink),storageQuota(limit,usage,usageInDrive,usageInDriveTrash)' },
    });
  }

  getFile(id, fields = FILE_FIELDS, opts = {}) {
    return this.request('GET', `/files/${encodeURIComponent(id)}`, { query: { fields }, ...opts });
  }

  /** One page of files.list. */
  listPage(params, opts = {}) {
    return this.request('GET', '/files', { query: params, ...opts });
  }

  /** List ALL results for a query, following nextPageToken until exhausted. */
  async listAll(q, { fields = FILE_FIELDS, pageSize = 1000, signal, onPage } = {}) {
    const out = [];
    let pageToken;
    let incomplete = false;
    do {
      const res = await this.listPage({
        q, pageSize, pageToken, corpora: 'user', spaces: 'drive',
        fields: `nextPageToken,incompleteSearch,files(${fields})`,
      }, { signal });
      if (res.incompleteSearch) incomplete = true;
      out.push(...(res.files || []));
      onPage?.(out.length, res);
      pageToken = res.nextPageToken;
    } while (pageToken);
    out.incompleteSearch = incomplete;
    return out;
  }

  /** Children of a folder with an exact name (used for live conflict checks). */
  async findChildrenByName(parentId, name, { foldersOnly = false, signal } = {}) {
    let q = `'${escapeQuery(parentId)}' in parents and name = '${escapeQuery(name)}' and trashed = false`;
    if (foldersOnly) q += ` and mimeType = '${FOLDER_MIME}'`;
    return this.listAll(q, { fields: 'id,name,mimeType,parents', pageSize: 100, signal });
  }

  async hasChildren(folderId, { signal } = {}) {
    const res = await this.listPage({
      q: `'${escapeQuery(folderId)}' in parents and trashed = false`,
      pageSize: 1, fields: 'files(id)', corpora: 'user', spaces: 'drive',
    }, { signal });
    return (res.files || []).length > 0;
  }

  /** Export a Google Docs/Sheets/Slides file as text. */
  exportText(id, mimeType = 'text/plain', opts = {}) {
    return this.request('GET', `/files/${encodeURIComponent(id)}/export`, { query: { mimeType }, responseType: 'text', ...opts });
  }

  /** Download (part of) a binary file's content. Read-only. */
  download(id, { range, signal } = {}) {
    const headers = range ? { Range: `bytes=${range[0]}-${range[1]}` } : {};
    return this.request('GET', `/files/${encodeURIComponent(id)}`, {
      query: { alt: 'media' }, headers, responseType: 'arraybuffer', signal,
    });
  }

  // ---------- writes (all gated by the executor / undo flows) ----------

  /**
   * Create a folder. Not idempotent, so it is never blindly retried: after a
   * failure we check whether the folder now exists before trying again.
   */
  async createFolder(name, parentId, { signal } = {}) {
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        return await this.request('POST', '/files', {
          query: { fields: FILE_FIELDS },
          body: { name, mimeType: FOLDER_MIME, parents: [parentId] },
          retry: false, signal,
        });
      } catch (err) {
        if (!(err instanceof DriveError) || !(err.retryable || err.reason === 'network')) throw err;
        await this.sleep(this._backoff(attempt + 1));
        const existing = await this.findChildrenByName(parentId, name, { foldersOnly: true, signal });
        if (existing.length) return { ...existing[0], recoveredAfterError: true };
      }
    }
    throw new DriveError(`Could not create folder "${name}" after several attempts`, { reason: 'createFailed' });
  }

  /** Move a file: add one parent and remove the given parents. Idempotent. */
  moveFile(id, addParentId, removeParentIds, { signal } = {}) {
    return this.request('PATCH', `/files/${encodeURIComponent(id)}`, {
      query: { addParents: addParentId, removeParents: (removeParentIds || []).join(','), fields: 'id,name,parents' },
      body: {}, signal,
    });
  }

  /** Rename a file (metadata only, contents untouched). Idempotent. */
  renameFile(id, newName, { signal } = {}) {
    return this.request('PATCH', `/files/${encodeURIComponent(id)}`, {
      query: { fields: 'id,name,parents' }, body: { name: newName }, signal,
    });
  }

  /**
   * Move a folder to the trash (recoverable for 30 days). Only used by Undo for
   * EMPTY folders that this app created. Never permanently deletes.
   */
  trashEmptyFolder(id, { signal } = {}) {
    return this.request('PATCH', `/files/${encodeURIComponent(id)}`, {
      query: { fields: 'id,trashed' }, body: { trashed: true }, signal,
    });
  }

  // ---------- app's private storage (appDataFolder) ----------

  async findAppDataFile(name) {
    const res = await this.listPage({
      q: `name = '${escapeQuery(name)}'`, spaces: 'appDataFolder', fields: 'files(id,name,modifiedTime)', pageSize: 10,
    });
    return res.files?.[0] || null;
  }

  readAppDataFile(id) {
    return this.request('GET', `/files/${encodeURIComponent(id)}`, { query: { alt: 'media' }, responseType: 'text' });
  }

  async writeAppDataFile(name, text, existingId) {
    if (existingId) {
      return this.request('PATCH', `/files/${encodeURIComponent(existingId)}`, {
        base: UPLOAD_API, query: { uploadType: 'media', fields: 'id' },
        headers: { 'Content-Type': 'application/json' }, body: text,
      });
    }
    const boundary = `bnd${Math.random().toString(36).slice(2)}`;
    const meta = JSON.stringify({ name, parents: ['appDataFolder'], mimeType: 'application/json' });
    const multipart =
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n` +
      `--${boundary}\r\nContent-Type: application/json\r\n\r\n${text}\r\n--${boundary}--`;
    return this.request('POST', '/files', {
      base: UPLOAD_API, query: { uploadType: 'multipart', fields: 'id' },
      headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body: multipart, retry: false,
    });
  }
}
