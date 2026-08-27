/**
 * GoogleDriveSyncPanel — the UI for NeedMusic's free Google-Drive-based
 * cross-device sync. Rendered inside the web Settings tab.
 *
 *   - unauth: "Sign in with Google" button (renders a branded GIS button).
 *   - auth: shows the account + a live sync status line + Sign out.
 *   - config missing: a link to the setup guide.
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
  onRunSync: () => void;
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
  onRunSync,
  onOpenGuide,
}) => {
  const busy = isBusy(status);
  const error = status.state === "error";
  const synced = status.state === "synced";

  return (
    <div style={{ marginBottom: 16, padding: 12, border: "1px solid #333", borderRadius: 8, background: "#14141f" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <h4 style={{ margin: 0, fontSize: 14 }}>
          <span style={{ marginRight: 4 }}>☁️</span> Google Drive Sync
          <span style={{ color: "#888", fontSize: 11, fontWeight: 400 }}> (free, cross-device)</span>
        </h4>
        {busy && <span className="lan-dot web-lan-dot" style={{ color: "#f0a500" }}></span>}
      </div>

      <p style={{ fontSize: 11, color: "#999", marginBottom: 10, lineHeight: 1.5 }}>
        Sync your favorites and playlists to your own Google Drive (private{" "}
        <code style={{ color: "#ccc" }}>appDataFolder</code>) so they follow you to any device —
        no account on NeedMusic's servers, no quota on your visible Drive.{" "}
        <button onClick={onOpenGuide} style={{ background: "none", border: "none", color: "#2f6fed", cursor: "pointer", fontWeight: 600, padding: 0, fontSize: 11 }}>
          Setup guide
        </button>
      </p>

      {error && (
        <p style={{ fontSize: 11, color: "var(--color-error)", background: "rgba(233,69,96,0.08)", border: "1px solid rgba(233,69,96,0.2)", borderRadius: 6, padding: "8px 10px", lineHeight: 1.5, marginBottom: 10 }}>
          {status.detail}
        </p>
      )}

      {!hasConfig ? (
        <button
          onClick={onOpenGuide}
          style={{ padding: "8px 16px", background: "#333", color: "#fff", border: "none", borderRadius: 6, cursor: "pointer", fontSize: 13 }}
        >
          Configure Google CLIENT_ID →
        </button>
      ) : signedIn ? (
        <>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            {account?.picture && (
              <img src={account.picture} alt="" width={26} height={26} style={{ borderRadius: "50%", objectFit: "cover" }} referrerPolicy="no-referrer" />
            )}
            <span style={{ fontSize: 13, color: "#e0e0e0" }}>
              {account?.name || "Signed in"}
              {account?.email && <span style={{ color: "#888", display: "block", fontSize: 11 }}>{account.email}</span>}
            </span>
            <span
              style={{
                fontSize: 11,
                padding: "2px 8px",
                borderRadius: 4,
                background: synced ? "rgba(78,204,163,0.12)" : error ? "rgba(233,69,96,0.12)" : "rgba(240,165,0,0.1)",
                color: synced ? "#4ecdc4" : error ? "#e94560" : "#f0a500",
              }}
            >
              {busy ? "…" : statusText(status)}
            </span>
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
            <button
              onClick={onRunSync}
              disabled={busy}
              style={{ padding: "6px 14px", background: "#333", color: "#fff", border: "none", borderRadius: 4, cursor: "pointer", fontSize: 12 }}
            >
              {busy ? "Syncing…" : "Sync now"}
            </button>
            <button
              onClick={onSignOut}
              style={{ padding: "6px 14px", background: "transparent", color: "#e94560", border: "1px solid #e94560", borderRadius: 4, cursor: "pointer", fontSize: 12 }}
            >
              Sign out
            </button>
          </div>
        </>
      ) : (
        <>
          <button
            onClick={onSignIn}
            disabled={busy}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
              padding: "8px 16px",
              borderRadius: 6,
              border: "1px solid #2f6fed",
              background: "#2f6fed",
              color: "#fff",
              cursor: "pointer",
              fontSize: 14,
              fontWeight: 500,
            }}
          >
            <span aria-hidden style={{ fontSize: 16 }}>G</span>
            {busy ? "Signing in…" : "Sign in with Google"}
          </button>
          <p style={{ fontSize: 10, color: "#666", marginTop: 8, marginBottom: 0 }}>
            Only needs the non-sensitive <code>drive.appdata</code> scope — your private app folder.
          </p>
        </>
      )}
    </div>
  );
};

export default GoogleDriveSyncPanel;
