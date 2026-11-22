/**
 * GoogleDriveSyncPanel — the UI for NeedMusic's free Google-Drive-based
 * cross-device sync. Rendered on the web "Login" page.
 *
 * Styled to match the rest of the settings pages: no box/card, just a clean
 * section with a horizontal divider keeping it consistent with the app's
 * background (no purple/blue card look).
 */

import React, { useEffect, useState } from "react";
import type { GoogleSyncStatus } from "./useGoogleSync";
import type { AudioMode } from "@core/services/cloudsync";

export interface GoogleSyncPanelProps {
  signedIn: boolean;
  account: { email: string; name: string; picture: string } | null;
  status: GoogleSyncStatus;
  hasConfig: boolean;
  onSignIn: () => void;
  onSignOut: () => void;
  onClean: () => void;
  onOpenGuide: () => void;
  /** Layer-2 policy: what audio this device uploads to Drive. */
  audioMode?: AudioMode;
  onAudioModeChange?: (mode: AudioMode) => void;
  /** Number of songs wanted available in Drive. */
  offlineCount?: number;
  driveItems?: { songKey: string; title: string; hasAudio: boolean }[];
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
  onClean,
  onOpenGuide,
  audioMode = "selected",
  onAudioModeChange,
  offlineCount = 0,
  driveItems = [],
}) => {
  const busy = isBusy(status);
  const error = status.state === "error";
  const synced = status.state === "synced";
  const divider = { padding: "4px 0 16px", borderBottom: "1px solid var(--glass-border, rgba(255,255,255,0.08))", marginBottom: 12 } as const;
  const [developerMode, setDeveloperMode] = useState(() => localStorage.getItem("needmusic:developerMode") === "true");
  const [countdown, setCountdown] = useState(20);
  useEffect(() => {
    const tick = () => {
      const last = status.state === "synced" && status.at ? Date.parse(status.at) : Date.now();
      setCountdown(Math.max(0, Math.ceil((last + 20_000 - Date.now()) / 1000)));
    };
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [status]);

  if (!signedIn) {
    return (
      <section className="gdrive-login-page">
        <div className="gdrive-login-content">
          <div className="gdrive-login-brand"><span aria-hidden>♫</span> NeedMusic</div>
          <h2>Welcome Back</h2>
          {error && <div className="gdrive-login-error">{status.detail}</div>}
          {hasConfig ? (
            <button className="gdrive-google-button" onClick={onSignIn} disabled={busy}>
              <span className="gdrive-google-mark" aria-hidden>G</span>
              {busy ? "Signing in…" : "Sign in with Google"}
            </button>
          ) : (
            <button className="settings-btn" onClick={onOpenGuide}>Configure Google sign-in →</button>
          )}
          <p>By signing in, you allow NeedMusic to sync your library data in your private Google Drive app folder.</p>
          <button className="gdrive-setup-link" onClick={onOpenGuide}>Privacy and sync details</button>
        </div>
      </section>
    );
  }

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
      {signedIn && <p style={{ fontSize: 13, color: "var(--text-tertiary)", margin: "0 0 12px" }}>Next automatic sync in {countdown}s</p>}
      {signedIn && <label style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 13, marginBottom: 12 }}>
        <input type="checkbox" checked={developerMode} onChange={(e) => { const v = e.target.checked; setDeveloperMode(v); localStorage.setItem("needmusic:developerMode", String(v)); }} /> Developer mode
      </label>}
      {signedIn && developerMode && <div style={{ maxHeight: 260, overflow: "auto", fontSize: 12, marginBottom: 14, padding: 10, border: "1px solid var(--glass-border)", borderRadius: 6 }}>
        <strong>Drive sync items ({driveItems.length})</strong>
        {driveItems.map((item) => <div key={item.songKey} style={{ display: "flex", justifyContent: "space-between", gap: 8, padding: "4px 0" }}><span title={item.songKey}>{item.title}</span><span>{item.hasAudio ? "Audio + metadata" : "Metadata only"}</span></div>)}
        {!driveItems.length && <div>No tracks in the latest sync snapshot.</div>}
      </div>}

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

          {/* ── Storage policy (which audio lives in Drive) ── */}
          <div style={{ marginTop: 16 }}>
            <label style={{ display: "block", fontSize: 14, color: "var(--text-secondary)", marginBottom: 6 }}>
              Audio in Drive
            </label>
            <select
              className="settings-input"
              value={audioMode}
              onChange={(e) => onAudioModeChange?.(e.target.value as AudioMode)}
              style={{ width: "100%", maxWidth: 320, padding: "10px 12px", fontSize: 15 }}
            >
              <option value="selected">Only marked tracks (recommended)</option>
              <option value="all">Every track (full cloud backup)</option>
              <option value="none">Never upload audio</option>
            </select>
            <p style={{ fontSize: 12, color: "var(--text-tertiary)", marginTop: 8, lineHeight: 1.5 }}>
              Metadata, favourites, progress and playlists always sync. Audio is uploaded only
              for tracks you mark <strong>Available offline</strong>
              {offlineCount > 0 ? ` (${offlineCount} marked)` : ""}.
            </p>
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
