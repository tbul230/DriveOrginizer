# Deployment guide (for the developer)

This guide is for the person setting the site up once. After that, the end user
only needs Chrome and the site's URL. Nothing gets installed on their laptop.

You will set up three things:

| Piece | Where it runs | Holds secrets? |
|---|---|---|
| Website (`app/`) | GitHub Pages (static HTTPS hosting) | **No.** Only the public OAuth client ID |
| Google OAuth client | Google Cloud Console | No client secret is used |
| AI backend (`worker/worker.js`) | Cloudflare Workers (serverless, free tier is enough) | **Yes.** The Anthropic API key is stored as an encrypted Worker secret |

GitHub Pages can't keep secrets, so the AI key lives only in the Worker. The
website never sees it. If you skip the Worker, the site still works in **basic
mode**, which classifies files with keyword rules instead of AI.

You can do every step in a web browser. A command line is optional.

---

## 1. Put the code on GitHub and turn on Pages

1. Push this repository to GitHub (it is already there if you are reading this on GitHub).
2. In the repo: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
3. Merge to `main` (or run the workflow manually: **Actions → Test and deploy to GitHub Pages → Run workflow**).
   The workflow `.github/workflows/deploy-pages.yml` runs the tests and then publishes the `app/` folder.
4. Your site URL is `https://<your-github-username>.github.io/<repo-name>/`.
   Its **origin** (scheme + host, no path) is `https://<your-github-username>.github.io`. You'll need the origin below.

> Any static HTTPS host works the same way (Cloudflare Pages, Netlify, Vercel static). Just publish the `app/` folder.

## 2. Create the Google OAuth client

