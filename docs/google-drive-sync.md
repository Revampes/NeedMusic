# Google Drive Sync — Setup Guide

NeedMusic can back up your favorites and playlists to your **own Google Drive**
(private `appDataFolder`) and pull them back on any other device — a free,
user-owned, cross-device sync with no NeedMusic backend.

This page explains how to register the app in the **Google Cloud Console**,
enable the **Google Drive API**, obtain a `CLIENT_ID`, and configure
**Authorized JavaScript Origins** for local development.

> The sync only ever touches a hidden, per-app folder (`appDataFolder`) that is
> invisible in the user's Drive UI and isolated to your own OAuth client. It
> uses the **non-sensitive** OAuth scope `https://www.googleapis.com/auth/drive.appdata`.
> The audio files themselves are **not** synced — only portable metadata
> (favorites + playlists + track info). No traffic ever goes through NeedMusic.

---

## 1. Create a project in Google Cloud Console

1. Go to <https://console.cloud.google.com> and sign in with any Google account.
2. Use the project picker in the top bar → **New Project**.
3. Name it (e.g. `NeedMusic`) and click **Create**.
4. Make sure your new project is selected in the top bar.

## 2. Enable the Google Drive API

1. In the left nav, go to **APIs & Services → Library**.
2. Search for **Google Drive API**.
3. Open it and click **Enable**.

## 3. Create OAuth consent screen

1. Go to **APIs & Services → OAuth consent screen**.
2. Choose **External** (you can add test users while developing; do not "Publish"
   unless you intend to let anyone authenticate) and click **Create**.
3. Fill in:
   - **App name**: e.g. `NeedMusic`
   - **User support email**: any reachable email
4. Click **Save and Continue** through the remaining screens. No **test users**
   are required for development if you use your own Google account that owns
   the project, but adding test users is recommended for collaboration.

## 4. Create an OAuth Client ID (Web application)

1. Go to **APIs & Services → Credentials** → **Create Credentials** →
   **OAuth client ID**.
2. **Application type**: **Web application**.
3. **Name**: e.g. `NeedMusic Web`.
4. Under **Authorized JavaScript origins**, add the origins you'll run the app from:

   | Environment                | Origin to add                     |
   |----------------------------|-----------------------------------|
   | Local development (web)    | `http://localhost:3000`           |
   | Local development (desktop)| `http://localhost:1420`           |
   | GitHub Pages / production  | `https://<your-user>.github.io`   |

   (Your deployed origin — e.g. GitHub Pages URL or a custom domain — must also
   be listed here. The **installed desktop app** is intentionally NOT listed: its
   `tauri.localhost` origin can't be registered (Google rejects `.localhost`),
   so it authenticates via the loopback PKCE redirect URI in step 5 instead.)
5. **Authorized redirect URIs**:
   - Leave empty **for the web app only** — it uses Google's client-side GIS
     (implicit token) flow which needs no redirect URI.
   - **For the desktop app**, add the loopback PKCE callback:
     `http://127.0.0.1:8543/oauth_callback` (Google allows `localhost`/`127.0.0.1`
     loopback redirects; the port is fixed in `src-tauri/src/google_oauth.rs`).
     This is how the installed app authenticates without needing its
     `tauri.localhost` origin to be a JavaScript origin.
6. Click **Create**. A dialog shows your **Client ID** — copy it.

> ⚠️ Keep the Client ID public-facing (it is public by design for web apps).
> The **desktop** client's secret must NOT be committed to the repo — supply it
> locally via the `VITE_GOOGLE_CLIENT_SECRET` env var in your `.env` (see
> `src/core/services/cloudConfig.ts` and `.env.example`). The web app never
> touches a secret (GIS inline flow).

## 5. Configure NeedMusic

The app reads the client id from the `VITE_GOOGLE_CLIENT_ID` environment
variable at build time, or from a hardcoded default in
`web/googleConfig.ts`.

**Option A — environment variable (recommended, keeps secrets out of source):**

```bash
# at the repo root, before `npm run dev:web` / `npm run build:web`
export VITE_GOOGLE_CLIENT_ID=1234567890-yourclientid.apps.googleusercontent.com
npm run dev:web
```

On Windows PowerShell:

