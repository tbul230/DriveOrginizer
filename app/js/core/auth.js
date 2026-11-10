// Google sign-in using Google Identity Services (OAuth 2.0 token model).
// The access token lives only in memory (never in localStorage). No client
// secret is used or needed: the OAuth client ID is public by design.

export const SCOPES = [
  // Needed to list ALL files in My Drive and move them between folders. Google
  // offers no narrower scope that can reorganise files the app did not create.
  'https://www.googleapis.com/auth/drive',
  // The app's own hidden folder, used to back up organisation history.
  'https://www.googleapis.com/auth/drive.appdata',
  // Your email address: shown in the app and used to authorise AI requests.
  'https://www.googleapis.com/auth/userinfo.email',
];

const HINT_KEY = 'driveOrganizer.loginHint';

function waitForGis(timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    (function poll() {
      if (window.google?.accounts?.oauth2) return resolve(window.google.accounts.oauth2);
      if (Date.now() - start > timeoutMs) {
        return reject(new Error('Google sign-in could not load. Check your internet connection, or whether accounts.google.com is blocked on this network.'));
      }
      setTimeout(poll, 100);
    })();
  });
}

export class GoogleAuth {
  constructor(clientId) {
    this.clientId = clientId;
    this.token = null;
    this.expiresAt = 0;
    this.grantedScopes = '';
    this._client = null;
    this._pending = null;
    this.listeners = new Set();
  }

  onChange(fn) { this.listeners.add(fn); }
  _emit() { for (const fn of this.listeners) fn(this.isSignedIn()); }

  get loginHint() { try { return localStorage.getItem(HINT_KEY) || ''; } catch { return ''; } }
  set loginHint(v) { try { if (v) localStorage.setItem(HINT_KEY, v); else localStorage.removeItem(HINT_KEY); } catch { /* ignore */ } }

  async _ensureClient() {
    if (this._client) return this._client;
    const oauth2 = await waitForGis();
    this._oauth2 = oauth2;
    this._client = oauth2.initTokenClient({
      client_id: this.clientId,
      scope: SCOPES.join(' '),
      include_granted_scopes: true,
      callback: (resp) => this._onToken(resp),
      error_callback: (err) => this._onError(err),
    });
    return this._client;
  }

  _onToken(resp) {
    const p = this._pending; this._pending = null;
    if (!p) return;
    if (resp.error) return p.reject(new Error(resp.error_description || resp.error));
    if (!this._oauth2.hasGrantedAllScopes(resp, SCOPES[0])) {
      return p.reject(new Error('Google Drive access was not granted. Please connect again and allow access to your Google Drive (the checkbox on Google’s consent screen).'));
    }
    this.token = resp.access_token;
    this.expiresAt = Date.now() + (Number(resp.expires_in) || 3600) * 1000;
    this.grantedScopes = resp.scope || '';
    this._emit();
    p.resolve(this.token);
  }

  _onError(err) {
    const p = this._pending; this._pending = null;
    if (!p) return;
    const type = err?.type || '';
    const msg = type === 'popup_closed' ? 'The Google sign-in window was closed before finishing.'
      : type === 'popup_failed_to_open' ? 'The Google sign-in window was blocked. Allow pop-ups for this site and try again.'
        : (err?.message || 'Google sign-in failed.');
    p.reject(Object.assign(new Error(msg), { type }));
  }

  /** Must be called from a user click (browsers block pop-ups otherwise). */
  async signIn({ prompt = '' } = {}) {
    const client = await this._ensureClient();
    if (this._pending) this._pending.reject(new Error('Superseded by a new sign-in request'));
    return new Promise((resolve, reject) => {
      this._pending = { resolve, reject };
      client.requestAccessToken({ prompt, login_hint: this.loginHint || undefined });
    });
  }

  isSignedIn() { return !!this.token && Date.now() < this.expiresAt - 30_000; }
  minutesLeft() { return this.token ? Math.max(0, Math.floor((this.expiresAt - Date.now()) / 60000)) : 0; }

  async getToken() {
    if (this.isSignedIn()) return this.token;
    return this.refresh();
  }

  /** Re-request a token without the consent screen (may briefly show a pop-up). */
  refresh() { return this.signIn({ prompt: '' }); }

  async signOut() {
    const token = this.token;
    this.token = null;
    this.expiresAt = 0;
    this.loginHint = '';
    if (token && this._oauth2) await new Promise((r) => this._oauth2.revoke(token, () => r()));
    this._emit();
  }
}
