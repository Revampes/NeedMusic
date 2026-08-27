/**
 * Google API configuration for the Drive-based cross-device sync (web build).
 *
 * The shared Drive layer in `@core/services/googleDriveSync` reads the client
 * id stored there. This module pulls it from the Vite-build-time environment
 * variable `VITE_GOOGLE_CLIENT_ID` (or a hardcoded default) and injects it into
 * the shared layer, then exposes the string value / predicate used by the UI.
 *
 * See `docs/google-drive-sync.md` for how to register the app and obtain a
 * CLIENT_ID.
 */

import {
  setGoogleClientId,
  getGoogleClientId,
  hasGoogleClientId,
} from "@core/services/googleDriveSync";

/** Hardcoded fallback for local development — set VITE_GOOGLE_CLIENT_ID to override. */
const DEFAULT_CLIENT_ID =
  "283330332801-tkc5c55figkopvmgu02u1run2js63rvj.apps.googleusercontent.com";

// Inject the configured client id into the shared layer on first import.
const envClientId: string =
  typeof import.meta !== "undefined" && (import.meta as any).env
    ? ((import.meta as any).env.VITE_GOOGLE_CLIENT_ID as string) || ""
    : "";
const injectedClientId = (envClientId || DEFAULT_CLIENT_ID).trim();
if (injectedClientId) setGoogleClientId(injectedClientId);

/** OAuth client ID string for "Sign in with Google" (Google Identity Services). */
export const GOOGLE_CLIENT_ID: string = getGoogleClientId();

export { hasGoogleClientId };