```powershell
$env:VITE_GOOGLE_CLIENT_ID="1234567890-yourclientid.apps.googleusercontent.com"
npm run dev:web
```

**Option B — hardcode for local dev** (paste into `web/googleConfig.ts`):

```ts
const DEFAULT_CLIENT_ID = "1234567890-yourclientid.apps.googleusercontent.com";
```

> A `.env.example` is provided in the repo root. Copy it to `.env` and set your
> client id — Vite loads `.env` automatically.

## 6. Run & verify

```bash
npm install
npm run dev:web            # opens http://localhost:3000
```

Open **Settings → Google Drive Sync → Sign in with Google**, approve the
`drive.appdata` scope, and the app will fetch `app_data.json` from your private
appDataFolder and push your favorites/playlists back after changes.

> **Both the web app and the desktop (Tauri) app use the same sync.** Sign in
> from either one — Settings → Google Drive Sync — and favorites / custom
> playlists are merged across devices by a normalized **song key**
> (`artist | title | album | duration`), so a song is reconciled even though the
> two apps assign it different internal ids.
>
> The **web app** signs in with Google's inline GIS (origin `http://localhost:3000`
> when developing). The **desktop app** signs in through the system browser via a
> loopback PKCE callback (`http://127.0.0.1:8543/oauth_callback`) because its
> `tauri.localhost` origin can't be registered as a JavaScript origin for GIS.
> The desktop requests a full OIDC authorization-code flow
> (`openid email profile` + `drive.appdata`) — Google treats a Web client's
> `response_type=code` with `openid` as a standard OIDC flow, avoiding the
> "Required parameter is missing: response_type" that pure-API scopes can
> trigger on this endpoint. Desktop OAuth lives in `src-tauri/src/google_oauth.rs`,
> web reuses the shared modules under `src/core/services/`.

To see whether data is actually being stored (read-only inspection), you can
issue against the Drive API with the same client id:

```
GET https://www.googleapis.com/drive/v3/files?spaces=appDataFolder
Authorization: Bearer <token>
```

---

## How it works (brief)

- **Storage target**: Google Drive File API **v3**, scope `drive.appdata`.
- **Sign-in**: modern Google Identity Services (`google.accounts.id`) via the
  `gsi/client` script loaded in `web/index.html`.
- **Auth**: `google.accounts.oauth2.initTokenClient({ scope: "…/drive.appdata" })`
  returns a short-lived access token used for Drive REST calls.
- **Read**: list `appDataFolder` for `app_data.json` (`spaces=appDataFolder`,
  `q=name='app_data.json'`), then download with `alt=media`.
- **Write**: create/update metadata with a JSON `files.create` / `files.update`
  and upload content via `/upload/drive/v3/files/{id}?uploadType=media` (no
  hand-rolled multipart, avoiding Drive's "Invalid JSON payload" boundary pitfall).
- **Conflict resolution**: timestamp-based — the envelope with the newest
  `lastUpdated` wins; ties are broken deterministically by `deviceId`.
- **Cross-device merge**: favorites and playlists are keyed by a normalized
  **song key** (`artist|title|album|duration`), so desktop and web reconcile the
  same song even with different internal ids.
- The actual code lives in `src/core/services/` (shared: `googleDriveSync.ts`,
  `cloudsync.ts`, `cloudsyncDb.ts`), `src/ui/useGoogleSync.ts` +
  `src/ui/useDesktopDriveSync.ts` (auth + orchestration), and
  `src/ui/components/GoogleDriveSyncPanel.tsx` (desktop UI, with a matching
  `web/GoogleDriveSyncPanel.tsx` / `web/useWebDriveSync.ts` for the web build).

## Troubleshooting

- **"Google Identity Services unavailable"** — the gsi client script was blocked
  or CSP rejected it; make sure `https://accounts.google.com/gsi/client` is allowed.
- **"No access token returned"** — dismiss the popup: not all scopes consented.
  Re-run "Sync now".
- **"origin mismatch"** — the page's origin isn't in **Authorized JavaScript origins**.
  Add it (and re-save) in the Cloud Console; allow a few minutes to propagate.
- **Mixed content** — the signed-in page must be served over **HTTPS** or
  `http://localhost` for Google to accept it as an authorized origin.
