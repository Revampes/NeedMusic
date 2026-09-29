/**
 * GoogleDriveSyncPanel (desktop) — the Settings-section panel for NeedMusic's
 * free Google-Drive-based cross-device sync, styled with the desktop app's CSS
 * variables. Mirrors the web panel's behaviour (sign-in, account, status).
 */

import React from "react";
import type { AudioMode } from "@core/services/cloudsync";

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
  /** Layer-2 policy: what audio this device uploads to Drive. */
  audioMode?: AudioMode;
  onAudioModeChange?: (mode: AudioMode) => void;
  /** Number of songs whose audio this device wants available in Drive. */
  offlineCount?: number;
  /** Delete Drive audio for songs nothing references any more. */
  onReclaimDriveSpace?: () => void;
  reclaimBusy?: boolean;
  reclaimResult?: string | null;
  /** Songs that exist in Drive (with audio) but are NOT in this library yet. */
  downloadableTracks?: { songKey: string; title: string; artist: string; sizeBytes?: number }[];
  /** Download one of those into this device's library. */
  onDownloadTrack?: (songKey: string) => void;
  downloadingKey?: string | null;
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
  audioMode = "selected",
  onAudioModeChange,
  offlineCount = 0,
  onReclaimDriveSpace,
  reclaimBusy = false,
  reclaimResult = null,
  downloadableTracks = [],
  onDownloadTrack,
  downloadingKey = null,
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

          {/* ── Storage policy (which audio lives in Drive) ── */}
          <div style={{ marginTop: 14, paddingTop: 12, borderTop: "1px solid var(--glass-border)" }}>
            <label className="settings-row" style={{ alignItems: "flex-start" }}>
              <span style={{ minWidth: 132 }}>Audio in Drive</span>
              <select
                className="settings-input"
                style={{ width: 190 }}
                value={audioMode}
                onChange={(e) => onAudioModeChange?.(e.target.value as AudioMode)}
              >
                <option value="selected">Only marked tracks (recommended)</option>
                <option value="all">Every track (full cloud backup)</option>
                <option value="none">Never upload audio</option>
              </select>
            </label>
            <p style={{ fontSize: 10, color: "var(--text-tertiary)", margin: "4px 0 8px", lineHeight: 1.5 }}>
              Metadata, favourites, ratings, progress and playlists always sync — they are tiny.
              Audio is uploaded only for tracks marked <strong>Available offline</strong>
              {offlineCount > 0 ? ` (${offlineCount} marked)` : ""}, so your Drive and your devices
              are never filled with copies you did not ask for. Tracks already in Drive are kept.
            </p>
            {onReclaimDriveSpace && (
              <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                <button className="settings-btn" onClick={onReclaimDriveSpace} disabled={reclaimBusy}
                  style={{ fontSize: 12, background: "var(--btn-hover-bg)", color: "var(--text-secondary)", border: "1px solid var(--glass-border-strong)" }}>
                  {reclaimBusy ? "Reclaiming…" : "Reclaim Drive space"}
                </button>
                <span style={{ fontSize: 10, color: "var(--text-tertiary)" }}>
                  {reclaimResult ?? "Deletes Drive audio for songs no device keeps offline."}
                </span>
              </div>
            )}

            {/* ── Songs in Drive that are not in this library yet ── */}
            {downloadableTracks.length > 0 && (
              <div style={{ marginTop: 12 }}>
                <div style={{ fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5, color: "var(--text-tertiary)", marginBottom: 6 }}>
                  In Drive, not on this device ({downloadableTracks.length})
                </div>
                <div style={{ maxHeight: 220, overflowY: "auto", display: "flex", flexDirection: "column", gap: 4 }}>
                  {downloadableTracks.map((t) => (
                    <div key={t.songKey} style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 6px", borderRadius: 6, background: "var(--glass-bg)" }}>
                      <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 12 }}>
                        {t.title}{t.artist ? <span style={{ color: "var(--text-tertiary)" }}> · {t.artist}</span> : null}
                      </span>
                      <button
                        className="settings-btn"
                        disabled={downloadingKey === t.songKey}
                        onClick={() => onDownloadTrack?.(t.songKey)}
                        title="Download this track onto this device"
                        style={{ fontSize: 11, padding: "3px 8px", flexShrink: 0 }}
                      >
                        {downloadingKey === t.songKey ? "Downloading…" : "⬇ Download"}
                      </button>
                    </div>
                  ))}
                </div>
                <p style={{ fontSize: 10, color: "var(--text-tertiary)", marginTop: 6, lineHeight: 1.5 }}>
                  These songs are synced from another device. Downloading keeps a copy here and on Drive.
                </p>
              </div>
            )}
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
