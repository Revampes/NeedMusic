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
> No traffic ever goes through NeedMusic.
>
> Sync is split into two layers. **Metadata & state** (tracks, favourites,
> ratings, resume positions, listening counters, playlists, deletions) is tiny
> JSON and always syncs in full. **Audio** is heavyweight and **user-controlled**:
> it is uploaded only for tracks you mark *Available offline* (or when you set
> "Audio in Drive" to *Every track*), and downloaded only where you asked for
> it — never duplicated onto every device automatically.

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
- **Per-device files**: each device owns ONE file `sync-<deviceId>.json` and only
  ever writes to it, so concurrent devices never race on a shared file. Every
  cycle merges all devices' files deterministically (`mergeDeviceFiles`).
- **Two layers**:
  - *Layer 1 — metadata & state* (always synced): track metadata **with or
    without audio**, favourites, ratings, resume positions, per-day listening
    counters, playlists and deletion tombstones. These are kilobytes.
  - *Layer 2 — audio bytes* (user-controlled): uploaded only for tracks marked
    offline (or under "Audio in Drive → Every track"), stored as
    `audio__<hash>.bin` with the file id referenced from the track record.
- **Merge rules** (deterministic, in `cloudsync.ts`):
  - tracks — metadata from the newest writer; an audio reference is carried over
    so a metadata write never drops another device's upload;
  - favourites / ratings / resume positions — last-writer-wins per song key;
  - listening counters — **summed** per day (each device's file only holds its
    own counters, so nothing can double-count);
  - playlists — last-writer-wins per playlist id;
  - "Audio in Drive" mode — last-writer-wins globally.
- **Deletions use tombstones**: a delete records `{songKey, deletedAt}` which
  propagates to every device. Re-importing the same song afterwards
  (`addedAt > deletedAt`) resurrects it. Tombstones older than
  **30 days** are garbage-collected, and their orphaned Drive audio can be
  reclaimed from *Drive → Reclaim Drive space*.
- **Storage protection**: on the web/mobile client the offline download cache is
  bounded by *Settings → Offline storage → Cache limit (MB)*; when it is
  exceeded the least-recently-used entries are evicted. Tracks marked available
  offline are **pinned** and never evicted.
- **How a song gets onto another device** (the on-demand flow):
  1. the track's metadata syncs everywhere, so it appears in the library even
     before any audio exists in Drive;
  2. you mark it *Available offline* (☁ in the desktop track list, the download
     button on the web) — or simply play it, which downloads it on demand;
  3. that request is **unioned across devices**, so the device that *owns the
     file* uploads the audio on its next cycle even when the request came from
     another device;
  4. every device that asked for it downloads the audio once the reference
     appears, and pins its local copy.
     *Audio in Drive → Only marked tracks* (default) means a library is never
     uploaded silently; choose *Every track* for a full cloud backup.
- **Self-healing audio references**: a recorded Drive file id can disappear
  (running *Clean everything* on ANY device wipes the whole app folder for the
  account). Each id is therefore verified once per app run before being
  republished — a dead id is dropped rather than handed to another device (which
  would fail with Google's `File not found`), a transient check failure keeps
  trusting it (so a network blip never triggers a library-wide re-upload), and
  any device that still wants the song re-uploads a fresh copy on the next
  cycle. A device that hits a missing file drops the dead pointer and re-requests
  the track instead of showing the raw Google error.
- **Cross-device merge key**: favorites/ratings/playlists are keyed by a
  normalized **song key** (`artist|title|album|duration`), so desktop and web
  reconcile the same song even with different internal ids.
- The actual code lives in `src/core/services/` (shared: `googleDriveSync.ts`,
  `cloudsync.ts` = v3 contract + merge, `cloudsyncDb.ts` = desktop/SQLite side),
  `src/ui/useGoogleSync.ts` (auth + sync cycle) +
  `src/ui/useDesktopDriveSync.ts` / `web/useWebDriveSync.ts` (per-build hosts),
  `web/downloads.ts` (bounded offline cache), and
  `src/ui/components/GoogleDriveSyncPanel.tsx` (desktop UI, with a matching
  `web/GoogleDriveSyncPanel.tsx` for the web build).
- **Tests**: `npm run test:sync` runs `tests/cloudsync.test.ts` (Node's built-in
  runner + native TS type stripping — no extra dependencies) covering tombstone
  propagation/GC, resurrection, LWW, counter summing and v2 back-compat.

## Troubleshooting

- **"Google Identity Services unavailable"** — the gsi client script was blocked
  or CSP rejected it; make sure `https://accounts.google.com/gsi/client` is allowed.
- **"No access token returned"** — dismiss the popup: not all scopes consented.
  Re-run "Sync now".
- **"origin mismatch"** — the page's origin isn't in **Authorized JavaScript origins**.
  Add it (and re-save) in the Cloud Console; allow a few minutes to propagate.
- **Mixed content** — the signed-in page must be served over **HTTPS** or
  `http://localhost` for Google to accept it as an authorized origin.
