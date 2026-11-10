// Public configuration for the website. Nothing in this file is secret.
//
// googleClientId: the OAuth 2.0 "Web application" client ID from Google Cloud
//   Console. Client IDs are public by design (no client secret is used).
// aiBackendUrl: the URL of your deployed AI worker (worker/worker.js), e.g.
//   "https://drive-organizer-ai.yourname.workers.dev". Leave empty to use only
//   the basic (non-AI) organizer.
//
// Both values can also be entered in the app's Settings page; values saved
// there override this file for that browser.
window.DRIVE_ORGANIZER_CONFIG = {
  googleClientId: '',
  aiBackendUrl: '',
};
