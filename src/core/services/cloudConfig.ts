/**
 * cloudConfig — desktop-side Google OAuth configuration.
 *
 * The shared Drive layer (`googleDriveSync`) holds the session's client id.
 * This module exposes the desktop build's client id/secret, allowing override
 * from the environment (`VITE_GOOGLE_CLIENT_ID` / `VITE_GOOGLE_CLIENT_SECRET`)
 * so you can centralize configuration in `.env` instead of editing code.
 *
 * Configure each target ONCE (web uses a Web client for GIS; desktop uses a
 * Desktop/public client with a secret for the loopback PKCE flow) — see
 * docs/google-drive-sync.md and .env.example.
 */

function readEnv(key: string): string {
  try {
    if (typeof import.meta !== "undefined" && (import.meta as any).env) {
      return ((import.meta as any).env[key] as string) || "";
    }
  } catch { /* unavailable */ }
  return "";
}

/* Desktop OAuth client id (Desktop/public client). Override via VITE_GOOGLE_CLIENT_ID. */
export const DESKTOP_GOOGLE_CLIENT_ID: string =
  readEnv("VITE_GOOGLE_CLIENT_ID") ||
  "283330332801-iu47208deqc5p2cqjfcpsc416cntvht0.apps.googleusercontent.com";

/**
 * OAuth client secret for the desktop client — read ONLY from the environment
 * (`VITE_GOOGLE_CLIENT_SECRET`) so a real secret is never committed to the
 * repository. Google's token endpoint insists on a client_secret for this
 * client even with PKCE.
 *
 * IMPORTANT: set this in your local `.env` (see .env.example), otherwise the
 * desktop token exchange will fail with "client_secret is missing".
 */
export const DESKTOP_GOOGLE_CLIENT_SECRET: string = readEnv("VITE_GOOGLE_CLIENT_SECRET");
