// An in-memory fake of the parts of the Google Drive v3 REST API the app uses.
// TEST-ONLY. Used by the unit tests (as a fetch implementation) and by the
// browser end-to-end test (via Playwright request interception). It records
// every request so tests can assert that nothing dangerous was ever called.
import crypto from 'node:crypto';

const FOLDER = 'application/vnd.google-apps.folder';

export class FakeDrive {
  constructor({ token = 'test-token', pageSizeCap = 1000 } = {}) {
    this.token = token;
    this.pageSizeCap = pageSizeCap;
    this.files = new Map();
    this.appData = new Map();
    this.requests = [];
    this.failures = []; // queue of { match(method, path), status, reason, times }
    this.seq = 0;
    this.rootId = 'root-id';
    this.files.set(this.rootId, { id: this.rootId, name: 'My Drive', mimeType: FOLDER, parents: [], trashed: false, isRootFolder: true });
  }

  id() { return `f${(++this.seq).toString().padStart(5, '0')}`; }

  add(name, { parent, mimeType = 'application/vnd.google-apps.document', content = '', size, md5, created = '2024-09-15T10:00:00Z',
    modified, viewed, ownedByMe = true, canMove = true, trashed = false, id } = {}) {
    const fid = id || this.id();
    const isNative = /^application\/vnd\.google-apps\./.test(mimeType);
    const f = {
      id: fid, name, mimeType, parents: [parent || this.rootId], trashed, content,
      createdTime: created, modifiedTime: modified || created, viewedByMeTime: viewed, ownedByMe,
      capabilities: { canMoveItemWithinDrive: canMove, canRename: canMove, canAddChildren: mimeType === FOLDER, canEdit: canMove, canTrash: canMove, canListChildren: true },
    };
    if (!isNative) {
      f.size = String(size ?? Buffer.byteLength(content || ''));
      f.md5Checksum = md5 || crypto.createHash('md5').update(content || name).digest('hex');
    }
    this.files.set(fid, f);
    return fid;
  }

  folder(name, parent, opts = {}) { return this.add(name, { ...opts, parent, mimeType: FOLDER }); }

  failNext(match, status, reason = '', times = 1) { this.failures.push({ match, status, reason, times }); }

  pathOf(id) {
    const names = [];
    let cur = this.files.get(id);
    while (cur && cur.id !== this.rootId) { names.unshift(cur.name); cur = this.files.get(cur.parents?.[0]); }
    return names.join('/');
  }

  childrenOf(id) { return [...this.files.values()].filter((f) => !f.trashed && f.parents?.includes(id)); }

