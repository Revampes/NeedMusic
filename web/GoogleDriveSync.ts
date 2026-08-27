/**
 * GoogleDriveSync — shared web + desktop Drive sync layer.
 *
 * This file is now a thin re-export of the shared implementation in
 * `src/core/services/googleDriveSync.ts` so the same fetch/Drive code is used
 * by both the web build and the Tauri desktop app.
 */
export {
  SYNC_SCOPE,
  SYNC_FILE_NAME,
  GIS_SCRIPT_SRC,
  loadGisScript,
  cacheToken,
  getCachedToken,
  setGoogleClientId,
  getGoogleClientId,
  hasGoogleClientId,
  fetchDriveData,
  saveDriveData,
  resolveConflicts,
  uploadAudioFile,
  downloadAudioFile,
  DriveApiError,
  DriveAuthError,
  type DriveSyncEnvelope,
} from "@core/services/googleDriveSync";
