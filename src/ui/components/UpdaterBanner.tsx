import React, { useEffect, useState, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-shell";
import { DatabaseManager } from "@core/services/DatabaseManager";
import { IconAlert, IconClose, IconRocket } from "@ui/components/Icons";

interface UpdateInfo {
  update_available: boolean;
  current_version: string;
  latest_version: string;
  download_url: string | null;
  notes?: string | null;
}

type Phase =
  | { name: "checking" }
  | { name: "hidden" }
  | { name: "available"; info: UpdateInfo }
  | { name: "downloading"; info: UpdateInfo }
  | { name: "launching"; info: UpdateInfo }
  | { name: "error"; info: UpdateInfo | null; message: string };

/**
 * Update banner — checks GitHub Releases once at startup and offers a
 * one-click update ("A new version is available: v1.1 [Update now]").
 * Dismissing a version stops nagging until the next release.
 */
const UpdaterBanner: React.FC = () => {
  const [phase, setPhase] = useState<Phase>({ name: "checking" });
  const cancelledRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const db = DatabaseManager.getInstance();
      try {
        const dismissed = await db.getSetting("dismissedUpdateVersion");
        const info = await invoke<UpdateInfo>("check_for_update");
        if (cancelled) return;
        if (!info.update_available || info.latest_version === dismissed) {
          setPhase({ name: "hidden" });
        } else {
          setPhase({ name: "available", info });
        }
      } catch {
        if (!cancelled) setPhase({ name: "hidden" }); // offline — stay quiet
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const handleUpdate = useCallback(async () => {
    if (phase.name !== "available") return;
    const info = phase.info;
    if (!info.download_url) {
      setPhase({ name: "error", info, message: "No installer download link on the release page." });
      return;
    }
    setPhase({ name: "downloading", info });
    try {
      const path = await invoke<string>("download_update", { url: info.download_url });
      if (cancelledRef.current) return; // dismissed mid-download
      setPhase({ name: "launching", info });
      await open(path); // launch the NSIS installer
      // Keep showing a hint; the installer will prompt to close the app.
    } catch (e) {
      if (cancelledRef.current) return;
      setPhase({ name: "error", info, message: String(e) });
    }
  }, [phase]);

  const handleDismiss = useCallback(async () => {
    cancelledRef.current = true;
    if (phase.name === "available" || phase.name === "downloading" || phase.name === "launching" || phase.name === "error") {
      if (phase.info) {
        const db = DatabaseManager.getInstance();
        await db.setSetting("dismissedUpdateVersion", phase.info.latest_version);
      }
    }
    setPhase({ name: "hidden" });
  }, [phase]);

  if (phase.name === "hidden" || phase.name === "checking") return null;

  const isError = phase.name === "error";

  return (
    <div className={`update-banner ${isError ? "update-banner-error" : ""}`}>
      <div className="update-banner-icon">
        {isError ? <IconAlert size={16} /> : <IconRocket size={16} />}
      </div>
      <div className="update-banner-text">
        {phase.name === "available" && (
          <>
            <strong>A new version is available: v{phase.info.latest_version}</strong>
            <span className="update-banner-sub">You are on v{phase.info.current_version}. Update in one click.</span>
          </>
        )}
        {phase.name === "downloading" && (
          <><strong>Downloading v{phase.info.latest_version}…</strong>
            <span className="update-banner-sub">This may take a minute.</span></>
        )}
        {phase.name === "launching" && (
          <><strong>Installer launched</strong>
            <span className="update-banner-sub">Close NeedMusic when prompted to finish updating.</span></>
        )}
        {phase.name === "error" && (
          <><strong>Update failed</strong>
            <span className="update-banner-sub">{phase.message}</span></>
        )}
      </div>
      <div className="update-banner-actions">
        {phase.name === "available" && (
          <button className="update-banner-btn" onClick={handleUpdate}>Update now</button>
        )}
        {phase.name === "error" && phase.info?.download_url && (
          <button
            className="update-banner-btn"
            onClick={() => open(phase.info!.download_url!)}
          >Open release page</button>
        )}
        <button className="update-banner-dismiss" onClick={handleDismiss} title="Dismiss">
          <IconClose size={12} />
        </button>
      </div>
    </div>
  );
};

export default UpdaterBanner;
