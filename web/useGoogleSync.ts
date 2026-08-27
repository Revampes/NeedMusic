/**
 * useGoogleSync — shared web + desktop Google sign-in / Drive sync hook.
 *
 * Re-exports the shared implementation in `src/ui/useGoogleSync.ts` so the web
 * build and the Tauri desktop app run the same GIS + OAuth + sync orchestration.
 */
export {
  useGoogleSync,
  type GoogleSyncStatus,
  type DriveAccount,
} from "../src/ui/useGoogleSync";
