# Next Session — Google Drive Cross-Device Sync Completion Plan

> **Audience:** the next working session on this repo.
> **Goal:** finish fully-automatic, bi-directional Google Drive sync (tracks, favorites, playlists, deletions) between any two devices (desktop app + web app) signed into the same Google account.

---

## 1. Project context

**NeedMusic** — a local-first music player:
- **Desktop app**: Tauri 2 (Rust backend + React frontend), SQLite via `@tauri-apps/plugin-sql` (`needmusic.db`), library managed by `LibraryManager`, UI in `src/ui/`.
- **Web app**: React SPA in `web/` (vite.config.web.ts), localStorage-backed store (`webTrackStore` in `web/bootstrap.ts`), downloaded audio in IndexedDB (`web/downloads.ts`).

Google Drive sync uses the **non-sensitive `drive.appdata` scope** and the app's private `appDataFolder` (no visible Drive quota, hidden from user's My Drive).

### Current working state (VERIFIED at plan-writing time)
- Working tree has **many uncommitted changes** (the entire sync feature so far). Last commit `77e43db "boooooooooooooooom"`.
- Both web and desktop have a **manual "Upload" / "Download"** button flow AND a **Changes-API-based periodic detector** (see §4).
- **Deletion receiving side is NOT implemented** (see §5 — this is the main remaining work).

---

## 2. The goal (user's exact requirements)

Fully automated bi-directional sync between two devices on the same Google account:

1. **Delete a track on device A → it is deleted on device B** (metadata entry + any downloaded audio copy).
2. **Add a track on device A → device B adds it AND auto-downloads its audio** (playable offline).
3. Same behavior for **favorites** and **playlists**.
4. Everything **automated** — no manual buttons required in the final state (manual Upload/Download may remain as a fallback but must not be required).

## 3. Locked design decisions (from user — do NOT change without asking)

| Decision | Choice |
|---|---|
| Deletion mechanism | **Explicit deletion queue** — only tracks the user explicitly deletes are propagated. **NEVER infer deletions from a diff between local list and Drive list.** |
| New-track download | **Auto-download audio** on the receiving device (web → IndexedDB; desktop → local storage dir). |
| Deletion depth | When a track is deleted remotely, remove **both the metadata entry AND the already-downloaded audio copy** on the receiving device. |
| Desktop delete semantics | Deleting a track on desktop removes it **from the library AND from disk** (`delete_track_file` already exists). |

## 4. What is already implemented (verified by grep at plan time)

### Shared layer — `src/core/services/googleDriveSync.ts`
- `getStartPageToken(token)` / `listChanges(token, pageToken)` — Drive **Changes API** lightweight detection (`spaces=appDataFolder`). Returns `{ changed, nextPageToken }` without downloading the payload.
- `fetchDriveData` (search appDataFolder for `app_data.json`, download via `alt=media`).
- `saveDriveData` (create or update via `uploadType=media`).
- `uploadAudioFile(token, name, bytes, mime)` / `downloadAudioFile(token, fileId)` — audio round-trip.
- `resolveConflicts(local, drive)` — timestamp (`lastUpdated`) based merge.
- Token cache: localStorage with expiry (`cacheToken`, `getCachedToken`, `cacheRefreshToken`, `clearCachedCredentials`), refresh-token support.
- `DriveAuthError` thrown on 401 (callers call `invalidateAuth`).

### Shared payload — `src/core/services/cloudsync.ts`
- `SyncableState` shape (in `app_data.json` under `payload`):
  ```ts
  interface SyncableState {
    tracks: SyncTrackMeta[];          // { songKey, title, artist, album, ..., driveFileId }
    favorites: string[];              // songKeys
    playlists: { id; name; trackKeys: string[] }[];
    deletedTracks?: string[];         // explicit deletion records (songKeys)
  }
  interface DriveSyncEnvelope { lastUpdated: string; deviceId: string; payload: SyncableState }
  ```
- `songKeyOf(track)` → normalized `artist|title|album|durationSecs` matching key.
- `mergeTrackLists(a, b, previouslySynced?, pendingDeletes?)` — **add-only union**, honors `pendingDeletes` (explicit deletes excluded), used by `runSync`.
- `mergeDeletedKeys(a, b)` — unions `deletedTracks`.

### Sync orchestration — `src/ui/useGoogleSync.ts` (shared hook)
- `uploadToDrive()` — **pure push**: fetches drive, merges tracks with `previouslySynced` = EMPTY (so ALL local tracks are kept — this fixed the "merged count 0" bug), writes to Drive. Never applies deletions.
- `downloadFromDrive()` = `runSync(true)` (quiet pull + apply).
- Changes-API poll effect: on sign-in fetch `startPageToken`; every ~15s call `listChanges`; **only when `changed` runs `runSync(true)`**. Updates `nextPageToken`.
- `getPendingDeletes()` provider (host provides the explicit-queue keys).
- Manual buttons exposed: `{ upload, download, runSync, signIn, signOut }`.

