import React, { useState, useCallback } from "react";
import { LibraryManager } from "@core/services/LibraryManager";
import { Track } from "@core/models/Track";
import { IconFolder, IconHourglass, IconCheck, IconAlert } from "@ui/components/Icons";

interface LibraryScanProps {
  onTracksLoaded?: (tracks: Track[]) => void;
}

/**
 * LibraryScan — UI component for selecting a music folder and scanning for audio files.
 * Shows progress and results from the Rust backend scanner.
 */
const LibraryScan: React.FC<LibraryScanProps> = ({ onTracksLoaded }) => {
  const [isScanning, setIsScanning] = useState(false);
  const [scanPath, setScanPath] = useState("");
  const [result, setResult] = useState<{
    trackCount: number;
    errorCount: number;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleScan = useCallback(async () => {
    if (!scanPath.trim()) return;

    setIsScanning(true);
    setError(null);
    setResult(null);

    try {
      const library = LibraryManager.getInstance();
      await library.scanDirectory(scanPath.trim());

      const allTracks = library.getAllTracks();
      setResult({
        trackCount: allTracks.length,
        errorCount: 0,
      });
      onTracksLoaded?.(allTracks);
    } catch (err) {
      setError(String(err));
    } finally {
      setIsScanning(false);
    }
  }, [scanPath, onTracksLoaded]);

  return (
    <div style={{ padding: "16px" }}>
      <h3 style={{ marginBottom: 12, fontSize: 16, color: "#ccc", display: "flex", alignItems: "center" }}>
        <IconFolder size={16} style={{ marginRight: 6 }} />Music Library
      </h3>

      {result && result.trackCount === 0 && (
        <div style={{ marginBottom: 16, padding: 12, background: "#1e1e1e", borderRadius: 8 }}>
          <p style={{ color: "#ccc", margin: 0 }}>
            No tracks found yet. Add a folder to start building your library.
          </p>
        </div>
      )}

      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        <input
          type="text"
          placeholder="e.g. C:\Users\user\Music"
          value={scanPath}
          onChange={(e) => setScanPath(e.target.value)}
          disabled={isScanning}
          style={{
            flex: 1,
            padding: "8px 12px",
            background: "#2a2a2a",
            border: "1px solid #3a3a3a",
            borderRadius: 6,
            color: "#eee",
            fontSize: 13,
            outline: "none",
          }}
        />
        <button
          onClick={handleScan}
          disabled={isScanning || !scanPath.trim()}
          style={{
            padding: "8px 16px",
            background: isScanning ? "#2a2a2a" : "#e94560",
            border: "none",
            borderRadius: 6,
            color: "#fff",
            cursor: isScanning ? "default" : "pointer",
            fontSize: 13,
            fontWeight: 600,
            whiteSpace: "nowrap",
          }}
        >
          {isScanning ? <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}><IconHourglass size={13} />Scanning...</span> : "Scan"}
        </button>
      </div>

      {isScanning && (
        <div style={{ color: "#e94560", fontSize: 13 }}>
          Scanning files... this may take a moment for large libraries.
        </div>
      )}

      {result && result.trackCount > 0 && (
        <div
          style={{
            padding: "8px 12px",
            background: "#2a2a2a",
            borderRadius: 6,
            color: "#4ecca3",
            fontSize: 13,
          }}
        >
          <IconCheck size={14} style={{ marginRight: 4 }} />{result.trackCount} tracks in library
        </div>
      )}

      {error && (
        <div
          style={{
            padding: "8px 12px",
            background: "rgba(233,69,96,0.15)",
            borderRadius: 6,
            color: "#e94560",
            fontSize: 13,
            marginTop: 8,
          }}
        >
          <IconAlert size={14} style={{ marginRight: 4 }} />Scan failed: {error}
        </div>
      )}
    </div>
  );
};

export default LibraryScan;
