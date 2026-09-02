/**
 * GoogleDriveSync — shared web + desktop Drive sync layer.
 *
 * This file is now a thin re-export of the shared implementation in
 * `src/core/services/googleDriveSync.ts` so the same fetch/Drive code is used
 * by both the web build and the Tauri desktop app.
 */
export {
  SYNC_SCOPE,
  SYNC_FILE_PREFIX,
  GIS_SCRIPT_SRC,
  loadGisScript,
  cacheToken,
  getCachedToken,
  getCachedTokenExpiry,
  cacheRefreshToken,
  getCachedRefreshToken,
  clearCachedCredentials,
  setGoogleClientId,
  getGoogleClientId,
  hasGoogleClientId,
  listSyncFiles,
  fetchDeviceFile,
  saveOwnSyncFile,
  uploadAudioFile,
  downloadAudioFile,
  clearAllDriveData,
  DriveApiError,
  DriveAuthError,
} from "@core/services/googleDriveSync";
export type { DeviceSyncFile } from "@core/services/cloudsync";