### Web — `web/`
- `web/useWebDriveSync.ts`: `PENDING_DELETE_KEY = "needmusic:gdrive:pendingDeletes"` (localStorage) — `queueDeletion(songKey)`, `getPendingDeletes`, `ackDeletion`.
- `web/WebApp.tsx`:
  - `handleRemoveTrack` (line ~943): on drive-track removal calls `driveSync.queueDeletion(td.id.slice("drive-".length))`.
  - `onApplyDriveTracks` (line ~975): injects non-duplicate drive tracks into the store AND **auto-downloads** their audio to IndexedDB (lines ~1024-1030).
  - `handlePlayTrack` drive:// branch downloads + saves to IndexedDB.
- `web/syncPayload.ts`: `toSyncableState(tracks, playlists, cloudTracks?, deletedTracks?)`, `applySyncedState` returns `{ favoritesSongKeys, playlists, driveTracks, deletedTracks }`.
- `web/GoogleDriveSync.ts` — thin re-export of shared layer.

### Desktop — `src/ui/`
- `src/ui/useDesktopDriveSync.ts`: pending-delete queue (localStorage), `getPendingDeletes`, passes `clientId`/`clientSecret` to browser PKCE auth; `buildDesktopEnvelope(token, existingTracks, pendingDeletes)` reads DB, uploads audio for missing driveFileIds, excludes `pendingDeletes`, writes `deletedTracks`.
- `src/ui/App.tsx` `confirmDeleteTrack` (line ~553): `delete_track_file` + `LibraryManager.removeTrack` + `driveSync.queueDeletion(songKeyOf(track))`.
- `src/core/services/cloudsyncDb.ts`: `buildDesktopEnvelope` + `applyDesktopEnvelope` (favorites/playlists merge only — deletion application currently DISABLED, see §5).
- Panel: `src/ui/components/GoogleDriveSyncPanel.tsx` (desktop) + `web/GoogleDriveSyncPanel.tsx` — Upload/Download/Sign out buttons.

## 5. Remaining work (the actual job of the next session)

### 5.1 ⭐ Receiving-side deletion (THE main missing piece)
When a device pulls an envelope whose `deletedTracks` contains a songKey it has locally, it must:
1. Remove the track **metadata** locally:
   - **web**: remove the `drive-<songKey>` entry from `webTrackStore`, and any normal track whose songKey matches; persist.
   - **desktop**: `LibraryManager.removeTrack` for each local track whose `songKeyOf(track)` is in `deletedTracks`.
2. Remove the **downloaded audio copy**:
   - **web**: `removeDownloadedAudio(trackId)` (IndexedDB) + revoke blob URL in `downloadedRef`.
   - **desktop**: `delete_track_file` for local files when the desktop delete semantics require it (§3: "from library and disk").
3. Wire it through the existing apply path:
   - `runSync` (in `useGoogleSync`) already unions `deletedTracks` into the payload — but **no code currently APPLIES them** (the old `onApplyDeletedTracks` / `applyDesktopEnvelope` delete blocks were removed to stop the mass-delete bug).
   - `onApplyDrive` (host-provided) should now, when applying the winner, also process `deletedTracks` → delete local matching tracks (explicit keys only).
   - Suggested: restore an `onDeletedTracks(songKeys[])` callback on the shared hook / `useWebDriveSync` / `useDesktopDriveSync`, implemented in `web/WebApp.tsx` and desktop.

**SAFETY RULE (critical, do not violate):**
- Only delete tracks whose songKey is EXPLICITLY in `deletedTracks`.
- **Never** delete based on "local has X but drive doesn't" (diff-based). The diff approach caused total library wipe twice and is banned.

### 5.2 Auto-download confirmation & UX
- `onApplyDriveTracks` auto-download already exists (web). Verify it also fires after a Changes-API-triggered `runSync` (not only after manual Download).
- Desktop receiving side has NO auto-download of drive-synced audio yet — decide + implement (desktop should download the drive audio for newly-synced tracks into a local dir, or leave them as Drive-backed entries with download-on-play; **user chose auto-download**).
- Consider a "Syncing / Downloading…" progress indicator.

