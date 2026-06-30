import React, { useState, useCallback, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { OnlineMusicService, OnlineSearchItem } from "@core/services/OnlineMusicService";
import { PlaybackEngine } from "@core/services/PlaybackEngine";
import { DatabaseManager } from "@core/services/DatabaseManager";
import { IconMusic, IconPlay, IconClose, IconPlus } from "@ui/components/Icons";

/** Fetches a cover image through the Rust proxy (adds Referer header). */
const ProxiedCover: React.FC<{ url: string; alt: string }> = ({ url, alt }) => {
  const [dataUri, setDataUri] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    setDataUri(null);
    setFailed(false);
    if (!url) {
      setFailed(true);
      return;
    }
    invoke<string>("proxy_image", { url })
      .then((uri) => { if (mountedRef.current) setDataUri(uri); })
      .catch(() => { if (mountedRef.current) setFailed(true); });
    return () => { mountedRef.current = false; };
  }, [url]);

  if (failed || !dataUri) {
    return (
      <div className="online-result-cover-placeholder">
        <IconMusic size={28} />
      </div>
    );
  }
  return <img src={dataUri} alt={alt} loading="lazy" />;
};

interface OnlineSearchViewProps {
  onTrackSaved: () => void;
}

const OnlineSearchView: React.FC<OnlineSearchViewProps> = ({ onTrackSaved }) => {
  const [query, setQuery] = useState("");
  const [bilibiliResults, setBilibiliResults] = useState<OnlineSearchItem[]>([]);
  const [youtubeResults, setYoutubeResults] = useState<OnlineSearchItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [downloading, setDownloading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [youtubeEnabled, setYoutubeEnabled] = useState(false);
  const [downloadDir, setDownloadDir] = useState("");

  const service = OnlineMusicService.getInstance();
  const engine = PlaybackEngine.getInstance();
  const db = DatabaseManager.getInstance();

  // Load settings
  useEffect(() => {
    (async () => {
      const ytVal = await db.getSetting("youtubeSearch");
      setYoutubeEnabled(ytVal === "true");

      // Load download path: custom setting → system default
      let dir = await db.getSetting("onlineDownloadPath");
      if (!dir) {
        try {
          dir = await invoke<string>("get_default_download_dir");
        } catch {
          dir = ""; // Will show error on save attempt
        }
      }
      setDownloadDir(dir || "");
    })();
  }, [db]);

  // Auto-dismiss error after 8 seconds
  React.useEffect(() => {
    if (!error) return;
    const t = setTimeout(() => setError(null), 8000);
    return () => clearTimeout(t);
  }, [error]);

  // Search both sources
  const handleSearch = useCallback(async () => {
    const q = query.trim();
    if (!q) return;
    setLoading(true);
    setError(null);
    setBilibiliResults([]);
    setYoutubeResults([]);
    try {
      if (youtubeEnabled) {
        // Search both simultaneously
        const res = await service.searchCombined(q);
        setBilibiliResults(res.bilibili.results);
        setYoutubeResults(res.youtube.results);
        if (res.bilibili.results.length === 0 && res.youtube.results.length === 0) {
          setError("No results found. Try a different search term.");
        }
      } else {
        // Bilibili only
        const res = await service.searchBilibili(q);
        setBilibiliResults(res.results);
        if (res.results.length === 0) {
          setError("No results found. Try a different search term.");
        }
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [query, youtubeEnabled]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter") handleSearch();
    },
    [handleSearch],
  );

  // Download & play
  const handlePlay = useCallback(async (item: OnlineSearchItem) => {
    setDownloading(item.id);
    setError(null);
    try {
      const track = await service.downloadAndPlay(item);
      await engine.play(track);
    } catch (err) {
      setError(String(err));
    } finally {
      setDownloading(null);
    }
  }, [engine]);

  // Save to library
  const handleSave = useCallback(async (item: OnlineSearchItem) => {
    if (!downloadDir) {
      setError("Download directory not available. Check Settings.");
      return;
    }
    setDownloading(item.id);
    setError(null);
    try {
      await service.saveToLibrary(item, downloadDir);
      onTrackSaved();
    } catch (err) {
      setError(String(err));
    } finally {
      setDownloading(null);
    }
  }, [downloadDir, onTrackSaved]);

  const hasResults = bilibiliResults.length > 0 || youtubeResults.length > 0;
  const searchPlaceholder = youtubeEnabled
    ? "Search Bilibili & YouTube for music..."
    : "Search Bilibili for music...";

  const renderResultCard = (item: OnlineSearchItem) => (
    <div key={`${item.source}-${item.id}`} className="online-result-card">
      {/* Source badge */}
      <span className={`online-source-badge ${item.source}`}>
        {item.source === "youtube" ? "YT" : "Bili"}
      </span>
      {/* Cover image */}
      <div className="online-result-cover">
        <ProxiedCover url={item.cover_url} alt={item.title} />
        {/* Duration badge */}
        <span className="online-result-duration">{item.duration}</span>
        {/* Play button overlay */}
        <button
          className="online-result-play-btn"
          onClick={() => handlePlay(item)}
          disabled={downloading === item.id}
          title="Download & Play"
        >
          {downloading === item.id ? (
            <span className="online-spinner" />
          ) : (
            <IconPlay size={16} />
          )}
        </button>
      </div>
      {/* Info */}
      <div className="online-result-info">
        <div className="online-result-title" title={item.title}>
          {item.title}
        </div>
        <div className="online-result-author" title={item.author}>
          {item.author}
        </div>
        {item.description && (
          <div className="online-result-desc" title={item.description}>
            {item.description.length > 60
              ? item.description.slice(0, 60) + "..."
              : item.description}
          </div>
        )}
        {/* Action buttons */}
        <div className="online-result-actions">
          <button
            className="online-action-btn play"
            onClick={() => handlePlay(item)}
            disabled={downloading === item.id}
            title="Play now (temp download)"
          >
            {downloading === item.id ? (
              <span className="online-spinner" />
            ) : (
              <IconPlay size={12} />
            )}
            Play
          </button>
          <button
            className="online-action-btn save"
            onClick={() => handleSave(item)}
            disabled={downloading === item.id || !downloadDir}
            title={downloadDir ? "Save to library" : "Download path not set — check Settings"}
          >
            <IconPlus size={12} />
            Save
          </button>
        </div>
      </div>
    </div>
  );

  return (
    <div className="online-search-view">
      {/* Search bar */}
      <div className="online-search-bar">
        <input
          className="online-search-input"
          type="text"
          placeholder={searchPlaceholder}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={loading}
        />
        <button
          className="online-search-btn"
          onClick={handleSearch}
          disabled={loading || !query.trim()}
        >
          {loading ? "Searching..." : "Search"}
        </button>
      </div>

      {/* Error */}
      {error && (
        <div className="online-error">
          <IconClose size={14} />
          <span>{error}</span>
        </div>
      )}

      {/* ── Bilibili Results ── */}
      {bilibiliResults.length > 0 && (
        <div className="online-results-section">
          <h3 className="online-results-section-title">
            <span className="online-source-badge bilibili">Bili</span>
            Bilibili Results
          </h3>
          <div className="online-results-grid">
            {bilibiliResults.map(renderResultCard)}
          </div>
        </div>
      )}

      {/* ── YouTube Results ── */}
      {youtubeResults.length > 0 && (
        <div className="online-results-section">
          <h3 className="online-results-section-title">
            <span className="online-source-badge youtube">YT</span>
            YouTube Results
          </h3>
          <div className="online-results-grid">
            {youtubeResults.map(renderResultCard)}
          </div>
        </div>
      )}

      {/* Empty state */}
      {!loading && !hasResults && !error && (
        <div className="online-empty">
          <IconMusic size={32} />
          <p>Search for music from {youtubeEnabled ? "Bilibili & YouTube" : "Bilibili"} to play instantly.</p>
          <p className="online-empty-hint">
            Tip: Try "lofi", "anime ost", or your favorite artist name.
          </p>
        </div>
      )}
    </div>
  );
};

export default OnlineSearchView;
