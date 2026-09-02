/**
 * GoogleDriveSyncPanel (desktop) — the Settings-section panel for NeedMusic's
 * free Google-Drive-based cross-device sync, styled with the desktop app's CSS
 * variables. Mirrors the web panel's behaviour (sign-in, account, status).
 */

import React from "react";

export interface GoogleSyncPanelProps {
  signedIn: boolean;
  account: { email: string; name: string; picture: string } | null;
  status: {
    state: string;
    detail?: string;
  };
  hasConfig: boolean;
  onSignIn: () => void;
  onSignOut: () => void;
  onUpload: () => void;
  onDownload: () => void;
  onClean: () => void;
  onOpenGuide: () => void;
}

function statusText(status: GoogleSyncPanelProps["status"]): string {
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
  const busy = status.state === "authorizing" || status.state === "syncing";
  const error = status.state === "error";
  const synced = status.state === "synced";
  const accentColor = synced ? "var(--color-success)" : error ? "var(--color-error)" : "var(--text-tertiary)";

  return (
    <section>
      <h3 style={{ marginBottom: 8 }}>
        <span role="img" aria-label="cloud">☁️</span> Google Drive Sync{" "}
        <span style={{ fontSize: 10, color: "var(--text-tertiary)", fontWeight: 400 }}>
          (free, cross-device)
        </span>
      </h3>
      <p style={{ fontSize: 11, color: "var(--text-secondary)", marginBottom: 10, lineHeight: 1.5 }}>
        Store your tracks/favorites/playlists in your own Google Drive (private{" "}
        <code>appDataFolder</code>). <strong>Upload</strong> pushes this device to Drive;{" "}
        <strong>Download</strong> pulls Drive tracks not already here. No automatic sync.{" "}
        <button
          onClick={onOpenGuide}
          style={{ background: "none", border: "none", color: "var(--accent-primary)", cursor: "pointer", fontWeight: 600, padding: 0, fontSize: 11 }}
        >
          Setup guide
        </button>
      </p>

      {error && (
        <div style={{ fontSize: 11, color: "var(--color-error)", background: "rgba(233,69,96,0.08)", border: "1px solid rgba(233,69,96,0.2)", borderRadius: 6, padding: "8px 10px", lineHeight: 1.5, marginBottom: 10 }}>
          {status.detail}
        </div>
      )}

      {!hasConfig ? (
        <button className="settings-btn" onClick={onOpenGuide} style={{ background: "var(--btn-hover-bg)", color: "var(--text-secondary)", border: "1px solid var(--glass-border-strong)" }}>
          Configure Google CLIENT_ID →
        </button>
      ) : signedIn ? (
        <>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 8 }}>
            {account?.picture && (
              <img src={account.picture} alt="" width={26} height={26} style={{ borderRadius: "50%", objectFit: "cover" }} referrerPolicy="no-referrer" />
            )}
            <span style={{ fontSize: 13 }}>
              {account?.name || "Signed in"}
              {account?.email && <span style={{ color: "var(--text-tertiary)", display: "block", fontSize: 11 }}>{account.email}</span>}
            </span>
            <span
              style={{
                fontSize: 11,
                padding: "2px 8px",
                borderRadius: 4,
                background: "var(--glass-bg)",
                color: busy ? "var(--color-warning)" : accentColor,
              }}
            >
              {busy ? "…" : statusText(status)}
            </span>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button className="settings-btn" onClick={onUpload} disabled={busy} style={{ fontSize: 12 }}>
              Upload
            </button>
            <button className="settings-btn" onClick={onDownload} disabled={busy} style={{ fontSize: 12 }}>
              Download
            </button>
            <button className="settings-btn" onClick={onSignOut} style={{ fontSize: 12, color: "var(--color-error)", background: "transparent", border: "1px solid var(--color-error)" }}>
              Sign out
            </button>
            <button className="settings-btn" onClick={onClean} disabled={busy} title="Delete all Drive sync data + reset local sync state"
              style={{ fontSize: 12, color: "var(--color-error)", background: "transparent", border: "1px solid var(--color-error)", opacity: busy ? 0.5 : 1 }}>
              🧹 Clean everything
            </button>
          </div>
        </>
      ) : (
        <>
          <button
            className="settings-btn primary"
            onClick={onSignIn}
            disabled={busy}
            style={{ display: "inline-flex", alignItems: "center", gap: 8, background: "var(--accent-primary)", color: "#fff" }}
          >
            <span role="img" aria-hidden>G</span>
            {busy ? "Signing in…" : "Sign in with Google"}
          </button>
          <p style={{ fontSize: 10, color: "var(--text-tertiary)", marginTop: 8, marginBottom: 0 }}>
            Only needs the non-sensitive <code>drive.appdata</code> scope — your private app folder.
          </p>
        </>
      )}
    </section>
  );
};

export default GoogleDriveSyncPanel;