In the [Google Cloud Console](https://console.cloud.google.com/):

1. **Create a project** (top bar → project picker → *New project*), e.g. "Drive Organizer".
2. **Enable the Drive API**: *APIs & Services → Library →* search **Google Drive API** → *Enable*.
3. **Configure the consent screen**. Open *Google Auth Platform* (older consoles call it *APIs & Services → OAuth consent screen*):
   - **Branding**: app name (e.g. "AI Drive Organizer"), your support email, developer contact email.
   - **Audience**: User type **External**. Leave the publishing status as **Testing**.
     Under **Test users**, add the Google account(s) that will use the app (yours, for example).
   - **Data access → Add or remove scopes**: add these three:
     - `https://www.googleapis.com/auth/drive`: list and move files across the whole My Drive
     - `https://www.googleapis.com/auth/drive.appdata`: the app's private folder (history backup)
     - `https://www.googleapis.com/auth/userinfo.email`: show the account and authorize AI calls
4. **Create the client**: *Clients* (or *Credentials*) → *Create client* → **Application type: Web application**.
   - **Authorized JavaScript origins**: add `https://<your-github-username>.github.io`
     (and `http://localhost:8080` if you want to test locally).
   - **Authorized redirect URIs**: leave empty. The app uses Google Identity Services' pop-up token flow.
   - Click *Create* and copy the **Client ID** (`…apps.googleusercontent.com`). You don't need the client secret, and it must not go into the website.
5. Put the client ID in `app/config.js`:
   ```js
   window.DRIVE_ORGANIZER_CONFIG = {
     googleClientId: '1234567890-abc123.apps.googleusercontent.com',
     aiBackendUrl: '',            // filled in step 3
   };
   ```
   Commit and push. Pages redeploys automatically.

### Why the full `drive` scope?

Moving a file the app did not create needs write access to it. Google's narrower
`drive.file` scope only covers files the app created or the user opened with it,
so it cannot reorganise an existing Drive. The app limits itself in code: there is
no delete, no empty-trash, no sharing or permission change, and no content upload
to user files (see `app/js/core/drive.js`). The automated tests fail if any of
those calls is ever made.

### Testing mode vs. verification

- In **Testing** mode, only the listed test users (up to 100) can sign in. They
  will see a "Google hasn't verified this app" screen the first time. Click
  **Advanced → Go to … (unsafe)** to continue. That is fine for personal use.
- `drive` is a *restricted* scope. Opening the app to the general public needs
  Google's app verification and a third-party security assessment. You don't need
  that for personal or family use.

### School (Google Workspace for Education) accounts

Many school admins block third-party apps from accessing Drive, especially for
students under 18. If sign-in shows **"Access blocked: … your administrator"**,
the school's policy is stopping it. The app can't bypass that, and it shouldn't
try. Options:

- Use the app with a personal Google account, or
- Ask the school's Google admin to trust the app's OAuth client ID in
  *Admin console → Security → Access and data control → API controls → App access control*.

Running the app on a school laptop is no problem: it's an ordinary website in Chrome.

## 3. Deploy the AI backend (Cloudflare Worker, in the browser)

1. Get an Anthropic API key at [console.anthropic.com](https://console.anthropic.com/) and set a monthly **spend limit** there.
2. Create a free [Cloudflare](https://dash.cloudflare.com/) account.
3. *Workers & Pages → Create → Create Worker* → name it e.g. `drive-organizer-ai` → **Deploy** (deploys the hello-world sample).
4. **Edit code** → delete the sample → paste the full contents of `worker/worker.js` → **Deploy**.
5. Worker → **Settings → Variables and Secrets** → add:

   | Name | Type | Value |
   |---|---|---|
   | `ANTHROPIC_API_KEY` | **Secret** | your Anthropic API key |
   | `GOOGLE_CLIENT_ID` | Text | the OAuth client ID from step 2 |
   | `ALLOWED_ORIGINS` | Text | `https://<your-github-username>.github.io` (comma-separate several; add `http://localhost:8080` for local testing) |
   | `ALLOWED_EMAILS` | Text (optional, recommended) | comma-separated Google accounts allowed to use the AI, e.g. `you@gmail.com` |
   | `MODEL` | Text (optional) | defaults to `claude-opus-5-5` |
   | `EFFORT` | Text (optional) | `low`, `medium` (default) or `high` |
   | `RATE_LIMIT_PER_10_MIN` | Text (optional) | per-user request cap per Worker instance, default `120` |

6. Copy the Worker URL (e.g. `https://drive-organizer-ai.<you>.workers.dev`). Opening `…/api/health` should show `"configured": true`.
7. Put that URL in `app/config.js` as `aiBackendUrl` and push. (Users can also paste it in the app under **Settings → AI provider**.)

**How the Worker protects the key:** every request must carry the user's Google
access token. The Worker checks it with Google's `tokeninfo` endpoint and only
accepts tokens issued to *your* client ID (and, if set, only the emails in
`ALLOWED_EMAILS`). Requests from browser origins not in `ALLOWED_ORIGINS` are
refused. Input sizes are capped. The Worker never modifies Google Drive. It only
returns a JSON proposal that the browser validates and shows for approval.

**CLI alternative (developer machine only):** `cd worker && npx wrangler deploy`,
then `npx wrangler secret put ANTHROPIC_API_KEY`. Edit `worker/wrangler.toml` first.

**Cost guide:** each AI request covers up to 150 files (adjustable in Settings). With
default settings, plan for very roughly $1–3 per 1,000 files analysed on
`claude-opus-5-5`. Turning off "Read document contents" or setting
`MODEL=claude-sonnet-5-5` cuts the cost, at some loss of accuracy. The spend limit
in the Anthropic console is the hard cap.

## 4. Check the deployment

1. Open the site in Chrome. You should see the welcome screen with a **Connect Google Drive** button.
   If it says "Setup needed", `config.js` has no client ID yet.
2. Connect with a test-user account. The dashboard should show file and folder counts and storage use.
3. *Settings → AI provider → Test connection* should say **Connected ✓**.
4. Try a small plan first, e.g. *What to organize → Only inside one folder…* on a test folder.

### Common problems

| Symptom | Fix |
|---|---|
| `Error 400: origin_mismatch` / `redirect_uri_mismatch` on sign-in | The site's origin isn't in the client's *Authorized JavaScript origins* (no trailing slash, no path). |
| "Access blocked: app has not completed verification" | The account isn't a test user (step 2.3), or the app was switched to Production. |
| "Access blocked … administrator" | School/Workspace policy. See above. |
| Pop-up doesn't open | Allow pop-ups for the site (Chrome shows an icon in the address bar). |
| AI: "Origin not allowed" | Add the site origin to `ALLOWED_ORIGINS` exactly. |
| AI: "Token was not issued for this app" | `GOOGLE_CLIENT_ID` in the Worker doesn't match `config.js`. |
| AI: "not allowed to use the AI organizer" | Add the account to `ALLOWED_EMAILS`. |
| "Google sign-in could not load" | `accounts.google.com` is blocked on that network. |

## 5. Local development (developer only)

```bash
npm run serve        # serves app/ on http://localhost:8080 (needs Node 20+)
npm test             # unit/integration tests against a fake Drive API
npm run test:e2e     # drives the real UI in headless Chromium (needs Playwright)
```