  // ---- request handling ----
  _resp(status, body, headers = {}) {
    return { status, headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) };
  }
  _err(status, message, reason = '') {
    return this._resp(status, { error: { code: status, message, errors: [{ reason, message }] } });
  }
  _public(f) {
    const { content, isRootFolder, ...rest } = f;
    return rest;
  }
  _pick(f, fields) {
    // Very small field projector: returns all public fields (the app tolerates extras).
    return this._public(f);
  }

  _parseQuery(q) {
    const clauses = [];
    const re = /'((?:[^'\\]|\\.)*)'\s+in\s+parents|name\s*=\s*'((?:[^'\\]|\\.)*)'|mimeType\s*=\s*'((?:[^'\\]|\\.)*)'|trashed\s*=\s*(true|false)/g;
    const unesc = (s) => s.replace(/\\(.)/g, '$1');
    let m;
    while ((m = re.exec(q || ''))) {
      if (m[1] !== undefined) { const v = unesc(m[1]); clauses.push((f) => f.parents?.includes(v)); }
      else if (m[2] !== undefined) { const v = unesc(m[2]); clauses.push((f) => f.name === v); }
      else if (m[3] !== undefined) { const v = unesc(m[3]); clauses.push((f) => f.mimeType === v); }
      else if (m[4] !== undefined) { const v = m[4] === 'true'; clauses.push((f) => !!f.trashed === v); }
    }
    return (f) => clauses.every((c) => c(f));
  }

  handle(method, urlStr, headers = {}, bodyText = '') {
    const url = new URL(urlStr);
    const path = url.pathname;
    const sp = url.searchParams;
    this.requests.push({ method, path, query: Object.fromEntries(sp), body: bodyText });
    if (method === 'DELETE') return this._err(403, 'Test harness: DELETE is forbidden', 'forbidden');
    if (path.includes('emptyTrash')) return this._err(403, 'Test harness: emptyTrash is forbidden', 'forbidden');
    if (/\/permissions/.test(path)) return this._err(403, 'Test harness: permission changes are forbidden', 'forbidden');

    const auth = headers.authorization || headers.Authorization || '';
    if (auth !== `Bearer ${this.token}`) return this._err(401, 'Invalid Credentials', 'authError');

    for (const f of this.failures) {
      if (f.times > 0 && f.match(method, path, sp)) {
        f.times--;
        return this._err(f.status, `Injected ${f.status}`, f.reason);
      }
    }

    const m = /^\/(upload\/)?drive\/v3\/(files|about)(?:\/([^/]+))?(?:\/(export))?$/.exec(path);
    if (!m) return this._err(404, 'Not found', 'notFound');
    const [, upload, kind, rawId, exportPath] = m;
    if (kind === 'about') {
      return this._resp(200, { user: { displayName: 'Test Student', emailAddress: 'student@example.com', photoLink: '' },
        storageQuota: { limit: String(15 * 1024 ** 3), usage: String(2 * 1024 ** 3), usageInDrive: String(1024 ** 3) } });
    }
    let id = rawId ? decodeURIComponent(rawId) : null;
    if (id === 'root') id = this.rootId;

    if (method === 'GET' && !id) {
      // files.list
      if (sp.get('spaces') === 'appDataFolder') {
        const pred = this._parseQuery(sp.get('q'));
        return this._resp(200, { files: [...this.appData.values()].filter(pred).map((f) => ({ id: f.id, name: f.name, modifiedTime: f.modifiedTime })) });
      }
      const pred = this._parseQuery(sp.get('q'));
      const all = [...this.files.values()].filter((f) => !f.isRootFolder && pred(f)).sort((a, b) => a.id.localeCompare(b.id));
      const size = Math.min(Number(sp.get('pageSize') || 100), this.pageSizeCap);
      const start = Number(sp.get('pageToken') || 0);
      const page = all.slice(start, start + size);
      const next = start + size < all.length ? String(start + size) : undefined;
      return this._resp(200, { files: page.map((f) => this._public(f)), nextPageToken: next, incompleteSearch: false });
    }

    if (method === 'GET' && id) {
      const ad = this.appData.get(id);
      if (ad) return sp.get('alt') === 'media' ? { status: 200, headers: { 'content-type': 'application/json' }, body: ad.content } : this._resp(200, ad);
      const f = this.files.get(id);
      if (!f) return this._err(404, `File not found: ${id}`, 'notFound');
      if (exportPath) {
        if (!/^application\/vnd\.google-apps\./.test(f.mimeType)) return this._err(403, 'Export only supports Docs Editors files', 'fileNotExportable');
        return { status: 200, headers: { 'content-type': 'text/plain' }, body: f.content || '' };
      }
      if (sp.get('alt') === 'media') {
        if (/^application\/vnd\.google-apps\./.test(f.mimeType)) return this._err(403, 'Use export', 'fileNotDownloadable');
        let body = Buffer.from(f.content || '');
        const range = /bytes=(\d+)-(\d+)/.exec(headers.range || headers.Range || '');
        if (range) body = body.subarray(Number(range[1]), Number(range[2]) + 1);
        return { status: range ? 206 : 200, headers: { 'content-type': 'application/octet-stream' }, body, binary: true };
      }
      return this._resp(200, id === this.rootId ? { id: this.rootId, name: 'My Drive', parents: [] } : this._pick(f, sp.get('fields')));
    }

    let body = {};
    try { body = bodyText && !upload ? JSON.parse(bodyText) : {}; } catch { body = {}; }

    if (method === 'POST' && !id) {
      if (upload) {
        const ct = headers['content-type'] || headers['Content-Type'] || '';
        const boundary = /boundary=(\S+)/.exec(ct)?.[1];
        const parts = String(bodyText).split(`--${boundary}`);
        const meta = JSON.parse(parts[1].split('\r\n\r\n')[1]);
        const content = parts[2].split('\r\n\r\n').slice(1).join('\r\n\r\n').replace(/\r\n$/, '');
        const nid = `appdata-${this.id()}`;
        this.appData.set(nid, { id: nid, name: meta.name, content, modifiedTime: new Date().toISOString() });
        return this._resp(200, { id: nid });
      }
      if (body.mimeType !== FOLDER) return this._err(400, 'Test harness only supports creating folders', 'badRequest');
      const parent = body.parents?.[0];
      if (!this.files.has(parent)) return this._err(404, 'Parent not found', 'notFound');
      const nid = this.folder(body.name, parent);
      return this._resp(200, this._public(this.files.get(nid)));
    }

    if (method === 'PATCH' && id) {
      if (upload) {
        const ad = this.appData.get(id);
        if (!ad) return this._err(404, 'not found', 'notFound');
        ad.content = bodyText;
        ad.modifiedTime = new Date().toISOString();
        return this._resp(200, { id });
      }
      const f = this.files.get(id);
      if (!f) return this._err(404, `File not found: ${id}`, 'notFound');
      if (Object.keys(body).some((k) => !['name', 'trashed'].includes(k))) return this._err(400, `Test harness: unexpected update fields ${Object.keys(body)}`, 'badRequest');
      if (body.trashed === true) {
        if (f.mimeType !== FOLDER || this.childrenOf(id).length) return this._err(400, 'Test harness: only empty folders may be trashed', 'badRequest');
        f.trashed = true;
      }
      if (body.name !== undefined) f.name = body.name;
      const add = sp.get('addParents');
      const remove = (sp.get('removeParents') || '').split(',').filter(Boolean);
      if (add) {
        if (!f.capabilities.canMoveItemWithinDrive) return this._err(403, 'Insufficient permissions', 'insufficientFilePermissions');
        if (!this.files.has(add)) return this._err(404, 'Parent not found', 'notFound');
        // Drive itself rejects cycles.
        let cur = add;
        while (cur) { if (cur === id) return this._err(400, 'Cycle', 'cannotMoveItemIntoItself'); cur = this.files.get(cur)?.parents?.[0]; }
        f.parents = [...f.parents.filter((p) => !remove.includes(p)), add].filter((v, i, a) => a.indexOf(v) === i);
      }
      return this._resp(200, { id: f.id, name: f.name, parents: f.parents, trashed: f.trashed });
    }
    return this._err(405, `Unsupported ${method} ${path}`, 'unsupported');
  }

  /** A fetch() implementation backed by this fake. */
  fetch = async (url, init = {}) => {
    const headers = {};
    for (const [k, v] of Object.entries(init.headers || {})) headers[k.toLowerCase()] = v;
    const bodyText = typeof init.body === 'string' ? init.body : init.body ? String(init.body) : '';
    const r = this.handle(init.method || 'GET', String(url), headers, bodyText);
    return new Response(r.status === 204 ? null : r.body, { status: r.status, headers: r.headers });
  };

  writes() { return this.requests.filter((r) => r.method !== 'GET'); }
}