### 5.3 Desktop add-track propagation sanity
- Desktop uploads audio for local tracks lacking `driveFileId` (done in `buildDesktopEnvelope`). Verify the Changes-API poll pushes new desktop tracks to Drive automatically (currently only Upload button pushes; the poll only PULLS). **User wants full automation** → the poll should also push local changes (or at least new tracks), not only pull. Decide the trigger: track `payloadSignature` changes and push after detection, or merge push into the periodic cycle.
- Same for favorites/playlists changes (web already pushes on signature change; desktop pushes via `getLocalEnvelope` only during `runSync`).

### 5.4 Cleanup / hardening
- Remove now-unused `getKnownTrackKeys`/`previouslySynced` plumbing if it becomes dead after the final design.
- The Changes-API interval (15s) — confirm acceptable, or make configurable.
- Ensure `ackDeletion` is called after a successful push so `pendingDeletes` doesn't grow unbounded.

## 6. How the final automated loop should look (target)

```
Device A deletes track X → queueDeletion(X) → next sync cycle:
  push: envelope { tracks: [...without X], deletedTracks: [...+X] } → Drive
Device B (Changes API detects change ~15s):
  listChanges → changed=true → runSync(true) → fetchDriveData
  → apply: add missing tracks (auto-download audio), apply favorites/playlists,
    process deletedTracks → remove X metadata + downloaded audio
Device B adds track Y → uploads audio + metadata to Drive
Device A detects change → pulls Y, auto-downloads audio
```

## 7. Verification checklist (user will test on real devices)

1. **Desktop → Web, add**: desktop imports a new track → within ~15-30s web shows it and can play offline (audio downloaded).
2. **Web → Desktop, add**: web-imported/Drive-synced track appears on desktop.
3. **Desktop → Web, delete**: desktop deletes a track → within ~15-30s web removes it (metadata + downloaded audio gone). Track does NOT resurrect.
4. **Web → Desktop, delete**: web deletes a track → desktop removes it (library + disk).
5. **Favorites**: heart on one device → appears on the other.
6. **Playlists**: create/add on one device → reflects on the other (no duplicates).
7. **No spurious deletions**: after any of the above, tracks that were NOT deleted remain on both devices.
8. **Restart persistence**: both devices remain signed in after app restart (localStorage token + refresh).

## 8. Known traps / config for the next session

- **Google OAuth config** (in Google Cloud Console, project for `283330332801-...`):
  - Web client (GIS inline): JS origins must include `http://localhost:3000` + your deployed origin.
  - Desktop client: loopback PKCE redirect `http://127.0.0.1:8543/oauth_callback`; needs `client_secret` from **local `.env`** (`VITE_GOOGLE_CLIENT_SECRET`) — never commit it (GitHub Push Protection blocks secrets; the old exposed secret should be rotated).
- **Tauri window origin**: desktop dev origin `http://localhost:1420`; the installed app's `tauri.localhost` can't be a GIS origin → that's why desktop uses system-browser PKCE via `src-tauri/src/google_oauth.rs`.
- **Drive 401 handling**: `gfetch` throws `DriveAuthError` on 401 → hosts call `invalidateAuth()`. If web tokens expire, user must re-sign-in (GIS silent refresh may not cover long sessions).
- **Never** reintroduce diff-based deletion (banned, caused library wipes).
- Building: desktop `npm run tauri dev` (Rust + Vite), web `npm run dev:web` (port 3000). Type-check: `npx tsc` for src, web via temp tsconfig including `web/`.
- Working tree is dirty with the whole feature; commit carefully (exclude `.env`, `.reasonix/*`, `dist-web` churn if unwanted).

## 9. Key files index

| File | Role |
|---|---|
| `src/core/services/googleDriveSync.ts` | Drive REST + Changes API + token cache (shared) |
| `src/core/services/cloudsync.ts` | payload types, songKey, merge helpers (shared) |
| `src/ui/useGoogleSync.ts` | shared sync hook (upload/download/changes-poll/sign-in) |
| `src/core/services/cloudsyncDb.ts` | desktop envelope build/apply (DB) |
| `src/ui/useDesktopDriveSync.ts` | desktop hook wrapper + pending-delete queue |
| `src/ui/App.tsx` | desktop library actions incl. `confirmDeleteTrack` |
| `web/useWebDriveSync.ts` | web hook wrapper + pending-delete queue |
| `web/WebApp.tsx` | web UI: remove/inject/auto-download/play |
| `web/syncPayload.ts` | web payload serialization |
| `web/downloads.ts` | IndexedDB audio storage |
| `src-tauri/src/google_oauth.rs` | desktop system-browser OAuth (PKCE + refresh) |
| `src/ui/components/GoogleDriveSyncPanel.tsx`, `web/GoogleDriveSyncPanel.tsx` | login/upload/download UI |
