/**
 * GoogleDriveSyncPanel — the UI for NeedMusic's free Google-Drive-based
 * cross-device sync. Rendered on the web "Login" page.
 *
 * Styled to match the rest of the settings pages: no box/card, just a clean
 * section with a horizontal divider keeping it consistent with the app's
 * background (no purple/blue card look).
 */

import React from "react";
import type { GoogleSyncStatus } from "./useGoogleSync";

export interface GoogleSyncPanelProps {
  signedIn: boolean;
  account: { email: string; name: string; picture: string } | null;
  status: GoogleSyncStatus;
  hasConfig: boolean;
  onSignIn: () => void;
  onSignOut: () => void;
  onUpload: () => void;
  onDownload: () => void;
  onClean: () => void;
  onOpenGuide: () => void;
}

function statusText(status: GoogleSyncStatus): string {
  switch (status.state) {
    case "idle": return "Ready";
    case "needs-config": return "Add your Google CLIENT_ID to enable sync.";
    case "unsigned": return "Sign in to sync favorites & playlists across devices.";
    case "authorizing": return status.detail || "Authorizing…";
    case "syncing": return status.detail || "Syncing…";
    case "synced": return status.detail || "Synced ✓";
    case "error": return status.detail || "Sync error.";
    default: return "";
  }
}

const isBusy = (s: GoogleSyncStatus) => s.state === "authorizing" || s.state === "syncing";

const GoogleDriveSyncPanel: React.FC<GoogleSyncPanelProps> = ({
  signedIn,
  account,
  status,
  hasConfig,
  onSignIn,
  onSignOut,
  onUpload,
  onDownload,
  onClean,
  onOpenGuide,
}) => {
  const busy = isBusy(status);
  const error = status.state === "error";
  const synced = status.state === "synced";
  const divider = { padding: "4px 0 16px", borderBottom: "1px solid var(--glass-border, rgba(255,255,255,0.08))", marginBottom: 12 } as const;

  return (
    <section>
      <h4 style={{ marginBottom: 12, fontSize: 16 }}>Google Drive Sync</h4>

      {!hasConfig && (
        <div style={divider}>
          <button
            onClick={onOpenGuide}
            style={{ padding: "10px 16px", background: "#333", color: "#fff", border: "none", borderRadius: 6, cursor: "pointer", fontSize: 15 }}
          >
            Configure Google CLIENT_ID →
          </button>
        </div>
      )}

      {error && (
        <div style={{ fontSize: 14, color: "var(--color-error)", marginBottom: 12 }}>
          {status.detail}
        </div>
      )}

      {!hasConfig ? (
        <></>
      ) : signedIn ? (
        <div style={divider}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            {account?.picture && (
              <img src={account.picture} alt="" width={40} height={40} style={{ borderRadius: "50%", objectFit: "cover" }} referrerPolicy="no-referrer" />
            )}
            <span style={{ fontSize: 16 }}>
              {account?.name || "Signed in"}
              {account?.email && <span style={{ color: "var(--text-tertiary)", display: "block", fontSize: 13 }}>{account.email}</span>}
            </span>
            <span style={{ fontSize: 13, color: synced ? "var(--color-success)" : error ? "var(--color-error)" : "var(--text-tertiary)" }}>
              {busy ? "…" : statusText(status)}
            </span>
          </div>
          <div style={{ display: "flex", gap: 10, marginTop: 14, flexWrap: "wrap" }}>
            <button
              onClick={onUpload}
              disabled={busy}
              style={{ padding: "10px 16px", background: "#333", color: "#fff", border: "none", borderRadius: 6, cursor: "pointer", fontSize: 15 }}
            >
              Upload
            </button>
            <button
              onClick={onDownload}
              disabled={busy}
              style={{ padding: "10px 16px", background: "#2f6fed", color: "#fff", border: "none", borderRadius: 6, cursor: "pointer", fontSize: 15 }}
            >
              Download
            </button>
            <button
              onClick={onSignOut}
              style={{ padding: "10px 16px", background: "transparent", color: "var(--color-error)", border: "1px solid var(--color-error)", borderRadius: 6, cursor: "pointer", fontSize: 15 }}
            >
              Sign out
            </button>
            <button
              onClick={onClean}
              disabled={busy}
              title="Delete all Drive sync data (envelope + audio) and reset local sync state"
              style={{ padding: "10px 16px", background: "transparent", color: "var(--color-error)", border: "1px solid #a02030", borderRadius: 6, cursor: "pointer", fontSize: 15, opacity: busy ? 0.5 : 1 }}
            >
              🧹 Clean everything
            </button>
          </div>
        </div>
      ) : (
        <div style={divider}>
          <button
            onClick={onSignIn}
            disabled={busy}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 10,
              padding: "12px 22px",
              borderRadius: 6,
              border: "none",
              background: "var(--accent-primary, #e94560)",
              color: "#fff",
              cursor: "pointer",
              fontSize: 16,
              fontWeight: 500,
            }}
          >
            <span aria-hidden style={{ fontSize: 18 }}>G</span>
            {busy ? "Signing in…" : "Sign in with Google"}
          </button>
        </div>
      )}
    </section>
  );
};

export default GoogleDriveSyncPanel;
